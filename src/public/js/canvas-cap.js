// Canvas cap + capability helpers.
//
// Two small subsystems that share the same closure:
//
// Plan capabilities (per-org):
//   _hasCap(name): true when the server-reported capability
//                          map contains a truthy value for `name`.
//                          Used to gate features (slot authoring,
//                          run-script, etc.) without scattering plan
//                          checks across the codebase.
//   _canAuthorSlots() / _canRunScripts(): legacy aliases.
//   setCaps(caps): app.js calls this from the /api/caps boot
//                          fetch handler; replaces the cap map.
//
// Record cap (per-canvas):
//   _realRecordCount(): non-type-node bulk records on the canvas.
//   _canvasCapBlockReason(addCount)
//   null if `addCount` more records can fit
//                          under the 500-record cap; otherwise a
//                          user-facing block-reason string.
//   _modifiedLoadedCount()
//   loaded records with unsaved local edits;
//                          drives the beforeunload warning.
//   getCanvasRecordCap(): exposes the 500 constant for callers
//                          that need it (records-canvas mount).
//
// Share-count cache (per-canvas):
//   _invalidateShareCountForCanvas(canvasId)
//   clears the cached count + re-renders the
//                          toolbar (if in bulk view).
//
// Exposed as window.OrgLoom.canvasCap. Load order: before app.js.

(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.canvasCap = {
		mount: function mount(deps) {
			const required = [
				'canvasState', 'isRecordModified',
				'getShareCountByCanvasId', 'renderBulkToolbar',
			];
			if (!deps) {
throw new Error('canvas-cap.mount: missing deps object');
}
			for (const k of required) {
				if (deps[k] === undefined || deps[k] === null) {
					throw new Error('canvas-cap.mount: missing dep ' + k);
				}
			}
			const canvasState = deps.canvasState;
			const isRecordModified = deps.isRecordModified;
			const getShareCountByCanvasId = deps.getShareCountByCanvasId;
			const renderBulkToolbar = deps.renderBulkToolbar;

			const _CANVAS_RECORD_CAP = 500;
			let _caps = {};

			function setCaps(caps) {
 _caps = caps || {}; 
}
			function _hasCap(name) {
 return !!(_caps && _caps[name]); 
}
			function _canAuthorSlots() {
 return _hasCap('create-slot-canvas'); 
}
			function _canRunScripts() {
 return _hasCap('run-script'); 
}

			function _realRecordCount() {
				return canvasState.bulkRecords.filter(r => !r.isTypeNode).length;
			}
			// The single canvas-record-cap rule. Every path that adds
			// records to the canvas must run its add count through this
			// before committing: it's the one source of truth so the cap
			// can't drift or leak. Returns a rich result:
			//   { ok, blocked, attempted, headroom, cap, reason }
			// Policy: REFUSE THE WHOLE batch when it would exceed the cap
			// (never silently partial-fill: that drops data invisibly).
			// The reason is count-aware so the user knows how much headroom
			// is left and by how much they overshot.
			function canvasCapCheck(addCount) {
				const current = _realRecordCount();
				const n = Math.max(0, addCount || 0);
				const headroom = Math.max(0, _CANVAS_RECORD_CAP - current);
				if (current + n > _CANVAS_RECORD_CAP) {
					const reason = n <= 1
						? 'Canvas is full (' + _CANVAS_RECORD_CAP + ' records). Remove some records, or use Direct CSV upload for larger sets.'
						: 'Loading ' + n + ' records would exceed the ' + _CANVAS_RECORD_CAP
							+ '-record canvas limit (' + headroom + ' slot' + (headroom === 1 ? '' : 's')
							+ ' left). Narrow your selection or filter, or use Direct CSV upload for larger sets.';
					return { ok: false, blocked: true, attempted: n, headroom: headroom, cap: _CANVAS_RECORD_CAP, reason: reason };
				}
				return { ok: true, blocked: false, attempted: n, headroom: headroom, cap: _CANVAS_RECORD_CAP, reason: null };
			}
			// Back-compat thin wrapper: existing single-add callers use the
			// reason string directly. Now count-aware via canvasCapCheck.
			function _canvasCapBlockReason(addCount) {
				return canvasCapCheck(addCount).reason;
			}
			function _modifiedLoadedCount() {
				return canvasState.bulkRecords.filter((r) => !r.isTypeNode && isRecordModified(r)).length;
			}
			function getCanvasRecordCap() {
 return _CANVAS_RECORD_CAP; 
}

			function _invalidateShareCountForCanvas(canvasId) {
				if (!canvasId) {
return;
}
				getShareCountByCanvasId().delete(canvasId);
				if (typeof canvasState.graphView !== 'undefined' && canvasState.graphView === 'bulk' && typeof renderBulkToolbar === 'function') {
					renderBulkToolbar();
				}
			}

			return {
				setCaps: setCaps,
				_hasCap: _hasCap,
				_canAuthorSlots: _canAuthorSlots,
				_canRunScripts: _canRunScripts,
				_realRecordCount: _realRecordCount,
				canvasCapCheck: canvasCapCheck,
				_canvasCapBlockReason: _canvasCapBlockReason,
				_modifiedLoadedCount: _modifiedLoadedCount,
				getCanvasRecordCap: getCanvasRecordCap,
				_invalidateShareCountForCanvas: _invalidateShareCountForCanvas,
			};
		},
	};
})();
