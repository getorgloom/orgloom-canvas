// Shared helpers for the live SF integration tests. Three things:
//
//   1. Read auth out of the `sf` CLI's local org config. No password
//      / OAuth plumbing in test code: if you can `sf org display
//      --target-org X`, the tests can talk to X.
//
//   2. Deploy + delete ValidationRule records via the Tooling API.
//      Tooling SObjects support REST CRUD which is much simpler than
//      Metadata API deployRequest plumbing. Limitation: the rule
//      becomes enforced ~1-2s after create on first DML; we add a
//      small retry on the first assertion against it.
//
//   3. Track every record + rule we created so a single after-hook
//      can clean up even when tests throw mid-flight.

import { execSync } from 'node:child_process';
import jsforce from 'jsforce';

const TEST_RULE_PREFIX = 'OrgLoomTest_';

// Connect to the SF org `sf` already has auth for. Throws if the
// alias doesn't exist or sf returns a malformed response.
//
// Defensive parsing: on Windows the `sf` CLI sometimes leaks an
// update-available banner ahead of its JSON output even with --json
// set. Pre-strip everything before the first `{` so the parse
// doesn't die on that. The SF_AUTO_UPDATE_DISABLE env var also
// suppresses the auto-update probe entirely; we set it for the
// child process. On parse failure we include the first 300 chars
// of the actual stdout so future-you can diagnose without
// re-instrumenting.
export function connectViaSfCli(alias) {
	if (!alias) {
throw new Error('alias required');
}
	let stdout;
	try {
		stdout = execSync(
			`sf org display --target-org ${alias} --json`,
			{
				encoding: 'utf8',
				stdio: ['pipe', 'pipe', 'pipe'],
				env: {
					...process.env,
					// Suppress the auto-update probe so its banner doesn't
					// leak ahead of the JSON.
					SF_AUTO_UPDATE_DISABLE: 'true',
					SF_AUTOUPDATE_DISABLE: 'true',
					// Force monochrome output. `sf` on Windows-via-cmd.exe
					// embeds ANSI color escapes inside its `--json` payload
					// when it thinks the parent is a TTY (this is an
					// upstream bug: colorization should be off for --json).
					// FORCE_COLOR=0 is honored by oclif's color layer; NO_COLOR
					// is the wider standard.
					FORCE_COLOR: '0',
					NO_COLOR: '1',
				},
			},
		);
	} catch (err) {
		const stderr = err.stderr ? err.stderr.toString() : '';
		throw new Error(`sf org display failed for alias "${alias}": ${stderr || err.message}`);
	}
	// Strip ANSI color escape sequences even if FORCE_COLOR / NO_COLOR
	// didn't take: defense in depth against any oclif/sf version where
	// the colorization-suppression env vars get ignored.
	const stripped = stdout.replace(/\[[0-9;]*m/g, '');
	const startIdx = stripped.indexOf('{');
	if (startIdx < 0) {
		throw new Error(
			`sf org display returned no JSON object. First 300 chars of stripped stdout: ${JSON.stringify(stripped.slice(0, 300))}`,
		);
	}
	const jsonText = stripped.slice(startIdx);
	let parsed;
	try {
 parsed = JSON.parse(jsonText); 
} catch (_e) {
		throw new Error(
			`sf org display did not return parseable JSON. First 300 chars of stripped stdout: ${JSON.stringify(stripped.slice(0, 300))}`,
		);
	}
	const r = parsed && parsed.result;
	if (!r || !r.accessToken || !r.instanceUrl) {
		throw new Error(
			'sf org display did not return accessToken/instanceUrl. Parsed payload keys: '
			+ Object.keys((parsed && parsed.result) || parsed || {}).join(', '),
		);
	}
	return new jsforce.Connection({
		accessToken: r.accessToken,
		instanceUrl: r.instanceUrl,
		version: r.apiVersion || '60.0',
	});
}

// Generate a unique ValidationRule name within the test run. Combines
// a timestamp + a counter so back-to-back tests don't collide and a
// crashed previous run's leftover rules don't shadow this run's.
let _ruleCounter = 0;
export function nextTestRuleName() {
	_ruleCounter += 1;
	return `${TEST_RULE_PREFIX}${Date.now()}_${_ruleCounter}`;
}

// Sentinel error-message generator. Unique per test so we can match
// SF's rejection error against the rule we deployed without false-
// matching some other rule the org happens to have.
export function sentinelErrorMessage(ruleName) {
	return `SENTINEL_${ruleName}_FAILED`;
}

// Create a ValidationRule on `objectName` via the Tooling API and
// return its Id. Caller is responsible for cleanup (push to a list
// and pass through deleteAll in after hook).
export async function deployValidationRule(conn, { objectName, ruleName, formula, errorMessage, description = 'OrgLoom integration test' }) {
	const result = await conn.tooling.sobject('ValidationRule').create({
		FullName: `${objectName}.${ruleName}`,
		Metadata: {
			active: true,
			description,
			errorConditionFormula: formula,
			errorMessage,
			errorDisplayField: null,
		},
	});
	if (!result || !result.success) {
		const errs = (result && result.errors) || [];
		throw new Error('Failed to create ValidationRule: ' + JSON.stringify(errs));
	}
	return result.id;
}

// Tooling-API delete. Idempotent against not-found (we ignore the
// NOT_FOUND errorCode so cleanup paths can run after the test
// already deleted the rule).
export async function deleteValidationRule(conn, ruleId) {
	if (!ruleId) {
return;
}
	try {
		await conn.tooling.sobject('ValidationRule').destroy(ruleId);
	} catch (e) {
		if (e && (e.errorCode === 'NOT_FOUND' || e.errorCode === 'INVALID_CROSS_REFERENCE_KEY')) {
return;
}
		throw e;
	}
}

// Sweep for any test-leftover rules on the given object and delete
// them. Use both as the after-hook and as a manual cleanup entry
// point if a previous run crashed without cleanup.
export async function cleanupTestRules(conn, objectName) {
	const soql = `SELECT Id, FullName FROM ValidationRule WHERE EntityDefinition.QualifiedApiName = '${objectName}'`;
	const result = await conn.tooling.query(soql);
	const ids = (result.records || [])
		.filter((r) => {
			const tail = (r.FullName || '').split('.').pop() || '';
			return tail.startsWith(TEST_RULE_PREFIX);
		})
		.map((r) => r.Id);
	for (const id of ids) {
await deleteValidationRule(conn, id);
}
	return ids.length;
}

// Attempt an insert; return SF's verdict in a normalized shape.
//   { ok: true, id } (accepted)
//   { ok: false, errors: [{message, statusCode}] } (rejected)
// jsforce 3.x throws on validation failures (it surfaces them as
// errors with statusCode FIELD_CUSTOM_VALIDATION_EXCEPTION). We
// normalize both shapes so callers don't have to try/catch every
// insert site.
export async function tryInsert(conn, objectName, values) {
	let result;
	try {
		result = await conn.sobject(objectName).create(values);
	} catch (err) {
		// jsforce surfaces SF errors as throws in some builds; in others
		// it returns a non-success result. Normalize both.
		const errs = err && err.errors
			? err.errors
			: [{ message: err.message || String(err), statusCode: err.errorCode || 'UNKNOWN' }];
		return { ok: false, errors: errs };
	}
	if (result && result.success) {
return { ok: true, id: result.id };
}
	const errs = (result && result.errors) || [];
	return { ok: false, errors: errs };
}

// Delete a record by id. Idempotent against not-found.
export async function deleteRecord(conn, objectName, recordId) {
	if (!recordId) {
return;
}
	try {
		await conn.sobject(objectName).destroy(recordId);
	} catch (e) {
		if (e && (e.errorCode === 'ENTITY_IS_DELETED' || e.errorCode === 'NOT_FOUND')) {
return;
}
		throw e;
	}
}

// Wait for a newly-deployed rule to take effect. SF normally
// enforces it on the very next DML, but in practice we've seen
// 1-2s lag in scratch orgs. Poll by attempting the failing-values
// insert until SF returns our sentinel error.
export async function waitForRuleActive(conn, objectName, failingValues, sentinel, { tries = 8, delayMs = 500 } = {}) {
	for (let attempt = 0; attempt < tries; attempt++) {
		const r = await tryInsert(conn, objectName, failingValues);
		if (!r.ok && r.errors.some((e) => (e.message || '').includes(sentinel))) {
			return; // Active.
		}
		// If the insert succeeded, the rule isn't enforced yet, so delete the
		// stray record (otherwise it'd leak) and retry after a delay.
		if (r.ok) {
await deleteRecord(conn, objectName, r.id);
}
		await new Promise((resolve) => setTimeout(resolve, delayMs));
	}
	throw new Error('Rule did not become active within ' + (tries * delayMs) + 'ms');
}
