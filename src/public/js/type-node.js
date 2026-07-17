// Type-node lifecycle.
//
// Type-nodes are on-canvas placeholders for an object type. This
// module owns the open/pick/load lifecycle:
//
//   spawnFreeTypeNode(name)
//   pickRecordForFreeTypeNode(rec, anchorEl)
//   loadRecordIntoFreeTypeNode(typeNodeRec, sfRecord)
//   openRelatedSearchFlow({rec, base})
//   openTypeNode(rec, opts): main action; bulk-loads N records
//                             (capped), interposes the soft/hard
//                             threshold confirms.
//
// Dependencies passed to mount(); see code below for the full list.
// seedEditModeTypeNodes is wrapped lazily because related-records
// reaches back via openTypeNode (the pair are co-dependent at runtime).
//
// Exposed as window.OrgLoom.typeNode. Load order: before app.js.

(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.typeNode = {
		mount: function mount(deps) {
			const required = [
				'canvasState', 'csrfFetch', 'escapeHtml',
				'showBulkToast', 'showBulkToastWithAction',
				'_canvasCapBlockReason', '_smoothScrollCanvas',
				'addToSelection', 'inferAssociationsForRecord',
				'purgeRedundantTypeNodes', 'renderBulkView',
				'showLargeRelatedConfirm', 'showRelatedSearchModal',
				'seedEditModeTypeNodes', 'fetchRelatedCount',
				'fetchByRefCached', '_countCacheKey', '_sfIdMatch',
				'_relatedCountCache', '_byRefCache',
				'_RELATED_BULK_LOAD_CAP', '_RELATED_SOFT_THRESHOLD',
				'getGraph', 'getBulkRenderShiftX', 'getBulkRenderShiftY',
			];
			if (!deps) {
throw new Error('type-node.mount: missing deps object');
}
			for (const k of required) {
				if (deps[k] === undefined || deps[k] === null) {
					throw new Error('type-node.mount: missing dep ' + k);
				}
			}
			const canvasState = deps.canvasState;
			const csrfFetch = deps.csrfFetch;
			const escapeHtml = deps.escapeHtml;
			const showBulkToast = deps.showBulkToast;
			const showBulkToastWithAction = deps.showBulkToastWithAction;
			const _canvasCapBlockReason = deps._canvasCapBlockReason;
			// Count-aware canvas record-cap gate (single source of truth).
			// Optional dep so older mounts don't throw; defaults to "always
			// allowed". The pre-fetch _canvasCapBlockReason guard above is a
			// fast estimate; this is re-run post-dedup against the genuinely
			// NEW record count before any record is committed.
			const canvasCapCheck = typeof deps.canvasCapCheck === 'function'
				? deps.canvasCapCheck
				: function () {
 return { ok: true, blocked: false, reason: null }; 
};
			const _smoothScrollCanvas = deps._smoothScrollCanvas;
			const addToSelection = deps.addToSelection;
			const inferAssociationsForRecord = deps.inferAssociationsForRecord;
			const purgeRedundantTypeNodes = deps.purgeRedundantTypeNodes;
			const renderBulkView = deps.renderBulkView;
			const showLargeRelatedConfirm = deps.showLargeRelatedConfirm;
			const showRelatedSearchModal = deps.showRelatedSearchModal;
			const seedEditModeTypeNodes = deps.seedEditModeTypeNodes;
			const fetchRelatedCount = deps.fetchRelatedCount;
			const fetchByRefCached = deps.fetchByRefCached;
			const _countCacheKey = deps._countCacheKey;
			const _sfIdMatch = deps._sfIdMatch;
			const _relatedCountCache = deps._relatedCountCache;
			const _byRefCache = deps._byRefCache;
			const _RELATED_BULK_LOAD_CAP = deps._RELATED_BULK_LOAD_CAP;
			const _RELATED_SOFT_THRESHOLD = deps._RELATED_SOFT_THRESHOLD;
			const getGraph = deps.getGraph;
			const getBulkRenderShiftX = deps.getBulkRenderShiftX;
			const getBulkRenderShiftY = deps.getBulkRenderShiftY;

			function spawnFreeTypeNode(objectName) {
				const meta = (Array.isArray(canvasState.allObjects) ? canvasState.allObjects : []).find((o) => o.name === objectName);
				const label = (meta && meta.label) || objectName;
				const canvas = getGraph().querySelector('#bulk-canvas');
				const cw = (canvas && canvas.clientWidth) || 800;
				const ch = (canvas && canvas.clientHeight) || 600;
				const sl = (canvas && canvas.scrollLeft) || 0;
				const st = (canvas && canvas.scrollTop) || 0;
				// Screen viewport center → world coords. Inverse of the
				// (rec.x + shiftX) * canvasState.bulkZoom transform used at render.
				const worldX = (sl + cw / 2) / canvasState.bulkZoom - getBulkRenderShiftX();
				const worldY = (st + ch / 2) / canvasState.bulkZoom - getBulkRenderShiftY();
				canvasState.bulkRecords.push({
					id: canvasState.bulkIdSeq++,
					isTypeNode: true,
					isFreeTypeNode: true,
					objectName,
					label,
					x: worldX,
					y: worldY,
				});
				renderBulkView();
				showBulkToast('Added ' + label + '; click "Pick record" to load one.');
			}
			
			// Per-type record picker for free type-nodes. Anchors a
			// search popover near the type-node and reuses the
			// /api/objects/:name/search endpoint. Accepts a 15/18-char
			// Salesforce ID directly as a power-user shortcut.
			//
			// `anchorEl` (optional): DOM element to position the popover
			// under, used by the pending-placeholder Load-existing flow
			// so the record-search appears in the same spot as the
			// object-picker that triggered it. When omitted, falls back
			// to canvas-coord math relative to rec.x/y (schema-mode and
			// type-node clicks).
			function pickRecordForFreeTypeNode(rec, anchorEl) {
				document.querySelectorAll('.find-object-popup, .free-tn-picker').forEach((el) => el.remove());
				const pop = document.createElement('div');
				pop.className = 'find-object-popup free-tn-picker';
				pop.style.width = '320px';
				let left, top;
				if (anchorEl && typeof anchorEl.getBoundingClientRect === 'function') {
					const r = anchorEl.getBoundingClientRect();
					left = Math.min(r.left, window.innerWidth - 328);
					top = r.bottom + 6;
				} else {
					const canvas = getGraph().querySelector('#bulk-canvas');
					const canvasRect = canvas ? canvas.getBoundingClientRect() : { left: 8, top: 8 };
					const screenX = (rec.x + getBulkRenderShiftX()) * canvasState.bulkZoom - (canvas ? canvas.scrollLeft : 0);
					const screenY = (rec.y + getBulkRenderShiftY()) * canvasState.bulkZoom - (canvas ? canvas.scrollTop : 0);
					left = Math.min(canvasRect.left + screenX + 70, window.innerWidth - 328);
					top = Math.min(canvasRect.top + screenY - 20, window.innerHeight - 320);
				}
				pop.style.left = Math.max(8, left) + 'px';
				pop.style.top = Math.max(8, top) + 'px';
				pop.innerHTML =
					'<div class="fop-header">' + escapeHtml(rec.label || rec.objectName) + '</div>' +
					'<div class="fop-sub">Search by Name or paste a 15/18-char record ID.</div>' +
					'<input type="search" class="fop-search ftnp-search" placeholder="Search\u2026" autocomplete="off">' +
					'<div class="fop-list ftnp-list"></div>';
				document.body.appendChild(pop);
				const input = pop.querySelector('.ftnp-search');
				const list = pop.querySelector('.ftnp-list');
				let seq = 0;
				const fetchById = async (id) => {
					list.innerHTML = '<div class="fop-empty">Loading record\u2026</div>';
					try {
						const resp = await csrfFetch('/api/objects/' + encodeURIComponent(rec.objectName) + '/records/' + encodeURIComponent(id), { credentials: 'same-origin' });
						if (!resp.ok) {
throw new Error(resp.statusText);
}
						const single = await resp.json();
						cleanup();
						await loadRecordIntoFreeTypeNode(rec, single);
					} catch (e) {
						list.innerHTML = '<div class="fop-empty">Not found.</div>';
					}
				};
				const runSearch = async () => {
					const q = (input.value || '').trim();
					if (/^[a-zA-Z0-9]{15,18}$/.test(q)) {
 fetchById(q); return; 
}
					if (!q) {
 list.innerHTML = ''; return; 
}
					const mySeq = ++seq;
					list.innerHTML = '<div class="fop-empty">Searching\u2026</div>';
					try {
						const resp = await csrfFetch('/api/objects/' + encodeURIComponent(rec.objectName) + '/search?q=' + encodeURIComponent(q), { credentials: 'same-origin' });
						if (!resp.ok) {
throw new Error(resp.statusText);
}
						const data = await resp.json();
						if (mySeq !== seq) {
return;
}
						const records = (data && data.records) || [];
						if (records.length === 0) {
 list.innerHTML = '<div class="fop-empty">No matches.</div>'; return; 
}
						// Mark records already on the canvas so the user
						// doesn't accidentally re-pick one. Match on
						// loadedFromId of the same object type.
						const onCanvas = new Set(
							canvasState.bulkRecords
								.filter((b) => !b.isTypeNode && b.objectName === rec.objectName && b.loadedFromId)
								.map((b) => b.loadedFromId)
						);
						list.innerHTML = records.map((r) => {
							const already = onCanvas.has(r.id);
							return '<button type="button" class="fop-item' + (already ? ' is-already' : '') + '" data-pick-id="' + escapeHtml(r.id) + '"' + (already ? ' disabled title="Already on the canvas"' : '') + '>' +
								'<span class="fop-label">' + escapeHtml(r.name || '(no name)') + '</span>' +
								'<span class="fop-name">' + escapeHtml(r.id) + (already ? ' \u00b7 already loaded' : '') + '</span>' +
							'</button>';
						}).join('');
					} catch (e) {
						if (mySeq !== seq) {
return;
}
						list.innerHTML = '<div class="fop-empty">Search failed.</div>';
					}
				};
				let timer;
				input.addEventListener('input', () => {
					clearTimeout(timer);
					timer = setTimeout(runSearch, 250);
				});
				list.addEventListener('click', (ev) => {
					const btn = ev.target.closest('[data-pick-id]');
					if (!btn || btn.disabled) {
return;
}
					fetchById(btn.dataset.pickId);
				});
				setTimeout(() => input.focus(), 0);
				const cleanup = () => {
					if (pop.parentNode) {
pop.remove();
}
					document.removeEventListener('mousedown', outside, true);
					document.removeEventListener('keydown', onEsc, true);
				};
				const outside = (ev) => {
 if (!pop.contains(ev.target)) {
cleanup();
} 
};
				const onEsc = (ev) => {
 if (ev.key === 'Escape') {
cleanup();
} 
};
				setTimeout(() => {
					document.addEventListener('mousedown', outside, true);
					document.addEventListener('keydown', onEsc, true);
				}, 0);
			}
			
			// Materialize a free type-node into a real record card at
			// the same canvas position, then seed parents/children
			// type-nodes around it so the user can keep traversing
			// from this new entry point.
			async function loadRecordIntoFreeTypeNode(typeNodeRec, sfRecord) {
				if (!sfRecord || !sfRecord.Id) {
					showBulkToast('Record could not be loaded.', 'error');
					return;
				}
				const dup = canvasState.bulkRecords.find((r) => !r.isTypeNode && r.objectName === typeNodeRec.objectName && r.loadedFromId === sfRecord.Id);
				if (dup) {
					const i = canvasState.bulkRecords.findIndex((b) => b.id === typeNodeRec.id);
					if (i !== -1) {
canvasState.bulkRecords.splice(i, 1);
}
					// Surface the already-loaded card instead of just
					// removing the placeholder silently: pan/zoom to
					// it and select it briefly so the user sees where
					// the record they picked already lives.
					canvasState.bulkSelectedIds.clear();
					canvasState.bulkSelectedIds.add(dup.id);
					renderBulkView();
					const canvas = getGraph().querySelector('#bulk-canvas');
					if (canvas) {
						const targetLeft = Math.max(0, (dup.x + getBulkRenderShiftX()) * canvasState.bulkZoom - canvas.clientWidth / 2);
						const targetTop = Math.max(0, (dup.y + getBulkRenderShiftY()) * canvasState.bulkZoom - canvas.clientHeight / 2);
						if (typeof _smoothScrollCanvas === 'function') {
_smoothScrollCanvas(canvas, targetLeft, targetTop, 600);
} else {
 canvas.scrollLeft = targetLeft; canvas.scrollTop = targetTop; 
}
					}
					showBulkToast('That record is already on the canvas.');
					return;
				}
				// Re-check at materialization time. The picker may have remained
				// open while another ingress filled the final canvas slot; the
				// earlier pre-search estimate is no longer authoritative here.
				const cap = canvasCapCheck(1);
				if (cap.blocked) {
					showBulkToast(cap.reason);
					return;
				}
				let targetSel = canvasState.selectedObjects.find((s) => s.name === typeNodeRec.objectName);
				if (!targetSel) {
					try {
 targetSel = await addToSelection(typeNodeRec.objectName); 
} catch (e) {
 console.warn('addToSelection failed for', typeNodeRec.objectName, e); 
}
				}
				const recToValues = (r) => {
					const v = {};
					Object.keys(r).forEach((k) => {
 if (k !== 'attributes' && r[k] != null) {
v[k] = r[k];
} 
});
					return v;
				};
				const values = recToValues(sfRecord);
				const newRec = {
					// REUSE the replaced node's id: the add-undo entry (and the
					// pending-spawn stub) remove by that id, so minting a fresh
					// one turned Ctrl+Z after Load-existing into a silent no-op
					// that then deleted the WRONG (older) card on the next press.
					// (Masked at full speed by the load toast's own undo entry;
					// exposed once the toast expires. Found by the
					// add-edit-records UAT, 2026-07-09.)
					id: typeNodeRec.id != null ? typeNodeRec.id : canvasState.bulkIdSeq++,
					objectName: typeNodeRec.objectName,
					label: targetSel ? targetSel.label : typeNodeRec.objectName,
					x: typeNodeRec.x,
					y: typeNodeRec.y,
					values,
					loadedFromId: sfRecord.Id,
					loadedValues: Object.assign({}, values),
					fromSelectionId: targetSel ? targetSel.id : null,
					_seedingTypes: !!targetSel,
				};
				const idx = canvasState.bulkRecords.findIndex((b) => b.id === typeNodeRec.id);
				if (idx !== -1) {
canvasState.bulkRecords.splice(idx, 1);
}
				canvasState.bulkRecords.push(newRec);
				// Auto-link to records already on the canvas; see
				// inferAssociationsForRecord for the parent/child
				// walk. Without this, a record loaded via Find
				// existing that happens to share an FK with something
				// already on the canvas would render as a
				// disconnected island. purgeRedundantTypeNodes then
				// drops any type-nodes elsewhere on the canvas whose
				// records are now all linked.
				const inferredLinks = inferAssociationsForRecord(newRec, targetSel);
				purgeRedundantTypeNodes();
				renderBulkView();
				if (targetSel) {
					// Hint the seed at "outward" by pointing it at the
					// centroid of existing canvas content. Without this,
					// the seed treats newRec as a base (full circle),
					// and any type-node on the half facing the existing
					// network collides with it and gets launched ~600px
					// outward by collision-push. With outwardFrom set,
					// the descendant branch fires and the clearance
					// sampler picks the half-circle direction with the
					// most open space: type-nodes pack into the empty
					// area instead of fighting the existing network.
					const others = canvasState.bulkRecords.filter((r) => r.id !== newRec.id);
					let seedOpts = {};
					if (others.length > 0) {
						let cx = 0, cy = 0;
						others.forEach((r) => {
 cx += r.x; cy += r.y; 
});
						seedOpts = { outwardFrom: { x: cx / others.length, y: cy / others.length } };
					}
					seedEditModeTypeNodes(newRec, targetSel, seedOpts)
						.catch((e) => console.warn('seedEditModeTypeNodes (free) failed:', e))
						.finally(() => {
 newRec._seedingTypes = false; renderBulkView(); 
});
				}
				const linkSuffix = inferredLinks > 0
					? ' (' + inferredLinks + ' link' + (inferredLinks === 1 ? '' : 's') + ' to existing records)'
					: '';
				showBulkToast('Loaded ' + (newRec.label || newRec.objectName) + linkSuffix + '.');
			}
			
			// "Open" a type-node: query Salesforce for related records of
			// this type, materialize them as regular bulk records linked
			// to the base via association edges, then remove the type-node
			// from the canvas. Idempotent on subsequent opens of the same
			// type, using the same dedup/hydrate logic as Load related so
			// the user never sees duplicate cards for the same SF id.
			// Shared entry point for the search-modal flow used by both
			// the pre-fetch threshold dialog and the post-fetch
			// "Search for more" toast button. Opens showRelatedSearchModal
			// with closure captures for the picked-record materialization
			// path; each pick is fed back through openTypeNode with
			// recordsOverride so the existing materialization logic
			// (dedup, association edges, type-node seeding around the
			// new record) runs unchanged. preserveTypeNode keeps the
			// type-node alive so multiple picks from the same modal all
			// anchor to the same type-node.
			function openRelatedSearchFlow({ rec, base }) {
				const targetType = rec.objectName;
				const fkField = rec.fieldOnOther; // child-direction only; parent dir doesn't hit the threshold
				showRelatedSearchModal({
					targetType,
					targetLabel: rec.label || targetType,
					fkField,
					hostId: base.loadedFromId,
					hostLabel: base.label || base.objectName,
					onPick: async ({ id }) => {
						const resp = await csrfFetch('/api/objects/' + encodeURIComponent(targetType) + '/records/' + encodeURIComponent(id), { credentials: 'same-origin' });
						if (!resp.ok) {
throw new Error(resp.statusText);
}
						const fullRec = await resp.json();
						// Re-materialize the type-node entry if the
						// previous bulk-load already removed it (the
						// truncation-preserve case keeps it alive, but
						// callers may invoke the search flow against a
						// rec that's already gone).
						if (!canvasState.bulkRecords.some((b) => b.id === rec.id)) {
							canvasState.bulkRecords.push(rec);
						}
						await openTypeNode(rec, { recordsOverride: [fullRec], preserveTypeNode: true });
					},
				});
			}
			
			async function openTypeNode(rec, opts) {
				opts = opts || {};
				if (!rec || !rec.isTypeNode) {
return;
}
				if (rec.isFreeTypeNode) {
 pickRecordForFreeTypeNode(rec); return; 
}
				const base = canvasState.bulkRecords.find(b => b.id === rec.hostRecordId);
				if (!base || !base.loadedFromId) {
					showBulkToast('Base record is not loaded.', 'error');
					return;
				}
				const targetType = rec.objectName;
				// Canvas cap guard. Parent-direction type-nodes always
				// add at most one record. Child-direction adds up to
				// `cachedCount` (or the by-ref default of 50 if no count
				// cache yet). opts.recordsOverride is the search-for-more
				// flow which is bounded by the user's pick.
				if (!opts.recordsOverride) {
					let willAdd = 1;
					if (rec.direction === 'child') {
						const k = _countCacheKey(targetType, rec.fieldOnOther, base.loadedFromId);
						const cached = _relatedCountCache.get(k);
						willAdd = Math.min(typeof cached === 'number' ? cached : 50, _RELATED_BULK_LOAD_CAP);
					}
					const blocked = _canvasCapBlockReason(willAdd);
					if (blocked) {
 showBulkToast(blocked); return; 
}
				}
				// Threshold gate. For child-direction type-nodes whose
				// count exceeds _RELATED_SOFT_THRESHOLD, ask the user
				// before pulling the bulk set down: bulk-loading
				// 5K+ cards will choke the renderer regardless of the
				// /by-ref server cap. opts.recordsOverride bypasses
				// this (used by the search-for-more flow which has
				// already chosen a single record).
				//
				// Cache-miss path: the popover that triggered this load
				// usually pre-warms the count cache via the "Children • X"
				// badge, but if the user clicks fast enough to beat the
				// probe, we'd previously skip the prompt and silently
				// bulk-load. Await fetchRelatedCount in that case so the
				// soft-cap is reliable regardless of timing. One extra
				// COUNT() roundtrip in the rare cache-miss case is the
				// right price for not surprising the user with 600 cards.
				if (!opts.recordsOverride && rec.direction === 'child') {
					const countKey = _countCacheKey(targetType, rec.fieldOnOther, base.loadedFromId);
					let cachedCount = _relatedCountCache.get(countKey);
					if (cachedCount == null) {
						rec._loading = true;
						renderBulkView();
						try {
							cachedCount = await fetchRelatedCount(targetType, rec.fieldOnOther, base.loadedFromId);
						} catch (_eCount) {
							cachedCount = null; // fall through; rare server fail shouldn't block load
						}
						rec._loading = false;
					}
					if (cachedCount != null && cachedCount > _RELATED_SOFT_THRESHOLD) {
						const choice = await showLargeRelatedConfirm({
							targetLabel: rec.label || targetType,
							count: cachedCount,
							hostLabel: base.label || base.objectName,
						});
						if (choice === 'cancel') {
return;
}
						if (choice === 'search') {
							openRelatedSearchFlow({ rec, base });
							return;
						}
						// 'load' falls through to the bulk-fetch path
					}
				}
				rec._loading = true;
				renderBulkView();
				try {
					let records = [];
					if (opts.recordsOverride) {
						records = opts.recordsOverride;
					} else if (rec.direction === 'child') {
						records = await fetchByRefCached(targetType, rec.fieldOnOther, base.loadedFromId);
					} else {
						const cacheKey = _countCacheKey(targetType, 'Id', rec.parentId);
						if (_byRefCache.has(cacheKey)) {
							records = _byRefCache.get(cacheKey);
						} else {
							const resp = await csrfFetch('/api/objects/' + encodeURIComponent(targetType) + '/records/' + encodeURIComponent(rec.parentId));
							if (!resp.ok) {
throw new Error(resp.statusText);
}
							const single = await resp.json();
							records = single ? [single] : [];
							_byRefCache.set(cacheKey, records);
						}
					}
					const recToValues = (r) => {
						const v = {};
						Object.keys(r).forEach(k => {
							if (k === 'attributes' || r[k] == null) {
return;
}
							v[k] = r[k];
						});
						return v;
					};
					// Make sure the related type is in canvasState.selectedObjects so its
					// describe + schema graph are available (Save/upload paths,
					// edge label resolution, and per-card editing all rely on
					// the entry existing in canvasState.selectedObjects).
					let targetSel = canvasState.selectedObjects.find(s => s.name === targetType);
					if (!targetSel) {
						try {
							targetSel = await addToSelection(targetType, base.fromSelectionId, {
								direction: rec.direction === 'child' ? 'child' : 'parent',
								fieldName: rec.direction === 'child' ? rec.fieldOnOther : rec.fieldOnThis,
							});
						} catch (e) {
							console.warn('addToSelection failed for', targetType, e);
						}
					}
					const targetSelId = targetSel ? targetSel.id : null;
					let added = 0;
					let reused = 0;
					const newRecs = [];
					// Fan new records in a half-circle facing AWAY from
					// the host record (the side opposite where the
					// host sits relative to the clicked type-node).
					// Full-circle distribution sometimes placed records
					// at angles pointing back toward the host, dropping
					// the new card on top of the host card or its
					// remaining ring of type-nodes; that's the "very
					// close to current node" symptom. The cy auto-pan
					// already centers on the new records' centroid, so
					// they're always brought into view regardless of
					// which half-circle direction they fan into.
					const _hx = rec.x - base.x;
					const _hy = rec.y - base.y;
					const _outwardLen = Math.hypot(_hx, _hy);
					const _outwardAngle = _outwardLen > 0.5 ? Math.atan2(_hy, _hx) : -Math.PI / 2;
					const arcSpan = Math.PI * 0.95;
					const N = records.length;
					// Slot offset for the search-for-more flow: every pick
					// re-enters this function with records.length === 1
					// and the type-node preserved, so naively reusing the
					// "place one record at the arc center" path stacked
					// every new pick on top of the last. Counting how
					// many records are already attached via this FK
					// gives each pick a unique slot to spiral into.
					// Bulk-load path keeps slotBase = 0 (no prior
					// associations) so the existing even-fan distribution
					// is unchanged.
					const _fkField = rec.direction === 'child' ? rec.fieldOnOther : rec.fieldOnThis;
					const _existingAttachedCount = canvasState.bulkAssociations.filter((a) => {
						if (a.fieldName !== _fkField) {
return false;
}
						return rec.direction === 'child' ? a.toId === base.id : a.fromId === base.id;
					}).length;
					// Canvas record-cap enforcement, measured against the
					// genuinely NEW records (those whose SF Id isn't already on
					// the canvas), since records that dedup into existing cards
					// don't consume new slots. This is the precise post-dedup
					// gate; the pre-fetch _canvasCapBlockReason check above is
					// only an estimate against the projected count. Refuse the
					// WHOLE load (commit nothing) if it would exceed the cap:
					// no silent partial-fill. Restore the type-node's loading
					// state and bail cleanly so the canvas is left untouched.
					const _newCount = records.filter((r) =>
						!canvasState.bulkRecords.some(br =>
							!br.isTypeNode && br.objectName === targetType && _sfIdMatch(br.loadedFromId, r.Id))
					).length;
					const _cap = canvasCapCheck(_newCount);
					if (_cap.blocked) {
						rec._loading = false;
						renderBulkView();
						showBulkToast(_cap.reason);
						return;
					}
					records.forEach((r, i) => {
						const v = recToValues(r);
						const existing = canvasState.bulkRecords.find(br =>
							!br.isTypeNode && br.objectName === targetType && _sfIdMatch(br.loadedFromId, r.Id));
						let target;
						if (existing) {
							target = existing;
							reused++;
						} else {
							let _x;
							let _y;
							if (N === 1) {
								// Single-record path (search-for-more
								// pick, or single-record auto-load).
								// Spiral out: slot N→ring/slotInRing
								// so successive picks land at distinct
								// positions in concentric arcs facing
								// away from the host.
								const slot = _existingAttachedCount + i;
								const PER_RING = 6;
								const ring = Math.floor(slot / PER_RING);
								const slotInRing = slot % PER_RING;
								const angleStep = arcSpan / Math.max(1, PER_RING - 1);
								const angle = _outwardAngle - arcSpan / 2 + angleStep * slotInRing;
								const radius = 170 + ring * 140;
								_x = rec.x + radius * Math.cos(angle);
								_y = rec.y + radius * Math.sin(angle);
							} else {
								// Bulk-load path: fan across the arc
								// evenly. Endpoints inclusive (t = 0
								// and t = 1) so two records sit at
								// the arc's flanks rather than
								// crammed in the middle.
								const t = i / (N - 1);
								const angle = _outwardAngle - arcSpan / 2 + arcSpan * t;
								const radius = 150 + Math.min(60, N * 5);
								_x = rec.x + radius * Math.cos(angle);
								_y = rec.y + radius * Math.sin(angle);
							}
							target = {
								id: canvasState.bulkIdSeq++,
								objectName: targetType,
								label: targetSel ? targetSel.label : targetType,
								x: _x,
								y: _y,
								values: v,
								loadedFromId: r.Id,
								loadedValues: Object.assign({}, v),
								fromSelectionId: targetSelId,
							};
							canvasState.bulkRecords.push(target);
							newRecs.push(target);
							added++;
						}
						const fromId = rec.direction === 'child' ? target.id : base.id;
						const toId = rec.direction === 'child' ? base.id : target.id;
						const fieldName = rec.direction === 'child' ? rec.fieldOnOther : rec.fieldOnThis;
						const dup = canvasState.bulkAssociations.some(a => a.fromId === fromId && a.toId === toId && a.fieldName === fieldName);
						if (!dup) {
							canvasState.bulkAssociations.push({ id: canvasState.bulkIdSeq++, fromId, toId, fieldName });
						}
						// Re-sync the FK value on the holder when the
						// association is (re-)created. deleteAssociation
						// clears the FK value in values to make the
						// unlink "real" (otherwise the render-time
						// auto-derive would put the edge right back from
						// the lingering FK). On a subsequent re-load via
						// the related pill, we put the edge back, but
						// without also restoring the FK value, the
						// record stays flagged as "modified" relative to
						// loadedValues even though the link visually
						// matches the loaded state. Only restore when
						// the value is currently null/absent so an
						// intentional user-set FK to a different parent
						// isn't silently clobbered.
						const holderRec = canvasState.bulkRecords.find((b) => b.id === fromId);
						const targetRec = canvasState.bulkRecords.find((b) => b.id === toId);
						if (holderRec && targetRec && targetRec.loadedFromId
							&& (!holderRec.values || holderRec.values[fieldName] == null)) {
							holderRec.values = holderRec.values || {};
							holderRec.values[fieldName] = targetRec.loadedFromId;
						}
					});
					// Preserve the type-node when called from the
					// search-for-more flow so the user can keep
					// pulling records into the same anchor. Also
					// preserve in the truncated bulk-load case so the
					// "Search for more" affordance has somewhere to
					// hang. Otherwise (full load) drop it.
					const cachedCountForRemoval = (rec.direction === 'child')
						? _relatedCountCache.get(_countCacheKey(targetType, rec.fieldOnOther, base.loadedFromId))
						: null;
					const wasTruncated = !opts.recordsOverride && cachedCountForRemoval != null && cachedCountForRemoval > records.length;
					const preserveTypeNode = !!opts.preserveTypeNode || wasTruncated;
					if (!preserveTypeNode) {
						const i = canvasState.bulkRecords.findIndex(b => b.id === rec.id);
						if (i !== -1) {
canvasState.bulkRecords.splice(i, 1);
}
					} else {
						rec._loading = false;
					}
					// Auto-link each new record to other records
					// already on the canvas. Beyond the host-edge
					// association created above (host ↔ new record
					// via the type-node's own FK), a record can have
					// other FKs that point at canvas cards (e.g., a
					// freshly-loaded Contact's AccountId points at an
					// Account that's also on the canvas via a
					// different navigation path). Without this pass
					// those parallel relationships render as
					// disconnected even though they're real in SF.
					// purgeRedundantTypeNodes then sweeps any type-
					// nodes elsewhere on the canvas that the new
					// associations made redundant.
					if (newRecs.length > 0 && targetSel) {
						newRecs.forEach((nr) => inferAssociationsForRecord(nr, targetSel));
						purgeRedundantTypeNodes();
					}
					// Mark new descendants as seeding BEFORE the render so
					// the spinner overlay appears in the same frame the
					// cards land; otherwise users see plain cards for
					// the full count-probe / type-node-layout window.
					if (newRecs.length > 0 && targetSel) {
						newRecs.forEach((nr) => {
 nr._seedingTypes = true; 
});
					}
					renderBulkView();
					// Each newly-materialized record gets its own ring of
					// type-nodes so the user can keep traversing the
					// relationship graph from any node, not just the base.
					// Fanned outward from the base/host (`outwardFrom`) so
					// the new nodes don't crowd the existing network.
					if (newRecs.length > 0 && targetSel) {
						const outwardFrom = { x: rec.x, y: rec.y };
						newRecs.forEach((nr) => {
							seedEditModeTypeNodes(nr, targetSel, { outwardFrom })
								.catch((e) => console.warn('seedEditModeTypeNodes (descendant) failed:', e))
								.finally(() => {
 nr._seedingTypes = false; renderBulkView(); 
});
						});
					}
					const noun = targetSel ? targetSel.label : targetType;
					if (added === 0 && reused === 0) {
						showBulkToast('No related ' + noun + ' records found.');
					} else if (wasTruncated) {
						// Surface truncation explicitly + give the user a
						// way to grab specific unloaded records via the
						// search-for-more flow. Captures the search ctx
						// up-front since the type-node's runtime state
						// can change between toast emission and click.
						const remaining = cachedCountForRemoval - records.length;
						const ctx = { rec, base };
						showBulkToastWithAction(
							'Loaded ' + records.length + ' of ' + cachedCountForRemoval.toLocaleString() + ' ' + noun + ' (' + remaining.toLocaleString() + ' more available).',
							'Search for more',
							() => openRelatedSearchFlow(ctx)
						);
					} else {
						const parts = [];
						if (added) {
parts.push('added ' + added);
}
						if (reused) {
parts.push('linked ' + reused + ' already on canvas');
}
						showBulkToast('Opened ' + noun + ': ' + parts.join(', ') + '.');
					}
				} catch (err) {
					rec._loading = false;
					renderBulkView();
					showBulkToast('Open ' + (rec.label || rec.objectName) + ' failed: ' + (err.message || err), 'error');
				}
			}

			return {
				openTypeNode: openTypeNode,
				spawnFreeTypeNode: spawnFreeTypeNode,
				pickRecordForFreeTypeNode: pickRecordForFreeTypeNode,
				loadRecordIntoFreeTypeNode: loadRecordIntoFreeTypeNode,
				openRelatedSearchFlow: openRelatedSearchFlow,
			};
		},
	};
})();
