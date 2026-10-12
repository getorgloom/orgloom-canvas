import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const window = { OrgLoom: {} };
vm.runInNewContext(fs.readFileSync(new URL('../src/public/js/insert-modal.js', import.meta.url), 'utf8'), { window });
const { mountMultiple, scopeEditorIds } = window.OrgLoom.insertModal._test;

function setup() {
	const first = { id: 1, objectName: 'Account', values: { Name: 'First' } };
	const second = { id: 2, objectName: 'Account', values: { Name: 'Second' } };
	const state = { bulkRecords: [first, second], currentRecordRef: null, bulkAssociations: [] };
	const instances = [];
	const manager = mountMultiple({ canvasState: state, pushPresenceFocus() {} }, (deps) => {
		const entry = { deps, opens: 0, closed: false, pending: false, refreshes: [] };
		const api = {
			openInsertModal(_object, options) {
				entry.opens++;
				deps.canvasState.currentRecordRef = options.record;
			},
			activate(options) {
				entry.options = options;
				deps.onActivate();
			},
			setActive(value) {
				entry.active = value;
			},
			closeModal() {
				deps.canvasState.currentRecordRef = null;
				deps.onClose();
			},
			destroy() {
				entry.closed = true;
			},
			hasPendingEncryptedUploadValues() {
				return entry.pending || !!state.pending;
			},
			refreshCurrentRecordAccess(record) {
				entry.refreshes.push(record);
			},
			unlinkRecord(record, targetState) {
				entry.unlink = { record, targetState };
				return true;
			},
			refreshCurrentFieldLocks() {},
			updateUploadFixFields(fields) {
				entry.fixFields = fields;
			},
			refreshCurrentRecordValues() {},
			sampleValueForField() {
				return 'sample';
			},
		};
		entry.api = api;
		instances.push(entry);
		return api;
	});
	return { manager, instances, state, first, second };
}

test('multiple editors isolate record references while sharing canvas data', () => {
	const { manager, instances, state, first, second } = setup();
	manager.openInsertModal('Account', { record: first });
	manager.openInsertModal('Account', { record: second });
	assert.equal(instances.length, 2);
	assert.equal(instances[0].closed, false);
	assert.equal(instances[0].deps.canvasState.currentRecordRef, first);
	assert.equal(instances[1].deps.canvasState.currentRecordRef, second);
	assert.equal(state.currentRecordRef, second);
	const associations = [{ id: 1 }];
	instances[0].deps.canvasState.bulkAssociations = associations;
	assert.equal(state.bulkAssociations, associations);
	assert.equal(instances[1].deps.canvasState.bulkAssociations, associations);
	assert.notEqual(instances[0].deps.editorId, instances[1].deps.editorId);
	manager.openInsertModal('Account', { record: first, focusField: 'Name' });
	assert.equal(instances.length, 2, 'reopening focuses rather than rebuilding and losing edits');
	assert.equal(instances[0].opens, 1);
	assert.equal(instances[0].options.focusField, 'Name');
	assert.equal(state.currentRecordRef, first);
	manager.closeModal();
	assert.equal(instances[0].closed, true);
	assert.equal(instances[1].closed, false);
	assert.equal(state.currentRecordRef, second);
});

test('linked-record navigation and shared refreshes reach independent editors', () => {
	const { manager, instances, first, second } = setup();
	manager.openInsertModal('Account', { record: first });
	instances[0].deps.openLinkedRecord(second);
	manager.refreshCurrentRecordAccess(first);
	assert.equal(instances.length, 2);
	assert.equal(instances[0].closed, false);
	assert.equal(instances[0].refreshes[0], first);
	assert.equal(instances[1].refreshes[0], first);
	manager.updateUploadFixFields(String(first.id), ['Phone']);
	assert.deepEqual(instances[0].fixFields, ['Phone']);
	assert.equal(instances[1].fixFields, undefined, 'dismissal updates guidance only on the affected record');
});

test('removing or replacing a record closes its editor even when IDs are reused', () => {
	const { manager, instances, state, first, second } = setup();
	manager.openInsertModal('Account', { record: first });
	manager.openInsertModal('Account', { record: second });
	state.bulkRecords = [second];
	manager.syncOpenRecords();
	assert.equal(instances[0].closed, true);
	assert.equal(instances[1].closed, false);
	state.bulkRecords = [{ ...second }];
	manager.syncOpenRecords();
	assert.equal(instances[1].closed, true);
	assert.equal(state.currentRecordRef, null);
});

test('close all and encrypted-value checks include inactive editors and saved proposals', () => {
	const { manager, instances, state, first, second } = setup();
	manager.openInsertModal('Account', { record: first });
	manager.openInsertModal('Account', { record: second });
	instances[0].pending = true;
	assert.equal(manager.hasPendingEncryptedUploadValues(), true);
	manager.closeAll();
	assert.ok(instances.slice(0, 2).every((entry) => entry.closed));
	assert.equal(state.currentRecordRef, null);
	state.pending = true;
	assert.equal(manager.hasPendingEncryptedUploadValues(), true);
});

test('field IDs and associated labels, datalists and ARIA references are namespaced', () => {
	const nodes = [{ id: 'f_Name' }, { id: 'options' }, { id: 'help' }];
	const attributes = { for: 'f_Name', list: 'options', 'aria-describedby': 'help external-help' };
	const ref = {
		getAttribute: (name) => attributes[name],
		setAttribute: (name, value) => {
			attributes[name] = value;
		},
	};
	scopeEditorIds(
		{
			querySelectorAll: (selector) =>
				selector === '[id]' ? nodes : attributes[selector.slice(1, -1)] ? [ref] : [],
		},
		'editor-1-',
	);
	assert.equal(nodes[0].id, 'editor-1-f_Name');
	assert.equal(attributes.for, 'editor-1-f_Name');
	assert.equal(attributes.list, 'editor-1-options');
	assert.equal(attributes['aria-describedby'], 'editor-1-help external-help');
});

test('menu unlink targets an existing editor or passes shared canvas state to the hidden helper', () => {
	const { manager, instances, state, first, second } = setup();
	manager.openInsertModal('Account', { record: first });
	manager.unlinkRecord(first);
	assert.equal(instances[0].unlink.record, first);
	assert.equal(instances[0].unlink.targetState, undefined);
	manager.unlinkRecord(second);
	assert.equal(instances[1].deps.helperOnly, true);
	assert.equal(instances[1].opens, 0);
	assert.equal(instances[1].unlink.record, second);
	assert.equal(instances[1].unlink.targetState, state);
	assert.equal(state.currentRecordRef, first);
});
