














import { execSync } from 'node:child_process';
import jsforce from 'jsforce';

const TEST_RULE_PREFIX = 'OrgLoomTest_';












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


					SF_AUTO_UPDATE_DISABLE: 'true',
					SF_AUTOUPDATE_DISABLE: 'true',






					FORCE_COLOR: '0',
					NO_COLOR: '1',
				},
			},
		);
	} catch (err) {
		const stderr = err.stderr ? err.stderr.toString() : '';
		throw new Error(`sf org display failed for alias "${alias}": ${stderr || err.message}`);
	}



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




let _ruleCounter = 0;
export function nextTestRuleName() {
	_ruleCounter += 1;
	return `${TEST_RULE_PREFIX}${Date.now()}_${_ruleCounter}`;
}




export function sentinelErrorMessage(ruleName) {
	return `SENTINEL_${ruleName}_FAILED`;
}




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








export async function tryInsert(conn, objectName, values) {
	let result;
	try {
		result = await conn.sobject(objectName).create(values);
	} catch (err) {


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





export async function waitForRuleActive(conn, objectName, failingValues, sentinel, { tries = 8, delayMs = 500 } = {}) {
	for (let attempt = 0; attempt < tries; attempt++) {
		const r = await tryInsert(conn, objectName, failingValues);
		if (!r.ok && r.errors.some((e) => (e.message || '').includes(sentinel))) {
			return;
		}


		if (r.ok) {
await deleteRecord(conn, objectName, r.id);
}
		await new Promise((resolve) => setTimeout(resolve, delayMs));
	}
	throw new Error('Rule did not become active within ' + (tries * delayMs) + 'ms');
}
