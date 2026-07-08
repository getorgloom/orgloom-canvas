import crypto from "node:crypto";
import { ext } from "../extensions.js";

const TOKEN_PREFIX = "ol_mcp_";
const TOKEN_RANDOM_BYTES = 32;

function _hashToken(plaintext) {
	return crypto.createHash("sha256").update(String(plaintext)).digest("hex");
}

function _generatePlaintext() {
	return (
		TOKEN_PREFIX + crypto.randomBytes(TOKEN_RANDOM_BYTES).toString("hex")
	);
}

export async function issue({ accountId, name, ttlMs = null }) {
	if (!accountId) {
		throw new Error("accountId required");
	}
	const trimmedName = String(name || "")
		.trim()
		.slice(0, 80);
	if (!trimmedName) {
		throw new Error("name required");
	}
	const db = ext.getDb();
	const now = Date.now();
	for (let attempt = 0; attempt < 5; attempt++) {
		const plaintext = _generatePlaintext();
		const tokenHash = _hashToken(plaintext);
		const collision = await db
			.selectFrom("mcp_tokens")
			.select("id")
			.where("token_hash", "=", tokenHash)
			.executeTakeFirst();
		if (collision) {
			continue;
		}
		const id = "mcp_" + crypto.randomUUID();
		const expiresAt = ttlMs ? now + ttlMs : null;
		await db
			.insertInto("mcp_tokens")
			.values({
				id,
				account_id: accountId,
				token_hash: tokenHash,
				name: trimmedName,
				created_at: now,
				last_used_at: null,
				expires_at: expiresAt,
				revoked_at: null,
			})
			.execute();
		return { id, plaintext, name: trimmedName, createdAt: now, expiresAt };
	}
	throw new Error("Could not allocate token");
}

export async function authenticate(plaintext) {
	if (!plaintext || typeof plaintext !== "string") {
		return null;
	}
	if (!plaintext.startsWith(TOKEN_PREFIX)) {
		return null;
	}
	const tokenHash = _hashToken(plaintext);
	const db = ext.getDb();
	const row = await db
		.selectFrom("mcp_tokens")
		.selectAll()
		.where("token_hash", "=", tokenHash)
		.executeTakeFirst();
	if (!row) {
		return null;
	}
	if (row.revoked_at) {
		return null;
	}
	if (row.expires_at && row.expires_at < Date.now()) {
		return null;
	}

	db.updateTable("mcp_tokens")
		.set({ last_used_at: Date.now() })
		.where("id", "=", row.id)
		.execute()
		.catch(() => {});
	return row;
}

export async function listForAccount(accountId) {
	if (!accountId) {
		return [];
	}
	const db = ext.getDb();
	const rows = await db
		.selectFrom("mcp_tokens")
		.select(["id", "name", "created_at", "last_used_at", "expires_at"])
		.where("account_id", "=", accountId)
		.where("revoked_at", "is", null)
		.orderBy("created_at", "desc")
		.execute();
	return rows.map((r) => ({
		id: r.id,
		name: r.name,
		createdAt: r.created_at,
		lastUsedAt: r.last_used_at,
		expiresAt: r.expires_at,
		expired: !!(r.expires_at && r.expires_at < Date.now()),
	}));
}

export async function revoke(tokenId, accountId) {
	if (!tokenId) {
		throw new Error("tokenId required");
	}
	const db = ext.getDb();
	let q = db
		.updateTable("mcp_tokens")
		.set({ revoked_at: Date.now() })
		.where("id", "=", tokenId)
		.where("revoked_at", "is", null);

	if (accountId) {
		q = q.where("account_id", "=", accountId);
	}
	const result = await q.execute();
	return Number(result?.[0]?.numUpdatedRows || 0) > 0;
}
