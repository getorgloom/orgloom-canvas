export async function up(db) {
	await db.schema
		.alterTable("connections")
		.addColumn("org_type", "text")
		.execute();
}

export async function down(db) {
	await db.schema.alterTable("connections").dropColumn("org_type").execute();
}
