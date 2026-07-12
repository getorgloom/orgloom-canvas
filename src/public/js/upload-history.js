(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.uploadHistory = {
		mount: function mount(deps) {
			if (!deps || !deps.csrfFetch || !deps.escapeHtml || !deps.showBulkToast) {
				throw new Error('upload-history.mount: missing required deps');
			}
			const csrfFetch = deps.csrfFetch;
			const escapeHtml = deps.escapeHtml;
			const showBulkToast = deps.showBulkToast;

			function showUploadHistoryModal() {
				document.querySelectorAll('.upload-history-modal').forEach((el) => el.remove());
				const overlay = document.createElement('div');
				overlay.className = 'modal upload-history-modal';
				overlay.innerHTML =
					'<div class="modal-overlay" data-uh-close></div>' +
					'<div class="modal-body" style="max-width:720px">' +
						'<div class="modal-header">' +

							'<h3 id="uh-header-title">Recent uploads</h3>' +
							'<button class="modal-close" data-uh-close>&times;</button>' +
						'</div>' +
						'<div class="modal-content" id="uh-content">' +
							'<p class="center tag">Loading…</p>' +
						'</div>' +
					'</div>';
				document.body.appendChild(overlay);
				const onEsc = (e) => {
 if (e.key === 'Escape') {
cleanup();
} 
};
				const cleanup = () => {
					document.removeEventListener('keydown', onEsc, true);
					if (overlay.parentNode) {
overlay.remove();
}
				};
				document.addEventListener('keydown', onEsc, true);
				overlay.querySelectorAll('[data-uh-close]').forEach((el) => el.addEventListener('click', cleanup));
				_renderUploadHistoryList(overlay);
			}

			async function _renderUploadHistoryList(overlay) {
				const content = overlay.querySelector('#uh-content');
				const title = overlay.querySelector('#uh-header-title');
				if (title) {
title.textContent = 'Recent uploads';
}
				try {
					const r = await csrfFetch('/api/upload-batches?limit=50', { credentials: 'same-origin' });
					const body = await r.json().catch(() => ({}));
					if (!r.ok) {
						content.innerHTML = '<div class="banner error">' + escapeHtml(body.error || ('HTTP ' + r.status)) + '</div>';
						return;
					}
					const batches = (body && body.batches) || [];
					if (batches.length === 0) {
						content.innerHTML = '<p class="tag center">No uploads yet. Once you upload records, they’ll appear here so you can recall them later. <a href="/docs/walkthroughs/recall-upload" target="_blank" rel="noopener" class="empty-doclink">How recall works &rarr;</a></p>';
						return;
					}
					const fmtDate = (ms) => {
						const d = new Date(ms);
						return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
					};

					const sourceLabel = (s) => {
						if (s === 'canvas') {
return 'Canvas';
}
						if (s === 'canvas-graph') {
return 'Canvas (graph)';
}
						if (s === 'canvas-bulk') {
return 'Canvas (bulk)';
}
						if (s === 'csv-direct') {
return 'CSV (direct)';
}
						if (s === 'csv-bulk') {
return 'CSV (bulk)';
}
						return s || 'Upload';
					};
					const statusBadge = (b) => {
						if (b.status === 'recalled') {
return '<span class="tag uh-status-recalled">Recalled</span>';
}
						if (b.status === 'recall_failed') {
return '<span class="tag uh-status-failed">Recall failed</span>';
}
						if (b.status === 'recall_partial') {
return '<span class="tag uh-status-partial">Partial recall</span>';
}
						if (b.status === 'recalling') {
return '<span class="tag uh-status-busy">Recalling…</span>';
}
						return '<span class="tag uh-status-uploaded">Uploaded</span>';
					};

					const detailLine = (b) => {
						const ins = typeof b.insertedCount === 'number' ? b.insertedCount : null;
						const del = typeof b.deletedCount === 'number' ? b.deletedCount : 0;
						if (ins == null) {

							return b.recordCount + ' record' + (b.recordCount === 1 ? '' : 's');
						}
						if (del === 0) {
return ins + ' synced';
}
						if (ins === 0) {
return del + ' deleted';
}
						return ins + ' synced + ' + del + ' deleted';
					};
					const hasRecallableInserts = (b) => {

						if (typeof b.insertedCount !== 'number') {
return true;
}
						return b.insertedCount > 0;
					};
					content.innerHTML =
						'<div class="uh-list">' +
							batches.map((b) => (
								'<div class="uh-row" data-uh-batch="' + escapeHtml(b.id) + '">' +
									'<div class="uh-row-main">' +
										'<div class="uh-row-line1">' +
											'<span class="uh-when">' + escapeHtml(fmtDate(b.createdAt)) + '</span>' +
											'<span class="uh-sep">·</span>' +
											'<span class="uh-source">' + escapeHtml(sourceLabel(b.source)) + '</span>' +
											'<span class="uh-sep">·</span>' +
											'<span class="uh-count">' + escapeHtml(detailLine(b)) + '</span>' +
											statusBadge(b) +
										'</div>' +
										(b.note ? '<div class="uh-note">' + escapeHtml(b.note) + '</div>' : '') +
										(typeof b.deletedCount === 'number' && b.deletedCount > 0
											? '<div class="uh-note uh-note-danger">' + b.deletedCount + ' record' + (b.deletedCount === 1 ? '' : 's') + ' deleted in Salesforce. Org Loom can’t undelete - restore from the SF recycle bin within 15 days.</div>'
											: '') +
									'</div>' +
									'<div class="uh-row-actions">' +
										(hasRecallableInserts(b) && (b.status === 'uploaded' || b.status === 'recall_partial' || b.status === 'recall_failed')
											? '<button type="button" class="button secondary" data-uh-recall="' + escapeHtml(b.id) + '">Recall</button>'
											: '') +
										'<button type="button" class="link-button" data-uh-forget="' + escapeHtml(b.id) + '" title="Remove this row from the history (does NOT touch Salesforce)">Forget</button>' +
									'</div>' +
								'</div>'
							)).join('') +
						'</div>';
					content.querySelectorAll('[data-uh-recall]').forEach((btn) => {
						btn.addEventListener('click', () => _confirmAndRecall(btn.dataset.uhRecall, overlay));
					});
					content.querySelectorAll('[data-uh-forget]').forEach((btn) => {
						btn.addEventListener('click', () => _forgetBatch(btn.dataset.uhForget, overlay));
					});
				} catch (e) {
					content.innerHTML = '<div class="banner error">Couldn’t load history: ' + escapeHtml(e.message || String(e)) + '</div>';
				}
			}

			async function _confirmAndRecall(batchId, overlay) {
				const content = overlay.querySelector('#uh-content');
				const title = overlay.querySelector('#uh-header-title');
				if (title) {
title.textContent = 'Recall this upload?';
}
				content.innerHTML = '<p class="center tag">Checking which records have changed since upload…</p>';
				let batch;
				let preflight;
				try {
					const [batchResp, preflightResp] = await Promise.all([
						csrfFetch('/api/upload-batches/' + encodeURIComponent(batchId), { credentials: 'same-origin' }),
						csrfFetch('/api/upload-batches/' + encodeURIComponent(batchId) + '/recall-preflight', {
							method: 'POST',
							credentials: 'same-origin',
							headers: { 'Content-Type': 'application/json' },
							body: '{}',
						}),
					]);
					batch = await batchResp.json();
					if (!batchResp.ok) {
throw new Error(batch.error || 'Load failed');
}
					preflight = await preflightResp.json();
					if (!preflightResp.ok) {
throw new Error(preflight.error || 'Preflight failed');
}
				} catch (e) {
					content.innerHTML = '<div class="banner error">' + escapeHtml(e.message || String(e)) + '</div>';
					return;
				}
				const cleanList = preflight.clean || [];
				const driftedList = preflight.drifted || [];
				const alreadyDeletedList = preflight.alreadyDeleted || [];
				const updatesList = preflight.updates || [];
				const unverifiedList = preflight.unverified || [];
				const cascadeConflicts = preflight.cascadeConflicts || [];

				const byObj = {};
				cleanList.forEach((r) => {
 byObj[r.objectName] = (byObj[r.objectName] || 0) + 1; 
});
				const cleanBreakdown = Object.keys(byObj).sort().map((o) =>
					'<li>' + byObj[o] + ' ' + escapeHtml(o) + (byObj[o] === 1 ? '' : 's') + '</li>'
				).join('');

				const driftedRows = driftedList.map((r) => {
					const when = r.lastModifiedDate
						? new Date(r.lastModifiedDate).toLocaleString()
						: 'unknown';
					const reason = r.driftReason === 'modified_by_other_user'
						? 'modified by another user'
						: 'modified after the upload window';
					return '<li>' +
						'<code>' + escapeHtml(r.objectName) + ' ' + escapeHtml(r.sfId) + '</code> ' +
						'<span class="tag"> - ' + reason + ' on ' + escapeHtml(when) + '</span>' +
					'</li>';
				}).join('');

				const alreadyDeletedNote = alreadyDeletedList.length > 0
					? '<p class="tag">' + alreadyDeletedList.length + ' record' +
						(alreadyDeletedList.length === 1 ? ' was' : 's were') +
						' already removed from Salesforce; nothing to recall there.</p>'
					: '';

				const valueDrift = (preflight && preflight.valueDrift) || { records: [], summary: {} };
				const revertableRecords = (valueDrift.records || []).filter((r) =>
					r && !r.notFound && ((r.clean && r.clean.length > 0) || (r.drifted && r.drifted.length > 0)),
				);
				const hasAnyRevertCandidate = revertableRecords.length > 0;
				const updatesNote = updatesList.length > 0 && !hasAnyRevertCandidate
					? '<p>Unchanged:</p>' +
						'<ul><li>' + updatesList.length + ' record' +
						(updatesList.length === 1 ? '' : 's') +
						' in this batch ' + (updatesList.length === 1 ? 'was' : 'were') +
						' updated (not newly created) and will be left in Salesforce. ' +
						'Recall does not restore pre-update values for this batch (uploaded before the value-revert feature shipped).</li></ul>'
					: '';

				function fmtVal(v) {
					if (v == null || v === '') {
return '<span class="uh-revert-empty">(empty)</span>';
}
					return '<code>' + escapeHtml(String(v)) + '</code>';
				}
				const valueRevertSections = revertableRecords.map((rec) => {
					const recIdAttr = escapeHtml(rec.sfId);
					const titleLabel = rec.label || (rec.objectName + ' ' + rec.sfId);
					const cleanRows = (rec.clean || []).map((f) =>
						'<li class="uh-revert-row uh-revert-row--clean">' +
							'<label>' +
								'<input type="checkbox" data-uh-revert-record="' + recIdAttr + '" data-uh-revert-field="' + escapeHtml(f.fieldName) + '" checked>' +
								' <code>' + escapeHtml(f.fieldName) + '</code>: ' +
								fmtVal(f.uploaded) + ' &rarr; ' + fmtVal(f.prior) +
							'</label>' +
						'</li>'
					).join('');
					const driftRows = (rec.drifted || []).map((f) =>
						'<li class="uh-revert-row uh-revert-row--drifted">' +
							'<label>' +
								'<input type="checkbox" data-uh-revert-record="' + recIdAttr + '" data-uh-revert-field="' + escapeHtml(f.fieldName) + '">' +
								' <code>' + escapeHtml(f.fieldName) + '</code>' +
								' <span class="tag uh-revert-drift-tag">drifted</span>' +
							'</label>' +
							'<div class="uh-revert-diff">' +
								'<div><span class="uh-revert-diff-lbl">prior:</span> ' + fmtVal(f.prior) + '</div>' +
								'<div><span class="uh-revert-diff-lbl">we wrote:</span> ' + fmtVal(f.uploaded) + '</div>' +
								'<div><span class="uh-revert-diff-lbl">SF now:</span> ' + fmtVal(f.current) + '</div>' +
							'</div>' +
						'</li>'
					).join('');
					const counts = [];
					if (rec.clean && rec.clean.length > 0) {
counts.push(rec.clean.length + ' clean');
}
					if (rec.drifted && rec.drifted.length > 0) {
counts.push(rec.drifted.length + ' drifted');
}
					return '<div class="uh-revert-record">' +
						'<h6 class="uh-revert-record-title">' + escapeHtml(titleLabel) +
							' <span class="tag">' + counts.join(' · ') + '</span>' +
						'</h6>' +
						(cleanRows ? '<ul class="uh-revert-list">' + cleanRows + '</ul>' : '') +
						(driftRows ? '<ul class="uh-revert-list uh-revert-list--drifted">' + driftRows + '</ul>' : '') +
					'</div>';
				}).join('');
				const totalDriftedFieldCount = (valueDrift.summary && valueDrift.summary.driftedFieldCount) || 0;
				const valueRevertSection = hasAnyRevertCandidate
					? '<div class="uh-revert-section">' +
						'<h5 class="uh-revert-title">Revert field values</h5>' +
						'<p class="tag">' +
							revertableRecords.length + ' updated record' + (revertableRecords.length === 1 ? '' : 's') +
							' carry value-revert data. Clean fields are checked by default; ' +
							(totalDriftedFieldCount > 0
								? 'drifted fields (where someone else changed the value after our upload) are ' +
									'<strong>unchecked</strong> by default - tick them to overwrite their change.'
								: 'no fields have drifted since the upload.') +
						'</p>' +
						valueRevertSections +
					'</div>'
					: '';

				const unverifiedRows = unverifiedList.map((r) => {
					const reason = r.probeError ? r.probeError : 'reason unknown';
					return '<li>' +
						'<code>' + escapeHtml(r.objectName) + ' ' + escapeHtml(r.sfId) + '</code> ' +
						'<span class="tag"> - ' + escapeHtml(reason) + '</span>' +
					'</li>';
				}).join('');
				const unverifiedSection = unverifiedList.length > 0
					? '<div class="uh-drifted-block">' +
						'<h5 class="uh-drifted-title">' + unverifiedList.length + ' record' + (unverifiedList.length === 1 ? '' : 's') + ' couldn’t be verified</h5>' +
						'<p class="tag">Salesforce returned an error when we tried to look up the current state of ' + (unverifiedList.length === 1 ? 'this record' : 'these records') + '. Recall is skipping ' + (unverifiedList.length === 1 ? 'it' : 'them') + ' by default. Common cause: your Salesforce user lost read access to the object since upload - ask your admin to check.</p>' +
						'<ul class="uh-drifted-list">' + unverifiedRows + '</ul>' +
					'</div>'
					: '';

				const driftedSection = driftedList.length > 0
					? '<div class="uh-drifted-block">' +
						'<h5 class="uh-drifted-title">' + driftedList.length + ' record' + (driftedList.length === 1 ? '' : 's') + ' changed since upload</h5>' +
						'<p class="tag">Recalling these will soft-delete those edits to the Recycle Bin (15-day recovery). Skipped by default.</p>' +
						'<ul class="uh-drifted-list">' + driftedRows + '</ul>' +
						'<label class="uh-drifted-toggle">' +
							'<input type="checkbox" data-uh-include-drifted> ' +
							'Recall drifted records too (override default)' +
						'</label>' +
					'</div>'
					: '';

				const cascadeRows = cascadeConflicts.map((c) => {
					const bucketLabel = c.childBucket === 'updates'
						? 'updated by this batch'
						: 'modified since upload';
					return '<li>' +
						'<code>' + escapeHtml(c.childObjectName) + ' ' + escapeHtml(c.childSfId) + '</code> ' +
						'<span class="tag"> - ' + bucketLabel + '</span>' +
					'</li>';
				}).join('');

				const cascadeHasUpdates = cascadeConflicts.some((c) => c.childBucket === 'updates');
				const cascadeHasDrifted = cascadeConflicts.some((c) => c.childBucket !== 'updates');
				const cascadeChildLabel = (cascadeHasUpdates && cascadeHasDrifted)
					? 'preserved record'
					: cascadeHasUpdates ? 'updated record' : 'drifted record';
				const cascadeSection = cascadeConflicts.length > 0
					? '<div class="uh-cascade-block">' +
						'<h5 class="uh-cascade-title">⚠ Master-detail cascade conflict</h5>' +
						'<p class="tag">' + cascadeConflicts.length + ' ' + cascadeChildLabel +
							(cascadeConflicts.length === 1 ? '' : 's') + ' will be deleted ANYWAY because their parent records are being recalled. ' +
							'Salesforce cascade-deletes master-detail children when their parents go - we can’t skip them.' +
						'</p>' +
						'<ul class="uh-cascade-list">' + cascadeRows + '</ul>' +
						'<label class="uh-cascade-ack">' +
							'<input type="checkbox" data-uh-cascade-ack> ' +
							'I understand - proceed knowing these records will be deleted by cascade.' +
						'</label>' +
					'</div>'
					: '';

				const initialActionCount = cleanList.length;
				const noCleanReason = driftedList.length > 0
					? ' - everything in this batch has been modified since upload.'
					: updatesList.length > 0 && cleanList.length === 0
						? ' - this batch only updated existing records; nothing was newly created to delete.'
						: '.';

				const batchDeletedCount = Array.isArray(batch && batch.deletedIds)
					? batch.deletedIds.length
					: 0;
				const batchDeletesNote = batchDeletedCount > 0
					? '<p>Deletes (not recallable):</p>' +
						'<ul><li>' + batchDeletedCount + ' record' +
						(batchDeletedCount === 1 ? '' : 's') +
						' in this batch ' + (batchDeletedCount === 1 ? 'was' : 'were') +
						' DELETE\'d in Salesforce. Org Loom can’t undelete - restore from the SF recycle bin within 15 days. Recall only reverses the inserts/updates above.</li></ul>'
					: '';
				content.innerHTML =
					'<div class="uh-confirm">' +

						(cleanList.length > 0
							? '<p>Delete from Salesforce:</p><ul>' + cleanBreakdown + '</ul>'
							: '<p class="tag">No clean records to recall' + noCleanReason + '</p>') +
						updatesNote +
						batchDeletesNote +
						unverifiedSection +
						alreadyDeletedNote +
						valueRevertSection +
						driftedSection +
						cascadeSection +
						'<p class="tag uh-warn">' +
							'⚠ Soft delete only - records go to the Recycle Bin (15-day retention; recoverable via Salesforce).' +
						'</p>' +
						'<div class="uh-confirm-actions">' +
							'<button type="button" class="button secondary" data-uh-back>Back</button>' +
							'<button type="button" class="button danger" data-uh-do-recall' +
								(initialActionCount === 0 && driftedList.length === 0 ? ' disabled' : '') + '>' +
								'Recall <span data-uh-recall-count>' + initialActionCount + '</span> record<span data-uh-recall-plural>' + (initialActionCount === 1 ? '' : 's') + '</span>' +
							'</button>' +
						'</div>' +
					'</div>';

				const includeBox = content.querySelector('[data-uh-include-drifted]');
				const cascadeAckBox = content.querySelector('[data-uh-cascade-ack]');
				const recallBtn = content.querySelector('[data-uh-do-recall]');
				const countSpan = content.querySelector('[data-uh-recall-count]');
				const pluralSpan = content.querySelector('[data-uh-recall-plural]');
				function updateRecallCount() {
					const include = includeBox && includeBox.checked;
					const checkedRevertFields = content.querySelectorAll('input[data-uh-revert-field]:checked').length;
					const total = cleanList.length + (include ? driftedList.length : 0);
					if (countSpan) {
countSpan.textContent = String(total);
}
					if (pluralSpan) {
pluralSpan.textContent = total === 1 ? '' : 's';
}
					const cascadeAckRequired = cascadeConflicts.length > 0 && !include;
					const cascadeAckSatisfied = !cascadeAckRequired || (cascadeAckBox && cascadeAckBox.checked);

					const hasWork = total > 0 || checkedRevertFields > 0;
					if (recallBtn) {
recallBtn.disabled = !hasWork || !cascadeAckSatisfied;
}
				}
				if (includeBox) {
includeBox.addEventListener('change', updateRecallCount);
}
				if (cascadeAckBox) {
cascadeAckBox.addEventListener('change', updateRecallCount);
}
				content.querySelectorAll('input[data-uh-revert-field]').forEach((cb) => {
					cb.addEventListener('change', updateRecallCount);
				});
				updateRecallCount();

				content.querySelector('[data-uh-back]').addEventListener('click', () => _renderUploadHistoryList(overlay));
				recallBtn.addEventListener('click', () => {
					const include = includeBox && includeBox.checked;
					const skipSfIds = [];
					if (!include) {
						driftedList.forEach((r) => {
 if (r.sfId) {
skipSfIds.push(r.sfId);
} 
});
					}
					alreadyDeletedList.forEach((r) => {
 if (r.sfId) {
skipSfIds.push(r.sfId);
} 
});

					const revertByRecord = new Map();
					content.querySelectorAll('input[data-uh-revert-field]:checked').forEach((cb) => {
						const sfId = cb.getAttribute('data-uh-revert-record');
						const fieldName = cb.getAttribute('data-uh-revert-field');
						if (!sfId || !fieldName) {
return;
}
						if (!revertByRecord.has(sfId)) {
revertByRecord.set(sfId, []);
}
						revertByRecord.get(sfId).push(fieldName);
					});
					const revertSelections = Array.from(revertByRecord.entries()).map(([sfId, fields]) => ({
						sfId, fields,
					}));
					_executeRecall(batchId, overlay, skipSfIds, revertSelections);
				});
			}

			async function _executeRecall(batchId, overlay, skipSfIds, revertSelections) {
				const content = overlay.querySelector('#uh-content');
				content.innerHTML = '<p class="center busy-row" style="justify-content:center"><span class="busy-spinner lg"></span><span>Recalling…</span></p>';
				try {
					const r = await csrfFetch('/api/upload-batches/' + encodeURIComponent(batchId) + '/recall', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						credentials: 'same-origin',
						body: JSON.stringify({
							skipSfIds: Array.isArray(skipSfIds) ? skipSfIds : [],
							revertSelections: Array.isArray(revertSelections) ? revertSelections : [],
						}),
					});
					const body = await r.json();
					if (!r.ok) {
throw new Error(body.error || 'Recall failed');
}
					const allResults = body.results || [];
					const alreadyDeleted = allResults.filter((x) => x && x.success && x.note === 'Already deleted').length;
					const succeeded = allResults.filter((x) => x && x.success && x.note !== 'Already deleted').length;
					const failures = allResults.filter((x) => x && !x.success);
					const failed = failures.length;
					const preservedUpdates = body.preservedUpdatesCount || 0;

					const deletedSfIds = allResults
						.filter((x) => x && x.success && x.sfId)
						.map((x) => x.sfId);
					if (deletedSfIds.length > 0) {
						try {
							document.dispatchEvent(new CustomEvent('orgloom:records-deleted', {
								detail: { sfIds: deletedSfIds },
							}));
						} catch (_) {                                                  }
					}
					const deletedFragment = succeeded + ' record' + (succeeded === 1 ? '' : 's') + ' deleted';
					const alreadyFragment = alreadyDeleted > 0
						? '; ' + alreadyDeleted + ' ' + (alreadyDeleted === 1 ? 'was' : 'were') + ' already removed in Salesforce'
						: '';
					const preservedFragment = preservedUpdates > 0
						? '; ' + preservedUpdates + ' updated record' + (preservedUpdates === 1 ? '' : 's') + ' left in place'
						: '';
					let banner;
					if (body.status === 'recalled') {
						if (succeeded === 0 && alreadyDeleted > 0 && preservedUpdates === 0) {
							banner = '<div class="banner">All ' + alreadyDeleted + ' record' + (alreadyDeleted === 1 ? '' : 's') + ' had already been removed in Salesforce - nothing to delete.</div>';
						} else if (succeeded === 0 && alreadyDeleted === 0 && preservedUpdates > 0) {
							banner = '<div class="banner">No records deleted - this batch only updated existing records, all left in place.</div>';
						} else {
							banner = '<div class="banner success">' + deletedFragment + alreadyFragment + preservedFragment + '.</div>';
						}
					} else if (body.status === 'recall_partial') {
						banner = '<div class="banner">' + deletedFragment + alreadyFragment + preservedFragment + '; ' + failed + ' failed.</div>';
					} else {
						banner = '<div class="banner error">All ' + failed + ' delete' + (failed === 1 ? '' : 's') + ' failed.</div>';
					}
					const failureRows = failures.length === 0 ? '' :
						'<div class="upload-section-head upload-section-head--err">Failures</div>' +
						'<div class="upload-summary" style="grid-template-columns: auto 1fr 2fr;">' +
							failures.map((f) =>
								'<div>' + escapeHtml(f.objectName) + '</div>' +
								'<div><code>' + escapeHtml(f.sfId) + '</code></div>' +
								'<div>' + escapeHtml(f.error || '') + '</div>'
							).join('') +
						'</div>';
					content.innerHTML = banner + failureRows +
						'<div class="uh-confirm-actions">' +
							'<button type="button" class="button" data-uh-list>Back to history</button>' +
						'</div>';
					content.querySelector('[data-uh-list]').addEventListener('click', () => _renderUploadHistoryList(overlay));
				} catch (e) {
					content.innerHTML = '<div class="banner error">' + escapeHtml(e.message || String(e)) + '</div>' +
						'<div class="uh-confirm-actions">' +
							'<button type="button" class="button" data-uh-list>Back to history</button>' +
						'</div>';
					content.querySelector('[data-uh-list]').addEventListener('click', () => _renderUploadHistoryList(overlay));
				}
			}

			async function _forgetBatch(batchId, overlay) {
				try {
					const r = await csrfFetch('/api/upload-batches/' + encodeURIComponent(batchId), {
						method: 'DELETE',
						credentials: 'same-origin',
					});
					const body = await r.json().catch(() => ({}));
					if (!r.ok) {
throw new Error(body.error || 'Forget failed');
}
					_renderUploadHistoryList(overlay);
				} catch (e) {
					showBulkToast('Couldn’t forget batch: ' + (e.message || e), 'error');
				}
			}

			return {
				openModal: showUploadHistoryModal,

				_testConfirmAndRecall: function (batchId) {
					const overlay = document.querySelector('.upload-history-modal');
					if (!overlay) {
return Promise.resolve(false);
}
					return _confirmAndRecall(batchId, overlay).then(() => true);
				},
			};
		},
	};
})();
