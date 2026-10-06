import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const shareSource = readFileSync(new URL('../src/public/js/canvas-share.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/public/js/app.js', import.meta.url), 'utf8');
const toolbarSource = readFileSync(new URL('../src/public/js/bulk-toolbar.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/public/css/app.css', import.meta.url), 'utf8');
const routesSource = readFileSync(new URL('../src/canvas-routes.js', import.meta.url), 'utf8');

test('share modal distinguishes plan access from an individual permission denial', () => {
	assert.match(shareSource, /const planAllowsSharing = workspacePlan === 'pro' \|\| workspacePlan === 'team'/);
	assert.match(shareSource, /Sharing is not enabled for your account/);
	assert.match(shareSource, /Ask a workspace admin to enable Share canvases/);
	assert.match(shareSource, /Sharing canvases is available on Pro and Team plans/);
	assert.doesNotMatch(shareSource, /Your current workspace is on the Free plan/);
	assert.match(appSource, /getWorkspacePlan:[\s\S]*_meInfo\.workspace\.plan/);
	assert.match(appSource, /refreshCapabilities:[\s\S]*_loadCaps\(\)\.then\(\(\) => renderBulkToolbar\(\)\)/);
});

test('share is visibly disabled before an unavailable workflow can begin', () => {
	assert.match(toolbarSource, /const shareAllowed = shareCapabilityReady && hasCapability\('share-canvas'\)/);
	assert.match(toolbarSource, /shareState = 'checking-access'/);
	assert.match(toolbarSource, /shareState = 'permission-required'/);
	assert.match(toolbarSource, /canvas-share-btn--locked/);
	assert.match(toolbarSource, /disabled aria-disabled="true"/);
	assert.match(toolbarSource, /canvas-toolbar-disabled-tip/);
	assert.match(toolbarSource, /Ask a workspace admin to enable Share canvases/);
	assert.match(toolbarSource, /Upgrade this workspace to Pro or Team to share canvases/);
	assert.match(styles, /\.canvas-toolbar-disabled-tip > button:disabled\s*{\s*pointer-events: none;/);
});

test('share routes return reason-specific permission guidance', () => {
	assert.match(routesSource, /const _SHARE_CANVAS_GATE_MESSAGES/);
	assert.match(routesSource, /'member-grant-required':[\s\S]*Sharing is not enabled for your account/);
	assert.match(routesSource, /'plan-insufficient':[\s\S]*Sharing canvases is available on Pro and Team plans/);
	assert.match(routesSource, /_gateCapability\(req, res, 'share-canvas', 'canvas_shared'/);
	assert.match(routesSource, /_gateCapability\(req, res, 'share-canvas', 'canvas_share_role_updated'/);
});

test('an open Share modal handles a later permission revocation inline', () => {
	assert.match(shareSource, /id="cs-access-msg"[\s\S]*aria-live="polite"/);
	assert.match(shareSource, /response\.status === 403/);
	assert.match(shareSource, /shareCapabilityErrors\.has\(body\.error\)/);
	assert.match(shareSource, /updateError\.shareCapabilityDenied = isShareCapabilityDenied/);
	assert.match(shareSource, /await handleShareCapabilityDenied\(error\.responseBody\)/);
	assert.match(shareSource, /shareAccessBlocked = true/);
	assert.match(shareSource, /await Promise\.resolve\(refreshCapabilities\(\)\)/);
});
