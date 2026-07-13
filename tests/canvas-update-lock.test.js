import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { canvasStoreFromSfConnection } from '../src/storage/canvas-store.js';
import { initTestDb, clearTestDb } from './helpers/db.js';
import { installSfFetchStub } from './helpers/sf-kek-stub.js';

const ORG_ID = '00DTEST00000001';
const CANVAS = '069LOCK0000001';

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

function makeStatefulConn(canvasId, opts = {}) {
	const state = { latest: opts.initialVersion || '068V0', counter: 0 };
	const createDelayMs = opts.createDelayMs || 5;
	return {
		instanceUrl: 'https://test.my.salesforce.com',
		accessToken: 'TEST_TOKEN',
		_state: state,
		async query(soql) {
			if (/ContentDocumentLink/.test(soql)) {
				return { records: [{ Id: 'cdl_' + canvasId }] };
			}
			if (/Orgloom_Canvas__c/.test(soql)) {
				return { records: [{ Id: 'a0' + canvasId }] };
			}
			if (/FROM ContentVersion\b/.test(soql)) {
				return { records: [{ Id: state.latest }] };
			}
			if (/FROM ContentDocument\b/.test(soql)) {
				return { records: [{ Id: canvasId, Title: 'lock-test' }] };
			}
			return { records: [] };
		},
		sobject(name) {
			return {
				async create(payload) {
					if (name === 'ContentVersion') {

						await new Promise((r) => setTimeout(r, createDelayMs));
						state.counter += 1;
						state.latest = '068V' + state.counter;
						return { success: true, id: state.latest };
					}
					return { success: true, id: 'x_' + name };
				},
				async upsert() {
 return { success: true }; 
},
				async update() {
 return { success: true }; 
},
				async retrieve() {
 return null; 
},
				async destroy() {
 return { success: true }; 
},
			};
		},
	};
}

describe('canvas update: per-canvas optimistic-lock serialization', () => {
	test('two concurrent overwrites from the same base version: one wins, one 409s', async () => {
		const conn = makeStatefulConn(CANVAS, { initialVersion: '068V0', createDelayMs: 10 });
		const store = await canvasStoreFromSfConnection(conn, '005MINE', ORG_ID, { sessionId: 'lock-sess' });

		const results = await Promise.allSettled([
			store.update(CANVAS, { payload: { who: 'A' }, expectedVersionId: '068V0' }),
			store.update(CANVAS, { payload: { who: 'B' }, expectedVersionId: '068V0' }),
		]);

		const fulfilled = results.filter((r) => r.status === 'fulfilled');
		const rejected = results.filter((r) => r.status === 'rejected');
		assert.equal(fulfilled.length, 1, 'exactly one concurrent save commits');
		assert.equal(rejected.length, 1, 'the other is rejected, not silently lost');
		assert.equal(rejected[0].reason.statusCode, 409);
		assert.equal(rejected[0].reason.code, 'version-mismatch');

		assert.equal(conn._state.counter, 1, 'only one ContentVersion was written');
	});

	test('sequential: a stale expectedVersionId after a prior save 409s (check survives the lock)', async () => {
		const conn = makeStatefulConn(CANVAS, { initialVersion: '068V0' });
		const store = await canvasStoreFromSfConnection(conn, '005MINE', ORG_ID, { sessionId: 'seq-sess' });

		const first = await store.update(CANVAS, { payload: { n: 1 }, expectedVersionId: '068V0' });
		assert.equal(first.versionId, '068V1', 'first write advances the version');

		await assert.rejects(
			() => store.update(CANVAS, { payload: { n: 2 }, expectedVersionId: '068V0' }),
			(err) => {
				assert.equal(err.statusCode, 409);
				assert.equal(err.code, 'version-mismatch');
				assert.equal(err.currentVersionId, '068V1');
				return true;
			},
		);
	});

	test('matching expectedVersionId proceeds end-to-end (happy path through the lock)', async () => {
		const conn = makeStatefulConn(CANVAS, { initialVersion: '068V0' });
		const store = await canvasStoreFromSfConnection(conn, '005MINE', ORG_ID, { sessionId: 'ok-sess' });
		const res = await store.update(CANVAS, { payload: { ok: true }, expectedVersionId: '068V0' });
		assert.equal(res.id, CANVAS);
		assert.equal(res.versionId, '068V1');
	});

	test('a failing update releases the lock (no deadlock for the next save)', async () => {
		const conn = makeStatefulConn(CANVAS, { initialVersion: '068V0' });
		const store = await canvasStoreFromSfConnection(conn, '005MINE', ORG_ID, { sessionId: 'rel-sess' });

		await assert.rejects(() => store.update(CANVAS, { payload: {}, expectedVersionId: '068STALE' }));
		const ok = await store.update(CANVAS, { payload: { after: 'fail' }, expectedVersionId: '068V0' });
		assert.equal(ok.versionId, '068V1');
	});
});
