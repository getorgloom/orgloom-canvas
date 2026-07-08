export async function up(db) {
	await db.schema
		.createTable("batch_keys")
		.addColumn("sf_org_id", "text", (col) => col.notNull())
		.addColumn("batch_id", "text", (col) => col.notNull())
		.addColumn("wrapped_key", "text", (col) => col.notNull())
		.addColumn("wrap_iv", "text", (col) => col.notNull())
		.addColumn("wrap_auth_tag", "text", (col) => col.notNull())
		.addColumn("master_key_version", "integer", (col) =>
			col.notNull().defaultTo(1),
		)
		.addColumn("created_at", "integer", (col) => col.notNull())
		.addColumn("updated_at", "integer", (col) => col.notNull())
		.addPrimaryKeyConstraint("batch_keys_pk", ["sf_org_id", "batch_id"])
		.execute();
}

export async function down(db) {
	await db.schema.dropTable("batch_keys").ifExists().execute();
}
