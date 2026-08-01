import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const toolbarSource = readFileSync(new URL('../src/public/js/bulk-toolbar.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/public/js/app.js', import.meta.url), 'utf8');
const cssSource = readFileSync(new URL('../src/public/css/app.css', import.meta.url), 'utf8');
const saveLoadSource = readFileSync(new URL('../src/public/js/canvas-save-load.js', import.meta.url), 'utf8');
const viewSource = readFileSync(new URL('../src/views/index.ejs', import.meta.url), 'utf8');

const toolbarSandbox = { window: { OrgLoom: {} } };
vm.createContext(toolbarSandbox);
vm.runInContext(toolbarSource, toolbarSandbox);
const { toolbarCanvasAccess } = toolbarSandbox.window.OrgLoom.bulkToolbar._test;

test('toolbar honors a staged Editor role before currentCanvas is installed', () => {
	assert.deepEqual({ ...toolbarCanvasAccess(null, 'editor') }, { isRecipient: true, canPersistCanvas: true });
	assert.deepEqual({ ...toolbarCanvasAccess(null, 'viewer') }, { isRecipient: true, canPersistCanvas: false });
	assert.deepEqual(
		{ ...toolbarCanvasAccess({ id: 'owned', ownedByMe: true }, null) },
		{ isRecipient: false, canPersistCanvas: true },
	);
});

test('the canvas surface identifies the active canvas by name', () => {
	assert.match(toolbarSource, /const currentCanvas = canvasState\.currentCanvas/);
	assert.match(toolbarSource, /currentCanvas\.title\.trim\(\)/);
	assert.match(toolbarSource, /: 'New canvas'/);
	assert.match(toolbarSource, /querySelector\('#canvas-name-text'\)/);
	assert.match(toolbarSource, /canvasName\.textContent = canvasTitle/);
	assert.match(toolbarSource, /renderCanvasName: renderCanvasName/);
	assert.match(appSource, /previewCanvasName: function \(name\)/);
	assert.match(saveLoadSource, /previewCanvasName\(name\)/);
	assert.match(saveLoadSource, /const restoreCanvasName = \(\) => previewCanvasName\(previousCanvasTitle\)/);
	assert.match(
		saveLoadSource,
		/catch \(e\) \{\s*restoreCanvasName\(\);\s*canvasSaveState\.markFailed\(e\.message \|\| e\);\s*showBulkToast\('Save failed:/,
	);
	assert.match(
		appSource,
		/class="canvas-name-overlay" id="canvas-name-overlay"[\s\S]*class="canvas-top-left-overlays"[\s\S]*id="canvas-status-strip"/,
	);
	assert.match(appSource, /id="canvas-name-text">New canvas/);
	assert.doesNotMatch(appSource, /canvas-name-overlay-label/);
	const overlayRule = cssSource.match(/\.canvas-name-overlay\s*\{([^}]*)\}/);
	assert.ok(overlayRule);
	assert.match(overlayRule[1], /position: absolute/);
	assert.match(overlayRule[1], /left: 50%/);
	assert.match(overlayRule[1], /text-align: center/);
	assert.match(overlayRule[1], /transform: translateX\(-50%\)/);
	assert.doesNotMatch(overlayRule[1], /right:/);
	assert.match(cssSource, /\.canvas-name-overlay strong/);
	assert.doesNotMatch(cssSource, /body\.canvas-share-banner-active \.canvas-name-overlay\s*\{/);
});

test('the canvas surface makes save state and the primary save action explicit', () => {
	assert.match(viewSource, /\/js\/canvas-save-state\.js/);
	assert.match(toolbarSource, /return 'Unsaved changes'/);
	assert.match(toolbarSource, /return 'Save failed \\u00B7 Try again'/);
	assert.match(toolbarSource, /data-bulk-save-primary/);
	assert.match(toolbarSource, /Save \/ export \\u25BC/);
	assert.match(appSource, /_canvasSaveState\.refresh\(\)/);
	assert.match(appSource, /cmd && \(e\.key === 's' \|\| e\.key === 'S'\)/);
	assert.match(saveLoadSource, /saveLabel: 'Save and continue'/);
	assert.match(saveLoadSource, /discardLabel: 'Continue without saving'/);
	assert.doesNotMatch(appSource, /id="canvas-save-status"/);
	assert.match(appSource, /id="canvas-save-status-overlay"/);
	assert.match(toolbarSource, /canvas-save-status-overlay canvas-save-status-overlay--/);
	assert.match(toolbarSource, /'Save canvas'/);
	assert.doesNotMatch(toolbarSource, /canvas-save-primary[\s\S]{0,120}batch-btn-accent/);
	assert.match(cssSource, /\.canvas-save-status-overlay--dirty/);
	assert.match(cssSource, /\.canvas-save-status-overlay\s*\{[\s\S]*right: 18px/);
	assert.doesNotMatch(cssSource, /body\.canvas-share-banner-active \.canvas-save-status-overlay\s*\{/);
	assert.match(appSource, /subbar\.insertAdjacentElement\('afterend', host\)/);
	const shareBannerRule = cssSource.match(/\.share-recipient-banner\s*\{([^}]*)\}/);
	assert.ok(shareBannerRule);
	assert.match(shareBannerRule[1], /position: relative/);
	assert.doesNotMatch(shareBannerRule[1], /position: fixed/);
	assert.match(cssSource, /\.canvas-save-control\s*\{[\s\S]*background: var\(--bg-inset\)/);
});
