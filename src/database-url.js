// Database URL helpers shared by the hosted and standalone bootstraps.
// Keep parsing here so a production fix cannot drift between the two entry
// points.

export function isPostgresDatabaseUrl(url) {
	return /^postgres(?:ql)?:\/\//.test(String(url || ''));
}

export function sqlitePathFromDatabaseUrl(url) {
	const value = String(url || '');
	if (!value.startsWith('sqlite:')) {
		return value;
	}

	const remainder = value.slice('sqlite:'.length);
	// Accept both sqlite:/absolute/path and sqlite:///absolute/path. For the
	// three-slash form, discard the two URL separator slashes and retain the
	// third slash as the filesystem root. Two-slash relative forms retain the
	// historical behavior (sqlite://./data.db -> ./data.db).
	if (remainder.startsWith('///')) {
		return remainder.slice(2);
	}
	if (remainder.startsWith('//')) {
		return remainder.slice(2);
	}
	return remainder;
}

export function databaseDialectLabel(url) {
	return isPostgresDatabaseUrl(url) ? 'postgres' : 'sqlite';
}
