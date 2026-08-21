import { migrationTableExists } from '../migration-introspection.js';

export async function up(db) {
	if (!(await migrationTableExists(db, 'workspace_settings'))) {
		return;
	}
	await db.schema.alterTable('workspace_settings').dropColumn('strict_draft_mode').execute();
}

export async function down(db) {
	if (!(await migrationTableExists(db, 'workspace_settings'))) {
		return;
	}
	await db.schema
		.alterTable('workspace_settings')
		.addColumn('strict_draft_mode', 'integer', (col) => col.notNull().defaultTo(0))
		.execute();
}
