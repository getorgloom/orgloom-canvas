import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, test } from 'node:test';
import {
	_claimUploadAttemptForTests,
	_countCommittedMutationsForTests,
	_requireUploadAttemptIdForTests,
	_resetUploadAttemptClaimsForTests,
	_settleKnownNoCommitForTests,
} from '../src/canvas-routes.js';

function request(accountId = 'acct-1', sfUserId = 'sf-user-1') {
	return { account: { id: accountId }, sf: { sfUserId } };
}

describe('upload attempt concurrency claim', () => {
	beforeEach(() => _resetUploadAttemptClaimsForTests());

	test('refuses a simultaneous duplicate and releases after completion', () => {
		const firstResponse = new EventEmitter();
		assert.equal(_claimUploadAttemptForTests(request(), firstResponse, 'attempt-1'), true);
		assert.equal(_claimUploadAttemptForTests(request(), new EventEmitter(), 'attempt-1'), false);

		firstResponse.emit('finish');
		assert.equal(_claimUploadAttemptForTests(request(), new EventEmitter(), 'attempt-1'), true);
	});

	test('scopes claims by account and Salesforce user', () => {
		assert.equal(_claimUploadAttemptForTests(request(), new EventEmitter(), 'attempt-1'), true);
		assert.equal(_claimUploadAttemptForTests(request('acct-2'), new EventEmitter(), 'attempt-1'), true);
		assert.equal(_claimUploadAttemptForTests(request('acct-1', 'sf-user-2'), new EventEmitter(), 'attempt-1'), true);
	});

	test('requests without an attempt id do not create a claim', () => {
		assert.equal(_claimUploadAttemptForTests(request(), new EventEmitter(), null), true);
		assert.equal(_claimUploadAttemptForTests(request(), new EventEmitter(), null), true);
	});

	test('write routes require a bounded filename-safe attempt id', () => {
		const response = () => {
			const res = { statusCode: null, body: null };
			res.status = (code) => {
				res.statusCode = code;
				return res;
			};
			res.json = (body) => {
				res.body = body;
				return res;
			};
			return res;
		};

		const missing = response();
		assert.equal(_requireUploadAttemptIdForTests({ body: {} }, missing), null);
		assert.equal(missing.statusCode, 400);
		assert.equal(missing.body.error, 'attempt-id-required');

		const unsafe = response();
		assert.equal(_requireUploadAttemptIdForTests({ body: { attemptId: '../same-id' } }, unsafe), null);
		assert.equal(unsafe.body.error, 'attempt-id-invalid');

		const valid = response();
		assert.equal(
			_requireUploadAttemptIdForTests({ body: { attemptId: '12345678-1234-1234-1234-123456789abc' } }, valid),
			'12345678-1234-1234-1234-123456789abc',
		);
		assert.equal(valid.statusCode, null);
	});
});

describe('known no-commit settlement', () => {
	test('unchanged cards do not disguise a full validation rollback as a commit', () => {
		const results = [
			{ tempId: 1, success: true, id: '001-existing', mode: 'unchanged' },
			{ tempId: 2, success: false, errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION' },
			{ tempId: 3, success: false, errorCode: 'REQUIRED_FIELD_MISSING' },
		];
		assert.equal(_countCommittedMutationsForTests(results), 0);
		assert.equal(_countCommittedMutationsForTests([
			...results,
			{ tempId: 4, success: true, id: '003-created', mode: 'create' },
		]), 1);
	});

	test('a terminal failed rewrite keeps retry safe when optional File cleanup fails', async () => {
		const calls = [];
		const result = await _settleKnownNoCommitForTests({
			async markFailed(id, details) {
				calls.push(['markFailed', id, details.errorCode]);
			},
			async remove(id) {
				calls.push(['remove', id]);
				throw new Error('delete denied');
			},
		}, '069-terminal', { errorCode: 'VALIDATION' });
		assert.deepEqual(result, { settled: true, method: 'failed-row' });
		assert.deepEqual(calls, [
			['markFailed', '069-terminal', 'VALIDATION'],
			['remove', '069-terminal'],
		]);
	});

	test('File deletion is a safe fallback when the terminal rewrite fails', async () => {
		const result = await _settleKnownNoCommitForTests({
			async markFailed() {
				throw new Error('rewrite denied');
			},
			async remove() {},
		}, '069-fallback', { errorCode: 'VALIDATION' });
		assert.deepEqual(result, { settled: true, method: 'removed' });
	});
});
