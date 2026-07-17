// Real-time canvas presence: client side of Phase 1 collab.
//
// On canvas load, opens an SSE channel at /api/canvas/:id/presence/subscribe
// to receive join/leave/cursor events for other tabs viewing the same
// canvas in the same workspace. Tracks the mouse position over the
// cytoscape container and posts cursor updates (throttled) to
// /api/canvas/:id/presence/cursor.
//
// Renders two surfaces:
//   1. Peer cursors as small colored markers floating over the canvas,
//      positioned in canvas-local coordinates. Pan/zoom changes apply
//      to the marker layer in the same transform the cy graph uses, so
//      cursors stay aligned with what each peer is actually pointing at.
//   2. A presence chip strip in the top-bar showing initials of each
//      peer, colored to match their cursor.
//
// Posture invariant: this module SENDS only cursor xy coordinates +
// focus refs (record ids, not values). It RECEIVES only peer identity
// metadata + their cursor xy. No Salesforce record values flow over
// this channel in either direction.
//
// Dependencies passed to mount():
//   canvasState  - shared canvas state. Reads currentCanvas.id (or
//                  the draft canvas id) for the active canvas.
//   csrfFetch    - fetch wrapper with CSRF header.
//   escapeHtml   - HTML escape utility.
//   getGraph     - () => Element; canvas root.
//
// Public API (returned from mount):
//   subscribeToCanvas(canvasId)  - open SSE for this canvas. Idempotent;
//                                  swaps to a new canvas cleanly.
//   unsubscribe()                - close SSE + clear UI.
//   pushFocus(focus)             - tell peers what record/panel we're
//                                  looking at. focus = null | { kind, ref }.
//
// Exposed as window.OrgLoom.presence. Load order: before app.js.

(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.presence = {
		mount: function mount(deps) {
			const _required = ['canvasState', 'csrfFetch', 'escapeHtml', 'getGraph', 'getCyInstance',
				'isCanvasDirty', 'reloadCanvasFromServer', 'showBulkToast', 'renderBulkView',
				'addToSelection'];
			for (const k of _required) {
				if (deps == null || deps[k] == null) {
					throw new Error('presence.mount: missing required dep: ' + k);
				}
			}
			const canvasState = deps.canvasState;
			const csrfFetch = deps.csrfFetch;
			const escapeHtml = deps.escapeHtml;
			const getGraph = deps.getGraph;
			const getCyInstance = deps.getCyInstance;
			const isCanvasDirty = deps.isCanvasDirty;
			const reloadCanvasFromServer = deps.reloadCanvasFromServer;
			const showBulkToast = deps.showBulkToast;
			const renderBulkView = deps.renderBulkView;
			const addToSelection = deps.addToSelection;

			// SSE + state
			let _eventSource = null;
			let _myConnectionId = null;
			let _currentCanvasId = null;
			let _outboundSequence = 0;
			function _nextSequence() {
 _outboundSequence += 1; return _outboundSequence; 
}
			const _peers = new Map();

			// DOM containers, lazy-created on first subscribe so they
			// don't appear until the canvas is loaded.
			let _cursorLayer = null;
			let _presenceChips = null;

			// Throttle the cursor POST so we don't fire 60 requests per
			// second on a fast mousemove. 50ms throttle = up to 20 ups,
			// which is comparable to Figma's stream rate while keeping
			// server load minimal.
			let _lastCursorPostAt = 0;
			// 100ms = 10 Hz cursor update rate. Comparable to Figma's
			// stream cadence, visually smooth, and stays well under
			// the global IP rate limiter even with multiple tabs on the
			// same network. The presence routes also skip the global
			// limiter (see apps/saas/src/server.js _isPresencePath),
			// but throttling client-side reduces wasted work regardless.
			const CURSOR_THROTTLE_MS = 100;
			let _pendingCursorAbort = null;

			function _resolveCanvasId() {
				if (canvasState.currentCanvas && canvasState.currentCanvas.id) {
return canvasState.currentCanvas.id;
}
				// Drafts: app exposes the in-memory draft id elsewhere
				// (same pattern as ai-proposals.js). The presence channel
				// works for drafts too: same workspace, just a different
				// id namespace.
				const cs = window.Orgloom && window.Orgloom.canvasState;
				if (cs && typeof cs.getCurrentCanvas === 'function') {
					const c = cs.getCurrentCanvas();
					return (c && c.canvasId) || null;
				}
				return null;
			}

			function _ensureCursorLayer() {
				if (_cursorLayer) {
return _cursorLayer;
}
				const graph = getGraph();
				const host = graph && graph.querySelector ? (graph.querySelector('#graph-bulk') || graph.querySelector('#bulk-canvas')) : null;
				if (!host) {
return null;
}
				_cursorLayer = document.createElement('div');
				_cursorLayer.className = 'presence-cursor-layer';
				_cursorLayer.setAttribute('aria-hidden', 'true');
				host.appendChild(_cursorLayer);
				return _cursorLayer;
			}

			function _ensurePresenceChips() {
				if (_presenceChips) {
return _presenceChips;
}
				_presenceChips = document.createElement('div');
				_presenceChips.className = 'presence-chip-strip';
				// Mount into the canvas status strip when it exists so the
				// chips sit as a flex sibling of the count chip; no JS
				// positioning needed, layout follows the parent's flex
				// gap. Fall back to fixed body-level positioning when the
				// strip isn't available (recipient mode hides the count
				// chip; canvas not yet rendered) so the chips still
				// appear somewhere reasonable.
				const strip = document.getElementById('canvas-status-strip');
				if (strip) {
					strip.appendChild(_presenceChips);
				} else {
					_presenceChips.classList.add('presence-chip-strip--detached');
					document.body.appendChild(_presenceChips);
				}
				return _presenceChips;
			}

			function _initials(name) {
				if (!name) {
return '?';
}
				const parts = String(name).trim().split(/\s+/);
				if (parts.length >= 2) {
return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
				return (parts[0][0] || '?').toUpperCase();
			}

			function _renderCursor(peer) {
				if (!_cursorLayer) {
return;
}
				let el = _cursorLayer.querySelector('[data-conn="' + peer.connectionId + '"]');
				if (!peer.cursor) {
					if (el) {
el.remove();
}
					return;
				}
				if (!el) {
					el = document.createElement('div');
					el.className = 'presence-cursor';
					el.setAttribute('data-conn', peer.connectionId);
					el.innerHTML =
						'<svg width="18" height="22" viewBox="0 0 18 22" aria-hidden="true">' +
							'<path d="M2 2 L16 11 L9 12 L6 19 Z" fill="currentColor" stroke="white" stroke-width="1.2" stroke-linejoin="round"/>' +
						'</svg>' +
						'<span class="presence-cursor-label"></span>';
					_cursorLayer.appendChild(el);
				}
				el.style.color = peer.color;
				// Two-schema receive: world coords (cursor.world=true)
				// flow through cy.pan/zoom inverse so cursors track
				// records across pan/zoom; viewport coords (no flag
				// or world=false) translate through our current
				// #graph-bulk rect. The layer is inset:0 inside
				// graph-bulk, so its top-left matches graph-bulk's
				// in viewport space; recomputing the rect each
				// render covers our own layout shifts.
				let localX, localY;
				if (peer.cursor.world) {
					const local = _worldToLayerLocal(peer.cursor.x, peer.cursor.y);
					if (local) {
						localX = local.x;
						localY = local.y;
					} else {
						// cy gone on our side; can't translate world
						// coords. Hide the cursor until our cy returns
						// (e.g., records load) or peer falls back to
						// viewport coords on their next mousemove.
						el.style.display = 'none';
						return;
					}
				} else {
					const layerRect = _cursorLayer.getBoundingClientRect();
					localX = peer.cursor.x - layerRect.left;
					localY = peer.cursor.y - layerRect.top;
				}
				el.style.display = '';
				el.style.transform = 'translate(' + localX + 'px, ' + localY + 'px)';
				const label = el.querySelector('.presence-cursor-label');
				if (label) {
					label.textContent = peer.displayName;
					label.style.backgroundColor = peer.color;
				}
			}

			// Reposition the chip strip to sit immediately to the right
			// of the records-count chip (`#bulk-count-chip`). The
			// When the chip strip is a flex child of #canvas-status-strip
			// (the common path post-status-strip refactor), CSS handles
			// positioning entirely and this function is a no-op. The
			// detached fallback (recipient mode / pre-canvas-render) is
			// already positioned by the .presence-chip-strip--detached
			// class; no per-tick rect chasing needed. Function name
			// preserved so the existing call sites stay valid.
			function _positionChipStrip() {
				/* no-op: layout now driven by CSS flex in #canvas-status-strip */
			}

			function _renderChips() {
				const strip = _ensurePresenceChips();
				if (!strip) {
return;
}
				const peersArr = Array.from(_peers.values());
				if (peersArr.length === 0) {
					strip.innerHTML = '';
					strip.style.display = 'none';
					return;
				}
				strip.style.display = '';
				strip.innerHTML = peersArr.map((p) =>
					'<span class="presence-chip" title="' + escapeHtml(p.displayName) + ' is on this canvas" style="background:' + p.color + '">' +
						escapeHtml(_initials(p.displayName)) +
					'</span>'
				).join('');
				_positionChipStrip();
			}

			function _onPresenceInit(data) {
				_myConnectionId = data.you && data.you.connectionId;
				_peers.clear();
				if (Array.isArray(data.peers)) {
					for (const p of data.peers) {
						_peers.set(p.connectionId, p);
						if (p.cursor) {
_renderCursor(p);
}
						if (p.focus) {
_renderPeerFocus(p);
}
					}
				}
				_renderChips();
			}

			function _onPresenceEvent(data) {
				if (!data || !data.type) {
return;
}
				if (data.type === 'canvas-saved') {
					_onCanvasSaved(data);
					return;
				}
				if (data.type === 'draft-update') {
					_applyPeerDraftUpdate(data);
					return;
				}
				if (data.type === 'loaded-removed') {
					_applyPeerLoadedRemoved(data);
					return;
				}
				if (data.type === 'draft-link') {
					_applyPeerDraftLink(data);
					return;
				}
				if (data.type === 'join' && data.peer) {
					_peers.set(data.peer.connectionId, data.peer);
					_renderChips();
					if (data.peer.focus) {
_renderPeerFocus(data.peer);
}
				} else if (data.type === 'leave' && data.connectionId) {
					_peers.delete(data.connectionId);
					_renderChips();
					if (_cursorLayer) {
						const el = _cursorLayer.querySelector('[data-conn="' + data.connectionId + '"]');
						if (el) {
el.remove();
}
					}
					_clearPeerFocus(data.connectionId);
				} else if (data.type === 'cursor' && data.connectionId) {
					const peer = _peers.get(data.connectionId);
					if (peer) {
						peer.cursor = data.cursor;
						_renderCursor(peer);
					}
				} else if (data.type === 'focus' && data.connectionId) {
					const peer = _peers.get(data.connectionId);
					if (peer) {
						peer.focus = data.focus;
						_renderPeerFocus(peer);
					}
				}
			}

			// Phase 2 focus rendering. When a peer's focus event arrives
			// with kind='record', find the matching loaded record on the
			// local canvas and apply a peer-colored outline + "viewing"
			// label. The outline color comes from the peer's assigned
			// presence color so cursor + focus stay visually coherent.
			//
			// Lookup chain: peer.focus.ref is the SF record id. Match
			// against canvasState.bulkRecords[].loadedFromId, then find
			// the rendered DOM element by its data-rec-id (set by
			// records-canvas.js render). If the local user can't see
			// the record (no matching loadedFromId, or no card in the
			// DOM yet because cytoscape hasn't painted that node), the
			// focus indicator just doesn't render; Phase 2 doesn't yet
			// surface "peer is viewing a record you can't see," that's
			// Phase 2.5 work.
			function _clearPeerFocus(connectionId) {
				// Remove any indicator the peer previously painted.
				document.querySelectorAll('.presence-focus-label[data-presence-focus="' + connectionId + '"]').forEach((el) => el.remove());
				document.querySelectorAll('[data-presence-focus-by="' + connectionId + '"]').forEach((el) => {
					el.removeAttribute('data-presence-focus-by');
					el.style.removeProperty('--presence-focus-color');
				});
			}
			function _renderPeerFocus(peer) {
				if (!peer || !peer.connectionId) {
return;
}
				_clearPeerFocus(peer.connectionId);
				const focus = peer.focus;
				if (!focus || focus.kind !== 'record' || !focus.ref) {
return;
}
				const cs = canvasState;
				if (!cs || !Array.isArray(cs.bulkRecords)) {
return;
}
				const sfRef = String(focus.ref);
				const rec = cs.bulkRecords.find((r) => r && r.loadedFromId && String(r.loadedFromId) === sfRef);
				if (!rec) {
return;
}
				const card = document.querySelector('[data-rec-id="' + rec.id + '"]');
				if (!card) {
return;
}
				card.setAttribute('data-presence-focus-by', peer.connectionId);
				card.style.setProperty('--presence-focus-color', peer.color);
				const label = document.createElement('div');
				label.className = 'presence-focus-label';
				label.setAttribute('data-presence-focus', peer.connectionId);
				label.textContent = (peer.displayName || 'Someone') + ' viewing';
				label.style.backgroundColor = peer.color;
				card.appendChild(label);
			}
			// Re-apply all peer focus indicators. Called whenever the
			// canvas DOM might have been rebuilt (cytoscape re-render,
			// records added, etc.). Cheap: iterates active peers and
			// applies a small CSS attribute mutation per match.
			function _reapplyAllFocus() {
				for (const peer of _peers.values()) {
					if (peer && peer.focus) {
_renderPeerFocus(peer);
}
				}
			}

			// Phase 4 collab: broadcast draft field-value updates so
			// peers see each other's work-in-progress on drafts in
			// real-time. ContentDocuments stay structural-only (the
			// principle); values flow only through process-memory
			// relay between connected browsers, never persisted server-
			// side. Strict mode disables send AND receive end-to-end.
			//
			// Diff approach (vs. event-on-every-keystroke): a 2 s timer
			// snapshots every draft's values, diffs against the last-
			// broadcast snapshot, posts only the keys that changed.
			// Captures the user's typing without hooking every edit
			// site, throttles network volume naturally, and means a
			// late-joining peer who missed earlier diffs still gets
			// the current state on the next tick.
			//
			// Scope: only drafts with a persisted tempId broadcast.
			// Brand-new drafts (created locally, not yet round-tripped
			// through a canvas save) have client-local tempIds that
			// the peer wouldn't recognize. Once the canvas saves and
			// reloads with stable tempIds, those drafts join the sync.
			// Last-broadcast snapshot, keyed by sync id (either the
			// persisted tempId from a saved canvas OR the _collabId
			// minted for brand-new drafts). Each entry holds
			// { values: {...}, x, y }: the last set we broadcast,
			// used for delta computation AND to suppress sender-side
			// echo when receiving a peer's update (stamp on receive
			// so the next tick sees no diff and doesn't bounce back).
			const _lastBroadcastDraftValues = new Map();
			// Phase 5: track SF ids of loaded (non-draft) records the
			// peer canvas knows about, so we can detect REMOVALS and
			// broadcast a real-time "loaded-removed" event. Additions
			// of loaded records still flow through the canvas-save
			// round-trip; they require SF visibility on the peer's
			// side, which is governed by SF sharing rules and can't
			// be synthesized by us. Removal is what we add real-time
			// support for so the "no access" placeholder on the peer
			// side disappears the moment the owner removes the
			// underlying reference.
			const _lastBroadcastLoadedSfIds = new Set();
			// Phase 5: track associations between drafts. Each entry is
			// the canonical key `${fromSyncId}->${toSyncId}::${field}`,
			// where sync ids are _persistedTempId OR _collabId (same
			// identifiers Phase 4 / 4.5 uses for values + position).
			// Diff against current bulkAssociations each tick to detect
			// adds and removes. Associations touching at least one
			// loaded record are skipped; their endpoints have stable
			// SF ids that go through the canvas-save flow already.
			const _lastBroadcastDraftLinks = new Set();
			const DRAFT_BROADCAST_INTERVAL_MS = 2000;
			// Minimum pixel movement before we broadcast a position
			// update. Cytoscape's render loop produces subpixel jitter
			// during drag inertia; below this threshold the human eye
			// can't tell either way and the network volume drops.
			const POSITION_BROADCAST_THRESHOLD = 1;

			// Resolve the sync identifier for a draft. Saved+reloaded
			// drafts carry _persistedTempId (stable across browsers
			// via the canvas File). Brand-new drafts get a _collabId
			// minted on first broadcast: a UUID that uniquely
			// identifies the draft across all peers until the canvas
			// is saved (at which point the saved tempId takes over
			// the cross-browser identity role).
			function _syncIdOf(rec) {
				if (!rec) {
return null;
}
				if (rec._persistedTempId != null) {
return String(rec._persistedTempId);
}
				if (rec._collabId) {
return String(rec._collabId);
}
				return null;
			}
			function _mintCollabId() {
				try {
					if (window.crypto && typeof window.crypto.randomUUID === 'function') {
						return window.crypto.randomUUID();
					}
				} catch (_) {}
				return 'collab_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
			}
			function _safeValueCopy(values) {
				const out = {};
				if (!values || typeof values !== 'object') {
return out;
}
				for (const k of Object.keys(values)) {
					const v = values[k];
					if (v == null) {
continue;
}
					const t = typeof v;
					if (t === 'string' || t === 'number' || t === 'boolean') {
out[k] = v;
}
				}
				return out;
			}

			function _postDraftPayload(payload) {
				payload.sequence = _nextSequence();
				return csrfFetch(
					'/api/canvas/' + encodeURIComponent(_currentCanvasId) + '/presence/draft',
					{
						method: 'POST',
						credentials: 'same-origin',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify(payload),
					},
				).catch(() => {});
			}
			function _broadcastDraftDeltas() {
				if (!_currentCanvasId || !_myConnectionId) {
return;
}
				if (!Array.isArray(canvasState.bulkRecords)) {
return;
}
				// Drain any links that were waiting for their endpoints
				// to materialize. If we just received the matching
				// drafts via SSE between ticks, the links resolve here.
				_flushPendingDraftLinks();
				const seenIds = new Set();
				for (const r of canvasState.bulkRecords) {
					if (!r) {
continue;
}
					if (r.isTypeNode) {
continue;
}
					if (r.loadedFromId) {
continue;
}
					// Phase 4.5: brand-new draft (no persisted tempId,
					// no collabId yet) → mint a collabId, send a
					// draft-create event with full structure. Subsequent
					// ticks send draft-update for value / position diffs.
					let syncId = _syncIdOf(r);
					const isFirstBroadcast = syncId == null;
					if (isFirstBroadcast) {
						r._collabId = _mintCollabId();
						syncId = r._collabId;
						const initialValues = _safeValueCopy(r.values);
						const initX = typeof r.x === 'number' ? r.x : 200;
						const initY = typeof r.y === 'number' ? r.y : 200;
						_postDraftPayload({
							connectionId: _myConnectionId,
							tempId: syncId,
							kind: 'create',
							objectName: r.objectName || null,
							x: initX,
							y: initY,
							fields: initialValues,
						});
						_lastBroadcastDraftValues.set(syncId, {
							values: initialValues,
							x: initX,
							y: initY,
						});
						seenIds.add(syncId);
						continue;
					}
					seenIds.add(syncId);
					const cur = _safeValueCopy(r.values);
					const lastEntry = _lastBroadcastDraftValues.get(syncId) || { values: {}, x: null, y: null };
					const lastValues = lastEntry.values || {};
					// Sparse value diff: changed/new keys, plus null
					// markers for keys removed since last send.
					const diff = {};
					let hasFieldsDiff = false;
					for (const k of Object.keys(cur)) {
						if (cur[k] !== lastValues[k]) {
							diff[k] = cur[k];
							hasFieldsDiff = true;
						}
					}
					for (const k of Object.keys(lastValues)) {
						if (!(k in cur)) {
							diff[k] = null;
							hasFieldsDiff = true;
						}
					}
					// Position diff: only when the user moved the draft
					// more than the jitter threshold. Send as a separate
					// `position` field so receivers don't have to peek
					// inside `fields` for structural info.
					const curX = typeof r.x === 'number' ? r.x : null;
					const curY = typeof r.y === 'number' ? r.y : null;
					let posPayload = null;
					if (curX != null && curY != null) {
						const dx = lastEntry.x == null ? Infinity : Math.abs(curX - lastEntry.x);
						const dy = lastEntry.y == null ? Infinity : Math.abs(curY - lastEntry.y);
						if (dx >= POSITION_BROADCAST_THRESHOLD || dy >= POSITION_BROADCAST_THRESHOLD) {
							posPayload = { x: curX, y: curY };
						}
					}
					if (!hasFieldsDiff && !posPayload) {
continue;
}
					const payload = {
						connectionId: _myConnectionId,
						tempId: syncId,
						fields: hasFieldsDiff ? diff : {},
					};
					if (posPayload) {
payload.position = posPayload;
}
					_postDraftPayload(payload);
					_lastBroadcastDraftValues.set(syncId, {
						values: cur,
						x: curX,
						y: curY,
					});
				}
				// Removed drafts: any sync id in last-broadcast that
				// the current canvas no longer has → broadcast a
				// draft-remove so peers drop their local copy. Then
				// purge the entry from our snapshot map.
				const toRemove = [];
				for (const k of _lastBroadcastDraftValues.keys()) {
					if (!seenIds.has(k)) {
toRemove.push(k);
}
				}
				for (const k of toRemove) {
					_postDraftPayload({
						connectionId: _myConnectionId,
						tempId: k,
						kind: 'remove',
						fields: {},
					});
					_lastBroadcastDraftValues.delete(k);
				}
				// Phase 5: detect removed loaded records by SF id.
				// Walk current bulkRecords building the current set,
				// then anything in our last-broadcast set not in
				// current got removed locally → broadcast a record-
				// remove for it.
				const currentLoadedSfIds = new Set();
				for (const r of canvasState.bulkRecords) {
					if (!r) {
continue;
}
					if (r.isTypeNode) {
continue;
}
					if (!r.loadedFromId) {
continue;
}
					currentLoadedSfIds.add(String(r.loadedFromId));
				}
				const removedLoadedIds = [];
				for (const sfId of _lastBroadcastLoadedSfIds) {
					if (!currentLoadedSfIds.has(sfId)) {
removedLoadedIds.push(sfId);
}
				}
				for (const sfId of removedLoadedIds) {
					csrfFetch(
						'/api/canvas/' + encodeURIComponent(_currentCanvasId) + '/presence/record-remove',
						{
							method: 'POST',
							credentials: 'same-origin',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({
								connectionId: _myConnectionId,
								sequence: _nextSequence(),
								sfId: sfId,
							}),
						},
					).catch(() => {});
					_lastBroadcastLoadedSfIds.delete(sfId);
				}
				// Update snapshot to current state for next tick's
				// diff. Additions are NOT broadcast; those propagate
				// through the canvas-saved round-trip.
				for (const sfId of currentLoadedSfIds) {
					_lastBroadcastLoadedSfIds.add(sfId);
				}
				// Phase 5: diff draft-draft associations. Build the
				// current canonical-key set, then compare to last
				// snapshot: anything new gets an 'add' broadcast,
				// anything missing gets a 'remove'. Only links where
				// BOTH endpoints are drafts (no loadedFromId) and
				// BOTH endpoints have a sync id are synced; mixed
				// (draft↔loaded) and pre-sync (no _persistedTempId
				// AND no _collabId) links can't be expressed by sync
				// ids alone yet and would require additional state on
				// the peer side. They flow through the canvas-saved
				// round-trip as before.
				const recordsByRuntimeId = new Map();
				for (const r of canvasState.bulkRecords) {
					if (r && r.id != null) {
recordsByRuntimeId.set(r.id, r);
}
				}
				const currentLinks = new Map(); // key → {fromSyncId, toSyncId, fieldName}
				if (Array.isArray(canvasState.bulkAssociations)) {
					for (const a of canvasState.bulkAssociations) {
						if (!a) {
continue;
}
						const fromRec = recordsByRuntimeId.get(a.fromId);
						const toRec = recordsByRuntimeId.get(a.toId);
						if (!fromRec || !toRec) {
continue;
}
						if (fromRec.loadedFromId || toRec.loadedFromId) {
continue;
}
						if (fromRec.isTypeNode || toRec.isTypeNode) {
continue;
}
						const fromSync = _syncIdOf(fromRec);
						const toSync = _syncIdOf(toRec);
						if (fromSync == null || toSync == null) {
continue;
}
						if (!a.fieldName) {
continue;
}
						const key = fromSync + '->' + toSync + '::' + a.fieldName;
						currentLinks.set(key, {
							fromSyncId: fromSync,
							toSyncId: toSync,
							fieldName: a.fieldName,
						});
					}
				}
				// Removed: in last set, not in current.
				for (const key of _lastBroadcastDraftLinks) {
					if (currentLinks.has(key)) {
continue;
}
					const parts = _parseLinkKey(key);
					if (!parts) {
continue;
}
					csrfFetch(
						'/api/canvas/' + encodeURIComponent(_currentCanvasId) + '/presence/draft-link',
						{
							method: 'POST',
							credentials: 'same-origin',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({
								connectionId: _myConnectionId,
								sequence: _nextSequence(),
								kind: 'remove',
								fromSyncId: parts.fromSyncId,
								toSyncId: parts.toSyncId,
								fieldName: parts.fieldName,
							}),
						},
					).catch(() => {});
				}
				// Added: in current, not in last set.
				for (const [key, link] of currentLinks) {
					if (_lastBroadcastDraftLinks.has(key)) {
continue;
}
					csrfFetch(
						'/api/canvas/' + encodeURIComponent(_currentCanvasId) + '/presence/draft-link',
						{
							method: 'POST',
							credentials: 'same-origin',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({
								connectionId: _myConnectionId,
								sequence: _nextSequence(),
								kind: 'add',
								fromSyncId: link.fromSyncId,
								toSyncId: link.toSyncId,
								fieldName: link.fieldName,
							}),
						},
					).catch(() => {});
				}
				_lastBroadcastDraftLinks.clear();
				for (const key of currentLinks.keys()) {
_lastBroadcastDraftLinks.add(key);
}
			}
			function _parseLinkKey(key) {
				const arrowIdx = key.indexOf('->');
				if (arrowIdx < 0) {
return null;
}
				const sepIdx = key.indexOf('::', arrowIdx + 2);
				if (sepIdx < 0) {
return null;
}
				return {
					fromSyncId: key.substring(0, arrowIdx),
					toSyncId: key.substring(arrowIdx + 2, sepIdx),
					fieldName: key.substring(sepIdx + 2),
				};
			}

			// Apply a received draft-update from a peer. Looks up the
			// draft by persisted tempId in the local canvas state and
			// merges the sparse field map. null values mean "delete
			// this key." Skipped in strict mode (workspace policy is
			// no draft-value flow in either direction). Skipped also
			// if we can't find the matching draft; peer's tempId
			// doesn't resolve here when our canvas hasn't loaded yet
			// or the draft was already removed locally; the diff
			// snapshot the peer holds will re-send on the next round
			// if needed.
			// Buffer for draft-link events that arrived before their
			// endpoints. Race window: the broadcaster fires multiple
			// POSTs in parallel within a tick (draft-create for new
			// drafts + draft-link for new associations), so the link
			// can land at the peer ahead of the matching draft-creates.
			// We park out-of-order adds here and re-try on every
			// subsequent tick. Cap prevents memory bloat from stuck
			// entries (e.g., a draft was removed before its link
			// could resolve); 100 unresolved adds is way past any
			// realistic batch size.
			const _pendingDraftLinks = [];
			const PENDING_LINKS_CAP = 100;

			// Apply a draft-link event; returns true if applied (or
			// safely no-oped because the same edge already exists),
			// false if endpoints aren't materialized locally yet.
			// Add-kind unresolved events get parked in _pendingDraftLinks
			// by the caller; remove-kind unresolved events are dropped
			// (no edge to remove anyway).
			function _tryApplyPeerDraftLink(data) {
				if (!data || !data.kind || !data.fromSyncId || !data.toSyncId || !data.fieldName) {
return true;
}
				if (!Array.isArray(canvasState.bulkRecords)) {
return false;
}
				const fromRec = _findDraftBySyncId(data.fromSyncId);
				const toRec = _findDraftBySyncId(data.toSyncId);
				if (!fromRec || !toRec) {
return false;
}
				const key = data.fromSyncId + '->' + data.toSyncId + '::' + data.fieldName;
				if (data.kind === 'add') {
					const existing = canvasState.bulkAssociations.find(
						(a) => a && a.fromId === fromRec.id && a.toId === toRec.id && a.fieldName === data.fieldName,
					);
					if (!existing) {
						canvasState.bulkAssociations.push({
							id: canvasState.bulkIdSeq++,
							fromId: fromRec.id,
							toId: toRec.id,
							fieldName: data.fieldName,
						});
					}
					_lastBroadcastDraftLinks.add(key);
				} else if (data.kind === 'remove') {
					const before = canvasState.bulkAssociations.length;
					canvasState.bulkAssociations = canvasState.bulkAssociations.filter(
						(a) => !(a && a.fromId === fromRec.id && a.toId === toRec.id && a.fieldName === data.fieldName),
					);
					if (canvasState.bulkAssociations.length === before) {
return true;
} // nothing to do
					_lastBroadcastDraftLinks.delete(key);
				}
				try {
 renderBulkView(); 
} catch (_) {}
				return true;
			}
			function _applyPeerDraftLink(data) {
				const ok = _tryApplyPeerDraftLink(data);
				if (!ok && data && data.kind === 'add') {
					if (_pendingDraftLinks.length < PENDING_LINKS_CAP) {
						_pendingDraftLinks.push(data);
					}
				}
			}
			// Drain pending links: called after each draft-create and
			// on each broadcast tick. Anything still unresolvable stays
			// in the queue for next time.
			function _flushPendingDraftLinks() {
				if (_pendingDraftLinks.length === 0) {
return;
}
				const queue = _pendingDraftLinks.slice();
				_pendingDraftLinks.length = 0;
				for (const data of queue) {
					const ok = _tryApplyPeerDraftLink(data);
					if (!ok && _pendingDraftLinks.length < PENDING_LINKS_CAP) {
						_pendingDraftLinks.push(data);
					}
				}
			}

			// Phase 5: a peer removed a loaded record from their canvas.
			// Drop the matching local card (whether it's a fully-loaded
			// record OR an "🔒 No access" placeholder; both reference
			// the same loadedFromId / ref). Also clean up any
			// associations touching that runtime id so we don't leave
			// dangling edges. Update our own broadcast snapshot so the
			// next outbound tick doesn't echo a remove back at the peer.
			function _applyPeerLoadedRemoved(data) {
				if (!data || !data.sfId) {
return;
}
				const targetSfId = String(data.sfId);
				if (!Array.isArray(canvasState.bulkRecords)) {
return;
}
				let removedRuntimeId = null;
				const remaining = [];
				for (const r of canvasState.bulkRecords) {
					if (!r) {
 remaining.push(r); continue; 
}
					if (r.isTypeNode) {
 remaining.push(r); continue; 
}
					// Match by loadedFromId on either a real loaded
					// record or the inaccessible placeholder (the
					// placeholder shape from templates.js carries
					// loadedFromId as the ref the placeholder is
					// standing in for).
					const refId = r.loadedFromId != null ? String(r.loadedFromId) : null;
					if (refId === targetSfId) {
						removedRuntimeId = r.id;
						continue;
					}
					remaining.push(r);
				}
				if (removedRuntimeId == null) {
					// Nothing to remove locally. Still drop from our
					// snapshot so we don't broadcast a stale remove
					// back later.
					_lastBroadcastLoadedSfIds.delete(targetSfId);
					return;
				}
				canvasState.bulkRecords = remaining;
				// Prune associations touching the removed runtime id.
				if (Array.isArray(canvasState.bulkAssociations)) {
					canvasState.bulkAssociations = canvasState.bulkAssociations.filter(
						(a) => a.fromId !== removedRuntimeId && a.toId !== removedRuntimeId,
					);
				}
				if (canvasState.bulkSelectedIds && typeof canvasState.bulkSelectedIds.delete === 'function') {
					canvasState.bulkSelectedIds.delete(removedRuntimeId);
				}
				_lastBroadcastLoadedSfIds.delete(targetSfId);
				try {
 renderBulkView(); 
} catch (_) {}
			}

			function _findDraftBySyncId(syncId) {
				if (!Array.isArray(canvasState.bulkRecords)) {
return null;
}
				const target = String(syncId);
				for (const r of canvasState.bulkRecords) {
					if (!r) {
continue;
}
					if (r.isTypeNode || r.loadedFromId) {
continue;
}
					if (_syncIdOf(r) === target) {
return r;
}
				}
				return null;
			}

			async function _applyPeerDraftUpdate(data) {
				if (!data || data.tempId == null) {
return;
}
				if (!Array.isArray(canvasState.bulkRecords)) {
return;
}
				const syncId = String(data.tempId);
				let target = _findDraftBySyncId(syncId);
				// Phase 4.5: 'remove' kind drops the matching draft.
				// Echo-prevention: also clear our last-broadcast entry
				// so the next outbound tick doesn't re-broadcast a
				// remove event back at the peer.
				if (data.kind === 'remove') {
					if (target) {
						const beforeLen = canvasState.bulkRecords.length;
						canvasState.bulkRecords = canvasState.bulkRecords.filter((r) => r !== target);
						if (canvasState.bulkRecords.length !== beforeLen) {
							if (canvasState.bulkSelectedIds && typeof canvasState.bulkSelectedIds.delete === 'function') {
								canvasState.bulkSelectedIds.delete(target.id);
							}
							try {
 renderBulkView(); 
} catch (_) {}
						}
					}
					_lastBroadcastDraftValues.delete(syncId);
					return;
				}
				// 'create' kind means peer is announcing a brand-new
				// draft. If we don't have it locally, materialize one
				// with the same _collabId so future updates match.
				// Auto-adds the object to selectedObjects if needed,
				// same pattern as the AI-proposal apply path.
				if (!target && data.kind === 'create') {
					const objName = data.objectName;
					if (!objName || typeof objName !== 'string') {
return;
}
					try {
						let sel = canvasState.selectedObjects.find((so) => so.name === objName);
						if (!sel) {
sel = await addToSelection(objName);
}
						if (!sel) {
return;
}
						const newRec = {
							id: canvasState.bulkIdSeq++,
							objectName: objName,
							label: sel.label || objName,
							x: typeof data.x === 'number' ? data.x : 200,
							y: typeof data.y === 'number' ? data.y : 200,
							values: {},
							fromSelectionId: sel.id,
							// Mirror the peer's collab identity so
							// subsequent updates match here. Cleared
							// on next canvas save+reload (then
							// _persistedTempId takes over).
							_collabId: syncId,
						};
						canvasState.bulkRecords.push(newRec);
						target = newRec;
					} catch (e) {
						console.warn('[presence draft-create] could not materialize peer draft:', e && e.message);
						return;
					}
				}
				if (!target) {
return;
}
				let touched = false;
				// Position sync: apply peer's xy to our local card.
				// Phase 4.5: drag/move events propagate independently
				// from value diffs.
				if (data.position && typeof data.position === 'object') {
					const px = typeof data.position.x === 'number' ? data.position.x : null;
					const py = typeof data.position.y === 'number' ? data.position.y : null;
					if (px != null && target.x !== px) {
 target.x = px; touched = true; 
}
					if (py != null && target.y !== py) {
 target.y = py; touched = true; 
}
				}
				if (data.fields && typeof data.fields === 'object') {
					const values = target.values = target.values || {};
					for (const k of Object.keys(data.fields)) {
						const v = data.fields[k];
						if (v === null) {
							if (k in values) {
 delete values[k]; touched = true; 
}
						} else if (values[k] !== v) {
							values[k] = v;
							touched = true;
						}
					}
				}
				// Echo-prevention: stamp our broadcast snapshot so
				// the next outbound tick doesn't see the received
				// state as a local change and bounce it back.
				_lastBroadcastDraftValues.set(syncId, {
					values: _safeValueCopy(target.values),
					x: typeof target.x === 'number' ? target.x : null,
					y: typeof target.y === 'number' ? target.y : null,
				});
				if (touched || data.kind === 'create') {
					try {
 renderBulkView(); 
} catch (_) {}
				}
				// After a draft materializes locally, retry any
				// pending links that reference it. Covers the race
				// where draft-link arrives before its endpoint
				// draft-create on the SSE stream.
				if (data.kind === 'create') {
_flushPendingDraftLinks();
}
			}

			// Phase 3 collab: banner shown when another browser saves
			// the canvas we're currently viewing. Self-saves are
			// suppressed (the saver's own browser already updated its
			// versionId via the save response and doesn't need to be
			// told). The banner offers Reload (pull the latest payload
			// + apply, discarding local-only edits) and Dismiss
			// (continue editing; next save will surface a 409 if the
			// version we expect is now stale, and the existing conflict
			// flow takes over from there).
			let _savedBanner = null;
			async function _onCanvasSaved(data) {
				// Skip own saves. The accountId match works for the
				// common case (same user across tabs); a different
				// user with the same display name still gets the
				// banner, which is the correct conservative behavior.
				const meAcct = (window.SF_ACCOUNT_ID || null);
				const yourSelfAcct = data.savedByAccountId || null;
				let isOwnSave = false;
				if (meAcct && yourSelfAcct) {
					isOwnSave = (meAcct === yourSelfAcct);
				}
				if (!isOwnSave && _lastLocalSaveAt && (Date.now() - _lastLocalSaveAt) < 5000) {
					isOwnSave = true;
				}
				if (isOwnSave) {
return;
}
				const name = data.savedByDisplayName || 'Someone';
				// Hybrid: if our canvas is clean (no unsaved edits, no
				// open modal), silently auto-apply the freshest payload
				// matching the UX Linear/Notion use for live sync in the common
				// passive-viewer case. If we have local state that
				// would be destroyed by a reset, show the explicit
				// banner so we don't yank the rug out.
				if (!isCanvasDirty()) {
					const ok = await reloadCanvasFromServer();
					if (ok) {
						// Subtle confirmation toast so the user knows
						// content shifted under them (without a banner
						// they'd have to act on). Auto-dismisses; same
						// affordance the proposals + AI flows use.
						try {
							showBulkToast(name + ' saved this canvas, and your view updated.', 'info');
						} catch (_) {}
						return;
					}
					// Reload failed (network blip, 4xx); fall through
					// to the banner so the user knows their view is
					// stale even though we couldn't pull the fix.
				}
				_showSavedBanner({ name, at: data.at || Date.now() });
			}
			// Local saves bump this so a self-save echo from the server
			// doesn't trigger our own banner. Called via the public
			// noteLocalSave() API by the save-handler in app.js.
			let _lastLocalSaveAt = 0;
			function noteLocalSave() {
 _lastLocalSaveAt = Date.now(); 
}

			function _showSavedBanner({ name, at }) {
				if (_savedBanner) {
					try {
 _savedBanner.remove(); 
} catch (_) {}
					_savedBanner = null;
				}
				_savedBanner = document.createElement('div');
				_savedBanner.className = 'presence-saved-banner';
				_savedBanner.setAttribute('role', 'status');
				_savedBanner.innerHTML =
					'<span class="presence-saved-icon" aria-hidden="true">⟳</span>' +
					'<span class="presence-saved-text">' +
						'<strong>' + escapeHtml(name) + '</strong> just saved this canvas. ' +
						'Your view may be out of date.' +
					'</span>' +
					'<button type="button" class="presence-saved-btn" data-saved-action="reload">Reload</button>' +
					'<button type="button" class="presence-saved-btn presence-saved-btn-secondary" data-saved-action="dismiss">Keep editing</button>';
				document.body.appendChild(_savedBanner);
				_savedBanner.addEventListener('click', (ev) => {
					const btn = ev.target.closest('[data-saved-action]');
					if (!btn) {
return;
}
					const action = btn.getAttribute('data-saved-action');
					if (action === 'reload') {
						// app.js's auto-open handler strips the
						// ?openCanvas= query param from the URL after
						// the canvas successfully loads (clean-URL UX).
						// A plain window.location.reload() therefore
						// reloads to bare `/` and the auto-open code
						// has nothing to act on; the page lands on a
						// fresh draft, NOT the canvas the banner was
						// referring to. Build the explicit URL with
						// the canvas id and navigate there instead;
						// the saved canvas reopens via the same
						// auto-open path as a first visit.
						const id = _currentCanvasId;
						if (id && /^[a-zA-Z0-9]{15,18}$/.test(id)) {
							window.location.href = '/?openCanvas=' + encodeURIComponent(id);
						} else {
							window.location.reload();
						}
					} else if (action === 'dismiss') {
						try {
 _savedBanner.remove(); 
} catch (_) {}
						_savedBanner = null;
					}
				});
			}

			// Viewport client-coords ⇄ cytoscape world-coords. When cy is
			// initialized, cursors travel in world space; pan/zoom on
			// either browser doesn't shift them off the underlying
			// records. When cy isn't available (no records yet, canvas
			// still loading, etc.) fall back to viewport-absolute
			// pixels: each browser translates against its own current
			// graph-bulk rect at render time so layout shifts during
			// load don't poison the captured position.
			function _viewportToWorld(clientX, clientY) {
				const cy = getCyInstance && getCyInstance();
				if (!cy || typeof cy.pan !== 'function' || typeof cy.zoom !== 'function') {
return null;
}
				const container = (typeof cy.container === 'function') ? cy.container() : null;
				if (!container) {
return null;
}
				const rect = container.getBoundingClientRect();
				if (rect.width === 0 || rect.height === 0) {
return null;
}
				const pan = cy.pan() || { x: 0, y: 0 };
				const zoom = cy.zoom();
				if (!zoom) {
return null;
}
				return {
					x: (clientX - rect.left - pan.x) / zoom,
					y: (clientY - rect.top - pan.y) / zoom,
				};
			}
			function _worldToLayerLocal(worldX, worldY) {
				const cy = getCyInstance && getCyInstance();
				if (!cy || typeof cy.pan !== 'function' || typeof cy.zoom !== 'function') {
return null;
}
				const container = (typeof cy.container === 'function') ? cy.container() : null;
				if (!container || !_cursorLayer) {
return null;
}
				const containerRect = container.getBoundingClientRect();
				const layerRect = _cursorLayer.getBoundingClientRect();
				const pan = cy.pan() || { x: 0, y: 0 };
				const zoom = cy.zoom();
				if (!zoom) {
return null;
}
				const renderedX = worldX * zoom + pan.x;
				const renderedY = worldY * zoom + pan.y;
				return {
					x: renderedX + containerRect.left - layerRect.left,
					y: renderedY + containerRect.top - layerRect.top,
				};
			}

			function _onMouseMove(ev) {
				if (!_currentCanvasId || !_myConnectionId) {
return;
}
				const now = Date.now();
				if (now - _lastCursorPostAt < CURSOR_THROTTLE_MS) {
return;
}
				_lastCursorPostAt = now;
				const graph = getGraph();
				const host = graph && graph.querySelector ? (graph.querySelector('#graph-bulk') || graph.querySelector('#bulk-canvas')) : null;
				if (!host) {
return;
}
				const rect = host.getBoundingClientRect();
				if (ev.clientX < rect.left || ev.clientY < rect.top
					|| ev.clientX > rect.right || ev.clientY > rect.bottom) {
return;
}
				// Send world coords when cy is alive so cursors track
				// records during pan/zoom. Two coord spaces flow over
				// the wire; the `world` flag tells the receiver which
				// inverse to apply.
				const world = _viewportToWorld(ev.clientX, ev.clientY);
				let x, y, isWorld;
				if (world) {
					x = world.x;
					y = world.y;
					isWorld = true;
				} else {
					// Viewport-absolute fallback: layout shifts during
					// canvas load don't poison the captured position
					// because the receiver re-translates using its own
					// current rect at render time.
					x = ev.clientX;
					y = ev.clientY;
					isWorld = false;
				}
				// Abort any in-flight request before firing the next one
				// so a slow network doesn't pile up cursor posts.
				if (_pendingCursorAbort) {
_pendingCursorAbort.abort();
}
				const ctl = new AbortController();
				_pendingCursorAbort = ctl;
				csrfFetch(
					'/api/canvas/' + encodeURIComponent(_currentCanvasId) + '/presence/cursor',
					{
						method: 'POST',
						credentials: 'same-origin',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ connectionId: _myConnectionId, sequence: _nextSequence(), x, y, world: isWorld }),
						signal: ctl.signal,
					},
				).catch(() => { /* abort/network, silent */ });
			}

			function _onMouseLeave() {
				if (!_currentCanvasId || !_myConnectionId) {
return;
}
				csrfFetch(
					'/api/canvas/' + encodeURIComponent(_currentCanvasId) + '/presence/cursor',
					{
						method: 'POST',
						credentials: 'same-origin',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ connectionId: _myConnectionId, sequence: _nextSequence(), x: null, y: null }),
					},
				).catch(() => {});
			}

			function _attachMouseTracking() {
				const graph = getGraph();
				const host = graph && graph.querySelector ? (graph.querySelector('#graph-bulk') || graph.querySelector('#bulk-canvas')) : null;
				if (!host) {
return;
}
				host.addEventListener('mousemove', _onMouseMove);
				host.addEventListener('mouseleave', _onMouseLeave);
			}

			function subscribeToCanvas(canvasId) {
				if (!canvasId) {
return;
}
				// Playground/demo mode: no presence. EventSource bypasses the
				// mock-sf fetch interceptor, so subscribing would open a REAL
				// SSE to the live server (401 auto-retry loop for anonymous
				// visitors; a real presence registration for a mock canvas id
				// under a signed-in visitor's account). Skipping here also
				// skips mouse tracking, so the throttled cursor POSTs never
				// fire either.
				if (window.ORGLOOM_MOCK) {
return;
}
				if (canvasId === _currentCanvasId && _eventSource && _eventSource.readyState !== 2) {
return;
}
				unsubscribe();
				_currentCanvasId = canvasId;
				_outboundSequence = 0;
				_ensureCursorLayer();
				_attachMouseTracking();
				try {
					_eventSource = new EventSource(
						'/api/canvas/' + encodeURIComponent(canvasId) + '/presence/subscribe',
					);
				} catch (e) {
					console.warn('[presence] EventSource open failed:', e && e.message);
					return;
				}
				_eventSource.addEventListener('presence-init', (e) => {
					try {
 _onPresenceInit(JSON.parse(e.data));
} catch (err) {
 window.ORGLOOM_capture && window.ORGLOOM_capture(err, { where: 'presence.js/sse/init' }); 
}
				});
				_eventSource.addEventListener('presence', (e) => {
					try {
 _onPresenceEvent(JSON.parse(e.data));
} catch (err) {
 window.ORGLOOM_capture && window.ORGLOOM_capture(err, { where: 'presence.js/sse/event' }); 
}
				});
				_eventSource.addEventListener('error', () => {
					// EventSource auto-retries by default; keep silent
					// unless we want to surface a "reconnecting" toast.
				});
			}

			function unsubscribe() {
				if (_eventSource) {
					try {
 _eventSource.close(); 
} catch (_) {}
					_eventSource = null;
				}
				_myConnectionId = null;
				_currentCanvasId = null;
				_peers.clear();
				if (_cursorLayer) {
_cursorLayer.innerHTML = '';
}
				_renderChips();
			}

			function pushFocus(focus) {
				if (!_currentCanvasId || !_myConnectionId) {
return;
}
				csrfFetch(
					'/api/canvas/' + encodeURIComponent(_currentCanvasId) + '/presence/focus',
					{
						method: 'POST',
						credentials: 'same-origin',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ connectionId: _myConnectionId, sequence: _nextSequence(), focus: focus || null }),
					},
				).catch(() => {});
			}

			// Auto-subscribe whenever the resolved canvas id changes OR
			// the existing EventSource has closed (readyState === 2).
			// Polls every 2 seconds (cheap: just reads in-memory state).
			// Re-checking the EventSource state covers the case where
			// the server dropped us (proxy timeout, transient 429 on the
			// initial subscribe before the rate-limiter skip landed,
			// etc.); without this, a single early failure would leave
			// the module sitting with a stale _lastSeenId and never
			// resubscribe until the canvas id changes.
			let _lastSeenId = null;
			setInterval(() => {
				const id = _resolveCanvasId();
				const sourceClosed = _eventSource && _eventSource.readyState === 2;
				if (id && (id !== _lastSeenId || sourceClosed)) {
					_lastSeenId = id;
					subscribeToCanvas(id);
				} else if (!id && _lastSeenId) {
					_lastSeenId = null;
					unsubscribe();
				}
				// Cytoscape re-renders rebuild record-card DOM nodes,
				// which wipe focus indicators painted on the old nodes.
				// Re-applying every 2 s is the cheapest catch-up: no
				// hooks into the render cycle, no MutationObserver
				// overhead. A peer who joined / changed focus right
				// after a re-render gets their indicator back within
				// ~2 s, which feels live enough for the "X is viewing"
				// signal.
				_reapplyAllFocus();
				// Re-translate peer cursors too. Their stored coords
				// are viewport-absolute and don't change, but OUR
				// host rect may have shifted (sidebar toggle, window
				// resize); re-rendering catches up the on-screen
				// position. Cheap: 1 rect read + style write per peer.
				for (const peer of _peers.values()) {
					if (peer && peer.cursor) {
_renderCursor(peer);
}
				}
				// Re-anchor chip strip to count chip: its width
				// changes when records are added / removed so the
				// strip's left needs to follow.
				_positionChipStrip();
			}, 2000);

			// Phase 4 draft-sync timer. Every 2 s, diff draft values
			// against last-broadcast snapshot and POST changed keys
			// for peers. No-op in strict mode AND when no canvas /
			// connection is up; cheap enough to run unconditionally.
			setInterval(_broadcastDraftDeltas, DRAFT_BROADCAST_INTERVAL_MS);

			// Close cleanly on page hide so the server's idle sweep
			// doesn't have to clean up our entry on a 90s delay.
			window.addEventListener('beforeunload', unsubscribe);

			// Re-render peer cursors + focus indicators on window
			// resize. The 2 s polling loop already catches up; this
			// listener just makes the response instant during an
			// active resize, sidebar toggle, or DPI change. Cheap;
			// fires only a few times per resize gesture.
			window.addEventListener('resize', () => {
				for (const peer of _peers.values()) {
					if (peer && peer.cursor) {
_renderCursor(peer);
}
				}
				_reapplyAllFocus();
				_positionChipStrip();
			});

			return {
				subscribeToCanvas: subscribeToCanvas,
				unsubscribe: unsubscribe,
				pushFocus: pushFocus,
				// Save-loop integration: caller hits this right before
				// firing the PUT save request so we can suppress the
				// banner for the saver's own browser when the server's
				// broadcast echoes back. 5 s skew window covers the
				// SSE round-trip.
				noteLocalSave: noteLocalSave,
			};
		},
	};
})();
