import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../src/public/js/linked-csv.js'), 'utf8');
const cssSource = fs.readFileSync(path.resolve(here, '../src/public/css/app.css'), 'utf8');
const window = {};
vm.runInNewContext(source, { window, Set, Map });
const policy = window.OrgLoom.linkedCsv._test;

test('CSV importer close control keeps a usable hit target', () => {
	assert.match(source, /<button type="button" class="modal-close" data-lcsv-close aria-label="Close importer">/);
	assert.doesNotMatch(cssSource, /\.lcsv-is-preparing \[data-lcsv-close\]/);
	assert.match(
		cssSource,
		/#linked-csv-modal \.modal-header \.modal-close\s*\{[^}]*width: 2rem;[^}]*height: 2rem;[^}]*line-height: 1;/s,
	);
});

test('CSV import preflight can be canceled before canvas mutation', () => {
	const activeState = { importing: true };
	assert.equal(policy.csvImportCanceled(activeState, activeState), false);
	activeState.cancelRequested = true;
	assert.equal(policy.csvImportCanceled(activeState, activeState), true);
	assert.equal(policy.csvImportCanceled({ importing: true }, activeState), true);
	assert.match(source, /linkedCsvState\.cancelRequested = true/);
	assert.match(source, /addEventListener\('click', \(\) => closeLinkedCsvModal\(\)\)/);
	assert.match(source, /if \(csvImportCanceled\(state, linkedCsvState\)\) \{\s*return;\s*\}\s*if \(shouldReplace\)/s);
});

test('CSV field policy uses create access for new rows and edit access for existing rows', () => {
	const createOnly = { createable: true, updateable: false };
	const updateOnly = { createable: false, updateable: true };

	assert.equal(policy.csvFieldDisposition(createOnly, 'create'), 'write');
	assert.equal(policy.csvFieldDisposition(createOnly, 'update'), 'context');
	assert.equal(policy.csvFieldDisposition(updateOnly, 'create'), 'warn');
	assert.equal(policy.csvFieldDisposition(updateOnly, 'update'), 'write');
});

test('read-only Salesforce output fields remain context without producing a write warning', () => {
	assert.equal(
		policy.csvFieldDisposition({ calculated: true, createable: false, updateable: false }, 'create'),
		'context',
	);
	assert.equal(
		policy.csvFieldDisposition({ autoNumber: true, createable: false, updateable: false }, 'create'),
		'context',
	);
	assert.equal(
		policy.csvFieldDisposition({ type: 'address', createable: false, updateable: false }, 'update'),
		'context',
	);
});

test('upsert accepts a field writable on either branch and warns when neither branch can write it', () => {
	assert.equal(policy.csvFieldDisposition({ createable: true, updateable: false }, 'upsert'), 'write');
	assert.equal(policy.csvFieldDisposition({ createable: false, updateable: true }, 'upsert'), 'write');
	assert.equal(policy.csvFieldDisposition({ createable: false, updateable: false }, 'upsert'), 'warn');
});

test('resolved Salesforce Ids classify as updates while missing Ids remain creates', () => {
	const idResolution = { liveById: new Map([['001000000000001', {}]]) };
	assert.equal(policy.csvRowOperation({ operation: 'insert' }, '001000000000001AAA', idResolution), 'update');
	assert.equal(policy.csvRowOperation({ operation: 'insert' }, '001000000000002AAA', idResolution), 'create');
	assert.equal(policy.csvRowOperation({ operation: 'insert' }, '', idResolution), 'create');
	assert.equal(policy.csvRowOperation({ operation: 'upsert' }, '001000000000001AAA', idResolution), 'upsert');
});

test('the Id mapping is presented as a field instead of a separate match operation', () => {
	assert.equal(policy.csvFieldOptionLabel({ name: 'Id', label: 'Account ID' }), 'Salesforce ID');
	assert.equal(policy.csvFieldOptionLabel({ name: 'Name', label: 'Account Name' }), 'Account Name');
	assert.doesNotMatch(source, /match & UPDATE existing record/i);
	assert.doesNotMatch(source, /fieldOpts\.unshift/);
});

test('mapping choices describe field access without assuming every row is a create', () => {
	assert.equal(policy.csvFieldAccessSuffix({ name: 'Name', createable: true, updateable: true }), '');
	assert.equal(
		policy.csvFieldAccessSuffix({ name: 'Formula__c', createable: false, updateable: false }),
		' - read only',
	);
	assert.equal(
		policy.csvFieldAccessSuffix({ name: 'Create_Only__c', createable: true, updateable: false }),
		' - new records only',
	);
	assert.equal(
		policy.csvFieldAccessSuffix({ name: 'Update_Only__c', createable: false, updateable: true }),
		' - existing records only',
	);
});

test('direct Salesforce fields have only one CSV source column', () => {
	const duplicateFile = {
		headers: ['Account Name', 'Alternate Name', 'Phone'],
		mapping: { 0: 'Name', 1: 'Name', 2: 'Phone' },
	};
	assert.deepEqual(JSON.parse(JSON.stringify(policy.duplicateDirectFieldMappings(duplicateFile))), [
		{
			fieldName: 'Name',
			columnIdxs: [0, 1],
			headers: ['Account Name', 'Alternate Name'],
		},
	]);
	assert.deepEqual(JSON.parse(JSON.stringify(policy.uniqueDirectFieldMapping(duplicateFile.mapping))), {
		0: 'Name',
		2: 'Phone',
	});
	assert.match(source, /already mapped from/);
	assert.match(source, /mappedElsewhere \? ' disabled' : ''/);
	assert.match(source, /Choose one source column/);
});

test('duplicate file-name warning reflects the current file list', () => {
	const state = {
		files: [{ name: 'Case.csv' }, { name: 'Case.csv' }, { name: 'Contact.csv' }],
		notices: [{ kind: 'error', code: 'other', text: 'Keep me' }],
	};
	policy.syncDuplicateFileNameNotice(state);
	assert.equal(state.notices.length, 2);
	assert.match(state.notices[1].text, /Two or more files share the name "Case\.csv"/);
	assert.equal(state.notices[1].code, 'duplicate-file-name');

	state.files.splice(1, 1);
	policy.syncDuplicateFileNameNotice(state);
	assert.deepEqual(JSON.parse(JSON.stringify(state.notices)), [{ kind: 'error', code: 'other', text: 'Keep me' }]);
});

test('direct lookup values accept only Salesforce IDs', () => {
	assert.equal(policy.isSalesforceId('001000000000001'), true);
	assert.equal(policy.isSalesforceId('001000000000001AAA'), true);
	assert.equal(policy.isSalesforceId(' 001000000000001AAA '), true);
	assert.equal(policy.isSalesforceId('person@example.com'), false);
	assert.equal(policy.isSalesforceId('001000000000001AAA,person@example.com'), false);
});

test('external lookup keys remain free-text fields rather than canvas relationship sources', () => {
	assert.equal(
		policy.isExternalKeyReferenceField({
			type: 'reference',
			referenceTargetField: 'ExternalId__c',
			referenceTo: ['Order__x'],
		}),
		true,
	);
	assert.equal(policy.isExternalKeyReferenceField({ type: 'reference', referenceTo: ['Account'] }), false);
});

test('CSV import has no relationship matching or association creation', () => {
	assert.doesNotMatch(
		source,
		/__relationship_key__|data-lcsv-link|Cross-file matching|autoSelectRelationshipColumns/,
	);
	assert.doesNotMatch(source, /bulkAssociations\.push|state\.links/);
});

test('lookup errors and duplicate field mappings keep CSV actions disabled', () => {
	const file = {
		objectName: 'Contact',
		headers: ['LastName', 'AccountId'],
		rows: [['Person', 'Acme']],
		mapping: { 0: 'LastName', 1: 'AccountId' },
	};
	assert.equal(policy.linkedCsvReady({ files: [{ ...file, lookupErrors: [{}] }] }), false);
	assert.equal(policy.linkedCsvReady({ files: [{ ...file, mapping: { 0: 'LastName', 1: 'LastName' } }] }), false);
	assert.equal(policy.linkedCsvReady({ files: [{ ...file, rows: [['Person', '001000000000001AAA']] }] }), true);
});

test('an unmapped matching key does not block loading record values', () => {
	const file = {
		objectName: 'Contact',
		headers: ['LastName', 'AccountKey'],
		rows: [['Person', 'Unknown company']],
		mapping: { 0: 'LastName' },
	};
	assert.equal(policy.linkedCsvReady({ files: [file] }), true);
});
