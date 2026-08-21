import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/public/js/migrate-match.js', import.meta.url), 'utf8');
const cssSource = readFileSync(new URL('../src/public/css/app.css', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/public/js/app.js', import.meta.url), 'utf8');
const uploadSource = readFileSync(new URL('../src/public/js/upload-modal.js', import.meta.url), 'utf8');
const sandbox = { window: { OrgLoom: {} } };
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const match = sandbox.window.OrgLoom.migrateMatch._test;

function candidate(id, label) {
	return { id, label: label || id, lastModifiedDate: null };
}

describe('cross-org match resolution', () => {
	test('only Salesforce-filterable fields are offered as match keys', () => {
		const candidates = match.keyCandidates({
			fields: [
				{ name: 'LastName', label: 'Last Name', type: 'string', filterable: true, nameField: true },
				{ name: 'Description', label: 'Description', type: 'textarea', filterable: false },
				{ name: 'LegacyField', label: 'Legacy field', type: 'string' },
			],
		});

		assert.deepEqual(
			Array.from(candidates, (field) => field.name),
			['LastName'],
		);
	});

	test('records of the same object can select different identifying fields', () => {
		const describe = {
			fields: [
				{ name: 'External_Key__c', label: 'External key', type: 'string', filterable: true, externalId: true },
				{ name: 'Name', label: 'Account name', type: 'string', filterable: true, nameField: true },
			],
		};
		const withExternalId = { values: { External_Key__c: 'EXT-1', Name: 'Acme' } };
		const withNameOnly = { values: { Name: 'Beta' } };

		assert.equal(match.preferredKeyCandidate(describe, withExternalId).name, 'External_Key__c');
		assert.equal(match.preferredKeyCandidate(describe, withNameOnly).name, 'Name');
	});

	test('a single source and destination match is applied automatically', () => {
		const rec = { id: 1, objectName: 'Account', values: { Name: 'Acme' } };
		const result = match.applyMatchResponse([rec], 'Name', {
			candidatesByValue: { Acme: [candidate('001TARGET', 'Acme')] },
		});

		assert.equal(result.matched, 1);
		assert.equal(result.unresolved, 0);
		assert.equal(rec.loadedFromId, '001TARGET');
		assert.equal(rec._migrateMatchResolution, 'automatic');
		assert.equal(rec._migrateMatchCandidates.length, 1);
		assert.equal(rec._migrateMatchCandidates[0].id, '001TARGET');
		assert.equal(rec._migrateMatchCandidates[0].matchField, 'Name');
		assert.equal(rec._migrateMatchCandidates[0].matchValue, 'Acme');
	});

	test('an automatic match remains reversible during review', () => {
		const rec = { id: 1, objectName: 'Account', values: { Name: 'Acme' } };
		match.applyMatchResponse([rec], 'Name', {
			candidatesByValue: { Acme: [candidate('001TARGET', 'Acme')] },
		});

		assert.equal(match.resolveRecord(rec, 'new', [rec]).ok, true);
		assert.equal(rec.loadedFromId, undefined);
		assert.equal(rec._migrateMatchResolution, 'new');
		assert.equal(match.resolveRecord(rec, '001TARGET', [rec]).ok, true);
		assert.equal(rec.loadedFromId, '001TARGET');
		assert.equal(rec._migrateMatchResolution, 'existing');
	});

	test('the selected match field persists when no destination record matches', () => {
		const rec = { id: 1, objectName: 'Account', values: { Name: 'No destination row' } };
		const result = match.applyMatchResponse([rec], 'Name', { candidatesByValue: {} });

		assert.equal(result.matched, 0);
		assert.equal(result.unresolved, 0);
		assert.equal(rec._migrateMatchKey, 'Name');
		assert.equal(rec._migrateMatchValue, 'No destination row');
		assert.equal(rec.loadedFromId, undefined);
	});

	test('multiple destination matches require an explicit candidate choice', () => {
		const rec = { id: 1, objectName: 'Account', values: { Name: 'Acme' } };
		const all = [rec];
		const result = match.applyMatchResponse(all, 'Name', {
			candidatesByValue: {
				Acme: [candidate('001A', 'Acme East'), candidate('001B', 'Acme West')],
			},
		});

		assert.equal(result.matched, 0);
		assert.equal(result.unresolved, 1);
		assert.equal(rec.loadedFromId, undefined);
		assert.equal(rec._migrateMatchAmbiguous, true);
		assert.equal(rec._migrateMatchResolution, undefined);

		assert.equal(match.resolveRecord(rec, '001B', all).ok, true);
		assert.equal(rec.loadedFromId, '001B');
		assert.equal(rec._migrateMatchResolution, 'existing');
		assert.equal(rec._migrateMatchIntent, 'existing');
	});

	test('choosing update is a separate incomplete decision until a destination is selected', () => {
		const rec = { id: 1, objectName: 'Account', values: { Name: 'Acme' } };
		match.applyMatchResponse([rec], 'Name', {
			candidatesByValue: {
				Acme: [candidate('001A', 'Acme East'), candidate('001B', 'Acme West')],
			},
		});

		const result = match.resolveRecord(rec, 'update', [rec]);
		assert.equal(result.ok, true);
		assert.equal(result.pending, true);
		assert.equal(rec._migrateMatchIntent, 'existing');
		assert.equal(rec._migrateMatchResolution, undefined);
		assert.equal(rec.loadedFromId, undefined);
	});

	test('create as new is an explicit resolution and leaves loadedFromId empty', () => {
		const rec = { id: 1, objectName: 'Contact', values: { LastName: 'Smith' } };
		match.applyMatchResponse([rec], 'LastName', {
			candidatesByValue: {
				Smith: [candidate('003A'), candidate('003B')],
			},
		});

		assert.equal(match.resolveRecord(rec, 'new', [rec]).ok, true);
		assert.equal(rec.loadedFromId, undefined);
		assert.equal(rec._migrateMatchResolution, 'new');
		assert.equal(rec._migrateMatchIntent, 'new');
	});

	test('a record with no suggestions can still be explicitly marked create new', () => {
		const rec = { id: 1, objectName: 'Contact', values: { LastName: 'New person' } };
		assert.equal(match.resolveRecord(rec, 'new', [rec]).ok, true);
		assert.equal(rec._migrateMatchResolution, 'new');
		assert.equal(rec._migrateMatchIntent, 'new');
	});

	test('a record with no suggestions can request update while it searches another field', () => {
		const rec = { id: 1, objectName: 'Contact', values: { LastName: 'Person' } };
		const result = match.resolveRecord(rec, 'update', [rec]);
		assert.equal(result.ok, true);
		assert.equal(result.pending, true);
		assert.equal(rec._migrateMatchIntent, 'existing');
		assert.equal(rec._migrateMatchResolution, undefined);
	});

	test('duplicate source keys cannot silently target the same destination row', () => {
		const first = { id: 1, objectName: 'Account', values: { Name: 'Acme' } };
		const second = { id: 2, objectName: 'Account', values: { Name: 'Acme' } };
		const all = [first, second];
		const result = match.applyMatchResponse(all, 'Name', {
			candidatesByValue: { Acme: [candidate('001TARGET')] },
		});

		assert.equal(result.matched, 0);
		assert.equal(result.unresolved, 2);
		assert.equal(match.resolveRecord(first, '001TARGET', all).ok, true);
		const collision = match.resolveRecord(second, '001TARGET', all);
		assert.equal(collision.ok, false);
		assert.equal(collision.error, 'candidate-already-used');
		assert.equal(second.loadedFromId, undefined);
		assert.equal(match.resolveRecord(second, 'new', all).ok, true);
	});

	test('returned key casing can differ from the canvas value', () => {
		const rec = { id: 1, objectName: 'Account', values: { Name: 'ACME' } };
		match.applyMatchResponse([rec], 'Name', {
			candidatesByValue: { acme: [candidate('001TARGET')] },
		});
		assert.equal(rec.loadedFromId, '001TARGET');
	});

	test('destination search records become selectable migration candidates', () => {
		assert.deepEqual(
			{ ...match.searchCandidate({ id: '001TARGET', name: 'Acme' }) },
			{
				id: '001TARGET',
				label: 'Acme',
				lastModifiedDate: null,
				matchField: null,
				matchValue: null,
			},
		);
		assert.equal(match.searchCandidate({ name: 'Missing id' }), null);
	});

	test('switching the key back to insert clears all match state', () => {
		const rec = { id: 1, objectName: 'Account', values: { Name: 'Acme' } };
		match.applyMatchResponse([rec], 'Name', {
			candidatesByValue: { Acme: [candidate('001TARGET')] },
		});
		match.clearMatchState(rec);

		assert.equal(rec.loadedFromId, undefined);
		assert.equal(rec._migrateMatchedId, undefined);
		assert.equal(rec._migrateMatchKey, undefined);
		assert.equal(rec._migrateMatchResolution, undefined);
		assert.equal(rec._migrateMatchIntent, undefined);
	});
});

describe('destination field mapping compatibility', () => {
	test('automatically matches an equivalent custom field by normalized API name', () => {
		const candidate = match.automaticFieldCandidate('pkg__Legacy_Code__c', 'ABC-1', [
			{ name: 'Legacy_Code__c', label: 'Legacy Code', type: 'string', createable: true },
			{ name: 'Description', label: 'Description', type: 'textarea', createable: true },
		]);

		assert.equal(candidate.field.name, 'Legacy_Code__c');
		assert.equal(candidate.disposition, 'direct');
	});

	test('automatically matches an exact normalized destination label', () => {
		const candidate = match.automaticFieldCandidate('Legacy_Code__c', 'ABC-1', [
			{ name: 'Migration_Code__c', label: 'Legacy Code', type: 'string', createable: true },
		]);

		assert.equal(candidate.field.name, 'Migration_Code__c');
	});

	test('does not guess when equally strong field matches are ambiguous or incompatible', () => {
		assert.equal(
			match.automaticFieldCandidate('Legacy_Code__c', 'ABC-1', [
				{ name: 'First__c', label: 'Legacy Code', type: 'string' },
				{ name: 'Second__c', label: 'Legacy Code', type: 'string' },
			]),
			null,
		);
		assert.equal(
			match.automaticFieldCandidate('Amount__c', 'not-a-number', [
				{ name: 'Target_Amount__c', label: 'Amount', type: 'currency' },
			]),
			null,
		);
	});

	test('an exact active picklist value maps directly and an unknown value requires translation', () => {
		const field = {
			name: 'Industry',
			type: 'picklist',
			picklistValues: [
				{ value: 'Technology', active: true },
				{ value: 'Legacy', active: false },
			],
		};

		assert.equal(match.fieldMapDisposition('Technology', field), 'direct');
		assert.equal(match.fieldMapDisposition('Manufacturing', field), 'choice');
		assert.equal(match.fieldMapDisposition('Legacy', field), 'choice');
	});

	test('field mapping uses record-type options and accepts unrestricted custom values', () => {
		const restricted = {
			name: 'Stage__c',
			type: 'picklist',
			restrictedPicklist: true,
			picklistValues: [{ value: 'GenericOnly', active: true }],
			picklistValuesByRecordType: {
				'012BUSINESS': [{ value: 'BusinessOnly', active: true }],
			},
		};
		const unrestricted = {
			name: 'Flexible__c',
			type: 'picklist',
			restrictedPicklist: false,
			picklistValues: [{ value: 'Suggested', active: true }],
		};

		assert.equal(match.fieldMapDisposition('BusinessOnly', restricted, '012BUSINESS'), 'direct');
		assert.equal(match.fieldMapDisposition('GenericOnly', restricted, '012BUSINESS'), 'choice');
		assert.equal(match.fieldMapDisposition('Customer-defined value', unrestricted), 'direct');
		assert.equal(match.fieldMapDisposition('GenericOnly', restricted, '012UNAVAILABLE'), 'incompatible');
	});

	test('relationship, structured, and invalid typed values are incompatible', () => {
		assert.equal(match.fieldMapDisposition('001xx', { name: 'AccountId', type: 'reference' }), 'incompatible');
		assert.equal(match.fieldMapDisposition({ latitude: 1 }, { name: 'Notes__c', type: 'string' }), 'incompatible');
		assert.equal(match.fieldMapDisposition('not-a-number', { name: 'Amount', type: 'currency' }), 'incompatible');
		assert.equal(match.fieldMapDisposition('2026-02-31', { name: 'StartDate__c', type: 'date' }), 'incompatible');
		assert.equal(match.fieldMapDisposition('3.5', { name: 'Count__c', type: 'int' }), 'incompatible');
		assert.equal(
			match.fieldMapDisposition('too long', { name: 'Code__c', type: 'string', length: 4 }),
			'incompatible',
		);
	});

	test('compatible scalar and multi-select values map directly without another choice', () => {
		assert.equal(match.fieldMapDisposition('100.50', { name: 'Amount', type: 'currency' }), 'direct');
		assert.equal(match.fieldMapDisposition('2026-07-16', { name: 'StartDate__c', type: 'date' }), 'direct');
		assert.equal(match.fieldMapDisposition('true', { name: 'Active__c', type: 'boolean' }), 'direct');
		assert.equal(
			match.fieldMapDisposition('A;B', {
				name: 'Tags__c',
				type: 'multipicklist',
				picklistValues: [
					{ value: 'A', active: true },
					{ value: 'B', active: true },
				],
			}),
			'direct',
		);
		assert.equal(
			match.fieldMapDisposition('A;C', {
				name: 'Tags__c',
				type: 'multipicklist',
				picklistValues: [
					{ value: 'A', active: true },
					{ value: 'B', active: true },
				],
			}),
			'incompatible',
		);
	});
});

test('unnamed records of the same object receive stable migration labels', () => {
	const describe = {
		label: 'Account',
		fields: [{ name: 'Name', nameField: true }],
	};
	const first = { id: 1, objectName: 'Account', label: 'Account', values: {} };
	const named = { id: 2, objectName: 'Account', label: 'Account', values: { Name: 'Acme' } };
	const second = { id: 3, objectName: 'Account', label: 'Account record', values: {} };
	const records = [first, named, second];

	assert.equal(match.recordDisplayLabel(first, describe, records, 1), 'Account #1');
	assert.equal(match.recordDisplayLabel(named, describe, records), 'Account \u00b7 Acme');
	assert.equal(match.recordDisplayLabel(second, describe, records, 3), 'Account #3');
	assert.equal(match.recordDisplayLabel(first, describe, [first]), 'Account');
});

test('the guided modal owns matching, destination differences, and final review', () => {
	assert.match(source, /<h3>Prepare migration<\/h3>/);
	assert.match(source, /data-mm-panel="matches"/);
	assert.match(source, /data-mm-panel="differences"/);
	assert.doesNotMatch(source, /Suggested matches are applied automatically/);
	assert.match(source, /data-mm-panel="review"/);
	assert.match(source, /<strong>Records<\/strong>/);
	assert.match(source, /<strong>Fields<\/strong>/);
	assert.match(source, /<strong>Summary<\/strong>/);
	assert.match(source, /primaryBtn\.textContent[\s\S]*: 'Continue to fields'/);
	assert.match(source, /primaryBtn\.textContent[\s\S]*: 'View summary'/);
	assert.match(source, /'Complete ' \+[\s\S]*' required field'/);
	assert.doesNotMatch(source, /required difference/);
	assert.match(source, /Choose what happens to each canvas record/);
	assert.match(source, /Records start as Create new/);
	assert.match(source, /mm-record-decisions/);
	assert.match(source, /mm-record-identity/);
	assert.doesNotMatch(source, />Canvas record</);
	assert.doesNotMatch(source, /mm-record-kind/);
	assert.match(source, /function _differenceRecordLabel\(rec\)/);
	assert.match(source, /_renderDifferences\(\)[\s\S]*_differenceRecordLabel\(rec\)/);
	assert.doesNotMatch(source, /_differenceRecordLabel\(rec\)\) \+ '<\/strong><span>'/);
	assert.match(source, /<summary>Try another identifying field<\/summary>/);
	assert.match(source, /showMatchOptions \? '' : ' hidden'/);
	assert.match(source, /state\.attempted[\s\S]*state\.results\.length === 0/);
	assert.match(source, /const matchOptions\s*=\s*action === 'existing'/);
	assert.match(source, /_initializeRecordDecisions\(\)/);
	assert.match(source, /_markCreate\(rec\)/);
	assert.match(source, /This changes suggestions for this record only/);
	assert.match(source, /Search failed/);
	assert.match(source, /_migrateMatchSearchError/);
	assert.doesNotMatch(source, /class="mm-row"/);
	assert.doesNotMatch(source, /Match using/);
	assert.match(source, /matchSnapshot/);
	assert.match(source, /'values',/);
	assert.doesNotMatch(source, /Continue with drafts/);
	assert.doesNotMatch(source, /data-mm-continue-drafts/);
	assert.doesNotMatch(source, /data-mm-refresh-fields/);
	assert.match(source, /ensureDescribe\(n, \{ force: true \}\)/);
	assert.match(source, /data-mm-retry-schema/);
	assert.doesNotMatch(source, /Unavailable through this destination connection/);
	assert.match(source, /data-mm-field-resolution/);
	assert.match(source, /_applyAutomaticFieldMappings\(\)/);
	assert.match(source, /Auto-matched/);
	assert.match(source, /Needs your input/);
	assert.match(source, /Completed required fields/);
	assert.match(source, /kind: 'required-reviewed'/);
	assert.match(source, /reviewedRequiredFields\.set/);
	assert.match(source, /escapeHtml\(String\(displayedValue\)\)/);
	assert.match(source, /Reviewed mappings/);
	assert.match(source, /Automatically matched \(/);
	assert.match(source, /mm-field-map-group/);
	assert.doesNotMatch(source, /Destination action/);
	assert.doesNotMatch(source, />Drop<\/button>/);
	assert.match(source, /Don't map \(destination unchanged\)/);
	assert.match(source, /Unmapped values do not clear or overwrite destination data/);
	assert.match(source, /Blank source fields won\\u2019t replace existing Salesforce values/);
	assert.match(source, /To clear a field, apply the migration, open the record/);
	assert.match(source, /Apply to canvas/);
	assert.match(source, /Nothing is written to Salesforce until you use Upload/);
	assert.match(source, /summaryEl\.hidden = step === 'review'/);
	assert.match(source, /status\.updates > 0/);
	assert.match(source, /Map to a destination field/);
	assert.match(source, /value selection required/);
	assert.match(source, /data-mm-map-value/);
	assert.match(source, /Source value <code>/);
	assert.match(source, /Destination value<select/);
	assert.match(source, /resolvedFieldMaps/);
	assert.match(source, /_migrateFieldResolutions/);
	assert.match(source, /mm-field-resolution-state/);
	assert.match(source, /Needs attention/);
	assert.match(source, /Resolved/);
	assert.match(source, /pendingFieldMapCount/);
	assert.match(cssSource, /\.mm-map-value-resolution/);
	assert.match(cssSource, /\.mm-field-resolution-state--resolved/);
	assert.doesNotMatch(source, /data-mm-map-missing/);
	assert.doesNotMatch(source, /data-mm-omit-missing/);
	assert.doesNotMatch(source, /data-mm-copy-missing/);
	assert.match(source, /Apply migration to canvas/);
	assert.match(source, /onCommitPlan/);
	assert.match(source, /Applying to canvas/);
	assert.doesNotMatch(source, /data-mm-close>Cancel/);
	assert.match(source, /What should happen to this record\?/);
	assert.match(source, /value="new"[\s\S]*Create new[\s\S]*value="existing"[\s\S]*Update existing/);
	assert.match(source, /Update existing/);
	assert.match(source, /Search destination/);
	assert.match(source, /class="mm-destination-search"/);
	assert.match(source, /class="mm-search-results"/);
	assert.match(source, /\/api\/objects\/[\s\S]*\/search\?q=/);
	assert.match(source, /if \(result\.ok\)[\s\S]*_collapseDestinationSearch\(rec, candidate\)/);
	assert.match(source, /destinationSearch\.open \? '' : ' hidden'/);
	assert.match(source, /query: selectedLabel \|\| rec\._migrateMatchedId \|\| ''/);
	assert.match(source, /open: !rec\._migrateMatchedId/);
	assert.doesNotMatch(source, /destinationInput\.addEventListener\('focus'/);
	assert.doesNotMatch(source, /mm-resolution-select/);
	assert.match(source, /Create new/);
	assert.match(cssSource, /\.mm-decision-card--needs[^\{]*\{[^}]*var\(--warn\)/);
	assert.match(cssSource, /\.mm-record-decisions/);
	assert.match(cssSource, /\.mm-match-options/);
	assert.match(cssSource, /\.mm-search-input-wrap::before/);
	assert.match(cssSource, /\.mm-destination-search:focus[^{]*\{[^}]*var\(--accent\)/);
	assert.match(cssSource, /input\.mm-difference-input:focus[\s\S]*box-shadow: 0 0 0 2px var\(--accent-soft\)/);
	assert.match(cssSource, /\.mm-primary:disabled[\s\S]*cursor: not-allowed/);
	assert.doesNotMatch(
		cssSource.match(/\.migrate-match-modal \.mm-target-choice \{[^}]*\}/)?.[0] || '',
		/border-left/,
	);
	assert.match(cssSource, /\.mm-difference-record--blocked/);
	assert.doesNotMatch(cssSource, /\.mm-review-summary/);
	assert.doesNotMatch(source, /class="mm-review-summary"/);
	assert.match(source, /existing record[\s\S]*to update/);
	assert.match(source, /new record[\s\S]*to create/);
	assert.match(cssSource, /\.mm-plan-summary/);
	assert.match(cssSource, /\.mm-before-upload/);
	assert.match(cssSource, /\.mm-auto-matches/);
	assert.match(appSource, /_migrationResumed\.justArrived[\s\S]*migrateMatch\.open\(\{ autoOpened: true \}\)/);
	assert.match(appSource, /data-mmb-review>Review and apply/);
	assert.match(appSource, /migrateMatch\.mount\(\{[\s\S]*recordOrdinal: recordOrdinal/);
	assert.match(appSource, /onCommitPlan: applyMigrationPlanToCanvas/);
	assert.match(appSource, /function exitMigrateMode\(\)[\s\S]*delete record\._migrateFieldResolutions/);
	assert.match(
		uploadSource,
		/function _clearCommittedMigrationMatch\(rec\)[\s\S]*delete rec\._migrateFieldResolutions/,
	);
});
