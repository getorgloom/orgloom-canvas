import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../src/public/js/records-canvas.js'), 'utf8');

test('inline resize handles claim the gesture before FK edge hit-testing', () => {
	const captureMatch = source.match(
		/document\.addEventListener\(\s*'mousedown',\s*\(ev\) => \{([\s\S]*?)\},\s*true(?:\s*\/\*[\s\S]*?\*\/)?\s*,?\s*\);/,
	);
	const captureHandler = captureMatch ? captureMatch[1] : '';

	const resizeGuard = captureHandler.indexOf('_isInlineResizeHandleTarget(ev.target)');
	const edgeHitTest = captureHandler.indexOf('_findEdgeTargetAt(ev.clientX, ev.clientY)');

	assert.ok(captureMatch, 'capture-phase mousedown handler exists');
	assert.notEqual(resizeGuard, -1, 'capture handler yields to an inline resize handle');
	assert.notEqual(edgeHitTest, -1, 'capture handler still performs FK edge hit-testing');
	assert.ok(resizeGuard < edgeHitTest, 'resize guard runs before FK hit-testing');
});

test('hovering an inline resize handle clears the FK-link affordance', () => {
	const hoverStart = source.indexOf("document.addEventListener('mousemove', (ev) => {");
	const hoverEnd = source.indexOf("document.addEventListener('mousedown', (ev) => {", hoverStart);
	const hoverHandler = source.slice(hoverStart, hoverEnd);

	assert.match(
		hoverHandler,
		/_isInlineResizeHandleTarget\(ev\.target\)[\s\S]*classList\.remove\('cy-edge-hover'\)[\s\S]*_setEdgeHoverCard\(null\)/,
	);
});
