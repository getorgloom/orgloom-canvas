import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const menuSource = readFileSync(new URL('../src/public/js/bulk-ops-menu.js', import.meta.url), 'utf8');
const scriptSource = readFileSync(new URL('../src/public/js/bulk-script.js', import.meta.url), 'utf8');
const bulkEditSource = readFileSync(new URL('../src/public/js/bulk-edit-modal.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/public/js/app.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/public/css/app.css', import.meta.url), 'utf8');
const routesSource = readFileSync(new URL('../src/canvas-routes.js', import.meta.url), 'utf8');

test('Run script uses a disabled lock with a reason-specific tooltip', () => {
	assert.match(menuSource, /const scriptCapabilityReady = isCapabilityReady\(\)/);
	assert.match(menuSource, /Ask a workspace admin to grant you the Run script permission/);
	assert.match(menuSource, /Upgrade this workspace to Pro or Team to use Run script/);
	assert.match(menuSource, /fill-menu-disabled-tip/);
	assert.match(menuSource, /disabled aria-disabled="true"/);
	assert.doesNotMatch(menuSource, />Off</);
	assert.doesNotMatch(menuSource, /script-not-granted|script-upgrade/);
	assert.match(appSource, /bulkOpsMenu\.mount\([\s\S]*isCapabilityReady:[\s\S]*return _capsLoaded/);
	assert.match(styles, /\.fill-menu-popup \.fill-menu-disabled-tip > button:disabled\s*{\s*pointer-events: none;/);
});

test('Bulk edit remains visible as a disabled lock when permission is unavailable', () => {
	assert.match(menuSource, /const bulkEditCapabilityReady = isCapabilityReady\(\)/);
	assert.match(menuSource, /Ask a workspace admin to grant you the Bulk edit records permission/);
	assert.match(menuSource, /Upgrade this workspace to Pro or Team to use Bulk edit/);
	assert.match(menuSource, /<span aria-hidden="true">\uD83D\uDD12<\/span> Bulk edit/);
	assert.match(menuSource, /bulkEditLockTitle/);
	assert.doesNotMatch(menuSource, /const _bulkEditItem = _canBulkEdit[\s\S]*?\s:\s'';/);
});

test('Run script rechecks server permission immediately before execution', () => {
	const checkIndex = scriptSource.indexOf("csrfFetch('/api/capabilities/run-script/check'");
	const executeIndex = scriptSource.indexOf('runBulkScript(source);');
	assert.ok(checkIndex >= 0);
	assert.ok(executeIndex > checkIndex);
	assert.match(scriptSource, /response\.status === 403/);
	assert.match(scriptSource, /No changes were applied/);
	assert.match(scriptSource, /refreshCapabilities\(\)/);
	assert.match(routesSource, /app\.post\('\/api\/capabilities\/run-script\/check', requireAccount/);
	assert.match(routesSource, /_gateCapability\(req, res, 'run-script', 'run_script'/);
	assert.match(routesSource, /const _RUN_SCRIPT_GATE_MESSAGES/);
});

test('Bulk edit rechecks server permission before changing records', () => {
	const applyStart = bulkEditSource.indexOf('async function applyBulkEdit()');
	const applyEnd = bulkEditSource.indexOf('async function verifyBulkEditPermission()', applyStart);
	const applySource = bulkEditSource.slice(applyStart, applyEnd);

	assert.ok(applyStart >= 0);
	assert.ok(applyEnd > applyStart);
	assert.match(applySource, /await verifyBulkEditPermission\(\)/);
	assert.ok(applySource.indexOf('await verifyBulkEditPermission()') < applySource.indexOf('_replaceValues('));
	assert.match(bulkEditSource, /\/api\/capabilities\/bulk-edit-records\/check/);
	assert.match(bulkEditSource, /class="bulk-edit-access-error"[^>]*role="alert" hidden/);
	assert.match(bulkEditSource, /accessError\.textContent = access\.message/);
	assert.match(bulkEditSource, /No records were changed/);
	assert.match(bulkEditSource, /refreshCapabilities\(\)/);
	assert.match(routesSource, /app\.post\('\/api\/capabilities\/bulk-edit-records\/check', requireAccount/);
	assert.match(routesSource, /_gateCapability\(req, res, 'bulk-edit-records', 'bulk_edit_records'/);
});
