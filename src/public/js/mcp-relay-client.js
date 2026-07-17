
// Browser-side relay client for the MCP "browser is the cache" model.
//
// What this does:
//   * Opens a long-lived SSE connection to /api/mcp/relay/listen.
//   * When app.js fires the orgloom:canvas-loaded event, POSTs the
//     canvasId + minimal metadata to /api/mcp/relay/register so the
//     server's MCP read tools know which canvases this browser hosts.
//   * Receives 'request' SSE events from the server (sent when an AI
//     client called read_canvas), calls into app.js for a payload
//     snapshot, POSTs the result back to /api/mcp/relay/respond.
//   * On orgloom:canvas-unloaded, POSTs /api/mcp/relay/unregister so
//     the AI loses access without waiting for the tab to close.
//   * On tab close, the SSE connection ends and the server's onClose
//     handler does the cleanup: no beacon required.
//
// Why this file exists separately from app.js:
//   The relay protocol is self-contained; it doesn't know anything
//   about cytoscape, drafts, or schema. It only needs hook points
//   (window.Orgloom.canvasState.snapshot(), canvas-loaded /
//   canvas-unloaded custom events). Keeping it out of app.js means
//   the protocol can evolve (heartbeats, batching, multi-canvas
//   snapshots, etc.) without churning the canvas UI code.

(function () {
	'use strict';

	// Only run on the canvas page where app.js mounts. Other pages
	// (workspace settings, docs, etc.) include this script via
	// top-strip.ejs but have no canvas state to relay.
	if (!document.getElementById('app-root')) {
return;
}
	// Playground/demo mode: never open the relay. EventSource bypasses the
	// mock-sf fetch interceptor, so this would be a REAL credentialed SSE
	// to /api/mcp/relay/listen: an endless 401→auto-reconnect loop for
	// anonymous visitors, and a live relay registration under a signed-in
	// visitor's real account from a demo page. There's no MCP in the demo.
	if (window.ORGLOOM_MOCK) {
return;
}

	function csrfFetch(url, options) {
		options = options || {};
		const method = (options.method || 'GET').toUpperCase();
		if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
			const meta = document.querySelector('meta[name="csrf-token"]');
			const token = meta ? meta.getAttribute('content') : '';
			options.headers = Object.assign({}, options.headers || {}, {
				'x-csrf-token': token,
				'content-type': 'application/json',
			});
		}
		if (!('credentials' in options)) {
options.credentials = 'same-origin';
}
		return globalThis.fetch(url, options);
	}

	let _connectionId = null;
	let _registeredCanvasId = null;
	let _eventSource = null;
	// Reconnect backoff. SSE auto-reconnects via EventSource's built-in
	// retry, but we still track failures so a totally-down server
	// surfaces clearly in the console rather than silently flapping.
	let _connectAttempts = 0;

	function _log(...args) {
		// Gated by a localStorage flag so users can debug if needed
		// without spamming the console for everyone.
		try {
			if (localStorage.getItem('orgloomRelayDebug') === '1') {
				console.log('[mcp-relay]', ...args);
			}
		} catch (e) { /* private mode etc. */ }
	}

	function _connect() {
		if (_eventSource) {
return;
}
		_connectAttempts++;
		_log('opening SSE (attempt ' + _connectAttempts + ')');
		_eventSource = new EventSource('/api/mcp/relay/listen', { withCredentials: true });
		_eventSource.addEventListener('ready', (ev) => {
			try {
				const data = JSON.parse(ev.data);
				_connectionId = data.connectionId;
				_connectAttempts = 0;
				_log('connected, connectionId=' + _connectionId);
				// If a canvas was already loaded before the SSE
				// connection completed, register it now.
				_maybeRegisterCurrent();
			} catch (e) {
 _log('bad ready payload:', e); 
}
		});
		_eventSource.addEventListener('request', (ev) => {
			let data;
			try {
 data = JSON.parse(ev.data); 
} catch (e) {
 _log('bad request payload:', e); return; 
}
			_handleRequest(data);
		});
		_eventSource.onerror = (err) => {
			_log('SSE error, will auto-retry:', err);
			// EventSource auto-reconnects. We only null out our
			// reference if the readyState transitioned to CLOSED so
			// our _connect()-is-idempotent guard works.
			if (_eventSource && _eventSource.readyState === EventSource.CLOSED) {
				_eventSource = null;
				_connectionId = null;
			}
		};
	}

	async function _handleRequest({ requestId, method, canvasId, params }) {
		_log('handle request:', method, canvasId, requestId);
		try {
			let result;
			if (method === 'read_canvas') {
				const snap = window.Orgloom && window.Orgloom.canvasState && window.Orgloom.canvasState.snapshot;
				if (typeof snap !== 'function') {
					return _postResponse(requestId, null, 'canvas-snapshot-not-available');
				}
				if (canvasId !== _registeredCanvasId) {
					// Race: server asked for a canvas this tab no
					// longer hosts. Tell the relay so the MCP tool
					// returns NOT_FOUND instead of hanging.
					return _postResponse(requestId, null, 'canvas-not-registered-here');
				}
				result = snap({ canvasId });
			} else if (method === 'describe_object') {
				// Cache-only lookup. canvasState.describeObject MUST
				// NOT trigger a fresh SF call; see the comment on the
				// canvasState method for why. A cache miss returns
				// {cacheMiss: true} which the MCP server surfaces to
				// the AI as a clean NOT_FOUND.
				const dsc = window.Orgloom && window.Orgloom.canvasState && window.Orgloom.canvasState.describeObject;
				if (typeof dsc !== 'function') {
					return _postResponse(requestId, null, 'describe-not-available');
				}
				result = dsc(params || {});
			} else {
				return _postResponse(requestId, null, 'unknown-method:' + method);
			}
			await _postResponse(requestId, result, null);
		} catch (err) {
			_log('request handler error:', err);
			await _postResponse(requestId, null, (err && err.message) || 'handler-error');
		}
	}

	async function _postResponse(requestId, result, error) {
		if (!_connectionId) {
return;
}
		try {
			await csrfFetch('/api/mcp/relay/respond', {
				method: 'POST',
				body: JSON.stringify({ connectionId: _connectionId, requestId, result, error }),
			});
		} catch (e) {
 _log('respond POST failed:', e); 
}
	}

	async function _register(canvasId, meta) {
		if (!_connectionId) {
return;
}
		_registeredCanvasId = canvasId;
		try {
			await csrfFetch('/api/mcp/relay/register', {
				method: 'POST',
				body: JSON.stringify({ connectionId: _connectionId, canvasId, meta: meta || {} }),
			});
			_log('registered canvas', canvasId);
		} catch (e) {
 _log('register POST failed:', e); 
}
	}

	async function _unregister(canvasId) {
		if (!_connectionId || !canvasId) {
return;
}
		if (_registeredCanvasId === canvasId) {
_registeredCanvasId = null;
}
		try {
			await csrfFetch('/api/mcp/relay/unregister', {
				method: 'POST',
				body: JSON.stringify({ connectionId: _connectionId, canvasId }),
			});
			_log('unregistered canvas', canvasId);
		} catch (e) {
 _log('unregister POST failed:', e); 
}
	}

	// If app.js loaded a canvas before our SSE was ready, query it
	// directly rather than relying on the (already-fired-and-missed)
	// canvas-loaded event. Belt-and-suspenders: also stash a pending
	// load if the event arrives before the SSE is up.
	let _pendingLoad = null;
	function _maybeRegisterCurrent() {
		// Hidden tabs don't register at all: AI shouldn't see
		// background canvases. The visibilitychange handler below
		// will re-trigger this path when the tab is brought to the
		// foreground.
		if (document.visibilityState !== 'visible') {
return;
}
		if (_pendingLoad) {
			_register(_pendingLoad.canvasId, _pendingLoad.meta);
			_pendingLoad = null;
			return;
		}
		const cs = window.Orgloom && window.Orgloom.canvasState;
		if (cs && typeof cs.getCurrentCanvas === 'function') {
			const c = cs.getCurrentCanvas();
			if (c && c.canvasId) {
_register(c.canvasId, c.meta || {});
}
		}
	}

	window.addEventListener('orgloom:canvas-loaded', (ev) => {
		const detail = ev.detail || {};
		if (!detail.canvasId) {
return;
}
		_syncRegistration(detail.canvasId, detail.meta || {});
	});

	window.addEventListener('orgloom:canvas-unloaded', (ev) => {
		const detail = ev.detail || {};
		const cid = detail.canvasId || _registeredCanvasId;
		if (cid) {
_unregister(cid);
}
		_pendingLoad = null;
	});

	function _syncRegistration(canvasId, meta) {
		// Visibility gate: only register when this tab is visible to
		// the user. The product principle is "AI sees what I'm
		// looking at"; a background tab isn't being looked at, so
		// its canvas shouldn't be in list_canvases. When the user
		// switches tabs, the visibilitychange handler below will
		// re-register the now-visible tab + drop the now-hidden one.
		if (document.visibilityState !== 'visible') {
			if (_registeredCanvasId) {
_unregister(_registeredCanvasId);
}
			return;
		}
		// Always-register-most-recent: if a different canvas was
		// previously registered, unregister it first so list_canvases
		// only surfaces what's actually open.
		if (_registeredCanvasId && _registeredCanvasId !== canvasId) {
			_unregister(_registeredCanvasId);
		}
		if (!_connectionId) {
			_pendingLoad = { canvasId, meta: meta || {} };
			return;
		}
		if (_registeredCanvasId !== canvasId) {
			_register(canvasId, meta || {});
		}
	}

	// Re-sync whenever the tab's visibility changes. Switching tabs
	// or apps fires visibilitychange; we drop the registration when
	// hidden and re-add it when visible again. This is what makes
	// AI's list_canvases only show the canvas the user is currently
	// looking at, not every open Orgloom tab.
	document.addEventListener('visibilitychange', () => {
		const cs = window.Orgloom && window.Orgloom.canvasState;
		if (!cs || typeof cs.getCurrentCanvas !== 'function') {
return;
}
		if (document.visibilityState === 'visible') {
			const current = cs.getCurrentCanvas();
			if (current && current.canvasId) {
				_syncRegistration(current.canvasId, current.meta);
			}
		} else if (_registeredCanvasId) {
			_unregister(_registeredCanvasId);
		}
	});

	// Polling fallback for canvas-change detection. app.js has many
	// currentCanvas assignment sites (load, save, share-open, replace,
	// etc.) and wiring an event-fire at each is invasive + easy to
	// miss. A 2s poll against window.Orgloom.canvasState.getCurrentCanvas()
	// catches every change cheaply. The custom events above are a
	// best-effort fast-path so the registration usually updates before
	// the next AI tool call lands. _syncRegistration itself enforces
	// the visibility gate, so a hidden tab's poll won't (re-)register.
	setInterval(() => {
		const cs = window.Orgloom && window.Orgloom.canvasState;
		if (!cs || typeof cs.getCurrentCanvas !== 'function') {
return;
}
		if (document.visibilityState !== 'visible') {
			if (_registeredCanvasId) {
_unregister(_registeredCanvasId);
}
			return;
		}
		const current = cs.getCurrentCanvas();
		if (current && current.canvasId) {
			if (current.canvasId !== _registeredCanvasId) {
				_syncRegistration(current.canvasId, current.meta);
			}
		} else if (_registeredCanvasId) {
			_unregister(_registeredCanvasId);
		}
	}, 2000);

	_connect();
})();
