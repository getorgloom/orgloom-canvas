// Consolidated schema baseline through former migration 060. Future migration
// filenames must start at 061 so existing UAT and production ledgers continue
// forward from this baseline without replaying historical schema changes.
async function createCoreSchema(db) {
	await db.schema
		.createTable('accounts')
		.addColumn('id', 'text', (col) => col.primaryKey())
		.addColumn('email', 'text', (col) => col.notNull())
		.addColumn('display_name', 'text')
		.addColumn('deleted_at', 'bigint')
		.addColumn('created_at', 'bigint', (col) => col.notNull())
		.addColumn('updated_at', 'bigint', (col) => col.notNull())
		.addColumn('is_super_admin', 'integer', (col) => col.notNull().defaultTo(0))
		.addColumn('promo_code', 'text')
		.addColumn('email_collision_key', 'text')
		.execute();
	await db.schema.createIndex('accounts_email_idx').on('accounts').column('email').execute();
	await db.schema.createIndex('accounts_promo_code_idx').on('accounts').column('promo_code').execute();
	await db.schema
		.createIndex('accounts_email_collision_key_unique')
		.on('accounts')
		.column('email_collision_key')
		.unique()
		.execute();

	await db.schema
		.createTable('connections')
		.addColumn('id', 'text', (col) => col.primaryKey())
		.addColumn('account_id', 'text', (col) => col.notNull().references('accounts.id').onDelete('cascade'))
		.addColumn('sf_user_id', 'text', (col) => col.notNull())
		.addColumn('sf_org_id', 'text', (col) => col.notNull())
		.addColumn('instance_url', 'text', (col) => col.notNull())
		.addColumn('display_username', 'text')
		.addColumn('display_name', 'text')
		.addColumn('email', 'text')
		.addColumn('last_used_at', 'bigint')
		.addColumn('disabled_at', 'bigint')
		.addColumn('created_at', 'bigint', (col) => col.notNull())
		.addColumn('updated_at', 'bigint', (col) => col.notNull())
		.addColumn('org_type', 'text')
		.execute();
	await db.schema.createIndex('connections_account_idx').on('connections').column('account_id').execute();
	await db.schema
		.createIndex('connections_account_sf_user_unique')
		.on('connections')
		.columns(['account_id', 'sf_user_id'])
		.unique()
		.execute();
	await db.schema.createIndex('connections_sf_org_idx').on('connections').column('sf_org_id').execute();

	await db.schema
		.createTable('mcp_tokens')
		.addColumn('id', 'text', (col) => col.primaryKey())
		.addColumn('account_id', 'text', (col) => col.notNull().references('accounts.id').onDelete('cascade'))
		.addColumn('token_hash', 'text', (col) => col.notNull().unique())
		.addColumn('name', 'text', (col) => col.notNull())
		.addColumn('created_at', 'bigint', (col) => col.notNull())
		.addColumn('last_used_at', 'bigint')
		.addColumn('expires_at', 'bigint')
		.addColumn('revoked_at', 'bigint')
		.addColumn('workspace_id', 'text')
		.execute();
	await db.schema.createIndex('mcp_tokens_account_idx').on('mcp_tokens').column('account_id').execute();
	await db.schema
		.createIndex('mcp_tokens_account_workspace_idx')
		.on('mcp_tokens')
		.columns(['account_id', 'workspace_id'])
		.execute();

	await db.schema
		.createTable('audit_log')
		.addColumn('id', 'text', (col) => col.primaryKey())
		.addColumn('workspace_id', 'text')
		.addColumn('actor_account_id', 'text', (col) => col.references('accounts.id'))
		.addColumn('actor_connection_id', 'text', (col) => col.references('connections.id').onDelete('set null'))
		.addColumn('action', 'text', (col) => col.notNull())
		.addColumn('target_sf_org_id', 'text')
		.addColumn('created_at', 'bigint', (col) => col.notNull())
		.addColumn('expires_at', 'bigint')
		.addColumn('actor_kind', 'text', (col) => col.notNull().defaultTo('web'))
		.addColumn('mcp_token_id', 'text', (col) => col.references('mcp_tokens.id').onDelete('set null'))
		.addColumn('status', 'text', (col) => col.notNull().defaultTo('ok'))
		.addColumn('error_code', 'text')
		.addColumn('request_id', 'text')
		.addColumn('chain_hash', 'text')
		.addColumn('content_hash', 'text')
		.addColumn('redacted_at', 'bigint')
		.execute();
	await db.schema
		.createIndex('audit_log_workspace_created_idx')
		.on('audit_log')
		.columns(['workspace_id', 'created_at'])
		.execute();
	await db.schema.createIndex('audit_log_expires_idx').on('audit_log').column('expires_at').execute();
	await db.schema.createIndex('audit_log_status_idx').on('audit_log').column('status').execute();
	await db.schema.createIndex('audit_log_request_idx').on('audit_log').column('request_id').execute();
	await db.schema.createIndex('audit_log_chain_hash_idx').on('audit_log').column('chain_hash').execute();
	await db.schema
		.createIndex('audit_log_chain_walk_idx')
		.on('audit_log')
		.columns(['workspace_id', 'created_at'])
		.execute();

	await db.schema
		.createTable('audit_chain_anchors')
		.addColumn('workspace_id', 'text', (col) => col.primaryKey())
		.addColumn('anchor_hash', 'text', (col) => col.notNull())
		.addColumn('purged_count', 'integer', (col) => col.notNull().defaultTo(0))
		.addColumn('updated_at', 'bigint', (col) => col.notNull())
		.execute();

	await db.schema
		.createTable('canvas_role_grants')
		.addColumn('sf_org_id', 'text', (col) => col.notNull())
		.addColumn('canvas_id', 'text', (col) => col.notNull())
		.addColumn('recipient_sf_user_id', 'text', (col) => col.notNull())
		.addColumn('role', 'text', (col) => col.notNull())
		.addColumn('granted_by_account_id', 'text')
		.addColumn('created_at', 'bigint', (col) => col.notNull())
		.addColumn('updated_at', 'bigint', (col) => col.notNull())
		.addPrimaryKeyConstraint('canvas_role_grants_pk', ['sf_org_id', 'canvas_id', 'recipient_sf_user_id'])
		.execute();
	await db.schema
		.createIndex('canvas_role_grants_canvas_idx')
		.on('canvas_role_grants')
		.columns(['sf_org_id', 'canvas_id'])
		.execute();

	for (const { table, artifactColumn } of [
		{ table: 'canvas_keys', artifactColumn: 'canvas_id' },
		{ table: 'batch_keys', artifactColumn: 'batch_id' },
	]) {
		await db.schema
			.createTable(table)
			.addColumn('sf_org_id', 'text', (col) => col.notNull())
			.addColumn(artifactColumn, 'text', (col) => col.notNull())
			.addColumn('wrapped_key', 'text', (col) => col.notNull())
			.addColumn('wrap_iv', 'text')
			.addColumn('wrap_auth_tag', 'text')
			.addColumn('master_key_version', 'integer', (col) => col.notNull().defaultTo(1))
			.addColumn('created_at', 'bigint', (col) => col.notNull())
			.addColumn('updated_at', 'bigint', (col) => col.notNull())
			.addPrimaryKeyConstraint(`${table}_pk`, ['sf_org_id', artifactColumn])
			.execute();
	}
}

async function createStandaloneViewState(db) {
	await db.schema
		.createTable('account_view_state')
		.addColumn('account_id', 'text', (col) => col.primaryKey().references('accounts.id').onDelete('cascade'))
		.addColumn('current_workspace_id', 'text')
		.addColumn('current_connection_id', 'text', (col) => col.references('connections.id').onDelete('set null'))
		.addColumn('updated_at', 'bigint', (col) => col.notNull())
		.execute();
}

export async function up(db) {
	await createCoreSchema(db);
	try {
		const overlay = await import('orgloom-saas/database/saas-overlay');
		await overlay.applySaasOverlay(db);
	} catch (error) {
		const message = String(error?.message || '');
		if (error?.code !== 'ERR_MODULE_NOT_FOUND' && !/cannot find/i.test(message)) {
			throw error;
		}
		await createStandaloneViewState(db);
		console.log('[migration 001_init] using the canvas-standalone schema');
	}
}

export async function down(db) {
	try {
		const overlay = await import('orgloom-saas/database/saas-overlay');
		await overlay.dropSaasOverlay(db);
	} catch (error) {
		const message = String(error?.message || '');
		if (error?.code !== 'ERR_MODULE_NOT_FOUND' && !/cannot find/i.test(message)) {
			throw error;
		}
	}
	await db.schema.dropTable('account_view_state').ifExists().execute();
	await db.schema.dropTable('batch_keys').ifExists().execute();
	await db.schema.dropTable('canvas_keys').ifExists().execute();
	await db.schema.dropTable('canvas_role_grants').ifExists().execute();
	await db.schema.dropTable('audit_chain_anchors').ifExists().execute();
	await db.schema.dropTable('audit_log').ifExists().execute();
	await db.schema.dropTable('mcp_tokens').ifExists().execute();
	await db.schema.dropTable('connections').ifExists().execute();
	await db.schema.dropTable('accounts').ifExists().execute();
}
