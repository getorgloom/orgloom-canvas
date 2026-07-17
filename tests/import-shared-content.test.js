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
