// Canvas-side auth helpers. Just SF OAuth; the multi-tenant signup gate,
// super-admin bootstrap, and beta-org allowlist live in src/saas-auth.js
// (saas-side, not present in canvas standalone).

import jsforce from 'jsforce';
import { config } from 'orgloom-canvas/config';

const { OAuth2 } = jsforce;

// Accepts an optional override of the Salesforce login URL, letting the
// /connect page direct users into prod (login.salesforce.com), sandbox
// (test.salesforce.com), or a specific My Domain URL without changing
// the env-set default. The /auth/login route stashes the chosen URL in
// session so /auth/callback can re-construct an OAuth2 with the same
// loginUrl when exchanging the code.
export function createOAuth2(loginUrlOverride) {
	// Defensive: jsforce silently accepts loginUrl: "" and then returns
	// relative auth URLs (/services/oauth2/authorize?...) that Express
	// 404s on. Treat empty/whitespace from either source as unset and
	// fall back to login.salesforce.com so the user at least lands on
	// a real Salesforce host instead of our 404.
	const cleaned = (loginUrlOverride || config.salesforce.loginUrl || '').trim();
	return new OAuth2({
		loginUrl: cleaned || 'https://login.salesforce.com',
		clientId: config.salesforce.clientId,
		clientSecret: config.salesforce.clientSecret,
		redirectUri: config.salesforce.redirectUri,
	});
}
