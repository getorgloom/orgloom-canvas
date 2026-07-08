import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { stripDraftsForNonOwner, stripDraftValuesForSave, applySlotFieldFilter, slotKind, slotProgress, aggregateSlotProgress, slotProgressClass } from '../src/slot-helpers.js';

describe('slotKind', () => {
	test('returns null for missing slot', () => {
		assert.equal(slotKind(null), null);
		assert.equal(slotKind(undefined), null);
	});

	test('defaults missing kind to whole-record (back-compat)', () => {
		assert.equal(slotKind({ slotId: 1 }), 'whole-record');
	});

	test('returns explicit kind verbatim', () => {
		assert.equal(slotKind({ slotId: 1, kind: 'fields' }), 'fields');
		assert.equal(slotKind({ slotId: 1, kind: 'whole-record' }), 'whole-record');
	});
});

describe('stripDraftsForNonOwner', () => {
	test('preserves draft values + structure + slot', () => {
		const out = stripDraftsForNonOwner({
			drafts: [
				{ tempId: 't1', objectName: 'Account', x: 10, y: 20, values: { Name: 'Acme' }, slot: { slotId: 1, label: 'Customer' } },
			],
			loadedRecords: [],
		});
		assert.equal(out.drafts.length, 1);
		assert.equal(out.drafts[0].tempId, 't1');
		assert.equal(out.drafts[0].objectName, 'Account');
		assert.equal(out.drafts[0].x, 10);
		assert.equal(out.drafts[0].y, 20);

		assert.deepEqual(out.drafts[0].values, { Name: 'Acme' });
		assert.deepEqual(out.drafts[0].slot, { slotId: 1, label: 'Customer' });
	});

	test('drafts with no values default to empty object', () => {
		const out = stripDraftsForNonOwner({
			drafts: [{ tempId: 't1', objectName: 'Account', x: 0, y: 0 }],
			loadedRecords: [],
		});
		assert.deepEqual(out.drafts[0].values, {});
	});

	test('whole-record slot loaded records: strips loadedFromId', () => {
		const out = stripDraftsForNonOwner({
			drafts: [],
			loadedRecords: [
				{ objectName: 'Account', x: 0, y: 0, loadedFromId: '001ABC', slot: { slotId: 5, kind: 'whole-record', label: 'Slot' } },
			],
		});
		assert.equal(out.loadedRecords[0].loadedFromId, undefined);
		assert.deepEqual(out.loadedRecords[0].slot, { slotId: 5, kind: 'whole-record', label: 'Slot' });
	});

	test('legacy slot (no kind) treated as whole-record: strips loadedFromId', () => {
		const out = stripDraftsForNonOwner({
			drafts: [],
			loadedRecords: [
				{ objectName: 'Account', x: 0, y: 0, loadedFromId: '001LEGACY', slot: { slotId: 6, label: 'Old' } },
			],
		});
		assert.equal(out.loadedRecords[0].loadedFromId, undefined);
	});

	test('field-level slot loaded records: KEEPS loadedFromId', () => {
		const out = stripDraftsForNonOwner({
			drafts: [],
			loadedRecords: [
				{
					objectName: 'Opportunity',
					x: 100, y: 200,
					loadedFromId: '006FIELDS',
					slot: { slotId: 7, kind: 'fields', fields: ['StageName', 'CloseDate'], label: 'Update' },
				},
			],
		});

		assert.equal(out.loadedRecords[0].loadedFromId, '006FIELDS');
		assert.equal(out.loadedRecords[0].x, 100);
		assert.equal(out.loadedRecords[0].y, 200);
		assert.deepEqual(out.loadedRecords[0].slot.fields, ['StageName', 'CloseDate']);
	});

	test('non-slot loaded records pass through unchanged', () => {
		const out = stripDraftsForNonOwner({
			drafts: [],
			loadedRecords: [
				{ objectName: 'Account', x: 0, y: 0, loadedFromId: '001PLAIN' },
			],
		});
		assert.equal(out.loadedRecords[0].loadedFromId, '001PLAIN');
	});

	test('handles empty payload + missing arrays', () => {
		assert.deepEqual(stripDraftsForNonOwner({}), { drafts: [], loadedRecords: [] });
		assert.deepEqual(stripDraftsForNonOwner(null), { drafts: [], loadedRecords: [] });
	});
});

describe('stripDraftValuesForSave', () => {

	test('preserves drafts with values (identity pass-through)', () => {
		const input = {
			drafts: [
				{ tempId: 't1', objectName: 'Account', x: 10, y: 20, values: { Name: 'Acme', Phone: '555' }, slot: { slotId: 7, label: 'Lead' } },
				{ tempId: 't2', objectName: 'Contact', x: 30, y: 40, values: { Email: 'a@b.c' } },
			],
		};
		const out = stripDraftValuesForSave(input);
		assert.equal(out, input);
		assert.deepEqual(out.drafts[0].values, { Name: 'Acme', Phone: '555' });
		assert.deepEqual(out.drafts[1].values, { Email: 'a@b.c' });
	});

	test('does not touch loadedRecords', () => {
		const input = {
			loadedRecords: [
				{ tempId: 'r1', objectName: 'Account', loadedFromId: '001abc', values: { Name: 'Acme' } },
			],
			drafts: [],
		};
		const out = stripDraftValuesForSave(input);
		assert.deepEqual(out.loadedRecords, input.loadedRecords);
	});

	test('does not mutate the input', () => {
		const input = {
			drafts: [{ tempId: 't1', objectName: 'Account', values: { Name: 'Acme' } }],
		};
		const before = JSON.stringify(input);
		stripDraftValuesForSave(input);
		assert.equal(JSON.stringify(input), before);
	});

	test('passes through null / undefined / no-drafts payloads', () => {
		assert.equal(stripDraftValuesForSave(null), null);
		assert.equal(stripDraftValuesForSave(undefined), undefined);
		const noDrafts = { loadedRecords: [], _meta: { savedAt: 'x' } };
		assert.equal(stripDraftValuesForSave(noDrafts), noDrafts);
	});

	test('preserves _meta and other top-level fields', () => {
		const input = {
			drafts: [{ tempId: 't1', objectName: 'Account', values: { Name: 'Acme' } }],
			_meta: { savedAt: '2026-01-01T00:00:00Z' },
			associations: [{ from: 'a', to: 'b' }],
		};
		const out = stripDraftValuesForSave(input);
		assert.deepEqual(out._meta, { savedAt: '2026-01-01T00:00:00Z' });
		assert.deepEqual(out.associations, [{ from: 'a', to: 'b' }]);
		assert.deepEqual(out.drafts[0].values, { Name: 'Acme' });
	});
});
