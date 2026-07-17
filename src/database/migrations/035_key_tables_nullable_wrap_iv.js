import { sql } from "kysely";

// Make wrap_iv / wrap_auth_tag nullable on canvas_keys and batch_keys.
//
// Migrations 026/027 created both tables with wrap_iv + wrap_auth_tag
// NOT NULL: correct for the original local AES-GCM master-key wrap,
// which produced a real iv + auth tag per row. KEK Phase 5 switched the
// wrap to the SF-Apex KEK provider (makeSfApexKekProvider), whose
// wrapDataKey() returns { wrappedKey, iv: null, authTag: null, ... }:
// the Apex envelope is self-describing, so iv/authTag are deliberately
// unused (see canvas-encryption.js). Every FRESH key mint therefore
// tried to INSERT wrap_iv = null and hit "NOT NULL constraint failed".
//
// Impact this corrected: the recall/upload-batch ledger write threw on
// every upload (silently swallowed by the upload routes), so the ledger
// was never written, which in turn disabled the lost-response reconcile
// (reconcileLostUpload found no batch) and let a retry re-INSERT
// duplicates. New-canvas key mints failed the same way. Existing rows
// (minted pre-KEK) keep their non-null iv and are untouched.
//
// SQLite can't DROP NOT NULL in place, so each table is rebuilt
// (create *_new with the relaxed columns → copy rows → drop old →
// rename). The same create/copy/drop/rename sequence is valid on
// Postgres too, so this stays dialect-agnostic.

export async function up(db) {
	await rebuildNullable(db, "canvas_keys", "canvas_id", "canvas_keys_pk");
	await rebuildNullable(db, "batch_keys", "batch_id", "batch_keys_pk");
}

async function rebuildNullable(db, table, idColumn, pkName) {
	const tmp = table + "_new";
	await db.schema
		.createTable(tmp)
		.addColumn("sf_org_id", "text", (col) => col.notNull())
		.addColumn(idColumn, "text", (col) => col.notNull())
		.addColumn("wrapped_key", "text", (col) => col.notNull())
		// Relaxed: null for self-describing KEK-Apex envelopes.
		.addColumn("wrap_iv", "text")
		.addColumn("wrap_auth_tag", "text")
		.addColumn("master_key_version", "integer", (col) =>
			col.notNull().defaultTo(1),
		)
		.addColumn("created_at", "integer", (col) => col.notNull())
		.addColumn("updated_at", "integer", (col) => col.notNull())
		// Constraint name must not collide with the live table's while both
		// exist; it survives the rename, so suffix it.
		.addPrimaryKeyConstraint(pkName + "_v2", ["sf_org_id", idColumn])
		.execute();
	// Column order matches the original table, so SELECT * lines up.
	await sql`INSERT INTO ${sql.ref(tmp)} SELECT * FROM ${sql.ref(table)}`.execute(db);
	await db.schema.dropTable(table).execute();
	await db.schema.alterTable(tmp).renameTo(table).execute();
}

// Irreversible in the strict sense (re-adding NOT NULL would reject the
// legitimately-null KEK-Apex rows). Down rebuilds the NOT NULL shape only
// if every row still has non-null iv/auth_tag; otherwise it throws rather
// than silently dropping rows.
export async function down(db) {
	await rebuildNotNull(db, "canvas_keys", "canvas_id", "canvas_keys_pk");
	await rebuildNotNull(db, "batch_keys", "batch_id", "batch_keys_pk");
}

async function rebuildNotNull(db, table, idColumn, pkName) {
	const tmp = table + "_old";
	await db.schema
		.createTable(tmp)
		.addColumn("sf_org_id", "text", (col) => col.notNull())
		.addColumn(idColumn, "text", (col) => col.notNull())
		.addColumn("wrapped_key", "text", (col) => col.notNull())
		.addColumn("wrap_iv", "text", (col) => col.notNull())
		.addColumn("wrap_auth_tag", "text", (col) => col.notNull())
		.addColumn("master_key_version", "integer", (col) =>
			col.notNull().defaultTo(1),
		)
		.addColumn("created_at", "integer", (col) => col.notNull())
		.addColumn("updated_at", "integer", (col) => col.notNull())
		.addPrimaryKeyConstraint(pkName + "_rb", ["sf_org_id", idColumn])
		.execute();
	await sql`INSERT INTO ${sql.ref(tmp)} SELECT * FROM ${sql.ref(table)}`.execute(db);
	await db.schema.dropTable(table).execute();
	await db.schema.alterTable(tmp).renameTo(table).execute();
}
