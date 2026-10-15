import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDescribeCache, stripUnwritableFields } from '../src/sf-upload.js';

test('describe cache deduplicates concurrent requests for one object', async () => {
	let calls = 0;
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const conn = {
		sobject: () => ({
			describe: async () => {
				calls++;
				await gate;
				return { name: 'Account', fields: [] };
			},
		}),
	};
	const getDescribe = makeDescribeCache(conn);
	const first = getDescribe('Account');
	const second = getDescribe('Account');
	release();
	const [a, b] = await Promise.all([first, second]);
	assert.equal(calls, 1);
	assert.equal(a, b);
});

test('upsert keeps fields writable for either insert or update', () => {
	const describe = {
		fields: [
			{ name: 'CreateOnly__c', createable: true, updateable: false, type: 'string' },
			{ name: 'UpdateOnly__c', createable: false, updateable: true, type: 'string' },
			{ name: 'NeverWritable__c', createable: false, updateable: false, type: 'string' },
			{ name: 'Address__c', createable: true, updateable: true, type: 'address' },
		],
	};
	const values = {
		CreateOnly__c: 'create',
		UpdateOnly__c: 'update',
		NeverWritable__c: 'never',
		Address__c: 'compound',
	};

	assert.deepEqual(stripUnwritableFields(values, describe, 'upsert'), {
		CreateOnly__c: 'create',
		UpdateOnly__c: 'update',
	});
});
