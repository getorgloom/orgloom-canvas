export async function up(db) {
	await db.schema
		.alterTable("workspace_settings")
		.addColumn("strict_draft_mode", "integer", (col) =>
			col.notNull().defaultTo(0),
		)
		.execute();
}

export async function down(db) {
	await db.schema
		.alterTable("workspace_settings")
		.dropColumn("strict_draft_mode")
		.execute();
}
