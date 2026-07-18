import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../src/public/js/related-records.js'), 'utf8');

function mountRelatedRecords(canvasState) {
	const window = {};
	vm.runInNewContext(source, { window, Map, Set });
	return window.OrgLoom.relatedRecords.mount({
		canvasState,
		escapeHtml: (value) => String(value),
		showBulkToast: () => {},
		renderBulkView: () => {},
		openTypeNode: async () => {},
		fetchRelatedCountsBatch: async () => new Map(),
		_countCacheKey: () => '',
		_relatedCountCache: new Map(),
	});
}

test('Find related falls back to an object schema when an imported card has no selection ID', () => {
	const accountSelection = {
		id: 12,
		name: 'Account',
		data: { parents: [], children: [{ object: 'Contact', field: 'AccountId' }] },
	};
	const related = mountRelatedRecords({ selectedObjects: [accountSelection], bulkRecords: [], bulkAssociations: [] });

	assert.equal(related._selectionForRecord({ objectName: 'Account', loadedFromId: '001000000000001AAA' }).id, 12);
});

test('Find related keeps an imported card bound to its exact schema selection when it exists', () => {
	const first = { id: 12, name: 'Account', data: { parents: [], children: [] } };
	const exact = { id: 13, name: 'Account', data: { parents: [], children: [] } };
	const related = mountRelatedRecords({ selectedObjects: [first, exact], bulkRecords: [], bulkAssociations: [] });

	assert.equal(
		related._selectionForRecord({ objectName: 'Account', fromSelectionId: 13, loadedFromId: '001000000000001AAA' })
			.id,
		13,
	);
});
