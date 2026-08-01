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
	canTakeOverField,
	resolveSharedDraftDescribe,
	sharedDraftLayoutMode,
	fieldsForLayoutCell,
	visibleRecordFields,
	contributorRequestedFieldNames,
	shouldShowRecipientSlotAccessNotice,
	mergeSubmittedFieldValues,
} = sandbox.window.OrgLoom.insertModal._test;

test('existing records keep accessible non-writable fields in Additional fields', () => {
	assert.match(source, /const visibleFields =[\s\S]*recipientCanEdit[\s\S]*regular/);
	assert.match(source, /Additional fields/);
	assert.doesNotMatch(source, /data-section=\"readOnly\"/);
	assert.match(source, /!isWritable\(f\) \|\| forceReadOnly/);
	assert.match(source, /if \(div\.dataset\.readonly === 'true'\) \{\s*return;/);
});

test('layout fallback uses one Additional fields section instead of a synthetic Required section', () => {
	assert.doesNotMatch(source, /This object has no required fields/);
	assert.doesNotMatch(source, /field-section-header">Required/);
	assert.match(source, /else if \(visibleFields\.length > 0\)[\s\S]*Additional fields/);
});

test('draft records omit fields Salesforce will not accept during creation', () => {
	const writable = { name: 'Name', createable: true };
	const readOnly = { name: 'CreatedDate', createable: false };
	const visible = visibleRecordFields({
		modalEditMode: 'new',
		recipientFieldRequest: false,
		recipientCanEdit: true,
		sharedReadOnly: false,
		regular: [writable, readOnly],
		writable: [writable],
		salesforceFieldWritable: (field) => field.createable,
	});
	assert.deepEqual(
		Array.from(visible, (field) => field.name),
		['Name'],
	);
	assert.match(source, /regular\.filter\(salesforceFieldWritable\)/);
});

test('shared draft field requests show readable fields while only requested fields remain writable', () => {
	const requested = { name: 'Name', createable: true };
	const readOnlyContext = { name: 'Phone', createable: true };
	const inaccessibleToCreate = { name: 'CreatedDate', createable: false };
	const regular = [requested, readOnlyContext, inaccessibleToCreate];

	const visible = visibleRecordFields({
		modalEditMode: 'new',
		recipientFieldRequest: true,
		recipientCanEdit: true,
		sharedReadOnly: false,
		regular,
		writable: [requested],
		salesforceFieldWritable: (field) => field.createable,
	});

	assert.deepEqual(
		Array.from(visible, (field) => field.name),
		['Name', 'Phone', 'CreatedDate'],
	);
	assert.match(source, /visibleFieldNames\.has\(f\.name\)/);
});

test('assigned editors and contributors see inaccessible-request guidance', () => {
	const assignedRequest = { _recipientSlot: true };
	const requestedFields = new Set(['Name']);
	assert.equal(shouldShowRecipientSlotAccessNotice('contributor', assignedRequest, requestedFields), true);
	assert.equal(shouldShowRecipientSlotAccessNotice('editor', assignedRequest, requestedFields), true);
	assert.equal(shouldShowRecipientSlotAccessNotice('viewer', assignedRequest, requestedFields), false);
	assert.equal(shouldShowRecipientSlotAccessNotice('editor', { _recipientSlot: false }, requestedFields), false);
	assert.match(source, /The field\(s\) marked for you aren’t available to your Salesforce user\./);
});

test('ordinary shared drafts keep every readable field visible and place layout fields normally', () => {
	const name = { name: 'Name', createable: true };
	const createdDate = { name: 'CreatedDate', createable: false };
	const visible = visibleRecordFields({
		modalEditMode: 'new',
		recipientFieldRequest: false,
		recipientCanEdit: false,
		sharedReadOnly: true,
		regular: [name, createdDate],
		writable: [],
		salesforceFieldWritable: (field) => field.createable,
	});

	assert.deepEqual(
		Array.from(visible, (field) => field.name),
		['Name', 'CreatedDate'],
	);
	assert.match(source, /visibleFieldNames\.has\(f\.name\)/);
	assert.match(source, /else if \(shareRole && !recipientCanEdit\)[\s\S]*Fields <span class="count">/);
});

test('contributor saves submit only requested fields and preserve read-only context', () => {
	const record = {
		_recipientSlot: true,
		slot: { slotId: 'slot-1', kind: 'fields', fields: ['LastName'] },
	};
	const requested = contributorRequestedFieldNames('contributor', record);
	const changed = ['LastName', 'Phone', 'CreatedDate'].filter((fieldName) => requested.has(fieldName));
	const nextValues = mergeSubmittedFieldValues(
		{ LastName: '', Phone: '602-555-0100', CreatedDate: '2026-07-01T00:00:00.000Z' },
		{ LastName: 'Slattery' },
		changed,
	);

	assert.deepEqual(Array.from(requested), ['LastName']);
	assert.deepEqual(changed, ['LastName']);
	assert.deepEqual(
		{ ...nextValues },
		{
			LastName: 'Slattery',
			Phone: '602-555-0100',
			CreatedDate: '2026-07-01T00:00:00.000Z',
		},
	);
	assert.equal(contributorRequestedFieldNames('editor', record), null);
	assert.equal(
		contributorRequestedFieldNames('contributor', { _recipientSlot: true, slot: { kind: 'whole-record' } }),
		null,
	);
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
	assert.match(source, /f\.name === 'RecordTypeId' && currentRecordTypes\.length > 1/);
});

test('compound layout fields render their writable constituents in the layout position', () => {
	const fields = [
		{ name: 'Name', label: 'Full Name', createable: false, updateable: false },
		{ name: 'LastName', label: 'Last Name', compoundFieldName: 'Name', createable: true, updateable: true },
		{ name: 'FirstName', label: 'First Name', compoundFieldName: 'Name', createable: true, updateable: true },
		{ name: 'Email', label: 'Email', createable: true, updateable: true },
	];

	assert.deepEqual(
		Array.from(fieldsForLayoutCell(fields, 'Name'), (field) => field.name),
		['LastName', 'FirstName'],
	);
	assert.deepEqual(
		Array.from(fieldsForLayoutCell(fields, 'Email'), (field) => field.name),
		['Email'],
	);
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

test('field requests narrow contributor access without narrowing editor access', () => {
	assert.match(source, /shareRole === 'contributor' &&\s*slotFieldNames/);
	assert.match(
		source,
		/shareRole === 'contributor' &&\s*canvasState\.currentRecordRef &&\s*canvasState\.currentRecordRef\._recipientSlot/,
	);
	assert.match(source, /const isSlotField = !!\(slotFieldNames && slotFieldNames\.has\(f\.name\)\)/);
	assert.match(source, /title="The author requested that a contributor complete this field.">requested/);
});

test('request owners and editors can complete whole-record requests', () => {
	const wholeRecordRequest = {
		id: 3,
		slot: { slotId: 'slot-3', kind: 'whole-record', origin: 'standalone' },
	};
	const recipientRequest = { ...wholeRecordRequest, _recipientSlot: true };

	assert.equal(sharedRecordEditAccess(null, wholeRecordRequest, null), true);
	assert.equal(sharedRecordEditAccess('viewer', recipientRequest, 'mine'), false);
	assert.equal(sharedRecordEditAccess('contributor', recipientRequest, 'mine'), true);
	assert.equal(sharedRecordEditAccess('editor', recipientRequest, 'generic'), true);
	assert.match(source, /id="modal-configure-request"/);
	assert.match(source, /configureBtn\.hidden = !configurableRecordRequest \|\| !configureRequest/);
});

test('field takeover is offered only when the lock is the reason the field is read-only', () => {
	const peerLock = { owned: false, accountId: 'account-2' };

	assert.equal(canTakeOverField(peerLock, false), true);
	assert.equal(canTakeOverField(peerLock, true), false);
	assert.equal(canTakeOverField({ owned: true }, false), false);
	assert.equal(canTakeOverField(null, false), false);
	assert.match(source, /const takeoverAllowed = canTakeOverField\(peerLock, configuredReadOnly\)/);
	assert.match(source, /data-field-takeover-allowed="true"/);
	assert.match(source, /dataset\.fieldTakeoverAllowed !== 'true'/);
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

test('removing a live request reloads the ordinary shared draft view layout', () => {
	assert.match(
		source,
		/function refreshCurrentRecordAccess\(record\)[\s\S]*const nextLayoutMode = sharedDraftLayoutMode\([\s\S]*currentLayoutMode = nextLayoutMode/,
	);
	assert.match(
		source,
		/function refreshCurrentRecordAccess\(record\)[\s\S]*fetchEditLayout\(currentObject, currentRecordTypeId, recId, currentLayoutMode\)/,
	);
	assert.match(source, /currentLayoutMode !== nextLayoutMode[\s\S]*currentLayout = layout/);
	assert.match(source, /layoutModeChanged \|\| !currentLayout \|\| !currentLayout\.available/);
});

test('layout failures are retried instead of permanently collapsing fields into Additional fields', () => {
	assert.match(source, /params\.set\('mode', mode\)/);
	assert.match(source, /fetchEditLayout\(currentObject, currentRecordTypeId, recId, currentLayoutMode\)/);
	assert.match(source, /if \(result\.available\) \{\s*layoutCache\[key\] = result;/);
	assert.doesNotMatch(source, /layoutCache\[key\] = \{ sections: \[\], available: false \}/);
});
