import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../src/public/js/insert-modal.js'), 'utf8');

function api() {
	const window = {};
	vm.runInNewContext(source, { window });
	return window.OrgLoom.insertModal._test;
}

function escapeHtml(value) {
	return String(value).replace(
		/[&<>"']/g,
		(char) =>
			({
				'&': '&amp;',
				'<': '&lt;',
				'>': '&gt;',
				'"': '&quot;',
				"'": '&#39;',
			})[char],
	);
}

test('linked field renders one compact record control and an optional Unlink action', () => {
	const { linkedRecordControlHtml } = api();
	const field = { name: 'AccountId' };
	const lock = { association: { id: 10 }, target: { values: { Name: 'Acme' } } };
	const html = linkedRecordControlHtml(field, lock, 'Acme · Account #2', true, escapeHtml);
	assert.match(html, /<span>Acme<\/span>/);
	assert.match(html, /title="AccountId · Acme · Account #2"/);
	assert.match(html, /type="hidden"[^>]+data-locked-assoc="10"/);
	assert.match(html, /type="button"[^>]+data-open-assoc-field="AccountId"/);
	assert.match(html, /data-disconnect-assoc="10"[^>]*>Unlink<\/button>/);
	assert.doesNotMatch(html, /Linked via association|Disconnect|type="text"/);
	const readOnly = linkedRecordControlHtml(field, lock, 'Acme · Account #2', false, escapeHtml);
	assert.doesNotMatch(readOnly, /data-disconnect-assoc/);
});

test('linked field escapes record names and attributes and provides unnamed/contact fallbacks', () => {
	const { linkedRecordControlHtml } = api();
	const lock = { association: { id: '"unsafe' }, target: { values: { Name: '<img src=x>' } } };
	const html = linkedRecordControlHtml({ name: '"field' }, lock, '"tooltip', true, escapeHtml);
	assert.doesNotMatch(html, /<img|=""field|=""unsafe/);
	assert.match(html, /&lt;img src=x&gt;/);
	lock.target.values = { FirstName: 'Test', LastName: 'Contact' };
	assert.match(
		linkedRecordControlHtml({ name: 'WhoId' }, lock, 'Contact #3', false, escapeHtml),
		/<span>Test Contact<\/span>/,
	);
	lock.target.values = {};
	assert.match(
		linkedRecordControlHtml({ name: 'WhoId' }, lock, 'Contact #3', false, escapeHtml),
		/<span>Contact #3<\/span>/,
	);
});

function linkedNavigation({
	dirty = false,
	encrypted = false,
	inaccessible = false,
	missing = false,
	multiple = false,
} = {}) {
	const start = source.indexOf("modal.querySelectorAll('[data-open-assoc-field]')");
	const end = source.indexOf("modal.querySelectorAll('[data-disconnect-assoc]')", start);
	const calls = [];
	let click;
	const target = { id: 2, objectName: 'Account', _inaccessible: inaccessible };
	vm.runInNewContext(source.slice(start, end), {
		deps: multiple ? { openLinkedRecord: (record) => calls.push(['open-linked', record]) } : {},
		modal: {
			querySelectorAll: () => [
				{
					dataset: { openAssocField: 'AccountId' },
					addEventListener: (_type, fn) => {
						click = fn;
					},
				},
			],
		},
		associationLockForField: (name) => {
			assert.equal(name, 'AccountId');
			return missing ? null : { target };
		},
		editorTouchedFields: new Set(dirty ? ['Name'] : []),
		currentEncryptedDraftValues: new Map(encrypted ? [['Secret__c', 'replacement']] : []),
		showBulkToast: (message) => calls.push(['toast', message]),
		closeModal: () => calls.push(['close']),
		openInsertModal: (objectName, opts) => calls.push(['open', objectName, opts.record]),
	});
	click();
	return { calls, target };
}

test('opening a linked card releases the current editor before opening the actual target', () => {
	const { calls, target } = linkedNavigation();
	assert.deepEqual(calls, [['close'], ['open', 'Account', target]]);
});

test('multi-card linked navigation preserves the current editor and its unsaved fields', () => {
	const { calls, target } = linkedNavigation({ multiple: true, dirty: true, encrypted: true });
	assert.deepEqual(calls, [['open-linked', target]]);
});

test('linked-card navigation cannot discard edits or open unavailable records', () => {
	for (const options of [{ dirty: true }, { encrypted: true }]) {
		const { calls } = linkedNavigation(options);
		assert.equal(calls.length, 1);
		assert.equal(calls[0][0], 'toast');
		assert.match(calls[0][1], /Save or cancel/);
	}
	assert.deepEqual(linkedNavigation({ inaccessible: true }).calls, []);
	assert.deepEqual(linkedNavigation({ missing: true }).calls, []);
});

function fixture() {
	const target = {
		id: 1,
		objectName: 'Account',
		loadedFromId: '001ORIGINAL',
		values: { Name: 'Original account' },
	};
	const existingChild = {
		id: 2,
		objectName: 'Contact',
		loadedFromId: '003EXISTING',
		values: { LastName: 'Existing', AccountId: '001ORIGINAL' },
	};
	const draftChild = {
		id: 3,
		objectName: 'Contact',
		loadedFromId: null,
		values: { LastName: 'Draft' },
	};
	const other = {
		id: 4,
		objectName: 'User',
		loadedFromId: '005OWNER',
		values: { Name: 'Owner' },
	};
	const state = {
		bulkRecords: [target, existingChild, draftChild, other],
		bulkAssociations: [
			{ id: 10, fromId: existingChild.id, toId: target.id, fieldName: 'AccountId' },
			{ id: 11, fromId: draftChild.id, toId: target.id, fieldName: 'AccountId' },
			{ id: 12, fromId: target.id, toId: other.id, fieldName: 'OwnerId' },
			{ id: 13, fromId: existingChild.id, toId: other.id, fieldName: 'OwnerId' },
		],
	};
	return { state, target, existingChild, draftChild };
}

test('unlink detaches all incoming links while preserving the original Salesforce lookup', () => {
	const { applyLoadedRecordUnlink } = api();
	const { state, target, existingChild, draftChild } = fixture();
	applyLoadedRecordUnlink(state, target);
	assert.equal(target.loadedFromId, null);
	assert.deepEqual(
		Array.from(state.bulkAssociations, (a) => a.id),
		[12, 13],
	);
	assert.equal(existingChild.values.AccountId, '001ORIGINAL');
	assert.equal(draftChild.values.AccountId, '001ORIGINAL');
	assert.equal(target.values.Name, 'Original account');
});

test('unlink preserves association-only lookups and does not reset unrelated child edits', () => {
	const { applyLoadedRecordUnlink } = api();
	const { state, target, existingChild } = fixture();
	delete existingChild.values.AccountId;
	existingChild.values.LastName = 'Edited';
	existingChild.loadedValues = { LastName: 'Existing', AccountId: '001ORIGINAL' };
	applyLoadedRecordUnlink(state, target);
	assert.equal(existingChild.values.AccountId, '001ORIGINAL');
	assert.equal(existingChild.values.LastName, 'Edited');
	assert.equal(existingChild.loadedValues.LastName, 'Existing');
});

test('unlink preserves the effective association target even when the raw lookup is stale', () => {
	const { applyLoadedRecordUnlink } = api();
	const { state, target, existingChild } = fixture();
	existingChild.values.AccountId = '001PREVIOUS';
	applyLoadedRecordUnlink(state, target);
	assert.equal(existingChild.values.AccountId, '001ORIGINAL');
});

test('unlink does not remove unrelated legacy associations that have no id', () => {
	const { applyLoadedRecordUnlink } = api();
	const { state, target, existingChild } = fixture();
	const incoming = { fromId: existingChild.id, toId: target.id, fieldName: 'AccountId' };
	const unrelated = { fromId: target.id, toId: 4, fieldName: 'OwnerId' };
	state.bulkAssociations = [incoming, unrelated];
	applyLoadedRecordUnlink(state, target);
	assert.equal(state.bulkAssociations.length, 1);
	assert.equal(state.bulkAssociations[0], unrelated);
});

test('unlink ignores records already converted to drafts', () => {
	const { applyLoadedRecordUnlink } = api();
	const { state, target } = fixture();
	target.loadedFromId = null;
	applyLoadedRecordUnlink(state, target);
	assert.equal(state.bulkAssociations.length, 4);
});

test('unlink no longer offers a relationship choice dialog', () => {
	assert.doesNotMatch(
		source,
		/chooseUnlinkRelationshipBehavior|unlink-relationship-modal|data-unlink-move|Keep with original/,
	);
});

test('carry-over values render structured data as readable JSON', () => {
	const { formatCarryoverValue } = api();
	assert.equal(
		formatCarryoverValue({ city: 'Phoenix', coordinates: [33.4, -112.1] }),
		'{\n  "city": "Phoenix",\n  "coordinates": [\n    33.4,\n    -112.1\n  ]\n}',
	);
	assert.equal(formatCarryoverValue('plain text'), 'plain text');
	assert.equal(formatCarryoverValue(42), '42');
});

test('carry-over value formatter never falls back to object Object', () => {
	const { formatCarryoverValue } = api();
	const circular = {};
	circular.self = circular;
	assert.equal(formatCarryoverValue(circular), '(structured value)');
});

test('shared unlink acts immediately on the correct canvas and rejects unavailable records', async () => {
	const start = source.indexOf('async function unlinkRecord(record, targetState = canvasState)');
	const end = source.indexOf('function updateRecordHeaderIdentity()', start);
	assert.ok(start > 0 && end > start);
	for (const mode of ['allowed', 'denied', 'removed', 'inaccessible', 'draft', 'open-editor']) {
		const { state, target, existingChild } = fixture();
		state.graphView = 'bulk';
		target.pendingDelete = true;
		if (mode === 'removed') state.bulkRecords = state.bulkRecords.filter((r) => r !== target);
		if (mode === 'inaccessible') target._inaccessible = true;
		if (mode === 'draft') target.loadedFromId = null;
		let renders = 0,
			editorRenders = 0;
		const unmarked = [];
		const context = {
			...api(),
			canvasState: { currentRecordRef: mode === 'open-editor' ? target : null },
			modalEditMode: 'existing',
			canEditCanvasStructure: () => mode !== 'denied',
			showBulkToast() {},
			unmarkPendingDelete: (id) => {
				unmarked.push(id);
				target.pendingDelete = false;
			},
			renderBulkView: () => renders++,
			rerenderFormPreservingValues: () => editorRenders++,
		};
		const unlink = vm.runInNewContext('(' + source.slice(start, end) + ')', context);
		const result = await unlink(target, state);
		if (mode === 'allowed' || mode === 'open-editor') {
			assert.equal(result, true);
			assert.equal(target.loadedFromId, null);
			assert.deepEqual(
				Array.from(state.bulkAssociations, (a) => a.id),
				[12, 13],
			);
			assert.equal(existingChild.values.AccountId, '001ORIGINAL');
			assert.deepEqual(unmarked, [target.id]);
			assert.equal(renders, 1);
			assert.equal(editorRenders, mode === 'open-editor' ? 1 : 0);
			if (mode === 'open-editor') assert.equal(context.modalEditMode, 'new');
		} else {
			assert.equal(result, false);
			assert.equal(target.loadedFromId, mode === 'draft' ? null : '001ORIGINAL');
			assert.equal(state.bulkAssociations.length, 4);
			assert.equal(target.pendingDelete, true);
			assert.deepEqual(unmarked, []);
			assert.equal(renders, 0);
			assert.equal(editorRenders, 0);
		}
	}
});
