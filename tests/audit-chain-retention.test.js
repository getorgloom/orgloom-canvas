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

async function rawRow(id) {
	const { ext } = await import('../src/extensions.js');
	return ext.getDb().selectFrom('audit_log').selectAll().where('id', '=', id).executeTakeFirst();
}

describe('unchained Activity History rows', () => {
	test('unchained is the default; explicit legacy chained rows still verify', async () => {
		const { audit } = await import('../src/database/index.js');
		const a = await makeAccount();
		const ws = await makeWorkspace(a.id);
		const chainedId = await audit.record({
			workspaceId: ws.id,
			actorAccountId: a.id,
			action: 'workspace_renamed',
			chained: true,
		});
		const dataId = await audit.record({ workspaceId: ws.id, actorAccountId: a.id, action: 'upload' });
		assert.ok((await rawRow(chainedId)).chain_hash, 'chained row has a hash');
		assert.equal((await rawRow(dataId)).chain_hash, null, 'unchained row has NULL hash');
		const result = await audit.verifyChain({ workspaceId: ws.id });
		assert.equal(result.ok, true);
		assert.equal(result.totalRows, 1, 'only the chained row is walked');
	});

	test('deleting an unchained row does NOT break the chain', async () => {
		const { audit } = await import('../src/database/index.js');
		const { ext } = await import('../src/extensions.js');
		const a = await makeAccount();
		const ws = await makeWorkspace(a.id);
		await audit.record({ workspaceId: ws.id, actorAccountId: a.id, action: 'workspace_created', chained: true });
		const dataId = await audit.record({
			workspaceId: ws.id,
			actorAccountId: a.id,
			action: 'upload',
			chained: false,
		});
		await audit.record({ workspaceId: ws.id, actorAccountId: a.id, action: 'workspace_renamed', chained: true });
		await ext.getDb().deleteFrom('audit_log').where('id', '=', dataId).execute();
		const result = await audit.verifyChain({ workspaceId: ws.id });
		assert.equal(result.ok, true, 'chain intact after unchained row deleted');
		assert.equal(result.totalRows, 2);
	});
});

describe('purgeExpired: chain-safe retention', () => {
	test('purges expired unchained rows unconditionally', async () => {
		const { audit } = await import('../src/database/index.js');
		const a = await makeAccount();
		const ws = await makeWorkspace(a.id);
		const past = Date.now() - 1000;
		await audit.record({
			workspaceId: ws.id,
			actorAccountId: a.id,
			action: 'upload',
			chained: false,
			expiresAt: past,
		});
		await audit.record({
			workspaceId: ws.id,
			actorAccountId: a.id,
			action: 'upload',
			chained: false,
			expiresAt: past,
		});
		const dropped = await audit.purgeExpired();
		assert.equal(dropped, 2);
		const result = await audit.verifyChain({ workspaceId: ws.id });
		assert.equal(result.ok, true);
		assert.equal(result.totalRows, 0);
	});

	test('purges an expired chained PREFIX and anchors so verify stays ok', async () => {
		const { audit } = await import('../src/database/index.js');
		const a = await makeAccount();
		const ws = await makeWorkspace(a.id);
		const past = Date.now() - 1000;
		const future = Date.now() + 1_000_000;
		await audit.record({
			workspaceId: ws.id,
			actorAccountId: a.id,
			action: 'workspace_created',
			expiresAt: past,
			chained: true,
		});
		await audit.record({
			workspaceId: ws.id,
			actorAccountId: a.id,
			action: 'workspace_renamed',
			expiresAt: past,
			chained: true,
		});
		await audit.record({
			workspaceId: ws.id,
			actorAccountId: a.id,
			action: 'permission_grant',
			expiresAt: future,
			chained: true,
		});
		await audit.record({
			workspaceId: ws.id,
			actorAccountId: a.id,
			action: 'permission_revoke',
			expiresAt: future,
			chained: true,
		});
		const dropped = await audit.purgeExpired();
		assert.equal(dropped, 2, 'the two expired prefix rows dropped');
		const result = await audit.verifyChain({ workspaceId: ws.id });
		assert.equal(result.ok, true, 'surviving suffix verifies via the anchor');
		assert.equal(result.totalRows, 2);
		assert.equal(result.purgedBefore, 2, 'anchor records the purged count');
	});

	test('does NOT delete a newer expired chained row shadowed by an older retained one', async () => {
		const { audit } = await import('../src/database/index.js');
		const { ext } = await import('../src/extensions.js');
		const a = await makeAccount();
		const ws = await makeWorkspace(a.id);
		const past = Date.now() - 1000;
		const future = Date.now() + 1_000_000;
		await audit.record({
			workspaceId: ws.id,
			actorAccountId: a.id,
			action: 'workspace_created',
			expiresAt: future,
			chained: true,
		});
		await audit.record({
			workspaceId: ws.id,
			actorAccountId: a.id,
			action: 'workspace_renamed',
			expiresAt: past,
			chained: true,
		});
		const dropped = await audit.purgeExpired();
		assert.equal(dropped, 0, 'nothing purged: the expired row is not a prefix');
		const result = await audit.verifyChain({ workspaceId: ws.id });
		assert.equal(result.ok, true);
		assert.equal(result.totalRows, 2);
	});

	test('a new chained write after a prefix purge chains off the anchor', async () => {
		const { audit } = await import('../src/database/index.js');
		const a = await makeAccount();
		const ws = await makeWorkspace(a.id);
		const past = Date.now() - 1000;
		await audit.record({
			workspaceId: ws.id,
			actorAccountId: a.id,
			action: 'workspace_created',
			expiresAt: past,
			chained: true,
		});
		await audit.purgeExpired(); // purges the only row, sets anchor
		await audit.record({ workspaceId: ws.id, actorAccountId: a.id, action: 'workspace_renamed', chained: true });
		const result = await audit.verifyChain({ workspaceId: ws.id });
		assert.equal(result.ok, true);
		assert.equal(result.totalRows, 1);
		assert.equal(result.purgedBefore, 1);
	});
});

describe('concurrent chained writes', () => {
	test('20 concurrent writes to one workspace do not fork the chain', async () => {
		const { audit } = await import('../src/database/index.js');
		const a = await makeAccount();
		const ws = await makeWorkspace(a.id);
		await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				audit.record({
					workspaceId: ws.id,
					actorAccountId: a.id,
					action: 'permission_grant',
					payload: { i },
					chained: true,
				}),
			),
		);
		const result = await audit.verifyChain({ workspaceId: ws.id });
		assert.equal(result.ok, true, 'chain verifies after concurrent writes');
		assert.equal(result.totalRows, 20);
	});
});
