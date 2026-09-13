import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/public/js/insert-modal.js', import.meta.url), 'utf8');
const preflight = fs.readFileSync(new URL('../src/public/js/preflight.js', import.meta.url), 'utf8');

function setup() {
	const values = { LastName: '', Email: 'bad', Phone: '123' };
	const record = { id: 1, objectName: 'Contact', values: { ...values } };
	const fields = ['LastName', 'Email', 'Phone'].map((name) => ({
		dataset: { field: name, type: name === 'Email' ? 'email' : 'string' },
		control: {
			valid: true,
			checkValidity() {
				return this.valid;
			},
		},
	}));
	for (const field of fields) {
		field.control.closest = () => field;
	}
	const queue = [];
	const focused = [];
	const env = {
		window: { OrgLoom: {} },
		uploadFixFields: ['LastName', 'Email'],
		guidedAdvanceTimer: null,
		guidedTouchedFields: new Set(),
		guidedCompletedFields: new Set(),
		currentEncryptedFormValues: new Map(),
		currentFields: fields.map((field) => ({
			name: field.dataset.field,
			type: field.dataset.type,
			createable: true,
			required: field.dataset.field === 'LastName',
		})),
		canvasState: { currentRecordRef: record, bulkAssociations: [], describeCache: { Contact: {} } },
		collectFormValues: () => ({ ...values }),
		_fieldHasUnsavedChange: (name) => values[name] !== record.values[name],
		_guidedRequestedFieldNames: () => env.uploadFixFields,
		_guidedFieldControl: (field) => field.control,
		focusTaskField: (name) => focused.push(name),
		document: { activeElement: fields[0].control },
		modal: { classList: { contains: () => false }, querySelectorAll: () => fields },
		setTimeout: (fn) => {
			queue.push(fn);
			return queue.length;
		},
		clearTimeout: () => {},
	};
	vm.runInNewContext(preflight, env);
	const readyStart = source.indexOf('function _uploadFixFieldReady(');
	vm.runInNewContext(source.slice(readyStart, source.indexOf('function _fieldHasUnsavedChange(', readyStart)), env);
	const advanceStart = source.indexOf('function _nextIncompleteGuidedField(');
	vm.runInNewContext(source.slice(advanceStart, source.indexOf('function openInsertModal(', advanceStart)), env);
	return {
		env,
		values,
		record,
		fields,
		focused,
		flush: () => {
			while (queue.length) {
				queue.shift()();
			}
		},
	};
}

test('a committed valid fix advances to the next field on the same record without saving data', () => {
	const e = setup();
	e.values.LastName = 'Fixed';
	assert.equal(e.env._updateGuidedFieldCompletion(e.fields[0]), true);
	assert.equal(e.focused.length, 0, 'input completion alone does not advance');
	e.env._scheduleGuidedAdvance('LastName', e.fields[0].control, true);
	e.flush();
	assert.deepEqual(e.focused, ['Email']);
	assert.equal(e.record.values.LastName, '', 'guidance must not save an unfinished draft');
});

test('an invalid correction cannot advance; clearing an optional invalid value can', () => {
	const e = setup();
	e.values.Email = 'still-invalid';
	assert.equal(e.env._updateGuidedFieldCompletion(e.fields[1]), false);
	e.values.Email = '';
	assert.equal(e.env._updateGuidedFieldCompletion(e.fields[1]), true);
	e.values.Email = 'invalid-again';
	assert.equal(e.env._updateGuidedFieldCompletion(e.fields[1]), false);
	assert.equal(e.env.guidedCompletedFields.has('Email'), false);
});

test('read-only fields, unavailable metadata, and browser-invalid inputs do not advance', () => {
	const e = setup();
	e.values.LastName = 'Fixed';
	e.fields[0].dataset.readonly = 'true';
	assert.equal(e.env._updateGuidedFieldCompletion(e.fields[0]), false);
	delete e.fields[0].dataset.readonly;
	e.fields[0].control.valid = false;
	assert.equal(e.env._updateGuidedFieldCompletion(e.fields[0]), false);
	e.fields[0].control.valid = true;
	e.env.currentFields = [];
	assert.equal(e.env._updateGuidedFieldCompletion(e.fields[0]), false);
});

test('manual navigation to another field wins over scheduled focus', () => {
	const e = setup();
	e.values.LastName = 'Fixed';
	e.env._updateGuidedFieldCompletion(e.fields[0]);
	e.env._scheduleGuidedAdvance('LastName', e.fields[0].control, true);
	e.env.document.activeElement = e.fields[2].control;
	e.flush();
	assert.deepEqual(e.focused, []);
});

test('finishing the final field or closing the editor never opens another record', () => {
	const e = setup();
	e.values.LastName = 'Fixed';
	e.values.Email = 'fixed@example.invalid';
	for (const field of e.fields.slice(0, 2)) {
		e.env._updateGuidedFieldCompletion(field);
	}
	e.env.document.activeElement = e.fields[1].control;
	e.env._scheduleGuidedAdvance('Email', e.fields[1].control, true);
	e.flush();
	assert.deepEqual(e.focused, []);
	e.env.guidedCompletedFields.delete('LastName');
	e.env.modal.classList.contains = () => true;
	e.env._scheduleGuidedAdvance('Email', e.fields[1].control, true);
	e.flush();
	assert.deepEqual(e.focused, []);
});

test('opening and closing editors resets upload guidance; change events retain shared-task advancement', () => {
	assert.match(source, /uploadFixFields = Array\.isArray\(opts\.uploadFixFields\)/);
	assert.match(source, /function closeModal\(\)\s*{\s*uploadFixFields = \[\]/);
	assert.match(source, /form\.addEventListener\('change',[\s\S]*if \(guidedComplete\) \{\s*_scheduleGuidedAdvance/);
});
