import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { canvasStoreFromSfConnection } from '../src/storage/canvas-store.js';
import {
	decryptPayload,
	encryptPayload,
	generateDataKey,
	isEncryptedEnvelope,
	makeSfApexKekProvider,
} from '../src/storage/canvas-encryption.js';
import * as canvasKeys from '../src/database/canvas-keys.js';
import { initTestDb, clearTestDb } from './helpers/db.js';
import { installSfFetchStub, makeKekConn } from './helpers/sf-kek-stub.js';

const CANVAS_EXT = '.orgloom-canvas.json';
const ORG_ID = '00DTEST00000001';

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

function mockConn(initial = {}) {
	const calls = {
		queries: [],
		sobjectCreates: [],
		sobjectRetrieves: [],
		sobjectUpserts: [],
	};
	const queryQueue = [...(initial.queries || [])];
	const createQueue = [...(initial.creates || [])];
	const retrieveQueue = [...(initial.retrieves || [])];
	return {

		instanceUrl: 'https://test.my.salesforce.com',
		accessToken: 'TEST_TOKEN',
		calls,
		async query(soql) {
			calls.queries.push(soql);
			if (queryQueue.length === 0) {
return { records: [], totalSize: 0 };
}
			return queryQueue.shift();
		},
		sobject(name) {
			return {
				async create(payload) {
					calls.sobjectCreates.push({ name, payload });
					if (createQueue.length === 0) {
return { success: false, errors: ['no-create-queued'] };
}
					return createQueue.shift();
				},
				async retrieve(id) {
					calls.sobjectRetrieves.push({ name, id });
					if (retrieveQueue.length === 0) {
return null;
}
					return retrieveQueue.shift();
				},
				async destroy() {
 return { success: true };
},
				async update() {
 return { success: true };
},

				async upsert(payload, extIdField) {
					calls.sobjectUpserts.push({ name, payload, extIdField });
					return { success: true };
				},
			};
		},
	};
}

async function decryptSavedBlob(versionDataB64, canvasId) {
	const buf = Buffer.from(versionDataB64, 'base64');
	assert.equal(isEncryptedEnvelope(buf), true, 'expected OLE2 envelope, got plaintext');
	const key = await canvasKeys.get({ sfOrgId: ORG_ID, canvasId, kekProvider: TEST_KEK });
	assert.ok(key, 'expected canvas_keys row to be persisted for ' + canvasId);
	return JSON.parse(decryptPayload(buf, key));
}

const F = (n) => 'orgloom__' + n;

function hybridMetaRow(canvasId, extra = {}) {
	return Object.assign({
		Id: 'a0' + canvasId,
		[F('Canvas_Id__c')]: canvasId,
		[F('Body_Document_Id__c')]: canvasId,
		[F('Schema_Version__c')]: 1,
		[F('Encryption_Key_Version__c')]: 'v1',
	}, extra);
}

describe('canvas store: list / ownedByMe', () => {
	test('owner sees ownedByMe=true; non-owner sees false', async () => {
		const conn = mockConn({
			queries: [{
				records: [
					{
						Id: 'a0c1', [F('Canvas_Id__c')]: '069A1', [F('Body_Document_Id__c')]: '069A1',
						Name: 'mine', OwnerId: '005MINE', [F('Record_Count__c')]: 5,
						[F('Last_Edited_At__c')]: '2026-05-02T00:00:00Z',
						CreatedDate: '2026-05-01T00:00:00Z', LastModifiedDate: '2026-05-02T00:00:00Z',
					},
					{
						Id: 'a0c2', [F('Canvas_Id__c')]: '069A2', [F('Body_Document_Id__c')]: '069A2',
						Name: 'theirs', OwnerId: '005OTHER', [F('Record_Count__c')]: 3,
						[F('Last_Edited_At__c')]: '2026-05-02T00:00:00Z',
						CreatedDate: '2026-05-01T00:00:00Z', LastModifiedDate: '2026-05-02T00:00:00Z',
					},
				],
			}],
		});
		const store = await canvasStoreFromSfConnection(conn, '005MINE', ORG_ID);
		const result = await store.list();
		assert.equal(result.items.length, 2);
		const mine = result.items.find((i) => i.id === '069A1');
		const theirs = result.items.find((i) => i.id === '069A2');
		assert.equal(mine.ownedByMe, true);
		assert.equal(mine.size, 5);
		assert.equal(theirs.ownedByMe, false);

		assert.match(conn.calls.queries[0], /FROM orgloom__Orgloom_Canvas__c/);
	});

	test('caller with no sfUserId never sees ownedByMe=true', async () => {
		const conn = mockConn({
			queries: [{
				records: [{
					Id: 'a0c1', [F('Canvas_Id__c')]: '069A1', [F('Body_Document_Id__c')]: '069A1',
					Name: 'x', OwnerId: '005ANY', [F('Record_Count__c')]: 0,
					[F('Last_Edited_At__c')]: '2026-05-01T00:00:00Z',
					CreatedDate: '2026-05-01T00:00:00Z', LastModifiedDate: '2026-05-01T00:00:00Z',
				}],
			}],
		});
		const store = await canvasStoreFromSfConnection(conn, null, ORG_ID);
		const result = await store.list();
		assert.equal(result.items[0].ownedByMe, false);
	});
});

describe('canvas store: save (encrypt + key persistence + metadata)', () => {
	test('emits OLE2 envelope, persists key, writes Canvas__c row, drafts pass through', async () => {
		const conn = mockConn({

			creates: [{ success: true, id: '068NEW' }, { success: true, id: 'cdl1' }],
			retrieves: [{ ContentDocumentId: '069NEW' }],

			queries: [
				{ records: [{ Id: 'a0Canvas1' }] },
				{ records: [] },
			],
		});
		const store = await canvasStoreFromSfConnection(conn, '005MINE', ORG_ID);
		const payload = {
			drafts: [
				{ tempId: 1, objectName: 'Account', x: 10, y: 20, values: { Name: 'IN-FLIGHT-DRAFT', Industry: 'Tech' } },
			],
			loadedRecords: [
				{ tempId: 2, objectName: 'Contact', loadedFromId: '003ABC', values: { LastName: 'kept' } },
			],
		};
		const res = await store.save({ name: 'My Canvas', payload });
		assert.equal(res.id, '069NEW');
		assert.equal(res.versionId, '068NEW');

		const cvCreate = conn.calls.sobjectCreates.find((c) => c.name === 'ContentVersion');
		const rawBuf = Buffer.from(cvCreate.payload.VersionData, 'base64');
		assert.equal(isEncryptedEnvelope(rawBuf), true);
		assert.doesNotMatch(
			rawBuf.toString('latin1'),
			/IN-FLIGHT-DRAFT|loadedRecords|drafts/,
			'plaintext payload markers leaked into ciphertext',
		);

		const upsert = conn.calls.sobjectUpserts.find((u) => u.name === F('Orgloom_Canvas__c'));
		assert.ok(upsert, 'save must upsert the Orgloom_Canvas__c metadata row');
		assert.equal(upsert.extIdField, F('Canvas_Id__c'));
		assert.equal(upsert.payload[F('Canvas_Id__c')], '069NEW');
		assert.equal(upsert.payload[F('Body_Document_Id__c')], '069NEW');

		const saved = await decryptSavedBlob(cvCreate.payload.VersionData, '069NEW');
		assert.equal(saved.drafts[0].tempId, 1);
		assert.equal(saved.drafts[0].x, 10);
		assert.deepEqual(saved.drafts[0].values, { Name: 'IN-FLIGHT-DRAFT', Industry: 'Tech' });
		assert.deepEqual(saved.loadedRecords[0].values, { LastName: 'kept' });
	});

	test('save failure surfaces a clear error and does NOT persist a key', async () => {
		const conn = mockConn({
			creates: [{ success: false, errors: [{ message: 'INSUFFICIENT_ACCESS' }] }],
		});
		const store = await canvasStoreFromSfConnection(conn, '005MINE', ORG_ID);
		await assert.rejects(
			() => store.save({ name: 'X', payload: { drafts: [], loadedRecords: [] } }),
			(err) => err instanceof Error && /save|permission|access|content/i.test(err.message),
		);

		const stranded = await canvasKeys.get({ sfOrgId: ORG_ID, canvasId: '069NEW', kekProvider: TEST_KEK });
		assert.equal(stranded, null);
	});
});

describe('canvas store: get (probe + decrypt + legacy plaintext)', () => {
	test('returns null when the body ContentDocument is missing', async () => {

		const conn = mockConn({
			queries: [
				{ records: [hybridMetaRow('069MISSING')] },
				{ records: [] },
			],
		});
		const store = await canvasStoreFromSfConnection(conn, '005MINE', ORG_ID);
		const result = await store.get('069MISSING');
		assert.equal(result, null);
	});

	test('throws 404 canvas-not-accessible when there is no Canvas__c metadata row', async () => {

		const conn = mockConn({ queries: [{ records: [] }] });
		const store = await canvasStoreFromSfConnection(conn, '005MINE', ORG_ID);
		await assert.rejects(
			() => store.get('069LEGACYDOC0001'),
			(err) => {
				assert.equal(err.statusCode, 404);
				assert.equal(err.code, 'canvas-not-accessible');
				return true;
			},
		);
	});

	test('rejects file whose PathOnClient ext is NOT .orgloom-canvas.json', async () => {
		const conn = mockConn({
			queries: [
				{ records: [hybridMetaRow('069X')] },
				{ records: [{ Id: '069X', Title: 'random.pdf', OwnerId: '005A', CreatedDate: '2026-05-01T00:00:00Z', LastModifiedDate: '2026-05-01T00:00:00Z' }] },
				{ records: [{ Id: '068X', VersionData: 'eyJ4Ijoxfg==', PathOnClient: 'random.pdf' }] },
			],
		});
		const store = await canvasStoreFromSfConnection(conn, '005MINE', ORG_ID);
		await assert.rejects(
			() => store.get('069X'),
			(err) => {
				assert.equal(err.statusCode, 400);
				assert.match(err.message, /Not an Orgloom canvas/);
				return true;
			},
		);
	});

	test('round-trips a save → get (decrypts back to the same payload)', async () => {
		const original = {
			drafts: [{ tempId: 1, objectName: 'Account', x: 5, y: 6, values: { Name: 'A' } }],
			loadedRecords: [{ tempId: 2, objectName: 'Contact', values: { LastName: 'B' } }],
		};
		const writeConn = mockConn({
			creates: [{ success: true, id: '068ROUND' }, { success: true, id: 'cdlR' }],
			retrieves: [{ ContentDocumentId: '069ROUND' }],
			queries: [{ records: [{ Id: 'a0Round' }] }, { records: [] }],
		});
		const writeStore = await canvasStoreFromSfConnection(writeConn, '005MINE', ORG_ID);
		await writeStore.save({ name: 'round-trip', payload: original });
		const cvCreate = writeConn.calls.sobjectCreates.find((c) => c.name === 'ContentVersion');
		const versionData = cvCreate.payload.VersionData;

		const bodySha = crypto.createHash('sha256').update(Buffer.from(versionData, 'base64')).digest('hex');

		const readConn = mockConn({
			queries: [
				{ records: [hybridMetaRow('069ROUND', { [F('Body_Sha256__c')]: bodySha })] },
				{ records: [{ Id: '069ROUND', Title: 'round-trip', OwnerId: '005MINE', CreatedDate: '2026-05-01T00:00:00Z', LastModifiedDate: '2026-05-02T00:00:00Z' }] },
				{ records: [{ Id: '068ROUND', VersionData: versionData, PathOnClient: 'round-trip' + CANVAS_EXT }] },
			],
		});
		const readStore = await canvasStoreFromSfConnection(readConn, '005MINE', ORG_ID);
		const result = await readStore.get('069ROUND');
		assert.equal(result.id, '069ROUND');
		assert.equal(result.ownedByMe, true);
		assert.deepEqual(result.payload, original);
	});

	test('legacy plaintext body (Canvas__c row present, no envelope) still parses', async () => {
		const fakePayload = { records: [{ tempId: 1, objectName: 'Account', values: { Name: 'A' } }] };
		const conn = mockConn({
			queries: [
				{ records: [hybridMetaRow('069LEGACY')] },
				{ records: [{ Id: '069LEGACY', Title: 'old', OwnerId: '005MINE', CreatedDate: '2026-05-01T00:00:00Z', LastModifiedDate: '2026-05-02T00:00:00Z' }] },
				{ records: [{
					Id: '068LEGACY',
					VersionData: Buffer.from(JSON.stringify(fakePayload), 'utf8').toString('base64'),
					PathOnClient: 'old' + CANVAS_EXT,
				}] },
			],
		});
		const store = await canvasStoreFromSfConnection(conn, '005MINE', ORG_ID);
		const result = await store.get('069LEGACY');
		assert.deepEqual(result.payload, fakePayload);
		assert.equal(result.versionId, '068LEGACY');
	});

	test('ciphertext with no key row throws canvas-key-missing', async () => {

		const dataKey = generateDataKey();
		const envelope = encryptPayload(JSON.stringify({ drafts: [], loadedRecords: [] }), dataKey);
		const conn = mockConn({
			queries: [
				{ records: [hybridMetaRow('069ORPHAN')] },
				{ records: [{ Id: '069ORPHAN', Title: 'orphan', OwnerId: '005MINE', CreatedDate: '2026-05-01T00:00:00Z', LastModifiedDate: '2026-05-02T00:00:00Z' }] },
				{ records: [{ Id: '068ORPHAN', VersionData: envelope.toString('base64'), PathOnClient: 'orphan' + CANVAS_EXT }] },
			],
		});
		const store = await canvasStoreFromSfConnection(conn, '005MINE', ORG_ID);
		await assert.rejects(
			() => store.get('069ORPHAN'),
			(err) => {
				assert.equal(err.code, 'canvas-key-missing');
				return true;
			},
		);
	});
});

describe('canvas store: update / optimistic lock', () => {
	test('stale expectedVersionId throws 409 with currentVersionId', async () => {
		const conn = mockConn({
			queries: [
				{ records: [{ Id: '069A', Title: 'mine' }] },
				{ records: [{ Id: '068LATEST' }] },
			],
		});
		const store = await canvasStoreFromSfConnection(conn, '005MINE', ORG_ID);
		await assert.rejects(
			() => store.update('069A', { payload: { records: [] }, expectedVersionId: '068STALE' }),
			(err) => {
				assert.equal(err.statusCode, 409);
				assert.equal(err.code, 'version-mismatch');
				assert.equal(err.currentVersionId, '068LATEST');
				return true;
			},
		);
	});

	test('matching expectedVersionId proceeds to write (encrypted)', async () => {
		const conn = mockConn({
			queries: [
				{ records: [{ Id: '069A', Title: 'mine' }] },
				{ records: [{ Id: '068LATEST' }] },
				{ records: [{ Id: 'a0069A' }] },
				{ records: [{ Id: 'cdl069A' }] },
			],
			creates: [{ success: true, id: '068NEW' }],
		});
		const store = await canvasStoreFromSfConnection(conn, '005MINE', ORG_ID);
		const res = await store.update('069A', {
			payload: { records: [] },
			expectedVersionId: '068LATEST',
		});
		assert.equal(res.id, '069A');
		assert.equal(res.versionId, '068NEW');

		const versionData = conn.calls.sobjectCreates[0].payload.VersionData;
		const saved = await decryptSavedBlob(versionData, '069A');
		assert.deepEqual(saved, { records: [] });
	});

	test('missing canvas throws 404', async () => {
		const conn = mockConn({ queries: [{ records: [] }] });
		const store = await canvasStoreFromSfConnection(conn, '005MINE', ORG_ID);
		await assert.rejects(
			() => store.update('069MISSING', { payload: { records: [] } }),
			(err) => {
				assert.equal(err.statusCode, 404);
				return true;
			},
		);
	});

	test('update preserves draft values in the encrypted payload', async () => {
		const conn = mockConn({
			queries: [
				{ records: [{ Id: '069A', Title: 'mine' }] },
				{ records: [{ Id: '068LATEST' }] },
				{ records: [{ Id: 'a0069A' }] },
				{ records: [{ Id: 'cdl069A' }] },
			],
			creates: [{ success: true, id: '068NEW' }],
		});
		const store = await canvasStoreFromSfConnection(conn, '005MINE', ORG_ID);
		await store.update('069A', {
			payload: {
				drafts: [{ tempId: 1, objectName: 'X', x: 0, y: 0, values: { N: 'KEPT-DRAFT' } }],
				loadedRecords: [],
			},
			expectedVersionId: '068LATEST',
		});
		const versionData = conn.calls.sobjectCreates[0].payload.VersionData;
		const saved = await decryptSavedBlob(versionData, '069A');
		assert.deepEqual(saved.drafts[0].values, { N: 'KEPT-DRAFT' });
	});

	test('update reuses the existing key across versions', async () => {

		const conn1 = mockConn({
			queries: [
				{ records: [{ Id: '069A', Title: 'mine' }] },
				{ records: [{ Id: '068V1' }] },
				{ records: [{ Id: 'a0069A' }] },
				{ records: [{ Id: 'cdl069A' }] },
			],
			creates: [{ success: true, id: '068V2' }],
		});
		const store1 = await canvasStoreFromSfConnection(conn1, '005MINE', ORG_ID);
		await store1.update('069A', { payload: { n: 1 }, expectedVersionId: '068V1' });
		const keyAfterFirst = await canvasKeys.get({ sfOrgId: ORG_ID, canvasId: '069A', kekProvider: TEST_KEK });

		const conn2 = mockConn({
			queries: [
				{ records: [{ Id: '069A', Title: 'mine' }] },
				{ records: [{ Id: '068V2' }] },
				{ records: [{ Id: 'a0069A' }] },
				{ records: [{ Id: 'cdl069A' }] },
			],
			creates: [{ success: true, id: '068V3' }],
		});
		const store2 = await canvasStoreFromSfConnection(conn2, '005MINE', ORG_ID);
		await store2.update('069A', { payload: { n: 2 }, expectedVersionId: '068V2' });
		const keyAfterSecond = await canvasKeys.get({ sfOrgId: ORG_ID, canvasId: '069A', kekProvider: TEST_KEK });

		assert.ok(keyAfterFirst.equals(keyAfterSecond), 'data key must be stable across updates');
	});
});

describe('canvas store: SOQL escaping', () => {
	test('canvas id with a quote is escaped in the SOQL the store issues', async () => {

		const conn = mockConn({ queries: [{ records: [] }] });
		const store = await canvasStoreFromSfConnection(conn, '005MINE', ORG_ID);
		await store.get("069A' OR Id='069B").catch(() => {});
		const soql = conn.calls.queries[0];
		assert.doesNotMatch(soql, /'069A' OR Id='069B'/);
	});
});

describe('canvas store: countOwned', () => {
	test('returns the totalSize value', async () => {
		const conn = mockConn({ queries: [{ totalSize: 7, records: [] }] });
		const store = await canvasStoreFromSfConnection(conn, '005MINE', ORG_ID);
		assert.equal(await store.countOwned(), 7);
	});

	test('returns 0 when sfUserId is unknown (gate cannot false-positive)', async () => {
		const conn = mockConn({});
		const store = await canvasStoreFromSfConnection(conn, null, ORG_ID);
		assert.equal(await store.countOwned(), 0);
		assert.equal(conn.calls.queries.length, 0);
	});
});

describe('canvas store: remove', () => {
	test('deletes the canvas_keys row alongside the SF ContentDocument', async () => {

		await canvasKeys.persist({ sfOrgId: ORG_ID, canvasId: '069DEL', dataKey: generateDataKey(), kekProvider: TEST_KEK });
		const before = await canvasKeys.get({ sfOrgId: ORG_ID, canvasId: '069DEL', kekProvider: TEST_KEK });
		assert.ok(before, 'precondition: key should exist before remove');
		const conn = mockConn({});
		const store = await canvasStoreFromSfConnection(conn, '005MINE', ORG_ID);
		await store.remove('069DEL');
		const after = await canvasKeys.get({ sfOrgId: ORG_ID, canvasId: '069DEL', kekProvider: TEST_KEK });
		assert.equal(after, null);
	});
});
