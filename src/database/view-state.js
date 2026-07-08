import { ext } from "../extensions.js";

export async function get(accountId) {
	if (!accountId) {
		return null;
	}
	const db = ext.getDb();
	return db
		.selectFrom("account_view_state")
		.selectAll()
		.where("account_id", "=", accountId)
		.executeTakeFirst();
}

export async function set(accountId, patch) {
	if (!accountId) {
		throw new Error("accountId required");
	}
	const db = ext.getDb();
	const now = Date.now();
	const existing = await get(accountId);
	if (existing) {
		const merged = { updated_at: now };
		if (Object.prototype.hasOwnProperty.call(patch, "currentWorkspaceId")) {
			merged.current_workspace_id = patch.currentWorkspaceId || null;
		}
		if (
			Object.prototype.hasOwnProperty.call(patch, "currentConnectionId")
		) {
			merged.current_connection_id = patch.currentConnectionId || null;
		}
		await db
			.updateTable("account_view_state")
			.set(merged)
			.where("account_id", "=", accountId)
			.execute();
	} else {
		await db
			.insertInto("account_view_state")
			.values({
				account_id: accountId,
				current_workspace_id: patch.currentWorkspaceId || null,
				current_connection_id: patch.currentConnectionId || null,
				updated_at: now,
			})
			.execute();
	}
	return get(accountId);
}

export async function setCurrentWorkspace(accountId, workspaceId) {
	if (!workspaceId) {
		return set(accountId, { currentWorkspaceId: null });
	}

	const db = ext.getDb();
	const member = await db
		.selectFrom("workspace_members")
		.select("account_id")
		.where("workspace_id", "=", workspaceId)
		.where("account_id", "=", accountId)
		.executeTakeFirst();
	if (!member) {
		const err = new Error("Account is not a member of this workspace.");
		err.code = "not-a-member";
		throw err;
	}
	return set(accountId, { currentWorkspaceId: workspaceId });
}

export async function setCurrentConnection(accountId, connectionId) {
	return set(accountId, { currentConnectionId: connectionId });
}
