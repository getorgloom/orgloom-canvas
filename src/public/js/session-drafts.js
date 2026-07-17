// Session-scoped draft value persistence.
//
// Canvases save STRUCTURALLY to Salesforce ContentDocuments: no
// record values, ever. That's the trust property admins govern
// Salesforce records via normal SF permissions; the canvas File
// holds pointers and positions, not the contents of records.
//
// But drafts (records typed into the canvas, not yet uploaded to SF)
// have values that exist nowhere durable. The previous behavior:
// values lived in JS memory and got wiped on every canvas save +
// reload. Users typed into a draft "Acme Corp" name field, hit Save,
// reloaded, and the field was blank: silent data loss.
//
// This module caches draft values in browser sessionStorage, keyed
// by (canvasId, tempId). Properties:
//   - Survives F5 reload in the same tab. Solves the silent-loss bug.
//   - Cleared when the tab closes. No persistence to disk between
//     browser sessions. (sessionStorage is technically backed by
//     disk for crash recovery, but the browser auto-purges it on
//     tab close, a much shorter at-rest window than localStorage.)
//   - Per-tab, per-canvas. User opens the same canvas in another
//     tab: empty drafts (matches "drafts are this session's work").
//   - User-controlled: clearing browser data wipes it. Signing out
//     clears the session cookie too, so a fresh sign-in starts
//     blank.
//
// Dependencies passed to mount():
//   canvasState - shared canvas state. Reads bulkRecords on
//                 rehydrate; receives mutations from save/load paths.
//
// Public API (returned from mount):
//   persistDraftValues(canvasId)
//                          - snapshot draft values for the given
//                            canvas to sessionStorage. Called on
//                            every save + on a debounced timer.
//   rehydrateDraftValues(canvasId)
//                          - on canvas load, read sessionStorage and
//                            apply values to matching drafts in
//                            bulkRecords. Called after applyCanvasPayload
//                            finishes.
//   clearDraftValues(canvasId, tempId)
//                          - on draft upload (becomes loaded record)
//                            or removal, drop its sessionStorage entry.
//   clearAllForCanvas(canvasId)
//                          - on canvas close / replace, wipe all
//                            entries for that canvas.
//
// Exposed as window.OrgLoom.sessionDrafts. Load order: before app.js.

(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.sessionDrafts = {
		mount: function mount(deps) {
			if (!deps || !deps.canvasState) {
				throw new Error('session-drafts.mount: missing canvasState');
			}
			const canvasState = deps.canvasState;

			// Single sessionStorage key per canvas. Holds a JSON map
			// of tempId → values object. Per-canvas keys (instead of
			// one global key) keep the read/write cost bounded by a
			// single canvas's draft count, not the cross-canvas total.
			function _storageKey(canvasId) {
				return 'orgloom:draftValues:' + canvasId;
			}

			function _readMap(canvasId) {
				if (!canvasId) {
return {};
}
				try {
					const raw = window.sessionStorage.getItem(_storageKey(canvasId));
					if (!raw) {
return {};
}
					const parsed = JSON.parse(raw);
					return (parsed && typeof parsed === 'object') ? parsed : {};
				} catch (_) {
					return {};
				}
			}

			function _writeMap(canvasId, map) {
				if (!canvasId) {
return;
}
				try {
					if (!map || Object.keys(map).length === 0) {
						window.sessionStorage.removeItem(_storageKey(canvasId));
					} else {
						window.sessionStorage.setItem(_storageKey(canvasId), JSON.stringify(map));
					}
				} catch (_) {
					// Quota exceeded or storage disabled: silently drop.
					// Worst case: drafts behave like strict mode.
				}
			}

			// Snapshot every draft on the canvas with at least one
			// non-empty value. Skips loaded records (their values
			// live in Salesforce + the canvas's loadedValues snapshot)
			// and type-node placeholders.
			function persistDraftValues(canvasId) {
				if (!canvasId) {
return;
}
				if (!Array.isArray(canvasState.bulkRecords)) {
return;
}
				const map = {};
				for (const r of canvasState.bulkRecords) {
					if (!r) {
continue;
}
					if (r.isTypeNode) {
continue;
}
					if (r.loadedFromId) {
continue;
} // SF record, not a draft
					const tid = _persistedTempIdOf(r);
					if (tid == null) {
continue;
}
					const values = r.values || {};
					if (Object.keys(values).length === 0) {
continue;
}
					// Only persist primitive values. Skip undefined and
					// the rare object/array values (lookup refs etc.);
					// they're either non-serializable or roundtrip-
					// fragile.
					const safe = {};
					for (const k of Object.keys(values)) {
						const v = values[k];
						if (v == null) {
continue;
}
						const t = typeof v;
						if (t === 'string' || t === 'number' || t === 'boolean') {
							safe[k] = v;
						}
					}
					if (Object.keys(safe).length > 0) {
map[String(tid)] = safe;
}
				}
				_writeMap(canvasId, map);
			}

			// On canvas load (after applyCanvasPayload), walk the
			// fresh drafts in bulkRecords and patch their values from
			// sessionStorage. Match by persisted tempId: that ID
			// survives save → reload via the canvas File payload.
			function rehydrateDraftValues(canvasId) {
				if (!canvasId) {
return 0;
}
				if (!Array.isArray(canvasState.bulkRecords)) {
return 0;
}
				const map = _readMap(canvasId);
				if (!map || Object.keys(map).length === 0) {
return 0;
}
				let restored = 0;
				for (const r of canvasState.bulkRecords) {
					if (!r) {
continue;
}
					if (r.isTypeNode || r.loadedFromId) {
continue;
}
					const tid = _persistedTempIdOf(r);
					if (tid == null) {
continue;
}
					const stored = map[String(tid)];
					if (!stored || typeof stored !== 'object') {
continue;
}
					r.values = Object.assign({}, r.values || {}, stored);
					restored++;
				}
				return restored;
			}

			function clearDraftValues(canvasId, tempId) {
				if (!canvasId || tempId == null) {
return;
}
				const map = _readMap(canvasId);
				if (!map || !map[String(tempId)]) {
return;
}
				delete map[String(tempId)];
				_writeMap(canvasId, map);
			}

			function clearAllForCanvas(canvasId) {
				if (!canvasId) {
return;
}
				try {
 window.sessionStorage.removeItem(_storageKey(canvasId)); 
} catch (_) {}
			}

			// Resolve the stable tempId for a draft record. Drafts
			// carry a persisted tempId set during canvas save/load;
			// freshly-created drafts use their runtime `id`. Falling
			// back to runtime id lets sessionStorage cover drafts the
			// user just typed in but hasn't yet round-tripped through
			// a save.
			function _persistedTempIdOf(rec) {
				if (rec._persistedTempId != null) {
return rec._persistedTempId;
}
				if (rec.id != null) {
return rec.id;
}
				return null;
			}

			return {
				persistDraftValues: persistDraftValues,
				rehydrateDraftValues: rehydrateDraftValues,
				clearDraftValues: clearDraftValues,
				clearAllForCanvas: clearAllForCanvas,
			};
		},
	};
})();
