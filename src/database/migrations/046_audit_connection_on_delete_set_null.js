import { sql } from "kysely";

// Activity History is intentionally retained when an account or Salesforce
// connection is erased. The original FK used PostgreSQL's default RESTRICT
// behavior, which prevented those connection rows from being deleted whenever
// they had attributed activity. Make the nullable relationship express the
// intended lifecycle: retain the event and clear its deleted credential link.
//
// Fresh SQLite databases already receive ON DELETE SET NULL from 001_init.
// SQLite cannot alter an FK constraint in place, so existing SQLite databases
// rely on the deletion orchestrator's explicit detach for compatibility.
export async function up(db) {
	const tables = await db.introspection.getTables();
	if (!tables.some((table) => typeof table.schema === "string")) {
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
	if (!tables.some((table) => typeof table.schema === "string")) {
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
