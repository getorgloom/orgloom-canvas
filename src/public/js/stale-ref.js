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
