import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { initTestDb } from './helpers/db.js';
import { ext } from '../src/extensions.js';

let server;
let baseUrl;
let describeError;
let previousAccountResolver;

before(async () => {
	await initTestDb();
	previousAccountResolver = ext.getCurrentAccount;
	ext.registerAuthProvider(async () => ({ id: 'acc_describe', email: 'describe@example.com' }));

	const app = express();
	app.use(express.json());
	app.use((req, _res, next) => {
		req.session = {};
		req.sf = {
			conn: {
				sobject: () => ({
					describe: async () => {
						throw describeError;
					},
					retrieve: async () => {
						throw describeError;
					},
				}),
			},
			sfOrgId: '00D000000000001AAA',
			sfUserId: '005000000000001AAA',
		};
		next();
	});
	const { mountCanvasRoutes } = await import('../src/canvas-routes.js');
	mountCanvasRoutes(app);
	ext.flush(app);
	app.use((error, _req, res, _next) => {
		res.status(599).json({ error: 'test-unhandled', message: error.message });
	});

	server = await new Promise((resolve) => {
		const listening = app.listen(0, () => resolve(listening));
	});
	baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
	ext.registerAuthProvider(previousAccountResolver);
	if (server) {
		await new Promise((resolve) => server.close(resolve));
	}
});

describe('Salesforce object describe errors', () => {
	test('NOT_FOUND becomes an expected object-not-available response', async () => {
		describeError = Object.assign(new Error('The requested resource does not exist'), {
			errorCode: 'NOT_FOUND',
			data: {
				errorCode: 'NOT_FOUND',
				message: 'The requested resource does not exist',
			},
		});

		const response = await fetch(baseUrl + '/api/objects/Removed_Object__c/describe');
		assert.equal(response.status, 404);
		assert.deepEqual(await response.json(), {
			error: 'object-not-available',
			objectName: 'Removed_Object__c',
			message:
				'Removed_Object__c is not available through this Salesforce connection. It may have been removed, or your Salesforce user may not have access.',
		});
	});

	test('Salesforce access errors become an actionable 403 response', async () => {
		describeError = Object.assign(new Error('Forbidden'), {
			statusCode: 403,
			errorCode: 'INSUFFICIENT_ACCESS',
		});

		const response = await fetch(baseUrl + '/api/objects/Restricted_Object__c/describe');
		assert.equal(response.status, 403);
		assert.deepEqual(await response.json(), {
			error: 'object-not-readable',
			objectName: 'Restricted_Object__c',
			message:
				'Your Salesforce user cannot read Restricted_Object__c. Ask a Salesforce administrator for object access, then try again.',
		});
	});

	test('inaccessible records and schema graphs are expected responses too', async () => {
		describeError = Object.assign(new Error('The requested resource does not exist'), {
			errorCode: 'NOT_FOUND',
		});

		const recordResponse = await fetch(baseUrl + '/api/objects/Account/records/001000000000001AAA');
		assert.equal(recordResponse.status, 404);
		assert.deepEqual(await recordResponse.json(), {
			error: 'record-not-available',
			objectName: 'Account',
			recordId: '001000000000001AAA',
			message:
				'This Salesforce record is not available through the current connection. It may have been removed, or your Salesforce user may not have access.',
		});

		const graphResponse = await fetch(baseUrl + '/api/objects/Restricted_Object__c/graph');
		assert.equal(graphResponse.status, 404);
		assert.equal((await graphResponse.json()).error, 'object-not-available');
	});

	test('unexpected describe failures still reach operational error handling', async () => {
		describeError = new Error('Unexpected upstream failure');
		const response = await fetch(baseUrl + '/api/objects/Account/describe');
		assert.equal(response.status, 599);
		assert.equal((await response.json()).error, 'test-unhandled');
	});
});
