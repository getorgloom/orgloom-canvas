import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOrgApprovalDeniedPayload as approvalPayload } from '../src/org-approval-copy.js';

test('pending production approval names the automatic request and approval path', () => {
	const payload = approvalPayload({ reason: 'approval-required', approvalStatus: 'pending' }, 'production');

	assert.equal(payload.error, 'approval-required');
	assert.equal(payload.approvalStatus, 'pending');
	assert.match(payload.message, /automatically created an access request/i);
	assert.match(payload.message, /production Salesforce org/i);
	assert.match(payload.message, /Any workspace admin can approve it in Workspace settings/i);
});

test('developer approval is described as non-production', () => {
	const payload = approvalPayload({ reason: 'approval-required', approvalStatus: 'pending' }, 'developer');

	assert.match(payload.message, /non-production Salesforce org/i);
	assert.doesNotMatch(payload.message, /this production Salesforce org/i);
});

test('a prior denial asks an admin to review instead of claiming a new request', () => {
	const payload = approvalPayload({ reason: 'approval-required', approvalStatus: 'denied' }, 'sandbox');

	assert.match(payload.message, /currently denied/i);
	assert.match(payload.message, /Any workspace admin can review and approve/i);
	assert.doesNotMatch(payload.message, /automatically created/i);
});
