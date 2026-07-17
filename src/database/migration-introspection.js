
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
