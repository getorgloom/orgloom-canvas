// Slot + user helper bundle.
//
// Ten small predicates / formatters that the records canvas, the
// insert modal, and the share flow all rely on for slot-aware
// rendering. Each one is a few lines; bundling them keeps the dep
// surface of the bigger modules manageable (every prior extraction
// passed these as individual deps).
//
//   _isEmptySlot, _slotAssignmentState, _slotAssigneeBadgeHtml,
//   _slotAssignmentCardClass, _slotProgress, _aggregateSlotProgress,
//   _slotProgressClass, _resolveUserName, _formatRelativeTime,
//   _slotPreflightWarn
//
// Public API (returned from mount):
//   The 10 helpers above PLUS `_slotInaccessibleObjects`: a Set
//   shared with app.js's _runSlotPreflight, which clears it and
//   re-populates it per canvas load. The renderer consults it via
//   _slotPreflightWarn.
//
// Exposed as window.OrgLoom.slotUser. Load order: before app.js.

(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.slotUser = {
		mount: function mount(deps) {
			if (!deps || !deps.canvasState || !deps.csrfFetch || !deps.escapeHtml) {
				throw new Error('slot-user.mount: missing required deps');
			}
			const canvasState = deps.canvasState;
			const csrfFetch = deps.csrfFetch;
			const escapeHtml = deps.escapeHtml;

			function _isEmptySlot(rec) {
				if (!rec || !rec.slot || rec.slot.slotId == null) {
return false;
}
				if (rec.loadedFromId) {
return false;
}
				if (!rec._recipientSlot) {
return false;
}
				const v = rec.values || {};
				for (const k in v) {
 if (v[k] != null && v[k] !== '') {
return false;
} 
}
				return true;
			}
			
			// Slot assignment state from the current viewer's perspective.
			// Returns one of:
			//   - null: not a slot record
			//   - 'mine': slot is assigned to me: fillable, highlighted
			//   - 'generic': slot has no assignee: anyone with access fills
			//   - 'other': slot is assigned to someone else: locked for me
			// Uses window.SF_USER_ID (populated server-side from the SF
			// session) as "me." Works for both share-grant recipients and
			// canvas owners; owners who assigned a slot to a teammate
			// see 'other' on those cards too, which is the right read
			// (the slot isn't theirs to fill).
			function _slotAssignmentState(rec) {
				if (!rec || !rec.slot || rec.slot.slotId == null) {
return null;
}
				const assignee = rec.slot.assigneeSfUserId || null;
				if (!assignee) {
return 'generic';
}
				return (window.SF_USER_ID && assignee === window.SF_USER_ID) ? 'mine' : 'other';
			}
			
			// Tiny inline badge for the slot card chrome. Skips when
			// the slot has no assignee (already implied by absence).
			// 'mine' renders as a green "for you" pill; 'other' as a
			// muted "for <Name>" pill with the assignee's display
			// name. Used by both legacy and cy renderers.
			function _slotAssigneeBadgeHtml(rec) {
				const state = _slotAssignmentState(rec);
				if (state !== 'mine' && state !== 'other') {
return '';
}
				if (state === 'mine') {
					return '<span class="slot-assignee-badge slot-assignee-badge--mine" title="Assigned to you: your fills will be saved when you submit.">for you</span>';
				}
				const name = (rec.slot.assigneeName || rec.slot.assigneeEmail || 'someone else');
				return '<span class="slot-assignee-badge slot-assignee-badge--other" title="Assigned to ' + escapeHtml(name) + ': only they can fill this slot.">for ' + escapeHtml(name) + '</span>';
			}
			
			// Class fragment for the card itself based on assignment
			// state. Returns ' record-card--slot-locked' for 'other',
			// empty otherwise. Drives muted/locked CSS treatment.
			function _slotAssignmentCardClass(rec) {
				const state = _slotAssignmentState(rec);
				return state === 'other' ? ' record-card--slot-locked' : '';
			}
			
			// Compute slot-fill progress for a single record. Two slot
			// shapes share this helper:
			//   - Field-level slot (kind='fields'): filled = count of
			//     slot.fields whose rec.values[name] is non-empty;
			//     total = slot.fields.length.
			//   - Whole-record slot (loaded or draft): binary, total=1;
			//     filled=1 once the recipient has loaded a record or
			//     typed anything into the draft.
			// Returns null when the record has no slot: caller can
			// short-circuit on that.
			function _slotProgress(rec) {
				if (!rec || !rec.slot || rec.slot.slotId == null) {
return null;
}
				const kind = rec.slot.kind || 'whole-record';
				if (kind === 'fields') {
					const fields = Array.isArray(rec.slot.fields) ? rec.slot.fields : [];
					const total = fields.length;
					const v = rec.values || {};
					let filled = 0;
					for (const f of fields) {
						const x = v[f];
						if (x != null && x !== '') {
filled++;
}
					}
					return { filled, total };
				}
				// Whole-record slot: filled when there's a loadedFromId
				// (recipient picked a record) OR any non-empty value
				// (recipient created a draft and typed something).
				const loaded = !!rec.loadedFromId;
				const hasValue = (() => {
					const v = rec.values || {};
					for (const k in v) {
 if (v[k] != null && v[k] !== '') {
return true;
} 
}
					return false;
				})();
				return { filled: (loaded || hasValue) ? 1 : 0, total: 1 };
			}
			
			// Sum slot progress across every slot record on the canvas.
			// Used by the toolbar pill. Returns { filled, total, recordCount }
			// where recordCount is the number of slot records contributing.
			function _aggregateSlotProgress() {
				let filled = 0, total = 0, recordCount = 0;
				for (const r of canvasState.bulkRecords) {
					if (r.isTypeNode || r.isPending) {
continue;
}
					const p = _slotProgress(r);
					if (!p) {
continue;
}
					filled += p.filled;
					total += p.total;
					recordCount++;
				}
				return { filled, total, recordCount };
			}
			
			// Color band for slot progress. 0/N → gray; partial → accent;
			// full (only when total > 0) → success. Centralized so the
			// card badge, modal banner, and toolbar pill agree.
			function _slotProgressClass(progress) {
				if (!progress || progress.total === 0) {
return 'slot-progress-empty';
}
				if (progress.filled >= progress.total) {
return 'slot-progress-full';
}
				if (progress.filled === 0) {
return 'slot-progress-empty';
}
				return 'slot-progress-partial';
			}
			
			// Slot last-modified indicator. Field-level slot records
			// surface "Last modified <relative-time> by <name>" on the
			// modal banner so owner and recipient can see whether the
			// slot's been filled. Time comes from the SF
			// LastModifiedDate already in rec.values; user name comes
			// from a lazy User-record fetch keyed by LastModifiedById.
			// Per-id cache so re-renders don't re-fetch.
			const _userNameCache = new Map();
			async function _resolveUserName(userId) {
				if (!userId) {
return null;
}
				if (_userNameCache.has(userId)) {
return _userNameCache.get(userId);
}
				if (window.SF_USER_ID && userId === window.SF_USER_ID) {
					_userNameCache.set(userId, 'you');
					return 'you';
				}
				try {
					const r = await csrfFetch('/api/objects/User/records/' + encodeURIComponent(userId), { credentials: 'same-origin' });
					if (!r.ok) {
return null;
}
					const u = await r.json();
					const name = (u && (u.Name || ((u.FirstName || '') + ' ' + (u.LastName || '')).trim())) || null;
					if (name) {
_userNameCache.set(userId, name);
}
					return name;
				} catch (e) {
 return null; 
}
			}
			
			function _formatRelativeTime(iso) {
				if (!iso) {
return '';
}
				const t = new Date(iso).getTime();
				if (!isFinite(t)) {
return '';
}
				const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
				if (sec < 60) {
return 'just now';
}
				const min = Math.round(sec / 60);
				if (min < 60) {
return min + ' minute' + (min === 1 ? '' : 's') + ' ago';
}
				const hr = Math.round(min / 60);
				if (hr < 24) {
return hr + ' hour' + (hr === 1 ? '' : 's') + ' ago';
}
				const day = Math.round(hr / 24);
				if (day < 30) {
return day + ' day' + (day === 1 ? '' : 's') + ' ago';
}
				return new Date(iso).toLocaleDateString();
			}
			
			// Per-canvas-load preflight: flags slot SObjects the loader
			// can't describe. Populated by _runSlotPreflight on canvas
			// open; consulted by renderers to add a ⚠ on affected slots.
			const _slotInaccessibleObjects = new Set();
			function _slotPreflightWarn(rec) {
				if (!_isEmptySlot(rec)) {
return false;
}
				return _slotInaccessibleObjects.has(rec.objectName);
			}

			return {
				_isEmptySlot: _isEmptySlot,
				_slotAssignmentState: _slotAssignmentState,
				_slotAssigneeBadgeHtml: _slotAssigneeBadgeHtml,
				_slotAssignmentCardClass: _slotAssignmentCardClass,
				_slotProgress: _slotProgress,
				_aggregateSlotProgress: _aggregateSlotProgress,
				_slotProgressClass: _slotProgressClass,
				_resolveUserName: _resolveUserName,
				_formatRelativeTime: _formatRelativeTime,
				_slotPreflightWarn: _slotPreflightWarn,
				_slotInaccessibleObjects: _slotInaccessibleObjects,
			};
		},
	};
})();
