import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Kysely, Migrator, PostgresDialect, SqliteDialect } from 'kysely';
import { ext } from './extensions.js';
import { canvasMigrationsDir } from './database/index.js';
import { isPostgresDatabaseUrl, sqlitePathFromDatabaseUrl } from './database-url.js';

export async function initializeStandaloneDatabase() {
	const url = process.env.DATABASE_URL || 'sqlite:./data/orgloom.db';
	let db;
	let raw;
	let dialect;
	if (isPostgresDatabaseUrl(url)) {
		const pg = await import('pg');
		const { Pool } = pg.default || pg;
		raw = new Pool({ connectionString: url, max: 10 });
		dialect = 'pg';
		db = new Kysely({ dialect: new PostgresDialect({ pool: raw }) });
	} else {
		const sqlitePath = sqlitePathFromDatabaseUrl(url);
		fs.mkdirSync(path.dirname(path.resolve(sqlitePath)), { recursive: true });
		const Database = (await import('better-sqlite3')).default;
		raw = new Database(sqlitePath);
		raw.pragma('journal_mode = WAL');
		raw.pragma('foreign_keys = ON');
		dialect = 'sqlite';
		db = new Kysely({ dialect: new SqliteDialect({ database: raw }) });
	}

	ext.registerDbProvider(() => db);
	ext.registerRawClientProvider(() => ({ dialect, client: raw }));
	const migrator = new Migrator({
		db,
		provider: {
			async getMigrations() {
				const migrations = {};
				const files = (await fs.promises.readdir(canvasMigrationsDir))
					.filter((file) => file.endsWith('.js')).sort();
				for (const file of files) {
					migrations[file.replace(/\.js$/, '')] = await import(pathToFileURL(path.join(canvasMigrationsDir, file)).href);
				}
				return migrations;
			},
		},
	});
	const { error } = await migrator.migrateToLatest();
	if (error) {
throw error;
}
	return db;
}
