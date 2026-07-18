export async function up(db) {
	await db.schema
		.createTable('audit_chain_anchors')
		.addColumn('workspace_id', 'text', (col) => col.primaryKey())
		.addColumn('anchor_hash', 'text', (col) => col.notNull())
		.addColumn('purged_count', 'integer', (col) => col.notNull().defaultTo(0))
		.addColumn('updated_at', 'integer', (col) => col.notNull())
		.execute();

	await db.schema.createIndex('audit_log_chain_hash_idx').on('audit_log').column('chain_hash').execute();
}

export async function down(db) {
	await db.schema.dropIndex('audit_log_chain_hash_idx').execute();
	await db.schema.dropTable('audit_chain_anchors').execute();
}
