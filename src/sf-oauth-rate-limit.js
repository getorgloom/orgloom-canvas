import { MemoryStore, rateLimit } from 'express-rate-limit';

export const SF_OAUTH_START_RATE_LIMIT = Object.freeze({
	windowMs: 5 * 60 * 1000,
	limit: 15,
});
export const SF_OAUTH_CALLBACK_IP_RATE_LIMIT = Object.freeze({
	windowMs: 5 * 60 * 1000,
	limit: 30,
});
export const SF_OAUTH_CALLBACK_SESSION_RATE_LIMIT = Object.freeze({
	windowMs: 5 * 60 * 1000,
	limit: 5,
});

const startStore = new MemoryStore();
const callbackIpStore = new MemoryStore();
const callbackSessionStore = new MemoryStore();

function plainTextRateLimitHandler(message) {
	return (_req, res) => res.status(429).type('text/plain').send(message);
}

export const sfOAuthStartIpRateLimit = rateLimit({
	...SF_OAUTH_START_RATE_LIMIT,
	identifier: 'salesforce-oauth-start',
	legacyHeaders: false,
	standardHeaders: 'draft-8',
	store: startStore,
	handler: plainTextRateLimitHandler(
		'Too many Salesforce sign-in attempts from this network. Try again in a few minutes.',
	),
});

export const sfOAuthCallbackIpRateLimit = rateLimit({
	...SF_OAUTH_CALLBACK_IP_RATE_LIMIT,
	identifier: 'salesforce-oauth-callback-ip',
	legacyHeaders: false,
	standardHeaders: 'draft-8',
	store: callbackIpStore,
	handler: plainTextRateLimitHandler(
		'Too many Salesforce sign-in responses from this network. Try again in a few minutes.',
	),
});

export const sfOAuthCallbackSessionRateLimit = rateLimit({
	...SF_OAUTH_CALLBACK_SESSION_RATE_LIMIT,
	identifier: 'salesforce-oauth-callback-session',
	legacyHeaders: false,
	standardHeaders: 'draft-8',
	store: callbackSessionStore,
	keyGenerator: (req) => String(req.sessionID || req.session?.id || 'missing-session'),
	handler: plainTextRateLimitHandler(
		'Too many Salesforce sign-in responses for this session. Try again in a few minutes.',
	),
});

export function validateSfOAuthCallback(req, res, next) {
	const code = typeof req.query?.code === 'string' ? req.query.code : null;
	if (!code) {
		return res.status(400).type('text/plain').send('Missing OAuth code.');
	}
	const state = typeof req.query?.state === 'string' ? req.query.state : null;
	if (!state || !req.session?.id || state !== req.session.id) {
		console.warn('[sf-oauth] state missing/mismatch on /auth/callback (possible CSRF)');
		return res
			.status(400)
			.type('text/plain')
			.send('Salesforce sign-in failed a security check (state mismatch). Try again from the start.');
	}
	res.locals.sfOAuthCode = code;
	return next();
}

export async function resetSfOAuthRateLimitsForTests() {
	await Promise.all([startStore.resetAll(), callbackIpStore.resetAll(), callbackSessionStore.resetAll()]);
}
