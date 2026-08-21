import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../src/public/js/app.js'), 'utf8');

test('approval banner labels sandbox and developer connections as non-production', () => {
	assert.match(source, /_meInfo\.connection && _meInfo\.connection\.approval/);
	assert.match(source, /_meInfo\.orgType === 'sandbox' \|\| _meInfo\.orgType === 'developer'/);
	assert.match(source, /\? 'non-production org'/);
	assert.doesNotMatch(source, /'Writes to this production org'/);
});

test('every required org approval state renders as blocked', () => {
	assert.match(source, /const blocked = approval\.required;/);
});

test('org approval banner is hidden for every shared-canvas recipient role', () => {
	assert.match(source, /current && current\.id && current\.ownedByMe === false/);
	assert.match(source, /openingSharedCanvas = \(!current \|\| !current\.id\) && params\.has\('share'\)/);
	assert.match(source, /function renderShareRecipientBanner\(\) \{[\s\S]*?renderOrgBanner\(\);/);
	assert.doesNotMatch(source, /recipientRole === 'contributor'[\s\S]*pending admin approval/);
});

test('missing approval offers an explicit, idempotent access request', () => {
	assert.match(source, /else if \(approval\.status === 'pending'\)/);
	assert.match(source, /data-request-org-access/);
	assert.match(source, /csrfFetch\('\/api\/upload\/access-check'/);
	assert.match(source, /body\.error === 'approval-required' && body\.approvalStatus === 'pending'/);
	assert.match(source, /status: 'pending'/);
});

test('the live access stream reconciles on reconnect and tab focus without polling', () => {
	assert.match(source, /addEventListener\('open'/);
	assert.match(source, /function _refreshOrgApprovalState\(\)/);
	assert.match(source, /csrfFetch\('\/api\/me'/);
	assert.match(source, /addEventListener\('visibilitychange'/);
	assert.doesNotMatch(source, /_orgApprovalPollTimer/);
	assert.doesNotMatch(source, /_watchPendingOrgApproval/);
});

test('the playground does not open an authenticated workspace access stream', () => {
	assert.match(
		source,
		/function _subscribeWorkspaceAccessEvents\(\) \{[\s\S]*?if \([\s\S]*?window\.ORGLOOM_MOCK \|\|/,
	);
});

test('later grants and revocations are pushed to an already-open canvas', () => {
	assert.match(source, /function _subscribeWorkspaceAccessEvents\(\)/);
	assert.match(source, /\/access-events'/);
	assert.match(source, /addEventListener\('access-change'/);
	assert.match(source, /required: status !== 'approved'/);
	assert.match(source, /renderOrgBanner\(\)/);
});
