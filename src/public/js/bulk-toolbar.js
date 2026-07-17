// Bulk-records toolbar render: the strip pinned above the records
// canvas. Three connected pieces:
//
//   renderBulkToolbar()
//     Top-level paint: count chip on the left, action buttons on the
//     right (Save / Browse / Import / Bulk operations / Upload / etc).
//     Rebuilds the DOM each call; cheap because the chip + buttons
//     are simple span/button nodes.
//   renderBulkCountChip()
//     The "N records · K draft · M modified · L existing" pill.
//     Tracks draft / modified / existing breakdowns.
//   renderBulkSelectionChip()
//     The "N selected" pill that appears when the user has marquee-
//     selected records.
//
// Public API (returned from mount):
//   renderBulkToolbar, renderBulkCountChip, renderBulkSelectionChip.
//
// Exposed as window.OrgLoom.bulkToolbar. Load order: before app.js.

(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.bulkToolbar = {
		mount: function mount(deps) {
			const required = [
				'canvasState', 'isRecordModified',
				'_aggregateSlotProgress', '_slotProgressClass',
				'showSaveMenu', 'promptCanvasSave',
				'showAddRecordsMenu', 'showBulkOperationsMenu',
				'openUploadModal', 'getGraph',
				'getReadOnlyMode',
				'openAiGenModal', 'getAiGen',
				'_wireCanvasFloatingAdd',
				'getCanvasShareCount', 'openCanvasEmailLinkModal',
				'openCanvasShareManagementModal',
				'openRecordDiffModal',
			];
			if (!deps) {
throw new Error('bulk-toolbar.mount: missing deps object');
}
			for (const k of required) {
				if (deps[k] === undefined || deps[k] === null) {
					throw new Error('bulk-toolbar.mount: missing dep ' + k);
				}
			}
			const canvasState = deps.canvasState;
			const isRecordModified = deps.isRecordModified;
			const _aggregateSlotProgress = deps._aggregateSlotProgress;
			const _slotProgressClass = deps._slotProgressClass;
			const showSaveMenu = deps.showSaveMenu;
			// _getCanvasShareCount lives in app.js's IIFE (lazy-fetch
			// cache + dedupe over /api/canvas/:id/share-links). The
			// toolbar reads it to decide whether to show the separate
			// Access shortcut for the active canvas. Without this dep the
			// toolbar throws ReferenceError on every render that the
			// canvas has an owner, including the post-load render
			// after Replace canvas, which surfaces as "Could not add
			// to canvas: _getCanvasShareCount is not defined."
			const _getCanvasShareCount = deps.getCanvasShareCount;
			// openCanvasEmailLinkModal lives in canvas-share.js and is
			// mounted later in app.js's IIFE than bulk-toolbar. Passed
			// as a lazy wrapper so the binding resolves at click time
			// (when the user opens the Share modal), not at mount time.
			const openCanvasEmailLinkModal = deps.openCanvasEmailLinkModal;
			const openCanvasShareManagementModal = deps.openCanvasShareManagementModal;
			const promptCanvasSave = deps.promptCanvasSave;
			// promptFileExport was retired from this module; Export lives
			// in showSaveMenu (canvas-save-load.js) now.
			const showAddRecordsMenu = deps.showAddRecordsMenu;
			const showBulkOperationsMenu = deps.showBulkOperationsMenu;
			const openUploadModal = deps.openUploadModal;
			const getGraph = deps.getGraph;
			const getReadOnlyMode = deps.getReadOnlyMode;
			// Smart filter, History, and Quick Upload were removed from
			// this toolbar; none of them are canvas-record operations.
			// Smart filter was already hidden (showSmartFilter = false).
			// History is a cross-canvas timeline and Quick Upload is a
			// CSV-direct-to-SF pipeline that bypasses the canvas; both
			// live in the top-strip (partials/top-strip.ejs) now where
			// they read as app-level utilities. Their deps were dropped
			// from this mount contract accordingly.
			const openAiGenModal = deps.openAiGenModal;
			const getAiGen = deps.getAiGen;
			const _wireCanvasFloatingAdd = deps._wireCanvasFloatingAdd;
			const openRecordDiffModal = deps.openRecordDiffModal;

			function renderBulkToolbar() {
				// Toolbar is split into two zones whose widths mirror the
				// schema canvas (left) and bulk records canvas (right) below:
				//   - cloneBar lives in the schema zone alongside the filter
				//     and parents/children controls: the per-object clone
				//     buttons read like quick-add affordances tied to the
				//     selected schema objects.
				//   - recordsBar holds everything from "+ Add records"
				//     onward: actions that affect the records canvas.
				const cloneBar = getGraph().querySelector('#subbar-clone-btns');
				const recordsBar = getGraph().querySelector('#subbar-records');
				if (!cloneBar || !recordsBar) {
return;
}
				// Clone-mount carries per-object clone buttons that only make
				// sense once the user has picked an object. Records-side
				// toolbar always renders so the +Add affordances are
				// reachable from the empty state.
				if (canvasState.selectedObjects.length === 0) {
					cloneBar.innerHTML = '';
				}
				// Per-object "+ record" affordances now live on the schema cards
				// themselves (see makeNode's cloneOpts), spatially correct, and
				// frees the toolbar from N chips per selected object type.
				// Bulk-add entry points (Import CSV, AI generate, load/save
				// template) collapse into a single "Add records" menu so the
				// toolbar isn't dominated by 4-6 competing CTAs.
				// Neutral .batch-btn (not accent): Share owns the accent on
				// this toolbar now. + Import records is a gateway into a
				// menu of starters, not a primary CTA, so visually
				// subordinating it lets Share read as *the* featured
				// action while still keeping Import discoverable.
				const addMenuBtn = '<button type="button" class="batch-btn" data-bulk-add-menu title="Import records from a CSV or saved template">+ Import records</button>';
				// Single "Bulk operations" entry collapses what used to
				// be three separate toolbar buttons (split-style Seed,
				// Bulk edit, Run script). The popover routes to the
				// individual handlers; menu items adapt to canvas
				// state: Fill-* options only show when there are
				// drafts to seed, Run script only when the team flag
				// is on, but the entry-point button itself stays put
				// so users always know where these actions live.
				const draftCountForToolbar = canvasState.bulkRecords.filter((r) => !r.loadedFromId && !r.isTypeNode).length;
				const _uploadEmpty = canvasState.bulkRecords.filter((r) => !r.isTypeNode).length === 0;
				// Every action in the bulk-ops menu (fill-required,
				// fill-all, clear-all, bulk-edit, script) operates on
				// existing canvas records, so the menu has nothing
				// useful to offer when the canvas is empty. Disable
				// the parent trigger up front with an explanatory
				// tooltip; previously the menu opened, the user
				// picked Run script (or any other item), and got a
				// missable toast saying "Add some records first."
				// Clearer to fail at the entry point.
				const bulkOpsBtn = _uploadEmpty
					? '<button type="button" class="batch-btn" data-bulk-ops title="Add records to the canvas first" disabled aria-disabled="true">Tools ▾</button>'
					: '<button type="button" class="batch-btn" data-bulk-ops title="Auto-fill drafts, bulk edit fields, run a script, or diff records on the canvas">Tools ▾</button>';
				// Adaptive label: when the user has a partial selection,
				// the upload button scope-shifts to "Upload N selected"
				// and pre-opens the modal in selected-only mode. With
				// no selection (or full selection) it stays "Save and
				// upload". The accent class makes the scope-shift
				// visible at a glance.
				const _allRealCount = canvasState.bulkRecords.filter((r) => !r.isTypeNode).length;
				const _selectedRealCount = canvasState.bulkRecords.filter((r) => !r.isTypeNode && canvasState.bulkSelectedIds.has(r.id)).length;
				const _hasPartialSelection = _selectedRealCount > 0 && _selectedRealCount < _allRealCount;
				const uploadBtn = getReadOnlyMode()
					? '<button type="button" class="upload-btn upload-btn--locked" disabled title="Read-only mode is on; turn it off in the org banner above to upload">\uD83D\uDD12 Read-only</button>'
					: (_uploadEmpty
						? '<button type="button" class="upload-btn" data-bulk-upload disabled title="Add records to the canvas to enable upload">Upload to Salesforce</button>'
						: (_hasPartialSelection
							? '<button type="button" class="upload-btn upload-btn--scoped" data-bulk-upload data-upload-scope-default="selected" title="Review and upload only the ' + _selectedRealCount + ' selected record' + (_selectedRealCount === 1 ? '' : 's') + '">Upload ' + _selectedRealCount + ' selected</button>'
							: '<button type="button" class="upload-btn" data-bulk-upload title="Review and upload all records to Salesforce">Upload to Salesforce</button>'));
				// Top-level Export entry-point: opens the same fixtures popover
				// that lives under "+ Add records ▾", but one click instead of
				// three.
				// Save is unconditionally enabled: even an empty canvas
				// can be saved. The original "add records first" gate
				// predated AI-on-canvas; with MCP in the picture, the
				// blank-canvas save IS the workflow ("save first to
				// give AI a target id, then have AI propose records
				// into it"). Export is still gated separately because
				// exporting nothing as JSON is genuinely useless.
				// "Save \u25BE" (was "Save canvas"): the caret signals a menu
				// (Save changes / Save as new / Export); "canvas" was
				// redundant on a canvas-screen toolbar. Tightens the
				// right-cluster verb arc rhythm: Share \u00B7 Save \u25BE \u00B7
				// Upload to Salesforce.
				const saveCanvasBtn = '<button type="button" class="batch-btn" data-bulk-save title="Save this canvas to your Salesforce org (stored as a File). Empty canvases can be saved as a starting point for AI proposals.">Save \u25BE</button>';
				// Export-to-file lives inside the Save menu now (see
				// showSaveMenu in canvas-save-load.js) so all "get a copy
				// of this canvas" actions sit together. The standalone
				// toolbar button was retired in favor of the one entry
				// point; this binding stays for any orphan template
				// reference but never renders a button.
				const exportBtn = '';
				// Help button removed from the records-toolbar: the
				// Canvas-shortcuts overlay it opens is now reached
				// from the top-strip Help chip (help-chip.js), which
				// also surfaces Documentation / Support / Bug-report
				// in one place.
				const helpBtn = '';
				// "+ Add record" toolbar button was removed in favor of
				// the right-click context menu's "Add record here" + the
				// dashed-card affordance in the empty-canvas placeholder.
				// A persistent corner hint ("Right-click to add a record")
				// surfaces the right-click affordance once the canvas has
				// content so it stays discoverable without crowding the
				// toolbar. See `bulk-canvas-hint` markup below and the
				// matching toggle in renderBulkView.
				// Share-nodes SVG for the primary Share button. Three
				// connected dots: reads universally as "share" without
				// relying on a chain/link metaphor that overlaps with
				// hyperlink iconography elsewhere in the app. Matches
				// the Lucide "share-2" outline so it sits visually
				// next to the other Lucide-style toolbar icons.
				const _shareIconSvg =
					'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px;margin-right:0.4em;display:inline-block" aria-hidden="true">' +
						'<circle cx="18" cy="5" r="3"/>' +
						'<circle cx="6" cy="12" r="3"/>' +
						'<circle cx="18" cy="19" r="3"/>' +
						'<line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>' +
						'<line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>' +
					'</svg>';
			
				// Primary Share button: always rendered, regardless of
				// canvas state, so it reads as a first-class verb (Google
				// Docs / Figma pattern). Disabled-with-tooltip when the
				// action isn't applicable yet. Four states:
				//
				//   owned-saved: saved canvas you own. Click opens the
				//                   share modal directly. Shows count
				//                   badge if 1+ existing shares.
				//   owned-unsaved: populated canvas, not yet saved. Click
				//                   chains save → share: opens save
				//                   prompt with "Save & share" CTA, then
				//                   opens the share modal once an id
				//                   exists.
				//   empty: no records on canvas AND not saved.
				//                   Disabled, tooltip coaches user to
				//                   add a record first. Saved-empty
				//                   canvases stay enabled (the MCP
				//                   "save first, AI adds records" flow
				//                   is a valid use).
				//   recipient: canvas you don't own. Disabled,
				//                   tooltip explains only the owner can
				//                   share + offers fork-as-new as the
				//                   workaround.
				//
				// data-share-state on the button drives the click router
				// below so the routing logic isn't duplicated between
				// render-time and click-time.
				const cc = canvasState.currentCanvas;
				const isRecipient = !!(cc && cc.id && !cc.ownedByMe);
				const isSavedOwned = !!(cc && cc.id && cc.ownedByMe);
				const _hasRealRecords = canvasState.bulkRecords.filter((r) => !r.isTypeNode).length > 0;
				let shareState = 'owned-saved';
				let shareDisabled = false;
				let shareTitle = 'Share this canvas with teammates';
				if (isRecipient) {
					shareState = 'recipient';
					shareDisabled = true;
					shareTitle = 'Only the canvas owner can share. Save a copy to share your version.';
				} else if (!_hasRealRecords && !isSavedOwned) {
					shareState = 'empty';
					shareDisabled = true;
					shareTitle = 'Add a record to start a canvas, then share it';
				} else if (!isSavedOwned) {
					shareState = 'owned-unsaved';
					shareTitle = 'Save this canvas and share it with teammates';
				}
				const shareCount = isSavedOwned ? _getCanvasShareCount(cc.id) : null;
				const shareBtn = '<button type="button" class="batch-btn batch-btn-accent canvas-share-btn" data-bulk-share data-share-state="' + shareState + '"' + (shareDisabled ? ' disabled' : '') + ' title="' + shareTitle + '">' +
						_shareIconSvg +
						'Share' +
					'</button>';
				const manageAccessBtn = (isSavedOwned && shareCount && shareCount > 0)
					? '<button type="button" class="batch-btn canvas-access-btn" data-bulk-manage-access title="Manage who can open this canvas">Access <span class="canvas-share-btn-count">' + shareCount + '</span></button>'
					: '';
				// History: sits to the immediate right of Upload so the
				// "I just uploaded; where do I undo?" flow has a one-glance
				// answer. data-app-history is the same hook the top-strip
				// used; app.js's document-level delegation handles the
				// click, so no new wiring here. Icon-only with title text
				// keeps the toolbar from bloating; Upload is already a
				// wide accent button to its left.
				const _historyIconSvg =
					'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
						'<path d="M3 12a9 9 0 1 0 9-9 9.74 9.74 0 0 0-6.74 2.74L3 8"/>' +
						'<path d="M3 3v5h5"/>' +
						'<path d="M12 7v5l4 2"/>' +
					'</svg>';
				const historyBtn = '<button type="button" class="batch-btn batch-btn-icon" data-app-history title="Recent uploads: recall a previous batch" aria-label="Upload history">' +
						_historyIconSvg +
					'</button>';
				// Promoted AI generate. Was nested inside the "Add records"
				// popover; surfacing it as its own toolbar button gives the
				// feature top-level visibility. Accent styling distinguishes
				// it from the regular content-creation buttons so users
				// notice it. Gated on getAiGen().isEnabled() so it's hidden
				// when the org doesn't have AI features turned on.
				const aiGenBtn = getAiGen().isEnabled()
					? '<button type="button" class="batch-btn ai-gen-btn" data-bulk-ai-gen title="Describe what you want and let Claude draft records + relationships">\u2728 Generate with AI</button>'
					: '';
				cloneBar.innerHTML = '';
				// Toolbar order: two logical clusters separated by the
				// auto-spacer that pushes the right cluster to the
				// right edge. Cross-canvas utilities (Quick Upload,
				// Help) live in the top-strip (partials/top-strip.ejs),
				// not here; the canvas toolbar holds canvas-record
				// operations PLUS History (kept here because it's the
				// natural follow-up to Upload: "I just uploaded;
				// where do I undo?", and pairing them spatially
				// removes the cross-bar context switch).
				//   LEFT (build the canvas):
				//     saved canvases · import records · AI generate ·
				//     bulk ops.
				//   RIGHT (act on the finished canvas):
				//     Share · Save ▾ · Upload to Salesforce · History.
				// The right cluster reads as a verb arc users learn
				// as the canvas workflow: collaborate → persist → push
				// to SF → review past pushes. Share is always-rendered
				// (Google Docs / Figma pattern) with disabled-with-
				// tooltip states for empty
				// canvases and recipient mode.
				recordsBar.innerHTML = addMenuBtn + aiGenBtn + bulkOpsBtn + '<span class="bulk-hint-spacer"></span>' + shareBtn + manageAccessBtn + saveCanvasBtn + uploadBtn + historyBtn;
			
				const bulkOpsTrigger = getGraph().querySelector('[data-bulk-ops]');
				if (bulkOpsTrigger) {
bulkOpsTrigger.addEventListener('click', (e) => {
					e.stopPropagation();
					showBulkOperationsMenu(bulkOpsTrigger);
				});
}
				const addMenuTrigger = getGraph().querySelector('[data-bulk-add-menu]');
				if (addMenuTrigger) {
addMenuTrigger.addEventListener('click', (e) => {
					e.stopPropagation();
					showAddRecordsMenu(addMenuTrigger);
				});
}
				const shareTrigger = getGraph().querySelector('[data-bulk-share]');
				if (shareTrigger) {
shareTrigger.addEventListener('click', (e) => {
					e.stopPropagation();
					if (shareTrigger.disabled) {
return;
}
					// Re-read canvasState at click time (not render time)
					// so the routing reflects the latest state; saves and
					// loads can change ownership/id between paints.
					const cc2 = canvasState.currentCanvas;
					const state = shareTrigger.dataset.shareState;
					if (state === 'owned-saved' && cc2 && cc2.id) {
						openCanvasEmailLinkModal(cc2.id, cc2.title || '');
					} else if (state === 'owned-unsaved') {
						// Chained save → share. Pass afterSave so the
						// share modal opens once the canvas has an id;
						// the user sees Save & share as one action, not
						// "save, then remember to click Share again."
						promptCanvasSave({
							title: 'Name this canvas to share it',
							submitText: 'Save & share',
							afterSave: function (saved) {
								if (saved && saved.id) {
									openCanvasEmailLinkModal(saved.id, saved.title || '');
								}
							},
						});
					}
				});
}
				const manageAccessTrigger = getGraph().querySelector('[data-bulk-manage-access]');
				if (manageAccessTrigger) {
					manageAccessTrigger.addEventListener('click', (event) => {
						event.stopPropagation();
						const current = canvasState.currentCanvas;
						if (current && current.id && current.ownedByMe) {
							openCanvasShareManagementModal(current.id, current.title || '');
						}
					});
				}
				// Export trigger was removed; Export-to-file is an entry
				// in the Save menu now (see showSaveMenu in canvas-save-load.js).
				const saveCanvasTrigger = getGraph().querySelector('[data-bulk-save]');
				if (saveCanvasTrigger) {
saveCanvasTrigger.addEventListener('click', () => {
					// Always show the menu so Export-to-file is reachable
					// even on a fresh canvas. The menu's render handles
					// the open-vs-fresh distinction (Save changes appears
					// only when a canvas is already open).
					showSaveMenu(saveCanvasTrigger);
				});
}
				// Help trigger moved to the top-strip; see help-chip.js.
				const aiGenTrigger = getGraph().querySelector('[data-bulk-ai-gen]');
				if (aiGenTrigger) {
aiGenTrigger.addEventListener('click', () => {
					openAiGenModal();
				});
}
				const uploadTrigger = getGraph().querySelector('[data-bulk-upload]');
				if (uploadTrigger) {
uploadTrigger.addEventListener('click', () => {
					const scope = uploadTrigger.dataset.uploadScopeDefault === 'selected' ? 'selected' : 'all';
					openUploadModal({ initialScope: scope });
				});
}
				_wireCanvasFloatingAdd();
			}
			
			// Right-click → context menu with "Add record here" plus
			// the canvas-wide keyboard shortcuts (Space-pan, Z-nudge).
			//
			// History: this used to be a Figma/Excalidraw-style "FAB
			// is the cursor" affordance: a floating + button that
			// tracked the mouse and spawned a record on click. That
			// was reverted because the FAB intercepted clicks and
			// fought with marquee select on open canvas; the
			// right-click menu gives users an explicit, on-demand
			// "spawn here" without colonizing the cursor.
			//
			// Guarded with `graph.dataset.canvasWired` so re-renders
			// don't stack listeners (the toolbar wiring re-runs on
			// every renderBulkView; without the guard each
			// keystroke would fire N times after N renders).
			function renderBulkCountChip() {
				const chip = getGraph().querySelector('#bulk-count-chip');
				if (!chip) {
return;
}
				let total = 0;
				let drafts = 0;
				let modified = 0;
				let existing = 0;
				canvasState.bulkRecords.forEach((r) => {
					if (!r || r.isTypeNode) {
return;
}
					total++;
					if (!r.loadedFromId) {
						drafts++;
					} else if (isRecordModified(r)) {
						modified++;
					} else {
						existing++;
					}
				});
				// Hide the chip entirely on an empty canvas. The onboarding
				// card (#bulk-empty-placeholder) already says "Start
				// building your canvas," and the literal "0 records · 0
				// draft · 0 modified · 0 existing" pill overlaps the
				// card's top edge on common viewport sizes. The chip
				// un-hides as soon as the first real record lands.
				if (total === 0) {
					chip.style.display = 'none';
					chip.innerHTML = '';
					return;
				}
				chip.style.display = '';
				chip.innerHTML =
					'<span class="bcc-total" title="Total records on the canvas">' + total + ' record' + (total === 1 ? '' : 's') + '</span>' +
					'<span class="bcc-sep" aria-hidden="true">·</span>' +
					'<span class="bcc-state bcc-draft" title="Drafts: new records that will be inserted">' +
						'<span class="bcc-dot" aria-hidden="true"></span>' + drafts + ' draft' +
					'</span>' +
					'<span class="bcc-state bcc-modified" title="Modified: loaded from Salesforce, edited locally; will be updated on upload">' +
						'<span class="bcc-dot" aria-hidden="true"></span>' + modified + ' modified' +
					'</span>' +
					'<span class="bcc-state bcc-existing" title="Existing: loaded from Salesforce, unchanged; will be skipped on upload">' +
						'<span class="bcc-dot" aria-hidden="true"></span>' + existing + ' existing' +
					'</span>' +
					// Slot-progress aggregate: appears next to the
					// other state chips when the canvas has any slot
					// records (field-level or whole-record). Color
					// matches the per-card badges (gray/accent/success).
					(() => {
						const sp = _aggregateSlotProgress();
						if (sp.total === 0) {
return '';
}
						return '<span class="bcc-sep" aria-hidden="true">·</span>' +
							'<span class="slot-progress ' + _slotProgressClass(sp) + '" ' +
								'title="Slot progress across ' + sp.recordCount +
								' slot record' + (sp.recordCount === 1 ? '' : 's') + ' on this canvas.">' +
								'Slots ' + sp.filled + '/' + sp.total +
							'</span>';
					})();
			}
			
			function renderBulkSelectionChip() {
				const chip = getGraph().querySelector('#bulk-selection-chip');
				if (!chip) {
return;
}
				const n = canvasState.bulkSelectedIds.size;
				if (n === 0) {
					chip.style.display = 'none';
					chip.innerHTML = '';
					return;
				}
				// Diff button: surfaces the affordance whenever the
				// user has a real-record selection, but only enables
				// at exactly 2. Filter at chip-render time so the
				// count we render is in sync with what the diff modal
				// will receive. The label inlines the constraint when
				// disabled ("Diff \u00b7 need 2", "Diff \u00b7 need 1 more")
				// so the user discovers the action AND learns what it
				// takes to use it, without needing to hover for a
				// tooltip on a grayed-out button.
				const selectedReal = canvasState.bulkRecords.filter((r) =>
					!r.isTypeNode && !r.isPending && canvasState.bulkSelectedIds.has(r.id)
				);
				let diffBtn = '';
				if (selectedReal.length === 2) {
					diffBtn = '<button type="button" class="bsc-diff" data-sel-diff title="Compare these two records field-by-field">Diff</button>';
				} else if (selectedReal.length >= 1) {
					const diffHint = selectedReal.length === 1
						? 'need 1 more'
						: 'select only 2 (' + selectedReal.length + ' selected)';
					const diffTitle = 'Diff compares exactly two records -' + diffHint + '.';
					diffBtn = '<button type="button" class="bsc-diff" data-sel-diff title="' + diffTitle + '" disabled aria-disabled="true">Diff <span class="bsc-diff-hint">\u00b7 ' + diffHint + '</span></button>';
				}
				chip.style.display = '';
				chip.innerHTML =
					'<span class="bsc-count">' + n + ' selected</span>' +
					diffBtn +
					'<button type="button" data-sel-copy title="Ctrl+C">Copy</button>' +
					(canvasState.bulkClipboard ? '<button type="button" data-sel-paste title="Ctrl+Shift+V">Clone\u2026</button>' : '') +
					'<button type="button" class="bsc-deselect" data-sel-clear>Deselect</button>';
				chip.querySelector('[data-sel-copy]').addEventListener('click', () => {
					copySelectionToClipboard();
					renderBulkSelectionChip();
				});
				const pasteBtn = chip.querySelector('[data-sel-paste]');
				if (pasteBtn) {
pasteBtn.addEventListener('click', () => openPasteCountPrompt());
}
				const diffTrigger = chip.querySelector('[data-sel-diff]');
				if (diffTrigger) {
diffTrigger.addEventListener('click', () => {
					// Re-resolve at click time so a selection change
					// between chip render and click can't ship a stale
					// pair. Mirrors the bulk-ops-menu click handler's
					// re-resolution pattern.
					const pair = canvasState.bulkRecords.filter((r) =>
						!r.isTypeNode && !r.isPending && canvasState.bulkSelectedIds.has(r.id)
					);
					if (pair.length === 2) {
openRecordDiffModal(pair[0], pair[1]);
}
				});
}
				chip.querySelector('[data-sel-clear]').addEventListener('click', () => {
					canvasState.bulkSelectedIds = new Set();
					renderBulkView();
				});
			}
			

			return {
				renderBulkToolbar: renderBulkToolbar,
				renderBulkCountChip: renderBulkCountChip,
				renderBulkSelectionChip: renderBulkSelectionChip,
			};
		},
	};
})();
