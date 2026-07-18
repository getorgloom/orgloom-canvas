import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../src/public/js/canvas-associations.js'), 'utf8');

function mount(describeCache, selectedObjects = []) {
	const window = {};
	vm.runInNewContext(source, { window, Set, Promise });
	return window.OrgLoom.canvasAssociations.mount({
		canvasState: { describeCache, selectedObjects, bulkRecords: [], bulkAssociations: [], bulkIdSeq: 1 },
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

test('occupied-reference guidance distinguishes an existing field from an available field', () => {
	assert.match(source, /A matching relationship field connects/);
	assert.match(source, /that field is/);
	assert.match(source, /Each relationship field can point to only one record/);
	assert.doesNotMatch(source, /No available lookup connects/);
});
