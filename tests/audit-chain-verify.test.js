
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { initTestDb, clearTestDb } from './helpers/db.js';

before(initTestDb);
beforeEach(clearTestDb);

async function makeAccount(email = 'a@x.com') {
	const { accounts } = await import('../src/database/index.js');
	return (await accounts.upsertByEmail({ email })).account;
}

async function makeWorkspace() {
	return { id: 'ws_' + crypto.randomUUID() };
}

async function writeN(workspaceId, actorAccountId, n) {
	const { audit } = await import('../src/database/index.js');
	const ids = [];
	for (let i = 0; i < n; i++) {
		ids.push(await audit.record({
			chained: true,
			workspaceId,
			actorAccountId,
			action: 'test_event_' + i,
			payload: { i },
		}));
		await new Promise((r) => setTimeout(r, 2));
	}
	return ids;
}

describe('verifyChain: clean chain', () => {
	test('empty workspace returns ok with totalRows=0', async () => {
		const { audit } = await import('../src/database/index.js');
		const a = await makeAccount();
		const ws = await makeWorkspace(a.id);
		const result = await audit.verifyChain({ workspaceId: ws.id });
		assert.equal(result.ok, true);
		assert.equal(result.totalRows, 0);
		assert.equal(result.lastHash, '');
	});

	test('unmutated chain of N rows verifies clean', async () => {
		const a = await makeAccount();
		const ws = await makeWorkspace(a.id);
		await writeN(ws.id, a.id, 5);
		const { audit } = await import('../src/database/index.js');
		const result = await audit.verifyChain({ workspaceId: ws.id });
		assert.equal(result.ok, true);
		assert.equal(result.totalRows, 5);
		assert.ok(result.lastHash && result.lastHash.length === 64, 'sha256 hex of 64 chars');
	});

	test('separate workspaces have independent chains', async () => {
		const a = await makeAccount();
		const wsA = await makeWorkspace(a.id, 'A');
		const wsB = await makeWorkspace(a.id, 'B');
		await writeN(wsA.id, a.id, 3);
		await writeN(wsB.id, a.id, 3);
		const { audit } = await import('../src/database/index.js');
		const ra = await audit.verifyChain({ workspaceId: wsA.id });
		const rb = await audit.verifyChain({ workspaceId: wsB.id });
		assert.equal(ra.ok, true);
		assert.equal(rb.ok, true);
		assert.notEqual(ra.lastHash, rb.lastHash, 'workspaces should NOT share chain heads');
	});
});

describe('verifyChain: tamper detection', () => {
	test('mutating a row\'s payload_json after insert is detected at that row', async () => {
		const { ext } = await import('../src/extensions.js');
		const a = await makeAccount();
		const ws = await makeWorkspace(a.id);
		const ids = await writeN(ws.id, a.id, 5);
		await ext.getDb()
			.updateTable('audit_log')
			.set({ payload_json: JSON.stringify({ i: 99, tampered: true }) })
			.where('id', '=', ids[2])
			.execute();
		const { audit } = await import('../src/database/index.js');
		const result = await audit.verifyChain({ workspaceId: ws.id });
		assert.equal(result.ok, false);
		assert.equal(result.brokenIndex, 2, 'break detected at the mutated row');
		assert.equal(result.breakAt.id, ids[2]);
		assert.equal(result.breakAt.action, 'test_event_2');
	});

	test('mutating a row\'s chain_hash directly is detected', async () => {
		const { ext } = await import('../src/extensions.js');
		const a = await makeAccount();
		const ws = await makeWorkspace(a.id);
		const ids = await writeN(ws.id, a.id, 4);
		await ext.getDb()
			.updateTable('audit_log')
			.set({ chain_hash: '00'.repeat(32) })
			.where('id', '=', ids[1])
			.execute();
		const { audit } = await import('../src/database/index.js');
		const result = await audit.verifyChain({ workspaceId: ws.id });
		assert.equal(result.ok, false);
		assert.equal(result.brokenIndex, 1);
	});

	test('deleting a middle row breaks the chain at the deleted position', async () => {
		const { ext } = await import('../src/extensions.js');
		const a = await makeAccount();
		const ws = await makeWorkspace(a.id);
		const ids = await writeN(ws.id, a.id, 5);
		await ext.getDb().deleteFrom('audit_log').where('id', '=', ids[2]).execute();
		const { audit } = await import('../src/database/index.js');
		const result = await audit.verifyChain({ workspaceId: ws.id });
		assert.equal(result.ok, false);
		assert.equal(result.totalRows, 4);
		assert.equal(result.brokenIndex, 2);
	});

	test('changing the action field on a row is detected', async () => {
		const { ext } = await import('../src/extensions.js');
		const a = await makeAccount();
		const ws = await makeWorkspace(a.id);
		const ids = await writeN(ws.id, a.id, 3);
		await ext.getDb()
			.updateTable('audit_log')
			.set({ action: 'workspace_renamed_evil' })
			.where('id', '=', ids[0])
			.execute();
		const { audit } = await import('../src/database/index.js');
		const result = await audit.verifyChain({ workspaceId: ws.id });
		assert.equal(result.ok, false);
		assert.equal(result.brokenIndex, 0);
	});

	test('mutating row N also surfaces a break: break propagates downstream', async () => {
		const { ext } = await import('../src/extensions.js');
		const a = await makeAccount();
		const ws = await makeWorkspace(a.id);
		const ids = await writeN(ws.id, a.id, 4);
		await ext.getDb()
			.updateTable('audit_log')
			.set({ payload_json: JSON.stringify({ rewritten: true }) })
			.where('id', '=', ids[1])
			.execute();
		const { audit } = await import('../src/database/index.js');
		const result = await audit.verifyChain({ workspaceId: ws.id });
		assert.equal(result.ok, false);
		assert.equal(result.brokenIndex, 1, 'first break wins');
	});
});
