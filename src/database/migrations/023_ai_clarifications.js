import { migrationTableExists } from '../migration-introspection.js';

export async function up(db) {
	if (!(await migrationTableExists(db, 'workspaces'))) {
		return;
	}
	await db.schema
		.createTable('ai_clarifications')
		.addColumn('id', 'text', (col) => col.primaryKey())
		.addColumn('canvas_id', 'text', (col) => col.notNull())
		.addColumn('workspace_id', 'text', (col) => col.notNull().references('workspaces.id').onDelete('cascade'))
		.addColumn('requesting_account_id', 'text', (col) =>
			col.notNull().references('accounts.id').onDelete('cascade'),
		)
		.addColumn('requesting_token_id', 'text', (col) => col.references('mcp_tokens.id').onDelete('set null'))
		.addColumn('status', 'text', (col) => col.notNull().defaultTo('pending'))
		.addColumn('question', 'text', (col) => col.notNull())
		.addColumn('options_json', 'text')
		.addColumn('response_text', 'text')
		.addColumn('response_option', 'text')
		.addColumn('created_at', 'integer', (col) => col.notNull())
		.addColumn('responded_at', 'integer')
		.addColumn('responded_by_account_id', 'text', (col) => col.references('accounts.id').onDelete('set null'))
		.addColumn('expires_at', 'integer', (col) => col.notNull())
		.execute();
	await db.schema
		.createIndex('ai_clarifications_canvas_status_idx')
		.on('ai_clarifications')
		.columns(['canvas_id', 'status'])
		.execute();
	await db.schema
		.createIndex('ai_clarifications_workspace_created_idx')
		.on('ai_clarifications')
		.columns(['workspace_id', 'created_at'])
		.execute();
}

export async function down(db) {
	await db.schema.dropTable('ai_clarifications').ifExists().execute();
}
