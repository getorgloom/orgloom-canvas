import test from 'node:test';
import assert from 'node:assert/strict';
import { stripUnwritableFields } from '../src/sf-upload.js';

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
