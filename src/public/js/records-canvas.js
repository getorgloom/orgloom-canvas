// Records canvas (cytoscape): renderBulkCanvasCy.
//
// Sibling to schema-builder's renderCanvas. Renders the bulk-records
// canvas via cytoscape: one node per record (HTML-labelled card),
// edges for FK associations + record-to-record derived FK links,
// drag-rearrange + marquee-select + middle-click pan + space-pan
// wired in via the attach* helpers. Pending records, type-node
// placeholders, "no-access" placeholders, and slot-fillable holes
// all paint through this same render.
//
// The records canvas's cytoscape instance (`_cyInstance`) stays as a
// let in app.js: renderBulkCanvas (the legacy SVG fallback),
// marquee handlers, and the records-canvas-cy creation path also
// touch it. We pass getter/setter wrappers.
//
// Dependencies passed to mount():
//   canvasState: shared canvas state. The render walks
//                              bulkRecords, bulkAssociations,
//                              bulkSelectedIds, _renderedRecIds,
//                              _bulkRenderShiftX/Y, etc.
//   escapeHtml: HTML-escape helper for card labels.
//   showBulkToast: error/info toast.
//   isRecordModified: value-compare predicate for the
//                              modified-badge on existing records.
//   recordOrdinal: builds the "#N" suffix on cards.
//   attachCyEdgeMarkers: SVG-overlay edge markers (crow-foot).
//   attachCyMarqueeSelect: marquee-select gesture attach.
//   attachCyMiddleClickPan: middle-button pan attach.
//   attachCySpacePan: space-bar pan attach.
//   openInsertModal: opens the insert/edit modal for a
//                              clicked card (insert-modal module).
//   showFindObjectPopover: type-node object-picker popover
//                              (find-object-popover module).
//   renderBulkView: outer paint-or-fallback dispatcher.
//   renderCanvas: schema-canvas paint (schema-builder
//                              module). Some events here trigger a
//                              schema repaint.
//   _runAfterSchemaTransition: defers cb until schema flex-basis
//                              transition ends (schema-graph module).
//   _isEmptySlot, _slotAssigneeBadgeHtml, _slotAssignmentCardClass,
//   _slotAssignmentState, _slotPreflightWarn, _slotProgress,
//   _slotProgressClass: per-card slot UI helpers (stay in app.js).
//   _ensureChipProbed, _relInfoForRec, _showStaleRefMenu,
//   _isRecordStale: chip + stale-ref helpers from app.js.
//   fillSlotWithBlank, fillSlotWithLoad: slot resolution from app.js.
//   deleteRecord, onRecordClick, finalizeAssociation, openTypeNode,
//   resolvePendingRecord, resolvePendingRecordToLoad, showCardMoreMenu,
//   showRelatedPopover: card-action handlers from app.js.
//   getGraph: returns .graph-overlay DOM element.
//   getCyInstance: returns _cyInstance (or null).
//   setCyInstance: setter for the same let.
//
// Public API (returned from mount):
//   renderBulkCanvasCy(): full records-canvas paint.
//
// Exposed as window.OrgLoom.recordsCanvas. Load order: before app.js.

(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.recordsCanvas = {
		mount: function mount(deps) {
			const required = [
				'canvasState', 'escapeHtml', 'showBulkToast', 'isRecordModified',
				'recordOrdinal', 'attachCyEdgeMarkers', 'attachCyMarqueeSelect',
				'attachCyMiddleClickPan', 'attachCySpacePan', 'openInsertModal',
				'showFindObjectPopover', 'renderBulkView', 'renderCanvas',
				'_runAfterSchemaTransition', '_isEmptySlot', '_slotAssigneeBadgeHtml',
				'_slotAssignmentCardClass', '_slotAssignmentState', '_slotPreflightWarn',
				'_slotProgress', '_slotProgressClass', '_ensureChipProbed',
				'_relInfoForRec', '_showStaleRefMenu', '_isRecordStale',
				'fillSlotWithBlank', 'fillSlotWithLoad', 'deleteRecord',
				'onRecordClick', 'finalizeAssociation', 'openTypeNode',
				'resolvePendingRecord', 'resolvePendingRecordToLoad',
				'showCardMoreMenu', 'showRelatedPopover', 'getGraph',
				'getCyInstance', 'setCyInstance', 'getObjectFilterHidden',
				'getSelectedDerivedEdge', 'setSelectedDerivedEdge',
				'getCyPendingEdge', 'setCyPendingEdge', 'getCySchemaInstance',
				'getSkipNextCyAutoPan', 'setSkipNextCyAutoPan',
				'unmarkPendingDelete',
			];
			if (!deps) {
throw new Error('records-canvas.mount: missing deps object');
}
			for (const k of required) {
				if (deps[k] === undefined || deps[k] === null) {
					throw new Error('records-canvas.mount: missing dep ' + k);
				}
			}
			const canvasState = deps.canvasState;
			const escapeHtml = deps.escapeHtml;
			const showBulkToast = deps.showBulkToast;
			const isRecordModified = deps.isRecordModified;
			const recordOrdinal = deps.recordOrdinal;
			const attachCyEdgeMarkers = deps.attachCyEdgeMarkers;
			const attachCyMarqueeSelect = deps.attachCyMarqueeSelect;
			const attachCyMiddleClickPan = deps.attachCyMiddleClickPan;
			const attachCySpacePan = deps.attachCySpacePan;
			const openInsertModal = deps.openInsertModal;
			const showFindObjectPopover = deps.showFindObjectPopover;
			const renderBulkView = deps.renderBulkView;
			const renderCanvas = deps.renderCanvas;
			const _runAfterSchemaTransition = deps._runAfterSchemaTransition;
			const _isEmptySlot = deps._isEmptySlot;
			const _slotAssigneeBadgeHtml = deps._slotAssigneeBadgeHtml;
			const _slotAssignmentCardClass = deps._slotAssignmentCardClass;
			const _slotAssignmentState = deps._slotAssignmentState;
			const _slotPreflightWarn = deps._slotPreflightWarn;
			const _slotProgress = deps._slotProgress;
			const _slotProgressClass = deps._slotProgressClass;
			const _ensureChipProbed = deps._ensureChipProbed;
			const _relInfoForRec = deps._relInfoForRec;
			const _showStaleRefMenu = deps._showStaleRefMenu;
			const _isRecordStale = deps._isRecordStale;
			const fillSlotWithBlank = deps.fillSlotWithBlank;
			const fillSlotWithLoad = deps.fillSlotWithLoad;
			const deleteRecord = deps.deleteRecord;
			const onRecordClick = deps.onRecordClick;
			const finalizeAssociation = deps.finalizeAssociation;
			const openTypeNode = deps.openTypeNode;
			const resolvePendingRecord = deps.resolvePendingRecord;
			const resolvePendingRecordToLoad = deps.resolvePendingRecordToLoad;
			const showCardMoreMenu = deps.showCardMoreMenu;
			const showRelatedPopover = deps.showRelatedPopover;
			const getGraph = deps.getGraph;
			const getCyInstance = deps.getCyInstance;
			const setCyInstance = deps.setCyInstance;
			const getObjectFilterHidden = deps.getObjectFilterHidden;
			const getSelectedDerivedEdge = deps.getSelectedDerivedEdge;
			const setSelectedDerivedEdge = deps.setSelectedDerivedEdge;
			const getCyPendingEdge = deps.getCyPendingEdge;
			const setCyPendingEdge = deps.setCyPendingEdge;
			const getCySchemaInstance = deps.getCySchemaInstance;
			const getSkipNextCyAutoPan = deps.getSkipNextCyAutoPan;
			const setSkipNextCyAutoPan = deps.setSkipNextCyAutoPan;
			const unmarkPendingDelete = deps.unmarkPendingDelete;

			function renderBulkCanvasCy() {
				const container = getGraph().querySelector('#bulk-canvas-cy');
				if (!container) {
return;
}
				if (typeof cytoscape !== 'function') {
					container.innerHTML = '<div class="bulk-empty" style="padding:1em">Cytoscape failed to load (check /vendor/cytoscape route).</div>';
					return;
				}
			
				// HTML markup for a record card, shaped like the legacy
				// .record-card so we can reuse the existing CSS verbatim
				// inside cytoscape-node-html-label. Wrapped in
				// .cy-card-shell which neutralizes the legacy card's
				// position:absolute / transform centering; the html-
				// label extension already centers the wrapper on the
				// cy node, so the card itself should lay out as a
				// normal block.
				const _cyCardHtml = (rec) => {
					if (rec.isPending) {
						let pcls = 'record-card record-card-pending';
						if (canvasState.bulkSelectedIds.has(rec.id)) {
pcls += ' selected';
}
						return '<div class="cy-card-shell"><div class="' + pcls + '" data-rec-id="' + rec.id + '">' +
							'<button class="record-delete" data-record-delete title="Remove">\u00D7</button>' +
							'<div class="record-pending-title">New record</div>' +
							'<div class="record-pending-ctas">' +
								'<button class="record-pending-cta record-pending-cta-blank" data-pending-pick-blank>+ Create blank</button>' +
								'<button class="record-pending-cta record-pending-cta-load" data-pending-pick-load title="Search and load an existing record from Salesforce">\u2197 Load existing</button>' +
							'</div>' +
						'</div></div>';
					}
					// "No access" placeholder: a loadedRecord we couldn't
					// fetch. We only know the object type and that it sat
					// here in the saved canvas; no name, no fields. Render a
					// locked card so the gap (and any edges into it) stay
					// visible. Checked before the slot branch so an
					// inaccessible slot-flagged record reads as locked, not
					// fillable (you can't fill fields on a record you can't
					// see).
					if (rec._inaccessible) {
						let ncls = 'record-card record-card-noaccess';
						if (canvasState.bulkSelectedIds.has(rec.id)) {
ncls += ' selected';
}
						const objLabel = rec.label || rec.objectName;
						// A record that was DELETED in Salesforce reconciles
						// as _inaccessible too (SF returns nothing for it),
						// so it would otherwise render as a generic "no
						// access" card and never reach the stale-badge logic
						// further down. Surface the actionable stale variant
						// here -"deleted in SF" + the fix popover (Convert /
						// Remove / Dismiss), so a deleted reference is
						// distinguishable from a permission gap and fixable.
						if (_isRecordStale(rec)) {
							return '<div class="cy-card-shell"><div class="' + ncls + ' record-card-stale" data-rec-id="' + rec.id + '" ' +
								'title="This record was deleted in Salesforce (or your access to it was removed) after it was loaded onto the canvas. Uploading changes to it will fail until you resolve it.">' +
								'<div class="record-noaccess-tag record-stale-badge">deleted in SF</div>' +
								'<div class="record-noaccess-type">' + escapeHtml(objLabel) + '</div>' +
								'<div class="record-noaccess-note">This record is no longer reachable in Salesforce.</div>' +
								'<button type="button" class="record-stale-action" data-stale-menu="' + rec.id + '" title="Choose how to handle this stale reference">fix \u25BE</button>' +
							'</div></div>';
						}
						return '<div class="cy-card-shell"><div class="' + ncls + '" data-rec-id="' + rec.id + '" ' +
							'title="This record is referenced by the canvas but Salesforce didn\u2019t return it for your user.">' +
							'<div class="record-noaccess-tag">\uD83D\uDD12 No access</div>' +
							'<div class="record-noaccess-type">' + escapeHtml(objLabel) + '</div>' +
							'<div class="record-noaccess-note">Referenced record not returned by Salesforce</div>' +
						'</div></div>';
					}
					// Empty slot (recipient view of a slot-marked record):
					// no loadedFromId, no values. The author's label is
					// the only meaningful thing to show; click opens the
					// fill popover (load existing or create draft).
					if (_isEmptySlot(rec)) {
						let scls = 'record-card record-card-slot';
						if (canvasState.bulkSelectedIds.has(rec.id)) {
scls += ' selected';
}
						scls += _slotAssignmentCardClass(rec);
						const slotLabel = rec.slot && rec.slot.label ? rec.slot.label : 'Slot';
						const desc = rec.slot && rec.slot.description ? rec.slot.description : '';
						const objLabel = rec.label || rec.objectName;
						const warnBadge = _slotPreflightWarn(rec)
							? '<span class="record-slot-warn" title="You may not have access to records of this type.">\u26A0</span>'
							: '';
						const assigneeBadge = _slotAssigneeBadgeHtml(rec);
						const isLocked = _slotAssignmentState(rec) === 'other';
						const ctas = isLocked
							? '<div class="record-slot-locked-note">Reserved for ' + escapeHtml(rec.slot.assigneeName || rec.slot.assigneeEmail || 'another teammate') + '; they need to fill this slot.</div>'
							: '<div class="record-slot-ctas">' +
								'<button class="record-slot-cta record-slot-cta-load" data-slot-fill-load title="Search and load an existing record into this slot">\u2197 Load existing</button>' +
								'<button class="record-slot-cta record-slot-cta-blank" data-slot-fill-blank title="Create a blank draft for this slot">+ Create blank</button>' +
							'</div>';
						return '<div class="cy-card-shell"><div class="' + scls + '" data-rec-id="' + rec.id + '">' +
							'<button class="record-delete" data-record-delete title="Remove">\u00D7</button>' +
							'<div class="record-slot-tag">SLOT' + warnBadge +
								(() => {
									const sp = _slotProgress(rec);
									return sp ? '<span class="slot-progress ' + _slotProgressClass(sp) + '" style="margin-left:0.4em">' + sp.filled + '/' + sp.total + '</span>' : '';
								})() +
								(assigneeBadge ? '<span style="margin-left:0.4em">' + assigneeBadge + '</span>' : '') +
							'</div>' +
							'<div class="record-slot-title">' + escapeHtml(slotLabel) + '</div>' +
							'<div class="record-slot-type">' + escapeHtml(objLabel) + '</div>' +
							(desc ? '<div class="record-slot-desc">' + escapeHtml(desc) + '</div>' : '') +
							ctas +
						'</div></div>';
					}
					const isExisting = !!rec.loadedFromId;
					const isModified = isExisting && isRecordModified(rec);
					const isPendingDelete = isExisting && !!rec.pendingDelete;
					let cls = 'record-card';
					// pending-delete is its own card variant. The has-pending-
					// delete class takes precedence over modified / existing
					// so the red strikethrough treatment isn't muddied by an
					// "edited" or "loaded from SF" frame. markPendingDelete
					// snaps values back to loadedValues so isModified should
					// be false here in practice; guarded with the precedence
					// anyway in case a later code path mutates values without
					// going through the mutator.
					if (isPendingDelete) {
cls += ' has-pending-delete';
} else if (isModified) {
cls += ' has-modified';
} else if (isExisting) {
cls += ' has-existing';
} else {
cls += ' has-draft';
}
					if (canvasState.bulkSelectedIds.has(rec.id)) {
cls += ' selected';
}
					if (getCyPendingEdge() && getCyPendingEdge().srcRec && getCyPendingEdge().srcRec.id === rec.id) {
cls += ' connect-source';
}
					if (getCyPendingEdge() && getCyPendingEdge().hoverTargetId === rec.id) {
cls += ' connect-target';
}
					// Refresh affordances: pulse fades after the
					// animation finishes (app.js clears _refreshPulse
					// via setTimeout); deleted-in-SF sticks until the
					// user removes or marks-for-delete the card.
					if (rec._refreshPulse) {
cls += ' record-card-just-refreshed';
}
					if (rec._deletedInSf && !rec._staleAck) {
cls += ' record-card-deleted-in-sf';
}
					cls += _slotAssignmentCardClass(rec);
					const titleText = (() => {
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
							// Fallback chain mirrors the modal title
							// resolution (jsforce sometimes drops the
							// nameField flag on auto-number fields).
							const generic = rec.values.Name || rec.values.CaseNumber || rec.values.OrderNumber || rec.values.WorkOrderNumber || rec.values.Subject || rec.values.Title;
							if (generic) {
return String(generic);
}
						}
						return isExisting ? '(no title)' : '(no name yet)';
					})();
					let badge;
					if (isPendingDelete) {
badge = '<span class="record-pending-delete-badge" title="Staged for SF DELETE on next upload. Click Keep to unmark.">delete on upload</span>';
} else if (isModified) {
badge = '<span class="record-modified-badge" title="Unsaved changes since load: Upload to Salesforce will push them">modified</span>';
} else if (isExisting) {
badge = '<span class="record-existing-badge" title="Loaded from Salesforce id ' + escapeHtml(rec.loadedFromId) + '">existing</span>';
} else {
badge = '<span class="record-draft-badge">draft</span>';
}
					// Stale-ref badge + action button. Appended to the
					// badge row so it sits next to "existing"/"modified".
					// Three actions: Convert (clear loadedFromId so next
					// save inserts fresh), Remove (delete card), Keep
					// (dismiss the badge for this session).
					if (_isRecordStale(rec)) {
						badge += '<span class="record-stale-badge" title="This record was deleted in Salesforce (or your access to it was removed) after it was loaded onto the canvas. Uploading changes to it will fail until you resolve it.">deleted in SF</span>';
						badge += '<button type="button" class="record-stale-action" data-stale-menu="' + rec.id + '" title="Choose how to handle this stale reference">fix ▾</button>';
					}
					// Partial-load marker for compact-mode SOQL imports. The
					// card's `values` only has the SELECT-listed fields; the
					// edit modal hides the rest, the upload path preserves
					// them on the SF record (UPDATE only touches what's in
					// the payload). This badge tells the user at a glance
					// they're not seeing the full record.
					if (Array.isArray(rec._loadedFieldNames)) {
						const n = rec._loadedFieldNames.length;
						badge += '<span class="record-partial-badge" title="Loaded with ' + n + ' field' + (n === 1 ? '' : 's') + ' only; the rest are preserved on Salesforce, not editable here. Re-import via SOQL with Load all fields checked to see them.">partial</span>';
					}
					const slotBadge = (rec.slot && rec.slot.slotId != null)
						? '<span class="record-slot-badge" title="Marked as slot for recipients of this canvas. Label: ' + escapeHtml(rec.slot.label || '') + '">slot</span>'
						: '';
					const slotProgress = _slotProgress(rec);
					const slotProgressBadge = slotProgress
						? '<span class="slot-progress ' + _slotProgressClass(slotProgress) + '" title="' +
							(slotProgress.filled === slotProgress.total
								? 'All slot fields filled.'
								: slotProgress.filled + ' of ' + slotProgress.total + ' slot field' + (slotProgress.total === 1 ? '' : 's') + ' filled.') +
							'">' + slotProgress.filled + '/' + slotProgress.total + '</span>'
						: '';
					const assigneeBadge = _slotAssigneeBadgeHtml(rec);
					badge = badge + slotBadge + slotProgressBadge + assigneeBadge;
					// Lightning link on the title for existing records
					// : same affordance the legacy renderer had at
					// app.js:5083. The link inside the html-label
					// gets `pointer-events: auto` via CSS so it's
					// clickable while the rest of the card stays
					// click-through to cy (drag-to-move + tap-to-
					// select continue to work).
					const sfBase = (window.SF_INSTANCE_URL || '').replace(/\/+$/, '');
					const lightningUrl = (isExisting && rec.loadedFromId && sfBase)
						? sfBase + '/lightning/r/' + encodeURIComponent(rec.objectName) + '/' + encodeURIComponent(rec.loadedFromId) + '/view'
						: null;
					const titleInner = lightningUrl
						? '<a class="record-title-link" href="' + escapeHtml(lightningUrl) + '" target="_blank" rel="noopener" title="Open in Salesforce \u2197">' + escapeHtml(titleText) + '</a>'
						: escapeHtml(titleText);
					// Related-chip: replaces the auto-fan of type-nodes
					// around loaded records. Rendered as a "Find related"
					// affordance on every loaded existing record without
					// any pre-probe; the picker triggers the count
					// fetch on open, so the API cost only lands when a
					// user actually wants to explore relationships.
					// Previous behavior eagerly probed every record's
					// describe-listed children on render (50 cards \u00d7 ~30
					// children = ~1,500 SF COUNT() calls per canvas
					// paint). See related-records.js for the on-click
					// probe-then-open path.
					let chipHtml = '';
					if (isExisting) {
						chipHtml = '<button class="record-related-chip" data-related-pick title="See records related to this one">' +
							'\u2194 Find related' +
						'</button>';
					}
					// `data-rec-id` on the inner .record-card so the
					// post-render measure pass (see _measureCyCardSizes
					// below) can find each card via querySelectorAll
					// and read its offsetWidth / offsetHeight.
					// Vertical ellipsis (U+22EE) reads more reliably as "menu"
				// than the horizontal \u22EF (U+22EF), which often parses as
				// "loading" or "more content elsewhere."
				const moreBtn = '<button class="record-more" data-card-more title="More actions">\u22EE</button>';
				// Inline Keep button on pending-delete cards: single-click
				// reversal of the destructive stage without re-opening
				// the \u22EE menu. Sits in the card's badge row alongside
				// the "delete on upload" pill so the affordance is
				// adjacent to the warning it cancels.
				const keepBtn = isPendingDelete
					? '<button class="record-keep" data-card-keep title="Unmark: cancels the delete">Keep</button>'
					: '';
					return '<div class="cy-card-shell"><div class="' + cls + '" data-rec-id="' + rec.id + '">' +
						badge +
						keepBtn +
						moreBtn +
						'<div class="record-title">' + titleInner + '</div>' +
						'<div class="record-type">' +
							'<span class="record-type-tag">' + escapeHtml(rec.label || rec.objectName) + '</span>' +
							'<span class="record-ordinal">#' + recordOrdinal(rec) + '</span>' +
						'</div>' +
						chipHtml +
					'</div></div>';
				};
			
				// Resolve a card title (kept as a thin helper for the
				// type-node label path). For records the full HTML
				// label above does the title work; this only feeds
				// type-node labels and the cy-internal text fallback.
				const titleFor = (rec) => {
					if (rec.isPending) {
return 'Blank record';
}
					if (rec._inaccessible) {
return 'No access';
}
					if (rec.isTypeNode) {
return rec.label || rec.objectName;
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
						const generic = rec.values.Name || rec.values.Subject || rec.values.Title;
						if (generic) {
return String(generic);
}
					}
					return rec.loadedFromId ? '(no title)' : '(no name yet)';
				};
				// Multi-line label for cy: title on top, then object
				// label + ordinal (mirrors the legacy record-card's
				// stack of record-title + record-type tag). Type-nodes
				// keep a single-line label since they don't carry an
				// ordinal.
				const labelFor = (rec) => {
					if (rec.isPending) {
return 'Blank record';
}
					if (rec._inaccessible) {
return 'No access\n' + (rec.label || rec.objectName);
}
					if (rec.isTypeNode) {
return rec.label || rec.objectName;
}
					const title = titleFor(rec);
					const tag = (rec.label || rec.objectName) + ' #' + recordOrdinal(rec);
					return title + '\n' + tag;
				};
			
				// Build the elements snapshot. Every record (including
				// type-nodes) becomes a node; canvasState.bulkAssociations become
				// edges; type-nodes also get a "host" edge to their
				// originating record so the visual hierarchy is clear
				// even though we don't track those in canvasState.bulkAssociations.
				// Object-type filter: skip type-node placeholders whose
				// object type the user has unchecked. Record cards are
				// never filtered; only the related-object fan circles.
				// Computing the hidden id set up front lets the edge
				// passes below drop host edges whose endpoint nodes
				// won't exist (cy throws otherwise).
				const _hiddenRecIds = new Set();
				if (getObjectFilterHidden() && getObjectFilterHidden().size > 0) {
					canvasState.bulkRecords.forEach((r) => {
						if (r && r.isTypeNode && r.objectName && getObjectFilterHidden().has(r.objectName)) {
							_hiddenRecIds.add(r.id);
						}
					});
				}
			
				const elements = [];
				canvasState.bulkRecords.forEach((r) => {
					if (_hiddenRecIds.has(r.id)) {
return;
}
					if (r._chipLoader) {
return;
}
					let kind;
					if (r.isPending) {
						kind = 'card-pending';
					} else if (r._inaccessible) {
						kind = 'card-noaccess';
					} else if (_isEmptySlot(r)) {
						kind = 'card-slot';
					} else if (r.isTypeNode) {
						if (r.isFreeTypeNode) {
kind = 'tn-free';
} else if (r.direction === 'child') {
kind = 'tn-child';
} else {
kind = 'tn-parent';
}
					} else if (r.loadedFromId) {
						kind = isRecordModified(r) ? 'card-modified' : 'card-existing';
					} else {
						kind = 'card-draft';
					}
					elements.push({
						group: 'nodes',
						// boxW / boxH are placeholders: cy needs
						// concrete numbers to render the node before
						// the html-label even mounts. After the first
						// measure pass these get rewritten with the
						// card's actual offsetWidth / offsetHeight.
						data: { id: 'r' + r.id, recId: r.id, kind, label: labelFor(r), boxW: 220, boxH: 110, pendingDelete: r.pendingDelete ? 1 : 0 },
						position: { x: typeof r.x === 'number' ? r.x : 0, y: typeof r.y === 'number' ? r.y : 0 },
						grabbable: true,
						selectable: !r.isTypeNode || r.isPending,
					});
				});
				canvasState.bulkAssociations.forEach((a) => {
					if (_hiddenRecIds.has(a.fromId) || _hiddenRecIds.has(a.toId)) {
return;
}
					elements.push({
						group: 'edges',
						data: { id: 'a' + a.id, source: 'r' + a.fromId, target: 'r' + a.toId, label: a.fieldName || '', kind: 'fk' },
					});
				});
				// Auto-derive FK edges from field values. A record whose FK
				// field holds the Salesforce id of another record already on
				// the canvas (a loaded record) gets an edge even when there's
				// no explicit association, e.g. the user typed/pasted the id
				// into the edit modal, or it arrived via SOQL import. Without
				// this, such a link is invisible until a later re-query
				// rebuilds associations at load time (the reported bug:
				// "the link doesn't immediately show up"). Match on the
				// 15-char id prefix so 15- and 18-char id forms unify, and
				// dedupe against canvasState.bulkAssociations so a canvas-drawn link
				// (which also stamps the value) doesn't render twice.
				{
					const idKey15 = (i) => (i ? String(i).slice(0, 15) : '');
					const assocKeys = new Set();
					canvasState.bulkAssociations.forEach((a) => assocKeys.add(a.fromId + '->' + a.toId + '::' + (a.fieldName || '')));
					const recByLoadedId = new Map();
					canvasState.bulkRecords.forEach((r) => {
						if (r.isTypeNode || !r.loadedFromId) {
return;
}
						recByLoadedId.set(idKey15(r.loadedFromId), r);
					});
					const derivedKeys = new Set();
					canvasState.bulkRecords.forEach((r) => {
						if (r.isTypeNode || _hiddenRecIds.has(r.id) || !r.values) {
return;
}
						for (const fieldName in r.values) {
							const val = r.values[fieldName];
							if (typeof val !== 'string' || val.length < 15) {
continue;
}
							const tgt = recByLoadedId.get(idKey15(val));
							if (!tgt || tgt.id === r.id || _hiddenRecIds.has(tgt.id)) {
continue;
}
							const k = r.id + '->' + tgt.id + '::' + fieldName;
							if (assocKeys.has(k) || derivedKeys.has(k)) {
continue;
}
							derivedKeys.add(k);
							elements.push({
								group: 'edges',
								data: { id: 'd' + r.id + '_' + fieldName, source: 'r' + r.id, target: 'r' + tgt.id, label: fieldName, kind: 'fk', holderRecId: r.id, fkFieldName: fieldName },
							});
						}
					});
				}
				canvasState.bulkRecords.forEach((r) => {
					if (_hiddenRecIds.has(r.id)) {
return;
}
					if (r._chipLoader) {
return;
}
					if (r.hostRecordId != null && _hiddenRecIds.has(r.hostRecordId)) {
return;
}
					if (r.isTypeNode && r.hostRecordId != null) {
						// Orient the host edge so source = many (FK
						// holder), target = one (referenced): the
						// same convention real FK edges follow. For a
						// child-direction type-node, the would-be
						// child records are the many side, so the
						// type-node anchors source. For parent
						// direction, the host record holds the FK,
						// so it's source. The crow-foot/bar markers
						// in the SVG overlay (redrawCyEdgeMarkers)
						// then land on the right ends without any
						// kind-specific branching.
						const fieldName = r.fieldOnOther || r.fieldOnThis || '';
						const manyIsTypeNode = r.direction === 'child';
						const sourceId = manyIsTypeNode ? 'r' + r.id : 'r' + r.hostRecordId;
						const targetId = manyIsTypeNode ? 'r' + r.hostRecordId : 'r' + r.id;
						elements.push({
							group: 'edges',
							data: { id: 'h' + r.id, source: sourceId, target: targetId, kind: 'host', label: fieldName },
						});
					}
				});
			
				const isFirstRender = !getCyInstance();
				const newRealNodeIds = []; // Tracked across the diff path
				if (!getCyInstance()) {
					setCyInstance(cytoscape({
						container,
						elements,
						style: [
							{
								// Marquee (box-select) styling. Cytoscape's
								// default is a bright opaque blue rectangle;
								// dial it down to a soft accent-orange with
								// 12% fill and a thin border so it reads as
								// a selection hint, not a UI element of its
								// own.
								selector: 'core',
								style: {
									'selection-box-color': '#d68b3c',
									'selection-box-border-color': '#d68b3c',
									'selection-box-border-width': 1,
									'selection-box-opacity': 0.12,
									'active-bg-opacity': 0,
								},
							},
							{
								selector: 'node',
								style: {
									label: 'data(label)',
									'text-valign': 'center', 'text-halign': 'center',
									'text-wrap': 'wrap',
									'font-family': 'system-ui, sans-serif',
									color: '#e8e6e1',
									// Disable cytoscape's default tap/hover
									// overlay (translucent black); selection
									// reads via border-color instead.
									'overlay-opacity': 0,
								},
							},
							{
								// Record cards: cy node is transparent
								// (no fill, no border, no text). The
								// visual is rendered by an HTML overlay
								// via cytoscape-node-html-label. Width
								// and height are read from per-node
								// data (`boxW` / `boxH`) so the hit
								// region matches the actual rendered
								// card; the post-render measure pass
								// (_measureCyCardSizes) writes the real
								// offsetWidth / offsetHeight back to
								// the data after every render.
								selector: 'node[kind ^= "card"]',
								style: {
									shape: 'round-rectangle',
									width: 'data(boxW)',
									height: 'data(boxH)',
									'background-opacity': 0,
									'border-opacity': 0,
									label: '',
								},
							},
							{
								selector: 'node[kind ^= "tn-"]',
								style: {
									shape: 'ellipse',
									width: 80, height: 80,
									'background-color': '#1c2226',
									'border-width': 2,
									'text-max-width': 66,
									'font-size': 10,
									color: '#cfd6df',
								},
							},
							{ selector: 'node[kind = "tn-parent"]', style: { 'border-color': '#7ac96a' } },
							{ selector: 'node[kind = "tn-child"]', style: { 'border-color': '#6fa9d6' } },
							{ selector: 'node[kind = "tn-free"]', style: { 'border-color': '#d68b3c', 'border-style': 'dashed' } },
							{ selector: 'node:selected', style: { 'border-color': '#d68b3c', 'border-width': 3 } },
							// Canvas search jump highlight. Brief amber
							// outline + glow on the target card so the
							// user sees where the viewport landed.
							// canvas-search.js adds the class for ~1.4s
							// then removes it.
							{
								selector: 'node.csr-flash',
								style: {
									'border-color': '#f0c244',
									'border-width': 4,
									'overlay-color': '#f0c244',
									'overlay-opacity': 0.18,
									'overlay-padding': 12,
								},
							},
							{
								selector: 'edge',
								style: {
									width: 1.5,
									'line-color': '#5a6068',
									'curve-style': 'bezier',
									'target-arrow-shape': 'triangle',
									'target-arrow-color': '#5a6068',
									label: 'data(label)',
									'font-size': 10,
									color: '#9aa0a8',
									'text-rotation': 'autorotate',
									'text-background-color': '#15171b',
									'text-background-opacity': 0.85,
									'text-background-padding': 2,
									'overlay-padding': 8,
									'overlay-opacity': 0,
								},
							},
							{
								// FK edges get crow-foot + bar markers
								// drawn by the SVG overlay (see
								// attachCyEdgeMarkers); suppress cy's
								// own arrow so the two don't stack.
								selector: 'edge[kind = "fk"]',
								style: { 'target-arrow-shape': 'none' },
							},
							{
								selector: 'edge[kind = "fk"].edge-picked',
								style: {
									'line-color': '#f0a050',
									width: 2,
									// Keep the base edge label background instead of
									// painting a padded orange badge around the FK name.
									// Accent text + line + cardinality markers provide a
									// clear selection state without a blocky label box.
									color: '#f0a050',
									'font-weight': 600,
								},
							},
							{
								selector: 'edge[kind = "host"]',
								style: {
									'line-color': '#3a3f47',
									'line-style': 'dashed',
									'target-arrow-shape': 'none',
								},
							},
						],
						layout: { name: 'preset' },
						// Disable cytoscape's built-in wheel zoom: we
						// wire an explicit listener below so the zoom
						// behavior is identical to the legacy canvases
						// and immune to whatever cy does internally.
						userZoomingEnabled: false,
						// Custom marquee replaces cytoscape's
						// built-in box select (which uses CONTAINS
						// semantics: every pixel of the node bbox
						// must be inside the rectangle). Our custom
						// implementation in attachCyMarqueeSelect
						// uses INTERSECTS so any visual overlap
						// counts. userPanningEnabled false leaves
						// left-drag free for the marquee gesture;
						// middle-drag handles pan via
						// attachCyMiddleClickPan.
						userPanningEnabled: false,
						boxSelectionEnabled: false,
						// Disable cytoscape's tap-to-select. Without
						// this, cy mutates :selected on mousedown
						// (with selectionType 'single' it deselects
						// peers when the user clicks one of them),
						// which races with the multi-drag grab
						// handler; anchor.selected() reads false /
						// the others-collection comes back empty.
						// With autounselectify, only my code writes
						// :selected (onRecordClick, marquee, render-
						// time sync from canvasState.bulkSelectedIds), so
						// cy:selected and canvasState.bulkSelectedIds stay
						// aligned all the time.
						autounselectify: true,
					}));

					attachCyMiddleClickPan(getCyInstance(), container);
					attachCySpacePan(getCyInstance(), container);
					attachCyEdgeMarkers(getCyInstance(), container);
			
					// Wheel zoom for the cy records canvas. Cursor-anchored
					// so the world point under the pointer stays fixed
					// across the zoom step.
					//
					// Listener lives at DOCUMENT level in capture phase,
					// gated on cursor-inside-container, rather than on
					// the container itself. Two reasons:
					//
					//   1. Browser intercept ordering. Chrome decides
					//      whether to commit to the default Ctrl+wheel
					//      page-zoom based on the FIRST listener it sees
					//      in capture phase. Cytoscape registers its
					//      own (passive) listeners on the inner <canvas>
					//      element; if those fire before our non-passive
					//      preventDefault, Chrome treats the event as
					//      non-cancellable and our preventDefault is
					//      silently ignored. Document-level capture
					//      guarantees we run before any container-or-
					//      deeper listener, so preventDefault always
					//      lands.
					//
					//   2. Unconditional preventDefault on Ctrl+wheel.
					//      A pinch-zoom gesture stream can fire wheel
					//      events with deltaY = 0 mid-gesture. The plain
					//      "skip horizontal swipes" early-return would
					//      let those through to the browser default,
					//      mixing canvas zoom with browser zoom on the
					//      same gesture. When ctrlKey is held we always
					//      preventDefault, even on deltaY-zero ticks, so
					//      the browser never gets a turn.
					document.addEventListener('wheel', (ev) => {
						if (!getCyInstance()) {
return;
}
						// Bail when the wheel originated inside a modal,
						// popover, or any other overlay rather than the
						// cy container itself. Pure geometry check
						// (clientX/Y vs container rect) misses this
						// because modals are positioned ON TOP of the
						// canvas; their coordinates land inside the
						// rect and the handler used to preventDefault
						// the modal's own scroll. The DOM-tree check is
						// the correct boundary.
						if (!container.contains(ev.target)) {
return;
}
						const rect = container.getBoundingClientRect();
						if (ev.clientX < rect.left || ev.clientX > rect.right
								|| ev.clientY < rect.top || ev.clientY > rect.bottom) {
return;
}
						// Ctrl+wheel: always preventDefault to fully kill
						// browser zoom for the duration of the gesture,
						// even on deltaY = 0 ticks that wouldn't change
						// our zoom level.
						if (ev.ctrlKey) {
ev.preventDefault();
}
						// Horizontal-only swipes have deltaY = 0. Without
						// ctrlKey, fall through so native pan / scroll
						// can apply (no spurious zoom). With ctrlKey we
						// already preventDefaulted above; just bail on the
						// canvas-zoom side since there's no vertical input.
						if (ev.deltaY === 0) {
return;
}
						if (!ev.ctrlKey) {
ev.preventDefault();
}
						const rx = ev.clientX - rect.left;
						const ry = ev.clientY - rect.top;
						const step = ev.deltaY > 0 ? 0.9 : 1.1;
						const cur = getCyInstance().zoom();
						const next = Math.max(0.2, Math.min(4, cur * step));
						if (next === cur) {
return;
}
						getCyInstance().zoom({ level: next, renderedPosition: { x: rx, y: ry } });
					}, { passive: false, capture: true });
			
					// tap on a type-node → existing openTypeNode (which
					// already handles free / parent / child variants).
					// tap on a record card → select via onRecordClick so
					// the existing keyboard / toolbar actions still see
					// the selection in canvasState.bulkSelectedIds.
					// dbltap on a record card → openInsertModal, which
					// is what the legacy renderer's double-click does.
					getCyInstance().on('tap', 'node', (evt) => {
						const recId = evt.target.data('recId');
						const rec = canvasState.bulkRecords.find((r) => r.id === recId);
						if (!rec) {
return;
}
						if (_isEmptySlot(rec)) {
							const oe = evt.originalEvent;
							const cardEl = container.querySelector('.record-card[data-rec-id="' + rec.id + '"]');
							const _hits = (el) => {
								if (!el || !oe) {
return false;
}
								const r = el.getBoundingClientRect();
								return oe.clientX >= r.left && oe.clientX <= r.right &&
									oe.clientY >= r.top && oe.clientY <= r.bottom;
							};
							const delBtn = cardEl && cardEl.querySelector('[data-record-delete]');
							if (_hits(delBtn)) {
 deleteRecord(rec.id); return; 
}
							const loadBtn = cardEl && cardEl.querySelector('[data-slot-fill-load]');
							if (_hits(loadBtn)) {
 fillSlotWithLoad(rec, loadBtn); return; 
}
							const blankBtn = cardEl && cardEl.querySelector('[data-slot-fill-blank]');
							if (_hits(blankBtn)) {
 fillSlotWithBlank(rec); return; 
}
							const additive = !!(oe && (oe.metaKey || oe.ctrlKey || oe.shiftKey));
							onRecordClick(rec, { additive });
							return;
						}
						if (rec.isPending) {
							// Cytoscape's tap fires off canvas-level hit
							// testing, independent of any DOM pointer-events
							// we set on the html-label children. So instead
							// of relying on the buttons to capture the
							// click, we read the original click coords here
							// and check whether they landed inside one of
							// the CTA button rects. Falls back to a plain
							// select if the click was elsewhere on the
							// placeholder body.
							const oe = evt.originalEvent;
							const cardEl = container.querySelector('.record-card-pending[data-rec-id="' + rec.id + '"]');
							const hitInRect = (el) => {
								if (!el || !oe) {
return false;
}
								const r = el.getBoundingClientRect();
								return oe.clientX >= r.left && oe.clientX <= r.right &&
									oe.clientY >= r.top && oe.clientY <= r.bottom;
							};
							const blankBtn = cardEl && cardEl.querySelector('[data-pending-pick-blank]');
							const loadBtn = cardEl && cardEl.querySelector('[data-pending-pick-load]');
							const deleteBtn = cardEl && cardEl.querySelector('[data-record-delete]');
							if (hitInRect(deleteBtn)) {
								deleteRecord(rec.id);
								return;
							}
							if (hitInRect(blankBtn)) {
								showFindObjectPopover(blankBtn, {
									header: 'Create blank record',
									sub: 'Pick the object type for this blank draft.',
									isAdded: () => false,
									onPick: (name) => resolvePendingRecord(rec.id, name),
								});
								return;
							}
							if (hitInRect(loadBtn)) {
								showFindObjectPopover(loadBtn, {
									header: 'Load existing record',
									sub: 'Pick the object type, then search by name or paste a record ID.',
									isAdded: () => false,
									onPick: (name) => resolvePendingRecordToLoad(rec.id, name),
								});
								return;
							}
							const additive = !!(oe && (oe.metaKey || oe.ctrlKey || oe.shiftKey));
							onRecordClick(rec, { additive });
							return;
						}
						if (rec.isTypeNode) {
							if (!rec._loading) {
openTypeNode(rec);
}
							return;
						}
						// Real-record cards (loaded OR draft): detect a tap
						// over the More button and the Related chip, route
						// each accordingly. Canvas-hit-test trick same as
						// pending CTAs: cy's tap fires regardless of DOM
						// pointer-events, so we read each affordance's DOM
						// rect and match against the click coords.
						//
						// More button: any non-pending real card. Empty
						// drafts need this so the user can convert to
						// slot or use other card-level actions.
						// Related chip: only loaded records (chip itself
						// is only rendered for loaded records).
						{
							const oe = evt.originalEvent;
							const cardEl = container.querySelector('.record-card[data-rec-id="' + rec.id + '"]');
							const _hitsRect = (el) => {
								if (!el || !oe) {
return false;
}
								const r = el.getBoundingClientRect();
								return oe.clientX >= r.left && oe.clientX <= r.right &&
									oe.clientY >= r.top && oe.clientY <= r.bottom;
							};
							const moreBtn = cardEl && cardEl.querySelector('[data-card-more]');
							if (_hitsRect(moreBtn)) {
								showCardMoreMenu(moreBtn, rec);
								return;
							}
							// Stale-ref fix menu. Renders next to the
							// "deleted in SF" badge when _isRecordStale
							// returns true. Click opens a small popover
							// with three actions; same hit-rect pattern
							// as the other card-level buttons.
							const staleBtn = cardEl && cardEl.querySelector('[data-stale-menu]');
							if (_hitsRect(staleBtn)) {
								_showStaleRefMenu(staleBtn, rec);
								return;
							}
							// Related chip: also routed via cy tap in case
							// it manages to fire, but the chip's pointer-
							// events: auto means cy rarely (never?) gets a
							// tap on chip clicks; the container-level click
							// delegation below is the actual working path.
							if (rec.loadedFromId) {
								const chip = cardEl && cardEl.querySelector('[data-related-pick]');
								if (_hitsRect(chip)) {
									showRelatedPopover(chip, rec);
									return;
								}
							}
						}
						const oe = evt.originalEvent || {};
						const additive = !!(oe.metaKey || oe.ctrlKey || oe.shiftKey);
						onRecordClick(rec, { additive });
					});
					getCyInstance().on('dbltap', 'node', (evt) => {
						const recId = evt.target.data('recId');
						const rec = canvasState.bulkRecords.find((r) => r.id === recId);
						if (!rec || rec.isTypeNode || rec.isPending) {
return;
}
						if (rec._inaccessible) {
							showBulkToast('This record isn’t available to your Salesforce user, so there’s nothing to open.', 'info');
							return;
						}
						if (_slotAssignmentState(rec) === 'other') {
							const who = rec.slot.assigneeName || rec.slot.assigneeEmail || 'another teammate';
							showBulkToast('Reserved for ' + who + ': only they can fill this slot.', 'info');
							return;
						}
						openInsertModal(rec.objectName, { record: rec });
					});
					// Edge tap → select the underlying FK association so
					// Delete/Backspace can unlink it. Only real fk edges
					// are user-deletable; host edges (record ↔ type-node
					// placeholder) come and go on their own.
					getCyInstance().on('tap', 'edge', (evt) => {
						const edge = evt.target;
						if (edge.data('kind') !== 'fk') {
return;
}
						const eid = edge.id();
						if (!eid) {
return;
}
						canvasState.bulkSelectedIds.clear();
						if (eid[0] === 'a') {
							const assocId = parseInt(eid.slice(1), 10);
							if (!Number.isFinite(assocId)) {
return;
}
							canvasState.bulkSelectedEdgeId = assocId;
							setSelectedDerivedEdge(null);
							renderBulkView();
							const a = canvasState.bulkAssociations.find((x) => x.id === assocId);
							const fieldLabel = a && a.fieldName ? a.fieldName : 'connection';
							showBulkToast('Selected ' + fieldLabel + ': press Delete to unlink.');
						} else if (eid[0] === 'd') {
							// Derived edge: drawn from a record's FK value
							// pointing at an on-canvas record, with no explicit
							// association. The holder rec + field ride on the
							// edge data, so Delete can clear the value.
							const recId = edge.data('holderRecId');
							const fieldName = edge.data('fkFieldName');
							if (recId == null || !fieldName) {
return;
}
							canvasState.bulkSelectedEdgeId = null;
							setSelectedDerivedEdge({ recId: recId, fieldName: fieldName });
							renderBulkView();
							showBulkToast('Selected ' + fieldName + ': press Delete to unlink.');
						}
					});
					getCyInstance().on('tap', (evt) => {
						if (evt.target === getCyInstance()) {
							canvasState.bulkSelectedIds.clear();
							canvasState.bulkSelectedEdgeId = null;
							setSelectedDerivedEdge(null);
							renderBulkView();
						}
					});
					// Sync drag-to-move back to rec.x / rec.y so the
					// legacy renderer (and seed math) sees the new
					// positions if the user toggles ?cy=1 off.
					// Custom multi-node drag. Cytoscape's native
					// "drag selected together" only kicks in when
					// boxSelectionEnabled is true; we turned it off
					// to host the custom intersect-based marquee.
					// Implemented explicitly here:
					//   * grab on a :selected card snapshots every
					//     :selected card's start position relative
					//     to the grabbed node.
					//   * drag on the grabbed (anchor) node computes
					//     a delta from its start, applies it to
					//     every other in the group via position().
					//   * free on the anchor syncs every group
					//     member's rec.x / rec.y back to canvasState.bulkRecords
					//     so the next render's diff doesn't roll
					//     them back to their pre-drag positions.
					let _cyDragGroup = null;
					getCyInstance().on('grab', 'node', (evt) => {
						const anchor = evt.target;
						const akind = anchor.data('kind') || '';
						const arecId = anchor.data('recId');
						// Read canvasState.bulkSelectedIds (our source of truth)
						// rather than node.selected(); cy's :selected
						// can lag the app's set during a tap-then-drag,
						// causing the grabbed node to drag alone.
						if (akind.indexOf('card') !== 0 || arecId == null || !canvasState.bulkSelectedIds.has(arecId)) {
							_cyDragGroup = null;
							return;
						}
						const others = [];
						getCyInstance().nodes().forEach((n) => {
							if (n.id() === anchor.id()) {
return;
}
							const kind = n.data('kind') || '';
							if (kind.indexOf('card') !== 0) {
return;
}
							const recId = n.data('recId');
							if (recId == null || !canvasState.bulkSelectedIds.has(recId)) {
return;
}
							const p = n.position();
							others.push({ node: n, start: { x: p.x, y: p.y } });
						});
						if (others.length === 0) {
							_cyDragGroup = null;
							return;
						}
						const ap = anchor.position();
						_cyDragGroup = {
							anchorId: anchor.id(),
							anchorStart: { x: ap.x, y: ap.y },
							others,
						};
						// Mark group members so the diff loop knows not
						// to reset their positions mid-drag; they're
						// being manually positioned by the drag handler
						// below and cy doesn't flag them as :grabbed
						// (only the anchor is). Cleared on 'free'.
						others.forEach((o) => {
 try {
 o.node.scratch('_dragFollower', true); 
} catch (_) {} 
});
					});
					getCyInstance().on('drag', 'node', (evt) => {
						if (!_cyDragGroup) {
return;
}
						if (evt.target.id() !== _cyDragGroup.anchorId) {
return;
}
						const cur = evt.target.position();
						const dx = cur.x - _cyDragGroup.anchorStart.x;
						const dy = cur.y - _cyDragGroup.anchorStart.y;
						_cyDragGroup.others.forEach((o) => {
							o.node.position({ x: o.start.x + dx, y: o.start.y + dy });
						});
					});
					// Sync positions back to rec.x / rec.y on free.
					// 'free' fires on every node that cytoscape
					// natively grabbed, plus we manually sync each
					// custom-drag-group member when the anchor is
					// freed (those members weren't grabbed by cy
					// : we positioned them via .position()).
					getCyInstance().on('free', 'node', (evt) => {
						const recId = evt.target.data('recId');
						const rec = canvasState.bulkRecords.find((r) => r.id === recId);
						if (rec) {
							const p = evt.target.position();
							rec.x = p.x;
							rec.y = p.y;
						}
						if (_cyDragGroup && evt.target.id() === _cyDragGroup.anchorId) {
							_cyDragGroup.others.forEach((o) => {
								const oid = o.node.data('recId');
								const orec = canvasState.bulkRecords.find((r) => r.id === oid);
								if (!orec) {
return;
}
								const op = o.node.position();
								orec.x = op.x;
								orec.y = op.y;
								try {
 o.node.scratch('_dragFollower', false); 
} catch (_) {}
							});
							_cyDragGroup = null;
						}
					});
			
					// Custom marquee selection. Replaces cytoscape's
					// built-in box select so we can use INTERSECTS
					// (any bbox overlap = selected) instead of cy's
					// CONTAINS (whole bbox must be inside).
					attachCyMarqueeSelect(getCyInstance(), container, (hits, additive) => {
						const next = additive ? new Set(canvasState.bulkSelectedIds) : new Set();
						hits.forEach((node) => {
							const recId = node.data('recId');
							if (recId != null) {
next.add(recId);
}
						});
						canvasState.bulkSelectedIds = next;
						canvasState.bulkSelectedEdgeId = null;
						renderBulkView();
					});
			
					// CTA-button intercept. Card affordances (delete ×, More
					// kebab, pending Create-blank / Load-existing, slot
					// fill CTAs, etc.) are rendered into the html-label
					// overlay with `pointer-events: auto`, but cytoscape
					// listens for mousedown at the container level and
					// runs its grab-the-node logic BEFORE our cy `mousedown`
					// handler fires, so calling ungrabify() in that
					// handler is too late and the card jumps with the
					// cursor between mousedown and mouseup. Fix: a
					// capture-phase DOM mousedown on the container that
					// stops propagation when target is a CTA. Cy's
					// listener never runs → no grab → no drag. We then
					// dispatch the click directly via a delegated `click`
					// listener below, since cy's tap event won't fire
					// either when mousedown is killed.
					if (!container._ctaInterceptInstalled) {
						container._ctaInterceptInstalled = true;
						const _CTA_SELECTOR =
							'[data-record-delete], [data-card-more], [data-card-keep], ' +
							'[data-related-pick], [data-pending-pick-blank], [data-pending-pick-load], ' +
							'[data-slot-fill-load], [data-slot-fill-blank], [data-stale-menu]';
						container.addEventListener('mousedown', (ev) => {
							if (ev.target && ev.target.closest && ev.target.closest(_CTA_SELECTOR)) {
								// Stop cy from seeing this mousedown so it
								// doesn't start a grab. Don't preventDefault:
								// we still want focus + the synthetic click
								// that follows mouseup to fire normally.
								ev.stopPropagation();
							}
						}, true /* capture */);
						container.addEventListener('click', (ev) => {
							const t = ev.target;
							if (!t || !t.closest) {
return;
}
							const cta = t.closest(_CTA_SELECTOR);
							if (!cta) {
return;
}
							const cardEl = cta.closest('[data-rec-id]');
							const recId = cardEl && Number(cardEl.getAttribute('data-rec-id'));
							if (!Number.isFinite(recId)) {
return;
}
							const rec = canvasState.bulkRecords.find((r) => r.id === recId);
							if (!rec) {
return;
}
							ev.stopPropagation();
							if (cta.matches('[data-record-delete]')) {
								deleteRecord(rec.id);
								return;
							}
							if (cta.matches('[data-card-more]')) {
								showCardMoreMenu(cta, rec);
								return;
							}
							if (cta.matches('[data-card-keep]')) {
								unmarkPendingDelete(rec.id);
								return;
							}
							if (cta.matches('[data-pending-pick-blank]')) {
								showFindObjectPopover(cta, {
									header: 'Create blank record',
									sub: 'Pick the object type for this blank draft.',
									isAdded: () => false,
									onPick: (name) => resolvePendingRecord(rec.id, name),
								});
								return;
							}
							if (cta.matches('[data-pending-pick-load]')) {
								showFindObjectPopover(cta, {
									header: 'Load existing record',
									sub: 'Pick the object type, then search by name or paste a record ID.',
									isAdded: () => false,
									onPick: (name) => resolvePendingRecordToLoad(rec.id, name),
								});
								return;
							}
							if (cta.matches('[data-slot-fill-blank]')) {
								fillSlotWithBlank(rec);
								return;
							}
							if (cta.matches('[data-slot-fill-load]')) {
								fillSlotWithLoad(rec, cta);
								return;
							}
							// Related-records chip: pulls related records onto
							// the canvas. Used to be routed via cy's tap handler
							// (see the chip block in the tap dispatcher above),
							// but the chip's `pointer-events: auto` captures the
							// mouseup before cy can detect a tap on the node, so
							// the tap path never fired. Container-level click
							// delegation is the actual working path: the DOM
							// click event bubbles up from the chip to the
							// container regardless of cy's hit-test.
							if (cta.matches('[data-related-pick]')) {
								if (rec.loadedFromId) {
showRelatedPopover(cta, rec);
}
								return;
							}
							// data-stale-menu also keeps its tap-handler path:
							// the badge it sits next to has its own positioning
							// that makes the cy tap reliable for that case.
						});

						// Record-card double-click → openInsertModal. Lives
						// here (not in cy's dbltap handler) because cy's
						// node hit-test is anchored to the cy node's
						// rendered position, which doesn't exactly match
						// the html-label card's DOM bounds; bottom half
						// of the card visibly overlaps "empty cy canvas"
						// from cy's POV, so cy-side dbltap silently misses
						// a chunk of legitimate clicks. The DOM delegation
						// below uses elementsFromPoint to walk the
						// z-stack (the card has pointer-events: none, so
						// elementFromPoint returns the cy canvas; we need
						// elementsFromPoint to see every layer) and find
						// whichever record-card the click visually
						// landed on.
						container.addEventListener('dblclick', (ev) => {
							const stack = document.elementsFromPoint(ev.clientX, ev.clientY);
							let cardEl = null;
							for (const el of stack) {
								if (el && el.matches && el.matches('[data-rec-id]')) {
 cardEl = el; break; 
}
								const a = el && el.closest && el.closest('[data-rec-id]');
								if (a) {
 cardEl = a; break; 
}
							}
							if (!cardEl) {
return;
}
							const recId = Number(cardEl.getAttribute('data-rec-id'));
							if (!Number.isFinite(recId)) {
return;
}
							const rec = canvasState.bulkRecords.find((r) => r.id === recId);
							if (!rec || rec.isTypeNode || rec.isPending) {
return;
}
							if (rec._inaccessible) {
								showBulkToast('This record isn’t available to your Salesforce user, so there’s nothing to open.', 'info');
								return;
							}
							if (_slotAssignmentState(rec) === 'other') {
								const who = rec.slot.assigneeName || rec.slot.assigneeEmail || 'another teammate';
								showBulkToast('Reserved for ' + who + ': only they can fill this slot.', 'info');
								return;
							}
							openInsertModal(rec.objectName, { record: rec });
						});
					}

					// HTML labels for record cards. Each card gets a
					// real <div class="record-card has-XYZ"> floating
					// over its (transparent) cy node, so the legacy
					// CSS: draft / existing / modified pills, the
					// record-title link, the record-type tag, the left
					// border-stripe; renders verbatim. Other node
					// kinds (type-nodes) keep cy's text label.
					if (typeof getCyInstance().nodeHtmlLabel === 'function') {
						getCyInstance().nodeHtmlLabel([
							{
								query: 'node[kind ^= "card"]',
								valign: 'center',
								halign: 'center',
								valignBox: 'center',
								halignBox: 'center',
								tpl: function (data) {
									const rec = canvasState.bulkRecords.find((r) => r.id === data.recId);
									return rec ? _cyCardHtml(rec) : '';
								},
							},
							{
								// Loading spinner overlay for type-nodes
								// while openTypeNode is fetching records
								// via /by-ref. The cy node's circle and
								// text label render underneath; this
								// overlay only appears when _loading
								// flips true and disappears when the
								// fetch resolves.
								query: 'node[kind ^= "tn-"]',
								valign: 'center',
								halign: 'center',
								valignBox: 'center',
								halignBox: 'center',
								tpl: function (data) {
									const rec = canvasState.bulkRecords.find((r) => r.id === data.recId);
									if (!rec || !rec._loading) {
return '';
}
									const dir = rec.isFreeTypeNode
										? 'tn-free'
										: (rec.direction === 'parent' ? 'tn-parent' : 'tn-child');
									return '<div class="cy-tn-loading ' + dir + '"><span class="cy-tn-spinner"></span></div>';
								},
							},
						]);
					}
			
					// Custom drag-to-link gesture. Mousedown within
					// CARD_EDGE_THRESHOLD pixels of a card's perimeter
					// starts a pending FK edge: same outcome as the
					// legacy startPendingEdge / finalizeAssociation
					// flow. Mousedown anywhere inside the card body
					// (further than the threshold from any edge) falls
					// through to cy's normal grab-to-move.
					// Why not edgehandles: its drag handle renders on
					// the cy canvas and gets obscured by the html-
					// label overlay covering each card. A direct cy
					// event listener that reads pointer position is
					// reliable regardless of overlay z-order.
					// 10 px. Was 20, but on a typical 190×61 record card
					// a 20 px band consumed ~70% of the click area:
					// every interior click felt like the start of a
					// drag. 10 px keeps the band findable with the
					// halo + cursor hint while ceding the card body
					// back to drag-to-move and double-click-to-edit.
					const CARD_EDGE_THRESHOLD = 10;
					// Outset for the FK link band: how far OUTSIDE
					// the card/modal perimeter still counts as "on
					// the edge" for halo + drag initiation. Lets the
					// user mousedown slightly off the card (e.g.,
					// just to the right of the border in empty
					// canvas space) and still start an FK gesture
					// instead of having to land precisely on the
					// border. Distance is measured to the closest
					// point on the rect.
					const CARD_EDGE_OUTSET = 15;
					const _setConnectClass = (on) => {
						if (container) {
container.classList.toggle('cy-connecting', !!on);
}
					};
					const _ns = 'http://www.w3.org/2000/svg';
					const _updatePendingLine = () => {
						const pe = getCyPendingEdge();
						if (!pe || !pe.line) {
return;
}
						// Anchor stored as an offset from the source node's
						// rendered center so the line stays attached to the
						// original click point on the card's edge as the
						// user pans/zooms. Falls back to node center for
						// any legacy callers that didn't capture an offset
						// (shouldn't happen post-fix; defensive).
						const rp = pe.srcCyNode.renderedPosition();
						const ox = typeof pe.anchorOffsetX === 'number' ? pe.anchorOffsetX : 0;
						const oy = typeof pe.anchorOffsetY === 'number' ? pe.anchorOffsetY : 0;
						pe.line.setAttribute('x1', rp.x + ox);
						pe.line.setAttribute('y1', rp.y + oy);
					};
					// All hover/initiation detection runs at the DOM
					// level via elementsFromPoint. Cy's node hit-test is
					// anchored to the cy node's renderedBoundingBox,
					// which doesn't reliably match the visible html-
					// label card's DOM rect (same root cause as the
					// dblclick handler above). Walking the DOM z-stack
					// finds the actual card the user is pointing at.
					const _CTA_EDGE_SKIP_SEL =
						'[data-record-delete], [data-card-more], ' +
						'[data-related-pick], [data-pending-pick-blank], [data-pending-pick-load], ' +
						'[data-slot-fill-load], [data-slot-fill-blank], [data-stale-menu]';
					// Finds whichever edge-link target is at (x, y):
					//   - a regular .record-card via [data-rec-id], OR
					//   - the inline edit modal's body via
					//     .modal.is-inline (which has replaced a card
					//     visually and acts as the cy node).
					// Iterates rects directly rather than calling
					// elementsFromPoint because the cards use
					// pointer-events: none (so cy can still receive
					// pan/marquee through them), and elementsFromPoint
					// respects pointer-events, so it never returns
					// the card element. Card count on a canvas is small;
					// per-move iteration is cheap.
					const _findEdgeTargetAt = (x, y) => {
						// Card edge takes priority over modal edge in
						// case the user is hovering an open modal that
						// happens to overlap another card. Match
						// targets up to CARD_EDGE_OUTSET px OUTSIDE
						// the rect too so users don't have to land
						// precisely on the border. Restrict matches
						// to cursors actually over the records canvas
						// container: without this, hovering the
						// schema sidebar (sibling element in the split
						// layout) still hits a card's rect if the
						// card's overflow-clipped bbox extends under
						// the schema area, lighting up halos on
						// records the user can't even see.
						const containerRect = container.getBoundingClientRect();
						const inContainer =
							x >= containerRect.left && x <= containerRect.right &&
							y >= containerRect.top && y <= containerRect.bottom;
						if (inContainer) {
							// Walk in REVERSE DOM order so overlapping cards
							// resolve to the visually-topmost one. cytoscape-
							// node-html-label appends labels in cy's
							// render order, so the last card in DOM is the
							// one drawn on top. Forward iteration would
							// match an underneath card whose rect happens
							// to contain the cursor, lighting up the wrong
							// card's edge-link halo and starting an FK
							// drag from a record the user isn't pointing
							// at. NodeList isn't directly reverse-iterable;
							// index the queryAll result and walk it
							// backward: querySelectorAll over a small set
							// (the canvas isn't holding hundreds of cards
							// at once) is cheap.
							const cards = container.querySelectorAll('.record-card[data-rec-id]');
							for (let i = cards.length - 1; i >= 0; i--) {
								const el = cards[i];
								const r = el.getBoundingClientRect();
								if (r.width === 0 || r.height === 0) {
continue;
}
								if (x < r.left - CARD_EDGE_OUTSET || x > r.right + CARD_EDGE_OUTSET) {
continue;
}
								if (y < r.top - CARD_EDGE_OUTSET || y > r.bottom + CARD_EDGE_OUTSET) {
continue;
}
								return { kind: 'card', el, rect: r, recId: Number(el.getAttribute('data-rec-id')) };
							}
						}
						const modalBody = document.querySelector('.modal.is-inline .modal-body[data-inline-rec-id]');
						if (modalBody) {
							const r = modalBody.getBoundingClientRect();
							// Inset the right edge by the modal-content's
							// scrollbar width so the FK link band doesn't
							// overlap the scrollbar. mousedown on the
							// scrollbar triggers Chrome's native scrollbar
							// grab; it captures pointer events at the
							// compositor level, never fires mousemove on
							// document, and we lose the rubber-band line.
							// Letting that area fall through to normal
							// scrollbar behaviour is the right outcome:
							// click the scrollbar to scroll, click just
							// inside it to start an FK drag. Note: the
							// OUTSIDE-the-modal OUTSET still applies on
							// the right (band extends past the actual
							// modal right edge into empty canvas space),
							// just not into the scrollbar strip itself.
							let rightAdjusted = r.right;
							const modal = modalBody.parentElement;
							const content = modal && modal.querySelector('.modal-content');
							if (content) {
								const sbW = content.offsetWidth - content.clientWidth;
								if (sbW > 0) {
rightAdjusted = r.right - sbW - 2;
}
							}
							const inside = x >= r.left && x <= rightAdjusted && y >= r.top && y <= r.bottom;
							const inOutsetBox =
								x >= r.left - CARD_EDGE_OUTSET && x <= r.right + CARD_EDGE_OUTSET &&
								y >= r.top - CARD_EDGE_OUTSET && y <= r.bottom + CARD_EDGE_OUTSET;
							// The scrollbar strip is between rightAdjusted
							// and r.right. Suppress matches there even
							// when the outset would otherwise catch
							// the cursor.
							const onScrollbarStrip = x > rightAdjusted && x <= r.right && y >= r.top && y <= r.bottom;
							if (r.width > 0 && r.height > 0 && (inside || (inOutsetBox && !onScrollbarStrip))) {
								return {
									kind: 'modal',
									el: modalBody,
									rect: { left: r.left, top: r.top, right: rightAdjusted, bottom: r.bottom, width: rightAdjusted - r.left, height: r.height },
									recId: Number(modalBody.getAttribute('data-inline-rec-id')),
								};
							}
						}
						return null;
					};
					// True when (x, y) is on the FK link band: within
					// CARD_EDGE_THRESHOLD px INSIDE the rect from any
					// edge, OR within CARD_EDGE_OUTSET px OUTSIDE the
					// rect (Euclidean distance to the closest point on
					// the perimeter).
					const _isOnRectEdge = (rect, x, y) => {
						const insideX = x >= rect.left && x <= rect.right;
						const insideY = y >= rect.top && y <= rect.bottom;
						if (insideX && insideY) {
							const d = Math.min(x - rect.left, rect.right - x, y - rect.top, rect.bottom - y);
							return d <= CARD_EDGE_THRESHOLD;
						}
						const cx = Math.max(rect.left, Math.min(x, rect.right));
						const cy = Math.max(rect.top, Math.min(y, rect.bottom));
						const dx = x - cx;
						const dy = y - cy;
						return Math.hypot(dx, dy) <= CARD_EDGE_OUTSET;
					};
					const _setEdgeHoverCard = (recId) => {
						document.querySelectorAll('.record-card.is-edge-link, .modal.is-inline.is-edge-link').forEach((el) => el.classList.remove('is-edge-link'));
						if (recId == null) {
return;
}
						const card = container.querySelector('.record-card[data-rec-id="' + recId + '"]');
						if (card) {
card.classList.add('is-edge-link');
}
						const modal = document.querySelector('.modal.is-inline');
						if (modal) {
							const a = modal.querySelector('.modal-body[data-inline-rec-id="' + recId + '"]');
							if (a) {
modal.classList.add('is-edge-link');
}
						}
					};
					// Resize handles are an explicit gesture boundary. This
					// document listener runs in the capture phase, before the
					// handle's own mousedown listener, so it must yield here or
					// an overlapping card can start an FK drag first.
					const _isInlineResizeHandleTarget = (target) => Boolean(
						target &&
						target.closest &&
						target.closest('.modal.is-inline .inline-resize-handle')
					);
					// Document-level so the listener catches events on
					// the cy canvas, on the html-label cards (which use
					// pointer-events: none and bubble to whatever's
					// underneath), AND on the inline modal (which lives
					// outside the cy container as a child of document.body).
					document.addEventListener('mousemove', (ev) => {
						if (_isInlineResizeHandleTarget(ev.target)) {
							container.classList.remove('cy-edge-hover');
							_setEdgeHoverCard(null);
							return;
						}
						if (getCyPendingEdge()) {
return;
}
						const hit = _findEdgeTargetAt(ev.clientX, ev.clientY);
						if (!hit) {
							if (container.classList.contains('cy-edge-hover')) {
container.classList.remove('cy-edge-hover');
}
							_setEdgeHoverCard(null);
							return;
						}
						const rec = canvasState.bulkRecords.find((r) => r.id === hit.recId);
						if (!rec || rec.isTypeNode) {
							container.classList.remove('cy-edge-hover');
							_setEdgeHoverCard(null);
							return;
						}
						const onEdge = _isOnRectEdge(hit.rect, ev.clientX, ev.clientY);
						container.classList.toggle('cy-edge-hover', onEdge);
						_setEdgeHoverCard(onEdge ? hit.recId : null);
					});
					// Initiation: capture phase on document so we run
					// before cy's mousedown handlers (cy attaches to the
					// container; document captures first).
					document.addEventListener('mousedown', (ev) => {
						if (ev.button !== 0) {
return;
}
						if (_isInlineResizeHandleTarget(ev.target)) {
return;
}
						if (getCyPendingEdge()) {
return;
}
						if (ev.target && ev.target.closest && ev.target.closest(_CTA_EDGE_SKIP_SEL)) {
return;
}
						// Form inputs and other interactive widgets
						// inside the modal aren't edge-link targets even
						// if they happen to be near the modal's perimeter.
						if (ev.target && ev.target.closest && ev.target.closest('input, textarea, select, button, a, [contenteditable="true"]')) {
return;
}
						const hit = _findEdgeTargetAt(ev.clientX, ev.clientY);
						if (!hit) {
return;
}
						if (!Number.isFinite(hit.recId)) {
return;
}
						const rec = canvasState.bulkRecords.find((r) => r.id === hit.recId);
						if (!rec || rec.isTypeNode) {
return;
}
						if (!_isOnRectEdge(hit.rect, ev.clientX, ev.clientY)) {
return;
}
						const cyNode = getCyInstance().getElementById('r' + hit.recId);
						if (!cyNode || cyNode.length === 0) {
return;
}
						const svg = document.createElementNS(_ns, 'svg');
						svg.setAttribute('class', 'cy-pending-edge-svg');
						const line = document.createElementNS(_ns, 'line');
						line.setAttribute('class', 'cy-pending-edge-line');
						// Anchor the line at the closest point on the card's
						// visible perimeter to where the user clicked:
						// NOT at the literal click point. The user clicks
						// inside the 15px edge band, which can land
						// slightly outside (or just inside) the card's
						// visible border; anchoring at the click point
						// makes the line appear to start in dead space
						// next to the card. Snapping to the nearest point
						// on the card's bounding rect perimeter makes the
						// line look like it emerges from the card itself.
						// Store as an OFFSET from the source node's
						// rendered center so _updatePendingLine can
						// re-derive the anchor every pan/zoom tick and
						// the line stays attached to the same point on
						// the card as the canvas moves.
						const _containerRect = container.getBoundingClientRect();
						// Closest point on the card's rect perimeter to
						// the click (in viewport coords). When the click
						// is outside the rect, clamping snaps it to the
						// boundary. When it's inside, we pick the nearest
						// of the four edges and project onto it.
						const _r = hit.rect;
						const _cx = Math.max(_r.left, Math.min(ev.clientX, _r.right));
						const _cy = Math.max(_r.top, Math.min(ev.clientY, _r.bottom));
						let _clientAnchorX = _cx;
						let _clientAnchorY = _cy;
						if (_cx === ev.clientX && _cy === ev.clientY) {
							const dLeft = ev.clientX - _r.left;
							const dRight = _r.right - ev.clientX;
							const dTop = ev.clientY - _r.top;
							const dBottom = _r.bottom - ev.clientY;
							const dMin = Math.min(dLeft, dRight, dTop, dBottom);
							if (dMin === dLeft) {
_clientAnchorX = _r.left;
} else if (dMin === dRight) {
_clientAnchorX = _r.right;
} else if (dMin === dTop) {
_clientAnchorY = _r.top;
} else {
_clientAnchorY = _r.bottom;
}
						}
						const _anchorX = _clientAnchorX - _containerRect.left;
						const _anchorY = _clientAnchorY - _containerRect.top;
						const _srcRP = cyNode.renderedPosition();
						const _anchorOffsetX = _anchorX - _srcRP.x;
						const _anchorOffsetY = _anchorY - _srcRP.y;
						line.setAttribute('x1', _anchorX);
						line.setAttribute('y1', _anchorY);
						line.setAttribute('x2', _anchorX);
						line.setAttribute('y2', _anchorY);
						svg.appendChild(line);
						container.appendChild(svg);
						setCyPendingEdge({
							srcRec: rec,
							srcCyNode: cyNode,
							svg: svg,
							line: line,
							anchorOffsetX: _anchorOffsetX,
							anchorOffsetY: _anchorOffsetY,
						});
						_setConnectClass(true);
						cyNode.ungrabify();
						getCyInstance().userPanningEnabled(false);
						ev.preventDefault();
						ev.stopPropagation();
						cyNode.data('rev', (cyNode.data('rev') || 0) + 1);
					}, true /* capture, runs before cy */);
					// Document-level mousemove during a drag: keeps the
					// rubber-band line end pinned to the cursor and
					// tracks the hover-target card the cursor is over.
					// Mirrors the cy 'mousemove' handler but works even
					// when the cursor is over the inline modal (which
					// lives outside the cy container).
					document.addEventListener('mousemove', (ev) => {
						const pe = getCyPendingEdge();
						if (!pe || !pe.line) {
return;
}
						const rect = container.getBoundingClientRect();
						const px = ev.clientX - rect.left;
						const py = ev.clientY - rect.top;
						pe.line.setAttribute('x2', px);
						pe.line.setAttribute('y2', py);
						const hit = _findEdgeTargetAt(ev.clientX, ev.clientY);
						let hoverId = null;
						if (hit && hit.recId !== pe.srcRec.id) {
							const candidate = canvasState.bulkRecords.find((r) => r.id === hit.recId);
							if (candidate && !candidate.isTypeNode) {
hoverId = hit.recId;
}
						}
						if (hoverId !== pe.hoverTargetId) {
							const prev = pe.hoverTargetId;
							pe.hoverTargetId = hoverId;
							_bumpRev(prev);
							_bumpRev(hoverId);
						}
					});
					// Document-level mouseup: cy's own 'mouseup' only
					// fires when cy's mousedown gesture initiated first,
					// but our DOM capture-phase mousedown stopPropagation's
					// to keep cy from starting drag-to-move on the source
					// card, so cy never sees the mousedown and won't fire
					// the paired mouseup either. Handle the gesture end
					// ourselves: find the target via DOM rect check, run
					// finalizeAssociation, and tear down the rubber-band.
					document.addEventListener('mouseup', (ev) => {
						const pe = getCyPendingEdge();
						if (!pe) {
return;
}
						let tgtRec = null;
						const hit = _findEdgeTargetAt(ev.clientX, ev.clientY);
						if (hit && hit.recId !== pe.srcRec.id) {
							const candidate = canvasState.bulkRecords.find((r) => r.id === hit.recId);
							if (candidate && !candidate.isTypeNode) {
tgtRec = candidate;
}
						}
						const srcRec = pe.srcRec;
						const srcId = srcRec.id;
						const hoverTargetId = pe.hoverTargetId;
						if (pe.svg && pe.svg.parentNode) {
pe.svg.parentNode.removeChild(pe.svg);
}
						setCyPendingEdge(null);
						_setConnectClass(false);
						container.classList.remove('cy-edge-hover');
						getCyInstance().userPanningEnabled(false);
						getCyInstance().nodes().forEach((n) => n.grabify());
						const srcCyNode = getCyInstance().getElementById('r' + srcId);
						if (srcCyNode && srcCyNode.length) {
srcCyNode.data('rev', (srcCyNode.data('rev') || 0) + 1);
}
						if (hoverTargetId != null) {
							const tgtCyNode = getCyInstance().getElementById('r' + hoverTargetId);
							if (tgtCyNode && tgtCyNode.length) {
tgtCyNode.data('rev', (tgtCyNode.data('rev') || 0) + 1);
}
						}
						if (tgtRec) {
							finalizeAssociation(srcRec, tgtRec, ev.clientX, ev.clientY);
						}
					});
					const _bumpRev = (id) => {
						if (id == null) {
return;
}
						const n = getCyInstance().getElementById('r' + id);
						if (n && n.length) {
n.data('rev', (n.data('rev') || 0) + 1);
}
					};
					// Track the cursor end of the line AND the current
					// hover target. Cytoscape's 'mousemove' fires for
					// every move over the container, including over
					// background AND over nodes (HTML overlay has
					// pointer-events: none, so it doesn't block these).
					// Hit-test by walking nodes and checking
					// renderedBoundingBox containment; using cy's
					// 'mouseover'/'mouseout' on nodes is unreliable
					// during an in-flight mousedown gesture (cy doesn't
					// emit them while the user is mid-drag from another
					// node).
					getCyInstance().on('mousemove', (evt) => {
						if (!getCyPendingEdge() || !getCyPendingEdge().line) {
return;
}
						const oe = evt.originalEvent;
						if (!oe) {
return;
}
						const rect = container.getBoundingClientRect();
						const px = oe.clientX - rect.left;
						const py = oe.clientY - rect.top;
						getCyPendingEdge().line.setAttribute('x2', px);
						getCyPendingEdge().line.setAttribute('y2', py);
						_updatePendingLine();
						// Find the topmost card node containing the
						// cursor (by rendered bbox), excluding the
						// source and type-nodes.
						let hit = null;
						getCyInstance().nodes('node[kind ^= "card"]').forEach((n) => {
							if (hit) {
return;
}
							const recId = n.data('recId');
							if (recId == null || recId === getCyPendingEdge().srcRec.id) {
return;
}
							const bb = n.renderedBoundingBox();
							if (px >= bb.x1 && px <= bb.x2 && py >= bb.y1 && py <= bb.y2) {
								hit = recId;
							}
						});
						if (hit !== getCyPendingEdge().hoverTargetId) {
							const prev = getCyPendingEdge().hoverTargetId;
							getCyPendingEdge().hoverTargetId = hit;
							_bumpRev(prev);
							_bumpRev(hit);
						}
					});
					// Cy emits 'render' on every viewport change; reuse
					// it to keep the source end pinned to the source
					// node if the user pans/zooms while dragging.
					getCyInstance().on('render', _updatePendingLine);
					getCyInstance().on('mouseup tap', (evt) => {
						if (!getCyPendingEdge()) {
return;
}
						let tgtRec = null;
						if (evt.target !== getCyInstance()) {
							const recId = evt.target.data && evt.target.data('recId');
							if (recId != null) {
								const candidate = canvasState.bulkRecords.find((r) => r.id === recId);
								if (candidate && !candidate.isTypeNode && candidate.id !== getCyPendingEdge().srcRec.id) {
									tgtRec = candidate;
								}
							}
						}
						const srcRec = getCyPendingEdge().srcRec;
						const srcId = srcRec.id;
						const hoverTargetId = getCyPendingEdge().hoverTargetId;
						if (getCyPendingEdge().svg && getCyPendingEdge().svg.parentNode) {
							getCyPendingEdge().svg.parentNode.removeChild(getCyPendingEdge().svg);
						}
						setCyPendingEdge(null);
						_setConnectClass(false);
						container.classList.remove('cy-edge-hover');
						// Restore the cy config default: pan stays off
						// so left-drag goes to the custom marquee, not
						// cy's built-in pan.
						getCyInstance().userPanningEnabled(false);
						getCyInstance().nodes().forEach((n) => n.grabify());
						// Re-render source + last hover target so the
						// .connect-source / .connect-target classes clear.
						const srcCyNode = getCyInstance().getElementById('r' + srcId);
						if (srcCyNode && srcCyNode.length) {
srcCyNode.data('rev', (srcCyNode.data('rev') || 0) + 1);
}
						if (hoverTargetId != null) {
							const tgtCyNode = getCyInstance().getElementById('r' + hoverTargetId);
							if (tgtCyNode && tgtCyNode.length) {
tgtCyNode.data('rev', (tgtCyNode.data('rev') || 0) + 1);
}
						}
						if (tgtRec) {
							const rect = container.getBoundingClientRect();
							const oe = evt.originalEvent;
							const cx = oe ? oe.clientX : rect.left + rect.width / 2;
							const cyy = oe ? oe.clientY : rect.top + rect.height / 2;
							finalizeAssociation(srcRec, tgtRec, cx, cyy);
						}
					});
				} else {
					// Diff-and-sync. Cheaper than rebuilding the whole
					// graph on every renderBulkView, and preserves the
					// user's current pan/zoom + selection.
					const wantedIds = new Set(elements.map((e) => e.data.id));
					getCyInstance().elements().forEach((el) => {
 if (!wantedIds.has(el.id())) {
el.remove();
} 
});
					const haveIds = new Set(getCyInstance().elements().map((el) => el.id()));
					elements.forEach((el) => {
						if (!haveIds.has(el.data.id)) {
							getCyInstance().add(el);
							// Track newly-added record cards (not
							// type-nodes, not edges) so we can animate
							// the camera to follow them. Mirrors the
							// legacy renderer's auto-pan behavior so
							// records spawned via openTypeNode / Find
							// existing don't land off-screen.
							if (el.group === 'nodes' && el.data.kind && el.data.kind.indexOf('card') === 0) {
								newRealNodeIds.push(el.data.id);
							}
							return;
						}
						if (el.group !== 'nodes') {
return;
}
						const existing = getCyInstance().getElementById(el.data.id);
						if (el.data.label !== existing.data('label')) {
existing.data('label', el.data.label);
}
						if (el.data.kind !== existing.data('kind')) {
existing.data('kind', el.data.kind);
}
						if (el.position) {
							// Don't fight the user's in-progress drag.
							// rec.x/rec.y only sync back on 'free' (see
							// the 'free' handler), so during a drag the
							// rec position is STALE; applying it would
							// snap the cy node back to its pre-drag
							// origin. Mid-drag re-renders happen any
							// time some background probe finishes
							// (related-counts chip, selection-change
							// rerender, etc.); without this guard the
							// drag visibly hops back when those land.
							// existing.grabbed() === true while cy is
							// holding the node for the user's drag; the
							// drag handler is keeping cy's position
							// authoritative until 'free' fires, so the
							// safe move is just to not touch it.
							// Also check _dragFollower scratch: for a
							// multi-select group drag, only the anchor
							// is :grabbed, the followers are positioned
							// manually. They get the scratch flag set
							// when the drag starts and cleared on free.
							if (!existing.grabbed() && !existing.scratch('_dragFollower')) {
								const p = existing.position();
								if (Math.abs(p.x - el.position.x) > 0.5 || Math.abs(p.y - el.position.y) > 0.5) {
									existing.position(el.position);
								}
							}
						}
						// Force cytoscape-node-html-label to re-run its
						// tpl on every diff for card and type-node
						// nodes. Card state can change without `kind`
						// flipping (e.g., user types a value into the
						// edit form; kind stays "card-draft" but the
						// title changes). Type-node state changes when
						// `_loading` flips during openTypeNode. Bumping
						// a rev counter triggers the label refresh
						// without us having to track every relevant
						// rec field in cy data.
						if (el.data.kind && (el.data.kind.indexOf('card') === 0 || el.data.kind.indexOf('tn-') === 0)) {
							existing.data('rev', (existing.data('rev') || 0) + 1);
						}
					});
				}
			
				// Mirror canvasState.bulkSelectedIds → cy selection so toolbar
				// actions and drag-select stay in sync.
				getCyInstance().elements('node:selected').unselect();
				canvasState.bulkSelectedIds.forEach((id) => {
					const n = getCyInstance().getElementById('r' + id);
					if (n && n.length) {
n.select();
}
				});
				// Mirror canvasState.bulkSelectedEdgeId → cy edge .edge-picked class.
				// Class-based (rather than data-attribute or :selected)
				// because autounselectify blocks programmatic .select(),
				// and removeData doesn't always trigger cy to re-evaluate
				// the line-color style; classes do, reliably.
				getCyInstance().edges('.edge-picked').removeClass('edge-picked');
				if (canvasState.bulkSelectedEdgeId != null) {
					const e = getCyInstance().getElementById('a' + canvasState.bulkSelectedEdgeId);
					if (e && e.length) {
e.addClass('edge-picked');
}
				} else if (getSelectedDerivedEdge()) {
					const e = getCyInstance().getElementById('d' + getSelectedDerivedEdge().recId + '_' + getSelectedDerivedEdge().fieldName);
					if (e && e.length) {
e.addClass('edge-picked');
}
				}
			
				// Dynamic per-card sizing. Defer two frames so cy has
				// finished its render and cytoscape-node-html-label
				// has mounted/updated the DOM, then read each card's
				// actual offsetWidth/offsetHeight and write them back
				// to the cy node's `boxW`/`boxH` data. The card
				// stylesheet binds width/height to those data fields,
				// so the cy hit area always matches the visible card,
				// regardless of how the title wraps, badge changes,
				// or content state transitions.
				requestAnimationFrame(() => requestAnimationFrame(() => {
					if (!getCyInstance() || !container) {
return;
}
					const cards = container.querySelectorAll('.record-card[data-rec-id]');
					cards.forEach((el) => {
						const w = el.offsetWidth;
						const h = el.offsetHeight;
						if (!w || !h) {
return;
}
						const recId = parseInt(el.getAttribute('data-rec-id'), 10);
						if (!Number.isFinite(recId)) {
return;
}
						const node = getCyInstance().getElementById('r' + recId);
						if (!node || !node.length) {
return;
}
						// When the inline edit modal has taken over this
						// record visually, the cy node's box has been
						// resized to match the modal's perimeter so FK
						// edges (and their crow-foot markers) terminate
						// at the modal's edge. The underlying card is
						// still in the DOM (CSP blocks runtime style
						// injection that would `display: none` it); its
						// offsetWidth here is the small card width, and
						// writing it back would shrink the cy node off
						// the modal, leaving the markers stranded at the
						// card's perimeter (hidden behind the modal at
						// z-index 100).
						if (node.data('_inlineLocked')) {
return;
}
						if (node.data('boxW') !== w) {
node.data('boxW', w);
}
						if (node.data('boxH') !== h) {
node.data('boxH', h);
}
					});
				}));
			
				// Camera follow. First render: fit everything into
				// view with padding so the user sees the full graph
				// without manual pan/zoom. Subsequent renders: only
				// move the camera if new record cards were added:
				// pan to their centroid so spawn flows (Open type-
				// node, Find existing, schema clone) put new content
				// in front of the user instead of off-screen. User-
				// initiated pan/zoom is otherwise preserved.
				if (isFirstRender) {
					// Center on the first record card at native zoom
					// (1:1) instead of cy.fit. cy.resize() first to
					// pick up the container's actual dimensions:
					// without it, a center() call when the container
					// just settled into its final size would pin
					// world (0,0) to viewport (0,0) (upper-left).
					requestAnimationFrame(() => {
						if (!getCyInstance() || getCyInstance().elements().length === 0) {
return;
}
						getCyInstance().resize();
						const baseCard = getCyInstance().nodes('[kind ^= "card"]').first();
						if (baseCard && baseCard.length) {
							getCyInstance().zoom(1);
							getCyInstance().center(baseCard);
						} else {
							getCyInstance().fit(undefined, 60);
							if (getCyInstance().zoom() > 1) {
								getCyInstance().zoom(1);
								getCyInstance().center();
							}
						}
					});
				} else if (newRealNodeIds.length > 0 && !getSkipNextCyAutoPan()) {
					const newNodes = getCyInstance().collection(
						newRealNodeIds
							.map((id) => getCyInstance().getElementById(id))
							.filter((n) => n && n.length)
					);
					if (newNodes.length > 0) {
						getCyInstance().animate({ center: { eles: newNodes }, duration: 500, easing: 'ease-out' });
					}
				}
				// Consume the one-shot skip flag regardless of whether
				// the auto-pan branch ran. Next render is back to
				// default behavior.
				setSkipNextCyAutoPan(false);
			}
			

			return {
				renderBulkCanvasCy: renderBulkCanvasCy,
			};
		},
	};
})();
