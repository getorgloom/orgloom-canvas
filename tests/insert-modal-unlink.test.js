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

	assert.deepEqual(Array.from(impact.incoming, (association) => association.id), [10, 11]);
	assert.deepEqual(Array.from(impact.existingIncoming, (association) => association.id), [10]);
	assert.deepEqual(Array.from(impact.draftIncoming, (association) => association.id), [11]);
});

test('safe unlink detaches existing children without clearing their original Salesforce lookup', () => {
	const { applyLoadedRecordUnlink } = api();
	const { state, target, existingChild } = fixture();

	const result = applyLoadedRecordUnlink(state, target, 'keep');

	assert.equal(target.loadedFromId, null);
	assert.deepEqual(Array.from(state.bulkAssociations, (association) => association.id), [11, 12, 13]);
	assert.equal(existingChild.values.AccountId, '001ORIGINAL');
	assert.deepEqual({ ...result }, { detachedExisting: 1, retainedDraft: 1 });
});

test('explicit move keeps existing and draft children connected to the new draft', () => {
	const { applyLoadedRecordUnlink } = api();
	const { state, target, existingChild } = fixture();

	const result = applyLoadedRecordUnlink(state, target, 'move');

	assert.equal(target.loadedFromId, null);
	assert.deepEqual(Array.from(state.bulkAssociations, (association) => association.id), [10, 11, 12, 13]);
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
