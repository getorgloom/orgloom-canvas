import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { isSalesforceSessionExpiredError } from '../src/sf-session-errors.js';

describe('Salesforce session error classification', () => {
	test('recognizes Salesforce and jsforce expired-session shapes', () => {
		assert.equal(isSalesforceSessionExpiredError({ errorCode: 'INVALID_SESSION_ID' }), true);
		assert.equal(isSalesforceSessionExpiredError({ name: 'INVALID_SESSION_ID' }), true);
		assert.equal(isSalesforceSessionExpiredError(new Error('Session expired or invalid')), true);
		assert.equal(isSalesforceSessionExpiredError({ code: 'invalid_grant' }), true);
		assert.equal(isSalesforceSessionExpiredError({ error_description: 'authentication failure' }), true);
		assert.equal(isSalesforceSessionExpiredError({ status: 401 }), true);
		assert.equal(isSalesforceSessionExpiredError({ data: { errorCode: 'INVALID_SESSION_ID' } }), true);
		assert.equal(
			isSalesforceSessionExpiredError({ response: { body: [{ errorCode: 'INVALID_SESSION_ID' }] } }),
			true,
		);
		assert.equal(isSalesforceSessionExpiredError({ cause: { statusCode: 401 } }), true);
		assert.equal(
			isSalesforceSessionExpiredError(
				new Error('Unable to refresh session due to: expired access/refresh token'),
			),
			true,
		);
	});

	test('does not misclassify permission and availability failures', () => {
		assert.equal(
			isSalesforceSessionExpiredError(new Error('sObject type PermissionSetAssignment is not supported')),
			false,
		);
		assert.equal(isSalesforceSessionExpiredError(new Error('request timed out')), false);
		assert.equal(isSalesforceSessionExpiredError(null), false);
	});
});
