// Two-record field-level diff modal.
//
// Reads two records' values, runs computeRecordDiff, renders the
// result as a two-column field list with diff highlighting. Per-row
// copy actions (◀▶) mutate the target record's values in
// canvasState, flow through renderBulkView so the canvas card flips
// to "modified," and re-render the modal body inline so the user
// can resolve diffs sequentially without re-opening.
//
// Per-pair suppression list: the ⊘ button on a row tags the field
// as "intentionally different for this pair," moving it into the
// Ignored bucket and out of the active-differences count. Stored
// on canvasState.diffSuppressions keyed by sorted record-id pair
// (order-invariant), persisted via the existing autosave snapshot.
// Pair-keyed not record-keyed so suppressions don't leak across
// different diff comparisons of the same record.
//
// Type-aware value display: picklist values resolve to their human
// labels (raw API value rendered as a small mono suffix), references
// resolve to the on-canvas record's title when the FK target is
// loaded, booleans render Yes/No, dates and datetimes use the user's
// locale. Falls back to raw values when describe metadata isn't
// available so an in-flight describe load still produces readable
// diffs.
//
// Read-only field guards: copy buttons toward a target where the
// field describe says calculated / autoNumber / non-createable (for
// drafts) / non-updateable (for loaded records) get disabled with a
// tooltip naming the gate. A "read-only" badge in the field column
// surfaces the constraint declaratively. Bulk apply skips read-only
// targets so the action's stated count reflects what actually
// resolves.
//
// Search: case-insensitive substring filter over field label + API
// name. Composes with the variant filter chips: a row is visible
// iff both filters pass. Query is preserved across in-place re-
// renders so a per-row copy doesn't blow away the user's filter.
//
// Entry point:
//   openRecordDiffModal(recA, recB): both records must be on the
//   canvas. Caller (bulk-ops-menu) gates on "exactly 2 selected"
//   before calling.
//
// Dependencies passed to mount():
//   canvasState: describeCache + values mutation
//   escapeHtml: XSS-safe HTML interpolation
//   computeRecordDiff: pure diff function from value-compare.js
//   recordOrdinal: for the "Account #3" header rendering
//   renderBulkView: repaint the canvas after a per-field copy
//   isRecordPendingDelete: gate copy actions; mutating values on a
//                           pending-delete record is meaningless (the
//                           record is DELETE'd at upload time and any
//                           value edits are silently dropped)
//
// Public API (returned from mount):
//   openRecordDiffModal(recA, recB)
//
// Exposed as window.OrgLoom.recordDiffModal. Load order: before app.js.

(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	// Salesforce compound address and geolocation containers are read-only
	// convenience values. Their writable component fields (BillingStreet,
	// BillingCity, Location__Latitude__s, etc.) are the canonical values for
	// canvas edits. Comparing both representations duplicates the same data and
	// makes an existing record's compound object look different from an
	// otherwise-identical draft that only carries the components.
	function _isCompoundContainerField(field) {
		return !!field && (field.type === 'address' || field.type === 'location');
	}

	function _filterComparableDiff(diff, fieldDefForA, fieldDefForB) {
		function keep(fieldName) {
			return !_isCompoundContainerField(fieldDefForA(fieldName))
				&& !_isCompoundContainerField(fieldDefForB(fieldName));
		}
		return Object.assign({}, diff, {
			shared: diff.shared.filter(keep),
			differing: diff.differing.filter(keep),
			aOnly: diff.aOnly.filter(keep),
			bOnly: diff.bOnly.filter(keep),
		});
	}

	window.OrgLoom.recordDiffModal = {
		filterComparableDiff: _filterComparableDiff,
		mount: function mount(deps) {
			const required = [
				'canvasState', 'escapeHtml', 'computeRecordDiff', 'recordOrdinal',
				'renderBulkView', 'isRecordPendingDelete',
			];
			if (!deps) {
throw new Error('record-diff-modal.mount: missing deps object');
}
			for (const k of required) {
				if (deps[k] === undefined || deps[k] === null) {
					throw new Error('record-diff-modal.mount: missing dep ' + k);
				}
			}
			const canvasState = deps.canvasState;
			const escapeHtml = deps.escapeHtml;
			const computeRecordDiff = deps.computeRecordDiff;
			const recordOrdinal = deps.recordOrdinal;
			const renderBulkView = deps.renderBulkView;
			const isRecordPendingDelete = deps.isRecordPendingDelete;
			// Optional: register value-copy mutations on the canvas undo
			// stack so Cmd/Ctrl+Z reverts them. The modal stays open over the
			// canvas during copies, so a toast Undo would sit behind the
			// overlay; the global undo stack (same mechanism as delete/mark)
			// is the right affordance here.
			const pushUndo = typeof deps.pushUndo === 'function' ? deps.pushUndo : null;
			const showBulkToast = typeof deps.showBulkToast === 'function'
				? deps.showBulkToast : function () {};

			// Snapshot / restore a single field's prior state (whether the
			// key existed + its value) so undo can restore an overwrite AND
			// distinguish "was empty string" from "key was absent."
			function _snapField(rec, fieldName) {
				const had = !!(rec.values && Object.prototype.hasOwnProperty.call(rec.values, fieldName));
				return { had: had, prev: had ? rec.values[fieldName] : undefined };
			}
			function _restoreField(rec, fieldName, snap) {
				if (!rec.values) {
					rec.values = {};
				}
				if (snap.had) {
					rec.values[fieldName] = snap.prev;
				} else {
					delete rec.values[fieldName];
				}
				rec._valuesRevision = (Number(rec._valuesRevision) || 0) + 1;
			}
			function _writeField(rec, fieldName, value) {
				rec.values[fieldName] = value;
				rec._valuesRevision = (Number(rec._valuesRevision) || 0) + 1;
			}
			function _fieldUndoIsCurrent(rec, revision, fieldName, expected) {
				return (Number(rec._valuesRevision) || 0) === revision &&
					rec.values && rec.values[fieldName] === expected;
			}

			// Diff-suppression: per-pair "this field's difference is
			// intentional, stop flagging it." Persisted on canvasState
			// so autosave preserves it across reloads; not written to
			// the saved-canvas payload (suppressions are a local view
			// preference, not data anyone sharing the canvas should
			// inherit). Pair key is order-invariant so swapping which
			// record is A vs B doesn't lose the user's choices.
			function _pairKey(idA, idB) {
				const a = Number(idA), b = Number(idB);
				return (a < b ? a + '|' + b : b + '|' + a);
			}
			function _readSuppressedSet(idA, idB) {
				const store = canvasState.diffSuppressions || {};
				const arr = store[_pairKey(idA, idB)];
				return new Set(Array.isArray(arr) ? arr : []);
			}
			function _writeSuppressedSet(idA, idB, set) {
				if (!canvasState.diffSuppressions) {
canvasState.diffSuppressions = {};
}
				const key = _pairKey(idA, idB);
				if (set.size === 0) {
delete canvasState.diffSuppressions[key];
} else {
canvasState.diffSuppressions[key] = Array.from(set);
}
			}
			function _suppressField(idA, idB, fieldName) {
				const set = _readSuppressedSet(idA, idB);
				set.add(fieldName);
				_writeSuppressedSet(idA, idB, set);
			}
			function _unsuppressField(idA, idB, fieldName) {
				const set = _readSuppressedSet(idA, idB);
				set.delete(fieldName);
				_writeSuppressedSet(idA, idB, set);
			}

			// Resolve a card title for the modal header. Same fallback
			// chain as the records canvas's titleFor: keep them in sync
			// or the diff modal will disagree with what the user sees on
			// the canvas card.
			function _titleFor(rec) {
				if (!rec) {
return '(missing record)';
}
				if (rec._inaccessible) {
return 'No access';
}
				if (rec.values) {
					const fn = rec.values.FirstName, ln = rec.values.LastName;
					if (fn != null || ln != null) {
						const composed = ((fn || '') + ' ' + (ln || '')).trim();
						if (composed) {
return composed;
}
					}
					const desc = canvasState.describeCache[rec.objectName];
					if (desc && Array.isArray(desc.fields)) {
						const nf = desc.fields.find((f) => f.nameField);
						if (nf && rec.values[nf.name]) {
return String(rec.values[nf.name]);
}
					}
					const generic = rec.values.Name || rec.values.CaseNumber
						|| rec.values.Subject || rec.values.Title;
					if (generic) {
return String(generic);
}
				}
				return rec.loadedFromId ? '(no title)' : '(no name yet)';
			}

			// Translate a field name to its describe label. Falls back to
			// the raw API name when the describe hasn't loaded yet (the
			// diff modal still works, just shows API names).
			function _fieldLabel(objectName, fieldName) {
				const desc = objectName && canvasState.describeCache[objectName];
				if (desc && Array.isArray(desc.fields)) {
					const f = desc.fields.find((x) => x && x.name === fieldName);
					if (f && f.label) {
return f.label;
}
				}
				return fieldName;
			}
			// Pull the field describe by name. Used both for the typed
			// value renderer and the writability check; cached at
			// _renderBody scope so each row doesn't re-scan the array.
			function _fieldDef(objectName, fieldName) {
				const desc = objectName && canvasState.describeCache[objectName];
				if (!desc || !Array.isArray(desc.fields)) {
return null;
}
				return desc.fields.find((x) => x && x.name === fieldName) || null;
			}

			// A target field is writable iff (1) it's not a calculated /
			// auto-number field, AND (2) the target's current load-state
			// matches the operation that would carry the change to SF.
			// Drafts go through INSERT (createable), loaded records go
			// through UPDATE (updateable). Unknown describes default to
			// writable; we'd rather let the user copy and have the
			// upload surface a per-record SF error than block on
			// missing metadata.
			function _isFieldWritable(field, targetRec) {
				if (!field) {
return true;
}
				if (_isCompoundContainerField(field)) {
return false;
}
				if (field.calculated || field.autoNumber) {
return false;
}
				if (targetRec && targetRec.loadedFromId) {
return field.updateable !== false;
}
				return field.createable !== false;
			}

			// Resolve an FK lookup value to the on-canvas record's title
			// when possible. Keyed on the 15-char SF id prefix so
			// 15/18-char id forms unify. Returns null when no canvas
			// record matches (FK points at a record the user hasn't
			// loaded).
			function _buildFkResolver() {
				const m = new Map();
				for (const r of canvasState.bulkRecords) {
					if (!r || !r.loadedFromId) {
continue;
}
					const key = String(r.loadedFromId).slice(0, 15);
					m.set(key, _titleFor(r));
				}
				return m;
			}

			// Type-aware value cell. Field describe drives presentation:
			// picklist values resolve to their human labels; references
			// resolve to the on-canvas record title; booleans become
			// Yes/No; dates and datetimes render in the user's locale.
			// Falls back to the raw value when describe data isn't
			// available so an in-flight describe load still produces a
			// readable diff. null/empty consistently shows the muted "—"
			// placeholder so users can tell "this field has nothing on
			// this side" at a glance.
			function _renderTypedValue(v, fieldDef, fkResolver) {
				if (v == null || v === '') {
return '<span class="rdm-empty">—</span>';
}
				const type = fieldDef && fieldDef.type;
				// Picklist: single value. Pull the matching label from
				// picklistValues; show the API value as a small mono
				// suffix so power users can verify the underlying value.
				if ((type === 'picklist' || type === 'combobox') && Array.isArray(fieldDef.picklistValues)) {
					const p = fieldDef.picklistValues.find((x) => x && x.value === v);
					if (p && p.label && p.label !== p.value) {
						return escapeHtml(p.label) + ' <code class="rdm-val-suffix">' + escapeHtml(String(v)) + '</code>';
					}
				}
				// Multipicklist: semicolon-delimited. Render each part
				// resolved to its label, joined with " · " for legibility.
				if (type === 'multipicklist' && Array.isArray(fieldDef.picklistValues)) {
					const parts = String(v).split(';').map((s) => s.trim()).filter(Boolean);
					const labels = parts.map((part) => {
						const p = fieldDef.picklistValues.find((x) => x && x.value === part);
						return (p && p.label) ? p.label : part;
					});
					return escapeHtml(labels.join(' · '));
				}
				// Reference (FK): resolve to the on-canvas record's
				// title when we can. SF ids are case-sensitive at the
				// 15-char form; the resolver indexes them already.
				if (type === 'reference' && fkResolver) {
					const key = String(v).slice(0, 15);
					const title = fkResolver.get(key);
					if (title) {
						return escapeHtml(title) + ' <code class="rdm-val-suffix">' + escapeHtml(String(v)) + '</code>';
					}
					return '<code>' + escapeHtml(String(v)) + '</code>';
				}
				// Booleans: SF returns them as actual booleans on REST,
				// but API users often write the string forms 'true' /
				// 'false'. Catch both.
				if (type === 'boolean' || typeof v === 'boolean') {
					const b = v === true || v === 'true' || v === 1 || v === '1';
					return b ? '<span class="rdm-val-bool">Yes</span>' : '<span class="rdm-val-bool">No</span>';
				}
				// Dates / datetimes: render locale-formatted. SF emits
				// 'YYYY-MM-DD' for date and ISO-8601 for datetime. We
				// hand the raw string to Date.parse and fall back to
				// the raw string if the parse fails (formula-emitted
				// or otherwise unusual shapes).
				if (type === 'date' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
					const t = Date.parse(v);
					if (!isNaN(t)) {
						const d = new Date(t);
						return escapeHtml(d.toLocaleDateString());
					}
				}
				if (type === 'datetime' && typeof v === 'string') {
					const t = Date.parse(v);
					if (!isNaN(t)) {
						const d = new Date(t);
						return escapeHtml(d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
					}
				}
				// Default: string-safe escape, JSON.stringify for
				// nested objects.
				if (typeof v === 'string') {
return escapeHtml(v);
}
				if (typeof v === 'number') {
return escapeHtml(String(v));
}
				try {
 return '<code>' + escapeHtml(JSON.stringify(v)) + '</code>'; 
} catch (_) {
 return '<code>(unserializable)</code>'; 
}
			}

			// One row per field. Variant class drives the highlight color
			// (differing = warn, aOnly/bOnly = info, shared = neutral).
			// Grid layout (matches the table head):
			//   [ field ] [ A value ] [ mid actions ] [ B value ] [ row actions ]
			// The middle "mid actions" column holds the copy buttons
			// (◀▶): they cross the column boundary, so they
			// shouldn't belong visually to either side. The right
			// "row actions" column holds Ignore / Restore: those are
			// row-level operations, not column-A operations. Both
			// gutters are auto-sized so a row with no action in a
			// given slot collapses to nothing rather than padding the
			// values away from the gutter.
			function _renderRow(fieldName, recA, recB, variant, ctx) {
				const objectName = recA.objectName || recB.objectName;
				const label = _fieldLabel(objectName, fieldName);
				const a = (recA && recA.values) ? recA.values[fieldName] : undefined;
				const b = (recB && recB.values) ? recB.values[fieldName] : undefined;
				const isResolvable = variant === 'diff' || variant === 'a-only' || variant === 'b-only';
				const isSuppressed = variant === 'suppressed';

				// Per-target writability, separate from "targetable"
				// (which is the record-level pendingDelete gate). A
				// targetable record can still have read-only fields
				// (formulas, auto-numbers, fields without create/update
				// perms in the org). When the field describe says the
				// field can't be written, disable the copy direction
				// toward that side with a tooltip explaining which gate
				// fired. Unknown describes default writable so an in-
				// flight metadata fetch doesn't false-flag everything.
				const fieldDefForA = ctx.fieldDefForA(fieldName);
				const fieldDefForB = ctx.fieldDefForB(fieldName);
				const aIsWritable = _isFieldWritable(fieldDefForA, recA);
				const bIsWritable = _isFieldWritable(fieldDefForB, recB);
				const readOnlyReason = (def) => {
					if (!def) {
return '';
}
					if (def.calculated) {
return 'formula';
}
					if (def.autoNumber) {
return 'auto-number';
}
					return 'read-only';
				};

				// Copy buttons in the MIDDLE column. ◀ pushes B → A
				// (value flows leftward from B to A), ▶ pushes A → B
				// (value flows rightward). For a-only rows only ▶
				// shows (A has the value, push to B); for b-only only
				// ◀ shows. Disabled-with-tooltip when target is
				// pendingDelete or field is read-only on target.
				let leftBtn = ''; // ◀ copies B → A
				if (variant === 'diff' || variant === 'b-only') {
					if (!ctx.aIsTargetable) {
						leftBtn = '<button type="button" class="rdm-copy-btn rdm-copy-btn-left" disabled aria-disabled="true" title="A is marked for delete, so copy is disabled">◀</button>';
					} else if (!aIsWritable) {
						leftBtn = '<button type="button" class="rdm-copy-btn rdm-copy-btn-left" disabled aria-disabled="true" title="Field is ' + readOnlyReason(fieldDefForA) + ' on A, so Salesforce won’t accept the write">◀</button>';
					} else {
						leftBtn = '<button type="button" class="rdm-copy-btn rdm-copy-btn-left" data-rdm-copy="b-to-a" data-rdm-field="' + escapeHtml(fieldName) + '" title="Copy B’s value to A">◀</button>';
					}
				}
				let rightBtn = ''; // ▶ copies A → B
				// Hidden in incoming/merge mode: B is the imported row and is
				// discarded on close, so pushing canvas → imported is a no-op.
				if (!ctx.incoming && (variant === 'diff' || variant === 'a-only')) {
					if (!ctx.bIsTargetable) {
						rightBtn = '<button type="button" class="rdm-copy-btn rdm-copy-btn-right" disabled aria-disabled="true" title="B is marked for delete, so copy is disabled">▶</button>';
					} else if (!bIsWritable) {
						rightBtn = '<button type="button" class="rdm-copy-btn rdm-copy-btn-right" disabled aria-disabled="true" title="Field is ' + readOnlyReason(fieldDefForB) + ' on B, so Salesforce won’t accept the write">▶</button>';
					} else {
						rightBtn = '<button type="button" class="rdm-copy-btn rdm-copy-btn-right" data-rdm-copy="a-to-b" data-rdm-field="' + escapeHtml(fieldName) + '" title="Copy A’s value to B">▶</button>';
					}
				}
				const midActionsContent = (leftBtn || rightBtn)
					? '<div class="rdm-mid-actions">' + leftBtn + rightBtn + '</div>'
					: '<div class="rdm-mid-actions rdm-mid-actions-empty"></div>';

				// Row-actions gutter on the right. Ignore for resolvable
				// rows (hover-revealed), Restore for suppressed rows
				// (always visible since the user is in "review what I
				// ignored" mode when they see these rows).
				// Suppression (ignore/restore) is a persistent per-pair view
				// preference, meaningless for a throwaway imported row, so
				// it's hidden in incoming/merge mode.
				const rowAction = ctx.incoming
					? ''
					: (isResolvable
						? '<button type="button" class="rdm-ignore-btn" data-rdm-ignore data-rdm-field="' + escapeHtml(fieldName) + '" title="Ignore this field: stop flagging it as a difference for this pair">⊘</button>'
						: (isSuppressed
							? '<button type="button" class="rdm-restore-btn" data-rdm-restore data-rdm-field="' + escapeHtml(fieldName) + '" title="Restore: flag this field as a difference again">↶</button>'
							: ''));
				const rowActionsContent = rowAction
					? '<div class="rdm-row-actions">' + rowAction + '</div>'
					: '<div class="rdm-row-actions rdm-row-actions-empty"></div>';

				// Read-only badge stays alongside the field label since
				// that's where the user expects "what's special about
				// this field" metadata to live.
				let readOnlyBadge = '';
				if (isResolvable && (!aIsWritable || !bIsWritable)) {
					const tag = (!aIsWritable && !bIsWritable)
						? 'read-only'
						: (!aIsWritable ? 'read-only on A' : 'read-only on B');
					readOnlyBadge = '<span class="rdm-readonly-badge" title="Salesforce won’t accept writes to this field on the marked side(s)">' + escapeHtml(tag) + '</span>';
				}

				const searchKey = (label + ' ' + fieldName).toLowerCase();

				return (
					'<div class="rdm-row rdm-row-' + variant + '" data-rdm-row-field="' + escapeHtml(fieldName) + '" data-rdm-search-key="' + escapeHtml(searchKey) + '">' +
						'<div class="rdm-field">' +
							'<div class="rdm-field-text">' +
								'<div class="rdm-field-label">' + escapeHtml(label) + readOnlyBadge + '</div>' +
								'<div class="rdm-field-name"><code>' + escapeHtml(fieldName) + '</code></div>' +
							'</div>' +
						'</div>' +
						'<div class="rdm-value rdm-value-a">' +
							'<div class="rdm-value-inner">' + _renderTypedValue(a, fieldDefForA, ctx.fkResolver) + '</div>' +
						'</div>' +
						midActionsContent +
						'<div class="rdm-value rdm-value-b">' +
							'<div class="rdm-value-inner">' + _renderTypedValue(b, fieldDefForB, ctx.fkResolver) + '</div>' +
						'</div>' +
						rowActionsContent +
					'</div>'
				);
			}

			// Build the inner content (banner + summary + chips + rows)
			// for the given record pair. Extracted from openRecordDiffModal
			// so per-field copy actions can re-render the modal body in
			// place without tearing down the outer overlay (preserves
			// scroll position, Esc handler, etc.). Caller supplies the
			// scrollable container so we can write the new HTML and
			// restore the prior scrollTop.
			function _renderBody(content, recA, recB) {
				const scroll = content ? content.scrollTop : 0;
				// Preserve search query across in-place re-renders so a
				// per-row copy/ignore doesn't blow away the user's
				// typed filter. Read from the existing input before
				// rewriting innerHTML.
				const overlay = content && content.closest('.record-diff-modal');
				const incoming = !!(overlay && overlay.dataset.rdmIncoming === '1');
				const labelB = (overlay && overlay.dataset.rdmLabelB) || 'Imported';
				const existingSearch = overlay && overlay.querySelector('.rdm-search');
				const searchQuery = existingSearch ? existingSearch.value : '';
				const titleA = _titleFor(recA);
				const titleB = _titleFor(recB);
				const subtitleA = (recA.label || recA.objectName) + ' #' + recordOrdinal(recA);
				// In incoming/merge mode B is a synthetic, non-canvas record;
				// it has no ordinal, so use the caller-supplied label.
				const subtitleB = incoming
					? labelB
					: (recB.label || recB.objectName) + ' #' + recordOrdinal(recB);
				// Field-describe cache scoped to this render. Each record
				// might be of a different object (in the cross-object
				// case), so the cache is per-side; same-object pairs
				// just both resolve to the same describe.
				const fkResolver = _buildFkResolver();
				const fieldDefForA = (name) => _fieldDef(recA.objectName, name);
				const fieldDefForB = (name) => _fieldDef(recB.objectName, name);
				const diff = _filterComparableDiff(
					computeRecordDiff(recA, recB),
					fieldDefForA,
					fieldDefForB,
				);

				// Partition the non-shared buckets through the suppression
				// set so the visible "differ / A-only / B-only" counts
				// reflect what the user actually needs to act on. Shared
				// rows can't be suppressed (there's nothing to ignore;
				// they already agree). Pure function inputs stay clean;
				// the suppression layer lives entirely in this module.
				const suppressedSet = _readSuppressedSet(recA.id, recB.id);
				function _partitionBySuppressed(arr) {
					const kept = [];
					const suppressed = [];
					for (const f of arr) {
						if (suppressedSet.has(f)) {
suppressed.push(f);
} else {
kept.push(f);
}
					}
					return { kept, suppressed };
				}
				const _pDiff = _partitionBySuppressed(diff.differing);
				const _pAOnly = _partitionBySuppressed(diff.aOnly);
				const _pBOnly = _partitionBySuppressed(diff.bOnly);
				const differing = _pDiff.kept;
				// In incoming/merge mode the B side is a sparse imported record
				// (only the CSV's mapped columns). Fields the canvas record has
				// but the CSV doesn't include would otherwise show as spurious
				// "A-only" rows (Website, OwnerId, Id, …), not part of this
				// merge. Drop them so the diff shows only what the CSV carries.
				const aOnly = incoming ? [] : _pAOnly.kept;
				const bOnly = _pBOnly.kept;
				// Suppressed bucket = union of suppressed-fields-that-still-
				// have-a-real-diff. A field that's in suppressedSet but no
				// longer appears in any non-shared bucket (because the
				// user copied values across, resolving the difference) is
				// dropped, since its suppression has no current effect, no
				// point listing it.
				const suppressed = _pDiff.suppressed
					.concat(_pAOnly.suppressed)
					.concat(_pBOnly.suppressed);
				const diffCount = differing.length;
				const aOnlyCount = aOnly.length;
				const bOnlyCount = bOnly.length;
				const sharedCount = diff.shared.length;
				const suppressedCount = suppressed.length;
				// Targetability: values can be written to either record
				// unless it's marked pendingDelete (in which case the
				// upload will DELETE it; any edits we'd make here would
				// be silently dropped). Inaccessible (no-access) records
				// also can't be mutated meaningfully. Drafts and loaded
				// records are both fine targets.
				const aIsTargetable = !isRecordPendingDelete(recA) && !recA._inaccessible;
				const bIsTargetable = !isRecordPendingDelete(recB) && !recB._inaccessible;
				// Per-row render context: bundles the field-describe
				// lookup, FK resolver, and record-level targetability
				// flags so _renderRow doesn't need a positional
				// parameter explosion.
				const rowCtx = {
					fieldDefForA,
					fieldDefForB,
					fkResolver,
					aIsTargetable,
					bIsTargetable,
					incoming,
				};

				const crossObjectBanner = !diff.sameObject
					? '<div class="rdm-banner">' +
							'<strong>Different object types.</strong> ' +
							'Field-level diff assumes the same object. ' +
							escapeHtml(diff.objectA || '?') + ' vs ' +
							escapeHtml(diff.objectB || '?') +
							'; comparison shows shared field names but values may not be semantically comparable.' +
						'</div>'
					: '';
				// Pending-delete banner: surfaces the disabled-copy
				// reason at modal scope instead of relying solely on
				// per-button tooltips. Helps the user understand WHY
				// every action button is greyed out.
				const pendingDeleteBanner = (!aIsTargetable || !bIsTargetable)
					? '<div class="rdm-banner rdm-banner-warn">' +
							'<strong>' +
							(!aIsTargetable && !bIsTargetable ? 'Both records are' : (!aIsTargetable ? 'Record A is' : 'Record B is')) +
							' marked for delete.</strong> ' +
							'Copy actions are disabled, since value edits would be discarded when the upload commits the DELETE.' +
						'</div>'
					: '';

				const filterChips =
					'<div class="rdm-filter-chips">' +
						'<button type="button" class="rdm-filter-chip" data-rdm-filter="diffs">' +
							'Only differences ' +
							'<span class="rdm-chip-count">' + (diffCount + aOnlyCount + bOnlyCount) + '</span>' +
						'</button>' +
						'<button type="button" class="rdm-filter-chip" data-rdm-filter="all">' +
							'All ' +
							'<span class="rdm-chip-count">' + (diffCount + aOnlyCount + bOnlyCount + sharedCount + suppressedCount) + '</span>' +
						'</button>' +
						(aOnlyCount + bOnlyCount > 0
							? '<button type="button" class="rdm-filter-chip" data-rdm-filter="gaps">' +
								'Gaps only ' +
								'<span class="rdm-chip-count">' + (aOnlyCount + bOnlyCount) + '</span>' +
								'</button>'
							: '') +
						(suppressedCount > 0
							? '<button type="button" class="rdm-filter-chip" data-rdm-filter="suppressed">' +
								'Ignored ' +
								'<span class="rdm-chip-count">' + suppressedCount + '</span>' +
								'</button>'
							: '') +
					'</div>';

				// Bulk-apply actions. Push every actionable field in one
				// direction at once, saving the user from clicking each
				// row when they've already decided which side is canon.
				// Counts reflect what the bulk action will ACTUALLY
				// touch: differing + same-direction-only, MINUS fields
				// where the target side is read-only (the upload would
				// silently drop those; counting them on the button
				// would mislead the user about how many rows actually
				// resolve). Suppressed fields are also excluded.
				const _isWritableTo = (fieldName, targetRec, getFieldDef) =>
					_isFieldWritable(getFieldDef(fieldName), targetRec);
				const aToBCount =
					differing.filter((f) => _isWritableTo(f, recB, fieldDefForB)).length +
					aOnly.filter((f) => _isWritableTo(f, recB, fieldDefForB)).length;
				const bToACount =
					differing.filter((f) => _isWritableTo(f, recA, fieldDefForA)).length +
					bOnly.filter((f) => _isWritableTo(f, recA, fieldDefForA)).length;
				// In incoming/merge mode only the imported→canvas (B→A)
				// direction is offered, so the bulk bar keys off bToACount.
				const hasAnyBulk = incoming ? (bToACount > 0) : (aToBCount > 0 || bToACount > 0);
				const aToBDisabled = aToBCount === 0 || !bIsTargetable;
				const bToADisabled = bToACount === 0 || !aIsTargetable;
				const aToBTitle = !bIsTargetable
					? 'B is marked for delete, so bulk copy is disabled'
					: (aToBCount === 0
						? 'No fields to copy from A → B'
						: 'Push A’s values into B for ' + aToBCount + ' field' + (aToBCount === 1 ? '' : 's') + ' (overwrites where they differ, fills where B is empty)');
				const bToATitle = !aIsTargetable
					? 'A is marked for delete, so bulk copy is disabled'
					: (bToACount === 0
						? 'No fields to copy from B → A'
						: 'Push B’s values into A for ' + bToACount + ' field' + (bToACount === 1 ? '' : 's') + ' (overwrites where they differ, fills where A is empty)');
				const bulkActions = hasAnyBulk
					? '<div class="rdm-bulk-actions">' +
							'<span class="rdm-bulk-label">' + (incoming ? 'Apply all imported:' : 'Apply all:') + '</span>' +
							(incoming ? '' :
								'<button type="button" class="rdm-bulk-btn" data-rdm-bulk="a-to-b"' + (aToBDisabled ? ' disabled aria-disabled="true"' : '') + ' title="' + escapeHtml(aToBTitle) + '">' +
									'A → B ' +
									'<span class="rdm-bulk-count">' + aToBCount + '</span>' +
								'</button>') +
							'<button type="button" class="rdm-bulk-btn" data-rdm-bulk="b-to-a"' + (bToADisabled ? ' disabled aria-disabled="true"' : '') + ' title="' + escapeHtml(bToATitle) + '">' +
								(incoming ? 'Apply ' : 'B → A ') +
								'<span class="rdm-bulk-count">' + bToACount + '</span>' +
							'</button>' +
						'</div>'
					: '';

				// Row order: actionable first, then noise:
				//   differing → aOnly → bOnly → suppressed → shared.
				// Suppressed sits between the non-shared buckets and
				// shared so the "Ignored" filter chip reveals them as a
				// distinct group rather than mixing into the shared row
				// muted-block.
				const rowsHtml =
					differing.map((f) => _renderRow(f, recA, recB, 'diff', rowCtx)).join('') +
					aOnly.map((f) => _renderRow(f, recA, recB, 'a-only', rowCtx)).join('') +
					bOnly.map((f) => _renderRow(f, recA, recB, 'b-only', rowCtx)).join('') +
					suppressed.map((f) => _renderRow(f, recA, recB, 'suppressed', rowCtx)).join('') +
					diff.shared.map((f) => _renderRow(f, recA, recB, 'shared', rowCtx)).join('');

				const totalRows = diffCount + aOnlyCount + bOnlyCount + suppressedCount + sharedCount;
				const emptyState = totalRows === 0
					? '<p class="rdm-empty-state">No fields with values on either record. There’s nothing to diff yet.</p>'
					: (diffCount + aOnlyCount + bOnlyCount === 0
						? (suppressedCount > 0
							? '<p class="rdm-empty-state">These records agree on every field that isn’t ignored. ' + suppressedCount + ' field' + (suppressedCount === 1 ? '' : 's') + ' marked as intentionally different.</p>'
							: '<p class="rdm-empty-state">These records are identical on every field they share.</p>')
						: '');

				// Per-bucket count breakdown: surfaces "4 differ · 2 A-only
				// · 1 B-only" alongside the table head's Field-column
				// label. Filter chips above already provide totals;
				// this is the per-category breakdown that lets the
				// user judge direction ("most diffs are aOnly, so
				// pushing A → B fills B's gaps").
				const countsBreakdownParts = [];
				countsBreakdownParts.push('<span class="rdm-count rdm-count-diff">' + diffCount + '</span> differ');
				if (aOnlyCount > 0) {
countsBreakdownParts.push('<span class="rdm-count rdm-count-a-only">' + aOnlyCount + '</span> A-only');
}
				if (bOnlyCount > 0) {
countsBreakdownParts.push('<span class="rdm-count rdm-count-b-only">' + bOnlyCount + '</span> B-only');
}
				if (suppressedCount > 0) {
countsBreakdownParts.push('<span class="rdm-count rdm-count-suppressed">' + suppressedCount + '</span> ignored');
}
				const countsBreakdown = countsBreakdownParts.join(' · ');

				// Table head: five-column grid mirroring the data rows
				// so A's label sits directly above A's value column.
				// Two action gutters (mid + right) get empty placeholder
				// cells so the head's grid width matches the rows'
				// exactly; their content is purely structural.
				const tableHead =
					'<div class="rdm-table-head">' +
						'<div class="rdm-th rdm-th-field">' +
							'<div class="rdm-th-title">Field</div>' +
							'<div class="rdm-th-counts">' + countsBreakdown + '</div>' +
						'</div>' +
						'<div class="rdm-th rdm-th-a">' +
							'<div class="rdm-th-title"><span class="rdm-th-prefix">A:</span> ' + escapeHtml(titleA) + '</div>' +
							'<div class="rdm-th-sub">' + escapeHtml(subtitleA) + '</div>' +
						'</div>' +
						'<div class="rdm-th rdm-th-mid"></div>' +
						'<div class="rdm-th rdm-th-b">' +
							'<div class="rdm-th-title"><span class="rdm-th-prefix">B:</span> ' + escapeHtml(titleB) + '</div>' +
							'<div class="rdm-th-sub">' + escapeHtml(subtitleB) + '</div>' +
						'</div>' +
						'<div class="rdm-th rdm-th-row-actions"></div>' +
					'</div>';

				// Order: banners (alarms), then "narrow the view"
				// (filter chips + search), then "act on what's
				// visible" (bulk apply), then the table itself
				// (head row + data rows). The A/B labels sit
				// immediately above the columns they describe so
				// the relationship reads as a table header instead
				// of a floating summary.
				const incomingBanner = incoming
					? '<div class="rdm-banner">' +
							'<strong>This imported row matches a record already on the canvas.</strong> ' +
							'The B column is the imported CSV values; the A column is the record on the canvas. ' +
							'Use ◀ (or &ldquo;Apply all imported&rdquo;) to copy values onto the canvas record, then close. ' +
							'Closing without copying keeps the canvas record unchanged.' +
						'</div>'
					: '';
				content.innerHTML =
					incomingBanner +
					crossObjectBanner +
					pendingDeleteBanner +
					'<div class="rdm-toolbar">' +
						filterChips +
						'<input type="search" class="rdm-search" placeholder="Search fields…" autocomplete="off" spellcheck="false" value="' + escapeHtml(searchQuery || '') + '">' +
					'</div>' +
					bulkActions +
					(emptyState
						? emptyState
						: tableHead + '<div class="rdm-rows">' + rowsHtml + '</div>') +
					'<p class="rdm-search-empty" style="display:none">No fields match your search.</p>';

				// Restore scroll. The previous body had different DOM but
				// the user's mental position (top of list / mid / bottom)
				// is best preserved as raw scrollTop; re-anchoring to a
				// specific row would jump if that row's variant changed.
				if (content) {
content.scrollTop = scroll;
}
			}

			// Apply a per-field copy action. side='a-to-b' means "take
			// A's current value for this field and write it into B."
			// Pure mutation on canvasState; the renderBulkView call
			// repaints the canvas card so its modified-badge and FK-
			// derived edges sync with the new value, and autosave fires
			// as a side effect of the next paint. The diff modal body
			// then re-renders so the row that was just resolved moves
			// from differing → shared (or A-only → shared, etc.).
			function _applyCopy(side, fieldName, recA, recB, content) {
				const source = side === 'a-to-b' ? recA : recB;
				const target = side === 'a-to-b' ? recB : recA;
				if (!source || !target) {
return;
}
				if (isRecordPendingDelete(target) || target._inaccessible) {
return;
}
				if (!target.values) {
target.values = {};
}
				// Snapshot before the overwrite for undo.
				const _snap = pushUndo ? _snapField(target, fieldName) : null;
				// Read at click time (not render time) so a value change
				// between menu render and click can't write a stale value.
				const newValue = source.values ? source.values[fieldName] : undefined;
				_writeField(target, fieldName, newValue == null ? '' : newValue);
				if (pushUndo && _snap) {
					const _tgt = target, _fn = fieldName, _s = _snap;
					const _expectedRevision = Number(target._valuesRevision) || 0;
					const _expectedValue = target.values[fieldName];
					pushUndo('Undo diff copy', () => {
						if (!_fieldUndoIsCurrent(_tgt, _expectedRevision, _fn, _expectedValue)) {
							showBulkToast('Can’t undo the diff copy because the target record was edited afterward.', 'info');
							return;
						}
						_restoreField(_tgt, _fn, _s);
						renderBulkView();
						showBulkToast('Reverted the copied field.');
					});
				}
				try {
 renderBulkView();
} catch (e) {
 console.warn('[diff] renderBulkView after copy failed:', e);
}
				_renderBody(content, recA, recB);
				_wireBodyHandlers(content, recA, recB);
			}

			// Bulk apply: push every actionable field in the given
			// direction in one pass. "Actionable for A→B" = differing
			// rows (overwrite B with A) + A-only rows (fill B from A).
			// B-only rows are SKIPPED for A→B since A has nothing to
			// push (copying empty over B would silently clear B's
			// value, which is too destructive for a one-click bulk
			// action). Symmetric for B→A. Suppressed fields are
			// excluded; the user already declared those intentionally
			// different. Batches the mutation: renderBulkView fires
			// once at the end, not N times, so the canvas re-paints
			// a single time even for big bulk applies.
			function _applyBulkCopy(direction, recA, recB, content) {
				const source = direction === 'a-to-b' ? recA : recB;
				const target = direction === 'a-to-b' ? recB : recA;
				if (!source || !target) {
return;
}
				if (isRecordPendingDelete(target) || target._inaccessible) {
return;
}
				const diff = _filterComparableDiff(
					computeRecordDiff(recA, recB),
					(name) => _fieldDef(recA.objectName, name),
					(name) => _fieldDef(recB.objectName, name),
				);
				const suppressedSet = _readSuppressedSet(recA.id, recB.id);
				// Eligible fields: differing (in either direction) +
				// source-only fields. Suppressed fields are excluded.
				// Read-only-on-target fields are excluded too, since the
				// upload would silently drop them, so applying them
				// here would surface as "I clicked, the row didn't
				// resolve" with no explanation. Per-field button
				// disables already block individual clicks; this
				// guard keeps bulk apply consistent.
				const eligible = [];
				const getTargetFieldDef = (name) => _fieldDef(target.objectName, name);
				for (const f of diff.differing) {
					if (suppressedSet.has(f)) {
continue;
}
					if (!_isFieldWritable(getTargetFieldDef(f), target)) {
continue;
}
					eligible.push(f);
				}
				for (const f of (direction === 'a-to-b' ? diff.aOnly : diff.bOnly)) {
					if (suppressedSet.has(f)) {
continue;
}
					if (!_isFieldWritable(getTargetFieldDef(f), target)) {
continue;
}
					eligible.push(f);
				}
				if (eligible.length === 0) {
return;
}
				if (!target.values) {
target.values = {};
}
				// One snapshot per eligible field → a single undo entry
				// reverts the whole bulk apply.
				const _snaps = pushUndo ? eligible.map((f) => ({ f: f, snap: _snapField(target, f) })) : null;
				for (const f of eligible) {
					const v = source.values ? source.values[f] : undefined;
					_writeField(target, f, v == null ? '' : v);
				}
				if (pushUndo && _snaps) {
					const _tgt = target, _all = _snaps, _n = eligible.length;
					const _expectedRevision = Number(target._valuesRevision) || 0;
					const _expectedValues = new Map(eligible.map((f) => [f, target.values[f]]));
					pushUndo('Undo diff apply-all', () => {
						const stale = (Number(_tgt._valuesRevision) || 0) !== _expectedRevision ||
							eligible.some((f) => !_tgt.values || _tgt.values[f] !== _expectedValues.get(f));
						if (stale) {
							showBulkToast('Can’t undo the diff copy because the target record was edited afterward.', 'info');
							return;
						}
						_all.forEach((e) => _restoreField(_tgt, e.f, e.snap));
						renderBulkView();
						showBulkToast('Reverted ' + _n + ' copied field' + (_n === 1 ? '' : 's') + '.');
					});
				}
				try {
 renderBulkView();
} catch (e) {
 console.warn('[diff] renderBulkView after bulk copy failed:', e);
}
				_renderBody(content, recA, recB);
				_wireBodyHandlers(content, recA, recB);
			}

			// Suppress / restore: no canvas mutation, so no renderBulkView
			// needed. The diff modal is the only consumer of the
			// suppression set today (canvas cards don't change their
			// look based on it), so re-rendering just the modal body
			// is sufficient. Autosave will catch the canvasState change
			// on the next 500ms tick; the render path triggers it
			// indirectly via the canvas-mutation queue elsewhere; here
			// we accept the slight delay (the user's next canvas
			// interaction triggers a render-and-autosave anyway).
			function _applyIgnore(fieldName, recA, recB, content) {
				_suppressField(recA.id, recB.id, fieldName);
				_renderBody(content, recA, recB);
				_wireBodyHandlers(content, recA, recB);
			}
			function _applyRestore(fieldName, recA, recB, content) {
				_unsuppressField(recA.id, recB.id, fieldName);
				_renderBody(content, recA, recB);
				_wireBodyHandlers(content, recA, recB);
			}

			// Bind click handlers on the freshly-rendered body. Re-wired
			// after each in-place re-render because innerHTML wipes
			// listeners. Filter-chip handlers ALSO live here because the
			// chip DOM is part of the body, but the active filter
			// (overlay.dataset.rdmFilter) is the authoritative state, so
			// the chips' is-active class is restored from it.
			// Apply the search query to row visibility. Composes with the
			// CSS variant filter (data-rdm-filter on the modal root):
			// a row is visible when BOTH the variant filter and the
			// search match. The variant filter is CSS-driven; this is
			// JS-driven via a class toggle. Search match is a single
			// case-insensitive includes() against the precomputed
			// data-rdm-search-key (label + API name lowercased at
			// render time).
			function _applySearchFilter(content, query) {
				const q = String(query || '').trim().toLowerCase();
				const rowsContainer = content.querySelector('.rdm-rows');
				const emptyMsg = content.querySelector('.rdm-search-empty');
				let anyVisible = false;
				content.querySelectorAll('.rdm-row').forEach((row) => {
					if (!q) {
						row.classList.remove('rdm-row-hidden-by-search');
						anyVisible = true;
						return;
					}
					const key = row.dataset.rdmSearchKey || '';
					if (key.indexOf(q) !== -1) {
						row.classList.remove('rdm-row-hidden-by-search');
						anyVisible = true;
					} else {
						row.classList.add('rdm-row-hidden-by-search');
					}
				});
				// When the search filters out everything, hide the rows
				// container and surface a small "no match" line so the
				// modal doesn't look broken / empty. The line lives in
				// the body HTML; we just flip display.
				if (emptyMsg && rowsContainer) {
					if (!q || anyVisible) {
						emptyMsg.style.display = 'none';
						rowsContainer.style.display = '';
					} else {
						emptyMsg.style.display = '';
						rowsContainer.style.display = 'none';
					}
				}
			}

			function _wireBodyHandlers(content, recA, recB) {
				const overlay = content.closest('.record-diff-modal');
				if (!overlay) {
return;
}
				const activeFilter = overlay.dataset.rdmFilter || 'diffs';
				content.querySelectorAll('[data-rdm-filter]').forEach((btn) => {
					btn.classList.toggle('is-active', btn.dataset.rdmFilter === activeFilter);
					btn.addEventListener('click', () => {
						overlay.dataset.rdmFilter = btn.dataset.rdmFilter;
						content.querySelectorAll('.rdm-filter-chip').forEach((c) => {
							c.classList.toggle('is-active', c.dataset.rdmFilter === btn.dataset.rdmFilter);
						});
					});
				});
				content.querySelectorAll('[data-rdm-copy]').forEach((btn) => {
					if (btn.disabled) {
return;
}
					btn.addEventListener('click', () => {
						const side = btn.dataset.rdmCopy;
						const fieldName = btn.dataset.rdmField;
						if (!side || !fieldName) {
return;
}
						_applyCopy(side, fieldName, recA, recB, content);
					});
				});
				content.querySelectorAll('[data-rdm-ignore]').forEach((btn) => {
					btn.addEventListener('click', () => {
						const fieldName = btn.dataset.rdmField;
						if (!fieldName) {
return;
}
						_applyIgnore(fieldName, recA, recB, content);
					});
				});
				content.querySelectorAll('[data-rdm-restore]').forEach((btn) => {
					btn.addEventListener('click', () => {
						const fieldName = btn.dataset.rdmField;
						if (!fieldName) {
return;
}
						_applyRestore(fieldName, recA, recB, content);
					});
				});
				content.querySelectorAll('[data-rdm-bulk]').forEach((btn) => {
					if (btn.disabled) {
return;
}
					btn.addEventListener('click', () => {
						const direction = btn.dataset.rdmBulk;
						if (!direction) {
return;
}
						_applyBulkCopy(direction, recA, recB, content);
					});
				});
				// Search input: live filter on input. No debounce since
				// the filter is just per-row class toggles; even with
				// 200+ fields it's well below a frame budget. Also fire
				// once now to apply any preserved query string from a
				// prior in-place re-render.
				const searchInput = content.querySelector('.rdm-search');
				if (searchInput) {
					searchInput.addEventListener('input', () => {
						_applySearchFilter(content, searchInput.value);
					});
					_applySearchFilter(content, searchInput.value);
				}
			}

			// opts (all optional):
			//   incoming: true when recB is a synthetic, non-canvas record
			//               (e.g. a CSV row matched to a card already on the
			//               canvas). Flips the modal to one-way merge mode:
			//               B is labelled, not ordinal'd; only ◀ (apply B→A)
			//               and the "apply all imported" bulk action show;
			//               ignore/restore are hidden.
			//   labelB: subtitle for the B column in incoming mode.
			//   onClose: fired once when the modal closes (lets a caller
			//               sequence multiple merges).
			function openRecordDiffModal(recA, recB, opts) {
				if (!recA || !recB) {
return;
}
				opts = opts || {};
				const incoming = !!opts.incoming;
				document.querySelectorAll('.record-diff-modal').forEach((el) => el.remove());
				const overlay = document.createElement('div');
				overlay.className = 'modal record-diff-modal';
				overlay.dataset.rdmFilter = 'diffs';
				// Stash incoming-mode on the overlay so it survives the
				// in-place body re-renders (same pattern as rdmFilter) without
				// threading an extra arg through every _renderBody call.
				if (incoming) {
					overlay.dataset.rdmIncoming = '1';
					overlay.dataset.rdmLabelB = opts.labelB || 'Imported';
				}
				const heading = incoming ? 'Review imported changes' : 'Diff records';
				overlay.innerHTML =
					'<div class="modal-overlay" data-rdm-close></div>' +
					'<div class="modal-body" style="max-width:960px">' +
						'<div class="modal-header">' +
							'<h3>' + escapeHtml(heading) + '</h3>' +
							'<button class="modal-close" data-rdm-close>&times;</button>' +
						'</div>' +
						'<div class="modal-content rdm-content"></div>' +
					'</div>';
				document.body.appendChild(overlay);
				const content = overlay.querySelector('.rdm-content');

				let closed = false;
				const onEsc = (e) => {
 if (e.key === 'Escape') {
cleanup();
}
};
				const cleanup = () => {
					if (closed) {
return;
}
					closed = true;
					document.removeEventListener('keydown', onEsc, true);
					if (overlay.parentNode) {
overlay.remove();
}
					if (typeof opts.onClose === 'function') {
						try {
 opts.onClose();
} catch (e) {
 console.warn('[diff] onClose failed:', e);
}
					}
				};
				document.addEventListener('keydown', onEsc, true);
				overlay.querySelectorAll('[data-rdm-close]').forEach((el) =>
					el.addEventListener('click', cleanup),
				);

				_renderBody(content, recA, recB);
				_wireBodyHandlers(content, recA, recB);
			}

			return {
				openRecordDiffModal: openRecordDiffModal,
			};
		},
	};
})();
