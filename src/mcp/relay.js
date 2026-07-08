import crypto from "node:crypto";

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
			res.write("event: " + event + "\n");
		}
		res.write("data: " + JSON.stringify(data) + "\n\n");
	} catch (e) {

	}
}

export function registerConnection({ accountId, workspaceId, sseRes }) {
	const connectionId = crypto.randomUUID();
	connections.set(connectionId, {
		sseRes,
		accountId,
		workspaceId,
		canvasIds: new Set(),
		openedAt: Date.now(),
	});

	_writeSseEvent(sseRes, "ready", { connectionId });

	const keepalive = setInterval(() => {
		try {
			sseRes.write(": keepalive\n\n");
		} catch (e) {

		}
	}, 25000);
	sseRes.on("close", () => {
		clearInterval(keepalive);
		unregisterConnection(connectionId);
	});
	return connectionId;
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
			pending.reject(new Error("relay-connection-dropped"));
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
		entry = { connectionIds: new Set(), meta: meta || {} };
		ws.set(canvasId, entry);
	} else if (meta) {
		entry.meta = meta;
	}
	entry.connectionIds.add(connectionId);
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
	if (entry.connectionIds.size === 0) {
		ws.delete(canvasId);
	}
	if (ws.size === 0) {
		canvasIndex.delete(conn.workspaceId);
	}
	return true;
}

export function listCanvasesInWorkspace(workspaceId) {
	const ws = canvasIndex.get(workspaceId);
	if (!ws) {
		return [];
	}
	const result = [];
	for (const [canvasId, entry] of ws.entries()) {
		result.push({
			canvasId,
			meta: entry.meta || {},
			liveBrowsers: entry.connectionIds.size,
		});
	}
	return result;
}

function _pickConnectionForCanvas(workspaceId, canvasId) {
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
		last = id;
	}
	return last;
}

export function dispatchRequest({
	workspaceId,
	canvasId,
	method,
	params,
	timeoutMs,
}) {
	const connectionId = _pickConnectionForCanvas(workspaceId, canvasId);
	if (!connectionId) {
		return Promise.reject(new Error("no-live-browser-for-canvas"));
	}
	const conn = connections.get(connectionId);
	if (!conn) {
		return Promise.reject(new Error("no-live-browser-for-canvas"));
	}
	const requestId = crypto.randomUUID();
	const timeout =
		typeof timeoutMs === "number" ? timeoutMs : DEFAULT_REQUEST_TIMEOUT_MS;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pendingRequests.delete(requestId);
			reject(new Error("relay-request-timeout"));
		}, timeout);
		pendingRequests.set(requestId, {
			resolve,
			reject,
			timer,
			connectionId,
			canvasId,
		});
		_writeSseEvent(conn.sseRes, "request", {
			requestId,
			method,
			canvasId,
			params: params || {},
		});
	});
}

export function recordResponse({ connectionId, requestId, result, error, accountId }) {
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
		removed++;
	}
	canvasIndex.delete(workspaceId);

	for (const [requestId, pending] of pendingRequests.entries()) {
		const conn = connections.get(pending.connectionId);
		if (conn && conn.workspaceId === workspaceId) {
			clearTimeout(pending.timer);
			pending.reject(new Error("relay-workspace-purged"));
			pendingRequests.delete(requestId);
		}
	}
	return removed;
}

export function workspaceLiveSummary(workspaceId) {
	const rows = listCanvasesInWorkspace(workspaceId);
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
			distinctConnections.add(id);
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
