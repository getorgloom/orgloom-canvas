// Plug-point registry for the open-core split.
//
// Canvas (the open repo) exposes the interfaces below; SaaS (the closed
// repo) registers implementations against them at boot. When no SaaS is
// mounted, the defaults take over; they are designed so canvas can boot
// standalone in single-user self-host mode with no SaaS code present.
//
// PHASE 2 NOTE: this file ships with the registry + defaults wired up,
// but no canvas call sites have been migrated to consume it yet. Today
// the existing modules (policy.js, audit.js, etc.) still do the work
// directly. The boundary file splits in phase 3 are what convert call
// sites from direct imports to `ext.getCapability(...)`, `ext.audit({...})`,
// etc. Until then, the registry is a stable contract that phase 3 will
// target; saas-mounted production keeps running unchanged.
//
// Design tenets:
//   - Single mutable `ext` object exported once. No factory, no DI;
//     same shape as the existing module-level singletons throughout the
//     codebase. _resetForTests() is the test seam.
//   - Defaults must be safe for canvas-standalone. "Safe" means: a
//     single-user instance with no plan / workspace / billing concept
//     still has a coherent answer. Default capability resolver returns
//     `allowed: true` for known caps (a self-hoster paid for nothing,
//     so they get everything they paid for, which is to say everything
//     the code can do). Unknown capability names still throw:
//     typos shouldn't silently pass.
//   - Registration is order-independent. SaaS can call register* in
//     any order before canvas's first request. There's no implicit
//     "now hand the registry over to canvas"; canvas just reads from
//     the registry at runtime.
//   - Routes / static / views / migrations use a register-then-flush
//     pattern: SaaS calls register* during its boot, then canvas's
//     bootstrap calls flush() once everything is registered. flush()
//     applies the queued mountFns / dirs to the Express app.

import express from 'express';
import { CAPABILITIES } from './capabilities.js';

// ============================================================================
// Default providers
// ============================================================================
//
// Each default is a self-contained function with no SaaS imports. Canvas-
// standalone uses these as-is. SaaS replaces them via the register* setters
// below. Defaults are intentionally minimal: they don't reach into the DB
// for plan / workspace data, because canvas-standalone has none.

const _defaults = {
	// Returns the current account record (or null). Self-host single-user
	// mode returns a stub account whose id is the workspace_id we use for
	// every audit/connection FK. SaaS overrides with session-based lookup
	// (req.session.accountId → accountsDb.findById).
	async getCurrentAccount(req) {
		if (req && req.session && req.session.accountId) {
			// Phase 2: even with no SaaS registered, if the session has
			// an account id we honor it; the existing single-codebase
			// flow stays valid. Phase 3 will replace this with a proper
			// canvas-side stub-account provider.
			return { id: req.session.accountId };
		}
		// Canvas-standalone self-host mode will register a stub-account
		// provider that auto-creates one row on first boot and returns
		// it for every request. Until that exists, we return null and
		// downstream call sites fall back to the unauthenticated path.
		return null;
	},

	// Returns { allowed, reason?, plan?, role? }. Default permits every
	// known capability and rejects unknown names so typos surface. SaaS
	// registers policy.js's resolver which evaluates plan + workspace
	// settings + approvals.
	async getCapability(account, capabilityName, _context) {
		if (!CAPABILITIES[capabilityName]) {
			return { allowed: false, reason: 'unknown-capability', capability: capabilityName };
		}
		return { allowed: true, plan: 'self-host', role: 'admin' };
	},

	// Returns { cap, used, remaining } for a usage dimension like
	// 'ai_tokens', 'uploads', 'shares'. Default: no caps (Infinity).
	// SaaS reads usage_counters + plan caps + workspace credits.
	async getQuota(_account, _dimension) {
		return { cap: null, used: 0, remaining: Infinity };
	},

	// Atomic charge against a quota dimension. Returns { allowed, remaining }.
	// Default always allows. SaaS decrements the appropriate counter and
	// may dip into workspace_credits once the plan cap is exhausted.
	async chargeQuota(_account, _dimension, _amount) {
		return { allowed: true, remaining: Infinity };
	},

	// Audit sink. Default writes to the canvas-side audit_log table.
	// SaaS wraps this to add retention metadata (expires_at based on
	// plan), payload minimization, and SF mirror dispatch.
	//
	// Phase 2: this default delegates to the existing audit module so
	// nothing breaks. Phase 3 will pull the SaaS-specific retention and
	// mirror behavior out of audit.js into a registered audit sink,
	// and the canvas default will be a plain INSERT.
	async auditWrite(event) {
		// Lazy import to avoid circular dependencies at module load and
		// to keep extensions.js dependency-free at the top level. Falls
		// through silently if the DB isn't initialized (e.g. test harness).
		try {
			const auditDb = await import('./database/audit.js');
			return await auditDb.record(event);
		} catch (err) {
			// Activity History write failed. In SaaS this
			// default is overridden by a saas-registered sink, so this
			// branch only fires in canvas-standalone. Report through
			// the capture plug-point (which falls back to console.warn
			// when no provider is registered). Self-reference via `ext`
			// here is fine; it reads the current property off the
			// singleton at call time.
			try {
				ext.captureException(err, {
					where: 'extensions.auditWrite/default',
					action: event && event.action,
				});
			} catch (_) { /* never throw out of the default audit sink */ }
			return null;
		}
	},

	// Returns retention in days, or null for "keep forever". Default:
	// null. SaaS reads the workspace's plan.audit_retention_days.
	async auditRetentionDays(_workspaceId) {
		return null;
	},

	// Telemetry sink for non-fatal exceptions that canvas code chose to
	// swallow (best-effort writes, retention lookups, cleanup hooks,
	// etc). Lets canvas surface "this catch fired" without crashing the
	// user flow and without forcing a hard Sentry dependency on self-
	// hosters. Signature: (err, context?) where context is a plain
	// object of tags / extras the provider can attach.
	//
	// Default behavior in canvas-standalone: console.warn the error so
	// it lands in stdout / Render-style log aggregators. SaaS registers
	// a Sentry-backed provider that calls Sentry.captureException and
	// attaches `source: 'canvas'` plus the supplied context as Sentry
	// tags/extras.
	//
	// Calls into this MUST NOT throw: the call sites are inside catch
	// blocks where re-throwing would defeat the whole point. The provider
	// is wrapped in try/catch at the call site as defense-in-depth.
	captureException(err, _context) {
		try {
			const msg = (err && (err.stack || err.message)) || String(err);
			console.warn('[canvas] captureException (no provider registered):', msg);
		} catch (_) { /* logger itself failed; nothing more to do */ }
	},

	// Returns the active workspace for this request, or null. Self-host
	// single-user mode has no workspace concept; the default returns null.
	// SaaS reads account_view_state.current_workspace_id and resolves the
	// workspace record.
	async getActiveWorkspace(_req) {
		return null;
	},

	// Returns plan info { tier, label } for the account. Default labels
	// self-host so UI surfaces can show "Self-host" instead of "Free".
	// SaaS replaces with the workspace's actual plan.
	async getPlanInfo(_account) {
		return { tier: 'self-host', label: 'Self-host' };
	},

	// Returns the active Kysely instance. There is no default DB layer in
	// canvas; the operational glue (Kysely init, dialect choice, WAL
	// pragmas, migration runner) lives in the saas package, which calls
	// ext.registerDbProvider(...) at boot. Self-hosters wire up their own
	// Kysely instance (the schemas + store modules in this package are
	// all that's needed to drive it) and call registerDbProvider before
	// importing canvas routes. The throw here is the failure surface,
	// not a 500 buried three layers deep.
	getDb() {
		throw new Error(
			'No database provider registered. The canvas package does not ship a DB ' +
			'initializer; mount the saas layer (which registers one at boot) or ' +
			'self-host by constructing a Kysely instance yourself and calling ' +
			'ext.registerDbProvider(() => yourDb) before importing canvas routes.',
		);
	},

	// Returns { dialect, client }: the underlying better-sqlite3 instance
	// or pg.Pool that backs Kysely. Only the express session store needs
	// this (it speaks raw SQL, not Kysely). Same friction story as getDb:
	// canvas doesn't open the DB, so it can't expose the raw client.
	getRawClient() {
		throw new Error(
			'No raw-client provider registered. Call ext.registerRawClientProvider() ' +
			'with a function that returns { dialect, client }.',
		);
	},
};

// ============================================================================
// Registration queues (flushed at boot)
// ============================================================================
//
// SaaS calls register* during its boot; canvas's bootstrap calls flush()
// once everything is registered. Until flush, nothing is applied to the
// Express app. After flush, late registrations are a programmer error.

const _queues = {
	routeMounts: [],     // [(app, ext) => void]
	migrationsDirs: [],  // absolute paths
	staticDirs: [],      // [{ prefix, dir }]
	viewDirs: [],        // absolute paths
	partialOverrides: {}, // { name: path }
	navLinks: [],        // [{ label, href, position?, visibleWhen? }]
};

let _flushed = false;

// ============================================================================
// The exported registry
// ============================================================================

export const ext = {
	// ---- providers (singletons; latest registration wins) ----------------

	getCurrentAccount: _defaults.getCurrentAccount,
	getCapability:     _defaults.getCapability,
	getQuota:          _defaults.getQuota,
	chargeQuota:       _defaults.chargeQuota,
	auditWrite:        _defaults.auditWrite,
	auditRetentionDays: _defaults.auditRetentionDays,
	captureException:  _defaults.captureException,
	getActiveWorkspace: _defaults.getActiveWorkspace,
	getPlanInfo:       _defaults.getPlanInfo,
	getDb:             _defaults.getDb,
	getRawClient:      _defaults.getRawClient,

	// True iff the saas layer has called registerSaasProviders() (or
	// the equivalent register* sequence). UI partials read this via
	// res.locals.saasEnabled to hide multi-tenant chrome (workspace
	// switcher, /workspace link, multi-user sign-out form) when canvas
	// is running standalone. Defaults to false; canvas-standalone never
	// flips it.
	saasMounted: false,

	// ---- registration setters --------------------------------------------

	registerAuthProvider(fn) {
		if (typeof fn !== 'function') {
throw new TypeError('registerAuthProvider expects a function');
}
		this.getCurrentAccount = fn;
	},
	registerCapabilityResolver(fn) {
		if (typeof fn !== 'function') {
throw new TypeError('registerCapabilityResolver expects a function');
}
		this.getCapability = fn;
	},
	registerQuotaProvider(provider) {
		if (!provider || typeof provider !== 'object') {
			throw new TypeError('registerQuotaProvider expects { getQuota, chargeQuota }');
		}
		if (typeof provider.getQuota === 'function') {
this.getQuota = provider.getQuota;
}
		if (typeof provider.chargeQuota === 'function') {
this.chargeQuota = provider.chargeQuota;
}
	},
	registerAuditSink(fn) {
		if (typeof fn !== 'function') {
throw new TypeError('registerAuditSink expects a function');
}
		this.auditWrite = fn;
	},
	registerAuditRetentionPolicy(fn) {
		if (typeof fn !== 'function') {
throw new TypeError('registerAuditRetentionPolicy expects a function');
}
		this.auditRetentionDays = fn;
	},
	registerCaptureException(fn) {
		if (typeof fn !== 'function') {
throw new TypeError('registerCaptureException expects a function');
}
		this.captureException = fn;
	},
	registerActiveWorkspaceProvider(fn) {
		if (typeof fn !== 'function') {
throw new TypeError('registerActiveWorkspaceProvider expects a function');
}
		this.getActiveWorkspace = fn;
	},
	registerPlanInfoProvider(fn) {
		if (typeof fn !== 'function') {
throw new TypeError('registerPlanInfoProvider expects a function');
}
		this.getPlanInfo = fn;
	},
	registerDbProvider(fn) {
		if (typeof fn !== 'function') {
throw new TypeError('registerDbProvider expects a function');
}
		this.getDb = fn;
	},
	registerRawClientProvider(fn) {
		if (typeof fn !== 'function') {
throw new TypeError('registerRawClientProvider expects a function');
}
		this.getRawClient = fn;
	},

	// ---- queued registrations (applied by flush()) -----------------------

	// SaaS calls this with a function that mounts additional Express
	// routes. The function receives (app, ext) so it can read the registry
	// for its own gate checks.
	registerRoutes(mountFn) {
		if (_flushed) {
throw new Error('registerRoutes called after flush()');
}
		if (typeof mountFn !== 'function') {
throw new TypeError('registerRoutes expects a function');
}
		_queues.routeMounts.push(mountFn);
	},

	// Additional migration directory. Canvas's migrations run first
	// (alphanumeric within each dir); each registered dir runs after,
	// in registration order. SaaS migrations carry a different filename
	// prefix (e.g. `saas-006_team_billing.js`) so they sort distinctly
	// inside the combined sequence.
	registerMigrationsDir(absoluteDir) {
		if (_flushed) {
throw new Error('registerMigrationsDir called after flush()');
}
		if (typeof absoluteDir !== 'string' || !absoluteDir) {
			throw new TypeError('registerMigrationsDir expects an absolute path string');
		}
		_queues.migrationsDirs.push(absoluteDir);
	},

	// Additional static-asset directory. The prefix is mounted on the
	// Express app (e.g. registerStaticDir('/saas-js', '/path/to/saas/js')
	// makes files under that path reachable at /saas-js/*).
	registerStaticDir(prefix, dir) {
		if (_flushed) {
throw new Error('registerStaticDir called after flush()');
}
		if (!prefix || !dir) {
throw new TypeError('registerStaticDir expects (prefix, dir)');
}
		_queues.staticDirs.push({ prefix, dir });
	},

	// Additional EJS views directory. Pushed onto Express's views array
	// so include() / render() can resolve templates from either canvas
	// or saas dirs.
	registerViewDir(absoluteDir) {
		if (_flushed) {
throw new Error('registerViewDir called after flush()');
}
		if (typeof absoluteDir !== 'string' || !absoluteDir) {
			throw new TypeError('registerViewDir expects an absolute path string');
		}
		_queues.viewDirs.push(absoluteDir);
	},

	// Override a canvas partial path. Used for top-strip (saas adds the
	// workspace switcher chip) and could be used for other partials in
	// future. Canvas-side render helpers consult ext.getPartialPath(name)
	// before falling back to the canvas-shipped path.
	registerPartialOverride(name, absolutePath) {
		if (_flushed) {
throw new Error('registerPartialOverride called after flush()');
}
		if (!name || !absolutePath) {
throw new TypeError('registerPartialOverride expects (name, path)');
}
		_queues.partialOverrides[name] = absolutePath;
	},

	// Adds an entry to the shared top-strip nav. position is one of
	// 'left' (next to brand) or 'right' (next to user menu). visibleWhen
	// is an optional fn(req) => boolean. SaaS uses this to register
	// /pricing and /workspace links that canvas-standalone doesn't have.
	registerNavLink(spec) {
		if (_flushed) {
throw new Error('registerNavLink called after flush()');
}
		if (!spec || !spec.label || !spec.href) {
			throw new TypeError('registerNavLink expects { label, href, position?, visibleWhen? }');
		}
		_queues.navLinks.push({ position: 'right', ...spec });
	},

	// ---- read-side accessors ---------------------------------------------

	// Used by canvas render helpers to resolve a partial path. Returns
	// the override if registered; the caller falls back to its own path
	// when this returns null.
	getPartialPath(name) {
		return _queues.partialOverrides[name] || null;
	},

	// Used by canvas's top-strip render to compose final nav. Canvas's
	// built-in links come first; registered links append in registration
	// order. The render filter handles visibleWhen.
	getNavLinks() {
		return _queues.navLinks.slice();
	},

	// Used by the migration runner to enumerate all registered migration
	// dirs in order.
	getMigrationsDirs() {
		return _queues.migrationsDirs.slice();
	},

	// ---- lifecycle -------------------------------------------------------

	// Canvas's bootstrap calls this once after its own routes / static
	// dirs / views have been wired up. Applies all queued registrations
	// to the Express app in the canonical order.
	//
	// Order matters:
	//   1. Static dirs (saas overrides may exist for shared paths).
	//   2. View dirs (so render() can resolve saas templates).
	//   3. Route mounts (after canvas's own routes; saas can override
	//      canvas routes by mounting the same path; Express picks first
	//      match, so route ordering becomes important once we start
	//      sharing paths. For phase 2 there's no overlap.)
	flush(app) {
		if (_flushed) {
throw new Error('ext.flush() called more than once');
}
		if (!app) {
throw new TypeError('ext.flush(app) expects the Express app');
}

		for (const { prefix, dir } of _queues.staticDirs) {
			// Lazy import to avoid pulling Express in here unnecessarily.
			// The caller has it; we just need to call app.use.
			app.use(prefix, _staticMiddleware(dir));
		}

		const existingViews = app.get('views');
		const viewsArr = Array.isArray(existingViews)
			? existingViews.slice()
			: (existingViews ? [existingViews] : []);
		for (const v of _queues.viewDirs) {
			if (!viewsArr.includes(v)) {
viewsArr.push(v);
}
		}
		if (viewsArr.length) {
app.set('views', viewsArr);
}

		for (const mountFn of _queues.routeMounts) {
			mountFn(app, ext);
		}

		_flushed = true;
	},

	// Test seam: restores all defaults and clears the queues. Production
	// code should never call this.
	_resetForTests() {
		this.getCurrentAccount = _defaults.getCurrentAccount;
		this.getCapability = _defaults.getCapability;
		this.getQuota = _defaults.getQuota;
		this.chargeQuota = _defaults.chargeQuota;
		this.auditWrite = _defaults.auditWrite;
		this.auditRetentionDays = _defaults.auditRetentionDays;
		this.captureException = _defaults.captureException;
		this.getActiveWorkspace = _defaults.getActiveWorkspace;
		this.getPlanInfo = _defaults.getPlanInfo;
		this.getDb = _defaults.getDb;
		this.getRawClient = _defaults.getRawClient;
		this.saasMounted = false;
		_queues.routeMounts = [];
		_queues.migrationsDirs = [];
		_queues.staticDirs = [];
		_queues.viewDirs = [];
		_queues.partialOverrides = {};
		_queues.navLinks = [];
		_flushed = false;
	},
};

function _staticMiddleware(dir) {
	return express.static(dir);
}
