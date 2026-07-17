// Save / load canvas.
//
// The save menu (Save changes / Fork / Save as new), the underlying
// save flows that POST/PATCH a serialized canvas to /api/canvas,
// the version-mismatch reconciler, the file-export dropdown, the
// saved-canvas-cap dialog, plus the browse-saved popup that lists
// every canvas the user can see in SF Files and routes to load.
//
// Public API (returned from mount):
//   showSaveMenu: opens the save dropdown.
//   promptCanvasSave: "Save as new canvas…" flow.
//   forkCanvasAsNew: non-owner fork flow.
//   saveExistingCanvas: overwrite-in-place flow.
//   handleCanvasVersionMismatch: server returned 409; reconcile.
//   promptFileExport: File menu / "Save canvas" dropdown.
//   _showSavedCanvasCapDialog: interposes when the user hits the
//                                   per-org saved-canvas cap.
//   _showContentPermDeniedDialog: SF content-perm denied helper.
//   showTemplatesMenu: back-compat alias for showSaveMenu.
//   showBrowseSavedMenu: "Saved canvases…" popover list.
//
// Many deps are wrapped in lazy closures because they live on
// modules that mount AFTER this one (templates, supportModals,
// aiProposals). Lazy wrapping keeps the closure binding resolved
// at call time, not parse time.
//
// Exposed as window.OrgLoom.canvasSaveLoad. Load order: before app.js.

(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.canvasSaveLoad = {
		mount: function mount(deps) {
			const required = [
				'canvasState', 'csrfFetch', 'escapeHtml', 'showBulkToast',
				'showConfirmDialog', 'showPromptModal', 'showReplaceOrMergeDialog',
				'_openAnchoredPopup', '_formatRelativeTime',
				'_setStaleRefsFromLoad', '_addStaleRefIds', '_staleIdKey',
				'_watchProposalsForCurrentCanvas',
				'applyCanvasPayload', 'buildCanvasPayload', 'downloadTemplate',
				'openCanvasEmailLinkModal', 'pingAuditEvent', 'getCurrentTeam',
				'openExportCsvModal',
				'renderBulkView',
				'notePresenceLocalSave',
				'rehydrateSessionDraftValues',
				'_hasCap',
			];
			if (!deps) {
throw new Error('canvas-save-load.mount: missing deps object');
}
			for (const k of required) {
				if (deps[k] === undefined || deps[k] === null) {
					throw new Error('canvas-save-load.mount: missing dep ' + k);
				}
			}
			const canvasState = deps.canvasState;
			const csrfFetch = deps.csrfFetch;
			const escapeHtml = deps.escapeHtml;
			const showBulkToast = deps.showBulkToast;
			const showConfirmDialog = deps.showConfirmDialog;
			const showPromptModal = deps.showPromptModal;
			const showReplaceOrMergeDialog = deps.showReplaceOrMergeDialog;
			const _openAnchoredPopup = deps._openAnchoredPopup;
			const _formatRelativeTime = deps._formatRelativeTime;
			const _setStaleRefsFromLoad = deps._setStaleRefsFromLoad;
			const _addStaleRefIds = deps._addStaleRefIds;
			const _staleIdKey = deps._staleIdKey;
			const _watchProposalsForCurrentCanvas = deps._watchProposalsForCurrentCanvas;
			const applyCanvasPayload = deps.applyCanvasPayload;
			const buildCanvasPayload = deps.buildCanvasPayload;
			const downloadTemplate = deps.downloadTemplate;
			const openCanvasEmailLinkModal = deps.openCanvasEmailLinkModal;
			const pingAuditEvent = deps.pingAuditEvent;
			const getCurrentTeam = deps.getCurrentTeam;
			const openExportCsvModal = deps.openExportCsvModal;
			const renderBulkView = deps.renderBulkView;
			const notePresenceLocalSave = deps.notePresenceLocalSave;
			const rehydrateSessionDraftValues = deps.rehydrateSessionDraftValues;
			const _hasCap = deps._hasCap;
			// Optional: sessionStorage-snapshot wiper. Called after a
			// successful save/update so the local snapshot doesn't shadow
			// the freshly-persisted canvas on a future restore.
			const clearAutosave = typeof deps.clearAutosave === 'function' ? deps.clearAutosave : function () {};

			function showSaveMenu(triggerEl) {
				const { pop, cleanup } = _openAnchoredPopup(triggerEl, 380);
				const hasAny = canvasState.selectedObjects.length > 0;
				const actionDisabled = hasAny ? '' : ' disabled';
				// Export-to-JSON gates on records (not just schema
				// selection); an "exported" file with no records is
				// genuinely useless, where an empty-but-named saved
				// canvas IS the workflow for AI-led record creation.
				const _hasRecords = canvasState.bulkRecords.some((r) => !r.isTypeNode);
				const exportDisabled = _hasRecords ? '' : ' disabled';
				// Two destinations:
				// Save canvas: into customer's SF Files, owner-private
				//   by default; user shares via SF's standard file UX
				//   if they want others to see it. Drafts ride along
				//   for the owner's resume-where-they-left-off; on a
				//   non-owner load the server strips drafts to
				//   structure only.
				// Export to file: JSON downloads to the user's
				//   machine, drafts included; equivalent to what Data
				//   Loader already lets them do.
				// Save flow surfaces three different actions depending on
				// state:
				//   - Owner with canvas open:      [Save changes] + [Save as new]
				//   - Non-owner with canvas open:  [Fork as new]  + [Save as new]
				//   - No canvas open:              [Save as new]  only
				// "Save changes" overwrites in place. "Fork as new" is
				// Save-as-new with a default "Fork of <title>" name,
				// the natural action for non-owners who can't write
				// back to the original. "Save as new" without a default
				// is always available so the user can name from scratch.
				const hasCurrent = !!(canvasState.currentCanvas && canvasState.currentCanvas.id);
				const ownsCurrent = !!(canvasState.currentCanvas && canvasState.currentCanvas.ownedByMe);
				const safeTitle = hasCurrent ? escapeHtml(canvasState.currentCanvas.title || '(untitled)') : '';
				let primarySaveBtn = '';
				if (hasCurrent && ownsCurrent) {
					primarySaveBtn = '<button type="button" class="tpl-action" data-tpl-action="save-existing"' + actionDisabled + '>' +
							'Save changes <span class="tpl-action-sub">overwrite \u201c' + safeTitle + '\u201d in Salesforce Files</span>' +
						'</button>';
				} else if (hasCurrent && !ownsCurrent) {
					primarySaveBtn = '<button type="button" class="tpl-action" data-tpl-action="fork-canvas"' + actionDisabled + '>' +
							'Fork as new canvas <span class="tpl-action-sub">your own editable copy of \u201c' + safeTitle + '\u201d</span>' +
						'</button>';
				}
				// Per-user export caps. Memberships without the grant
				// don't see the buttons at all; hiding is cleaner than
				// "disabled with tooltip" for permission-denied state
				// because the action would never become available with
				// a different click. The whole download-to-machine
				// section drops out when neither cap is granted. Uses
				// the deps-injected _hasCap; window.OrgLoom.canvasCap
				// itself is the factory and has no _hasCap method.
				const _canExportCanvas = _hasCap('export-canvas');
				const _canExportRecords = _hasCap('export-records');
				const _exportJsonBtn = _canExportCanvas
					? '<button type="button" class="tpl-action" data-tpl-action="export-file"' + exportDisabled + '>Export canvas (JSON) <span class="tpl-action-sub">lossless, re-import to restore exactly</span></button>'
					: '';
				const _exportCsvBtn = _canExportRecords
					? '<button type="button" class="tpl-action" data-tpl-action="export-csv"' + exportDisabled + '>Export records (CSV) <span class="tpl-action-sub">records only, opens in Excel</span></button>'
					: '';
				const _downloadHeader = (_canExportCanvas || _canExportRecords)
					? '<div class="tpl-header">Download to your machine</div>'
					: '';
				pop.innerHTML =
					'<div class="tpl-header">Save this canvas</div>' +
					primarySaveBtn +
					// "Save as new" is deliberately NOT gated on selectedObjects:
					// an empty-but-named saved canvas IS the workflow for AI-led
					// record creation (save first to get a canvas id, then have
					// AI propose records into it (see promptCanvasSave). Only
					// the overwrite/fork actions keep the has-content gate.
					'<button type="button" class="tpl-action" data-tpl-action="save-new">Save as new canvas <span class="tpl-action-sub">a fresh saved canvas in your Salesforce org</span></button>' +
					_downloadHeader +
					// Two formats, side-by-side. JSON is the lossless
					// canvas (schema + records + layout + associations
					// + slots), round-trips cleanly back into Org Loom.
					// CSV is the records-only data dump for use in
					// Excel / other tools; drops layout, associations,
					// and canvas metadata, so it's NOT a round-trip
					// save substitute. Captions spell that out so
					// users don't pick CSV expecting full restore.
					_exportJsonBtn +
					_exportCsvBtn;
				pop.querySelectorAll('[data-tpl-action]').forEach(b => {
					b.addEventListener('click', () => {
						if (b.disabled) {
return;
}
						const action = b.dataset.tplAction;
						cleanup();
						if (action === 'save-existing') {
saveExistingCanvas();
} else if (action === 'fork-canvas') {
forkCanvasAsNew();
} else if (action === 'save-new') {
promptCanvasSave();
} else if (action === 'export-file') {
promptFileExport();
} else if (action === 'export-csv') {
openExportCsvModal();
}
					});
				});
			}
			
			// Prompt for a name and POST to /api/canvas. Single save
			// path: owner-vs-non-owner content filtering happens at
			// load time on the server, so the client always uploads
			// the full payload.
			async function promptCanvasSave(opts = {}) {
				// Empty canvases (no schema objects, no records) are
				// saveable now: the workflow is "save first to give
				// AI a canvas id, then have AI propose records into
				// it." buildCanvasPayload handles empty inputs
				// cleanly; the POST route accepts an empty payload
				// object; the cache hook populates the MCP-read
				// cache on success.
				const name = await showPromptModal({
					title: opts.title || 'Name this canvas',
					label: 'Name',
					placeholder: 'e.g. QA seed for Order flow',
					defaultValue: opts.defaultName || '',
					submitText: opts.submitText || 'Save',
				});
				if (!name) {
return;
}
				let payload;
				try {
 payload = buildCanvasPayload(); 
} catch (e) {
 showBulkToast(e.message || 'Build failed', 'error'); return; 
}
				try {
					const r = await csrfFetch('/api/canvas', {
						method: 'POST',
						credentials: 'same-origin',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ name, payload }),
					});
					const data = await r.json().catch(() => ({}));
					if (!r.ok) {
						// Content-perm denials get the structured
						// dialog treatment (explains what to ask the
						// admin for + offers Export-to-JSON as an
						// unblock-the-user workaround). Other tagged
						// 403s still get the verbatim message; they
						// already explain the specific perm issue.
						if (r.status === 403 && data && data.error === 'sf-content-version-create-denied') {
							await _showContentPermDeniedDialog(data.message || '', data.sfError || '');
							return;
						}
						if (r.status === 402 && data && data.error === 'saved-canvas-cap-reached') {
							await _showSavedCanvasCapDialog(data);
							return;
						}
						if (r.status === 403 && data && data.message && data.error) {
							showBulkToast(data.message, 'error');
							return;
						}
						throw new Error((data && (data.message || data.error)) || 'HTTP ' + r.status);
					}
					showBulkToast('Saved canvas \u201c' + name + '\u201d to your Salesforce Files.');
					// Drop the sessionStorage snapshot: the canvas is now
					// persisted to SF, so the local copy is redundant.
					clearAutosave();
					// Track the freshly-created canvas as "currently open"
					// so a subsequent Save updates it in place. The user
					// just authored it, so they're definitionally the owner.
					if (data && data.id) {
						canvasState.currentCanvas = { id: data.id, title: name, ownedByMe: true, versionId: data.versionId || null };
						// Refresh first-run guidance immediately: step 2 changes from
						// optional/pending to complete as soon as this first save lands.
						renderBulkView();
						_watchProposalsForCurrentCanvas();
						// Drop the in-memory draft id so the relay
						// re-registers under the new SF id on its
						// next 2s poll. If the AI had any proposals
						// pending against the draft id, they're
						// orphaned (still in ai_proposals but keyed
						// to the old draft id); for V1 we accept
						// this, the user can re-ask the AI.
						if (window.Orgloom && window.Orgloom.canvasState && window.Orgloom.canvasState.clearDraft) {
							window.Orgloom.canvasState.clearDraft();
						}
					}
					pingAuditEvent('canvas_save_sf', {
						recordCount: (payload.loadedRecords || []).length + (payload.drafts || []).length,
						payload: { name, contentDocumentId: data.id },
					});
					// Optional post-save callback. Used by the chained
					// "Save & share" flow in bulk-toolbar.js so a fresh
					// canvas can open the share modal as soon as its id
					// exists. Wrapped in try/catch so a callback error
					// doesn't surface as a "Save failed" toast; the
					// save itself already succeeded.
					if (typeof opts.afterSave === 'function' && data && data.id) {
						try {
 opts.afterSave({ id: data.id, title: name }); 
} catch (cbErr) { /* noop: save succeeded */ }
					}
				} catch (e) {
					showBulkToast('Save failed: ' + (e.message || e), 'error');
				}
			}
			
			// Save the current canvas as a new file owned by the
			// recipient. Convenience wrapper over promptCanvasSave that
			// prefills "Fork of <title>": the natural name a non-owner
			// wants when they can't write back to the original. The
			// underlying create path is unchanged, so the freshly-forked
			// canvas correctly tracks as canvasState.currentCanvas afterward.
			async function forkCanvasAsNew() {
				const sourceTitle = (canvasState.currentCanvas && canvasState.currentCanvas.title) || '';
				await promptCanvasSave({
					title: 'Fork as new canvas',
					defaultName: sourceTitle ? 'Fork of ' + sourceTitle : '',
					submitText: 'Fork',
				});
			}
			
			// Overwrite the currently-open canvas in place. Only callable
			// when `canvasState.currentCanvas` is set AND the user owns it (the menu
			// upstream already gates on this; defensive checks here keep
			// the function honest if it's wired to something else later).
			async function saveExistingCanvas() {
				if (!canvasState.currentCanvas || !canvasState.currentCanvas.id) {
					showBulkToast('No canvas open to save changes to. Use \u201cSave as new canvas\u201d.', 'error');
					return;
				}
				if (!canvasState.currentCanvas.ownedByMe) {
					showBulkToast('Only the canvas owner can update this canvas.', 'error');
					return;
				}
				if (canvasState.selectedObjects.length === 0) {
					showBulkToast('Nothing to save: canvas is empty.', 'error');
					return;
				}
				let payload;
				try {
 payload = buildCanvasPayload(); 
} catch (e) {
 showBulkToast(e.message || 'Build failed', 'error'); return; 
}
				try {
					// Tell the presence module we're about to save so the
					// server's broadcast echo doesn't trigger our own
					// "X just saved" banner. 5 s skew window covers
					// the SSE round-trip.
					try {
 notePresenceLocalSave(); 
} catch (_) {}
					const r = await csrfFetch('/api/canvas/' + encodeURIComponent(canvasState.currentCanvas.id), {
						method: 'PUT',
						credentials: 'same-origin',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							payload,
							// Optimistic-concurrency token. Server compares
							// against the canvas's current versionId; 409
							// if someone else saved (or a recipient
							// slot-fill landed) since we loaded.
							expectedVersionId: canvasState.currentCanvas.versionId || null,
						}),
					});
					const data = await r.json().catch(() => ({}));
					// Version mismatch: someone else edited the canvas
					// since we loaded it. Don't clobber their changes;
					// surface a dialog so the user can reload + re-apply
					// their local edits intentionally. The server sends
					// { error: 'version-mismatch' } on the PUT 409; accept
					// the legacy { code: 'version_mismatch' } shape too so a
					// future server tweak can't silently re-break this.
					if (r.status === 409 && data && (data.error === 'version-mismatch' || data.code === 'version_mismatch')) {
						handleCanvasVersionMismatch(data, payload);
						return;
					}
					// Content-perm denials get the structured dialog +
					// Export-to-JSON workaround. The edit-denial code
					// (sf-content-document-edit-denied) fires for
					// non-owners and for users whose profile lost
					// Content access since the initial save.
					if (r.status === 403 && data && (data.error === 'sf-content-version-create-denied' || data.error === 'sf-content-document-edit-denied')) {
						await _showContentPermDeniedDialog(data.message || '', data.sfError || '');
						return;
					}
					// Other tagged 403s still get the verbatim toast.
					if (r.status === 403 && data && data.message && data.error) {
						showBulkToast(data.message, 'error');
						return;
					}
					if (!r.ok) {
throw new Error((data && (data.message || data.error)) || 'HTTP ' + r.status);
}
					const titleForToast = (data && data.title) || canvasState.currentCanvas.title || 'canvas';
					// Update our local versionId to the new one so the
					// next save uses a fresh token.
					if (data && data.versionId) {
						canvasState.currentCanvas = Object.assign({}, canvasState.currentCanvas, { versionId: data.versionId });
					}
					showBulkToast('Updated \u201c' + titleForToast + '\u201d.');
					// Drop the sessionStorage snapshot: the canvas is now
					// persisted to SF, so the local copy is redundant.
					clearAutosave();
					pingAuditEvent('canvas_save_sf', {
						recordCount: (payload.loadedRecords || []).length + (payload.drafts || []).length,
						payload: { name: titleForToast, contentDocumentId: canvasState.currentCanvas.id, mode: 'update' },
					});
				} catch (e) {
					showBulkToast('Save failed: ' + (e.message || e), 'error');
				}
			}
			
			// Versioning conflict dialog: fired when the server
			// returns 409 'version_mismatch' on a PUT save. Tells the
			// user the canvas was edited elsewhere (another tab, a
			// teammate, or a magic-link recipient submitting fills),
			// gives them a Reload button to fetch the fresh version,
			// and surfaces a Save Anyway escape hatch that retries the
			// PUT without the version check (last-write-wins). The
			// escape hatch is there so a user who knows their local
			// edits are the right answer (e.g., they explicitly want
			// to overwrite a recipient's fill) doesn't get stuck.
			function handleCanvasVersionMismatch(serverPayload, originalPayload) {
				document.querySelectorAll('.canvas-version-conflict').forEach((el) => el.remove());
				const overlay = document.createElement('div');
				overlay.className = 'modal canvas-version-conflict';
				overlay.innerHTML =
					'<div class="modal-overlay" data-vc-close></div>' +
					'<div class="modal-body" style="max-width:520px">' +
						'<div class="modal-header">' +
							'<h3>Canvas was edited elsewhere</h3>' +
							'<button class="modal-close" data-vc-close>&times;</button>' +
						'</div>' +
						'<div class="modal-content">' +
							'<p>Someone else (another tab, a teammate, or a magic-link recipient who just submitted fills) updated this canvas after you opened it.</p>' +
							'<p class="tag" style="margin-top:0.5em">Saving now would overwrite their changes. Reload to see the latest version, or save anyway to overwrite.</p>' +
						'</div>' +
						'<div class="modal-footer">' +
							'<button class="button secondary" data-vc-close>Cancel</button>' +
							'<button class="button secondary" data-vc-save-anyway>Save anyway</button>' +
							'<button class="button" data-vc-reload>Reload from Salesforce</button>' +
						'</div>' +
					'</div>';
				document.body.appendChild(overlay);
				const cleanup = () => overlay.remove();
				overlay.querySelectorAll('[data-vc-close]').forEach((el) =>
					el.addEventListener('click', cleanup)
				);
				overlay.querySelector('[data-vc-reload]').addEventListener('click', async () => {
					cleanup();
					try {
						const r = await csrfFetch('/api/canvas/' + encodeURIComponent(canvasState.currentCanvas.id), { credentials: 'same-origin' });
						const data = await r.json().catch(() => null);
						if (!r.ok) {
throw new Error((data && data.error) || 'HTTP ' + r.status);
}
						await applyCanvasPayload(data.payload || {}, { merge: false, ownedByMe: !!data.ownedByMe });
						_setStaleRefsFromLoad(data.staleRefs);
						canvasState.currentCanvas = Object.assign({}, canvasState.currentCanvas, {
							versionId: data.versionId || null,
							title: data.title || canvasState.currentCanvas.title,
							ownedByMe: !!data.ownedByMe,
						});
						try {
 rehydrateSessionDraftValues(canvasState.currentCanvas.id);
} catch (err) {
 window.ORGLOOM_capture && window.ORGLOOM_capture(err, { where: 'canvas-save-load.js/reload/rehydrateSession' }); 
}
						showBulkToast('Reloaded the latest version from Salesforce.');
					} catch (err) {
						showBulkToast('Reload failed: ' + (err.message || err), 'error');
					}
				});
				overlay.querySelector('[data-vc-save-anyway]').addEventListener('click', async () => {
					cleanup();
					try {
						const r = await csrfFetch('/api/canvas/' + encodeURIComponent(canvasState.currentCanvas.id), {
							method: 'PUT',
							credentials: 'same-origin',
							headers: { 'Content-Type': 'application/json' },
							// No expectedVersionId: explicit override. Server
							// last-write-wins behavior.
							body: JSON.stringify({ payload: originalPayload }),
						});
						const data = await r.json().catch(() => ({}));
						if (!r.ok) {
throw new Error(data && data.error || 'HTTP ' + r.status);
}
						if (data && data.versionId) {
							canvasState.currentCanvas = Object.assign({}, canvasState.currentCanvas, { versionId: data.versionId });
						}
						showBulkToast('Saved over the elsewhere-edits.');
					} catch (err) {
						showBulkToast('Save failed: ' + (err.message || err), 'error');
					}
				});
				setTimeout(() => overlay.querySelector('[data-vc-reload]').focus(), 0);
			}
			
			// File export. Downloads schema + ALL records (drafts and
			// existing) as JSON. When the canvas has loaded-existing
			// records, surface a one-question dialog asking whether to
			// preserve the loadedFromId links (same-org round-trip) or
			// strip them (portable file; existing records re-import as
			// drafts). On a drafts-only canvas there's nothing to ask
			// Begin a cross-org migration. Stashes the canvas for this tab
			// session, then routes
			// the user to the destination-org picker. On arrival at the new
			// org, app.js boot detects the pending migration and restores
			// the canvas (loaded-from-source records converted to drafts,
			// since source Ids don't carry across orgs). Phase 0: this lands
			// the user back on the canvas to review + upload; later phases
			// add the migrate-mode annotation/reconciliation layer.
			async function beginMigration() {
				const real = canvasState.bulkRecords.filter((r) => !r.isTypeNode);
				if (real.length === 0) {
					showBulkToast('Add or load records before migrating to another org.', 'error');
					return;
				}
				const ok = await showConfirmDialog({
					title: 'Migrate this canvas to another Salesforce org?',
					message:
						'Your canvas is kept for this tab while you switch orgs. Keep this tab open until the migration finishes. ' +
						'Next you’ll connect or switch to the destination org and this canvas comes with you to review and upload. ' +
						'Records keep their field values but are recreated as new records in the destination (a source record’s Salesforce Id doesn’t exist in another org).',
					confirmLabel: 'Save and choose destination',
					cancelLabel: 'Cancel',
				});
				if (!ok) {
					return;
				}
				const os = window.Orgloom && window.Orgloom.canvasOrgSwitch;
				const stashed = os && typeof os.migrationStash === 'function'
					? os.migrationStash({ status: 'awaiting-target' })
					: false;
				if (!stashed) {
					showBulkToast(
						'Couldn’t save this canvas for migration: it may be too large for this browser’s storage. Export it to a file instead, then re-import after switching orgs.',
						'error',
					);
					return;
				}
				// Route to the destination-org picker. Prefer the in-app
				// connections modal (pick a saved org or add a new one);
				// fall back to the connect page on canvas-standalone where
				// the modal isn't mounted.
				if (window.Orgloom && window.Orgloom.sfConnectionsModal
					&& typeof window.Orgloom.sfConnectionsModal.open === 'function') {
					window.Orgloom.sfConnectionsModal.open();
				} else {
					window.location.assign('/connect');
				}
			}

			// about and we skip straight to the download.
			async function promptFileExport() {
				const real = canvasState.bulkRecords.filter((r) => !r.isTypeNode);
				if (real.length === 0) {
					showBulkToast('Add records to the canvas before exporting.', 'error');
					return;
				}
				const loadedCount = real.filter((r) => !!r.loadedFromId).length;
				let preserveLoadedLinks = false;
				if (loadedCount > 0) {
					const choice = await _showExportOptionsDialog({ loadedCount, totalCount: real.length });
					if (choice == null) {
return;
} // user cancelled
					preserveLoadedLinks = !!choice.preserveLoadedLinks;
				}
				const name = (canvasState.currentCanvas && canvasState.currentCanvas.title)
					? canvasState.currentCanvas.title
					: ('orgloom-canvas-' + new Date().toISOString().slice(0, 10));
				downloadTemplate(name, false, { preserveLoadedLinks });
			}

			// Inline checkbox dialog for the Export action. Surfaces only
			// when the canvas has loaded-existing records (otherwise
			// there's no decision to make). Resolves to null on cancel
			// or { preserveLoadedLinks: boolean } on confirm.
			function _showExportOptionsDialog({ loadedCount, totalCount }) {
				return new Promise((resolve) => {
					document.querySelectorAll('.app-export-options-modal').forEach((el) => el.remove());
					const modal = document.createElement('div');
					modal.className = 'modal app-export-options-modal';
					const recordWord = loadedCount === 1 ? 'record' : 'records';
					modal.innerHTML =
						'<div class="modal-overlay" data-eo-close></div>' +
						'<div class="modal-body" style="max-width:480px">' +
							'<div class="modal-header">' +
								'<h3>Export canvas to file</h3>' +
								'<button class="modal-close" data-eo-close>&times;</button>' +
							'</div>' +
							'<div class="modal-content">' +
								'<p>Download all ' + totalCount + ' record' + (totalCount === 1 ? '' : 's') + ' on this canvas as a JSON file (schema, drafts, associations).</p>' +
								'<label style="display:flex;gap:0.6em;align-items:flex-start;margin-top:0.8em;padding:0.7em;border:1px solid var(--border);border-radius:4px;cursor:pointer">' +
									'<input type="checkbox" id="eo-preserve-loaded" style="margin-top:0.2em">' +
									'<span style="flex:1">' +
										'<strong>Keep links to ' + loadedCount + ' existing Salesforce ' + recordWord + '</strong>' +
										'<div class="tag" style="margin-top:0.25em;font-size:0.78rem">' +
											'On: re-import into the same Salesforce org reconnects to the live records (good for refresh-recover).<br>' +
											'Off: existing records re-import as fresh drafts. Portable across orgs; re-importing into the same org may create duplicates.' +
										'</div>' +
									'</span>' +
								'</label>' +
							'</div>' +
							'<div class="modal-footer">' +
								'<button class="button secondary" data-eo-cancel>Cancel</button>' +
								'<button class="button" data-eo-confirm>Download</button>' +
							'</div>' +
						'</div>';
					document.body.appendChild(modal);
					let settled = false;
					const finish = (value) => {
						if (settled) {
return;
}
						settled = true;
						document.removeEventListener('keydown', onKey);
						modal.remove();
						resolve(value);
					};
					const onKey = (e) => {
						if (e.key === 'Escape') {
finish(null);
} else if (e.key === 'Enter') {
							const cb = modal.querySelector('#eo-preserve-loaded');
							finish({ preserveLoadedLinks: !!(cb && cb.checked) });
						}
					};
					document.addEventListener('keydown', onKey);
					modal.querySelectorAll('[data-eo-close], [data-eo-cancel]').forEach((el) =>
						el.addEventListener('click', () => finish(null)),
					);
					modal.querySelector('[data-eo-confirm]').addEventListener('click', () => {
						const cb = modal.querySelector('#eo-preserve-loaded');
						finish({ preserveLoadedLinks: !!(cb && cb.checked) });
					});
					setTimeout(() => modal.querySelector('[data-eo-confirm]').focus(), 0);
				});
			}
			
			// Shown when the server rejects a canvas save with
			// `sf-content-version-create-denied`: the user's SF
			// profile lacks Create on ContentVersion (typically
			// the "Salesforce CRM Content User" checkbox or the
			// "Salesforce Standard" permission set). Explains what
			// to ask the admin for + offers Export-to-JSON so the
			// user isn't blocked from preserving their work.
			async function _showContentPermDeniedDialog(actionableMessage, sfError) {
				document.querySelectorAll('.modal.content-perm-modal').forEach((el) => el.remove());
				const modal = document.createElement('div');
				modal.className = 'modal content-perm-modal';
				const sfErrorSnippet = sfError
					? '<details style="margin-top:0.8em"><summary class="tag">Raw Salesforce error</summary><pre style="margin:0.4em 0 0;font-size:0.78rem;color:var(--ink-faint);white-space:pre-wrap">' + escapeHtml(String(sfError).slice(0, 600)) + '</pre></details>'
					: '';
				modal.innerHTML =
					'<div class="modal-overlay" data-cp-close></div>' +
					'<div class="modal-body" style="max-width:540px">' +
						'<div class="modal-header">' +
							'<h3>Salesforce won’t accept this save</h3>' +
							'<button class="modal-close" data-cp-close>&times;</button>' +
						'</div>' +
						'<div class="modal-content">' +
							'<p>' + escapeHtml(actionableMessage || 'Your Salesforce user can’t create files in this org.') + '</p>' +
							'<p class="tag" style="margin-top:0.8em">Ask your Salesforce admin to do one of:</p>' +
							'<ul style="margin:0.4em 0 0.8em 1.2em;font-size:0.88rem">' +
								'<li>Enable the <strong>Salesforce CRM Content User</strong> checkbox on your user record (User → Edit), OR</li>' +
								'<li>Assign you the <strong>Salesforce Standard</strong> permission set (Setup → Permission Sets), OR</li>' +
								'<li>Grant your profile <strong>Create</strong> on the <strong>ContentVersion</strong> object.</li>' +
							'</ul>' +
							'<p class="tag" style="margin-top:0.8em">In the meantime, you can <strong>export this canvas to a JSON file</strong> and re-import it next session; your work won’t be lost. Records you upload directly to Salesforce don’t need Content permissions, so the rest of Org Loom keeps working.</p>' +
							sfErrorSnippet +
						'</div>' +
						'<div class="modal-footer" style="justify-content:flex-end;gap:0.5em">' +
							'<button class="button secondary" data-cp-close>Close</button>' +
							'<button class="button" data-cp-export>Export to JSON</button>' +
						'</div>' +
					'</div>';
				document.body.appendChild(modal);
				return new Promise((resolve) => {
					function cleanup() {
						modal.remove();
						document.removeEventListener('keydown', onKey);
						resolve();
					}
					function onKey(e) {
 if (e.key === 'Escape') {
cleanup();
} 
}
					modal.querySelectorAll('[data-cp-close]').forEach((el) => el.addEventListener('click', cleanup));
					const exportBtn = modal.querySelector('[data-cp-export]');
					if (exportBtn) {
						exportBtn.addEventListener('click', () => {
							try {
 promptFileExport(); 
} catch (e) { /* swallow */ }
							cleanup();
						});
					}
					document.addEventListener('keydown', onKey);
				});
			}
			
			// Free-plan saved-canvas-cap dialog. Triggered by the POST
			// /api/canvas 402 when the user's owned-canvas count is at
			// the plan's saved_canvas_cap. Offers two paths forward:
			// open Saved Canvases to delete one (frees a slot), or
			// upgrade to Pro for unlimited saves. Export-to-JSON is a
			// belt-and-suspenders fallback so this session's work isn't
			// trapped if the user wants to bail entirely.
			async function _showSavedCanvasCapDialog(data) {
				document.querySelectorAll('.modal.saved-cap-modal').forEach((el) => el.remove());
				const used = data && data.savedCount != null ? data.savedCount : '?';
				const cap = data && data.savedCap != null ? data.savedCap : '?';
				const planLabel = data && data.currentPlan === 'free' ? 'Inactive' : (data && data.currentPlan) || 'your';
				const modal = document.createElement('div');
				modal.className = 'modal saved-cap-modal';
				modal.innerHTML =
					'<div class="modal-overlay" data-sc-close></div>' +
					'<div class="modal-body" style="max-width:520px">' +
						'<div class="modal-header">' +
							'<h3>You’ve hit the ' + escapeHtml(String(planLabel)) + ' plan’s saved-canvas limit</h3>' +
							'<button class="modal-close" data-sc-close>&times;</button>' +
						'</div>' +
						'<div class="modal-content">' +
							'<p>You have <strong>' + escapeHtml(String(used)) + ' of ' + escapeHtml(String(cap)) + '</strong> saved canvases on the ' + escapeHtml(String(planLabel)) + ' plan.</p>' +
							'<p class="tag" style="margin-top:0.6em">Open <strong>Save → Browse saved</strong> from the toolbar to delete one you no longer need, export this canvas as JSON to re-import next session, or upgrade to <strong>Pro</strong> for unlimited saves.</p>' +
						'</div>' +
						'<div class="modal-footer" style="justify-content:flex-end;gap:0.5em">' +
							'<button class="button secondary" data-sc-export>Export to JSON</button>' +
							'<a class="button" href="/workspace/upgrade">Upgrade to Pro →</a>' +
						'</div>' +
					'</div>';
				document.body.appendChild(modal);
				return new Promise((resolve) => {
					function cleanup() {
						modal.remove();
						document.removeEventListener('keydown', onKey);
						resolve();
					}
					function onKey(e) {
 if (e.key === 'Escape') {
cleanup();
} 
}
					modal.querySelectorAll('[data-sc-close]').forEach((el) => el.addEventListener('click', cleanup));
					const exportBtn = modal.querySelector('[data-sc-export]');
					if (exportBtn) {
						exportBtn.addEventListener('click', () => {
							try {
 promptFileExport(); 
} catch (e) { /* swallow */ }
							cleanup();
						});
					}
					document.addEventListener('keydown', onKey);
				});
			}
			
			// Back-compat shim: anything that used to call showTemplatesMenu
			// gets routed to the export view (the historical default).
			function showTemplatesMenu(triggerEl) {
 showSaveMenu(triggerEl); 
}
			
			// Browse SF-Files-stored canvases. Lists everything the
			// loading user has access to via SF's standard Files
			// sharing; "Mine" badges call out files the user owns
			// (drafts come back full on load) vs. ones shared with
			// them (drafts auto-stripped server-side).
			// Reusable Salesforce user picker. Builds a typeahead-style
			// search rooted in `hostEl` (caller passes a container).
			// Hits /api/sf/users/search debounced on input. Calls
			// `onPick({ id, name, email, username })` when the sender
			// commits to a result. Used both by the canvas-share
			// modal (pick a recipient) and (in PR D6) the slot
			// assignee picker.
			//
			// Empty query opens with the first 20 active standard
			// users by Name so the picker is useful before typing.
			// Server filters: IsActive = true, UserType = Standard,
			// Email != null.
			async function showBrowseSavedMenu(triggerEl) {
				const { pop, cleanup } = _openAnchoredPopup(triggerEl, 440);
				const teamName = (getCurrentTeam() && getCurrentTeam().name) || '';
				const headerLabel = teamName ? 'Saved canvases in ' + escapeHtml(teamName) : 'Saved canvases';
				pop.innerHTML =
					'<div class="tpl-header">' + headerLabel + '</div>' +
					'<div class="tpl-local-list" id="browse-sf-list"><div class="tpl-empty">Loading\u2026</div></div>' +
					'<div class="tpl-footer">Canvases are scoped to the workspace you\u2019re viewing and your active Salesforce connection.</div>';
				const list = pop.querySelector('#browse-sf-list');
				try {
					const r = await csrfFetch('/api/canvas', { credentials: 'same-origin' });
					const data = await r.json();
					if (!r.ok) {
throw new Error(data && data.error || 'HTTP ' + r.status);
}
					const items = (data && data.items) || [];
					if (items.length === 0) {
						list.innerHTML = '<div class="tpl-empty">No saved canvases in ' + escapeHtml(teamName || 'this workspace') + ' yet. Use Save &rarr; "Save as new canvas" to put one here. <a href="/docs/walkthroughs/saving-canvases" target="_blank" rel="noopener" class="empty-doclink">How saving works &rarr;</a></div>';
						return;
					}
			
					// Workspace partitioning is gone post-rewrite:
					// connections aren't workspace-bound anymore (no
					// users.bound_team_id), so /api/canvas returns
					// every canvas the active SF user can see. The
					// "other workspaces" disclosure section is empty
					// in the new model; kept around so the rest of
					// the render path still works without restructuring.
					const inWorkspace = items.slice();
					const other = [];
			
					function _renderSavedRow(t, opts) {
						const showWsBadge = !!(opts && opts.showWsBadge);
						const date = t.updatedAt ? new Date(t.updatedAt).toLocaleString() : '';
						// "ACTIVE" tag on the row matching the currently-
						// open canvas so the user can tell at a glance
						// which canvas they're already viewing: avoids
						// the "did I already load this?" re-load.
						const isActive = !!(canvasState.currentCanvas && canvasState.currentCanvas.id === t.id);
						const activeTag = isActive
							? '<span class="tpl-scope-tag tpl-scope-tag--active" title="This is the canvas you currently have open">ACTIVE</span>'
							: '';
						// Role-driven scope tag. Owner sees MINE; editors
						// see EDITOR; contributors and OWD-backed
						// fallthrough see CONTRIBUTOR. Tells the user
						// what they'll be able to do BEFORE clicking
						// Load, saving a "wait, why can't I save this?"
						// surprise.
						let ownTag;
						if (t.ownedByMe) {
							ownTag = '<span class="tpl-scope-tag tpl-scope-tag--personal">MINE</span>';
						} else if (t.role === 'editor') {
							ownTag = '<span class="tpl-scope-tag tpl-scope-tag--editor">EDITOR</span>';
						} else {
							ownTag = '<span class="tpl-scope-tag tpl-scope-tag--template">CONTRIBUTOR</span>';
						}
						// Last-activity indicator on owned canvases. Pulled
						// from Activity History: canvas_slot_filled
						// (contributor fills) + canvas_edited_by_editor
						// (editor saves). Most recent across both wins.
						// Verb adapts to the activity kind so the owner
						// sees "filled" vs "edited" at a glance.
						let fillTag = '';
						const activity = t.lastActivity || t.lastFillActivity;
						if (t.ownedByMe && activity && activity.at) {
							const rel = _formatRelativeTime(activity.at);
							const who = (activity.byName || activity.recipientName)
								|| (activity.byEmail || activity.recipientEmail)
								|| 'a teammate';
							const verb = activity.kind === 'edit' ? 'Last edited' : 'Last filled';
							fillTag = '<div class="tpl-last-fill" title="' +
								escapeHtml(new Date(activity.at).toLocaleString()) +
								'">' + escapeHtml(verb + ' ' + rel + ' by ' + who) + '</div>';
						}
						// Workspace badge: only on rows in the "other
						// workspaces" disclosure. In-workspace rows
						// drop it (the popup heading already names
						// the workspace once).
						const wsBadge = showWsBadge && t.ownerBoundTeamName
							? '<span class="tpl-ws-badge" title="This canvas is bound to ' + escapeHtml(t.ownerBoundTeamName) + '. Loading it will switch your view to that workspace.">' + escapeHtml(t.ownerBoundTeamName) + '</span>'
							: '';
						return '<div class="tpl-item' + (isActive ? ' tpl-item--active' : '') + '">' +
							'<div class="tpl-info">' +
								'<div class="tpl-name">' + escapeHtml(t.title) + ' ' + activeTag + ownTag + wsBadge + '</div>' +
								'<div class="tpl-meta">' + escapeHtml(date) + '</div>' +
								fillTag +
							'</div>' +
							(t.ownedByMe ? '<button type="button" class="tpl-share" data-tpl-link="' + escapeHtml(t.id) + '" data-tpl-name="' + escapeHtml(t.title) + '" title="Email a magic-link share to a teammate">Share\u2026</button>' : '') +
							'<button type="button" class="tpl-load" data-tpl-load="' + escapeHtml(t.id) + '"' + (isActive ? ' title="Reload this canvas from Salesforce"' : '') + '>' + (isActive ? 'Reload' : 'Load') + '</button>' +
							(t.ownedByMe ? '<button type="button" class="tpl-del" data-tpl-del="' + escapeHtml(t.id) + '" title="Delete">\u00D7</button>' : '') +
						'</div>';
					}
			
					const inWsHtml = inWorkspace.length > 0
						? inWorkspace.map((t) => _renderSavedRow(t, { showWsBadge: false })).join('')
						: '<div class="tpl-empty">No canvases in ' + escapeHtml(teamName || 'this workspace') + ' yet. Use Export &rarr; "Save canvas" to put one here.</div>';
			
					let otherHtml = '';
					if (other.length > 0) {
						// Open by default when nothing's in the
						// current workspace; otherwise the popup
						// looks empty when the user actually has
						// canvases, just bound to other workspaces.
						const openByDefault = inWorkspace.length === 0;
						const otherRows = other.map((t) => _renderSavedRow(t, { showWsBadge: true })).join('');
						const summary = other.length + ' canvas' + (other.length === 1 ? '' : 'es') + ' in other workspaces';
						otherHtml =
							'<details class="tpl-other"' + (openByDefault ? ' open' : '') + '>' +
								'<summary class="tpl-other-summary">' + escapeHtml(summary) + '</summary>' +
								'<p class="tpl-other-tag">Loading one of these will switch your view to its workspace.</p>' +
								'<div class="tpl-other-list">' + otherRows + '</div>' +
							'</details>';
					}
			
					list.innerHTML = inWsHtml + otherHtml;
					pop.querySelectorAll('[data-tpl-load]').forEach((b) => {
						b.addEventListener('click', async () => {
							cleanup();
							let mode = 'replace';
							const hasContent = canvasState.bulkRecords.length > 0 || canvasState.selectedObjects.length > 0;
							if (hasContent) {
								mode = await showReplaceOrMergeDialog();
								if (mode === 'cancel') {
return;
}
							}
							try {
								const id = b.dataset.tplLoad;
								const tr = await csrfFetch('/api/canvas/' + encodeURIComponent(id), { credentials: 'same-origin' });
								const td = await tr.json();
								if (!tr.ok) {
throw new Error(td && td.error || 'HTTP ' + tr.status);
}
								await applyCanvasPayload(td.payload || {}, { merge: mode === 'merge', ownedByMe: !!td.ownedByMe });
								// Rehydrate session-cached draft values
								// after the fresh load. Replace mode
								// clobbers the in-memory canvas; merge
								// preserves existing records but the
								// imported drafts can still benefit
								// from cached values if the user had
								// the same canvas open earlier.
								try {
 rehydrateSessionDraftValues(id);
} catch (err) {
 window.ORGLOOM_capture && window.ORGLOOM_capture(err, { where: 'canvas-save-load.js/loadFromList/rehydrateSession' }); 
}
								// Replace mode: reset stale-ref list to
								// the new canvas's probe result. Merge mode:
								// add any newly-probed stale refs without
								// clobbering the existing set (the surviving
								// records from the prior canvas could also be
								// stale).
								if (mode !== 'merge') {
									_setStaleRefsFromLoad(td.staleRefs);
								} else if (Array.isArray(td.staleRefs)) {
									// Merge mode: ADD the merged canvas's stale refs
									// to the existing set (don't clobber; the prior
									// canvas's surviving records may also be stale).
									// The previous code referenced `_staleSfIds`, a
									// private Set inside stale-ref.js that isn't in
									// scope here: a ReferenceError that surfaced as a
									// false "Load failed" after a SUCCESSFUL merge and
									// skipped the canvas_load_sf audit. Use the exported
									// _addStaleRefIds (normalizes ids + re-renders), and
									// filter 'no-access' the same way
									// _setStaleRefsFromLoad does (permission gap, not a
									// deletion, avoiding a misleading "deleted" badge).
									const mergeStaleIds = td.staleRefs
										.filter((s) => s && s.sfId && (s.reason || 'unknown') !== 'no-access')
										.map((s) => s.sfId);
									_addStaleRefIds(mergeStaleIds);
								}
								// On replace, the saved canvas IS the canvas now
								// open: track it so Save overwrites in place.
								// On merge, we're combining canvases; "current"
								// becomes ambiguous, so leave it as-is (or clear
								// if there was no prior current canvas).
								if (mode !== 'merge') {
									canvasState.currentCanvas = { id, title: td.title || '', ownedByMe: !!td.ownedByMe, versionId: td.versionId || null };
									_watchProposalsForCurrentCanvas();
								}
								pingAuditEvent('canvas_load_sf', {
									recordCount: ((td.payload && td.payload.drafts) || []).length + ((td.payload && td.payload.loadedRecords) || []).length,
									payload: { contentDocumentId: id, ownedByMe: !!td.ownedByMe, mode },
								});
							} catch (e) {
								showBulkToast('Load failed: ' + (e.message || e), 'error');
							}
						});
					});
					pop.querySelectorAll('[data-tpl-link]').forEach((b) => {
						b.addEventListener('click', (ev) => {
							ev.stopPropagation();
							const canvasId = b.dataset.tplLink;
							const canvasName = b.dataset.tplName || '';
							openCanvasEmailLinkModal(canvasId, canvasName);
						});
					});
					pop.querySelectorAll('[data-tpl-del]').forEach((b) => {
						b.addEventListener('click', async (ev) => {
							ev.stopPropagation();
							// Resolve a friendly confirm message: pull the
							// canvas title from its row in the popup so the
							// confirm reads "Delete 'Q3 Onboarding'?" rather
							// than the bare generic prompt.
							const id = b.dataset.tplDel;
							const row = b.closest('.tpl-item');
							// Prefer the canvas name stashed on the
							// share button's data-tpl-name attribute
							// (always present on owner rows alongside
							// delete). Falls back to scraping the
							// .tpl-name text and stripping trailing
							// role + workspace badges.
							const shareBtn = row && row.querySelector('[data-tpl-name]');
							let title = shareBtn ? shareBtn.getAttribute('data-tpl-name') : null;
							if (!title) {
								const titleEl = row && row.querySelector('.tpl-name');
								title = titleEl ? titleEl.textContent
									.replace(/\s+(MINE|EDITOR|CONTRIBUTOR|YOUR|SHARED)(\s+\S+)?$/, '')
									.trim() : null;
							}
							const ok = await showConfirmDialog({
								title: 'Delete saved canvas',
								message: title
									? 'Delete "' + title + '"? This removes the canvas from Salesforce. Anyone you shared it with will lose access.'
									: 'Delete this saved canvas? This removes it from Salesforce. Anyone you shared it with will lose access.',
								confirmLabel: 'Delete',
								cancelLabel: 'Cancel',
								danger: true,
							});
							if (!ok) {
return;
}
							try {
								const dr = await csrfFetch('/api/canvas/' + encodeURIComponent(id), {
									method: 'DELETE',
									credentials: 'same-origin',
								});
								const dd = await dr.json().catch(() => ({}));
								if (!dr.ok) {
throw new Error(dd && dd.error || 'HTTP ' + dr.status);
}
								// In-place removal: drop the row's DOM
								// element instead of teardown + refetch.
								// Fixes the collapse/re-expand flash users
								// saw when the popup unmounted, fetched
								// the list again, and remounted.
								if (row && row.parentNode) {
									row.parentNode.removeChild(row);
								}
								// If the list is now empty, reflect that.
								const listEl = pop.querySelector('.tpl-local-list');
								if (listEl && listEl.querySelectorAll('.tpl-item').length === 0) {
									listEl.innerHTML = '<div class="tpl-empty">No saved canvases in ' + escapeHtml(teamName || 'this workspace') + ' yet. Use Save &rarr; "Save as new canvas" to put one here. <a href="/docs/walkthroughs/saving-canvases" target="_blank" rel="noopener" class="empty-doclink">How saving works &rarr;</a></div>';
								}
							} catch (e) {
								showBulkToast('Delete failed: ' + (e.message || e), 'error');
							}
						});
					});
				} catch (e) {
					list.innerHTML = '<div class="tpl-empty">Failed to load: ' + escapeHtml(e.message || String(e)) + '</div>';
				}
			}
			
			// Prompt for a name + run the selected save flow. If any records
			// are loaded from SF, route through the per-object consent modal
			// before building the payload: keeps real org data from sneaking
			// into a fixture file the user might share externally. Schema-only
			// exports skip that consent step since no record values leave.
			// Server-side schema save (personal workspace or team). File
			// exports go through promptFileExport instead; that flow
			// owns the schema-vs-records scope picker.

			return {
				showSaveMenu: showSaveMenu,
				promptCanvasSave: promptCanvasSave,
				forkCanvasAsNew: forkCanvasAsNew,
				saveExistingCanvas: saveExistingCanvas,
				handleCanvasVersionMismatch: handleCanvasVersionMismatch,
				promptFileExport: promptFileExport,
				beginMigration: beginMigration,
				_showSavedCanvasCapDialog: _showSavedCanvasCapDialog,
				_showContentPermDeniedDialog: _showContentPermDeniedDialog,
				showTemplatesMenu: showTemplatesMenu,
				showBrowseSavedMenu: showBrowseSavedMenu,
			};
		},
	};
})();
