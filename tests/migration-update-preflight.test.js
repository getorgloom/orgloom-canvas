import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const preflightSource = readFileSync(new URL('../src/public/js/preflight.js', import.meta.url), 'utf8');

function validate(record, fields, describeOverrides = {}) {
	const context = { window: { OrgLoom: {} }, Set, Map, Date, isFinite };
	vm.runInNewContext(preflightSource, context);
	const api = context.window.OrgLoom.preflight.mount({
		canvasState: {
			bulkRecords: [record],
			bulkAssociations: [],
			describeCache: { Account: { fields, ...describeOverrides } },
		},
		isRecordModified: () => true,
		recordOrdinal: () => 1,
	});
	return api.validateBulkRecords();
}

const requiredName = {
	name: 'Name',
	label: 'Account Name',
	type: 'string',
	required: true,
	createable: true,
	updateable: true,
	defaultedOnCreate: false,
};

test('migration update does not require a destination field omitted by the source draft', () => {
	const result = validate(
		{
			id: 1,
			objectName: 'Account',
			loadedFromId: '001TARGET',
			_migrateMatchedId: '001TARGET',
			values: { Name: '' },
		},
		[requiredName],
	);
	assert.equal(result.issues.length, 0);
});

test('ordinary update still catches explicitly clearing a required destination field', () => {
	const result = validate(
		{
			id: 1,
			objectName: 'Account',
			loadedFromId: '001TARGET',
			values: { Name: '' },
			loadedValues: { Name: 'Existing account' },
		},
		[requiredName],
	);
	assert.equal(result.issues.length, 1);
	assert.equal(result.issues[0].severity, 'error');
	assert.equal(result.issues[0].message, 'Required field is empty.');
});

test('update preflight validates updateable fields even when they are not createable', () => {
	const result = validate(
		{
			id: 1,
			objectName: 'Account',
			loadedFromId: '001TARGET',
			values: { Update_Only__c: 'invalid' },
			loadedValues: { Update_Only__c: 'valid' },
		},
		[
			{
				name: 'Update_Only__c',
				label: 'Update only',
				type: 'picklist',
				createable: false,
				updateable: true,
				restrictedPicklist: true,
				picklistValues: [{ value: 'valid', active: true }],
			},
		],
	);
	assert.equal(result.issues.length, 1);
	assert.match(result.issues[0].message, /not an active picklist option/);
});

test('an unrelated update preserves and does not reject a legacy picklist value', () => {
	const result = validate(
		{
			id: 1,
			objectName: 'Account',
			loadedFromId: '001TARGET',
			values: { Description: 'Updated', Status__c: 'Legacy value' },
			loadedValues: { Description: 'Original', Status__c: 'Legacy value' },
		},
		[
			{ name: 'Description', type: 'string', createable: true, updateable: true },
			{
				name: 'Status__c',
				type: 'picklist',
				createable: true,
				updateable: true,
				restrictedPicklist: true,
				picklistValues: [{ value: 'Current option', active: true }],
			},
		],
	);
	assert.equal(result.issues.length, 0);
});

test('an unrelated update preserves and does not validate an external lookup key as a Salesforce ID', () => {
	const result = validate(
		{
			id: 1,
			objectName: 'Account',
			loadedFromId: '001TARGET',
			values: { Description: 'Updated', ExternalParent__c: 'ORDER-1025' },
			loadedValues: { Description: 'Original', ExternalParent__c: 'ORDER-1025' },
		},
		[
			{ name: 'Description', type: 'string', createable: true, updateable: true },
			{
				name: 'ExternalParent__c',
				type: 'reference',
				createable: true,
				updateable: true,
				referenceTo: ['ExternalParent__x'],
				referenceTargetField: 'ExternalId',
			},
		],
	);
	assert.equal(result.issues.length, 0);
});

test('external lookup keys are exempt from ordinary Salesforce-ID validation', () => {
	const result = validate(
		{
			id: 1,
			objectName: 'Account',
			loadedFromId: '001TARGET',
			values: { ExternalParent__c: 'ORDER-2048' },
			loadedValues: { ExternalParent__c: 'ORDER-1025' },
		},
		[
			{
				name: 'ExternalParent__c',
				type: 'reference',
				createable: true,
				updateable: true,
				referenceTo: ['ExternalParent__x'],
				referenceTargetField: 'ExternalId',
			},
		],
	);
	assert.equal(result.issues.length, 0);
});

test('an explicitly changed restricted picklist still rejects an unavailable value', () => {
	const result = validate(
		{
			id: 1,
			objectName: 'Account',
			loadedFromId: '001TARGET',
			values: { Status__c: 'Unavailable' },
			loadedValues: { Status__c: 'Current option' },
		},
		[
			{
				name: 'Status__c',
				type: 'picklist',
				createable: true,
				updateable: true,
				restrictedPicklist: true,
				picklistValues: [{ value: 'Current option', active: true }],
			},
		],
	);
	assert.equal(result.issues.length, 1);
	assert.match(result.issues[0].message, /not an active picklist option/);
});

test('an unrestricted picklist accepts an explicitly entered custom value', () => {
	const result = validate(
		{
			id: 1,
			objectName: 'Account',
			loadedFromId: '001TARGET',
			values: { Status__c: 'Customer-defined value' },
			loadedValues: { Status__c: 'Suggested option' },
		},
		[
			{
				name: 'Status__c',
				type: 'picklist',
				createable: true,
				updateable: true,
				restrictedPicklist: false,
				picklistValues: [{ value: 'Suggested option', active: true }],
			},
		],
	);
	assert.equal(result.issues.length, 0);
});

test('record-type-specific picklist options are authoritative, including on a record-type change', () => {
	const field = {
		name: 'Status__c',
		type: 'picklist',
		createable: true,
		updateable: true,
		restrictedPicklist: true,
		picklistValues: [{ value: 'Generic', active: true }],
		picklistValuesByRecordType: {
			'012TYPEA': [{ value: 'Type A', active: true }],
			'012TYPEB': [{ value: 'Type B', active: true }],
		},
	};
	const valid = validate(
		{
			id: 1,
			objectName: 'Account',
			loadedFromId: '001TARGET',
			values: { RecordTypeId: '012TYPEB', Status__c: 'Type B' },
			loadedValues: { RecordTypeId: '012TYPEA', Status__c: 'Type A' },
		},
		[field],
	);
	assert.equal(valid.issues.length, 0);

	const invalid = validate(
		{
			id: 1,
			objectName: 'Account',
			loadedFromId: '001TARGET',
			values: { RecordTypeId: '012TYPEB', Status__c: 'Type A' },
			loadedValues: { RecordTypeId: '012TYPEA', Status__c: 'Type A' },
		},
		[field],
	);
	assert.equal(invalid.issues.length, 1);
	assert.match(invalid.issues[0].message, /not an active picklist option/);
});

test('an authoritative empty record-type option list does not fall back to generic options', () => {
	const result = validate(
		{
			id: 1,
			objectName: 'Account',
			loadedFromId: '001TARGET',
			values: { RecordTypeId: '012EMPTY', Status__c: 'Generic' },
			loadedValues: { RecordTypeId: '012OTHER', Status__c: 'Other' },
		},
		[
			{
				name: 'Status__c',
				type: 'picklist',
				createable: true,
				updateable: true,
				restrictedPicklist: true,
				picklistValues: [{ value: 'Generic', active: true }],
				picklistValuesByRecordType: { '012EMPTY': [] },
			},
		],
	);
	assert.equal(result.issues.length, 1);
});

test('an unavailable record type does not validate against another record type or generic options', () => {
	const result = validate(
		{
			id: 1,
			objectName: 'Account',
			loadedFromId: '001TARGET',
			values: { Description: 'Changed', RecordTypeId: '012UNAVAILABLE', Status__c: 'Legacy' },
			loadedValues: { Description: 'Original', RecordTypeId: '012UNAVAILABLE', Status__c: 'Legacy' },
		},
		[
			{ name: 'Description', type: 'string', createable: true, updateable: true },
			{
				name: 'Status__c',
				type: 'picklist',
				createable: true,
				updateable: true,
				restrictedPicklist: true,
				picklistValues: [{ value: 'Generic', active: true }],
				picklistValuesByRecordType: { '012AVAILABLE': [{ value: 'Available', active: true }] },
			},
		],
	);
	assert.equal(result.issues.length, 0);
});

test('the accessible record-type list protects a legacy value when no per-type map was returned', () => {
	const result = validate(
		{
			id: 1,
			objectName: 'Account',
			loadedFromId: '001TARGET',
			values: { Description: 'Changed', RecordTypeId: '012UNAVAILABLE', Status__c: 'Legacy' },
			loadedValues: { Description: 'Original', RecordTypeId: '012UNAVAILABLE', Status__c: 'Legacy' },
		},
		[
			{ name: 'Description', type: 'string', createable: true, updateable: true },
			{
				name: 'Status__c',
				type: 'picklist',
				createable: true,
				updateable: true,
				restrictedPicklist: true,
				picklistValues: [{ value: 'Generic', active: true }],
				picklistValuesByRecordType: {},
			},
		],
		{ recordTypes: [{ id: '012AVAILABLE' }] },
	);
	assert.equal(result.issues.length, 0);
});

test('changing a controlling field validates an untouched dependent value in the new context', () => {
	const result = validate(
		{
			id: 1,
			objectName: 'Account',
			loadedFromId: '001TARGET',
			values: { Country__c: 'Canada', State__c: 'Arizona' },
			loadedValues: { Country__c: 'USA', State__c: 'Arizona' },
		},
		[
			{ name: 'Country__c', type: 'picklist', createable: true, updateable: true },
			{
				name: 'State__c',
				type: 'picklist',
				controllerName: 'Country__c',
				createable: true,
				updateable: true,
				restrictedPicklist: true,
				picklistValues: [
					{ value: 'Arizona', active: true, validFor: [0] },
					{ value: 'Ontario', active: true, validFor: [1] },
				],
				controllerValues: { USA: 0, Canada: 1 },
			},
		],
	);
	assert.equal(result.issues.length, 1);
	assert.equal(result.issues[0].field, 'State__c');
	assert.match(result.issues[0].message, /not an active picklist option/);
});
