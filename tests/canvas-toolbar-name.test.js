import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const toolbarSource = readFileSync(new URL('../src/public/js/bulk-toolbar.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/public/js/app.js', import.meta.url), 'utf8');
const cssSource = readFileSync(new URL('../src/public/css/app.css', import.meta.url), 'utf8');
const saveLoadSource = readFileSync(new URL('../src/public/js/canvas-save-load.js', import.meta.url), 'utf8');

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
	assert.match(saveLoadSource, /catch \(e\) \{\s*restoreCanvasName\(\);\s*showBulkToast\('Save failed:/);
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
	assert.match(cssSource, /body\.canvas-share-banner-active \.canvas-name-overlay\s*\{\s*top: 56px/);
});
