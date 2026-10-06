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

test('unlink impact separates existing incoming relationships from draft incoming relationships', () => {
	const { unlinkRelationshipImpact } = api();
	const { state, target } = fixture();
	const impact = unlinkRelationshipImpact(state, target);

	assert.deepEqual(
		Array.from(impact.incoming, (association) => association.id),
		[10, 11],
	);
	assert.deepEqual(
		Array.from(impact.existingIncoming, (association) => association.id),
		[10],
	);
	assert.deepEqual(
		Array.from(impact.draftIncoming, (association) => association.id),
		[11],
	);
});

test('safe unlink detaches existing children without clearing their original Salesforce lookup', () => {
	const { applyLoadedRecordUnlink } = api();
	const { state, target, existingChild } = fixture();

	const result = applyLoadedRecordUnlink(state, target, 'keep');

	assert.equal(target.loadedFromId, null);
	assert.deepEqual(
		Array.from(state.bulkAssociations, (association) => association.id),
		[11, 12, 13],
	);
	assert.equal(existingChild.values.AccountId, '001ORIGINAL');
	assert.deepEqual({ ...result }, { detachedExisting: 1, retainedDraft: 1 });
});

test('explicit move keeps existing and draft children connected to the new draft', () => {
	const { applyLoadedRecordUnlink } = api();
	const { state, target, existingChild } = fixture();

	const result = applyLoadedRecordUnlink(state, target, 'move');

	assert.equal(target.loadedFromId, null);
	assert.deepEqual(
		Array.from(state.bulkAssociations, (association) => association.id),
		[10, 11, 12, 13],
	);
	assert.equal(existingChild.values.AccountId, '001ORIGINAL');
	assert.deepEqual({ ...result }, { detachedExisting: 0, retainedDraft: 1 });
});

test('safe unlink does not remove unrelated legacy associations that have no id', () => {
	const { applyLoadedRecordUnlink } = api();
	const { state, target, existingChild } = fixture();
	const incoming = { fromId: existingChild.id, toId: target.id, fieldName: 'AccountId' };
	const unrelated = { fromId: target.id, toId: 4, fieldName: 'OwnerId' };
	state.bulkAssociations = [incoming, unrelated];

	applyLoadedRecordUnlink(state, target, 'keep');

	assert.equal(state.bulkAssociations.length, 1);
	assert.equal(state.bulkAssociations[0], unrelated);
});

test('relationship-aware unlink UI offers keep, move, and cancel with safe keep as the default', () => {
	assert.match(source, /data-unlink-move>Move to new draft/);
	assert.match(source, /data-unlink-keep>Keep with original/);
	assert.match(source, /data-unlink-cancel>Cancel/);
	assert.match(source, /event\.key === 'Enter'[\s\S]*finish\('keep'\)/);
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
