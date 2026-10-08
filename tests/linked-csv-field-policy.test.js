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

test('relationship semantics recognize labels and custom-object API names independently', () => {
	assert.equal(
		policy.relationshipSemanticBonus(
			'ProjectNameKey',
			{ name: 'Project__c', label: 'Project', relationshipName: 'Milestones' },
			'OLQA_Project__c',
			'Project',
		),
		6,
	);
	assert.equal(
		policy.relationshipSemanticBonus(
			'ProjectNameKey',
			{ name: 'Project__c', relationshipName: 'Milestones' },
			'OLQA_Project__c',
			null,
		),
		6,
	);
	assert.equal(
		policy.relationshipSemanticBonus(
			'UnrelatedKey',
			{ name: 'Project__c', label: 'Project', relationshipName: 'Milestones' },
			'OLQA_Project__c',
			'Project',
		),
		0,
	);
	assert.equal(
		policy.relationshipSemanticBonus(
			'ReportsToEmailKey',
			{ name: 'ReportsToId', label: 'Reports To', relationshipName: 'ReportsTo' },
			'Contact',
			'Contact',
		),
		4,
	);
});

test('relationship keys are configured separately from direct Salesforce field mappings', () => {
	assert.doesNotMatch(source, /Relationship keys \(not uploaded\)/);
	assert.doesNotMatch(source, /__relationship__:/);
	assert.doesNotMatch(source, /Salesforce lookup fields take Salesforce IDs/);
	assert.doesNotMatch(source, /lcsv-lookup-guidance/);
	assert.match(source, /not Salesforce IDs/);
	assert.doesNotMatch(source, /Add relationship/);
	assert.match(source, /Match to a related record in another CSV - not uploaded/);
	assert.match(source, /__relationship_key__/);
	assert.match(source, /autoSelectRelationshipColumns/);
	assert.match(source, /relationshipChoices\[fromColumnIdx\] === 'declined'/);
	assert.match(source, /<details class="lcsv-cols" data-lcsv-cols=/);
	assert.match(source, /file\.columnsOpen \? ' open' : ''/);
	assert.match(source, /state\.files\[fileIdx\]\.columnsOpen = details\.open/);
	assert.doesNotMatch(source, /openByDefault/);
	assert.doesNotMatch(source, /<label>Source file/);
	assert.doesNotMatch(source, /<label>Source key/);
	assert.doesNotMatch(source, /<label>Lookup to populate/);
	assert.doesNotMatch(source, /<label>Target file/);
	assert.doesNotMatch(source, /<label>Target key/);
	assert.doesNotMatch(source, />Value comes from</);
	assert.doesNotMatch(source, />Find the related record in</);
	assert.doesNotMatch(source, />Find the related record by</);
	assert.doesNotMatch(source, /For each/);
	assert.match(source, /class="lcsv-link-key-head"/);
	assert.doesNotMatch(source, /Relationship column · not uploaded/);
	assert.match(source, /class="lcsv-link-key-help"/);
	assert.match(source, /uses this CSV column as a reference/);
	assert.match(source, /The column itself is not uploaded/);
	assert.match(source, /Populate:<\/span>/);
	assert.match(source, /relationshipControl/);
	assert.match(source, /Match against:<\/span><select/);
	assert.match(source, /class="lcsv-link-flow-arrow"/);
	assert.match(source, /class="lcsv-link-set-control"/);
	assert.ok(source.indexOf('Match against:</span>') < source.indexOf('Populate:</span>'));
	assert.match(source, /data-lcsv-link-field/);
	assert.match(source, /data-lcsv-link-target/);
	assert.doesNotMatch(source, /data-lcsv-link-source/);
	assert.match(source, /aria-label="Relationship to set"/);
	assert.match(source, /aria-label="Matching target CSV value"/);
	assert.doesNotMatch(source, /aria-label="Source CSV value"/);
	assert.match(source, /shouldSelectRelationshipField/);
	assert.match(source, /nextField\.referenceTo\.includes\(targetFile\.objectName\)/);
	assert.doesNotMatch(source, / whose:<\/span><strong>/);
	assert.doesNotMatch(source, /matches:<\/span><strong>/);
	assert.doesNotMatch(source, /relationshipFieldReference/);
	assert.match(source, /class="lcsv-link-reference"/);
	assert.doesNotMatch(source, /lcsv-link-samples/);
	assert.doesNotMatch(source, /Sample matched values:/);
	assert.doesNotMatch(source, /Complete this relationship mapping\./);
	assert.doesNotMatch(source, />Suggested<\/span>/);
	assert.match(source, /class="lcsv-link-group"/);
	assert.match(source, /data-lcsv-relationship-file/);
	assert.match(source, /class="lcsv-link-group-head"/);
	assert.match(source, /fileGroupCount/);
	assert.doesNotMatch(source, /Change target matching/);
	assert.doesNotMatch(source, /data-lcsv-link-advanced/);
	assert.doesNotMatch(source, /data-lcsv-link-edit/);
	assert.doesNotMatch(source, /data-lcsv-link-done/);
	assert.match(source, /Match to a related record in another CSV - not uploaded/);
	assert.doesNotMatch(source, /Matched against/);
	assert.doesNotMatch(source, /first matching target file wins/);
});

test('lookup and relationship mapping errors keep CSV actions disabled', () => {
	const validFile = {
		objectName: 'Case',
		headers: ['Subject'],
		rows: [['Test']],
		mapping: { 0: 'Subject' },
		blockingErrors: [],
	};
	assert.equal(policy.linkedCsvReady({ files: [{ ...validFile, lookupErrors: [{}] }] }), false);
	assert.equal(policy.linkedCsvReady({ files: [{ ...validFile, relationshipErrors: [{}] }] }), false);
	assert.equal(
		policy.linkedCsvReady({
			files: [{ ...validFile, headers: ['Subject', 'Other subject'], mapping: { 0: 'Subject', 1: 'Subject' } }],
		}),
		false,
	);
	assert.equal(
		policy.linkedCsvReady({
			files: [validFile],
			links: [
				{
					fromFileIdx: 0,
					fromColumnIdx: 0,
					fromField: 'AccountId',
					toFileIdx: 1,
					toColumnIdx: null,
				},
			],
		}),
		false,
	);
	assert.equal(
		policy.linkedCsvReady({
			files: [validFile],
			links: [{ fromFileIdx: 0, fromColumnIdx: 0, fromField: null, toFileIdx: 0, toColumnIdx: 0 }],
		}),
		false,
	);
	assert.equal(
		policy.linkedCsvReady({
			files: [validFile],
			links: [
				{
					fromFileIdx: 0,
					fromColumnIdx: 0,
					fromField: 'AccountId',
					toFileIdx: 0,
					toColumnIdx: 0,
					unmatched: 1,
					ambiguous: 0,
					duplicateTargetKeys: [],
				},
			],
		}),
		false,
	);
	assert.equal(
		policy.linkedCsvReady({
			files: [validFile],
			links: [
				{
					fromFileIdx: 0,
					fromColumnIdx: 0,
					fromField: 'AccountId',
					toFileIdx: 0,
					toColumnIdx: 0,
					unmatched: 0,
					ambiguous: 0,
					duplicateTargetKeys: [{ value: 'Acme' }],
				},
			],
		}),
		false,
	);
});

test('relationship resolution requires exactly one target row for every nonblank source key', () => {
	const result = policy.resolveRelationshipRows(
		[[' Acme '], ['Global'], ['Missing'], ['acme'], ['']],
		0,
		[['Acme'], ['Global'], ['Global'], ['Unused'], ['Unused'], ['']],
		0,
	);

	assert.deepEqual(JSON.parse(JSON.stringify(result.matches)), [{ fromRowIdx: 0, toRowIdx: 0, value: 'Acme' }]);
	assert.deepEqual(JSON.parse(JSON.stringify(result.unmatchedRows)), [
		{ fromRowIdx: 2, value: 'Missing' },
		{ fromRowIdx: 3, value: 'acme' },
	]);
	assert.deepEqual(JSON.parse(JSON.stringify(result.ambiguousRows)), [
		{ fromRowIdx: 1, value: 'Global', toRowIdxs: [1, 2] },
	]);
	assert.deepEqual(JSON.parse(JSON.stringify(result.duplicateTargetKeys)), [
		{ value: 'Global', toRowIdxs: [1, 2], fromRowIdxs: [1] },
		{ value: 'Unused', toRowIdxs: [3, 4], fromRowIdxs: [] },
	]);
	assert.equal(result.sourceRowCount, 4);

	const withoutConflictingRow = policy.resolveRelationshipRows(
		[['Acme'], ['Missing']],
		0,
		[['Acme']],
		0,
		new Set([1]),
	);
	assert.equal(withoutConflictingRow.sourceRowCount, 1);
	assert.equal(withoutConflictingRow.matches.length, 1);
	assert.equal(withoutConflictingRow.unmatchedRows.length, 0);
});

test('mixed direct and virtual relationship sources are identified by lookup field', () => {
	const state = {
		files: [
			{
				headers: ['AccountId', 'AccountNameKey'],
				mapping: { 0: 'AccountId' },
			},
		],
		links: [{ fromFileIdx: 0, fromColumnIdx: 1, fromField: 'AccountId' }],
	};

	assert.equal(
		JSON.stringify(policy.mixedRelationshipSources(state, 0)),
		JSON.stringify([
			{
				fieldName: 'AccountId',
				directHeader: 'AccountId',
				relationshipHeader: 'AccountNameKey',
			},
		]),
	);
	assert.match(source, /Use one method per row/);
	assert.match(source, /Leave the unused column blank/);
	assert.doesNotMatch(source, /mixedSourceGuidanceHtml/);
	assert.match(source, /relationshipHelpText/);
	assert.match(source, /Edit the CSV so/);
	assert.match(source, /only one, then re-import/);
	assert.match(source, /relationship values matched/);
	assert.doesNotMatch(source, /matched uniquely/);
	assert.match(source, /is not unique/);
	assert.match(source, /no matching target/);
	assert.equal((source.match(/resolveRelationshipRows\(/g) || []).length, 3);
	assert.match(source, /resolution\.matches\.forEach/);
	assert.doesNotMatch(source, /rows found a related record/);
	assert.doesNotMatch(source, /Import affected rows unlinked/);
});

test('relationship destination is selectable when two writable lookups target the same object', () => {
	const selectedLink = { fromField: 'AccountId' };
	assert.equal(policy.shouldSelectRelationshipField(selectedLink, [{ name: 'AccountId' }]), false);
	assert.equal(
		policy.shouldSelectRelationshipField(selectedLink, [
			{ name: 'AccountId' },
			{ name: 'OLQA_Secondary_Account__c' },
		]),
		true,
	);
	assert.equal(policy.shouldSelectRelationshipField({ fromField: null }, [{ name: 'AccountId' }]), true);
});

test('matching targets are available before a relationship field is chosen', () => {
	const files = [{ objectName: 'Account' }, { objectName: 'Contact' }, { objectName: 'Case' }];
	const fields = [
		{ name: 'AccountId', referenceTo: ['Account'] },
		{ name: 'ContactId', referenceTo: ['Contact'] },
	];

	assert.deepEqual(Array.from(policy.compatibleTargetFileIndexes(files, fields)), [0, 1]);
	assert.deepEqual(Array.from(policy.compatibleTargetFileIndexes(files, [fields[0]])), [0]);
});

test('import-only relationship keys are not offered as relationship match targets', () => {
	const file = {
		headers: ['Seed_Key__c', 'ParentWorkItemSeedKey', 'ExplicitBusinessKey'],
		mapping: { 0: 'Seed_Key__c', 2: 'Business_Key__c' },
		relationshipChoices: { 1: 'relationship' },
	};

	assert.equal(policy.relationshipMatchTargetColumn(file, 0), true);
	assert.equal(policy.relationshipMatchTargetColumn(file, 1), false);
	assert.equal(policy.relationshipMatchTargetColumn(file, 2), true);
	assert.equal(
		policy.relationshipMatchTargetColumn(
			{ headers: ['UnmappedRelationshipKey'], mapping: {}, relationshipChoices: {} },
			0,
		),
		false,
	);
	assert.match(source, /!relationshipMatchTargetColumn\(toFile, i\)/);
	assert.match(source, /relationshipMatchTargetColumn\(\s*state\.files\[toFileIdx\],\s*entry\.columnIdx,?\s*\)/);
});

test('a virtual lookup selected by one relationship is unavailable to another relationship', () => {
	const state = {
		links: [
			{ fromFileIdx: 0, fromField: 'AccountId' },
			{ fromFileIdx: 0, fromField: null },
			{ fromFileIdx: 1, fromField: 'AccountId' },
		],
	};

	assert.equal(policy.relationshipFieldAvailableForLink(state, 1, 0, 'AccountId'), false);
	assert.equal(policy.relationshipFieldAvailableForLink(state, 1, 0, 'Secondary_Account__c'), true);
	assert.equal(policy.relationshipFieldAvailableForLink(state, 2, 1, 'AccountId'), true);
	assert.match(source, /const usedFields = new Set/);
	assert.match(source, /field: compatibleFields\.length === 1 \? compatibleFields\[0\] : null/);
	assert.match(source, /\.\.\.compatibleFields\.map\(\(field\) =>\s*relationshipSemanticBonus/);
	assert.match(source, /shouldSelectRelationshipField\(\s*link,\s*compatibleRelationshipFields/);
});
