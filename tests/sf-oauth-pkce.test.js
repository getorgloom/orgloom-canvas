import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
	beginSfOAuth,
	consumeSfOAuthAttempt,
	createOAuth2,
	dropSfOAuthAttempt,
	SF_OAUTH_ATTEMPT_TTL_MS,
} from '../src/auth.js';
import { dropSessionRefreshTokens } from '../src/sf-refresh-store.js';

test('authorization challenge and token verifier match across separate OAuth clients', async () => {
	const { oauth2, authParams } = beginSfOAuth('pkce', 'https://test.salesforce.com');
	const url = new URL(oauth2.getAuthorizationUrl(authParams));
	assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
	assert.notEqual(authParams.state, 'pkce');
	assert.equal(url.searchParams.has('code_verifier'), false);
	const attempt = consumeSfOAuthAttempt('pkce', authParams.state);
	assert.match(attempt.codeVerifier, /^[A-Za-z0-9_-]{43,128}$/);
	assert.equal(
		url.searchParams.get('code_challenge'),
		createHash('sha256').update(attempt.codeVerifier).digest('base64url'),
	);
	const callbackOAuth = createOAuth2(attempt.loginUrl, attempt.codeVerifier);
	callbackOAuth.clientId = 'test-client';
	callbackOAuth.redirectUri = 'https://app.example/auth/callback';
	let posted;
	callbackOAuth._transport.httpRequest = async (request) => {
		posted = request;
		return { statusCode: 200, body: JSON.stringify({ access_token: 'test-access' }) };
	};
	await callbackOAuth.requestToken('test-code');
	assert.equal(posted.url, 'https://test.salesforce.com/services/oauth2/token');
	const body = new URLSearchParams(posted.body);
	assert.equal(body.get('code_verifier'), attempt.codeVerifier);
	assert.equal(body.get('grant_type'), 'authorization_code');
	assert.equal(consumeSfOAuthAttempt('pkce', authParams.state), null);
});

test('states are session-bound, single-use and superseded by a new sign-in', () => {
	const first = beginSfOAuth('attempts', 'https://login.salesforce.com');
	assert.equal(consumeSfOAuthAttempt('another-session', first.authParams.state), null);
	assert.equal(consumeSfOAuthAttempt('attempts', 'wrong'), null);
	assert.equal(consumeSfOAuthAttempt('attempts', [first.authParams.state]), null);
	const second = beginSfOAuth('attempts', 'https://test.salesforce.com');
	assert.notEqual(first.authParams.state, second.authParams.state);
	assert.notEqual(first.oauth2.codeVerifier, second.oauth2.codeVerifier);
	assert.equal(consumeSfOAuthAttempt('attempts', first.authParams.state), null);
	assert.equal(consumeSfOAuthAttempt('attempts', second.authParams.state).loginUrl, 'https://test.salesforce.com');
	assert.equal(consumeSfOAuthAttempt('attempts', second.authParams.state), null);
});

test('expired and signed-out attempts cannot be exchanged', (t) => {
	t.mock.timers.enable({ apis: ['Date'], now: 1000 });
	const expired = beginSfOAuth('expired');
	t.mock.timers.tick(SF_OAUTH_ATTEMPT_TTL_MS);
	assert.equal(consumeSfOAuthAttempt('expired', expired.authParams.state), null);
	const signedOut = beginSfOAuth('signed-out');
	dropSessionRefreshTokens('signed-out');
	assert.equal(consumeSfOAuthAttempt('signed-out', signedOut.authParams.state), null);
	dropSfOAuthAttempt('expired');
});
