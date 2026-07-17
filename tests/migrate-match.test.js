import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(
	new URL('../src/public/js/migrate-match.js', import.meta.url),
	'utf8',
);
const cssSource = readFileSync(
	new URL('../src/public/css/app.css', import.meta.url),
	'utf8',
);
const appSource = readFileSync(
	new URL('../src/public/js/app.js', import.meta.url),
	'utf8',
);
const uploadSource = readFileSync(
	new URL('../src/public/js/upload-modal.js', import.meta.url),
	'utf8',
);
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

		assert.deepEqual(Array.from(candidates, (field) => field.name), ['LastName']);
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

	test('relationship, structured, and invalid typed values are incompatible', () => {
		assert.equal(match.fieldMapDisposition('001xx', { name: 'AccountId', type: 'reference' }), 'incompatible');
		assert.equal(match.fieldMapDisposition({ latitude: 1 }, { name: 'Notes__c', type: 'string' }), 'incompatible');
		assert.equal(match.fieldMapDisposition('not-a-number', { name: 'Amount', type: 'currency' }), 'incompatible');
		assert.equal(match.fieldMapDisposition('2026-02-31', { name: 'StartDate__c', type: 'date' }), 'incompatible');
		assert.equal(match.fieldMapDisposition('3.5', { name: 'Count__c', type: 'int' }), 'incompatible');
		assert.equal(match.fieldMapDisposition('too long', { name: 'Code__c', type: 'string', length: 4 }), 'incompatible');
	});

	test('compatible scalar and multi-select values map directly without another choice', () => {
		assert.equal(match.fieldMapDisposition('100.50', { name: 'Amount', type: 'currency' }), 'direct');
		assert.equal(match.fieldMapDisposition('2026-07-16', { name: 'StartDate__c', type: 'date' }), 'direct');
		assert.equal(match.fieldMapDisposition('true', { name: 'Active__c', type: 'boolean' }), 'direct');
		assert.equal(match.fieldMapDisposition('A;B', {
			name: 'Tags__c',
			type: 'multipicklist',
			picklistValues: [{ value: 'A', active: true }, { value: 'B', active: true }],
		}), 'direct');
		assert.equal(match.fieldMapDisposition('A;C', {
			name: 'Tags__c',
			type: 'multipicklist',
			picklistValues: [{ value: 'A', active: true }, { value: 'B', active: true }],
		}), 'incompatible');
	});
});

test('the guided modal owns matching, destination differences, and final review', () => {
	assert.match(source, /<h3>Prepare migration<\/h3>/);
	assert.match(source, /data-mm-panel="matches"/);
	assert.match(source, /data-mm-panel="differences"/);
	assert.match(source, /data-mm-panel="review"/);
	assert.match(source, /Decide record actions/);
	assert.match(source, /Resolve differences/);
	assert.match(source, /Review migration/);
	assert.match(source, /Next: Resolve differences/);
	assert.match(source, /Next: Review migration/);
	assert.match(source, /Choose what happens to each canvas record/);
	assert.match(source, /Records start as Create new/);
	assert.match(source, /mm-record-decisions/);
	assert.match(source, /mm-record-identity/);
	assert.doesNotMatch(source, />Canvas record</);
	assert.doesNotMatch(source, /mm-record-kind/);
	assert.match(source, /function _differenceRecordLabel\(rec\)/);
	assert.match(source, /_renderDifferences\(\)[\s\S]*_differenceRecordLabel\(rec\)/);
	assert.doesNotMatch(source, /_differenceRecordLabel\(rec\)\) \+ '<\/strong><span>'/);
	assert.match(source, /Change how matches are found/);
	assert.match(source, /const matchOptions = action === 'existing'/);
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
	assert.match(source, /Don\\'t map leaves that source field out of this migration/);
	assert.match(source, /it does not clear or overwrite destination data/);
	assert.doesNotMatch(source, />Drop<\/button>/);
	assert.match(source, /Don\\'t map \(destination unchanged\)/);
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
	assert.match(source, /Apply migration plan/);
	assert.match(source, /What should happen to this record\?/);
	assert.match(source, /value="new"[\s\S]*Create new[\s\S]*value="existing"[\s\S]*Update existing/);
	assert.match(source, /Update existing/);
	assert.match(source, /Destination record/);
	assert.match(source, /Create new/);
	assert.match(cssSource, /\.mm-decision-card--needs[^\{]*\{[^}]*var\(--warn\)/);
	assert.match(cssSource, /\.mm-record-decisions/);
	assert.match(cssSource, /\.mm-match-options/);
	assert.match(cssSource, /\.mm-difference-record--blocked/);
	assert.match(cssSource, /\.mm-final-counts/);
	assert.match(appSource, /_migrationResumed\.justArrived[\s\S]*migrateMatch\.open\(\{ autoOpened: true \}\)/);
	assert.match(appSource, /data-mmb-review>Review migration/);
	assert.match(appSource, /function exitMigrateMode\(\)[\s\S]*delete record\._migrateFieldResolutions/);
	assert.match(uploadSource, /function _clearCommittedMigrationMatch\(rec\)[\s\S]*delete rec\._migrateFieldResolutions/);
});
