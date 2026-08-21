import { test } from 'node:test';
import assert from 'node:assert/strict';
import { payloadContainsSlots } from '../src/slot-helpers.js';

test('save slot gate detects markers in loaded records and drafts', () => {
	assert.equal(payloadContainsSlots({ loadedRecords: [{ loadedFromId: '001', slot: { slotId: 1 } }] }), true);
	assert.equal(payloadContainsSlots({ drafts: [{ tempId: 2, slot: { slotId: 2, kind: 'fields' } }] }), true);
});

test('save slot gate ignores ordinary and malformed canvas records', () => {
	assert.equal(payloadContainsSlots({ loadedRecords: [{ loadedFromId: '001' }], drafts: [{ tempId: 2 }] }), false);
	assert.equal(payloadContainsSlots({ drafts: [{ tempId: 2, slot: {} }] }), false);
	assert.equal(payloadContainsSlots(null), false);
	assert.equal(payloadContainsSlots({ loadedRecords: 'not-an-array' }), false);
});
