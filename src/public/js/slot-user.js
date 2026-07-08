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

			function _slotAssigneeBadgeHtml(rec) {
				const state = _slotAssignmentState(rec);
				if (state !== 'mine' && state !== 'other') {
return '';
}
				if (state === 'mine') {
					return '<span class="slot-assignee-badge slot-assignee-badge--mine" title="Assigned to you — your fills will be saved when you submit.">for you</span>';
				}
				const name = (rec.slot.assigneeName || rec.slot.assigneeEmail || 'someone else');
				return '<span class="slot-assignee-badge slot-assignee-badge--other" title="Assigned to ' + escapeHtml(name) + ' — only they can fill this slot.">for ' + escapeHtml(name) + '</span>';
			}

			function _slotAssignmentCardClass(rec) {
				const state = _slotAssignmentState(rec);
				return state === 'other' ? ' record-card--slot-locked' : '';
			}

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
