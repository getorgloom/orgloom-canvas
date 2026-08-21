import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { up } from '../src/database/migrations/044_workspace_bound_mcp_tokens.js';

test('workspace-binding migration invalidates credentials whose scope cannot be trusted', async () => {
	const sqlite = new Database(':memory:');
	const db = new Kysely({ dialect: new SqliteDialect({ database: sqlite }) });
	try {
		await db.schema
			.createTable('mcp_tokens')
			.addColumn('id', 'text', (column) => column.primaryKey())
			.addColumn('account_id', 'text', (column) => column.notNull())
			.addColumn('token_hash', 'text', (column) => column.notNull().unique())
			.addColumn('name', 'text', (column) => column.notNull())
			.addColumn('created_at', 'integer', (column) => column.notNull())
			.addColumn('last_used_at', 'integer')
			.addColumn('expires_at', 'integer')
			.addColumn('revoked_at', 'integer')
			.execute();
		await db
			.insertInto('mcp_tokens')
			.values({
				id: 'legacy',
				account_id: 'acct',
				token_hash: 'a'.repeat(64),
				name: 'ambiguous client',
				created_at: Date.now(),
			})
			.execute();

		await up(db);

		assert.equal((await db.selectFrom('mcp_tokens').selectAll().execute()).length, 0);
		const table = (await db.introspection.getTables()).find((candidate) => candidate.name === 'mcp_tokens');
		assert.ok(table.columns.some((column) => column.name === 'workspace_id'));
	} finally {
		await db.destroy();
	}
});
