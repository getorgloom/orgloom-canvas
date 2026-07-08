#!/usr/bin/env node






import { connectViaSfCli, cleanupTestRules } from './sf-helpers.js';

const RUN_LIVE = process.env.RUN_SF_LIVE === '1';
const ORG_ALIAS = process.env.SF_TEST_ORG_ALIAS;
const OBJECT_NAME = process.env.SF_TEST_OBJECT || 'Account';

if (!RUN_LIVE || !ORG_ALIAS) {
	console.error('Refusing to run: set RUN_SF_LIVE=1 and SF_TEST_ORG_ALIAS=<alias>.');
	console.error('See packages/canvas/tests/integration/README.md.');
	process.exit(1);
}

const conn = connectViaSfCli(ORG_ALIAS);
console.log(`Sweeping OrgLoomTest_* rules on ${OBJECT_NAME} in org "${ORG_ALIAS}"...`);
const count = await cleanupTestRules(conn, OBJECT_NAME);
console.log(`Deleted ${count} test rule${count === 1 ? '' : 's'}.`);
