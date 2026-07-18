import { migrationTableExists } from "../migration-introspection.js";

export async function up(db) {
	if (!(await migrationTableExists(db, "workspace_settings"))) {
		return;
	}
	await db.schema
		.alterTable("workspace_settings")
		.addColumn("nonprod_org_allowlist_enabled", "integer", (col) =>
			col.notNull().defaultTo(0),
		)
		.execute();
}

export async function down(db) {
	if (!(await migrationTableExists(db, "workspace_settings"))) {
		return;
	}
	await db.schema
		.alterTable("workspace_settings")
		.dropColumn("nonprod_org_allowlist_enabled")
		.execute();
}
