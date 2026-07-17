import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const uploadModalSource = fs.readFileSync(
	path.resolve(here, '../src/public/js/upload-modal.js'),
	'utf8',
);
const preflightSource = fs.readFileSync(
	path.resolve(here, '../src/public/js/preflight.js'),
	'utf8',
);

function evaluateUploadModal() {
	const context = { window: { OrgLoom: {} } };
	vm.runInNewContext(uploadModalSource, context);
	return context.window.OrgLoom.uploadModal;
}

const uploadModal = evaluateUploadModal();

function summarize(row) {
	const records = row.records || [];
	const associations = row.associations || [];
	const selectedIds = new Set(row.selectedIds || []);
	const scopedRecords = uploadModal.scopeUploadRecords(
		records,
		selectedIds,
		row.selectedOnly,
	);
	const scopedIds = new Set(Array.from(scopedRecords, (r) => r.id));
	const scopedAssociations = uploadModal.scopeUploadAssociations(associations, scopedIds);
	const excludedDraftLinks = uploadModal.excludedDraftParentLinks(
		records,
		associations,
		scopedIds,
		row.selectedOnly,
	);
	const requiredExcludedLinks = uploadModal.requiredExcludedDraftParentLinks(
		records,
		excludedDraftLinks,
		row.describeCache || {},
	);

	const window = {};
	vm.runInNewContext(preflightSource, { window, Set, Map, Date, isFinite });
	const preflight = window.OrgLoom.preflight.mount({
		canvasState: {
			bulkRecords: records,
			bulkAssociations: associations,
			describeCache: row.describeCache || {},
			selectedObjects: [],
		},
		isRecordModified: (record) => !record.unchanged,
		recordOrdinal: () => 1,
	});
	const unchangedIds = new Set(
		Array.from(scopedRecords)
			.filter((r) => r.loadedFromId && r.unchanged && !r.pendingDelete)
			.map((r) => r.id),
	);
	const deleteIds = new Set(
		Array.from(scopedRecords)
			.filter((r) => r.pendingDelete && r.loadedFromId)
			.map((r) => r.id),
	);
	const order = preflight.computeUploadOrder(unchangedIds, scopedIds, deleteIds);

	return {
		recordIds: Array.from(scopedRecords, (r) => r.id),
		associationFields: Array.from(scopedAssociations, (a) => a.fieldName),
		excludedFields: Array.from(excludedDraftLinks, (a) => a.fieldName),
		requiredExcludedFields: Array.from(requiredExcludedLinks, (a) => a.fieldName),
		createOrder: Array.from(order.creates)
			.filter((entry) => entry.upload > 0)
			.map((entry) => entry.objectName),
		deleteOrder: Array.from(order.deletes, (entry) => entry.objectName),
	};
}

const accountDraft = (id, extra = {}) => ({ id, objectName: 'Account', values: {}, ...extra });
const contactDraft = (id, extra = {}) => ({ id, objectName: 'Contact', values: {}, ...extra });
const link = (fromId, toId, fieldName) => ({ fromId, toId, fieldName });

const matrix = [
	{
		name: 'all-record scope includes both linked drafts and preserves their association',
		records: [accountDraft('a'), contactDraft('c')],
		associations: [link('c', 'a', 'AccountId')],
		selectedIds: ['c'],
		selectedOnly: false,
		expect: {
			recordIds: ['a', 'c'], associationFields: ['AccountId'], excludedFields: [],
			requiredExcludedFields: [], createOrder: ['Account', 'Contact'], deleteOrder: [],
		},
	},
	{
		name: 'isolated selected draft excludes an unrelated draft',
		records: [accountDraft('selected'), accountDraft('other')],
		associations: [],
		selectedIds: ['selected'],
		selectedOnly: true,
		expect: {
			recordIds: ['selected'], associationFields: [], excludedFields: [],
			requiredExcludedFields: [], createOrder: ['Account'], deleteOrder: [],
		},
	},
	{
		name: 'selected child excludes its unselected draft parent and discloses the omitted link',
		records: [accountDraft('a'), contactDraft('c')],
		associations: [link('c', 'a', 'AccountId')],
		selectedIds: ['c'],
		selectedOnly: true,
		expect: {
			recordIds: ['c'], associationFields: [], excludedFields: ['AccountId'],
			requiredExcludedFields: [], createOrder: ['Contact'], deleteOrder: [],
		},
	},
	{
		name: 'selected child can retain the real id of an unselected existing parent without uploading it',
		records: [
			accountDraft('a', { loadedFromId: '001-existing' }),
			contactDraft('c', { values: { AccountId: '001-existing' } }),
		],
		associations: [link('c', 'a', 'AccountId')],
		selectedIds: ['c'],
		selectedOnly: true,
		expect: {
			recordIds: ['c'], associationFields: [], excludedFields: [],
			requiredExcludedFields: [], createOrder: ['Contact'], deleteOrder: [],
		},
	},
	{
		name: 'selecting both child and draft parent preserves parent-first ordering',
		records: [accountDraft('a'), contactDraft('c')],
		associations: [link('c', 'a', 'AccountId')],
		selectedIds: ['a', 'c'],
		selectedOnly: true,
		expect: {
			recordIds: ['a', 'c'], associationFields: ['AccountId'], excludedFields: [],
			requiredExcludedFields: [], createOrder: ['Account', 'Contact'], deleteOrder: [],
		},
	},
	{
		name: 'selecting only a parent does not pull in an unselected child',
		records: [accountDraft('a'), contactDraft('c')],
		associations: [link('c', 'a', 'AccountId')],
		selectedIds: ['a'],
		selectedOnly: true,
		expect: {
			recordIds: ['a'], associationFields: [], excludedFields: [],
			requiredExcludedFields: [], createOrder: ['Account'], deleteOrder: [],
		},
	},
	{
		name: 'multi-level selection keeps its internal link and omits only the direct unselected ancestor link',
		records: [accountDraft('grand'), accountDraft('parent'), contactDraft('child')],
		associations: [
			link('parent', 'grand', 'ParentId'),
			link('child', 'parent', 'AccountId'),
		],
		selectedIds: ['parent', 'child'],
		selectedOnly: true,
		expect: {
			recordIds: ['parent', 'child'], associationFields: ['AccountId'], excludedFields: ['ParentId'],
			requiredExcludedFields: [], createOrder: ['Account', 'Contact'], deleteOrder: [],
		},
	},
	{
		name: 'required lookup to an unselected draft is identified as a likely failed insert',
		records: [
			{ id: 'project', objectName: 'Project__c', values: {} },
			{ id: 'work', objectName: 'Work_Item__c', values: {} },
		],
		associations: [link('work', 'project', 'Project__c')],
		selectedIds: ['work'],
		selectedOnly: true,
		describeCache: {
			Work_Item__c: {
				fields: [{
					name: 'Project__c', label: 'Project', type: 'reference',
					createable: true, required: true, defaultedOnCreate: false,
				}],
			},
		},
		expect: {
			recordIds: ['work'], associationFields: [], excludedFields: ['Project__c'],
			requiredExcludedFields: ['Project__c'], createOrder: ['Work_Item__c'], deleteOrder: [],
		},
	},
	{
		name: 'mixed draft, modified existing, unchanged, delete, and type-node state respects selection and lanes',
		records: [
			accountDraft('draft'),
			contactDraft('modified', { loadedFromId: '003-modified' }),
			{ id: 'unchanged', objectName: 'Opportunity', loadedFromId: '006-unchanged', unchanged: true },
			{ id: 'deleted', objectName: 'Case', loadedFromId: '500-delete', pendingDelete: true },
			{ id: 'type', objectName: 'Lead', isTypeNode: true },
		],
		associations: [link('modified', 'draft', 'AccountId')],
		selectedIds: ['draft', 'modified', 'deleted', 'type'],
		selectedOnly: true,
		expect: {
			recordIds: ['draft', 'modified', 'deleted'], associationFields: ['AccountId'], excludedFields: [],
			requiredExcludedFields: [], createOrder: ['Account', 'Contact'], deleteOrder: ['Case'],
		},
	},
];

for (const row of matrix) {
	test(`upload scope matrix: ${row.name}`, () => {
		assert.deepEqual(summarize(row), row.expect);
	});
}

test('upload scope matrix: omitted draft links strip stale literal lookup values from the payload', () => {
	const contact = contactDraft('c', {
		values: { LastName: 'User', AccountId: '001-stale' },
	});
	const values = uploadModal.scopeUploadValues(
		contact,
		contact.values,
		[link('c', 'draft-account', 'AccountId')],
	);

	assert.deepEqual({ ...values }, { LastName: 'User' });
	assert.equal(contact.values.AccountId, '001-stale', 'canvas state is not mutated');
});

test('upload scope matrix: existing-parent IDs survive because their relationship remains resolvable', () => {
	const contact = contactDraft('c', {
		values: { LastName: 'User', AccountId: '001-existing' },
	});
	const values = uploadModal.scopeUploadValues(contact, contact.values, []);

	assert.deepEqual({ ...values }, { LastName: 'User', AccountId: '001-existing' });
});
