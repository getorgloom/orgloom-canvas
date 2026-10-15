import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { changedValuesForUpdate, normalizeValuesForUpload, buildGraphSubRequest } from '../src/sf-upload.js';
import { buildCsv } from '../src/sf-bulk.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../src/public/js/canvas-associations.js'), 'utf8');

function mount(describeCache, selectedObjects = [], bulkRecords = [], overrides = {}) {
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
		...overrides,
	});
}

function caseLinkFixture({ derived = false, draftTarget = false } = {}) {
	const contact = { id: 2, objectName: 'Contact', values: { LastName: 'Tester' } };
	if (!draftTarget) {
		contact.loadedFromId = '003000000000001AAA';
	}
	const record = {
		id: 1,
		objectName: 'Case',
		loadedFromId: '500000000000001AAA',
		values: draftTarget ? {} : { ContactId: contact.loadedFromId },
		loadedValues: { ContactId: '003000000000001AAA' },
	};
	const state = {
		bulkRecords: [record, contact],
		bulkAssociations: derived ? [] : [{ id: 3, fromId: 1, toId: 2, fieldName: 'ContactId' }],
		bulkSelectedEdgeId: 3,
	};
	const undo = [];
	const api = mount({}, [], [], { canvasState: state, pushUndo: (_label, fn) => undo.push(fn) });
	return { api, state, record, undo };
}

for (const derived of [false, true]) {
	test(`${derived ? 'derived' : 'explicit'} Case link deletion sends a lookup clear through every upload format`, () => {
		const { api, state, record, undo } = caseLinkFixture({ derived });
		if (derived) {
			api.deleteDerivedFkEdge(1, 'ContactId');
		} else {
			api.deleteAssociation(3);
		}
		assert.equal(state.bulkAssociations.length, 0);
		const serialized = JSON.parse(JSON.stringify(record));
		assert.deepEqual(changedValuesForUpdate(serialized), { ContactId: null });
		assert.deepEqual(normalizeValuesForUpload(serialized, 1, [], new Map()), { ContactId: null });
		const graph = buildGraphSubRequest({
			rec: serialized,
			tempId: 1,
			apiBase: '/services/data/v67.0',
			associations: [],
			submittedIds: new Set([1]),
			recordsById: new Map([[1, serialized]]),
			describesByObject: new Map([
				['Case', { fields: [{ name: 'ContactId', type: 'reference', updateable: true }] }],
			]),
		});
		assert.equal(graph.method, 'PATCH');
		assert.deepEqual(graph.body, { ContactId: null });
		assert.equal(buildCsv([changedValuesForUpdate(serialized)], ['ContactId']), 'ContactId\n#N/A');
		undo.pop()();
		assert.equal(record.values.ContactId, record.loadedValues.ContactId);
		assert.deepEqual(changedValuesForUpdate(record), {});
		assert.equal(state.bulkAssociations.length, derived ? 0 : 1);
	});
}

test('removing a pending link to a draft contact still clears the original Salesforce lookup', () => {
	const { api, record, state, undo } = caseLinkFixture({ draftTarget: true });
	api.deleteAssociation(3);
	assert.deepEqual(changedValuesForUpdate(record), { ContactId: null });
	undo.pop()();
	assert.equal(Object.hasOwn(record.values, 'ContactId'), false);
	assert.equal(state.bulkAssociations.length, 1);
});

test('removing a stale association preserves a newer lookup value', () => {
	const { api, record } = caseLinkFixture();
	record.values.ContactId = '003000000000002AAA';
	api.deleteAssociation(3);
	assert.equal(record.values.ContactId, '003000000000002AAA');
});

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
