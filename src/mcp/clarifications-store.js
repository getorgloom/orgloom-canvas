import crypto from "node:crypto";

const DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24h
// run a sweep every 30 minutes to drop expired-and-answered entries
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;

const _clarifications = new Map();

function _shape({
	id,
	canvasId,
	workspaceId,
	requestingAccountId,
	requestingTokenId,
	question,
	options,
	createdAt,
	expiresAt,
}) {
	return {
		id,
		canvasId,
		workspaceId,
		requestingAccountId,
		requestingTokenId: requestingTokenId || null,
		status: "pending",
		question: String(question).slice(0, 500),
		options: Array.isArray(options) ? options.slice() : null,
		responseText: null,
		responseOption: null,
		createdAt,
		respondedAt: null,
		respondedByAccountId: null,
		expiresAt,
	};
}

export async function create({
	canvasId,
	workspaceId,
	requestingAccountId,
	requestingTokenId,
	question,
	options,
}) {
	if (!canvasId) {
		throw new Error("canvasId required");
	}
	if (!workspaceId) {
		throw new Error("workspaceId required");
	}
	if (!requestingAccountId) {
		throw new Error("requestingAccountId required");
	}
	if (!question) {
		throw new Error("question required");
	}
	const id = "clar_" + crypto.randomUUID();
	const now = Date.now();
	const record = _shape({
		id,
		canvasId,
		workspaceId,
		requestingAccountId,
		requestingTokenId,
		question,
		options,
		createdAt: now,
		expiresAt: now + DEFAULT_EXPIRY_MS,
	});
	_clarifications.set(id, record);
	return _clone(record);
}

export async function findById(id) {
	if (!id) {
		return null;
	}
	const r = _clarifications.get(id);
	return r ? _clone(r) : null;
}

export async function listPendingForCanvas(canvasId) {
	if (!canvasId) {
		return [];
	}
	const out = [];
	for (const r of _clarifications.values()) {
		if (r.canvasId === canvasId && r.status === "pending") {
			out.push(_clone(r));
		}
	}
	out.sort((a, b) => b.createdAt - a.createdAt);
	return out;
}

const ANSWERED_RETENTION_MS = 60 * 60 * 1000; // 1h
export async function markAnswered({
	id,
	responseText,
	responseOption,
	respondedByAccountId,
}) {
	if (!id) {
		throw new Error("id required");
	}
	const r = _clarifications.get(id);
	if (!r || r.status !== "pending") {
		return false;
	}
	r.status = "answered";
	r.responseText = responseText || null;
	r.responseOption = responseOption || null;
	r.respondedAt = Date.now();
	r.respondedByAccountId = respondedByAccountId || null;

	const tightEnd = Date.now() + ANSWERED_RETENTION_MS;
	if (r.expiresAt == null || tightEnd < r.expiresAt) {
		r.expiresAt = tightEnd;
	}
	return true;
}

export async function markWithdrawn({ id }) {
	if (!id) {
		throw new Error("id required");
	}
	const r = _clarifications.get(id);
	if (!r || r.status !== "pending") {
		return false;
	}
	_clarifications.delete(id);
	return true;
}

function _clone(r) {
	return {
		id: r.id,
		canvasId: r.canvasId,
		workspaceId: r.workspaceId,
		requestingAccountId: r.requestingAccountId,
		requestingTokenId: r.requestingTokenId,
		status: r.status,
		question: r.question,
		options: r.options ? r.options.slice() : null,
		responseText: r.responseText,
		responseOption: r.responseOption,
		createdAt: r.createdAt,
		respondedAt: r.respondedAt,
		respondedByAccountId: r.respondedByAccountId,
		expiresAt: r.expiresAt,
	};
}

function _purgeExpired(now = Date.now()) {
	for (const [id, r] of _clarifications.entries()) {
		if (r.expiresAt != null && r.expiresAt < now) {
			_clarifications.delete(id);
		}
	}
}

const _sweepTimer = setInterval(_purgeExpired, SWEEP_INTERVAL_MS);
if (_sweepTimer.unref) {
	_sweepTimer.unref();
}
