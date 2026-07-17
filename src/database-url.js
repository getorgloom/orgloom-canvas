
export function isPostgresDatabaseUrl(url) {
	return /^postgres(?:ql)?:\/\//.test(String(url || ''));
}

export function sqlitePathFromDatabaseUrl(url) {
	const value = String(url || '');
	if (!value.startsWith('sqlite:')) {
		return value;
	}

	const remainder = value.slice('sqlite:'.length);
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
