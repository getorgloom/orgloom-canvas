(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.uploadModal = {
		mount: function mount(deps) {
			const required = [
				'canvasState', 'csrfFetch', 'escapeHtml',
				'showBulkToast', 'showConfirmDialog',
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

			const safeLoginHref = (u) => {
				if (typeof u === 'string' && /^\/(?![/\\])/.test(u)) {
					return escapeHtml(u);
				}
				return '/auth/login';
			};
			const showBulkToast = deps.showBulkToast;
			const showConfirmDialog = deps.showConfirmDialog;
			const validateBulkRecords = deps.validateBulkRecords;
			const computeUploadOrder = deps.computeUploadOrder;
			const isRecordModified = deps.isRecordModified;
			const isRecordPendingDelete = deps.isRecordPendingDelete;
			const recordOrdinal = deps.recordOrdinal;
			const renderBulkView = deps.renderBulkView;
			const startElapsedTicker = deps.startElapsedTicker;
			const ensureDescribe = deps.ensureDescribe;

			const _isLinkedCsvQuickUploadMode = deps.isLinkedCsvQuickUploadMode;

			const pingAuditEvent = typeof deps.pingAuditEvent === 'function' ? deps.pingAuditEvent : function () {};

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

					_runPendingUploadCleanup();
					return;
				}

				_preflightOverride = false;
				_bulkSwitchAcknowledged = false;

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

				const content = uploadModal.querySelector('#upload-modal-content');
				content.innerHTML = '<p class="center tag">Running pre-flight checks\u2026</p>';
				uploadModal.classList.remove('hidden');
				const uniqObjs = Array.from(new Set(canvasState.bulkRecords.map((r) => r.objectName)));
				await Promise.all(uniqObjs.map((n) => ensureDescribe(n).catch(() => null)));

				_renderUploadModalSummary();
			}

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

				const scopedRecords = _scopedRealRecords();
				const scopedIds = new Set(scopedRecords.map((r) => r.id));
				const autoExtendCount = _uploadScopeSelected ? _scopedAutoExtendCount() : 0;

				const _mig = window.Orgloom && window.Orgloom.canvasMigrate;
				const _migActive = !!(_mig && _mig.isActive());
				let _migBlocked = 0;
				let _migWarning = 0;
				if (_migActive) {
					scopedRecords.forEach((r) => {
						const a = _mig.annotationFor(r.id);
						if (a && a.status === 'blocked') {
							_migBlocked++;
						} else if (a && a.status === 'warning') {
							_migWarning++;
						}
					});
				}
				const migrateBanner = _migActive
					? '<div class="preflight ' +
						(_migBlocked > 0 ? 'has-errors' : (_migWarning > 0 ? 'has-warnings' : 'ok')) +
						'">' +
						'<span class="pf-icon">' + (_migBlocked > 0 ? '⚠' : (_migWarning > 0 ? 'i' : '✓')) + '</span>' +
						'<span class="pf-msg"><strong>Migrating to this org.</strong> ' +
						(_migBlocked > 0
							? _migBlocked + ' record' + (_migBlocked === 1 ? '' : 's') + ' can’t be migrated yet — resolve the <em>blocked</em> cards (missing record type or required field) before uploading.'
							: (_migWarning > 0
								? _migWarning + ' record' + (_migWarning === 1 ? '' : 's') + ' will migrate with fields dropped or picklist values skipped — review the <em>review</em> cards, or proceed.'
								: 'All records are ready to recreate in the destination org.')) +
						' <button type="button" class="link-button" data-migrate-match>Match existing records…</button>' +
						'</span></div>'
					: '';

				const { issues: rawIssues, byRecordId: rawByRecordId, missingDescribes } = validateBulkRecords();

				const issues = rawIssues.filter((i) => !i.recordId || scopedIds.has(i.recordId));
				const byRecordId = new Map();
				rawByRecordId.forEach((rIssues, rid) => {
					if (scopedIds.has(rid)) {
byRecordId.set(rid, rIssues);
}
				});
				const errorCount = issues.filter((i) => i.severity === 'error').length;
				const warningCount = issues.filter((i) => i.severity === 'warning').length;

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

				const orderResult = computeUploadOrder(unchangedSet, scopedIds, deleteIdSet);
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

				const deleteRowsHtml = deleteEntries.map((entry, idx) => (
					'<div class="us-step us-step-delete">' + (orderEntries.length + idx + 1) + '</div>' +
					'<div class="us-label">' + escapeHtml(entry.label) + ' <span class="us-detail tag tag-danger">DELETE</span></div>' +
					'<div class="us-count">' + entry.count + '</div>'
				)).join('');

				const totalRecords = scopedRecords.length;
				const totalAssoc = canvasState.bulkAssociations.filter((a) => (
					scopedIds.has(a.fromId) && scopedIds.has(a.toId)
				)).length;

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
								'<span class="pf-field">' + escapeHtml(iss.fieldLabel) + ' <code>' + escapeHtml(iss.field) + '</code></span> ' +
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

				const unchangedNote = unchangedSet.size > 0
					? '<p class="tag" style="margin-top:0.4em">' + unchangedSet.size + ' loaded record' + (unchangedSet.size === 1 ? '' : 's') + ' ' + (unchangedSet.size === 1 ? 'has' : 'have') + ' no local changes and will be skipped \u2014 only modified or new records will sync.</p>'
					: '';

				const autoExtendNote = autoExtendCount > 0
					? '<p class="tag" style="margin-top:0.4em">Also uploading ' + autoExtendCount + ' record' + (autoExtendCount === 1 ? '' : 's') + ' you didn’t select that your chosen records link to — without ' + (autoExtendCount === 1 ? 'it, that link' : 'them, those links') + ' would be blank in Salesforce.</p>'
					: '';

				const deletesBlock = deleteEntries.length > 0
					? '<div class="upload-section-head upload-section-head--danger">Then delete <span class="tag tag-danger">irreversible</span></div>' +
						'<p class="upload-deletes-lead">These records will be DELETE\'d in Salesforce after the creates/updates above. Deletes can\u2019t be undone from Org Loom \u2014 recover from the Salesforce recycle bin within 15 days if needed.</p>' +
						'<div class="upload-summary upload-summary--ordered upload-summary--deletes">' +
							deleteRowsHtml +
						'</div>'
					: '';
				const deletesTotalRow = willDeleteCount > 0
					? '<div class="ut-row ut-row--danger"><span>Will delete</span><strong>' + willDeleteCount + '</strong></div>'
					: '';
				content.innerHTML =
					scopeToggleHtml +
					migrateBanner +
					autoExtendNote +
					preflightHtml +
					'<p>Records will upload in the order below \u2014 parents first, so child FK lookups always resolve.</p>' +
					unchangedNote +
					'<div class="upload-section-head">Upload order</div>' +
					'<div class="upload-summary upload-summary--ordered">' +
						orderRows +
					'</div>' +
					deletesBlock +
					'<div class="upload-totals">' +
						'<div class="ut-row"><span>' + (_uploadScopeSelected ? 'Selected records' : 'Total records') + '</span><strong>' + totalRecords + '</strong></div>' +
						'<div class="ut-row"><span>Will sync</span><strong>' + willUploadCount + '</strong></div>' +
						deletesTotalRow +
						'<div class="ut-row"><span>Associations (FK links)</span><strong>' + totalAssoc + '</strong></div>' +
					'</div>';

				const _matchBtn = content.querySelector('[data-migrate-match]');
				if (_matchBtn) {
					_matchBtn.addEventListener('click', () => {
						const mm = window.Orgloom && window.Orgloom.migrateMatch;
						if (mm && mm.open) {
							mm.open({ onClose: () => _renderUploadModalSummary() });
						}
					});
				}

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

				const hasWork = willUploadCount > 0 || willDeleteCount > 0;
				if (_migActive && _migBlocked > 0) {

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

			let _pendingUploadCleanup = null;

			let _pendingCsvImportMeta = null;

			function _runPendingUploadCleanup() {

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

			let _preflightOverride = false;

			let _bulkSwitchAcknowledged = false;

			let _uploadScopeSelected = false;

			function _scopedRealRecords() {
				const real = canvasState.bulkRecords.filter((r) => !r.isTypeNode);
				if (!_uploadScopeSelected || canvasState.bulkSelectedIds.size === 0) {
return real;
}
				const realById = new Map(real.map((r) => [r.id, r]));
				const scope = new Set();
				real.forEach((r) => {
 if (canvasState.bulkSelectedIds.has(r.id)) {
scope.add(r.id);
} 
});

				let added = true;
				let safety = real.length + 1;
				while (added && safety-- > 0) {
					added = false;
					for (const a of canvasState.bulkAssociations) {
						if (!scope.has(a.fromId)) {
continue;
}
						if (scope.has(a.toId)) {
continue;
}
						const parent = realById.get(a.toId);
						if (!parent) {
continue;
}
						if (parent.loadedFromId) {
continue;
}
						scope.add(a.toId);
						added = true;
					}
				}
				return real.filter((r) => scope.has(r.id));
			}

			function _scopedAutoExtendCount() {
				if (!_uploadScopeSelected || canvasState.bulkSelectedIds.size === 0) {
return 0;
}
				const scoped = _scopedRealRecords();
				let extended = 0;
				for (const r of scoped) {
					if (!canvasState.bulkSelectedIds.has(r.id)) {
extended++;
}
				}
				return extended;
			}

			function _migrateUploadValues(r) {
				const base = (r && r.values) || {};
				const mig = window.Orgloom && window.Orgloom.canvasMigrate;
				if (!mig || !mig.isActive()) {
					return base;
				}
				const out = Object.assign({}, base);
				const ann = mig.annotationFor(r.id);
				if (ann && ann.resolvedRecordTypeId) {
					out.RecordTypeId = ann.resolvedRecordTypeId;
				}
				const remap = r._migratePicklistRemap;
				if (remap) {
					Object.keys(remap).forEach((field) => {
						let key = field;
						if (!Object.prototype.hasOwnProperty.call(out, key)) {
							const lk = field.toLowerCase();
							key = Object.keys(out).find((k) => k.toLowerCase() === lk) || field;
						}
						if (!Object.prototype.hasOwnProperty.call(out, key)) {
							return;
						}
						const map = remap[field] || {};
						const cur = out[key];
						if (cur == null) {
							return;
						}
						const s = String(cur);
						if (s.indexOf(';') !== -1) {

							out[key] = s.split(';')
								.map((p) => (Object.prototype.hasOwnProperty.call(map, p) ? map[p] : p))
								.filter((p) => p !== '')
								.join(';');
						} else if (Object.prototype.hasOwnProperty.call(map, s)) {
							const t = map[s];
							if (t === '') {
								delete out[key];
							} else {
								out[key] = t;
							}
						}
					});
				}
				return out;
			}

			let _uploadAttemptId = null;

			let _allowDuplicates = false;
			async function confirmUpload() {

				const realRecords = _scopedRealRecords();
				if (realRecords.length === 0) {
return;
}

				const userRecords = realRecords.filter((r) => r.objectName === 'User' && !r.loadedFromId);
				if (userRecords.length > 0) {
					const orgLabel = (_meInfo && _meInfo.orgType === 'production') ? 'PRODUCTION' : (_meInfo && _meInfo.orgType) || 'this org';
					const msg = 'You\'re about to create ' + userRecords.length + ' User record' + (userRecords.length === 1 ? '' : 's') + ' in ' + orgLabel + '.\n\n' +
						'\u2022 Each new User consumes a Salesforce license.\n' +
						'\u2022 Users CAN\'T be deleted, only deactivated — these stay in the org forever.\n' +
						'\u2022 Salesforce sends a welcome email on insert (suppressed when IsActive=false).\n\n' +
						'Proceed?';
					if (!(await showConfirmDialog({ title: 'Create User records?', message: msg, confirmLabel: 'Create users', cancelLabel: 'Cancel', danger: true }))) {
return;
}
				}
				const confirmBtn = uploadModal.querySelector('#upload-confirm');
				const cancelBtn = uploadModal.querySelector('[data-upload-close]');
				const content = uploadModal.querySelector('#upload-modal-content');

				const skipTempIds = realRecords
					.filter((r) => r.loadedFromId && !isRecordModified(r) && !r.pendingDelete)
					.map((r) => r.id);
				const recordsForPayload = realRecords.filter((r) => !r.pendingDelete);
				const deletesForPayload = realRecords.filter((r) => isRecordPendingDelete(r));

				const scopedIds = new Set(recordsForPayload.map((r) => r.id));
				const payload = {
					records: recordsForPayload.map(r => ({
						tempId: r.id,
						objectName: r.objectName,
						values: _migrateUploadValues(r),
						loadedFromId: r.loadedFromId || null,

						loadedValues: (r.loadedFromId && r.loadedValues) ? r.loadedValues : undefined,

						_csvOperation: r._csvOperation || undefined,
						_csvExternalIdField: r._csvExternalIdField || undefined,
					})),

					deletes: deletesForPayload.map(r => ({
						tempId: r.id,
						sfId: r.loadedFromId,
						objectName: r.objectName,
					})),
					associations: canvasState.bulkAssociations
						.filter((a) => scopedIds.has(a.fromId) && scopedIds.has(a.toId))
						.map((a) => ({
							fromId: a.fromId,
							toId: a.toId,
							fieldName: a.fieldName,
						})),
					skipTempIds,

					directUpload: _isLinkedCsvQuickUploadMode(),
				};

				if (!_uploadAttemptId) {
					_uploadAttemptId = (window.crypto && typeof crypto.randomUUID === 'function')
						? crypto.randomUUID()
						: ('att-' + Date.now() + '-' + Math.random().toString(36).slice(2));
				}
				payload.attemptId = _uploadAttemptId;

				if (_allowDuplicates) {
					payload.allowDuplicates = true;
				}

				const uploadingCountForGate = recordsForPayload.length - skipTempIds.length;
				const PER_COMPONENT_CAP = 75;
				const TOTAL_NODES_CAP = 500;
				const BYTE_CAP = 5 * 1024 * 1024;
				const components = (() => {

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

				const _UPLOAD_SYSTEM_FIELDS = new Set([
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

								delete r.values[k];
								return;
							}
							if (!known.has(k)) {
								delete r.values[k];

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
						'Dropped ' + _orphanStrippedCount + ' carry-over field value' +
							(_orphanStrippedCount === 1 ? '' : 's') +
							' across ' + _orphanStrippedRecordCount + ' record' +
							(_orphanStrippedRecordCount === 1 ? '' : 's') +
							' — those fields don\'t exist on this org\'s schema.',
						'warn',
					);
				}

				const payloadJson = JSON.stringify(payload);
				const fitsGraph = uploadingCountForGate > 0
					&& maxComponentSize <= PER_COMPONENT_CAP
					&& uploadingCountForGate <= TOTAL_NODES_CAP
					&& payloadJson.length <= BYTE_CAP;

				if (!_preflightOverride && !fitsGraph && uploadingCountForGate > 0) {
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
				if (!_preflightOverride && fitsGraph) {
					confirmBtn.disabled = true;
					confirmBtn.textContent = 'Uploading\u2026';
					content.innerHTML =
						'<p class="center busy-row" style="justify-content:center">' +
							'<span class="busy-spinner lg"></span>' +
							'<span>Uploading ' + uploadingCountForGate + ' record' + (uploadingCountForGate === 1 ? '' : 's') + ' atomically\u2026</span>' +
						'</p>' +
						'<p class="tag center">Validation and commit happen in one step \u2014 if anything fails, nothing is saved.</p>';
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

						console.warn('[graph upload] failed, falling back:', err);

						try { await reconcileLostUpload(payload.records); } catch (_e) {                   }
					}
				}

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

				if (!_preflightOverride) {
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

						console.warn('[preflight] request failed, allowing upload:', err);
						pf = { ok: true, sampled: 0, skipped: true };
					}
					if (!pf.ok) {
						renderPreflightFailure(pf);
						return;
					}

					const skippedNote = pf.skipped
						? ' <span class="tag">(no new records to validate)</span>'
						: ' <span class="tag">(' + pf.sampled + ' record' + (pf.sampled === 1 ? '' : 's') + ' sampled)</span>';
					content.innerHTML = '<p class="center">Pre-flight passed' + skippedNote + ' \u2014 starting upload\u2026</p>';
				}

				confirmBtn.disabled = true;
				confirmBtn.textContent = 'Uploading\u2026';

				const hasUpsert = realRecords.some((r) => r._csvOperation === 'upsert');
				const useBulk = hasUpsert || realRecords.length > BULK_THRESHOLD;
				if (useBulk) {
					try {
						await runBulkUploadSSE(payload, content);
					} catch (err) {

						let recovered = 0;
						try { recovered = await reconcileLostUpload(payload.records); } catch (_e) { recovered = 0; }
						if (recovered > 0) {
							content.innerHTML = '<div class="banner">Connection dropped mid-upload — but ' + recovered + ' record' + (recovered === 1 ? '' : 's') + ' had already saved to Salesforce. ' + (recovered === 1 ? 'It\u2019s' : 'They\u2019re') + ' now marked as uploaded, so retrying won\u2019t create duplicates. Click Retry to finish any records that didn\u2019t save.</div>';
						} else {
							content.innerHTML = '<div class="banner error">Upload failed: ' + escapeHtml(err.message || String(err)) + '</div>';
						}
						confirmBtn.disabled = false;
						confirmBtn.textContent = 'Retry';
					}
					return;
				}

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
					'<p class="tag center">Records upload one at a time \u2014 expect ~5\u201310 records per second.</p>' +
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

					let recovered = 0;
					try {
						recovered = await reconcileLostUpload(payload.records);
					} catch (_e) {
						recovered = 0;
					}
					if (recovered > 0) {
						content.innerHTML = '<div class="banner">Connection dropped mid-upload — but ' + recovered + ' record' + (recovered === 1 ? '' : 's') + ' had already saved to Salesforce. ' + (recovered === 1 ? 'It\u2019s' : 'They\u2019re') + ' now marked as uploaded, so retrying won\u2019t create duplicates. Click Retry to finish any records that didn\u2019t save.</div>';
					} else {
						content.innerHTML = '<div class="banner error">Upload failed: ' + escapeHtml(err.message || String(err)) + '</div>';
					}
					confirmBtn.disabled = false;
					confirmBtn.textContent = 'Retry';
				}
			}

			const BULK_THRESHOLD = 150;

			function humanizeState(s) {
				if (!s) {
return '';
}
				const out = String(s).replace(/([a-z])([A-Z])/g, '$1 $2');
				return out.charAt(0).toUpperCase() + out.slice(1).toLowerCase();
			}

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

				let plan = null;

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

				displayUploadResults(finalResults, finalInstanceUrl, finalDeletes, finalCanonicalValues);
			}

			function renderPreflightFailure(pf) {
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
								'These errors come from a real validation pass against ' + (pf.sampled || 0) + ' sample record' + (pf.sampled === 1 ? '' : 's') + ' (rolled back \u2014 nothing was committed). Fix them and retry, or upload anyway to see the same errors per-record.' +
							'</span>' +
						'</div>' +
						'<div class="pf-body">' + sections + '</div>' +
					'</div>';
				confirmBtn.disabled = false;
				confirmBtn.textContent = 'Upload anyway';
				confirmBtn.classList.add('confirm-anyway');
				_preflightOverride = true;
			}

			function _applyRecoveredIds(realIdByTempId) {
				canvasState.bulkRecords.forEach((rec) => {
					if (realIdByTempId.has(rec.id) && !rec.loadedFromId) {
						rec.loadedFromId = realIdByTempId.get(rec.id);
						rec.values = rec.values || {};
						rec.values.Id = realIdByTempId.get(rec.id);
						rec.loadedValues = Object.assign({}, rec.values);
					}
				});
				if (typeof renderBulkView === 'function') {
					renderBulkView();
				}
			}

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

			function renderAttemptIncomplete(body) {
				const content = uploadModal.querySelector('#upload-modal-content');
				const confirmBtn = uploadModal.querySelector('#upload-confirm');
				if (content) {
					content.innerHTML =
						'<div class="banner">' +
							'<strong>Previous attempt didn’t finish.</strong> ' +
							escapeHtml((body && body.message) || 'An earlier upload with this attempt id may have saved these records to Salesforce. To avoid duplicates, this retry was paused.') +
						'</div>' +
						'<p class="tag" style="margin-top:0.5em">Open <strong>Upload History</strong> (the ↻ button in the toolbar) to see what landed, or refresh the affected records from Salesforce. Close this dialog once you’ve reconciled — a fresh upload then starts a new attempt.</p>';
				}

				_uploadAttemptId = null;
				if (confirmBtn) {
					confirmBtn.disabled = true;
				}
			}

			function displayUploadResults(results, instanceUrl, deletesResults, canonicalValues) {

				_uploadAttemptId = null;
				_allowDuplicates = false;
				const content = uploadModal.querySelector('#upload-modal-content');
				const confirmBtn = uploadModal.querySelector('#upload-confirm');

				const synced = results.filter(r => r.success && r.mode !== 'unchanged');
				const unchanged = results.filter(r => r.success && r.mode === 'unchanged');
				const failed = results.filter(r => !r.success);
				const deletesArr = Array.isArray(deletesResults) ? deletesResults : [];
				const deleted = deletesArr.filter((d) => d && d.success);
				const deleteFailed = deletesArr.filter((d) => d && !d.success);

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
					html += '<div class="banner">' + escapeHtml(summaryText) + ' — nothing needed updating.</div>';
				} else if (synced.length === 0 && unchanged.length === 0) {
					html += '<div class="banner error">' + escapeHtml(summaryText) + '.</div>';
				} else {
					html += '<div class="banner">' + escapeHtml(summaryText) + '.</div>';
				}

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
								(isDup ? ' — a Salesforce duplicate rule matched an existing record.' : '') +
							'</div>' +
						'</div>';
					});

					if (dupFailed.length > 0) {
						html += '<div class="banner" style="margin-top:0.6em">' +
							'<strong>' + dupFailed.length + ' record' + (dupFailed.length === 1 ? '' : 's') + ' blocked by Salesforce duplicate rules.</strong> ' +
							'If ' + (dupFailed.length === 1 ? 'this is' : 'these are') + ' intentional (not accidental duplicates), you can upload anyway — Salesforce will record the duplicate alert but accept the save. ' +
							'<button type="button" class="button secondary" id="upload-allow-dups" style="margin-left:0.4em;font-size:0.82rem;padding:0.2em 0.6em">Upload anyway</button>' +
						'</div>';
					}
				}

				if (deleted.length > 0) {
					html += '<div class="upload-section-head upload-section-head--danger">Deleted in Salesforce</div>' +
						'<p class="tag" style="margin-top:-0.4em">These records are gone. Org Loom can’t undelete them — restore from the Salesforce recycle bin within 15 days if needed.</p>' +
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

				if (deleted.length > 0) {
					const deletedTempIds = new Set(deleted.map((d) => d.tempId));
					canvasState.bulkRecords = canvasState.bulkRecords.filter((r) => !deletedTempIds.has(r.id));
					canvasState.bulkAssociations = canvasState.bulkAssociations.filter((a) =>
						!deletedTempIds.has(a.fromId) && !deletedTempIds.has(a.toId)
					);
					deletedTempIds.forEach((id) => canvasState.bulkSelectedIds.delete(id));
				}

				// idempotent update, and (c) cross-object rule evaluation on

				const realIdByTempId = new Map(synced.map(r => [r.tempId, r.id]));

				const realIdByRuntimeId = new Map(realIdByTempId);
				canvasState.bulkRecords.forEach((rec) => {
					if (!realIdByRuntimeId.has(rec.id) && rec.loadedFromId) {
						realIdByRuntimeId.set(rec.id, rec.loadedFromId);
					}
				});

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

				const canonicalMap = canonicalValues && typeof canonicalValues === 'object' ? canonicalValues : {};
				canvasState.bulkRecords.forEach(rec => {
					if (realIdByTempId.has(rec.id)) {
						rec.loadedFromId = realIdByTempId.get(rec.id);

						rec.values = rec.values || {};
						rec.values.Id = realIdByTempId.get(rec.id);
						const canonical = canonicalMap[rec.id];
						if (canonical && typeof canonical === 'object') {

							for (const fieldName of Object.keys(canonical)) {
								if (!fieldName || fieldName.startsWith('_')) {
continue;
}
								rec.values[fieldName] = canonical[fieldName];
							}
						}
						rec.loadedValues = Object.assign({}, rec.values);
					}
				});
				renderBulkView();

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
								? 'Migration complete — ' + _n + ' record' + (_n === 1 ? '' : 's') +
									' now live in this org. You’re back to a normal canvas.'
								: 'Migration complete — everything was already up to date. You’re back to a normal canvas.';
							showBulkToast(_doneMsg);
						}
					}
				} catch (_e) {}

				confirmBtn.disabled = false;
				confirmBtn.textContent = failed.length > 0 ? 'Retry failed' : 'Close';
				confirmBtn.onclick = failed.length > 0
					? (() => {

						confirmBtn.onclick = confirmUpload;
						confirmUpload();
					})
					: closeUploadModal;

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
