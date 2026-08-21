import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { initTestDb } from './helpers/db.js';
import { ext } from '../src/extensions.js';

let app;
let server;
let baseUrl;
let injectFakeSf = false;

before(async () => {
	await initTestDb();
	const dbProvider = ext.getDb;
	const rawProvider = ext.getRawClient;
	ext._resetForTests();
	ext.registerDbProvider(() => dbProvider());
	ext.registerRawClientProvider(() => rawProvider());

	app = express();
	app.use(express.json());
	app.use((req, _res, next) => {
		req.session = {};
		next();
	});
	app.use('/api/records/refresh', (req, _res, next) => {
		if (injectFakeSf) {
			req.sf = {
				conn: { sobject: () => ({ retrieve: async () => [] }) },
				sfOrgId: '00DTEST',
				sfUserId: '005TEST',
				instanceUrl: 'https://test.my.salesforce.com',
			};
		}
		next();
	});

	const { mountCanvasRoutes } = await import('../src/canvas-routes.js');
	mountCanvasRoutes(app);
	ext.flush(app);

	server = await new Promise((resolve) => {
		const s = app.listen(0, () => resolve(s));
	});
	const port = server.address().port;
	baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
	if (server) {
		await new Promise((r) => server.close(r));
	}
});

describe('POST /api/records/refresh (route mounts)', () => {
	test('route exists (auth gate fires, not 404)', async () => {
		const r = await fetch(baseUrl + '/api/records/refresh', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ records: [] }),
		});
		assert.notEqual(r.status, 404, 'route must be mounted');
		assert.equal(r.status, 401, 'unauthenticated requests get 401');
	});
});

describe('POST /api/records/refresh (validation)', () => {
	let prevAccountResolver;
	let prevCapResolver;

	before(() => {
		prevAccountResolver = ext.getCurrentAccount;
		prevCapResolver = ext.getCapability;
		ext.registerAuthProvider(async () => ({ id: 'acc_test', email: 'test@x.com' }));
		ext.registerCapabilityResolver(async () => ({ allowed: true, role: 'admin', plan: 'team' }));
		injectFakeSf = true;
	});

	after(() => {
		injectFakeSf = false;
		ext.registerAuthProvider(prevAccountResolver);
		ext.registerCapabilityResolver(prevCapResolver);
	});

	const post = (body) =>
		fetch(baseUrl + '/api/records/refresh', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});

	test('empty records array returns 400 records-required', async () => {
		const r = await post({ records: [] });
		assert.equal(r.status, 400);
		const data = await r.json();
		assert.equal(data.error, 'records-required');
	});

	test('201-record request returns 400 too-many-records', async () => {
		const records = [];
		for (let i = 0; i < 201; i++) {
			records.push({ objectName: 'Account', sfId: '001' + String(i).padStart(15, '0') });
		}
		const r = await post({ records });
		assert.equal(r.status, 400);
		const data = await r.json();
		assert.equal(data.error, 'too-many-records');
		assert.equal(data.max, 200);
	});

	test('200-record request passes input validation (does not 400)', async () => {
		const records = [];
		for (let i = 0; i < 200; i++) {
			records.push({ objectName: 'Account', sfId: '001' + String(i).padStart(15, '0') });
		}
		const r = await post({ records });
		assert.notEqual(r.status, 400, 'exactly 200 is the limit and must be accepted');
	});

	test('per-record invalid-object error surfaces in results', async () => {
		const r = await post({
			records: [
				{ objectName: 'Account', sfId: '001000000000000' },
				{ objectName: '!bogus!', sfId: '001000000000001' },
			],
		});
		assert.equal(r.status, 200, 'whole-batch succeeds; per-record errors surface in results');
		const data = await r.json();
		assert.equal(data.results.length, 2);
		const bogus = data.results.find((x) => x.objectName === '!bogus!');
		assert.ok(bogus);
		assert.equal(bogus.ok, false);
		assert.equal(bogus.error, 'invalid-object');
	});

	test('per-record invalid-id error surfaces in results', async () => {
		const r = await post({
			records: [{ objectName: 'Account', sfId: 'not-a-real-id' }],
		});
		assert.equal(r.status, 200);
		const data = await r.json();
		assert.equal(data.results.length, 1);
		assert.equal(data.results[0].ok, false);
		assert.equal(data.results[0].error, 'invalid-id');
	});

	test('missing records key returns 400 records-required', async () => {
		const r = await post({});
		assert.equal(r.status, 400);
		const data = await r.json();
		assert.equal(data.error, 'records-required');
	});
});
