// Focused unit tests for POST /api/records/refresh validation paths.
// Boots a canvas-only Express app and exercises the request-shape
// validation that fires BEFORE any SF call: no stubbed jsforce conn
// needed.
//
// Deeper integration (per-object SOQL grouping, retrieve→ok/error
// translation, audit-row emission) needs a real conn or a mocked
// jsforce instance; that's covered manually in QA + future Playwright
// rather than baked in here because the harness lift is large for
// one route.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { initTestDb } from './helpers/db.js';
import { ext } from '../src/extensions.js';

let app;
let server;
let baseUrl;
// Set true once the validation describe is active; the pre-mount middleware
// then injects a fake req.sf (with a no-op conn) so requireSfConnection's
// pre-resolved-bundle seam lets the request through to the route's own input
// validation without any real Salesforce call. The mount/401 test leaves it
// false so requireAccount still gates first.
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
	// Registered BEFORE the routes so it runs first in the chain. When the
	// validation suite is active it pre-resolves req.sf with a no-op conn;
	// requireSfConnection then short-circuits (its already-resolved seam),
	// letting the route's synchronous input validation run without a real SF
	// call. The conn's retrieve returns [] so per-record tests don't hit the
	// network either.
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
		// Without a session the default getCurrentAccount returns null,
		// so requireAccount returns 401. The point is to assert mount:
		// a 404 here would mean the route was never registered.
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
	// These tests bypass the auth gate by registering a permissive
	// getCurrentAccount + a permissive capability resolver. The SF
	// connection requirement is faked by registering a session stub
	// that injects a dummy req.sf, which the test fixture sets up.
	//
	// Past this gate, the route's own validation runs synchronously
	// before any conn call; that's exactly what we want to exercise.
	let prevAccountResolver;
	let prevCapResolver;

	before(() => {
		prevAccountResolver = ext.getCurrentAccount;
		prevCapResolver = ext.getCapability;
		ext.registerAuthProvider(async () => ({ id: 'acc_test', email: 'test@x.com' }));
		ext.registerCapabilityResolver(async () => ({ allowed: true, role: 'admin', plan: 'team' }));
		// Turn on the pre-mount fake-req.sf injector (see the outer before).
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
			records: [
				{ objectName: 'Account', sfId: 'not-a-real-id' },
			],
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
