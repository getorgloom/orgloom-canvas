// Activity History - "who did what in which workspace" operational record.
// workspace-keyed (audit_log.workspace_id). Actor split into actor_
// account_id (the human) and actor_connection_id (the credential) so
// the trail attributes both - same human via different credentials is
// distinguishable. Retention policy is decided by the plug-point registry,
// not this file
import crypto from "node:crypto";
import { sql } from "kysely";
import { ext } from "../extensions.js";

const DAY_MS = 1000 * 60 * 60 * 24;
const EXPORT_MAX = 50_000;
export const LIST_EXPORT_MAX = EXPORT_MAX;

// Per-workspace serialization for CHAINED writes. record() reads the
// current chain head then inserts a row that chains off it; two
// concurrent chained writes to the same workspace could both read the
// same head and fork the chain (a spurious verifyChain() break). An
// in-process promise queue keyed by workspace makes the read+insert
// critical section atomic. Unchained writes (data-touching buffer rows)
// skip the lock: they don't touch the chain, so their order is
// irrelevant. Cross-process races are out of scope (single-writer
// deployment); this closes the common same-process window.
const _chainLocks = new Map(); // workspace key -> tail promise
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

// The chain anchor for a workspace, if an older prefix has been purged.
// verifyChain() and record() seed their walk from anchor_hash so the
// surviving suffix still verifies after retention deletes the head.
async function _getAnchor(db, workspaceId) {
	return db
		.selectFrom("audit_chain_anchors")
		.select(["anchor_hash", "purged_count"])
		.where("workspace_id", "=", workspaceId || "")
		.executeTakeFirst();
}

// actorKind: 'web' (default; human acting in the UI), 'mcp' (an AI
// client acting on the user's behalf via MCP), 'system' (server-internal
// operations like retention purges).
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
	const rawErrorCode = opts.errorCode == null ? null : String(opts.errorCode);
	const errorCode = rawErrorCode == null
		? null
		: (/^[A-Za-z0-9_.:-]{1,100}$/.test(rawErrorCode) ? rawErrorCode : "error");
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
				/* never let telemetry break the audit insert */
			}
		}
	}

	// Legacy tamper-evidence support: explicitly chained rows are linked to
	// the most recent CHAINED row in the same workspace. New hosted Activity
	// History writes are unchained; the chain was stored in the same database
	// and was not an externally anchored integrity proof. The compatibility
	// path remains so existing development databases and old migrations can
	// still be read, retained, redacted, and verified safely.
	//
	// Chain this row off the most recent CHAINED row in
	// the same workspace. verifyChain() recomputes every row's hash from
	// the stored content; any UPDATE/DELETE/reorder breaks the chain at
	// the modified position. Workspace-scoped so a tamper event in
	// workspace A doesn't invalidate workspace B's trail.
	//
	// Chaining now requires explicit opt-in. No production sink opts in.
	const chained = opts.chained === true;
	const payloadJson = payload ? JSON.stringify(payload) : null;

	// Serialize the read-head + insert for chained writes so concurrent
	// writes to one workspace can't fork the chain.
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
			// Strict-monotonic created_at per workspace. verifyChain walks
			// by (created_at ASC, id ASC), but since ids are random UUIDs, two
			// chained rows sharing a millisecond could walk in the opposite
			// order from how they chained, a spurious break. Holding the
			// lock, bump `now` past the previous chained row so created_at
			// alone determines order and the id tie-break never bites.
			if (prevRow && prevRow.created_at != null && prevRow.created_at >= now) {
				now = prevRow.created_at + 1;
			}
			// No chained row yet? Seed from the workspace anchor if a prior
			// prefix was purged, else the empty string (genesis).
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
		const candidateCode =
			extras.errorCode ||
			(err && (err.errorCode || err.name)) ||
			"error";
		const safeErrorCode = /^[A-Za-z0-9_.:-]{1,100}$/.test(String(candidateCode))
			? String(candidateCode)
			: "error";
		await record({
			req,
			action,
			...extras,
			status: "failed",
			errorCode: safeErrorCode,
			// Free-form exception messages can contain Salesforce field values,
			// SOQL literals, URLs, or provider response text. Activity History
			// retains the bounded classification above and caller-supplied
			// structural metadata only.
			payload: extras.payload || null,
		});
	} catch (_eAudit) {
		/* never let an audit write break the real error path */
	}
}

// prevent record from firing more than once for one-time events
// e.g. account signup
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
		// Funnel telemetry must never break the user flow. Log + swallow.
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

// find the most recent audit row matching (workspace, action, target_id).
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
							/* swallow */
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

// Per-row content hash: H(canonical(row)). Immutable and independent of
// position. Retained even when a row is redacted, so the chain linkage
// stays reproducible after erasure.
function _contentHash(row) {
	return crypto.createHash("sha256").update(_canonicalForHash(row)).digest("hex");
}

// Chain link: H(prev_chain_hash + content_hash). Chaining over the
// content_hash (not the raw content) is what lets a redacted row's linkage
// still be verified from its retained content_hash.
function _computeChainHash(prevHash, contentHash) {
	const h = crypto.createHash("sha256");
	h.update(prevHash || "");
	h.update("|");
	h.update(contentHash);
	return h.digest("hex");
}

// walk every row in a workspace in created_at ASC order, recompute
// the chain_hash from the stored content, and compare against what's
// in the column.
export async function verifyChain({ workspaceId } = {}) {
	const db = ext.getDb();
	let q = db
		.selectFrom("audit_log")
		.selectAll()
		// Only chained rows participate. Data-touching buffer rows carry
		// chain_hash=NULL and are excluded, since their deletion is expected
		// and must not read as tampering.
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
	// Seed from the workspace anchor when an older prefix was purged for
	// retention, so the surviving suffix still verifies. `purgedBefore`
	// is surfaced so callers can say "chain intact; N older rows purged
	// per retention" rather than implying the log was always this short.
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
		// Content check: a non-redacted row's stored content must still hash
		// to its content_hash. Skipped for redacted rows, whose content was
		// intentionally erased, so it no longer reproduces content_hash.
		if (r.redacted_at != null) {
			redactedCount++;
		} else {
			const expectedContent = _contentHash(r);
			if (r.content_hash !== expectedContent) {
				return _break("content", expectedContent);
			}
		}
		// Chain-linkage check: ALWAYS run, redacted or not. The retained
		// content_hash keeps this reproducible after erasure, so a deleted,
		// inserted, or reordered row around a redacted one is still caught.
		const expectedChain = _computeChainHash(prev, r.content_hash);
		if (r.chain_hash !== expectedChain) {
			return _break("chain", expectedChain);
		}
		prev = r.chain_hash;
	}
	return { ok: true, totalRows: rows.length, purgedBefore, redactedCount, lastHash: prev };
}

// GDPR erasure: redact a subject's email wherever it sits as free text in
// Activity History payloads. Account pseudonymization already scrubs the actor's
// join-time email from every row, but literal copies in payload_json (an
// invite the subject sent, an admin action naming them, a share) survive
// the join. This scans payloads for the email and overwrites occurrences
// with "[redacted]" in place, marking each touched row with redacted_at so
// legacy verifyChain() trusts its (untouched) chain_hash instead of recomputing.
//
// Scans globally (all workspaces): a subject's PII can appear anywhere.
// A one-time operation at account deletion, so a full scan is acceptable.
// The LIKE narrows candidates; the JS re-check is authoritative (so LIKE
// over-matching on '_' is harmless). Never touches chain_hash. Returns the
// number of rows redacted.
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
			continue; // non-JSON payload: nothing structured to redact
		}
		const { changed, value } = _deepRedactEmail(parsed, needle);
		if (!changed) {
			continue; // LIKE matched but no actual email leaf (over-match)
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

// Recursively replace case-insensitive occurrences of `needle` in every
// string leaf of a parsed payload with "[redacted]". Returns whether
// anything changed plus the (possibly new) value.
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

// Retention cleanup of expired rows, chain-safe.
//
// Two classes of expired rows are handled differently so the tamper
// chain stays verifiable:
//
//   * Unchained rows (chain_hash IS NULL): data-touching buffer events.
//     Not in any chain, so they're deleted freely.
//
//   * Chained rows (chain_hash NOT NULL): workspace-meta events. Deleting
//     one mid-chain would break verifyChain(). So we only delete a
//     contiguous OLDEST prefix per workspace (walk oldest-first, stop at
//     the first row that hasn't expired), and record an ANCHOR = the
//     chain_hash of the newest row in the deleted prefix. verifyChain()
//     then seeds from the anchor and the surviving suffix still verifies.
//     A chained row whose expiry falls out of created_at order (e.g. a
//     plan downgrade shortened later rows' retention) is simply kept a
//     bit longer: never deleted ahead of an older still-retained row.
//     This trades slightly-longer retention for an unbreakable chain.
export async function purgeExpired(now = Date.now()) {
	const db = ext.getDb();

	// 1. Unchained expired rows: delete unconditionally.
	const unchainedResult = await db
		.deleteFrom("audit_log")
		.where("chain_hash", "is", null)
		.where("expires_at", "is not", null)
		.where("expires_at", "<", now)
		.execute();
	let deleted = Number(unchainedResult?.[0]?.numDeletedRows || 0);

	// 2. Chained rows: prefix-only per workspace, with an anchor.
	// Find workspaces that have at least one expired chained row.
	const wsRows = await db
		.selectFrom("audit_log")
		.select("workspace_id")
		.distinct()
		.where("chain_hash", "is not", null)
		.where("expires_at", "is not", null)
		.where("expires_at", "<", now)
		.execute();

	for (const { workspace_id: workspaceId } of wsRows) {
		// Load this workspace's chained rows oldest-first. Same ordering
		// verifyChain walks, so "prefix" here means the same prefix there.
		const chainedRows = await db
			.selectFrom("audit_log")
			.select(["id", "chain_hash", "expires_at"])
			.where("workspace_id", workspaceId ? "=" : "is", workspaceId || null)
			.where("chain_hash", "is not", null)
			.orderBy("created_at", "asc")
			.orderBy("id", "asc")
			.execute();

		// Contiguous expired prefix: stop at the first row that is not
		// expired (null expiry = keep forever, or not yet due).
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

		// Record/advance the anchor BEFORE deleting so a crash mid-purge
		// can't leave a purged prefix without a seed for the survivors.
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

		// Delete the prefix (chunk to keep the IN list bounded).
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
