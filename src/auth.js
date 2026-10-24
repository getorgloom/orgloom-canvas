import jsforce from 'jsforce';
import { randomBytes } from 'node:crypto';
import { config } from 'orgloom-canvas/config';

const { OAuth2 } = jsforce;

export function createOAuth2(loginUrlOverride, codeVerifier) {
	const cleaned = (loginUrlOverride || config.salesforce.loginUrl || '').trim();
	const oauth2 = new OAuth2({
		loginUrl: cleaned || 'https://login.salesforce.com',
		clientId: config.salesforce.clientId,
		clientSecret: config.salesforce.clientSecret,
		redirectUri: config.salesforce.redirectUri,
	});
	if (codeVerifier) {
		oauth2.codeVerifier = codeVerifier;
	}
	return oauth2;
}

// Like refresh tokens, pending Salesforce grants are process-local. A restart
// requires starting sign-in again; multi-node deployments need sticky sessions.
const attempts = new Map();
export const SF_OAUTH_ATTEMPT_TTL_MS = 10 * 60 * 1000;

export function beginSfOAuth(sid, loginUrl) {
	if (!sid) {
		throw new Error('Salesforce sign-in requires a session');
	}
	dropSfOAuthAttempt(sid);
	const state = randomBytes(32).toString('base64url');
	const codeVerifier = randomBytes(32).toString('base64url');
	const oauth2 = createOAuth2(loginUrl, codeVerifier);
	const timer = setTimeout(() => dropSfOAuthAttempt(sid), SF_OAUTH_ATTEMPT_TTL_MS);
	timer.unref();
	attempts.set(sid, {
		state,
		codeVerifier,
		loginUrl: oauth2.loginUrl,
		expiresAt: Date.now() + SF_OAUTH_ATTEMPT_TTL_MS,
		timer,
	});
	return { oauth2, authParams: { state, code_challenge_method: 'S256' } };
}

export function consumeSfOAuthAttempt(sid, state) {
	const attempt = attempts.get(sid);
	if (!attempt || typeof state !== 'string' || state !== attempt.state) {
		return null;
	}
	// Delete synchronously before any asynchronous token exchange, including
	// callbacks arriving on separate requests with stale copies of the session.
	dropSfOAuthAttempt(sid);
	if (attempt.expiresAt <= Date.now()) {
		return null;
	}
	return { loginUrl: attempt.loginUrl, codeVerifier: attempt.codeVerifier };
}

export function dropSfOAuthAttempt(sid) {
	const attempt = attempts.get(sid);
	if (attempt) {
		clearTimeout(attempt.timer);
	}
	attempts.delete(sid);
}
