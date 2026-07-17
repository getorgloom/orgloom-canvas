// Locks the registration + flush behavior of the plug-point registry.
// Phase 3 saas-side registration must produce stable behavior; these
// tests assert: registered providers replace defaults, queued
// registrations apply at flush, double-flush throws, register-after-
// flush throws.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ext } from '../src/extensions.js';

beforeEach(() => ext._resetForTests());

// Minimal Express-shaped mock: collects what was registered so we can
// assert the registry applied things correctly. Real Express isn't
// needed since we only care that .use() and .set() were called with
// the right arguments.
function mockApp() {
	const calls = { use: [], set: {} };
	return {
		use(...args) {
 calls.use.push(args); 
},
		set(key, val) {
 calls.set[key] = val; return this; 
},
		get(key) {
 return calls.set[key]; 
},
		_calls: calls,
	};
}

describe('provider replacement', () => {
	test('registerCapabilityResolver replaces the default', async () => {
		const beforeR = await ext.getCapability({ id: 'a' }, 'share-canvas');
		assert.equal(beforeR.allowed, true);

		ext.registerCapabilityResolver(async () => ({ allowed: false, reason: 'plan-insufficient', plan: 'free' }));
		const afterR = await ext.getCapability({ id: 'a' }, 'share-canvas');
		assert.equal(afterR.allowed, false);
		assert.equal(afterR.reason, 'plan-insufficient');
	});

	test('registerAuthProvider replaces the default', async () => {
		ext.registerAuthProvider(async (req) => ({ id: 'override-id', email: req.headers.x }));
		const r = await ext.getCurrentAccount({ headers: { x: 'test@x.com' } });
		assert.equal(r.id, 'override-id');
		assert.equal(r.email, 'test@x.com');
	});

	test('registerQuotaProvider replaces getQuota and chargeQuota', async () => {
		ext.registerQuotaProvider({
			getQuota: async () => ({ cap: 100, used: 75, remaining: 25 }),
			chargeQuota: async (_a, _d, amt) => ({ allowed: amt <= 25, remaining: 25 - amt }),
		});
		const q = await ext.getQuota({}, 'ai_tokens');
		assert.equal(q.cap, 100);
		assert.equal(q.remaining, 25);
		const c1 = await ext.chargeQuota({}, 'ai_tokens', 10);
		assert.equal(c1.allowed, true);
		const c2 = await ext.chargeQuota({}, 'ai_tokens', 50);
		assert.equal(c2.allowed, false);
	});

	test('registerQuotaProvider with partial object preserves missing fns', async () => {
		ext.registerQuotaProvider({
			getQuota: async () => ({ cap: 5, used: 0, remaining: 5 }),
			// no chargeQuota, keeps the default
		});
		const q = await ext.getQuota({}, 'uploads');
		assert.equal(q.cap, 5);
		const c = await ext.chargeQuota({}, 'uploads', 100);
		assert.equal(c.allowed, true);
		assert.equal(c.remaining, Infinity);
	});

	test('registerActiveWorkspaceProvider replaces the default', async () => {
		ext.registerActiveWorkspaceProvider(async (req) => ({ id: 'ws_1', name: 'Acme', userId: req.session.accountId }));
		const ws = await ext.getActiveWorkspace({ session: { accountId: 'a1' } });
		assert.equal(ws.id, 'ws_1');
		assert.equal(ws.userId, 'a1');
	});

	test('registerPlanInfoProvider replaces the default', async () => {
		ext.registerPlanInfoProvider(async () => ({ tier: 'pro', label: 'Pro' }));
		const r = await ext.getPlanInfo({});
		assert.equal(r.tier, 'pro');
		assert.equal(r.label, 'Pro');
	});
});

describe('type validation', () => {
	test('registerAuthProvider rejects non-function', () => {
		assert.throws(() => ext.registerAuthProvider(null), TypeError);
		assert.throws(() => ext.registerAuthProvider('x'), TypeError);
	});

	test('registerCapabilityResolver rejects non-function', () => {
		assert.throws(() => ext.registerCapabilityResolver(42), TypeError);
	});

	test('registerQuotaProvider rejects non-object', () => {
		assert.throws(() => ext.registerQuotaProvider(null), TypeError);
		assert.throws(() => ext.registerQuotaProvider('x'), TypeError);
	});

	test('registerRoutes rejects non-function', () => {
		assert.throws(() => ext.registerRoutes('not a fn'), TypeError);
	});

	test('registerMigrationsDir rejects non-string', () => {
		assert.throws(() => ext.registerMigrationsDir(123), TypeError);
		assert.throws(() => ext.registerMigrationsDir(''), TypeError);
	});

	test('registerStaticDir rejects missing args', () => {
		assert.throws(() => ext.registerStaticDir('/x'), TypeError);
		assert.throws(() => ext.registerStaticDir(null, '/dir'), TypeError);
	});

	test('registerNavLink requires label and href', () => {
		assert.throws(() => ext.registerNavLink({ label: 'x' }), TypeError);
		assert.throws(() => ext.registerNavLink({ href: '/y' }), TypeError);
	});
});

describe('queued registrations + flush', () => {
	test('static dirs apply on flush', () => {
		ext.registerStaticDir('/saas-js', '/abs/path/to/saas/js');
		const app = mockApp();
		ext.flush(app);
		assert.equal(app._calls.use.length, 1);
		assert.equal(app._calls.use[0][0], '/saas-js');
		assert.equal(typeof app._calls.use[0][1], 'function');
	});

	test('view dirs are appended to existing app views', () => {
		ext.registerViewDir('/abs/views/saas');
		const app = mockApp();
		app.set('views', '/abs/views/canvas');
		ext.flush(app);
		assert.deepEqual(app._calls.set.views, ['/abs/views/canvas', '/abs/views/saas']);
	});

	test('view dirs work when no existing views set', () => {
		ext.registerViewDir('/abs/views/saas');
		const app = mockApp();
		ext.flush(app);
		assert.deepEqual(app._calls.set.views, ['/abs/views/saas']);
	});

	test('multiple view dirs deduplicate', () => {
		ext.registerViewDir('/abs/views/saas');
		ext.registerViewDir('/abs/views/saas'); // dup
		const app = mockApp();
		app.set('views', '/abs/views/canvas');
		ext.flush(app);
		assert.deepEqual(app._calls.set.views, ['/abs/views/canvas', '/abs/views/saas']);
	});

	test('route mounts run in registration order', () => {
		const order = [];
		ext.registerRoutes(() => order.push('first'));
		ext.registerRoutes(() => order.push('second'));
		ext.registerRoutes(() => order.push('third'));
		ext.flush(mockApp());
		assert.deepEqual(order, ['first', 'second', 'third']);
	});

	test('route mountFn receives (app, ext)', () => {
		let received = null;
		ext.registerRoutes((app, extArg) => {
 received = { app, extArg }; 
});
		const app = mockApp();
		ext.flush(app);
		assert.equal(received.app, app);
		assert.equal(received.extArg, ext);
	});

	test('flush throws if called twice', () => {
		ext.flush(mockApp());
		assert.throws(() => ext.flush(mockApp()), /more than once/);
	});

	test('flush rejects missing app', () => {
		assert.throws(() => ext.flush(), TypeError);
		assert.throws(() => ext.flush(null), TypeError);
	});

	test('registerRoutes after flush throws', () => {
		ext.flush(mockApp());
		assert.throws(() => ext.registerRoutes(() => {}), /after flush/);
	});

	test('registerStaticDir after flush throws', () => {
		ext.flush(mockApp());
		assert.throws(() => ext.registerStaticDir('/x', '/y'), /after flush/);
	});

	test('registerViewDir after flush throws', () => {
		ext.flush(mockApp());
		assert.throws(() => ext.registerViewDir('/x'), /after flush/);
	});

	test('registerMigrationsDir after flush throws', () => {
		ext.flush(mockApp());
		assert.throws(() => ext.registerMigrationsDir('/x'), /after flush/);
	});

	test('registerPartialOverride after flush throws', () => {
		ext.flush(mockApp());
		assert.throws(() => ext.registerPartialOverride('top-strip', '/x'), /after flush/);
	});

	test('registerNavLink after flush throws', () => {
		ext.flush(mockApp());
		assert.throws(() => ext.registerNavLink({ label: 'Pricing', href: '/pricing' }), /after flush/);
	});
});

describe('partial overrides', () => {
	test('registered partial path returned by getPartialPath', () => {
		ext.registerPartialOverride('top-strip', '/abs/path/saas-top-strip.ejs');
		assert.equal(ext.getPartialPath('top-strip'), '/abs/path/saas-top-strip.ejs');
	});

	test('unregistered partial returns null', () => {
		assert.equal(ext.getPartialPath('nonexistent'), null);
	});

	test('later registration overrides earlier (last wins)', () => {
		ext.registerPartialOverride('top-strip', '/first.ejs');
		ext.registerPartialOverride('top-strip', '/second.ejs');
		assert.equal(ext.getPartialPath('top-strip'), '/second.ejs');
	});
});

describe('nav links', () => {
	test('registered links appear in getNavLinks', () => {
		ext.registerNavLink({ label: 'Pricing', href: '/pricing' });
		ext.registerNavLink({ label: 'Workspace', href: '/workspace', position: 'left' });
		const links = ext.getNavLinks();
		assert.equal(links.length, 2);
		assert.equal(links[0].label, 'Pricing');
		assert.equal(links[0].position, 'right'); // default
		assert.equal(links[1].position, 'left');
	});

	test('returned array is a copy (callers cannot mutate registry state)', () => {
		ext.registerNavLink({ label: 'Pricing', href: '/pricing' });
		const links = ext.getNavLinks();
		links.push({ label: 'Sneaky', href: '/sneaky' });
		assert.equal(ext.getNavLinks().length, 1);
	});
});

describe('migration dirs', () => {
	test('registered dirs returned in order', () => {
		ext.registerMigrationsDir('/abs/saas/migrations');
		ext.registerMigrationsDir('/abs/other/migrations');
		const dirs = ext.getMigrationsDirs();
		assert.deepEqual(dirs, ['/abs/saas/migrations', '/abs/other/migrations']);
	});

	test('returned array is a copy', () => {
		ext.registerMigrationsDir('/abs/x');
		const dirs = ext.getMigrationsDirs();
		dirs.push('/abs/sneaky');
		assert.equal(ext.getMigrationsDirs().length, 1);
	});
});
