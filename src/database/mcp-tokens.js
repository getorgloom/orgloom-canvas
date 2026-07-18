// Workspace-scoped MCP credentials. Plaintext is returned once and only its SHA-256 digest is stored.
import crypto from 'node:crypto';
import { ext } from '../extensions.js';

const TOKEN_PREFIX = 'ol_mcp_';
export const MAX_ACTIVE_TOKENS_PER_ACCOUNT_WORKSPACE = 10;
const TOKEN_RANDOM_BYTES = 32; // 256 bits → 64 hex chars

function _hashToken(plaintext) {
	return crypto.createHash('sha256').update(String(plaintext)).digest('hex');
}

function _generatePlaintext() {
	return TOKEN_PREFIX + crypto.randomBytes(TOKEN_RANDOM_BYTES).toString('hex');
}

export async function issue({ accountId, workspaceId, name, ttlMs = null }) {
	if (!accountId) {
		throw new Error('accountId required');
	}
	if (!workspaceId) {
		throw new Error('workspaceId required');
	}
	const trimmedName = String(name || '')
		.trim()
		.slice(0, 80);
	if (!trimmedName) {
		throw new Error('name required');
	}
	const db = ext.getDb();
	const now = Date.now();
	const active = await db
		.selectFrom('mcp_tokens')
		.select('id')
		.where('account_id', '=', accountId)
		.where('revoked_at', 'is', null)
		.where('workspace_id', '=', workspaceId)
		.where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', now)]))
		.execute();
	if (active.length >= MAX_ACTIVE_TOKENS_PER_ACCOUNT_WORKSPACE) {
		const err = new Error('mcp-token-cap-reached');
		err.code = 'mcp-token-cap-reached';
		throw err;
	}
	for (let attempt = 0; attempt < 5; attempt++) {
		const plaintext = _generatePlaintext();
		const tokenHash = _hashToken(plaintext);
		const collision = await db
			.selectFrom('mcp_tokens')
			.select('id')
			.where('token_hash', '=', tokenHash)
			.executeTakeFirst();
		if (collision) {
			continue;
		}
		const id = 'mcp_' + crypto.randomUUID();
		const expiresAt = ttlMs ? now + ttlMs : null;
		await db
			.insertInto('mcp_tokens')
			.values({
				id,
				account_id: accountId,
				workspace_id: workspaceId,
				token_hash: tokenHash,
				name: trimmedName,
				created_at: now,
				last_used_at: null,
				expires_at: expiresAt,
				revoked_at: null,
			})
			.execute();
		return { id, plaintext, name: trimmedName, workspaceId, createdAt: now, expiresAt };
	}
	throw new Error('Could not allocate token');
}

export async function authenticate(plaintext) {
	// Authentication also rejects revoked, expired, deleted-account, and inaccessible-workspace tokens.
	if (!plaintext || typeof plaintext !== 'string') {
		return null;
	}
	if (!plaintext.startsWith(TOKEN_PREFIX)) {
		return null;
	}
	const tokenHash = _hashToken(plaintext);
	const db = ext.getDb();
	const row = await db.selectFrom('mcp_tokens').selectAll().where('token_hash', '=', tokenHash).executeTakeFirst();
	if (!row) {
		return null;
	}
	if (row.revoked_at) {
		return null;
	}
	if (row.expires_at && row.expires_at < Date.now()) {
		return null;
	}
	if (!row.workspace_id) {
		return null;
	}

	db.updateTable('mcp_tokens')
		.set({ last_used_at: Date.now() })
		.where('id', '=', row.id)
		.execute()
		.catch(() => {});
	return row;
}

export async function listForWorkspace(accountId, workspaceId, { includeAllOwners = false } = {}) {
	if ((!accountId && !includeAllOwners) || !workspaceId) {
		return [];
	}
	const db = ext.getDb();
	let query = db
		.selectFrom('mcp_tokens')
		.leftJoin('accounts', 'accounts.id', 'mcp_tokens.account_id')
		.select([
			'mcp_tokens.id as id',
			'mcp_tokens.account_id as account_id',
			'mcp_tokens.name as name',
			'mcp_tokens.workspace_id as workspace_id',
			'mcp_tokens.created_at as created_at',
			'mcp_tokens.last_used_at as last_used_at',
			'mcp_tokens.expires_at as expires_at',
			'accounts.display_name as owner_display_name',
			'accounts.email as owner_email',
		])
		.where('mcp_tokens.workspace_id', '=', workspaceId)
		.where('mcp_tokens.revoked_at', 'is', null);
	if (!includeAllOwners) {
		query = query.where('mcp_tokens.account_id', '=', accountId);
	}
	const rows = await query.orderBy('mcp_tokens.created_at', 'desc').execute();
	return rows.map((r) => ({
		id: r.id,
		accountId: r.account_id,
		name: r.name,
		workspaceId: r.workspace_id,
		ownerDisplayName: r.owner_display_name || null,
		ownerEmail: r.owner_email || null,
		createdAt: r.created_at,
		lastUsedAt: r.last_used_at,
		expiresAt: r.expires_at,
		expired: !!(r.expires_at && r.expires_at < Date.now()),
	}));
}

export async function hasActiveForWorkspace(workspaceId) {
	if (!workspaceId) {
		return false;
	}
	const now = Date.now();
	const row = await ext
		.getDb()
		.selectFrom('mcp_tokens')
		.select('id')
		.where('workspace_id', '=', workspaceId)
		.where('revoked_at', 'is', null)
		.where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', now)]))
		.executeTakeFirst();
	return !!row;
}

export async function revoke(tokenId, accountId, workspaceId = null) {
	if (!tokenId) {
		throw new Error('tokenId required');
	}
	const db = ext.getDb();
	let q = db
		.updateTable('mcp_tokens')
		.set({ revoked_at: Date.now() })
		.where('id', '=', tokenId)
		.where('revoked_at', 'is', null);

	if (accountId) {
		q = q.where('account_id', '=', accountId);
	}
	if (workspaceId) {
		q = q.where('workspace_id', '=', workspaceId);
	}
	const result = await q.execute();
	return Number(result?.[0]?.numUpdatedRows || 0) > 0;
}

export async function revokeForAccountWorkspace(accountId, workspaceId) {
	if (!accountId || !workspaceId) {
		return 0;
	}
	const result = await ext
		.getDb()
		.updateTable('mcp_tokens')
		.set({ revoked_at: Date.now() })
		.where('account_id', '=', accountId)
		.where('workspace_id', '=', workspaceId)
		.where('revoked_at', 'is', null)
		.execute();
	return Number(result?.[0]?.numUpdatedRows || 0);
}
