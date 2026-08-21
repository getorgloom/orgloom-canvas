import { migrationTableExists } from '../migration-introspection.js';

export async function up(db) {
	if (!(await migrationTableExists(db, 'workspace_settings'))) {
		return;
	}
	await db.schema
		.alterTable('workspace_settings')
		.addColumn('prod_org_allowlist_enabled', 'integer', (col) => col.notNull().defaultTo(0))
		.execute();

	await db
		.updateTable('workspace_settings')
		.set({ prod_org_allowlist_enabled: 1 })
		.where('prod_orgs_unrestricted', '=', 0)
		.execute();
	await db.schema.alterTable('workspace_settings').dropColumn('prod_orgs_unrestricted').execute();
}

export async function down(db) {
	if (!(await migrationTableExists(db, 'workspace_settings'))) {
		return;
	}
	await db.schema
		.alterTable('workspace_settings')
		.addColumn('prod_orgs_unrestricted', 'integer', (col) => col.notNull().defaultTo(1))
		.execute();

	await db
		.updateTable('workspace_settings')
		.set({ prod_orgs_unrestricted: 0 })
		.where('prod_org_allowlist_enabled', '=', 1)
		.execute();
	await db.schema.alterTable('workspace_settings').dropColumn('prod_org_allowlist_enabled').execute();
}
