//     rejects (a) wrong secret, (b) revoked token, (c) expired token,

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

describe('mcpTokens.issue', () => {
	test('returns plaintext once and stores only the hash', async () => {
		const { mcpTokens } = await import('../src/database/index.js');
		const { ext } = await import('../src/extensions.js');
		const a = await makeAccount();
		const issued = await mcpTokens.issue({ accountId: a.id, name: 'cli' });
		assert.ok(issued.plaintext.startsWith('ol_mcp_'));
		assert.equal(issued.plaintext.length, 'ol_mcp_'.length + 64, '64 hex chars after prefix');

		const row = await ext.getDb()
			.selectFrom('mcp_tokens')
			.select(['token_hash'])
			.where('id', '=', issued.id)
			.executeTakeFirst();
		assert.equal(row.token_hash.length, 64, 'sha256 hex');
		assert.notEqual(row.token_hash, issued.plaintext);
		const expectedHash = crypto.createHash('sha256').update(issued.plaintext).digest('hex');
		assert.equal(row.token_hash, expectedHash);
	});

	test('rejects missing/empty inputs', async () => {
		const { mcpTokens } = await import('../src/database/index.js');
		const a = await makeAccount();
		await assert.rejects(() => mcpTokens.issue({ name: 'x' }), /accountId/);
		await assert.rejects(() => mcpTokens.issue({ accountId: a.id }), /name/);
		await assert.rejects(() => mcpTokens.issue({ accountId: a.id, name: '   ' }), /name/);
	});

	test('two issuances for the same account produce distinct plaintexts', async () => {
		const { mcpTokens } = await import('../src/database/index.js');
		const a = await makeAccount();
		const t1 = await mcpTokens.issue({ accountId: a.id, name: 'one' });
		const t2 = await mcpTokens.issue({ accountId: a.id, name: 'two' });
		assert.notEqual(t1.plaintext, t2.plaintext);
		assert.notEqual(t1.id, t2.id);
	});
});

describe('mcpTokens.authenticate', () => {
	test('right plaintext returns the row', async () => {
		const { mcpTokens } = await import('../src/database/index.js');
		const a = await makeAccount();
		const issued = await mcpTokens.issue({ accountId: a.id, name: 'cli' });
		const row = await mcpTokens.authenticate(issued.plaintext);
		assert.ok(row);
		assert.equal(row.id, issued.id);
		assert.equal(row.account_id, a.id);
	});

	test('wrong plaintext returns null', async () => {
		const { mcpTokens } = await import('../src/database/index.js');
		const a = await makeAccount();
		await mcpTokens.issue({ accountId: a.id, name: 'cli' });
		const row = await mcpTokens.authenticate('ol_mcp_' + 'f'.repeat(64));
		assert.equal(row, null);
	});

	test('rejects strings without the ol_mcp_ prefix', async () => {
		const { mcpTokens } = await import('../src/database/index.js');
		const a = await makeAccount();
		const issued = await mcpTokens.issue({ accountId: a.id, name: 'cli' });

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
		const issued = await mcpTokens.issue({ accountId: a.id, name: 'cli' });
		const revoked = await mcpTokens.revoke(issued.id, a.id);
		assert.equal(revoked, true);
		assert.equal(await mcpTokens.authenticate(issued.plaintext), null);
	});

	test('expired token does not authenticate', async () => {
		const { mcpTokens } = await import('../src/database/index.js');
		const a = await makeAccount();

		const issued = await mcpTokens.issue({ accountId: a.id, name: 'cli', ttlMs: 5 });
		await new Promise((r) => setTimeout(r, 15));
		assert.equal(await mcpTokens.authenticate(issued.plaintext), null);
	});
});

describe('mcpTokens.revoke', () => {
	test('account-scoped revoke rejects another user\'s token', async () => {
		const { mcpTokens } = await import('../src/database/index.js');
		const alice = await makeAccount('alice@x.com');
		const bob = await makeAccount('bob@x.com');
		const tok = await mcpTokens.issue({ accountId: alice.id, name: 'alice-cli' });

		const ok = await mcpTokens.revoke(tok.id, bob.id);
		assert.equal(ok, false, 'cross-account revoke must not succeed');

		const row = await mcpTokens.authenticate(tok.plaintext);
		assert.ok(row);
	});

	test('revoke without accountId (admin path) succeeds', async () => {
		const { mcpTokens } = await import('../src/database/index.js');
		const a = await makeAccount();
		const tok = await mcpTokens.issue({ accountId: a.id, name: 'cli' });
		const ok = await mcpTokens.revoke(tok.id, null);
		assert.equal(ok, true);
	});

	test('double-revoke returns false the second time', async () => {
		const { mcpTokens } = await import('../src/database/index.js');
		const a = await makeAccount();
		const tok = await mcpTokens.issue({ accountId: a.id, name: 'cli' });
		assert.equal(await mcpTokens.revoke(tok.id, a.id), true);
		assert.equal(await mcpTokens.revoke(tok.id, a.id), false, 'idempotent — already revoked');
	});
});

describe('mcpTokens.listForAccount', () => {
	test('omits revoked tokens; includes expired-but-not-revoked with expired:true', async () => {
		const { mcpTokens } = await import('../src/database/index.js');
		const a = await makeAccount();
		const active = await mcpTokens.issue({ accountId: a.id, name: 'active' });
		const expired = await mcpTokens.issue({ accountId: a.id, name: 'expired', ttlMs: 5 });
		const revoked = await mcpTokens.issue({ accountId: a.id, name: 'revoked' });
		await mcpTokens.revoke(revoked.id, a.id);
		await new Promise((r) => setTimeout(r, 15));
		const list = await mcpTokens.listForAccount(a.id);
		const names = list.map((t) => t.name).sort();
		assert.deepEqual(names, ['active', 'expired'], 'revoked is filtered out');
		const expRow = list.find((t) => t.name === 'expired');
		assert.equal(expRow.expired, true);
		const actRow = list.find((t) => t.name === 'active');
		assert.equal(actRow.expired, false);

		for (const t of list) {
			assert.equal(t.token_hash, undefined, 'list never includes the hash');
			assert.equal(t.plaintext, undefined, 'list never includes plaintext');
		}
	});
});
