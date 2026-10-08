import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
	_fetchCanonicalValuesForUpload,
	_buildBatchEntryFromResult,
	_capturePreUploadState,
} from '../src/canvas-routes.js';

describe('_buildBatchEntryFromResult (canonical-values preference)', () => {
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
		assert.equal(
			entry.uploadedValues.Industry,
			'Technology',
			'trigger-transformed value must land in uploadedValues, not what we wrote',
		);
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
		assert.equal(
			entry.uploadedValues.Phone,
			'555-1234',
			'Phone falls back to client value when canonical lacks it',
		);
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

	test('CREATE row stores its exact post-upload modification baseline', () => {
		const r = { tempId: 1, id: '001abc', objectName: 'Account', mode: 'create', success: true };
		const rec = {
			values: { Industry: 'Tech' },
			loadedValues: undefined,
		};
		const canonical = {
			values: { Industry: 'Technology' },
			uploadLastModifiedDate: '2026-08-08T12:00:00.000Z',
		};
		const entry = _buildBatchEntryFromResult(r, rec, canonical);
		assert.equal(entry.priorValues, undefined);
		assert.equal(entry.uploadedValues, undefined);
		assert.equal(entry.mode, 'create');
		assert.equal(entry.uploadLastModifiedDate, '2026-08-08T12:00:00.000Z');
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

	test('UPDATE recall baseline comes from Salesforce immediately before upload', () => {
		const r = { tempId: 1, id: '001abc', objectName: 'Account', mode: 'update', success: true };
		const rec = {
			values: { Name: 'Canvas name', Phone: '555-1111' },
			loadedValues: { Name: 'Old loaded name', Phone: '555-1111' },
		};
		const canonical = { values: { Name: 'Canvas name' } };
		const preUpload = {
			values: { Name: 'Salesforce name at upload' },
			capturedAt: 1786200000000,
		};
		const entry = _buildBatchEntryFromResult(r, rec, canonical, preUpload);
		assert.deepEqual(entry.priorValues, { Name: 'Salesforce name at upload' });
		assert.deepEqual(entry.uploadedValues, { Name: 'Canvas name' });
		assert.equal(entry.preUploadCapturedAt, 1786200000000);
		assert.equal(entry.priorValues.Phone, undefined, 'untouched fields do not enter the recall ledger');
	});

	test('encrypted fields are not retained in the recall ledger', () => {
		const r = { tempId: 1, id: '001abc', objectName: 'Account', mode: 'update', success: true };
		const rec = {
			values: { Name: 'Canvas name', Secret__c: 'replacement' },
			loadedValues: { Name: 'Old name' },
		};
		const canonical = { values: { Name: 'Canvas name', Secret__c: 'replacement' } };
		const preUpload = { values: { Name: 'Old name', Secret__c: 'original secret' } };
		const entry = _buildBatchEntryFromResult(r, rec, canonical, preUpload, new Set(['Secret__c']));

		assert.deepEqual(entry.priorValues, { Name: 'Old name' });
		assert.deepEqual(entry.uploadedValues, { Name: 'Canvas name' });
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

const accountDescribe = {
	fields: [
		{ name: 'Name', updateable: true },
		{ name: 'Phone', updateable: true },
		{ name: 'ParentId', updateable: true },
	],
};

describe('_capturePreUploadState', () => {
	test('captures and compares only fields that will actually be uploaded', async () => {
		const conn = makeQueryConn({
			'001abc': {
				Id: '001abc',
				Name: 'Changed elsewhere',
				Phone: '555-1111',
				LastModifiedDate: '2026-08-08T12:00:00.000Z',
			},
		});
		const capture = await _capturePreUploadState({
			conn,
			records: [
				{
					tempId: 1,
					objectName: 'Account',
					loadedFromId: '001abc',
					values: { Name: 'Loaded name', Phone: '555-2222' },
					loadedValues: { Name: 'Loaded name', Phone: '555-1111' },
				},
			],
			skipTempIds: new Set(),
			associations: [],
			getDescribe: async () => accountDescribe,
		});

		assert.equal(capture.conflicts.length, 0, 'an untouched stale Name must not block a Phone-only upload');
		assert.deepEqual(capture.snapshotByTempId.get(1).values, { Phone: '555-1111' });
		assert.match(conn.calls.queries[0], /Phone/);
		assert.doesNotMatch(conn.calls.queries[0], /\bName\b/);
	});

	test('requires an exact review when an uploaded field changed in Salesforce', async () => {
		const conn = makeQueryConn({
			'001abc': {
				Id: '001abc',
				Phone: '555-3333',
				LastModifiedDate: '2026-08-08T12:00:00.000Z',
			},
		});
		const record = {
			tempId: 1,
			objectName: 'Account',
			loadedFromId: '001abc',
			values: { Phone: '555-2222' },
			loadedValues: { Phone: '555-1111' },
		};
		const first = await _capturePreUploadState({
			conn,
			records: [record],
			skipTempIds: new Set(),
			associations: [],
			getDescribe: async () => accountDescribe,
		});
		assert.deepEqual(first.conflicts[0].fields, [
			{ fieldName: 'Phone', loaded: '555-1111', current: '555-3333', canvas: '555-2222' },
		]);

		const confirmed = await _capturePreUploadState({
			conn,
			records: [record],
			skipTempIds: new Set(),
			associations: [],
			getDescribe: async () => accountDescribe,
			baselineConfirmations: [{ sfId: '001abc', fields: [{ fieldName: 'Phone', expectedCurrent: '555-3333' }] }],
		});
		assert.equal(confirmed.conflicts.length, 0);
	});

	test('rejects a stale confirmation if Salesforce changes again', async () => {
		const conn = makeQueryConn({
			'001abc': { Id: '001abc', Phone: '555-4444', LastModifiedDate: '2026-08-08T12:01:00.000Z' },
		});
		const capture = await _capturePreUploadState({
			conn,
			records: [
				{
					tempId: 1,
					objectName: 'Account',
					loadedFromId: '001abc',
					values: { Phone: '555-2222' },
					loadedValues: { Phone: '555-1111' },
				},
			],
			skipTempIds: new Set(),
			associations: [],
			getDescribe: async () => accountDescribe,
			baselineConfirmations: [{ sfId: '001abc', fields: [{ fieldName: 'Phone', expectedCurrent: '555-3333' }] }],
		});
		assert.equal(capture.conflicts[0].fields[0].current, '555-4444');
	});

	test('fails closed when the Salesforce baseline query fails', async () => {
		await assert.rejects(
			_capturePreUploadState({
				conn: { query: async () => Promise.reject(new Error('connection unavailable')) },
				records: [
					{
						tempId: 1,
						objectName: 'Account',
						loadedFromId: '001abc',
						values: { Phone: '555-2222' },
						loadedValues: { Phone: '555-1111' },
					},
				],
				skipTempIds: new Set(),
				associations: [],
				getDescribe: async () => accountDescribe,
			}),
			/connection unavailable/,
		);
	});
});

describe('_fetchCanonicalValuesForUpload', () => {
	function connection(stateById, calls = []) {
		return {
			sobject(objectName) {
				return {
					async retrieve(ids) {
						calls.push({ objectName, ids });
						return ids.map((id) => stateById[id]).filter(Boolean);
					},
				};
			},
		};
	}
	test('retrieves the complete accessible record, including server-generated lookups and audit fields', async () => {
		const values = {
			Id: '500abc',
			ContactId: '003abc',
			AccountId: '001abc',
			LastModifiedDate: '2026-10-07T12:00:00Z',
			Formula__c: 42,
			Description: null,
		};
		const record = { values: { ContactId: '003abc' }, canonicalFields: ['ContactId'] };
		const calls = [];
		const out = await _fetchCanonicalValuesForUpload({
			conn: connection({ '500abc': { ...values, attributes: { type: 'Case' } } }, calls),
			results: [{ tempId: 1, id: '500abc', objectName: 'Case', mode: 'create', success: true }],
			recordsById: new Map([[1, record]]),
		});
		assert.deepEqual(out.get(1).values, values);
		assert.equal(out.get(1).uploadLastModifiedDate, values.LastModifiedDate);
		assert.deepEqual(calls, [{ objectName: 'Case', ids: ['500abc'] }]);
		assert.deepEqual(record.values, { ContactId: '003abc' }, 'reads do not broaden submitted writes');
	});
	test('only successfully written records are refreshed, grouped by object', async () => {
		const calls = [];
		const results = [
			{ tempId: 1, id: '001a', objectName: 'Account', success: true },
			{ tempId: 2, id: '001b', objectName: 'Account', success: false },
			{ tempId: 3, id: '001c', objectName: 'Account', success: true, mode: 'unchanged' },
			{ tempId: 4, id: '001d', objectName: 'Account', success: true },
			{ tempId: 5, id: '001e', objectName: 'Account', success: true },
		];
		const out = await _fetchCanonicalValuesForUpload({
			conn: connection({ '001a': { Id: '001a' }, '001e': { Id: '001e' } }, calls),
			results,
			recordsById: new Map([
				[1, {}],
				[2, {}],
				[3, {}],
				[5, {}],
			]),
		});
		assert.deepEqual(calls, [{ objectName: 'Account', ids: ['001a', '001e'] }]);
		assert.deepEqual([...out.keys()], [1, 5]);
	});
	test('empty or invalid input does not issue reads', async () => {
		const calls = [];
		const conn = connection({}, calls);
		assert.equal((await _fetchCanonicalValuesForUpload({ conn, results: [], recordsById: new Map() })).size, 0);
		assert.equal(
			(
				await _fetchCanonicalValuesForUpload({
					conn,
					results: [{ tempId: 1, id: '001abc', objectName: 'Bad; DROP TABLE', success: true }],
					recordsById: new Map([[1, {}]]),
				})
			).size,
			0,
		);
		assert.deepEqual(calls, []);
	});
	test('read failures leave successful writes intact and signal missing refresh values', async () => {
		const result = { tempId: 1, id: '001abc', objectName: 'Account', success: true, mode: 'update' };
		const out = await _fetchCanonicalValuesForUpload({
			conn: {
				sobject() {
					return {
						retrieve: async () => {
							throw new Error('read failed');
						},
					};
				},
			},
			results: [result],
			recordsById: new Map([[1, { values: { Name: 'Saved' } }]]),
		});
		assert.equal(out.size, 0);
		assert.equal(result.success, true);
	});
});

import { _orderDeletesChildrenFirst } from '../src/canvas-routes.js';

describe('_orderDeletesChildrenFirst', () => {
	const del = (tempId) => ({ tempId, sfId: 'id' + tempId, objectName: 'X' });

	test('child deletes before parent regardless of received order', () => {
		const deletes = [del(1), del(2)]; // 1 = parent first (canvas order)
		const assoc = [{ fromId: 2, toId: 1, fieldName: 'ParentId' }];
		const ordered = _orderDeletesChildrenFirst(deletes, assoc);
		assert.deepEqual(
			ordered.map((d) => d.tempId),
			[2, 1],
			'child (2) first, parent (1) last',
		);
	});

	test('three-level chain orders grandchild → child → parent', () => {
		const deletes = [del(1), del(2), del(3)]; // parent, child, grandchild
		const assoc = [
			{ fromId: 2, toId: 1 },
			{ fromId: 3, toId: 2 },
		];
		const ordered = _orderDeletesChildrenFirst(deletes, assoc);
		assert.deepEqual(
			ordered.map((d) => d.tempId),
			[3, 2, 1],
		);
	});

	test('unlinked deletes keep relative order; associations to non-deleted records are ignored', () => {
		const deletes = [del(1), del(2), del(3)];
		const assoc = [{ fromId: 99, toId: 1 }];
		const ordered = _orderDeletesChildrenFirst(deletes, assoc);
		assert.deepEqual(
			ordered.map((d) => d.tempId),
			[1, 2, 3],
			'no reorder without in-set edges',
		);
	});

	test('entries missing sfId/tempId run last, in original order', () => {
		const broken = { tempId: null, sfId: null, objectName: 'X' };
		const deletes = [broken, del(1), del(2)];
		const assoc = [{ fromId: 2, toId: 1 }];
		const ordered = _orderDeletesChildrenFirst(deletes, assoc);
		assert.deepEqual(
			ordered.map((d) => d.tempId),
			[2, 1, null],
		);
	});

	test('empty and single-entry inputs pass through', () => {
		assert.deepEqual(_orderDeletesChildrenFirst([], []), []);
		const one = [del(1)];
		assert.deepEqual(_orderDeletesChildrenFirst(one, []), one);
		assert.deepEqual(_orderDeletesChildrenFirst(null, []), []);
	});
});
