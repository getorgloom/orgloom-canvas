import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const staleSource = readFileSync(new URL('../src/public/js/stale-ref.js', import.meta.url), 'utf8');
const recordsSource = readFileSync(new URL('../src/public/js/records-canvas.js', import.meta.url), 'utf8');
const cssSource = readFileSync(new URL('../src/public/css/app.css', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/public/js/app.js', import.meta.url), 'utf8');

function mount({ describe, messages = [], renders = [] } = {}) {
	const window = { OrgLoom: {} };
	vm.runInNewContext(staleSource, {
		window,
		console,
		document: { addEventListener() {} },
	});
	let describeOptions = null;
	const api = window.OrgLoom.staleRef.mount({
		canvasState: { describeCache: { Account: describe || { fields: [] } } },
		encryptedFields: {
			stripValues(_state, _objectName, values) {
				const encrypted = new Set(
					((describe && describe.fields) || [])
						.filter((field) => field.type === 'encryptedstring')
						.map((field) => field.name),
				);
				return Object.fromEntries(Object.entries(values || {}).filter(([name]) => !encrypted.has(name)));
			},
			intentNames: () => [],
			clearSubmitted() {},
		},
		renderBulkView: () => renders.push('render'),
		deleteRecord() {},
		getBulkRecords: () => [],
		ensureDescribe: async (_name, options) => {
			describeOptions = options;
			return describe;
		},
		showBulkToast: (message, kind) => messages.push({ message, kind }),
	});
	return { api, getDescribeOptions: () => describeOptions };
}

test('an inaccessible placeholder cannot be converted into a draft', async () => {
	const messages = [];
	const { api, getDescribeOptions } = mount({ describe: { createable: true }, messages });
	const record = {
		objectName: 'Account',
		loadedFromId: '001000000000001AAA',
		values: {},
		_inaccessible: true,
	};

	assert.equal(await api._convertStaleRecordToDraft(record), false);
	assert.equal(record.loadedFromId, '001000000000001AAA');
	assert.equal(getDescribeOptions(), null);
	assert.match(messages[0].message, /No readable Salesforce values/);
});

test('an unavailable refresh clears previously loaded Salesforce values', () => {
	const { api } = mount();
	const record = {
		loadedFromId: '001000000000001AAA',
		values: { Name: 'Previously visible', Secret__c: 'Sensitive value' },
		loadedValues: { Name: 'Previously visible', Secret__c: 'Sensitive value' },
		_loadedFieldNames: ['Name', 'Secret__c'],
		_recordAccess: { checked: true, hasEditAccess: true },
		_recordAccessCheckedAt: Date.now(),
		_recordAccessAttemptedAt: Date.now(),
		_lastRefreshedAt: Date.now(),
		_refreshPulse: true,
		_deletedInSf: true,
		_staleAck: true,
	};

	assert.equal(api._markRecordUnavailable(record), true);
	assert.equal(Object.keys(record.values).length, 0);
	assert.equal(record.loadedValues, undefined);
	assert.equal(record._loadedFieldNames, undefined);
	assert.equal(record._recordAccess, undefined);
	assert.equal(record._recordAccessCheckedAt, undefined);
	assert.equal(record._recordAccessAttemptedAt, undefined);
	assert.equal(record._lastRefreshedAt, undefined);
	assert.equal(record._refreshPulse, undefined);
	assert.equal(record._inaccessible, true);
	assert.equal(record._deletedInSf, false);
	assert.equal(record._staleAck, false);
	assert.equal(record.loadedFromId, '001000000000001AAA');
	assert.equal((appSource.match(/_markRecordUnavailable\(rec\)/g) || []).length, 2);
});

test('conversion requires current Salesforce object create access', async () => {
	const messages = [];
	const { api, getDescribeOptions } = mount({ describe: { createable: false }, messages });
	const record = {
		objectName: 'Account',
		loadedFromId: '001000000000001AAA',
		values: { Name: 'Previously loaded' },
	};

	assert.equal(await api._convertStaleRecordToDraft(record), false);
	assert.equal(record.loadedFromId, '001000000000001AAA');
	assert.equal(getDescribeOptions().force, true);
	assert.match(messages[0].message, /does not allow this user to create Account/);
});

test('conversion uses only values already loaded into the visible card', async () => {
	const renders = [];
	const { api } = mount({ describe: { createable: true }, renders });
	const values = { Name: 'Previously loaded' };
	const record = {
		objectName: 'Account',
		loadedFromId: '001000000000001AAA',
		loadedValues: { Name: 'Previously loaded' },
		values,
		_deletedInSf: true,
		_staleAck: true,
	};

	assert.equal(await api._convertStaleRecordToDraft(record), true);
	assert.equal(record.loadedFromId, null);
	assert.equal(record.loadedValues, undefined);
	assert.deepEqual(record.values, values);
	assert.equal(record._deletedInSf, false);
	assert.equal(record._staleAck, false);
	assert.deepEqual(renders, ['render']);
});

test('conversion to a draft removes Salesforce encrypted values', async () => {
	const { api } = mount({
		describe: {
			createable: true,
			fields: [
				{ name: 'Name', type: 'string' },
				{ name: 'Secret__c', type: 'encryptedstring' },
			],
		},
	});
	const record = {
		objectName: 'Account',
		loadedFromId: '001000000000001AAA',
		loadedValues: { Name: 'Visible', Secret__c: 'Salesforce decrypted value' },
		values: { Name: 'Visible', Secret__c: 'Salesforce decrypted value' },
	};

	assert.equal(await api._convertStaleRecordToDraft(record), true);
	assert.deepEqual(record.values, { Name: 'Visible' });
});

test('unavailable-record UI does not claim Salesforce deleted the record', () => {
	assert.doesNotMatch(staleSource, /Record was deleted in Salesforce/);
	assert.doesNotMatch(staleSource, /Convert to draft and re-create/);
	assert.doesNotMatch(recordsSource, />deleted in SF</);
	assert.doesNotMatch(cssSource, /content: 'Deleted in SF'/);
	assert.match(recordsSource, /This record may have been deleted, or your Salesforce access may have changed/);
});
