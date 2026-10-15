import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retrieveRecordValues } from '../src/record-refresh.js';

const sfId = (number) => '001' + String(number).padStart(12, '0');

test('refresh uses full retrieve, groups objects, deduplicates and batches at 200', async () => {
	const records = Array.from({ length: 201 }, (_, i) => ({ objectName: 'Account', sfId: sfId(i) }));
	records.push(records[0], { objectName: 'Contact', sfId: '003000000000001' });
	const calls = [];
	const conn = {
		sobject(objectName) {
			return {
				async retrieve(...args) {
					assert.equal(args.length, 1, 'must not impose a canvas-defined field list');
					calls.push([objectName, args[0].length]);
					return args[0].map((Id) => ({ Id, Name: 'Retrieved', attributes: { type: objectName } })).reverse();
				},
			};
		},
	};
	const results = await retrieveRecordValues(conn, records);
	assert.deepEqual(calls, [
		['Account', 200],
		['Account', 1],
		['Contact', 1],
	]);
	assert.equal(results.length, records.length);
	results.forEach((result, i) => {
		assert.equal(result.ok, true);
		assert.equal(result.values.Id, records[i].sfId);
		assert.equal(result.values.attributes, undefined);
	});
});

test('refresh matches 15 and 18 character IDs, handles singleton, null and unexpected results', async () => {
	const id = sfId(1);
	const conn = {
		sobject() {
			return {
				retrieve: async () => [null, { Id: id + 'AAA', Value__c: null, Secret__c: '****' }, { Id: sfId(9) }],
			};
		},
	};
	const records = [
		{ objectName: 'Account', sfId: id },
		{ objectName: 'Account', sfId: sfId(2) },
	];
	const results = await retrieveRecordValues(conn, records);
	assert.deepEqual(results[0].values, { Id: id + 'AAA', Value__c: null, Secret__c: '****' });
	assert.equal(results[1].error, 'not-found');
	conn.sobject = () => ({ retrieve: async () => ({ Id: id }) });
	assert.equal((await retrieveRecordValues(conn, records.slice(0, 1)))[0].ok, true);
});

test('a failed chunk does not discard other successful reads or expose exception details', async () => {
	const records = Array.from({ length: 201 }, (_, i) => ({ objectName: 'Account', sfId: sfId(i) }));
	const conn = {
		sobject() {
			return {
				async retrieve(ids) {
					if (ids.length === 200)
						throw Object.assign(new Error('private details'), { errorCode: 'INSUFFICIENT_ACCESS' });
					return [{ Id: ids[0] }];
				},
			};
		},
	};
	const results = await retrieveRecordValues(conn, records);
	assert.equal(results[0].error, 'no-access');
	assert.equal(results[200].ok, true);
	assert.doesNotMatch(JSON.stringify(results), /private details/);
});

test('invalid objects and IDs never reach Salesforce', async () => {
	const conn = {
		sobject() {
			throw new Error('must not call');
		},
	};
	const results = await retrieveRecordValues(conn, [
		{ objectName: 'Account;SELECT', sfId: sfId(1) },
		{ objectName: 'Account', sfId: "x' OR Id != null" },
	]);
	assert.deepEqual(
		results.map((row) => row.error),
		['invalid-record', 'invalid-record'],
	);
});
