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
const { findImportSpace } = window.OrgLoom.treeLayout._test;

test('imports use free space in the current viewport, including negative canvas coordinates', () => {
	const space = findImportSpace(200, 100, [], { x: -400, y: -300 });
	assert.equal(space.x, -500);
	assert.equal(space.y, -350);
});

test('a link crossing otherwise empty space keeps the imported group out of that area', () => {
	const boxes = [
		{ x1: -500, y1: -50, x2: -300, y2: 50 },
		{ x1: 300, y1: -50, x2: 500, y2: 50 },
		{ x1: -300, y1: -10, x2: 300, y2: 200 },
	];
	const space = findImportSpace(200, 100, boxes, { x: 0, y: 0 });
	assert(
		boxes.every(
			(b) =>
				space.x + 200 <= b.x1 - 80 ||
				space.x >= b.x2 + 80 ||
				space.y + 100 <= b.y1 - 80 ||
				space.y >= b.y2 + 80,
		),
	);
	assert.equal(space.x, -100, 'uses nearby space above the link instead of the far side of the canvas');
	assert.equal(space.y, -190);
});

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
