export async function up(db) {
	await db.schema
		.alterTable("accounts")
		.addColumn("promo_code", "text")
		.execute();
	await db.schema
		.createIndex("accounts_promo_code_idx")
		.on("accounts")
		.column("promo_code")
		.execute();
}

export async function down(db) {
	await db.schema.dropIndex("accounts_promo_code_idx").execute();
	await db.schema.alterTable("accounts").dropColumn("promo_code").execute();
}
