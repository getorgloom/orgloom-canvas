import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, test } from 'node:test';
import {
	_claimUploadAttemptForTests,
	_resetUploadAttemptClaimsForTests,
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
});
