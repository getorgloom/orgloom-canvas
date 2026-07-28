(function () {
	'use strict';
	// Freezes a validated canvas snapshot, submits it, and reconciles only confirmed successes.

	window.OrgLoom = window.OrgLoom || {};

	function scopeUploadRecords(records, selectedIds, selectedOnly) {
		const real = (records || []).filter((r) => r && !r.isTypeNode);
		if (!selectedOnly || !selectedIds || selectedIds.size === 0) {
			return real;
		}
		// "Selected only" is literal; related drafts are never silently added to the upload.
		return real.filter((r) => selectedIds.has(r.id));
	}

	function excludedDraftParentLinks(records, associations, scopedIds, selectedOnly) {
		if (!selectedOnly || !scopedIds || scopedIds.size === 0) {
			return [];
		}
		const realById = new Map((records || []).filter((r) => r && !r.isTypeNode).map((r) => [r.id, r]));
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
		return (associations || []).filter((a) => a && scopedIds.has(a.fromId) && scopedIds.has(a.toId));
	}

	function requiredExcludedDraftParentLinks(records, links, describeCache) {
		const realById = new Map((records || []).filter((r) => r && !r.isTypeNode).map((r) => [r.id, r]));
		return (links || []).filter((link) => {
			const child = realById.get(link.fromId);
			if (!child || child.loadedFromId) {
				return false;
			}
			const describe = describeCache && describeCache[child.objectName];
			const field =
				describe && Array.isArray(describe.fields)
					? describe.fields.find((f) => f && f.name === link.fieldName)
					: null;
			return !!(
				field &&
				field.type === 'reference' &&
				field.createable !== false &&
				field.required &&
				!field.defaultedOnCreate
			);
		});
	}

	function scopeUploadValues(record, values, excludedDraftLinks) {
		const scopedValues = Object.assign({}, values || {});
		if (!record) {
			return scopedValues;
		}
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
		const objectLabel =
			count === 1
				? (describe && describe.label) || objectName
				: (describe && describe.labelPlural) ||
					(describe && describe.label ? describe.label + 's' : objectName + 's');
		return 'Uploading ' + count + ' ' + objectLabel + '…';
	}

	function describeLoadFailureSummary(failures, missingDescribes) {
		const failed = Array.isArray(failures) ? failures : [];
		const missing = Array.from(missingDescribes || []).filter(Boolean);
		const connectionFailure = failed.some(
			(failure) => failure && (failure.code === 'no-active-connection' || failure.code === 'sf-session-expired'),
		);
		if (connectionFailure) {
			return {
				kind: 'connection',
				heading: 'Salesforce needs to be reconnected.',
				message:
					'Org Loom could not use its Salesforce connection to check these records. Signing in to Salesforce in another tab does not restore the connection. Reconnect here, then reopen Upload.',
				action: 'Reconnect Salesforce',
			};
		}
		return {
			kind: 'retry',
			heading: 'Salesforce field information could not be loaded.',
			message:
				'Org Loom could not pre-flight check ' +
				(missing.length > 0 ? missing.join(', ') : 'these records') +
				'. Retry the check before uploading. If it continues, reconnect Salesforce.',
			action: 'Retry pre-flight checks',
		};
	}

	function approvalRequiredMessage(body) {
		if (body && body.message) {
			return body.message;
		}
		if (body && body.approvalStatus === 'pending') {
			return 'Org Loom automatically created an access request for this Salesforce org. Any workspace admin can approve it in Workspace settings. After approval, retry this action.';
		}
		return 'This Salesforce org requires workspace approval. Any workspace admin can review and approve access in Workspace settings, then you can retry this action.';
	}

	function csvReportCell(value) {
		let text = value == null ? '' : String(value);
		// Keep spreadsheet applications from interpreting report content as formulas.
		if (/^[=+\-@]/.test(text)) {
			text = "'" + text;
		}
		return '"' + text.replace(/"/g, '""') + '"';
	}

	function buildUploadResultsCsv(results, records) {
		const recordByTempId = new Map(
			(records || []).filter((record) => record && record.id != null).map((record) => [record.id, record]),
		);
		const header = ['Source file', 'CSV row', 'Object', 'Status', 'Salesforce ID', 'Error'];
		const rows = (results || []).map((result) => {
			const record = recordByTempId.get(result && result.tempId);
			let status = 'Failed';
			if (result && result.success) {
				status = result.mode === 'update' ? 'Updated' : result.mode === 'unchanged' ? 'Unchanged' : 'Created';
			}
			return [
				record && record._csvSourceFile,
				record && record._csvSourceRow,
				(result && result.objectName) || (record && record.objectName),
				status,
				result && result.success ? result.id : '',
				result && !result.success ? result.error || 'Unknown error' : '',
			];
		});
		return (
			[header]
				.concat(rows)
				.map((row) => row.map(csvReportCell).join(','))
				.join('\r\n') + '\r\n'
		);
	}

	window.OrgLoom.uploadModal = {
		scopeUploadRecords: scopeUploadRecords,
		excludedDraftParentLinks: excludedDraftParentLinks,
		scopeUploadAssociations: scopeUploadAssociations,
		requiredExcludedDraftParentLinks: requiredExcludedDraftParentLinks,
		scopeUploadValues: scopeUploadValues,
		formatUploadProgress: formatUploadProgress,
		describeLoadFailureSummary: describeLoadFailureSummary,
		approvalRequiredMessage: approvalRequiredMessage,
		buildUploadResultsCsv: buildUploadResultsCsv,
		mount: function mount(deps) {
			const required = [
				'canvasState',
				'csrfFetch',
				'escapeHtml',
				'showBulkToast',
				'showConfirmDialog',
				'showBulkSwitchWarning',
				'validateBulkRecords',
				'computeUploadOrder',
				'isRecordModified',
				'isRecordPendingDelete',
				'recordOrdinal',
				'renderBulkView',
				'startElapsedTicker',
				'ensureDescribe',
				'isLinkedCsvQuickUploadMode',
				'getMeInfo',
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
			const showBulkSwitchWarning = deps.showBulkSwitchWarning;
			const validateBulkRecords = deps.validateBulkRecords;
			const computeUploadOrder = deps.computeUploadOrder;
			const isRecordModified = deps.isRecordModified;
			const isRecordPendingDelete = deps.isRecordPendingDelete;
			const recordOrdinal = deps.recordOrdinal;
			const renderBulkView = deps.renderBulkView;
			const startElapsedTicker = deps.startElapsedTicker;
			const ensureDescribe = deps.ensureDescribe;
			const _isLinkedCsvQuickUploadMode = deps.isLinkedCsvQuickUploadMode;
			const getMeInfo = deps.getMeInfo;
			const pingAuditEvent = typeof deps.pingAuditEvent === 'function' ? deps.pingAuditEvent : function () {};
			const markCanvasGuideUploadComplete =
				typeof deps.markCanvasGuideUploadComplete === 'function'
					? deps.markCanvasGuideUploadComplete
					: function () {};

			let _describeLoadFailures = [];
			const uploadModal = document.createElement('div');
			uploadModal.className = 'modal hidden';
			uploadModal.innerHTML =
				'<div class="modal-overlay"></div>' +
				'<div class="modal-body">' +
				'<div class="modal-header">' +
				'<h3>Upload records to Salesforce</h3>' +
				'<button class="modal-close" data-upload-close>&times;</button>' +
				'</div>' +
				'<div class="modal-content" id="upload-modal-content"></div>' +
				'<div class="modal-footer">' +
				'<button type="button" class="button secondary" id="upload-results-csv" hidden style="margin-right:auto">Download CSV report</button>' +
				'<button class="button secondary" id="upload-cancel" data-upload-close>Cancel</button>' +
				'<button class="button" id="upload-confirm">Upload</button>' +
				'</div>' +
				'</div>';
			document.body.appendChild(uploadModal);
			uploadModal
				.querySelectorAll('[data-upload-close]')
				.forEach((el) => el.addEventListener('click', closeUploadModal));
			document.addEventListener('keydown', (e) => {
				if (e.key === 'Escape' && !uploadModal.classList.contains('hidden')) {
					closeUploadModal();
				}
			});
			uploadModal.querySelector('#upload-confirm').onclick = confirmUpload;

			function renderApprovalRequired(contentEl, confirmBtn, body) {
				_uploadAttemptId = null;
				contentEl.innerHTML =
					'<div class="banner error"><strong>Workspace approval required.</strong> ' +
					escapeHtml(approvalRequiredMessage(body)) +
					'</div><p class="tag center">No Salesforce records were written.</p>';
				confirmBtn.disabled = false;
				confirmBtn.textContent = 'Retry';
			}

			function renderActiveOrgChanged(contentEl, confirmBtn, body) {
				_uploadAttemptId = null;
				contentEl.innerHTML =
					'<div class="banner error"><strong>Salesforce org changed.</strong> ' +
					escapeHtml(
						(body && body.message) ||
							'Nothing was uploaded. Close this window and reopen Quick Upload to remap your files.',
					) +
					'</div>';
				confirmBtn.disabled = true;
				confirmBtn.textContent = 'Upload';
			}

			async function openUploadModal(opts) {
				resetResultsCsvAction();
				if (canvasState.bulkRecords.length === 0) {
					showBulkToast('No records to upload.');
					_runPendingUploadCleanup();
					return;
				}
				_preflightOverride = false;
				_bulkSwitchAcknowledged = false;
				const _allRealCount = canvasState.bulkRecords.filter((r) => !r.isTypeNode).length;
				const _selectedRealCount = canvasState.bulkRecords.filter(
					(r) => !r.isTypeNode && canvasState.bulkSelectedIds.has(r.id),
				).length;
				const _wantSelected =
					opts &&
					opts.initialScope === 'selected' &&
					_selectedRealCount > 0 &&
					_selectedRealCount < _allRealCount;
				_uploadScopeSelected = !!_wantSelected;
				const confirmBtn = uploadModal.querySelector('#upload-confirm');
				confirmBtn.disabled = false;
				confirmBtn.textContent = 'Upload';
				confirmBtn.classList.remove('confirm-anyway');
				confirmBtn.style.display = '';
				confirmBtn.onclick = confirmUpload;
				const cancelBtn = uploadModal.querySelector('#upload-cancel');
				if (cancelBtn) {
					cancelBtn.style.display = '';
					cancelBtn.textContent = 'Cancel';
				}

				const content = uploadModal.querySelector('#upload-modal-content');
				content.innerHTML = '<p class="center tag">Running pre-flight checks\u2026</p>';
				uploadModal.classList.remove('hidden');
				const uniqObjs = Array.from(
					new Set(
						canvasState.bulkRecords
							.filter((record) => record && !record.isTypeNode && record.objectName)
							.map((record) => record.objectName),
					),
				);
				_describeLoadFailures = (
					await Promise.all(
						uniqObjs.map(async (name) => {
							try {
								await ensureDescribe(name);
								return null;
							} catch (error) {
								return {
									name,
									code: error && error.code,
									status: error && error.status,
								};
							}
						}),
					)
				).filter(Boolean);

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
				const excludedDraftLinks = _uploadScopeSelected ? _scopedExcludedDraftParentLinks() : [];
				const requiredExcludedDraftLinks = requiredExcludedDraftParentLinks(
					canvasState.bulkRecords,
					excludedDraftLinks,
					canvasState.describeCache,
				);
				const optionalExcludedDraftLinkCount = excludedDraftLinks.length - requiredExcludedDraftLinks.length;

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
						(_migBlocked > 0 || _migMatchBlocked > 0
							? 'has-errors'
							: _migWarning > 0
								? 'has-warnings'
								: 'ok') +
						'">' +
						'<span class="pf-icon">' +
						(_migBlocked > 0 || _migMatchBlocked > 0 ? '⚠' : _migWarning > 0 ? 'i' : '✓') +
						'</span>' +
						'<span class="pf-msg"><strong>Migrating to this org.</strong> ' +
						(_migMatchUnresolved > 0
							? _migMatchUnresolved +
								' record' +
								(_migMatchUnresolved === 1 ? '' : 's') +
								' still needs an action. Open <em>Review migration</em> and choose Update existing with a destination record, or Create new.'
							: _migDuplicateTargets > 0
								? 'More than one canvas record is assigned to the same destination record. Review the record actions before uploading.'
								: _migBlocked > 0
									? _migBlocked +
										' record' +
										(_migBlocked === 1 ? '' : 's') +
										' can’t be migrated yet. Open <em>Review migration</em> and resolve the required destination differences.'
									: _migWarning > 0
										? _migWarning +
											' record' +
											(_migWarning === 1 ? '' : 's') +
											' has values that will be omitted unless resolved. Review the migration plan, or proceed.'
										: 'All records are ready to recreate in the destination org.') +
						' <button type="button" class="link-button" data-migrate-review>Review migration…</button>' +
						'</span></div>'
					: '';

				const { issues: rawIssues, byRecordId: rawByRecordId, missingDescribes } = validateBulkRecords();
				const issues = rawIssues.filter((i) => !i.recordId || scopedIds.has(i.recordId));
				const byRecordId = new Map();
				rawByRecordId.forEach((rIssues, rid) => {
					if (scopedIds.has(rid)) {
						byRecordId.set(rid, rIssues.slice());
					}
				});
				requiredExcludedDraftLinks.forEach((link) => {
					const rec = scopedRecords.find((r) => r.id === link.fromId);
					if (!rec) {
						return;
					}
					const describe = canvasState.describeCache[rec.objectName];
					const field =
						describe && Array.isArray(describe.fields)
							? describe.fields.find((f) => f && f.name === link.fieldName)
							: null;
					const issue = {
						recordId: rec.id,
						objectName: rec.objectName,
						recordLabel: (rec.label || rec.objectName) + ' #' + recordOrdinal(rec),
						field: link.fieldName,
						fieldLabel: (field && field.label) || link.fieldName,
						severity: 'error',
						message:
							'This required relationship points to an unselected draft and won’t be included. Select the related draft too.',
					};
					issues.push(issue);
					const recordIssues = byRecordId.get(rec.id) || [];
					recordIssues.push(issue);
					byRecordId.set(rec.id, recordIssues);
				});
				const errorCount = issues.filter((i) => i.severity === 'error').length;
				const warningCount = issues.filter((i) => i.severity === 'warning').length;

				const realRecordsForCount = scopedRecords;
				const deleteIdSet = new Set(realRecordsForCount.filter(isRecordPendingDelete).map((r) => r.id));
				const unchangedTempIds = realRecordsForCount
					.filter((r) => r.loadedFromId && !isRecordModified(r) && !r.pendingDelete)
					.map((r) => r.id);
				const unchangedSet = new Set(unchangedTempIds);
				const willUploadCount = realRecordsForCount.length - unchangedSet.size - deleteIdSet.size;
				const willDeleteCount = deleteIdSet.size;

				const orderResult = computeUploadOrder(unchangedSet, scopedIds, deleteIdSet);
				const cycleIds = orderResult.cycleIds || new Set();
				const orderEntries = orderResult.creates.filter((e) => e.upload > 0);
				const deleteEntries = orderResult.deletes;
				const orderRows = orderEntries
					.map((entry, idx) => {
						const detail =
							entry.unchanged > 0
								? '<span class="us-detail tag">' + entry.unchanged + ' unchanged skipped</span>'
								: '';
						return (
							'<div class="us-step">' +
							(idx + 1) +
							'</div>' +
							'<div class="us-label">' +
							escapeHtml(entry.label) +
							' ' +
							detail +
							'</div>' +
							'<div class="us-count">' +
							entry.upload +
							'</div>'
						);
					})
					.join('');
				const deleteRowsHtml = deleteEntries
					.map(
						(entry, idx) =>
							'<div class="us-step us-step-delete">' +
							(orderEntries.length + idx + 1) +
							'</div>' +
							'<div class="us-label">' +
							escapeHtml(entry.label) +
							' <span class="us-detail tag tag-danger">DELETE</span></div>' +
							'<div class="us-count">' +
							entry.count +
							'</div>',
					)
					.join('');
				const totalRecords = willUploadCount + willDeleteCount;
				const scopeToggleHtml = canScope
					? '<div class="upload-scope-toggle">' +
						'<button type="button" class="upload-scope-btn' +
						(_uploadScopeSelected ? '' : ' is-active') +
						'" data-upload-scope="all">' +
						'All records (' +
						allReal.length +
						')' +
						'</button>' +
						'<button type="button" class="upload-scope-btn' +
						(_uploadScopeSelected ? ' is-active' : '') +
						'" data-upload-scope="selected">' +
						'Selected only (' +
						selectedRealCount +
						')' +
						'</button>' +
						'</div>'
					: '';

				const describeFailure =
					missingDescribes.size > 0 || _describeLoadFailures.length > 0
						? describeLoadFailureSummary(_describeLoadFailures, missingDescribes)
						: null;
				let preflightHtml = '';
				if (issues.length === 0 && !describeFailure) {
					preflightHtml =
						'<div class="preflight ok">' +
						'<span class="pf-icon">\u2713</span>' +
						'<span class="pf-msg"><strong>Pre-flight passed.</strong> All records look ready to upload.</span>' +
						'</div>';
				} else if (issues.length > 0) {
					const recordSections = Array.from(byRecordId.entries())
						.map(([rid, rIssues]) => {
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
							const items = rIssues
								.map(
									(iss) =>
										'<li class="pf-item pf-' +
										iss.severity +
										'">' +
										'<span class="pf-field">' +
										escapeHtml(iss.fieldLabel) +
										' (<code>' +
										escapeHtml(iss.field) +
										'</code>)</span> ' +
										'<span class="pf-msg-text">' +
										escapeHtml(iss.message) +
										'</span>' +
										'</li>',
								)
								.join('');
							return (
								'<details class="pf-record"' +
								(errs > 0 ? ' open' : '') +
								'>' +
								'<summary>' +
								'<span class="pf-rec-label">' +
								escapeHtml(first.recordLabel) +
								'</span>' +
								'<span class="pf-rec-counts">' +
								summaryParts.join(' \u00b7 ') +
								'</span>' +
								'</summary>' +
								'<ul class="pf-issues">' +
								items +
								'</ul>' +
								'</details>'
							);
						})
						.join('');
					preflightHtml =
						'<div class="preflight ' +
						(errorCount > 0 ? 'has-errors' : 'has-warnings') +
						'">' +
						'<div class="pf-head">' +
						'<span class="pf-icon">' +
						(errorCount > 0 ? '\u26A0' : 'i') +
						'</span>' +
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
						'<div class="pf-body">' +
						recordSections +
						'</div>' +
						'</div>';
				}
				if (describeFailure) {
					preflightHtml +=
						'<div class="preflight has-errors">' +
						'<span class="pf-icon">\u26A0</span>' +
						'<span class="pf-msg"><strong>' +
						escapeHtml(describeFailure.heading) +
						'</strong> ' +
						escapeHtml(describeFailure.message) +
						'</span>' +
						'</div>';
				}
				if (cycleIds.size > 0) {
					preflightHtml =
						'<div class="preflight has-errors">' +
						'<span class="pf-icon">⚠</span>' +
						'<span class="pf-msg"><strong>Reference cycle detected.</strong> ' +
						cycleIds.size +
						' record' +
						(cycleIds.size === 1 ? '' : 's') +
						' depend on each other. Break the cycle on the canvas before uploading; no records have been sent to Salesforce.</span>' +
						'</div>';
				}

				const unchangedNote =
					unchangedSet.size > 0
						? '<p class="tag" style="margin-top:0.4em">' +
							unchangedSet.size +
							' loaded record' +
							(unchangedSet.size === 1 ? '' : 's') +
							' ' +
							(unchangedSet.size === 1 ? 'has' : 'have') +
							' no local changes and will be skipped: only modified or new records will sync.</p>'
						: '';
				const excludedDraftLinkNote =
					optionalExcludedDraftLinkCount > 0
						? '<div class="preflight has-warnings">' +
							'<span class="pf-icon">i</span>' +
							'<span class="pf-msg"><strong>Some relationships won’t be included.</strong> ' +
							optionalExcludedDraftLinkCount +
							' relationship' +
							(optionalExcludedDraftLinkCount === 1 ? '' : 's') +
							' point' +
							(optionalExcludedDraftLinkCount === 1 ? 's' : '') +
							' to an unselected draft. Only the selected ' +
							'record' +
							(scopedRecords.length === 1 ? '' : 's') +
							' will upload. Select the related draft' +
							(optionalExcludedDraftLinkCount === 1 ? '' : 's') +
							' too if you want Salesforce to preserve ' +
							(optionalExcludedDraftLinkCount === 1 ? 'that relationship' : 'those relationships') +
							'.</span>' +
							'</div>'
						: '';
				const deletesBlock =
					deleteEntries.length > 0
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
					'<div class="ut-row"><span>Total records</span><strong>' +
					totalRecords +
					'</strong></div>' +
					'</div>';
				const _matchBtn = content.querySelector('[data-migrate-review]');
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
				if (describeFailure) {
					confirmBtn.style.display = '';
					confirmBtn.disabled = false;
					confirmBtn.textContent = describeFailure.action;
					confirmBtn.classList.remove('confirm-anyway');
					confirmBtn.classList.remove('confirm-danger');
					confirmBtn.onclick = () => {
						if (describeFailure.kind === 'connection') {
							const chip = document.getElementById('app-sf-chip');
							if (chip) {
								chip.click();
							}
							return;
						}
						openUploadModal({ initialScope: _uploadScopeSelected ? 'selected' : 'all' });
					};
					if (cancelBtn) {
						cancelBtn.textContent = 'Close';
					}
				} else if (cycleIds.size > 0) {
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
					confirmBtn.textContent =
						_migMatchUnresolved > 0
							? 'Resolve ' + _migMatchUnresolved + ' match' + (_migMatchUnresolved === 1 ? '' : 'es')
							: 'Resolve duplicate matches';
					confirmBtn.classList.remove('confirm-anyway');
					confirmBtn.classList.remove('confirm-danger');
					if (cancelBtn) {
						cancelBtn.textContent = 'Cancel';
					}
				} else if (_migActive && _migBlocked > 0) {
					confirmBtn.style.display = '';
					confirmBtn.disabled = true;
					confirmBtn.textContent =
						'Resolve ' + _migBlocked + ' blocked record' + (_migBlocked === 1 ? '' : 's');
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
							: scopeLabel
								? 'Upload selected anyway'
								: 'Upload anyway';
						confirmBtn.classList.add('confirm-anyway');
					} else if (deletesOnly) {
						confirmBtn.textContent =
							'Delete ' + willDeleteCount + ' record' + (willDeleteCount === 1 ? '' : 's');
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
				resetResultsCsvAction();
				_runPendingUploadCleanup();
			}

			function resetResultsCsvAction() {
				const button = uploadModal.querySelector('#upload-results-csv');
				if (button) {
					button.hidden = true;
					button.onclick = null;
				}
			}

			let _preflightOverride = false;
			let _bulkSwitchAcknowledged = false;
			let _uploadScopeSelected = false;
			function _scopedRealRecords() {
				return scopeUploadRecords(canvasState.bulkRecords, canvasState.bulkSelectedIds, _uploadScopeSelected);
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

			let _uploadAttemptId = null;
			let _allowDuplicates = false;
			async function confirmUpload() {
				resetResultsCsvAction();
				const realRecords = _scopedRealRecords();
				if (realRecords.length === 0) {
					return;
				}
				const migrateApi = window.Orgloom && window.Orgloom.canvasMigrate;
				const currentCanvas = canvasState.currentCanvas;
				if (currentCanvas && currentCanvas.id && !currentCanvas.ownedByMe) {
					showBulkToast(
						'Only the canvas owner can upload this shared canvas to Salesforce. Submit your contribution instead.',
						'error',
					);
					return;
				}
				const publishCanvasId =
					currentCanvas && currentCanvas.id && !(migrateApi && migrateApi.isActive())
						? currentCanvas.id
						: null;
				if (migrateApi && migrateApi.isActive()) {
					const unresolvedMatches = realRecords.filter(
						(r) => r._migrateMatchAmbiguous && !r._migrateMatchResolution,
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
				const meInfo = getMeInfo();
				const userRecords = realRecords.filter((r) => r.objectName === 'User' && !r.loadedFromId);
				if (userRecords.length > 0) {
					const orgLabel =
						meInfo && meInfo.orgType === 'production'
							? 'PRODUCTION'
							: (meInfo && meInfo.orgType) || 'this org';
					const msg =
						"You're about to create " +
						userRecords.length +
						' User record' +
						(userRecords.length === 1 ? '' : 's') +
						' in ' +
						orgLabel +
						'.\n\n' +
						'\u2022 Each new User consumes a Salesforce license.\n' +
						"\u2022 Users CAN'T be deleted, only deactivated; these stay in the org forever.\n" +
						'\u2022 Salesforce sends a welcome email on insert (suppressed when IsActive=false).\n\n' +
						'Proceed?';
					if (
						!(await showConfirmDialog({
							title: 'Create User records?',
							message: msg,
							confirmLabel: 'Create users',
							cancelLabel: 'Cancel',
							danger: true,
						}))
					) {
						return;
					}
				}
				const confirmBtn = uploadModal.querySelector('#upload-confirm');
				const cancelBtn = uploadModal.querySelector('[data-upload-close]');
				const content = uploadModal.querySelector('#upload-modal-content');
				confirmBtn.disabled = true;
				content.innerHTML =
					'<p class="center busy-row" style="justify-content:center">' +
					'<span class="busy-spinner lg"></span>' +
					'<span>Checking Salesforce access&hellip;</span>' +
					'</p>';
				const accessController = new AbortController();
				const accessTimeout = setTimeout(() => accessController.abort(), 5000);
				try {
					const accessResponse = await csrfFetch('/api/upload/access-check', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ canvasId: publishCanvasId }),
						credentials: 'same-origin',
						signal: accessController.signal,
					});
					const accessBody = await accessResponse.json().catch(() => ({}));
					if (!accessResponse.ok) {
						if (accessBody && accessBody.error === 'approval-required') {
							renderApprovalRequired(content, confirmBtn, accessBody);
							return;
						}
						throw new Error(
							(accessBody && (accessBody.message || accessBody.error)) ||
								'Org Loom could not verify upload access.',
						);
					}
					if (meInfo && meInfo.connection) {
						meInfo.connection.approval = { required: false, status: 'approved' };
					}
				} catch (error) {
					const timedOut = accessController.signal.aborted;
					content.innerHTML =
						'<div class="banner error"><strong>' +
						(timedOut ? 'Salesforce access check took too long.' : 'Could not verify upload access.') +
						'</strong> ' +
						(timedOut
							? 'No records were written. Retry, or open Workspace settings to review whether this Salesforce org is awaiting approval.'
							: escapeHtml(error.message || String(error))) +
						'</div>' +
						(timedOut
							? '<p class="center"><a class="button secondary" href="/workspace#workspace" target="_blank" rel="noopener">Open Workspace settings</a></p>'
							: '');
					confirmBtn.disabled = false;
					confirmBtn.textContent = 'Retry';
					return;
				} finally {
					clearTimeout(accessTimeout);
				}

				const skipTempIds = realRecords
					.filter((r) => r.loadedFromId && !isRecordModified(r) && !r.pendingDelete)
					.map((r) => r.id);
				const recordsForPayload = realRecords.filter((r) => !r.pendingDelete);
				const deletesForPayload = realRecords.filter((r) => isRecordPendingDelete(r));
				const excludedDraftLinksForPayload = _uploadScopeSelected ? _scopedExcludedDraftParentLinks() : [];

				// Build one immutable request snapshot so later canvas edits cannot change this attempt.
				const scopedIds = new Set(recordsForPayload.map((r) => r.id));
				const payload = {
					canvasId: publishCanvasId,
					records: recordsForPayload.map((r) => ({
						tempId: r.id,
						objectName: r.objectName,
						values: scopeUploadValues(r, _migrateUploadValues(r), excludedDraftLinksForPayload),
						loadedFromId: r.loadedFromId || null,
						loadedValues: r.loadedFromId && r.loadedValues ? r.loadedValues : undefined,
						_csvOperation: r._csvOperation || undefined,
						_csvExternalIdField: r._csvExternalIdField || undefined,
					})),
					deletes: deletesForPayload.map((r) => ({
						tempId: r.id,
						sfId: r.loadedFromId,
						objectName: r.objectName,
					})),
					associations: scopeUploadAssociations(canvasState.bulkAssociations, scopedIds).map((a) => ({
						fromId: a.fromId,
						toId: a.toId,
						fieldName: a.fieldName,
					})),
					skipTempIds,
					directUpload: _isLinkedCsvQuickUploadMode(),
					expectedSfOrgId: window.SF_ORG_ID || null,
				};
				// Retries reuse this ID so the server can distinguish a retry from a new transaction.
				if (!_uploadAttemptId) {
					_uploadAttemptId =
						window.crypto && typeof crypto.randomUUID === 'function'
							? crypto.randomUUID()
							: 'att-' + Date.now() + '-' + Math.random().toString(36).slice(2);
				}
				payload.attemptId = _uploadAttemptId;
				if (_allowDuplicates) {
					payload.allowDuplicates = true;
				}

				const uploadingCountForGate = recordsForPayload.length - skipTempIds.length;
				const PER_COMPONENT_CAP = 75;
				const TOTAL_NODES_CAP = 500;
				const BYTE_CAP = 5 * 1024 * 1024; // 5 MB, leaves room under the 6 MB hard ceiling
				const components = (() => {
					const submitted = new Set(
						recordsForPayload
							.filter((r) => !(r.loadedFromId && skipTempIds.indexOf(r.id) !== -1))
							.map((r) => r.id),
					);
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
							for (const n of adj.get(cur) || []) {
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
					'attributes',
					'Id',
					'CreatedDate',
					'CreatedById',
					'LastModifiedDate',
					'LastModifiedById',
					'SystemModstamp',
					'LastReferencedDate',
					'LastViewedDate',
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
						'Skipped ' +
							_orphanStrippedCount +
							' unavailable field value' +
							(_orphanStrippedCount === 1 ? '' : 's') +
							' across ' +
							_orphanStrippedRecordCount +
							' record' +
							(_orphanStrippedRecordCount === 1 ? '' : 's') +
							'. They may not exist in the destination org, or Salesforce permissions may hide them.',
						'warn',
					);
				}

				const payloadJson = JSON.stringify(payload);
				const hasUpsert = realRecords.some((r) => r._csvOperation === 'upsert');
				const fitsGraph =
					uploadingCountForGate > 0 &&
					maxComponentSize <= PER_COMPONENT_CAP &&
					uploadingCountForGate <= TOTAL_NODES_CAP &&
					payloadJson.length <= BYTE_CAP;
				if (!_preflightOverride && !payload.directUpload && !fitsGraph && uploadingCountForGate > 0) {
					confirmBtn.disabled = false;
					confirmBtn.textContent = 'Upload';
					const reasons = [];
					if (maxComponentSize > PER_COMPONENT_CAP) {
						reasons.push(
							'one connected cluster has ' +
								maxComponentSize +
								' records (canvas cap is ' +
								PER_COMPONENT_CAP +
								' per cluster)',
						);
					}
					if (uploadingCountForGate > TOTAL_NODES_CAP) {
						reasons.push(uploadingCountForGate + ' total records (canvas cap is ' + TOTAL_NODES_CAP + ')');
					}
					if (payloadJson.length > BYTE_CAP) {
						reasons.push(
							'payload is ' +
								(payloadJson.length / 1024 / 1024).toFixed(1) +
								' MB (canvas cap is ' +
								(BYTE_CAP / 1024 / 1024).toFixed(0) +
								' MB)',
						);
					}
					content.innerHTML =
						'<div class="banner error">' +
						'<strong>Upload too large for the canvas path.</strong> ' +
						(reasons.length
							? '<ul style="margin:0.4em 0 0 1.2em">' +
								reasons.map((r) => '<li>' + escapeHtml(r) + '</li>').join('') +
								'</ul>'
							: '') +
						'<p style="margin-top:0.5em">Split this upload into smaller batches, or use Direct CSV upload.</p>' +
						'</div>';
					return;
				}
				if (!_preflightOverride && fitsGraph && !hasUpsert) {
					confirmBtn.disabled = true;
					confirmBtn.textContent = 'Uploading\u2026';
					const uploadingRecords = recordsForPayload.filter(
						(record) => skipTempIds.indexOf(record.id) === -1,
					);
					content.innerHTML =
						'<p class="center busy-row" style="justify-content:center">' +
						'<span class="busy-spinner lg"></span>' +
						'<span>' +
						escapeHtml(formatUploadProgress(uploadingRecords, canvasState.describeCache)) +
						'</span>' +
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
								'<a href="' +
								safeLoginHref(body && body.loginUrl) +
								'">Sign in again</a> ' +
								'and retry the upload.' +
								'</div>';
							confirmBtn.disabled = true;
							return;
						}
						if (r.status === 402 && body && body.code === 'upload_cap_reached') {
							content.innerHTML =
								'<div class="banner error">' +
								escapeHtml(body.error || 'Upload cap reached.') +
								'</div>' +
								(body.uploadsUsed != null && body.uploadCap != null
									? '<p class="tag" style="margin-top:0.4em">Used <strong>' +
										body.uploadsUsed +
										'</strong> of ' +
										body.uploadCap +
										' uploads this month.</p>'
									: '') +
								'<div style="display:flex;gap:0.5em;align-items:center;margin-top:0.7em;flex-wrap:wrap">' +
								'<a class="button" href="/workspace/upgrade">Upgrade to Pro &rarr;</a>' +
								'<a class="tag" href="/pricing" target="_blank" rel="noopener">Compare plans</a>' +
								'</div>';
							confirmBtn.disabled = true;
							return;
						}
						if (r.status === 409 && body && body.error === 'upload-attempt-incomplete') {
							// The server owns recovery guidance when an earlier attempt has an uncertain outcome.
							renderAttemptIncomplete(body);
							return;
						}
						if (r.status === 409 && body && body.error === 'active-org-changed') {
							renderActiveOrgChanged(content, confirmBtn, body);
							return;
						}
						if (!r.ok && body && body.error === 'approval-required') {
							renderApprovalRequired(content, confirmBtn, body);
							return;
						}
						if (!r.ok) {
							throw new Error((body && (body.message || body.error)) || 'Upload failed');
						}
						const allResults = (body && body.results) || [];
						const hasCommitted = allResults.some((r) => r && r.success && r.mode !== 'unchanged');
						if (body && (body.atomicSuccess || hasCommitted)) {
							displayUploadResults(
								allResults,
								body.instanceUrl || '',
								body.deletes || [],
								body.canonicalValues || {},
							);
							return;
						}
						const errors = allResults
							.filter((r) => !r.success && r.error)
							.map((r) => {
								const rec = canvasState.bulkRecords.find((br) => br.id === r.tempId);
								return {
									recordLabel: rec
										? (rec.label || rec.objectName) + ' #' + recordOrdinal(rec)
										: r.objectName + ' #' + r.tempId,
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
						try {
							await reconcileLostUpload(payload.records);
						} catch (_e) {
							/* best-effort */
						}
					}
				}

				if (!_bulkSwitchAcknowledged && !fitsGraph && realRecords.length > BULK_THRESHOLD) {
					const reasons = [];
					if (maxComponentSize > PER_COMPONENT_CAP) {
						reasons.push(
							'one connected group has ' +
								maxComponentSize +
								' records (Composite Graph caps a group at ' +
								PER_COMPONENT_CAP +
								')',
						);
					}
					if (uploadingCountForGate > TOTAL_NODES_CAP) {
						reasons.push(
							uploadingCountForGate +
								' total records (Composite Graph caps total at ' +
								TOTAL_NODES_CAP +
								')',
						);
					}
					if (payloadJson.length > BYTE_CAP) {
						reasons.push(
							'payload is ' +
								(payloadJson.length / 1024 / 1024).toFixed(1) +
								' MB (Composite Graph caps payload at ' +
								(BYTE_CAP / 1024 / 1024).toFixed(0) +
								' MB)',
						);
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

				if (!_preflightOverride && !hasUpsert) {
					confirmBtn.disabled = true;
					confirmBtn.textContent = 'Validating\u2026';
					content.innerHTML =
						'<p class="center">Sending a sample to Salesforce to validate the schema, validation rules, and triggers\u2026</p>';
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
								'<a href="' +
								safeLoginHref(pf && pf.loginUrl) +
								'">Sign in again</a> ' +
								'and retry the upload.' +
								'</div>';
							confirmBtn.disabled = true;
							return;
						}
						if (!r.ok && pf && pf.error === 'approval-required') {
							renderApprovalRequired(content, confirmBtn, pf);
							return;
						}
						if (!r.ok && pf && pf.error === 'active-org-changed') {
							renderActiveOrgChanged(content, confirmBtn, pf);
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
						: ' <span class="tag">(' +
							pf.sampled +
							' record' +
							(pf.sampled === 1 ? '' : 's') +
							' sampled)</span>';
					content.innerHTML =
						'<p class="center">Pre-flight passed' + skippedNote + ': starting upload\u2026</p>';
				}

				confirmBtn.disabled = true;
				confirmBtn.textContent = 'Uploading\u2026';

				const useBulk = hasUpsert || realRecords.length > BULK_THRESHOLD;
				if (useBulk) {
					try {
						await runBulkUploadSSE(payload, content);
					} catch (err) {
						let recovered = 0;
						try {
							recovered = await reconcileLostUpload(payload.records);
						} catch (_e) {
							recovered = 0;
						}
						if (recovered > 0) {
							content.innerHTML =
								'<div class="banner">Connection dropped mid-upload, but ' +
								recovered +
								' record' +
								(recovered === 1 ? '' : 's') +
								' had already saved to Salesforce. ' +
								(recovered === 1 ? 'It\u2019s' : 'They\u2019re') +
								' now marked as uploaded, so retrying won\u2019t create duplicates. Click Retry to finish any records that didn\u2019t save.</div>';
						} else {
							content.innerHTML =
								'<div class="banner error">Upload failed: ' +
								escapeHtml(err.message || String(err)) +
								'</div>';
						}
						confirmBtn.disabled = false;
						confirmBtn.textContent = 'Retry';
					}
					return;
				}

				const uploadingCount = recordsForPayload.length - skipTempIds.length;
				const deleteCount = deletesForPayload.length;
				const skippedNote =
					skipTempIds.length > 0
						? '<p class="tag center">' +
							skipTempIds.length +
							' unchanged record' +
							(skipTempIds.length === 1 ? '' : 's') +
							' skipped.</p>'
						: '';
				const headerMsg =
					uploadingCount === 0 && deleteCount > 0
						? 'Deleting ' +
							deleteCount +
							' record' +
							(deleteCount === 1 ? '' : 's') +
							' in Salesforce\u2026'
						: 'Uploading ' +
							uploadingCount +
							' record' +
							(uploadingCount === 1 ? '' : 's') +
							(deleteCount > 0 ? ' (and deleting ' + deleteCount + ')' : '') +
							' to Salesforce\u2026';
				content.innerHTML =
					'<p class="center busy-row" style="justify-content:center">' +
					'<span class="busy-spinner lg"></span>' +
					'<span>' +
					headerMsg +
					'</span>' +
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
							'<a href="' +
							safeLoginHref(body && body.loginUrl) +
							'">Sign in again</a> ' +
							'and retry the upload.' +
							'</div>';
						confirmBtn.disabled = true;
						return;
					}
					if (r.status === 409 && body && body.error === 'upload-attempt-incomplete') {
						renderAttemptIncomplete(body);
						return;
					}
					if (r.status === 409 && body && body.error === 'active-org-changed') {
						renderActiveOrgChanged(content, confirmBtn, body);
						return;
					}
					if (!r.ok) {
						if (body && body.error === 'approval-required') {
							renderApprovalRequired(content, confirmBtn, body);
							return;
						}
						throw new Error((body && (body.message || body.error)) || 'Upload failed');
					}
					displayUploadResults(
						body.results || [],
						body.instanceUrl || '',
						body.deletes || [],
						body.canonicalValues || {},
					);
				} catch (err) {
					stopElapsed();
					let recovered = 0;
					try {
						recovered = await reconcileLostUpload(payload.records);
					} catch (_e) {
						recovered = 0;
					}
					if (recovered > 0) {
						content.innerHTML =
							'<div class="banner">Connection dropped mid-upload, but ' +
							recovered +
							' record' +
							(recovered === 1 ? '' : 's') +
							' had already saved to Salesforce. ' +
							(recovered === 1 ? 'It\u2019s' : 'They\u2019re') +
							' now marked as uploaded, so retrying won\u2019t create duplicates. Click Retry to finish any records that didn\u2019t save.</div>';
					} else {
						content.innerHTML =
							'<div class="banner error">Upload failed: ' +
							escapeHtml(err.message || String(err)) +
							'</div>';
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

				let plan = null; // start-event payload
				const jobState = new Map();
				function jobKey(level, operation, objectName) {
					return level + '|' + operation + '|' + objectName;
				}

				function renderLevels() {
					if (!plan) {
						return;
					}
					const html = plan.levels
						.map((lvl) => {
							const groups = lvl.groups
								.map((g) => {
									const k = jobKey(lvl.level, g.operation, g.objectName);
									const st = jobState.get(k) || {};
									const processed = st.processed || 0;
									const failed = st.failed || 0;
									const total = g.count;
									const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
									const rawState = st.state || st.phase || 'queued';
									const stateLabel = humanizeState(rawState);
									const terminal =
										rawState === 'JobComplete' ||
										rawState === 'Failed' ||
										rawState === 'Aborted' ||
										rawState === 'done';
									const active = !terminal && rawState !== 'queued';
									const indeterminate = active && processed === 0;
									const spinnerHtml = active ? '<span class="busy-spinner"></span>' : '';
									return (
										'<div class="bp-job">' +
										'<div class="bp-job-head">' +
										'<span class="bp-obj">' +
										escapeHtml(g.objectName) +
										'</span> ' +
										'<span class="tag">' +
										escapeHtml(g.operation) +
										' \u00b7 ' +
										total +
										'</span>' +
										'<span class="bp-state tag">' +
										spinnerHtml +
										escapeHtml(stateLabel) +
										'</span>' +
										'</div>' +
										'<div class="bp-bar' +
										(indeterminate ? ' indeterminate' : '') +
										'"><div class="bp-bar-fill" style="width:' +
										pct +
										'%"></div></div>' +
										'<div class="bp-counts"><span>' +
										processed +
										' / ' +
										total +
										' processed</span>' +
										(failed > 0 ? '<span class="bp-failed">' + failed + ' failed</span>' : '') +
										'</div>' +
										'</div>'
									);
								})
								.join('');
							return (
								'<div class="bp-level">' +
								'<div class="bp-level-head">Level ' +
								(lvl.level + 1) +
								' of ' +
								plan.totalLevels +
								'</div>' +
								groups +
								'</div>'
							);
						})
						.join('');
					levelsEl.innerHTML = html;
				}

				const resp = await csrfFetch('/api/upload/bulk', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
					body: JSON.stringify(payload),
					credentials: 'same-origin',
				});
				if (resp.status === 401) {
					const body = await resp.json().catch(() => ({}));
					contentEl.innerHTML =
						'<div class="banner error">Your Salesforce session expired. ' +
						'<a href="' +
						safeLoginHref(body && body.loginUrl) +
						'">Sign in again</a> ' +
						'and retry the upload.' +
						'</div>';
					return;
				}
				if (resp.status === 402) {
					const body = await resp.json().catch(() => ({}));
					contentEl.innerHTML =
						'<div class="banner error">' +
						escapeHtml((body && body.error) || 'Upload cap reached.') +
						'</div>' +
						(body && body.uploadsUsed != null && body.uploadCap != null
							? '<p class="tag" style="margin-top:0.4em">Used <strong>' +
								body.uploadsUsed +
								'</strong> of ' +
								body.uploadCap +
								' uploads this month.</p>'
							: '') +
						'<div style="display:flex;gap:0.5em;align-items:center;margin-top:0.7em;flex-wrap:wrap">' +
						'<a class="button" href="/workspace/upgrade">Upgrade to Pro &rarr;</a>' +
						'<a class="tag" href="/pricing" target="_blank" rel="noopener">Compare plans</a>' +
						'</div>';
					return;
				}
				if (resp.status === 403) {
					const body = await resp.json().catch(() => ({}));
					if (body && body.error === 'approval-required') {
						renderApprovalRequired(contentEl, uploadModal.querySelector('#upload-confirm'), body);
						return;
					}
					throw new Error((body && (body.message || body.error)) || 'HTTP 403');
				}
				if (resp.status === 409) {
					const body = await resp.json().catch(() => ({}));
					if (body && body.error === 'active-org-changed') {
						renderActiveOrgChanged(contentEl, uploadModal.querySelector('#upload-confirm'), body);
						return;
					}
					throw new Error((body && (body.message || body.error)) || 'HTTP 409');
				}
				if (!resp.ok || !resp.body) {
					const t = await resp.text().catch(() => '');
					throw new Error(t || 'HTTP ' + resp.status);
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
							let txt =
								willUpload +
								' record' +
								(willUpload === 1 ? '' : 's') +
								' across ' +
								data.totalLevels +
								' level' +
								(data.totalLevels === 1 ? '' : 's');
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
									const match = lvl.groups.find(
										(g) => g.objectName === data.objectName && g.operation === data.operation,
									);
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
				_uploadAttemptId = null;
				const content = uploadModal.querySelector('#upload-modal-content');
				const confirmBtn = uploadModal.querySelector('#upload-confirm');
				const errs = Array.isArray(pf.errors) ? pf.errors : [];
				const grouped = new Map();
				errs.forEach((e) => {
					const key = e.recordLabel || 'Unknown record';
					let bucket = grouped.get(key);
					if (!bucket) {
						bucket = [];
						grouped.set(key, bucket);
					}
					bucket.push(e);
				});
				const sections = Array.from(grouped.entries())
					.map(([label, list]) => {
						const items = list
							.map((e) => {
								const fieldsHtml =
									e.fields && e.fields.length > 0
										? '<span class="pf-field"><code>' +
											e.fields.map(escapeHtml).join(', ') +
											'</code></span> '
										: '';
								const code = e.errorCode
									? ' <span class="pf-rec-counts">' + escapeHtml(e.errorCode) + '</span>'
									: '';
								return (
									'<li class="pf-item pf-error">' +
									fieldsHtml +
									'<span class="pf-msg-text">' +
									escapeHtml(e.message || 'Unknown error') +
									'</span>' +
									code +
									'</li>'
								);
							})
							.join('');
						return (
							'<details class="pf-record" open>' +
							'<summary>' +
							'<span class="pf-rec-label">' +
							escapeHtml(label) +
							'</span>' +
							'<span class="pf-rec-counts">' +
							list.length +
							' SF error' +
							(list.length === 1 ? '' : 's') +
							'</span>' +
							'</summary>' +
							'<ul class="pf-issues">' +
							items +
							'</ul>' +
							'</details>'
						);
					})
					.join('');
				content.innerHTML =
					'<div class="preflight has-errors">' +
					'<div class="pf-head">' +
					'<span class="pf-icon">\u26A0</span>' +
					'<span class="pf-msg">' +
					'<strong>Salesforce rejected the sample.</strong> ' +
					'These errors come from a real validation pass against ' +
					(pf.sampled || 0) +
					' sample record' +
					(pf.sampled === 1 ? '' : 's') +
					' (rolled back; nothing was committed). Fix them and retry, or upload anyway to see the same errors per-record.' +
					'</span>' +
					'</div>' +
					'<div class="pf-body">' +
					sections +
					'</div>' +
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

			function _applyRecoveredIds(realIdByTempId) {
				canvasState.bulkRecords.forEach((rec) => {
					if (realIdByTempId.has(rec.id) && !rec.loadedFromId) {
						rec.loadedFromId = realIdByTempId.get(rec.id);
						rec.values = rec.values || {};
						rec.values.Id = realIdByTempId.get(rec.id);
						rec.loadedValues = Object.assign({}, rec.values);
						_clearCommittedMigrationMatch(rec);
					}
				});
				if (typeof renderBulkView === 'function') {
					renderBulkView();
				}
			}

			async function reconcileLostUpload(attemptedRecords) {
				// Recover a committed response lost to navigation or transport failure without re-uploading.
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
						const detR = await csrfFetch('/api/upload-batches/' + encodeURIComponent(b.id), {
							credentials: 'same-origin',
						});
						if (!detR.ok) {
							continue;
						}
						const detBody = await detR.json().catch(() => ({}));
						const inserted =
							detBody.batch && Array.isArray(detBody.batch.insertedIds) ? detBody.batch.insertedIds : [];
						if (inserted.length === 0) {
							continue;
						}
						if (
							!byToken &&
							!inserted.every(
								(ins) =>
									ins && ins.tempId != null && wantObjByTempId.get(ins.tempId) === ins.objectName,
							)
						) {
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
						'<strong>Upload paused to prevent duplicate records.</strong> ' +
						escapeHtml(
							(body && body.message) ||
								'Org Loom could not confirm whether Salesforce saved the previous attempt.',
						) +
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
				_uploadAttemptId = null;
				if (confirmBtn) {
					confirmBtn.disabled = false;
					confirmBtn.textContent = 'Close';
					confirmBtn.onclick = closeUploadModal;
				}
			}

			function displayUploadResults(results, instanceUrl, deletesResults, canonicalValues) {
				// Only successful rows become existing records; failed rows remain editable drafts.
				_uploadAttemptId = null;
				_allowDuplicates = false;
				const content = uploadModal.querySelector('#upload-modal-content');
				const confirmBtn = uploadModal.querySelector('#upload-confirm');
				const isQuickUploadResults = !!_pendingCsvImportMeta;
				const resultsCsv = isQuickUploadResults
					? buildUploadResultsCsv(results, canvasState.bulkRecords)
					: null;
				const synced = results.filter((r) => r.success && r.mode !== 'unchanged');
				const unchanged = results.filter((r) => r.success && r.mode === 'unchanged');
				const failed = results.filter((r) => !r.success);
				const deletesArr = Array.isArray(deletesResults) ? deletesResults : [];
				const deleted = deletesArr.filter((d) => d && d.success);
				const deleteFailed = deletesArr.filter((d) => d && !d.success);
				if (synced.length > 0) {
					markCanvasGuideUploadComplete();
				}
				if (_pendingCsvImportMeta) {
					const _csvMeta = _pendingCsvImportMeta;
					_pendingCsvImportMeta = null;
					const _csvStatus = failed.length === 0 ? 'ok' : synced.length > 0 ? 'partial' : 'failed';
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
				const recordUrl = (objectName, id) =>
					sfBase
						? sfBase +
							'/lightning/r/' +
							encodeURIComponent(objectName) +
							'/' +
							encodeURIComponent(id) +
							'/view'
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
				if (synced.length > 0) {
					html +=
						'<div class="upload-section-head upload-section-head--ok">Synced</div>' +
						'<div class="upload-summary" style="grid-template-columns: auto 1fr auto auto;">' +
						synced
							.map((r, i) => {
								const url = recordUrl(r.objectName, r.id);
								const idHtml = url
									? '<a href="' +
										escapeHtml(url) +
										'" target="_blank" rel="noopener"><code>' +
										escapeHtml(r.id) +
										'</code></a>'
									: '<code>' + escapeHtml(r.id) + '</code>';
								const modeLabel = r.mode === 'update' ? 'updated' : 'created';
								return (
									'<div>#' +
									(i + 1) +
									'</div>' +
									'<div>' +
									escapeHtml(r.objectName) +
									'</div>' +
									'<div>' +
									idHtml +
									'</div>' +
									'<div class="tag">' +
									modeLabel +
									'</div>'
								);
							})
							.join('') +
						'</div>';
				}
				if (unchanged.length > 0) {
					html +=
						'<div class="upload-section-head upload-section-head--ok">Unchanged (skipped)</div>' +
						'<p class="tag" style="margin-top:-0.4em">These records were already in Salesforce and had no local edits, so we didn\u2019t touch them.</p>' +
						'<div class="upload-summary" style="grid-template-columns: auto 1fr auto;">' +
						unchanged
							.map((r, i) => {
								const url = recordUrl(r.objectName, r.id);
								const idHtml = url
									? '<a href="' +
										escapeHtml(url) +
										'" target="_blank" rel="noopener"><code>' +
										escapeHtml(r.id) +
										'</code></a>'
									: '<code>' + escapeHtml(r.id) + '</code>';
								return (
									'<div>#' +
									(i + 1) +
									'</div>' +
									'<div>' +
									escapeHtml(r.objectName) +
									'</div>' +
									'<div>' +
									idHtml +
									'</div>'
								);
							})
							.join('') +
						'</div>';
				}
				const dupFailed = failed.filter((r) => r && r.errorCode === 'DUPLICATES_DETECTED');
				if (failed.length > 0) {
					html += '<div class="upload-section-head upload-section-head--fail">Failed</div>';
					failed.forEach((r, i) => {
						const isDup = r && r.errorCode === 'DUPLICATES_DETECTED';
						html +=
							'<div class="upload-failure-block">' +
							'<strong>#' +
							(i + 1) +
							' ' +
							escapeHtml(r.objectName) +
							'</strong>' +
							'<div class="upload-failure-msg">' +
							escapeHtml(r.error || 'Unknown error') +
							(isDup ? ': a Salesforce duplicate rule matched an existing record.' : '') +
							'</div>' +
							'</div>';
					});
					if (dupFailed.length > 0) {
						html +=
							'<div class="banner" style="margin-top:0.6em">' +
							'<strong>' +
							dupFailed.length +
							' record' +
							(dupFailed.length === 1 ? '' : 's') +
							' blocked by Salesforce duplicate rules.</strong> ' +
							'If ' +
							(dupFailed.length === 1 ? 'this is' : 'these are') +
							' intentional (not accidental duplicates), you can upload anyway; Salesforce will record the duplicate alert but accept the save. ' +
							'<button type="button" class="button secondary" id="upload-allow-dups" style="margin-left:0.4em;font-size:0.82rem;padding:0.2em 0.6em">Upload anyway</button>' +
							'</div>';
					}
				}
				if (deleted.length > 0) {
					html +=
						'<div class="upload-section-head upload-section-head--danger">Deleted in Salesforce</div>' +
						'<p class="tag" style="margin-top:-0.4em">These records are gone. Org Loom can’t undelete them; restore from the Salesforce recycle bin within 15 days if needed.</p>' +
						'<div class="upload-summary" style="grid-template-columns: auto 1fr auto;">' +
						deleted
							.map((d, i) => {
								return (
									'<div>#' +
									(i + 1) +
									'</div>' +
									'<div>' +
									escapeHtml(d.objectName || '') +
									'</div>' +
									'<div><code>' +
									escapeHtml(d.sfId || '') +
									'</code></div>'
								);
							})
							.join('') +
						'</div>';
				}
				if (deleteFailed.length > 0) {
					html += '<div class="upload-section-head upload-section-head--fail">Delete failed</div>';
					deleteFailed.forEach((d, i) => {
						html +=
							'<div class="upload-failure-block">' +
							'<strong>#' +
							(i + 1) +
							' ' +
							escapeHtml(d.objectName || '') +
							'</strong>' +
							'<div class="upload-failure-msg">' +
							escapeHtml(d.error || 'Unknown error') +
							'</div>' +
							'</div>';
					});
				}
				content.innerHTML = html;

				const resultsCsvBtn = uploadModal.querySelector('#upload-results-csv');
				if (resultsCsvBtn && resultsCsv) {
					resultsCsvBtn.hidden = false;
					resultsCsvBtn.onclick = () => {
						const blob = new Blob(['\uFEFF' + resultsCsv], { type: 'text/csv;charset=utf-8' });
						const url = URL.createObjectURL(blob);
						const link = document.createElement('a');
						link.href = url;
						link.download =
							'org-loom-quick-upload-results-' + new Date().toISOString().slice(0, 10) + '.csv';
						document.body.appendChild(link);
						link.click();
						link.remove();
						setTimeout(() => URL.revokeObjectURL(url), 0);
					};
				}

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
					canvasState.bulkAssociations = canvasState.bulkAssociations.filter(
						(a) => !deletedTempIds.has(a.fromId) && !deletedTempIds.has(a.toId),
					);
					deletedTempIds.forEach((id) => canvasState.bulkSelectedIds.delete(id));
				}

				const realIdByTempId = new Map(synced.map((r) => [r.tempId, r.id]));
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
				// Salesforce canonical values win over submitted values after a successful write.
				const canonicalMap = canonicalValues && typeof canonicalValues === 'object' ? canonicalValues : {};
				canvasState.bulkRecords.forEach((rec) => {
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
						_clearCommittedMigrationMatch(rec);
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
							if (window.Orgloom.canvasOrgSwitch && window.Orgloom.canvasOrgSwitch.migrationClear) {
								window.Orgloom.canvasOrgSwitch.migrationClear();
							}
							if (_mig.exit) {
								_mig.exit();
							}
							const _n = synced.length;
							const _doneMsg =
								_n > 0
									? 'Migration complete: ' +
										_n +
										' record' +
										(_n === 1 ? '' : 's') +
										' now live in this org. You’re back to a normal canvas.'
									: 'Migration complete: everything was already up to date. You’re back to a normal canvas.';
							showBulkToast(_doneMsg);
						}
					}
				} catch (_e) {}

				confirmBtn.disabled = false;
				confirmBtn.textContent = failed.length > 0 ? 'Retry failed' : 'Close';
				confirmBtn.onclick =
					failed.length > 0
						? () => {
								confirmBtn.onclick = confirmUpload;
								confirmUpload();
							}
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
