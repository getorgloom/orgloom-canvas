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

const TEST_KEK = makeSfApexKekProvider(makeKekConn());

const mockConn = makeKekConn;

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
			{
				tempId: 2,
				sfId: '003def',
				objectName: 'Contact',
				mode: 'update',
				priorValues: { LastName: 'Old' },
				uploadedValues: { LastName: 'New' },
			},
		];
		const result = await store.create({
			source: 'canvas',
			insertedIds,
			deletedIds: [],
			associations: null,
			note: 'integration smoke',
		});
		assert.equal(result.id, '069NEW');

		const created = conn.calls.sobjectCreates[0];
		const rawBuf = Buffer.from(created.payload.VersionData, 'base64');
		assert.equal(isEncryptedEnvelope(rawBuf), true);
		assert.doesNotMatch(
			rawBuf.toString('latin1'),
			/insertedIds|integration smoke|LastName/,
			'plaintext payload markers leaked into ciphertext',
		);

		const decrypted = await decryptStoredBlob(created.payload.VersionData, '069NEW');
		assert.equal(decrypted.source, 'canvas');
		assert.equal(decrypted.note, 'integration smoke');
		assert.equal(decrypted.insertedIds.length, 2);
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
			() =>
				store.create({
					source: 'canvas',
					insertedIds: [{ tempId: 1, sfId: '001abc', objectName: 'Account', mode: 'create' }],
					deletedIds: [],
					associations: null,
				}),
			/Upload-batch persist failed/,
		);
		const stranded = await batchKeys.get({ sfOrgId: ORG_ID, batchId: '069NEW', kekProvider: TEST_KEK });
		assert.equal(stranded, null);
	});

	test('wrapped-key failure removes the unusable Salesforce upload-intent file', async () => {
		const stubFetch = global.fetch;
		global.fetch = async (url) => {
			if (String(url).endsWith('/kek/wrap')) {
				return {
					ok: false,
					status: 500,
					async json() {
						return { error: 'internal-error', message: 'KEK service failed unexpectedly.' };
					},
				};
			}
			return stubFetch(url);
		};
		try {
			const conn = mockConn({
				creates: [{ success: true, id: '068ORPHAN' }],
				retrieves: [{ ContentDocumentId: '069ORPHAN' }],
				destroys: [{ success: true }],
			});
			const store = await uploadBatchesStoreFromSfConnection(conn, USER_ID, ORG_ID);
			await assert.rejects(
				() =>
					store.create({
						source: 'canvas',
						insertedIds: [],
						deletedIds: [],
						associations: null,
					}),
				/Apex KEK call failed/,
			);
			assert.deepEqual(conn.calls.sobjectDestroys, [{ name: 'ContentDocument', id: '069ORPHAN' }]);
			const stranded = await batchKeys.get({
				sfOrgId: ORG_ID,
				batchId: '069ORPHAN',
				kekProvider: TEST_KEK,
			});
			assert.equal(stranded, null);
		} finally {
			global.fetch = stubFetch;
		}
	});
});

describe('upload-batches store: decryption on list / get', () => {
	test('list applies a bounded pagination offset to the Salesforce query', async () => {
		const readConn = mockConn({ queries: [{ records: [] }] });
		const readStore = await uploadBatchesStoreFromSfConnection(readConn, USER_ID, ORG_ID);
		const items = await readStore.list({ limit: 16, offset: 30 });
		assert.deepEqual(items, []);
		assert.match(readConn.calls.queries[0], /ORDER BY CreatedDate DESC LIMIT 16 OFFSET 30$/);
	});

	test('list decrypts each batch payload using its persisted key', async () => {
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

		const readConn = mockConn({
			queries: [
				{
					records: [
						{
							Id: '068A',
							ContentDocumentId: '069A',
							VersionData: writtenVersionData,
							PathOnClient: 'batch-x' + BATCH_EXT,
							OwnerId: USER_ID,
							CreatedDate: '2026-06-01T00:00:00Z',
						},
					],
				},
			],
		});
		const readStore = await uploadBatchesStoreFromSfConnection(readConn, USER_ID, ORG_ID);
		const items = await readStore.list();
		assert.equal(items.length, 1);
		assert.equal(items[0].source, 'canvas-graph');
		assert.equal(items[0].insertedCount, 1);
	});

	test('list decodes ledgers concurrently without exceeding the configured bound', async () => {
		const records = [];
		for (let i = 0; i < 6; i++) {
			const url = 'https://test.my.salesforce.com/version/' + i;
			_stub.registerVersionUrl(
				url,
				Buffer.from(
					JSON.stringify({
						externalId: 'batch-' + i,
						source: 'canvas',
						createdAt: i,
						status: 'uploaded',
						insertedIds: [],
						deletedIds: [],
					}),
					'utf8',
				),
			);
			records.push({
				Id: '068' + i,
				ContentDocumentId: '069' + i,
				VersionData: '/version/' + i,
				PathOnClient: 'batch-' + i + BATCH_EXT,
				OwnerId: USER_ID,
				CreatedDate: '2026-06-01T00:00:00Z',
			});
		}

		const readConn = mockConn({ queries: [{ records }] });
		const readStore = await uploadBatchesStoreFromSfConnection(readConn, USER_ID, ORG_ID);
		const originalFetch = global.fetch;
		let activeVersionFetches = 0;
		let maxActiveVersionFetches = 0;
		global.fetch = async (url, opts) => {
			if (String(url).includes('/version/')) {
				activeVersionFetches++;
				maxActiveVersionFetches = Math.max(maxActiveVersionFetches, activeVersionFetches);
				await new Promise((resolve) => setTimeout(resolve, 10));
				try {
					return await originalFetch(url, opts);
				} finally {
					activeVersionFetches--;
				}
			}
			return originalFetch(url, opts);
		};
		try {
			const items = await readStore.list({ limit: 6 });
			assert.equal(items.length, 6);
			assert.ok(maxActiveVersionFetches > 1, 'expected ledger downloads to overlap');
			assert.ok(maxActiveVersionFetches <= 4, 'expected at most four concurrent ledger downloads');
		} finally {
			global.fetch = originalFetch;
		}
	});

	test('list silently skips a row whose key has been wiped (returns 0 items, no crash)', async () => {
		const dataKey = generateDataKey();
		const envelope = encryptPayload(
			JSON.stringify({
				externalId: 'x',
				source: 'canvas',
				recordCount: 0,
				status: 'uploaded',
				insertedIds: [],
				deletedIds: [],
			}),
			dataKey,
		);
		const readConn = mockConn({
			queries: [
				{
					records: [
						{
							Id: '068LOST',
							ContentDocumentId: '069LOST',
							VersionData: envelope.toString('base64'),
							PathOnClient: 'batch-x' + BATCH_EXT,
							OwnerId: USER_ID,
							CreatedDate: '2026-06-01T00:00:00Z',
						},
					],
				},
			],
		});
		const readStore = await uploadBatchesStoreFromSfConnection(readConn, USER_ID, ORG_ID);
		const items = await readStore.list();
		assert.equal(items.length, 0);
	});

	test('legacy plaintext batch (no envelope) still parses cleanly', async () => {
		const plaintext = JSON.stringify({
			externalId: 'legacy',
			source: 'canvas',
			recordCount: 1,
			createdAt: Date.now(),
			status: 'uploaded',
			insertedIds: [{ tempId: 1, sfId: '001abc', objectName: 'Account', mode: 'create' }],
			deletedIds: [],
			associations: null,
		});
		const readConn = mockConn({
			queries: [
				{
					records: [
						{
							Id: '068LEGACY',
							ContentDocumentId: '069LEGACY',
							VersionData: Buffer.from(plaintext, 'utf8').toString('base64'),
							PathOnClient: 'batch-legacy' + BATCH_EXT,
							OwnerId: USER_ID,
							CreatedDate: '2026-04-01T00:00:00Z',
						},
					],
				},
			],
		});
		const readStore = await uploadBatchesStoreFromSfConnection(readConn, USER_ID, ORG_ID);
		const items = await readStore.list();
		assert.equal(items.length, 1);
		assert.equal(items[0].source, 'canvas');
	});
});

describe('upload-batches store: remove drops the wrapped key', () => {
	test('remove deletes the batch_keys row alongside the SF ContentDocument', async () => {
		await batchKeys.persist({
			sfOrgId: ORG_ID,
			batchId: '069DELXXXXXXXXX',
			dataKey: generateDataKey(),
			kekProvider: TEST_KEK,
		});
		const before = await batchKeys.get({ sfOrgId: ORG_ID, batchId: '069DELXXXXXXXXX', kekProvider: TEST_KEK });
		assert.ok(before, 'precondition: key should exist before remove');

		const conn = mockConn({
			queries: [
				{
					records: [
						{ Id: '069DELXXXXXXXXX', Title: 'old', OwnerId: USER_ID, CreatedDate: '2026-05-01T00:00:00Z' },
					],
				},
				{
					records: [
						{
							Id: '068DEL',
							VersionData: Buffer.from(
								JSON.stringify({
									externalId: 'x',
									source: 'canvas',
									insertedIds: [],
									deletedIds: [],
								}),
								'utf8',
							).toString('base64'),
							PathOnClient: 'batch-x' + BATCH_EXT,
						},
					],
				},
			],
			destroys: [{ success: true }],
		});
		const store = await uploadBatchesStoreFromSfConnection(conn, USER_ID, ORG_ID);
		await store.remove('069DELXXXXXXXXX');
		const after = await batchKeys.get({ sfOrgId: ORG_ID, batchId: '069DELXXXXXXXXX', kekProvider: TEST_KEK });
		assert.equal(after, null, 'batch_keys row must be gone after remove');
	});
});
