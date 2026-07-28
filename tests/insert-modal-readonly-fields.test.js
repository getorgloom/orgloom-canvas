import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/public/js/insert-modal.js', import.meta.url), 'utf8');
const sandbox = { window: { OrgLoom: {} }, Date, Map, Set };
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const {
	formatReadOnlyFieldValue,
	isGuidedFieldComplete,
	sharedRecordEditAccess,
	resolveSharedDraftDescribe,
	sharedDraftLayoutMode,
} = sandbox.window.OrgLoom.insertModal._test;

test('existing records keep accessible non-writable fields in Additional fields', () => {
	assert.match(source, /const visibleFields =[\s\S]*recipientCanEdit[\s\S]*regular/);
	assert.match(source, /Additional fields/);
	assert.doesNotMatch(source, /data-section=\"readOnly\"/);
	assert.match(source, /!isWritable\(f\) \|\| forceReadOnly/);
	assert.match(source, /if \(div\.dataset\.readonly === 'true'\) \{\s*return;/);
});

test('draft records omit fields Salesforce will not accept during creation', () => {
	assert.match(source, /modalEditMode === 'new' && !isWritable\(f\)/);
	assert.match(source, /regular\.filter\(salesforceFieldWritable\)/);
});

test('Salesforce API field permissions, not page-layout presentation, control writability', () => {
	assert.match(source, /const readOnly =\s*!isWritable\(f\) \|\|\s*forceReadOnly/);
	assert.doesNotMatch(source, /layoutEditable && isWritable/);
});

test('permitted requested fields omitted from the page layout still appear under Additional fields', () => {
	assert.match(source, /const remaining = visibleFields\.filter\(\(f\) => !renderedNames\.has\(f\.name\)\)/);
	assert.match(source, /Additional fields/);
	assert.match(source, /modalEditMode === 'new' \? !!field\.createable : !!field\.updateable/);
});

test('the dedicated record-type control does not duplicate the field in layout or Additional fields', () => {
	assert.match(source, /new Set\(currentRecordTypes\.length > 1 \? \['RecordTypeId'\] : \[\]\)/);
	assert.match(source, /cell\.apiName === 'RecordTypeId' && currentRecordTypes\.length > 1/);
});

test('read-only values are formatted for display without becoming editable controls', () => {
	assert.equal(formatReadOnlyFieldValue(true, 'boolean'), 'Yes');
	assert.equal(formatReadOnlyFieldValue(false, 'boolean'), 'No');
	assert.equal(formatReadOnlyFieldValue(['A', 'B'], 'multipicklist'), 'A; B');
	assert.equal(formatReadOnlyFieldValue({ city: 'Phoenix' }, 'address'), '{\n  "city": "Phoenix"\n}');
	assert.match(source, /disabled aria-readonly=\"true\" tabindex=\"-1\"/);
});

test('focused SOQL imports retain their explicit field boundary in the editor', () => {
	assert.match(source, /const partialFieldSet =/);
	assert.match(source, /const inPartial = \(name\) => !partialFieldSet \|\| partialFieldSet\.has\(name\)/);
	assert.doesNotMatch(source, /mergeAccessibleRecordFields/);
});

test('guided field completion requires a touched, valid, meaningful value', () => {
	assert.equal(isGuidedFieldComplete('string', { touched: false, valid: true, value: 'Acme' }), false);
	assert.equal(isGuidedFieldComplete('string', { touched: true, valid: false, value: 'Acme' }), false);
	assert.equal(isGuidedFieldComplete('string', { touched: true, valid: true, value: '   ' }), false);
	assert.equal(isGuidedFieldComplete('string', { touched: true, valid: true, value: 'Acme' }), true);
	assert.equal(isGuidedFieldComplete('double', { touched: true, valid: true, value: '0' }), true);
	assert.equal(isGuidedFieldComplete('boolean', { touched: true, valid: true, value: false }), true);
	assert.equal(isGuidedFieldComplete('multipicklist', { touched: true, valid: true, values: [] }), false);
	assert.equal(isGuidedFieldComplete('multipicklist', { touched: true, valid: true, values: ['A'] }), true);
});

test('contributors can edit only explicit recipient requests', () => {
	const ordinaryRecord = { id: 1, values: { Name: 'Draft' } };
	const requestedRecord = {
		id: 2,
		_recipientSlot: true,
		slot: { slotId: 'slot-2', kind: 'fields', fields: ['Name'] },
	};

	assert.equal(sharedRecordEditAccess('viewer', requestedRecord, 'mine'), false);
	assert.equal(sharedRecordEditAccess('contributor', ordinaryRecord, null), false);
	assert.equal(sharedRecordEditAccess('contributor', requestedRecord, 'other'), false);
	assert.equal(sharedRecordEditAccess('contributor', requestedRecord, 'mine'), true);
	assert.equal(sharedRecordEditAccess('contributor', requestedRecord, 'generic'), true);
	assert.equal(sharedRecordEditAccess('editor', ordinaryRecord, null), true);
	assert.equal(sharedRecordEditAccess(null, ordinaryRecord, null), true);
});

test('request owners configure whole-record requests instead of editing their fields', () => {
	const wholeRecordRequest = {
		id: 3,
		slot: { slotId: 'slot-3', kind: 'whole-record', origin: 'standalone' },
	};
	const recipientRequest = { ...wholeRecordRequest, _recipientSlot: true };

	assert.equal(sharedRecordEditAccess(null, wholeRecordRequest, null), false);
	assert.equal(sharedRecordEditAccess('viewer', recipientRequest, 'mine'), false);
	assert.equal(sharedRecordEditAccess('contributor', recipientRequest, 'mine'), true);
	assert.equal(sharedRecordEditAccess('editor', recipientRequest, 'generic'), true);
});

test('shared drafts prefer the recipient Salesforce describe and fall back to saved metadata', async () => {
	const liveDescribe = { fields: [{ name: 'Name' }, { name: 'Phone' }] };
	const savedSnapshot = { fields: [{ name: 'Name' }], _canvasSnapshot: true };

	assert.equal(await resolveSharedDraftDescribe(async () => liveDescribe, 'Account', savedSnapshot), liveDescribe);
	assert.equal(
		await resolveSharedDraftDescribe(
			async () => {
				throw new Error('describe unavailable');
			},
			'Account',
			savedSnapshot,
		),
		savedSnapshot,
	);
	await assert.rejects(
		resolveSharedDraftDescribe(async () => {
			throw new Error('describe unavailable');
		}, 'Account'),
		/describe unavailable/,
	);
});

test('ordinary shared drafts use the recipient view layout while editable requests use create layout', () => {
	const ordinaryDraft = { id: 1, values: { Name: 'Draft' } };
	const requestedDraft = {
		id: 2,
		_recipientSlot: true,
		slot: { slotId: 'slot-2', kind: 'fields', fields: ['Name'] },
	};
	const existingRecord = { id: 3, loadedFromId: '001000000000001AAA' };

	assert.equal(sharedDraftLayoutMode('viewer', ordinaryDraft, null), 'View');
	assert.equal(sharedDraftLayoutMode('contributor', ordinaryDraft, null), 'View');
	assert.equal(sharedDraftLayoutMode('contributor', requestedDraft, 'mine'), 'Create');
	assert.equal(sharedDraftLayoutMode('editor', ordinaryDraft, null), 'Create');
	assert.equal(sharedDraftLayoutMode(null, ordinaryDraft, null), null);
	assert.equal(sharedDraftLayoutMode('viewer', existingRecord, null), null);
});

test('layout failures are retried instead of permanently collapsing fields into Additional fields', () => {
	assert.match(source, /params\.set\('mode', mode\)/);
	assert.match(source, /fetchEditLayout\(currentObject, currentRecordTypeId, recId, currentLayoutMode\)/);
	assert.match(source, /if \(result\.available\) \{\s*layoutCache\[key\] = result;/);
	assert.doesNotMatch(source, /layoutCache\[key\] = \{ sections: \[\], available: false \}/);
});
