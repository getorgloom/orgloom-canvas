import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/public/js/insert-modal.js', import.meta.url), 'utf8');
const context = { window: {}, currentFields: [], picklistValuesForField: () => ({ values: [] }) };
vm.createContext(context);
vm.runInContext(source, context);
Object.assign(context, context.window.OrgLoom.insertModal._test);
for (const [start, end] of [
	['function fieldBounds(', 'function isPicklistLikeField('],
	['function sampleValueForField(', 'function isCustomField('],
]) {
	vm.runInContext(source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))), context);
}

for (const [name, compoundFieldName, limit] of [
	['OtherLatitude', 'OtherAddress', 90],
	['OtherLongitude', 'OtherAddress', 180],
	['MailingLatitude', 'MailingAddress', 90],
	['BillingLatitude', 'BillingAddress', 90],
	['ShippingLatitude', null, 90],
	['PersonMailingLatitude', null, 90],
	['Office__Latitude__s', 'Office__c', 90],
	['Office__Longitude__s', 'Office__c', 180],
	['Office__Latitude__s', null, 90],
	['LatitudeOffice__Longitude__s', null, 180],
]) {
	test(`autofill respects coordinate bounds for ${name} without a compound container`, () => {
		const field = { name, compoundFieldName, type: 'double', precision: 18, scale: 6 };
		const value = context.sampleValueForField(field, [field], {}, null, 'Contact');
		assert.equal(typeof value, 'number');
		assert.ok(value >= -limit && value <= limit);
		assert.equal(context.fieldBounds(field, [field]).max, limit);
	});
}

test('ordinary numeric fields keep their existing sample values and precision bounds', () => {
	for (const field of [
		{ name: 'Latitude__c', type: 'double', precision: 8, scale: 2 },
		{ name: 'Amount', type: 'currency', precision: 18, scale: 2 },
		{ name: 'Employees', type: 'int' },
	])
		assert.equal(context.sampleValueForField(field, [field]), 100);
	const small = { name: 'Score__c', type: 'double', precision: 2, scale: 0 };
	assert.equal(context.sampleValueForField(small, [small]), 99);
});
