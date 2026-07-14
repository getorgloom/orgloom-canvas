import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { initTestDb } from './helpers/db.js';
import { ext } from '../src/extensions.js';

let server;
let baseUrl;
let businessWrites;
let testAccount;

before(async () => {
	await initTestDb();
	const dbProvider = ext.getDb;
	const rawProvider = ext.getRawClient;
	ext._resetForTests();
	ext.registerDbProvider(() => dbProvider());
	ext.registerRawClientProvider(() => rawProvider());
	const { accounts } = await import('../src/database/index.js');
	const viewState = await import('../src/database/view-state.js');
	testAccount = (await accounts.upsertByEmail({ email: 'ledger@example.com' })).account;
	const workspaceId = 'ws_' + crypto.randomUUID();
	const now = Date.now();
	await ext.getDb().insertInto('workspaces').values({
		id: workspaceId,
		name: 'Ledger Test',
		owner_account_id: testAccount.id,
		created_at: now,
		updated_at: now,
	}).execute();
	await ext.getDb().insertInto('workspace_members').values({
		workspace_id: workspaceId,
		account_id: testAccount.id,
		role: 'admin',
		joined_at: now,
	}).execute();
	await viewState.setCurrentWorkspace(testAccount.id, workspaceId);
	ext.registerAuthProvider(async () => testAccount);
	ext.registerCapabilityResolver(async () => ({ allowed: true, role: 'admin', plan: 'team' }));

	const app = express();
	app.use(express.json());
	app.use((req, _res, next) => {
		req.session = { id: 'session-ledger' };
		businessWrites = 0;

		req.sf = {
			sfOrgId: '00D000000000001',
			sfUserId: '005000000000001',
			orgType: 'sandbox',
			conn: {
				instanceUrl: 'https://example.my.salesforce.com',
				accessToken: 'test-access-token',
				query: async () => {
					throw new Error('simulated ledger outage');
				},
				sobject: (name) => ({
					create: async () => {
						if (name !== 'ContentVersion') {
							businessWrites += 1;
						}
						throw new Error('unexpected create');
					},
				}),
			},
		};
		next();
	});

	const { mountCanvasRoutes } = await import('../src/canvas-routes.js');
	mountCanvasRoutes(app);
	ext.flush(app);
	server = await new Promise((resolve) => {
		const s = app.listen(0, () => resolve(s));
	});
	baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
	if (server) {
		await new Promise((resolve) => server.close(resolve));
	}
});

describe('upload ledger fail-closed boundary', () => {
	for (const [index, path] of ['/api/upload', '/api/upload/graph', '/api/upload/bulk'].entries()) {
		test(`${path} returns 503 before business-record DML when the intent store is unavailable`, async () => {
			const response = await fetch(baseUrl + path, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					attemptId: `12345678-1234-1234-1234-123456789ab${index}`,
					records: [{ tempId: 1, objectName: 'Account', values: { Name: 'Must not write' } }],
					associations: [],
				}),
			});
			assert.equal(response.status, 503);
			assert.equal((await response.json()).error, 'upload-ledger-unavailable');
			assert.equal(businessWrites, 0);
		});
	}
});
