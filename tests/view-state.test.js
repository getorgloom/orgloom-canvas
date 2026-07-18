import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { initTestDb, clearTestDb, hasTestTable } from './helpers/db.js';

before(initTestDb);
beforeEach(clearTestDb);

async function makeAccount(email = 'a@x.com') {
	const { accounts } = await import('../src/database/index.js');
	return (await accounts.upsertByEmail({ email })).account;
}

async function makeWorkspace(ownerAccountId, name = 'W') {
	const { ext } = await import('../src/extensions.js');
	const db = ext.getDb();
	const id = 'ws_' + crypto.randomUUID();
	const now = Date.now();
	await db
		.insertInto('workspaces')
		.values({
			id,
			name,
			owner_account_id: ownerAccountId,
			created_at: now,
			updated_at: now,
		})
		.execute();
	await db
		.insertInto('workspace_members')
		.values({
			workspace_id: id,
			account_id: ownerAccountId,
			role: 'admin',
			joined_at: now,
		})
		.execute();
	return { id };
}

async function makeWorkspaceReference(accountId) {
	if (await hasTestTable('workspace_members')) {
		return (await makeWorkspace(accountId)).id;
	}
	return 'ws_' + crypto.randomUUID();
}

describe('viewStateDb', () => {
	test('get returns undefined for an account with no view-state row yet', async () => {
		const { viewState } = await import('../src/database/index.js');
		const a = await makeAccount();
		const v = await viewState.get(a.id);
		assert.equal(v, undefined);
	});

	test('setCurrentWorkspace creates the row on first call', async (t) => {
		if (!(await hasTestTable('workspace_members'))) {
			t.skip('hosted workspace overlay is not installed');
			return;
		}
		const { viewState } = await import('../src/database/index.js');
		const a = await makeAccount();
		const ws = await makeWorkspace(a.id);
		await viewState.setCurrentWorkspace(a.id, ws.id);
		const v = await viewState.get(a.id);
		assert.equal(v.current_workspace_id, ws.id);
		assert.equal(v.current_connection_id, null);
	});

	test('setCurrentConnection preserves current_workspace_id', async () => {
		const { viewState, connections } = await import('../src/database/index.js');
		const a = await makeAccount();
		const workspaceId = await makeWorkspaceReference(a.id);
		const { connection } = await connections.upsertFromOauth({
			accountId: a.id,
			sfUserId: 's1',
			sfOrgId: '00D1',
			instanceUrl: 'https://x.salesforce.com',
		});
		await viewState.set(a.id, { currentWorkspaceId: workspaceId });
		await viewState.setCurrentConnection(a.id, connection.id);
		const v = await viewState.get(a.id);
		assert.equal(v.current_workspace_id, workspaceId, 'workspace preserved');
		assert.equal(v.current_connection_id, connection.id);
	});

	test('passing null clears the field', async () => {
		const { viewState } = await import('../src/database/index.js');
		const a = await makeAccount();
		await viewState.set(a.id, { currentWorkspaceId: await makeWorkspaceReference(a.id) });
		await viewState.setCurrentWorkspace(a.id, null);
		const v = await viewState.get(a.id);
		assert.equal(v.current_workspace_id, null);
	});

	test('setCurrentWorkspace rejects when the account is not a member of the target workspace', async (t) => {
		if (!(await hasTestTable('workspace_members'))) {
			t.skip('hosted workspace overlay is not installed');
			return;
		}
		const { viewState } = await import('../src/database/index.js');
		const owner = await makeAccount('owner@x.com');
		const stranger = await makeAccount('stranger@x.com');
		const ws = await makeWorkspace(owner.id); // stranger is NOT a member
		await assert.rejects(
			() => viewState.setCurrentWorkspace(stranger.id, ws.id),
			(err) => {
				assert.equal(err.code, 'not-a-member');
				return true;
			},
		);
		const v = await viewState.get(stranger.id);
		assert.equal(v, undefined);
	});
});
