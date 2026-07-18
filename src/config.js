import 'dotenv/config';
import { installOperationalConsoleGuard } from './operational-console.js';

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

const _nodeEnvRaw = process.env.NODE_ENV;
if (_nodeEnvRaw && _nodeEnvRaw !== 'production' && /prod/i.test(_nodeEnvRaw)) {
	console.error(
		`[config] NODE_ENV="${_nodeEnvRaw}" looks production-like but doesn't equal the literal "production". ` +
			"Production-only guards (session secure flag, /dev/last-magic-link 404, HSTS, etc.) check === 'production' exactly. " +
			"Set NODE_ENV to the literal string 'production' (lowercase, no whitespace) or use a non-production-looking value like 'staging'. " +
			'Refusing to start.',
	);
	process.exit(1);
}

const _DEFAULT_SESSION_SECRET = 'dev-only-change-me';
const _envSessionSecret = (process.env.SESSION_SECRET || '').trim();
const _isProd = process.env.NODE_ENV === 'production';
const _canvasStandalone = process.env.ORGLOOM_CANVAS_ONLY === '1';
if (_isProd) {
	if (!_envSessionSecret || _envSessionSecret === _DEFAULT_SESSION_SECRET) {
		console.error(
			'[config] SESSION_SECRET must be set to a strong random value in production (suggested: `openssl rand -hex 32`). Refusing to start.',
		);
		process.exit(1);
	}
	if (_envSessionSecret.length < 32) {
		console.error(
			'[config] SESSION_SECRET is too short (' +
				_envSessionSecret.length +
				' chars). Use at least 32 chars (suggested: `openssl rand -hex 32`). Refusing to start.',
		);
		process.exit(1);
	}
}

if (_isProd && !_canvasStandalone) {
	const fatal = [];

	const emailTransport = (process.env.EMAIL_TRANSPORT || 'console').toLowerCase();
	if (emailTransport === 'console') {
		fatal.push(
			'EMAIL_TRANSPORT is unset (defaults to "console" which only logs). Set EMAIL_TRANSPORT=resend (or another supported transport).',
		);
	}
	if (emailTransport === 'resend' && !process.env.RESEND_API_KEY) {
		fatal.push('EMAIL_TRANSPORT=resend requires RESEND_API_KEY.');
	}
	if (!process.env.EMAIL_FROM) {
		fatal.push('EMAIL_FROM must be set in production (defaults to noreply@orgloom.local which fails DMARC).');
	}

	if (!process.env.APP_URL) {
		fatal.push('APP_URL must be set in production (e.g. https://orgloom.com).');
	}

	if (fatal.length > 0) {
		console.error('[config] Production startup checks failed:');
		for (const msg of fatal) {
			console.error('  - ' + msg);
		}

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
		loginUrl: (process.env.SF_LOGIN_URL || '').trim() || 'https://login.salesforce.com',
		scope: process.env.SF_OAUTH_SCOPE || '',
		apiVersion: (process.env.SF_API_VERSION || '').trim() || '62.0',
		packageVersionId: (process.env.ORGLOOM_PACKAGE_VERSION_ID || '').trim() || null,
	},
	canvas: {
		namespacePrefix: 'orgloom',
	},
};
