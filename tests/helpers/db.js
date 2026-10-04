import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { Kysely, SqliteDialect, Migrator } from 'kysely';
import { ext } from '../../src/extensions.js';
import { canvasMigrationsDir } from '../../src/database/index.js';

let _ready = false;
let _db = null;
let _rawClient = null;

export async function initTestDb() {
	if (_ready) {
		return;
	}
	const tmpFile = path.join(os.tmpdir(), `orgloom-canvas-test-${process.pid}-${Date.now()}.db`);
	process.env.DATABASE_URL = `sqlite:${tmpFile}`;
	if (!process.env.ENCRYPTION_KEY) {
		process.env.ENCRYPTION_KEY = '0123456789abcdef'.repeat(4); // gitleaks:allow
	}
	const Database = (await import('better-sqlite3')).default;
	const sqlite = new Database(tmpFile);
	sqlite.pragma('journal_mode = WAL');
	sqlite.pragma('foreign_keys = ON');
	_rawClient = sqlite;
	_db = new Kysely({ dialect: new SqliteDialect({ database: sqlite }) });
	const migrator = new Migrator({
		db: _db,
		provider: {
			async getMigrations() {
				const migrations = {};
				const files = (await fs.promises.readdir(canvasMigrationsDir)).filter((f) => f.endsWith('.js')).sort();
				for (const file of files) {
					const name = file.replace(/\.js$/, '');
					const url = pathToFileURL(path.join(canvasMigrationsDir, file)).href;
					migrations[name] = await import(url);
				}
				return migrations;
			},
		},
	});
	const { error } = await migrator.migrateToLatest();
	if (error) {
		throw error;
	}
	ext.registerDbProvider(() => _db);
	ext.registerRawClientProvider(() => ({ dialect: 'sqlite', client: _rawClient }));
	_ready = true;
	process.on('exit', () => {
		try {
			fs.unlinkSync(tmpFile);
		} catch (_) {}
		try {
			fs.unlinkSync(tmpFile + '-shm');
		} catch (_) {}
		try {
			fs.unlinkSync(tmpFile + '-wal');
		} catch (_) {}
	});
}

const TABLES_IN_DELETE_ORDER = [
	'workspace_pending_joins',
	'magic_link_tokens',
	'account_oauth_links',
	'usage_counters',
	'audit_log',
	'audit_chain_anchors',
	'member_capabilities',
	'workspace_credits',
	'subscriptions',
	'account_view_state',
	'mcp_tokens',
	'canvas_keys',
	'batch_keys',
	'connections',
	'workspace_invites',
	'workspace_settings',
	'workspace_members',
	'workspaces',
	'accounts',
];

export async function clearTestDb() {
	const db = ext.getDb();
	const existingTables = new Set((await db.introspection.getTables()).map((table) => table.name));
	for (const t of TABLES_IN_DELETE_ORDER) {
		if (!existingTables.has(t)) {
			continue;
		}
		await db.deleteFrom(t).execute();
	}
}

export async function hasTestTable(tableName) {
	return (await _db.introspection.getTables()).some((table) => table.name === tableName);
}
