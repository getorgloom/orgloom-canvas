
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

try {
	ext.getDb();
} catch (err) {
	console.error('[boot] canvas-standalone requires a DB provider registered before import:', err.message);
	throw err;
}
console.log('[db] ready:', ext.getRawClient().dialect);

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

ext.registerAuthProvider(async (req) => {
	if (!req || !req.session || !req.session.accountId) {
return null;
}
	if (req.session.accountId !== LOCAL_ACCOUNT_ID) {
return null;
}
	return { id: LOCAL_ACCOUNT_ID, email: 'self-host@local', display_name: 'Self-host user' };
});


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

app.disable('x-powered-by');

app.use((req, res, next) => {
	res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
	next();
});

app.use(helmet({
	contentSecurityPolicy: {
		useDefaults: true,
		directives: {
			'default-src': ["'self'"],
			'upgrade-insecure-requests': process.env.NODE_ENV === 'production' ? [] : null,
			'script-src': ["'self'", 'https://*.posthog.com', 'https://browser.sentry-cdn.com', (req, res) => `'nonce-${res.locals.cspNonce}'`],
			'style-src': ["'self'"],
			'style-src-elem': [
				"'self'",
				"'sha256-pgvDUBa4IjFA2yuSJ2cqcyxmNYJMborsd0ORcRv9vw8='", // cytoscape v3.x renderer init
			],
			'style-src-attr': ["'unsafe-inline'"],
			'img-src': ["'self'", 'data:', 'https://*.posthog.com'],
			'font-src': ["'self'", 'data:'],
			'connect-src': ["'self'", 'https://*.posthog.com', 'https://browser.sentry-cdn.com', ...(process.env.SENTRY_INGEST_HOST ? ['https://' + process.env.SENTRY_INGEST_HOST] : [])],
			'frame-src': ["'self'", 'https://www.youtube.com', 'https://www.youtube-nocookie.com'],
			'frame-ancestors': ["'self'"],
			'object-src': ["'none'"],
			'base-uri': ["'self'"],
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

app.locals.jsonForScript = (value) => {
	return JSON.stringify(value)
		.replace(/</g, '\\u003c')
		.replace(/\u2028/g, '\\u2028')
		.replace(/\u2029/g, '\\u2029');
};

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


app.set('view engine', 'ejs');
app.set('views', [path.join(__dirname, 'views')]);
app.use('/css', express.static(path.join(__dirname, 'public/css')));
app.use('/js', express.static(path.join(__dirname, 'public/js')));
app.use('/img', express.static(path.join(__dirname, 'public/img')));
app.use('/vendor', express.static(fileURLToPath(new URL('../../../node_modules', import.meta.url))));
app.use(express.static(path.join(__dirname, 'public')));

ext.flush(app);

mountSetupWizard(app);

app.use((req, res, next) => {
	res.locals.currentPath = req.path;
	res.locals.saasEnabled = false;
	res.locals.posthogKey = process.env.POSTHOG_KEY || '';
	res.locals.posthogHost = process.env.POSTHOG_HOST || 'https://app.posthog.com';
	next();
});


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

app.get('/auth/callback', async (req, res, next) => {
	try {
		const code = req.query.code;
		if (!code) {
return res.status(400).send('Missing OAuth code.');
}
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
		req.session.sfAuthByConnection = req.session.sfAuthByConnection || {};
		req.session.sfAuthByConnection[connection.id] = _sfAuth;

		await _regenerateSession(req);

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
			payload: { sfUserId: userInfo.id },
		}).catch(() => {});

		res.redirect('/');
	} catch (err) {
 next(err); 
}
});


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

app.post('/auth/logout', (req, res) => {
	dropSessionRefreshTokens(req.session && req.session.id);
	req.session.destroy(() => res.redirect('/'));
});



app.post('/mcp/v1', mcpHandler);


mountCanvasRoutes(app);


app.use((req, res) => {
	res.status(404).type('text/plain').send('Not Found');
});

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
		const body = { error: 'internal' };
		if (!config.isProduction && err && err.message) {
body.message = err.message;
}
		return res.status(500).json(body);
	}
	res.status(500).send('Internal error');
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
	console.log(`[server] listening on http://localhost:${PORT}`);
});
