(function () {
	'use strict';
	// Synchronizes ephemeral collaborator state; persisted canvas data still flows through save/load.

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.presence = {
		mount: function mount(deps) {
			const _required = [
				'canvasState',
				'csrfFetch',
				'escapeHtml',
				'getGraph',
				'getCyInstance',
				'isCanvasDirty',
				'reloadCanvasFromServer',
				'showBulkToast',
				'renderBulkView',
				'addToSelection',
				'buildCanvasPayload',
				'applyLiveSnapshot',
			];
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
			const buildCanvasPayload = deps.buildCanvasPayload;
			const applyLiveSnapshot = deps.applyLiveSnapshot;
			const onAccessChanged = typeof deps.onAccessChanged === 'function' ? deps.onAccessChanged : function () {};

			let _eventSource = null;
			let _myConnectionId = null;
			let _currentCanvasId = null;
			let _outboundSequence = 0;
			let _localCanEdit = true;
			let _localRole = null;
			let _localAccessRevoked = false;
			let _latestAppliedRevision = 0;
			let _durableRevision = 0;
			let _serverRevision = 0;
			let _hasRevisionGap = false;
			let _snapshotApplyPromise = null;
			const _queuedSnapshotEvents = [];
			// Monotonic per-connection sequence numbers let the server reject stale collaboration events.
			function _nextSequence() {
				_outboundSequence += 1;
				return _outboundSequence;
			}
			function _observeRevision(value) {
				if (!Number.isSafeInteger(value) || value < 0) {
					return;
				}
				if (_latestAppliedRevision > 0 && value > _latestAppliedRevision + 1) {
					_hasRevisionGap = true;
				}
				_latestAppliedRevision = Math.max(_latestAppliedRevision, value);
				_serverRevision = Math.max(_serverRevision, value);
			}
			function _canonicalSnapshot(value, isRoot, depth) {
				depth = depth || 0;
				if (depth > 64) {
					throw new Error('canvas snapshot exceeds the supported nesting depth');
				}
				if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
					return undefined;
				}
				if (value === null || typeof value === 'string' || typeof value === 'boolean') {
					return value;
				}
				if (typeof value === 'number') {
					return Number.isFinite(value) ? value : null;
				}
				if (Array.isArray(value)) {
					return value.map((item) => {
						const normalized = _canonicalSnapshot(item, false, depth + 1);
						return normalized === undefined ? null : normalized;
					});
				}
				if (typeof value === 'object') {
					const out = {};
					Object.keys(value)
						.sort()
						.forEach((key) => {
							if (isRoot && key === '_meta') {
								return;
							}
							const normalized = _canonicalSnapshot(value[key], false, depth + 1);
							if (normalized !== undefined) {
								out[key] = normalized;
							}
						});
					return out;
				}
				return undefined;
			}
			async function _currentSnapshotHash() {
				try {
					if (
						!window.crypto ||
						!window.crypto.subtle ||
						typeof window.crypto.subtle.digest !== 'function' ||
						typeof TextEncoder === 'undefined'
					) {
						return null;
					}
					const payload = buildCanvasPayload();
					const canonical = JSON.stringify(_canonicalSnapshot(payload || {}, true, 0));
					const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
					return Array.from(new Uint8Array(digest))
						.map((byte) => byte.toString(16).padStart(2, '0'))
						.join('');
				} catch (_) {
					return null;
				}
			}
			const _mutationInFlight = new Map();
			const _mutationRetry = new Map();
			const _failedMutationKeys = new Set();
			let _mutationFailureCount = 0;
			let _syncWarningShown = false;
			let _mutationGeneration = 0;
			const MUTATION_RETRY_MAX_MS = 30_000;

			function _mutationCanSend(key) {
				if (_mutationInFlight.has(key)) {
					return false;
				}
				const retry = _mutationRetry.get(key);
				return !retry || Date.now() >= retry.nextAt;
			}

			function _mutationFailure(key) {
				const previous = _mutationRetry.get(key);
				const attempts = (previous ? previous.attempts : 0) + 1;
				const delay = Math.min(MUTATION_RETRY_MAX_MS, 1000 * Math.pow(2, attempts - 1));
				_mutationRetry.set(key, { attempts, nextAt: Date.now() + delay });
				_failedMutationKeys.add(key);
				_mutationFailureCount += 1;
				if (_mutationFailureCount >= 3 && !_syncWarningShown) {
					_syncWarningShown = true;
					showBulkToast(
						'Live sharing is temporarily disconnected. Your changes remain on this canvas, but collaborators may not see them yet. Org Loom will keep retrying.',
						'error',
					);
				}
			}

			function _mutationAccepted(key) {
				_mutationRetry.delete(key);
				_failedMutationKeys.delete(key);
				if (_failedMutationKeys.size > 0) {
					return;
				}
				_mutationFailureCount = 0;
				if (_syncWarningShown) {
					_syncWarningShown = false;
					showBulkToast('Live sharing reconnected. Your pending changes are now synchronized.', 'info');
				}
			}

			function _resetMutationTracking() {
				_mutationGeneration += 1;
				_mutationInFlight.clear();
				_mutationRetry.clear();
				_failedMutationKeys.clear();
				_mutationFailureCount = 0;
				_syncWarningShown = false;
			}

			function _sendDesiredMutation(key, requestFactory, onAccepted) {
				if (!_mutationCanSend(key)) {
					return false;
				}
				const token = { generation: _mutationGeneration };
				_mutationInFlight.set(key, token);
				let request;
				try {
					request = requestFactory();
				} catch (_error) {
					_mutationInFlight.delete(key);
					_mutationFailure(key);
					return false;
				}
				Promise.resolve(request)
					.then(async (response) => {
						if (!response || response.ok === false) {
							throw new Error('live mutation was not accepted');
						}
						let data = null;
						const readable = response && typeof response.clone === 'function' ? response.clone() : response;
						if (readable && typeof readable.json === 'function') {
							data = await readable.json().catch(() => null);
						}
						if (token.generation !== _mutationGeneration) {
							return;
						}
						_observeRevision(data && data.revision);
						onAccepted(data);
						_mutationAccepted(key);
					})
					.catch(() => {
						if (token.generation === _mutationGeneration) {
							_mutationFailure(key);
						}
					})
					.finally(() => {
						if (_mutationInFlight.get(key) === token) {
							_mutationInFlight.delete(key);
						}
					});
				return true;
			}
			const _peers = new Map();
			const _shareCounts = new Map();

			let _cursorLayer = null;
			let _cursorHost = null;
			let _mouseTrackingHost = null;
			let _presenceChips = null;

			let _lastCursorPostAt = 0;
			const CURSOR_THROTTLE_MS = 100;
			let _pendingCursorAbort = null;
			let _cursorPublished = false;
			let _hasLocalFocus = false;
			let _lastLocalFocus = null;

			function _savedCanvasId(value) {
				const id = String(value || '');
				return /^[a-zA-Z0-9]{15,18}$/.test(id) ? id : null;
			}

			function _resolveCanvasId() {
				if (canvasState.currentCanvas && canvasState.currentCanvas.id) {
					const current = canvasState.currentCanvas;
					if (current.ownedByMe && !(_shareCounts.get(current.id) > 0)) {
						return null;
					}
					return _savedCanvasId(current.id);
				}
				const cs = window.Orgloom && window.Orgloom.canvasState;
				if (cs && typeof cs.getCurrentCanvas === 'function') {
					const c = cs.getCurrentCanvas();
					return _savedCanvasId(c && c.canvasId);
				}
				return null;
			}

			window.addEventListener('orgloom:canvas-share-count', (event) => {
				const detail = event.detail || {};
				if (!detail.canvasId) {
					return;
				}
				_shareCounts.set(detail.canvasId, Number(detail.count) || 0);
				if (detail.count > 0) {
					subscribeToCanvas(detail.canvasId);
				} else if (_currentCanvasId === detail.canvasId) {
					unsubscribe();
				}
			});

			function _canvasHost() {
				const graph = getGraph();
				return graph && graph.querySelector
					? graph.querySelector('#graph-bulk') || graph.querySelector('#bulk-canvas')
					: null;
			}

			function _ensureCursorLayer() {
				const host = _canvasHost();
				if (!host) {
					return null;
				}
				if (_cursorLayer && _cursorHost === host && _cursorLayer.parentNode === host) {
					return _cursorLayer;
				}
				if (_cursorLayer && typeof _cursorLayer.remove === 'function') {
					_cursorLayer.remove();
				}
				_cursorLayer = document.createElement('div');
				_cursorLayer.className = 'presence-cursor-layer';
				_cursorLayer.setAttribute('aria-hidden', 'true');
				host.appendChild(_cursorLayer);
				_cursorHost = host;
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
				const layer = _ensureCursorLayer();
				if (!layer) {
					return;
				}
				let el = layer.querySelector('[data-conn="' + peer.connectionId + '"]');
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
					layer.appendChild(el);
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
					const layerRect = layer.getBoundingClientRect();
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

			function _positionChipStrip() {}

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
				strip.innerHTML = peersArr
					.map(
						(p) =>
							'<span class="presence-chip" title="' +
							escapeHtml(p.displayName) +
							' is on this canvas" style="background:' +
							p.color +
							'">' +
							escapeHtml(_initials(p.displayName)) +
							'</span>',
					)
					.join('');
				_positionChipStrip();
			}

			function _onPresenceInit(data) {
				_myConnectionId = data.you && data.you.connectionId;
				_localCanEdit = !(data.you && data.you.canEdit === false);
				_localRole = (data.you && data.you.role) || (_localCanEdit ? 'editor' : 'viewer');
				_localAccessRevoked = false;
				_durableRevision = Number.isSafeInteger(data.durableRevision) ? data.durableRevision : 0;
				_latestAppliedRevision = _durableRevision;
				_serverRevision = Number.isSafeInteger(data.revision) ? data.revision : _durableRevision;
				_hasRevisionGap = _serverRevision > _durableRevision;
				_seedLoadedRecordBaselines();
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
				_publishLocalFocus();
				_flushPendingLayouts();
			}

			async function _applyLiveSnapshotEvent(data) {
				try {
					await applyLiveSnapshot(data.payload || {}, {
						revision: data.revision,
						durableRevision: data.durableRevision,
					});
					_durableRevision = Number.isSafeInteger(data.durableRevision)
						? data.durableRevision
						: _durableRevision;
					_latestAppliedRevision = Number.isSafeInteger(data.revision)
						? data.revision
						: _latestAppliedRevision;
					_serverRevision = Math.max(_serverRevision, _latestAppliedRevision);
					_hasRevisionGap = false;
					_seedLoadedRecordBaselines();
					_flushPendingDraftLinks();
					_reapplyAllFocus();
				} catch (error) {
					_hasRevisionGap = true;
					window.ORGLOOM_capture && window.ORGLOOM_capture(error, { where: 'presence.js/applyLiveSnapshot' });
					try {
						showBulkToast(
							'Current live changes could not be synchronized. Reload the canvas before editing.',
							'error',
						);
					} catch (_) {}
				} finally {
					_snapshotApplyPromise = null;
					const queued = _queuedSnapshotEvents.splice(0);
					queued.sort((left, right) => (left.revision || 0) - (right.revision || 0));
					for (const event of queued) {
						await _onPresenceEvent(event);
					}
				}
			}

			async function _onPresenceEvent(data) {
				if (!data || !data.type) {
					return;
				}
				if (_snapshotApplyPromise) {
					_queuedSnapshotEvents.push(data);
					return;
				}
				if (data.type === 'live-snapshot') {
					_snapshotApplyPromise = _applyLiveSnapshotEvent(data);
					await _snapshotApplyPromise;
					return;
				}
				if (data.type === 'live-snapshot-unavailable') {
					_hasRevisionGap = true;
					try {
						showBulkToast(
							'Current live changes could not be synchronized. Reload the canvas before editing.',
							'error',
						);
					} catch (_) {}
					return;
				}
				if (data.type === 'canvas-saved') {
					_onCanvasSaved(data);
					return;
				}
				if (data.type === 'access-changed') {
					_onAccessChanged(data);
					return;
				}
				if (data.type === 'draft-update') {
					_observeRevision(data.revision);
					_applyPeerDraftUpdate(data);
					return;
				}
				if (data.type === 'loaded-record') {
					_observeRevision(data.revision);
					_applyPeerLoadedRecord(data);
					return;
				}
				if (data.type === 'loaded-removed') {
					_observeRevision(data.revision);
					_applyPeerLoadedRemoved(data);
					return;
				}
				if (data.type === 'slot-update') {
					_observeRevision(data.revision);
					_applyPeerSlotUpdate(data);
					return;
				}
				if (data.type === 'draft-link') {
					_observeRevision(data.revision);
					_applyPeerDraftLink(data);
					return;
				}
				if (data.type === 'record-layout') {
					_observeRevision(data.revision);
					_applyPeerLayout(data);
					return;
				}
				if (data.type === 'join' && data.peer) {
					const wasAlone = _peers.size === 0;
					_peers.set(data.peer.connectionId, data.peer);
					_renderChips();
					if (wasAlone) {
						_publishLocalFocus();
					}
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
					if (_peers.size === 0) {
						_clearPublishedCursor();
					}
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
				document
					.querySelectorAll('.presence-focus-label[data-presence-focus="' + connectionId + '"]')
					.forEach((el) => el.remove());
				document.querySelectorAll('[data-presence-focus-by="' + connectionId + '"]').forEach((el) => {
					el.removeAttribute('data-presence-focus-by');
					el.style.removeProperty('--presence-focus-color');
				});
			}
			function _recordForRef(reference) {
				if (!reference || reference.ref == null || !Array.isArray(canvasState.bulkRecords)) {
					return null;
				}
				const ref = String(reference.ref);
				const collabRef = reference.collabRef == null ? null : String(reference.collabRef);
				const matchesPrimaryRef = (record) => {
					if (reference.refKind === 'slot') {
						return record.slot && record.slot.slotId != null && String(record.slot.slotId) === ref;
					}
					if (reference.refKind === 'draft') {
						const draftRef =
							record._persistedTempId != null ? record._persistedTempId : record._collabId || record.id;
						return !record.loadedFromId && draftRef != null && String(draftRef) === ref;
					}
					return record.loadedFromId && String(record.loadedFromId) === ref;
				};
				if (collabRef != null) {
					const exact = canvasState.bulkRecords.find(
						(record) =>
							record &&
							matchesPrimaryRef(record) &&
							((record._canvasRecordId != null && String(record._canvasRecordId) === collabRef) ||
								(record._collabId != null && String(record._collabId) === collabRef)),
					);
					if (exact) {
						return exact;
					}
					return null;
				}
				return (
					canvasState.bulkRecords.find((record) => {
						if (!record) {
							return false;
						}
						return matchesPrimaryRef(record);
					}) || null
				);
			}
			function _ensureCanvasRecordId(record) {
				if (record._canvasRecordId != null && String(record._canvasRecordId)) {
					return String(record._canvasRecordId);
				}
				if (record._collabId != null && String(record._collabId)) {
					record._canvasRecordId = String(record._collabId);
					return record._canvasRecordId;
				}
				record._canvasRecordId = _mintCollabId();
				if (!record.loadedFromId && record._persistedTempId == null) {
					record._collabId = record._canvasRecordId;
				}
				return record._canvasRecordId;
			}
			function _recordReference(record) {
				if (!record || record.isTypeNode || record.isPending) {
					return null;
				}
				let out;
				if (record.slot && record.slot.slotId != null) {
					out = { refKind: 'slot', ref: String(record.slot.slotId) };
				} else if (record.loadedFromId) {
					out = { refKind: 'loaded', ref: String(record.loadedFromId) };
				} else {
					const ref =
						record._persistedTempId != null ? record._persistedTempId : record._collabId || record.id;
					if (ref == null) {
						return null;
					}
					out = { refKind: 'draft', ref: String(ref) };
				}
				out.collabRef = _ensureCanvasRecordId(record);
				return out;
			}
			function _underlyingRecordReference(record) {
				if (!record || record.isTypeNode || record.isPending) {
					return null;
				}
				let out;
				if (record.loadedFromId) {
					out = { refKind: 'loaded', ref: String(record.loadedFromId) };
				} else {
					const ref =
						record._persistedTempId != null ? record._persistedTempId : record._collabId || record.id;
					if (ref == null) {
						return null;
					}
					out = { refKind: 'draft', ref: String(ref) };
				}
				out.collabRef = _ensureCanvasRecordId(record);
				return out;
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
				const rec = _recordForRef(focus);
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

			function _applyPeerLayout(data) {
				if (!data || !Array.isArray(data.positions)) {
					return;
				}
				const cy = getCyInstance && getCyInstance();
				for (const position of data.positions) {
					const record = _recordForRef(position);
					if (!record || typeof position.x !== 'number' || typeof position.y !== 'number') {
						continue;
					}
					record.x = position.x;
					record.y = position.y;
					if (cy && typeof cy.getElementById === 'function') {
						const node = cy.getElementById('r' + record.id);
						if (node && node.length && !node.grabbed()) {
							node.position({ x: position.x, y: position.y });
						}
					}
				}
			}

			const _lastBroadcastDraftValues = new Map();
			const _lastBroadcastLoadedRefs = new Map();
			const _lastBroadcastLoadedRecords = new Map();
			const _lastBroadcastSlots = new Map();
			const _lastBroadcastLinks = new Map();
			const _pendingLayoutPositions = new Map();
			const DRAFT_BROADCAST_INTERVAL_MS = 2000;

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

			function _loadedRecordSnapshot(record) {
				return {
					fields: _safeValueCopy(record && record.values),
					baseline: _safeValueCopy(record && record.loadedValues),
					pendingDelete: !!(record && record.pendingDelete),
				};
			}

			function _safeSlotCopy(slot) {
				if (!slot || slot.slotId == null) {
					return null;
				}
				const copy = {
					slotId: slot.slotId,
					kind: slot.kind === 'fields' ? 'fields' : 'whole-record',
					label: slot.label || null,
					description: slot.description || null,
					assigneeSfUserId: slot.assigneeSfUserId || null,
					assigneeName: slot.assigneeName || null,
					assigneeEmail: slot.assigneeEmail || null,
				};
				if (copy.kind === 'fields') {
					copy.fields = Array.isArray(slot.fields) ? slot.fields.slice() : [];
				}
				return copy;
			}

			function _seedLoadedRecordBaselines() {
				_lastBroadcastDraftValues.clear();
				_lastBroadcastLoadedRecords.clear();
				_lastBroadcastLoadedRefs.clear();
				_lastBroadcastSlots.clear();
				_lastBroadcastLinks.clear();
				if (!Array.isArray(canvasState.bulkRecords)) {
					return;
				}
				for (const record of canvasState.bulkRecords) {
					if (!record || record.isTypeNode) {
						continue;
					}
					if (record.loadedFromId) {
						const sfId = String(record.loadedFromId);
						const cardRef = _ensureCanvasRecordId(record);
						_lastBroadcastLoadedRefs.set(cardRef, sfId);
						_lastBroadcastLoadedRecords.set(cardRef, _loadedRecordSnapshot(record));
					} else {
						const syncId = _syncIdOf(record);
						if (syncId != null) {
							_lastBroadcastDraftValues.set(syncId, {
								values: _safeValueCopy(record.values),
								x: typeof record.x === 'number' ? record.x : null,
								y: typeof record.y === 'number' ? record.y : null,
							});
						}
					}
				}
				for (const record of canvasState.bulkRecords) {
					const targetRef = _underlyingRecordReference(record);
					if (!targetRef) {
						continue;
					}
					_lastBroadcastSlots.set(JSON.stringify(targetRef), JSON.stringify(_safeSlotCopy(record.slot)));
				}
				const recordsByRuntimeId = new Map(
					canvasState.bulkRecords
						.filter((record) => record && record.id != null)
						.map((record) => [record.id, record]),
				);
				for (const association of Array.isArray(canvasState.bulkAssociations)
					? canvasState.bulkAssociations
					: []) {
					const fromRef = _recordReference(recordsByRuntimeId.get(association && association.fromId));
					const toRef = _recordReference(recordsByRuntimeId.get(association && association.toId));
					if (!fromRef || !toRef || !association.fieldName) {
						continue;
					}
					const key = JSON.stringify([fromRef, toRef, association.fieldName]);
					_lastBroadcastLinks.set(key, {
						fromRef,
						toRef,
						fieldName: association.fieldName,
					});
				}
			}

			function _postLoadedRecord(key, payload, onAccepted) {
				return _sendDesiredMutation(
					key,
					() => {
						payload.connectionId = _myConnectionId;
						payload.sequence = _nextSequence();
						return csrfFetch(
							'/api/canvas/' + encodeURIComponent(_currentCanvasId) + '/presence/loaded-record',
							{
								method: 'POST',
								credentials: 'same-origin',
								headers: { 'Content-Type': 'application/json' },
								body: JSON.stringify(payload),
							},
						);
					},
					onAccepted,
				);
			}

			async function _applyPeerLoadedRecord(data) {
				if (!data || !data.sfId || !Array.isArray(canvasState.bulkRecords)) {
					return;
				}
				const sfId = String(data.sfId);
				let target = _recordForRef({
					refKind: 'loaded',
					ref: sfId,
					collabRef: data.collabRef,
				});
				if (!target && data.kind === 'create') {
					if (!data.objectName || typeof data.objectName !== 'string') {
						return;
					}
					let selected = canvasState.selectedObjects.find((entry) => entry.name === data.objectName);
					if (!selected) {
						try {
							selected = await addToSelection(data.objectName);
						} catch (_) {
							selected = null;
						}
					}
					target = {
						id: canvasState.bulkIdSeq++,
						objectName: data.objectName,
						label: (selected && selected.label) || data.objectName,
						fromSelectionId: selected ? selected.id : null,
						loadedFromId: sfId,
						_canvasRecordId: data.collabRef || _mintCollabId(),
						x: Number.isFinite(data.x) ? data.x : 200,
						y: Number.isFinite(data.y) ? data.y : 200,
						loadedValues: _safeValueCopy(data.baseline),
						values: {},
					};
					canvasState.bulkRecords.push(target);
				}
				if (!target) {
					return;
				}
				const values = (target.values = target.values || {});
				for (const key of Object.keys(data.fields || {})) {
					if (data.fields[key] === null) {
						delete values[key];
					} else {
						values[key] = data.fields[key];
					}
				}
				if (typeof data.pendingDelete === 'boolean') {
					target.pendingDelete = data.pendingDelete;
				}
				const cardRef = _ensureCanvasRecordId(target);
				_lastBroadcastLoadedRefs.set(cardRef, sfId);
				_lastBroadcastLoadedRecords.set(cardRef, _loadedRecordSnapshot(target));
				renderBulkView();
				if (data.kind === 'create') {
					_flushPendingDraftLinks();
				}
			}

			function _postSlotUpdate(key, targetRef, slot, onAccepted) {
				return _sendDesiredMutation(
					key,
					() =>
						csrfFetch('/api/canvas/' + encodeURIComponent(_currentCanvasId) + '/presence/slot', {
							method: 'POST',
							credentials: 'same-origin',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({
								connectionId: _myConnectionId,
								sequence: _nextSequence(),
								targetRef,
								slot,
							}),
						}),
					onAccepted,
				);
			}

			function _applyPeerSlotUpdate(data) {
				if (!data || !data.targetRef || !Array.isArray(canvasState.bulkRecords)) {
					return;
				}
				const target = _recordForRef(data.targetRef);
				if (!target) {
					return;
				}
				if (data.slot === null) {
					delete target.slot;
				} else if (data.slot && typeof data.slot === 'object') {
					target.slot = Object.assign({}, data.slot);
					if (Array.isArray(data.slot.fields)) {
						target.slot.fields = data.slot.fields.slice();
					}
				}
				const targetRef = _underlyingRecordReference(target);
				if (targetRef) {
					_lastBroadcastSlots.set(JSON.stringify(targetRef), JSON.stringify(_safeSlotCopy(target.slot)));
				}
				renderBulkView();
				_flushPendingDraftLinks();
			}

			function _postDraftPayload(key, payload, onAccepted) {
				return _sendDesiredMutation(
					key,
					() => {
						payload.sequence = _nextSequence();
						return csrfFetch('/api/canvas/' + encodeURIComponent(_currentCanvasId) + '/presence/draft', {
							method: 'POST',
							credentials: 'same-origin',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify(payload),
						});
					},
					onAccepted,
				);
			}
			function _broadcastDraftDeltas() {
				if (!_localCanEdit || !_currentCanvasId || !_myConnectionId) {
					return;
				}
				if (!Array.isArray(canvasState.bulkRecords)) {
					return;
				}
				_flushPendingDraftLinks();
				const seenIds = new Set();
				// Only drafts are co-edited here; existing Salesforce records retain their own write flow.
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
					if (syncId == null) {
						r._collabId = _mintCollabId();
						syncId = r._collabId;
					}
					const isFirstBroadcast = !_lastBroadcastDraftValues.has(syncId);
					if (isFirstBroadcast) {
						const initialValues = _safeValueCopy(r.values);
						const initX = typeof r.x === 'number' ? r.x : 200;
						const initY = typeof r.y === 'number' ? r.y : 200;
						const sentEntry = {
							values: initialValues,
							x: initX,
							y: initY,
						};
						_postDraftPayload(
							'draft:' + syncId,
							{
								connectionId: _myConnectionId,
								tempId: syncId,
								canvasRecordId: _ensureCanvasRecordId(r),
								kind: 'create',
								objectName: r.objectName || null,
								x: initX,
								y: initY,
								fields: initialValues,
							},
							() => _lastBroadcastDraftValues.set(syncId, sentEntry),
						);
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
					if (!hasFieldsDiff) {
						continue;
					}
					const payload = {
						connectionId: _myConnectionId,
						tempId: syncId,
						fields: hasFieldsDiff ? diff : {},
					};
					const sentEntry = {
						values: cur,
						x: curX,
						y: curY,
					};
					_postDraftPayload('draft:' + syncId, payload, () =>
						_lastBroadcastDraftValues.set(syncId, sentEntry),
					);
				}
				const toRemove = [];
				for (const k of _lastBroadcastDraftValues.keys()) {
					if (!seenIds.has(k)) {
						toRemove.push(k);
					}
				}
				for (const k of toRemove) {
					_postDraftPayload(
						'draft:' + k,
						{
							connectionId: _myConnectionId,
							tempId: k,
							kind: 'remove',
							fields: {},
						},
						() => _lastBroadcastDraftValues.delete(k),
					);
				}
				const currentLoadedRefs = new Map();
				for (const r of canvasState.bulkRecords) {
					if (!r || r.isTypeNode || !r.loadedFromId) {
						continue;
					}
					const sfId = String(r.loadedFromId);
					const cardRef = _ensureCanvasRecordId(r);
					currentLoadedRefs.set(cardRef, sfId);
					const current = _loadedRecordSnapshot(r);
					const previous = _lastBroadcastLoadedRecords.get(cardRef);
					if (!previous) {
						_postLoadedRecord(
							'loaded:' + cardRef,
							{
								kind: 'create',
								sfId,
								collabRef: cardRef,
								objectName: r.objectName,
								fields: current.fields,
								baseline: current.baseline,
								x: r.x,
								y: r.y,
								pendingDelete: current.pendingDelete,
							},
							() => {
								_lastBroadcastLoadedRefs.set(cardRef, sfId);
								_lastBroadcastLoadedRecords.set(cardRef, current);
							},
						);
						continue;
					}
					const diff = {};
					let changed = false;
					for (const key of Object.keys(current.fields)) {
						if (current.fields[key] !== previous.fields[key]) {
							diff[key] = current.fields[key];
							changed = true;
						}
					}
					for (const key of Object.keys(previous.fields)) {
						if (!(key in current.fields)) {
							diff[key] = null;
							changed = true;
						}
					}
					const deleteChanged = current.pendingDelete !== previous.pendingDelete;
					if (changed || deleteChanged) {
						_postLoadedRecord(
							'loaded:' + cardRef,
							{
								kind: 'update',
								sfId,
								collabRef: cardRef,
								fields: diff,
								pendingDelete: current.pendingDelete,
							},
							() => _lastBroadcastLoadedRecords.set(cardRef, current),
						);
					}
				}
				const removedLoadedRefs = [];
				for (const [cardRef, sfId] of _lastBroadcastLoadedRefs) {
					if (!currentLoadedRefs.has(cardRef)) {
						removedLoadedRefs.push({ cardRef, sfId });
					}
				}
				for (const removed of removedLoadedRefs) {
					_sendDesiredMutation(
						'loaded:' + removed.cardRef,
						() =>
							csrfFetch(
								'/api/canvas/' + encodeURIComponent(_currentCanvasId) + '/presence/record-remove',
								{
									method: 'POST',
									credentials: 'same-origin',
									headers: { 'Content-Type': 'application/json' },
									body: JSON.stringify({
										connectionId: _myConnectionId,
										sequence: _nextSequence(),
										sfId: removed.sfId,
										collabRef: removed.cardRef,
									}),
								},
							),
						() => {
							_lastBroadcastLoadedRefs.delete(removed.cardRef);
							_lastBroadcastLoadedRecords.delete(removed.cardRef);
						},
					);
				}
				const currentSlotKeys = new Set();
				for (const record of canvasState.bulkRecords) {
					const targetRef = _underlyingRecordReference(record);
					if (!targetRef) {
						continue;
					}
					const key = JSON.stringify(targetRef);
					const sentSlot = _safeSlotCopy(record.slot);
					const serialized = JSON.stringify(sentSlot);
					currentSlotKeys.add(key);
					if (_lastBroadcastSlots.get(key) !== serialized) {
						_postSlotUpdate('slot:' + key, targetRef, sentSlot, () =>
							_lastBroadcastSlots.set(key, serialized),
						);
					}
				}
				for (const key of Array.from(_lastBroadcastSlots.keys())) {
					if (!currentSlotKeys.has(key)) {
						_lastBroadcastSlots.delete(key);
					}
				}
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
						if (fromRec.isTypeNode || toRec.isTypeNode) {
							continue;
						}
						const fromRef = _recordReference(fromRec);
						const toRef = _recordReference(toRec);
						if (!fromRef || !toRef) {
							continue;
						}
						if (!a.fieldName) {
							continue;
						}
						const key = JSON.stringify([fromRef, toRef, a.fieldName]);
						currentLinks.set(key, {
							fromRef,
							toRef,
							fieldName: a.fieldName,
						});
					}
				}
				for (const [key, link] of _lastBroadcastLinks) {
					if (currentLinks.has(key)) {
						continue;
					}
					_sendDesiredMutation(
						'link:' + key,
						() =>
							csrfFetch('/api/canvas/' + encodeURIComponent(_currentCanvasId) + '/presence/draft-link', {
								method: 'POST',
								credentials: 'same-origin',
								headers: { 'Content-Type': 'application/json' },
								body: JSON.stringify({
									connectionId: _myConnectionId,
									sequence: _nextSequence(),
									kind: 'remove',
									fromRef: link.fromRef,
									toRef: link.toRef,
									fieldName: link.fieldName,
								}),
							}),
						() => _lastBroadcastLinks.delete(key),
					);
				}
				for (const [key, link] of currentLinks) {
					if (_lastBroadcastLinks.has(key)) {
						continue;
					}
					_sendDesiredMutation(
						'link:' + key,
						() =>
							csrfFetch('/api/canvas/' + encodeURIComponent(_currentCanvasId) + '/presence/draft-link', {
								method: 'POST',
								credentials: 'same-origin',
								headers: { 'Content-Type': 'application/json' },
								body: JSON.stringify({
									connectionId: _myConnectionId,
									sequence: _nextSequence(),
									kind: 'add',
									fromRef: link.fromRef,
									toRef: link.toRef,
									fieldName: link.fieldName,
								}),
							}),
						() => _lastBroadcastLinks.set(key, link),
					);
				}
			}

			const _pendingDraftLinks = [];
			const PENDING_LINKS_CAP = 100;

			function _tryApplyPeerDraftLink(data) {
				if (!data || !data.kind || !data.fieldName) {
					return true;
				}
				if (!Array.isArray(canvasState.bulkRecords)) {
					return false;
				}
				const fromRef =
					data.fromRef ||
					(data.fromSyncId
						? { refKind: 'draft', ref: String(data.fromSyncId), collabRef: String(data.fromSyncId) }
						: null);
				const toRef =
					data.toRef ||
					(data.toSyncId
						? { refKind: 'draft', ref: String(data.toSyncId), collabRef: String(data.toSyncId) }
						: null);
				if (!fromRef || !toRef) {
					return true;
				}
				const fromRec = _recordForRef(fromRef);
				const toRec = _recordForRef(toRef);
				if (!fromRec || !toRec) {
					return false;
				}
				if (fromRec._inaccessible || toRec._inaccessible) {
					return true;
				}
				const key = JSON.stringify([fromRef, toRef, data.fieldName]);
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
					fromRec.values = fromRec.values || {};
					if (toRec.loadedFromId) {
						fromRec.values[data.fieldName] = toRec.loadedFromId;
					} else {
						delete fromRec.values[data.fieldName];
					}
					_lastBroadcastLinks.set(key, {
						fromRef,
						toRef,
						fieldName: data.fieldName,
					});
				} else if (data.kind === 'remove') {
					const before = canvasState.bulkAssociations.length;
					canvasState.bulkAssociations = canvasState.bulkAssociations.filter(
						(a) => !(a && a.fromId === fromRec.id && a.toId === toRec.id && a.fieldName === data.fieldName),
					);
					if (canvasState.bulkAssociations.length === before) {
						return true;
					} // nothing to do
					if (
						fromRec.values &&
						toRec.loadedFromId &&
						String(fromRec.values[data.fieldName] || '').slice(0, 15) ===
							String(toRec.loadedFromId).slice(0, 15)
					) {
						delete fromRec.values[data.fieldName];
					}
					_lastBroadcastLinks.delete(key);
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
				const target = _recordForRef({
					refKind: 'loaded',
					ref: targetSfId,
					collabRef: data.collabRef,
				});
				if (!target) {
					if (data.collabRef) {
						_lastBroadcastLoadedRefs.delete(String(data.collabRef));
						_lastBroadcastLoadedRecords.delete(String(data.collabRef));
					}
					return;
				}
				let removedRuntimeId = null;
				const remaining = [];
				for (const r of canvasState.bulkRecords) {
					if (!r) {
						remaining.push(r);
						continue;
					}
					if (r.isTypeNode) {
						remaining.push(r);
						continue;
					}
					if (r === target) {
						removedRuntimeId = r.id;
						continue;
					}
					remaining.push(r);
				}
				if (removedRuntimeId == null) {
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
				const cardRef = _ensureCanvasRecordId(target);
				_lastBroadcastLoadedRefs.delete(cardRef);
				_lastBroadcastLoadedRecords.delete(cardRef);
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
				// Remote edits update local state without entering this user's undo stack or echoing immediately.
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
							if (
								canvasState.bulkSelectedIds &&
								typeof canvasState.bulkSelectedIds.delete === 'function'
							) {
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
							_canvasRecordId: data.canvasRecordId || syncId,
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
						target.x = px;
						touched = true;
					}
					if (py != null && target.y !== py) {
						target.y = py;
						touched = true;
					}
				}
				if (data.fields && typeof data.fields === 'object') {
					const values = (target.values = target.values || {});
					for (const k of Object.keys(data.fields)) {
						const v = data.fields[k];
						if (v === null) {
							if (k in values) {
								delete values[k];
								touched = true;
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
			let _accessNotice = null;
			function _reloadCurrentCanvas() {
				const id = _currentCanvasId;
				if (id && /^[a-zA-Z0-9]{15,18}$/.test(id)) {
					window.location.href = '/?openCanvas=' + encodeURIComponent(id);
				} else {
					window.location.reload();
				}
			}

			function _clearAccessNotice() {
				if (!_accessNotice) {
					return;
				}
				try {
					_accessNotice.remove();
				} catch (_) {}
				_accessNotice = null;
			}

			function _showIncreasedAccess(role) {
				_clearAccessNotice();
				const label = role === 'editor' ? 'Editor' : 'Contributor';
				_accessNotice = document.createElement('div');
				_accessNotice.className = 'presence-saved-banner presence-access-banner';
				_accessNotice.setAttribute('role', 'status');
				_accessNotice.innerHTML =
					'<span class="presence-saved-icon" aria-hidden="true">&#8593;</span>' +
					'<span class="presence-saved-text"><strong>Your access is now ' +
					escapeHtml(label) +
					'.</strong> Reload to use your new permissions.</span>' +
					'<button type="button" class="presence-saved-btn" data-access-action="reload">Reload</button>' +
					'<button type="button" class="presence-saved-btn presence-saved-btn-secondary" data-access-action="dismiss">Later</button>';
				document.body.appendChild(_accessNotice);
				_accessNotice.addEventListener('click', (event) => {
					const button = event.target.closest && event.target.closest('[data-access-action]');
					if (!button) {
						return;
					}
					if (button.getAttribute('data-access-action') === 'reload') {
						_reloadCurrentCanvas();
					} else {
						_clearAccessNotice();
					}
				});
			}

			function _showRestrictedAccess({ role, revoked }) {
				_clearAccessNotice();
				_accessNotice = document.createElement('div');
				_accessNotice.className = 'modal presence-access-modal';
				_accessNotice.setAttribute('role', 'alertdialog');
				_accessNotice.setAttribute('aria-modal', 'true');
				const title = revoked ? 'Canvas access removed' : 'Your canvas access changed';
				const message = revoked
					? 'You no longer have access to this canvas.'
					: 'Your access is now ' +
						(role === 'contributor' ? 'Contributor' : 'View only') +
						'. Editing has stopped. Changes already shared may remain visible to collaborators. Changes that were not submitted or saved will not be applied.';
				_accessNotice.innerHTML =
					'<div class="modal-overlay"></div>' +
					'<div class="modal-body">' +
					'<div class="modal-header"><h3>' +
					escapeHtml(title) +
					'</h3></div>' +
					'<div class="modal-content"><p>' +
					escapeHtml(message) +
					'</p></div>' +
					'<div class="modal-footer"><button type="button" class="primary" data-access-action="reload">' +
					(revoked ? 'Return to workspace' : 'Reload canvas') +
					'</button></div></div>';
				document.body.appendChild(_accessNotice);
				_accessNotice.addEventListener('click', (event) => {
					const button = event.target.closest && event.target.closest('[data-access-action="reload"]');
					if (!button) {
						return;
					}
					if (revoked) {
						window.location.href = '/workspace';
					} else {
						_reloadCurrentCanvas();
					}
				});
			}

			function _onAccessChanged(data) {
				const revoked = !!data.revoked || data.change === 'revoked';
				_localAccessRevoked = revoked;
				if (revoked || data.change === 'decreased') {
					_localCanEdit = false;
				}
				onAccessChanged({
					role: data.role || null,
					previousRole: data.previousRole || null,
					change: data.change || null,
					revoked,
				});
				if (revoked || data.change === 'decreased') {
					_showRestrictedAccess({ role: data.role, revoked });
					return;
				}
				if (data.change === 'increased') {
					_showIncreasedAccess(data.role);
				}
			}

			async function _onCanvasSaved(data) {
				const meAcct = window.SF_ACCOUNT_ID || null;
				const yourSelfAcct = data.savedByAccountId || null;
				let isOwnSave = false;
				if (meAcct && yourSelfAcct) {
					isOwnSave = meAcct === yourSelfAcct;
				}
				if (!isOwnSave && _lastLocalSaveAt && Date.now() - _lastLocalSaveAt < 5000) {
					isOwnSave = true;
				}
				const savedRevision = Number.isSafeInteger(data.revision) ? data.revision : _serverRevision;
				_serverRevision = Math.max(_serverRevision, savedRevision);
				_durableRevision = Math.max(_durableRevision, savedRevision);
				if (isOwnSave) {
					if (
						canvasState.currentCanvas &&
						data.versionId &&
						_currentCanvasId === canvasState.currentCanvas.id
					) {
						canvasState.currentCanvas.versionId = data.versionId;
					}
					_latestAppliedRevision = Math.max(_latestAppliedRevision, savedRevision);
					_hasRevisionGap = false;
					return;
				}
				const name = data.savedByDisplayName || 'Someone';
				const currentHash = data.snapshotHash ? await _currentSnapshotHash() : null;
				if (currentHash && currentHash === data.snapshotHash) {
					if (
						canvasState.currentCanvas &&
						data.versionId &&
						_currentCanvasId === canvasState.currentCanvas.id
					) {
						canvasState.currentCanvas.versionId = data.versionId;
					}
					_latestAppliedRevision = Math.max(_latestAppliedRevision, savedRevision);
					_hasRevisionGap = false;
					_clearSavedBanner();
					try {
						showBulkToast(name + ' saved this canvas. Your view is current.', 'info');
					} catch (_) {}
					return;
				}
				if (_latestAppliedRevision > savedRevision && !_hasRevisionGap) {
					try {
						showBulkToast(name + ' saved this canvas. Newer live changes are still visible.', 'info');
					} catch (_) {}
					return;
				}
				if (!isCanvasDirty()) {
					const ok = await reloadCanvasFromServer();
					if (ok) {
						_refreshCurrentSubscription();
						_latestAppliedRevision = savedRevision;
						_hasRevisionGap = false;
						try {
							showBulkToast(name + ' saved this canvas, and your view updated.', 'info');
						} catch (_) {}
						return;
					}
				}
				_showSavedBanner({ name, at: data.at || Date.now() });
			}
			let _lastLocalSaveAt = 0;
			function noteLocalSave(result) {
				_lastLocalSaveAt = Date.now();
				if (result && Number.isSafeInteger(result.liveRevision)) {
					_latestAppliedRevision = Math.max(_latestAppliedRevision, result.liveRevision);
					_durableRevision = Math.max(_durableRevision, result.liveRevision);
					_serverRevision = Math.max(_serverRevision, result.liveRevision);
					_hasRevisionGap = false;
				}
			}

			function _clearSavedBanner() {
				if (!_savedBanner) {
					return;
				}
				try {
					_savedBanner.remove();
				} catch (_) {}
				_savedBanner = null;
			}

			function _showSavedBanner({ name, at }) {
				_clearSavedBanner();
				_savedBanner = document.createElement('div');
				_savedBanner.className = 'presence-saved-banner';
				_savedBanner.setAttribute('role', 'status');
				_savedBanner.innerHTML =
					'<span class="presence-saved-icon" aria-hidden="true">⟳</span>' +
					'<span class="presence-saved-text">' +
					'<strong>' +
					escapeHtml(name) +
					'</strong> just saved this canvas. ' +
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
						_reloadCurrentCanvas();
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
				const container = typeof cy.container === 'function' ? cy.container() : null;
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
				const container = typeof cy.container === 'function' ? cy.container() : null;
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
				if (_localAccessRevoked || !_currentCanvasId || !_myConnectionId || _peers.size === 0) {
					return;
				}
				const now = Date.now();
				if (now - _lastCursorPostAt < CURSOR_THROTTLE_MS) {
					return;
				}
				_lastCursorPostAt = now;
				const graph = getGraph();
				const host =
					graph && graph.querySelector
						? graph.querySelector('#graph-bulk') || graph.querySelector('#bulk-canvas')
						: null;
				if (!host) {
					return;
				}
				const rect = host.getBoundingClientRect();
				if (
					ev.clientX < rect.left ||
					ev.clientY < rect.top ||
					ev.clientX > rect.right ||
					ev.clientY > rect.bottom
				) {
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
				_cursorPublished = true;
				csrfFetch('/api/canvas/' + encodeURIComponent(_currentCanvasId) + '/presence/cursor', {
					method: 'POST',
					credentials: 'same-origin',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						connectionId: _myConnectionId,
						sequence: _nextSequence(),
						x,
						y,
						world: isWorld,
					}),
					signal: ctl.signal,
				}).catch(() => {
					/* abort/network, silent */
				});
			}

			function _onMouseLeave() {
				if (
					_localAccessRevoked ||
					!_currentCanvasId ||
					!_myConnectionId ||
					_peers.size === 0 ||
					!_cursorPublished
				) {
					return;
				}
				_cursorPublished = false;
				csrfFetch('/api/canvas/' + encodeURIComponent(_currentCanvasId) + '/presence/cursor', {
					method: 'POST',
					credentials: 'same-origin',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						connectionId: _myConnectionId,
						sequence: _nextSequence(),
						x: null,
						y: null,
					}),
				}).catch(() => {});
			}

			function _clearPublishedCursor() {
				if (_localAccessRevoked || !_currentCanvasId || !_myConnectionId || !_cursorPublished) {
					return;
				}
				_cursorPublished = false;
				csrfFetch('/api/canvas/' + encodeURIComponent(_currentCanvasId) + '/presence/cursor', {
					method: 'POST',
					credentials: 'same-origin',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						connectionId: _myConnectionId,
						sequence: _nextSequence(),
						x: null,
						y: null,
					}),
				}).catch(() => {});
			}

			function _attachMouseTracking() {
				const host = _canvasHost();
				if (!host) {
					return;
				}
				if (_mouseTrackingHost === host) {
					return;
				}
				if (_mouseTrackingHost && typeof _mouseTrackingHost.removeEventListener === 'function') {
					_mouseTrackingHost.removeEventListener('mousemove', _onMouseMove);
					_mouseTrackingHost.removeEventListener('mouseleave', _onMouseLeave);
				}
				host.addEventListener('mousemove', _onMouseMove);
				host.addEventListener('mouseleave', _onMouseLeave);
				_mouseTrackingHost = host;
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
				// Keep exactly one EventSource bound to the active saved canvas.
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
						Promise.resolve(_onPresenceEvent(JSON.parse(e.data))).catch((err) => {
							window.ORGLOOM_capture && window.ORGLOOM_capture(err, { where: 'presence.js/sse/event' });
						});
					} catch (err) {
						window.ORGLOOM_capture && window.ORGLOOM_capture(err, { where: 'presence.js/sse/event' });
					}
				});
				_eventSource.addEventListener('error', () => {});
			}

			function _refreshCurrentSubscription() {
				const canvasId = _currentCanvasId;
				if (!canvasId) {
					return;
				}
				unsubscribe();
				subscribeToCanvas(canvasId);
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
				_cursorPublished = false;
				_hasLocalFocus = false;
				_lastLocalFocus = null;
				_localCanEdit = true;
				_localRole = null;
				_localAccessRevoked = false;
				_latestAppliedRevision = 0;
				_durableRevision = 0;
				_serverRevision = 0;
				_hasRevisionGap = false;
				_snapshotApplyPromise = null;
				_queuedSnapshotEvents.length = 0;
				_lastBroadcastDraftValues.clear();
				_lastBroadcastLoadedRefs.clear();
				_lastBroadcastLoadedRecords.clear();
				_lastBroadcastSlots.clear();
				_lastBroadcastLinks.clear();
				_pendingLayoutPositions.clear();
				_resetMutationTracking();
				if (_cursorLayer) {
					_cursorLayer.innerHTML = '';
				}
				_renderChips();
			}

			function _publishLocalFocus() {
				if (
					_localAccessRevoked ||
					!_currentCanvasId ||
					!_myConnectionId ||
					_peers.size === 0 ||
					!_hasLocalFocus
				) {
					return;
				}
				csrfFetch('/api/canvas/' + encodeURIComponent(_currentCanvasId) + '/presence/focus', {
					method: 'POST',
					credentials: 'same-origin',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						connectionId: _myConnectionId,
						sequence: _nextSequence(),
						focus: _lastLocalFocus,
					}),
				}).catch(() => {});
			}

			function pushFocus(focus) {
				_hasLocalFocus = true;
				_lastLocalFocus = focus || null;
				_publishLocalFocus();
			}

			function _layoutPositionKey(position) {
				return JSON.stringify([
					position.refKind,
					position.ref,
					position.collabRef == null ? null : position.collabRef,
				]);
			}

			function _flushPendingLayouts() {
				if (!_localCanEdit || !_currentCanvasId || !_myConnectionId || _pendingLayoutPositions.size === 0) {
					return;
				}
				const sent = Array.from(_pendingLayoutPositions.entries()).slice(0, 500);
				const positions = sent.map((entry) => entry[1]);
				_sendDesiredMutation(
					'layout',
					() =>
						csrfFetch('/api/canvas/' + encodeURIComponent(_currentCanvasId) + '/presence/layout', {
							method: 'POST',
							credentials: 'same-origin',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({
								connectionId: _myConnectionId,
								sequence: _nextSequence(),
								positions,
							}),
						}),
					() => {
						for (const [key, position] of sent) {
							const pending = _pendingLayoutPositions.get(key);
							if (
								pending &&
								pending.x === position.x &&
								pending.y === position.y &&
								pending.refKind === position.refKind &&
								pending.ref === position.ref &&
								pending.collabRef === position.collabRef
							) {
								_pendingLayoutPositions.delete(key);
							}
						}
					},
				);
			}

			function publishLayout(records) {
				if (!_localCanEdit || !_currentCanvasId || !Array.isArray(records)) {
					return;
				}
				records
					.map((record) => {
						const reference = _recordReference(record);
						if (!reference || typeof record.x !== 'number' || typeof record.y !== 'number') {
							return null;
						}
						return Object.assign(reference, { x: record.x, y: record.y });
					})
					.filter(Boolean)
					.forEach((position) => {
						_pendingLayoutPositions.set(_layoutPositionKey(position), position);
					});
				_flushPendingLayouts();
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
				if (_currentCanvasId) {
					_ensureCursorLayer();
					_attachMouseTracking();
				}
				_reapplyAllFocus();
				for (const peer of _peers.values()) {
					if (peer && peer.cursor) {
						_renderCursor(peer);
					}
				}
				_positionChipStrip();
			}, 2000);

			setInterval(() => {
				_broadcastDraftDeltas();
				_flushPendingLayouts();
			}, DRAFT_BROADCAST_INTERVAL_MS);

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
				publishLayout: publishLayout,
				noteLocalSave: noteLocalSave,
			};
		},
	};
})();
