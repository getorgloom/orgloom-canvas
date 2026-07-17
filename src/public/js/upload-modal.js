// Upload-to-Salesforce modal flow.
//
// The big one: ~1,200 lines covering the upload pipeline from the
// toolbar click through the SSE-streamed bulk upload and the
// post-upload results review. Owns its own modal DOM (created on
// mount) plus a handful of module-private state lets that survive
// across opens.
//
// Public API (returned from mount):
//   openUploadModal, closeUploadModal, confirmUpload,
//   _runPendingUploadCleanup.
//
// Exposed as window.OrgLoom.uploadModal. Load order: before app.js.

(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	// Keep "Selected only" literal. A selection is an explicit upload
	// boundary, not a request to traverse the canvas graph and silently add
	// related drafts. Links whose parent draft falls outside that boundary are
	// surfaced separately so the user can choose to select both records when
	// preserving the relationship matters.
	function scopeUploadRecords(records, selectedIds, selectedOnly) {
		const real = (records || []).filter((r) => r && !r.isTypeNode);
		if (!selectedOnly || !selectedIds || selectedIds.size === 0) {
			return real;
		}
		return real.filter((r) => selectedIds.has(r.id));
	}

	function excludedDraftParentLinks(records, associations, scopedIds, selectedOnly) {
		if (!selectedOnly || !scopedIds || scopedIds.size === 0) {
			return [];
		}
		const realById = new Map(
			(records || [])
				.filter((r) => r && !r.isTypeNode)
				.map((r) => [r.id, r]),
		);
		return (associations || []).filter((a) => {
			if (!a || !scopedIds.has(a.fromId) || scopedIds.has(a.toId)) {
				return false;
			}
			const parent = realById.get(a.toId);
			return !!(parent && !parent.loadedFromId);
		});
	}

	function scopeUploadAssociations(associations, scopedIds) {
		if (!scopedIds || scopedIds.size === 0) {
			return [];
		}
		return (associations || []).filter((a) =>
			a && scopedIds.has(a.fromId) && scopedIds.has(a.toId));
	}

	function requiredExcludedDraftParentLinks(records, links, describeCache) {
		const realById = new Map(
			(records || [])
				.filter((r) => r && !r.isTypeNode)
				.map((r) => [r.id, r]),
		);
		return (links || []).filter((link) => {
			const child = realById.get(link.fromId);
			// Omitting a relationship on an existing record leaves its stored
			// Salesforce value alone. This is a known failure only for a new
			// record whose required lookup cannot be populated.
			if (!child || child.loadedFromId) {
				return false;
			}
			const describe = describeCache && describeCache[child.objectName];
			const field = describe && Array.isArray(describe.fields)
				? describe.fields.find((f) => f && f.name === link.fieldName)
				: null;
			return !!(
				field && field.type === 'reference' && field.createable !== false &&
				field.required && !field.defaultedOnCreate
			);
		});
	}

	function scopeUploadValues(record, values, excludedDraftLinks) {
		const scopedValues = Object.assign({}, values || {});
		if (!record) {
			return scopedValues;
		}
		// A stale literal lookup value must not survive after the canvas link
		// that semantically owns that field has been excluded. For inserts this
		// leaves the lookup empty; for updates omitting the field preserves the
		// current Salesforce value instead of writing an unrelated old ID.
		(excludedDraftLinks || []).forEach((link) => {
			if (link && link.fromId === record.id && link.fieldName) {
				delete scopedValues[link.fieldName];
			}
		});
		return scopedValues;
	}

	function formatUploadProgress(records, describeCache) {
		const uploading = (records || []).filter((record) => record && !record.isTypeNode);
		const count = uploading.length;
		if (count === 0) {
			return 'Uploading…';
		}

		const objectNames = new Set(uploading.map((record) => record.objectName).filter(Boolean));
		if (objectNames.size !== 1) {
			return 'Uploading ' + count + ' records…';
		}

		const objectName = Array.from(objectNames)[0];
		const describe = describeCache && describeCache[objectName];
		const objectLabel = count === 1
			? ((describe && describe.label) || objectName)
			: ((describe && describe.labelPlural) || (describe && describe.label ? describe.label + 's' : objectName + 's'));
		return 'Uploading ' + count + ' ' + objectLabel + '…';
	}

	window.OrgLoom.uploadModal = {
		scopeUploadRecords: scopeUploadRecords,
		excludedDraftParentLinks: excludedDraftParentLinks,
		scopeUploadAssociations: scopeUploadAssociations,
		requiredExcludedDraftParentLinks: requiredExcludedDraftParentLinks,
		scopeUploadValues: scopeUploadValues,
		formatUploadProgress: formatUploadProgress,
		mount: function mount(deps) {
			const required = [
				'canvasState', 'csrfFetch', 'escapeHtml',
				'showBulkToast', 'showConfirmDialog', 'showBulkSwitchWarning',
				'validateBulkRecords', 'computeUploadOrder',
				'isRecordModified', 'isRecordPendingDelete', 'recordOrdinal',
				'renderBulkView', 'startElapsedTicker',
				'ensureDescribe',
				'isLinkedCsvQuickUploadMode',
			];
			if (!deps) {
throw new Error('upload-modal.mount: missing deps object');
}
			for (const k of required) {
				if (deps[k] === undefined || deps[k] === null) {
					throw new Error('upload-modal.mount: missing dep ' + k);
				}
			}
			const canvasState = deps.canvasState;
			const csrfFetch = deps.csrfFetch;
			const escapeHtml = deps.escapeHtml;
			// Safe href for the server-provided re-auth link. The server
			// always returns a relative '/auth/login...' path, but this
			// value lands in an href, so accept ONLY a same-origin relative
			// path (leading single '/', never '//' or '/\') and HTML-escape
			// it: never trust arbitrary JSON as a URL. Anything else falls
			// back to the static sign-in path.
			const safeLoginHref = (u) => {
				if (typeof u === 'string' && /^\/(?![/\\])/.test(u)) {
					return escapeHtml(u);
				}
				return '/auth/login';
			};
			const showBulkToast = deps.showBulkToast;
			const showConfirmDialog = deps.showConfirmDialog;
			const showBulkSwitchWarning = deps.showBulkSwitchWarning;
			const validateBulkRecords = deps.validateBulkRecords;
			const computeUploadOrder = deps.computeUploadOrder;
			const isRecordModified = deps.isRecordModified;
			const isRecordPendingDelete = deps.isRecordPendingDelete;
			const recordOrdinal = deps.recordOrdinal;
			const renderBulkView = deps.renderBulkView;
			const startElapsedTicker = deps.startElapsedTicker;
			const ensureDescribe = deps.ensureDescribe;
			// Quick-upload mode getter: true when the user opened
			// the linked-CSV importer via the Quick Upload entry
			// point (bypasses the monthly cap; the server marks
			// directUpload=true rows accordingly).
			const _isLinkedCsvQuickUploadMode = deps.isLinkedCsvQuickUploadMode;
			// Fire-and-forget client audit POST, used only for the
			// deferred csv_import event on the Quick Upload path.
			// Optional with a no-op fallback: an audit miss must never
			// break the results render (displayUploadResults runs inside
			// the upload try/catch, where a throw reads as a network
			// failure and reroutes through the reconcile path).
			const pingAuditEvent = typeof deps.pingAuditEvent === 'function' ? deps.pingAuditEvent : function () {};
			const markCanvasGuideUploadComplete =
				typeof deps.markCanvasGuideUploadComplete === 'function'
					? deps.markCanvasGuideUploadComplete
					: function () {};

			const uploadModal = document.createElement('div');
			uploadModal.className = 'modal hidden';
			uploadModal.innerHTML =
				'<div class="modal-overlay" data-upload-close></div>' +
				'<div class="modal-body">' +
					'<div class="modal-header">' +
						'<h3>Upload records to Salesforce</h3>' +
						'<button class="modal-close" data-upload-close>&times;</button>' +
					'</div>' +
					'<div class="modal-content" id="upload-modal-content"></div>' +
					'<div class="modal-footer">' +
						'<button class="button secondary" id="upload-cancel" data-upload-close>Cancel</button>' +
						'<button class="button" id="upload-confirm">Upload</button>' +
					'</div>' +
				'</div>';
			document.body.appendChild(uploadModal);
			uploadModal.querySelectorAll('[data-upload-close]').forEach(el => el.addEventListener('click', closeUploadModal));
			document.addEventListener('keydown', e => {
 if (e.key === 'Escape' && !uploadModal.classList.contains('hidden')) {
closeUploadModal();
} 
});
			uploadModal.querySelector('#upload-confirm').onclick = confirmUpload;

			async function openUploadModal(opts) {
				if (canvasState.bulkRecords.length === 0) {
					showBulkToast('No records to upload.');
					// If the linked-CSV direct-upload path queued a
					// canvas-state restorer that's now stranded by the
					// empty-records bail (the new CSV rows somehow ended
					// up filtered out, etc.), run it now so the canvas
					// snaps back to its pre-import state.
					_runPendingUploadCleanup();
					return;
				}
				// Reset the confirm button in case the modal is reopened after a
				// previous upload repurposed it as Close / Retry, and make sure the
				// Cancel button is visible again.
				_preflightOverride = false;
				_bulkSwitchAcknowledged = false;
				// Initial scope: if the caller asked for selected (toolbar's
				// "Upload N selected" button) AND the user actually has a
				// non-empty partial selection, open in selected mode. Else
				// default to "all" (the canScope check inside
				// _renderUploadModalSummary handles edge cases like the
				// selection becoming empty after the modal is open).
				const _allRealCount = canvasState.bulkRecords.filter((r) => !r.isTypeNode).length;
				const _selectedRealCount = canvasState.bulkRecords.filter((r) => !r.isTypeNode && canvasState.bulkSelectedIds.has(r.id)).length;
				const _wantSelected = opts && opts.initialScope === 'selected'
					&& _selectedRealCount > 0 && _selectedRealCount < _allRealCount;
				_uploadScopeSelected = !!_wantSelected;
				const confirmBtn = uploadModal.querySelector('#upload-confirm');
				confirmBtn.disabled = false;
				confirmBtn.textContent = 'Upload';
				confirmBtn.classList.remove('confirm-anyway');
				confirmBtn.style.display = '';
				confirmBtn.onclick = confirmUpload;
				const cancelBtn = uploadModal.querySelector('#upload-cancel');
				if (cancelBtn) {
 cancelBtn.style.display = ''; cancelBtn.textContent = 'Cancel'; 
}
			
				// Pre-flight needs describes cached for every object on the
				// canvas. Most are already loaded (renderBulkView warms
				// them); fetch any stragglers before validating so we don't
				// silently skip object types.
				const content = uploadModal.querySelector('#upload-modal-content');
				content.innerHTML = '<p class="center tag">Running pre-flight checks\u2026</p>';
				uploadModal.classList.remove('hidden');
				const uniqObjs = Array.from(new Set(canvasState.bulkRecords.map((r) => r.objectName)));
				await Promise.all(uniqObjs.map((n) => ensureDescribe(n).catch(() => null)));
			
				_renderUploadModalSummary();
			}
			
			// Repaints the upload modal's body for the current scope
			// (all records vs. selected only). Wired to the scope
			// toggle that the modal renders when there are selected
			// records to scope to.
			function _renderUploadModalSummary() {
				const content = uploadModal.querySelector('#upload-modal-content');
				if (!content) {
return;
}
				const confirmBtn = uploadModal.querySelector('#upload-confirm');
				const cancelBtn = uploadModal.querySelector('#upload-cancel');
			
				const allReal = canvasState.bulkRecords.filter((r) => !r.isTypeNode);
				const selectedRealCount = allReal.filter((r) => canvasState.bulkSelectedIds.has(r.id)).length;
				const canScope = selectedRealCount > 0 && selectedRealCount < allReal.length;
				if (!canScope) {
_uploadScopeSelected = false;
}
				// The modal and submit path share this exact, literal scope so
				// the total and order always match the records sent.
				const scopedRecords = _scopedRealRecords();
				const scopedIds = new Set(scopedRecords.map((r) => r.id));
				const excludedDraftLinks = _uploadScopeSelected
					? _scopedExcludedDraftParentLinks()
					: [];
				const requiredExcludedDraftLinks = requiredExcludedDraftParentLinks(
					canvasState.bulkRecords,
					excludedDraftLinks,
					canvasState.describeCache,
				);
				const optionalExcludedDraftLinkCount = excludedDraftLinks.length - requiredExcludedDraftLinks.length;

				// Cross-org migrate-mode readiness gate. When a migration is
				// being reconciled on the destination org, blocked records
				// (missing record type, unfilled required field) can't be
				// recreated: hard-gate the upload until they're resolved.
				// Warnings (dropped fields / picklist values) are surfaced
				// but don't block.
				const _mig = window.Orgloom && window.Orgloom.canvasMigrate;
				const _migActive = !!(_mig && _mig.isActive());
				let _migBlocked = 0;
				let _migWarning = 0;
				let _migMatchUnresolved = 0;
				let _migDuplicateTargets = 0;
				if (_migActive) {
					const targetClaims = new Set();
					scopedRecords.forEach((r) => {
						const a = _mig.annotationFor(r.id);
						if (a && a.status === 'blocked') {
							_migBlocked++;
						} else if (a && a.status === 'warning') {
							_migWarning++;
						}
						if (r._migrateMatchAmbiguous && !r._migrateMatchResolution) {
							_migMatchUnresolved++;
						}
						if (r._migrateMatchedId) {
							if (targetClaims.has(r._migrateMatchedId)) {
								_migDuplicateTargets++;
							}
							targetClaims.add(r._migrateMatchedId);
						}
					});
				}
				const _migMatchBlocked = _migMatchUnresolved + _migDuplicateTargets;
				const migrateBanner = _migActive
					? '<div class="preflight ' +
						((_migBlocked > 0 || _migMatchBlocked > 0) ? 'has-errors' : (_migWarning > 0 ? 'has-warnings' : 'ok')) +
						'">' +
						'<span class="pf-icon">' + ((_migBlocked > 0 || _migMatchBlocked > 0) ? '⚠' : (_migWarning > 0 ? 'i' : '✓')) + '</span>' +
						'<span class="pf-msg"><strong>Migrating to this org.</strong> ' +
						(_migMatchUnresolved > 0
							? _migMatchUnresolved + ' record' + (_migMatchUnresolved === 1 ? '' : 's') + ' still needs an action. Open <em>Review migration</em> and choose Update existing with a destination record, or Create new.'
							: (_migDuplicateTargets > 0
								? 'More than one canvas record is assigned to the same destination record. Review the record actions before uploading.'
							: (_migBlocked > 0
							? _migBlocked + ' record' + (_migBlocked === 1 ? '' : 's') + ' can’t be migrated yet. Open <em>Review migration</em> and resolve the required destination differences.'
							: (_migWarning > 0
								? _migWarning + ' record' + (_migWarning === 1 ? '' : 's') + ' has values that will be omitted unless resolved. Review the migration plan, or proceed.'
								: 'All records are ready to recreate in the destination org.')))) +
						' <button type="button" class="link-button" data-migrate-review>Review migration…</button>' +
						'</span></div>'
					: '';
			
				const { issues: rawIssues, byRecordId: rawByRecordId, missingDescribes } = validateBulkRecords();
				// Restrict preflight feedback to records that are actually
				// in scope: issues on records the user excluded would
				// just be noise.
				const issues = rawIssues.filter((i) => !i.recordId || scopedIds.has(i.recordId));
				const byRecordId = new Map();
				rawByRecordId.forEach((rIssues, rid) => {
					if (scopedIds.has(rid)) {
byRecordId.set(rid, rIssues.slice());
}
				});
				// validateBulkRecords sees the canvas relationship and normally
				// treats a required lookup as filled. In selected-only mode that
				// relationship may be outside the payload, so add a scope-aware
				// issue rather than promising a successful insert.
				requiredExcludedDraftLinks.forEach((link) => {
					const rec = scopedRecords.find((r) => r.id === link.fromId);
					if (!rec) {
						return;
					}
					const describe = canvasState.describeCache[rec.objectName];
					const field = describe && Array.isArray(describe.fields)
						? describe.fields.find((f) => f && f.name === link.fieldName)
						: null;
					const issue = {
						recordId: rec.id,
						objectName: rec.objectName,
						recordLabel: (rec.label || rec.objectName) + ' #' + recordOrdinal(rec),
						field: link.fieldName,
						fieldLabel: (field && field.label) || link.fieldName,
						severity: 'error',
						message: 'This required relationship points to an unselected draft and won’t be included. Select the related draft too.',
					};
					issues.push(issue);
					const recordIssues = byRecordId.get(rec.id) || [];
					recordIssues.push(issue);
					byRecordId.set(rec.id, recordIssues);
				});
				const errorCount = issues.filter((i) => i.severity === 'error').length;
				const warningCount = issues.filter((i) => i.severity === 'warning').length;
			
				// Three-way classification per scoped record:
				//   * pending-delete: staged for SF DELETE; flows
				//     through the separate deletes lane below.
				//   * unchanged: loaded record with no value edits AND
				//     not pending-delete; skipped server-side.
				//   * changing: anything else (drafts, modified loaded).
				const realRecordsForCount = scopedRecords;
				const deleteIdSet = new Set(
					realRecordsForCount.filter(isRecordPendingDelete).map((r) => r.id)
				);
				const unchangedTempIds = realRecordsForCount
					.filter((r) => r.loadedFromId && !isRecordModified(r) && !r.pendingDelete)
					.map((r) => r.id);
				const unchangedSet = new Set(unchangedTempIds);
				const willUploadCount = realRecordsForCount.length - unchangedSet.size - deleteIdSet.size;
				const willDeleteCount = deleteIdSet.size;

				// Topo-ordered upload preview: mirrors the server's dependency
				// walk so the modal previews the exact order records will go
				// in. Within a level we group by object type; across levels
				// we render numbered entries so the user sees the FK chain.
				// Drop entries whose entire object-type bucket is unchanged
				// because they're not being uploaded, so listing them as a step
				// in the upload order is misleading. The unchanged-note
				// below still tells the user how many got skipped overall.
				const orderResult = computeUploadOrder(unchangedSet, scopedIds, deleteIdSet);
				const cycleIds = orderResult.cycleIds || new Set();
				const orderEntries = orderResult.creates.filter((e) => e.upload > 0);
				const deleteEntries = orderResult.deletes;
				const orderRows = orderEntries.map((entry, idx) => {
					const detail = entry.unchanged > 0
						? '<span class="us-detail tag">' + entry.unchanged + ' unchanged skipped</span>'
						: '';
					return (
						'<div class="us-step">' + (idx + 1) + '</div>' +
						'<div class="us-label">' + escapeHtml(entry.label) + ' ' + detail + '</div>' +
						'<div class="us-count">' + entry.upload + '</div>'
					);
				}).join('');
				// Deletes lane: rendered after creates so the user sees the
				// full sequence in execution order (creates → deletes).
				// Step numbers continue from the creates lane.
				const deleteRowsHtml = deleteEntries.map((entry, idx) => (
					'<div class="us-step us-step-delete">' + (orderEntries.length + idx + 1) + '</div>' +
					'<div class="us-label">' + escapeHtml(entry.label) + ' <span class="us-detail tag tag-danger">DELETE</span></div>' +
					'<div class="us-count">' + entry.count + '</div>'
				)).join('');
				// Type-nodes aren't records; don't count them in the
				// summary panel. Total reflects the in-scope subset
				// (all records, or only the user-selected slice).
				const totalRecords = scopedRecords.length;
				// Scope toggle: only render when the user has a partial
				// selection (some records selected but not all). Lets
				// them flip between "Upload all N" and "Upload selected M".
				const scopeToggleHtml = canScope
					? '<div class="upload-scope-toggle">' +
						'<button type="button" class="upload-scope-btn' + (_uploadScopeSelected ? '' : ' is-active') + '" data-upload-scope="all">' +
							'All records (' + allReal.length + ')' +
						'</button>' +
						'<button type="button" class="upload-scope-btn' + (_uploadScopeSelected ? ' is-active' : '') + '" data-upload-scope="selected">' +
							'Selected only (' + selectedRealCount + ')' +
						'</button>' +
					'</div>'
					: '';
			
				// Pre-flight section: nothing to show if all clear; a green
				// pill if all clear; a red/yellow expandable list if not.
				let preflightHtml = '';
				if (issues.length === 0 && missingDescribes.size === 0) {
					preflightHtml =
						'<div class="preflight ok">' +
							'<span class="pf-icon">\u2713</span>' +
							'<span class="pf-msg"><strong>Pre-flight passed.</strong> All records look ready to upload.</span>' +
						'</div>';
				} else if (issues.length > 0) {
					const recordSections = Array.from(byRecordId.entries()).map(([rid, rIssues]) => {
						const first = rIssues[0];
						const errs = rIssues.filter((x) => x.severity === 'error').length;
						const warns = rIssues.filter((x) => x.severity === 'warning').length;
						const summaryParts = [];
						if (errs > 0) {
summaryParts.push(errs + ' error' + (errs === 1 ? '' : 's'));
}
						if (warns > 0) {
summaryParts.push(warns + ' warning' + (warns === 1 ? '' : 's'));
}
						const items = rIssues.map((iss) => (
							'<li class="pf-item pf-' + iss.severity + '">' +
								'<span class="pf-field">' + escapeHtml(iss.fieldLabel) + ' (<code>' + escapeHtml(iss.field) + '</code>)</span> ' +
								'<span class="pf-msg-text">' + escapeHtml(iss.message) + '</span>' +
							'</li>'
						)).join('');
						return (
							'<details class="pf-record"' + (errs > 0 ? ' open' : '') + '>' +
								'<summary>' +
									'<span class="pf-rec-label">' + escapeHtml(first.recordLabel) + '</span>' +
									'<span class="pf-rec-counts">' + summaryParts.join(' \u00b7 ') + '</span>' +
								'</summary>' +
								'<ul class="pf-issues">' + items + '</ul>' +
							'</details>'
						);
					}).join('');
					preflightHtml =
						'<div class="preflight ' + (errorCount > 0 ? 'has-errors' : 'has-warnings') + '">' +
							'<div class="pf-head">' +
								'<span class="pf-icon">' + (errorCount > 0 ? '\u26A0' : 'i') + '</span>' +
								'<span class="pf-msg">' +
									'<strong>Pre-flight: ' +
									(errorCount > 0 ? errorCount + ' error' + (errorCount === 1 ? '' : 's') : '') +
									(errorCount > 0 && warningCount > 0 ? ', ' : '') +
									(warningCount > 0 ? warningCount + ' warning' + (warningCount === 1 ? '' : 's') : '') +
									'.</strong> ' +
									(errorCount > 0
										? 'Salesforce will likely reject these records. Fix them on the canvas, or upload anyway and review the errors after.'
										: 'These look fixable but should still upload. Review or proceed.') +
								'</span>' +
							'</div>' +
							'<div class="pf-body">' + recordSections + '</div>' +
						'</div>';
				}
				if (missingDescribes.size > 0) {
					preflightHtml +=
						'<div class="preflight has-warnings">' +
							'<span class="pf-icon">i</span>' +
							'<span class="pf-msg">Describes still loading for: ' +
								Array.from(missingDescribes).map((n) => '<code>' + escapeHtml(n) + '</code>').join(', ') +
								'. These objects weren\u2019t pre-flight checked.' +
							'</span>' +
						'</div>';
				}
				if (cycleIds.size > 0) {
					preflightHtml =
						'<div class="preflight has-errors">' +
							'<span class="pf-icon">⚠</span>' +
							'<span class="pf-msg"><strong>Reference cycle detected.</strong> ' +
							cycleIds.size + ' record' + (cycleIds.size === 1 ? '' : 's') +
							' depend on each other. Break the cycle on the canvas before uploading; no records have been sent to Salesforce.</span>' +
						'</div>';
				}
			
				const unchangedNote = unchangedSet.size > 0
					? '<p class="tag" style="margin-top:0.4em">' + unchangedSet.size + ' loaded record' + (unchangedSet.size === 1 ? '' : 's') + ' ' + (unchangedSet.size === 1 ? 'has' : 'have') + ' no local changes and will be skipped: only modified or new records will sync.</p>'
					: '';
				// A selected record may point to an unselected draft. Do not
				// cross the user's explicit selection boundary; explain the
				// relationship consequence before they confirm instead.
				const excludedDraftLinkNote = optionalExcludedDraftLinkCount > 0
					? '<div class="preflight has-warnings">' +
						'<span class="pf-icon">i</span>' +
						'<span class="pf-msg"><strong>Some relationships won’t be included.</strong> ' +
						optionalExcludedDraftLinkCount + ' relationship' + (optionalExcludedDraftLinkCount === 1 ? '' : 's') +
						' point' + (optionalExcludedDraftLinkCount === 1 ? 's' : '') + ' to an unselected draft. Only the selected ' +
						'record' + (scopedRecords.length === 1 ? '' : 's') + ' will upload. Select the related draft' +
						(optionalExcludedDraftLinkCount === 1 ? '' : 's') + ' too if you want Salesforce to preserve ' +
						(optionalExcludedDraftLinkCount === 1 ? 'that relationship' : 'those relationships') + '.</span>' +
					'</div>'
					: '';
				// Deletes section + lead-in. Only renders when there are
				// pending-delete records; otherwise the upload modal
				// reads exactly the way it always did.
				const deletesBlock = deleteEntries.length > 0
					? '<div class="upload-section-head upload-section-head--danger">Then delete <span class="tag tag-danger">irreversible</span></div>' +
						'<p class="upload-deletes-lead">These records will be DELETE\'d in Salesforce after the creates/updates above. Deletes can\u2019t be undone from Org Loom; recover from the Salesforce recycle bin within 15 days if needed.</p>' +
						'<div class="upload-summary upload-summary--ordered upload-summary--deletes">' +
							deleteRowsHtml +
						'</div>'
					: '';
				content.innerHTML =
					scopeToggleHtml +
					migrateBanner +
					excludedDraftLinkNote +
					preflightHtml +
					unchangedNote +
					'<div class="upload-section-head">Upload order</div>' +
					'<div class="upload-summary upload-summary--ordered">' +
						orderRows +
					'</div>' +
					deletesBlock +
					'<div class="upload-totals">' +
						'<div class="ut-row"><span>Total records</span><strong>' + totalRecords + '</strong></div>' +
					'</div>';
				// Wire the guided migration launcher in the banner. On close, re-render the
				// summary so newly-matched records show as updates and the
				// blocked-gate recomputes.
				const _matchBtn = content.querySelector('[data-migrate-review]');
				if (_matchBtn) {
					_matchBtn.addEventListener('click', () => {
						const mm = window.Orgloom && window.Orgloom.migrateMatch;
						if (mm && mm.open) {
							mm.open({ onClose: () => _renderUploadModalSummary() });
						}
					});
				}
				// Wire the scope toggle (no-op if it didn't render).
				content.querySelectorAll('[data-upload-scope]').forEach((btn) => {
					btn.addEventListener('click', () => {
						const next = btn.dataset.uploadScope === 'selected';
						if (next === _uploadScopeSelected) {
return;
}
						_uploadScopeSelected = next;
						_renderUploadModalSummary();
					});
				});
			
				// Soft-gate: when there are hard errors, repurpose the
				// confirm button to "Upload anyway" so the user has to
				// acknowledge they're committing to a likely-failed run.
				// When there's literally nothing to do (no syncs AND
				// no deletes), hide the confirm button outright and
				// rename Cancel → Close so the only action is to dismiss.
				const hasWork = willUploadCount > 0 || willDeleteCount > 0;
				if (cycleIds.size > 0) {
					confirmBtn.style.display = '';
					confirmBtn.disabled = true;
					confirmBtn.textContent = 'Break reference cycle';
					confirmBtn.classList.remove('confirm-anyway');
					confirmBtn.classList.remove('confirm-danger');
					if (cancelBtn) {
cancelBtn.textContent = 'Cancel';
}
				} else if (_migActive && _migMatchBlocked > 0) {
					confirmBtn.style.display = '';
					confirmBtn.disabled = true;
					confirmBtn.textContent = _migMatchUnresolved > 0
						? 'Resolve ' + _migMatchUnresolved + ' match' + (_migMatchUnresolved === 1 ? '' : 'es')
						: 'Resolve duplicate matches';
					confirmBtn.classList.remove('confirm-anyway');
					confirmBtn.classList.remove('confirm-danger');
					if (cancelBtn) {
						cancelBtn.textContent = 'Cancel';
					}
				} else if (_migActive && _migBlocked > 0) {
					// Hard gate: blocked migration records would error on
					// insert into the destination org. Disable confirm until
					// the guided migration differences are resolved.
					confirmBtn.style.display = '';
					confirmBtn.disabled = true;
					confirmBtn.textContent = 'Resolve ' + _migBlocked + ' blocked record' + (_migBlocked === 1 ? '' : 's');
					confirmBtn.classList.remove('confirm-anyway');
					confirmBtn.classList.remove('confirm-danger');
					if (cancelBtn) {
						cancelBtn.textContent = 'Cancel';
					}
				} else if (!hasWork) {
					confirmBtn.style.display = 'none';
					confirmBtn.disabled = false;
					if (cancelBtn) {
cancelBtn.textContent = 'Close';
}
				} else {
					confirmBtn.disabled = false;
					confirmBtn.style.display = '';
					if (cancelBtn) {
cancelBtn.textContent = 'Cancel';
}
					const scopeLabel = _uploadScopeSelected ? 'selected' : '';
					// Deletes-only path gets its own label so the button
					// doesn't promise an "upload" when nothing's being
					// created/updated. Mixed and creates-only paths use
					// the standard Upload label even when deletes ride
					// along; the deletes lane in the preview already
					// announces them.
					const deletesOnly = willUploadCount === 0 && willDeleteCount > 0;
					if (errorCount > 0) {
						confirmBtn.textContent = deletesOnly
							? 'Delete anyway'
							: (scopeLabel ? 'Upload selected anyway' : 'Upload anyway');
						confirmBtn.classList.add('confirm-anyway');
					} else if (deletesOnly) {
						confirmBtn.textContent = 'Delete ' + willDeleteCount + ' record' + (willDeleteCount === 1 ? '' : 's');
						confirmBtn.classList.remove('confirm-anyway');
						confirmBtn.classList.add('confirm-danger');
					} else {
						confirmBtn.textContent = scopeLabel ? 'Upload selected' : 'Upload';
						confirmBtn.classList.remove('confirm-anyway');
						confirmBtn.classList.remove('confirm-danger');
					}
				}
			}
			
			// Optional one-shot callback invoked when the upload
			// modal closes. Used by the direct-upload CSV path to
			// restore the canvas state it temporarily swapped out so
			// the upload pipeline sees only the new CSV rows. The
			// callback fires regardless of how the modal closes
			// (success, cancel, or post-upload "Close" button).
			let _pendingUploadCleanup = null;
			// Metadata for the deferred csv_import audit (Quick Upload /
			// direct-CSV path). Set in linkedCsvConfirm at materialization
			// time; consumed + cleared in displayUploadResults once the
			// real upload outcome (applied / failed counts) is known.
			let _pendingCsvImportMeta = null;
			// One-shot runner for the optional restorer registered by
			// the linked-CSV direct-upload path. Extracted from the
			// modal-close path so callers that bail BEFORE the modal
			// renders (e.g., openUploadModal's empty-records early
			// return) can still flush the cleanup; without it, the
			// canvas state stays in its trimmed direct-upload form
			// and the user effectively loses every pre-existing
			// record until they reload.
			function _runPendingUploadCleanup() {
				// If the modal closed without the upload ever executing
				// (user cancelled the pre-flight), drop the deferred
				// csv_import metadata WITHOUT auditing; nothing was
				// uploaded, so there's no outcome to record (matches the
				// "cancel before upload → no audit" expectation). When the
				// upload DID run, displayUploadResults already consumed it.
				_pendingCsvImportMeta = null;
				if (!_pendingUploadCleanup) {
return;
}
				const cb = _pendingUploadCleanup;
				_pendingUploadCleanup = null;
				try {
 cb(); 
} catch (e) {
 console.warn('upload cleanup failed:', e); 
}
			}
			function closeUploadModal() {
				uploadModal.classList.add('hidden');
				_runPendingUploadCleanup();
			}
			
			// Set to true once Layer 3 has passed (or the user chose to
			// override a preflight failure). Cleared when the modal opens.
			let _preflightOverride = false;
			// Set to true once the user has acknowledged the
			// "switching to Bulk API" warning. Cleared on each modal
			// open so a re-upload re-prompts (the canvas may have
			// shrunk into a graph-eligible payload in between).
			let _bulkSwitchAcknowledged = false;
			// When true, the upload modal restricts the payload to
			// records whose ids are in `canvasState.bulkSelectedIds`. Cleared
			// each time the modal opens so the default is "all".
			let _uploadScopeSelected = false;
			
			// Records that the upload pipeline should consider, filtered by
			// the current scope (all vs. the user's literal selection).
			function _scopedRealRecords() {
				return scopeUploadRecords(
					canvasState.bulkRecords,
					canvasState.bulkSelectedIds,
					_uploadScopeSelected,
				);
			}
			
			function _scopedExcludedDraftParentLinks() {
				const scopedIds = new Set(_scopedRealRecords().map((r) => r.id));
				return excludedDraftParentLinks(
					canvasState.bulkRecords,
					canvasState.bulkAssociations,
					scopedIds,
					_uploadScopeSelected,
				);
			}
			
			// In migrate mode, produce the effective values to send to the
			// destination org: inject the resolved RecordTypeId (auto-resolved
			// by DeveloperName or user-picked; it was stripped on the
			// cross-org transform) and apply any picklist remaps (replace or
			// drop invalid values). Outside migrate mode this is a passthrough.
			function _migrateUploadValues(r) {
				const base = (r && r.values) || {};
				const mig = window.Orgloom && window.Orgloom.canvasMigrate;
				if (!mig || !mig.isActive()) {
					return base;
				}
				const ann = mig.annotationFor(r.id);
				const engine = window.Orgloom && window.Orgloom.migrateAnnotate;
				return engine && typeof engine.prepareMigrationValues === 'function'
					? engine.prepareMigrationValues(r, ann)
					: base;
			}

			// Per-upload-attempt idempotency token. Generated lazily when an
			// upload's payload is built, reused across retries, and cleared on
			// a successful displayUploadResults. Threaded to the server, stored
			// on the recall batch, and used by reconcileLostUpload to match the
			// exact batch a network-dropped upload wrote (so a retry can't dup).
			let _uploadAttemptId = null;
			// One-shot duplicate-rule override. Armed by the "Upload anyway"
			// button that appears when records fail with DUPLICATES_DETECTED;
			// consumed (reset) when results render, so the override never
			// silently carries into an unrelated later upload.
			let _allowDuplicates = false;
			async function confirmUpload() {
				// Type-nodes are ephemeral edit-mode placeholders; never
				// upload them. Filter once at submit time so every step
				// (preflight, REST, bulk) sees the real-records-only view.
				// _scopedRealRecords also honors the modal's "selected
				// only" toggle so we never upload records the user
				// excluded from this run.
				const realRecords = _scopedRealRecords();
				if (realRecords.length === 0) {
return;
}
				// Defense in depth for migration matching. The visible upload
				// button is disabled while choices are unresolved, but re-check at
				// submit time so a stale modal or scripted click cannot bypass it.
				const migrateApi = window.Orgloom && window.Orgloom.canvasMigrate;
				if (migrateApi && migrateApi.isActive()) {
					const unresolvedMatches = realRecords.filter((r) =>
						r._migrateMatchAmbiguous && !r._migrateMatchResolution,
					);
					const claimed = new Set();
					let duplicateTarget = false;
					realRecords.forEach((r) => {
						if (!r._migrateMatchedId) {
							return;
						}
						if (claimed.has(r._migrateMatchedId)) {
							duplicateTarget = true;
						}
						claimed.add(r._migrateMatchedId);
					});
					if (unresolvedMatches.length > 0 || duplicateTarget) {
						showBulkToast(
							unresolvedMatches.length > 0
								? 'Decide the destination action for every record before uploading.'
								: 'Two canvas records cannot update the same destination record.',
							'warning',
						);
						_renderUploadModalSummary();
						return;
					}
				}
				// Extra guard for User records: they consume licenses, can't
				// be deleted, and trigger Salesforce welcome emails on insert.
				// Force a literal click-to-confirm before going any further.
				const userRecords = realRecords.filter((r) => r.objectName === 'User' && !r.loadedFromId);
				if (userRecords.length > 0) {
					const orgLabel = (_meInfo && _meInfo.orgType === 'production') ? 'PRODUCTION' : (_meInfo && _meInfo.orgType) || 'this org';
					const msg = 'You\'re about to create ' + userRecords.length + ' User record' + (userRecords.length === 1 ? '' : 's') + ' in ' + orgLabel + '.\n\n' +
						'\u2022 Each new User consumes a Salesforce license.\n' +
						'\u2022 Users CAN\'T be deleted, only deactivated; these stay in the org forever.\n' +
						'\u2022 Salesforce sends a welcome email on insert (suppressed when IsActive=false).\n\n' +
						'Proceed?';
					if (!(await showConfirmDialog({ title: 'Create User records?', message: msg, confirmLabel: 'Create users', cancelLabel: 'Cancel', danger: true }))) {
return;
}
				}
				const confirmBtn = uploadModal.querySelector('#upload-confirm');
				const cancelBtn = uploadModal.querySelector('[data-upload-close]');
				const content = uploadModal.querySelector('#upload-modal-content');
			
				// Recompute unchanged set at submit time: a card the user
				// edited between opening the modal and clicking Upload would
				// have flipped from unchanged to modified. Pending-delete
				// records also get carved out here so they don't appear
				// in skipTempIds OR in records[]; they ride in deletes[]
				// (separate payload lane with different verb + reverse-
				// topo ordering on the server side).
				const skipTempIds = realRecords
					.filter((r) => r.loadedFromId && !isRecordModified(r) && !r.pendingDelete)
					.map((r) => r.id);
				const recordsForPayload = realRecords.filter((r) => !r.pendingDelete);
				const deletesForPayload = realRecords.filter((r) => isRecordPendingDelete(r));
				const excludedDraftLinksForPayload = _uploadScopeSelected
					? _scopedExcludedDraftParentLinks()
					: [];

				// Restrict associations to those connecting two in-scope
				// records. Including links to records the user excluded
				// from this run would leave dangling FK references. Drop
				// edges whose endpoint is being deleted: the FK on the
				// child side will be moot post-delete, and shipping the
				// edge would just confuse downstream consumers (autosave,
				// schema-builder hover) that re-read the canvas after the
				// upload commits.
				const scopedIds = new Set(recordsForPayload.map((r) => r.id));
				const payload = {
					records: recordsForPayload.map(r => ({
						tempId: r.id,
						objectName: r.objectName,
						values: scopeUploadValues(
							r,
							_migrateUploadValues(r),
							excludedDraftLinksForPayload,
						),
						loadedFromId: r.loadedFromId || null,
						// SF baseline at canvas-load time, for any
						// loaded record. The upload route uses these
						// to populate the recall ledger's priorValues
						// for value-revert: if the user later recalls
						// the upload, the server PATCHes each updated
						// field back to its loadedValues entry
						// (assuming no drift). Drafts (no loadedFromId)
						// get nothing here; there's no pre-upload
						// baseline to revert to. The field is opt-in
						// on the server side; backwards-compat with
						// older clients is preserved.
						loadedValues: (r.loadedFromId && r.loadedValues) ? r.loadedValues : undefined,
						// Per-record operation overrides from the
						// linked-CSV modal's per-file picker. When
						// present, server groups by operation+extId
						// rather than the loadedFromId-derived
						// default. Only set when user picked
						// 'upsert' on a file's operation picker.
						_csvOperation: r._csvOperation || undefined,
						_csvExternalIdField: r._csvExternalIdField || undefined,
					})),
					// Pending deletes: separate lane from records[]. Server
					// runs DELETEs after creates/updates, in REVERSE topo
					// order (deepest children first) so cascades / FK
					// constraints don't reject the batch. sfId is the
					// 15/18-char Salesforce id captured at load time.
					deletes: deletesForPayload.map(r => ({
						tempId: r.id,
						sfId: r.loadedFromId,
						objectName: r.objectName,
					})),
					associations: scopeUploadAssociations(canvasState.bulkAssociations, scopedIds)
						.map((a) => ({
							fromId: a.fromId,
							toId: a.toId,
							fieldName: a.fieldName,
						})),
					skipTempIds,
					// Set when the linked-CSV modal was opened in Quick
					// Upload mode (openLinkedCsvModal({ quickUpload: true }));
					// cleared by closeLinkedCsvModal. Server-side,
					// directUpload=true makes assertUploadCap skip the
					// monthly cap and recordUploadIfSucceeded write
					// kind='upload_direct' (excluded from uploadsThisMonth).
					// Canvas-mode imports and other upload paths count
					// toward the cap normally.
					directUpload: _isLinkedCsvQuickUploadMode(),
				};
				// Stamp the per-attempt idempotency token (generated once, reused
				// on retry). The server persists it on the recall batch.
				if (!_uploadAttemptId) {
					_uploadAttemptId = (window.crypto && typeof crypto.randomUUID === 'function')
						? crypto.randomUUID()
						: ('att-' + Date.now() + '-' + Math.random().toString(36).slice(2));
				}
				payload.attemptId = _uploadAttemptId;
				// One-shot duplicate-rule override, armed by the "Upload
				// anyway" affordance after a DUPLICATES_DETECTED failure.
				// Alert-severity duplicate rules allow the save in the SF UI
				// but BLOCK API inserts unless the request carries the
				// duplicate-rule header; without this flag, Retry failed
				// would loop on the same rejection forever.
				if (_allowDuplicates) {
					payload.allowDuplicates = true;
				}
			
				// Atomic-graph fast path. Splits the canvas into
				// connected components (one composite graph each) so
				// the cap is 75-per-component / 500-total / 5MB-body
				// rather than 75-overall. Most edit-mode canvases
				// have a few clustered components (base + each opened
				// type-node group) well under per-component limit,
				// even with hundreds of records total. Each component
				// commits or rolls back independently, so partial
				// success across components is normal and fine.
				// Cap-counted work is creates/updates only. Deletes don't
				// consume the monthly cap; they're net-negative SF state
				// changes that we don't want to discourage with a counter.
				// The component-grouping below also excludes deletes so
				// they don't bloat per-component limits.
				const uploadingCountForGate = recordsForPayload.length - skipTempIds.length;
				const PER_COMPONENT_CAP = 75;
				const TOTAL_NODES_CAP = 500;
				const BYTE_CAP = 5 * 1024 * 1024; // 5 MB, leaves room under the 6 MB hard ceiling
				const components = (() => {
					// Build undirected adjacency among records that will
					// actually upload (excluding skipTempIds + type-nodes
					// + pending-deletes).
					const submitted = new Set(recordsForPayload
						.filter((r) => !(r.loadedFromId && skipTempIds.indexOf(r.id) !== -1))
						.map((r) => r.id));
					const adj = new Map();
					submitted.forEach((id) => adj.set(id, new Set()));
					canvasState.bulkAssociations.forEach((a) => {
						if (!a) {
return;
}
						if (!submitted.has(a.fromId) || !submitted.has(a.toId)) {
return;
}
						adj.get(a.fromId).add(a.toId);
						adj.get(a.toId).add(a.fromId);
					});
					const seen = new Set();
					const groups = [];
					for (const seed of submitted) {
						if (seen.has(seed)) {
continue;
}
						const group = [];
						const queue = [seed];
						while (queue.length) {
							const cur = queue.shift();
							if (seen.has(cur)) {
continue;
}
							seen.add(cur);
							group.push(cur);
							for (const n of (adj.get(cur) || [])) {
if (!seen.has(n)) {
queue.push(n);
}
}
						}
						groups.push(group);
					}
					return groups;
				})();
				const maxComponentSize = components.reduce((m, g) => Math.max(m, g.length), 0);
				// Carry-over orphan strip. After a cross-org switch the
				// canvas may hold values for fields that are unavailable in
				// this object's running-user describe in the new org. Sending them
				// would 4xx (SF rejects unknown fields outright) so we
				// strip them here, count what got dropped per record,
				// and surface a single toast summarizing the total.
				// The guided migration flow discloses these fields; this remains
				// the safety net for a plan applied with unresolved warnings.
				// Records WITHOUT a populated describeCache entry are
				// left alone; we can't tell what's orphan without
				// the describe, and the safer choice is to let the
				// SF round-trip surface the error than to silently
				// drop fields we're unsure about.
				// System-managed fields (Id, audit timestamps, audit user
				// refs) get stripped silently on insert payloads; SF
				// rejects them and they're not a "carry-over from a
				// different org" the user can do anything about. Only
				// genuine cross-org orphans get counted toward the warn
				// toast. Mirrors the system-field list in app.js's
				// loaded→draft conversion and the orphan-detection
				// filter in insert-modal.js.
				const _UPLOAD_SYSTEM_FIELDS = new Set([
					'attributes',
					'Id',
					'CreatedDate', 'CreatedById',
					'LastModifiedDate', 'LastModifiedById',
					'SystemModstamp',
					'LastReferencedDate', 'LastViewedDate',
					'IsDeleted',
					'OwnerId',
					'RecordTypeId',
					'MasterRecordId',
				]);
				// The warn toast only fires for genuine cross-org
				// carry-overs (records where _wasLoadedFromOrgId is
				// set). Non-createable fields that ride on regular
				// loaded records still get silently stripped; SF
				// rejects them anyway, and the user has no agency
				// over them, but they don't surface a scary toast
				// that makes a claim about the destination schema when
				// in fact they're just system fields
				// that aren't writable on insert.
				let _orphanStrippedCount = 0;
				let _orphanStrippedRecordCount = 0;
				if (Array.isArray(payload.records)) {
					payload.records.forEach((r) => {
						if (!r || !r.values || !r.objectName) {
return;
}
						const desc = canvasState.describeCache && canvasState.describeCache[r.objectName];
						if (!desc || !Array.isArray(desc.fields)) {
return;
}
						const known = new Set(desc.fields.map((f) => f.name));
						const isCrossOrgCarryover = !!r._wasLoadedFromOrgId;
						let stripped = 0;
						Object.keys(r.values).forEach((k) => {
							if (!k || k.startsWith('_')) {
return;
}
							if (_UPLOAD_SYSTEM_FIELDS.has(k)) {
								// System field: silent strip, not a
								// cross-org orphan.
								delete r.values[k];
								return;
							}
							if (!known.has(k)) {
								delete r.values[k];
								// Only count toward the warn toast
								// when the record is a real cross-org
								// carry-over.
								if (isCrossOrgCarryover) {
stripped++;
}
							}
						});
						if (stripped > 0) {
							_orphanStrippedCount += stripped;
							_orphanStrippedRecordCount++;
						}
					});
				}
				if (_orphanStrippedCount > 0 && typeof window.olToast === 'function') {
					window.olToast(
						'Skipped ' + _orphanStrippedCount + ' unavailable field value' +
							(_orphanStrippedCount === 1 ? '' : 's') +
							' across ' + _orphanStrippedRecordCount + ' record' +
							(_orphanStrippedRecordCount === 1 ? '' : 's') +
							'. They may not exist in the destination org, or Salesforce permissions may hide them.',
						'warn',
					);
				}

				const payloadJson = JSON.stringify(payload);
				// External-ID upsert is a native Bulk API operation. Composite
				// Graph has no equivalent operation and would treat the row as an
				// insert, so it must be excluded from the Graph fast path even when
				// the payload is otherwise small enough.
				const hasUpsert = realRecords.some((r) => r._csvOperation === 'upsert');
				const fitsGraph = uploadingCountForGate > 0
					&& maxComponentSize <= PER_COMPONENT_CAP
					&& uploadingCountForGate <= TOTAL_NODES_CAP
					&& payloadJson.length <= BYTE_CAP;
				// Path 1 hard cap. Per docs/UPLOAD_ARCHITECTURE.md the
				// canvas-upload path is Composite Graph only; if the
				// payload doesn't fit, we refuse rather than silently
				// degrading to Bulk (which is what the legacy code path
				// did and what produced the partial-commit messes the
				// new architecture is designed to prevent). The user is
				// told exactly which cap was busted and what to do
				// instead.
				if (!_preflightOverride && !payload.directUpload && !fitsGraph && uploadingCountForGate > 0) {
					confirmBtn.disabled = false;
					confirmBtn.textContent = 'Upload';
					const reasons = [];
					if (maxComponentSize > PER_COMPONENT_CAP) {
						reasons.push('one connected cluster has ' + maxComponentSize + ' records (canvas cap is ' + PER_COMPONENT_CAP + ' per cluster)');
					}
					if (uploadingCountForGate > TOTAL_NODES_CAP) {
						reasons.push(uploadingCountForGate + ' total records (canvas cap is ' + TOTAL_NODES_CAP + ')');
					}
					if (payloadJson.length > BYTE_CAP) {
						reasons.push('payload is ' + (payloadJson.length / 1024 / 1024).toFixed(1) + ' MB (canvas cap is ' + (BYTE_CAP / 1024 / 1024).toFixed(0) + ' MB)');
					}
					content.innerHTML =
						'<div class="banner error">' +
							'<strong>Upload too large for the canvas path.</strong> ' +
							(reasons.length ? '<ul style="margin:0.4em 0 0 1.2em">' + reasons.map((r) => '<li>' + escapeHtml(r) + '</li>').join('') + '</ul>' : '') +
							'<p style="margin-top:0.5em">Split this upload into smaller batches, or use Direct CSV upload.</p>' +
						'</div>';
					return;
				}
				if (!_preflightOverride && fitsGraph && !hasUpsert) {
					confirmBtn.disabled = true;
					confirmBtn.textContent = 'Uploading\u2026';
					const uploadingRecords = recordsForPayload.filter((record) =>
						skipTempIds.indexOf(record.id) === -1);
					content.innerHTML =
						'<p class="center busy-row" style="justify-content:center">' +
							'<span class="busy-spinner lg"></span>' +
							'<span>' + escapeHtml(formatUploadProgress(uploadingRecords, canvasState.describeCache)) + '</span>' +
						'</p>';
					let body;
					try {
						const r = await csrfFetch('/api/upload/graph', {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: payloadJson,
							credentials: 'same-origin',
						});
						body = await r.json().catch(() => ({}));
						if (r.status === 401) {
							content.innerHTML =
								'<div class="banner error">Your Salesforce session expired. ' +
									'<a href="' + safeLoginHref(body && body.loginUrl) + '">Sign in again</a> ' +
									'and retry the upload.' +
								'</div>';
							confirmBtn.disabled = true;
							return;
						}
						if (r.status === 402 && body && body.code === 'upload_cap_reached') {
							content.innerHTML =
								'<div class="banner error">' + escapeHtml(body.error || 'Upload cap reached.') + '</div>' +
								(body.uploadsUsed != null && body.uploadCap != null
									? '<p class="tag" style="margin-top:0.4em">Used <strong>' + body.uploadsUsed + '</strong> of ' + body.uploadCap + ' uploads this month.</p>'
									: '') +
								'<div style="display:flex;gap:0.5em;align-items:center;margin-top:0.7em;flex-wrap:wrap">' +
									'<a class="button" href="/workspace/upgrade">Upgrade to Pro &rarr;</a>' +
									'<a class="tag" href="/pricing" target="_blank" rel="noopener">Compare plans</a>' +
								'</div>';
							confirmBtn.disabled = true;
							return;
						}
						if (r.status === 409 && body && body.error === 'upload-attempt-incomplete') {
							renderAttemptIncomplete(body);
							return;
						}
						const allResults = (body && body.results) || [];
						const hasCommitted = allResults.some((r) => r && r.success && r.mode !== 'unchanged');
						// Three outcomes:
						// 1. Full atomic success → all components committed.
						// 2. Partial success → multi-graph: some components
						//    committed, others rolled back. displayUploadResults
						//    renders both buckets and updates each successful
						//    record's loadedFromId so a subsequent "Retry
						//    failed" only re-attempts the failures.
						// 3. Full rollback → nothing committed. Show
						//    preflight-style errors with "Upload anyway"
						//    so the user can opt into REST best-effort.
						if (body && (body.atomicSuccess || hasCommitted)) {
							displayUploadResults(allResults, body.instanceUrl || '', body.deletes || [], body.canonicalValues || {});
							return;
						}
						const errors = allResults
							.filter((r) => !r.success && r.error)
							.map((r) => {
								const rec = canvasState.bulkRecords.find((br) => br.id === r.tempId);
								return {
									recordLabel: rec ? ((rec.label || rec.objectName) + ' #' + recordOrdinal(rec)) : (r.objectName + ' #' + r.tempId),
									message: r.error,
									errorCode: r.errorCode,
									fields: r.fields,
								};
							});
						renderPreflightFailure({
							ok: false,
							errors,
							sampled: uploadingCountForGate,
							total: realRecords.length,
						});
						return;
					} catch (err) {
						// Network blip → fall through to the legacy
						// preflight + REST path below so the user isn't
						// blocked on a transient.
						console.warn('[graph upload] failed, falling back:', err);
						// The atomic graph may have COMMITTED before the response was lost;
						// reconcile so the REST fallback UPDATEs those records instead of
						// re-INSERTing duplicates.
						try {
 await reconcileLostUpload(payload.records); 
} catch (_e) { /* best-effort */ }
					}
				}
			
				// Bulk-API switch gate. The atomic Composite Graph fast
				// path above didn't apply (payload too big, component
				// too large, or > 500 nodes). If we'd also fall through
				// to /api/upload/bulk (count > BULK_THRESHOLD), the
				// user moves from atomic-per-component semantics to
				// non-atomic, partial-success Bulk API v2: a real
				// behavioral change worth surfacing once. Once
				// acknowledged in this modal session we don't re-prompt.
				if (!_bulkSwitchAcknowledged && !fitsGraph && realRecords.length > BULK_THRESHOLD) {
					const reasons = [];
					if (maxComponentSize > PER_COMPONENT_CAP) {
						reasons.push('one connected group has ' + maxComponentSize + ' records (Composite Graph caps a group at ' + PER_COMPONENT_CAP + ')');
					}
					if (uploadingCountForGate > TOTAL_NODES_CAP) {
						reasons.push(uploadingCountForGate + ' total records (Composite Graph caps total at ' + TOTAL_NODES_CAP + ')');
					}
					if (payloadJson.length > BYTE_CAP) {
						reasons.push('payload is ' + (payloadJson.length / 1024 / 1024).toFixed(1) + ' MB (Composite Graph caps payload at ' + (BYTE_CAP / 1024 / 1024).toFixed(0) + ' MB)');
					}
					const ok = await showBulkSwitchWarning({
						recordCount: uploadingCountForGate,
						reasons,
					});
					if (!ok) {
						confirmBtn.disabled = false;
						confirmBtn.textContent = 'Upload';
						content.innerHTML = '<p class="center tag">Upload cancelled.</p>';
						return;
					}
					_bulkSwitchAcknowledged = true;
				}
			
				// Layer 3: Composite Graph dry-run. Skipped if the user has
				// already opted to override a previous failure (the button
				// is now "Upload anyway"; they've seen the errors).
				if (!_preflightOverride && !hasUpsert) {
					confirmBtn.disabled = true;
					confirmBtn.textContent = 'Validating\u2026';
					content.innerHTML = '<p class="center">Sending a sample to Salesforce to validate the schema, validation rules, and triggers\u2026</p>';
					let pf;
					try {
						const r = await csrfFetch('/api/upload/preflight', {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify(payload),
							credentials: 'same-origin',
						});
						pf = await r.json();
						if (r.status === 401) {
							content.innerHTML =
								'<div class="banner error">Your Salesforce session expired. ' +
									'<a href="' + safeLoginHref(pf && pf.loginUrl) + '">Sign in again</a> ' +
									'and retry the upload.' +
								'</div>';
							confirmBtn.disabled = true;
							return;
						}
					} catch (err) {
						// Network failure on preflight; let the user proceed
						// rather than block on a transient blip.
						console.warn('[preflight] request failed, allowing upload:', err);
						pf = { ok: true, sampled: 0, skipped: true };
					}
					if (!pf.ok) {
						renderPreflightFailure(pf);
						return;
					}
					// Tiny visual ack on success path so the validating step
					// doesn't feel skipped.
					const skippedNote = pf.skipped
						? ' <span class="tag">(no new records to validate)</span>'
						: ' <span class="tag">(' + pf.sampled + ' record' + (pf.sampled === 1 ? '' : 's') + ' sampled)</span>';
					content.innerHTML = '<p class="center">Pre-flight passed' + skippedNote + ': starting upload\u2026</p>';
				}
			
				confirmBtn.disabled = true;
				confirmBtn.textContent = 'Uploading\u2026';
			
				// Pick REST vs Bulk. REST is faster end-to-end for small
				// uploads (no job creation overhead); Bulk wins decisively
				// past ~50 records and avoids per-user API limits.
				// Force Bulk when any record uses _csvOperation='upsert':
				// the REST path (/api/upload) doesn't support upsert by
				// external id, only insert + update-by-Id. Routing
				// upserts there would silently fall back to insert and
				// create duplicates. Bulk API has native upsert support.
				const useBulk = hasUpsert || realRecords.length > BULK_THRESHOLD;
				if (useBulk) {
					try {
						await runBulkUploadSSE(payload, content);
					} catch (err) {
						// The Bulk job runs server-side on Salesforce and can keep going
						// after the SSE stream drops, so records may have committed even
						// though we lost the result. Reconcile so a Retry UPDATEs them
						// instead of duplicating.
						let recovered = 0;
						try {
 recovered = await reconcileLostUpload(payload.records); 
} catch (_e) {
 recovered = 0; 
}
						if (recovered > 0) {
							content.innerHTML = '<div class="banner">Connection dropped mid-upload, but ' + recovered + ' record' + (recovered === 1 ? '' : 's') + ' had already saved to Salesforce. ' + (recovered === 1 ? 'It\u2019s' : 'They\u2019re') + ' now marked as uploaded, so retrying won\u2019t create duplicates. Click Retry to finish any records that didn\u2019t save.</div>';
						} else {
							content.innerHTML = '<div class="banner error">Upload failed: ' + escapeHtml(err.message || String(err)) + '</div>';
						}
						confirmBtn.disabled = false;
						confirmBtn.textContent = 'Retry';
					}
					return;
				}
			
				// Count actually-uploading records: the unchanged-loaded
				// ones in skipTempIds stay in the payload so the server
				// can still substitute their loadedFromId into child FK
				// fields, but they don't generate any API call.
				// uploadingCount surfaces creates/updates; deleteCount is
				// rendered alongside so the user sees both sides of the
				// work. A pure-delete pass uses a delete-specific header
				// instead of "Uploading 0 records (and deleting N)".
				const uploadingCount = recordsForPayload.length - skipTempIds.length;
				const deleteCount = deletesForPayload.length;
				const skippedNote = skipTempIds.length > 0
					? '<p class="tag center">' + skipTempIds.length + ' unchanged record' + (skipTempIds.length === 1 ? '' : 's') + ' skipped.</p>'
					: '';
				const headerMsg = (uploadingCount === 0 && deleteCount > 0)
					? 'Deleting ' + deleteCount + ' record' + (deleteCount === 1 ? '' : 's') + ' in Salesforce\u2026'
					: 'Uploading ' + uploadingCount + ' record' + (uploadingCount === 1 ? '' : 's') +
						(deleteCount > 0 ? ' (and deleting ' + deleteCount + ')' : '') +
						' to Salesforce\u2026';
				content.innerHTML =
					'<p class="center busy-row" style="justify-content:center">' +
						'<span class="busy-spinner lg"></span>' +
						'<span>' + headerMsg + '</span>' +
						'<span class="busy-elapsed" id="rest-elapsed"></span>' +
					'</p>' +
					'<p class="tag center">Records upload one at a time: expect ~5\u201310 records per second.</p>' +
					skippedNote;
				const stopElapsed = startElapsedTicker(content.querySelector('#rest-elapsed'));
				try {
					const r = await csrfFetch('/api/upload', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify(payload),
						credentials: 'same-origin',
					});
					const body = await r.json().catch(() => ({}));
					stopElapsed();
					if (r.status === 401) {
						content.innerHTML =
							'<div class="banner error">Your Salesforce session expired. ' +
								'<a href="' + safeLoginHref(body && body.loginUrl) + '">Sign in again</a> ' +
								'and retry the upload.' +
							'</div>';
						confirmBtn.disabled = true;
						return;
					}
					if (r.status === 409 && body && body.error === 'upload-attempt-incomplete') {
						renderAttemptIncomplete(body);
						return;
					}
					if (!r.ok) {
throw new Error((body && body.error) || 'Upload failed');
}
					displayUploadResults(body.results || [], body.instanceUrl || '', body.deletes || [], body.canonicalValues || {});
				} catch (err) {
					stopElapsed();
					// A thrown error here means we never got a response (network
					// drop / timeout); the upload's outcome is UNKNOWN. The server
					// may have already committed records (and written the recall
					// ledger), so reconcile against it to stamp loadedFromId back
					// onto any that saved, which makes the Retry idempotent (saved
					// records UPDATE rather than duplicate-INSERT).
					let recovered = 0;
					try {
						recovered = await reconcileLostUpload(payload.records);
					} catch (_e) {
						recovered = 0;
					}
					if (recovered > 0) {
						content.innerHTML = '<div class="banner">Connection dropped mid-upload, but ' + recovered + ' record' + (recovered === 1 ? '' : 's') + ' had already saved to Salesforce. ' + (recovered === 1 ? 'It\u2019s' : 'They\u2019re') + ' now marked as uploaded, so retrying won\u2019t create duplicates. Click Retry to finish any records that didn\u2019t save.</div>';
					} else {
						content.innerHTML = '<div class="banner error">Upload failed: ' + escapeHtml(err.message || String(err)) + '</div>';
					}
					confirmBtn.disabled = false;
					confirmBtn.textContent = 'Retry';
				}
			}
			
			// Threshold for switching from REST to Bulk API v2. REST is
			// faster for small uploads (no job-creation overhead, ~5/sec);
			// Bulk wins at scale (~1000/sec) and avoids per-user API limits.
			// 50 is the single-object break-even, but typical uploads
			// fan across multiple FK levels; each (level, object) group
			// becomes its own Bulk job with ~5-15 sec of create/poll
			// overhead, so the multi-level break-even sits closer to
			// ~150 total. Raise this if users routinely upload very
			// concentrated single-object batches.
			const BULK_THRESHOLD = 150;
			
			// Salesforce job-state strings come back as PascalCase
			// ("UploadComplete", "InProgress", "JobComplete"). Render them
			// with spaces so they don't read like one mashed word.
			function humanizeState(s) {
				if (!s) {
return '';
}
				const out = String(s).replace(/([a-z])([A-Z])/g, '$1 $2');
				return out.charAt(0).toUpperCase() + out.slice(1).toLowerCase();
			}
			
			// Tick a "0:23 elapsed" counter inside `el`. Returns a stop
			// function that stops the timer. Format is m:ss.
			
			async function runBulkUploadSSE(payload, contentEl) {
				contentEl.innerHTML =
					'<div class="bulk-progress">' +
						'<div class="bp-head">' +
							'<span class="busy-row"><span class="busy-spinner"></span><strong>Bulk upload</strong></span> ' +
							'<span class="tag" id="bp-summary">starting\u2026</span>' +
							'<span class="busy-elapsed" id="bp-elapsed"></span>' +
						'</div>' +
						'<div class="bp-levels" id="bp-levels"></div>' +
					'</div>';
				const summaryEl = contentEl.querySelector('#bp-summary');
				const levelsEl = contentEl.querySelector('#bp-levels');
				const stopElapsed = startElapsedTicker(contentEl.querySelector('#bp-elapsed'));
			
				let plan = null; // start-event payload
				// Map of jobKey ("level|operation|objectName") → live state.
				const jobState = new Map();
				function jobKey(level, operation, objectName) {
 return level + '|' + operation + '|' + objectName; 
}
			
				function renderLevels() {
					if (!plan) {
return;
}
					const html = plan.levels.map((lvl) => {
						const groups = lvl.groups.map((g) => {
							const k = jobKey(lvl.level, g.operation, g.objectName);
							const st = jobState.get(k) || {};
							const processed = st.processed || 0;
							const failed = st.failed || 0;
							const total = g.count;
							const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
							const rawState = st.state || st.phase || 'queued';
							const stateLabel = humanizeState(rawState);
							// "Active" = job is in flight: created, uploading,
							// queued in SF, or in progress with no records done
							// yet. Show a spinner + indeterminate bar in those
							// cases so the user knows we're not stuck.
							const terminal = rawState === 'JobComplete' || rawState === 'Failed' || rawState === 'Aborted' || rawState === 'done';
							const active = !terminal && rawState !== 'queued';
							const indeterminate = active && processed === 0;
							const spinnerHtml = active ? '<span class="busy-spinner"></span>' : '';
							return (
								'<div class="bp-job">' +
									'<div class="bp-job-head">' +
										'<span class="bp-obj">' + escapeHtml(g.objectName) + '</span> ' +
										'<span class="tag">' + escapeHtml(g.operation) + ' \u00b7 ' + total + '</span>' +
										'<span class="bp-state tag">' + spinnerHtml + escapeHtml(stateLabel) + '</span>' +
									'</div>' +
									'<div class="bp-bar' + (indeterminate ? ' indeterminate' : '') + '"><div class="bp-bar-fill" style="width:' + pct + '%"></div></div>' +
									'<div class="bp-counts"><span>' + processed + ' / ' + total + ' processed</span>' +
										(failed > 0 ? '<span class="bp-failed">' + failed + ' failed</span>' : '') +
									'</div>' +
								'</div>'
							);
						}).join('');
						return (
							'<div class="bp-level">' +
								'<div class="bp-level-head">Level ' + (lvl.level + 1) + ' of ' + plan.totalLevels + '</div>' +
								groups +
							'</div>'
						);
					}).join('');
					levelsEl.innerHTML = html;
				}
			
				const resp = await csrfFetch('/api/upload/bulk', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
					body: JSON.stringify(payload),
					credentials: 'same-origin',
				});
				if (resp.status === 401) {
					const body = await resp.json().catch(() => ({}));
					contentEl.innerHTML =
						'<div class="banner error">Your Salesforce session expired. ' +
							'<a href="' + safeLoginHref(body && body.loginUrl) + '">Sign in again</a> ' +
							'and retry the upload.' +
						'</div>';
					return;
				}
				if (resp.status === 402) {
					// Cap-reached: server returns JSON (not SSE) when the
					// pre-flight cap check fires. body.code === 'upload_cap_reached'.
					const body = await resp.json().catch(() => ({}));
					contentEl.innerHTML =
						'<div class="banner error">' + escapeHtml((body && body.error) || 'Upload cap reached.') + '</div>' +
						(body && body.uploadsUsed != null && body.uploadCap != null
							? '<p class="tag" style="margin-top:0.4em">Used <strong>' + body.uploadsUsed + '</strong> of ' + body.uploadCap + ' uploads this month.</p>'
							: '') +
						'<div style="display:flex;gap:0.5em;align-items:center;margin-top:0.7em;flex-wrap:wrap">' +
							'<a class="button" href="/workspace/upgrade">Upgrade to Pro &rarr;</a>' +
							'<a class="tag" href="/pricing" target="_blank" rel="noopener">Compare plans</a>' +
						'</div>';
					return;
				}
				if (!resp.ok || !resp.body) {
					const t = await resp.text().catch(() => '');
					throw new Error(t || ('HTTP ' + resp.status));
				}
			
				const reader = resp.body.getReader();
				const decoder = new TextDecoder();
				let buffer = '';
				let finalResults = null;
				let finalDeletes = [];
				let finalInstanceUrl = '';
				let finalCanonicalValues = {};
				let streamErr = null;
				while (true) {
					const { done, value } = await reader.read();
					if (done) {
break;
}
					buffer += decoder.decode(value, { stream: true });
					let sep;
					while ((sep = buffer.indexOf('\n\n')) !== -1) {
						const raw = buffer.slice(0, sep);
						buffer = buffer.slice(sep + 2);
						if (!raw.trim()) {
continue;
}
						let evName = 'message';
						let dataStr = '';
						raw.split('\n').forEach((line) => {
							if (line.startsWith('event: ')) {
evName = line.slice(7).trim();
} else if (line.startsWith('data: ')) {
dataStr += (dataStr ? '\n' : '') + line.slice(6);
}
						});
						let data;
						try {
 data = JSON.parse(dataStr); 
} catch (e) {
 continue; 
}
						if (evName === 'start') {
							plan = data;
							const willUpload = data.willUploadCount != null ? data.willUploadCount : data.totalRecords;
							let txt = willUpload + ' record' + (willUpload === 1 ? '' : 's') + ' across ' + data.totalLevels + ' level' + (data.totalLevels === 1 ? '' : 's');
							if (data.unchangedCount > 0) {
txt += ' \u00b7 ' + data.unchangedCount + ' unchanged (skipped)';
}
							summaryEl.textContent = txt;
							renderLevels();
						} else if (evName === 'level-start') {
							renderLevels();
						} else if (evName === 'job-event') {
							// data has objectName, operation, phase, state, processed, failed, total, jobId
							// We don't get the level back from the server in job-event, but per (op,obj)
							// pair only one job exists per level, so search across plan.levels.
							if (plan) {
								for (const lvl of plan.levels) {
									const match = lvl.groups.find((g) => g.objectName === data.objectName && g.operation === data.operation);
									if (match) {
										const k = jobKey(lvl.level, data.operation, data.objectName);
										const st = jobState.get(k) || {};
										if (data.phase) {
st.phase = data.phase;
}
										if (data.state) {
st.state = data.state;
}
										if (data.processed != null) {
st.processed = data.processed;
}
										if (data.failed != null) {
st.failed = data.failed;
}
										jobState.set(k, st);
										break;
									}
								}
								renderLevels();
							}
						} else if (evName === 'level-done') {
							renderLevels();
						} else if (evName === 'complete') {
							finalResults = data.results || [];
							finalDeletes = data.deletes || [];
							finalInstanceUrl = data.instanceUrl || '';
							finalCanonicalValues = data.canonicalValues || {};
						} else if (evName === 'error') {
							streamErr = new Error(data.message || 'Bulk upload failed');
						}
					}
				}
				stopElapsed();
				if (streamErr) {
throw streamErr;
}
				if (!finalResults) {
throw new Error('Bulk upload ended without results.');
}
				// Per-delete results ride the 'complete' event alongside the
				// record results, same rendering + pending-delete-card
				// pruning as the REST/graph paths.
				displayUploadResults(finalResults, finalInstanceUrl, finalDeletes, finalCanonicalValues);
			}
			
			// Render the per-record SF errors returned by the preflight
			// endpoint. Reuses the .preflight panel styles so it visually
			// matches the Layer 1 panel above. Repurposes the confirm
			// button to "Upload anyway"; a second click bypasses the
			// preflight and goes straight to /api/upload.
			function renderPreflightFailure(pf) {
				// A validation response is a deterministic no-commit outcome. The
				// next click is a new logical attempt, potentially after the user
				// edits fields or explicitly chooses Upload anyway, so it must not
				// reuse the idempotency token from the rolled-back request.
				_uploadAttemptId = null;
				const content = uploadModal.querySelector('#upload-modal-content');
				const confirmBtn = uploadModal.querySelector('#upload-confirm');
				const errs = Array.isArray(pf.errors) ? pf.errors : [];
				const grouped = new Map();
				errs.forEach((e) => {
					const key = e.recordLabel || 'Unknown record';
					let bucket = grouped.get(key);
					if (!bucket) {
 bucket = []; grouped.set(key, bucket); 
}
					bucket.push(e);
				});
				const sections = Array.from(grouped.entries()).map(([label, list]) => {
					const items = list.map((e) => {
						const fieldsHtml = (e.fields && e.fields.length > 0)
							? '<span class="pf-field"><code>' + e.fields.map(escapeHtml).join(', ') + '</code></span> '
							: '';
						const code = e.errorCode ? ' <span class="pf-rec-counts">' + escapeHtml(e.errorCode) + '</span>' : '';
						return (
							'<li class="pf-item pf-error">' +
								fieldsHtml +
								'<span class="pf-msg-text">' + escapeHtml(e.message || 'Unknown error') + '</span>' +
								code +
							'</li>'
						);
					}).join('');
					return (
						'<details class="pf-record" open>' +
							'<summary>' +
								'<span class="pf-rec-label">' + escapeHtml(label) + '</span>' +
								'<span class="pf-rec-counts">' + list.length + ' SF error' + (list.length === 1 ? '' : 's') + '</span>' +
							'</summary>' +
							'<ul class="pf-issues">' + items + '</ul>' +
						'</details>'
					);
				}).join('');
				content.innerHTML =
					'<div class="preflight has-errors">' +
						'<div class="pf-head">' +
							'<span class="pf-icon">\u26A0</span>' +
							'<span class="pf-msg">' +
								'<strong>Salesforce rejected the sample.</strong> ' +
								'These errors come from a real validation pass against ' + (pf.sampled || 0) + ' sample record' + (pf.sampled === 1 ? '' : 's') + ' (rolled back; nothing was committed). Fix them and retry, or upload anyway to see the same errors per-record.' +
							'</span>' +
						'</div>' +
						'<div class="pf-body">' + sections + '</div>' +
					'</div>';
				confirmBtn.disabled = false;
				confirmBtn.textContent = 'Upload anyway';
				confirmBtn.classList.add('confirm-anyway');
				_preflightOverride = true; // next click bypasses preflight
			}
			
			function _clearCommittedMigrationMatch(rec) {
				delete rec._migrateMatchedId;
				delete rec._migrateMatchKey;
				delete rec._migrateMatchValue;
				delete rec._migrateMatchAmbiguous;
				delete rec._migrateMatchResolution;
				delete rec._migrateMatchIntent;
				delete rec._migrateMatchCandidates;
				delete rec._migrateFieldResolutions;
			}

			// Stamp recovered SF ids back onto the matching canvas cards so a
			// retry treats them as UPDATEs (idempotent), not fresh INSERTs.
			function _applyRecoveredIds(realIdByTempId) {
				canvasState.bulkRecords.forEach((rec) => {
					if (realIdByTempId.has(rec.id) && !rec.loadedFromId) {
						rec.loadedFromId = realIdByTempId.get(rec.id);
						rec.values = rec.values || {};
						rec.values.Id = realIdByTempId.get(rec.id);
						rec.loadedValues = Object.assign({}, rec.values);
						// The one-shot migration decision has now committed. Keep the
						// destination loadedFromId, but remove match-review metadata so
						// ordinary future edits use the normal loadedValues diff.
						_clearCommittedMigrationMatch(rec);
					}
				});
				if (typeof renderBulkView === 'function') {
					renderBulkView();
				}
			}

			// Reconcile after a network failure mid-upload. The server may have
			// committed records AND written the recall ledger even though the
			// response never reached us, so a naive Retry would re-INSERT them
			// as duplicates. Look up recent recall batches, find one whose
			// inserted records are all part of this attempt (matched by tempId
			// + objectName, recent), and stamp their ids back onto the cards.
			// Returns the count reconciled (0 if none / lookup failed); the
			// caller then shows the plain error). Best-effort: never throws.
			async function reconcileLostUpload(attemptedRecords) {
				try {
					const wantObjByTempId = new Map();
					(attemptedRecords || []).forEach((r) => {
						if (r && r.tempId != null && !r.loadedFromId) {
							wantObjByTempId.set(r.tempId, r.objectName);
						}
					});
					if (wantObjByTempId.size === 0) {
						return 0;
					}
					const listR = await csrfFetch('/api/upload-batches?limit=5', { credentials: 'same-origin' });
					if (!listR.ok) {
						return 0;
					}
					const listBody = await listR.json().catch(() => ({}));
					const batches = Array.isArray(listBody.batches) ? listBody.batches : [];
					const cutoff = Date.now() - 15 * 60 * 1000;
					// Prefer an EXACT match by this attempt's idempotency token:
					// the batch the server stamped with the same attemptId is
					// unambiguously ours. Only when no batch carries the token
					// (e.g. an older upload) fall back to the tempId+objectName
					// heuristic, scoped by recency + a subset guard.
					const tokenMatches = _uploadAttemptId
						? batches.filter((b) => b && b.id && b.attemptId === _uploadAttemptId)
						: [];
					const byToken = tokenMatches.length > 0;
					const candidates = byToken
						? tokenMatches
						: batches.filter((b) => b && b.id && !(b.createdAt && b.createdAt < cutoff));
					const realIdByTempId = new Map();
					for (const b of candidates) {
						const detR = await csrfFetch('/api/upload-batches/' + encodeURIComponent(b.id), { credentials: 'same-origin' });
						if (!detR.ok) {
							continue;
						}
						const detBody = await detR.json().catch(() => ({}));
						const inserted = (detBody.batch && Array.isArray(detBody.batch.insertedIds)) ? detBody.batch.insertedIds : [];
						if (inserted.length === 0) {
							continue;
						}
						// Heuristic-only guard: every inserted record must be one we
						// tried to upload (same tempId + objectName). Token matches
						// are exact, so they skip this.
						if (!byToken
							&& !inserted.every((ins) => ins && ins.tempId != null && wantObjByTempId.get(ins.tempId) === ins.objectName)) {
							continue;
						}
						inserted.forEach((ins) => {
							if (ins.sfId) {
								realIdByTempId.set(ins.tempId, ins.sfId);
							}
						});
					}
					if (realIdByTempId.size === 0) {
						return 0;
					}
					_applyRecoveredIds(realIdByTempId);
					// Also patch the in-flight payload records we were handed.
					// The graph catch falls through to the REST path in the SAME
					// invocation, re-sending this very `payload` object, built
					// before the commit with loadedFromId:null. Without stamping
					// it here, that fall-through (and any caller reusing the array)
					// re-INSERTs the just-committed records as duplicates. Stamping
					// loadedFromId flips them to UPDATEs, matching _applyRecoveredIds
					// on the canvas cards.
					(attemptedRecords || []).forEach((r) => {
						if (r && r.tempId != null && !r.loadedFromId && realIdByTempId.has(r.tempId)) {
							r.loadedFromId = realIdByTempId.get(r.tempId);
							if (r.values && typeof r.values === 'object') {
								r.values.Id = realIdByTempId.get(r.tempId);
							}
						}
					});
					return realIdByTempId.size;
				} catch (_e) {
					return 0;
				}
			}

			// Render the unresolved-outcome state for a
			// 409 upload-attempt-incomplete. The server refuses a retry whose
			// attemptId matches a batch still in 'pending' (committed-but-not-
			// finalized, or crashed mid-commit) so a retry can't create
			// duplicates. We can't safely auto-retry (the records may or may
			// not have landed), so we explain and point the user at Upload
			// History / Refresh to reconcile, and leave the action disabled.
			function renderAttemptIncomplete(body) {
				const content = uploadModal.querySelector('#upload-modal-content');
				const confirmBtn = uploadModal.querySelector('#upload-confirm');
				if (content) {
					content.innerHTML =
						'<div class="banner">' +
							'<strong>Upload paused to prevent duplicate records.</strong> ' +
							escapeHtml((body && body.message) || 'Org Loom could not confirm whether Salesforce saved the previous attempt.') +
						'</div>' +
						'<div style="margin-top:0.75em">' +
							'<strong>Before uploading these drafts again:</strong>' +
							'<ol style="margin:0.45em 0 0 1.3em;padding:0">' +
								'<li>Open <strong>Upload History</strong> using the ↻ toolbar button and find the entry marked <strong>Outcome unknown</strong>.</li>' +
								'<li>Check Salesforce to see whether the affected records were saved.</li>' +
								'<li>If they were saved, refresh or replace the matching drafts on the canvas. If they were not saved, close this message and start the upload again.</li>' +
							'</ol>' +
						'</div>';
				}
				// Reaching here means a prior attempt is unresolved; retire this
				// invocation's token so that if the user reconciles and uploads
				// again, it's a clean NEW attempt rather than re-hitting the 409.
				_uploadAttemptId = null;
				if (confirmBtn) {
					confirmBtn.disabled = false;
					confirmBtn.textContent = 'Close';
					confirmBtn.onclick = closeUploadModal;
				}
			}

			function displayUploadResults(results, instanceUrl, deletesResults, canonicalValues) {
				// Reaching here means the server responded: this attempt is
				// resolved, so retire its idempotency token. (A network failure
				// routes through the catch instead, keeping the token for retry.)
				_uploadAttemptId = null;
				_allowDuplicates = false;
				const content = uploadModal.querySelector('#upload-modal-content');
				const confirmBtn = uploadModal.querySelector('#upload-confirm');
				// Three buckets for the creates lane: synced (created or
				// updated), unchanged (skipped: record already in SF and
				// not modified locally), and failed. Plus the deletes
				// lane: deleted (successful SF DELETE) + deleteFailed.
				const synced = results.filter(r => r.success && r.mode !== 'unchanged');
				const unchanged = results.filter(r => r.success && r.mode === 'unchanged');
				const failed = results.filter(r => !r.success);
				const deletesArr = Array.isArray(deletesResults) ? deletesResults : [];
				const deleted = deletesArr.filter((d) => d && d.success);
				const deleteFailed = deletesArr.filter((d) => d && !d.success);
				// One committed create/update is enough to finish first-run canvas
				// guidance. Partial uploads count because the user successfully
				// completed the workflow for at least one record.
				if (synced.length > 0) {
					markCanvasGuideUploadComplete();
				}
				// Emit the deferred csv_import audit (Quick Upload path)
				// now that the real outcome is known. Status: ok (all
				// applied), partial (some applied, some failed), or failed
				// (none applied). Consume the metadata so a later canvas
				// upload doesn't re-fire it. Only set on the direct-CSV
				// path, so this no-ops for normal canvas uploads.
				if (_pendingCsvImportMeta) {
					const _csvMeta = _pendingCsvImportMeta;
					_pendingCsvImportMeta = null;
					const _csvStatus = failed.length === 0 ? 'ok' : (synced.length > 0 ? 'partial' : 'failed');
					pingAuditEvent('csv_import', {
						recordCount: _csvMeta.recordCount,
						status: _csvStatus,
						payload: {
							mode: _csvMeta.mode,
							fileCount: _csvMeta.fileCount,
							linksWired: _csvMeta.linksWired,
							strippedFields: _csvMeta.strippedFields,
							applied: synced.length,
							failed: failed.length,
							unchanged: unchanged.length,
						},
					});
				}
				// Recall-ledger persistence happens SERVER-SIDE inside
				// the upload route now (/api/upload, /api/upload/graph,
				// /api/upload/bulk all call batchStore.create() and
				// return the resulting batchId in their JSON response).
				// The duplicate client-side POST that used to live here
				// produced two History rows per upload: one labeled
				// with the server's source ('canvas-graph' →
				// "Canvas (graph)") and one labeled with the client's
				// stub ('canvas' → "Canvas"). Removed; the server is
				// the single source of truth. If a future flow needs
				// to write a batch from the client (e.g. a non-upload
				// path that bypasses the route), use the response's
				// batchId and call POST /api/upload-batches once with
				// the correct source.
				const sfBase = (instanceUrl || '').replace(/\/+$/, '');
				const recordUrl = (objectName, id) => sfBase
					? sfBase + '/lightning/r/' + encodeURIComponent(objectName) + '/' + encodeURIComponent(id) + '/view'
					: null;
			
				const summaryParts = [];
				if (synced.length > 0) {
summaryParts.push(synced.length + ' synced');
}
				if (unchanged.length > 0) {
summaryParts.push(unchanged.length + ' unchanged');
}
				if (failed.length > 0) {
summaryParts.push(failed.length + ' failed');
}
				const summaryText = summaryParts.join(', ') || 'No records to sync';
			
				let html = '';
				if (failed.length === 0 && synced.length > 0) {
					html += '<div class="banner success">' + escapeHtml(summaryText) + '.</div>';
				} else if (failed.length === 0 && synced.length === 0) {
					html += '<div class="banner">' + escapeHtml(summaryText) + ': nothing needed updating.</div>';
				} else if (synced.length === 0 && unchanged.length === 0) {
					html += '<div class="banner error">' + escapeHtml(summaryText) + '.</div>';
				} else {
					html += '<div class="banner">' + escapeHtml(summaryText) + '.</div>';
				}
				// Result rows are numbered by their position in the section
				// (1..N), not by the canvas's internal tempId sequence.
				// tempId counts every node on the canvas: type-nodes,
				// pending placeholders, slot cards, so uploaded records
				// would otherwise display with gaps (3 accounts uploaded
				// \u2192 "#1 #2 #5" instead of "#1 #2 #3").
				if (synced.length > 0) {
					html += '<div class="upload-section-head upload-section-head--ok">Synced</div>' +
						'<div class="upload-summary" style="grid-template-columns: auto 1fr auto auto;">' +
							synced.map((r, i) => {
								const url = recordUrl(r.objectName, r.id);
								const idHtml = url
									? '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener"><code>' + escapeHtml(r.id) + '</code></a>'
									: '<code>' + escapeHtml(r.id) + '</code>';
								const modeLabel = r.mode === 'update' ? 'updated' : 'created';
								return '<div>#' + (i + 1) + '</div>' +
									'<div>' + escapeHtml(r.objectName) + '</div>' +
									'<div>' + idHtml + '</div>' +
									'<div class="tag">' + modeLabel + '</div>';
							}).join('') +
						'</div>';
				}
				if (unchanged.length > 0) {
					html += '<div class="upload-section-head upload-section-head--ok">Unchanged (skipped)</div>' +
						'<p class="tag" style="margin-top:-0.4em">These records were already in Salesforce and had no local edits, so we didn\u2019t touch them.</p>' +
						'<div class="upload-summary" style="grid-template-columns: auto 1fr auto;">' +
							unchanged.map((r, i) => {
								const url = recordUrl(r.objectName, r.id);
								const idHtml = url
									? '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener"><code>' + escapeHtml(r.id) + '</code></a>'
									: '<code>' + escapeHtml(r.id) + '</code>';
								return '<div>#' + (i + 1) + '</div>' +
									'<div>' + escapeHtml(r.objectName) + '</div>' +
									'<div>' + idHtml + '</div>';
							}).join('') +
						'</div>';
				}
				const dupFailed = failed.filter((r) => r && r.errorCode === 'DUPLICATES_DETECTED');
				if (failed.length > 0) {
					html += '<div class="upload-section-head upload-section-head--fail">Failed</div>';
					failed.forEach((r, i) => {
						const isDup = r && r.errorCode === 'DUPLICATES_DETECTED';
						html += '<div class="upload-failure-block">' +
							'<strong>#' + (i + 1) + ' ' + escapeHtml(r.objectName) + '</strong>' +
							'<div class="upload-failure-msg">' + escapeHtml(r.error || 'Unknown error') +
								(isDup ? ': a Salesforce duplicate rule matched an existing record.' : '') +
							'</div>' +
						'</div>';
					});
					// Duplicate-rule failures deserve their own exit: plain
					// Retry re-hits the same rule forever (alert-severity
					// rules allow saves in the SF UI but block API writes
					// without the duplicate-rule header). Offer the explicit
					// override; block-severity rules will still refuse it,
					// which is the org admin's intent.
					if (dupFailed.length > 0) {
						html += '<div class="banner" style="margin-top:0.6em">' +
							'<strong>' + dupFailed.length + ' record' + (dupFailed.length === 1 ? '' : 's') + ' blocked by Salesforce duplicate rules.</strong> ' +
							'If ' + (dupFailed.length === 1 ? 'this is' : 'these are') + ' intentional (not accidental duplicates), you can upload anyway; Salesforce will record the duplicate alert but accept the save. ' +
							'<button type="button" class="button secondary" id="upload-allow-dups" style="margin-left:0.4em;font-size:0.82rem;padding:0.2em 0.6em">Upload anyway</button>' +
						'</div>';
					}
				}
				// Deletes lane in the results panel. Mirrors the synced
				// section so the user reads a parallel three-row layout
				// (#, object, sfId). Adds the "not recallable" note so the
				// SF recycle-bin caveat is right next to the IDs; no
				// hunting through a History view to learn what's
				// recoverable.
				if (deleted.length > 0) {
					html += '<div class="upload-section-head upload-section-head--danger">Deleted in Salesforce</div>' +
						'<p class="tag" style="margin-top:-0.4em">These records are gone. Org Loom can’t undelete them; restore from the Salesforce recycle bin within 15 days if needed.</p>' +
						'<div class="upload-summary" style="grid-template-columns: auto 1fr auto;">' +
							deleted.map((d, i) => {
								return '<div>#' + (i + 1) + '</div>' +
									'<div>' + escapeHtml(d.objectName || '') + '</div>' +
									'<div><code>' + escapeHtml(d.sfId || '') + '</code></div>';
							}).join('') +
						'</div>';
				}
				if (deleteFailed.length > 0) {
					html += '<div class="upload-section-head upload-section-head--fail">Delete failed</div>';
					deleteFailed.forEach((d, i) => {
						html += '<div class="upload-failure-block">' +
							'<strong>#' + (i + 1) + ' ' + escapeHtml(d.objectName || '') + '</strong>' +
							'<div class="upload-failure-msg">' + escapeHtml(d.error || 'Unknown error') + '</div>' +
						'</div>';
					});
				}
				content.innerHTML = html;

				// Wire the duplicate-override affordance (rendered above only
				// when DUPLICATES_DETECTED failures exist). Arms the one-shot
				// flag, then re-enters the normal confirm flow; a fresh
				// attemptId is minted (the old one retired on entry here), so
				// idempotency bookkeeping treats this as a new attempt.
				const _allowDupsBtn = content.querySelector('#upload-allow-dups');
				if (_allowDupsBtn) {
					_allowDupsBtn.onclick = () => {
						_allowDuplicates = true;
						const _cb = uploadModal.querySelector('#upload-confirm');
						if (_cb) {
							_cb.onclick = confirmUpload;
						}
						confirmUpload();
					};
				}

				// Successfully-deleted cards no longer exist in SF and
				// shouldn't stay on the canvas with their red treatment
				// once the upload commits. Drop them from canvasState so
				// the post-upload renderBulkView leaves a clean canvas
				// matching the new SF state. Failed deletes stay on the
				// canvas (still pendingDelete) so the user can retry or
				// unmark.
				if (deleted.length > 0) {
					const deletedTempIds = new Set(deleted.map((d) => d.tempId));
					canvasState.bulkRecords = canvasState.bulkRecords.filter((r) => !deletedTempIds.has(r.id));
					canvasState.bulkAssociations = canvasState.bulkAssociations.filter((a) =>
						!deletedTempIds.has(a.fromId) && !deletedTempIds.has(a.toId)
					);
					deletedTempIds.forEach((id) => canvasState.bulkSelectedIds.delete(id));
				}
			
				// Tag synced records with their new Salesforce id so (a) they
				// show as "existing" on the canvas, (b) next upload becomes an
				// idempotent update, and (c) cross-object rule evaluation on
				// other records can still resolve references to them. Snapshot
				// rec.values as loadedValues so the card drops out of "modified"
				// state after a successful round trip. Unchanged records keep
				// their existing loadedFromId/loadedValues; they didn't move.
				const realIdByTempId = new Map(synced.map(r => [r.tempId, r.id]));
				// Build a runtime-id → real-SF-id index too. realIdByTempId
				// is keyed on tempId which equals runtime id at upload
				// time, so this map covers every newly-uploaded record.
				// We additively layer in existing loadedFromId values
				// from records that were already loaded (loadedFromId set
				// before upload) so associations targeting a pre-loaded
				// parent also resolve correctly when rewriting.
				const realIdByRuntimeId = new Map(realIdByTempId);
				canvasState.bulkRecords.forEach((rec) => {
					if (!realIdByRuntimeId.has(rec.id) && rec.loadedFromId) {
						realIdByRuntimeId.set(rec.id, rec.loadedFromId);
					}
				});
				// Rewrite FK fields on every child whose parent now has a
				// real SF id. Without this pass, values.AccountId (and
				// every other FK) stays as the auto-fill placeholder
				// the bulkAutoFill helper assigned at draft time, so
				// the canvas card displays as "Auto-filled sample
				// value ..." instead of the real parent id, and the AI
				// (reading via the relay) sees the placeholder too and
				// has no way to resolve which SF record the FK points
				// at. SF itself has the right value because the
				// composite-graph upload uses @{ref.id} substitution at
				// insert time; we're just bringing the browser's
				// in-memory state in sync with SF after the fact.
				(canvasState.bulkAssociations || []).forEach((a) => {
					if (!a || !a.fieldName) {
return;
}
					const child = canvasState.bulkRecords.find((r) => r.id === a.fromId);
					if (!child || !child.values) {
return;
}
					const parentRealId = realIdByRuntimeId.get(a.toId);
					if (!parentRealId) {
return;
}
					child.values[a.fieldName] = parentRealId;
				});
				// canonicalValues comes from the server's post-upload
				// re-query (one SOQL per object type after commit). It
				// holds what SF ACTUALLY HAS after triggers / workflows
				// / formula recomputes fired, which can differ from
				// what we wrote (a trigger normalizing Industry to a
				// canonical case, a workflow setting an audit field,
				// etc.). Patching rec.values from this keeps the
				// canvas in sync with SF truth; snapshotting
				// loadedValues from the canonical values means the
				// next edit's modified-badge math is anchored at the
				// post-trigger baseline (not what we wrote, which
				// would falsely flag every trigger-touched field).
				// Missing entries (re-query failed for the record's
				// object) fall back to the pre-existing behavior of
				// loadedValues = rec.values.
				const canonicalMap = canonicalValues && typeof canonicalValues === 'object' ? canonicalValues : {};
				canvasState.bulkRecords.forEach(rec => {
					if (realIdByTempId.has(rec.id)) {
						rec.loadedFromId = realIdByTempId.get(rec.id);
						// Make sure values.Id matches loadedFromId
						// too: the AI / UI both read values.Id as
						// the canonical "this record's SF id" key.
						rec.values = rec.values || {};
						rec.values.Id = realIdByTempId.get(rec.id);
						const canonical = canonicalMap[rec.id];
						if (canonical && typeof canonical === 'object') {
							// Overlay the post-trigger values onto rec.values.
							// We don't replace wholesale because canonical
							// only covers the fields the SELECT asked for;
							// any client-side metadata key (Id, lookups we
							// didn't write) stays untouched.
							for (const fieldName of Object.keys(canonical)) {
								if (!fieldName || fieldName.startsWith('_')) {
continue;
}
								rec.values[fieldName] = canonical[fieldName];
							}
						}
						rec.loadedValues = Object.assign({}, rec.values);
						_clearCommittedMigrationMatch(rec);
					}
				});
				renderBulkView();

				// Migrate-mode completion. If this run finished with no
				// failures AND there are no migratable records left on the
				// canvas (every record now has a destination id, either
				// freshly inserted or matched-then-updated), the migration is
				// done: stop tracking the durable snapshot and exit migrate
				// mode, but KEEP the canvas: it's now just a normal canvas in
				// the destination org. Partial runs (failures, or out-of-scope
				// drafts still pending) stay in migrate mode for the remainder.
				try {
					const _mig = window.Orgloom && window.Orgloom.canvasMigrate;
					if (_mig && _mig.isActive() && failed.length === 0 && deleteFailed.length === 0) {
						const _remaining = canvasState.bulkRecords.some(
							(r) => r && !r.isTypeNode && !r.pendingDelete && !r.loadedFromId,
						);
						if (!_remaining) {
							if (window.Orgloom.canvasOrgSwitch &&
								window.Orgloom.canvasOrgSwitch.migrationClear) {
								window.Orgloom.canvasOrgSwitch.migrationClear();
							}
							if (_mig.exit) {
								_mig.exit();
							}
							const _n = synced.length;
							const _doneMsg = _n > 0
								? 'Migration complete: ' + _n + ' record' + (_n === 1 ? '' : 's') +
									' now live in this org. You’re back to a normal canvas.'
								: 'Migration complete: everything was already up to date. You’re back to a normal canvas.';
							showBulkToast(_doneMsg);
						}
					}
				} catch (_e) {}

				// Turn the confirm button into a Close action now that upload is done.
				confirmBtn.disabled = false;
				confirmBtn.textContent = failed.length > 0 ? 'Retry failed' : 'Close';
				confirmBtn.onclick = failed.length > 0
					? (() => {
						// Re-enter confirm flow; restore the original handler.
						confirmBtn.onclick = confirmUpload;
						confirmUpload();
					})
					: closeUploadModal;
				// Hide Cancel after a fully-successful upload: the confirm button
				// now does the close action and a separate Cancel is redundant.
				const cancelBtn = uploadModal.querySelector('#upload-cancel');
				if (cancelBtn) {
cancelBtn.style.display = failed.length === 0 ? 'none' : '';
}
			}

			return {
				openUploadModal: openUploadModal,
				closeUploadModal: closeUploadModal,
				confirmUpload: confirmUpload,
				_runPendingUploadCleanup: _runPendingUploadCleanup,
				// Setters for the two cross-module pending lets. Used by
				// linked-csv's direct-upload path to register a state-
				// restoring cleanup + a deferred csv_import audit meta
				// before it calls openUploadModal. When upload-modal +
				// linked-csv lived in the same closure these were bare
				// assignments; now the module boundary makes them
				// unreachable, so writes go through these setters.
				setPendingUploadCleanup: function (fn) {
 _pendingUploadCleanup = fn; 
},
				setPendingCsvImportMeta: function (meta) {
 _pendingCsvImportMeta = meta; 
},
			};
		},
	};
})();
