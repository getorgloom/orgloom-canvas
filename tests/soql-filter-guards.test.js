import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { readFileSync } from 'node:fs';
import { initTestDb } from './helpers/db.js';
import { ext } from '../src/extensions.js';

let server;
let baseUrl;
let capturedQueries;
let capabilitiesAllowed;

const browseClientSource = readFileSync(new URL('../src/public/js/record-browse.js', import.meta.url), 'utf8');
const linkedCsvSource = readFileSync(new URL('../src/public/js/linked-csv.js', import.meta.url), 'utf8');
const canvasCardMenuSource = readFileSync(new URL('../src/public/js/canvas-card-menu.js', import.meta.url), 'utf8');
const typeNodeSource = readFileSync(new URL('../src/public/js/type-node.js', import.meta.url), 'utf8');

const describes = {
	Account: {
		name: 'Account',
		fields: [
			{ name: 'Id', type: 'id', filterable: true },
			{ name: 'Name', label: 'Account Name', type: 'string', filterable: true, nameField: true },
			{ name: 'CreatedDate', label: 'Created Date', type: 'datetime', filterable: true },
			{ name: 'Description', label: 'Description', type: 'textarea', filterable: false },
			{
				name: 'External_Key__c',
				label: 'External Key',
				type: 'string',
				filterable: true,
				externalId: true,
				createable: true,
			},
			{
				name: 'Unfilterable_External__c',
				label: 'Unfilterable External',
				type: 'string',
				filterable: false,
				externalId: true,
				createable: true,
			},
		],
	},
	Child__c: {
		name: 'Child__c',
		fields: [
			{ name: 'Id', type: 'id', filterable: true },
			{ name: 'Name', type: 'string', filterable: true, nameField: true },
			{ name: 'Parent__c', label: 'Parent', type: 'reference', filterable: false, referenceTo: ['Account'] },
		],
	},
	Unsearchable__c: {
		name: 'Unsearchable__c',
		fields: [
			{ name: 'Id', type: 'id', filterable: true },
			{ name: 'Name', type: 'string', filterable: false, nameField: true },
		],
	},
	Case: {
		name: 'Case',
		fields: [
			{ name: 'Id', type: 'id', filterable: true },
			{ name: 'CaseNumber', label: 'Case Number', type: 'string', filterable: true, nameField: true },
			{ name: 'Subject', label: 'Subject', type: 'string', filterable: true },
			{ name: 'Description', label: 'Description', type: 'textarea', filterable: false },
			{ name: 'AccountId', label: 'Account', type: 'reference', filterable: true, referenceTo: ['Account'] },
		],
	},
};

before(async () => {
	await initTestDb();
	const dbProvider = ext.getDb;
	const rawProvider = ext.getRawClient;
	ext._resetForTests();
	ext.registerDbProvider(() => dbProvider());
	ext.registerRawClientProvider(() => rawProvider());
	ext.registerAuthProvider(async () => ({ id: 'acc_filter_guard', email: 'filters@example.com' }));
	ext.registerCapabilityResolver(async () =>
		capabilitiesAllowed
			? { allowed: true, role: 'admin', plan: 'team' }
			: { allowed: false, reason: 'member-grant-required', approvalStatus: 'missing' },
	);

	const conn = {
		version: '60.0',
		instanceUrl: 'https://destination.my.salesforce.com',
		sobject: (name) => ({
			describe: async () => describes[name] || { name, fields: [] },
		}),
		query: async (soql) => {
			capturedQueries.push(soql);
			if (/\bFROM Case\b/.test(soql)) {
				return {
					records: [{ Id: '500000000000001AAA', CaseNumber: '00001029', Subject: 'Printer is offline' }],
					done: true,
					totalSize: 1,
				};
			}
			return { records: [], done: true, totalSize: 0 };
		},
	};
	const app = express();
	app.use(express.json());
	app.use((req, _res, next) => {
		req.session = {};
		req.sf = {
			conn,
			sfOrgId: '00DDEST',
			sfUserId: '005DEST',
			instanceUrl: conn.instanceUrl,
		};
		next();
	});
	const { mountCanvasRoutes } = await import('../src/canvas-routes.js');
	mountCanvasRoutes(app);
	ext.flush(app);
	server = await new Promise((resolve) => {
		const listening = app.listen(0, () => resolve(listening));
	});
	baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
	if (server) {
		await new Promise((resolve) => server.close(resolve));
	}
});

beforeEach(() => {
	capturedQueries = [];
	capabilitiesAllowed = true;
});

async function jsonRequest(path, options = {}) {
	const response = await fetch(baseUrl + path, options);
	return { response, body: await response.json() };
}

describe('app-generated SOQL WHERE field guards', () => {
	test('affected UI pickers only offer filterable fields', () => {
		assert.match(browseClientSource, /f\.filterable === true/);
		assert.match(linkedCsvSource, /f\.externalId && f\.filterable === true && f\.createable/);
	});

	test('Browse rejects a non-filterable field before querying Salesforce', async () => {
		const { response, body } = await jsonRequest('/api/browse', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				objectName: 'Account',
				filters: [{ field: 'Description', op: 'equals', value: 'private text' }],
			}),
		});
		assert.equal(response.status, 400);
		assert.equal(body.error, 'invalid-filter');
		assert.match(body.message, /cannot be used in a Salesforce filter/i);
		assert.equal(capturedQueries.length, 0);
	});

	test('Browse emits complete UTC literals for datetime filters', async () => {
		for (const [op, token] of [
			['equals', '='],
			['before', '<'],
			['after', '>'],
		]) {
			capturedQueries = [];
			const { response } = await jsonRequest('/api/browse', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					objectName: 'Account',
					filters: [{ field: 'CreatedDate', op, value: '2026-07-19T07:00:00.000Z' }],
				}),
			});
			assert.equal(response.status, 200);
			assert.ok(capturedQueries[0].includes(`CreatedDate ${token} 2026-07-19T07:00:00.000Z`));
		}
	});

	test('Browse rejects timezone-free datetime values before querying Salesforce', async () => {
		const { response, body } = await jsonRequest('/api/browse', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				objectName: 'Account',
				filters: [{ field: 'CreatedDate', op: 'equals', value: '2026-07-19T00:00' }],
			}),
		});
		assert.equal(response.status, 400);
		assert.equal(body.error, 'invalid-filter');
		assert.match(body.message, /valid date and time/i);
		assert.equal(capturedQueries.length, 0);
	});

	test('related-record endpoints skip a non-filterable lookup before querying', async () => {
		const id = '001000000000001AAA';
		const single = await jsonRequest(`/api/objects/Child__c/related-count?field=Parent__c&id=${id}`);
		assert.equal(single.body.skipped, true);
		assert.equal(single.body.reason, 'field-not-filterable');

		const batch = await jsonRequest('/api/related-counts', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ probes: [{ name: 'Child__c', field: 'Parent__c', id }] }),
		});
		assert.equal(batch.body.counts[0].skipped, true);
		assert.equal(batch.body.counts[0].reason, 'field-not-filterable');

		const related = await jsonRequest(`/api/objects/Child__c/by-ref?field=Parent__c&id=${id}`);
		assert.equal(related.body.skipped, true);
		assert.equal(related.body.reason, 'field-not-filterable');

		const searched = await jsonRequest(`/api/objects/Child__c/by-ref-search?field=Parent__c&id=${id}&q=child`);
		assert.equal(searched.body.skipped, true);
		assert.equal(searched.body.reason, 'field-not-filterable');
		assert.equal(capturedQueries.length, 0);
	});

	test('name-field search rejects a non-filterable name before querying', async () => {
		const { response, body } = await jsonRequest('/api/objects/Unsearchable__c/search?q=test');
		assert.equal(response.status, 400);
		assert.equal(body.error, 'search-field-not-filterable');
		assert.equal(capturedQueries.length, 0);
	});

	test('record-name search enforces the same Browse records capability as record loading', async () => {
		capabilitiesAllowed = false;
		const { response, body } = await jsonRequest('/api/objects/Account/search?q=test');
		assert.equal(response.status, 403);
		assert.equal(body.error, 'member-grant-required');
		assert.equal(body.capability, 'browse-records');
		assert.equal(capturedQueries.length, 0);
	});

	test('Case search matches case number or subject and returns a useful label', async () => {
		const { response, body } = await jsonRequest('/api/objects/Case/search?q=printer');
		assert.equal(response.status, 200);
		assert.deepEqual(body.searchFields, ['CaseNumber', 'Subject']);
		assert.match(capturedQueries[0], /WHERE \(CaseNumber LIKE '%printer%' OR Subject LIKE '%printer%'\)/);
		assert.doesNotMatch(capturedQueries[0], /Description LIKE/);
		assert.deepEqual(body.records, [{ id: '500000000000001AAA', name: '00001029 — Printer is offline' }]);
	});

	test('related Case search also matches case number or subject', async () => {
		const { response, body } = await jsonRequest(
			'/api/objects/Case/by-ref-search?field=AccountId&id=001000000000001AAA&q=printer',
		);
		assert.equal(response.status, 200);
		assert.deepEqual(body.searchFields, ['CaseNumber', 'Subject']);
		assert.match(
			capturedQueries[0],
			/AccountId = '001000000000001AAA' AND \(CaseNumber LIKE '%printer%' OR Subject LIKE '%printer%'\)/,
		);
		assert.doesNotMatch(capturedQueries[0], /Description LIKE/);
		assert.deepEqual(body.records, [{ id: '500000000000001AAA', name: '00001029 — Printer is offline' }]);
	});

	test('Case record pickers explain the available search fields', () => {
		assert.match(canvasCardMenuSource, /Search by case number or subject/);
		assert.match(typeNodeSource, /Search by case number or subject/);
		assert.doesNotMatch(canvasCardMenuSource, /by Name or paste/);
		assert.doesNotMatch(typeNodeSource, /by Name or paste/);
	});

	test('Bulk upsert rejects non-filterable and non-External-ID keys before querying', async () => {
		for (const [field, reason] of [
			['Unfilterable_External__c', 'field-not-filterable'],
			['Name', 'field-not-external-id'],
			['Name FROM Contact', 'invalid-field-name'],
		]) {
			const { response, body } = await jsonRequest('/api/upload/bulk', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					records: [
						{
							tempId: 'r1',
							objectName: 'Account',
							values: { [field]: 'key-1' },
							_csvOperation: 'upsert',
							_csvExternalIdField: field,
						},
					],
				}),
			});
			assert.equal(response.status, 400);
			assert.equal(body.error, 'invalid-upsert-external-id-field');
			assert.equal(body.reason, reason);
		}
		assert.equal(capturedQueries.length, 0);
	});
});
