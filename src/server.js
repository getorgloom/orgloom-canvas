// Org Loom Canvas: standalone server entry point.
//
// This is the entry the public orgloom-canvas repo uses. It runs the
// canvas in single-user / self-host mode: no signup, no workspaces,
// no billing, no multi-user auth, no audit retention enforcement. One
// implicit local account; one SF connection at a time (per session).
//
// For the hosted SaaS deployment (multi-user, billing, etc.) the entry
// is apps/saas/src/server.js in the monorepo; this file isn't used
// there.
//
// What this server mounts:
//   - DB init (canvas-side migrations only)
//   - Express + sessions (SQLite-backed)
//   - Static assets (canvas /css, /js, /img, /vendor)
//   - EJS views (canvas views/)
//   - First-boot setup wizard at /setup (SF Connected App config)
//   - / + /connect: landing + SF picker
//   - /auth/login, /auth/callback, /auth/sf-signout, /auth/logout
// SF OAuth lifecycle routes
//   - /mcp/v1: MCP server endpoint
//   - mountCanvasRoutes(app): all /api/* canvas routes
//
// What this server intentionally does NOT mount:
//   - /sign-in, /signup, /workspace, /pricing, /onboarding/* (saas-only)
//   - Stripe webhook + billing routes
//   - Admin pages
//   - Magic-link / Google / Microsoft IdP sign-in
//   - Saas-side crons (Stripe reconciler, audit retention sweep)

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { doubleCsrf } from 'csrf-csrf';
import jsforce from 'jsforce';
import { createSqliteSessionStore } from './database/sqlite-session-store.js';
import connectPgSimpleFactory from 'connect-pg-simple';
import { config } from './config.js';
import { createOAuth2 } from './auth.js';
import { connections as connectionsDb } from './database/index.js';
import { getActiveSfConnection } from './sf-connection.js';
import { putRefreshToken, dropSessionRefreshTokens } from './sf-refresh-store.js';
import { canvasStoreFromSfConnection } from './storage/canvas-store.js';
import { ext } from './extensions.js';
import { mountCanvasRoutes, mountSetupWizard } from './canvas-routes.js';
import { mcpHandler } from './mcp/server.js';

const { Connection } = jsforce;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Canvas-standalone bootstrap: the open-core split moved the Kysely
// init layer to apps/saas/src/database/init.js, so canvas no longer
// ships an initDb() of its own. Self-hosters who run this server
// directly must register a DB provider (and run migrations) BEFORE
// importing this module, typically in a small wrapper script:
//
//   import { ext } from 'orgloom-canvas/extensions';
//   // ...build Kysely instance + run migrations against canvas/migrations/...
//   ext.registerDbProvider(() => myDb);
//   ext.registerRawClientProvider(() => ({ dialect, client }));
//   await import('orgloom-canvas/server');
//
// The probe below fails fast with a clear error if no provider has been
// registered, rather than letting the first DB-touching request 500.
try {
	ext.getDb();
} catch (err) {
	console.error('[boot] canvas-standalone requires a DB provider registered before import:', err.message);
	throw err;
}
console.log('[db] ready:', ext.getRawClient().dialect);

// ---- canvas-standalone implicit local user --------------------------------
//
// Canvas-standalone has no signup flow. One implicit account exists,
// hardcoded to id='local'. The /auth/callback handler creates it on
// first SF connect; SF connections + audit rows reference it as their
// account_id. The accounts table itself exists (created by canvas
// migration 001_init) but is essentially single-row in this mode.
const LOCAL_ACCOUNT_ID = 'local';

async function ensureLocalAccount() {
	const db = ext.getDb();
	const now = Date.now();
	await db
		.insertInto('accounts')
		.values({
			id: LOCAL_ACCOUNT_ID,
			email: 'self-host@local',
			display_name: 'Self-host user',
			deleted_at: null,
			created_at: now,
			updated_at: now,
		})
		.onConflict((oc) => oc.column('id').doNothing())
		.execute();
	return { id: LOCAL_ACCOUNT_ID, email: 'self-host@local', display_name: 'Self-host user' };
}

// Canvas-standalone authProvider: returns the implicit local account if
// the session has been bootstrapped via /auth/callback. Otherwise null
// (so /api/me + canvas-routes treat the request as unauthenticated and
// the landing-page CTA still renders).
ext.registerAuthProvider(async (req) => {
	if (!req || !req.session || !req.session.accountId) {
return null;
}
	if (req.session.accountId !== LOCAL_ACCOUNT_ID) {
return null;
}
	return { id: LOCAL_ACCOUNT_ID, email: 'self-host@local', display_name: 'Self-host user' };
});

// ---- session store --------------------------------------------------------

const _rawDb = ext.getRawClient();
let _sessionStore = null;
if (_rawDb.dialect === 'sqlite') {
	const SqliteStore = createSqliteSessionStore(session.Store);
	_sessionStore = new SqliteStore({
		client: _rawDb.client,
		cleanupIntervalMs: 1000 * 60 * 15,
	});
} else {
	const PgStore = connectPgSimpleFactory(session);
	_sessionStore = new PgStore({ pool: _rawDb.client, createTableIfMissing: true });
}

const app = express();
app.set('trust proxy', 1);

// Suppress X-Powered-By + apply security headers. See apps/saas/src/server.js
// for the rationale on each directive.
app.disable('x-powered-by');

// Per-request CSP nonce; see apps/saas/src/server.js for the full
// explanation. Must run before helmet so res.locals.cspNonce is set
// when helmet's directive function fires.
app.use((req, res, next) => {
	res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
	next();
});

app.use(helmet({
	contentSecurityPolicy: {
		useDefaults: true,
		directives: {
			'default-src': ["'self'"],
			// Safari applies upgrade-insecure-requests to localhost more
			// aggressively than Chromium. Disable the directive only for local
			// HTTP development so styles and scripts are not rewritten to an
			// HTTPS origin the development server does not provide.
			'upgrade-insecure-requests': process.env.NODE_ENV === 'production' ? [] : null,
			// posthog.com host allowed so the PostHog loader (which
			// appends an external <script>) can run. See
			// apps/saas/src/server.js for the long-form rationale.
			// browser.sentry-cdn.com hosts the @sentry/browser SDK bundle
			// (v7+ stopped shipping a pre-built bundle in the npm package
			// , since Sentry's recommended path without a bundler is the CDN).
			// Specific subdomain, not wildcarded, so a compromise of a
			// sibling Sentry CDN host can't backdoor our pages.
			'script-src': ["'self'", 'https://*.posthog.com', 'https://browser.sentry-cdn.com', (req, res) => `'nonce-${res.locals.cspNonce}'`],
			// See apps/saas/src/server.js for the style-src split rationale.
			'style-src': ["'self'"],
			// Cytoscape's renderer injects one inline <style> block at
			// canvas init. See apps/saas/src/server.js for the full
			// rationale; the hash needs to match across both files so
			// canvas-standalone and saas deployments behave identically.
			'style-src-elem': [
				"'self'",
				"'sha256-pgvDUBa4IjFA2yuSJ2cqcyxmNYJMborsd0ORcRv9vw8='", // cytoscape v3.x renderer init
			],
			'style-src-attr': ["'unsafe-inline'"],
			'img-src': ["'self'", 'data:', 'https://*.posthog.com'],
			'font-src': ["'self'", 'data:'],
			// Sentry SDK POSTs event payloads to its ingest endpoint. Host
			// comes from SENTRY_INGEST_HOST env (typically the host part
			// of the DSN, e.g. `<project>.ingest.sentry.io` or a self-
			// hosted GlitchTip). Mirrors the saas-server CSP shape so
			// browser-side error reporting works identically in either
			// deployment mode when the env var is set.
			// browser.sentry-cdn.com is also in connect-src because the
			// minified bundle includes a `//# sourceMappingURL=...map`
			// trailer; DevTools loads that map via a script-initiated
			// fetch, which CSP routes through connect-src (not script-
			// src). Production users without DevTools open never trigger
			// this, but devs see a CSP violation in the console without
			// the entry.
			'connect-src': ["'self'", 'https://*.posthog.com', 'https://browser.sentry-cdn.com', ...(process.env.SENTRY_INGEST_HOST ? ['https://' + process.env.SENTRY_INGEST_HOST] : [])],
			'frame-src': ["'self'", 'https://www.youtube.com', 'https://www.youtube-nocookie.com'],
			'frame-ancestors': ["'self'"],
			'object-src': ["'none'"],
			'base-uri': ["'self'"],
			// See apps/saas/src/server.js for the long-form rationale.
			// Canvas-standalone only does SF OAuth, not Google/MS/Stripe,
			// but listing them here means the canvas module's CSP
			// works unchanged in both deployment modes.
			'form-action': [
				"'self'",
				'https://login.salesforce.com',
				'https://test.salesforce.com',
				'https://*.my.salesforce.com',
				'https://*.salesforce.com',
				'https://*.force.com',
				'https://accounts.google.com',
				'https://login.microsoftonline.com',
				'https://checkout.stripe.com',
				'https://billing.stripe.com',
			],
		},
	},
	crossOriginEmbedderPolicy: false,
	...(process.env.NODE_ENV === 'production' ? {} : { strictTransportSecurity: false }),
}));

// CORP override for public-embedding paths. See apps/saas/src/server.js
// for the full rationale; the headers must match across both deployments
// so the brand logo + /.well-known endpoints behave the same way for
// SaaS users and self-hosters.
app.use(['/img/brand', '/.well-known'], (req, res, next) => {
	res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
	next();
});

app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
	store: _sessionStore,
	secret: config.sessionSecret,
	resave: false,
	saveUninitialized: false,
	cookie: {
		httpOnly: true,
		secure: process.env.NODE_ENV === 'production',
		sameSite: 'lax',
		maxAge: 1000 * 60 * 60 * 24 * 30,
	},
}));

// Rotate the session id while preserving the payload. Called at
// privilege-elevation boundaries (e.g., SF OAuth callback) to defend
// against session fixation. Mirrors the helper in apps/saas/src/server.js.
function _regenerateSession(req) {
	return new Promise((resolve, reject) => {
		const carryover = {};
		for (const k of Object.keys(req.session)) {
			if (k === 'cookie') {
continue;
}
			carryover[k] = req.session[k];
		}
		req.session.regenerate((err) => {
			if (err) {
return reject(err);
}
			for (const k of Object.keys(carryover)) {
req.session[k] = carryover[k];
}
			req.session.save((saveErr) => {
				if (saveErr) {
return reject(saveErr);
}
				resolve();
			});
		});
	});
}

// ---- CSRF protection (double-submit cookie) -------------------------------
// See apps/saas/src/server.js for the long-form rationale. Same setup
// here so the standalone canvas binary has equivalent defense.
app.use(cookieParser(config.sessionSecret));

const { doubleCsrfProtection, generateCsrfToken } = doubleCsrf({
	getSecret: () => config.sessionSecret,
	getSessionIdentifier: (req) => req.session?.id || req.ip || 'anonymous',
	cookieName: process.env.NODE_ENV === 'production' ? '__Host-csrf' : 'csrf',
	cookieOptions: {
		httpOnly: true,
		sameSite: 'lax',
		secure: process.env.NODE_ENV === 'production',
		path: '/',
	},
	size: 64,
	ignoredMethods: ['GET', 'HEAD', 'OPTIONS'],
	getCsrfTokenFromRequest: (req) =>
		req.headers['x-csrf-token'] ||
		req.headers['x-xsrf-token'] ||
		(req.body && req.body._csrf) ||
		(req.query && req.query._csrf),
});

const _CSRF_EXEMPT_PATHS = new Set([
	'/setup',           // First-boot wizard: no session exists yet.
]);
const _CSRF_EXEMPT_PREFIXES = [
	'/auth/callback',                    // SF OAuth, state-validated.
	'/auth/account/google/callback',
	'/auth/account/microsoft/callback',
];
app.use((req, res, next) => {
	if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
		// Force session persistence (see apps/saas/src/server.js for why).
		if (req.session && !req.session._csrfInit) {
req.session._csrfInit = 1;
}
		res.locals.csrfToken = generateCsrfToken(req, res);
		return next();
	}
	if (_CSRF_EXEMPT_PATHS.has(req.path)) {
return next();
}
	if (_CSRF_EXEMPT_PREFIXES.some((p) => req.path.startsWith(p))) {
return next();
}
	return doubleCsrfProtection(req, res, next);
});

app.use((err, req, res, next) => {
	if (err && err.code === 'EBADCSRFTOKEN' || err?.name === 'ForbiddenError') {
		if (req.path && req.path.startsWith('/api/')) {
			return res.status(403).json({ error: 'csrf-token-invalid', message: 'CSRF token missing or invalid. Reload the page and try again.' });
		}
		return res.status(403).send('CSRF token missing or invalid. Reload the page and try again.');
	}
	next(err);
});

// jsonForScript: safe JSON serialization for inline <script> blocks.
// See apps/saas/src/server.js for the long-form rationale.
app.locals.jsonForScript = (value) => {
	return JSON.stringify(value)
		.replace(/</g, '\\u003c')
		.replace(/\u2028/g, '\\u2028')
		.replace(/\u2029/g, '\\u2029');
};

// Auto-inject <meta name="csrf-token"> into HTML responses. See the
// matching block in apps/saas/src/server.js for the rationale.
app.use((req, res, next) => {
	const _send = res.send.bind(res);
	res.send = function patchedSend(body) {
		try {
			if (typeof body === 'string' && res.locals.csrfToken) {
				const ct = res.get('content-type') || '';
				if (ct.includes('text/html') || (!ct && body.toLowerCase().includes('<head'))) {
					const tag = `<meta name="csrf-token" content="${res.locals.csrfToken}">`;
					body = body.replace(/<head(\s[^>]*)?>/i, (m) => `${m}${tag}`);
				}
			}
		} catch (err) {
			// CSRF tag injection failed: every HTML response in this
			// process will be missing its meta tag, breaking every form.
			// Worth reporting; the original body still ships so the
			// response itself isn't broken (just CSRF-tokenless).
			try {
				ext.captureException(err, {
					where: 'server/csrfMetaInjection',
					path: req.path,
				});
			} catch (_) { /* fall through with original body regardless */ }
		}
		return _send(body);
	};
	next();
});

// ---- views + static -------------------------------------------------------

app.set('view engine', 'ejs');
app.set('views', [path.join(__dirname, 'views')]);
app.use('/css', express.static(path.join(__dirname, 'public/css')));
app.use('/js', express.static(path.join(__dirname, 'public/js')));
app.use('/img', express.static(path.join(__dirname, 'public/img')));
app.use('/vendor', express.static(fileURLToPath(new URL('../../../node_modules', import.meta.url))));
app.use(express.static(path.join(__dirname, 'public')));

// Saas extensions never registered in this entry; flush is a no-op but
// keeps the contract consistent.
ext.flush(app);

// First-boot setup wizard. Runs BEFORE any other route handlers so an
// unconfigured instance redirects every request to /setup.
mountSetupWizard(app);

// Stamp request path + saasEnabled (always false here) onto res.locals
// so views can hide saas chrome and active-mark nav links.
app.use((req, res, next) => {
	res.locals.currentPath = req.path;
	res.locals.saasEnabled = false;
	// PostHog config. Canvas-standalone is typically self-hosted by
	// a single user; analytics is opt-in and off by default. Same
	// env vars as saas mode so a config copy-paste works.
	res.locals.posthogKey = process.env.POSTHOG_KEY || '';
	res.locals.posthogHost = process.env.POSTHOG_HOST || 'https://app.posthog.com';
	next();
});

// ---- pages ----------------------------------------------------------------

// /: canvas or "connect Salesforce" CTA depending on session state.
app.get('/', async (req, res, next) => {
	try {
		const account = await ext.getCurrentAccount(req);
		if (!account) {
			return res.render('index', {
				user: null,
				connection: null,
				instanceUrl: null,
				betaGateEnabled: false,
			});
		}
		// Active connection? Resolve via session.currentConnectionId.
		let connection = null;
		if (req.session.currentConnectionId) {
			connection = await connectionsDb.findById(req.session.currentConnectionId);
			if (connection && connection.account_id !== account.id) {
connection = null;
}
		}
		const sfAuth = req.session && req.session.sfAuth;
		const usable = !!(sfAuth && sfAuth.accessToken && sfAuth.instanceUrl)
			&& connection && !connection.disabled_at;
		if (!usable) {
			return res.render('index', {
				user: {
					id: account.id,
					username: account.email,
					displayName: account.display_name,
					organizationId: null,
					sfUserId: null,
				},
				connection: null,
				instanceUrl: null,
				needsSfConnect: true,
				betaGateEnabled: false,
			});
		}
		res.render('index', {
			user: {
				id: account.id,
				username: account.email,
				displayName: account.display_name,
				organizationId: sfAuth.organizationId || sfAuth.sfOrgId || connection.sf_org_id,
				sfUserId: sfAuth.sfUserId || connection.sf_user_id,
			},
			connection,
			instanceUrl: sfAuth.instanceUrl,
			needsSfConnect: false,
			betaGateEnabled: false,
		});
	} catch (err) {
 next(err); 
}
});

// /connect: SF org picker. In canvas-standalone, anon visitors bounce
// back to / (which renders the SF-connect CTA).
app.get('/connect', async (req, res, next) => {
	try {
		const account = await ext.getCurrentAccount(req);
		if (!account) {
return res.redirect('/');
}
		const conns = await connectionsDb.listForAccount(account.id);
		res.render('connect', {
			accountEmail: account.email,
			activeWorkspace: null,
			workspaceSettings: null,
			existingConnections: conns.map((c) => ({
				username: c.display_username,
				email: c.email,
				sfUserId: c.sf_user_id,
				sfOrgId: c.sf_org_id,
				instanceUrl: c.instance_url,
				orgType: c.org_type,
			})),
			errorCode: typeof req.query.error === 'string' ? req.query.error : null,
			user: { id: account.id, username: account.email, displayName: account.display_name },
		});
	} catch (err) {
 next(err); 
}
});

// ---- Salesforce OAuth -----------------------------------------------------

// Whitelist of SF host patterns accepted as ?env=custom domain values.
// Stops the OAuth-start endpoint from being used as an open redirector.
// Hostname chars only; see apps/saas/src/server.js for the rationale.
const _SF_HOST_PATTERN = /^https:\/\/[a-z0-9.-]+(?:\.salesforce\.com|\.lightning\.force\.com)(\/.*)?$/i;
function _normalizeCustomSfDomain(value) {
	const raw = typeof value === 'string' ? value.trim() : '';
	if (!raw) {
		return '';
	}
	if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) {
		return raw;
	}
	return `https://${raw}`;
}
function _canonicalizeSfLoginUrl(value) {
	const raw = typeof value === 'string' ? value.trim() : '';
	if (!raw || !_SF_HOST_PATTERN.test(raw)) {
		return '';
	}
	const parsed = new URL(raw);
	let hostname = parsed.hostname.toLowerCase();
	if (hostname.endsWith('.lightning.force.com')) {
		hostname = hostname.slice(0, -'.lightning.force.com'.length) + '.my.salesforce.com';
	}
	return `https://${hostname}`;
}
function _resolveSfLoginUrl(req) {
	const env = String(req.query.env || '').toLowerCase();
	if (env === 'prod') {
return { url: 'https://login.salesforce.com', invalid: false };
}
	if (env === 'sandbox') {
return { url: 'https://test.salesforce.com', invalid: false };
	}
	if (env === 'custom') {
		const raw = _normalizeCustomSfDomain(req.query.domain);
		const canonical = _canonicalizeSfLoginUrl(raw);
		if (canonical) {
return { url: canonical, invalid: false };
}
		return { url: null, invalid: true };
	}
	if (typeof req.query.loginUrl === 'string' && req.query.loginUrl) {
		const raw = req.query.loginUrl.trim();
		const canonical = _canonicalizeSfLoginUrl(raw);
		if (canonical) {
return { url: canonical, invalid: false };
}
		return { url: null, invalid: true };
	}
	return { url: null, invalid: false };
}

app.get('/auth/login', (req, res) => {
	const resolved = _resolveSfLoginUrl(req);
	if (resolved.invalid) {
return res.redirect('/connect?error=invalid-domain');
}
	const priorSessionUrl = _canonicalizeSfLoginUrl(req.session.sfLoginUrl) || null;
	const loginUrlOverride = resolved.url || priorSessionUrl || null;
	if (loginUrlOverride) {
		req.session.sfLoginUrl = loginUrlOverride;
	}
	const oauth2 = createOAuth2(loginUrlOverride);
	const authParams = { state: req.session.id };
	if (config.salesforce.scope) {
authParams.scope = config.salesforce.scope;
}
	if (req.query.force === '1' || req.query.force === 'login') {
authParams.prompt = 'login';
}
	res.redirect(oauth2.getAuthorizationUrl(authParams));
});

// Canvas-standalone /auth/callback: simpler than saas. No signup-intent
// branching, no cross-account collision check (single user), no
// pendingCanvasShare path. Always ensure the local account exists, bind
// the SF connection to it, stamp the session.
app.get('/auth/callback', async (req, res, next) => {
	try {
		const code = req.query.code;
		if (!code) {
return res.status(400).send('Missing OAuth code.');
}
		// OAuth CSRF defense; see apps/saas/src/server.js for full
		// rationale. The state param MUST be present and equal to the
		// session ID we set on /auth/login. Fail-closed: a missing state
		// is rejected, not skipped.
		const state = typeof req.query.state === 'string' ? req.query.state : null;
		if (!state || !req.session?.id || state !== req.session.id) {
			console.warn('[sf-oauth] state missing/mismatch on /auth/callback (possible CSRF)');
			return res.status(400).send('Salesforce sign-in failed a security check (state mismatch). Try again from the start.');
		}
		const callbackLoginUrl = _canonicalizeSfLoginUrl(req.session.sfLoginUrl) || null;
		if (callbackLoginUrl) {
			req.session.sfLoginUrl = callbackLoginUrl;
		}
		const oauth2 = createOAuth2(callbackLoginUrl);
		const conn = new Connection({ oauth2, version: config.salesforce.apiVersion });
		let userInfo;
		try {
			userInfo = await conn.authorize(code);
		} catch (error) {
			const oauthError = [error?.name, error?.code, error?.message]
				.filter((value) => typeof value === 'string')
				.join(' ')
				.toLowerCase();
			if (oauthError.includes('unsupported_grant_type')
				|| oauthError.includes('grant type not supported')) {
				delete req.session.sfLoginUrl;
				return res.status(400).send('The Salesforce URL was not an OAuth login endpoint. Return to Connect and try the org again; copied Lightning URLs are converted automatically.');
			}
			throw error;
		}
		const identity = await conn.identity();

		const account = await ensureLocalAccount();
		const connection = await connectionsDb.upsertFromOauth({
			accountId: account.id,
			sfUserId: userInfo.id,
			sfOrgId: userInfo.organizationId || identity.organization_id,
			instanceUrl: conn.instanceUrl,
			displayUsername: identity.username || identity.email,
			displayName: identity.display_name,
			email: identity.email,
		});

		req.session.accountId = account.id;
		req.session.currentConnectionId = connection.id;
		const _sfAuth = {
			accessToken: conn.accessToken,
			instanceUrl: conn.instanceUrl,
			sfUserId: userInfo.id,
			sfOrgId: userInfo.organizationId || identity.organization_id || null,
			organizationId: userInfo.organizationId || identity.organization_id || null,
		};
		req.session.sfAuth = _sfAuth;
		// Multi-token switching: keep this connection's access token in the
		// session's per-connection map so a later switch back to it is an
		// instant in-session flip (no re-OAuth). Same posture as the single
		// active token: short-lived access tokens in the server session,
		// N instead of 1; refresh tokens still never persisted.
		req.session.sfAuthByConnection = req.session.sfAuthByConnection || {};
		req.session.sfAuthByConnection[connection.id] = _sfAuth;

		// Session-fixation defense: rotate the session id whenever the
		// session crosses the unauthenticated -> authenticated boundary.
		// See _regenerateSession in apps/saas/src/server.js for the
		// long-form rationale. Inline here because canvas-standalone
		// runs without the saas module.
		await _regenerateSession(req);

		// If the Connected App granted offline_access, keep the issued
		// refresh token in process memory ONLY (never persisted) so the
		// access token can be silently renewed for long sessions. Keyed by
		// the post-regeneration session id.
		if (conn.refreshToken) {
			putRefreshToken(req.session.id, connection.id, conn.refreshToken);
		}

		ext.auditWrite({
			req,
			workspaceId: null,
			actorAccountId: account.id,
			actorConnectionId: connection.id,
			action: 'sf_org_connected',
			targetSfOrgId: userInfo.organizationId || identity.organization_id || null,
			// sfUserId identifies the connected SF identity; the email would
			// be redundant PII (and the saas sf_org_connected already omits it).
			payload: { sfUserId: userInfo.id },
		}).catch(() => {});

		res.redirect('/');
	} catch (err) {
 next(err); 
}
});

// (Silent SF token renewal was retired; see public/js/sf-fetch.js
// header. The hidden-iframe prompt=none renewal can't complete because
// the page CSP doesn't frame the Salesforce origin and SF sets
// X-Frame-Options on its OAuth pages, so an expired access token now
// surfaces the interactive reauth UI directly.)

app.post('/auth/sf-signout', (req, res) => {
	if (req.session) {
		dropSessionRefreshTokens(req.session.id);
		delete req.session.sfAuth;
		delete req.session.sfAuthByConnection;
		req.session.currentConnectionId = null;
	}
	if (req.session && typeof req.session.save === 'function') {
		return req.session.save(() => res.redirect('/'));
	}
	res.redirect('/');
});

// Canvas-standalone /auth/logout: clear the session entirely (rare
// path; the implicit local user usually stays signed in).
app.post('/auth/logout', (req, res) => {
	dropSessionRefreshTokens(req.session && req.session.id);
	req.session.destroy(() => res.redirect('/'));
});

// /docs hub + /docs/walkthroughs/* live entirely in the saas (private)
// tree; see apps/saas/src/views/docs.ejs +
// apps/saas/src/views/docs/walkthroughs/ + the route registrations in
// apps/saas/src/server.js. Canvas-standalone deployments ship no
// /docs surface; the catch-all 404 fires.

// ---- MCP server endpoint --------------------------------------------------

app.post('/mcp/v1', mcpHandler);

// ---- canvas API routes ----------------------------------------------------

mountCanvasRoutes(app);

// ---- 404 + error handlers -------------------------------------------------

// Plain-text 404 catch-all. See apps/saas/src/server.js for the
// rationale (clean handoff to helmet's CSP, no Express-default
// CSP collision that ZAP flags).
app.use((req, res) => {
	res.status(404).type('text/plain').send('Not Found');
});

// Global INVALID_SESSION_ID handler: when a jsforce call rejects with
// the SF "session expired" code, return a clean 401 so sf-fetch.js can
// surface the interactive reauth UI instead of bubbling a confusing 500.
app.use((err, req, res, next) => {
	if (err && (err.errorCode === 'INVALID_SESSION_ID' || err.name === 'INVALID_SESSION_ID')) {
		if (req.path && req.path.startsWith('/api/')) {
			return res.status(401).json({
				error: 'sf-session-expired',
				message: 'Your Salesforce session has expired. Reconnect Salesforce and try again.',
			});
		}
		return res.redirect('/auth/login');
	}
	console.error('[server] unhandled error:', err);
	if (req.path && req.path.startsWith('/api/')) {
		// See apps/saas/src/server.js for the prod-vs-dev rationale;
		// generic body in prod, detail in dev.
		const body = { error: 'internal' };
		if (!config.isProduction && err && err.message) {
body.message = err.message;
}
		return res.status(500).json(body);
	}
	res.status(500).send('Internal error');
});

// ---- start ----------------------------------------------------------------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
	console.log(`[server] listening on http://localhost:${PORT}`);
});
