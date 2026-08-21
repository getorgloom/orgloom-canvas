import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/public/js/insert-modal.js', import.meta.url), 'utf8');
const datetimeSource = readFileSync(new URL('../src/public/js/datetime.js', import.meta.url), 'utf8');
const sandbox = {
	window: { OrgLoom: {}, SF_USER_TIME_ZONE: 'America/Los_Angeles' },
	Date,
	Intl,
	Map,
	Set,
};
vm.createContext(sandbox);
vm.runInContext(datetimeSource, sandbox);
vm.runInContext(source, sandbox);
const {
	formatReadOnlyFieldValue,
	isSalesforceTrue,
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
	formSelectValue,
	formInputValue,
	encryptedControlValue,
	encryptedControlState,
	canChangeEncryptedField,
	encryptedActionForField,
	timeForInput,
	formatTimeChoice,
	timeForChoice,
	timeChoiceOptions,
	dateTimeForInput,
	dateTimeFromInput,
	fieldControlsDependentPicklist,
	recordTypePicklistValues,
	recordTypePicklistAvailable,
	retainCurrentRecordType,
	retainCurrentPicklistValues,
	applyLayoutPicklistFallback,
	supportsCustomPicklistValue,
	numericFieldStep,
	geolocationCoordinateKind,
	groupGeolocationFields,
	truncateDecimalScale,
	geolocationValidationMessage,
	browserSafeNumericBounds,
	stepNumericInput,
	wireNumericInputSteppers,
	inferReferenceTarget,
	isExternalKeyReferenceField,
	picklistSelectionForContext,
	intentionalChangedFieldNames,
	shouldValidateEditorField,
	firstInvalidEditorControl,
	editorFieldValueControl,
	richTextForEditor,
	recordRichTextForEditor,
} = sandbox.window.OrgLoom.insertModal._test;

test('external-key references use a bounded text input without lookup resolution', () => {
	const externalLookup = {
		name: 'ExternalParent__c',
		type: 'reference',
		createable: true,
		updateable: true,
		referenceTo: ['ExternalParent__x'],
		referenceTargetField: 'ExternalId',
	};
	assert.equal(isExternalKeyReferenceField(externalLookup), true);
	assert.equal(
		isExternalKeyReferenceField({ name: 'AccountId', type: 'reference', referenceTo: ['Account'] }),
		false,
	);
	assert.match(source, /Enter the external record’s External ID/);
	assert.match(source, /Org Loom cannot verify that the external record exists/);
	assert.match(source, /placeholder="Enter external record ID"/);
	assert.match(source, /if \(isExternalKeyReferenceField\(f\)\)/);
	assert.match(source, /configuredReadOnly = !!\(opts && opts\.readOnly\)/);
	assert.match(source, /classList\.contains\('is-external-lookup'\)/);
	assert.match(source, /f\.type === 'reference' && !isExternalKeyReferenceField\(f\)/);
	assert.doesNotMatch(source, /Org Loom leaves external lookup fields unchanged/);
});

test('Salesforce rich HTML reopens as plain text in the record editor', () => {
	assert.equal(richTextForEditor('<p>First &amp; second</p><p>&amp;nbsp;</p>'), 'First & second\n&nbsp;');
	assert.equal(richTextForEditor('First<br>Second<br/>Third'), 'First\nSecond\nThird');
	assert.match(source, /data-html-formatted="true"/);
	assert.match(source, /recordRichTextForEditor\(canvasState\.currentRecordRef, field, val\)/);
});

test('canvas-authored rich text remains literal when the editor reopens', () => {
	const record = {
		loadedFromId: '001000000000001AAA',
		loadedValues: { Rich_Text__c: '<p>Original</p>' },
	};
	assert.equal(recordRichTextForEditor(record, 'Rich_Text__c', '<p>Original</p>'), 'Original');
	assert.equal(recordRichTextForEditor(record, 'Rich_Text__c', '<b>not bold</b>'), '<b>not bold</b>');
	assert.equal(recordRichTextForEditor({ values: {} }, 'Rich_Text__c', '&nbsp;'), '&nbsp;');
});

test('numeric input steps follow Salesforce field scale', () => {
	assert.equal(numericFieldStep({ type: 'currency', scale: 2 }, 1), 0.01);
	assert.equal(numericFieldStep({ type: 'double', scale: 3 }, 1), 0.001);
	assert.equal(numericFieldStep({ type: 'currency', scale: 0 }, 0.01), 1);
	assert.equal(numericFieldStep({ type: 'currency' }, 0.01), 0.01);
});

test('geolocation components are grouped and use Salesforce coordinate ranges', () => {
	const fields = [
		{ name: 'Site__c', label: 'Site', type: 'location' },
		{
			name: 'Site__Latitude__s',
			label: 'Latitude',
			type: 'double',
			compoundFieldName: 'Site__c',
			scale: 6,
		},
		{
			name: 'Site__Longitude__s',
			label: 'Longitude',
			type: 'double',
			compoundFieldName: 'Site__c',
			scale: 6,
		},
		{ name: 'Name', label: 'Name', type: 'string' },
	];
	assert.equal(geolocationCoordinateKind(fields[1], fields), 'latitude');
	assert.equal(geolocationCoordinateKind(fields[2], fields), 'longitude');
	assert.equal(geolocationCoordinateKind(fields[3], fields), null);
	const grouped = groupGeolocationFields([fields[1], fields[3], fields[2]], fields);
	assert.equal(grouped[0].kind, 'geolocation');
	assert.deepEqual(
		Array.from(grouped[0].fields, (field) => field.name),
		['Site__Latitude__s', 'Site__Longitude__s'],
	);
	assert.equal(grouped[1].field.name, 'Name');
	assert.equal(
		geolocationValidationMessage('latitude', '91'),
		'Latitude should be a decimal number in a range [-90, 90].',
	);
	assert.equal(
		geolocationValidationMessage('longitude', '-181'),
		'Longitude should be a decimal number in a range [-180, 180].',
	);
	assert.equal(geolocationValidationMessage('latitude', '90'), '');
});

test('geolocation precision is truncated rather than rounded', () => {
	assert.equal(truncateDecimalScale('33.448376987', 6), '33.448376');
	assert.equal(truncateDecimalScale('-112.074037999', 6), '-112.074037');
	assert.equal(truncateDecimalScale('90.0000009', 6), '90.000000');
	assert.equal(truncateDecimalScale('12.3', 6), '12.3');
	assert.match(source, /const b = coordinateKind \? fieldBounds\(f\) : browserSafeNumericBounds/);
	assert.match(source, /data-coordinate-kind=/);
	assert.match(source, /class="geolocation-field-group"/);
});

test('numeric inputs omit bounds whose step grid exceeds browser-safe precision', () => {
	const annualRevenue = browserSafeNumericBounds({ min: -1e18, max: 1e18, step: 1 });
	assert.equal(annualRevenue.min, undefined);
	assert.equal(annualRevenue.max, undefined);
	assert.equal(annualRevenue.step, 1);
	const scaledCurrency = browserSafeNumericBounds({
		min: -9999999999999999.99,
		max: 9999999999999999.99,
		step: 0.01,
	});
	assert.equal(scaledCurrency.min, undefined);
	assert.equal(scaledCurrency.max, undefined);
	assert.equal(scaledCurrency.step, 0.01);
	const employees = browserSafeNumericBounds({ min: -2147483648, max: 2147483647, step: 1 });
	assert.equal(employees.min, -2147483648);
	assert.equal(employees.max, 2147483647);
	assert.equal(employees.step, 1);
});

test('numeric step controls change the value through the native number API', () => {
	const input = {
		value: '100',
		stepUp() {
			this.value = '101';
		},
		stepDown() {
			this.value = '99';
		},
	};
	assert.equal(stepNumericInput(input, 1), true);
	assert.equal(input.value, '101');
	input.value = '100';
	assert.equal(stepNumericInput(input, -1), true);
	assert.equal(input.value, '99');
});

test('numeric controls wire both spinner clicks and arrow keys', () => {
	const handlers = {};
	const input = {
		value: '100',
		addEventListener(type, handler) {
			handlers[type] = handler;
		},
		getBoundingClientRect() {
			return { top: 0, right: 100, width: 100, height: 40 };
		},
		focus() {},
		stepUp() {
			this.value = String(Number(this.value) + 1);
		},
		stepDown() {
			this.value = String(Number(this.value) - 1);
		},
	};
	wireNumericInputSteppers({ querySelectorAll: () => [input] });
	let prevented = false;
	handlers.pointerdown({
		button: 0,
		clientX: 90,
		clientY: 10,
		preventDefault() {
			prevented = true;
		},
	});
	assert.equal(prevented, true);
	assert.equal(input.value, '101');
	handlers.keydown({ key: 'ArrowDown', preventDefault() {} });
	assert.equal(input.value, '100');
});

test('record editor datetimes round-trip through the Salesforce user timezone', () => {
	assert.equal(dateTimeForInput('2026-07-15T19:30:00.000Z'), '2026-07-15T12:30');
	assert.equal(dateTimeFromInput('2026-07-15T12:30'), '2026-07-15T19:30:00.000Z');
});

test('Salesforce time values populate 15-minute time dropdowns', () => {
	assert.equal(timeForInput('13:45:30.000Z'), '13:45:30.000');
	assert.equal(timeForInput('13:45:30Z'), '13:45:30');
	assert.equal(timeForInput('13:45'), '13:45');
	assert.equal(timeForInput('not-a-time'), '');
	assert.equal(timeChoiceOptions().length, 96);
	assert.equal(timeChoiceOptions()[0].value, '00:00');
	assert.equal(timeChoiceOptions()[1].value, '00:15');
	assert.equal(timeChoiceOptions()[95].value, '23:45');
	assert.equal(timeChoiceOptions('13:45').length, 96);
	assert.equal(timeForChoice('13:45:00.000Z'), '13:45');
	assert.equal(timeChoiceOptions('13:45:00.000Z').length, 96);
	assert.doesNotMatch(formatTimeChoice('13:45:00.000Z'), /\.000/);
	assert.match(formatTimeChoice('13:47:30.125Z'), /30\.125/);
	assert.deepEqual(
		{ ...timeChoiceOptions('13:45:30.000Z')[0] },
		{ value: '13:45:30.000', label: formatTimeChoice('13:45:30.000') + ' (current value)', current: true },
	);
	assert.match(source, /<select class="time-select"/);
	assert.match(source, /if \(ftype === 'time'\) \{\s*setTimeSelectValue\(el, val\)/);
});

test('read-only time results, including formulas, use the typed time formatter', () => {
	assert.equal(formatReadOnlyFieldValue('23:41:46.001Z', 'time'), formatTimeChoice('23:41:46.001Z'));
	assert.notEqual(formatReadOnlyFieldValue('23:41:46.001Z', 'time'), '23:41:46.001Z');
	assert.equal(formatReadOnlyFieldValue('not-a-time', 'time'), 'not-a-time');
});

test('read-only checkbox formulas recognize Salesforce boolean representations', () => {
	for (const value of [true, 1, '1', 'true', 'TRUE', ' True ']) {
		assert.equal(isSalesforceTrue(value), true);
		assert.equal(formatReadOnlyFieldValue(value, 'boolean'), 'Yes');
	}
	for (const value of [false, 0, '0', 'false', 'FALSE']) {
		assert.equal(isSalesforceTrue(value), false);
		assert.equal(formatReadOnlyFieldValue(value, 'boolean'), 'No');
	}
	assert.match(source, /f\.type === 'boolean'[\s\S]*type="checkbox" class="readonly-checkbox"/);
	assert.match(
		source,
		/div\.dataset\.readonly === 'true'[\s\S]*ftype === 'boolean'[\s\S]*display\.checked = isSalesforceTrue\(val\)/,
	);
});

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
		{ LastName: 'Doe' },
		changed,
	);

	assert.deepEqual(Array.from(requested), ['LastName']);
	assert.deepEqual(changed, ['LastName']);
	assert.deepEqual(
		{ ...nextValues },
		{
			LastName: 'Doe',
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

test('clearing a touched field preserves an explicit null in the canvas patch', () => {
	const nextValues = mergeSubmittedFieldValues(
		{ TestCurr__c: 125, Description: 'Keep me' },
		{ Description: 'Keep me' },
		['TestCurr__c'],
	);

	assert.deepEqual({ ...nextValues }, { TestCurr__c: null, Description: 'Keep me' });
});

test('encrypted replacement and clearing remain separate upload decisions', () => {
	assert.equal(encryptedControlValue(false, 'replacement'), 'replacement');
	assert.equal(encryptedControlValue(true, 'replacement'), null);
	assert.equal(encryptedControlValue(false, ''), undefined);
	assert.doesNotMatch(source, /input\.value = '';\s*input\.disabled = true/);
	assert.match(source, /Ready for upload in this tab\./);
	assert.match(source, /class="encrypted-field-change"/);
	assert.match(source, /aria-describedby=/);
	assert.match(source, /Why encrypted fields work differently/);
	assert.doesNotMatch(source, /Salesforce may return only a masked value/);
	assert.match(source, /popover="manual"/);
	assert.match(source, /function positionEncryptedTooltip\(trigger, content\)/);
	assert.match(source, /document\.body\.appendChild\(content\)/);
	assert.doesNotMatch(source, /Change for next upload/);
	assert.match(source, /data-encrypted-action-toggle aria-expanded=/);
	assert.match(source, /const actionPanelOpen = false/);
	assert.match(source, /panel\.hidden = expanded/);
	assert.match(source, /<span>What should happen on the next upload\?<\/span>/);
	assert.match(source, /Not loaded in this tab/);
	assert.doesNotMatch(source, /encrypted-field-empty">Empty/);
	assert.doesNotMatch(source, /Empty string/);
	assert.doesNotMatch(source, />In Salesforce<\/span>/);
	assert.match(source, /data-encrypted-load-current=/);
	assert.match(source, /Loaded from Salesforce for this tab only\./);
	assert.match(source, /record\.loadedValues = Object\.assign\(\{\}, record\.loadedValues \|\| \{\}, \{/);
});

test('only the canvas owner can stage an encrypted replacement or clear', () => {
	assert.equal(canChangeEncryptedField(null, false), true);
	assert.equal(canChangeEncryptedField('editor', false), false);
	assert.equal(canChangeEncryptedField('contributor', false), false);
	assert.equal(canChangeEncryptedField('viewer', false), false);
	assert.equal(canChangeEncryptedField(null, true), false);
	assert.match(
		source,
		/function encryptedInputForField\(f, readOnly\) \{\s*const record = canvasState\.currentRecordRef;\s*const shareRole = getCanvasShareRole\(\);/,
	);
	assert.match(source, /if \(canChangeEncryptedField\(shareRole, readOnly\)\)/);
	assert.match(
		source,
		/function captureEncryptedFormValue\(target\) \{\s*if \(getCanvasShareRole\(\)\) \{\s*return false;/,
	);
	assert.match(
		source,
		/if \(record && !getCanvasShareRole\(\)\) \{[\s\S]*?for \(const \[fieldName, value\] of currentEncryptedFormValues\)/,
	);
	assert.doesNotMatch(source, /Only the canvas owner can enter or clear an encrypted value for upload\./);
	assert.match(source, /Canvas owner managed/);
});

test('encrypted fields use explicit unchanged, replace, and clear actions', () => {
	assert.equal(encryptedActionForField(true, false, false, undefined, false, undefined), 'unchanged');
	assert.equal(encryptedActionForField(false, false, false, undefined, false, undefined), 'replace');
	assert.equal(encryptedActionForField(true, true, false, undefined, false, undefined), 'replace');
	assert.equal(encryptedActionForField(true, true, true, 'secret', false, undefined), 'replace');
	assert.equal(encryptedActionForField(true, true, true, null, false, undefined), 'clear');
	assert.equal(encryptedActionForField(true, false, false, undefined, true, null), 'clear');
	assert.equal(encryptedActionForField(true, true, true, 'secret', false, undefined, true), 'unchanged');
	assert.match(source, /value="unchanged" data-encrypted-action/);
	assert.match(source, /value="replace" data-encrypted-action/);
	assert.match(source, /value="clear" data-encrypted-action/);
	assert.match(source, /<input type="text" id="f_/);
	assert.doesNotMatch(source, /data-encrypted-reveal/);
	assert.doesNotMatch(source, /type="password"/);
	assert.match(source, /Enter a replacement value before uploading\./);
	assert.match(
		source,
		/Ready for upload in this tab\. If you reopen the canvas, you’ll need to enter it again\. This value is not saved during a canvas save\./,
	);
	assert.doesNotMatch(source, /Not saved to the canvas or shared with collaborators\./);
	assert.match(source, /Will be cleared from Salesforce on the next upload\./);
	assert.match(source, /This cannot be undone by Org Loom\./);
	assert.doesNotMatch(source, /data-encrypted-privacy/);
	assert.match(
		source,
		/for \(const fieldName of currentEncryptedDismissedFields\) \{\s*encryptedFields\.dismissIntent\(record, fieldName\)/,
	);
	assert.match(source, /restoreEncryptedBaseline\(fieldName\)/);
	assert.match(source, /changed = changed\.filter\(\(fieldName\) => !encryptedFieldNames\.has\(fieldName\)\)/);
	assert.doesNotMatch(source, /data-encrypted-clear="true"/);
});

test('undoing a new encrypted-field choice returns to unchanged without creating a saved intent', () => {
	assert.deepEqual({ ...encryptedControlState(false, false, '') }, { tracked: false, value: undefined });
	assert.deepEqual({ ...encryptedControlState(false, true, '') }, { tracked: true, value: null });
	assert.deepEqual(
		{ ...encryptedControlState(false, false, 'replacement') },
		{
			tracked: true,
			value: 'replacement',
		},
	);
	assert.deepEqual({ ...encryptedControlState(true, false, '') }, { tracked: true, value: undefined });
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
	assert.match(source, /new Set\(showRecordTypeField \? \['RecordTypeId'\] : \[\]\)/);
	assert.match(source, /f\.name === 'RecordTypeId' && showRecordTypeField/);
});

test('compound layout fields render their writable constituents in the layout position', () => {
	const fields = [
		{ name: 'Name', label: 'Full Name', createable: false, updateable: false },
		{ name: 'Salutation', label: 'Salutation', createable: true, updateable: true },
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
	assert.deepEqual(
		Array.from(fieldsForLayoutCell(fields, ['Salutation', 'FirstName', 'LastName']), (field) => field.name),
		['Salutation', 'FirstName', 'LastName'],
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

test('clearing a picklist remains an explicit blank through form rerenders', () => {
	assert.equal(formSelectValue('picklist', ''), null);
	assert.equal(formSelectValue('combobox', null), null);
	assert.equal(formSelectValue('picklist', 'Mrs.'), 'Mrs.');
	assert.equal(formSelectValue('multipicklist', []), null);
	assert.equal(formSelectValue('multipicklist', ['', 'Primary', 'Secondary']), 'Primary;Secondary');
	assert.match(source, /if \(el\.tagName === 'SELECT'\) \{[\s\S]*formSelectValue\(ftype, v\)/);
	assert.match(source, /el\.value = display == null \? '' : display/);
	assert.equal(
		fieldControlsDependentPicklist(
			[{ name: 'Salutation' }, { name: 'Subcategory__c', controllerName: 'Category__c' }],
			'Salutation',
		),
		false,
	);
	assert.equal(
		fieldControlsDependentPicklist([{ name: 'Subcategory__c', controllerName: 'Category__c' }], 'Category__c'),
		true,
	);
});

test('clearing a reference remains an explicit null for contributor submission', () => {
	assert.equal(formInputValue('reference', ''), null);
	assert.equal(formInputValue('reference', null), null);
	assert.equal(formInputValue('reference', '001000000000001AAA'), '001000000000001AAA');
	assert.equal(formInputValue('string', ''), undefined);
	assert.match(source, /const inputValue = formInputValue\(ftype, v\)/);
});

test('record-type picklist options remain authoritative when Salesforce returns none', () => {
	const field = {
		picklistValues: [{ value: 'Generic' }],
		picklistValuesByRecordType: { '012EMPTY': [] },
	};
	assert.deepEqual(Array.from(recordTypePicklistValues(field, '012EMPTY')), []);
	assert.deepEqual(Array.from(recordTypePicklistValues(field, '012OTHER')), []);
	assert.equal(recordTypePicklistAvailable(field, '012EMPTY'), true);
	assert.equal(recordTypePicklistAvailable(field, '012OTHER'), false);
});

test('exact layout picklist metadata replaces stale record-type options', () => {
	const fields = [
		{
			name: 'Status__c',
			picklistValues: [],
			picklistValuesByRecordType: {
				'012TYPEB': [{ value: 'B', label: 'Type B' }],
			},
		},
	];
	const layoutValues = {
		Status__c: {
			values: [{ value: 'A', label: 'Type A' }],
			defaultValue: null,
		},
	};

	applyLayoutPicklistFallback(fields, layoutValues, '012TYPEB');
	assert.deepEqual(
		Array.from(fields[0].picklistValuesByRecordType['012TYPEB'], (value) => value.value),
		['A'],
	);

	applyLayoutPicklistFallback(fields, layoutValues, '012TYPEC');
	assert.deepEqual(
		Array.from(fields[0].picklistValuesByRecordType['012TYPEC'], (value) => value.value),
		['A'],
	);
});

test('switching record type refreshes choices without clearing current picklist values', () => {
	const handler = source.match(/rtSelect\.addEventListener\('change',[\s\S]*?\r?\n\s*}\);\r?\n\s*}/);
	assert.ok(handler);
	assert.match(handler[0], /picklistContextOverrides\(currentFields, \{ restoreLoadedValues: true \}\)/);
	assert.match(handler[0], /picklistValuesRecordTypeId === currentRecordTypeId/);
	assert.match(handler[0], /applyLayoutPicklistFallback/);
	assert.match(handler[0], /rerenderFormPreservingValues/);
	assert.match(source, /updates the available choices without clearing current values/);
});

test('opening a record refetches picklists when Salesforce reveals a different record type', () => {
	assert.match(source, /const hasExplicitRecordTypeId = !!\(draftRt \|\| savedRt\)/);
	assert.match(source, /layout && layout\.recordTypeId && !hasExplicitRecordTypeId/);
	assert.match(source, /layout\.picklistValuesRecordTypeId !== currentRecordTypeId/);
	assert.match(source, /picklistLayout = await fetchEditLayout/);
});

test('an inaccessible current record type stays visible but cannot be newly selected', () => {
	const choices = retainCurrentRecordType([{ id: '012AVAILABLE', name: 'Available', available: true }], '012CURRENT');
	assert.equal(choices[0].id, '012CURRENT');
	assert.equal(choices[0].available, false);
	assert.match(choices[0].label, /current Salesforce value/);
	assert.equal(retainCurrentRecordType(choices, '012CURRENT').length, 2);
	assert.match(source, /hasLoadedSalesforceRecord \? currentRecordTypeId : null/);
});

test('dependent picklists discard values that do not apply to the selected controller value', () => {
	const field = {
		type: 'picklist',
		controllerName: 'Country__c',
		restrictedPicklist: true,
		picklistValuesByRecordType: {
			'012TYPE': [
				{ value: 'Arizona', validFor: [0] },
				{ value: 'Ontario', validFor: [1] },
			],
		},
		controllerValuesByRecordType: { '012TYPE': { USA: 0, Canada: 1 } },
	};
	assert.deepEqual(
		{ ...picklistSelectionForContext(field, '012TYPE', 'Canada', 'Arizona') },
		{ known: true, value: null },
	);
	assert.deepEqual(
		{ ...picklistSelectionForContext(field, '012TYPE', 'Canada', 'Ontario') },
		{ known: true, value: 'Ontario' },
	);
	assert.deepEqual(
		{ ...picklistSelectionForContext(field, '012TYPE', 'Canada', 'Arizona', false) },
		{ known: false, value: 'Arizona' },
	);
});

test('polymorphic references infer their target from the Salesforce ID prefix', () => {
	const objects = [
		{ name: 'Contact', keyPrefix: '003' },
		{ name: 'Lead', keyPrefix: '00Q' },
	];
	assert.equal(inferReferenceTarget(['Contact', 'Lead'], '003000000000001AAA', objects), 'Contact');
	assert.equal(inferReferenceTarget(['Contact', 'Lead'], '00Q000000000001AAA', objects), 'Lead');
	assert.equal(inferReferenceTarget(['Contact', 'Lead'], '001000000000001AAA', objects), null);
	assert.equal(inferReferenceTarget(['Account'], '', objects), 'Account');
	assert.match(source, /class="lookup-target"/);
	assert.match(source, /targetApiName=/);
	assert.match(source, /referenceTargets\.length === 1 \? referenceTargets\[0\] : ''/);
});

test('polymorphic reference values come from the selected Salesforce record, not the type dropdown', () => {
	const typeControl = { value: 'User' };
	const idControl = { value: '005000000000001AAA' };
	const field = {
		querySelector(selector) {
			if (selector === '.lookup-picker input[type="hidden"]') {
				return idControl;
			}
			return typeControl;
		},
	};
	assert.equal(editorFieldValueControl(field, 'reference'), idControl);
	assert.equal(editorFieldValueControl(field, 'picklist'), typeControl);
});

test('legacy picklist values stay visible without becoming normal selectable options', () => {
	const options = retainCurrentPicklistValues(
		[{ value: 'Current', label: 'Current', active: true }],
		'Legacy',
		'picklist',
		'Legacy',
	);
	assert.equal(options.length, 2);
	assert.equal(options[0].value, 'Legacy');
	assert.equal(options[0].retainedCurrent, true);
	assert.equal(options[0].label, 'Legacy (current value)');
	assert.doesNotMatch(options[0].label, /Salesforce/);
	assert.equal(retainCurrentPicklistValues(options, 'Legacy', 'picklist', 'Legacy').length, 2);
	assert.deepEqual(Array.from(retainCurrentPicklistValues([], 'Transient', 'picklist', 'Legacy')), []);

	const multi = retainCurrentPicklistValues([], 'Legacy A;Transient', 'multipicklist', 'Legacy A;Legacy B');
	assert.deepEqual(
		Array.from(multi, (value) => value.value),
		['Legacy A'],
	);
	assert.equal(multi[0].label, 'Legacy A (current value)');
});

test('Salesforce picklists remain dropdowns while true combobox fields accept custom values', () => {
	assert.equal(supportsCustomPicklistValue({ type: 'combobox' }), true);
	assert.equal(supportsCustomPicklistValue({ type: 'picklist', restrictedPicklist: false }), false);
	assert.equal(supportsCustomPicklistValue({ type: 'multipicklist', restrictedPicklist: false }), false);
	assert.equal(supportsCustomPicklistValue({ type: 'picklist', restrictedPicklist: true }), false);
	assert.equal(formInputValue('picklist', ''), null);
	assert.equal(formInputValue('multipicklist', ' One ; Two; '), 'One;Two');
	assert.match(source, /class="picklist-combobox"/);
	assert.match(source, /<form id="insert-form" autocomplete="off">/);
});

test('saving an existing record writes only fields intentionally touched in the editor', () => {
	assert.deepEqual(
		Array.from(intentionalChangedFieldNames(['Description', 'Status__c'], new Set(['Description']), true)),
		['Description'],
	);
	assert.deepEqual(
		Array.from(intentionalChangedFieldNames(['Description', 'Status__c'], new Set(['Description']), false)),
		['Description', 'Status__c'],
	);
	assert.match(source, /editorTouchedFields/);
	assert.match(source, /intentionalChangedFieldNames\(/);
	assert.match(source, /currentRecordRef\.values = mergeSubmittedFieldValues/);
});

test('untouched loaded fields cannot block an unrelated edit', () => {
	const touched = new Set(['Description']);
	assert.equal(shouldValidateEditorField('Description', touched, true), true);
	assert.equal(shouldValidateEditorField('Legacy_Email__c', touched, true), false);
	assert.equal(shouldValidateEditorField('Legacy_Email__c', touched, false), true);

	const controls = [
		{
			closest: () => ({ dataset: { field: 'Legacy_Email__c' } }),
			checkValidity: () => false,
		},
		{
			closest: () => ({ dataset: { field: 'Description' } }),
			checkValidity: () => true,
		},
	];
	const form = { querySelectorAll: () => controls };
	assert.equal(firstInvalidEditorControl(form, touched, true), null);
	assert.equal(firstInvalidEditorControl(form, touched, false), controls[0]);
	const touchedInvalidControl = {
		closest: () => ({ dataset: { field: 'Description' } }),
		checkValidity: () => false,
	};
	assert.equal(
		firstInvalidEditorControl({ querySelectorAll: () => [touchedInvalidControl] }, touched, true),
		touchedInvalidControl,
	);
	assert.match(source, /firstInvalidEditorControl\(form, editorTouchedFields, existingRecord\)/);
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
	assert.match(source, /if \(!recordId && result\.available\) \{\s*layoutCache\[key\] = result;/);
	assert.match(source, /if \(!recordId && layoutCache\[key\]\)/);
	assert.doesNotMatch(source, /layoutCache\[key\] = \{ sections: \[\], available: false \}/);
});
