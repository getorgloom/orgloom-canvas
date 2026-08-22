import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import express from 'express';
import {
	resetSfOAuthRateLimitsForTests,
	SF_OAUTH_CALLBACK_IP_RATE_LIMIT,
	SF_OAUTH_CALLBACK_SESSION_RATE_LIMIT,
	SF_OAUTH_START_RATE_LIMIT,
	sfOAuthCallbackIpRateLimit,
	sfOAuthCallbackSessionRateLimit,
	sfOAuthStartIpRateLimit,
	validateSfOAuthCallback,
} from '../src/sf-oauth-rate-limit.js';

let baseUrl;
let callbackHits = 0;
let server;

function request(path, { ip = '198.51.100.10', session = 'session-a' } = {}) {
	return fetch(`${baseUrl}${path}`, {
		headers: {
			'x-forwarded-for': ip,
			'x-test-session': session,
		},
		redirect: 'manual',
	});
}

before(async () => {
	const app = express();
	app.set('trust proxy', 1);
	app.use((req, _res, next) => {
		const sessionId = req.get('x-test-session') || 'session-a';
		req.sessionID = sessionId;
		req.session = { id: sessionId };
		next();
	});
	app.get('/start', sfOAuthStartIpRateLimit, (_req, res) => res.sendStatus(204));
	app.get(
		'/callback',
		validateSfOAuthCallback,
		sfOAuthCallbackIpRateLimit,
		sfOAuthCallbackSessionRateLimit,
		(_req, res) => {
			callbackHits += 1;
			res.sendStatus(204);
		},
	);
	server = await new Promise((resolve) => {
		const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
	});
	baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
	callbackHits = 0;
	await resetSfOAuthRateLimitsForTests();
});

after(async () => {
	if (server) {
		await new Promise((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
	}
});

test('Salesforce OAuth starts are limited by IP without affecting another IP', async () => {
	for (let attempt = 0; attempt < SF_OAUTH_START_RATE_LIMIT.limit; attempt += 1) {
		const response = await request('/start');
		assert.equal(response.status, 204);
	}

	const blocked = await request('/start');
	assert.equal(blocked.status, 429);
	assert.ok(blocked.headers.get('retry-after'));
	assert.ok(blocked.headers.get('ratelimit'));
	assert.match(await blocked.text(), /too many salesforce sign-in attempts/i);

	const otherIp = await request('/start', { ip: '198.51.100.11' });
	assert.equal(otherIp.status, 204);
});

test('invalid callback requests are rejected before they consume rate-limit budgets', async () => {
	const originalWarn = console.warn;
	console.warn = () => {};
	try {
		for (let attempt = 0; attempt < SF_OAUTH_CALLBACK_IP_RATE_LIMIT.limit + 2; attempt += 1) {
			const response = await request('/callback?code=test-code&state=wrong-state');
			assert.equal(response.status, 400);
		}
	} finally {
		console.warn = originalWarn;
	}

	const valid = await request('/callback?code=test-code&state=session-a');
	assert.equal(valid.status, 204);
	assert.equal(callbackHits, 1);
});

test('callback requests are limited per session before protected work runs', async () => {
	for (let attempt = 0; attempt < SF_OAUTH_CALLBACK_SESSION_RATE_LIMIT.limit; attempt += 1) {
		const response = await request('/callback?code=test-code&state=session-a');
		assert.equal(response.status, 204);
	}

	const blocked = await request('/callback?code=test-code&state=session-a');
	assert.equal(blocked.status, 429);
	assert.ok(blocked.headers.get('retry-after'));
	assert.match(await blocked.text(), /too many salesforce sign-in responses for this session/i);
	assert.equal(callbackHits, SF_OAUTH_CALLBACK_SESSION_RATE_LIMIT.limit);

	const otherSession = await request('/callback?code=test-code&state=session-b', {
		session: 'session-b',
	});
	assert.equal(otherSession.status, 204);
});

test('callback requests are limited per IP across sessions before protected work runs', async () => {
	for (let attempt = 0; attempt < SF_OAUTH_CALLBACK_IP_RATE_LIMIT.limit; attempt += 1) {
		const session = `session-${attempt}`;
		const response = await request(`/callback?code=test-code&state=${session}`, { session });
		assert.equal(response.status, 204);
	}

	const blocked = await request('/callback?code=test-code&state=session-blocked', {
		session: 'session-blocked',
	});
	assert.equal(blocked.status, 429);
	assert.ok(blocked.headers.get('retry-after'));
	assert.match(await blocked.text(), /too many salesforce sign-in responses from this network/i);
	assert.equal(callbackHits, SF_OAUTH_CALLBACK_IP_RATE_LIMIT.limit);

	const otherIp = await request('/callback?code=test-code&state=session-other-ip', {
		ip: '198.51.100.12',
		session: 'session-other-ip',
	});
	assert.equal(otherIp.status, 204);
});
