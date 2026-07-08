















import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
	_fetchCanonicalValuesForUpload,
	_buildBatchEntryFromResult,
} from '../src/canvas-routes.js';

describe('_buildBatchEntryFromResult — canonical-values preference', () => {
	test('without canonical → uploadedValues mirrors rec.values (legacy path)', () => {
		const r = { tempId: 1, id: '001abc', objectName: 'Account', mode: 'update', success: true };
		const rec = {
			values: { Industry: 'Tech', Phone: '555-1234' },
			loadedValues: { Industry: 'Old', Phone: '555-0000' },
		};
		const entry = _buildBatchEntryFromResult(r, rec);
		assert.deepEqual(entry.uploadedValues, { Industry: 'Tech', Phone: '555-1234' });
		assert.deepEqual(entry.priorValues, { Industry: 'Old', Phone: '555-0000' });
	});

	test('with canonical → uploadedValues uses post-trigger value', () => {
		const r = { tempId: 1, id: '001abc', objectName: 'Account', mode: 'update', success: true };
		const rec = {
			values: { Industry: 'Tech', Phone: '555-1234' },
			loadedValues: { Industry: 'Old', Phone: '555-0000' },
		};

		const canonical = { values: { Industry: 'Technology', Phone: '555-1234' } };
		const entry = _buildBatchEntryFromResult(r, rec, canonical);
		assert.equal(entry.uploadedValues.Industry, 'Technology',
			'trigger-transformed value must land in uploadedValues, not what we wrote');
		assert.equal(entry.uploadedValues.Phone, '555-1234');

		assert.equal(entry.priorValues.Industry, 'Old');
	});

	test('canonical missing one field → fall back to what we wrote for that field', () => {
		const r = { tempId: 1, id: '001abc', objectName: 'Account', mode: 'update', success: true };
		const rec = {
			values: { Industry: 'Tech', Phone: '555-1234' },
			loadedValues: { Industry: 'Old', Phone: '555-0000' },
		};

		const canonical = { values: { Industry: 'Technology' } };
		const entry = _buildBatchEntryFromResult(r, rec, canonical);
		assert.equal(entry.uploadedValues.Industry, 'Technology');
		assert.equal(entry.uploadedValues.Phone, '555-1234',
			'Phone falls back to client value when canonical lacks it');
	});

	test('canonical with extra fields not in rec.values is ignored', () => {
		const r = { tempId: 1, id: '001abc', objectName: 'Account', mode: 'update', success: true };
		const rec = {
			values: { Industry: 'Tech' },
			loadedValues: { Industry: 'Old' },
		};

		const canonical = { values: { Industry: 'Technology', AuditField: 'set-by-workflow' } };
		const entry = _buildBatchEntryFromResult(r, rec, canonical);

		assert.deepEqual(Object.keys(entry.uploadedValues), ['Industry']);
	});

	test('CREATE row → no priorValues/uploadedValues regardless of canonical', () => {
		const r = { tempId: 1, id: '001abc', objectName: 'Account', mode: 'create', success: true };
		const rec = {
			values: { Industry: 'Tech' },
			loadedValues: undefined,
		};
		const canonical = { values: { Industry: 'Technology' } };
		const entry = _buildBatchEntryFromResult(r, rec, canonical);
		assert.equal(entry.priorValues, undefined);
		assert.equal(entry.uploadedValues, undefined);
		assert.equal(entry.mode, 'create');
	});

	test('UPDATE with all values matching loadedValues → no entry (nothing changed)', () => {



		const r = { tempId: 1, id: '001abc', objectName: 'Account', mode: 'update', success: true };
		const rec = {
			values: { Industry: 'Tech' },
			loadedValues: { Industry: 'Tech' },
		};
		const canonical = { values: { Industry: 'Technology' } };
		const entry = _buildBatchEntryFromResult(r, rec, canonical);
		assert.equal(entry.priorValues, undefined);
		assert.equal(entry.uploadedValues, undefined);
	});
});




function makeQueryConn(stateById) {
	const calls = { queries: [] };
	return {
		calls,
		async query(soql) {
			calls.queries.push(soql);
			const idsMatch = soql.match(/Id IN \(([^)]+)\)/);
			if (!idsMatch) {
return { records: [] };
}
			const ids = idsMatch[1].split(',').map((s) => s.replace(/^'|'$/g, '').trim());
			const selMatch = soql.match(/^SELECT\s+(.+?)\s+FROM/i);
			const fields = selMatch ? selMatch[1].split(',').map((f) => f.trim()) : ['Id'];
			const records = ids
				.map((id) => stateById[id])
				.filter(Boolean)
				.map((state) => {
					const row = {};
					for (const f of fields) {
						row[f] = state[f] !== undefined ? state[f] : null;
					}
					return row;
				});
			return { records };
		},
	};
}

describe('_fetchCanonicalValuesForUpload', () => {
	test('returns empty map for empty results array', async () => {
		const conn = makeQueryConn({});
		const out = await _fetchCanonicalValuesForUpload({
			conn, results: [], recordsById: new Map(),
		});
		assert.equal(out.size, 0);
		assert.equal(conn.calls.queries.length, 0);
	});

	test('returns post-trigger values keyed by tempId', async () => {
		const conn = makeQueryConn({
			'001abc': { Id: '001abc', Industry: 'Technology', Phone: '555-1234' },
		});
		const results = [
			{ tempId: 1, id: '001abc', objectName: 'Account', mode: 'update', success: true },
		];
		const recordsById = new Map([
			[1, { values: { Industry: 'Tech', Phone: '555-1234' }, loadedValues: { Industry: 'Old', Phone: '555-0000' } }],
		]);
		const out = await _fetchCanonicalValuesForUpload({ conn, results, recordsById });
		assert.equal(out.size, 1);
		assert.deepEqual(out.get(1).values, {
			Industry: 'Technology',
			Phone: '555-1234',
		});
		assert.equal(out.get(1).sfId, '001abc');
		assert.equal(out.get(1).objectName, 'Account');
	});

	test('multiple records of the same object batched into one SOQL', async () => {
		const conn = makeQueryConn({
			'001a': { Id: '001a', Industry: 'A' },
			'001b': { Id: '001b', Industry: 'B' },
		});
		const results = [
			{ tempId: 1, id: '001a', objectName: 'Account', mode: 'update', success: true },
			{ tempId: 2, id: '001b', objectName: 'Account', mode: 'update', success: true },
		];
		const recordsById = new Map([
			[1, { values: { Industry: 'a' }, loadedValues: { Industry: 'x' } }],
			[2, { values: { Industry: 'b' }, loadedValues: { Industry: 'x' } }],
		]);
		await _fetchCanonicalValuesForUpload({ conn, results, recordsById });
		assert.equal(conn.calls.queries.length, 1,
			'records of the same object should hit SF in one SOQL, not N');
	});

	test('skipped: failed results, unchanged results, and results without recordsById entry', async () => {
		const conn = makeQueryConn({
			'001a': { Id: '001a', Industry: 'A' },
		});
		const results = [
			{ tempId: 1, id: '001a', objectName: 'Account', mode: 'update', success: true },
			{ tempId: 2, id: '001b', objectName: 'Account', mode: 'update', success: false },
			{ tempId: 3, id: '001c', objectName: 'Account', mode: 'unchanged', success: true },
			{ tempId: 4, id: '001d', objectName: 'Account', mode: 'update', success: true },
		];
		const recordsById = new Map([
			[1, { values: { Industry: 'a' } }],
			[2, { values: { Industry: 'b' } }],
			[3, { values: { Industry: 'c' } }],

		]);
		await _fetchCanonicalValuesForUpload({ conn, results, recordsById });

		const soql = conn.calls.queries[0] || '';
		assert.match(soql, /'001a'/);
		assert.doesNotMatch(soql, /'001b'/, 'failed result must not be queried');
		assert.doesNotMatch(soql, /'001c'/, 'unchanged result must not be queried');
		assert.doesNotMatch(soql, /'001d'/, 'result missing from recordsById must not be queried');
	});

	test('field names with bad shape are dropped from the SELECT (SOQL injection defense)', async () => {
		const conn = makeQueryConn({
			'001a': { Id: '001a', Industry: 'Banking' },
		});
		const results = [
			{ tempId: 1, id: '001a', objectName: 'Account', mode: 'update', success: true },
		];
		const recordsById = new Map([
			[1, {
				values: { Industry: 'a', 'BadField; DROP TABLE': 'x' },
				loadedValues: { Industry: 'x' },
			}],
		]);
		await _fetchCanonicalValuesForUpload({ conn, results, recordsById });
		const soql = conn.calls.queries[0] || '';
		assert.doesNotMatch(soql, /DROP TABLE/,
			'malformed field names must not reach the SOQL');
	});

	test('SOQL failure leaves the tempId missing from the returned map (graceful fallback)', async () => {
		const conn = {
			calls: { queries: [] },
			async query(soql) {
				this.calls.queries.push(soql);
				throw new Error('INSUFFICIENT_ACCESS');
			},
		};
		const results = [
			{ tempId: 1, id: '001a', objectName: 'Account', mode: 'update', success: true },
		];
		const recordsById = new Map([
			[1, { values: { Industry: 'a' }, loadedValues: { Industry: 'x' } }],
		]);
		const out = await _fetchCanonicalValuesForUpload({ conn, results, recordsById });



		assert.equal(out.size, 0);
	});

	test('field names from both rec.values AND rec.loadedValues are included in the SELECT', async () => {




		const conn = makeQueryConn({
			'001a': { Id: '001a' },
		});
		const results = [
			{ tempId: 1, id: '001a', objectName: 'Account', mode: 'update', success: true },
		];
		const recordsById = new Map([
			[1, {
				values: { Industry: 'a' },
				loadedValues: { Industry: 'x', Phone: '555-0000' },
			}],
		]);
		await _fetchCanonicalValuesForUpload({ conn, results, recordsById });
		const soql = conn.calls.queries[0] || '';
		assert.match(soql, /Industry/, 'Industry must be in SELECT');
		assert.match(soql, /Phone/, 'Phone (loaded but not written) must also be in SELECT');
	});

	test('object name with bad shape is silently skipped (defense in depth)', async () => {
		const conn = makeQueryConn({});
		const results = [
			{ tempId: 1, id: '001a', objectName: 'Bad; DROP TABLE', mode: 'update', success: true },
		];
		const recordsById = new Map([
			[1, { values: { Industry: 'a' } }],
		]);
		const out = await _fetchCanonicalValuesForUpload({ conn, results, recordsById });
		assert.equal(out.size, 0);
		assert.equal(conn.calls.queries.length, 0);
	});
});






import { _orderDeletesChildrenFirst } from '../src/canvas-routes.js';

describe('_orderDeletesChildrenFirst', () => {
	const del = (tempId) => ({ tempId, sfId: 'id' + tempId, objectName: 'X' });

	test('child deletes before parent regardless of received order', () => {

		const deletes = [del(1), del(2)];
		const assoc = [{ fromId: 2, toId: 1, fieldName: 'ParentId' }];
		const ordered = _orderDeletesChildrenFirst(deletes, assoc);
		assert.deepEqual(ordered.map((d) => d.tempId), [2, 1], 'child (2) first, parent (1) last');
	});

	test('three-level chain orders grandchild → child → parent', () => {
		const deletes = [del(1), del(2), del(3)];
		const assoc = [
			{ fromId: 2, toId: 1 },
			{ fromId: 3, toId: 2 },
		];
		const ordered = _orderDeletesChildrenFirst(deletes, assoc);
		assert.deepEqual(ordered.map((d) => d.tempId), [3, 2, 1]);
	});

	test('unlinked deletes keep relative order; associations to non-deleted records are ignored', () => {
		const deletes = [del(1), del(2), del(3)];

		const assoc = [{ fromId: 99, toId: 1 }];
		const ordered = _orderDeletesChildrenFirst(deletes, assoc);
		assert.deepEqual(ordered.map((d) => d.tempId), [1, 2, 3], 'no reorder without in-set edges');
	});

	test('entries missing sfId/tempId run last, in original order', () => {
		const broken = { tempId: null, sfId: null, objectName: 'X' };
		const deletes = [broken, del(1), del(2)];
		const assoc = [{ fromId: 2, toId: 1 }];
		const ordered = _orderDeletesChildrenFirst(deletes, assoc);
		assert.deepEqual(ordered.map((d) => d.tempId), [2, 1, null]);
	});

	test('empty and single-entry inputs pass through', () => {
		assert.deepEqual(_orderDeletesChildrenFirst([], []), []);
		const one = [del(1)];
		assert.deepEqual(_orderDeletesChildrenFirst(one, []), one);
		assert.deepEqual(_orderDeletesChildrenFirst(null, []), []);
	});
});
