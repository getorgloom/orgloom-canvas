export async function up(db) {

	await db.schema
		.createTable("mcp_tokens")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("account_id", "text", (col) =>
			col.notNull().references("accounts.id").onDelete("cascade"),
		)
		.addColumn("token_hash", "text", (col) => col.notNull().unique())
		.addColumn("name", "text", (col) => col.notNull())
		.addColumn("created_at", "integer", (col) => col.notNull())
		.addColumn("last_used_at", "integer")
		.addColumn("expires_at", "integer")
		.addColumn("revoked_at", "integer")
		.execute();
	await db.schema
		.createIndex("mcp_tokens_account_idx")
		.on("mcp_tokens")
		.column("account_id")
		.execute();

	await db.schema
		.createTable("ai_proposals")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("canvas_id", "text", (col) => col.notNull())
		.addColumn("workspace_id", "text", (col) =>
			col.notNull().references("workspaces.id").onDelete("cascade"),
		)
		.addColumn("proposing_account_id", "text", (col) =>
			col.notNull().references("accounts.id").onDelete("cascade"),
		)
		.addColumn("proposing_token_id", "text", (col) =>
			col.references("mcp_tokens.id").onDelete("set null"),
		)
		.addColumn("status", "text", (col) =>
			col.notNull().defaultTo("pending"),
		)
		.addColumn("changes_json", "text", (col) => col.notNull())
		.addColumn("summary", "text")
		.addColumn("created_at", "integer", (col) => col.notNull())
		.addColumn("decided_at", "integer")
		.addColumn("decided_by_account_id", "text", (col) =>
			col.references("accounts.id"),
		)
		.execute();
	await db.schema
		.createIndex("ai_proposals_canvas_status_idx")
		.on("ai_proposals")
		.columns(["canvas_id", "status"])
		.execute();
	await db.schema
		.createIndex("ai_proposals_workspace_idx")
		.on("ai_proposals")
		.column("workspace_id")
		.execute();

	await db.schema
		.alterTable("workspace_settings")
		.addColumn("ai_on_canvas_data_enabled", "integer", (col) =>
			col.notNull().defaultTo(0),
		)
		.execute();
	await db.schema
		.alterTable("workspace_settings")
		.addColumn("mcp_required_review", "integer", (col) =>
			col.notNull().defaultTo(1),
		)
		.execute();

	await db.schema
		.alterTable("audit_log")
		.addColumn("actor_kind", "text", (col) =>
			col.notNull().defaultTo("web"),
		)
		.execute();
	await db.schema
		.alterTable("audit_log")
		.addColumn("mcp_token_id", "text", (col) =>
			col.references("mcp_tokens.id").onDelete("set null"),
		)
		.execute();
}

export async function down(db) {
	await db.schema
		.alterTable("audit_log")
		.dropColumn("mcp_token_id")
		.execute();
	await db.schema.alterTable("audit_log").dropColumn("actor_kind").execute();
	await db.schema
		.alterTable("workspace_settings")
		.dropColumn("mcp_required_review")
		.execute();
	await db.schema
		.alterTable("workspace_settings")
		.dropColumn("ai_on_canvas_data_enabled")
		.execute();
	await db.schema.dropTable("ai_proposals").execute();
	await db.schema.dropTable("mcp_tokens").execute();
}
