(function () {
	'use strict';
	// Saves encrypted canvases to Salesforce and restores them into the current browser session.

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.canvasSaveLoad = {
		mount: function mount(deps) {
			const required = [
				'canvasState',
				'csrfFetch',
				'escapeHtml',
				'showBulkToast',
				'showConfirmDialog',
				'showPromptModal',
				'showReplaceOrMergeDialog',
				'_openAnchoredPopup',
				'_formatRelativeTime',
				'_setStaleRefsFromLoad',
				'_addStaleRefIds',
				'_staleIdKey',
				'_watchProposalsForCurrentCanvas',
				'applyCanvasPayload',
				'buildCanvasPayload',
				'downloadTemplate',
				'openCanvasEmailLinkModal',
				'pingAuditEvent',
				'getCurrentTeam',
				'openExportCsvModal',
				'renderBulkView',
				'summarizeCanvasContent',
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
			const summarizeCanvasContent = deps.summarizeCanvasContent;
			const notePresenceLocalSave = deps.notePresenceLocalSave;
			const rehydrateSessionDraftValues = deps.rehydrateSessionDraftValues;
			const _hasCap = deps._hasCap;
			const clearAutosave = typeof deps.clearAutosave === 'function' ? deps.clearAutosave : function () {};

			function showSaveMenu(triggerEl) {
				const { pop, cleanup } = _openAnchoredPopup(triggerEl, 380);
				const hasAny = canvasState.selectedObjects.length > 0;
				const actionDisabled = hasAny ? '' : ' disabled';
				const _hasRecords = canvasState.bulkRecords.some((r) => !r.isTypeNode);
				const exportDisabled = _hasRecords ? '' : ' disabled';
				const hasCurrent = !!(canvasState.currentCanvas && canvasState.currentCanvas.id);
				const ownsCurrent = !!(canvasState.currentCanvas && canvasState.currentCanvas.ownedByMe);
				const safeTitle = hasCurrent ? escapeHtml(canvasState.currentCanvas.title || '(untitled)') : '';
				let primarySaveBtn = '';
				if (hasCurrent && ownsCurrent) {
					primarySaveBtn =
						'<button type="button" class="tpl-action" data-tpl-action="save-existing"' +
						actionDisabled +
						'>' +
						'Save changes <span class="tpl-action-sub">overwrite \u201c' +
						safeTitle +
						'\u201d in Salesforce Files</span>' +
						'</button>';
				} else if (hasCurrent && !ownsCurrent) {
					primarySaveBtn =
						'<button type="button" class="tpl-action" data-tpl-action="fork-canvas"' +
						actionDisabled +
						'>' +
						'Fork as new canvas <span class="tpl-action-sub">your own editable copy of \u201c' +
						safeTitle +
						'\u201d</span>' +
						'</button>';
				}
				const _canExportCanvas = _hasCap('export-canvas');
				const _canExportRecords = _hasCap('export-records');
				const _exportJsonBtn = _canExportCanvas
					? '<button type="button" class="tpl-action" data-tpl-action="export-file"' +
						exportDisabled +
						'>Export canvas (JSON) <span class="tpl-action-sub">lossless, re-import to restore exactly</span></button>'
					: '';
				const _exportCsvBtn = _canExportRecords
					? '<button type="button" class="tpl-action" data-tpl-action="export-csv"' +
						exportDisabled +
						'>Export records (CSV) <span class="tpl-action-sub">records only, opens in Excel</span></button>'
					: '';
				const _downloadHeader =
					_canExportCanvas || _canExportRecords
						? '<div class="tpl-header">Download to your machine</div>'
						: '';
				pop.innerHTML =
					'<div class="tpl-header">Save this canvas</div>' +
					primarySaveBtn +
					'<button type="button" class="tpl-action" data-tpl-action="save-new">Save as new canvas <span class="tpl-action-sub">a fresh saved canvas in your Salesforce org</span></button>' +
					_downloadHeader +
					_exportJsonBtn +
					_exportCsvBtn;
				pop.querySelectorAll('[data-tpl-action]').forEach((b) => {
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

			async function promptCanvasSave(opts = {}) {
				// The browser sends plaintext over TLS; the server encrypts before writing Salesforce Files.
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
					showBulkToast(e.message || 'Build failed', 'error');
					return;
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
					clearAutosave();
					if (data && data.id) {
						canvasState.currentCanvas = {
							id: data.id,
							title: name,
							ownedByMe: true,
							versionId: data.versionId || null,
						};
						renderBulkView();
						_watchProposalsForCurrentCanvas();
						if (window.Orgloom && window.Orgloom.canvasState && window.Orgloom.canvasState.clearDraft) {
							window.Orgloom.canvasState.clearDraft();
						}
					}
					pingAuditEvent('canvas_save_sf', {
						recordCount: (payload.loadedRecords || []).length + (payload.drafts || []).length,
						payload: { name, contentDocumentId: data.id },
					});
					if (typeof opts.afterSave === 'function' && data && data.id) {
						try {
							opts.afterSave({ id: data.id, title: name });
						} catch (cbErr) {
							/* noop: save succeeded */
						}
					}
				} catch (e) {
					showBulkToast('Save failed: ' + (e.message || e), 'error');
				}
			}

			async function forkCanvasAsNew() {
				const sourceTitle = (canvasState.currentCanvas && canvasState.currentCanvas.title) || '';
				await promptCanvasSave({
					title: 'Fork as new canvas',
					defaultName: sourceTitle ? 'Fork of ' + sourceTitle : '',
					submitText: 'Fork',
				});
			}

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
					showBulkToast(e.message || 'Build failed', 'error');
					return;
				}
				try {
					// Optimistic version IDs prevent one collaborator from silently overwriting another.
					try {
						notePresenceLocalSave();
					} catch (_) {}
					const r = await csrfFetch('/api/canvas/' + encodeURIComponent(canvasState.currentCanvas.id), {
						method: 'PUT',
						credentials: 'same-origin',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							payload,
							expectedVersionId: canvasState.currentCanvas.versionId || null,
						}),
					});
					const data = await r.json().catch(() => ({}));
					if (
						r.status === 409 &&
						data &&
						(data.error === 'version-mismatch' || data.code === 'version_mismatch')
					) {
						handleCanvasVersionMismatch(data, payload);
						return;
					}
					if (
						r.status === 403 &&
						data &&
						(data.error === 'sf-content-version-create-denied' ||
							data.error === 'sf-content-document-edit-denied')
					) {
						await _showContentPermDeniedDialog(data.message || '', data.sfError || '');
						return;
					}
					if (r.status === 403 && data && data.message && data.error) {
						showBulkToast(data.message, 'error');
						return;
					}
					if (!r.ok) {
						throw new Error((data && (data.message || data.error)) || 'HTTP ' + r.status);
					}
					const titleForToast = (data && data.title) || canvasState.currentCanvas.title || 'canvas';
					if (data && data.versionId) {
						canvasState.currentCanvas = Object.assign({}, canvasState.currentCanvas, {
							versionId: data.versionId,
						});
					}
					showBulkToast('Updated \u201c' + titleForToast + '\u201d.');
					clearAutosave();
					pingAuditEvent('canvas_save_sf', {
						recordCount: (payload.loadedRecords || []).length + (payload.drafts || []).length,
						payload: {
							name: titleForToast,
							contentDocumentId: canvasState.currentCanvas.id,
							mode: 'update',
						},
					});
				} catch (e) {
					showBulkToast('Save failed: ' + (e.message || e), 'error');
				}
			}

			function handleCanvasVersionMismatch(serverPayload, originalPayload) {
				// Keep both safe paths explicit: reload the latest version or deliberately overwrite it.
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
				overlay.querySelectorAll('[data-vc-close]').forEach((el) => el.addEventListener('click', cleanup));
				overlay.querySelector('[data-vc-reload]').addEventListener('click', async () => {
					cleanup();
					try {
						const r = await csrfFetch('/api/canvas/' + encodeURIComponent(canvasState.currentCanvas.id), {
							credentials: 'same-origin',
						});
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
							window.ORGLOOM_capture &&
								window.ORGLOOM_capture(err, { where: 'canvas-save-load.js/reload/rehydrateSession' });
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
							body: JSON.stringify({ payload: originalPayload }),
						});
						const data = await r.json().catch(() => ({}));
						if (!r.ok) {
							throw new Error((data && data.error) || 'HTTP ' + r.status);
						}
						if (data && data.versionId) {
							canvasState.currentCanvas = Object.assign({}, canvasState.currentCanvas, {
								versionId: data.versionId,
							});
						}
						showBulkToast('Saved over the elsewhere-edits.');
					} catch (err) {
						showBulkToast('Save failed: ' + (err.message || err), 'error');
					}
				});
				setTimeout(() => overlay.querySelector('[data-vc-reload]').focus(), 0);
			}

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
				const stashed =
					os && typeof os.migrationStash === 'function'
						? os.migrationStash({ status: 'awaiting-target' })
						: false;
				if (!stashed) {
					showBulkToast(
						'Couldn’t save this canvas for migration: it may be too large for this browser’s storage. Export it to a file instead, then re-import after switching orgs.',
						'error',
					);
					return;
				}
				if (
					window.Orgloom &&
					window.Orgloom.sfConnectionsModal &&
					typeof window.Orgloom.sfConnectionsModal.open === 'function'
				) {
					window.Orgloom.sfConnectionsModal.open();
				} else {
					window.location.assign('/connect');
				}
			}

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
				const name =
					canvasState.currentCanvas && canvasState.currentCanvas.title
						? canvasState.currentCanvas.title
						: 'orgloom-canvas-' + new Date().toISOString().slice(0, 10);
				downloadTemplate(name, false, { preserveLoadedLinks });
			}

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
						'<p>Download all ' +
						totalCount +
						' record' +
						(totalCount === 1 ? '' : 's') +
						' on this canvas as a JSON file (schema, drafts, associations).</p>' +
						'<label style="display:flex;gap:0.6em;align-items:flex-start;margin-top:0.8em;padding:0.7em;border:1px solid var(--border);border-radius:4px;cursor:pointer">' +
						'<input type="checkbox" id="eo-preserve-loaded" style="margin-top:0.2em">' +
						'<span style="flex:1">' +
						'<strong>Keep links to ' +
						loadedCount +
						' existing Salesforce ' +
						recordWord +
						'</strong>' +
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
					modal
						.querySelectorAll('[data-eo-close], [data-eo-cancel]')
						.forEach((el) => el.addEventListener('click', () => finish(null)));
					modal.querySelector('[data-eo-confirm]').addEventListener('click', () => {
						const cb = modal.querySelector('#eo-preserve-loaded');
						finish({ preserveLoadedLinks: !!(cb && cb.checked) });
					});
					setTimeout(() => modal.querySelector('[data-eo-confirm]').focus(), 0);
				});
			}

			async function _showContentPermDeniedDialog(actionableMessage, sfError) {
				document.querySelectorAll('.modal.content-perm-modal').forEach((el) => el.remove());
				const modal = document.createElement('div');
				modal.className = 'modal content-perm-modal';
				const sfErrorSnippet = sfError
					? '<details style="margin-top:0.8em"><summary class="tag">Raw Salesforce error</summary><pre style="margin:0.4em 0 0;font-size:0.78rem;color:var(--ink-faint);white-space:pre-wrap">' +
						escapeHtml(String(sfError).slice(0, 600)) +
						'</pre></details>'
					: '';
				modal.innerHTML =
					'<div class="modal-overlay" data-cp-close></div>' +
					'<div class="modal-body" style="max-width:540px">' +
					'<div class="modal-header">' +
					'<h3>Salesforce won’t accept this save</h3>' +
					'<button class="modal-close" data-cp-close>&times;</button>' +
					'</div>' +
					'<div class="modal-content">' +
					'<p>' +
					escapeHtml(actionableMessage || 'Your Salesforce user can’t create files in this org.') +
					'</p>' +
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
							} catch (e) {
								/* swallow */
							}
							cleanup();
						});
					}
					document.addEventListener('keydown', onKey);
				});
			}

			async function _showSavedCanvasCapDialog(data) {
				document.querySelectorAll('.modal.saved-cap-modal').forEach((el) => el.remove());
				const used = data && data.savedCount != null ? data.savedCount : '?';
				const cap = data && data.savedCap != null ? data.savedCap : '?';
				const planLabel =
					data && data.currentPlan === 'free' ? 'Inactive' : (data && data.currentPlan) || 'your';
				const modal = document.createElement('div');
				modal.className = 'modal saved-cap-modal';
				modal.innerHTML =
					'<div class="modal-overlay" data-sc-close></div>' +
					'<div class="modal-body" style="max-width:520px">' +
					'<div class="modal-header">' +
					'<h3>You’ve hit the ' +
					escapeHtml(String(planLabel)) +
					' plan’s saved-canvas limit</h3>' +
					'<button class="modal-close" data-sc-close>&times;</button>' +
					'</div>' +
					'<div class="modal-content">' +
					'<p>You have <strong>' +
					escapeHtml(String(used)) +
					' of ' +
					escapeHtml(String(cap)) +
					'</strong> saved canvases on the ' +
					escapeHtml(String(planLabel)) +
					' plan.</p>' +
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
							} catch (e) {
								/* swallow */
							}
							cleanup();
						});
					}
					document.addEventListener('keydown', onKey);
				});
			}

			function showTemplatesMenu(triggerEl) {
				showSaveMenu(triggerEl);
			}

			async function showBrowseSavedMenu(triggerEl) {
				const { pop, cleanup } = _openAnchoredPopup(triggerEl, 440);
				const teamName = (getCurrentTeam() && getCurrentTeam().name) || '';
				const headerLabel = teamName ? 'Saved canvases in ' + escapeHtml(teamName) : 'Saved canvases';
				pop.innerHTML =
					'<div class="tpl-header">' +
					headerLabel +
					'</div>' +
					'<div class="tpl-local-list" id="browse-sf-list"><div class="tpl-empty">Loading\u2026</div></div>' +
					'<div class="tpl-footer">Canvases are scoped to the workspace you\u2019re viewing and your active Salesforce connection.</div>';
				const list = pop.querySelector('#browse-sf-list');
				try {
					const r = await csrfFetch('/api/canvas', { credentials: 'same-origin' });
					const data = await r.json();
					if (!r.ok) {
						throw new Error((data && data.error) || 'HTTP ' + r.status);
					}
					const items = (data && data.items) || [];
					if (items.length === 0) {
						list.innerHTML =
							'<div class="tpl-empty">No saved canvases in ' +
							escapeHtml(teamName || 'this workspace') +
							' yet. Use Save &rarr; "Save as new canvas" to put one here. <a href="/docs/walkthroughs/saving-canvases" target="_blank" rel="noopener" class="empty-doclink">How saving works &rarr;</a></div>';
						return;
					}

					const inWorkspace = items.slice();
					const other = [];

					function _renderSavedRow(t, opts) {
						const showWsBadge = !!(opts && opts.showWsBadge);
						const date = t.updatedAt ? new Date(t.updatedAt).toLocaleString() : '';
						const isActive = !!(canvasState.currentCanvas && canvasState.currentCanvas.id === t.id);
						const activeTag = isActive
							? '<span class="tpl-scope-tag tpl-scope-tag--active" title="This is the canvas you currently have open">ACTIVE</span>'
							: '';
						let ownTag;
						if (t.ownedByMe) {
							ownTag = '<span class="tpl-scope-tag tpl-scope-tag--personal">MINE</span>';
						} else if (t.role === 'editor') {
							ownTag = '<span class="tpl-scope-tag tpl-scope-tag--editor">EDITOR</span>';
						} else {
							ownTag = '<span class="tpl-scope-tag tpl-scope-tag--template">CONTRIBUTOR</span>';
						}
						let fillTag = '';
						const activity = t.lastActivity || t.lastFillActivity;
						if (t.ownedByMe && activity && activity.at) {
							const rel = _formatRelativeTime(activity.at);
							const who =
								activity.byName ||
								activity.recipientName ||
								activity.byEmail ||
								activity.recipientEmail ||
								'a teammate';
							const verb = activity.kind === 'edit' ? 'Last edited' : 'Last filled';
							fillTag =
								'<div class="tpl-last-fill" title="' +
								escapeHtml(new Date(activity.at).toLocaleString()) +
								'">' +
								escapeHtml(verb + ' ' + rel + ' by ' + who) +
								'</div>';
						}
						const wsBadge =
							showWsBadge && t.ownerBoundTeamName
								? '<span class="tpl-ws-badge" title="This canvas is bound to ' +
									escapeHtml(t.ownerBoundTeamName) +
									'. Loading it will switch your view to that workspace.">' +
									escapeHtml(t.ownerBoundTeamName) +
									'</span>'
								: '';
						return (
							'<div class="tpl-item' +
							(isActive ? ' tpl-item--active' : '') +
							'">' +
							'<div class="tpl-info">' +
							'<div class="tpl-name">' +
							escapeHtml(t.title) +
							' ' +
							activeTag +
							ownTag +
							wsBadge +
							'</div>' +
							'<div class="tpl-meta">' +
							escapeHtml(date) +
							'</div>' +
							fillTag +
							'</div>' +
							(t.ownedByMe
								? '<button type="button" class="tpl-share" data-tpl-link="' +
									escapeHtml(t.id) +
									'" data-tpl-name="' +
									escapeHtml(t.title) +
									'" title="Email a magic-link share to a teammate">Share\u2026</button>'
								: '') +
							'<button type="button" class="tpl-load" data-tpl-load="' +
							escapeHtml(t.id) +
							'" data-tpl-title="' +
							escapeHtml(t.title) +
							'"' +
							(isActive ? ' title="Reload this canvas from Salesforce"' : '') +
							'>' +
							(isActive ? 'Reload' : 'Load') +
							'</button>' +
							(t.ownedByMe
								? '<button type="button" class="tpl-del" data-tpl-del="' +
									escapeHtml(t.id) +
									'" title="Delete">\u00D7</button>'
								: '') +
							'</div>'
						);
					}

					const inWsHtml =
						inWorkspace.length > 0
							? inWorkspace.map((t) => _renderSavedRow(t, { showWsBadge: false })).join('')
							: '<div class="tpl-empty">No canvases in ' +
								escapeHtml(teamName || 'this workspace') +
								' yet. Use Export &rarr; "Save canvas" to put one here.</div>';

					let otherHtml = '';
					if (other.length > 0) {
						const openByDefault = inWorkspace.length === 0;
						const otherRows = other.map((t) => _renderSavedRow(t, { showWsBadge: true })).join('');
						const summary =
							other.length + ' canvas' + (other.length === 1 ? '' : 'es') + ' in other workspaces';
						otherHtml =
							'<details class="tpl-other"' +
							(openByDefault ? ' open' : '') +
							'>' +
							'<summary class="tpl-other-summary">' +
							escapeHtml(summary) +
							'</summary>' +
							'<p class="tpl-other-tag">Loading one of these will switch your view to its workspace.</p>' +
							'<div class="tpl-other-list">' +
							otherRows +
							'</div>' +
							'</details>';
					}

					list.innerHTML = inWsHtml + otherHtml;
					pop.querySelectorAll('[data-tpl-load]').forEach((b) => {
						b.addEventListener('click', async () => {
							cleanup();
							let mode = 'replace';
							const currentSummary = summarizeCanvasContent(canvasState);
							if (currentSummary.hasContent) {
								mode = await showReplaceOrMergeDialog({
									currentSummary,
									incomingLabel: b.dataset.tplTitle,
								});
								if (mode === 'cancel') {
									return;
								}
							}
							try {
								const id = b.dataset.tplLoad;
								const tr = await csrfFetch('/api/canvas/' + encodeURIComponent(id), {
									credentials: 'same-origin',
								});
								const td = await tr.json();
								if (!tr.ok) {
									throw new Error((td && td.error) || 'HTTP ' + tr.status);
								}
								await applyCanvasPayload(td.payload || {}, {
									merge: mode === 'merge',
									ownedByMe: !!td.ownedByMe,
								});
								try {
									rehydrateSessionDraftValues(id);
								} catch (err) {
									window.ORGLOOM_capture &&
										window.ORGLOOM_capture(err, {
											where: 'canvas-save-load.js/loadFromList/rehydrateSession',
										});
								}
								if (mode !== 'merge') {
									_setStaleRefsFromLoad(td.staleRefs);
								} else if (Array.isArray(td.staleRefs)) {
									const mergeStaleIds = td.staleRefs
										.filter((s) => s && s.sfId && (s.reason || 'unknown') !== 'no-access')
										.map((s) => s.sfId);
									_addStaleRefIds(mergeStaleIds);
								}
								if (mode !== 'merge') {
									canvasState.currentCanvas = {
										id,
										title: td.title || '',
										ownedByMe: !!td.ownedByMe,
										versionId: td.versionId || null,
									};
									_watchProposalsForCurrentCanvas();
								}
								pingAuditEvent('canvas_load_sf', {
									recordCount:
										((td.payload && td.payload.drafts) || []).length +
										((td.payload && td.payload.loadedRecords) || []).length,
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
							const id = b.dataset.tplDel;
							const row = b.closest('.tpl-item');
							const shareBtn = row && row.querySelector('[data-tpl-name]');
							let title = shareBtn ? shareBtn.getAttribute('data-tpl-name') : null;
							if (!title) {
								const titleEl = row && row.querySelector('.tpl-name');
								title = titleEl
									? titleEl.textContent
											.replace(/\s+(MINE|EDITOR|CONTRIBUTOR|YOUR|SHARED)(\s+\S+)?$/, '')
											.trim()
									: null;
							}
							const ok = await showConfirmDialog({
								title: 'Delete saved canvas',
								message: title
									? 'Delete "' +
										title +
										'"? This removes the canvas from Salesforce. Anyone you shared it with will lose access.'
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
									throw new Error((dd && dd.error) || 'HTTP ' + dr.status);
								}
								if (row && row.parentNode) {
									row.parentNode.removeChild(row);
								}
								const listEl = pop.querySelector('.tpl-local-list');
								if (listEl && listEl.querySelectorAll('.tpl-item').length === 0) {
									listEl.innerHTML =
										'<div class="tpl-empty">No saved canvases in ' +
										escapeHtml(teamName || 'this workspace') +
										' yet. Use Save &rarr; "Save as new canvas" to put one here. <a href="/docs/walkthroughs/saving-canvases" target="_blank" rel="noopener" class="empty-doclink">How saving works &rarr;</a></div>';
								}
							} catch (e) {
								showBulkToast('Delete failed: ' + (e.message || e), 'error');
							}
						});
					});
				} catch (e) {
					list.innerHTML =
						'<div class="tpl-empty">Failed to load: ' + escapeHtml(e.message || String(e)) + '</div>';
				}
			}

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
