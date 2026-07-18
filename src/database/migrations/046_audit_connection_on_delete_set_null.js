import { sql } from 'kysely';

export async function up(db) {
	const tables = await db.introspection.getTables();
	if (!tables.some((table) => typeof table.schema === 'string')) {
		return;
	}

	await sql`
		ALTER TABLE audit_log
		DROP CONSTRAINT IF EXISTS audit_log_actor_connection_id_fkey
	`.execute(db);
	await sql`
		ALTER TABLE audit_log
		ADD CONSTRAINT audit_log_actor_connection_id_fkey
		FOREIGN KEY (actor_connection_id)
		REFERENCES connections(id)
		ON DELETE SET NULL
	`.execute(db);
}

export async function down(db) {
	const tables = await db.introspection.getTables();
	if (!tables.some((table) => typeof table.schema === 'string')) {
		return;
	}

	await sql`
		ALTER TABLE audit_log
		DROP CONSTRAINT IF EXISTS audit_log_actor_connection_id_fkey
	`.execute(db);
	await sql`
		ALTER TABLE audit_log
		ADD CONSTRAINT audit_log_actor_connection_id_fkey
		FOREIGN KEY (actor_connection_id)
		REFERENCES connections(id)
	`.execute(db);
}
