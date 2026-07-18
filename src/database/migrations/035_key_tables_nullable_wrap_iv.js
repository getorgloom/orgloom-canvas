import { sql } from 'kysely';

export async function up(db) {
	await rebuildNullable(db, 'canvas_keys', 'canvas_id', 'canvas_keys_pk');
	await rebuildNullable(db, 'batch_keys', 'batch_id', 'batch_keys_pk');
}

async function rebuildNullable(db, table, idColumn, pkName) {
	const tmp = table + '_new';
	await db.schema
		.createTable(tmp)
		.addColumn('sf_org_id', 'text', (col) => col.notNull())
		.addColumn(idColumn, 'text', (col) => col.notNull())
		.addColumn('wrapped_key', 'text', (col) => col.notNull())
		.addColumn('wrap_iv', 'text')
		.addColumn('wrap_auth_tag', 'text')
		.addColumn('master_key_version', 'integer', (col) => col.notNull().defaultTo(1))
		.addColumn('created_at', 'integer', (col) => col.notNull())
		.addColumn('updated_at', 'integer', (col) => col.notNull())
		.addPrimaryKeyConstraint(pkName + '_v2', ['sf_org_id', idColumn])
		.execute();
	await sql`INSERT INTO ${sql.ref(tmp)} SELECT * FROM ${sql.ref(table)}`.execute(db);
	await db.schema.dropTable(table).execute();
	await db.schema.alterTable(tmp).renameTo(table).execute();
}

export async function down(db) {
	await rebuildNotNull(db, 'canvas_keys', 'canvas_id', 'canvas_keys_pk');
	await rebuildNotNull(db, 'batch_keys', 'batch_id', 'batch_keys_pk');
}

async function rebuildNotNull(db, table, idColumn, pkName) {
	const tmp = table + '_old';
	await db.schema
		.createTable(tmp)
		.addColumn('sf_org_id', 'text', (col) => col.notNull())
		.addColumn(idColumn, 'text', (col) => col.notNull())
		.addColumn('wrapped_key', 'text', (col) => col.notNull())
		.addColumn('wrap_iv', 'text', (col) => col.notNull())
		.addColumn('wrap_auth_tag', 'text', (col) => col.notNull())
		.addColumn('master_key_version', 'integer', (col) => col.notNull().defaultTo(1))
		.addColumn('created_at', 'integer', (col) => col.notNull())
		.addColumn('updated_at', 'integer', (col) => col.notNull())
		.addPrimaryKeyConstraint(pkName + '_rb', ['sf_org_id', idColumn])
		.execute();
	await sql`INSERT INTO ${sql.ref(tmp)} SELECT * FROM ${sql.ref(table)}`.execute(db);
	await db.schema.dropTable(table).execute();
	await db.schema.alterTable(tmp).renameTo(table).execute();
}
