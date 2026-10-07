import assert from 'node:assert/strict';
import test from 'node:test';
import * as proposals from '../src/mcp/proposals-store.js';

test('applied proposal outcome remains briefly in process memory without retaining proposed values', async () => {
	const proposal = await proposals.create({
		canvasId: '069000000000001AAA',
		workspaceId: 'ws-test',
		proposingAccountId: 'acct-test',
		proposingTokenId: 'token-test',
		changes: [{ kind: 'set-field', field: 'Account.Name', value: 'Sensitive value' }],
		summary: 'Sensitive summary',
	});
	const marked = await proposals.markApplied({
		id: proposal.id,
		decidedByAccountId: 'acct-reviewer',
		outcome: [{ kind: 'set-field', status: 'applied' }],
		applyMode: 'canvas-only',
	});
	assert.equal(marked, true);

	const stored = await proposals.findById(proposal.id);
	assert.equal(stored.status, 'applied');
	assert.equal(stored.decidedByAccountId, 'acct-reviewer');
	assert.equal(stored.summary, null);
	assert.deepEqual(stored.changes, []);
	assert.deepEqual(stored.outcome, [{ kind: 'set-field', status: 'applied' }]);
	assert.equal(stored.applyMode, 'canvas-only');
	assert.doesNotMatch(JSON.stringify(stored), /Sensitive value|Sensitive summary|Account\.Name/);
});

test('rejected proposal status remains briefly without retaining proposed values', async () => {
	const proposal = await proposals.create({
		canvasId: '069000000000002AAA',
		workspaceId: 'ws-test',
		proposingAccountId: 'acct-test',
		changes: [{ kind: 'set-field', field: 'Contact.Email', value: 'private@example.com' }],
		summary: 'Reject this',
	});
	assert.equal(await proposals.markRejected({ id: proposal.id, decidedByAccountId: 'acct-reviewer' }), true);
	const stored = await proposals.findById(proposal.id);
	assert.equal(stored.status, 'rejected');
	assert.deepEqual(stored.changes, []);
	assert.equal(stored.summary, null);
	assert.doesNotMatch(JSON.stringify(stored), /private@example\.com|Contact\.Email|Reject this/);
});
