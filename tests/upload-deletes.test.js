import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { executeUploadDeletes } from '../src/upload-deletes.js';
import { _deleteSalesforceRecordForTests as deleteSalesforceRecord } from '../src/canvas-routes.js';

const record = (objectName, prefix, n) => ({ tempId: n, objectName, sfId: prefix + String(n).padStart(12, '0') });
const account = record('Account', '001', 1);
const contact = record('Contact', '003', 2);
const case1 = record('Case', '500', 3);
const case2 = record('Case', '500', 4);
const unrelated = record('Account', '001', 5);
const reference = (name, ...referenceTo) => ({ name, referenceTo, type: 'reference' });

function harness(records, values = {}, options = {}) {
	const calls = [];
	const reads = [];
	const descriptions = options.descriptions || {
		Account: { deletable: true, fields: [reference('ParentId', 'Account')] },
		Contact: { deletable: true, fields: [reference('AccountId', 'Account')] },
		Case: { deletable: true, fields: [reference('ContactId', 'Contact'), reference('AccountId', 'Account')] },
	};
	const getDescribe = async (objectName) => descriptions[objectName];
	const conn = {
		sobject(objectName) {
			return {
				async retrieve(ids, { fields }) {
					reads.push({ objectName, ids, fields });
					if (options.readError) throw new Error('Read unavailable');
					return ids.map((Id) =>
						options.missing === Id
							? null
							: {
									...Object.fromEntries(fields.map((field) => [field, null])),
									Id,
									...values[Id],
								},
					);
				},
				async delete(id) {
					calls.push(id);
					await options.onDelete?.(id);
					if (options.fail === id)
						return {
							success: false,
							errors: [{ errorCode: 'DELETE_FAILED', message: 'Blocked by validation' }],
						};
					return { success: true };
				},
			};
		},
	};
	return {
		calls,
		reads,
		run: () =>
			executeUploadDeletes({
				conn,
				getDescribe,
				records,
				deleteRecord: (record) => deleteSalesforceRecord({ conn, getDescribe, record }),
			}),
	};
}

test('deletes both Cases before their Contact without any canvas associations', async () => {
	const h = harness([contact, case1, case2], {
		[case1.sfId]: { ContactId: contact.sfId + 'AAA' }, // 15/18-character IDs match
		[case2.sfId]: { ContactId: contact.sfId },
	});
	const results = await h.run();
	assert.deepEqual(h.calls, [case1.sfId, case2.sfId, contact.sfId]);
	assert.ok(results.every((r) => r.success));
	assert.deepEqual(h.reads, [{ objectName: 'Case', ids: [case1.sfId, case2.sfId], fields: ['Id', 'ContactId'] }]);
});

test('awaits the child response before attempting its parent', async () => {
	let release;
	let started;
	const waiting = new Promise((resolve) => {
		release = resolve;
	});
	const childStarted = new Promise((resolve) => {
		started = resolve;
	});
	const h = harness(
		[contact, case1],
		{ [case1.sfId]: { ContactId: contact.sfId } },
		{
			onDelete: async (id) => {
				if (id === case1.sfId) {
					started();
					await waiting;
				}
			},
		},
	);
	const result = h.run();
	await childStarted;
	assert.deepEqual(h.calls, [case1.sfId]);
	release();
	await result;
	assert.deepEqual(h.calls, [case1.sfId, contact.sfId]);
});

test('failed child blocks all ancestors while siblings and unrelated records still delete', async () => {
	const h = harness(
		[account, contact, case1, case2, unrelated],
		{
			[contact.sfId]: { AccountId: account.sfId },
			[case1.sfId]: { ContactId: contact.sfId },
			[case2.sfId]: { ContactId: contact.sfId },
		},
		{ fail: case1.sfId },
	);
	const results = await h.run();
	assert.deepEqual(h.calls, [case1.sfId, case2.sfId, unrelated.sfId]);
	assert.equal(results.find((r) => r.sfId === case1.sfId).error, 'Blocked by validation');
	for (const r of [contact, account])
		assert.equal(results.find((result) => result.sfId === r.sfId).errorCode, 'DELETE_DEPENDENCY_FAILED');
});

test('three levels delete grandchild, child, parent using persisted values despite staged reparenting', async () => {
	const stagedContact = { ...contact, values: { AccountId: unrelated.sfId }, loadedValues: { AccountId: null } };
	const h = harness([account, stagedContact, case1], {
		[contact.sfId]: { AccountId: account.sfId },
		[case1.sfId]: { ContactId: contact.sfId },
	});
	assert.ok((await h.run()).every((r) => r.success));
	assert.deepEqual(h.calls, [case1.sfId, contact.sfId, account.sfId]);
});

test('cycles are skipped while unrelated deletes complete', async () => {
	const h = harness([account, unrelated, contact], {
		[account.sfId]: { ParentId: unrelated.sfId },
		[unrelated.sfId]: { ParentId: account.sfId },
	});
	const results = await h.run();
	assert.deepEqual(h.calls, [contact.sfId]);
	assert.equal(results.filter((r) => r.errorCode === 'DELETE_DEPENDENCY_CYCLE').length, 2);
});

test('self-references and references outside the delete set do not add more deletes', async () => {
	const h = harness([account, contact], {
		[account.sfId]: { ParentId: account.sfId },
		[contact.sfId]: { AccountId: unrelated.sfId },
	});
	assert.ok((await h.run()).every((r) => r.success));
	assert.deepEqual(h.calls, [account.sfId, contact.sfId]);
});

for (const options of [{ readError: true }, { missing: case1.sfId }, { descriptions: {} }]) {
	test('unverifiable relationships prevent deletes: ' + JSON.stringify(options), async () => {
		const h = harness([contact, case1], {}, options);
		const results = await h.run();
		assert.deepEqual(h.calls, []);
		assert.ok(results.every((r) => r.errorCode === 'DELETE_DEPENDENCIES_UNAVAILABLE'));
	});
}

test('permission failures still prevent DML and block the parent', async () => {
	const h = harness(
		[contact, case1],
		{ [case1.sfId]: { ContactId: contact.sfId } },
		{
			descriptions: {
				Contact: { deletable: true, fields: [] },
				Case: { deletable: false, fields: [reference('ContactId', 'Contact')] },
			},
		},
	);
	const results = await h.run();
	assert.deepEqual(h.calls, []);
	assert.equal(results[0].errorCode, 'INSUFFICIENT_ACCESS_OR_READONLY');
	assert.equal(results[1].errorCode, 'DELETE_DEPENDENCY_FAILED');
});

test('relationship reads are batched in groups of at most 200', async () => {
	const cases = Array.from({ length: 401 }, (_, i) => record('Case', '500', i + 10));
	const values = Object.fromEntries(cases.map((r) => [r.sfId, { ContactId: contact.sfId }]));
	const h = harness([contact, ...cases], values);
	assert.ok((await h.run()).every((r) => r.success));
	assert.deepEqual(
		h.reads.map((r) => r.ids.length),
		[200, 200, 1],
	);
	assert.equal(h.calls.at(-1), contact.sfId);
});

test('empty and single deletes need no dependency reads', async () => {
	const empty = harness([]);
	assert.deepEqual(await empty.run(), []);
	const single = harness([contact]);
	assert.ok((await single.run())[0].success);
	assert.deepEqual(single.reads, []);
});

test('all three upload routes use dependency-aware deletion and retain the graph rollback guard', () => {
	const source = readFileSync(new URL('../src/canvas-routes.js', import.meta.url), 'utf8');
	for (const route of ['/api/upload', '/api/upload/graph', '/api/upload/bulk']) {
		const start = source.indexOf("app.post('" + route + "'");
		const end = source.indexOf('\n\tapp.', start + 1);
		const block = source.slice(start, end);
		assert.match(block, /await executeUploadDeletes\(/);
		assert.doesNotMatch(block, /await _deleteSalesforceRecord\(/);
		if (route.endsWith('/graph')) assert.match(block, /records.length === 0 \|\| someGraphCommitted/);
	}
});
