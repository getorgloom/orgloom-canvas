// Repair: ensure audit_log.content_hash exists and is backfilled.
//
// Why this exists: migration 041 was revised IN PLACE during development;
// its first version added only `redacted_at`; the final version adds
// `content_hash` + `redacted_at` and rechains. Any database that applied
// the intermediate 041 has it recorded as complete in the migration
// ledger, so the revised 041 never re-runs, leaving `redacted_at` present
// but `content_hash` missing, and every audit INSERT failing with
// "table audit_log has no column named content_hash" (surfaced as a 500
// on, e.g., connection Remove).
//
// Lesson enforced by this file: never edit an applied migration; ship a
// follow-up. This one is idempotent so it is safe on every lineage:
//   * DB that ran the intermediate 041 → adds content_hash + backfills.
//   * DB that ran the final 041        → column exists, zero NULL rows,
//     both steps no-op.
import crypto from "node:crypto";
import { migrationColumnExists } from "../migration-introspection.js";

function _canonical(row) {
	return JSON.stringify([
		row.id,
		row.workspace_id || null,
		row.actor_account_id || null,
		row.actor_connection_id || null,
		row.actor_kind || "web",
		row.mcp_token_id || null,
		row.action,
		row.target_object || null,
		row.target_id || null,
		row.target_sf_org_id || null,
		row.payload_json || null,
		row.status || "ok",
		row.error_code || null,
		row.request_id || null,
		row.created_at,
	]);
}

function _contentHash(row) {
	return crypto.createHash("sha256").update(_canonical(row)).digest("hex");
}

function _chainHash(prev, contentHash) {
	const h = crypto.createHash("sha256");
	h.update(prev || "");
	h.update("|");
	h.update(contentHash);
	return h.digest("hex");
}

export async function up(db) {
	// Add the column if (and only if) it's missing. SQLite has no
	// ADD COLUMN IF NOT EXISTS. Introspection works on SQLite and PostgreSQL
	// without intentionally failing a statement inside the migration
	// transaction.
	if (await migrationColumnExists(db, "audit_log", "content_hash")) {
		return; // final-041 lineage, fully consistent already
	}
	await db.schema
		.alterTable("audit_log")
		.addColumn("content_hash", "text")
		.execute();

	// Backfill + rechain, same walk order and formulas as (final) 041.
	const rows = await db
		.selectFrom("audit_log")
		.selectAll()
		.orderBy("workspace_id", "asc")
		.orderBy("created_at", "asc")
		.orderBy("id", "asc")
		.execute();

	const prevByWs = new Map();
	for (const row of rows) {
		const key = row.workspace_id || "";
		const contentHash = _contentHash(row);
		const prev = prevByWs.get(key) || "";
		const chainHash = _chainHash(prev, contentHash);
		await db
			.updateTable("audit_log")
			.set({ content_hash: contentHash, chain_hash: chainHash })
			.where("id", "=", row.id)
			.execute();
		prevByWs.set(key, chainHash);
	}
}

export async function down() {
	// Repair migration: nothing to reverse. (Dropping content_hash here
	// would corrupt final-041 databases, where the column is 041's.)
}
