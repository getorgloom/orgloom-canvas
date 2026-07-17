// Upload-batches store encryption contract. Mirrors the canvas-store
// encryption tests but for the recall ledger (.orgloom-batch.json
// ContentVersion files). The store has no DB-level state of its own
// for batch data (it lives on SF); the SQLite test DB only holds
// batch_keys rows. SF connection is mocked via the same queue-based
// stub canvas-store.test.js uses.
//
// Behaviors:
//   * create emits an OLE2 envelope as VersionData (never plaintext).
//   * create persists a wrapped data key in batch_keys keyed by
//     (sfOrgId, ContentDocumentId).
//   * list / get decrypt the envelope using the stored key.
//   * list / get fall back to plain-JSON parsing on a legacy plaintext
//     blob: backwards compat for batches written pre-027.
//   * remove drops the batch_keys row alongside the SF ContentDocument.
//   * Decrypted payloads round-trip through markRecalling /
//     markRecallResult, which re-encrypt with the same key (one key
//     per batch across the SF version history).

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { uploadBatchesStoreFromSfConnection } from '../src/storage/upload-batches-store.js';
import {
	decryptPayload,
	encryptPayload,
	generateDataKey,
	isEncryptedEnvelope,
	makeSfApexKekProvider,
} from '../src/storage/canvas-encryption.js';
import * as batchKeys from '../src/database/batch-keys.js';
import { initTestDb, clearTestDb } from './helpers/db.js';
import { installSfFetchStub, makeKekConn } from './helpers/sf-kek-stub.js';

const BATCH_EXT = '.orgloom-batch.json';
const ORG_ID = '00DTEST00000001';
const USER_ID = '005TESTUploader';

// The store drives the real SF-Apex KEK provider; stub the network (KEK
// wrap/unwrap) so wrap is identity and round-trips. (Before KEK Phase 5 this
// suite used a local master key; the provider switch left it un-stubbed and
// every test errored, which is part of how the recall-ledger bugs shipped.)
let _stub;
before(initTestDb);
before(() => {
 _stub = installSfFetchStub(); 
});
after(() => {
 if (_stub) {
 _stub.restore(); 
} 
});
beforeEach(clearTestDb);

// A kekProvider for direct batchKeys.get/persist calls in assertions. wrap/
// unwrap route through the installed global-fetch stub, so the conn only needs
// instanceUrl + accessToken (which makeKekConn provides).
const TEST_KEK = makeSfApexKekProvider(makeKekConn());

// Queue-based SF connection mock with instanceUrl/accessToken so the KEK
// provider accepts it. Shared with the two-phase tests.
const mockConn = makeKekConn;

// Decrypt a base64 VersionData blob using the per-batch data key that
// the store just persisted. Used by tests that want to assert the
// decrypted payload shape.
async function decryptStoredBlob(versionDataB64, batchId) {
	const buf = Buffer.from(versionDataB64, 'base64');
	assert.equal(isEncryptedEnvelope(buf), true, 'expected OLE2 envelope, got plaintext');
	const key = await batchKeys.get({ sfOrgId: ORG_ID, batchId, kekProvider: TEST_KEK });
	assert.ok(key, 'expected batch_keys row to be persisted for ' + batchId);
	return JSON.parse(decryptPayload(buf, key));
}

describe('upload-batches store: encryption on create', () => {
	test('emits OLE2 envelope, persists wrapped key, decrypted payload matches input', async () => {
		const conn = mockConn({
			creates: [{ success: true, id: '068NEW' }],
			retrieves: [{ ContentDocumentId: '069NEW' }],
		});
		const store = await uploadBatchesStoreFromSfConnection(conn, USER_ID, ORG_ID);
		const insertedIds = [
			{ tempId: 1, sfId: '001abc', objectName: 'Account', mode: 'create' },
			{ tempId: 2, sfId: '003def', objectName: 'Contact', mode: 'update',
				priorValues: { LastName: 'Old' }, uploadedValues: { LastName: 'New' } },
		];
		const result = await store.create({
			source: 'canvas',
			insertedIds,
			deletedIds: [],
			associations: null,
			note: 'integration smoke',
		});
		assert.equal(result.id, '069NEW');

		// VersionData posted to SF must be an OLE2 envelope, never plaintext JSON.
		const created = conn.calls.sobjectCreates[0];
		const rawBuf = Buffer.from(created.payload.VersionData, 'base64');
		assert.equal(isEncryptedEnvelope(rawBuf), true);
		// Plaintext markers must NOT appear in the ciphertext blob.
		assert.doesNotMatch(
			rawBuf.toString('latin1'),
			/insertedIds|integration smoke|LastName/,
			'plaintext payload markers leaked into ciphertext',
		);

		// Decrypt with the persisted key and verify the payload shape.
		const decrypted = await decryptStoredBlob(created.payload.VersionData, '069NEW');
		assert.equal(decrypted.source, 'canvas');
		assert.equal(decrypted.note, 'integration smoke');
		assert.equal(decrypted.insertedIds.length, 2);
		// priorValues / uploadedValues round-trip exactly.
		const updateEntry = decrypted.insertedIds.find((e) => e.mode === 'update');
		assert.deepEqual(updateEntry.priorValues, { LastName: 'Old' });
		assert.deepEqual(updateEntry.uploadedValues, { LastName: 'New' });
	});

	test('create failure does NOT persist a wrapped key (no orphan rows)', async () => {
		const conn = mockConn({
			creates: [{ success: false, errors: [{ message: 'INSUFFICIENT_ACCESS' }] }],
		});
		const store = await uploadBatchesStoreFromSfConnection(conn, USER_ID, ORG_ID);
		await assert.rejects(
			() => store.create({
				source: 'canvas',
				insertedIds: [{ tempId: 1, sfId: '001abc', objectName: 'Account', mode: 'create' }],
				deletedIds: [], associations: null,
			}),
			/Upload-batch persist failed/,
		);
		// No batch_keys row should exist: the SF write failed, so
		// there's no batch to key.
		const stranded = await batchKeys.get({ sfOrgId: ORG_ID, batchId: '069NEW', kekProvider: TEST_KEK });
		assert.equal(stranded, null);
	});
});

describe('upload-batches store: decryption on list / get', () => {
	test('list decrypts each batch payload using its persisted key', async () => {
		// Pre-create a batch to populate state.
		const writeConn = mockConn({
			creates: [{ success: true, id: '068A' }],
			retrieves: [{ ContentDocumentId: '069A' }],
		});
		const writeStore = await uploadBatchesStoreFromSfConnection(writeConn, USER_ID, ORG_ID);
		await writeStore.create({
			source: 'canvas-graph',
			insertedIds: [{ tempId: 1, sfId: '001abc', objectName: 'Account', mode: 'create' }],
			deletedIds: [],
			associations: null,
		});
		const writtenVersionData = writeConn.calls.sobjectCreates[0].payload.VersionData;

		// Now read it back through list().
		const readConn = mockConn({
			queries: [{
				records: [{
					Id: '068A',
					ContentDocumentId: '069A',
					VersionData: writtenVersionData,
					PathOnClient: 'batch-x' + BATCH_EXT,
					OwnerId: USER_ID,
					CreatedDate: '2026-06-01T00:00:00Z',
				}],
			}],
		});
		const readStore = await uploadBatchesStoreFromSfConnection(readConn, USER_ID, ORG_ID);
		const items = await readStore.list();
		assert.equal(items.length, 1);
		assert.equal(items[0].source, 'canvas-graph');
		assert.equal(items[0].insertedCount, 1);
	});

	test('list silently skips a row whose key has been wiped (returns 0 items, no crash)', async () => {
		// Encrypt with a known-good key, but never persist the key: simulates
		// a wiped batch_keys row (DB restore, manual cleanup, etc.).
		const dataKey = generateDataKey();
		const envelope = encryptPayload(JSON.stringify({
			externalId: 'x', source: 'canvas', recordCount: 0,
			status: 'uploaded', insertedIds: [], deletedIds: [],
		}), dataKey);
		const readConn = mockConn({
			queries: [{
				records: [{
					Id: '068LOST',
					ContentDocumentId: '069LOST',
					VersionData: envelope.toString('base64'),
					PathOnClient: 'batch-x' + BATCH_EXT,
					OwnerId: USER_ID,
					CreatedDate: '2026-06-01T00:00:00Z',
				}],
			}],
		});
		const readStore = await uploadBatchesStoreFromSfConnection(readConn, USER_ID, ORG_ID);
		// _decodeVersionData returns null for un-decryptable rows; list
		// filters them out rather than throwing.
		const items = await readStore.list();
		assert.equal(items.length, 0);
	});

	test('legacy plaintext batch (no envelope) still parses cleanly', async () => {
		const plaintext = JSON.stringify({
			externalId: 'legacy', source: 'canvas', recordCount: 1,
			createdAt: Date.now(), status: 'uploaded',
			insertedIds: [{ tempId: 1, sfId: '001abc', objectName: 'Account', mode: 'create' }],
			deletedIds: [], associations: null,
		});
		const readConn = mockConn({
			queries: [{
				records: [{
					Id: '068LEGACY',
					ContentDocumentId: '069LEGACY',
					VersionData: Buffer.from(plaintext, 'utf8').toString('base64'),
					PathOnClient: 'batch-legacy' + BATCH_EXT,
					OwnerId: USER_ID,
					CreatedDate: '2026-04-01T00:00:00Z',
				}],
			}],
		});
		const readStore = await uploadBatchesStoreFromSfConnection(readConn, USER_ID, ORG_ID);
		const items = await readStore.list();
		assert.equal(items.length, 1);
		assert.equal(items[0].source, 'canvas');
	});
});

describe('upload-batches store: remove drops the wrapped key', () => {
	test('remove deletes the batch_keys row alongside the SF ContentDocument', async () => {
		// Pre-seed a key directly so we can verify remove() clears it.
		await batchKeys.persist({ sfOrgId: ORG_ID, batchId: '069DELXXXXXXXXX', dataKey: generateDataKey(), kekProvider: TEST_KEK });
		const before = await batchKeys.get({ sfOrgId: ORG_ID, batchId: '069DELXXXXXXXXX', kekProvider: TEST_KEK });
		assert.ok(before, 'precondition: key should exist before remove');

		// remove() needs a successful get() first to look up the batch
		// (existence + ownership). Stage the query + version response.
		const conn = mockConn({
			queries: [
				// First query: get(id) → ContentDocument lookup
				{ records: [{ Id: '069DELXXXXXXXXX', Title: 'old', OwnerId: USER_ID, CreatedDate: '2026-05-01T00:00:00Z' }] },
				// Second query: get(id) → ContentVersion lookup
				{ records: [{
					Id: '068DEL',
					VersionData: Buffer.from(JSON.stringify({
						externalId: 'x', source: 'canvas', insertedIds: [], deletedIds: [],
					}), 'utf8').toString('base64'),
					PathOnClient: 'batch-x' + BATCH_EXT,
				}] },
			],
			destroys: [{ success: true }],
		});
		const store = await uploadBatchesStoreFromSfConnection(conn, USER_ID, ORG_ID);
		await store.remove('069DELXXXXXXXXX');
		const after = await batchKeys.get({ sfOrgId: ORG_ID, batchId: '069DELXXXXXXXXX', kekProvider: TEST_KEK });
		assert.equal(after, null, 'batch_keys row must be gone after remove');
	});
});
