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

async function makeWorkspace(ownerAccountId, name = 'W') {
	const { ext } = await import('../src/extensions.js');
	const db = ext.getDb();
	const id = 'ws_' + crypto.randomUUID();
	const now = Date.now();
	await db.insertInto('workspaces').values({
		id, name, owner_account_id: ownerAccountId,
		created_at: now, updated_at: now,
	}).execute();
	return { id };
}

async function rawRow(id) {
	const { ext } = await import('../src/extensions.js');
	return ext.getDb().selectFrom('audit_log').selectAll().where('id', '=', id).executeTakeFirst();
}

describe('unchained (data-touching) rows', () => {
	test('chained:false writes a NULL chain_hash and is excluded from verifyChain', async () => {
		const { audit } = await import('../src/database/index.js');
		const a = await makeAccount();
		const ws = await makeWorkspace(a.id);
		const chainedId = await audit.record({ workspaceId: ws.id, actorAccountId: a.id, action: 'workspace_renamed' });
		const dataId = await audit.record({ workspaceId: ws.id, actorAccountId: a.id, action: 'upload', chained: false });
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

		await audit.record({ workspaceId: ws.id, actorAccountId: a.id, action: 'workspace_created' });
		const dataId = await audit.record({ workspaceId: ws.id, actorAccountId: a.id, action: 'upload', chained: false });
		await audit.record({ workspaceId: ws.id, actorAccountId: a.id, action: 'workspace_renamed' });
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
		await audit.record({ workspaceId: ws.id, actorAccountId: a.id, action: 'upload', chained: false, expiresAt: past });
		await audit.record({ workspaceId: ws.id, actorAccountId: a.id, action: 'upload', chained: false, expiresAt: past });
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

		await audit.record({ workspaceId: ws.id, actorAccountId: a.id, action: 'workspace_created', expiresAt: past });
		await audit.record({ workspaceId: ws.id, actorAccountId: a.id, action: 'workspace_renamed', expiresAt: past });
		await audit.record({ workspaceId: ws.id, actorAccountId: a.id, action: 'permission_grant', expiresAt: future });
		await audit.record({ workspaceId: ws.id, actorAccountId: a.id, action: 'permission_revoke', expiresAt: future });
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

		await audit.record({ workspaceId: ws.id, actorAccountId: a.id, action: 'workspace_created', expiresAt: future });
		await audit.record({ workspaceId: ws.id, actorAccountId: a.id, action: 'workspace_renamed', expiresAt: past });
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
		await audit.record({ workspaceId: ws.id, actorAccountId: a.id, action: 'workspace_created', expiresAt: past });
		await audit.purgeExpired();

		await audit.record({ workspaceId: ws.id, actorAccountId: a.id, action: 'workspace_renamed' });
		const result = await audit.verifyChain({ workspaceId: ws.id });
		assert.equal(result.ok, true);
		assert.equal(result.totalRows, 1);
		assert.equal(result.purgedBefore, 1);
	});
});

describe('GDPR payload redaction', () => {
	test('redacting a payload keeps verifyChain ok and marks redacted_at', async () => {
		const { audit } = await import('../src/database/index.js');
		const a = await makeAccount();
		const ws = await makeWorkspace(a.id);
		await audit.record({ workspaceId: ws.id, actorAccountId: a.id, action: 'workspace_created' });
		const inviteId = await audit.record({
			workspaceId: ws.id, actorAccountId: a.id, action: 'workspace_invite_created',
			payload: { note: 'invited alice@example.com to the team', role: 'member' },
		});
		await audit.record({ workspaceId: ws.id, actorAccountId: a.id, action: 'workspace_renamed' });

		const n = await audit.redactPayloadByEmail('alice@example.com');
		assert.equal(n, 1, 'one row contained the email');

		const row = await rawRow(inviteId);
		assert.ok(row.redacted_at, 'row marked redacted');
		assert.ok(!row.payload_json.includes('alice@example.com'), 'email scrubbed from payload');
		assert.ok(row.payload_json.includes('[redacted]'), 'placeholder written');
		assert.ok(row.payload_json.includes('member'), 'non-PII fields preserved');

		const result = await audit.verifyChain({ workspaceId: ws.id });
		assert.equal(result.ok, true, 'chain still verifies after redaction');
		assert.equal(result.totalRows, 3);
		assert.equal(result.redactedCount, 1);
	});

	test('redaction preserves STRUCTURAL integrity: deleting a neighbor is still detected', async () => {
		const { audit } = await import('../src/database/index.js');
		const { ext } = await import('../src/extensions.js');
		const a = await makeAccount();
		const ws = await makeWorkspace(a.id);
		const id0 = await audit.record({ workspaceId: ws.id, actorAccountId: a.id, action: 'workspace_created' });
		await audit.record({
			workspaceId: ws.id, actorAccountId: a.id, action: 'workspace_invite_created',
			payload: { email: 'bob@example.com' },
		});
		await audit.record({ workspaceId: ws.id, actorAccountId: a.id, action: 'workspace_renamed' });
		await audit.redactPayloadByEmail('bob@example.com');

		await ext.getDb().deleteFrom('audit_log').where('id', '=', id0).execute();
		const result = await audit.verifyChain({ workspaceId: ws.id });
		assert.equal(result.ok, false, 'deleting a row is still caught even next to a redacted one');
	});

	test('a redacted row still contributes to structural detection of a reordered neighbor', async () => {
		const { audit } = await import('../src/database/index.js');
		const { ext } = await import('../src/extensions.js');
		const a = await makeAccount();
		const ws = await makeWorkspace(a.id);
		await audit.record({ workspaceId: ws.id, actorAccountId: a.id, action: 'workspace_invite_created', payload: { email: 'dave@example.com' } });
		const id1 = await audit.record({ workspaceId: ws.id, actorAccountId: a.id, action: 'permission_grant', payload: { capability: 'x' } });
		const id2 = await audit.record({ workspaceId: ws.id, actorAccountId: a.id, action: 'permission_revoke', payload: { capability: 'y' } });
		await audit.redactPayloadByEmail('dave@example.com');

		const r1 = await rawRow(id1);
		const r2 = await rawRow(id2);
		await ext.getDb().updateTable('audit_log').set({ created_at: r2.created_at }).where('id', '=', id1).execute();
		await ext.getDb().updateTable('audit_log').set({ created_at: r1.created_at }).where('id', '=', id2).execute();
		const result = await audit.verifyChain({ workspaceId: ws.id });
		assert.equal(result.ok, false, 'reorder detected even with a redacted row present');
	});

	test('redactPayloadByEmail only touches rows that actually contain the email', async () => {
		const { audit } = await import('../src/database/index.js');
		const a = await makeAccount();
		const ws = await makeWorkspace(a.id);
		await audit.record({ workspaceId: ws.id, actorAccountId: a.id, action: 'workspace_renamed', payload: { newName: 'Ops' } });
		await audit.record({ workspaceId: ws.id, actorAccountId: a.id, action: 'workspace_invite_created', payload: { email: 'carol@example.com' } });
		const n = await audit.redactPayloadByEmail('nobody@nowhere.com');
		assert.equal(n, 0, 'no rows contained that email');
		const result = await audit.verifyChain({ workspaceId: ws.id });
		assert.equal(result.ok, true);
		assert.equal(result.redactedCount, 0);
	});
});

describe('concurrent chained writes', () => {
	test('20 concurrent writes to one workspace do not fork the chain', async () => {
		const { audit } = await import('../src/database/index.js');
		const a = await makeAccount();
		const ws = await makeWorkspace(a.id);

		await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				audit.record({ workspaceId: ws.id, actorAccountId: a.id, action: 'permission_grant', payload: { i } }),
			),
		);
		const result = await audit.verifyChain({ workspaceId: ws.id });
		assert.equal(result.ok, true, 'chain verifies after concurrent writes');
		assert.equal(result.totalRows, 20);
	});
});
