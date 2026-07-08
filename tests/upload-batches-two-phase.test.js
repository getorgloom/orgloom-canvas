import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { uploadBatchesStoreFromSfConnection } from '../src/storage/upload-batches-store.js';
import { decryptPayload, makeSfApexKekProvider } from '../src/storage/canvas-encryption.js';
import * as batchKeys from '../src/database/batch-keys.js';
import { initTestDb, clearTestDb } from './helpers/db.js';
import { installSfFetchStub, makeKekConn } from './helpers/sf-kek-stub.js';

const BATCH_EXT = '.orgloom-batch.json';
const ORG_ID = '00DTEST00000001';
const USER_ID = '005TESTUploader';

before(initTestDb);
beforeEach(clearTestDb);

async function decodeWithKey(conn, versionDataB64, batchId) {
	const buf = Buffer.from(versionDataB64, 'base64');
	const kekProvider = makeSfApexKekProvider(conn);
	const key = await batchKeys.get({ sfOrgId: ORG_ID, batchId, kekProvider });
	assert.ok(key, 'expected a persisted batch key for ' + batchId);
	return JSON.parse(decryptPayload(buf, key));
}

describe('upload-batches store — layer 4: VersionData-as-URL', () => {
	test('a batch whose VersionData comes back as a URL decodes correctly', async () => {
		const stub = installSfFetchStub();
		try {

			const wConn = makeKekConn({ creates: [{ success: true, id: '068A' }], retrieves: [{ ContentDocumentId: '069A' }] });
			const wStore = await uploadBatchesStoreFromSfConnection(wConn, USER_ID, ORG_ID);
			await wStore.create({
				source: 'canvas-graph',
				insertedIds: [{ tempId: 1, sfId: '001x', objectName: 'Account', mode: 'create' }],
				deletedIds: [], associations: null,
			});
			const envBuf = Buffer.from(wConn.calls.sobjectCreates[0].payload.VersionData, 'base64');

			const vdUrl = '/services/data/v60.0/sobjects/ContentVersion/068A/VersionData';
			const rConn = makeKekConn({
				queries: [{ records: [{
					Id: '068A', ContentDocumentId: '069A', VersionData: vdUrl,
					PathOnClient: 'batch-x' + BATCH_EXT, OwnerId: USER_ID, CreatedDate: '2026-06-01T00:00:00Z',
				}] }],
			});
			stub.registerVersionUrl(rConn.instanceUrl + vdUrl, envBuf);
			const rStore = await uploadBatchesStoreFromSfConnection(rConn, USER_ID, ORG_ID);

			const items = await rStore.list();
			assert.equal(items.length, 1, 'URL-delivered VersionData must decode (regression: binary fetch, not UTF-8)');
			assert.equal(items[0].source, 'canvas-graph');
			assert.equal(items[0].insertedCount, 1);
		} finally {
			stub.restore();
		}
	});
});

describe('upload-batches store — two-phase write', () => {
	test('createPending records intent (pending, no ids); finalize flips to uploaded with ids', async () => {
		const stub = installSfFetchStub();
		try {

			const DOC_ID = '069O400000RjEorIAF';
			const conn = makeKekConn({ creates: [{ success: true, id: '068O400000S8kK5IAJ' }], retrieves: [{ ContentDocumentId: DOC_ID }] });
			const store = await uploadBatchesStoreFromSfConnection(conn, USER_ID, ORG_ID);

			await store.createPending({
				source: 'canvas-graph',
				attemptId: 'att-xyz',
				intendedRecords: [{ tempId: 1, objectName: 'Account' }],
			});
			const pendingVd = conn.calls.sobjectCreates[0].payload.VersionData;
			const pending = await decodeWithKey(conn, pendingVd, DOC_ID);
			assert.equal(pending.status, 'pending');
			assert.equal(pending.attemptId, 'att-xyz');
			assert.equal(pending.insertedIds.length, 0);
			assert.deepEqual(pending.intendedRecords, [{ tempId: 1, objectName: 'Account' }]);

			conn._queues.queries.push(
				{ records: [{ Id: DOC_ID, Title: 't', OwnerId: USER_ID, CreatedDate: '2026-06-01T00:00:00Z' }] },
				{ records: [{ Id: '068O400000S8kK5IAJ', VersionData: pendingVd, PathOnClient: 'batch-x__att-att-xyz' + BATCH_EXT }] },
			);
			conn._queues.creates.push({ success: true, id: '068O400000S8kK6IAJ' });
			await store.finalize(DOC_ID, {
				insertedIds: [{ tempId: 1, sfId: '001x', objectName: 'Account', mode: 'create' }],
			});
			const finalVd = conn.calls.sobjectCreates[1].payload.VersionData;
			const finalized = await decodeWithKey(conn, finalVd, DOC_ID);
			assert.equal(finalized.status, 'uploaded');
			assert.equal(finalized.attemptId, 'att-xyz', 'attemptId is preserved across phases');
			assert.equal(finalized.insertedIds.length, 1);
			assert.equal(finalized.insertedIds[0].sfId, '001x');
			assert.ok(!finalized.intendedRecords, 'intendedRecords dropped once finalized');
		} finally {
			stub.restore();
		}
	});
});

describe('upload-batches store — idempotency index (attemptId)', () => {
	test('create() encodes attemptId into PathOnClient', async () => {
		const stub = installSfFetchStub();
		try {
			const conn = makeKekConn({ creates: [{ success: true, id: '068C' }], retrieves: [{ ContentDocumentId: '069C' }] });
			const store = await uploadBatchesStoreFromSfConnection(conn, USER_ID, ORG_ID);
			await store.create({
				source: 'canvas',
				attemptId: 'att-tag-1',
				insertedIds: [{ tempId: 1, sfId: '001x', objectName: 'Account', mode: 'create' }],
				deletedIds: [], associations: null,
			});
			const path = conn.calls.sobjectCreates[0].payload.PathOnClient;
			assert.match(path, /__att-att-tag-1\.orgloom-batch\.json$/);
		} finally {
			stub.restore();
		}
	});

	test('findByAttemptId queries the filename tag, owner-scoped, and returns null when absent', async () => {
		const stub = installSfFetchStub();
		try {
			const conn = makeKekConn({});
			const store = await uploadBatchesStoreFromSfConnection(conn, USER_ID, ORG_ID);
			const res = await store.findByAttemptId('att-abc');
			assert.equal(res, null);
			const soql = conn.calls.queries[0];
			assert.match(soql, /__att-att-abc\.orgloom-batch\.json/, 'lookup must filter on the attemptId tag (cheap, no decrypt)');
			assert.match(soql, /OwnerId = '005TESTUploader'/, 'lookup must be owner-scoped');
		} finally {
			stub.restore();
		}
	});
});
