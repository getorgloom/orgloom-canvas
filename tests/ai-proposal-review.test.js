import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/public/js/ai-proposals.js', import.meta.url), 'utf8');

function element() {
	return {
		hidden: true,
		innerHTML: '',
		textContent: '',
		appendChild() {},
		addEventListener() {},
		setAttribute() {},
	};
}

function createApi(bulkRecords = [], bulkAssociations = [], describeCache = {}) {
	const window = { OrgLoom: {}, Orgloom: {}, addEventListener() {}, localStorage: { getItem: () => null } };
	const document = { body: element(), createElement: element, addEventListener() {} };
	vm.runInNewContext(source, {
		window,
		document,
		console,
		Promise,
		JSON,
		Number,
		String,
		Array,
		Map,
		Set,
		encodeURIComponent,
		setInterval: () => 1,
		clearInterval() {},
	});
	return window.OrgLoom.aiProposals.mount({
		canvasState: { currentCanvas: null, bulkRecords, bulkAssociations, describeCache },
		csrfFetch: async () => ({ ok: true, json: async () => ({ proposals: [] }) }),
		escapeHtml: (value) => String(value),
		showBulkToast() {},
		showConfirmDialog: async () => true,
		addToSelection() {},
		bulkAutoFill() {},
		ensureDescribe: async () => ({}),
		renderBulkView() {},
	});
}

function createRenderer(bulkRecords = [], bulkAssociations = [], describeCache = {}) {
	return createApi(bulkRecords, bulkAssociations, describeCache).renderProposalCard;
}

test('relationship operations render as fields on their proposed child record', () => {
	const render = createRenderer();
	const html = render({
		id: 'proposal-1',
		changes: [
			{
				kind: 'new-draft',
				objectName: 'Contact',
				tempRef: 'contact-one',
				fields: { LastName: 'Lovelace' },
			},
			{
				kind: 'new-association',
				fieldName: 'AccountId',
				from: { kind: 'tempRef', ref: 'contact-one' },
				to: { kind: 'loaded', ref: '001000000000001AAA' },
			},
		],
	});

	assert.equal((html.match(/proposal-change-checkbox/g) || []).length, 1);
	assert.match(html, /data-change-indexes="0,1"/);
	assert.match(html, /<code>AccountId<\/code> <span class="tag">relationship<\/span>/);
	assert.match(html, /001000000000001AAA/);
	assert.doesNotMatch(html, /\+ link|− unlink|From \(child\)|To \(parent\)/);
	assert.match(html, /1 of 1 selected/);
});

test('relationship-only changes for one child render as one record item', () => {
	const render = createRenderer([
		{
			id: 10,
			loadedFromId: '003000000000001AAA',
			objectName: 'Contact',
			values: { Id: '003000000000001AAA', Name: 'Ada Lovelace' },
		},
		{
			id: 11,
			loadedFromId: '001000000000001AAA',
			objectName: 'Account',
			values: { Id: '001000000000001AAA', Name: 'Analytical Engines' },
		},
	]);
	const html = render({
		id: 'proposal-2',
		changes: [
			{
				kind: 'delete-association',
				fieldName: 'AccountId',
				from: { kind: 'loaded', ref: '003000000000001AAA' },
				to: { kind: 'loaded', ref: '001000000000001AAA' },
			},
			{
				kind: 'new-association',
				fieldName: 'ReportsToId',
				from: { kind: 'loaded', ref: '003000000000001AAA' },
				to: { kind: 'loaded', ref: '003000000000002AAA' },
			},
		],
	});

	assert.equal((html.match(/proposal-change-checkbox/g) || []).length, 1);
	assert.match(html, /data-change-indexes="0,1"/);
	assert.match(html, /AccountId/);
	assert.match(html, /ReportsToId/);
	assert.match(html, /Not linked/);
	assert.match(html, /<code class="proposal-object-type">Contact<\/code>/);
	assert.match(html, /<strong class="proposal-record-name">Ada Lovelace<\/strong>/);
	assert.match(html, /<strong class="proposal-record-name">Analytical Engines<\/strong>/);
	assert.match(html, /1 of 1 selected/);
});

test('record field edits identify the object, record name, and Salesforce id', () => {
	const render = createRenderer([
		{
			id: 20,
			loadedFromId: '001000000000009AAA',
			objectName: 'Account',
			values: { Id: '001000000000009AAA', Name: 'Acme Manufacturing', Industry: 'Energy' },
		},
	]);
	const html = render({
		id: 'proposal-3',
		changes: [
			{
				kind: 'record',
				recordId: '001000000000009AAA',
				objectName: 'Account',
				fields: { Industry: 'Manufacturing' },
				oldValues: { Industry: 'Energy' },
			},
		],
	});

	assert.match(html, /<code class="proposal-object-type">Account<\/code>/);
	assert.match(html, /<strong class="proposal-record-name">Acme Manufacturing<\/strong>/);
	assert.match(html, /<code class="tag">001000000000009AAA<\/code>/);
});

test('record names resolve through 15/18-character ids, loaded baselines, and describe name fields', () => {
	const render = createRenderer(
		[
			{
				id: 25,
				loadedFromId: '001000000000025',
				objectName: 'OLQA_Issue__c',
				values: { Status__c: 'Open' },
				loadedValues: { Issue_Number__c: 'ISSUE-0025', Status__c: 'Open' },
			},
		],
		[],
		{
			OLQA_Issue__c: {
				fields: [{ name: 'Issue_Number__c', nameField: true }],
			},
		},
	);
	const html = render({
		id: 'proposal-custom-name',
		changes: [
			{
				kind: 'record',
				recordId: '001000000000025AAA',
				objectName: 'OLQA_Issue__c',
				fields: { Status__c: 'Closed' },
				oldValues: { Status__c: 'Open' },
			},
		],
	});

	assert.match(html, /<strong class="proposal-record-name">ISSUE-0025<\/strong>/);
});

test('a replacement lookup shows both the current and proposed parent', () => {
	const records = [
		{
			id: 30,
			loadedFromId: '003000000000030AAA',
			objectName: 'Contact',
			values: { Id: '003000000000030AAA', Name: 'Grace Hopper' },
		},
		{
			id: 31,
			loadedFromId: '001000000000031AAA',
			objectName: 'Account',
			values: { Id: '001000000000031AAA', Name: 'Original Account' },
		},
		{
			id: 32,
			objectName: 'Account',
			values: { Name: 'Proposed Account' },
		},
	];
	const render = createRenderer(records, [{ id: 40, fromId: 30, toId: 31, fieldName: 'AccountId' }]);
	const html = render({
		id: 'proposal-4',
		changes: [
			{
				kind: 'new-association',
				fieldName: 'AccountId',
				from: { kind: 'loaded', ref: '003000000000030AAA' },
				to: { kind: 'draft', ref: 32 },
			},
		],
	});

	assert.match(html, /Original Account/);
	assert.match(html, /Proposed Account/);
	assert.match(html, /<th>Old value<\/th><th>New value<\/th>/);
});

test('unchanged identity fields are omitted from a relationship proposal', () => {
	const render = createRenderer([
		{
			id: 20,
			loadedFromId: '003000000000020AAA',
			objectName: 'Contact',
			values: {
				Id: '003000000000020AAA',
				FirstName: 'Contact',
				LastName: 'Two',
			},
		},
		{
			id: 21,
			objectName: 'Account',
			values: { Name: 'New Account' },
		},
	]);
	const html = render({
		id: 'proposal-no-op-fields',
		changes: [
			{
				kind: 'record',
				recordId: '003000000000020AAA',
				objectName: 'Contact',
				fields: { LastName: 'Two', FirstName: 'Contact' },
				oldValues: { LastName: 'Two', FirstName: 'Contact' },
			},
			{
				kind: 'new-association',
				fieldName: 'AccountId',
				from: { kind: 'loaded', ref: '003000000000020AAA' },
				to: { kind: 'draft', ref: 21 },
			},
		],
	});

	assert.doesNotMatch(html, /<code>FirstName<\/code>|<code>LastName<\/code>|unchanged/);
	assert.match(html, /<code>AccountId<\/code>/);
	assert.match(html, /New Account/);
});

test('applying a lookup proposal replaces any existing value for that child field', () => {
	const api = createApi();
	const original = [
		{ id: 1, fromId: 10, toId: 20, fieldName: 'AccountId' },
		{ id: 2, fromId: 10, toId: 30, fieldName: 'ReportsToId' },
	];
	const result = api.upsertSingleLookupAssociation(original, {
		id: 3,
		fromId: 10,
		toId: 21,
		fieldName: 'AccountId',
	});

	assert.equal(result.changed, true);
	assert.equal(result.inserted, true);
	assert.deepEqual(result.associations, [
		{ id: 2, fromId: 10, toId: 30, fieldName: 'ReportsToId' },
		{ id: 3, fromId: 10, toId: 21, fieldName: 'AccountId' },
	]);
	assert.equal(result.associations.filter((association) => association.fieldName === 'AccountId').length, 1);

	const records = [
		{ id: 10, values: { AccountId: '001OLD000000001AAA' } },
		{ id: 21, loadedFromId: '001NEW000000001AAA', values: { Id: '001NEW000000001AAA' } },
		{ id: 22, values: { Name: 'New draft parent' } },
	];
	assert.equal(api.syncLookupFieldValue(records, 10, 21, 'AccountId'), true);
	assert.equal(records[0].values.AccountId, '001NEW000000001AAA');
	assert.equal(api.syncLookupFieldValue(records, 10, 22, 'AccountId'), true);
	assert.equal(Object.hasOwn(records[0].values, 'AccountId'), false);
});
