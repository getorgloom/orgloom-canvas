import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../src/public/js/bulk-autofill.js'), 'utf8');

function harness({ records, describes = {}, associations = [], ensureDescribe, getSmartDefault, sampleValueForField } = {}) {
	const toasts = [];
	const state = { bulkRecords: records || [], bulkAssociations: associations, describeCache: { ...describes } };
	const window = {};
	vm.runInNewContext(source, { window, Map, Set, Promise, JSON, Number });
	const api = window.OrgLoom.bulkAutofill.mount({
		canvasState: state,
		ensureDescribe: ensureDescribe || (async (name) => state.describeCache[name]),
		fieldTypeFilter: () => () => true,
		getSmartDefault: getSmartDefault || (() => null),
		renderBulkView: () => {},
		sampleValueForField: sampleValueForField || ((field) => field.sample === undefined ? `sample-${field.name}` : field.sample),
		showBulkToast: (message, kind) => toasts.push({ message, kind }),
		showConfirmDialog: async () => true,
		loadSmartDefaults: async () => {},
	});
	return { api, state, toasts };
}

async function settleFill(api, scope = 'all') {
	await api.bulkAutoFill(scope, 'all', { silent: true });
	for (let i = 0; i < 3; i++) {
		await new Promise((resolve) => setImmediate(resolve));
	}
}

test('AF-038: an FLS-hidden field absent from describe is never generated', async () => {
	const record = { id: 1, objectName: 'Secret__c', values: {} };
	const { api } = harness({
		records: [record],
		describes: { Secret__c: { fields: [{ name: 'Visible__c', required: false }] } },
	});
	await settleFill(api);
	assert.equal(record.values.Visible__c, 'sample-Visible__c');
	assert.equal(Object.hasOwn(record.values, 'Hidden_By_FLS__c'), false);
});

test('AF-050: a describe failure is atomic across the whole fill', async () => {
	const records = [
		{ id: 1, objectName: 'Good__c', values: {} },
		{ id: 2, objectName: 'Broken__c', values: {} },
	];
	const { api } = harness({
		records,
		describes: { Good__c: { fields: [{ name: 'Name', required: true }] } },
		ensureDescribe: async (name) => {
			if (name === 'Broken__c') {
				throw new Error('synthetic describe failure');
			}
		},
	});
	await settleFill(api, 'required');
	assert.deepEqual(records.map((record) => record.values), [{}, {}]);
});

test('AF-051: fill required handles 9,999 drafts without truncation', async () => {
	const records = Array.from({ length: 9_999 }, (_, index) => ({
		id: index + 1,
		objectName: 'Scale__c',
		values: {},
	}));
	const { api } = harness({
		records,
		describes: { Scale__c: { fields: [{ name: 'Required__c', required: true }] } },
	});
	await settleFill(api, 'required');
	assert.equal(records.filter((record) => record.values.Required__c).length, 9_999);
});

test('AF-055: preview separates fillable required fields from unresolved relationships', () => {
	const record = { id: 1, objectName: 'Work__c', values: {} };
	const { api } = harness({
		records: [record],
		describes: {
			Work__c: {
				fields: [
					{ name: 'Name', label: 'Name', required: true, type: 'string' },
					{ name: 'Customer__c', label: 'Customer', required: true, type: 'reference' },
					{ name: 'Milestone__c', label: 'Milestone', required: true, type: 'reference' },
				],
			},
		},
		associations: [{ fromId: 1, toId: 2, fieldName: 'Customer__c' }],
	});

	const summary = JSON.parse(JSON.stringify(api.summarizeAutoFillTargets([record], 'required', 'both')));
	assert.deepEqual(summary, {
		fillableFields: 1,
		unresolvedRelationships: 1,
		relationshipLabels: ['Milestone'],
	});
});

test('AF-056: result toast reports required relationships that still need connections', async () => {
	const record = { id: 1, objectName: 'Project__c', values: {} };
	const { api, toasts } = harness({
		records: [record],
		describes: {
			Project__c: {
				fields: [
					{ name: 'Name', required: true, type: 'string' },
					{ name: 'Customer__c', required: true, type: 'reference', sample: null },
				],
			},
		},
	});

	await api.bulkAutoFill('required', 'both');
	for (let i = 0; i < 3; i++) {
		await new Promise((resolve) => setImmediate(resolve));
	}
	assert.equal(record.values.Name, 'sample-Name');
	assert.equal(Object.hasOwn(record.values, 'Customer__c'), false);
	assert.match(toasts.at(-1).message, /1 required relationship still needs a canvas connection\./);
});
