import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../src/public/js/tree-layout.js'), 'utf8');
const window = {};
vm.runInNewContext(source, { window, Set, Math });
const { componentLayoutName, compactGridColumns, minimumOverviewZoom } = window.OrgLoom.treeLayout._test;

test('small tree-like components retain the relationship-oriented layout', () => {
	assert.equal(componentLayoutName(12, 11), 'breadthfirst');
});

test('large or densely linked imports use a bounded grid layout', () => {
	assert.equal(componentLayoutName(51, 50), 'grid');
	assert.equal(componentLayoutName(20, 25), 'grid');
	assert.equal(compactGridColumns(51), 6);
});

test('large imports retain the fit-all overview instead of forcing a zoomed-in viewport', () => {
	assert.equal(minimumOverviewZoom(99), 0.4);
	assert.equal(minimumOverviewZoom(100), 0);
	assert.equal(minimumOverviewZoom(500), 0);
});
