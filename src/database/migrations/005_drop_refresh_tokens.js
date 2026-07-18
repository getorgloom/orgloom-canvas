export async function up(db) {
	await db.schema.alterTable('connections').dropColumn('refresh_token_encrypted').execute();
}

export async function down(db) {
	await db.schema.alterTable('connections').addColumn('refresh_token_encrypted', 'text').execute();
}
