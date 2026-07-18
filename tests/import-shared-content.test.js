import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../src/public/js/import-shared.js'), 'utf8');
const window = {};
vm.runInNewContext(source, { window, Set });
const summarize = window.OrgLoom.importShared.summarizeCanvasContent;
const reconcileLoadedRecordAssociations = window.OrgLoom.importShared.reconcileLoadedRecordAssociations;

test('real records make the current canvas meaningful import content', () => {
	const summary = summarize({
		bulkRecords: [
			{ id: 1, objectName: 'Account', loadedFromId: '001000000000001AAA', pendingDelete: true },
			{ id: 2, objectName: 'Contact', values: { LastName: 'Draft' } },
		],
		bulkAssociations: [{ fromId: 2, toId: 1, fieldName: 'AccountId' }],
		selectedObjects: [{ name: 'Account' }, { name: 'Contact' }],
	});
	assert.equal(summary.hasContent, true);
	assert.equal(summary.recordCount, 2);
	assert.equal(summary.existingCount, 1);
	assert.equal(summary.draftCount, 1);
	assert.equal(summary.pendingDeleteCount, 1);
	assert.equal(summary.associationCount, 1);
	assert.equal(summary.objectCount, 2);
});

test('intentional schema-only work still receives a replace-or-add choice', () => {
	const summary = summarize({
		bulkRecords: [{ id: 'type-1', objectName: 'Account', isTypeNode: true }],
		selectedObjects: [{ name: 'Account' }],
		_bulkUserDeleted: false,
	});
	assert.equal(summary.hasContent, true);
	assert.equal(summary.schemaOnly, true);
	assert.equal(summary.recordCount, 0);
});

test('deleting the final record does not leave schema residue that triggers a false conflict', () => {
	const summary = summarize({
		bulkRecords: [{ id: 'type-1', objectName: 'Account', isTypeNode: true }],
		selectedObjects: [{ name: 'Account' }],
		_bulkUserDeleted: true,
	});
	assert.equal(summary.hasContent, false);
	assert.equal(summary.schemaOnly, false);
	assert.equal(summary.recordCount, 0);
});

test('loading placeholders alone do not trigger the conflict dialog', () => {
	const summary = summarize({
		bulkRecords: [{ id: 'pending-1', objectName: 'Account', isPending: true }],
		selectedObjects: [],
	});
	assert.equal(summary.hasContent, false);
});

test('rebuilds a lookup edge when an imported record refers to an existing canvas record', () => {
	const canvasState = {
		bulkIdSeq: 10,
		bulkRecords: [
			{ id: 1, objectName: 'Account', loadedFromId: '001000000000001AAA', values: { Name: 'Acme' } },
			{
				id: 2,
				objectName: 'Contact',
				loadedFromId: '003000000000001AAA',
				fromSelectionId: 2,
				values: { LastName: 'Jones', AccountId: '001000000000001AAA' },
			},
		],
		bulkAssociations: [],
		selectedObjects: [
			{ id: 1, name: 'Account', data: { parents: [] } },
			{ id: 2, name: 'Contact', data: { parents: [{ field: 'AccountId', object: 'Account' }] } },
		],
	};

	assert.equal(reconcileLoadedRecordAssociations(canvasState).added, 1);
	assert.equal(canvasState.bulkAssociations.length, 1);
	assert.equal(canvasState.bulkAssociations[0].id, 10);
	assert.equal(canvasState.bulkAssociations[0].fromId, 2);
	assert.equal(canvasState.bulkAssociations[0].toId, 1);
	assert.equal(canvasState.bulkAssociations[0].fieldName, 'AccountId');
});

test('does not replace an explicit canvas relationship for the same lookup field', () => {
	const canvasState = {
		bulkIdSeq: 20,
		bulkRecords: [
			{ id: 1, objectName: 'Account', loadedFromId: '001000000000001AAA', values: { Name: 'Acme' } },
			{ id: 2, objectName: 'Account', values: { Name: 'Draft parent' } },
			{
				id: 3,
				objectName: 'Contact',
				loadedFromId: '003000000000001AAA',
				fromSelectionId: 3,
				values: { LastName: 'Jones', AccountId: '001000000000001AAA' },
			},
		],
		bulkAssociations: [{ id: 19, fromId: 3, toId: 2, fieldName: 'AccountId' }],
		selectedObjects: [{ id: 3, name: 'Contact', data: { parents: [{ field: 'AccountId', object: 'Account' }] } }],
	};

	assert.equal(reconcileLoadedRecordAssociations(canvasState).added, 0);
	assert.equal(canvasState.bulkAssociations.length, 1);
});
