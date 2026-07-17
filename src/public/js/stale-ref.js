// Stale-ref tracking.
//
// When a loaded record's SF id no longer exists (deleted via recall,
// manual SF delete, workflow purge, etc.), we surface a ⚠ on the
// card and offer the user a Convert / Remove / Dismiss menu. Stale
// ids come in two ways:
//   - From a canvas-load `staleRefs` server-side probe → wholesale
//     replace via _setStaleRefsFromLoad. Each entry has a `reason`
//     field of 'deleted' | 'no-access' | 'unknown'. Only deletion-
//     shaped reasons land in the stale set; 'no-access' records get
//     the distinct "🔒 No access" treatment via _inaccessible
//     (see records-canvas.js render path), flagging them as
//     "deleted in SF" would mislead users into removing valid
//     records they just can't read.
//   - From a live "records-deleted" custom event (e.g., a recall
//     just completed). For this path we AUTO-CONVERT matching
//     loaded records to drafts immediately: the user just deleted
//     these records, they know they're gone, and leaving them as
//     stale-loaded would silently brick the re-upload path
//     (loaded-with-no-diff produces an empty upload). The popup is
//     reserved for the load-time path where the user reopens a
//     canvas and discovers a record was deleted out-of-band.
//
// Public API (returned from mount):
//   _isRecordStale, _setStaleRefsFromLoad, _addStaleRefIds,
//   _showStaleRefMenu, _staleIdKey.
//
// Exposed as window.OrgLoom.staleRef. Load order: before app.js.

(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.staleRef = {
		mount: function mount(deps) {
			const required = ['renderBulkView', 'deleteRecord', 'getBulkRecords'];
			if (!deps) {
throw new Error('stale-ref.mount: missing deps object');
}
			for (const k of required) {
				if (deps[k] === undefined || deps[k] === null) {
					throw new Error('stale-ref.mount: missing dep ' + k);
				}
			}
			const renderBulkView = deps.renderBulkView;
			const deleteRecord = deps.deleteRecord;
			const getBulkRecords = deps.getBulkRecords;

			const _staleSfIds = new Set();
			const _staleIdKey = (id) => (id ? String(id).slice(0, 15) : '');

			function _isRecordStale(rec) {
				if (!rec || !rec.loadedFromId || rec._staleAck) {
return false;
}
				// Two sources of staleness: the load-time probe (_staleSfIds,
				// set from the canvas GET's staleRefs) and a Refresh that
				// came back not-found / no-access (_deletedInSf, set per
				// card). Both mean "this card's Id can't be read in SF" and
				// both deserve the badge + fix popover; without this, a
				// refresh-flagged card got the red tint but no explanation
				// and no way to resolve it.
				if (rec._deletedInSf) {
					return true;
				}
				return _staleSfIds.has(_staleIdKey(rec.loadedFromId));
			}
			function _setStaleRefsFromLoad(staleRefs) {
				_staleSfIds.clear();
				(staleRefs || []).forEach((s) => {
					if (!s || !s.sfId) {
return;
}
					// 'no-access' means the record exists in SF but the
					// current user lacks read permission; NOT a deletion.
					// Skipping it here lets the existing _inaccessible
					// path render the "🔒 No access" card without the
					// misleading "deleted in SF" badge or fix popover.
					// 'unknown' (probe failed or returned an unexpected
					// error code) falls through to the deletion path
					// conservatively: better to show an actionable fix
					// affordance than silently hide an unsavable card.
					const reason = s.reason || 'unknown';
					if (reason === 'no-access') {
return;
}
					_staleSfIds.add(_staleIdKey(s.sfId));
				});
			}
			function _addStaleRefIds(sfIds) {
				if (!Array.isArray(sfIds) || sfIds.length === 0) {
return;
}
				let added = false;
				for (const id of sfIds) {
					const k = _staleIdKey(id);
					if (k && !_staleSfIds.has(k)) {
 _staleSfIds.add(k); added = true; 
}
				}
				if (added) {
					try {
 renderBulkView(); 
} catch (_) {}
				}
			}
			// Live-recall path. Walk bulkRecords and convert every
			// loaded record whose sfId matches a just-deleted id to a
			// draft (loadedFromId = null + drop hasExisting / hasModified
			// so the card re-renders as a normal draft). After conversion
			// the record uploads naturally as an insert on the next
			// Upload click: the recall → re-upload cycle works without
			// the user having to find the Convert action in a popup.
			// Records we couldn't match (canvas closed, different
			// canvas, already drafted) fall through to the stale set
			// as before, harmless because there's nothing to render
			// against.
			document.addEventListener('orgloom:records-deleted', (e) => {
				const ids = (e && e.detail && e.detail.sfIds) || [];
				if (!Array.isArray(ids) || ids.length === 0) {
return;
}
				const deletedKeys = new Set(ids.map(_staleIdKey).filter(Boolean));
				let recs;
				try {
 recs = getBulkRecords(); 
} catch (_) {
 recs = null; 
}
				let converted = 0;
				if (Array.isArray(recs)) {
					recs.forEach((rec) => {
						if (!rec || !rec.loadedFromId) {
return;
}
						if (!deletedKeys.has(_staleIdKey(rec.loadedFromId))) {
return;
}
						rec._wasLoadedFromId = rec.loadedFromId;
						rec.loadedFromId = null;
						rec._staleAck = false;
						delete rec.hasExisting;
						delete rec.hasModified;
						converted++;
					});
				}
				if (converted > 0) {
					try {
 renderBulkView(); 
} catch (_) {}
				}
			});

			function _showStaleRefMenu(triggerEl, rec) {
				document.querySelectorAll('.stale-ref-popup').forEach((el) => el.remove());
				const pop = document.createElement('div');
				pop.className = 'find-object-popup stale-ref-popup';
				pop.style.width = '300px';
				const r = triggerEl.getBoundingClientRect();
				pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 308)) + 'px';
				pop.style.top = (r.bottom + 6) + 'px';
				pop.innerHTML =
					'<div class="fop-header">' +
						'<div class="fop-title">Record was deleted in Salesforce</div>' +
						'<div class="fop-sub">The card&rsquo;s Salesforce Id can no longer be read: the record was deleted, or your access to it was removed. Pick what to do.</div>' +
					'</div>' +
					'<button type="button" class="fop-item fop-item--primary" data-stale-action="convert">' +
						'<span class="fop-label">Convert to draft and re-create</span>' +
						'<span class="fop-name">Keep your edits; next upload re-creates this record in Salesforce as a fresh insert.</span>' +
					'</button>' +
					'<button type="button" class="fop-item" data-stale-action="remove">' +
						'<span class="fop-label">Remove from canvas</span>' +
						'<span class="fop-name">Delete this card and its edges. Salesforce isn’t touched.</span>' +
					'</button>' +
					'<button type="button" class="fop-item" data-stale-action="keep">' +
						'<span class="fop-label">Dismiss (won’t re-upload until fixed)</span>' +
						'<span class="fop-name">Hides the warning, but the card stays linked to a missing Id; uploads will skip it as "no changes."</span>' +
					'</button>';
				document.body.appendChild(pop);
				const cleanup = () => {
 pop.remove(); document.removeEventListener('mousedown', onDocDown, true); 
};
				const onDocDown = (e) => {
 if (!pop.contains(e.target)) {
cleanup();
} 
};
				setTimeout(() => document.addEventListener('mousedown', onDocDown, true), 0);
				pop.querySelectorAll('[data-stale-action]').forEach((btn) => {
					btn.addEventListener('click', () => {
						const action = btn.dataset.staleAction;
						cleanup();
						if (action === 'convert') {
							rec.loadedFromId = null;
							rec._staleAck = false;
							// Clear the refresh-set flag too: the card is a
							// draft now; leaving it would strand the red
							// deleted-in-SF tint on a record that no longer
							// references any SF row.
							rec._deletedInSf = false;
						} else if (action === 'remove') {
							deleteRecord(rec.id);
							return;
						} else if (action === 'keep') {
							rec._staleAck = true;
						}
						renderBulkView();
					});
				});
			}

			return {
				_isRecordStale: _isRecordStale,
				_setStaleRefsFromLoad: _setStaleRefsFromLoad,
				_addStaleRefIds: _addStaleRefIds,
				_showStaleRefMenu: _showStaleRefMenu,
				_staleIdKey: _staleIdKey,
			};
		},
	};
})();
