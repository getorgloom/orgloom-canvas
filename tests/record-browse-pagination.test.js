import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/public/js/record-browse.js', import.meta.url), 'utf8');
const anchor = '\twindow.OrgLoom.recordBrowse = {';
assert.ok(source.includes(anchor), 'record-browse test injection anchor must remain available');

const instrumented = source.replace(anchor, '\twindow.__browsePageWindow = _browsePageWindow;\n\n' + anchor);
const context = { window: { OrgLoom: {} } };
vm.runInNewContext(instrumented, context);
const pageWindow = context.window.__browsePageWindow;

test('Browse pagination clamps an offset beyond the final page', () => {
	assert.equal(pageWindow(31, 25, 50, 0).offset, 25);
});

test('Browse pagination describes the final partial page and disables Next', () => {
	assert.deepEqual(
		{ ...pageWindow(31, 25, 25, 6) },
		{ offset: 25, start: 26, end: 31, hasPrev: true, hasMore: false },
	);
});

test('Browse pagination handles empty and single-page result sets', () => {
	assert.deepEqual({ ...pageWindow(0, 25, 50, 0) }, { offset: 0, start: 0, end: 0, hasPrev: false, hasMore: false });
	assert.deepEqual(
		{ ...pageWindow(12, 25, 0, 12) },
		{ offset: 0, start: 1, end: 12, hasPrev: false, hasMore: false },
	);
});
