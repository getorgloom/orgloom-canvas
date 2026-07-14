import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
	databaseDialectLabel,
	isPostgresDatabaseUrl,
	sqlitePathFromDatabaseUrl,
} from '../src/database-url.js';

describe('database URL parsing', () => {
	test('recognizes both PostgreSQL URL schemes without exposing credentials', () => {
		assert.equal(isPostgresDatabaseUrl('postgres://user:secret@db/orgloom'), true);
		assert.equal(isPostgresDatabaseUrl('postgresql://user:secret@db/orgloom'), true);
		assert.equal(databaseDialectLabel('postgres://user:secret@db/orgloom'), 'postgres');
	});

	test('preserves absolute SQLite paths in one- and three-slash forms', () => {
		assert.equal(sqlitePathFromDatabaseUrl('sqlite:/data/seedsmith.db'), '/data/seedsmith.db');
		assert.equal(sqlitePathFromDatabaseUrl('sqlite:///data/seedsmith.db'), '/data/seedsmith.db');
	});

	test('preserves supported relative and Windows SQLite paths', () => {
		assert.equal(sqlitePathFromDatabaseUrl('sqlite:./data/orgloom.db'), './data/orgloom.db');
		assert.equal(sqlitePathFromDatabaseUrl('sqlite://./data/orgloom.db'), './data/orgloom.db');
		assert.equal(sqlitePathFromDatabaseUrl('sqlite:C:\\data\\orgloom.db'), 'C:\\data\\orgloom.db');
		assert.equal(databaseDialectLabel('sqlite:./data/orgloom.db'), 'sqlite');
	});
});
