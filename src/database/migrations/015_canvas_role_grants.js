export async function up(db) {
	await db.schema
		.createTable('canvas_role_grants')
		.addColumn('sf_org_id', 'text', (col) => col.notNull())
		.addColumn('canvas_id', 'text', (col) => col.notNull())
		.addColumn('recipient_sf_user_id', 'text', (col) => col.notNull())
		.addColumn('role', 'text', (col) => col.notNull())
		.addColumn('granted_by_account_id', 'text')
		.addColumn('created_at', 'integer', (col) => col.notNull())
		.addColumn('updated_at', 'integer', (col) => col.notNull())
		.addPrimaryKeyConstraint('canvas_role_grants_pk', ['sf_org_id', 'canvas_id', 'recipient_sf_user_id'])
		.execute();

	await db.schema
		.createIndex('canvas_role_grants_canvas_idx')
		.on('canvas_role_grants')
		.columns(['sf_org_id', 'canvas_id'])
		.execute();
}

export async function down(db) {
	await db.schema.dropTable('canvas_role_grants').ifExists().execute();
}
