import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyValueDrift, executeRecall } from '../src/upload-recall.js';

function makeQueryConn(stateById) {
	return {
		version: '60.0',
		request: async ({ method, url }) => {
			if (method !== 'GET') {
return { records: [] };
}
			const qIdx = url.indexOf('?q=');
			if (qIdx < 0) {
return { records: [] };
}
			const soql = decodeURIComponent(url.slice(qIdx + 3));

			const selMatch = soql.match(/^SELECT\s+(.+?)\s+FROM/i);
			const fields = selMatch
				? selMatch[1].split(',').map((f) => f.trim())
				: ['Id'];
			const idsMatch = soql.match(/Id IN \(([^)]+)\)/);
			if (!idsMatch) {
return { records: [] };
}
			const ids = idsMatch[1].split(',').map((s) => s.replace(/^'|'$/g, '').trim());
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

function makeUpdateRow({ tempId = 't1', sfId = '001abc', objectName = 'Account', label = null, priorValues = {}, uploadedValues = {} }) {
	return { tempId, sfId, objectName, mode: 'update', label, priorValues, uploadedValues };
}

describe('classifyValueDrift', () => {
	test('empty batch returns empty results', async () => {
		const conn = makeQueryConn({});
		const result = await classifyValueDrift({ conn, batch: { insertedIds: [] } });
		assert.deepEqual(result.records, []);
		assert.equal(result.summary.eligibleRecords, 0);
	});

	test('batch with only CREATE rows is ignored (nothing to revert)', async () => {
		const conn = makeQueryConn({});
		const result = await classifyValueDrift({
			conn,
			batch: { insertedIds: [
				{ tempId: 't1', sfId: '001abc', objectName: 'Account', mode: 'create' },
			] },
		});
		assert.deepEqual(result.records, []);
		assert.equal(result.summary.eligibleRecords, 0);
	});

	test('UPDATE row without priorValues/uploadedValues is skipped (legacy batch)', async () => {
		const conn = makeQueryConn({
			'001abc': { Id: '001abc', Industry: 'Tech' },
		});
		const result = await classifyValueDrift({
			conn,
			batch: { insertedIds: [
				{ tempId: 't1', sfId: '001abc', objectName: 'Account', mode: 'update' },
			] },
		});
		assert.deepEqual(result.records, []);
		assert.equal(result.summary.eligibleRecords, 0);
	});

	test('SF current matches uploadedValues → clean (safe to revert)', async () => {
		const conn = makeQueryConn({
			'001abc': { Id: '001abc', Industry: 'Banking', Phone: '555-1234' },
		});
		const row = makeUpdateRow({
			sfId: '001abc',
			priorValues: { Industry: 'Tech', Phone: '555-0000' },
			uploadedValues: { Industry: 'Banking', Phone: '555-1234' },
		});
		const result = await classifyValueDrift({ conn, batch: { insertedIds: [row] } });
		assert.equal(result.records.length, 1);
		const rec = result.records[0];
		assert.equal(rec.clean.length, 2);
		assert.equal(rec.drifted.length, 0);
		assert.equal(rec.reverted.length, 0);
		assert.equal(rec.notFound, false);
		assert.equal(result.summary.cleanFieldCount, 2);
		assert.equal(result.summary.driftedFieldCount, 0);
		assert.equal(result.summary.driftedRecords, 0);
	});

	test('SF current differs from uploaded AND prior → drifted (someone touched it)', async () => {
		const conn = makeQueryConn({
			'001abc': { Id: '001abc', Industry: 'Healthcare', Phone: '555-1234' },
		});
		const row = makeUpdateRow({
			sfId: '001abc',
			priorValues: { Industry: 'Tech', Phone: '555-0000' },
			uploadedValues: { Industry: 'Banking', Phone: '555-1234' },
		});
		const result = await classifyValueDrift({ conn, batch: { insertedIds: [row] } });
		const rec = result.records[0];

		assert.equal(rec.drifted.length, 1);
		assert.equal(rec.drifted[0].fieldName, 'Industry');
		assert.equal(rec.drifted[0].current, 'Healthcare');
		assert.equal(rec.drifted[0].uploaded, 'Banking');
		assert.equal(rec.drifted[0].prior, 'Tech');
		assert.equal(rec.clean.length, 1);
		assert.equal(rec.clean[0].fieldName, 'Phone');
		assert.equal(result.summary.driftedRecords, 1);
	});

	test('SF current matches priorValues → reverted (already rolled back)', async () => {
		const conn = makeQueryConn({
			'001abc': { Id: '001abc', Industry: 'Tech' },
		});
		const row = makeUpdateRow({
			sfId: '001abc',
			priorValues: { Industry: 'Tech' },
			uploadedValues: { Industry: 'Banking' },
		});
		const result = await classifyValueDrift({ conn, batch: { insertedIds: [row] } });
		const rec = result.records[0];
		assert.equal(rec.reverted.length, 1);
		assert.equal(rec.clean.length, 0);
		assert.equal(rec.drifted.length, 0);
	});

	test('SF record missing → notFound (deleted out of band, can\'t revert)', async () => {
		const conn = makeQueryConn({});
		const row = makeUpdateRow({
			sfId: '001abc',
			priorValues: { Industry: 'Tech' },
			uploadedValues: { Industry: 'Banking' },
		});
		const result = await classifyValueDrift({ conn, batch: { insertedIds: [row] } });
		const rec = result.records[0];
		assert.equal(rec.notFound, true);
		assert.equal(rec.clean.length, 0);
		assert.equal(rec.drifted.length, 0);
	});

	test('loose equality covers JSON round-trip coercions (5 vs "5")', async () => {
		const conn = makeQueryConn({
			'001abc': { Id: '001abc', NumberField: 5 },
		});
		const row = makeUpdateRow({
			sfId: '001abc',
			priorValues: { NumberField: 1 },
			uploadedValues: { NumberField: '5' },
		});
		const result = await classifyValueDrift({ conn, batch: { insertedIds: [row] } });
		const rec = result.records[0];

		assert.equal(rec.clean.length, 1);
		assert.equal(rec.drifted.length, 0);
	});

	test('field name with bad shape gets dropped from the SOQL SELECT', async () => {

		const conn = makeQueryConn({
			'001abc': { Id: '001abc', Industry: 'Banking' },
		});
		const row = makeUpdateRow({
			sfId: '001abc',
			priorValues: { Industry: 'Tech', 'BadField; DROP TABLE': 'x' },
			uploadedValues: { Industry: 'Banking', 'BadField; DROP TABLE': 'y' },
		});

		const result = await classifyValueDrift({ conn, batch: { insertedIds: [row] } });
		const rec = result.records[0];
		const industryEntry = [...rec.clean, ...rec.drifted, ...rec.reverted]
			.find((c) => c.fieldName === 'Industry');
		assert.ok(industryEntry, 'Industry must still be classified');
	});

	test('multiple records of the same object batched into one SOQL', async () => {

		const queries = [];
		const conn = {
			version: '60.0',
			request: async ({ method, url }) => {
				queries.push(url);
				const qIdx = url.indexOf('?q=');
				if (qIdx < 0) {
return { records: [] };
}
				const soql = decodeURIComponent(url.slice(qIdx + 3));
				const idsMatch = soql.match(/Id IN \(([^)]+)\)/);
				const ids = idsMatch[1].split(',').map((s) => s.replace(/^'|'$/g, '').trim());
				return {
					records: ids.map((id) => ({ Id: id, Industry: 'Banking', Phone: '555' })),
				};
			},
		};
		await classifyValueDrift({
			conn,
			batch: { insertedIds: [
				makeUpdateRow({ sfId: '001a', priorValues: { Industry: 'A' }, uploadedValues: { Industry: 'Banking' } }),
				makeUpdateRow({ sfId: '001b', priorValues: { Phone: 'B' }, uploadedValues: { Phone: '555' } }),
			] },
		});

		assert.equal(queries.length, 1, 'should batch all records of one object into one SOQL');
	});
});

function makeRecallConn({ updateBehavior = () => ({ success: true }) } = {}) {
	const calls = { updates: [], deletes: [] };
	return {
		calls,
		version: '60.0',
		request: async ({ method, url }) => {

			if (method === 'GET' && url.indexOf('queryAll') >= 0) {
				return { records: [] };
			}

			if (method === 'DELETE' && url.indexOf('/composite/sobjects') >= 0) {
				const idsMatch = url.match(/ids=([^&]+)/);
				const ids = idsMatch ? decodeURIComponent(idsMatch[1]).split(',') : [];
				calls.deletes.push(...ids);
				return ids.map((id) => ({ id, success: true, errors: [] }));
			}
			return { records: [] };
		},
		sobject: (name) => ({
			update: async (patch) => {
				calls.updates.push({ object: name, patch });
				return updateBehavior(patch, name);
			},
		}),
	};
}

describe('executeRecall — value-revert path', () => {
	test('no revertSelections → no PATCHes fired (legacy behavior preserved)', async () => {
		const conn = makeRecallConn();
		const batch = {
			insertedIds: [
				makeUpdateRow({
					sfId: '001abc',
					priorValues: { Industry: 'Tech' },
					uploadedValues: { Industry: 'Banking' },
				}),
			],
			associations: [],
		};
		const result = await executeRecall({ conn, batch });
		assert.equal(conn.calls.updates.length, 0);
		assert.equal(result.revertedCount, 0);
		assert.equal(result.revertFailedCount, 0);
		assert.deepEqual(result.revertResults, []);
	});

	test('revertSelections fires one PATCH per record with the selected fields', async () => {
		const conn = makeRecallConn();
		const batch = {
			insertedIds: [
				makeUpdateRow({
					sfId: '001abc',
					objectName: 'Account',
					priorValues: { Industry: 'Tech', Phone: '555-0000', Website: 'old.com' },
					uploadedValues: { Industry: 'Banking', Phone: '555-1234', Website: 'new.com' },
				}),
			],
			associations: [],
		};
		const result = await executeRecall({
			conn,
			batch,
			revertSelections: [
				{ sfId: '001abc', fields: ['Industry', 'Phone'] },
			],
		});
		assert.equal(conn.calls.updates.length, 1);
		const patch = conn.calls.updates[0].patch;
		assert.equal(patch.Id, '001abc');
		assert.equal(patch.Industry, 'Tech');
		assert.equal(patch.Phone, '555-0000');

		assert.equal(patch.Website, undefined);
		assert.equal(result.revertedCount, 1);
		assert.equal(result.revertFailedCount, 0);
	});

	test('priorValues null entries write SF null (not "null" string)', async () => {
		const conn = makeRecallConn();
		const batch = {
			insertedIds: [
				makeUpdateRow({
					sfId: '001abc',
					objectName: 'Account',
					priorValues: { Industry: null },
					uploadedValues: { Industry: 'Banking' },
				}),
			],
			associations: [],
		};
		await executeRecall({
			conn,
			batch,
			revertSelections: [{ sfId: '001abc', fields: ['Industry'] }],
		});
		assert.equal(conn.calls.updates[0].patch.Industry, null);
	});

	test('SF PATCH failure surfaces in revertResults; revertFailedCount ticks', async () => {
		const conn = makeRecallConn({
			updateBehavior: () => ({ success: false, errors: [{ message: 'INVALID_FIELD_FOR_INSERT_UPDATE' }] }),
		});
		const batch = {
			insertedIds: [
				makeUpdateRow({
					sfId: '001abc',
					objectName: 'Account',
					priorValues: { Industry: 'Tech' },
					uploadedValues: { Industry: 'Banking' },
				}),
			],
			associations: [],
		};
		const result = await executeRecall({
			conn,
			batch,
			revertSelections: [{ sfId: '001abc', fields: ['Industry'] }],
		});
		assert.equal(result.revertedCount, 0);
		assert.equal(result.revertFailedCount, 1);
		assert.equal(result.revertResults.length, 1);
		assert.equal(result.revertResults[0].success, false);
		assert.match(result.revertResults[0].error, /INVALID_FIELD/);
	});

	test('multiple records in revertSelections each get their own PATCH', async () => {
		const conn = makeRecallConn();
		const batch = {
			insertedIds: [
				makeUpdateRow({
					sfId: '001a', objectName: 'Account',
					priorValues: { Industry: 'A' }, uploadedValues: { Industry: 'B' },
				}),
				makeUpdateRow({
					sfId: '003c', objectName: 'Contact',
					priorValues: { LastName: 'Old' }, uploadedValues: { LastName: 'New' },
				}),
			],
			associations: [],
		};
		const result = await executeRecall({
			conn,
			batch,
			revertSelections: [
				{ sfId: '001a', fields: ['Industry'] },
				{ sfId: '003c', fields: ['LastName'] },
			],
		});
		assert.equal(conn.calls.updates.length, 2);
		assert.equal(result.revertedCount, 2);

		const accountCall = conn.calls.updates.find((c) => c.object === 'Account');
		const contactCall = conn.calls.updates.find((c) => c.object === 'Contact');
		assert.ok(accountCall);
		assert.ok(contactCall);
		assert.equal(accountCall.patch.Industry, 'A');
		assert.equal(contactCall.patch.LastName, 'Old');
	});

	test('revertSelections with sfId that does not match any update row is silently ignored', async () => {
		const conn = makeRecallConn();
		const batch = {
			insertedIds: [
				makeUpdateRow({
					sfId: '001a',
					priorValues: { Industry: 'A' },
					uploadedValues: { Industry: 'B' },
				}),
			],
			associations: [],
		};
		const result = await executeRecall({
			conn,
			batch,
			revertSelections: [{ sfId: 'nonsense', fields: ['Industry'] }],
		});
		assert.equal(conn.calls.updates.length, 0);
		assert.equal(result.revertedCount, 0);
	});

	test('revert selection with internal _* field name is filtered out', async () => {
		const conn = makeRecallConn();
		const batch = {
			insertedIds: [
				makeUpdateRow({
					sfId: '001a', objectName: 'Account',
					priorValues: { Industry: 'A', _meta: 'x' },
					uploadedValues: { Industry: 'B', _meta: 'y' },
				}),
			],
			associations: [],
		};
		await executeRecall({
			conn,
			batch,
			revertSelections: [{ sfId: '001a', fields: ['Industry', '_meta'] }],
		});
		const patch = conn.calls.updates[0].patch;
		assert.equal(patch.Industry, 'A');
		assert.equal(patch._meta, undefined, '_* fields must not leak into the PATCH');
	});
});
