


































import express from 'express';
import { CAPABILITIES } from './capabilities.js';










const _defaults = {




	async getCurrentAccount(req) {
		if (req && req.session && req.session.accountId) {




			return { id: req.session.accountId };
		}




		return null;
	},





	async getCapability(account, capabilityName, _context) {
		if (!CAPABILITIES[capabilityName]) {
			return { allowed: false, reason: 'unknown-capability', capability: capabilityName };
		}
		return { allowed: true, plan: 'self-host', role: 'admin' };
	},




	async getQuota(_account, _dimension) {
		return { cap: null, used: 0, remaining: Infinity };
	},




	async chargeQuota(_account, _dimension, _amount) {
		return { allowed: true, remaining: Infinity };
	},









	async auditWrite(event) {



		try {
			const auditDb = await import('./database/audit.js');
			return await auditDb.record(event);
		} catch (err) {







			try {
				ext.captureException(err, {
					where: 'extensions.auditWrite/default',
					action: event && event.action,
				});
			} catch (_) {                                                 }
			return null;
		}
	},



	async auditRetentionDays(_workspaceId) {
		return null;
	},

















	captureException(err, _context) {
		try {
			const msg = (err && (err.stack || err.message)) || String(err);
			console.warn('[canvas] captureException (no provider registered):', msg);
		} catch (_) {                                                }
	},





	async getActiveWorkspace(_req) {
		return null;
	},




	async getPlanInfo(_account) {
		return { tier: 'self-host', label: 'Self-host' };
	},









	getDb() {
		throw new Error(
			'No database provider registered. The canvas package does not ship a DB ' +
			'initializer; mount the saas layer (which registers one at boot) or ' +
			'self-host by constructing a Kysely instance yourself and calling ' +
			'ext.registerDbProvider(() => yourDb) before importing canvas routes.',
		);
	},





	getRawClient() {
		throw new Error(
			'No raw-client provider registered. Call ext.registerRawClientProvider() ' +
			'with a function that returns { dialect, client }.',
		);
	},
};









const _queues = {
	routeMounts: [],
	migrationsDirs: [],
	staticDirs: [],
	viewDirs: [],
	partialOverrides: {},
	navLinks: [],
};

let _flushed = false;





export const ext = {


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







	saasMounted: false,



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






	registerRoutes(mountFn) {
		if (_flushed) {
throw new Error('registerRoutes called after flush()');
}
		if (typeof mountFn !== 'function') {
throw new TypeError('registerRoutes expects a function');
}
		_queues.routeMounts.push(mountFn);
	},






	registerMigrationsDir(absoluteDir) {
		if (_flushed) {
throw new Error('registerMigrationsDir called after flush()');
}
		if (typeof absoluteDir !== 'string' || !absoluteDir) {
			throw new TypeError('registerMigrationsDir expects an absolute path string');
		}
		_queues.migrationsDirs.push(absoluteDir);
	},




	registerStaticDir(prefix, dir) {
		if (_flushed) {
throw new Error('registerStaticDir called after flush()');
}
		if (!prefix || !dir) {
throw new TypeError('registerStaticDir expects (prefix, dir)');
}
		_queues.staticDirs.push({ prefix, dir });
	},




	registerViewDir(absoluteDir) {
		if (_flushed) {
throw new Error('registerViewDir called after flush()');
}
		if (typeof absoluteDir !== 'string' || !absoluteDir) {
			throw new TypeError('registerViewDir expects an absolute path string');
		}
		_queues.viewDirs.push(absoluteDir);
	},





	registerPartialOverride(name, absolutePath) {
		if (_flushed) {
throw new Error('registerPartialOverride called after flush()');
}
		if (!name || !absolutePath) {
throw new TypeError('registerPartialOverride expects (name, path)');
}
		_queues.partialOverrides[name] = absolutePath;
	},





	registerNavLink(spec) {
		if (_flushed) {
throw new Error('registerNavLink called after flush()');
}
		if (!spec || !spec.label || !spec.href) {
			throw new TypeError('registerNavLink expects { label, href, position?, visibleWhen? }');
		}
		_queues.navLinks.push({ position: 'right', ...spec });
	},






	getPartialPath(name) {
		return _queues.partialOverrides[name] || null;
	},




	getNavLinks() {
		return _queues.navLinks.slice();
	},



	getMigrationsDirs() {
		return _queues.migrationsDirs.slice();
	},














	flush(app) {
		if (_flushed) {
throw new Error('ext.flush() called more than once');
}
		if (!app) {
throw new TypeError('ext.flush(app) expects the Express app');
}

		for (const { prefix, dir } of _queues.staticDirs) {


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
