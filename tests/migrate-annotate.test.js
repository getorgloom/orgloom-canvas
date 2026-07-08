












import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';





const _src = readFileSync(
	new URL('../src/public/js/migrate-annotate.js', import.meta.url),
	'utf8',
);
const _sandbox = { window: {} };
vm.createContext(_sandbox);
vm.runInContext(_src, _sandbox);
const annotate = _sandbox.window.Orgloom.migrateAnnotate;


function describe_(fields, recordTypes) {
	return { fields: fields || [], recordTypes: recordTypes || [] };
}
function field(name, opts) {
	opts = opts || {};
	return {
		name: name,
		label: opts.label || name,
		type: opts.type || 'string',
		createable: opts.createable !== false,
		required: !!opts.required,

		picklistValues: opts.picklistValues || [],
	};
}

function pv(value) {
	return { value: value, label: value };
}

describe('computeMigrationStatus', () => {
	test('clean record on a compatible target is ready', () => {
		const d = describe_([field('Name', { required: true }), field('Phone')]);
		const rec = { objectName: 'Account', values: { Name: 'Acme', Phone: '555' } };
		const res = annotate.computeMigrationStatus(rec, d);
		assert.equal(res.status, 'ready');
		assert.equal(res.issues.length, 0);
	});

	test('field not on target -> missing-field warning (non-blocking)', () => {
		const d = describe_([field('Name', { required: true })]);
		const rec = { objectName: 'Account', values: { Name: 'Acme', Custom_X__c: 'v' } };
		const res = annotate.computeMigrationStatus(rec, d);
		assert.equal(res.status, 'warning');
		assert.equal(res.issues.length, 1);
		assert.equal(res.issues[0].kind, 'missing-field');
		assert.equal(res.issues[0].field, 'Custom_X__c');
	});

	test('empty value for a missing field is ignored (nothing to migrate)', () => {
		const d = describe_([field('Name', { required: true })]);
		const rec = { objectName: 'Account', values: { Name: 'Acme', Gone__c: '' } };
		const res = annotate.computeMigrationStatus(rec, d);
		assert.equal(res.status, 'ready');
	});

	test('required-on-create field unfilled -> blocked', () => {

		const d = describe_([field('Name', { required: true }), field('Phone')]);
		const rec = { objectName: 'Account', values: { Phone: '555' } };
		const res = annotate.computeMigrationStatus(rec, d);
		assert.equal(res.status, 'blocked');
		assert.equal(res.issues.length, 1);
		assert.equal(res.issues[0].kind, 'required-unfilled');
		assert.equal(res.issues[0].field, 'Name');
	});

	test('required field that IS populated does not flag', () => {
		const d = describe_([field('Name', { required: true })]);
		const rec = { objectName: 'Account', values: { Name: 'Acme' } };
		assert.equal(annotate.computeMigrationStatus(rec, d).status, 'ready');
	});

	test('required reference field is NOT flagged (association may satisfy it)', () => {
		const d = describe_([
			field('Name', { required: true }),
			field('AccountId', { required: true, type: 'reference' }),
		]);
		const rec = { objectName: 'Contact', values: { Name: 'Bob' } };

		assert.equal(annotate.computeMigrationStatus(rec, d).status, 'ready');
	});

	test('non-required field (defaulted/optional) is not flagged', () => {


		const d = describe_([field('Status', { required: false })]);
		const rec = { objectName: 'Case', values: {} };
		assert.equal(annotate.computeMigrationStatus(rec, d).status, 'ready');
	});

	test('picklist value not in target -> warning', () => {
		const d = describe_([
			field('Stage', { type: 'picklist', picklistValues: [pv('Open'), pv('Closed')] }),
		]);
		const rec = { objectName: 'Opp', values: { Stage: 'Frozen' } };
		const res = annotate.computeMigrationStatus(rec, d);
		assert.equal(res.status, 'warning');
		assert.equal(res.issues[0].kind, 'picklist-mismatch');


		assert.deepEqual(Array.from(res.issues[0].invalidValues), ['Frozen']);
	});

	test('multipicklist flags only the invalid members', () => {
		const d = describe_([
			field('Tags', { type: 'multipicklist', picklistValues: [pv('A'), pv('B')] }),
		]);
		const rec = { objectName: 'X', values: { Tags: 'A;Z;B' } };
		const res = annotate.computeMigrationStatus(rec, d);
		assert.deepEqual(Array.from(res.issues[0].invalidValues), ['Z']);
	});

	test('value dropped from target picklist (e.g. inactive) is invalid', () => {


		const d = describe_([
			field('Stage', { type: 'picklist', picklistValues: [pv('Open')] }),
		]);
		const rec = { objectName: 'Opp', values: { Stage: 'Old' } };
		assert.equal(annotate.computeMigrationStatus(rec, d).status, 'warning');
	});

	test('record type resolves by DeveloperName -> ready + resolvedRecordTypeId', () => {
		const d = describe_(
			[field('Name', { required: true })],
			[{ developerName: 'Business', id: '012TARGET001' }],
		);
		const rec = {
			objectName: 'Account',
			values: { Name: 'Acme' },
			_sourceRecordTypeDeveloperName: 'Business',
		};
		const res = annotate.computeMigrationStatus(rec, d);
		assert.equal(res.status, 'ready');
		assert.equal(res.resolvedRecordTypeId, '012TARGET001');
	});

	test('record type with no target match -> blocked', () => {
		const d = describe_(
			[field('Name', { required: true })],
			[{ developerName: 'Other', id: '012X' }],
		);
		const rec = {
			objectName: 'Account',
			values: { Name: 'Acme' },
			_sourceRecordTypeDeveloperName: 'Business',
		};
		const res = annotate.computeMigrationStatus(rec, d);
		assert.equal(res.status, 'blocked');
		assert.equal(res.issues[0].kind, 'recordtype-unresolved');
		assert.equal(res.resolvedRecordTypeId, null);
	});

	test('record type absent from target (e.g. unavailable) -> blocked', () => {


		const d = describe_([field('Name', { required: true })], []);
		const rec = {
			objectName: 'Account',
			values: { Name: 'Acme' },
			_sourceRecordTypeDeveloperName: 'Business',
		};
		assert.equal(annotate.computeMigrationStatus(rec, d).status, 'blocked');
	});

	test('blocked dominates warning in the status rollup', () => {
		const d = describe_([field('Name', { required: true })]);
		const rec = { objectName: 'Account', values: { Extra__c: 'x' } };
		const res = annotate.computeMigrationStatus(rec, d);
		assert.equal(res.status, 'blocked');
	});

	test('_migrateRecordTypeId override resolves an otherwise-blocked record type', () => {
		const d = describe_(
			[field('Name', { required: true })],
			[{ developerName: 'Other', id: '012X' }],
		);
		const rec = {
			objectName: 'Account',
			values: { Name: 'Acme' },
			_sourceRecordTypeDeveloperName: 'Business',
			_migrateRecordTypeId: '012CHOSEN',
		};
		const res = annotate.computeMigrationStatus(rec, d);
		assert.equal(res.status, 'ready');
		assert.equal(res.resolvedRecordTypeId, '012CHOSEN');
	});

	test('_migrateClearRecordType drops the record type without blocking', () => {
		const d = describe_([field('Name', { required: true })], []);
		const rec = {
			objectName: 'Account',
			values: { Name: 'Acme' },
			_sourceRecordTypeDeveloperName: 'Business',
			_migrateClearRecordType: true,
		};
		const res = annotate.computeMigrationStatus(rec, d);
		assert.equal(res.status, 'ready');
		assert.equal(res.resolvedRecordTypeId, null);
	});

	test('matched record (loadedFromId set) skips required-unfilled — it is an update', () => {
		const d = describe_([field('Name', { required: true })]);
		const rec = {
			objectName: 'Account',
			values: { Phone: '555' },
			loadedFromId: '001TARGET',
		};


		const res = annotate.computeMigrationStatus(rec, d);
		assert.equal(res.status, 'warning');
		assert.ok(!res.issues.some((i) => i.kind === 'required-unfilled'));
	});

	test('_migratePicklistRemap resolves an invalid picklist value (no warning)', () => {
		const d = describe_([
			field('Stage', { type: 'picklist', picklistValues: [pv('Open'), pv('Closed')] }),
		]);
		const rec = {
			objectName: 'Opp',
			values: { Stage: 'Frozen' },
			_migratePicklistRemap: { Stage: { Frozen: 'Closed' } },
		};
		assert.equal(annotate.computeMigrationStatus(rec, d).status, 'ready');
	});

	test('_migratePicklistRemap to drop ("") also resolves', () => {
		const d = describe_([
			field('Stage', { type: 'picklist', picklistValues: [pv('Open')] }),
		]);
		const rec = {
			objectName: 'Opp',
			values: { Stage: 'Old' },
			_migratePicklistRemap: { Stage: { Old: '' } },
		};
		assert.equal(annotate.computeMigrationStatus(rec, d).status, 'ready');
	});

	test('partial multipicklist remap still flags the unmapped member', () => {
		const d = describe_([
			field('Tags', { type: 'multipicklist', picklistValues: [pv('A')] }),
		]);
		const rec = {
			objectName: 'X',
			values: { Tags: 'A;Y;Z' },
			_migratePicklistRemap: { Tags: { Y: 'A' } },
		};
		const res = annotate.computeMigrationStatus(rec, d);
		assert.equal(res.status, 'warning');
		assert.deepEqual(Array.from(res.issues[0].invalidValues), ['Z']);
	});

	test('Org Loom internal markers and SF system fields are ignored', () => {
		const d = describe_([field('Name', { required: true })]);
		const rec = {
			objectName: 'Account',
			values: { Name: 'Acme', Id: '001X', OwnerId: '005X', _wasLoadedFromId: '001Y' },
		};
		assert.equal(annotate.computeMigrationStatus(rec, d).status, 'ready');
	});
});

describe('annotateRecords + summarize', () => {
	test('records without a describe yet are pending', () => {
		const recs = [{ objectName: 'Account', values: { Name: 'A' } }];
		const out = annotate.annotateRecords(recs, {});
		assert.equal(out[0].status, 'pending');
	});

	test('type nodes annotate to null', () => {
		const recs = [{ isTypeNode: true, objectName: 'Account' }];
		assert.equal(annotate.annotateRecords(recs, {})[0], null);
	});

	test('summarize counts by status', () => {
		const d = describe_([field('Name', { required: true })]);
		const recs = [
			{ objectName: 'Account', values: { Name: 'A' } },
			{ objectName: 'Account', values: { Extra__c: 'x' } },
			{ isTypeNode: true, objectName: 'Account' },
		];
		const anns = annotate.annotateRecords(recs, { Account: d });
		const counts = annotate.summarize(anns);
		assert.equal(counts.total, 2);
		assert.equal(counts.ready, 1);
		assert.equal(counts.blocked, 1);
	});
});
