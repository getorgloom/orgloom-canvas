
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const _src = readFileSync(
	new URL('../src/public/js/migrate-annotate.js', import.meta.url),
	'utf8',
);
const _recordsCanvasSrc = readFileSync(
	new URL('../src/public/js/records-canvas.js', import.meta.url),
	'utf8',
);
const _insertModalSrc = readFileSync(
	new URL('../src/public/js/insert-modal.js', import.meta.url),
	'utf8',
);
const _appSrc = readFileSync(
	new URL('../src/public/js/app.js', import.meta.url),
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

	test('non-createable compound field never blocks required-on-create', () => {
		const d = describe_([
			field('Name', { label: 'Full Name', required: true, createable: false }),
			field('LastName', { label: 'Last Name', required: true }),
		]);
		const rec = { objectName: 'Contact', values: { LastName: 'Migration Contact' } };
		const res = annotate.computeMigrationStatus(rec, d);
		assert.equal(res.status, 'ready');
		assert.ok(!res.issues.some((i) => i.field === 'Name'));
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
		const rec = { objectName: 'Account', values: { Extra__c: 'x' } }; // missing-field warn + Name required block
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
			_sourceRecordTypeDeveloperName: 'Business', // no target match
			_migrateRecordTypeId: '012CHOSEN', // user picked one
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

	test('matched record (loadedFromId set) skips required-unfilled: it is an update', () => {
		const d = describe_([field('Name', { required: true })]);
		const rec = {
			objectName: 'Account',
			values: { Phone: '555' }, // Name unfilled, but...
			loadedFromId: '001TARGET', // matched to an existing target record
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
			_migratePicklistRemap: { Tags: { Y: 'A' } }, // Z still unmapped
		};
		const res = annotate.computeMigrationStatus(rec, d);
		assert.equal(res.status, 'warning');
		assert.deepEqual(Array.from(res.issues[0].invalidValues), ['Z']);
	});

	test('Org Loom internal markers and SF system fields are ignored', () => {
		const d = describe_([field('Name', { required: true })]);
		const rec = {
			objectName: 'Account',
			values: {
				Name: 'Acme',
				attributes: { type: 'Account', url: '/services/data/vXX.X/sobjects/Account/001X' },
				Id: '001X',
				OwnerId: '005X',
				_wasLoadedFromId: '001Y',
			},
		};
		assert.equal(annotate.computeMigrationStatus(rec, d).status, 'ready');
	});
});

describe('annotateRecords + summarize', () => {
	test('records without a describe yet are pending', () => {
		const recs = [{ objectName: 'Account', values: { Name: 'A' } }];
		const out = annotate.annotateRecords(recs, {}); // no describe
		assert.equal(out[0].status, 'pending');
	});

	test('type nodes annotate to null', () => {
		const recs = [{ isTypeNode: true, objectName: 'Account' }];
		assert.equal(annotate.annotateRecords(recs, {})[0], null);
	});

	test('summarize counts by status', () => {
		const d = describe_([field('Name', { required: true })]);
		const recs = [
			{ objectName: 'Account', values: { Name: 'A' } }, // ready
			{ objectName: 'Account', values: { Extra__c: 'x' } }, // blocked (Name missing)
			{ isTypeNode: true, objectName: 'Account' }, // null
		];
		const anns = annotate.annotateRecords(recs, { Account: d });
		const counts = annotate.summarize(anns);
		assert.equal(counts.total, 2);
		assert.equal(counts.ready, 1);
		assert.equal(counts.blocked, 1);
	});
});

describe('badgeSummary: one contextual card badge', () => {
	test('ready records have no migration badge', () => {
		assert.equal(annotate.badgeSummary({ status: 'ready', issues: [] }), null);
	});

	test('blocked records use one direct fix-required label', () => {
		const badge = annotate.badgeSummary({
			status: 'blocked',
			issues: [{ kind: 'required-unfilled' }, { kind: 'missing-field' }],
		});
		assert.equal(badge.status, 'blocked');
		assert.equal(badge.label, 'fix required');
		assert.match(badge.title, /2 migration issues/);
	});

	test('unavailable fields are counted without claiming they are absent', () => {
		const badge = annotate.badgeSummary({
			status: 'warning',
			issues: [
				{ kind: 'missing-field', field: 'Source_Only__c' },
				{ kind: 'missing-field', field: 'Hidden_By_Fls__c' },
			],
		});
		assert.equal(badge.label, '2 fields unavailable');
		assert.match(badge.title, /may not exist/);
		assert.match(badge.title, /permissions may hide/);
	});

	test('picklist badge counts invalid values rather than fields', () => {
		const badge = annotate.badgeSummary({
			status: 'warning',
			issues: [
				{ kind: 'picklist-mismatch', invalidValues: ['Old', 'Legacy'] },
				{ kind: 'picklist-mismatch', invalidValues: ['Retired'] },
			],
		});
		assert.equal(badge.label, '3 values need mapping');
	});

	test('mixed warnings use a single generic issue count', () => {
		const badge = annotate.badgeSummary({
			status: 'warning',
			issues: [
				{ kind: 'missing-field' },
				{ kind: 'picklist-mismatch', invalidValues: ['Old'] },
			],
		});
		assert.equal(badge.label, '2 migration issues');
	});

	test('pending records use a neutral checking label', () => {
		assert.equal(
			annotate.badgeSummary({ status: 'pending', issues: [] }).label,
			'checking...',
		);
	});

	test('migration issue details are not rendered as competing canvas-card badges', () => {
		assert.doesNotMatch(_recordsCanvasSrc, /\.badgeSummary\(_ann\)/);
		assert.doesNotMatch(_recordsCanvasSrc, /record-migrate-badge/);
		assert.doesNotMatch(_recordsCanvasSrc, /record-orphan-badge/);
		assert.doesNotMatch(_recordsCanvasSrc, />review<\/span>/);
	});

	test('permission changes can force-refresh fields without losing the tab migration', () => {
		assert.match(_insertModalSrc, /data-orphan-refresh/);
		assert.match(_insertModalSrc, /ensureDescribe\(currentObject, \{ force: true \}\)/);
		assert.match(_insertModalSrc, /currentFields = refreshedDescribe\.fields \|\| \[\]/);
		assert.match(_appSrc, /sessionStorage\.removeItem\(_describeStorageKey\(name\)\)/);
	});
});

describe('prepareMigrationValues: destination-safe upload payload', () => {
	test('omits destination-missing fields instead of sending a clear or INVALID_FIELD payload', () => {
		const record = { values: { Name: 'Acme', Source_Only__c: 'must not cross' } };
		const ann = { issues: [{ kind: 'missing-field', severity: 'warning', field: 'Source_Only__c' }] };
		assert.equal(JSON.stringify(annotate.prepareMigrationValues(record, ann)), JSON.stringify({ Name: 'Acme' }));
	});

	test('drops only unresolved invalid multipicklist members', () => {
		const record = { values: { Tags__c: 'Valid;SourceOnly;AlsoValid' } };
		const ann = { issues: [{ kind: 'picklist-mismatch', severity: 'warning', field: 'Tags__c', invalidValues: ['SourceOnly'] }] };
		assert.equal(JSON.stringify(annotate.prepareMigrationValues(record, ann)), JSON.stringify({ Tags__c: 'Valid;AlsoValid' }));
	});

	test('applies explicit remaps and target record type without mutating canvas values', () => {
		const record = {
			values: { Stage__c: 'Source', Keep__c: 'same' },
			_migratePicklistRemap: { Stage__c: { Source: 'Target' } },
		};
		const result = annotate.prepareMigrationValues(record, { issues: [], resolvedRecordTypeId: '012TARGET' });
		assert.equal(JSON.stringify(result), JSON.stringify({ Stage__c: 'Target', Keep__c: 'same', RecordTypeId: '012TARGET' }));
		assert.equal(record.values.Stage__c, 'Source');
	});
});
