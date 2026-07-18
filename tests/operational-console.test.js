import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { installOperationalConsoleGuard, sanitizeConsoleArgs } from '../src/operational-console.js';

describe('production operational console privacy guard', () => {
	test('drops arbitrary messages, email, Salesforce IDs, tokens, URLs, and object values', () => {
		const error = new Error('INVALID_FIELD: Secret Contact Value jane@example.com');
		error.errorCode = 'INVALID_FIELD';
		error.statusCode = 400;
		const result = sanitizeConsoleArgs([
			'[upload] failed for 003xx000004TmiQAAS at https://example.test/?token=secret',
			'jane@example.com',
			error,
			{ workspaceId: 'ws-secret', payload: 'customer value' },
			7,
		]);
		const serialized = JSON.stringify(result);
		for (const forbidden of [
			'jane@example.com',
			'003xx000004TmiQAAS',
			'secret',
			'customer value',
			'example.test',
		]) {
			assert.ok(!serialized.includes(forbidden), `must remove ${forbidden}`);
		}
		assert.deepEqual(result[0], '[upload] failed');
		assert.deepEqual(result[2], { errorType: 'Error', code: 'INVALID_FIELD', status: 400 });
		assert.deepEqual(result[3], { redacted: true, keys: ['payload', 'workspaceId'] });
		assert.equal(result[4], 7);
	});

	test('wraps and restores a console-like sink', () => {
		const calls = [];
		const sink = { log: (...args) => calls.push(args) };
		const original = sink.log;
		const restore = installOperationalConsoleGuard(sink);
		sink.log('[oauth] blocked for', 'person@example.com');
		assert.deepEqual(calls, [['[oauth] blocked', '[redacted]']]);
		restore();
		assert.equal(sink.log, original);
	});

	test('never throws when a logged proxy rejects inspection', () => {
		const hostile = new Proxy(
			{},
			{
				ownKeys() {
					throw new Error('do not inspect me');
				},
			},
		);
		assert.deepEqual(sanitizeConsoleArgs(['[worker] failed:', hostile]), ['[worker] failed', '[redacted]']);
	});
});
