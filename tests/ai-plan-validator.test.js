
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateAiPlan } from '../src/ai-plan.js';

function describes() {
	return [
		{
			name: 'Account',
			describe: {
				label: 'Account',
				fields: [
					{ name: 'Name', type: 'string', createable: true, nillable: false, defaultedOnCreate: false },
					{ name: 'Industry', type: 'picklist', createable: true, nillable: true,
						picklistValues: [
							{ value: 'Technology', active: true },
							{ value: 'Finance', active: true },
							{ value: 'Retired', active: false },
						],
					},
					{ name: 'Tags__c', type: 'multipicklist', createable: true, nillable: true,
						picklistValues: [
							{ value: 'A', active: true },
							{ value: 'B', active: true },
							{ value: 'C', active: true },
						],
					},
					{ name: 'Id', type: 'id', createable: false, nillable: false },
					{ name: 'CreatedDate', type: 'datetime', createable: false, nillable: false },
				],
			},
		},
		{
			name: 'Contact',
			describe: {
				label: 'Contact',
				fields: [
					{ name: 'LastName', type: 'string', createable: true, nillable: false, defaultedOnCreate: false },
					{ name: 'AccountId', type: 'reference', createable: true, nillable: true,
						referenceTo: ['Account'] },
					{ name: 'ReportsToId', type: 'reference', createable: true, nillable: true,
						referenceTo: ['Contact'] },
					{ name: 'ReadOnlyAccount__c', type: 'reference', createable: false, updateable: false,
						referenceTo: ['Account'] },
				],
			},
		},
	];
}

describe('validateAiPlan: happy path', () => {
	test('a well-formed plan passes with no warnings', () => {
		const plan = {
			records: [
				{ tempId: 1, objectName: 'Account', values: { Name: 'Acme', Industry: 'Technology' } },
				{ tempId: 2, objectName: 'Contact', values: { LastName: 'Doe' } },
			],
			associations: [
				{ fromTempId: 2, toTempId: 1, fieldName: 'AccountId' },
			],
		};
		const r = validateAiPlan(plan, describes());
		assert.equal(r.warnings.length, 0);
		assert.equal(r.records.length, 2);
		assert.equal(r.associations.length, 1);
		assert.deepEqual(r.records[0].values, { Name: 'Acme', Industry: 'Technology' });
	});

	test('multipicklist value gets normalized (parts trimmed, joined with ;)', () => {
		const plan = {
			records: [{ tempId: 1, objectName: 'Account', values: { Name: 'Acme', Tags__c: 'A ; B ; C' } }],
			associations: [],
		};
		const r = validateAiPlan(plan, describes());
		assert.equal(r.warnings.length, 0);
		assert.equal(r.records[0].values.Tags__c, 'A;B;C');
	});
});

describe('validateAiPlan: record drops', () => {
	test('caps a poisoned/model-invalid response at 100 records', () => {
		const plan = {
			records: Array.from({ length: 101 }, (_, i) => ({ tempId: i + 1, objectName: 'Account', values: { Name: `A${i}` } })),
			associations: [],
		};
		const r = validateAiPlan(plan, describes());
		assert.equal(r.records.length, 100);
		assert.ok(r.warnings.some((w) => /only the first 100 were kept/.test(w)));
	});

	test('drops invalid and duplicate tempIds so associations are unambiguous', () => {
		const plan = {
			records: [
				{ tempId: 0, objectName: 'Account', values: { Name: 'Invalid' } },
				{ tempId: 1, objectName: 'Account', values: { Name: 'First' } },
				{ tempId: 1, objectName: 'Account', values: { Name: 'Duplicate' } },
			],
			associations: [],
		};
		const r = validateAiPlan(plan, describes());
		assert.deepEqual(r.records.map((record) => record.values.Name), ['First']);
		assert.equal(r.warnings.length, 2);
	});

	test('record with unknown object is dropped with a warning', () => {
		const plan = {
			records: [{ tempId: 1, objectName: 'MadeUp__c', values: {} }],
			associations: [],
		};
		const r = validateAiPlan(plan, describes());
		assert.equal(r.records.length, 0);
		assert.match(r.warnings[0], /unknown object "MadeUp__c"/);
	});

	test('malformed record (null/non-object) is dropped', () => {
		const plan = { records: [null, 42, 'oops'], associations: [] };
		const r = validateAiPlan(plan, describes());
		assert.equal(r.records.length, 0);
		assert.equal(r.warnings.length, 3);
	});

	test('non-createable field (Id, CreatedDate) is dropped per-field', () => {
		const plan = {
			records: [{ tempId: 1, objectName: 'Account', values: { Name: 'Acme', Id: '001ABC', CreatedDate: '2020-01-01' } }],
			associations: [],
		};
		const r = validateAiPlan(plan, describes());
		assert.equal(r.records.length, 1);
		assert.deepEqual(r.records[0].values, { Name: 'Acme' });
		assert.ok(r.warnings.some((w) => /Id/.test(w)));
		assert.ok(r.warnings.some((w) => /CreatedDate/.test(w)));
	});

	test('unknown field name is dropped per-field', () => {
		const plan = {
			records: [{ tempId: 1, objectName: 'Account', values: { Name: 'Acme', Bogus__c: 'x' } }],
			associations: [],
		};
		const r = validateAiPlan(plan, describes());
		assert.equal(r.records[0].values.Bogus__c, undefined);
		assert.ok(r.warnings.some((w) => /Bogus__c/.test(w)));
	});

	test('literal value in a reference field is dropped: references must come through associations', () => {
		const plan = {
			records: [{ tempId: 1, objectName: 'Contact', values: { LastName: 'Doe', AccountId: '001AAAAAAAAAAAA' } }],
			associations: [],
		};
		const r = validateAiPlan(plan, describes());
		assert.equal(r.records[0].values.AccountId, undefined, 'reference literal stripped');
		assert.ok(r.warnings.some((w) => /reference field "AccountId"/.test(w)));
	});

	test('picklist value not in allowlist is dropped (rejects "Retired", which is inactive, and unknown values)', () => {
		const plan = {
			records: [
				{ tempId: 1, objectName: 'Account', values: { Name: 'Acme', Industry: 'NotARealValue' } },
				{ tempId: 2, objectName: 'Account', values: { Name: 'Inact', Industry: 'Retired' } },
			],
			associations: [],
		};
		const r = validateAiPlan(plan, describes());
		assert.equal(r.records[0].values.Industry, undefined);
		assert.equal(r.records[1].values.Industry, undefined);
		assert.equal(r.warnings.filter((w) => /picklist "Industry"/.test(w)).length, 2);
	});

	test('multipicklist with no valid parts is dropped entirely', () => {
		const plan = {
			records: [{ tempId: 1, objectName: 'Account', values: { Name: 'Acme', Tags__c: 'X;Y;Z' } }],
			associations: [],
		};
		const r = validateAiPlan(plan, describes());
		assert.equal(r.records[0].values.Tags__c, undefined);
		assert.ok(r.warnings.some((w) => /no valid multipicklist values/.test(w)));
	});
});

describe('validateAiPlan: association drops', () => {
	test('association on a read-only reference field is dropped', () => {
		const plan = {
			records: [
				{ tempId: 1, objectName: 'Account', values: { Name: 'Acme' } },
				{ tempId: 2, objectName: 'Contact', values: { LastName: 'Doe' } },
			],
			associations: [{ fromTempId: 2, toTempId: 1, fieldName: 'ReadOnlyAccount__c' }],
		};
		const r = validateAiPlan(plan, describes());
		assert.equal(r.associations.length, 0);
		assert.ok(r.warnings.some((w) => /not createable/.test(w)));
	});

	test('association pointing at a missing tempId is dropped', () => {
		const plan = {
			records: [{ tempId: 1, objectName: 'Contact', values: { LastName: 'Doe' } }],
			associations: [{ fromTempId: 1, toTempId: 999, fieldName: 'AccountId' }],
		};
		const r = validateAiPlan(plan, describes());
		assert.equal(r.associations.length, 0);
		assert.ok(r.warnings.some((w) => /missing record/.test(w)));
	});

	test('association on a non-reference field is dropped', () => {
		const plan = {
			records: [
				{ tempId: 1, objectName: 'Account', values: { Name: 'Acme' } },
				{ tempId: 2, objectName: 'Contact', values: { LastName: 'Doe' } },
			],
			associations: [{ fromTempId: 2, toTempId: 1, fieldName: 'LastName' }],
		};
		const r = validateAiPlan(plan, describes());
		assert.equal(r.associations.length, 0);
		assert.ok(r.warnings.some((w) => /not a reference/.test(w)));
	});

	test('association whose target object type doesn\'t match referenceTo is dropped', () => {
		const plan = {
			records: [
				{ tempId: 1, objectName: 'Account', values: { Name: 'Acme' } },
				{ tempId: 2, objectName: 'Contact', values: { LastName: 'Doe' } },
			],
			associations: [{ fromTempId: 2, toTempId: 1, fieldName: 'ReportsToId' }],
		};
		const r = validateAiPlan(plan, describes());
		assert.equal(r.associations.length, 0);
		assert.ok(r.warnings.some((w) => /target type mismatch/.test(w)));
	});

	test('association on unknown field is dropped', () => {
		const plan = {
			records: [
				{ tempId: 1, objectName: 'Account', values: { Name: 'A' } },
				{ tempId: 2, objectName: 'Contact', values: { LastName: 'D' } },
			],
			associations: [{ fromTempId: 2, toTempId: 1, fieldName: 'NotARealField__c' }],
		};
		const r = validateAiPlan(plan, describes());
		assert.equal(r.associations.length, 0);
		assert.ok(r.warnings.some((w) => /not on Contact/.test(w)));
	});
});

describe('validateAiPlan: empty input', () => {
	test('empty plan returns empty arrays with no warnings', () => {
		const r = validateAiPlan({ records: [], associations: [] }, describes());
		assert.equal(r.records.length, 0);
		assert.equal(r.associations.length, 0);
		assert.equal(r.warnings.length, 0);
	});

	test('missing records/associations arrays don\'t crash', () => {
		const r = validateAiPlan({}, describes());
		assert.equal(r.records.length, 0);
		assert.equal(r.associations.length, 0);
	});
});
