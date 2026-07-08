import Anthropic from '@anthropic-ai/sdk';

let _client = null;
const _key = process.env.ANTHROPIC_API_KEY;

if (_key) {
	_client = new Anthropic({
		apiKey: _key,

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
