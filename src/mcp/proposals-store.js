import crypto from 'node:crypto';

// Ephemeral proposal queue; accepted changes still require a live browser canvas to apply.

const SWEEP_INTERVAL_MS = 30 * 60 * 1000;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const TERMINAL_TTL_MS = 60 * 60 * 1000;

const _proposals = new Map();

function _shape({ id, canvasId, workspaceId, proposingAccountId, proposingTokenId, changes, summary, createdAt }) {
	return {
		id,
		canvasId,
		workspaceId,
		proposingAccountId,
		proposingTokenId: proposingTokenId || null,
		status: 'pending',
		changes: changes.slice(),
		summary: summary ? String(summary).slice(0, 500) : null,
		createdAt,
		decidedAt: null,
		decidedByAccountId: null,
		outcome: null,
		applyMode: null,
	};
}

export async function create({ canvasId, workspaceId, proposingAccountId, proposingTokenId, changes, summary }) {
	if (!canvasId) {
		throw new Error('canvasId required');
	}
	if (!workspaceId) {
		throw new Error('workspaceId required');
	}
	if (!proposingAccountId) {
		throw new Error('proposingAccountId required');
	}
	if (!Array.isArray(changes) || changes.length === 0) {
		throw new Error('changes must be a non-empty array');
	}
	const id = 'prop_' + crypto.randomUUID();
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
		if (r.canvasId === canvasId && r.status === 'pending') {
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

export async function markApplied({ id, decidedByAccountId, outcome, applyMode }) {
	if (!id) {
		throw new Error('id required');
	}
	const r = _proposals.get(id);
	if (!r || r.status !== 'pending') {
		return false;
	}
	r.status = 'applied';
	r.decidedAt = Date.now();
	r.decidedByAccountId = decidedByAccountId || null;
	r.outcome = Array.isArray(outcome) ? outcome.map(_cloneChange) : null;
	r.applyMode = applyMode || null;
	r.changes = [];
	r.summary = null;
	return true;
}

export async function markRejected({ id, decidedByAccountId }) {
	if (!id) {
		throw new Error('id required');
	}
	const r = _proposals.get(id);
	if (!r || r.status !== 'pending') {
		return false;
	}
	r.status = 'rejected';
	r.decidedAt = Date.now();
	r.decidedByAccountId = decidedByAccountId || null;
	r.changes = [];
	r.summary = null;
	return true;
}

export async function markWithdrawn({ id, decidedByAccountId }) {
	if (!id) {
		throw new Error('id required');
	}
	const r = _proposals.get(id);
	if (!r || r.status !== 'pending') {
		return false;
	}
	r.status = 'withdrawn';
	r.decidedAt = Date.now();
	r.decidedByAccountId = decidedByAccountId || null;
	r.changes = [];
	r.summary = null;
	return true;
}

function _cloneChange(value) {
	return value && typeof value === 'object' ? Object.assign({}, value) : value;
}

function _clone(r) {
	return {
		id: r.id,
		canvasId: r.canvasId,
		workspaceId: r.workspaceId,
		proposingAccountId: r.proposingAccountId,
		proposingTokenId: r.proposingTokenId,
		status: r.status,
		changes: r.changes.map(_cloneChange),
		summary: r.summary,
		createdAt: r.createdAt,
		decidedAt: r.decidedAt,
		decidedByAccountId: r.decidedByAccountId,
		outcome: Array.isArray(r.outcome) ? r.outcome.map(_cloneChange) : null,
		applyMode: r.applyMode || null,
	};
}
function _purgeOrphans(now = Date.now()) {
	for (const [id, r] of _proposals.entries()) {
		const age = now - (r.status === 'pending' ? r.createdAt : r.decidedAt || r.createdAt);
		const ttl = r.status === 'pending' ? PENDING_TTL_MS : TERMINAL_TTL_MS;
		if (age > ttl) {
			_proposals.delete(id);
		}
	}
}

const _sweepTimer = setInterval(_purgeOrphans, SWEEP_INTERVAL_MS);
if (_sweepTimer.unref) {
	_sweepTimer.unref();
}
