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

			let _eventSource = null;
			let _myConnectionId = null;
			let _currentCanvasId = null;
			const _peers = new Map();

			let _cursorLayer = null;
			let _presenceChips = null;

			let _lastCursorPostAt = 0;

			const CURSOR_THROTTLE_MS = 100;
			let _pendingCursorAbort = null;

			function _resolveCanvasId() {
				if (canvasState.currentCanvas && canvasState.currentCanvas.id) {
return canvasState.currentCanvas.id;
}

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

				let localX, localY;
				if (peer.cursor.world) {
					const local = _worldToLayerLocal(peer.cursor.x, peer.cursor.y);
					if (local) {
						localX = local.x;
						localY = local.y;
					} else {

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

			function _positionChipStrip() {

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

			function _clearPeerFocus(connectionId) {

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

			function _reapplyAllFocus() {
				for (const peer of _peers.values()) {
					if (peer && peer.focus) {
_renderPeerFocus(peer);
}
				}
			}

			const _lastBroadcastDraftValues = new Map();

			const _lastBroadcastLoadedSfIds = new Set();

			const _lastBroadcastDraftLinks = new Set();
			const DRAFT_BROADCAST_INTERVAL_MS = 2000;

			const POSITION_BROADCAST_THRESHOLD = 1;

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
								sfId: sfId,
							}),
						},
					).catch(() => {});
					_lastBroadcastLoadedSfIds.delete(sfId);
				}

				for (const sfId of currentLoadedSfIds) {
					_lastBroadcastLoadedSfIds.add(sfId);
				}

				const recordsByRuntimeId = new Map();
				for (const r of canvasState.bulkRecords) {
					if (r && r.id != null) {
recordsByRuntimeId.set(r.id, r);
}
				}
				const currentLinks = new Map();
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
								kind: 'remove',
								fromSyncId: parts.fromSyncId,
								toSyncId: parts.toSyncId,
								fieldName: parts.fieldName,
							}),
						},
					).catch(() => {});
				}

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

			const _pendingDraftLinks = [];
			const PENDING_LINKS_CAP = 100;

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
}
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

					const refId = r.loadedFromId != null ? String(r.loadedFromId) : null;
					if (refId === targetSfId) {
						removedRuntimeId = r.id;
						continue;
					}
					remaining.push(r);
				}
				if (removedRuntimeId == null) {

					_lastBroadcastLoadedSfIds.delete(targetSfId);
					return;
				}
				canvasState.bulkRecords = remaining;

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

				if (data.kind === 'create') {
_flushPendingDraftLinks();
}
			}

			let _savedBanner = null;
			async function _onCanvasSaved(data) {

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

				if (!isCanvasDirty()) {
					const ok = await reloadCanvasFromServer();
					if (ok) {

						try {
							showBulkToast(name + ' saved this canvas — your view updated.', 'info');
						} catch (_) {}
						return;
					}

				}
				_showSavedBanner({ name, at: data.at || Date.now() });
			}

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

				const world = _viewportToWorld(ev.clientX, ev.clientY);
				let x, y, isWorld;
				if (world) {
					x = world.x;
					y = world.y;
					isWorld = true;
				} else {

					x = ev.clientX;
					y = ev.clientY;
					isWorld = false;
				}

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
						body: JSON.stringify({ connectionId: _myConnectionId, x, y, world: isWorld }),
						signal: ctl.signal,
					},
				).catch(() => {                              });
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
						body: JSON.stringify({ connectionId: _myConnectionId, x: null, y: null }),
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

				if (window.ORGLOOM_MOCK) {
return;
}
				if (canvasId === _currentCanvasId && _eventSource && _eventSource.readyState !== 2) {
return;
}
				unsubscribe();
				_currentCanvasId = canvasId;
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
} catch (err) { window.ORGLOOM_capture && window.ORGLOOM_capture(err, { where: 'presence.js/sse/init' }); }
				});
				_eventSource.addEventListener('presence', (e) => {
					try {
 _onPresenceEvent(JSON.parse(e.data));
} catch (err) { window.ORGLOOM_capture && window.ORGLOOM_capture(err, { where: 'presence.js/sse/event' }); }
				});
				_eventSource.addEventListener('error', () => {

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
						body: JSON.stringify({ connectionId: _myConnectionId, focus: focus || null }),
					},
				).catch(() => {});
			}

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

				_reapplyAllFocus();

				for (const peer of _peers.values()) {
					if (peer && peer.cursor) {
_renderCursor(peer);
}
				}

				_positionChipStrip();
			}, 2000);

			setInterval(_broadcastDraftDeltas, DRAFT_BROADCAST_INTERVAL_MS);

			window.addEventListener('beforeunload', unsubscribe);

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

				noteLocalSave: noteLocalSave,
			};
		},
	};
})();
