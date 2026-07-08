import crypto from "node:crypto";

const SWEEP_INTERVAL_MS = 30 * 60 * 1000;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

const _proposals = new Map();

function _shape({
	id,
	canvasId,
	workspaceId,
	proposingAccountId,
	proposingTokenId,
	changes,
	summary,
	createdAt,
}) {
	return {
		id,
		canvasId,
		workspaceId,
		proposingAccountId,
		proposingTokenId: proposingTokenId || null,
		status: "pending",
		changes: changes.slice(),
		summary: summary ? String(summary).slice(0, 500) : null,
		createdAt,
		decidedAt: null,
		decidedByAccountId: null,
	};
}

export async function create({
	canvasId,
	workspaceId,
	proposingAccountId,
	proposingTokenId,
	changes,
	summary,
}) {
	if (!canvasId) {
		throw new Error("canvasId required");
	}
	if (!workspaceId) {
		throw new Error("workspaceId required");
	}
	if (!proposingAccountId) {
		throw new Error("proposingAccountId required");
	}
	if (!Array.isArray(changes) || changes.length === 0) {
		throw new Error("changes must be a non-empty array");
	}
	const id = "prop_" + crypto.randomUUID();
	const record = _shape({
		id,
		canvasId,
		workspaceId,
		proposingAccountId,
		proposingTokenId,
		changes,
		summary,
		createdAt: Date.now(),
	});
	_proposals.set(id, record);
	return _clone(record);
}

export async function findById(id) {
	if (!id) {
		return null;
	}
	const r = _proposals.get(id);
	return r ? _clone(r) : null;
}

export async function listPendingForCanvas(canvasId) {
	if (!canvasId) {
		return [];
	}
	const out = [];
	for (const r of _proposals.values()) {
		if (r.canvasId === canvasId && r.status === "pending") {
			out.push(_clone(r));
		}
	}
	out.sort((a, b) => b.createdAt - a.createdAt);
	return out;
}

export async function listForCanvas(canvasId, { limit = 100 } = {}) {
	const all = await listPendingForCanvas(canvasId);
	return all.slice(0, Math.min(500, Math.max(1, limit)));
}

export async function markApplied({ id }) {
	if (!id) {
		throw new Error("id required");
	}
	const r = _proposals.get(id);
	if (!r || r.status !== "pending") {
		return false;
	}
	_proposals.delete(id);
	return true;
}

export async function markRejected({ id }) {
	if (!id) {
		throw new Error("id required");
	}
	const r = _proposals.get(id);
	if (!r || r.status !== "pending") {
		return false;
	}
	_proposals.delete(id);
	return true;
}

export async function markWithdrawn({ id }) {
	if (!id) {
		throw new Error("id required");
	}
	const r = _proposals.get(id);
	if (!r || r.status !== "pending") {
		return false;
	}
	_proposals.delete(id);
	return true;
}

function _clone(r) {
	return {
		id: r.id,
		canvasId: r.canvasId,
		workspaceId: r.workspaceId,
		proposingAccountId: r.proposingAccountId,
		proposingTokenId: r.proposingTokenId,
		status: r.status,
		changes: r.changes.map((c) =>
			c && typeof c === "object" ? Object.assign({}, c) : c,
		),
		summary: r.summary,
		createdAt: r.createdAt,
		decidedAt: r.decidedAt,
		decidedByAccountId: r.decidedByAccountId,
	};
}
function _purgeOrphans(now = Date.now()) {
	for (const [id, r] of _proposals.entries()) {
		if (r.status === "pending" && now - r.createdAt > PENDING_TTL_MS) {
			_proposals.delete(id);
		}
	}
}

const _sweepTimer = setInterval(_purgeOrphans, SWEEP_INTERVAL_MS);
if (_sweepTimer.unref) {
	_sweepTimer.unref();
}
