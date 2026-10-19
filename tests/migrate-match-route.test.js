import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { initTestDb } from './helpers/db.js';
import { ext } from '../src/extensions.js';
import { migrationCandidateFields, migrationCandidateDetails } from '../src/migration-candidate-details.js';

test('custom objects use external identifiers and preserve meaningful zero values', () => {
	const fields = migrationCandidateFields(
		{
			fields: [
				{ name: 'Name', type: 'string', nameField: true },
				{ name: 'Seed_Key__c', label: 'Seed Key', type: 'string', externalId: true },
				{ name: 'Sequence__c', label: 'Sequence', type: 'int', unique: true },
				{ name: 'Encrypted_Key__c', type: 'encryptedstring', externalId: true },
			],
		},
		'Project__c',
	);
	assert.deepEqual(migrationCandidateDetails({ Seed_Key__c: 'PROJECT-1', Sequence__c: 0 }, fields), [
		{ name: 'Seed_Key__c', label: 'Seed Key', value: 'PROJECT-1' },
		{ name: 'Sequence__c', label: 'Sequence', value: '0' },
	]);
});

let server;
let baseUrl;
let capturedQueries;
let queryRecords;

const accountDescribe = {
	name: 'Account',
	fields: [
		{ name: 'Id', type: 'id', filterable: true },
		{ name: 'Name', type: 'string', filterable: true, nameField: true },
		{ name: 'AccountNumber', label: 'Account Number', type: 'string', filterable: true },
		{ name: 'Secret_Key__c', type: 'string', externalId: true, encrypted: true },
		{ name: 'Hidden_Key__c', type: 'string', externalId: true, accessible: false },
		{ name: 'Description', label: 'Description', type: 'textarea', filterable: false },
		{ name: 'AnnualRevenue', type: 'double', filterable: true },
		{ name: 'LastModifiedDate', type: 'datetime', filterable: true },
	],
};

before(async () => {
	await initTestDb();
	const dbProvider = ext.getDb;
	const rawProvider = ext.getRawClient;
	ext._resetForTests();
	ext.registerDbProvider(() => dbProvider());
	ext.registerRawClientProvider(() => rawProvider());
	ext.registerAuthProvider(async () => ({ id: 'acc_match', email: 'match@example.com' }));
	ext.registerCapabilityResolver(async () => ({ allowed: true, role: 'admin', plan: 'team' }));

	const conn = {
		sobject: () => ({ describe: async () => accountDescribe }),
		query: async (soql) => {
			capturedQueries.push(soql);
			return { records: queryRecords, done: true, totalSize: queryRecords.length };
		},
		queryMore: async () => ({ records: [], done: true }),
	};
	const app = express();
	app.use(express.json());
	app.use((req, _res, next) => {
		req.session = {};
		next();
	});
	app.use(['/api/migrate/match', '/api/objects'], (req, _res, next) => {
		req.sf = {
			conn,
			sfOrgId: '00DDEST',
			sfUserId: '005DEST',
			instanceUrl: 'https://destination.my.salesforce.com',
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
	queryRecords = [];
});

async function post(body) {
	return fetch(baseUrl + '/api/migrate/match', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
}

describe('POST /api/migrate/match field-aware SOQL literals', () => {
	test('ambiguous matches include readable identifiers but exclude encrypted or inaccessible fields', async () => {
		queryRecords = [
			{ Id: '001000000000001AAA', Name: 'Duplicate', AccountNumber: 'MIG-DUP-A' },
			{ Id: '001000000000002AAA', Name: 'Duplicate', AccountNumber: 'MIG-DUP-B' },
		];
		const response = await post({ objectName: 'Account', keyField: 'Name', values: ['Duplicate'] });
		assert.equal(response.status, 200);
		const body = await response.json();
		assert.deepEqual(body.ambiguous, ['Duplicate']);
		assert.deepEqual(
			body.candidatesByValue.Duplicate.map((candidate) => candidate.details),
			[
				[{ name: 'AccountNumber', label: 'Account Number', value: 'MIG-DUP-A' }],
				[{ name: 'AccountNumber', label: 'Account Number', value: 'MIG-DUP-B' }],
			],
		);
		assert.match(capturedQueries[0], /AccountNumber/);
		assert.doesNotMatch(capturedQueries[0], /Secret_Key__c|Hidden_Key__c/);
	});

	test('typed migration search includes details without changing ordinary lookup responses', async () => {
		queryRecords = [{ Id: '001000000000001AAA', Name: 'Duplicate', AccountNumber: 'MIG-DUP-A' }];
		const response = await fetch(baseUrl + '/api/objects/Account/search?q=Duplicate&migrationDetails=1');
		assert.equal(response.status, 200);
		assert.deepEqual((await response.json()).records[0].details, [
			{ name: 'AccountNumber', label: 'Account Number', value: 'MIG-DUP-A' },
		]);
		assert.doesNotMatch(capturedQueries[0], /Secret_Key__c|Hidden_Key__c/);
		const ordinary = await fetch(baseUrl + '/api/objects/Account/search?q=Duplicate');
		assert.equal(ordinary.status, 200);
		assert.equal(Object.hasOwn((await ordinary.json()).records[0], 'details'), false);
	});
	test('AnnualRevenue uses an unquoted numeric IN literal', async () => {
		queryRecords = [
			{
				Id: '001000000000001AAA',
				Name: 'Numeric account',
				AnnualRevenue: 100,
				LastModifiedDate: '2026-07-16T00:00:00.000Z',
			},
		];
		const response = await post({ objectName: 'Account', keyField: 'AnnualRevenue', values: ['100'] });
		assert.equal(response.status, 200);
		assert.match(capturedQueries[0], /AnnualRevenue IN \(100\)$/);
		assert.doesNotMatch(capturedQueries[0], /IN \('100'\)/);
		const body = await response.json();
		assert.equal(body.candidatesByValue['100'][0].id, '001000000000001AAA');
	});

	test('numeric spellings normalize when Salesforce returns a JSON number', async () => {
		queryRecords = [{ Id: '001000000000002AAA', Name: 'Normalized', AnnualRevenue: 100 }];
		const response = await post({ objectName: 'Account', keyField: 'AnnualRevenue', values: ['00100.00'] });
		assert.equal(response.status, 200);
		assert.match(capturedQueries[0], /AnnualRevenue IN \(100\)$/);
		const body = await response.json();
		assert.equal(body.candidatesByValue['00100.00'][0].id, '001000000000002AAA');
	});

	test('invalid numeric match values fail before a Salesforce query', async () => {
		const response = await post({
			objectName: 'Account',
			keyField: 'AnnualRevenue',
			values: ["100) OR Name != ''"],
		});
		assert.equal(response.status, 400);
		assert.equal((await response.json()).error, 'invalid-key-value');
		assert.equal(capturedQueries.length, 0);
	});

	test('string keys remain quoted and escaped', async () => {
		const response = await post({ objectName: 'Account', keyField: 'Name', values: ["O'Brien"] });
		assert.equal(response.status, 200);
		assert.match(capturedQueries[0], /Name IN \('O\\'Brien'\)$/);
	});

	test('non-filterable fields fail with actionable guidance and no query', async () => {
		const response = await post({ objectName: 'Account', keyField: 'Description', values: ['Long text'] });
		assert.equal(response.status, 400);
		const body = await response.json();
		assert.equal(body.error, 'key-field-not-filterable');
		assert.equal(body.field, 'Description');
		assert.match(body.message, /cannot be used to find matching records/i);
		assert.match(body.message, /external ID or unique field/i);
		assert.equal(capturedQueries.length, 0);
	});
});

test('exact Salesforce ID matching returns the selected destination candidate', async () => {
	queryRecords = [{ Id: '001000000000001AAA', Name: 'Exact destination' }];
	const response = await post({ objectName: 'Account', keyField: 'Id', values: ['001000000000001AAA'] });
	assert.equal(response.status, 200);
	assert.match(capturedQueries[0], /Id IN \('001000000000001AAA'\)$/);
	assert.equal((await response.json()).candidatesByValue['001000000000001AAA'][0].label, 'Exact destination');
});
