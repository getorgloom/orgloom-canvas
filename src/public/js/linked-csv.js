// Linked CSV import: multi-file upload with auto-FK linking.
//
// Eliminates the Data-Loader two-step (upload Account, paste back
// resulting Ids into Contact CSV, upload Contact). The user drops in
// several CSVs at once; Org Loom uses each file's `referenceTo`
// describes to identify FK columns, then scores value-overlap against
// every column in candidate target files to propose the match key.
// The user reviews the auto-proposed pairings and confirms: no
// manual canvas wiring required.
//
// Dependencies passed to mount():
//   canvasState: shared canvas state (reads allObjects,
//                           selectedObjects, describeCache; mutates
//                           bulkRecords + bulkAssociations + bulkIdSeq
//                           on confirm).
//   showBulkToast: toast notification.
//   escapeHtml: HTML escape utility.
//   ensureDescribe: async function(objectName) that resolves
//                           to a describe object.
//   csrfFetch: fetch wrapper.
//   renderBulkView: re-render the bulk canvas after import.
//   getGraph: () => Element; canvas root, queried for
//                           the '#bulk-canvas' element.
//   parseCsv: RFC 4180-ish parser (from csv-import).
//   csvGuessObjectFromFilename: filename → object name guess.
//   csvAutoMapHeaders: auto-map CSV headers → field names.
//   csvNormalizeKey: string normalization for key matching.
//   pingAuditEvent: fire-and-forget audit POST.
//   addToSelection: async; register an object on the canvas.
//   showPromptModal: generic prompt dialog.
//   showReplaceOrMergeDialog: 3-way dialog for canvas import mode.
//   canvasCapBlockReason: () => string|null; returns a block reason
//                           when canvas record cap would be exceeded.
//   openUploadModal: opens the upload-to-SF modal (called from
//                           linkedCsvConfirm when user picks "Upload
//                           to Salesforce" in Quick Upload mode).
//   allObjectsReady: Promise resolving when canvasState.allObjects
//                           is populated (boot-time fetch).
//
// Public API (returned from mount):
//   openModal(opts): opens the linked-CSV modal. opts.quickUpload
//                      flips to Quick Upload mode (direct CSV → SF,
//                      bypasses canvas + upload cap).
//   closeModal(): closes it.
//
// Exposed as window.OrgLoom.linkedCsv. Load order: before app.js.

(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	const _DIRECT_CSV_VALIDATED_CAP = 5000;
	const _QU_RESTORE_KEY = 'orgloom:quick-upload:restore:v1';

	window.OrgLoom.linkedCsv = {
		mount: function mount(deps) {
			if (!deps || !deps.canvasState || !deps.showBulkToast || !deps.escapeHtml
				|| !deps.ensureDescribe || !deps.csrfFetch || !deps.renderBulkView
				|| !deps.getGraph || !deps.parseCsv || !deps.csvGuessObjectFromFilename
				|| !deps.csvAutoMapHeaders || !deps.csvNormalizeKey
				|| !deps.pingAuditEvent || !deps.addToSelection
				|| !deps.showConfirmDialog
				|| !deps.showPromptModal || !deps.showReplaceOrMergeDialog
				|| !deps.canvasCapBlockReason || !deps.openUploadModal
				|| !deps.setPendingUploadCleanup || !deps.setPendingCsvImportMeta
				|| !deps.allObjectsReady
				|| !deps.getCyInstance || !deps.setSkipNextCyAutoPan
				|| !deps.relayoutNewRecords || !deps.clearEmptyStarterCard) {
				throw new Error('linked-csv.mount: missing required deps');
			}
			const canvasState = deps.canvasState;
			const showBulkToast = deps.showBulkToast;
			const escapeHtml = deps.escapeHtml;
			const ensureDescribe = deps.ensureDescribe;
			const csrfFetch = deps.csrfFetch;
			const renderBulkView = deps.renderBulkView;
			const getGraph = deps.getGraph;
			const parseCsv = deps.parseCsv;
			const csvGuessObjectFromFilename = deps.csvGuessObjectFromFilename;
			const csvAutoMapHeaders = deps.csvAutoMapHeaders;
			const csvNormalizeKey = deps.csvNormalizeKey;
			const pingAuditEvent = deps.pingAuditEvent;
			const addToSelection = deps.addToSelection;
			const showConfirmDialog = deps.showConfirmDialog;
			const showPromptModal = deps.showPromptModal;
			const showReplaceOrMergeDialog = deps.showReplaceOrMergeDialog;
			const _canvasCapBlockReason = deps.canvasCapBlockReason;
			const openUploadModal = deps.openUploadModal;
			const setPendingUploadCleanup = deps.setPendingUploadCleanup;
			const setPendingCsvImportMeta = deps.setPendingCsvImportMeta;
			const _allObjectsReady = deps.allObjectsReady;
			const getCyInstance = deps.getCyInstance;
			const setSkipNextCyAutoPan = deps.setSkipNextCyAutoPan;
			const relayoutNewRecords = deps.relayoutNewRecords;
			const clearEmptyStarterCard = deps.clearEmptyStarterCard;
			// Optional: when present, a canvas-mode import whose Id already has
			// a card on the canvas merges the CSV's values onto that card via
			// the Diff modal instead of creating a duplicate. Absent → such a
			// row is skipped (still no duplicate) with a notice.
			const openRecordDiffModal = typeof deps.openRecordDiffModal === 'function'
				? deps.openRecordDiffModal
				: null;
			// Optional (all present in the normal app.js mount):
			//   canvasCapCheck: count-aware cap probe; enables the
			//                           replace-mode baseline-0 check.
			//   captureUndoSnapshot: pre-import canvas snapshot; enables
			//                           the Undo action on the import toast.
			//   showBulkToastWithAction: action-toast for that Undo.
			const canvasCapCheck = typeof deps.canvasCapCheck === 'function'
				? deps.canvasCapCheck
				: null;
			const captureUndoSnapshot = typeof deps.captureUndoSnapshot === 'function'
				? deps.captureUndoSnapshot
				: null;
			const showBulkToastWithAction = typeof deps.showBulkToastWithAction === 'function'
				? deps.showBulkToastWithAction
				: null;

				const linkedCsvModal = document.createElement('div');
				linkedCsvModal.id = 'linked-csv-modal';
				// The linked-CSV modal serves two opening contexts. Each
				// mode renders ONLY the buttons it actually uses: no
				// hidden buttons in the DOM - so the modal stays focused
				// on the user's job:
				//   * Canvas import (default): "Replace canvas" + "Add to
				//     canvas". Records flow onto the canvas; uploads
				//     count toward the monthly cap.
				//   * Quick Upload (openLinkedCsvModal({ quickUpload: true })):
				//     "Upload to Salesforce" only. Records skip the
				//     canvas; the upload payload sets directUpload=true
				//     so the server bypasses the cap counter (the
				//     "Data Loader but better, free forever" path).
				// The footer is rebuilt each open by openLinkedCsvModal.
				linkedCsvModal.className = 'modal hidden';
				linkedCsvModal.innerHTML =
					'<div class="modal-overlay" data-lcsv-close></div>' +
					'<div class="modal-body" style="max-width:920px">' +
						'<div class="modal-header">' +
							'<h3>Import from CSV</h3>' +
							'<button class="modal-close" data-lcsv-close>&times;</button>' +
						'</div>' +
						'<div class="modal-content" id="linked-csv-content"></div>' +
						'<div class="modal-footer"></div>' +
					'</div>';
				document.body.appendChild(linkedCsvModal);
				linkedCsvModal.querySelectorAll('[data-lcsv-close]').forEach((el) => el.addEventListener('click', closeLinkedCsvModal));
				document.addEventListener('keydown', (e) => {
					if (e.key === 'Escape' && !linkedCsvModal.classList.contains('hidden')) {
closeLinkedCsvModal();
}
				});
				// ----- Linked CSV import: multi-file upload with auto-FK linking -----
				// Eliminates the Data-Loader two-step (upload Account, paste back
				// resulting Ids into Contact CSV, upload Contact). The user drops
				// in several CSVs at once; Org Loom uses each file's `referenceTo`
				// describes to identify FK columns, then scores value-overlap
				// against every column in candidate target files to propose the
				// match key. The user reviews the auto-proposed pairings and
				// confirms - no manual canvas wiring required.
				let linkedCsvState = null;
				// Per-open mode flag. Set by openLinkedCsvModal({ quickUpload: true })
				// from the Quick Upload trigger; cleared on close. Read at
				// upload-payload time to set directUpload=true so the server
				// skips the cap counter. This is per-open (not page-level)
				// so the same canvas page can do both canvas-mode imports
				// and Quick Upload imports without reloading.
				let _linkedCsvQuickUploadMode = false;

				function openLinkedCsvModal(opts) {
					opts = opts || {};
					if (opts.quickUpload && _linkedCsvQuickUploadMode) {
						showBulkToast('A Quick Upload is already in progress. Finish or cancel it before starting another.', 'warn');
						return;
					}
					_linkedCsvQuickUploadMode = !!opts.quickUpload;
					// Build the per-mode button row. Each mode gets ONLY the
					// buttons it uses; no hidden DOM noise. Footer is
					// rebuilt fresh each open so click handlers are bound
					// against current closures.
					const footer = linkedCsvModal.querySelector('.modal-footer');
					if (_linkedCsvQuickUploadMode) {
						footer.innerHTML =
							'<button class="button" id="linked-csv-upload" disabled title="Push these rows to Salesforce. No cap on this path - direct CSV uploads are unlimited on every plan.">Upload to Salesforce</button>';
						footer.querySelector('#linked-csv-upload').onclick = () => linkedCsvConfirm({ uploadDirectly: true });
					} else {
						footer.innerHTML =
							'<button class="button secondary" id="linked-csv-replace" disabled title="Drop everything currently on the canvas, then load this file onto a fresh canvas.">Replace canvas</button>' +
							'<button class="button" id="linked-csv-confirm" disabled title="Load records onto the canvas alongside what is already there. Use Upload from the canvas toolbar to push them to Salesforce.">Add to canvas</button>';
						footer.querySelector('#linked-csv-replace').onclick = () => linkedCsvConfirm({ uploadDirectly: false, replaceCanvas: true });
						footer.querySelector('#linked-csv-confirm').onclick = () => linkedCsvConfirm({ uploadDirectly: false });
					}
					// Header reflects mode so the user knows which path they're on.
					const header = linkedCsvModal.querySelector('.modal-header h3');
					if (header) {
header.textContent = _linkedCsvQuickUploadMode ? 'Quick Upload: Import from CSV' : 'Import from CSV';
}

					linkedCsvState = {
						files: [], links: null, notices: [],
						planSfOrgId: window.SF_ORG_ID || null,
						planConnectionPromise: csrfFetch('/api/me', { credentials: 'same-origin' })
							.then((response) => response.json())
							.then((me) => me && me.connection ? {
								id: me.connection.id || null,
								sfOrgId: me.connection.sfOrgId || me.connection.organizationId || null,
							} : null)
							.catch(() => null),
					};
					linkedCsvModal.classList.remove('hidden');
					linkedCsvRender();
					// If the object catalog is still loading, re-render once
					// it lands so the dropzone replaces the loading state and
					// the per-file object picker has options.
					if (canvasState.allObjects === null) {
						_allObjectsReady.then(() => {
							if (linkedCsvState && !linkedCsvModal.classList.contains('hidden')) {
								linkedCsvRender();
							}
						});
					}
				}

				function closeLinkedCsvModal(opts) {
					linkedCsvModal.classList.add('hidden');
					linkedCsvState = null;
					// Quick Upload mode flag lifecycle: linkedCsvConfirm
					// closes this modal BEFORE opening the upload modal and
					// the payload is built later inside the upload-modal
					// flow - so THAT close passes keepQuickUploadMode:true
					// and the flag is instead cleared by the QU flow's
					// pending-upload cleanup (fires when the upload modal
					// closes). Every OTHER close (X, overlay, Escape -
					// i.e. the user bailed without uploading) disarms the
					// flag here; leaving it armed made the next normal
					// canvas upload send directUpload=true (cap-exempt,
					// mislabeled 'upload_direct' in metering).
					if (!opts || !opts.keepQuickUploadMode) {
						_linkedCsvQuickUploadMode = false;
					}
				}
				// Score how well a CSV's headers fit each ALREADY-CACHED object
				// describe. Restricting to cache prevents a 100+ describe burst
				// when the user drops a CSV - describes load on demand the first
				// time the user picks an object explicitly. If nothing in cache
				// scores any header hits, return null so the user picks manually.
				function guessObjectForFile(headers) {
					const candidates = [];
					for (const objectName of Object.keys(canvasState.describeCache)) {
						const describe = canvasState.describeCache[objectName];
						if (!describe || !Array.isArray(describe.fields)) {
continue;
}
						const fields = describe.fields.filter((f) => f.createable);
						if (fields.length === 0) {
continue;
}
						const byKey = new Map();
						fields.forEach((f) => {
							byKey.set(csvNormalizeKey(f.name), f.name);
							if (f.label) {
byKey.set(csvNormalizeKey(f.label), f.name);
}
						});
						let hits = 0;
						headers.forEach((h) => {
 if (byKey.has(csvNormalizeKey(h))) {
hits++;
} 
});
						if (hits > 0) {
candidates.push({ name: objectName, hits, total: fields.length });
}
					}
					candidates.sort((a, b) => (b.hits - a.hits) || (a.total - b.total));
					return candidates[0] ? candidates[0].name : null;
				}

				// For a file's mapped FK columns, find the best matching column
				// in another file based on value-overlap. Returns
				//   { fromFileIdx, fromField, toFileIdx, toColumnIdx, matched, total, samples }
				// or null when no candidate column has any overlap.
				function scoreLink(fromFile, fromColumnIdx, toFile, fromValuesSet, excludeColumnIdx) {
					let best = null;
					for (let i = 0; i < toFile.headers.length; i++) {
						// Self-referential links must never match the FK column
						// to itself (e.g. Account.ParentId scored against the
						// ParentId column) - the parent key lives in a DIFFERENT
						// column (Ref / Name / Id).
						if (excludeColumnIdx != null && i === excludeColumnIdx) {
continue;
}
						let hits = 0;
						const seen = new Set();
						for (const row of toFile.rows) {
							const v = (row[i] || '').trim();
							if (!v || seen.has(v)) {
continue;
}
							seen.add(v);
							if (fromValuesSet.has(v)) {
hits++;
}
						}
						if (hits === 0) {
continue;
}
						const fromHeader = fromFile.headers[fromColumnIdx] || '';
						const toHeader = toFile.headers[i] || '';
						let bonus = 0;
						const tk = csvNormalizeKey(toHeader);
						const fk = csvNormalizeKey(fromHeader);
						// Header-affinity bonuses: an FK column ending in "Id"
						// matched to a column literally called "Id" or "Name"
						// or matching the FK column name minus "Id" gets a
						// nudge so a tie between Name and a random text field
						// resolves predictably.
						if (tk === 'id' || tk === 'name') {
bonus += 1;
}
						if (fk.endsWith('id') && tk === fk.slice(0, -2)) {
bonus += 1;
}
						const score = hits + bonus;
						if (!best || score > best.score) {
best = { score, hits, toColumnIdx: i, toHeader };
}
					}
					return best;
				}

				function analyzeLinkedCsvs() {
					if (!linkedCsvState) {
return;
}
					const state = linkedCsvState;
					const links = []; // { fromFileIdx, fromColumnIdx, fromField, toObjectName, toFileIdx, toColumnIdx, matched, total, samples }
					state.files.forEach((file, fromIdx) => {
						if (!file.objectName || !file.describe) {
return;
}
						// Find FK columns: mapped to a reference field whose
						// referenceTo overlaps with another uploaded file's
						// object.
						const fkFields = file.describe.fields.filter((f) =>
							f.type === 'reference' && Array.isArray(f.referenceTo) && f.referenceTo.length > 0
						);
						const fkByName = new Map(fkFields.map((f) => [f.name, f]));
						Object.keys(file.mapping).forEach((idxStr) => {
							const fieldName = file.mapping[idxStr];
							if (!fieldName) {
return;
}
							const fk = fkByName.get(fieldName);
							if (!fk) {
return;
}
							const fromColumnIdx = Number(idxStr);
							// Collect distinct non-empty values from this column.
							const fromValues = new Set();
							file.rows.forEach((r) => {
								const v = (r[fromColumnIdx] || '').trim();
								if (v) {
fromValues.add(v);
}
							});
							if (fromValues.size === 0) {
return;
}
							// If values look like real Salesforce Ids, no
							// linking needed - they're already direct refs.
							const allSfIds = Array.from(fromValues).every((v) => /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(v));
							if (allSfIds) {
return;
}
							// Find a candidate target file whose objectName
							// is in this FK's referenceTo set, then score its
							// columns for value overlap. Same-file is allowed
							// ONLY for self-referential FKs (the FK references
							// the file's own object, e.g. Account.ParentId →
							// Account) - a row's parent is another row in the
							// same file. For a self-ref we exclude the FK
							// column from scoring so it can't match itself.
							for (let toIdx = 0; toIdx < state.files.length; toIdx++) {
								const toFile = state.files[toIdx];
								if (!toFile.objectName) {
continue;
}
								if (!fk.referenceTo.includes(toFile.objectName)) {
continue;
}
								const isSelfRef = toIdx === fromIdx;
								const best = scoreLink(file, fromColumnIdx, toFile, fromValues, isSelfRef ? fromColumnIdx : -1);
								if (!best) {
continue;
}
								// Sample a few from-values that matched in toFile to surface
								// in the wizard for confidence.
								const samples = [];
								const toCol = best.toColumnIdx;
								outer: for (const v of fromValues) {
									for (const r of toFile.rows) {
										if ((r[toCol] || '').trim() === v) {
											samples.push(v);
											if (samples.length >= 3) {
break outer;
}
											break;
										}
									}
								}
								links.push({
									fromFileIdx: fromIdx,
									fromColumnIdx,
									fromField: fieldName,
									fromHeader: file.headers[fromColumnIdx],
									toObjectName: toFile.objectName,
									toFileIdx: toIdx,
									toColumnIdx: toCol,
									toHeader: best.toHeader,
									matched: best.hits,
									total: fromValues.size,
									samples,
								});
								break; // first matching target file wins
							}
						});
					});
					state.links = links;
				}

				function linkedCsvHandleFiles(fileList) {
					const state = linkedCsvState;
					if (!state) {
return;
}
					const files = Array.from(fileList || []);
					// New drop batch → new notice set. Notices render inside the
					// modal (see linkedCsvRender) so multiple warnings from one
					// batch are all visible at once.
					state.notices = [];
					const _shared = window.OrgLoom.importShared;
					const _CSV_GATE = {
						extRe: /\.csv$/i,
						extLabel: '.csv',
						maxBytes: 50 * 1024 * 1024,
						flowLabel: 'Import from CSV',
					};
					Promise.all(files.map((f) => new Promise((resolve) => {
						// Type + size gate (shared with the JSON importer).
						// Drag-drop bypasses the picker's accept=".csv", so
						// validate here - covers the drop, click, and Quick
						// Upload paths (all route through linkedCsvHandleFiles).
						// The size cap runs before FileReader pulls the whole
						// file into memory.
						const _gateMsg = _shared.gateImportFile(f, _CSV_GATE);
						if (_gateMsg) {
							const _isCsvName = /\.csv$/i.test(String(f.name || ''));
							resolve({
								__rejected: true,
								name: f.name,
								reason: _isCsvName ? 'toolarge' : 'wrongtype',
								gateMsg: _gateMsg,
							});
							return;
						}
						const reader = new FileReader();
						reader.onerror = () => resolve({ __rejected: true, name: f.name, reason: 'unreadable' });
						reader.onload = () => {
							if (String(reader.result || '').trim() === '') {
								resolve({ __rejected: true, name: f.name, reason: 'norows' }); return;
							}
							let parsed;
							try {
 parsed = parseCsv(String(reader.result || '')); 
} catch (e) {
 resolve({ __rejected: true, name: f.name, reason: 'unreadable' }); return; 
}
							if (String(reader.result || '').indexOf(String.fromCharCode(0)) !== -1) {
 resolve({ __rejected: true, name: f.name, reason: 'notcsv' }); return; 
} if (!parsed.headers.length) {
 resolve({ __rejected: true, name: f.name, reason: 'notcsv' }); return; 
} if (!parsed.rows.length) {
 resolve({ __rejected: true, name: f.name, reason: 'norows' }); return; 
}
							const raggedRows = parsed.rows.filter((r) => r.length !== parsed.headers.length).length;
							const blankDataHeaders = parsed.headers.reduce((out, header, idx) => {
								if (!header && parsed.rows.some((row) => String(row[idx] || '').trim() !== '')) {
out.push(idx + 1);
}
								return out;
							}, []);
							const blockingErrors = (parsed.errors || []).slice();
							if (raggedRows > 0) {
blockingErrors.push(raggedRows + ' row' + (raggedRows === 1 ? ' has' : 's have') + ' a different column count than the header.');
}
							if (blankDataHeaders.length > 0) {
blockingErrors.push('Data appears under blank header column' + (blankDataHeaders.length === 1 ? '' : 's') + ' ' + blankDataHeaders.join(', ') + '.');
}
							resolve({
								name: f.name,
								headers: parsed.headers,
								rows: parsed.rows,
								// Rows whose cell count differs from the header
								// count - a sign of unquoted commas or missing
								// fields. parseCsv is intentionally lenient (it
								// won't throw), so surface the mismatch to the
								// user rather than letting columns silently shift.
								raggedRows,
								blockingErrors,
								objectName: null,
								describe: null,
								mapping: {},
							});
						};
						reader.readAsText(f);
					}))).then(async (parsedFiles) => {
						const valid = parsedFiles.filter((f) => f && !f.__rejected); const rejected = parsedFiles.filter((f) => f && f.__rejected);
						// Duplicate-name detection. Compute name counts both
						// before and after the concat so we know whether this
						// drop batch CONTRIBUTED to a duplicate (vs. a pre-
						// existing duplicate that's already been warned).
						// One-shot toast - the display layer auto-suffixes
						// "(2)", "(3)" so the user can still tell duplicates
						// apart in the file list and detected-links section.
						const _newNames = new Set(valid.map((f) => f.name));
						const _existingCount = new Map();
						for (const f of state.files) {
							_existingCount.set(f.name, (_existingCount.get(f.name) || 0) + 1);
						}
						state.files = state.files.concat(valid);
						const _postCount = new Map();
						for (const f of state.files) {
							_postCount.set(f.name, (_postCount.get(f.name) || 0) + 1);
						}
						const _newlyDuplicated = [];
						for (const name of _newNames) {
							const pre = _existingCount.get(name) || 0;
							const post = _postCount.get(name) || 0;
							if (post >= 2 && pre < post) {
_newlyDuplicated.push(name);
}
						}
						if (_newlyDuplicated.length > 0) {
							const list = _newlyDuplicated.map((n) => '"' + n + '"').join(', ');
							state.notices.push({
								kind: 'warn',
								text: _newlyDuplicated.length === 1
									? 'Two or more files share the name ' + list + ' - suffixed "(2)" etc. in the file list for clarity. Rename if you want a clearer distinction.'
									: 'Multiple files share names (' + list + ') - suffixed "(2)" etc. in the file list. Rename if you want clearer labels.',
							});
						}
						// Ragged-row warning: rows whose column count doesn't
						// match the header usually mean an unquoted comma or a
						// missing field, which silently shifts values into the
						// wrong fields. Flag it so the user can fix the CSV
						// before uploading.
						const _ragged = valid.filter((f) => Array.isArray(f.blockingErrors) && f.blockingErrors.length > 0);
						if (_ragged.length > 0) {
							const list = _ragged.map((f) => '"' + f.name + '": ' + f.blockingErrors.join(' ')).join(' ');
							state.notices.push({
								kind: 'error',
								text: 'Import blocked because the CSV structure is unsafe. ' + list + ' Fix the file and try again; no rows were imported.',
							});
						}
						// Auto-guess object + auto-map columns for each new
						// file. Filename guess wins when it matches an entry
						// in the org's object catalog (cold-cache friendly,
						// resolves on the very first drop). Falls back to
						// header-affinity scoring against cached describes,
						// which usually kicks in for the second file onward
						// once an earlier pick has warmed the cache.
						if (rejected.length > 0) {
							// Oversized files carry their own gate message; the
							// rest are grouped by reason.
							const _sized = rejected.filter((f) => f.reason === 'toolarge');
							_sized.forEach((f) => state.notices.push({ kind: 'error', text: f.gateMsg }));
							const _rest = rejected.filter((f) => f.reason !== 'toolarge');
							_rest.forEach((f) => {
								const name = '"' + f.name + '"';
								const text = f.reason === 'wrongtype'
									? name + " isn't a CSV file - Import from CSV only accepts .csv files."
									: f.reason === 'norows'
										? name + ' has no data rows - nothing to import.'
										: name + " couldn't be read as a CSV and was skipped - drop a .csv file with a header row.";
								state.notices.push({ kind: 'error', text });
							});
							// Failure telemetry, one event per rejected file -
							// exports that won't re-import are silent churn.
							rejected.forEach((f) => _shared.captureImportFailure(
								'csv',
								f.reason === 'wrongtype' ? 'type'
									: f.reason === 'toolarge' ? 'size'
									: f.reason,
								null,
							));
}
							for (const file of valid) {
							let guessed = csvGuessObjectFromFilename(file.name, canvasState.allObjects || []);
							if (!guessed) {
guessed = guessObjectForFile(file.headers);
}
							if (guessed) {
								file.objectName = guessed;
								if (canvasState.describeCache[guessed]) {
									file.describe = canvasState.describeCache[guessed];
								} else {
									try {
 file.describe = await ensureDescribe(guessed); 
} catch (e) {
 file.describe = null; 
}
								}
								if (file.describe) {
									file.mapping = csvAutoMapHeaders(file.headers, file.describe.fields || []);
								}
							}
						}
						analyzeLinkedCsvs();
						linkedCsvRender();
					});
				}

				async function linkedCsvSetObject(fileIdx, objectName) {
					const state = linkedCsvState;
					if (!state || !state.files[fileIdx]) {
return;
}
					const file = state.files[fileIdx];
					file.objectName = objectName || null;
					if (objectName) {
						try {
							file.describe = await ensureDescribe(objectName);
							file.mapping = csvAutoMapHeaders(file.headers, file.describe.fields || []);
						} catch (e) {
 file.describe = null; file.mapping = {}; 
}
					} else {
						file.describe = null;
						file.mapping = {};
					}
					analyzeLinkedCsvs();
					linkedCsvRender();
				}

				function linkedCsvRemoveFile(fileIdx) {
					const state = linkedCsvState;
					if (!state) {
return;
}
					state.files.splice(fileIdx, 1);
					analyzeLinkedCsvs();
					linkedCsvRender();
				}

				// Manual override for a single CSV column's field mapping.
				// Re-runs link analysis afterwards because changing what a
				// column maps to can introduce or remove a reference-field
				// FK pairing.
				function linkedCsvUpdateColumn(fileIdx, columnIdx, fieldName) {
					const state = linkedCsvState;
					if (!state || !state.files[fileIdx]) {
return;
}
					const file = state.files[fileIdx];
					if (!file.mapping) {
file.mapping = {};
}
					if (fieldName) {
						file.mapping[columnIdx] = fieldName;
					} else {
						delete file.mapping[columnIdx];
					}
					analyzeLinkedCsvs();
					linkedCsvRender();
				}

				// Per-file operation picker mutators. Default operation
				// is 'insert' (file.operation undefined). Switching to
				// 'upsert' auto-picks the first eligible external-id
				// field that's currently mapped, so the user doesn't have
				// to make two picks; they can refine via the key picker.
				// Switching back to 'insert' clears externalIdFieldName.
				function linkedCsvUpdateOperation(fileIdx, operation) {
					const state = linkedCsvState;
					if (!state || !state.files[fileIdx]) {
return;
}
					const file = state.files[fileIdx];
					file.operation = operation;
					if (operation === 'upsert') {
						const eligible = (file.describe && Array.isArray(file.describe.fields))
							? file.describe.fields.filter((f) => f && f.externalId && f.filterable === true && f.createable)
							: [];
						const mapped = new Set(Object.values(file.mapping || {}).filter(Boolean));
						const pick = eligible.find((f) => mapped.has(f.name));
						file.externalIdFieldName = pick ? pick.name : null;
					} else {
						file.externalIdFieldName = null;
					}
					linkedCsvRender();
				}

				function linkedCsvUpdateExternalIdField(fileIdx, fieldName) {
					const state = linkedCsvState;
					if (!state || !state.files[fileIdx]) {
return;
}
					state.files[fileIdx].externalIdFieldName = fieldName || null;
					linkedCsvRender();
				}

				function linkedCsvUpdateLink(linkIdx, toColumnIdx) {
					const state = linkedCsvState;
					if (!state || !state.links || !state.links[linkIdx]) {
return;
}
					const link = state.links[linkIdx];
					if (toColumnIdx === '' || toColumnIdx == null) {
						state.links.splice(linkIdx, 1);
						linkedCsvRender();
						return;
					}
					const toCol = Number(toColumnIdx);
					const toFile = state.files[link.toFileIdx];
					if (!toFile) {
return;
}
					// Recompute matched count for the new column.
					const fromFile = state.files[link.fromFileIdx];
					const fromValues = new Set();
					fromFile.rows.forEach((r) => {
						const v = (r[link.fromColumnIdx] || '').trim();
						if (v) {
fromValues.add(v);
}
					});
					let matched = 0;
					const seen = new Set();
					toFile.rows.forEach((r) => {
						const v = (r[toCol] || '').trim();
						if (!v || seen.has(v)) {
return;
}
						seen.add(v);
						if (fromValues.has(v)) {
matched++;
}
					});
					link.toColumnIdx = toCol;
					link.toHeader = toFile.headers[toCol];
					link.matched = matched;
					link.total = fromValues.size;
					link.samples = [];
					outer: for (const v of fromValues) {
						for (const r of toFile.rows) {
							if ((r[toCol] || '').trim() === v) {
								link.samples.push(v);
								if (link.samples.length >= 3) {
break outer;
}
								break;
							}
						}
					}
					linkedCsvRender();
				}

				// Disambiguate duplicate filenames for display. Users sometimes
			// drop two files with the same name (system that names every
			// export `data.csv`, or genuinely two `accounts.csv`'s from
			// different time periods). The linker is index-keyed under the
			// hood so the data is fine, but identical labels in the files
			// list + detected-links panel make it impossible to tell which
			// is which when reviewing or removing. This helper returns an
			// array of display labels aligned with state.files indices -
			// first occurrence of a name renders bare, second renders
			// "name (2)", third "name (3)", etc. file.name in memory stays
			// raw so OS-level error messages still match what the user sees
			// in their file picker.
			function _buildFileDisplayNames(files) {
				const counts = new Map();
				const labels = [];
				for (const f of files) {
					const n = (f && f.name) || '(unnamed)';
					const c = (counts.get(n) || 0) + 1;
					counts.set(n, c);
					labels.push(c === 1 ? n : (n + ' (' + c + ')'));
				}
				return labels;
			}

			function linkedCsvRender() {
					const body = linkedCsvModal.querySelector('#linked-csv-content');
					const state = linkedCsvState;
					if (!body || !state) {
return;
}
					const allObjOptions = (canvasState.allObjects || [])
						.slice()
						.sort((a, b) => String(a.label || a.name).localeCompare(String(b.label || b.name)));
					const displayNames = _buildFileDisplayNames(state.files);
					const filesHtml = state.files.length === 0
						? '<p class="tag center">Drop CSVs above or click to choose.</p>'
						: state.files.map((file, i) => {
							const opts = '<option value=""> - Pick object - </option>' +
								allObjOptions.map((o) =>
									'<option value="' + escapeHtml(o.name) + '"' + (o.name === file.objectName ? ' selected' : '') + '>' +
										escapeHtml(o.label) + ' (' + escapeHtml(o.name) + ')' +
									'</option>'
								).join('');
							const mappedCount = Object.values(file.mapping).filter(Boolean).length;
							const unmappedCount = file.headers.length - mappedCount;
							const meta = file.objectName
								? '<span class="tag' + (unmappedCount > 0 ? ' warn' : '') + '">' + mappedCount + ' / ' + file.headers.length + ' columns mapped</span>'
								: '<span class="tag warn">Pick an object</span>';
							// Object-level CRUD pre-check (S217/S218): warn upfront
							// when the user can read this object but can't create
							// (or, for an Id-column update, can't update) its
							// records - so they find out at object-pick time, not
							// via a per-record INSUFFICIENT_ACCESS at DML time after
							// mapping columns and clicking Upload. createable is
							// undefined on describes cached before the flag existed,
							// so we only warn on an explicit false (no false
							// positives on stale cache).
							let permWarn = '';
							if (file.objectName && file.describe) {
								const hasIdCol = Object.values(file.mapping || {}).some((f) => f === 'Id');
								if (hasIdCol && file.describe.updateable === false) {
									permWarn = '<div class="lcsv-perm-warn">⚠ Your Salesforce user can read ' + escapeHtml(file.objectName) + ' but can’t update its records - this upload will fail. Ask your admin for Edit access.</div>';
								} else if (!hasIdCol && file.describe.createable === false) {
									permWarn = '<div class="lcsv-perm-warn">⚠ Your Salesforce user can read ' + escapeHtml(file.objectName) + ' but can’t create new records - this upload will fail. Ask your admin for Create access on ' + escapeHtml(file.objectName) + '.</div>';
								}
							}
							// Column-mapping panel: one row per CSV header with
							// a field-picker dropdown. Readable-but-unwritable fields
							// remain available so the user sees the exact mapping and
							// must explicitly confirm that those values will be dropped.
							// Pre-populated with the auto-mapper's guess; users
							// can override or skip any column. Collapsed by
							// default - opens automatically when there are
							// unmapped columns so they aren't easy to overlook.
							let columnsHtml = '';
							if (file.objectName && file.describe && Array.isArray(file.describe.fields)) {
								const fieldOpts = file.describe.fields
									.slice()
									.sort((a, b) => String(a.label || a.name).localeCompare(String(b.label || b.name)));
								// Add Id at the top with a clear "this means
								// UPDATE" label. Salesforce's describe lists
								// Id but flags it non-createable, and the
								// server's describe payload only keeps createable
								// fields - so describe.fields never carries Id.
								// Surface it manually for any updateable object,
								// because mapping a column to Id is what triggers
								// the row-as-existing path downstream (we fetch
								// the live record by Id; rec.loadedFromId is set
								// and the card shows as a loaded existing record).
								if (file.describe.updateable !== false) {
									fieldOpts.unshift({
										name: 'Id',
										label: 'Salesforce Id - match & UPDATE existing record',
									});
								}
								const rows = file.headers.map((h, ci) => {
									const current = file.mapping[ci] || '';
									const opts = '<option value=""> - Skip - </option>' +
										fieldOpts.map((f) =>
											'<option value="' + escapeHtml(f.name) + '"' + (f.name === current ? ' selected' : '') + '>' +
												escapeHtml(f.label || f.name) + ' (' + escapeHtml(f.name) + ')' +
															(!f.createable ? ' - no create access' : '') +
											'</option>'
										).join('');
									const status = current
										? '<span class="lcsv-col-status mapped" title="Mapped">\u2713</span>'
										: '<span class="lcsv-col-status unmapped" title="Skipped on import">\u25CB</span>';
									return (
										'<div class="lcsv-col-row">' +
											status +
											'<code class="lcsv-col-name">' + escapeHtml(h) + '</code>' +
											'<select class="lcsv-col-map" data-lcsv-col="' + i + ':' + ci + '">' + opts + '</select>' +
										'</div>'
									);
								}).join('');
								const openByDefault = unmappedCount > 0;
								columnsHtml =
									'<details class="lcsv-cols"' + (openByDefault ? ' open' : '') + '>' +
										'<summary>Columns ' +
											'<span class="lcsv-cols-summary">' +
												(unmappedCount > 0
													? unmappedCount + ' column' + (unmappedCount === 1 ? '' : 's') + ' unmapped'
													: 'all mapped') +
											'</span>' +
										'</summary>' +
										'<div class="lcsv-col-list">' + rows + '</div>' +
									'</details>';
							}
							const fileLabel = displayNames[i] || file.name;
							const dupSuffixTitle = fileLabel !== file.name
								? ' title="Original filename: ' + escapeHtml(file.name) + ' (suffix added because another file with this name is also loaded)"'
								: '';
							// Operation picker per file. Default 'insert'.
							// 'upsert' is offered when the file's describe
							// exposes one or more External Id custom fields
							// AND at least one of them is mapped in the CSV
							// (otherwise upsert has no key to match on).
							// 'update' deferred (S220) - not surfaced here.
							const eligibleExtIdFields = (file.describe && Array.isArray(file.describe.fields))
								? file.describe.fields.filter((f) => f && f.externalId && f.filterable === true && f.createable)
								: [];
							const mappedFieldNames = new Set(Object.values(file.mapping || {}).filter(Boolean));
							const mappedExtIdFields = eligibleExtIdFields.filter((f) => mappedFieldNames.has(f.name));
							const opPicker = (file.objectName && mappedExtIdFields.length > 0)
								? (() => {
									const currentOp = file.operation || 'insert';
									const currentExt = file.externalIdFieldName || '';
									const extOpts = mappedExtIdFields.map((f) =>
										'<option value="' + escapeHtml(f.name) + '"' + (f.name === currentExt ? ' selected' : '') + '>' +
											escapeHtml(f.label || f.name) + ' (' + escapeHtml(f.name) + ')' +
										'</option>'
									).join('');
									return (
										'<div class="lcsv-op-row">' +
											'<label class="lcsv-op-label">Operation:</label>' +
											'<select class="lcsv-op" data-lcsv-op="' + i + '">' +
												'<option value="insert"' + (currentOp === 'insert' ? ' selected' : '') + '>Insert new records</option>' +
												'<option value="upsert"' + (currentOp === 'upsert' ? ' selected' : '') + '>Upsert by external id</option>' +
											'</select>' +
											(currentOp === 'upsert'
												? '<label class="lcsv-op-label">Key:</label>' +
													'<select class="lcsv-op-key" data-lcsv-op-key="' + i + '">' + extOpts + '</select>'
												: ''
											) +
										'</div>'
									);
								})()
								: '';
							return (
								'<div class="lcsv-file">' +
									'<div class="lcsv-file-head">' +
										'<span class="lcsv-name"' + dupSuffixTitle + '>' + escapeHtml(fileLabel) + '</span>' +
										'<span class="lcsv-meta">' + file.rows.length + ' row' + (file.rows.length === 1 ? '' : 's') + '</span>' +
										'<button type="button" class="lcsv-remove" data-lcsv-remove="' + i + '" title="Remove this file">\u00D7</button>' +
									'</div>' +
									'<div class="lcsv-file-body">' +
										'<select class="lcsv-obj" data-lcsv-obj="' + i + '">' + opts + '</select>' +
										meta +
									'</div>' +
									permWarn +
									opPicker +
									columnsHtml +
								'</div>'
							);
						}).join('');
					const links = state.links || [];
					const linksHtml = links.length === 0
						? (state.files.filter((f) => f.objectName).length >= 2
							? '<p class="tag">No FK links auto-detected between these files. Records will import unconnected; you can wire them on the canvas after.</p>'
							: '')
						: links.map((link, i) => {
							const fromFile = state.files[link.fromFileIdx];
							const toFile = state.files[link.toFileIdx];
							const colOpts = '<option value=""> - Don\u2019t link - </option>' +
								toFile.headers.map((h, ci) =>
									'<option value="' + ci + '"' + (ci === link.toColumnIdx ? ' selected' : '') + '>' +
										escapeHtml(h || '(blank)') +
									'</option>'
								).join('');
							const samplesHtml = link.samples.length > 0
								? '<div class="lcsv-link-samples">e.g. ' + link.samples.map((s) => '<code>' + escapeHtml(s) + '</code>').join(', ') + '</div>'
								: '';
							const ratio = link.total > 0 ? Math.round((link.matched / link.total) * 100) : 0;
							const stateClass = link.matched === link.total ? 'lcsv-link-full'
								: (link.matched > 0 ? 'lcsv-link-partial' : 'lcsv-link-empty');
							const fromLabel = displayNames[link.fromFileIdx] || fromFile.name;
							const toLabel = displayNames[link.toFileIdx] || toFile.name;
							return (
								'<div class="lcsv-link ' + stateClass + '">' +
									'<div class="lcsv-link-head">' +
										'<code>' + escapeHtml(fromLabel) + '</code>.<code>' + escapeHtml(link.fromHeader) + '</code>' +
										' <span class="lcsv-arrow">\u2192</span> ' +
										'<code>' + escapeHtml(toLabel) + '</code>.<select class="lcsv-link-col" data-lcsv-link="' + i + '">' + colOpts + '</select>' +
									'</div>' +
									'<div class="lcsv-link-stats">' +
										'<strong>' + link.matched + ' / ' + link.total + '</strong> values matched (' + ratio + '%)' +
									'</div>' +
									samplesHtml +
								'</div>'
							);
						}).join('');
					// Pre-compute the row/file summary so the Files section
					// can carry the count (was previously appended to each
					// action button's label, which made them long).
					const _validForSummary = state.files.filter((f) => f.objectName && Object.values(f.mapping).filter(Boolean).length > 0);
					const _totalRowsForSummary = _validForSummary.reduce((n, f) => n + f.rows.length, 0);
					const _linkedCountForSummary = (state.links || []).length;
					const _isMultiOrLinkedForSummary = _validForSummary.length > 1 || _linkedCountForSummary > 0;
					// Single-file uploads above the validated cap fall
					// through to Bulk API v2 once they reach the upload
					// modal. There's a separate "switch to Bulk" warning
					// downstream, but surfacing the trade-off here means
					// the user sees it before they commit to a path -
					// otherwise they only learn after clicking Upload.
					const _bulkBannerForSummary = !_isMultiOrLinkedForSummary
						&& _totalRowsForSummary > _DIRECT_CSV_VALIDATED_CAP;
					const _filesSummary = _validForSummary.length > 0
						? _totalRowsForSummary + ' record' + (_totalRowsForSummary === 1 ? '' : 's') + ' from ' + _validForSummary.length + ' file' + (_validForSummary.length === 1 ? '' : 's') + ' ready'
						: 'map at least one file';
					// Object catalog still loading? Show a loading placeholder
					// instead of the dropzone - auto-guess and per-file object
					// picker both depend on `canvasState.allObjects`, so dropping files
					// before it resolves leaves the user staring at an empty
					// picker. The modal re-renders when the catalog lands.
					const dropzoneHtml = (canvasState.allObjects === null)
						? '<div class="lcsv-dropzone is-loading" tabindex="-1" aria-busy="true">' +
							'<strong>Loading object catalog…</strong>' +
							'<span class="tag">First load can take 30+ seconds in a fresh org.</span>' +
						'</div>'
						: '<div class="lcsv-dropzone" id="lcsv-dropzone" tabindex="0">' +
							'<strong>Drop CSV files here</strong>' +
							'<span class="tag">or click to select</span>' +
							'<input type="file" id="lcsv-file-input" accept=".csv,text/csv,text/plain" multiple style="display:none">' +
						'</div>';
					// Parse-time warnings (rejected files, ragged rows, duplicate
					// names) render INSIDE the modal. They used to go through
					// showBulkToast, which (a) anchors behind the modal overlay
					// and (b) removes prior toasts - three warnings in one drop
					// batch left at most one visible, dimmed, behind the modal.
					const _noticesHtml = (state.notices && state.notices.length)
						? '<div class="lcsv-notices">' +
							state.notices.map((n) =>
								'<div class="banner ' + (n.kind === 'error' ? 'error' : 'warn') + '" style="margin:0 0 0.5em">' +
									escapeHtml(n.text) +
								'</div>'
							).join('') +
						'</div>'
						: '';
					body.innerHTML =
						_noticesHtml +
						'<div class="lcsv-step">' +
							dropzoneHtml +
						'</div>' +
						(state.files.length > 0
							? '<div class="lcsv-step">' +
								'<div class="lcsv-files-header"><strong>Files</strong><span class="tag lcsv-files-summary">' + _filesSummary + '</span></div>' +
								(_bulkBannerForSummary
									? '<div class="banner warn lcsv-bulk-banner" data-lcsv-bulk-banner>' +
										'<strong>Large upload - atomicity not guaranteed.</strong> ' +
										_totalRowsForSummary.toLocaleString() + ' rows is past the ' + _DIRECT_CSV_VALIDATED_CAP.toLocaleString() + '-row pre-flight limit, so ' +
										'<em>Upload to Salesforce</em> will run via the Bulk API v2. Records commit independently - some may succeed while others fail, and there is no all-or-nothing rollback. Per-row failures are reported when the upload finishes.' +
									'</div>'
									: '') +
								'<div class="lcsv-files">' + filesHtml + '</div>' +
							'</div>'
							: '') +
						// Detected links section - only render when there
						// are actual links to surface. With one file or
						// two files that share no overlapping values,
						// linksHtml would otherwise show a "no links
						// detected" tag, which adds visual noise without
						// surfacing useful info.
						(links.length > 0
							? '<div class="lcsv-step"><strong>Detected links</strong>' +
								'<p class="tag">FK columns are auto-paired with the closest match by value overlap. Adjust or skip below; unlinked rows still import as standalone records.</p>' +
								'<div class="lcsv-links">' + linksHtml + '</div>' +
							'</div>'
							: '');
					const dz = body.querySelector('#lcsv-dropzone');
					const fileInput = body.querySelector('#lcsv-file-input');
					if (dz && fileInput) {
						dz.addEventListener('click', () => fileInput.click());
						dz.addEventListener('dragover', (e) => {
 e.preventDefault(); dz.classList.add('drag'); 
});
						dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
						dz.addEventListener('drop', (e) => {
							e.preventDefault();
							dz.classList.remove('drag');
							linkedCsvHandleFiles(e.dataTransfer && e.dataTransfer.files);
						});
						fileInput.addEventListener('change', (e) => linkedCsvHandleFiles(e.target.files));
					}
					body.querySelectorAll('[data-lcsv-obj]').forEach((sel) => {
						sel.addEventListener('change', (e) => linkedCsvSetObject(Number(e.target.dataset.lcsvObj), e.target.value));
					});
					body.querySelectorAll('[data-lcsv-remove]').forEach((btn) => {
						btn.addEventListener('click', () => linkedCsvRemoveFile(Number(btn.dataset.lcsvRemove)));
					});
					body.querySelectorAll('[data-lcsv-link]').forEach((sel) => {
						sel.addEventListener('change', (e) => linkedCsvUpdateLink(Number(e.target.dataset.lcsvLink), e.target.value));
					});
					body.querySelectorAll('[data-lcsv-col]').forEach((sel) => {
						sel.addEventListener('change', (e) => {
							const [fileIdx, colIdx] = e.target.dataset.lcsvCol.split(':').map(Number);
							linkedCsvUpdateColumn(fileIdx, colIdx, e.target.value);
						});
					});
					// Operation picker handlers - change either the
					// operation (insert/upsert) or the external-id field.
					// Re-render after each change so the dependent
					// external-id dropdown shows/hides correctly.
					body.querySelectorAll('[data-lcsv-op]').forEach((sel) => {
						sel.addEventListener('change', (e) => {
							linkedCsvUpdateOperation(Number(e.target.dataset.lcsvOp), e.target.value);
						});
					});
					body.querySelectorAll('[data-lcsv-op-key]').forEach((sel) => {
						sel.addEventListener('change', (e) => {
							linkedCsvUpdateExternalIdField(Number(e.target.dataset.lcsvOpKey), e.target.value);
						});
					});
					// Buttons rendered conditionally per mode (canvas page has
					// replace/confirm; Quick Upload page has only upload), so
					// every lookup must be null-safe.
					const replaceBtn = linkedCsvModal.querySelector('#linked-csv-replace');
					const confirmBtn = linkedCsvModal.querySelector('#linked-csv-confirm');
					const uploadBtn = linkedCsvModal.querySelector('#linked-csv-upload');
					const ready = _validForSummary.length > 0 && !state.files.some((f) => Array.isArray(f.blockingErrors) && f.blockingErrors.length > 0);
					if (confirmBtn) {
confirmBtn.disabled = !ready;
}
					if (replaceBtn) {
replaceBtn.disabled = !ready;
}
					if (uploadBtn) {
uploadBtn.disabled = !ready;
}
					// Path 2 / Path 3 caps for the upload-to-Salesforce
					// (skipCanvas) button. Per docs/UPLOAD_ARCHITECTURE.md:
					//   * Multi-file imports OR single-file imports with
					//     detected FK linking → Path 2, capped at 5,000.
					//   * Single flat file with no linking → Path 3, no
					//     atomic upper limit (Bulk API per-record).
					if (uploadBtn && ready) {
						const linkedCount = (state.links || []).length;
						const isMultiOrLinked = _validForSummary.length > 1 || linkedCount > 0;
						const overValidatedCap = isMultiOrLinked && _totalRowsForSummary > _DIRECT_CSV_VALIDATED_CAP;
						if (overValidatedCap) {
							uploadBtn.disabled = true;
							uploadBtn.title = 'Multi-file or linked uploads are capped at ' + _DIRECT_CSV_VALIDATED_CAP.toLocaleString() + ' rows. Split this batch or remove FK linking.';
						} else if (_bulkBannerForSummary) {
							uploadBtn.title = 'Large single-file upload - runs via Bulk API v2. Per-record success/failure; no pre-flight check, no atomic rollback.';
						} else {
							uploadBtn.title = isMultiOrLinked
								? 'Multi-file / linked upload. Records will be validated and committed together via the Composite Graph API (atomic per connected component).'
								: 'Bulk upload via Salesforce Bulk API. Per-record success/failure; no pre-flight check.';
						}
					}
				}

				// Detect CSV columns mapped to fields the current SF user
			// can't write to. Quick Upload (and canvas-save imports)
			// historically called stripUnwritableFields() on the server
			// which SILENTLY dropped these - the records inserted with
			// the field empty and the user got no warning. That's a
			// footgun for FLS-restricted profiles. We surface the
			// dropped fields up front and require explicit confirmation
			// so the user knows what's about to happen.
			//
			// Check uses describe.fields[].createable since CSV imports
			// are primarily an insert workflow. The canvas-save path
			// for previously-loaded records (loadedFromId, update mode)
			// uses updateable instead - a refinement worth doing if
			// the canvas-save flow also needs this warning, but Quick
			// Upload is the immediate concern.
			//
			// Composite fields (address, location) are skipped - they're
			// never writable directly; their components (BillingStreet,
			// BillingCity, etc.) carry the actual write perm.
			function _detectUnwritableMappedFields(files) {
				const issues = [];
				for (const file of files) {
					if (!file.describe || !Array.isArray(file.describe.fields)) {
continue;
}
					const fieldByName = new Map();
					file.describe.fields.forEach((f) => {
 if (f && f.name) {
fieldByName.set(f.name, f);
} 
});
					const bad = [];
					Object.keys(file.mapping || {}).forEach((colIdx) => {
						const fieldName = file.mapping[colIdx];
						if (!fieldName) {
return;
}
						// Id is the existing-record match key, never a field sent to
						// create/update DML, so its expected createable:false is not an
						// FLS problem and must not trigger the dropped-field warning.
						if (fieldName === 'Id') {
return;
}
						const field = fieldByName.get(fieldName);
						if (!field) {
return;
}
						if (field.type === 'address' || field.type === 'location') {
return;
}
						if (!field.createable) {
							bad.push({
								csvHeader: (file.headers && file.headers[Number(colIdx)]) || '(blank)',
								fieldName,
								fieldLabel: field.label || fieldName,
							});
						}
					});
					if (bad.length > 0) {
						issues.push({ fileName: file.name, objectName: file.objectName, fields: bad });
					}
				}
				return issues;
			}

			// A join value must identify exactly one target row. The old O(1)
			// index deliberately kept the first duplicate, which made file order
			// silently decide a child's Salesforce parent. Surface every
			// referenced duplicate before mutation and let the user either return
			// to mapping or explicitly import those children unlinked.
			function _detectAmbiguousJoinKeys(state) {
				const issues = [];
				(state.links || []).forEach((link, linkIdx) => {
					const fromFile = state.files[link.fromFileIdx];
					const toFile = state.files[link.toFileIdx];
					if (!fromFile || !toFile || link.toColumnIdx == null) {
return;
}
					const targetRows = new Map();
					toFile.rows.forEach((row, rowIdx) => {
						const value = String(row[link.toColumnIdx] || '').trim();
						if (!value) {
return;
}
						if (!targetRows.has(value)) {
targetRows.set(value, []);
}
						targetRows.get(value).push(rowIdx);
					});
					const sourceCounts = new Map();
					fromFile.rows.forEach((row) => {
						const value = String(row[link.fromColumnIdx] || '').trim();
						if (value) {
sourceCounts.set(value, (sourceCounts.get(value) || 0) + 1);
}
					});
					targetRows.forEach((rows, value) => {
						if (rows.length > 1 && sourceCounts.has(value)) {
							issues.push({ linkIdx, value, targetCount: rows.length, childCount: sourceCounts.get(value), fromField: link.fromField });
						}
					});
				});
				return issues;
			}

			// Look up every Id-mapped CSV row against Salesforce so found
			// rows can import as real existing records and missing ones can
			// be triaged. Batched per object (chunks of 200) via /api/query
			// with full-field rehydration. Returns:
			//   { liveById: Map(15charId -> liveValues), draftKeys: Set(cellKey), canceled: bool }
			async function csvResolveExistingIds(validFiles, state, cellKey) {
				const liveById = new Map();
				const idRows = [];
				validFiles.forEach((file) => {
					const fromFileIdx = state.files.indexOf(file);
					const mapping = file.mapping || {};
					const idColIdxStr = Object.keys(mapping).find((iStr) => mapping[Number(iStr)] === 'Id');
					if (idColIdxStr == null) {
return;
}
					const idColIdx = Number(idColIdxStr);
					const nameColIdxStr = Object.keys(mapping).find((iStr) => mapping[Number(iStr)] === 'Name');
					const nameColIdx = nameColIdxStr != null ? Number(nameColIdxStr) : null;
					file.rows.forEach((row, rowIdx) => {
						const raw = row[idColIdx];
						const sfId = (raw != null && String(raw).trim() !== '') ? String(raw).trim() : null;
						if (!sfId) {
return;
}
						const nm = nameColIdx != null ? String(row[nameColIdx] || '').trim() : '';
						idRows.push({
							key: cellKey(fromFileIdx, rowIdx),
							sfId,
							objectName: file.objectName,
							label: (nm ? nm + ' · ' : '') + file.objectName + ' · ' + sfId,
						});
					});
				});
				if (idRows.length === 0) {
return { liveById, draftKeys: new Set(), canceled: false };
}
				const byObj = new Map();
				idRows.forEach((r) => {
					if (!byObj.has(r.objectName)) {
byObj.set(r.objectName, new Set());
}
					byObj.get(r.objectName).add(r.sfId);
				});
				for (const [obj, idset] of byObj) {
					const ids = Array.from(idset);
					for (let i = 0; i < ids.length; i += 200) {
						const chunk = ids.slice(i, i + 200);
						const inList = chunk.map((x) => "'" + String(x).replace(/'/g, '') + "'").join(',');
						try {
							const resp = await csrfFetch('/api/query', {
								method: 'POST',
								headers: { 'content-type': 'application/json' },
								credentials: 'same-origin',
								body: JSON.stringify({ soql: 'SELECT Id FROM ' + obj + ' WHERE Id IN (' + inList + ')', fullFields: true }),
							});
							if (resp.ok) {
								const data = await resp.json();
								(data.records || []).forEach((rec) => {
									if (rec && rec.loadedFromId) {
liveById.set(String(rec.loadedFromId).slice(0, 15), rec.values || {});
}
								});
							}
						} catch (e) { /* network/query error → rows treated as not-found */ }
					}
				}
				const missing = idRows.filter((r) => !liveById.has(r.sfId.slice(0, 15)));
				if (missing.length === 0) {
return { liveById, draftKeys: new Set(), canceled: false };
}
				const choice = await showMissingIdChecklist(missing);
				if (choice === null) {
return { liveById, draftKeys: new Set(), canceled: true };
}
				return { liveById, draftKeys: choice, canceled: false };
			}

			// Checklist for CSV rows whose mapped Id wasn't found in Salesforce.
			// Resolves to a Set of cellKeys the user wants created as new drafts,
			// or null to cancel the whole import.
			function showMissingIdChecklist(items) {
				return new Promise((resolve) => {
					document.querySelectorAll('.missing-id-modal').forEach((el) => el.remove());
					const modal = document.createElement('div');
					modal.className = 'modal missing-id-modal';
					const rows = items.map((it, i) =>
						'<label class="missing-id-row" style="display:flex;align-items:center;gap:8px;padding:4px 0;">' +
							'<input type="checkbox" data-mid="' + i + '" checked>' +
							'<span>' + escapeHtml(it.label) + '</span>' +
						'</label>'
					).join('');
					modal.innerHTML =
						'<div class="modal-overlay" data-mid-close></div>' +
						'<div class="modal-body" style="max-width:520px">' +
							'<div class="modal-header"><h3>Some Id rows weren’t found</h3>' +
								'<button class="modal-close" data-mid-close>&times;</button></div>' +
							'<div class="modal-content">' +
								'<p style="white-space:pre-line">' + items.length + ' row' + (items.length === 1 ? '' : 's') +
									(items.length === 1 ? ' references' : ' reference') + ' a Salesforce Id that doesn’t exist in this org (deleted, wrong org, or a typo). ' +
									'Pick which to add as new draft records - unchecked rows are skipped. ' +
									'Rows whose Id WAS found import as existing records regardless.</p>' +
								'<div style="display:flex;gap:12px;margin:6px 0;">' +
									'<button type="button" class="button secondary" data-mid-all>Select all</button>' +
									'<button type="button" class="button secondary" data-mid-none>Select none</button>' +
								'</div>' +
								'<div class="missing-id-list" style="max-height:280px;overflow:auto;border:1px solid var(--border);border-radius:4px;padding:8px;">' + rows + '</div>' +
							'</div>' +
							'<div class="modal-footer">' +
								'<button class="button secondary" data-mid-cancel>Cancel import</button>' +
								'<button class="button" data-mid-confirm>Import</button>' +
							'</div>' +
						'</div>';
					document.body.appendChild(modal);
					let settled = false;
					const finish = (val) => {
						if (settled) {
return;
}
						settled = true;
						document.removeEventListener('keydown', onKey);
						modal.remove();
						resolve(val);
					};
					const onKey = (e) => {
 if (e.key === 'Escape') {
finish(null);
} 
};
					document.addEventListener('keydown', onKey);
					modal.querySelectorAll('[data-mid-close], [data-mid-cancel]').forEach((el) => el.addEventListener('click', () => finish(null)));
					modal.querySelector('[data-mid-all]').addEventListener('click', () => modal.querySelectorAll('input[data-mid]').forEach((cb) => {
 cb.checked = true; 
}));
					modal.querySelector('[data-mid-none]').addEventListener('click', () => modal.querySelectorAll('input[data-mid]').forEach((cb) => {
 cb.checked = false; 
}));
					modal.querySelector('[data-mid-confirm]').addEventListener('click', () => {
						const chosen = new Set();
						modal.querySelectorAll('input[data-mid]').forEach((cb) => {
 if (cb.checked) {
chosen.add(items[Number(cb.dataset.mid)].key);
} 
});
						finish(chosen);
					});
					setTimeout(() => {
 const b = modal.querySelector('[data-mid-confirm]'); if (b) {
b.focus();
} 
}, 0);
				});
			}

			async function linkedCsvConfirm(opts) {
					opts = opts || {};
					const skipCanvas = !!opts.uploadDirectly;
					const state = linkedCsvState;
					if (!state) {
return;
}
					// Mapping/describes are connection-scoped. Re-check immediately
					// before any materialization so a connection change in another tab
					// cannot send a stale plan to the newly active org.
					if (skipCanvas) {
						try {
							const plannedConnection = await state.planConnectionPromise;
							const response = await csrfFetch('/api/me', { credentials: 'same-origin' });
							const me = await response.json();
							const activeConnection = me && me.connection ? {
								id: me.connection.id || null,
								sfOrgId: me.connection.sfOrgId || me.connection.organizationId || null,
							} : null;
							const changed = !plannedConnection || !activeConnection ||
								(plannedConnection.id && activeConnection.id && plannedConnection.id !== activeConnection.id) ||
								(plannedConnection.sfOrgId && activeConnection.sfOrgId && plannedConnection.sfOrgId !== activeConnection.sfOrgId);
							if (!response.ok || changed) {
								closeLinkedCsvModal();
								showBulkToast('Your active Salesforce org changed. Quick Upload was cancelled; reopen it to remap against the active org.', 'error');
								return;
							}
						} catch (e) {
							showBulkToast('Could not verify the active Salesforce org. Nothing was uploaded; retry when the connection is available.', 'error');
							return;
						}
					}
					const validFiles = state.files.filter((f) => f.objectName && Object.values(f.mapping).filter(Boolean).length > 0);
					if (validFiles.length === 0) {
return;
}
					if (validFiles.some((f) => Array.isArray(f.blockingErrors) && f.blockingErrors.length > 0)) {
						showBulkToast('Fix the blocked CSV structure errors before importing.', 'error');
						return;
					}
					const ambiguousJoins = _detectAmbiguousJoinKeys(state);
					state._skippedAmbiguousJoinKeys = new Set();
					if (ambiguousJoins.length > 0) {
						const lines = ['Some relationship keys match more than one parent row:', ''];
						ambiguousJoins.forEach((issue) => {
							lines.push('• "' + issue.value + '" → ' + issue.targetCount + ' parents, ' + issue.childCount + ' child' + (issue.childCount === 1 ? '' : 'ren') + ' (' + issue.fromField + ')');
						});
						lines.push('', 'Org Loom will never pick a parent based on file order. Continue only if you want the affected children imported without those relationships.');
						const skip = await showConfirmDialog({
							title: 'Ambiguous relationship keys',
							message: lines.join('\n'),
							confirmLabel: 'Import affected rows unlinked',
							cancelLabel: 'Back to mapping',
							danger: true,
						});
						if (!skip) {
return;
}
						ambiguousJoins.forEach((issue) => state._skippedAmbiguousJoinKeys.add(issue.linkIdx + '::' + issue.value));
					}
					// Warn-and-confirm for FLS-blocked fields. Runs before
					// any path-specific cap check or state mutation so the
					// user can cancel without side effects. Applies to both
					// Quick Upload and canvas-import paths since both call
					// stripUnwritableFields server-side.
					const unwritable = _detectUnwritableMappedFields(validFiles);
					// Build a flat ['Object.Field', ...] summary for the
					// csv_import audit payload below. Empty array when the
					// user has full write perms: recorded as [] (not
					// undefined) in the payload so audit-log consumers can
					// rely on the field's presence to mean "we checked".
					const strippedFieldsSummary = [];
					for (const issue of unwritable) {
						for (const f of issue.fields) {
							strippedFieldsSummary.push(issue.objectName + '.' + f.fieldName);
						}
					}
					if (unwritable.length > 0) {
						const lines = ['Your Salesforce user doesn’t have write access to some fields in your CSV mapping:', ''];
						for (const issue of unwritable) {
							lines.push(issue.fileName + ' (' + issue.objectName + '):');
							for (const f of issue.fields) {
								lines.push('  • ' + f.csvHeader + ' → ' + f.fieldLabel + ' (' + f.fieldName + ')');
							}
							lines.push('');
						}
						lines.push('If you continue, these columns will be silently dropped - the records will be created with those fields empty.');
						lines.push('');
						lines.push('To upload these values, either ask your SF admin to grant your profile write access on the fields above, or remove those columns from the CSV.');
						const ok = await showConfirmDialog({
							title: 'Some fields can’t be written',
							message: lines.join('\n'),
							confirmLabel: 'Upload anyway',
							cancelLabel: 'Cancel',
							danger: true,
						});
						if (!ok) {
return;
}
					}
					// Path-classifier guards for the upload-to-Salesforce
					// (skipCanvas) button. Mirrors the rules from
					// docs/UPLOAD_ARCHITECTURE.md:
					//   * Path 2 (multi-file or linked single-file): hard
					//     cap at _DIRECT_CSV_VALIDATED_CAP. Already
					//     enforced by disabling the button in
					//     linkedCsvRender, but we re-check here in case the
					//     user got past via keyboard or a stale state.
					//   * Path 3 (single flat file, no linking, beyond the
					//     validated cap): no extra confirm here - the
					//     in-modal banner (.lcsv-bulk-banner) already
					//     warns about Bulk API non-atomicity, and
					//     showBulkSwitchWarning fires once the upload
					//     modal opens. A second window.confirm at this
					//     point would just be a redundant click.
					if (skipCanvas) {
						const linkedCount = (state.links || []).length;
						const totalRows = validFiles.reduce((n, f) => n + f.rows.length, 0);
						const isMultiOrLinked = validFiles.length > 1 || linkedCount > 0;
						if (isMultiOrLinked && totalRows > _DIRECT_CSV_VALIDATED_CAP) {
							showBulkToast('Multi-file or linked uploads are capped at ' + _DIRECT_CSV_VALIDATED_CAP.toLocaleString() + ' rows. Split this batch or remove the FK linking.', 'error');
							return;
						}
					}
					// ORDERING INVARIANT: nothing below may mutate canvas state
					// until every cancelable / refusable step has passed - the
					// not-found checklist can Cancel and the cap check can
					// refuse. The Replace wipe used to run first, so a Cancel
					// (or a cap refusal) destroyed the user's canvas while
					// importing nothing.
					const shouldReplace = !!opts.replaceCanvas;
					const canvas = getGraph().querySelector('#bulk-canvas');
					const W = canvas ? canvas.clientWidth : 1200;
					const startX = 80;
					const startY = 80;
					const stepX = 220;
					const stepY = 180;
					const perRow = Math.max(1, Math.floor((W - startX) / stepX));
					// Snapshot canvasState.selectedObjects BEFORE the addToSelection loop
					// so the skipCanvas-path cleanup can restore the schema
					// to its pre-import state. Without this, cleanup
					// "restores" to the post-addToSelection state and the
					// new CSV-introduced objects survive - triggering the
					// unmirrored-types auto-port which spawns one draft per
					// surviving entry.
					const _preImportSelectedObjects = canvasState.selectedObjects.slice();
					// Resolve Id-mapped rows against Salesforce up front - before
					// any canvas or schema mutation - so a Cancel in the
					// not-found checklist leaves no side effects. Found ids load
					// as existing records; missing ids are triaged (draft or skip).
					const cellKey = (fi, ri) => fi + '|' + ri;
					const _idResolution = await csvResolveExistingIds(validFiles, state, cellKey);
					if (_idResolution.canceled) {
return;
}
					// Canvas-collision dedup (canvas mode only): index cards
					// already on the canvas by object + 15-char Id, so an
					// imported Id that already has a card merges onto it via the
					// Diff modal instead of creating a duplicate. Replace mode
					// wipes the canvas before materializing, so its index is
					// deliberately empty (no false collisions with cards that
					// are about to disappear). Quick-upload (skipCanvas) is
					// upload-only - no canvas to collide with.
					const existingCanvasById = new Map();
					const mergeQueue = [];
					let mergeSkippedNoModal = 0;
					let unchangedCount = 0;
					if (!skipCanvas && !shouldReplace) {
						canvasState.bulkRecords.forEach((rec) => {
							if (!rec || rec.isTypeNode) {
								return;
							}
							const key = rec.loadedFromId || (rec.values && rec.values.Id);
							if (key) {
								existingCanvasById.set(rec.objectName + '::' + String(key).slice(0, 15), rec);
							}
						});
					}
					// Path 1 cap (canvas → Composite Graph): canvas-bound
					// imports must respect the canvas record cap. Count only
					// the rows that will become NEW cards - collision-merges,
					// unchanged skips, and checklist-skipped rows add nothing
					// (re-importing rows already on the canvas near the cap
					// must not be refused). Replace mode baselines at 0 (the
					// canvas is wiped before materializing). The Upload-to-
					// Salesforce path (skipCanvas) has its own caps above.
					if (!skipCanvas) {
						let plannedNewCards = 0;
						validFiles.forEach((file) => {
							const fromFileIdx = state.files.indexOf(file);
							const mapping = file.mapping || {};
							const idColIdxStr = Object.keys(mapping).find((iStr) => mapping[Number(iStr)] === 'Id');
							const idColIdx = idColIdxStr != null ? Number(idColIdxStr) : null;
							file.rows.forEach((row, rowIdx) => {
								const raw = idColIdx != null ? row[idColIdx] : null;
								const sfId = (raw != null && String(raw).trim() !== '') ? String(raw).trim() : null;
								if (sfId && existingCanvasById.has(file.objectName + '::' + sfId.slice(0, 15))) {
									return; // collision → merges onto the existing card
								}
								if (sfId && !_idResolution.liveById.has(sfId.slice(0, 15))
									&& !_idResolution.draftKeys.has(cellKey(fromFileIdx, rowIdx))) {
									return; // not found + not drafted → row skipped
								}
								plannedNewCards++;
							});
						});
						const _capProbe = canvasCapCheck ? canvasCapCheck(plannedNewCards) : null;
						const blocked = _capProbe
							? (shouldReplace
								? (plannedNewCards > _capProbe.cap ? _capProbe.reason : null)
								: _capProbe.reason)
							: _canvasCapBlockReason(plannedNewCards);
						if (blocked) {
 showBulkToast(blocked, 'error'); return;
}
					}
					// All cancelable steps have passed - snapshot for the
					// post-import Undo toast, then mutate.
					const _undoImport = (!skipCanvas && captureUndoSnapshot)
						? captureUndoSnapshot()
						: null;
					// Per-file: ensure the object is in canvasState.selectedObjects so the
					// upload path knows about it.
					const selByName = new Map();
					for (const file of validFiles) {
						let sel = canvasState.selectedObjects.find((s) => s.name === file.objectName);
						if (!sel) {
							try {
 sel = await addToSelection(file.objectName);
} catch (e) {
 console.warn('addToSelection failed for', file.objectName, e); continue;
}
						}
						selByName.set(file.objectName, sel);
					}
					// "Replace canvas" path - drop every existing record +
					// association so the new CSV starts from a clean slate.
					// canvasState.selectedObjects is preserved (the schema stays so the
					// new import can wire into it), but the current-canvas
					// pointer and draft id are cleared - the replaced content
					// is a NEW unsaved canvas, so autosave can't overwrite the
					// previously open saved canvas under its old identity
					// (same semantics as the JSON importer's Replace).
					if (shouldReplace) {
						canvasState.bulkRecords = [];
						canvasState.bulkAssociations = [];
						canvasState.currentCanvas = null;
						if (window.Orgloom && window.Orgloom.canvasState && window.Orgloom.canvasState.clearDraft) {
							window.Orgloom.canvasState.clearDraft();
						}
					} else {
						// Merge path - wipe just the lone empty starter card
						// (if any) so imported rows don't sit next to a
						// placeholder. No-op when the canvas already has
						// real content.
						clearEmptyStarterCard();
					}
					// Slot allocator that reserves a swath per file so cards
					// from different files don't interleave on the canvas.
					// Computed AFTER the Replace wipe so a replaced canvas
					// starts laying out from slot 0.
					let slot = canvasState.bulkRecords.length;
					// First pass: materialize records. Track tempId per
					// (fileIdx, rowIdx) so the second pass can resolve links.
					// Track every newly-created record id so the
					// direct-upload path can later isolate them from any
					// pre-existing canvas content.
					const tempIdByCell = new Map();
					const newRecIds = new Set();
					validFiles.forEach((file, vfi) => {
						const fromFileIdx = state.files.indexOf(file);
						const sel = selByName.get(file.objectName);
						if (!sel) {
return;
}
						const mappedIdxs = Object.keys(file.mapping).filter((i) => file.mapping[i]);
						// Find the column (if any) mapped to Id. Rows with a
						// non-empty value here are treated as UPDATE targets:
						// the resulting record gets loadedFromId set, which
						// the upload pipeline routes through update-DML, and
						// the canvas shows it as a loaded-existing record
						// (with CSV values applied as changes) rather than a
						// new draft. Rows without an Id value continue to
						// import as INSERT drafts. Multiple Id mappings -
						// shouldn't happen given the field-picker UI but
						// defensively pick the first.
						const idColIdxStr = mappedIdxs.find((iStr) => file.mapping[Number(iStr)] === 'Id');
						const idColIdx = idColIdxStr != null ? Number(idColIdxStr) : null;
						file.rows.forEach((row, rowIdx) => {
							const values = {};
							mappedIdxs.forEach((iStr) => {
								const i = Number(iStr);
								const field = file.mapping[i];
								// Skip FK columns that will be resolved via
								// associations - leaving the literal user
								// reference (acc-1, etc.) in values would
								// fail Salesforce's id format check.
								const isLinkedFk = (state.links || []).some((l) =>
									l.fromFileIdx === fromFileIdx && l.fromColumnIdx === i);
								if (isLinkedFk) {
return;
}
								// The Id column identifies the record; it's
								// not a field to write. Captured separately
								// as loadedFromId below.
								if (i === idColIdx) {
return;
}
								const v = row[i];
								if (v !== undefined && v !== '') {
values[field] = v;
}
							});
							// Pull the Id value (if mapped + non-empty). Trim
							// because CSVs often carry stray whitespace from
							// copy-paste / Salesforce-export round-trips.
							const rawId = idColIdx != null ? row[idColIdx] : null;
							const sfId = (rawId != null && String(rawId).trim() !== '')
								? String(rawId).trim()
								: null;
							// Canvas-collision: this Id already has a card on the
							// canvas. Don't create a duplicate - merge the CSV's
							// values onto the existing card via the Diff modal,
							// and point any links at that existing card. Identical
							// values are skipped silently.
							if (!skipCanvas && sfId) {
								const _hit = existingCanvasById.get(sel.name + '::' + sfId.slice(0, 15));
								if (_hit) {
									const _vc = window.OrgLoom && window.OrgLoom.valueCompare;
									const _d = (_vc && typeof _vc.computeRecordDiff === 'function')
										? _vc.computeRecordDiff(_hit, { objectName: _hit.objectName, values: values })
										: null;
									const _changes = _d ? (_d.differing.length + _d.bOnly.length) : 1;
									if (_changes > 0) {
										if (openRecordDiffModal) {
											mergeQueue.push({ existing: _hit, values: values, label: sel.label });
										} else {
											mergeSkippedNoModal++;
										}
									} else {
										unchangedCount++;
									}
									tempIdByCell.set(cellKey(fromFileIdx, rowIdx), _hit.id);
									return;
								}
							}
							const id = canvasState.bulkIdSeq++;
							const col = slot % perRow;
							const r = Math.floor(slot / perRow);
							slot++;
							const rec = {
								id,
								objectName: sel.name,
								label: sel.label,
								x: startX + col * stepX,
								y: startY + r * stepY,
								values,
								fromSelectionId: sel.id,
							};
							if (sfId) {
								// Id column present + non-empty: this row targets
								// an EXISTING record, looked up in SF above
								// (_idResolution). Found → load it as a real
								// existing record: live values are the baseline,
								// CSV columns layer on top as edits. Not found →
								// create as a new draft if the user opted in via
								// the checklist, otherwise skip the row entirely.
								const _live = _idResolution.liveById.get(sfId.slice(0, 15));
								if (_live) {
									rec.loadedFromId = sfId;
									rec.loadedValues = Object.assign({}, _live);
									rec.values = Object.assign({}, _live, rec.values);
								} else if (!_idResolution.draftKeys.has(cellKey(fromFileIdx, rowIdx))) {
									// Not found and left unchecked - drop the row,
									// returning its layout slot so no gap is left.
									slot--;
									return;
								}
								// else: not found, but user chose to create it as
								// a new draft - fall through with no loadedFromId.
							}
							// Per-file operation overrides for upsert. The
							// upload route reads these to override the
							// default (loadedFromId ? 'update' : 'insert')
							// per-record grouping. Only stamped when the
							// user picked 'upsert' on the file's operation
							// picker AND chose an external-id field.
							if (file.operation === 'upsert' && file.externalIdFieldName) {
								rec._csvOperation = 'upsert';
								rec._csvExternalIdField = file.externalIdFieldName;
							}
							canvasState.bulkRecords.push(rec);
							newRecIds.add(id);
							tempIdByCell.set(cellKey(fromFileIdx, rowIdx), id);
						});
					});
					// Second pass: resolve links → canvasState.bulkAssociations. For each
					// from-row, look up the matching to-row by value, then
					// connect their tempIds via the FK field.
					let linkedCount = 0;
					let linksSkippedFk = 0;
					let linksSkippedAmbiguous = 0;
					const newAssocIds = new Set();
					// A lookup is single-value: at most one association per
					// (holder, fieldName). Seed from the canvas so a collision
					// row whose links resolve to an EXISTING card can't
					// double-wire a lookup that card already has. Admission
					// rules are shared with the JSON importer
					// (import-shared.js admitAssociation).
					const _admitAssociation = window.OrgLoom.importShared.admitAssociation;
					const _usedFk = new Set();
					canvasState.bulkAssociations.forEach((a) => {
						_usedFk.add(a.fromId + '::' + a.fieldName);
					});
					(state.links || []).forEach((link, linkIdx) => {
						const fromFile = state.files[link.fromFileIdx];
						const toFile = state.files[link.toFileIdx];
						if (!fromFile || !toFile || link.toColumnIdx == null) {
return;
}
						// Pre-index the to-file by its match column for O(1) lookup.
						const toIndex = new Map();
						toFile.rows.forEach((r, idx) => {
							const v = (r[link.toColumnIdx] || '').trim();
							if (v && !toIndex.has(v)) {
toIndex.set(v, idx);
}
						});
						fromFile.rows.forEach((r, fromRowIdx) => {
							const v = (r[link.fromColumnIdx] || '').trim();
							if (!v) {
return;
}
							if (state._skippedAmbiguousJoinKeys && state._skippedAmbiguousJoinKeys.has(linkIdx + '::' + v)) {
								linksSkippedAmbiguous++;
								return;
							}
							const toRowIdx = toIndex.get(v);
							if (toRowIdx == null) {
return;
}
							const fromTempId = tempIdByCell.get(cellKey(link.fromFileIdx, fromRowIdx));
							const toTempId = tempIdByCell.get(cellKey(link.toFileIdx, toRowIdx));
							if (fromTempId == null || toTempId == null) {
return;
}
							if (!_admitAssociation(_usedFk, fromTempId, toTempId, link.fromField)) {
								linksSkippedFk++;
								return;
							}
							const aid = canvasState.bulkIdSeq++;
							canvasState.bulkAssociations.push({
								id: aid,
								fromId: fromTempId,
								toId: toTempId,
								fieldName: link.fromField,
							});
							newAssocIds.add(aid);
							linkedCount++;
						});
					});
					const totalRecords = validFiles.reduce((n, f) => n + f.rows.length, 0);
					const fileCount = validFiles.length;
					// keepQuickUploadMode: the upload payload (built later in
					// the upload-modal flow) still reads the QU flag; the QU
					// cleanup disarms it when the upload modal closes.
					closeLinkedCsvModal({ keepQuickUploadMode: true });
					if (skipCanvas) {
						// Direct-upload path: do NOT render the canvas. Swap
						// canvasState.bulkRecords / canvasState.bulkAssociations / canvasState.selectedObjects
						// to contain ONLY the state needed for the new CSV
						// rows, so:
						//   * the upload pipeline doesn't ship pre-existing
						//     canvas content;
						//   * the post-upload restore doesn't leak any
						//     schema entries that addToSelection added
						//     above (which would trigger renderBulkView's
						//     auto-port and spawn one draft per type).
						// The snapshot restores when the upload modal
						// closes (success, cancel, or post-results
						// "Close"), via _pendingUploadCleanup.
						const _snapRecs = canvasState.bulkRecords.filter((r) => !newRecIds.has(r.id));
						const _snapAssocs = canvasState.bulkAssociations.filter((a) => !newAssocIds.has(a.id));
						const _snapSelectedObjects = _preImportSelectedObjects;
						// The in-memory cleanup closure below cannot survive a reload.
						// Persist only for this tab (sessionStorage) so an interruption
						// restores the user's original canvas without leaving Salesforce
						// data durably on the device.
						try {
							const cy = getCyInstance();
							sessionStorage.setItem(_QU_RESTORE_KEY, JSON.stringify({
								version: 1,
								sfOrgId: window.SF_ORG_ID || null,
								records: _snapRecs,
								associations: _snapAssocs,
								selectedObjects: _snapSelectedObjects,
								selectedIds: Array.from(canvasState.bulkSelectedIds || []),
								bulkIdSeq: canvasState.bulkIdSeq,
								currentCanvas: canvasState.currentCanvas || null,
								viewport: cy ? { zoom: cy.zoom(), pan: cy.pan() } : null,
							}));
						} catch (e) {
							console.warn('Quick Upload recovery snapshot failed:', e);
						}
						canvasState.bulkRecords = canvasState.bulkRecords.filter((r) => newRecIds.has(r.id));
						canvasState.bulkAssociations = canvasState.bulkAssociations.filter((a) => newAssocIds.has(a.id));
						// Hide the canvas content during the upload. Without
						// this, the canvasState.bulkRecords swap leaves the cy / DOM
						// state showing the new CSV records briefly before
						// the upload modal opens (and again whenever the
						// modal lets through a redraw). The class is removed
						// in _pendingUploadCleanup once the modal closes.
						getGraph().classList.add('csv-direct-upload-active');
						setPendingUploadCleanup(() => {
							// Throw away the CSV rows entirely - the user
							// asked for upload-only semantics. canvasState.selectedObjects
							// is restored too so any objects addToSelection
							// added during materialization don't survive the
							// upload and trigger the unmirrored-types auto-
							// port (which would spawn one draft per type).
							canvasState.bulkRecords = _snapRecs;
							canvasState.bulkAssociations = _snapAssocs;
							canvasState.selectedObjects = _snapSelectedObjects;
							getGraph().classList.remove('csv-direct-upload-active');
							// Disarm Quick Upload mode. The flag had to
							// survive closeLinkedCsvModal (the upload payload
							// is built later, inside the upload-modal flow),
							// but once THIS cleanup fires the QU flow is
							// finished - leaving it armed made every
							// subsequent normal canvas upload in the session
							// send directUpload=true: cap-exempt and
							// mislabeled 'upload_direct' in usage metering.
							// Retry-failed is unaffected: retries run while
							// the upload modal is still open, before this
							// cleanup fires.
							_linkedCsvQuickUploadMode = false;
							try {
 sessionStorage.removeItem(_QU_RESTORE_KEY); 
} catch (e) {}
							renderBulkView();
						});
						// Defer the csv_import audit until the upload result is
						// known so the recorded status reflects the actual
						// outcome (ok / partial / failed) rather than just
						// "import initiated". displayUploadResults emits it.
						setPendingCsvImportMeta({
							mode: 'linked-direct-upload',
							recordCount: totalRecords,
							fileCount,
							linksWired: linkedCount,
							// Fields the user knowingly accepted as
							// silently-dropped via the warn-and-confirm modal
							// (see _detectUnwritableMappedFields). [] when all
							// mapped fields were writable.
							strippedFields: strippedFieldsSummary,
						});
						setTimeout(() => openUploadModal(), 0);
						return;
					}
					// Canvas path: render + layout + toast.
					// Tree-aware layout lives in tree-layout.js - same
					// algorithm SOQL import uses, including the gutter
					// below existing records so imports don't overlap
					// the prior arrangement.
					if (totalRecords > 0) {
setSkipNextCyAutoPan(true);
}
					renderBulkView();
					if (totalRecords > 0) {
relayoutNewRecords(newRecIds);
}
					const _mergeTotal = mergeQueue.length + mergeSkippedNoModal;
					const _mergeNote = _mergeTotal > 0
						? ' · ' + _mergeTotal + ' matched a card already on the canvas' +
							(mergeQueue.length > 0 ? ' - review the merge' : ' - skipped')
						: '';
					const _unchangedNote = unchangedCount > 0
						? ' · ' + unchangedCount + ' already on the canvas, unchanged'
						: '';
					const _fkNote = linksSkippedFk > 0
						? ' · ' + linksSkippedFk + ' link' + (linksSkippedFk === 1 ? '' : 's') + ' skipped (lookup already set)'
						: '';
					const _ambiguousNote = linksSkippedAmbiguous > 0
						? ' · ' + linksSkippedAmbiguous + ' link' + (linksSkippedAmbiguous === 1 ? '' : 's') + ' skipped (ambiguous parent key)'
						: '';
					const _toastMsg =
						'Imported ' + totalRecords + ' record' + (totalRecords === 1 ? '' : 's') +
						' from ' + fileCount + ' file' + (fileCount === 1 ? '' : 's') +
						(linkedCount > 0 ? ' (' + linkedCount + ' link' + (linkedCount === 1 ? '' : 's') + ' wired)' : '') +
						_mergeNote + _unchangedNote + _fkNote + _ambiguousNote + '.';
					if (_undoImport && showBulkToastWithAction) {
						if (typeof _undoImport.arm === 'function') {
							_undoImport.arm();
						}
						showBulkToastWithAction(_toastMsg, 'Undo', _undoImport);
					} else {
						showBulkToast(_toastMsg);
					}
					pingAuditEvent('csv_import', {
						recordCount: totalRecords,
						payload: {
							mode: 'linked',
							fileCount,
							linksWired: linkedCount,
							linksSkippedFk,
							linksSkippedAmbiguous,
							merged: mergeQueue.length,
							unchanged: unchangedCount,
							// Fields the user accepted as silently-dropped
							// via the warn-and-confirm modal earlier in
							// linkedCsvConfirm. [] when all mapped fields
							// were writable.
							strippedFields: strippedFieldsSummary,
						},
					});
					// Walk canvas-collisions through the Diff modal in merge mode
					// (existing card vs the CSV's incoming values), sequentially -
					// each modal's onClose opens the next.
					if (mergeQueue.length && openRecordDiffModal) {
						let qi = 0;
						const nextMerge = () => {
							if (qi >= mergeQueue.length) {
								return;
							}
							const item = mergeQueue[qi++];
							const importedRec = {
								id: -1 - qi, // synthetic, off-canvas id
								objectName: item.existing.objectName,
								label: item.label || item.existing.label,
								values: item.values,
							};
							openRecordDiffModal(item.existing, importedRec, {
								incoming: true,
								labelB: 'Imported row ' + qi + ' of ' + mergeQueue.length,
								onClose: nextMerge,
							});
						};
						nextMerge();
					}
				}

			function restoreInterruptedQuickUpload() {
				let snapshot;
				try {
					const raw = sessionStorage.getItem(_QU_RESTORE_KEY);
					if (!raw) {
return false;
}
					snapshot = JSON.parse(raw);
					sessionStorage.removeItem(_QU_RESTORE_KEY);
				} catch (e) {
					try {
 sessionStorage.removeItem(_QU_RESTORE_KEY); 
} catch (_e) {}
					return false;
				}
				if (!snapshot || snapshot.version !== 1 ||
					(snapshot.sfOrgId && window.SF_ORG_ID && snapshot.sfOrgId !== window.SF_ORG_ID)) {
					return false;
				}
				canvasState.bulkRecords = Array.isArray(snapshot.records) ? snapshot.records : [];
				canvasState.bulkAssociations = Array.isArray(snapshot.associations) ? snapshot.associations : [];
				canvasState.selectedObjects = Array.isArray(snapshot.selectedObjects) ? snapshot.selectedObjects : [];
				canvasState.bulkSelectedIds = new Set(Array.isArray(snapshot.selectedIds) ? snapshot.selectedIds : []);
				if (Number.isFinite(snapshot.bulkIdSeq)) {
canvasState.bulkIdSeq = snapshot.bulkIdSeq;
}
				canvasState.currentCanvas = snapshot.currentCanvas || null;
				_linkedCsvQuickUploadMode = false;
				getGraph().classList.remove('csv-direct-upload-active');
				if (snapshot.viewport) {
					setTimeout(() => {
						const cy = getCyInstance();
						if (!cy) {
return;
}
						if (Number.isFinite(snapshot.viewport.zoom)) {
cy.zoom(snapshot.viewport.zoom);
}
						if (snapshot.viewport.pan) {
cy.pan(snapshot.viewport.pan);
}
					}, 0);
				}
				return true;
			}

			return {
				openModal: openLinkedCsvModal,
				closeModal: closeLinkedCsvModal,
				// confirmUpload (still in app.js) reads this flag at
				// upload-payload time to set directUpload=true so the
				// server skips the monthly cap. The flag survives across
				// closeLinkedCsvModal (intentionally) until the next
				// openLinkedCsvModal resets it from opts.quickUpload.
				isQuickUploadMode: function () {
 return _linkedCsvQuickUploadMode; 
},
				restoreInterruptedQuickUpload: restoreInterruptedQuickUpload,
			};
		},
	};
})();
