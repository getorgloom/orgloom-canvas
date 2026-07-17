// Audit chain anchors: support retention purges that don't break the
// tamper-evident hash chain.
//
// The audit log is hash-chained (migration 008): each row's chain_hash
// depends on the previous row's. Deleting a chained row mid-stream would
// make verifyChain() report a false tamper break. But retention REQUIRES
// deleting old rows. Two mechanisms resolve the tension:
//
//   1. Data-touching buffer rows (uploads, refreshes, canvas CRUD) are
//      written UNCHAINED (chain_hash IS NULL); their long-term store is
//      the customer's orgloom__Audit_Event__c. Deleting them can't break
//      the chain because they were never in it.
//
//   2. Chained workspace-meta rows are purged oldest-first (a contiguous
//      prefix per workspace). Before deleting a prefix, we record an
//      ANCHOR: the chain_hash of the newest row in the deleted prefix,
//      plus how many rows were dropped. verifyChain() seeds its walk from
//      the anchor instead of the empty string, so the surviving suffix
//      still verifies. One anchor row per workspace; updated in place as
//      later prefixes are purged.
export async function up(db) {
	await db.schema
		.createTable("audit_chain_anchors")
		.addColumn("workspace_id", "text", (col) => col.primaryKey())
		.addColumn("anchor_hash", "text", (col) => col.notNull())
		.addColumn("purged_count", "integer", (col) => col.notNull().defaultTo(0))
		.addColumn("updated_at", "integer", (col) => col.notNull())
		.execute();

	// Index the chain_hash so the unchained-vs-chained split (chain_hash
	// IS NULL) that purge + verify + the prev-hash lookup all rely on
	// stays cheap as the log grows.
	await db.schema
		.createIndex("audit_log_chain_hash_idx")
		.on("audit_log")
		.column("chain_hash")
		.execute();
}

export async function down(db) {
	await db.schema.dropIndex("audit_log_chain_hash_idx").execute();
	await db.schema.dropTable("audit_chain_anchors").execute();
}
