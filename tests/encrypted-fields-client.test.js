import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/public/js/encrypted-fields.js', import.meta.url), 'utf8');

function loadApi() {
	const window = { OrgLoom: {} };
	vm.runInNewContext(source, { window, Map, Set, Array, Object, String });
	return window.OrgLoom.encryptedFields;
}

function state() {
	return {
		describeCache: {
			Account: {
				fields: [
					{ name: 'Name', type: 'string' },
					{ name: 'Secret__c', type: 'encryptedstring' },
				],
			},
		},
	};
}

test('encrypted proposals stay non-enumerable and merge only into upload values', () => {
	const api = loadApi();
	const record = { objectName: 'Account', values: { Name: 'Acme', Secret__c: 'visible from Salesforce' } };
	api.setProposal(record, 'Secret__c', 'replacement');

	assert.deepEqual(Object.keys(record), ['objectName', 'values']);
	assert.deepEqual(JSON.parse(JSON.stringify(api.uploadValues(record, state(), record.values))), {
		Name: 'Acme',
		Secret__c: 'replacement',
	});
	assert.equal(JSON.stringify(record).includes('replacement'), false);
});

test('replacement and explicit clear produce distinct upload values', () => {
	const api = loadApi();
	const record = { objectName: 'Account', values: { Name: 'Acme' } };
	api.setProposal(record, 'Secret__c', 'replacement');
	assert.equal(api.uploadValues(record, state(), record.values).Secret__c, 'replacement');

	api.setProposal(record, 'Secret__c', null);
	assert.equal(api.uploadValues(record, state(), record.values).Secret__c, null);
});

test('saved intent reloads unresolved and can be dismissed without a value', () => {
	const api = loadApi();
	const record = { objectName: 'Account' };
	api.hydrateIntents(record, ['Secret__c'], state());
	assert.deepEqual(Array.from(api.unresolvedIntentNames(record, state())), ['Secret__c']);

	api.dismissIntent(record, 'Secret__c');
	assert.deepEqual(Array.from(api.intentNames(record, state())), []);
});

test('an unresolved encrypted intent is omitted from upload values', () => {
	const api = loadApi();
	const record = { objectName: 'Account', values: { Name: 'Acme' } };
	api.markIntent(record, 'Secret__c');

	assert.deepEqual(JSON.parse(JSON.stringify(api.uploadValues(record, state(), record.values))), {
		Name: 'Acme',
	});
});

test('legacy draft encrypted values are adopted into tab-local proposals', () => {
	const api = loadApi();
	const record = { objectName: 'Account', values: { Name: 'Draft', Secret__c: 'legacy secret' } };
	api.adoptRuntimeValues(record, state());

	assert.deepEqual(record.values, { Name: 'Draft' });
	assert.equal(api.proposal(record, 'Secret__c'), 'legacy secret');
	assert.equal(JSON.stringify(record).includes('legacy secret'), false);
});
