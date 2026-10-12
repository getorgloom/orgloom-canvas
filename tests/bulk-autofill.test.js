import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../src/public/js/bulk-autofill.js'), 'utf8');

function harness({
	records,
	describes = {},
	associations = [],
	ensureDescribe,
	getSmartDefault,
	sampleValueForField,
	autoFillAllowed = true,
	confirmResult = true,
} = {}) {
	const toasts = [];
	let capabilityRefreshes = 0;
	let confirmations = 0;
	let lastConfirmation = null;
	const state = { bulkRecords: records || [], bulkAssociations: associations, describeCache: { ...describes } };
	const window = {};
	vm.runInNewContext(source, { window, Map, Set, Promise, JSON, Number });
	const api = window.OrgLoom.bulkAutofill.mount({
		canvasState: state,
		csrfFetch: async () => ({
			ok: autoFillAllowed,
			status: autoFillAllowed ? 200 : 403,
			json: async () =>
				autoFillAllowed ? { ok: true } : { message: 'Ask an admin to grant Auto-fill permission.' },
		}),
		ensureDescribe: ensureDescribe || (async (name) => state.describeCache[name]),
		fieldTypeFilter: () => () => true,
		getSmartDefault: getSmartDefault || (() => null),
		renderBulkView: () => {},
		sampleValueForField:
			sampleValueForField || ((field) => (field.sample === undefined ? `sample-${field.name}` : field.sample)),
		showBulkToast: (message, kind) => toasts.push({ message, kind }),
		showConfirmDialog: async (options) => {
			confirmations += 1;
			lastConfirmation = options;
			return confirmResult;
		},
		loadSmartDefaults: async () => {},
		refreshCapabilities: async () => {
			capabilityRefreshes += 1;
		},
	});
	return {
		api,
		state,
		toasts,
		get capabilityRefreshes() {
			return capabilityRefreshes;
		},
		get confirmations() {
			return confirmations;
		},
		get lastConfirmation() {
			return lastConfirmation;
		},
	};
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
	assert.deepEqual(
		records.map((record) => record.values),
		[{}, {}],
	);
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

test('Auto-fill changes nothing when permission is revoked before execution', async () => {
	const record = { id: 1, objectName: 'Account', values: {} };
	const result = harness({
		records: [record],
		describes: { Account: { fields: [{ name: 'Name', required: true }] } },
		autoFillAllowed: false,
	});

	assert.equal(await result.api.bulkAutoFill('required', 'both', { silent: true }), false);
	assert.deepEqual(record.values, {});
	assert.equal(result.capabilityRefreshes, 1);
	assert.match(result.toasts.at(-1).message, /Ask an admin to grant Auto-fill permission/);
});

test('the reviewed modal can skip a second fill confirmation', async () => {
	const record = { id: 1, objectName: 'Account', values: {} };
	const result = harness({
		records: [record],
		describes: { Account: { fields: [{ name: 'Name', required: true }] } },
	});

	assert.equal(await result.api.bulkAutoFill('required', 'both', { skipConfirm: true }), true);
	assert.equal(result.confirmations, 0);
	assert.equal(record.values.Name, 'sample-Name');
});

test('draft-only clear can skip confirmation after review while loaded-record clear still confirms', async () => {
	const draft = { id: 1, objectName: 'Account', values: { Name: 'Draft' } };
	const loaded = {
		id: 2,
		objectName: 'Account',
		loadedFromId: '001000000000001AAA',
		values: { Name: 'Existing' },
	};
	const result = harness({ records: [draft, loaded] });

	assert.equal(await result.api.bulkClearAllFields({ tempIds: [draft.id], skipConfirm: true }), true);
	assert.equal(result.confirmations, 0);
	assert.equal(Object.keys(draft.values).length, 0);

	assert.equal(await result.api.bulkClearAllFields({ tempIds: [loaded.id], includeLoaded: true }), true);
	assert.equal(result.confirmations, 1);
	assert.equal(Object.keys(loaded.values).length, 0);
	assert.equal(result.lastConfirmation.title, 'Clear fields?');
	assert.equal(result.lastConfirmation.message, 'The next upload will clear field values for 1 Salesforce record.');
	assert.doesNotMatch(result.lastConfirmation.message, /What this does|Wipe every field value|Undo/);
});
