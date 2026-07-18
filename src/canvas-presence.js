// Ephemeral in-process collaboration state. Presence is never a durable source of canvas truth.
import crypto from 'node:crypto';

const _presenceByCanvas = new Map();

const IDLE_THRESHOLD_MS = 90 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
export const MAX_PRESENCE_FIELDS = 100;
export const MAX_PRESENCE_PAYLOAD_BYTES = 64 * 1024;

const _COLOR_PALETTE = [
	'#e09240', // accent orange (brand)
	'#6fa9d6', // info blue
	'#7ac96a', // success green
	'#d36fb0', // pink
	'#9d7fd3', // purple
	'#e0a048', // warm amber
	'#5fbfbf', // teal
	'#d36f6f', // coral
];

function _pickColor(canvasState) {
	const used = new Set();
	for (const entry of canvasState.values()) {
		used.add(entry.color);
	}
	for (const c of _COLOR_PALETTE) {
		if (!used.has(c)) {
			return c;
		}
	}
	const idx = canvasState.size % _COLOR_PALETTE.length;
	return _COLOR_PALETTE[idx];
}

function _writeSseEvent(res, event, data) {
	try {
		if (event) {
			res.write('event: ' + event + '\n');
		}
		res.write('data: ' + JSON.stringify(data) + '\n\n');
		return true;
	} catch (e) {
		return false;
	}
}

function _ownsConnection(entry, requestingAccountId) {
	if (!requestingAccountId) {
		return false;
	}
	return entry.accountId === requestingAccountId;
}

function _acceptSequence(entry, sequence) {
	// Ignore out-of-order browser events so a delayed cursor or draft cannot overwrite newer state.
	if (!Number.isSafeInteger(sequence) || sequence <= entry.lastSequence) {
		return false;
	}
	entry.lastSequence = sequence;
	return true;
}

function _toPeerPayload(entry) {
	return {
		connectionId: entry.connectionId,
		accountId: entry.accountId,
		displayName: entry.displayName,
		color: entry.color,
		cursor: entry.cursor,
		focus: entry.focus,
	};
}

function _broadcast(canvasId, payload, excludeConnId) {
	const conns = _presenceByCanvas.get(canvasId);
	if (!conns) {
		return 0;
	}
	let delivered = 0;
	for (const [connId, entry] of conns.entries()) {
		if (connId === excludeConnId) {
			continue;
		}
		if (_writeSseEvent(entry.sseRes, 'presence', payload)) {
			delivered++;
		}
	}
	return delivered;
}

export function subscribe({ canvasId, workspaceId, accountId, displayName, canEdit = true, sseRes }) {
	// Workspace identity is captured at subscription time and checked by every later mutation.
	if (!canvasId || !workspaceId || !accountId || !sseRes) {
		throw new Error('subscribe: missing required field');
	}
	if (!_presenceByCanvas.has(canvasId)) {
		_presenceByCanvas.set(canvasId, new Map());
	}
	const conns = _presenceByCanvas.get(canvasId);
	const connectionId = crypto.randomUUID();
	const color = _pickColor(conns);
	const entry = {
		connectionId,
		workspaceId,
		accountId,
		displayName: displayName || 'Someone',
		canEdit: !!canEdit,
		color,
		cursor: null,
		focus: null,
		lastSeenAt: Date.now(),
		lastSequence: 0,
		sseRes,
	};
	const peers = [];
	for (const other of conns.values()) {
		peers.push(_toPeerPayload(other));
	}
	conns.set(connectionId, entry);
	_writeSseEvent(sseRes, 'presence-init', {
		you: _toPeerPayload(entry),
		peers,
	});
	const keepalive = setInterval(() => {
		try {
			if (sseRes.destroyed || sseRes.writableEnded) {
				clearInterval(keepalive);
				unsubscribe({ canvasId, connectionId });
				return;
			}
			sseRes.write(': keepalive\n\n');
			// The open SSE stream, rather than cursor traffic, proves this browser is still present.
			entry.lastSeenAt = Date.now();
		} catch (e) {
			clearInterval(keepalive);
			unsubscribe({ canvasId, connectionId });
		}
	}, 25 * 1000);
	entry.keepalive = keepalive;
	sseRes.on('close', () => {
		clearInterval(keepalive);
		unsubscribe({ canvasId, connectionId });
	});
	sseRes.on('error', () => {
		clearInterval(keepalive);
		unsubscribe({ canvasId, connectionId });
	});
	_broadcast(canvasId, { type: 'join', peer: _toPeerPayload(entry) }, connectionId);
	return connectionId;
}

export function unsubscribe({ canvasId, connectionId }) {
	const conns = _presenceByCanvas.get(canvasId);
	if (!conns) {
		return false;
	}
	const entry = conns.get(connectionId);
	if (!entry) {
		return false;
	}
	if (entry.keepalive) {
		clearInterval(entry.keepalive);
	}
	conns.delete(connectionId);
	if (conns.size === 0) {
		_presenceByCanvas.delete(canvasId);
	}
	_broadcast(canvasId, { type: 'leave', connectionId }, connectionId);
	return true;
}

export function updateCursor({ canvasId, connectionId, x, y, world, sequence, requestingAccountId }) {
	const conns = _presenceByCanvas.get(canvasId);
	if (!conns) {
		return false;
	}
	const entry = conns.get(connectionId);
	if (!entry) {
		return false;
	}
	if (!_ownsConnection(entry, requestingAccountId)) {
		return false;
	}
	if (!_acceptSequence(entry, sequence)) {
		return false;
	}
	const cx = typeof x === 'number' ? x : null;
	const cy = typeof y === 'number' ? y : null;
	entry.cursor = cx == null || cy == null ? null : { x: cx, y: cy, world: !!world };
	entry.lastSeenAt = Date.now();
	_broadcast(
		canvasId,
		{
			type: 'cursor',
			connectionId,
			cursor: entry.cursor,
		},
		connectionId,
	);
	return true;
}

export function updateDraft({
	canvasId,
	connectionId,
	tempId,
	fields,
	kind,
	objectName,
	x,
	y,
	position,
	sequence,
	requestingAccountId,
}) {
	const conns = _presenceByCanvas.get(canvasId);
	if (!conns) {
		return false;
	}
	const entry = conns.get(connectionId);
	if (!entry) {
		return false;
	}
	if (!_ownsConnection(entry, requestingAccountId)) {
		return false;
	}
	if (!entry.canEdit) {
		return false;
	}
	if (!_acceptSequence(entry, sequence)) {
		return false;
	}
	if (tempId == null) {
		return false;
	}
	if (!fields || typeof fields !== 'object') {
		return false;
	}
	const keys = Object.keys(fields);
	if (keys.length > MAX_PRESENCE_FIELDS || keys.some((key) => !/^[A-Za-z][A-Za-z0-9_]*$/.test(key))) {
		return false;
	}
	if (Buffer.byteLength(JSON.stringify(fields), 'utf8') > MAX_PRESENCE_PAYLOAD_BYTES) {
		return false;
	}
	entry.lastSeenAt = Date.now();
	const payload = {
		type: 'draft-update',
		connectionId,
		tempId,
		fields,
	};
	if (kind === 'create') {
		payload.kind = 'create';
		if (typeof objectName === 'string') {
			payload.objectName = objectName;
		}
		if (typeof x === 'number') {
			payload.x = x;
		}
		if (typeof y === 'number') {
			payload.y = y;
		}
	} else if (kind === 'remove') {
		payload.kind = 'remove';
	}
	if (position && typeof position === 'object' && typeof position.x === 'number' && typeof position.y === 'number') {
		payload.position = { x: position.x, y: position.y };
	}
	_broadcast(canvasId, payload, connectionId);
	return true;
}

export function updateDraftLink({
	canvasId,
	connectionId,
	kind,
	fromSyncId,
	toSyncId,
	fieldName,
	sequence,
	requestingAccountId,
}) {
	const conns = _presenceByCanvas.get(canvasId);
	if (!conns) {
		return false;
	}
	const entry = conns.get(connectionId);
	if (!entry) {
		return false;
	}
	if (!_ownsConnection(entry, requestingAccountId)) {
		return false;
	}
	if (!entry.canEdit) {
		return false;
	}
	if (!_acceptSequence(entry, sequence)) {
		return false;
	}
	if (kind !== 'add' && kind !== 'remove') {
		return false;
	}
	if (!fromSyncId || !toSyncId || !fieldName) {
		return false;
	}
	entry.lastSeenAt = Date.now();
	_broadcast(
		canvasId,
		{
			type: 'draft-link',
			connectionId,
			kind,
			fromSyncId: String(fromSyncId),
			toSyncId: String(toSyncId),
			fieldName: String(fieldName),
		},
		connectionId,
	);
	return true;
}

export function removeLoadedRecord({ canvasId, connectionId, sfId, sequence, requestingAccountId }) {
	const conns = _presenceByCanvas.get(canvasId);
	if (!conns) {
		return false;
	}
	const entry = conns.get(connectionId);
	if (!entry) {
		return false;
	}
	if (!_ownsConnection(entry, requestingAccountId)) {
		return false;
	}
	if (!entry.canEdit) {
		return false;
	}
	if (!_acceptSequence(entry, sequence)) {
		return false;
	}
	if (!sfId) {
		return false;
	}
	entry.lastSeenAt = Date.now();
	_broadcast(
		canvasId,
		{
			type: 'loaded-removed',
			connectionId,
			sfId: String(sfId),
		},
		connectionId,
	);
	return true;
}

export function updateFocus({ canvasId, connectionId, focus, sequence, requestingAccountId }) {
	const conns = _presenceByCanvas.get(canvasId);
	if (!conns) {
		return false;
	}
	const entry = conns.get(connectionId);
	if (!entry) {
		return false;
	}
	if (!_ownsConnection(entry, requestingAccountId)) {
		return false;
	}
	if (!_acceptSequence(entry, sequence)) {
		return false;
	}
	entry.focus = focus || null;
	entry.lastSeenAt = Date.now();
	_broadcast(
		canvasId,
		{
			type: 'focus',
			connectionId,
			focus: entry.focus,
		},
		connectionId,
	);
	return true;
}

export function broadcastCanvasSaved({ canvasId, savedByAccountId, savedByDisplayName, versionId, title }) {
	if (!canvasId) {
		return 0;
	}
	return _broadcast(
		canvasId,
		{
			type: 'canvas-saved',
			savedByAccountId: savedByAccountId || null,
			savedByDisplayName: savedByDisplayName || 'Someone',
			versionId: versionId || null,
			title: title || null,
			at: Date.now(),
		},
		null,
	);
}

export function summary({ canvasId }) {
	const conns = _presenceByCanvas.get(canvasId);
	if (!conns) {
		return { count: 0 };
	}
	return { count: conns.size };
}

export function purgeAccountFromWorkspace({ workspaceId, accountId }) {
	let removed = 0;
	for (const [canvasId, conns] of _presenceByCanvas.entries()) {
		for (const entry of [...conns.values()]) {
			if (entry.workspaceId === workspaceId && entry.accountId === accountId) {
				if (unsubscribe({ canvasId, connectionId: entry.connectionId })) {
					removed++;
				}
			}
		}
	}
	return removed;
}

export function purgeWorkspace({ workspaceId }) {
	let removed = 0;
	for (const [canvasId, conns] of _presenceByCanvas.entries()) {
		for (const entry of [...conns.values()]) {
			if (entry.workspaceId === workspaceId) {
				if (unsubscribe({ canvasId, connectionId: entry.connectionId })) {
					removed++;
				}
			}
		}
	}
	return removed;
}

function _sweep() {
	// Idle peers disappear even when a browser vanishes without closing its SSE connection cleanly.
	const now = Date.now();
	for (const [canvasId, conns] of _presenceByCanvas.entries()) {
		for (const [connectionId, entry] of conns.entries()) {
			if (now - entry.lastSeenAt > IDLE_THRESHOLD_MS) {
				conns.delete(connectionId);
				_broadcast(canvasId, { type: 'leave', connectionId }, connectionId);
			}
		}
		if (conns.size === 0) {
			_presenceByCanvas.delete(canvasId);
		}
	}
}

const _sweepTimer = setInterval(_sweep, SWEEP_INTERVAL_MS);
if (_sweepTimer.unref) {
	_sweepTimer.unref();
}
