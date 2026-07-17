// Locks the MCP bearer-token security model:
//   * Plaintext is shown at issue time, then never again: the row
//     stores sha256(plaintext), not the plaintext itself.
//   * authenticate() verifies presented bearer against stored hash, and
//     rejects (a) wrong secret, (b) revoked token, (c) expired token,
//     (d) tokens not bearing the `ol_mcp_` prefix.
//   * every token has an immutable workspace scope; list/revoke operations
//     cannot cross either the account or workspace boundary.

import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { initTestDb, clearTestDb } from './helpers/db.js';

const WS_A = 'ws_mcp_a';
const WS_B = 'ws_mcp_b';

before(initTestDb);
beforeEach(clearTestDb);

async function makeAccount(email = 'a@x.com') {
	const { accounts } = await import('../src/database/index.js');
	return (await accounts.upsertByEmail({ email })).account;
}

describe('mcpTokens.issue', () => {
	test('returns plaintext once and stores only the hash', async () => {
		const { mcpTokens } = await import('../src/database/index.js');
		const { ext } = await import('../src/extensions.js');
		const a = await makeAccount();
		const issued = await mcpTokens.issue({ accountId: a.id, workspaceId: WS_A, name: 'cli' });
		assert.ok(issued.plaintext.startsWith('ol_mcp_'));
		assert.equal(issued.plaintext.length, 'ol_mcp_'.length + 64, '64 hex chars after prefix');
		// Verify the stored column is the hash, never the plaintext.
		const row = await ext.getDb()
			.selectFrom('mcp_tokens')
			.select(['token_hash', 'workspace_id'])
			.where('id', '=', issued.id)
			.executeTakeFirst();
		assert.equal(row.token_hash.length, 64, 'sha256 hex');
		assert.equal(row.workspace_id, WS_A);
		assert.notEqual(row.token_hash, issued.plaintext);
		const expectedHash = crypto.createHash('sha256').update(issued.plaintext).digest('hex');
		assert.equal(row.token_hash, expectedHash);
	});

	test('rejects missing/empty inputs', async () => {
		const { mcpTokens } = await import('../src/database/index.js');
		const a = await makeAccount();
		await assert.rejects(() => mcpTokens.issue({ name: 'x' }), /accountId/);
		await assert.rejects(() => mcpTokens.issue({ accountId: a.id, name: 'x' }), /workspaceId/);
		await assert.rejects(() => mcpTokens.issue({ accountId: a.id, workspaceId: WS_A }), /name/);
		await assert.rejects(() => mcpTokens.issue({ accountId: a.id, workspaceId: WS_A, name: '   ' }), /name/);
	});

	test('two issuances for the same account produce distinct plaintexts', async () => {
		const { mcpTokens } = await import('../src/database/index.js');
		const a = await makeAccount();
		const t1 = await mcpTokens.issue({ accountId: a.id, workspaceId: WS_A, name: 'one' });
		const t2 = await mcpTokens.issue({ accountId: a.id, workspaceId: WS_A, name: 'two' });
		assert.notEqual(t1.plaintext, t2.plaintext);
		assert.notEqual(t1.id, t2.id);
	});

	test('caps each account and workspace at ten live tokens and frees capacity on revoke', async () => {
		const { mcpTokens } = await import('../src/database/index.js');
		const a = await makeAccount();
		const issued = [];
		for (let i = 0; i < 10; i++) {
issued.push(await mcpTokens.issue({ accountId: a.id, workspaceId: WS_A, name: `client-${i}` }));
}
		await assert.rejects(() => mcpTokens.issue({ accountId: a.id, workspaceId: WS_A, name: 'eleven' }), /mcp-token-cap-reached/);
		assert.ok(await mcpTokens.issue({ accountId: a.id, workspaceId: WS_B, name: 'other workspace' }), 'cap is per workspace');
		await mcpTokens.revoke(issued[0].id, a.id, WS_A);
		assert.ok(await mcpTokens.issue({ accountId: a.id, workspaceId: WS_A, name: 'replacement' }));
	});
});

describe('mcpTokens.authenticate', () => {
	test('right plaintext returns the row', async () => {
		const { mcpTokens } = await import('../src/database/index.js');
		const a = await makeAccount();
		const issued = await mcpTokens.issue({ accountId: a.id, workspaceId: WS_A, name: 'cli' });
		const row = await mcpTokens.authenticate(issued.plaintext);
		assert.ok(row);
		assert.equal(row.id, issued.id);
		assert.equal(row.account_id, a.id);
		assert.equal(row.workspace_id, WS_A);
	});

	test('wrong plaintext returns null', async () => {
		const { mcpTokens } = await import('../src/database/index.js');
		const a = await makeAccount();
		await mcpTokens.issue({ accountId: a.id, workspaceId: WS_A, name: 'cli' });
		const row = await mcpTokens.authenticate('ol_mcp_' + 'f'.repeat(64));
		assert.equal(row, null);
	});

	test('rejects strings without the ol_mcp_ prefix', async () => {
		const { mcpTokens } = await import('../src/database/index.js');
		const a = await makeAccount();
		const issued = await mcpTokens.issue({ accountId: a.id, workspaceId: WS_A, name: 'cli' });
		// Strip the prefix: same chars after, should still fail
		// (prefix gate runs BEFORE the hash lookup).
		const stripped = issued.plaintext.slice('ol_mcp_'.length);
		assert.equal(await mcpTokens.authenticate(stripped), null);
		assert.equal(await mcpTokens.authenticate(''), null);
		assert.equal(await mcpTokens.authenticate(null), null);
		assert.equal(await mcpTokens.authenticate(undefined), null);
		assert.equal(await mcpTokens.authenticate(42), null);
	});

	test('revoked token does not authenticate', async () => {
		const { mcpTokens } = await import('../src/database/index.js');
		const a = await makeAccount();
		const issued = await mcpTokens.issue({ accountId: a.id, workspaceId: WS_A, name: 'cli' });
		const revoked = await mcpTokens.revoke(issued.id, a.id, WS_A);
		assert.equal(revoked, true);
		assert.equal(await mcpTokens.authenticate(issued.plaintext), null);
	});

	test('expired token does not authenticate', async () => {
		const { mcpTokens } = await import('../src/database/index.js');
		const a = await makeAccount();
		// Use a 5ms TTL so the test doesn't sleep long.
		const issued = await mcpTokens.issue({ accountId: a.id, workspaceId: WS_A, name: 'cli', ttlMs: 5 });
		await new Promise((r) => setTimeout(r, 15));
		assert.equal(await mcpTokens.authenticate(issued.plaintext), null);
	});
});

describe('mcpTokens.revoke', () => {
	test('account-scoped revoke rejects another user\'s token', async () => {
		const { mcpTokens } = await import('../src/database/index.js');
		const alice = await makeAccount('alice@x.com');
		const bob = await makeAccount('bob@x.com');
		const tok = await mcpTokens.issue({ accountId: alice.id, workspaceId: WS_A, name: 'alice-cli' });
		// Bob tries to revoke Alice's token.
		const ok = await mcpTokens.revoke(tok.id, bob.id);
		assert.equal(ok, false, 'cross-account revoke must not succeed');
		// Alice's token still authenticates.
		const row = await mcpTokens.authenticate(tok.plaintext);
		assert.ok(row);
	});

	test('workspace-scoped revoke rejects a token from another workspace', async () => {
		const { mcpTokens } = await import('../src/database/index.js');
		const a = await makeAccount();
		const tok = await mcpTokens.issue({ accountId: a.id, workspaceId: WS_A, name: 'cli' });
		assert.equal(await mcpTokens.revoke(tok.id, a.id, WS_B), false);
		assert.ok(await mcpTokens.authenticate(tok.plaintext));
	});

	test('admin-style revoke remains fenced to the supplied workspace', async () => {
		const { mcpTokens } = await import('../src/database/index.js');
		const a = await makeAccount();
		const tok = await mcpTokens.issue({ accountId: a.id, workspaceId: WS_A, name: 'cli' });
		assert.equal(await mcpTokens.revoke(tok.id, null, WS_B), false);
		assert.ok(await mcpTokens.authenticate(tok.plaintext));
		assert.equal(await mcpTokens.revoke(tok.id, null, WS_A), true);
		assert.equal(await mcpTokens.authenticate(tok.plaintext), null);
	});

	test('membership cleanup revokes every token for only that account and workspace', async () => {
		const { mcpTokens } = await import('../src/database/index.js');
		const a = await makeAccount();
		const first = await mcpTokens.issue({ accountId: a.id, workspaceId: WS_A, name: 'one' });
		const second = await mcpTokens.issue({ accountId: a.id, workspaceId: WS_A, name: 'two' });
		const other = await mcpTokens.issue({ accountId: a.id, workspaceId: WS_B, name: 'other' });
		assert.equal(await mcpTokens.revokeForAccountWorkspace(a.id, WS_A), 2);
		assert.equal(await mcpTokens.authenticate(first.plaintext), null);
		assert.equal(await mcpTokens.authenticate(second.plaintext), null);
		assert.ok(await mcpTokens.authenticate(other.plaintext));
	});

	test('revoke without accountId (admin path) succeeds', async () => {
		const { mcpTokens } = await import('../src/database/index.js');
		const a = await makeAccount();
		const tok = await mcpTokens.issue({ accountId: a.id, workspaceId: WS_A, name: 'cli' });
		const ok = await mcpTokens.revoke(tok.id, null);
		assert.equal(ok, true);
	});

	test('double-revoke returns false the second time', async () => {
		const { mcpTokens } = await import('../src/database/index.js');
		const a = await makeAccount();
		const tok = await mcpTokens.issue({ accountId: a.id, workspaceId: WS_A, name: 'cli' });
		assert.equal(await mcpTokens.revoke(tok.id, a.id), true);
		assert.equal(await mcpTokens.revoke(tok.id, a.id), false, 'idempotent, already revoked');
	});
});

describe('mcpTokens.listForWorkspace', () => {
	test('omits revoked tokens; includes expired-but-not-revoked with expired:true', async () => {
		const { mcpTokens } = await import('../src/database/index.js');
		const a = await makeAccount();
		const active = await mcpTokens.issue({ accountId: a.id, workspaceId: WS_A, name: 'active' });
		const expired = await mcpTokens.issue({ accountId: a.id, workspaceId: WS_A, name: 'expired', ttlMs: 5 });
		const revoked = await mcpTokens.issue({ accountId: a.id, workspaceId: WS_A, name: 'revoked' });
		await mcpTokens.issue({ accountId: a.id, workspaceId: WS_B, name: 'other' });
		await mcpTokens.revoke(revoked.id, a.id, WS_A);
		await new Promise((r) => setTimeout(r, 15));
		const list = await mcpTokens.listForWorkspace(a.id, WS_A);
		const names = list.map((t) => t.name).sort();
		assert.deepEqual(names, ['active', 'expired'], 'revoked is filtered out');
		const expRow = list.find((t) => t.name === 'expired');
		assert.equal(expRow.expired, true);
		const actRow = list.find((t) => t.name === 'active');
		assert.equal(actRow.expired, false);
		// The hash is never surfaced.
		for (const t of list) {
			assert.equal(t.token_hash, undefined, 'list never includes the hash');
			assert.equal(t.plaintext, undefined, 'list never includes plaintext');
		}
	});

	test('members see only their tokens while an admin listing can see every owner in the workspace', async () => {
		const { mcpTokens } = await import('../src/database/index.js');
		const alice = await makeAccount('alice-list@x.com');
		const bob = await makeAccount('bob-list@x.com');
		await mcpTokens.issue({ accountId: alice.id, workspaceId: WS_A, name: 'alice client' });
		await mcpTokens.issue({ accountId: bob.id, workspaceId: WS_A, name: 'bob client' });
		await mcpTokens.issue({ accountId: bob.id, workspaceId: WS_B, name: 'other workspace' });

		const memberList = await mcpTokens.listForWorkspace(alice.id, WS_A);
		assert.deepEqual(memberList.map((token) => token.name), ['alice client']);
		const adminList = await mcpTokens.listForWorkspace(alice.id, WS_A, { includeAllOwners: true });
		assert.deepEqual(adminList.map((token) => token.name).sort(), ['alice client', 'bob client']);
		assert.deepEqual(new Set(adminList.map((token) => token.accountId)), new Set([alice.id, bob.id]));
	});
});
