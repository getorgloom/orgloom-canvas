// Find Duplicates modal.
//
// Scans the canvas for duplicate records: records of the same
// object type whose values on a sensible "identity" field set match
// after light normalization (case-insensitive, trim whitespace).
// Groups them, lets the user pick which record to keep in each
// group, and removes the losers on Apply.
//
// Removal semantics match the rest of the canvas:
//   loaded records  → markPendingDelete (will DELETE on next upload)
//   drafts          → deleteRecord (immediate canvas-remove)
//
// Default match fields per object type:
//   Contact / Lead / User: Email (falls back to FirstName+LastName)
//   Account / Asset: Name
//   Opportunity: Name (Account context is too volatile)
//   Case: Subject
//   anything else: Name
// Records whose normalized match-key is empty (all match fields
// blank) are excluded from grouping, since comparing empty strings as
// "matches" would surface spurious groups.
//
// Default winner pick within each group:
//   1. Prefer a loaded record (has loadedFromId) over a draft, since
//      the loaded record carries a real SF identity that's expensive
//      to recreate. Lowest ordinal among loaded wins.
//   2. Otherwise the lowest ordinal draft wins.
// User can override by clicking a different row's radio.
//
// Records already pending-delete are skipped during the scan; they
// won't survive the next upload anyway, so flagging them as
// "duplicates" would be misleading.
//
// Entry point:
//   openFindDuplicatesModal(): reads canvas state, opens the modal
//   with whatever duplicate groups it finds. Shows an empty-state
//   panel when no groups are detected.
//
// Public API (returned from mount):
//   openFindDuplicatesModal
//
// Exposed as window.OrgLoom.findDuplicatesModal. Load order: before app.js.

(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.findDuplicatesModal = {
		mount: function mount(deps) {
			const required = [
				'canvasState', 'escapeHtml', 'recordOrdinal',
				'renderBulkView', 'deleteRecord', 'markPendingDelete',
				'isRecordPendingDelete', 'showBulkToast',
				'getCyInstance',
			];
			if (!deps) {
throw new Error('find-duplicates-modal.mount: missing deps object');
}
			for (const k of required) {
				if (deps[k] === undefined || deps[k] === null) {
					throw new Error('find-duplicates-modal.mount: missing dep ' + k);
				}
			}
			const canvasState = deps.canvasState;
			const escapeHtml = deps.escapeHtml;
			const recordOrdinal = deps.recordOrdinal;
			const renderBulkView = deps.renderBulkView;
			const deleteRecord = deps.deleteRecord;
			const markPendingDelete = deps.markPendingDelete;
			const isRecordPendingDelete = deps.isRecordPendingDelete;
			const showBulkToast = deps.showBulkToast;
			const getCyInstance = deps.getCyInstance;
			// Optional (present in the normal app.js mount): a single batch
			// Undo on the removal toast. deleteRecord/markPendingDelete each
			// register their own per-record undo entry; the batch Undo below
			// reverts the WHOLE operation in one click and trims those
			// per-record entries so a later Cmd+Z can't double-restore.
			const showBulkToastWithAction = typeof deps.showBulkToastWithAction === 'function'
				? deps.showBulkToastWithAction : null;
			const undoStackSize = typeof deps.undoStackSize === 'function'
				? deps.undoStackSize : null;
			const trimUndoStack = typeof deps.trimUndoStack === 'function'
				? deps.trimUndoStack : null;

			// Pan + flash the target card on the canvas behind the
			// modal. Same cy id convention as canvas-search.js, uses
			// the .csr-flash node class for the amber outline glow so
			// the visual is consistent across surfaces. Peeks the
			// modal (fades the body to ~18% opacity for ~1.4s) so the
			// flashing card isn't fully obscured by the modal body
			// the user just clicked from.
			function _jumpToRecord(recordId) {
				const cy = getCyInstance && getCyInstance();
				if (!cy) {
return;
}
				const node = cy.getElementById('r' + recordId);
				if (!node || !node.length) {
return;
}
				cy.animate({
					center: { eles: node },
					duration: 380,
					easing: 'ease-out',
				});
				try {
 node.addClass('csr-flash'); 
} catch (_) {}
				const overlay = document.querySelector('.fdm-overlay');
				if (overlay) {
overlay.classList.add('fdm-peek');
}
				setTimeout(() => {
					try {
 node.removeClass('csr-flash'); 
} catch (_) {}
					if (overlay) {
overlay.classList.remove('fdm-peek');
}
				}, 1400);
			}

			// Per-object default match-field sets. First non-empty set
			// of values on a record wins (so Contact with no Email
			// falls back to FirstName+LastName). Order matters within
			// each list: Email-first for people-shaped objects so two
			// "John Smiths" with different emails aren't flagged.
			const MATCH_RULES = {
				Contact: [['Email'], ['FirstName', 'LastName']],
				Lead:    [['Email'], ['FirstName', 'LastName', 'Company']],
				User:    [['Email'], ['Username'], ['FirstName', 'LastName']],
				Account: [['Name']],
				Asset:   [['Name']],
				Opportunity: [['Name']],
				Case:    [['Subject']],
			};
			const DEFAULT_RULE = [['Name']];

			function _matchRulesFor(objectName) {
				return MATCH_RULES[objectName] || DEFAULT_RULE;
			}

			function _normalize(v) {
				if (v === null || v === undefined) {
return '';
}
				return String(v).trim().toLowerCase().replace(/\s+/g, ' ');
			}

			// Build the match key for a record. Walks the rule sets in
			// order; the first set where ALL fields have non-empty
			// values produces the key. Returns null when no rule set
			// has full coverage; the record is excluded from grouping
			// rather than getting bucketed under an empty key with
			// every other under-specified record.
			function _matchKey(rec, rules) {
				const v = rec.values || {};
				for (const fieldSet of rules) {
					const parts = [];
					let full = true;
					for (const f of fieldSet) {
						const norm = _normalize(v[f]);
						if (!norm) {
 full = false; break; 
}
						parts.push(f + ':' + norm);
					}
					if (full) {
return { fields: fieldSet, key: parts.join('||') };
}
				}
				return null;
			}

			// Friendly label for "matching on Email" / "matching on
			// FirstName + LastName" (AND) or "matching on Email or
			// Phone" (OR). Used in the per-group header.
			function _formatFieldSet(fields, op) {
				const joiner = op === 'or' ? ' or ' : ' + ';
				return fields.join(joiner);
			}

			// Best-effort display name for a record row. Mirrors the
			// canvas card title heuristics so the modal reads like the
			// canvas. recordOrdinal carries the "#N" identity.
			function _displayName(rec) {
				const v = rec.values || {};
				const guess = v.Name || (v.FirstName || v.LastName ? [v.FirstName, v.LastName].filter(Boolean).join(' ') : '')
					|| v.Subject || v.CaseNumber || v.Email || '';
				return guess || ('(no name)');
			}

			// Short summary of which fields drove the match, shown
			// as a soft secondary line beneath the display name so the
			// user can spot why a row was bucketed even if the names
			// look different (e.g., Email match where FirstName diff).
			function _matchExcerpt(rec, fields) {
				const v = rec.values || {};
				return fields
					.map((f) => f + ': ' + (v[f] || ''))
					.filter((s) => s.endsWith(': ') === false)
					.join(' · ');
			}

			// Order a group of records: loaded first (lowest ordinal
			// among loaded), then drafts (lowest ordinal). Shared by
			// both AND and OR scan paths so the default-winner pick
			// reads the first row the same way regardless of mode.
			function _sortGroupRecords(arr) {
				arr.sort((a, b) => {
					const aLoaded = !!a.loadedFromId, bLoaded = !!b.loadedFromId;
					if (aLoaded !== bLoaded) {
return aLoaded ? -1 : 1;
}
					return recordOrdinal(a) - recordOrdinal(b);
				});
			}

			// Scan ONE object type with a user-picked field set + a
			// match operator. Returns a section
			// { objectName, groups, defaultFields, op } in the shape
			// the renderer expects, or null when no duplicate groups
			// exist for the given config.
			//
			// op === 'and' (strict): a record only joins a bucket when
			// EVERY picked field has a non-empty value AND that record
			// agrees with the bucket on all of them. Partial-coverage
			// records get excluded, since empty-equals-empty would false-
			// positive every under-specified record together.
			//
			// op === 'or' (loose, transitive): records get unioned via
			// union-find whenever they share a normalized value on
			// ANY picked field. So A↔B via Email and B↔C via Phone
			// produces {A,B,C} together even though A and C don't
			// share anything directly, which is the right semantic
			// for "same person, different contact methods." Empty
			// values still don't union (empty-equals-empty would
			// merge every record into one mega-group).
			function _scanForObject(objectName, fields, op) {
				if (!objectName || !Array.isArray(fields) || fields.length === 0) {
return null;
}
				op = op === 'or' ? 'or' : 'and';
				const recs = canvasState.bulkRecords.filter(
					(r) => r && !r.isTypeNode && !isRecordPendingDelete(r) && r.objectName === objectName
				);
				if (recs.length < 2) {
return null;
}

				if (op === 'and') {
					const buckets = new Map();
					for (const rec of recs) {
						const v = rec.values || {};
						const parts = [];
						let full = true;
						for (const f of fields) {
							const norm = _normalize(v[f]);
							if (!norm) {
 full = false; break; 
}
							parts.push(f + ':' + norm);
						}
						if (!full) {
continue;
}
						const k = parts.join('||');
						if (!buckets.has(k)) {
buckets.set(k, []);
}
						buckets.get(k).push(rec);
					}
					const groups = [];
					for (const bucket of buckets.values()) {
						if (bucket.length < 2) {
continue;
}
						_sortGroupRecords(bucket);
						groups.push({ fields, records: bucket, winnerId: bucket[0].id });
					}
					if (groups.length === 0) {
return null;
}
					return { objectName, groups, defaultFields: fields, op };
				}

				// OR: union-find. Index records by position; for each
				// picked field, group records that share a normalized
				// value, then union each group into one component.
				const parent = recs.map((_, i) => i);
				const find = (i) => {
					while (parent[i] !== i) {
						parent[i] = parent[parent[i]]; // path halving
						i = parent[i];
					}
					return i;
				};
				const union = (i, j) => {
					const ri = find(i), rj = find(j);
					if (ri !== rj) {
parent[ri] = rj;
}
				};
				for (const f of fields) {
					const byValue = new Map();
					for (let i = 0; i < recs.length; i++) {
						const v = (recs[i].values || {})[f];
						const norm = _normalize(v);
						if (!norm) {
continue;
}
						if (!byValue.has(norm)) {
byValue.set(norm, []);
}
						byValue.get(norm).push(i);
					}
					for (const idxs of byValue.values()) {
						if (idxs.length < 2) {
continue;
}
						for (let k = 1; k < idxs.length; k++) {
union(idxs[0], idxs[k]);
}
					}
				}
				const componentMap = new Map();
				for (let i = 0; i < recs.length; i++) {
					const root = find(i);
					if (!componentMap.has(root)) {
componentMap.set(root, []);
}
					componentMap.get(root).push(recs[i]);
				}
				const groups = [];
				for (const component of componentMap.values()) {
					if (component.length < 2) {
continue;
}
					_sortGroupRecords(component);
					groups.push({ fields, records: component, winnerId: component[0].id });
				}
				if (groups.length === 0) {
return null;
}
				return { objectName, groups, defaultFields: fields, op };
			}

			// ----- config step (object + field picker) -----
			//
			// Walks canvasState to figure out which objects have ≥ 2
			// records (the dedup-eligible set), then for each, collects
			// the union of value-keys across those records (skipping
			// system + internal). The picker shows ONE object at a
			// time; default-selected fields come from MATCH_RULES when
			// the picked object has a rule that has any overlap with
			// the available fields. Otherwise the first available
			// field is preselected so Scan is enabled without the user
			// having to touch anything.

			const SYSTEM_FIELDS = new Set([
				'Id',
				'CreatedDate', 'CreatedById',
				'LastModifiedDate', 'LastModifiedById',
				'SystemModstamp',
				'LastReferencedDate', 'LastViewedDate',
				'IsDeleted',
			]);

			// For a given object on the canvas: what fields are
			// available as match-key candidates, and how many of the
			// records have each one populated? Records of that object
			// only; type-nodes / pending-delete excluded.
			function _availableFieldsForObject(objectName) {
				const recs = canvasState.bulkRecords.filter(
					(r) => r && !r.isTypeNode && !isRecordPendingDelete(r) && r.objectName === objectName
				);
				const counts = new Map();
				for (const rec of recs) {
					const v = rec.values || {};
					for (const k of Object.keys(v)) {
						if (!k || k.startsWith('_')) {
continue;
}
						if (SYSTEM_FIELDS.has(k)) {
continue;
}
						const val = v[k];
						if (val === null || val === undefined || val === '') {
continue;
}
						counts.set(k, (counts.get(k) || 0) + 1);
					}
				}
				// Sort alphabetically. The default-checked set bubbles
				// up visually via the "default" tag rather than sort
				// order so the alphabetical scan is stable as the user
				// switches objects.
				return Array.from(counts.entries())
					.map(([name, populated]) => ({ name, populated, total: recs.length }))
					.sort((a, b) => a.name.localeCompare(b.name));
			}

			// First MATCH_RULES rule-set whose fields are ALL present
			// on the canvas (i.e. some record has a value for each).
			// Returns null when no rule set fits; caller falls back to
			// preselecting the single most-populated field.
			function _defaultFieldsFor(objectName, availableFields) {
				const rules = _matchRulesFor(objectName);
				const availSet = new Set(availableFields.map((f) => f.name));
				for (const fieldSet of rules) {
					if (fieldSet.every((f) => availSet.has(f))) {
return fieldSet.slice();
}
				}
				return null;
			}

			// Which object types currently have ≥ 2 dedup-eligible
			// records on the canvas. Used to populate the object
			// dropdown in the config step.
			function _eligibleObjects() {
				const counts = new Map();
				for (const r of canvasState.bulkRecords) {
					if (!r || r.isTypeNode) {
continue;
}
					if (isRecordPendingDelete(r)) {
continue;
}
					counts.set(r.objectName, (counts.get(r.objectName) || 0) + 1);
				}
				return Array.from(counts.entries())
					.filter(([, n]) => n >= 2)
					.map(([objectName, recordCount]) => ({ objectName, recordCount }))
					.sort((a, b) => a.objectName.localeCompare(b.objectName));
			}

			// Re-renders the modal body in place after a winner change
			// (so the "X records will be removed" count + the
			// strikethrough on loser rows update without rebuilding
			// the chrome). Kept compact, since the modal is short-lived so
			// no diff/patch optimization needed.
			function _renderBody(overlay, sections) {
				const body = overlay.querySelector('.fdm-body');
				if (!body) {
return;
}
				let html = '';
				let losersTotal = 0;
				sections.forEach((section) => {
					html += '<div class="fdm-section">' +
						'<div class="fdm-section-head">' +
							escapeHtml(section.objectName) +
							' <span class="fdm-section-fields">matching on ' + escapeHtml(_formatFieldSet(section.defaultFields, section.op)) + '</span>' +
						'</div>';
					section.groups.forEach((group, gi) => {
						const groupKey = section.objectName + ':' + gi;
						html += '<div class="fdm-group">' +
							'<div class="fdm-group-head">' + group.records.length + ' records match</div>' +
							'<ul class="fdm-rows">';
						group.records.forEach((rec) => {
							const isWinner = group.winnerId === rec.id;
							const rowClass = 'fdm-row' + (isWinner ? ' fdm-row--keep' : ' fdm-row--remove');
							const badge = rec.loadedFromId
								? '<span class="fdm-badge fdm-badge--loaded" title="Loaded from Salesforce, will be marked for delete on Apply">loaded</span>'
								: '<span class="fdm-badge fdm-badge--draft" title="Draft record, will be removed from canvas on Apply">draft</span>';
							// Per-row "Go to": pans the canvas behind the
							// modal to the card and flashes it. Lets the
							// user investigate a candidate before
							// committing to keep / remove. Modal peeks
							// (fades) during the flash so the card isn't
							// fully obscured.
							const gotoBtn = '<button type="button" class="fdm-row-goto" data-fdm-goto="' + rec.id + '" title="Pan the canvas to this record and flash it" aria-label="Go to this record on the canvas">' +
								'<span aria-hidden="true">&#8689;</span>' +
							'</button>';
							html += '<li class="' + rowClass + '">' +
								'<label class="fdm-row-label">' +
									'<input type="radio" name="fdm-group-' + escapeHtml(groupKey) + '" value="' + rec.id + '"' + (isWinner ? ' checked' : '') + ' data-fdm-winner data-group-key="' + escapeHtml(groupKey) + '">' +
									'<span class="fdm-row-keep-tag">' + (isWinner ? 'KEEP' : 'REMOVE') + '</span>' +
									'<span class="fdm-row-ord">' + escapeHtml(section.objectName) + ' #' + recordOrdinal(rec) + '</span>' +
									'<span class="fdm-row-name">' + escapeHtml(_displayName(rec)) + '</span>' +
									badge +
								'</label>' +
								gotoBtn +
								'<div class="fdm-row-excerpt">' + escapeHtml(_matchExcerpt(rec, group.fields)) + '</div>' +
							'</li>';
							if (!isWinner) {
losersTotal++;
}
						});
						html += '</ul></div>';
					});
					html += '</div>';
				});
				body.innerHTML = html;
				// Update the apply CTA copy + count.
				const applyBtn = overlay.querySelector('.fdm-apply');
				if (applyBtn) {
					applyBtn.disabled = losersTotal === 0;
					applyBtn.textContent = losersTotal === 0
						? 'Nothing to remove'
						: 'Remove ' + losersTotal + ' duplicate' + (losersTotal === 1 ? '' : 's');
				}
				// Wire radios to re-render so the row tags + count
				// reflect the new winner choice.
				body.querySelectorAll('[data-fdm-winner]').forEach((input) => {
					input.addEventListener('change', () => {
						const [obj, gi] = input.dataset.groupKey.split(':');
						const section = sections.find((s) => s.objectName === obj);
						if (!section) {
return;
}
						const group = section.groups[parseInt(gi, 10)];
						if (!group) {
return;
}
						group.winnerId = parseInt(input.value, 10);
						_renderBody(overlay, sections);
					});
				});
				// Wire per-row "Go to" → pan canvas + flash card.
				body.querySelectorAll('[data-fdm-goto]').forEach((btn) => {
					btn.addEventListener('click', (e) => {
						e.preventDefault();
						e.stopPropagation();
						const recordId = parseInt(btn.dataset.fdmGoto, 10);
						if (Number.isFinite(recordId)) {
_jumpToRecord(recordId);
}
					});
				});
			}

			function _renderEmpty(overlay, objectName, fields, op) {
				const body = overlay.querySelector('.fdm-body');
				if (body) {
					const joiner = op === 'or' ? ' / ' : ' + ';
					const fieldList = (fields || []).join(joiner);
					const phrase = op === 'or'
						? 'share a normalized value on any of'
						: 'share the same normalized value across all of';
					body.innerHTML = '<div class="fdm-empty">' +
						'<div class="fdm-empty-title">No duplicates found</div>' +
						'<div class="fdm-empty-hint">' +
							'No two <code>' + escapeHtml(objectName || '') + '</code> records ' + phrase + ' ' +
							'<code>' + escapeHtml(fieldList) + '</code>' +
							'. Try a different field set or switch operator if you expected matches.' +
						'</div>' +
					'</div>';
				}
				const applyBtn = overlay.querySelector('.fdm-apply');
				if (applyBtn) {
					applyBtn.disabled = true;
					applyBtn.textContent = 'Nothing to remove';
				}
			}

			function _apply(sections) {
				const winners = new Set();
				const losers = [];
				sections.forEach((section) => {
					section.groups.forEach((group) => {
						winners.add(group.winnerId);
						group.records.forEach((rec) => {
							if (rec.id !== group.winnerId) {
losers.push(rec);
}
						});
					});
				});
				// Whole-canvas snapshot BEFORE any removal, for the single
				// batch Undo. deleteRecord/markPendingDelete reassign the
				// bulkRecords/bulkAssociations arrays (or set pendingDelete
				// in place), so holding the pre-op array references restores
				// deleted drafts + their associations, and clearing the flag
				// on the marked losers un-marks them.
				const _snapBulk = canvasState.bulkRecords.slice();
				const _snapAssoc = canvasState.bulkAssociations.slice();
				const _snapSelected = new Set(canvasState.bulkSelectedIds);
				const _undoSizeBefore = undoStackSize ? undoStackSize() : 0;
				const _markedLoserIds = [];
				// Two-pass removal: drafts first (deleteRecord mutates
				// bulkRecords; doing it inline alongside loaded-mark
				// inside one loop would mess with subsequent
				// markPendingDelete lookups since the array index
				// drifts. Loaded records are tagged via the public
				// markPendingDelete helper which guards against
				// drafts/type-nodes/no-access placeholders.
				let drafts = 0, marked = 0;
				losers.forEach((rec) => {
					if (rec.loadedFromId) {
						if (markPendingDelete(rec.id)) {
							marked++;
							_markedLoserIds.push(rec.id);
						}
					}
				});
				losers.forEach((rec) => {
					if (!rec.loadedFromId) {
						deleteRecord(rec.id);
						drafts++;
					}
				});
				// Discard the per-record undo entries the helpers just pushed;
				// the batch Undo below owns reverting this operation.
				if (trimUndoStack && undoStackSize) {
					trimUndoStack(undoStackSize() - _undoSizeBefore);
				}
				renderBulkView();
				const parts = [];
				if (drafts > 0) {
parts.push(drafts + ' draft' + (drafts === 1 ? '' : 's') + ' removed');
}
				if (marked > 0) {
parts.push(marked + ' loaded record' + (marked === 1 ? '' : 's') + ' marked for delete');
}
				const msg = parts.length === 0
					? 'No duplicates removed.'
					: parts.join(' · ');
				const _postBulk = canvasState.bulkRecords;
				const _postAssoc = canvasState.bulkAssociations;
				const _postFingerprint = JSON.stringify({
					records: canvasState.bulkRecords,
					associations: canvasState.bulkAssociations,
				});
				const _undo = () => {
					let currentFingerprint = null;
					try {
						currentFingerprint = JSON.stringify({
							records: canvasState.bulkRecords,
							associations: canvasState.bulkAssociations,
						});
					} catch (_e) {}
					if (canvasState.bulkRecords !== _postBulk ||
						canvasState.bulkAssociations !== _postAssoc ||
						currentFingerprint !== _postFingerprint) {
						showBulkToast('Can’t undo duplicate removal because the canvas was edited afterward.', 'info');
						return;
					}
					canvasState.bulkRecords = _snapBulk;
					canvasState.bulkAssociations = _snapAssoc;
					canvasState.bulkSelectedIds = _snapSelected;
					// Un-mark the loaded losers (the scan excludes already
					// pending-delete records, so every marked loser was clean
					// before this op).
					_markedLoserIds.forEach((id) => {
						const r = canvasState.bulkRecords.find((x) => x.id === id);
						if (r) {
							r.pendingDelete = false;
						}
					});
					renderBulkView();
					showBulkToast('Restored the removed duplicates.');
				};
				if ((drafts + marked) > 0 && showBulkToastWithAction) {
					showBulkToastWithAction(msg, 'Undo', _undo);
				} else {
					showBulkToast(msg);
				}
			}

			function openFindDuplicatesModal() {
				// Drop any prior instance so re-opening doesn't stack.
				document.querySelectorAll('.fdm-overlay').forEach((el) => el.remove());
				const overlay = document.createElement('div');
				overlay.className = 'modal fdm-overlay';
				overlay.innerHTML =
					'<div class="modal-overlay" data-fdm-close></div>' +
					'<div class="modal-body fdm-body-wrap">' +
						'<div class="modal-header">' +
							'<h3>Find duplicates</h3>' +
							'<button class="modal-close" data-fdm-close>&times;</button>' +
						'</div>' +
						'<div class="modal-content fdm-content">' +
							'<div class="fdm-intro-wrap"></div>' +
							'<div class="fdm-body"></div>' +
						'</div>' +
						'<div class="modal-footer fdm-footer"></div>' +
					'</div>';
				document.body.appendChild(overlay);
				const cleanup = () => overlay.remove();
				overlay.querySelectorAll('[data-fdm-close]').forEach((el) =>
					el.addEventListener('click', cleanup)
				);
				const onEsc = (ev) => {
 if (ev.key === 'Escape') {
 cleanup(); document.removeEventListener('keydown', onEsc, true); 
} 
};
				document.addEventListener('keydown', onEsc, true);

				// Per-object selected-field memory across object switches
				// inside this modal instance. If the user picks Contact,
				// touches the checkboxes, switches to Account, then back
				// to Contact, we restore their picks rather than
				// re-defaulting. Per-instance, not persisted across
				// modal opens.
				const _fieldMemory = new Map();
				// Match operator (AND / OR) is modal-wide, not per
				// object: the user picks "strict" or "loose" once and
				// it stays as they switch objects. Default AND (the
				// safer, less-aggressive merging behavior).
				const _modeRef = { op: 'and' };

				const eligible = _eligibleObjects();
				if (eligible.length === 0) {
					_renderNoEligible(overlay);
					return;
				}
				const initial = eligible[0].objectName;
				_renderConfig(overlay, initial, eligible, _fieldMemory, _modeRef, cleanup);
			}

			// Step 0: hard fail before the config can even render:
			// no object on the canvas has 2+ dedup-eligible records.
			function _renderNoEligible(overlay) {
				const intro = overlay.querySelector('.fdm-intro-wrap');
				const body = overlay.querySelector('.fdm-body');
				const footer = overlay.querySelector('.fdm-footer');
				if (intro) {
intro.innerHTML = '';
}
				if (body) {
					body.innerHTML = '<div class="fdm-empty">' +
						'<div class="fdm-empty-title">Nothing to scan</div>' +
						'<div class="fdm-empty-hint">Find duplicates needs at least 2 records of the same object type. Add more records to the canvas, then come back.</div>' +
					'</div>';
				}
				if (footer) {
					footer.innerHTML = '<button class="button secondary" data-fdm-close>Close</button>';
					footer.querySelectorAll('[data-fdm-close]').forEach((el) => el.addEventListener('click', () => overlay.remove()));
				}
			}

			// Step 1: object + field picker + match operator. Switching
			// the object rebuilds the field list; checkbox + operator
			// state persists across navigation for the modal's lifetime.
			function _renderConfig(overlay, objectName, eligible, fieldMemory, modeRef, cleanup) {
				const intro = overlay.querySelector('.fdm-intro-wrap');
				const body = overlay.querySelector('.fdm-body');
				const footer = overlay.querySelector('.fdm-footer');

				const available = _availableFieldsForObject(objectName);
				let selected;
				if (fieldMemory.has(objectName)) {
					selected = new Set(fieldMemory.get(objectName));
				} else {
					const defaults = _defaultFieldsFor(objectName, available);
					if (defaults && defaults.length > 0) {
						selected = new Set(defaults);
					} else {
						// No MATCH_RULES default fits. Preselect the
						// single most-populated field so Scan is enabled
						// out of the box; user can re-pick.
						const top = available.slice().sort((a, b) => b.populated - a.populated)[0];
						selected = new Set(top ? [top.name] : []);
					}
				}

				const objectOptions = eligible.map((e) =>
					'<option value="' + escapeHtml(e.objectName) + '"' +
						(e.objectName === objectName ? ' selected' : '') + '>' +
						escapeHtml(e.objectName) + ' (' + e.recordCount + ')' +
					'</option>'
				).join('');

				const defaultsSet = new Set(_defaultFieldsFor(objectName, available) || []);
				const fieldRows = available.length === 0
					? '<div class="fdm-fields-empty">None of the records of this object type have any field values yet. Fill some fields first, then come back.</div>'
					: available.map((f) => {
						const checked = selected.has(f.name) ? ' checked' : '';
						const isDefault = defaultsSet.has(f.name);
						return '<label class="fdm-field-row">' +
							'<input type="checkbox" data-fdm-field value="' + escapeHtml(f.name) + '"' + checked + '>' +
							'<span class="fdm-field-name"><code>' + escapeHtml(f.name) + '</code></span>' +
							(isDefault ? '<span class="fdm-field-tag">suggested</span>' : '') +
							'<span class="fdm-field-pop">' + f.populated + ' of ' + f.total + ' populated</span>' +
						'</label>';
					}).join('');

				if (intro) {
					intro.innerHTML =
						'<p class="fdm-intro">Pick the object, the fields that identify a duplicate, and how strictly to match. Values are compared after case + whitespace normalization.</p>';
				}
				if (body) {
					const andChecked = modeRef.op === 'and' ? ' checked' : '';
					const orChecked = modeRef.op === 'or' ? ' checked' : '';
					body.innerHTML =
						'<div class="fdm-config">' +
							'<label class="fdm-config-row">' +
								'<span class="fdm-config-label">Object</span>' +
								'<select id="fdm-object">' + objectOptions + '</select>' +
							'</label>' +
							'<div class="fdm-config-row fdm-config-row--block">' +
								'<span class="fdm-config-label">Match fields</span>' +
								'<div class="fdm-fields">' + fieldRows + '</div>' +
							'</div>' +
							// Match operator. AND is stricter: every
							// picked field must agree. OR is looser
							// and transitive: records get unioned
							// when they share a value on ANY picked
							// field (A↔B via Email, B↔C via Phone →
							// {A,B,C} all group). Sub-text explains
							// the tradeoff in plain English so the
							// user picks intentionally.
							'<div class="fdm-config-row fdm-config-row--block">' +
								'<span class="fdm-config-label">Match when…</span>' +
								'<div class="fdm-mode">' +
									'<label class="fdm-mode-opt">' +
										'<input type="radio" name="fdm-op" value="and"' + andChecked + '>' +
										'<span class="fdm-mode-label">All selected fields agree <span class="fdm-mode-tag">AND &middot; strict</span></span>' +
										'<span class="fdm-mode-sub">Two records match only when every checked field has the same value. Fewer false positives; misses records that disagree on one field.</span>' +
									'</label>' +
									'<label class="fdm-mode-opt">' +
										'<input type="radio" name="fdm-op" value="or"' + orChecked + '>' +
										'<span class="fdm-mode-label">Any selected field agrees <span class="fdm-mode-tag">OR &middot; transitive</span></span>' +
										'<span class="fdm-mode-sub">Records group whenever they share a value on any checked field. Catches "same person, different contact methods": A↔B by Email and B↔C by Phone groups {A, B, C}.</span>' +
									'</label>' +
								'</div>' +
							'</div>' +
						'</div>';
				}
				if (footer) {
					footer.innerHTML =
						'<button class="button secondary" data-fdm-close>Cancel</button>' +
						'<button class="button fdm-scan" id="fdm-scan">Scan for matches</button>';
					footer.querySelectorAll('[data-fdm-close]').forEach((el) => el.addEventListener('click', cleanup));
				}

				const updateScanEnabled = () => {
					const scanBtn = footer && footer.querySelector('#fdm-scan');
					if (scanBtn) {
scanBtn.disabled = selected.size === 0;
}
				};
				updateScanEnabled();

				// Object switch → re-render in place (selection picks
				// up the new object's memory entry or its defaults).
				const objSel = body && body.querySelector('#fdm-object');
				if (objSel) {
					objSel.addEventListener('change', () => {
						// Snapshot current selection before navigating
						// so the user can come back.
						fieldMemory.set(objectName, Array.from(selected));
						_renderConfig(overlay, objSel.value, eligible, fieldMemory, modeRef, cleanup);
					});
				}
				// Field checkboxes.
				if (body) {
					body.querySelectorAll('[data-fdm-field]').forEach((cb) => {
						cb.addEventListener('change', () => {
							if (cb.checked) {
selected.add(cb.value);
} else {
selected.delete(cb.value);
}
							updateScanEnabled();
						});
					});
					// Operator radios.
					body.querySelectorAll('input[name="fdm-op"]').forEach((rb) => {
						rb.addEventListener('change', () => {
							if (rb.checked) {
modeRef.op = rb.value === 'or' ? 'or' : 'and';
}
						});
					});
				}
				// Scan trigger → step 2.
				const scanBtn = footer && footer.querySelector('#fdm-scan');
				if (scanBtn) {
					scanBtn.addEventListener('click', () => {
						if (scanBtn.disabled) {
return;
}
						const fields = Array.from(selected);
						fieldMemory.set(objectName, fields);
						const section = _scanForObject(objectName, fields, modeRef.op);
						if (!section) {
							_renderEmpty(overlay, objectName, fields, modeRef.op);
							_renderResultsFooter(overlay, [], objectName, eligible, fieldMemory, modeRef, cleanup);
							return;
						}
						_renderBody(overlay, [section]);
						_renderResultsFooter(overlay, [section], objectName, eligible, fieldMemory, modeRef, cleanup);
					});
				}
			}

			// Step 2 footer: Back to config, Cancel, Apply.
			function _renderResultsFooter(overlay, sections, objectName, eligible, fieldMemory, modeRef, cleanup) {
				const footer = overlay.querySelector('.fdm-footer');
				if (!footer) {
return;
}
				const losersTotal = sections.reduce((acc, sec) => {
					return acc + sec.groups.reduce((a, g) => a + (g.records.length - 1), 0);
				}, 0);
				footer.innerHTML =
					'<button class="button secondary" id="fdm-back">&larr; Back</button>' +
					'<button class="button secondary" data-fdm-close>Cancel</button>' +
					'<button class="button fdm-apply"' + (losersTotal === 0 ? ' disabled' : '') + '>' +
						(losersTotal === 0 ? 'Nothing to remove' : 'Remove ' + losersTotal + ' duplicate' + (losersTotal === 1 ? '' : 's')) +
					'</button>';
				footer.querySelectorAll('[data-fdm-close]').forEach((el) => el.addEventListener('click', cleanup));
				const backBtn = footer.querySelector('#fdm-back');
				if (backBtn) {
					backBtn.addEventListener('click', () => _renderConfig(overlay, objectName, eligible, fieldMemory, modeRef, cleanup));
				}
				const applyBtn = footer.querySelector('.fdm-apply');
				if (applyBtn) {
					applyBtn.addEventListener('click', () => {
						if (applyBtn.disabled) {
return;
}
						_apply(sections);
						cleanup();
					});
				}
			}

			return { openFindDuplicatesModal: openFindDuplicatesModal };
		},
	};
}());
