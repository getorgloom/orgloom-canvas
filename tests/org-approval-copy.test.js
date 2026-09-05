import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOrgApprovalDeniedPayload as approvalPayload } from '../src/org-approval-copy.js';

test('a blocked production org directs the user to the workspace allowlist', () => {
	const payload = approvalPayload({ reason: 'org-not-allowed' }, 'production');

	assert.equal(payload.error, 'org-not-allowed');
	assert.equal(payload.orgType, 'production');
	assert.match(payload.message, /workspace allowlist/i);
	assert.match(payload.message, /Current My Domain URL/i);
	assert.doesNotMatch(payload.message, /request|pending|approve/i);
});

test('the payload preserves the detected org type', () => {
	const payload = approvalPayload({ reason: 'org-not-allowed' }, 'developer');

	assert.equal(payload.orgType, 'developer');
	assert.doesNotMatch(payload.message, /approval request/i);
});
