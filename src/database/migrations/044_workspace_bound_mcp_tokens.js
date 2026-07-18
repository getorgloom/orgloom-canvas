export async function up(db) {
	await db.schema.alterTable('mcp_tokens').addColumn('workspace_id', 'text').execute();

	await db.deleteFrom('mcp_tokens').execute();

	await db.schema
		.createIndex('mcp_tokens_account_workspace_idx')
		.on('mcp_tokens')
		.columns(['account_id', 'workspace_id'])
		.execute();
}

export async function down(db) {
	await db.schema.dropIndex('mcp_tokens_account_workspace_idx').execute();
	await db.schema.alterTable('mcp_tokens').dropColumn('workspace_id').execute();
}
