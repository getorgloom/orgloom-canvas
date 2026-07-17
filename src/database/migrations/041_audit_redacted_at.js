// Audit redaction support: GDPR erasure that keeps the tamper chain
// verifiable.
//
// Two columns are added:
//   * content_hash: an immutable per-row hash of the row's canonical
//     content, H(canonical(row)). The chain now links over content_hash
//     rather than over the raw content: chain_hash = H(prev_chain_hash +
//     content_hash). This split lets a REDACTED row (content erased) still
//     have its chain LINKAGE verified (the retained content_hash keeps
//     chain_hash reproducible) while only its CONTENT integrity (does the
//     stored content still hash to content_hash) becomes uncheckable,
//     which is inherent to having erased it.
//   * redacted_at: marks a row whose PII was erased in place. verifyChain
//     skips the content recompute for these rows but still checks the
//     chain linkage, so an insert/delete/reorder around a redacted row is
//     STILL detected (the structural guarantee survives erasure).
//
// Existing rows are rechained under the new content_hash formula. This is
// a one-time, in-migration recompute (not a tamper) so the chain stays
// internally consistent afterward.
import crypto from "node:crypto";

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
	await db.schema
		.alterTable("audit_log")
		.addColumn("content_hash", "text")
		.execute();
	await db.schema
		.alterTable("audit_log")
		.addColumn("redacted_at", "integer")
		.execute();

	// Backfill content_hash and rechain chain_hash over it. Walk in the
	// same (workspace, created_at, id) order verifyChain uses.
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

export async function down(db) {
	await db.schema.alterTable("audit_log").dropColumn("redacted_at").execute();
	await db.schema.alterTable("audit_log").dropColumn("content_hash").execute();
}
