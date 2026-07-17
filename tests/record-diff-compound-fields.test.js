import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const sandbox = { window: { OrgLoom: {} } };
vm.createContext(sandbox);
vm.runInContext(
	readFileSync(new URL('../src/public/js/record-diff-modal.js', import.meta.url), 'utf8'),
	sandbox,
);

const { filterComparableDiff } = sandbox.window.OrgLoom.recordDiffModal;

function fieldLookup(fields) {
	return (name) => fields.find((field) => field.name === name) || null;
}

test('compound address container is removed while identical address components remain shared', () => {
	const diff = {
		sameObject: true,
		objectA: 'Account',
		objectB: 'Account',
		shared: ['BillingStreet', 'BillingCity'],
		differing: [],
		aOnly: [],
		bOnly: ['BillingAddress'],
	};
	const fields = [
		{ name: 'BillingAddress', type: 'address' },
		{ name: 'BillingStreet', type: 'string', compoundFieldName: 'BillingAddress' },
		{ name: 'BillingCity', type: 'string', compoundFieldName: 'BillingAddress' },
	];

	const filtered = filterComparableDiff(diff, fieldLookup(fields), fieldLookup(fields));

	assert.deepEqual(Array.from(filtered.bOnly), []);
	assert.deepEqual(Array.from(filtered.shared), ['BillingStreet', 'BillingCity']);
});

test('a changed address component remains a visible difference', () => {
	const diff = {
		sameObject: true,
		objectA: 'Account',
		objectB: 'Account',
		shared: [],
		differing: ['BillingAddress', 'BillingCity'],
		aOnly: [],
		bOnly: [],
	};
	const fields = [
		{ name: 'BillingAddress', type: 'address' },
		{ name: 'BillingCity', type: 'string', compoundFieldName: 'BillingAddress' },
	];

	const filtered = filterComparableDiff(diff, fieldLookup(fields), fieldLookup(fields));

	assert.deepEqual(Array.from(filtered.differing), ['BillingCity']);
});

test('geolocation container is removed but latitude and longitude components remain comparable', () => {
	const diff = {
		sameObject: true,
		objectA: 'Site__c',
		objectB: 'Site__c',
		shared: ['Location__Longitude__s'],
		differing: ['Location__c', 'Location__Latitude__s'],
		aOnly: [],
		bOnly: [],
	};
	const fields = [
		{ name: 'Location__c', type: 'location' },
		{ name: 'Location__Latitude__s', type: 'double', compoundFieldName: 'Location__c' },
		{ name: 'Location__Longitude__s', type: 'double', compoundFieldName: 'Location__c' },
	];

	const filtered = filterComparableDiff(diff, fieldLookup(fields), fieldLookup(fields));

	assert.deepEqual(Array.from(filtered.differing), ['Location__Latitude__s']);
	assert.deepEqual(Array.from(filtered.shared), ['Location__Longitude__s']);
});
