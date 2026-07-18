export async function up(db) {
	await db.schema
		.alterTable('audit_log')
		.addColumn('status', 'text', (col) => col.notNull().defaultTo('ok'))
		.execute();
	await db.schema.alterTable('audit_log').addColumn('error_code', 'text').execute();
	await db.schema.alterTable('audit_log').addColumn('request_id', 'text').execute();

	await db.schema.createIndex('audit_log_status_idx').on('audit_log').column('status').execute();
	await db.schema.createIndex('audit_log_request_idx').on('audit_log').column('request_id').execute();
}

export async function down(db) {
	await db.schema.dropIndex('audit_log_request_idx').execute();
	await db.schema.dropIndex('audit_log_status_idx').execute();
	await db.schema.alterTable('audit_log').dropColumn('request_id').execute();
	await db.schema.alterTable('audit_log').dropColumn('error_code').execute();
	await db.schema.alterTable('audit_log').dropColumn('status').execute();
}
