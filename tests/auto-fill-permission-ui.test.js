import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const menuSource = readFileSync(new URL('../src/public/js/bulk-ops-menu.js', import.meta.url), 'utf8');
const autoFillSource = readFileSync(new URL('../src/public/js/bulk-autofill.js', import.meta.url), 'utf8');
const routesSource = readFileSync(new URL('../src/canvas-routes.js', import.meta.url), 'utf8');

test('Auto-fill uses the concise permission label and a disabled lock', () => {
	assert.match(menuSource, /const autoFillCapabilityReady = isCapabilityReady\(\)/);
	assert.match(menuSource, /Ask a workspace admin to grant you the Auto-fill permission/);
	assert.match(menuSource, /Upgrade this workspace to Pro or Team to use Auto-fill/);
	assert.match(menuSource, /<span aria-hidden="true">\uD83D\uDD12<\/span> Auto-fill/);
	assert.doesNotMatch(menuSource, /const _autoFillItem = _canAutoFill[\s\S]*?\s:\s'';/);
});

test('Auto-fill rechecks server permission before changing records', () => {
	const fillStart = autoFillSource.indexOf('async function bulkAutoFill(');
	const permissionCheck = autoFillSource.indexOf('await verifyAutoFillPermission()', fillStart);
	const firstMutation = autoFillSource.indexOf('_replaceValues(rec, values)', fillStart);

	assert.ok(fillStart >= 0);
	assert.ok(permissionCheck > fillStart);
	assert.ok(firstMutation > permissionCheck);
	assert.match(autoFillSource, /\/api\/capabilities\/auto-fill-records\/check/);
	assert.match(autoFillSource, /response\.status === 403/);
	assert.match(autoFillSource, /refreshCapabilities\(\)/);
	assert.match(autoFillSource, /Unable to use Auto-fill/);
	assert.match(autoFillSource, /No records were changed/);
	assert.match(routesSource, /app\.post\('\/api\/capabilities\/auto-fill-records\/check', requireAccount/);
	assert.match(routesSource, /_gateCapability\(req, res, 'auto-fill-records', 'auto_fill_records'/);
});
