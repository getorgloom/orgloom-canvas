import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../src/public/js/canvas-associations.js'), 'utf8');

function mount(describeCache, selectedObjects = [], bulkRecords = []) {
	const window = {};
	vm.runInNewContext(source, { window, Set, Promise });
	return window.OrgLoom.canvasAssociations.mount({
		canvasState: { describeCache, selectedObjects, bulkRecords, bulkAssociations: [], bulkIdSeq: 1 },
		canEditCanvasStructure: () => true,
		renderBulkView: () => {},
		showBulkToast: () => {},
		ensureDescribe: async () => {},
		pushUndo: () => {},
		showFieldPicker: () => {},
		getSelectedDerivedEdge: () => null,
		setSelectedDerivedEdge: () => {},
		_sfIdValue: (value) => value,
		_sfIdMatch: (a, b) => a === b,
	});
}

test('read-only describe references are never offered as FK candidates', () => {
	const api = mount({
		Lead: {
			fields: [
				{
					name: 'ConvertedAccountId',
					type: 'reference',
					referenceTo: ['Account'],
					createable: false,
					updateable: false,
				},
				{
					name: 'Writable_Account__c',
					type: 'reference',
					referenceTo: ['Account'],
					createable: true,
					updateable: true,
				},
			],
		},
		Account: { fields: [] },
	});
	assert.deepEqual(
		Array.from(api.inferAllReferences('Lead', 'Account'), (candidate) => ({ ...candidate })),
		[{ direction: 'fwd', fieldName: 'Writable_Account__c' }],
	);
});

test('reverse read-only references are filtered and legacy metadata remains compatible', () => {
	const api = mount({
		Account: { fields: [] },
		Child__c: {
			fields: [
				{
					name: 'Read_Only_Parent__c',
					type: 'reference',
					referenceTo: ['Account'],
					createable: false,
					updateable: false,
				},
				{ name: 'Legacy_Parent__c', type: 'reference', referenceTo: ['Account'] },
			],
		},
	});
	assert.deepEqual(
		Array.from(api.inferAllReferences('Account', 'Child__c'), (candidate) => ({ ...candidate })),
		[{ direction: 'rev', fieldName: 'Legacy_Parent__c' }],
	);
});

test('external-key references are never offered as canvas relationship candidates', () => {
	const api = mount({
		Account: {
			fields: [
				{
					name: 'ExternalParent__c',
					type: 'reference',
					referenceTo: ['ExternalParent__x'],
					referenceTargetField: 'ExternalId',
					createable: true,
					updateable: true,
				},
			],
		},
		ExternalParent__x: { fields: [] },
	});
	assert.deepEqual(Array.from(api.inferAllReferences('Account', 'ExternalParent__x')), []);
});

test('occupied-reference guidance distinguishes an existing field from an available field', () => {
	assert.match(source, /A matching relationship field connects/);
	assert.match(source, /that field is/);
	assert.match(source, /Each relationship field can point to only one record/);
	assert.doesNotMatch(source, /No available lookup connects/);
});

test('linking an existing child to a draft parent removes the stale Salesforce parent id', () => {
	const contact = {
		id: 'contact',
		objectName: 'Contact',
		values: { LastName: 'Tester', AccountId: '001OLD000000001AAA' },
	};
	const account = { id: 'account', objectName: 'Account', values: { Name: 'Draft account' } };
	const api = mount({}, [], [contact, account]);
	api.createAssociation(contact, account, 'fwd', 'AccountId');

	assert.equal(Object.hasOwn(contact.values, 'AccountId'), false);
});
