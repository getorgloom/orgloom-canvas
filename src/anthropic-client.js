// Lazy Anthropic SDK client. Single instance per process, gated on
// ANTHROPIC_API_KEY. When the key isn't set, isEnabled() returns false
// and route handlers should 501 the AI endpoints. No API calls happen
// without an explicit key on the server.
//
// Pulled out of server.js so route modules (routes-v2.js) can use it
// without taking a server-as-dependency.

import Anthropic from '@anthropic-ai/sdk';

let _client = null;
const _key = process.env.ANTHROPIC_API_KEY;

if (_key) {
	_client = new Anthropic({
		apiKey: _key,
		// Anthropic SDK default is 60s. Bump to 120s so a slow
		// generation (large context, complex prompt) doesn't surface
		// as a timeout. Render's HTTP timeout is generous (30 min);
		// the SDK is the constraining factor here.
		timeout: 120_000,
		maxRetries: 2,
	});
}

export function isEnabled() {
	return !!_client;
}

export function getClient() {
	return _client;
}

export const ANTHROPIC_MODEL = 'claude-sonnet-4-6';
