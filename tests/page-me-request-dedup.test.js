import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const switcherSource = fs.readFileSync(
	path.resolve(here, '../../../apps/saas/src/public/js/workspace-switcher.js'),
	'utf8',
);
const trialSource = fs.readFileSync(path.resolve(here, '../../../apps/saas/src/public/js/trial-banner.js'), 'utf8');
const appSource = fs.readFileSync(path.resolve(here, '../src/public/js/app.js'), 'utf8');
const routesSource = fs.readFileSync(path.resolve(here, '../../../apps/saas/src/saas-routes.js'), 'utf8');
const uploadSource = fs.readFileSync(path.resolve(here, '../src/public/js/upload-modal.js'), 'utf8');

test('canvas page bootstraps share one account request', () => {
	assert.match(switcherSource, /window\.OrgLoom\.fetchMe = function fetchMe/);
	assert.match(switcherSource, /if \(!meRequest\)/);
	assert.match(trialSource, /window\.OrgLoom\.fetchMe\(\)/);
	assert.match(appSource, /window\.OrgLoom\.fetchMe\(\)/);
});

test('page bootstrap may display connection approval but uploads always use a fresh access check', () => {
	assert.match(routesSource, /approvalGate = await ext\.getCapability/);
	assert.match(routesSource, /required: approvalGate\.reason === 'approval-required'/);
	assert.match(uploadSource, /const meInfo = getMeInfo\(\)/);
	assert.doesNotMatch(uploadSource, /approvalHint/);
	assert.doesNotMatch(uploadSource, /_approvalHintConsumed/);
	assert.match(uploadSource, /csrfFetch\('\/api\/upload\/access-check'/);
	assert.match(uploadSource, /meInfo\.connection\.approval = \{ required: false, status: 'approved' \}/);
	assert.match(appSource, /getMeInfo: function \(\) \{\s*return _meInfo;/);
	assert.match(uploadSource, /renderApprovalRequired\(content, confirmBtn/);
});
