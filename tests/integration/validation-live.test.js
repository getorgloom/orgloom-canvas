// Live integration tests for the validation-rule engine.
//
// Deliberately not run by `npm test`: guarded behind RUN_SF_LIVE=1
// (see ./README.md). Talks to a real Salesforce org via the `sf`
// CLI's existing auth.
//
// Contract being verified: for every rule the engine claims to
// support, evaluateRule's prediction matches what SF actually does
// when you POST the record. The unit suite covers the parser /
// evaluator in isolation; this suite covers "we agree with SF",
// which is the only check that matters in production.
//
// Each describe block deploys ONE rule, exercises BOTH directions
// (predicted-fail values + predicted-pass values), and cleans up. A
// suite-level after hook sweeps any leftover OrgLoomTest_* rules in
// case a test crashed mid-flight.

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

// Skip-by-default. The harness prints why so a future-you doesn't
// wonder if they're running.
if (!RUN_LIVE || !ORG_ALIAS) {
	describe('validation engine: live SF integration', () => {
		test('skipped: set RUN_SF_LIVE=1 and SF_TEST_ORG_ALIAS=<alias> to enable', () => {
			// See packages/canvas/tests/integration/README.md.
			assert.ok(true);
		});
	});
} else {
	let conn;
	const trackedRuleIds = [];
	const trackedRecordIds = [];

	before(async () => {
		conn = connectViaSfCli(ORG_ALIAS);
		// Pre-sweep: if a prior crashed run left rules around, kill them
		// before we start so their error messages don't pollute our
		// assertions about THIS run's sentinels.
		await cleanupTestRules(conn, OBJECT_NAME);
	});

	after(async () => {
		// Defense in depth. Each test already cleans up its own state,
		// but a thrown assertion bypasses the test body's try/finally.
		// Clean up by tracked IDs first, then a final sweep by prefix.
		for (const id of trackedRecordIds) {
			await deleteRecord(conn, OBJECT_NAME, id).catch(() => {});
		}
		for (const id of trackedRuleIds) {
			await deleteValidationRule(conn, id).catch(() => {});
		}
		await cleanupTestRules(conn, OBJECT_NAME).catch(() => {});
	});

	// runRulePattern: the four-step ritual described in README.md.
	// Wrapped in try/finally so the cleanup runs even if an assertion
	// throws; the tracked-id lists are the suite-level safety net.
	async function runRulePattern({
		ruleName,
		formula,
		failingValues,
		passingValues,
		opts,
	}) {
		const errorMessage = sentinelErrorMessage(ruleName);
		const rule = { id: null, name: ruleName, formula, errorMessage, active: true };

		// Engine prediction MUST be a definite pass/fail for the test to
		// be meaningful. 'unknown' means the engine doesn't support
		// something in the formula; surface a clear failure rather
		// than rubber-stamping the SF roundtrip.
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
			// Wait for SF to start enforcing: newly-created rules can lag
			// a beat. waitForRuleActive polls until the sentinel error
			// surfaces.
			await waitForRuleActive(conn, OBJECT_NAME, failingValues, errorMessage);

			// Fail path: SF rejects with our sentinel.
			const failResult = await tryInsert(conn, OBJECT_NAME, failingValues);
			if (failResult.ok) {
				// Track the unexpected row so cleanup still gets it.
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

			// Pass path: SF accepts.
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

	// ----- Test patterns -------------------------------------------------

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
