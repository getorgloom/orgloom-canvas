import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import * as migration from '../src/database/migrations/047_account_email_collision_key.js';

test('email collision migration recovers when SQLite already added the column', async () => {
	const sqlite = new Database(':memory:');
	const db = new Kysely({ dialect: new SqliteDialect({ database: sqlite }) });
	try {
		await db.schema
			.createTable('accounts')
			.addColumn('id', 'text', (col) => col.primaryKey())
			.addColumn('email', 'text', (col) => col.notNull())
			.addColumn('created_at', 'integer', (col) => col.notNull())
			.addColumn('deleted_at', 'integer')
			.addColumn('email_collision_key', 'text')
			.execute();
		await db
			.insertInto('accounts')
			.values({
				id: 'acc_partial',
				email: 'Owner+trial@Example.com',
				created_at: 1,
				deleted_at: null,
				email_collision_key: null,
			})
			.execute();
		await db
			.insertInto('accounts')
			.values({
				id: 'acc_historical_alias',
				email: 'owner+second@example.com',
				created_at: 2,
				deleted_at: null,
				email_collision_key: null,
			})
			.execute();

		await migration.up(db);
		await migration.up(db);

		const accounts = await db.selectFrom('accounts').selectAll().orderBy('created_at').execute();
		assert.equal(accounts[0].email_collision_key, 'owner@example.com');
		assert.equal(accounts[1].email_collision_key, null);
		const indexes = sqlite.prepare("PRAGMA index_list('accounts')").all();
		assert.equal(indexes.filter((index) => index.name === 'accounts_email_collision_key_unique').length, 1);
		assert.equal(indexes.find((index) => index.name === 'accounts_email_collision_key_unique').unique, 1);
	} finally {
		await db.destroy();
	}
});
