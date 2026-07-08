import crypto from "node:crypto";
import { sql } from "kysely";
import { ext } from "../extensions.js";

const DAY_MS = 1000 * 60 * 60 * 24;
const EXPORT_MAX = 50_000;
export const LIST_EXPORT_MAX = EXPORT_MAX;

const _chainLocks = new Map();
async function _acquireChainLock(key) {
	const prev = _chainLocks.get(key) || Promise.resolve();
	let release;
	const gate = new Promise((res) => {
		release = res;
	});
	_chainLocks.set(key, prev.then(() => gate));
	await prev.catch(() => {});
	return release;
}

async function _getAnchor(db, workspaceId) {
	return db
		.selectFrom("audit_chain_anchors")
		.select(["anchor_hash", "purged_count"])
		.where("workspace_id", "=", workspaceId || "")
		.executeTakeFirst();
}

export async function record(opts = {}) {
	const { req, action, targetObject, targetId, targetSfOrgId, payload } =
		opts;
	if (!action) {
		throw new Error("action is required");
	}

	let workspaceId = opts.workspaceId;
	let actorAccountId = opts.actorAccountId;
	let actorConnectionId = opts.actorConnectionId;
	const actorKind = opts.actorKind || "web";
	const mcpTokenId = opts.mcpTokenId || null;
	const status = opts.status || "ok";
	const errorCode = opts.errorCode || null;
	const requestId = opts.requestId || null;

	if (req && req.session) {
		if (!actorAccountId) {
			actorAccountId = req.session.accountId || null;
		}
		if (!actorConnectionId) {
			actorConnectionId = req.session.currentConnectionId || null;
		}
	}

	const db = ext.getDb();
	let now = Date.now();
	const id = "audit_" + crypto.randomUUID();

	let expiresAt = opts.expiresAt != null ? opts.expiresAt : null;
	if (expiresAt == null && workspaceId) {
		try {
			const days = await ext.auditRetentionDays(workspaceId);
			if (days != null) {
				expiresAt = now + days * DAY_MS;
			}
		} catch (err) {
			try {
				ext.captureException(err, {
					where: "audit.record/retentionLookup",
					workspaceId,
					action,
				});
			} catch (_) {

			}
		}
	}

	const chained = opts.chained !== false;
	const payloadJson = payload ? JSON.stringify(payload) : null;

	const release = chained ? await _acquireChainLock(workspaceId || "") : null;
	try {
		let chainHash = null;
		let contentHash = null;
		if (chained) {
			const prevRow = await db
				.selectFrom("audit_log")
				.select(["chain_hash", "created_at"])
				.where("workspace_id", workspaceId ? "=" : "is", workspaceId || null)
				.where("chain_hash", "is not", null)
				.orderBy("created_at", "desc")
				.orderBy("id", "desc")
				.limit(1)
				.executeTakeFirst();

			if (prevRow && prevRow.created_at != null && prevRow.created_at >= now) {
				now = prevRow.created_at + 1;
			}

			let prev = (prevRow && prevRow.chain_hash) || "";
			if (!prev) {
				const anchor = await _getAnchor(db, workspaceId);
				prev = (anchor && anchor.anchor_hash) || "";
			}
			const rowForHash = {
				id,
				workspace_id: workspaceId || null,
				actor_account_id: actorAccountId || null,
				actor_connection_id: actorConnectionId || null,
				actor_kind: actorKind,
				mcp_token_id: mcpTokenId,
				action,
				target_object: targetObject || null,
				target_id: targetId || null,
				target_sf_org_id: targetSfOrgId || null,
				payload_json: payloadJson,
				status,
				error_code: errorCode,
				request_id: requestId,
				created_at: now,
			};
			contentHash = _contentHash(rowForHash);
			chainHash = _computeChainHash(prev, contentHash);
		}

		await db
			.insertInto("audit_log")
			.values({
				id,
				workspace_id: workspaceId || null,
				actor_account_id: actorAccountId || null,
				actor_connection_id: actorConnectionId || null,
				actor_kind: actorKind,
				mcp_token_id: mcpTokenId,
				action,
				target_object: targetObject || null,
				target_id: targetId || null,
				target_sf_org_id: targetSfOrgId || null,
				payload_json: payloadJson,
				status,
				error_code: errorCode,
				request_id: requestId,
				content_hash: contentHash,
				chain_hash: chainHash,
				created_at: now,
				expires_at: expiresAt,
			})
			.execute();
	} finally {
		if (release) {
			release();
		}
	}

	return id;
}

export function newRequestId() {
	return "req_" + crypto.randomUUID();
}

export async function recordFailure(req, action, err, extras = {}) {
	try {
		await record({
			req,
			action,
			...extras,
			status: "failed",
			errorCode:
				extras.errorCode ||
				(err && (err.errorCode || err.name)) ||
				"error",
			payload: {
				...(extras.payload || {}),
				error: (err && err.message) || String(err),
			},
		});
	} catch (_eAudit) {

	}
}

export async function recordFirstTime(
	req,
	{
		actorAccountId,
		action,
		payload,
		workspaceId,
		targetObject,
		targetId,
	} = {},
) {
	if (!actorAccountId || !action) {
		return false;
	}
	try {
		const { ext } = await import("../extensions.js");
		const db = ext.getDb();
		const existing = await db
			.selectFrom("audit_log")
			.select("id")
			.where("actor_account_id", "=", actorAccountId)
			.where("action", "=", action)
			.limit(1)
			.executeTakeFirst();
		if (existing) {
			return false;
		}
		await record({
			req,
			workspaceId: workspaceId || null,
			actorAccountId,
			action,
			targetObject: targetObject || null,
			targetId: targetId || null,
			payload: payload || {},
		});
		return true;
	} catch (e) {

		try {
			console.warn(
				"[audit] recordFirstTime failed:",
				action,
				e.message || e,
			);
		} catch (_) {}
		return false;
	}
}

export async function list({
	workspaceId,
	action,
	limit = 100,
	offset = 0,
	since = null,
	until = null,
} = {}) {
	if (!workspaceId) {
		return [];
	}
	const db = ext.getDb();
	let q = db
		.selectFrom("audit_log")
		.leftJoin("accounts", "accounts.id", "audit_log.actor_account_id")
		.leftJoin("mcp_tokens", "mcp_tokens.id", "audit_log.mcp_token_id")
		.select([
			"audit_log.id",
			"audit_log.workspace_id",
			"audit_log.actor_account_id",
			"audit_log.actor_connection_id",
			"audit_log.actor_kind",
			"audit_log.mcp_token_id",
			"audit_log.action",
			"audit_log.target_object",
			"audit_log.target_id",
			"audit_log.target_sf_org_id",
			"audit_log.payload_json",
			"audit_log.status",
			"audit_log.error_code",
			"audit_log.request_id",
			"audit_log.created_at",
			"audit_log.redacted_at",
			"accounts.email as actor_email",
			"accounts.display_name as actor_display_name",
			"mcp_tokens.name as mcp_token_name",
		])
		.where("audit_log.workspace_id", "=", workspaceId)
		.orderBy("audit_log.created_at", "desc")
		.limit(Math.min(EXPORT_MAX, Math.max(1, limit)))
		.offset(Math.max(0, offset));
	if (action) {
		q = q.where("audit_log.action", "=", action);
	}
	if (since != null) {
		q = q.where("audit_log.created_at", ">=", since);
	}
	if (until != null) {
		q = q.where("audit_log.created_at", "<=", until);
	}
	const rows = await q.execute();
	return rows.map((r) => ({
		id: r.id,
		workspaceId: r.workspace_id,
		actorAccountId: r.actor_account_id,
		actorConnectionId: r.actor_connection_id,
		actorKind: r.actor_kind || "web",
		mcpTokenId: r.mcp_token_id,
		mcpTokenName: r.mcp_token_name,
		actorEmail: r.actor_email,
		actorDisplayName: r.actor_display_name,
		action: r.action,
		targetObject: r.target_object,
		targetId: r.target_id,
		targetSfOrgId: r.target_sf_org_id,
		payload: r.payload_json ? JSON.parse(r.payload_json) : null,
		status: r.status || "ok",
		errorCode: r.error_code,
		requestId: r.request_id,
		createdAt: r.created_at,
		redactedAt: r.redacted_at || null,
	}));
}

export async function findLatestByTarget({ workspaceId, action, targetId }) {
	if (!workspaceId || !action || !targetId) {
		return null;
	}
	const db = ext.getDb();
	const row = await db
		.selectFrom("audit_log")
		.select(["payload_json", "status", "error_code", "created_at"])
		.where("workspace_id", "=", workspaceId)
		.where("action", "=", action)
		.where("target_id", "=", targetId)
		.orderBy("created_at", "desc")
		.limit(1)
		.executeTakeFirst();
	if (!row) {
		return null;
	}
	return {
		payload: row.payload_json
			? (() => {
					try {
						return JSON.parse(row.payload_json);
					} catch (err) {
						try {
							ext.captureException(err, {
								where: "audit.findLatestByTarget/parsePayload",
							});
						} catch (_) {

						}
						return null;
					}
				})()
			: null,
		status: row.status || "ok",
		errorCode: row.error_code,
		createdAt: row.created_at,
	};
}

function _canonicalForHash(row) {
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
	return crypto.createHash("sha256").update(_canonicalForHash(row)).digest("hex");
}

function _computeChainHash(prevHash, contentHash) {
	const h = crypto.createHash("sha256");
	h.update(prevHash || "");
	h.update("|");
	h.update(contentHash);
	return h.digest("hex");
}

export async function verifyChain({ workspaceId } = {}) {
	const db = ext.getDb();
	let q = db
		.selectFrom("audit_log")
		.selectAll()

		.where("chain_hash", "is not", null)
		.orderBy("created_at", "asc")
		.orderBy("id", "asc");
	if (workspaceId !== undefined) {
		q = q.where(
			"workspace_id",
			workspaceId === null ? "is" : "=",
			workspaceId,
		);
	}
	const rows = await q.execute();

	const anchor =
		workspaceId !== undefined ? await _getAnchor(db, workspaceId) : null;
	let purgedBefore = 0;
	let prev = "";
	if (anchor && anchor.anchor_hash) {
		prev = anchor.anchor_hash;
		purgedBefore = anchor.purged_count || 0;
	}
	let redactedCount = 0;
	for (let i = 0; i < rows.length; i++) {
		const r = rows[i];
		const _break = (reason, expected) => ({
			ok: false,
			totalRows: rows.length,
			purgedBefore,
			redactedCount,
			brokenIndex: i,
			breakAt: {
				id: r.id,
				createdAt: r.created_at,
				workspaceId: r.workspace_id,
				action: r.action,
				reason,
				expected,
				actual: reason === "content" ? r.content_hash : r.chain_hash,
			},
		});

		if (r.redacted_at != null) {
			redactedCount++;
		} else {
			const expectedContent = _contentHash(r);
			if (r.content_hash !== expectedContent) {
				return _break("content", expectedContent);
			}
		}

		const expectedChain = _computeChainHash(prev, r.content_hash);
		if (r.chain_hash !== expectedChain) {
			return _break("chain", expectedChain);
		}
		prev = r.chain_hash;
	}
	return { ok: true, totalRows: rows.length, purgedBefore, redactedCount, lastHash: prev };
}

export async function redactPayloadByEmail(email, { now = Date.now() } = {}) {
	if (!email || typeof email !== "string") {
		return 0;
	}
	const needle = email.trim().toLowerCase();
	if (!needle) {
		return 0;
	}
	const db = ext.getDb();
	const rows = await db
		.selectFrom("audit_log")
		.select(["id", "payload_json"])
		.where("payload_json", "is not", null)
		.where(sql`lower(audit_log.payload_json) like ${"%" + needle + "%"}`)
		.execute();
	let count = 0;
	for (const r of rows) {
		let parsed;
		try {
			parsed = JSON.parse(r.payload_json);
		} catch (_) {
			continue;
		}
		const { changed, value } = _deepRedactEmail(parsed, needle);
		if (!changed) {
			continue;
		}
		await db
			.updateTable("audit_log")
			.set({ payload_json: JSON.stringify(value), redacted_at: now })
			.where("id", "=", r.id)
			.execute();
		count++;
	}
	return count;
}

function _deepRedactEmail(node, needle) {
	if (typeof node === "string") {
		if (!node.toLowerCase().includes(needle)) {
			return { changed: false, value: node };
		}
		const re = new RegExp(
			needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
			"gi",
		);
		return { changed: true, value: node.replace(re, "[redacted]") };
	}
	if (Array.isArray(node)) {
		let changed = false;
		const out = node.map((v) => {
			const r = _deepRedactEmail(v, needle);
			changed = changed || r.changed;
			return r.value;
		});
		return { changed, value: out };
	}
	if (node && typeof node === "object") {
		let changed = false;
		const out = {};
		for (const k of Object.keys(node)) {
			const r = _deepRedactEmail(node[k], needle);
			changed = changed || r.changed;
			out[k] = r.value;
		}
		return { changed, value: out };
	}
	return { changed: false, value: node };
}

export async function purgeExpired(now = Date.now()) {
	const db = ext.getDb();

	const unchainedResult = await db
		.deleteFrom("audit_log")
		.where("chain_hash", "is", null)
		.where("expires_at", "is not", null)
		.where("expires_at", "<", now)
		.execute();
	let deleted = Number(unchainedResult?.[0]?.numDeletedRows || 0);

	const wsRows = await db
		.selectFrom("audit_log")
		.select("workspace_id")
		.distinct()
		.where("chain_hash", "is not", null)
		.where("expires_at", "is not", null)
		.where("expires_at", "<", now)
		.execute();

	for (const { workspace_id: workspaceId } of wsRows) {

		const chainedRows = await db
			.selectFrom("audit_log")
			.select(["id", "chain_hash", "expires_at"])
			.where("workspace_id", workspaceId ? "=" : "is", workspaceId || null)
			.where("chain_hash", "is not", null)
			.orderBy("created_at", "asc")
			.orderBy("id", "asc")
			.execute();

		const prefixIds = [];
		let anchorHash = null;
		for (const row of chainedRows) {
			const expired = row.expires_at != null && row.expires_at < now;
			if (!expired) {
				break;
			}
			prefixIds.push(row.id);
			anchorHash = row.chain_hash;
		}
		if (prefixIds.length === 0) {
			continue;
		}

		const anchorKey = workspaceId || "";
		const existing = await _getAnchor(db, workspaceId);
		const purgedCount =
			(existing ? existing.purged_count || 0 : 0) + prefixIds.length;
		if (existing) {
			await db
				.updateTable("audit_chain_anchors")
				.set({ anchor_hash: anchorHash, purged_count: purgedCount, updated_at: now })
				.where("workspace_id", "=", anchorKey)
				.execute();
		} else {
			await db
				.insertInto("audit_chain_anchors")
				.values({ workspace_id: anchorKey, anchor_hash: anchorHash, purged_count: purgedCount, updated_at: now })
				.execute();
		}

		for (let i = 0; i < prefixIds.length; i += 500) {
			const slice = prefixIds.slice(i, i + 500);
			const r = await db
				.deleteFrom("audit_log")
				.where("id", "in", slice)
				.execute();
			deleted += Number(r?.[0]?.numDeletedRows || 0);
		}
	}

	return deleted;
}
