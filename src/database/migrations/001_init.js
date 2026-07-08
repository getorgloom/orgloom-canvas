






















export async function up(db) {





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





	await db.schema
		.createTable("audit_log")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("workspace_id", "text")
		.addColumn("actor_account_id", "text", (col) =>
			col.references("accounts.id"),
		)
		.addColumn("actor_connection_id", "text", (col) =>
			col.references("connections.id"),
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






	try {
		const overlay = await import("orgloom-saas/database/saas-overlay");
		await overlay.applySaasOverlay(db);
	} catch (e) {
		const msg = (e && e.message) || "";
		const code = e && e.code;
		if (code === "ERR_MODULE_NOT_FOUND" || /cannot find/i.test(msg)) {
			console.log(
				"[migration 001_init] orgloom-saas not installed — running canvas-standalone schema (no workspaces/billing/oauth tables).",
			);
			return;
		}
		throw e;
	}
}

export async function down(db) {



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
