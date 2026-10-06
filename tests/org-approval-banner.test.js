import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../src/public/js/app.js'), 'utf8');

test('the canvas blocks a connection whose Salesforce org is not allowed', () => {
	assert.match(source, /const orgAccess = _meInfo\.orgApproval/);
	assert.match(source, /const blocked = orgAccess\.blocked === true/);
	assert.match(source, /not on the workspace allowlist/);
	assert.match(source, /Current My Domain URL/);
	assert.match(source, /href="\/connect">Open Salesforce connections/);
});

test('shared-canvas recipients still see the blocking org message', () => {
	assert.match(source, /!blocked && \(\(current && current\.id && current\.ownedByMe === false\)/);
	assert.match(source, /openingSharedCanvas = \(!current \|\| !current\.id\) && params\.has\('share'\)/);
	assert.match(source, /function renderShareRecipientBanner\(\) \{[\s\S]*?renderOrgBanner\(\);/);
});

test('the live access stream refreshes access after an allowlist change', () => {
	assert.match(source, /function _subscribeWorkspaceAccessEvents\(\)/);
	assert.match(source, /\/access-events'/);
	assert.match(source, /addEventListener\('access-change'/);
	assert.match(source, /_refreshOrgApprovalState\(\)/);
	assert.match(source, /renderOrgBanner\(\)/);
});

test('the playground does not open an authenticated workspace access stream', () => {
	assert.match(
		source,
		/function _subscribeWorkspaceAccessEvents\(\) \{[\s\S]*?if \([\s\S]*?window\.ORGLOOM_MOCK \|\|/,
	);
});
