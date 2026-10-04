import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fetchToolingValidationRuleRecords, transformToolingRecords } from '../src/validation-rules.js';

const RULE_ID_1 = '03d000000000001AAA';
const RULE_ID_2 = '03d000000000002AAA';

describe('fetchToolingValidationRuleRecords', () => {
	test('discovers IDs, then retrieves metadata one rule at a time', async () => {
		const detailById = new Map([
			[RULE_ID_1, row({ id: RULE_ID_1, name: 'First_Rule' })],
			[RULE_ID_2, row({ id: RULE_ID_2, name: 'Second_Rule' })],
		]);
		const queries = [];
		const tooling = {
			async query(soql) {
				queries.push(soql);
				if (queries.length === 1) {
					return { records: [{ Id: RULE_ID_1 }, { Id: RULE_ID_2 }] };
				}
				const id = [...detailById.keys()].find((candidate) => soql.includes(candidate));
				return { records: id ? [detailById.get(id)] : [] };
			},
		};

		const records = await fetchToolingValidationRuleRecords(tooling, 'Account');

		assert.equal(queries.length, 3);
		assert.equal(queries[0], "SELECT Id FROM ValidationRule WHERE EntityDefinition.QualifiedApiName = 'Account'");
		assert.equal(queries[0].includes('Metadata'), false);
		assert.equal(queries[0].includes('FullName'), false);
		for (const id of [RULE_ID_1, RULE_ID_2]) {
			assert.equal(
				queries.includes(`SELECT Id, FullName, Metadata FROM ValidationRule WHERE Id = '${id}' LIMIT 1`),
				true,
			);
		}
		assert.deepEqual(records, [detailById.get(RULE_ID_1), detailById.get(RULE_ID_2)]);
	});

	test('returns an empty list without metadata queries when the object has no rules', async () => {
		let queryCount = 0;
		const records = await fetchToolingValidationRuleRecords(
			{
				async query() {
					queryCount += 1;
					return { records: [] };
				},
			},
			'Contact',
		);

		assert.deepEqual(records, []);
		assert.equal(queryCount, 1);
	});

	test('ignores malformed IDs and retrieves duplicate IDs only once', async () => {
		const queries = [];
		const tooling = {
			async query(soql) {
				queries.push(soql);
				if (queries.length === 1) {
					return {
						records: [{ Id: RULE_ID_1 }, { Id: RULE_ID_1 }, { Id: "bad'id" }, { Id: null }],
					};
				}
				return { records: [row({ id: RULE_ID_1, name: 'Only_Rule' })] };
			},
		};

		const records = await fetchToolingValidationRuleRecords(tooling, 'Account');

		assert.equal(queries.length, 2);
		assert.equal(records.length, 1);
	});

	test('limits concurrent metadata queries', async () => {
		const ids = Array.from({ length: 5 }, (_, index) => `03d00000000000${index + 1}AAA`);
		let firstQuery = true;
		let active = 0;
		let maxActive = 0;
		const tooling = {
			async query(soql) {
				if (firstQuery) {
					firstQuery = false;
					return { records: ids.map((Id) => ({ Id })) };
				}
				active += 1;
				maxActive = Math.max(maxActive, active);
				await new Promise((resolve) => setTimeout(resolve, 5));
				active -= 1;
				const id = ids.find((candidate) => soql.includes(candidate));
				return { records: [row({ id, name: id })] };
			},
		};

		const records = await fetchToolingValidationRuleRecords(tooling, 'Account', {
			concurrency: 2,
		});

		assert.equal(records.length, 5);
		assert.equal(maxActive, 2);
	});
});

function row({
	id = '03dxxx',
	fullName = 'Account.Rule',
	name,
	active = true,
	description = null,
	errorMessage = null,
	errorDisplayField = null,
	formula = null,
	metadataNull = false,
} = {}) {
	if (metadataNull) {
		return { Id: id, FullName: fullName, Metadata: null };
	}
	return {
		Id: id,
		FullName: fullName,
		Metadata: {
			name,
			active,
			description,
			errorMessage,
			errorDisplayField,
			errorConditionFormula: formula,
		},
	};
}

describe('transformToolingRecords: input shapes', () => {
	test('returns [] for null / undefined / non-array input', () => {
		assert.deepEqual(transformToolingRecords(null), []);
		assert.deepEqual(transformToolingRecords(undefined), []);
		assert.deepEqual(transformToolingRecords('not an array'), []);
	});

	test('returns [] for an empty array', () => {
		assert.deepEqual(transformToolingRecords([]), []);
	});

	test('drops rows whose Metadata is null', () => {
		const out = transformToolingRecords([row({ name: 'real_rule' }), row({ metadataNull: true })]);
		assert.equal(out.length, 1);
		assert.equal(out[0].name, 'real_rule');
	});

	test('drops rows that are entirely null / not-objects (defensive)', () => {
		const out = transformToolingRecords([null, 42, row({ name: 'ok' })]);
		assert.equal(out.length, 1);
		assert.equal(out[0].name, 'ok');
	});
});

describe('transformToolingRecords: active filter', () => {
	test('keeps active=true rules', () => {
		const out = transformToolingRecords([row({ name: 'a', active: true })]);
		assert.equal(out.length, 1);
	});

	test('drops active=false rules', () => {
		const out = transformToolingRecords([
			row({ name: 'inactive', active: false }),
			row({ name: 'active', active: true }),
		]);
		assert.equal(out.length, 1);
		assert.equal(out[0].name, 'active');
	});

	test('drops rules where active is missing (treats as false)', () => {
		const rec = row({ name: 'string_active' });
		rec.Metadata.active = 'true';
		const out = transformToolingRecords([rec]);
		assert.equal(out.length, 0);
	});

	test('drops rules where active is truthy but not strictly true', () => {
		const rec = row({ name: 'one_active' });
		rec.Metadata.active = 1;
		assert.equal(transformToolingRecords([rec]).length, 0);
	});
});

describe('transformToolingRecords: field mapping', () => {
	test('passes every documented field through to the normalized shape', () => {
		const out = transformToolingRecords([
			row({
				id: '03d001',
				fullName: 'Account.MyRule',
				name: 'MyRule',
				active: true,
				description: 'a description',
				errorMessage: 'an error',
				errorDisplayField: 'SSN__c',
				formula: 'LEN(SSN__c) <> 9',
			}),
		]);
		assert.deepEqual(out, [
			{
				id: '03d001',
				name: 'MyRule',
				active: true,
				description: 'a description',
				errorMessage: 'an error',
				errorDisplayField: 'SSN__c',
				formula: 'LEN(SSN__c) <> 9',
			},
		]);
	});

	test('renames errorConditionFormula → formula', () => {
		const out = transformToolingRecords([row({ name: 'r', formula: 'TRUE' })]);
		assert.equal(out[0].formula, 'TRUE');
		assert.equal('errorConditionFormula' in out[0], false);
	});

	test('preserves null/undefined fields without throwing', () => {
		const out = transformToolingRecords([
			row({
				name: 'minimal',
				active: true,
				description: null,
				errorMessage: null,
				errorDisplayField: null,
				formula: null,
			}),
		]);
		assert.equal(out[0].description, null);
		assert.equal(out[0].errorMessage, null);
		assert.equal(out[0].errorDisplayField, null);
		assert.equal(out[0].formula, null);
	});

	test('falls back to FullName-derived name when Metadata.name is missing', () => {
		const out = transformToolingRecords([row({ name: undefined, fullName: 'Account.SSN_Validation' })]);
		assert.equal(out[0].name, 'SSN_Validation');
	});

	test('handles multi-dot FullName by joining everything after the first segment', () => {
		const out = transformToolingRecords([row({ name: undefined, fullName: 'Account.Sub.Rule' })]);
		assert.equal(out[0].name, 'Sub.Rule');
	});

	test('returns name as null when both Metadata.name and FullName are missing', () => {
		const out = transformToolingRecords([row({ name: undefined, fullName: null })]);
		assert.equal(out[0].name, null);
	});
});

describe('transformToolingRecords: sorting', () => {
	test('sorts active rules by name (case-sensitive locale compare)', () => {
		const out = transformToolingRecords([
			row({ name: 'zeta_rule' }),
			row({ name: 'alpha_rule' }),
			row({ name: 'mu_rule' }),
		]);
		assert.deepEqual(
			out.map((r) => r.name),
			['alpha_rule', 'mu_rule', 'zeta_rule'],
		);
	});

	test('rules with null names sort before everything else', () => {
		const out = transformToolingRecords([
			row({ name: 'beta' }),
			row({ name: undefined, fullName: null }),
			row({ name: 'alpha' }),
		]);
		assert.equal(out[0].name, null);
		assert.equal(out[1].name, 'alpha');
		assert.equal(out[2].name, 'beta');
	});

	test('sort is stable across the active filter', () => {
		const out = transformToolingRecords([
			row({ name: 'gamma', active: false }),
			row({ name: 'alpha', active: true }),
			row({ name: 'beta', active: false }),
			row({ name: 'delta', active: true }),
		]);
		assert.deepEqual(
			out.map((r) => r.name),
			['alpha', 'delta'],
		);
	});
});

describe('transformToolingRecords: realistic Tooling-API responses', () => {
	test('two active rules + one inactive → only the actives, sorted', () => {
		const out = transformToolingRecords([
			{
				Id: '03d001',
				FullName: 'Account.Description_Required',
				Metadata: {
					name: 'Description_Required',
					active: true,
					description: 'Important accounts need a description.',
					errorMessage: 'Description is required for Important accounts.',
					errorDisplayField: 'Description',
					errorConditionFormula: 'AND(ISBLANK(Description), Type = "Important")',
				},
			},
			{
				Id: '03d002',
				FullName: 'Account.Old_Defunct_Rule',
				Metadata: {
					name: 'Old_Defunct_Rule',
					active: false,
					description: 'No longer enforced.',
					errorMessage: 'This rule should not surface to users.',
					errorDisplayField: null,
					errorConditionFormula: 'TRUE',
				},
			},
			{
				Id: '03d003',
				FullName: 'Account.Annual_Revenue_Cap',
				Metadata: {
					name: 'Annual_Revenue_Cap',
					active: true,
					description: 'AnnualRevenue cannot exceed $1B.',
					errorMessage: 'AnnualRevenue cannot exceed 1,000,000,000.',
					errorDisplayField: 'AnnualRevenue',
					errorConditionFormula: 'AnnualRevenue > 1000000000',
				},
			},
		]);
		assert.equal(out.length, 2);
		assert.deepEqual(
			out.map((r) => r.name),
			['Annual_Revenue_Cap', 'Description_Required'],
		);
		assert.equal(
			out.every((r) => r.formula !== 'TRUE'),
			true,
		);
	});
});
