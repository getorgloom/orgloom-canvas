// Unit tests for src/database/view-state.js. Tiny module: covers
// lazy-create, partial patches, and per-axis setters.
//
// view-state's FK columns reference the workspaces + connections
// tables, but the workspaces module itself lives in the saas package.
// To keep this test self-contained inside the canvas package, we
// insert workspace rows via raw kysely instead of going through the
// saas workspaces.create() helper. The schema's the same; only the
// constructor shortcut is missing.

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

// Raw workspace insert: bypasses the saas workspaces.create() helper
// (which also wires workspace_members + workspace_settings). For these
// tests we only need a valid workspaces.id to satisfy the FK on
// account_view_state.current_workspace_id; the related-table rows
// aren't read. We use only the canvas-base columns (id, name,
// owner_account_id, created_at, updated_at) so this works without the
// saas migrations that add kind / plan / paid_seats.
async function makeWorkspace(ownerAccountId, name = 'W') {
	const { ext } = await import('../src/extensions.js');
	const db = ext.getDb();
	const id = 'ws_' + crypto.randomUUID();
	const now = Date.now();
	await db.insertInto('workspaces').values({
		id, name, owner_account_id: ownerAccountId,
		created_at: now, updated_at: now,
	}).execute();
	// Mirror the saas-side workspacesDb.create() shape: the owner is
	// always inserted as an admin member in the same transaction. The
	// defense-in-depth membership check inside setCurrentWorkspace
	// expects this row; without it the helper-created workspace would
	// fail the gate.
	await db.insertInto('workspace_members').values({
		workspace_id: id,
		account_id: ownerAccountId,
		role: 'admin',
		joined_at: now,
	}).execute();
	return { id };
}

describe('viewStateDb', () => {
	test('get returns undefined for an account with no view-state row yet', async () => {
		const { viewState } = await import('../src/database/index.js');
		const a = await makeAccount();
		const v = await viewState.get(a.id);
		assert.equal(v, undefined);
	});

	test('setCurrentWorkspace creates the row on first call', async () => {
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
		const ws = await makeWorkspace(a.id);
		const { connection } = await connections.upsertFromOauth({
			accountId: a.id, sfUserId: 's1', sfOrgId: '00D1',
			instanceUrl: 'https://x.salesforce.com',
		});
		await viewState.setCurrentWorkspace(a.id, ws.id);
		await viewState.setCurrentConnection(a.id, connection.id);
		const v = await viewState.get(a.id);
		assert.equal(v.current_workspace_id, ws.id, 'workspace preserved');
		assert.equal(v.current_connection_id, connection.id);
	});

	test('passing null clears the field', async () => {
		const { viewState } = await import('../src/database/index.js');
		const a = await makeAccount();
		const ws = await makeWorkspace(a.id);
		await viewState.setCurrentWorkspace(a.id, ws.id);
		await viewState.setCurrentWorkspace(a.id, null);
		const v = await viewState.get(a.id);
		assert.equal(v.current_workspace_id, null);
	});

	test('setCurrentWorkspace rejects when the account is not a member of the target workspace', async () => {
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
		// And the view-state must not have been written.
		const v = await viewState.get(stranger.id);
		assert.equal(v, undefined);
	});
});
