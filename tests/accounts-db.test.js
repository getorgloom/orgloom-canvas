
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initTestDb, clearTestDb } from './helpers/db.js';

before(initTestDb);
beforeEach(clearTestDb);

describe('accountsDb.upsertByEmail', () => {
	test('creates a new account when email is unknown', async () => {
		const { accounts } = await import('../src/database/index.js');
		const { account, created } = await accounts.upsertByEmail({
			email: 'Alice@Example.com',
			displayName: 'Alice',
		});
		assert.equal(created, true);
		assert.equal(account.email, 'alice@example.com', 'email is normalized to lowercase');
		assert.equal(account.display_name, 'Alice');
		assert.equal(account.deleted_at, null);
		assert.ok(account.id.startsWith('acc_'));
	});

	test('returns existing account for repeat email (case-insensitive)', async () => {
		const { accounts } = await import('../src/database/index.js');
		const first = await accounts.upsertByEmail({ email: 'bob@x.com', displayName: 'Bob' });
		const second = await accounts.upsertByEmail({ email: 'BOB@X.COM', displayName: 'Bobby' });
		assert.equal(second.created, false);
		assert.equal(second.account.id, first.account.id);
	});

	test('updates a missing display_name on existing account', async () => {
		const { accounts } = await import('../src/database/index.js');
		await accounts.upsertByEmail({ email: 'cara@x.com', displayName: null });
		const { account } = await accounts.upsertByEmail({ email: 'cara@x.com', displayName: 'Cara' });
		assert.equal(account.display_name, 'Cara');
	});
});

describe('accountsDb.findByEmail', () => {
	test('case-insensitive lookup', async () => {
		const { accounts } = await import('../src/database/index.js');
		await accounts.upsertByEmail({ email: 'dan@x.com' });
		const found = await accounts.findByEmail('DAN@X.COM');
		assert.ok(found);
		assert.equal(found.email, 'dan@x.com');
	});

	test('returns undefined for unknown email', async () => {
		const { accounts } = await import('../src/database/index.js');
		const result = await accounts.findByEmail('ghost@nowhere');
		assert.equal(result, undefined);
	});
});

describe('accountsDb.updateEmail', () => {
	test('rejects collision with another account', async () => {
		const { accounts } = await import('../src/database/index.js');
		await accounts.upsertByEmail({ email: 'emma@x.com' });
		const { account: frank } = await accounts.upsertByEmail({ email: 'frank@x.com' });
		await assert.rejects(
			() => accounts.updateEmail(frank.id, 'emma@x.com'),
			(err) => err.code === 'email_in_use',
		);
	});

	test('updates email when free, normalizing case', async () => {
		const { accounts } = await import('../src/database/index.js');
		const { account } = await accounts.upsertByEmail({ email: 'gail@x.com' });
		const updated = await accounts.updateEmail(account.id, 'GAIL.NEW@X.COM');
		assert.equal(updated.email, 'gail.new@x.com');
	});
});

describe('accountsDb.softDelete / restore', () => {
	test('softDelete stamps deleted_at; restore clears it', async () => {
		const { accounts } = await import('../src/database/index.js');
		const { account } = await accounts.upsertByEmail({ email: 'h@x.com' });
		const deleted = await accounts.softDelete(account.id);
		assert.ok(deleted.deleted_at, 'deleted_at is set');
		const restored = await accounts.restore(account.id);
		assert.equal(restored.deleted_at, null);
	});
});

describe('accountsDb.listForAdminView', () => {
	test('includeDeleted: false (default) excludes soft-deleted rows', async () => {
		const { accounts } = await import('../src/database/index.js');
		const a1 = (await accounts.upsertByEmail({ email: 'live@x.com' })).account;
		const a2 = (await accounts.upsertByEmail({ email: 'dead@x.com' })).account;
		await accounts.softDelete(a2.id);
		const list = await accounts.listForAdminView();
		const ids = list.map((r) => r.id);
		assert.ok(ids.includes(a1.id));
		assert.ok(!ids.includes(a2.id));
	});

	test('includeDeleted: true returns soft-deleted rows', async () => {
		const { accounts } = await import('../src/database/index.js');
		const a1 = (await accounts.upsertByEmail({ email: 'live@x.com' })).account;
		const a2 = (await accounts.upsertByEmail({ email: 'dead@x.com' })).account;
		await accounts.softDelete(a2.id);
		const list = await accounts.listForAdminView({ includeDeleted: true });
		const ids = list.map((r) => r.id);
		assert.ok(ids.includes(a1.id));
		assert.ok(ids.includes(a2.id));
	});
});
