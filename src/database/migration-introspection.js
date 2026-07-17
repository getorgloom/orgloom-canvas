// Dialect-neutral schema checks for idempotent migrations. Querying Kysely's
// introspector avoids SQLite-only PRAGMA statements and, unlike catching a
// failed ALTER TABLE, does not leave a PostgreSQL migration transaction in an
// aborted state.

export async function migrationTable(db, tableName) {
	const tables = await db.introspection.getTables();
	return tables.find((table) => table.name === tableName) || null;
}

export async function migrationTableExists(db, tableName) {
	return (await migrationTable(db, tableName)) !== null;
}

export async function migrationColumnExists(db, tableName, columnName) {
	const table = await migrationTable(db, tableName);
	return !!table && table.columns.some((column) => column.name === columnName);
}
