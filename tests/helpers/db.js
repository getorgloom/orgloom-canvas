// Shared DB setup for canvas unit tests. The Kysely init layer moved to
// the saas package in the Pass 1 open-core re-split, so canvas tests
// can't call initDb() from the canvas package anymore: that function
// no longer exists here. The helper below constructs its own Kysely
// instance against a temp SQLite file, runs the canvas migrations
// against it, and registers it via ext.registerDbProvider() so canvas
// store modules (which call ext.getDb()) resolve to this test DB.
//
// Usage in a test file:
//   import { initTestDb, clearTestDb } from './helpers/db.js';
//   before(initTestDb);
//   beforeEach(clearTestDb);

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
	// Unique temp file per process so concurrent test runs don't collide.
	const tmpFile = path.join(
		os.tmpdir(),
		`orgloom-canvas-test-${process.pid}-${Date.now()}.db`,
	);
	process.env.DATABASE_URL = `sqlite:${tmpFile}`;
	// Provide a stable encryption key so canvas's crypto.js helper has
	// something usable during tests. 32 bytes hex = 64 chars. NOT a real
	// secret: it's a publicly-visible test fixture committed to git on
	// purpose. The `gitleaks:allow` comment keeps the secret-scanner
	// from flagging it.
	if (!process.env.ENCRYPTION_KEY) {
		process.env.ENCRYPTION_KEY = '0123456789abcdef'.repeat(4); // gitleaks:allow
	}
	const Database = (await import('better-sqlite3')).default;
	const sqlite = new Database(tmpFile);
	sqlite.pragma('journal_mode = WAL');
	sqlite.pragma('foreign_keys = ON');
	_rawClient = sqlite;
	_db = new Kysely({ dialect: new SqliteDialect({ database: sqlite }) });
	// Run canvas migrations. Tests only need canvas's schema; they don't
	// register saas migration dirs. Custom provider mirrors the saas init
	// layer's Windows-friendly file:// URL conversion.
	const migrator = new Migrator({
		db: _db,
		provider: {
			async getMigrations() {
				const migrations = {};
				const files = (await fs.promises.readdir(canvasMigrationsDir))
					.filter((f) => f.endsWith('.js'))
					.sort();
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
	// Cleanup the file when the process exits, otherwise the temp dir
	// fills up over many test runs.
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

// Truncate all data tables. Order matters: child rows before parents
// so FK constraints don't fire. Migration tracking table is left alone.
// The list covers every table canvas migrations create, including the
// workspace_* family used by saas: canvas-standalone has the schema
// even when those tables stay empty in practice, and the saas tests
// import this helper too in the cross-package monorepo test runs.
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
	// ai_proposals + ai_clarifications were dropped in migration 024
	// (in-memory now); intentionally omitted so clearTestDb doesn't
	// reference a non-existent table.
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
	for (const t of TABLES_IN_DELETE_ORDER) {
		await db.deleteFrom(t).execute();
	}
}
