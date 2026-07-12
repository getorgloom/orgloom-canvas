import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../src/public/js/bulk-autofill.js'), 'utf8');

function harness({ records, describes = {}, ensureDescribe } = {}) {
	const toasts = [];
	const state = { bulkRecords: records || [], describeCache: { ...describes } };
	const window = {};
	vm.runInNewContext(source, { window, Map, Set, Promise, JSON, Number });
	const api = window.OrgLoom.bulkAutofill.mount({
		canvasState: state,
		ensureDescribe: ensureDescribe || (async (name) => state.describeCache[name]),
		fieldTypeFilter: () => () => true,
		getSmartDefault: () => null,
		renderBulkView: () => {},
		sampleValueForField: (field) => field.sample === undefined ? `sample-${field.name}` : field.sample,
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
