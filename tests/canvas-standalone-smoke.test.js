// Canvas-standalone smoke test: boots an Express app with ONLY the
// canvas-side route mount (no registerSaasProviders, no saas-routes.js)
// and asserts that:
//   * canvas-only routes mount cleanly (e.g. /api/canvas hits its auth
//     gate rather than 404ing; the registry's default getCurrentAccount
//     returns null without a session, so we expect 401 not 404).
//   * routes that ONLY exist in saas-routes.js are absent; the open-core
//     promise is "you can run canvas without the saas package."
//   * the registry uses the default capability resolver (allowed:true for
//     known caps).
//
// This is the contract that backs the open-core split. After the route
// extraction in apps/saas/src/saas-routes.js, this test would catch a
// regression where a saas-only route accidentally got moved back into
// canvas-routes.js.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { initTestDb } from './helpers/db.js';
import { ext } from '../src/extensions.js';

let app;
let server;
let baseUrl;

before(async () => {
	await initTestDb();
	// Reset to defaults (no saas providers); test DB is already registered
	// by initTestDb. Re-register the providers after the reset so the test
	// DB is still resolvable.
	const dbProvider = ext.getDb;
	const rawProvider = ext.getRawClient;
	ext._resetForTests();
	ext.registerDbProvider(() => dbProvider());
	ext.registerRawClientProvider(() => rawProvider());

	app = express();
	app.use(express.json());
	// Stub session middleware: canvas-standalone uses a session store
	// but we don't need persistence for this smoke test.
	app.use((req, _res, next) => {
 req.session = {}; next(); 
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

describe('canvas-only routes mount and respond', () => {
	test('GET /api/canvas → 401 (auth gate fires, route exists)', async () => {
		const r = await fetch(baseUrl + '/api/canvas');
		assert.equal(r.status, 401);
	});

	test('GET /api/setup → 200 or 404 (page route, not 500)', async () => {
		const r = await fetch(baseUrl + '/api/setup');
		// /api/setup may not exist; canvas-standalone exposes a setup
		// wizard at /setup itself. Either way, status must be a clean
		// HTTP code, not 500 from a crash.
		assert.ok(r.status === 200 || r.status === 401 || r.status === 404);
	});
});

describe('saas-only routes are absent', () => {
	const saasOnlyPaths = [
		'/api/me',
		'/api/me/capabilities',
		'/api/workspaces',
		'/api/workspaces/W/activate',
		'/api/workspaces/W/invite',
		'/api/workspaces/W/members',
		'/api/workspaces/W/leave',
		'/api/workspaces/W/permissions',
		'/api/workspaces/W/pending-joins',
		'/api/activity',
		'/api/activity/export',
		'/api/activity/verify',
		'/api/audit-event',
		'/api/mcp-tokens',
		'/api/account/delete',
		'/api/mcp/relay/listen',
		'/api/mcp/relay/register',
		'/api/mcp/relay/unregister',
		'/api/mcp/relay/respond',
		'/api/mcp/relay/status',
	];

	for (const path of saasOnlyPaths) {
		test(`${path} → 404 (route lives in saas-routes.js, not mounted)`, async () => {
			const r = await fetch(baseUrl + path);
			assert.equal(r.status, 404, path + ' should not exist in canvas-standalone');
		});
	}
});

describe('default capability resolver', () => {
	test('known capability returns allowed=true with plan="self-host"', async () => {
		const r = await ext.getCapability({ id: 'a1' }, 'share-canvas');
		assert.equal(r.allowed, true);
		assert.equal(r.plan, 'self-host');
		assert.equal(r.role, 'admin');
	});

	test('unknown capability returns allowed=false with reason="unknown-capability"', async () => {
		const r = await ext.getCapability({ id: 'a1' }, 'made-up');
		assert.equal(r.allowed, false);
		assert.equal(r.reason, 'unknown-capability');
	});
});
