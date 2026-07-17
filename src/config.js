import 'dotenv/config';
import { installOperationalConsoleGuard } from './operational-console.js';

// Salesforce External Client App (formerly Connected App) credentials
// are required to talk to SF. In
// canvas-standalone mode (ORGLOOM_CANVAS_ONLY=1) we tolerate them being
// missing at startup: the first-boot setup wizard at /setup collects
// them and writes them to .env, after which a restart picks them up.
// In saas mode (hosted product) missing creds is always a deploy bug
// and we fail fast.
const required = ['SF_CLIENT_ID', 'SF_CLIENT_SECRET', 'SF_REDIRECT_URI'];
const missing = required.filter((v) => !process.env[v]);
if (missing.length > 0) {
	const canvasStandalone = process.env.ORGLOOM_CANVAS_ONLY === '1';
	if (canvasStandalone) {
		console.warn('[setup] ' + missing.join(', ') + ' unset; visiting / will route to the first-boot setup wizard.');
	} else {
		console.error(`Missing required env vars: ${missing.join(', ')}`);
		console.error('Copy .env.example to .env and fill in your External Client App credentials.');
		process.exit(1);
	}
}

// NODE_ENV literal-string check. Every production-only guard in this
// codebase checks `process.env.NODE_ENV === 'production'` exactly:
// session cookie `secure: true`, the /dev/last-magic-link route gate,
// HSTS, default-session-secret refusal, etc. A misconfigured deploy
// that sets NODE_ENV to a production-LOOKING but non-exact value
// (capitalized, trimmed wrong, or abbreviated) silently flips ALL
// those guards off. Refuse to boot when the value looks production-
// like but isn't the literal string we check against. Legitimate
// non-prod values ("development", "test", "staging") don't trip
// because they don't contain "prod".
const _nodeEnvRaw = process.env.NODE_ENV;
if (_nodeEnvRaw && _nodeEnvRaw !== 'production' && /prod/i.test(_nodeEnvRaw)) {
	console.error(
		`[config] NODE_ENV="${_nodeEnvRaw}" looks production-like but doesn't equal the literal "production". ` +
		'Production-only guards (session secure flag, /dev/last-magic-link 404, HSTS, etc.) check === \'production\' exactly. ' +
		'Set NODE_ENV to the literal string \'production\' (lowercase, no whitespace) or use a non-production-looking value like \'staging\'. ' +
		'Refusing to start.',
	);
	process.exit(1);
}

// Session secret protects both the session cookie signature AND the
// CSRF double-submit token signature. Falling through to a known
// default in production means a determined attacker can forge both,
// so we fail fast instead. Dev keeps the convenient default.
const _DEFAULT_SESSION_SECRET = 'dev-only-change-me';
const _envSessionSecret = (process.env.SESSION_SECRET || '').trim();
const _isProd = process.env.NODE_ENV === 'production';
const _canvasStandalone = process.env.ORGLOOM_CANVAS_ONLY === '1';
if (_isProd) {
	if (!_envSessionSecret || _envSessionSecret === _DEFAULT_SESSION_SECRET) {
		console.error('[config] SESSION_SECRET must be set to a strong random value in production (suggested: `openssl rand -hex 32`). Refusing to start.');
		process.exit(1);
	}
	if (_envSessionSecret.length < 32) {
		console.error('[config] SESSION_SECRET is too short (' + _envSessionSecret.length + ' chars). Use at least 32 chars (suggested: `openssl rand -hex 32`). Refusing to start.');
		process.exit(1);
	}
}

// Production startup checks for the SaaS deployment. Each of these
// would silently degrade a critical feature if missing (auth, email
// delivery), and the failure mode would only surface mid-flow, in magic-
// link emails not arriving, etc. Fail loud at boot instead. Canvas-
// standalone mode skips these: a self-hoster running canvas only
// doesn't need email.
//
// Billing-side prod checks (Stripe key set, etc.) live in apps/saas/
// src/saas-config.js, kept out of this file so canvas-standalone has
// no dependency on a billing config it doesn't use.
if (_isProd && !_canvasStandalone) {
	const fatal = [];

	// Magic-link sign-in is the primary auth path; broken email means
	// broken sign-in. EMAIL_TRANSPORT=console logs the email body to
	// stdout but never delivers it; workable in dev, catastrophic in
	// prod because users see "we sent you a link" and never get one.
	const emailTransport = (process.env.EMAIL_TRANSPORT || 'console').toLowerCase();
	if (emailTransport === 'console') {
		fatal.push('EMAIL_TRANSPORT is unset (defaults to "console" which only logs). Set EMAIL_TRANSPORT=resend (or another supported transport).');
	}
	if (emailTransport === 'resend' && !process.env.RESEND_API_KEY) {
		fatal.push('EMAIL_TRANSPORT=resend requires RESEND_API_KEY.');
	}
	if (!process.env.EMAIL_FROM) {
		fatal.push('EMAIL_FROM must be set in production (defaults to noreply@orgloom.local which fails DMARC).');
	}

	// Magic-link emails carry an absolute URL the user clicks from their
	// inbox. The in-request fallback to req.headers.host works only
	// for URLs built inside a request; the email itself needs the
	// canonical APP_URL pinned.
	if (!process.env.APP_URL) {
		fatal.push('APP_URL must be set in production (e.g. https://orgloom.com).');
	}

	if (fatal.length > 0) {
		console.error('[config] Production startup checks failed:');
		for (const msg of fatal) {
console.error('  - ' + msg);
}

// Install after startup validation so actionable configuration failures retain
// their safe variable names. ESM dependency evaluation completes this module
// before server/runtime importers execute, so subsequent production console
// output is privacy-minimized before it can enter retained provider logs.
if (_isProd) {
	installOperationalConsoleGuard();
}
		console.error('[config] Refusing to start. Fix the env vars and retry.');
		process.exit(1);
	}
}

export const config = {
	port: parseInt(process.env.PORT ?? '3000', 10),
	sessionSecret: _envSessionSecret || _DEFAULT_SESSION_SECRET,
	isProduction: _isProd,
	salesforce: {
		clientId: process.env.SF_CLIENT_ID,
		clientSecret: process.env.SF_CLIENT_SECRET,
		redirectUri: process.env.SF_REDIRECT_URI,
		// Nullish-coalescing only fires on null/undefined; empty string
		// counts as "set" and would pass through, leaving jsforce with
		// loginUrl: "" which produces relative /services/oauth2/authorize
		// URLs and an Express 404. Treat empty/whitespace as unset.
		loginUrl: (process.env.SF_LOGIN_URL || '').trim() || 'https://login.salesforce.com',
		// Optional space-separated OAuth scope list (e.g. "api web").
		// When empty, no `scope` parameter is sent on the auth URL and
		// Salesforce uses the Connected App's selected scopes. Set
		// this only when you want to request a strict subset of what
		// the Connected App permits; every value here must be in the
		// Connected App's Selected OAuth Scopes or Salesforce will
		// return invalid_scope.
		scope: process.env.SF_OAUTH_SCOPE || '',
		// Salesforce REST/UI-API version pinned on every jsforce
		// Connection we build. jsforce's library default is '50.0'
		// (Spring '21), which predates UI API features like
		// /ui-api/lookups?searchType=Search. Without an explicit
		// version, every API call we make would target v50, and the
		// Lightning-style endpoints Lightning UI itself uses silently
		// return zero results. Override via SF_API_VERSION; bump in
		// step with whatever your target orgs run.
		apiVersion: (process.env.SF_API_VERSION || '').trim() || '62.0',
		// 2GP managed-package version ID (04t...) used to build the
		// Salesforce install URL on the /install-required page. The
		// install URL form is
		//   https://login.salesforce.com/packaging/installPackage.apexp?p0=<04t>
		// (production) or test.salesforce.com (sandbox). Unset → the
		// install CTA is disabled and the OAuth-error fallback renders
		// the raw SF error description instead. Self-host deployments
		// that ship their own ECA don't need this set.
		packageVersionId: (process.env.ORGLOOM_PACKAGE_VERSION_ID || '').trim() || null,
	},
	canvas: {
		// Canvas storage: metadata in orgloom__Orgloom_Canvas__c, encrypted
		// body in a ContentDocument linked via ShareType='I'. The managed
		// package must be installed in every org Org Loom connects to;
		// the API names are always namespaced because both customer
		// installs and dev scratch orgs derive their namespace from the
		// same sfdx-project.json. A fork that needs a different prefix
		// would change this here.
		namespacePrefix: 'orgloom',
	},
};
