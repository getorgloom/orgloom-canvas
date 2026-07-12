import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
	connectViaSfCli,
	deployValidationRule,
	deleteValidationRule,
	cleanupTestRules,
	tryInsert,
	deleteRecord,
	waitForRuleActive,
	nextTestRuleName,
	sentinelErrorMessage,
} from './sf-helpers.js';
import { evaluateRule } from '../../src/validation-formula.js';

const RUN_LIVE = process.env.RUN_SF_LIVE === '1';
const ORG_ALIAS = process.env.SF_TEST_ORG_ALIAS;
const OBJECT_NAME = 'Account';

if (!RUN_LIVE || !ORG_ALIAS) {
	describe('validation engine: live SF integration', () => {
		test('skipped: set RUN_SF_LIVE=1 and SF_TEST_ORG_ALIAS=<alias> to enable', () => {

			assert.ok(true);
		});
	});
} else {
	let conn;
	const trackedRuleIds = [];
	const trackedRecordIds = [];

	before(async () => {
		conn = connectViaSfCli(ORG_ALIAS);

		await cleanupTestRules(conn, OBJECT_NAME);
	});

	after(async () => {

		for (const id of trackedRecordIds) {
			await deleteRecord(conn, OBJECT_NAME, id).catch(() => {});
		}
		for (const id of trackedRuleIds) {
			await deleteValidationRule(conn, id).catch(() => {});
		}
		await cleanupTestRules(conn, OBJECT_NAME).catch(() => {});
	});

	async function runRulePattern({
		ruleName,
		formula,
		failingValues,
		passingValues,
		opts,
	}) {
		const errorMessage = sentinelErrorMessage(ruleName);
		const rule = { id: null, name: ruleName, formula, errorMessage, active: true };

		const predFail = evaluateRule(rule, failingValues, opts);
		assert.equal(predFail, 'fail',
			`Engine predicted ${predFail} for failing values; expected 'fail'`);
		const predPass = evaluateRule(rule, passingValues, opts);
		assert.equal(predPass, 'pass',
			`Engine predicted ${predPass} for passing values; expected 'pass'`);

		const ruleId = await deployValidationRule(conn, {
			objectName: OBJECT_NAME, ruleName, formula, errorMessage,
		});
		trackedRuleIds.push(ruleId);
		rule.id = ruleId;

		try {

			await waitForRuleActive(conn, OBJECT_NAME, failingValues, errorMessage);

			const failResult = await tryInsert(conn, OBJECT_NAME, failingValues);
			if (failResult.ok) {

				trackedRecordIds.push(failResult.id);
				assert.fail(
					`SF accepted a record the engine predicted would fail. ` +
					`Rule: ${ruleName}, formula: ${formula}, values: ${JSON.stringify(failingValues)}`,
				);
			}
			const hasSentinel = failResult.errors.some((e) => (e.message || '').includes(errorMessage));
			assert.equal(hasSentinel, true,
				`SF rejected but not with our sentinel error. ` +
				`Rule: ${ruleName}. Errors: ${JSON.stringify(failResult.errors)}`);

			const passResult = await tryInsert(conn, OBJECT_NAME, passingValues);
			assert.equal(passResult.ok, true,
				`SF rejected a record the engine predicted would pass. ` +
				`Rule: ${ruleName}, errors: ${JSON.stringify(passResult.errors || [])}`);
			trackedRecordIds.push(passResult.id);
			await deleteRecord(conn, OBJECT_NAME, passResult.id);
		} finally {
			await deleteValidationRule(conn, ruleId).catch(() => {});
		}
	}

	describe('validation engine: live SF integration', () => {
		test('LEN comparison: Description over 50 chars fires the rule', async () => {
			await runRulePattern({
				ruleName: nextTestRuleName(),
				formula: 'LEN(Description) > 50',
				failingValues: { Name: 'OrgLoom Test', Description: 'x'.repeat(60) },
				passingValues: { Name: 'OrgLoom Test', Description: 'short' },
			});
		});

		test('ISBLANK + AND: Description required when Industry=Banking', async () => {
			await runRulePattern({
				ruleName: nextTestRuleName(),
				formula: 'AND(ISBLANK(Description), ISPICKVAL(Industry, "Banking"))',
				failingValues: { Name: 'OrgLoom Test', Industry: 'Banking' },
				passingValues: { Name: 'OrgLoom Test', Industry: 'Banking', Description: 'present' },
			});
		});

		test('numeric cap: AnnualRevenue cannot exceed $1M', async () => {
			await runRulePattern({
				ruleName: nextTestRuleName(),
				formula: 'AnnualRevenue > 1000000',
				failingValues: { Name: 'OrgLoom Test', AnnualRevenue: 1500000 },
				passingValues: { Name: 'OrgLoom Test', AnnualRevenue: 500000 },
			});
		});

		test('ISPICKVAL: Industry=Banking blocked entirely (sanity check)', async () => {
			await runRulePattern({
				ruleName: nextTestRuleName(),
				formula: 'ISPICKVAL(Industry, "Banking")',
				failingValues: { Name: 'OrgLoom Test', Industry: 'Banking' },
				passingValues: { Name: 'OrgLoom Test', Industry: 'Technology' },
			});
		});

		test('OR: either NumberOfEmployees over 10000 or AnnualRevenue over 1B', async () => {
			await runRulePattern({
				ruleName: nextTestRuleName(),
				formula: 'OR(NumberOfEmployees > 10000, AnnualRevenue > 1000000000)',
				failingValues: { Name: 'OrgLoom Test', NumberOfEmployees: 15000 },
				passingValues: { Name: 'OrgLoom Test', NumberOfEmployees: 100, AnnualRevenue: 500000 },
			});
		});

		test('NOT + ISBLANK: rule fires when Description is set (contrived)', async () => {
			await runRulePattern({
				ruleName: nextTestRuleName(),
				formula: 'NOT(ISBLANK(Description))',
				failingValues: { Name: 'OrgLoom Test', Description: 'anything' },
				passingValues: { Name: 'OrgLoom Test' },
			});
		});
	});
}
