// MCP bearer credentials used to inherit account_view_state.current_workspace_id
// at request time. That made a browser workspace switch silently retarget an
// already-configured AI client. Bind every new credential to one immutable
// workspace instead.
//
// Existing credentials have no trustworthy workspace scope. Delete them rather
// than guessing from mutable view state; users must generate replacements after
// this migration. workspace_id intentionally has no database FK because the
// canvas-only distribution does not install the SaaS workspaces table.

export async function up(db) {
	await db.schema
		.alterTable("mcp_tokens")
		.addColumn("workspace_id", "text")
		.execute();

	await db.deleteFrom("mcp_tokens").execute();

	await db.schema
		.createIndex("mcp_tokens_account_workspace_idx")
		.on("mcp_tokens")
		.columns(["account_id", "workspace_id"])
		.execute();
}

export async function down(db) {
	await db.schema.dropIndex("mcp_tokens_account_workspace_idx").execute();
	await db.schema
		.alterTable("mcp_tokens")
		.dropColumn("workspace_id")
		.execute();
}
