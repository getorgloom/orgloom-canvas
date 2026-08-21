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

test('Find related typeahead matches object labels and API names', () => {
	const related = mountRelatedRecords({ selectedObjects: [], bulkRecords: [], bulkAssociations: [] });
	const items = [
		{ label: 'Account', objectName: 'Account' },
		{ label: 'OLQA Work Item', objectName: 'OLQA_Work_Item__c' },
		{ label: 'Contact Roles', objectName: 'OpportunityContactRole' },
	];

	assert.equal(related._findRelatedTypeaheadMatchIndex(items, 'acc'), 0);
	assert.equal(related._findRelatedTypeaheadMatchIndex(items, 'olqawork'), 1);
	assert.equal(related._findRelatedTypeaheadMatchIndex(items, 'opportunitycontact'), 2);
	assert.equal(related._findRelatedTypeaheadMatchIndex(items, 'roles'), 2, 'falls back to a contained match');
	assert.equal(related._findRelatedTypeaheadMatchIndex(items, 'missing'), -1);
});

test('Find related typeahead focuses, highlights, and scrolls the matching row', () => {
	const related = mountRelatedRecords({ selectedObjects: [], bulkRecords: [], bulkAssociations: [] });
	const row = (label, objectName) => {
		const classes = new Set();
		return {
			dataset: { relObject: objectName },
			querySelector: () => ({ textContent: label }),
			classList: {
				add: (name) => classes.add(name),
				remove: (name) => classes.delete(name),
				contains: (name) => classes.has(name),
			},
			focusOptions: null,
			scrollOptions: null,
			focus(options) {
				this.focusOptions = options;
			},
			scrollIntoView(options) {
				this.scrollOptions = options;
			},
		};
	};
	const rows = [row('Account', 'Account'), row('OLQA Work Item', 'OLQA_Work_Item__c')];
	const result = related._jumpToRelatedTypeahead(rows, 'work');

	assert.equal(result.index, 1);
	assert.equal(rows[0].classList.contains('is-typeahead-match'), false);
	assert.equal(rows[1].classList.contains('is-typeahead-match'), true);
	assert.equal(rows[1].focusOptions.preventScroll, true);
	assert.equal(rows[1].scrollOptions.block, 'nearest');
});
