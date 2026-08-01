import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../src/public/js/app.js', import.meta.url), 'utf8');
const routeSource = readFileSync(new URL('../src/canvas-routes.js', import.meta.url), 'utf8');
const dialogsSource = readFileSync(new URL('../src/public/js/ui-dialogs.js', import.meta.url), 'utf8');
const cssSource = readFileSync(new URL('../src/public/css/app.css', import.meta.url), 'utf8');

test('openCanvas is a one-time launch parameter rather than persistent canvas identity', () => {
	const start = source.indexOf('(function autoOpenLinkedCanvas()');
	const end = source.indexOf('\n\t})();', start);
	assert.ok(start >= 0 && end > start, 'openCanvas launch handler should be present');
	const handler = source.slice(start, end);

	assert.match(handler, /finally \{\s*clearCanvasLaunchParam\('openCanvas'\)/);
	assert.match(handler, /!\S+\.test\(openId\)[\s\S]*clearCanvasLaunchParam\('openCanvas'\)/);
	assert.match(handler, /This canvas link is invalid/);
});

test('clearing a canvas launch parameter preserves unrelated URL state', () => {
	const start = source.indexOf('function clearCanvasLaunchParam(name)');
	const end = source.indexOf('\n\t}', start);
	assert.ok(start >= 0 && end > start, 'launch-parameter cleanup helper should be present');
	const helper = source.slice(start, end);

	assert.match(helper, /params\.delete\(name\)/);
	assert.match(helper, /const query = params\.toString\(\)/);
	assert.match(helper, /window\.location\.pathname \+ \(query \? '\?' \+ query : ''\) \+ window\.location\.hash/);
});

test('a launch-link result is not masked by the routine session-restore notice', () => {
	assert.match(source, /let _hasCanvasLaunchRequest = !!\(/);
	assert.match(
		source,
		/\(_restored \|\| _quickUploadRestored\)[\s\S]*!_hasCanvasLaunchRequest[\s\S]*Restored your unsaved canvas from this tab/,
	);
	assert.match(
		source,
		/Org Loom could not open this canvas\. It may have been deleted, or it may not be shared with your current Salesforce user\. Your current canvas has not changed\./,
	);
	assert.match(
		source,
		/function showCanvasLaunchError\(message\)[\s\S]*window\.olAlert[\s\S]*title: 'Canvas unavailable'[\s\S]*showConfirm: false/,
	);
	assert.doesNotMatch(source, /Stay on current canvas/);
	assert.match(dialogsSource, /showConfirm === false[\s\S]*const footerHtml/);
	assert.match(dialogsSource, /input \|\| confirmButton \|\| modal\.querySelector\('\.modal-close'\)/);
});

test('a same-org Salesforce user switch reopens the canvas through the launch authorization path', () => {
	assert.match(source, /const _userSwitchCanvasId = _autosave\.consumeUserSwitchCanvasId\(\)/);
	assert.match(source, /_canvasLaunchParamsAtLoad\.set\('openCanvas', _userSwitchCanvasId\)/);
	assert.match(source, /_hasCanvasLaunchRequest = true/);
});

test('shared and direct canvas links hide the previous canvas until replacement finishes', () => {
	assert.match(
		source,
		/function beginCanvasReplacementLoad\(message\)[\s\S]*mask\.hidden = false[\s\S]*return function finishCanvasReplacementLoad/,
	);

	for (const handlerName of ['autoOpenSharedCanvas', 'autoOpenLinkedCanvas']) {
		const start = source.indexOf('(function ' + handlerName + '()');
		const end = source.indexOf('\n\t})();', start);
		assert.ok(start >= 0 && end > start, handlerName + ' should be present');
		const handler = source.slice(start, end);
		assert.match(handler, /beginCanvasReplacementLoad\(/);
		assert.match(handler, /finally \{[\s\S]*finishCanvasLoad\(\)/);
	}

	assert.match(cssSource, /\.canvas-replacement-loading \{[\s\S]*position: fixed;[\s\S]*inset: 0;/);
	assert.match(cssSource, /\.canvas-replacement-loading\[hidden\] \{\s*display: none;/);
});

test('Salesforce not-found responses become a clean inaccessible-canvas response', () => {
	assert.match(
		routeSource,
		/function _isCanvasUnavailableError\(error\)[\s\S]*error\.errorCode[\s\S]*code === 'NOT_FOUND'/,
	);
	const loadStart = routeSource.indexOf("app.get('/api/canvas/:id'");
	const loadEnd = routeSource.indexOf("app.post('/api/canvas'", loadStart);
	const loadRoute = routeSource.slice(loadStart, loadEnd);
	assert.match(loadRoute, /_isCanvasUnavailableError\(error\)/);
	assert.match(loadRoute, /status\(404\)\.json\(\{[\s\S]*error: 'canvas-not-accessible'/);
});
