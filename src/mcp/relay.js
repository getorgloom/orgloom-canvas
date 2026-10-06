// In-process bridge between MCP tool calls and the browser that owns an open canvas.
import crypto from 'node:crypto';

const connections = new Map();
const canvasIndex = new Map();
const pendingRequests = new Map();

const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

function _ensureWorkspace(workspaceId) {
	if (!canvasIndex.has(workspaceId)) {
		canvasIndex.set(workspaceId, new Map());
	}
	return canvasIndex.get(workspaceId);
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

export function registerConnection({ accountId, workspaceId, sseRes, mcpActive = false }) {
	const connectionId = crypto.randomUUID();
	connections.set(connectionId, {
		sseRes,
		accountId,
		workspaceId,
		canvasIds: new Set(),
		openedAt: Date.now(),
	});

	_writeSseEvent(sseRes, 'ready', { connectionId, mcpActive: !!mcpActive });

	const keepalive = setInterval(() => {
		try {
			if (sseRes.destroyed || sseRes.writableEnded) {
				clearInterval(keepalive);
				unregisterConnection(connectionId);
				return;
			}
			sseRes.write(': keepalive\n\n');
		} catch (e) {
			clearInterval(keepalive);
			unregisterConnection(connectionId);
		}
	}, 25000);
	sseRes.on('close', () => {
		clearInterval(keepalive);
		unregisterConnection(connectionId);
	});
	sseRes.on('error', () => {
		clearInterval(keepalive);
		unregisterConnection(connectionId);
	});
	return connectionId;
}

export function broadcastMcpAvailability(workspaceId, active) {
	for (const conn of connections.values()) {
		if (conn.workspaceId === workspaceId) {
			_writeSseEvent(conn.sseRes, 'mcp-availability', { active: !!active });
		}
	}
}

export function broadcastCanvasEvent({ workspaceId, canvasId, accountId, event, data = {} }) {
	if (!workspaceId || !canvasId || !accountId || !/^[a-z][a-z0-9-]{0,63}$/.test(String(event || ''))) {
		return 0;
	}
	const ws = canvasIndex.get(workspaceId);
	const entry = ws && ws.get(canvasId);
	if (!entry) {
		return 0;
	}
	let delivered = 0;
	for (const connectionId of entry.connectionIds) {
		const conn = connections.get(connectionId);
		if (
			conn &&
			conn.workspaceId === workspaceId &&
			conn.accountId === accountId &&
			_writeSseEvent(conn.sseRes, event, { ...data, canvasId })
		) {
			delivered += 1;
		}
	}
	return delivered;
}

export function unregisterConnection(connectionId) {
	const conn = connections.get(connectionId);
	if (!conn) {
		return;
	}
	for (const canvasId of conn.canvasIds) {
		const ws = canvasIndex.get(conn.workspaceId);
		if (!ws) {
			continue;
		}
		const entry = ws.get(canvasId);
		if (!entry) {
			continue;
		}
		entry.connectionIds.delete(connectionId);
		entry.metaByConnection.delete(connectionId);
		if (entry.connectionIds.size === 0) {
			ws.delete(canvasId);
		}
		if (ws.size === 0) {
			canvasIndex.delete(conn.workspaceId);
		}
	}
	connections.delete(connectionId);

	for (const [requestId, pending] of pendingRequests.entries()) {
		if (pending.connectionId === connectionId) {
			clearTimeout(pending.timer);
			pending.reject(new Error('relay-connection-dropped'));
			pendingRequests.delete(requestId);
		}
	}
}

export function registerCanvas({ connectionId, canvasId, meta, accountId }) {
	const conn = connections.get(connectionId);
	if (!conn) {
		return false;
	}
	if (accountId !== undefined && conn.accountId !== accountId) {
		return false;
	}
	conn.canvasIds.add(canvasId);
	const ws = _ensureWorkspace(conn.workspaceId);
	let entry = ws.get(canvasId);
	if (!entry) {
		entry = { connectionIds: new Set(), metaByConnection: new Map() };
		ws.set(canvasId, entry);
	}
	entry.connectionIds.add(connectionId);
	entry.metaByConnection.set(connectionId, meta || {});
	return true;
}

export function unregisterCanvas({ connectionId, canvasId, accountId }) {
	const conn = connections.get(connectionId);
	if (!conn) {
		return false;
	}
	if (accountId !== undefined && conn.accountId !== accountId) {
		return false;
	}
	conn.canvasIds.delete(canvasId);
	const ws = canvasIndex.get(conn.workspaceId);
	if (!ws) {
		return false;
	}
	const entry = ws.get(canvasId);
	if (!entry) {
		return false;
	}
	entry.connectionIds.delete(connectionId);
	entry.metaByConnection.delete(connectionId);
	if (entry.connectionIds.size === 0) {
		ws.delete(canvasId);
	}
	if (ws.size === 0) {
		canvasIndex.delete(conn.workspaceId);
	}
	return true;
}

export function listCanvasesInWorkspace(workspaceId, accountId) {
	if (!workspaceId || !accountId) {
		return [];
	}
	const ws = canvasIndex.get(workspaceId);
	if (!ws) {
		return [];
	}
	const result = [];
	for (const [canvasId, entry] of ws.entries()) {
		const ownedConnectionIds = Array.from(entry.connectionIds).filter((connectionId) => {
			const conn = connections.get(connectionId);
			return conn && conn.workspaceId === workspaceId && conn.accountId === accountId;
		});
		if (ownedConnectionIds.length === 0) {
			continue;
		}
		const lastConnectionId = ownedConnectionIds[ownedConnectionIds.length - 1];
		result.push({
			canvasId,
			meta: entry.metaByConnection.get(lastConnectionId) || {},
			liveBrowsers: ownedConnectionIds.length,
		});
	}
	return result;
}

export function hasCanvasForAccount({ workspaceId, canvasId, accountId }) {
	return _pickConnectionForCanvas(workspaceId, canvasId, accountId) !== null;
}

function _pickConnectionForCanvas(workspaceId, canvasId, accountId) {
	if (!workspaceId || !canvasId || !accountId) {
		return null;
	}
	const ws = canvasIndex.get(workspaceId);
	if (!ws) {
		return null;
	}
	const entry = ws.get(canvasId);
	if (!entry || entry.connectionIds.size === 0) {
		return null;
	}
	let last = null;
	for (const id of entry.connectionIds) {
		const conn = connections.get(id);
		if (conn && conn.workspaceId === workspaceId && conn.accountId === accountId) {
			last = id;
		}
	}
	return last;
}

export function dispatchRequest({ workspaceId, canvasId, accountId, method, params, timeoutMs }) {
	// Requests are bound to one workspace/canvas connection and fail closed when no live browser answers.
	const connectionId = _pickConnectionForCanvas(workspaceId, canvasId, accountId);
	if (!connectionId) {
		return Promise.reject(new Error('no-live-browser-for-canvas'));
	}
	const conn = connections.get(connectionId);
	if (!conn) {
		return Promise.reject(new Error('no-live-browser-for-canvas'));
	}
	const requestId = crypto.randomUUID();
	const timeout = typeof timeoutMs === 'number' ? timeoutMs : DEFAULT_REQUEST_TIMEOUT_MS;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pendingRequests.delete(requestId);
			reject(new Error('relay-request-timeout'));
		}, timeout);
		pendingRequests.set(requestId, {
			resolve,
			reject,
			timer,
			connectionId,
			canvasId,
		});
		_writeSseEvent(conn.sseRes, 'request', {
			requestId,
			method,
			canvasId,
			params: params || {},
		});
	});
}

export function recordResponse({ connectionId, requestId, result, error, accountId }) {
	// Only the connection that received a request may resolve its pending promise.
	const pending = pendingRequests.get(requestId);
	if (!pending) {
		return false;
	}

	if (pending.connectionId !== connectionId) {
		return false;
	}
	if (accountId !== undefined) {
		const conn = connections.get(connectionId);
		if (!conn || conn.accountId !== accountId) {
			return false;
		}
	}

	clearTimeout(pending.timer);
	pendingRequests.delete(requestId);
	if (error) {
		pending.reject(new Error(error));
	} else {
		pending.resolve(result);
	}
	return true;
}

export function purgeWorkspace(workspaceId) {
	const ws = canvasIndex.get(workspaceId);
	if (!ws) {
		return 0;
	}
	let removed = 0;
	for (const [canvasId, entry] of ws.entries()) {
		for (const connectionId of entry.connectionIds) {
			const conn = connections.get(connectionId);
			if (conn) {
				conn.canvasIds.delete(canvasId);
			}
		}
		entry.connectionIds.clear();
		entry.metaByConnection.clear();
		removed++;
	}
	canvasIndex.delete(workspaceId);

	for (const [requestId, pending] of pendingRequests.entries()) {
		const conn = connections.get(pending.connectionId);
		if (conn && conn.workspaceId === workspaceId) {
			clearTimeout(pending.timer);
			pending.reject(new Error('relay-workspace-purged'));
			pendingRequests.delete(requestId);
		}
	}
	return removed;
}

export function workspaceLiveSummary(workspaceId, accountId) {
	const rows = listCanvasesInWorkspace(workspaceId, accountId);
	const distinctConnections = new Set();
	for (const row of rows) {
		const ws = canvasIndex.get(workspaceId);
		if (!ws) {
			continue;
		}
		const entry = ws.get(row.canvasId);
		if (!entry) {
			continue;
		}
		for (const id of entry.connectionIds) {
			const conn = connections.get(id);
			if (conn && conn.accountId === accountId) {
				distinctConnections.add(id);
			}
		}
	}
	return {
		canvasCount: rows.length,
		browserCount: distinctConnections.size,
		canvases: rows.map((r) => ({
			canvasId: r.canvasId,
			title: r.meta.title || null,
			ownerSfUserId: r.meta.ownerSfUserId || null,
			liveBrowsers: r.liveBrowsers,
		})),
	};
}
