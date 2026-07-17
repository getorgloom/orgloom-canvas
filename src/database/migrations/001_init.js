// Baseline schema. Canvas-only surface: accounts (identity), connections
// (SF OAuth), audit_log (per-account append-only event trail).
//
// SaaS-tier tables (workspaces, billing, multi-user chrome, oauth links,
// magic links, view-state) live in apps/saas/src/database/saas-overlay.js
// and are applied here via a dynamic import when the orgloom-saas
// package is installed. Canvas-standalone deployments don't have the
// saas package, so the import fails with ERR_MODULE_NOT_FOUND and the
// overlay is skipped cleanly, leaving a minimal canvas-only schema.
//
// Notes on cross-mode portability:
//   - audit_log.workspace_id is a plain text column (no FK to
//     workspaces.id) so canvas-standalone can create the table without
//     workspaces existing. SaaS uses the column with application-level
//     consistency rather than DB-enforced FK; orphan rows after a
//     workspace delete are tolerable.
//   - The existing saas prod database has all the SaaS overlay tables
//     from the pre-split 001_init. After this refactor, 001_init is
//     already in that DB's migrations tracker; it does not re-run, so
//     no schema changes apply to existing prod. The migration's source
//     change is purely about what fresh installs (and the canvas
//     package's auditable surface) look like.

export async function up(db) {
	// accounts ------------------------------------------------------------
	// One row per signed-up human. Identity + soft-delete only: no
	// billing state, no view state, no access-control flags. SaaS-tier
	// extensions (e.g. is_super_admin) attach via ALTER TABLE in the
	// saas migrations dir, so the OSS surface stays minimal.
	await db.schema
		.createTable("accounts")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("email", "text", (col) => col.notNull())
		.addColumn("display_name", "text")
		.addColumn("deleted_at", "integer")
		.addColumn("created_at", "integer", (col) => col.notNull())
		.addColumn("updated_at", "integer", (col) => col.notNull())
		.execute();
	await db.schema
		.createIndex("accounts_email_idx")
		.on("accounts")
		.column("email")
		.execute();

	// connections ---------------------------------------------------------
	await db.schema
		.createTable("connections")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("account_id", "text", (col) =>
			col.notNull().references("accounts.id").onDelete("cascade"),
		)
		.addColumn("sf_user_id", "text", (col) => col.notNull())
		.addColumn("sf_org_id", "text", (col) => col.notNull())
		.addColumn("instance_url", "text", (col) => col.notNull())
		.addColumn("refresh_token_encrypted", "text")
		.addColumn("display_username", "text")
		.addColumn("display_name", "text")
		.addColumn("email", "text")
		.addColumn("last_used_at", "integer")
		.addColumn("disabled_at", "integer")
		.addColumn("created_at", "integer", (col) => col.notNull())
		.addColumn("updated_at", "integer", (col) => col.notNull())
		.execute();
	await db.schema
		.createIndex("connections_account_idx")
		.on("connections")
		.column("account_id")
		.execute();
	await db.schema
		.createIndex("connections_account_sf_user_unique")
		.on("connections")
		.columns(["account_id", "sf_user_id"])
		.unique()
		.execute();
	await db.schema
		.createIndex("connections_sf_org_idx")
		.on("connections")
		.column("sf_org_id")
		.execute();

	// audit_log -----------------------------------------------------------
	// workspace_id is plain text with no FK (see header note). Application
	// code (audit.js) uses it as a scope key with NULL-tolerant lookups
	// for canvas-standalone where there's no workspace concept.
	await db.schema
		.createTable("audit_log")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("workspace_id", "text")
		.addColumn("actor_account_id", "text", (col) =>
			col.references("accounts.id"),
		)
		.addColumn("actor_connection_id", "text", (col) =>
			// Activity History outlives a disconnected or erased Salesforce
			// credential. Keep the event and clear only the credential anchor.
			col.references("connections.id").onDelete("set null"),
		)
		.addColumn("action", "text", (col) => col.notNull())
		.addColumn("target_object", "text")
		.addColumn("target_id", "text")
		.addColumn("target_sf_org_id", "text")
		.addColumn("payload_json", "text")
		.addColumn("created_at", "integer", (col) => col.notNull())
		.addColumn("expires_at", "integer")
		.execute();
	await db.schema
		.createIndex("audit_log_workspace_created_idx")
		.on("audit_log")
		.columns(["workspace_id", "created_at"])
		.execute();
	await db.schema
		.createIndex("audit_log_expires_idx")
		.on("audit_log")
		.column("expires_at")
		.execute();

	// SaaS overlay --------------------------------------------------------
	// Workspaces, billing, multi-user chrome, oauth links, magic links,
	// view-state. Lives in the closed saas package. Canvas-standalone
	// deployments don't install orgloom-saas, so the import throws
	// ERR_MODULE_NOT_FOUND and we fall through with a minimal schema.
	try {
		const overlay = await import("orgloom-saas/database/saas-overlay");
		await overlay.applySaasOverlay(db);
	} catch (e) {
		const msg = (e && e.message) || "";
		const code = e && e.code;
		if (code === "ERR_MODULE_NOT_FOUND" || /cannot find/i.test(msg)) {
			console.log(
				"[migration 001_init] orgloom-saas not installed; running canvas-standalone schema (no workspaces/billing/oauth tables).",
			);
			return;
		}
		throw e;
	}
}

export async function down(db) {
	// SaaS overlay tear-down first (reverse of up()) so FK dependents
	// drop before their parents. Same import-guard pattern as up():
	// canvas-standalone deployments skip the overlay drop.
	try {
		const overlay = await import("orgloom-saas/database/saas-overlay");
		await overlay.dropSaasOverlay(db);
	} catch (e) {
		const msg = (e && e.message) || "";
		const code = e && e.code;
		if (code !== "ERR_MODULE_NOT_FOUND" && !/cannot find/i.test(msg)) {
			throw e;
		}
	}

	await db.schema.dropTable("audit_log").execute();
	await db.schema.dropTable("connections").execute();
	await db.schema.dropTable("accounts").execute();
}
