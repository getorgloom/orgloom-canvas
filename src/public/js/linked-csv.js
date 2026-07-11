(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	const _DIRECT_CSV_VALIDATED_CAP = 5000;

	window.OrgLoom.linkedCsv = {
		mount: function mount(deps) {
			if (!deps || !deps.canvasState || !deps.showBulkToast || !deps.escapeHtml
				|| !deps.ensureDescribe || !deps.csrfFetch || !deps.renderBulkView
				|| !deps.getGraph || !deps.parseCsv || !deps.csvGuessObjectFromFilename
				|| !deps.csvAutoMapHeaders || !deps.csvNormalizeKey
				|| !deps.pingAuditEvent || !deps.addToSelection
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

			const openRecordDiffModal = typeof deps.openRecordDiffModal === 'function'
				? deps.openRecordDiffModal
				: null;

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

				let linkedCsvState = null;

				let _linkedCsvQuickUploadMode = false;

				function openLinkedCsvModal(opts) {
					opts = opts || {};
					_linkedCsvQuickUploadMode = !!opts.quickUpload;

					const footer = linkedCsvModal.querySelector('.modal-footer');
					if (_linkedCsvQuickUploadMode) {
						footer.innerHTML =
							'<button class="button" id="linked-csv-upload" disabled title="Push these rows to Salesforce. No cap on this path — direct CSV uploads are unlimited on every plan.">Upload to Salesforce</button>';
						footer.querySelector('#linked-csv-upload').onclick = () => linkedCsvConfirm({ uploadDirectly: true });
					} else {
						footer.innerHTML =
							'<button class="button secondary" id="linked-csv-replace" disabled title="Drop everything currently on the canvas, then load this file onto a fresh canvas.">Replace canvas</button>' +
							'<button class="button" id="linked-csv-confirm" disabled title="Load records onto the canvas alongside what is already there. Use Upload from the canvas toolbar to push them to Salesforce.">Add to canvas</button>';
						footer.querySelector('#linked-csv-replace').onclick = () => linkedCsvConfirm({ uploadDirectly: false, replaceCanvas: true });
						footer.querySelector('#linked-csv-confirm').onclick = () => linkedCsvConfirm({ uploadDirectly: false });
					}

					const header = linkedCsvModal.querySelector('.modal-header h3');
					if (header) {
header.textContent = _linkedCsvQuickUploadMode ? 'Quick Upload — Import from CSV' : 'Import from CSV';
}

					linkedCsvState = { files: [], links: null, notices: [] };
					linkedCsvModal.classList.remove('hidden');
					linkedCsvRender();

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

					if (!opts || !opts.keepQuickUploadMode) {
						_linkedCsvQuickUploadMode = false;
					}
				}

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

				function scoreLink(fromFile, fromColumnIdx, toFile, fromValuesSet, excludeColumnIdx) {
					let best = null;
					for (let i = 0; i < toFile.headers.length; i++) {

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
					const links = [];
					state.files.forEach((file, fromIdx) => {
						if (!file.objectName || !file.describe) {
return;
}

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

							const allSfIds = Array.from(fromValues).every((v) => /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(v));
							if (allSfIds) {
return;
}

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
								break;
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

					state.notices = [];
					const _shared = window.OrgLoom.importShared;
					const _CSV_GATE = {
						extRe: /\.csv$/i,
						extLabel: '.csv',
						maxBytes: 50 * 1024 * 1024,
						flowLabel: 'Import from CSV',
					};
					Promise.all(files.map((f) => new Promise((resolve) => {

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
							resolve({
								name: f.name,
								headers: parsed.headers,
								rows: parsed.rows,

								raggedRows: parsed.rows.filter((r) => r.length !== parsed.headers.length).length,
								objectName: null,
								describe: null,
								mapping: {},
							});
						};
						reader.readAsText(f);
					}))).then(async (parsedFiles) => {
						const valid = parsedFiles.filter((f) => f && !f.__rejected); const rejected = parsedFiles.filter((f) => f && f.__rejected);

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
									? 'Two or more files share the name ' + list + ' — suffixed "(2)" etc. in the file list for clarity. Rename if you want a clearer distinction.'
									: 'Multiple files share names (' + list + ') — suffixed "(2)" etc. in the file list. Rename if you want clearer labels.',
							});
						}

						const _ragged = valid.filter((f) => f.raggedRows > 0);
						if (_ragged.length > 0) {
							const list = _ragged.map((f) => '"' + f.name + '" (' + f.raggedRows + ' row' + (f.raggedRows === 1 ? '' : 's') + ')').join(', ');
							state.notices.push({
								kind: 'warn',
								text: 'Some rows have a different column count than the header: ' + list + '. Check for unquoted commas or missing fields — those rows may map to the wrong fields.',
							});
						}

						if (rejected.length > 0) {

							const _sized = rejected.filter((f) => f.reason === 'toolarge');
							_sized.forEach((f) => state.notices.push({ kind: 'error', text: f.gateMsg }));
							const _rest = rejected.filter((f) => f.reason !== 'toolarge');
							if (_rest.length > 0) {
								const _rn = _rest.map((f) => '"' + f.name + '"').join(', ');
								const _allWrongType = _rest.every((f) => f.reason === 'wrongtype');
								const _allNoRows = _rest.every((f) => f.reason === 'norows');
								let _msg;
								if (_allWrongType) {
									_msg = _rest.length === 1
										? _rn + " isn't a CSV file — Import from CSV only accepts .csv files."
										: 'These are not CSV files and were skipped: ' + _rn + ' — Import from CSV only accepts .csv files.';
								} else if (_allNoRows) {
									_msg = _rest.length === 1
										? _rn + ' has no data rows — nothing to import.'
										: 'These files have no data rows: ' + _rn + '.';
								} else {
									_msg = _rest.length === 1
										? _rn + " couldn't be read as a CSV and was skipped — drop a .csv file with a header row."
										: _rest.length + " files couldn't be read as CSV and were skipped: " + _rn + '.';
								}
								state.notices.push({ kind: 'error', text: _msg });
							}

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

				function linkedCsvUpdateOperation(fileIdx, operation) {
					const state = linkedCsvState;
					if (!state || !state.files[fileIdx]) {
return;
}
					const file = state.files[fileIdx];
					file.operation = operation;
					if (operation === 'upsert') {
						const eligible = (file.describe && Array.isArray(file.describe.fields))
							? file.describe.fields.filter((f) => f && f.externalId && f.createable)
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
							const opts = '<option value="">\u2014 Pick object \u2014</option>' +
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

							let permWarn = '';
							if (file.objectName && file.describe) {
								const hasIdCol = Object.values(file.mapping || {}).some((f) => f === 'Id');
								if (hasIdCol && file.describe.updateable === false) {
									permWarn = '<div class="lcsv-perm-warn">⚠ Your Salesforce user can read ' + escapeHtml(file.objectName) + ' but can’t update its records — this upload will fail. Ask your admin for Edit access.</div>';
								} else if (!hasIdCol && file.describe.createable === false) {
									permWarn = '<div class="lcsv-perm-warn">⚠ Your Salesforce user can read ' + escapeHtml(file.objectName) + ' but can’t create new records — this upload will fail. Ask your admin for Create access on ' + escapeHtml(file.objectName) + '.</div>';
								}
							}

							let columnsHtml = '';
							if (file.objectName && file.describe && Array.isArray(file.describe.fields)) {
								const fieldOpts = file.describe.fields
									.filter((f) => f.createable)
									.slice()
									.sort((a, b) => String(a.label || a.name).localeCompare(String(b.label || b.name)));

								if (file.describe.updateable !== false) {
									fieldOpts.unshift({
										name: 'Id',
										label: 'Salesforce Id — match & UPDATE existing record',
									});
								}
								const rows = file.headers.map((h, ci) => {
									const current = file.mapping[ci] || '';
									const opts = '<option value="">\u2014 Skip \u2014</option>' +
										fieldOpts.map((f) =>
											'<option value="' + escapeHtml(f.name) + '"' + (f.name === current ? ' selected' : '') + '>' +
												escapeHtml(f.label || f.name) + ' (' + escapeHtml(f.name) + ')' +
												((f.type === 'reference' && Array.isArray(f.referenceTo) && f.referenceTo.length > 0) ? ' \u2192 ' + escapeHtml(f.referenceTo.join('/')) : '') +
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

							const eligibleExtIdFields = (file.describe && Array.isArray(file.describe.fields))
								? file.describe.fields.filter((f) => f && f.externalId && f.createable)
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
							const colOpts = '<option value="">\u2014 Don\u2019t link \u2014</option>' +
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

					const _validForSummary = state.files.filter((f) => f.objectName && Object.values(f.mapping).filter(Boolean).length > 0);
					const _totalRowsForSummary = _validForSummary.reduce((n, f) => n + f.rows.length, 0);
					const _linkedCountForSummary = (state.links || []).length;
					const _isMultiOrLinkedForSummary = _validForSummary.length > 1 || _linkedCountForSummary > 0;

					const _bulkBannerForSummary = !_isMultiOrLinkedForSummary
						&& _totalRowsForSummary > _DIRECT_CSV_VALIDATED_CAP;
					const _filesSummary = _validForSummary.length > 0
						? _totalRowsForSummary + ' record' + (_totalRowsForSummary === 1 ? '' : 's') + ' from ' + _validForSummary.length + ' file' + (_validForSummary.length === 1 ? '' : 's') + ' ready'
						: 'map at least one file';

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
										'<strong>Large upload — atomicity not guaranteed.</strong> ' +
										_totalRowsForSummary.toLocaleString() + ' rows is past the ' + _DIRECT_CSV_VALIDATED_CAP.toLocaleString() + '-row pre-flight limit, so ' +
										'<em>Upload to Salesforce</em> will run via the Bulk API v2. Records commit independently — some may succeed while others fail, and there is no all-or-nothing rollback. Per-row failures are reported when the upload finishes.' +
									'</div>'
									: '') +
								'<div class="lcsv-files">' + filesHtml + '</div>' +
							'</div>'
							: '') +

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

					const replaceBtn = linkedCsvModal.querySelector('#linked-csv-replace');
					const confirmBtn = linkedCsvModal.querySelector('#linked-csv-confirm');
					const uploadBtn = linkedCsvModal.querySelector('#linked-csv-upload');
					const ready = _validForSummary.length > 0;
					if (confirmBtn) {
confirmBtn.disabled = !ready;
}
					if (replaceBtn) {
replaceBtn.disabled = !ready;
}
					if (uploadBtn) {
uploadBtn.disabled = !ready;
}

					if (uploadBtn && ready) {
						const linkedCount = (state.links || []).length;
						const isMultiOrLinked = _validForSummary.length > 1 || linkedCount > 0;
						const overValidatedCap = isMultiOrLinked && _totalRowsForSummary > _DIRECT_CSV_VALIDATED_CAP;
						if (overValidatedCap) {
							uploadBtn.disabled = true;
							uploadBtn.title = 'Multi-file or linked uploads are capped at ' + _DIRECT_CSV_VALIDATED_CAP.toLocaleString() + ' rows. Split this batch or remove FK linking.';
						} else if (_bulkBannerForSummary) {
							uploadBtn.title = 'Large single-file upload — runs via Bulk API v2. Per-record success/failure; no pre-flight check, no atomic rollback.';
						} else {
							uploadBtn.title = isMultiOrLinked
								? 'Multi-file / linked upload. Records will be validated and committed together via the Composite Graph API (atomic per connected component).'
								: 'Bulk upload via Salesforce Bulk API. Per-record success/failure; no pre-flight check.';
						}
					}
				}

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
						} catch (e) {                                                       }
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
									'Pick which to add as new draft records — unchecked rows are skipped. ' +
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
					const validFiles = state.files.filter((f) => f.objectName && Object.values(f.mapping).filter(Boolean).length > 0);
					if (validFiles.length === 0) {
return;
}

					const unwritable = _detectUnwritableMappedFields(validFiles);

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
						lines.push('If you continue, these columns will be silently dropped — the records will be created with those fields empty.');
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

					if (skipCanvas) {
						const linkedCount = (state.links || []).length;
						const totalRows = validFiles.reduce((n, f) => n + f.rows.length, 0);
						const isMultiOrLinked = validFiles.length > 1 || linkedCount > 0;
						if (isMultiOrLinked && totalRows > _DIRECT_CSV_VALIDATED_CAP) {
							showBulkToast('Multi-file or linked uploads are capped at ' + _DIRECT_CSV_VALIDATED_CAP.toLocaleString() + ' rows. Split this batch or remove the FK linking.', 'error');
							return;
						}
					}

					const shouldReplace = !!opts.replaceCanvas;
					const canvas = getGraph().querySelector('#bulk-canvas');
					const W = canvas ? canvas.clientWidth : 1200;
					const startX = 80;
					const startY = 80;
					const stepX = 220;
					const stepY = 180;
					const perRow = Math.max(1, Math.floor((W - startX) / stepX));

					const _preImportSelectedObjects = canvasState.selectedObjects.slice();

					const cellKey = (fi, ri) => fi + '|' + ri;
					const _idResolution = await csvResolveExistingIds(validFiles, state, cellKey);
					if (_idResolution.canceled) {
return;
}

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
									return;
								}
								if (sfId && !_idResolution.liveById.has(sfId.slice(0, 15))
									&& !_idResolution.draftKeys.has(cellKey(fromFileIdx, rowIdx))) {
									return;
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

					const _undoImport = (!skipCanvas && captureUndoSnapshot)
						? captureUndoSnapshot()
						: null;

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

					if (shouldReplace) {
						canvasState.bulkRecords = [];
						canvasState.bulkAssociations = [];
						canvasState.currentCanvas = null;
						if (window.Orgloom && window.Orgloom.canvasState && window.Orgloom.canvasState.clearDraft) {
							window.Orgloom.canvasState.clearDraft();
						}
					} else {

						clearEmptyStarterCard();
					}

					let slot = canvasState.bulkRecords.length;

					const tempIdByCell = new Map();
					const newRecIds = new Set();
					validFiles.forEach((file, vfi) => {
						const fromFileIdx = state.files.indexOf(file);
						const sel = selByName.get(file.objectName);
						if (!sel) {
return;
}
						const mappedIdxs = Object.keys(file.mapping).filter((i) => file.mapping[i]);

						const idColIdxStr = mappedIdxs.find((iStr) => file.mapping[Number(iStr)] === 'Id');
						const idColIdx = idColIdxStr != null ? Number(idColIdxStr) : null;
						file.rows.forEach((row, rowIdx) => {
							const values = {};
							mappedIdxs.forEach((iStr) => {
								const i = Number(iStr);
								const field = file.mapping[i];

								const isLinkedFk = (state.links || []).some((l) =>
									l.fromFileIdx === fromFileIdx && l.fromColumnIdx === i);
								if (isLinkedFk) {
return;
}

								if (i === idColIdx) {
return;
}
								const v = row[i];
								if (v !== undefined && v !== '') {
values[field] = v;
}
							});

							const rawId = idColIdx != null ? row[idColIdx] : null;
							const sfId = (rawId != null && String(rawId).trim() !== '')
								? String(rawId).trim()
								: null;

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

								const _live = _idResolution.liveById.get(sfId.slice(0, 15));
								if (_live) {
									rec.loadedFromId = sfId;
									rec.loadedValues = Object.assign({}, _live);
									rec.values = Object.assign({}, _live, rec.values);
								} else if (!_idResolution.draftKeys.has(cellKey(fromFileIdx, rowIdx))) {

									slot--;
									return;
								}

							}

							if (file.operation === 'upsert' && file.externalIdFieldName) {
								rec._csvOperation = 'upsert';
								rec._csvExternalIdField = file.externalIdFieldName;
							}
							canvasState.bulkRecords.push(rec);
							newRecIds.add(id);
							tempIdByCell.set(cellKey(fromFileIdx, rowIdx), id);
						});
					});

					let linkedCount = 0;
					let linksSkippedFk = 0;
					const newAssocIds = new Set();

					const _admitAssociation = window.OrgLoom.importShared.admitAssociation;
					const _usedFk = new Set();
					canvasState.bulkAssociations.forEach((a) => {
						_usedFk.add(a.fromId + '::' + a.fieldName);
					});
					(state.links || []).forEach((link) => {
						const fromFile = state.files[link.fromFileIdx];
						const toFile = state.files[link.toFileIdx];
						if (!fromFile || !toFile || link.toColumnIdx == null) {
return;
}

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

					closeLinkedCsvModal({ keepQuickUploadMode: true });
					if (skipCanvas) {

						const _snapRecs = canvasState.bulkRecords.filter((r) => !newRecIds.has(r.id));
						const _snapAssocs = canvasState.bulkAssociations.filter((a) => !newAssocIds.has(a.id));
						const _snapSelectedObjects = _preImportSelectedObjects;
						canvasState.bulkRecords = canvasState.bulkRecords.filter((r) => newRecIds.has(r.id));
						canvasState.bulkAssociations = canvasState.bulkAssociations.filter((a) => newAssocIds.has(a.id));

						getGraph().classList.add('csv-direct-upload-active');
						setPendingUploadCleanup(() => {

							canvasState.bulkRecords = _snapRecs;
							canvasState.bulkAssociations = _snapAssocs;
							canvasState.selectedObjects = _snapSelectedObjects;
							getGraph().classList.remove('csv-direct-upload-active');

							_linkedCsvQuickUploadMode = false;
							renderBulkView();
						});

						setPendingCsvImportMeta({
							mode: 'linked-direct-upload',
							recordCount: totalRecords,
							fileCount,
							linksWired: linkedCount,

							strippedFields: strippedFieldsSummary,
						});
						setTimeout(() => openUploadModal(), 0);
						return;
					}

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
							(mergeQueue.length > 0 ? ' — review the merge' : ' — skipped')
						: '';
					const _unchangedNote = unchangedCount > 0
						? ' · ' + unchangedCount + ' already on the canvas, unchanged'
						: '';
					const _fkNote = linksSkippedFk > 0
						? ' · ' + linksSkippedFk + ' link' + (linksSkippedFk === 1 ? '' : 's') + ' skipped (lookup already set)'
						: '';
					const _toastMsg =
						'Imported ' + totalRecords + ' record' + (totalRecords === 1 ? '' : 's') +
						' from ' + fileCount + ' file' + (fileCount === 1 ? '' : 's') +
						(linkedCount > 0 ? ' (' + linkedCount + ' link' + (linkedCount === 1 ? '' : 's') + ' wired)' : '') +
						_mergeNote + _unchangedNote + _fkNote + '.';
					if (_undoImport && showBulkToastWithAction) {
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
							merged: mergeQueue.length,
							unchanged: unchangedCount,

							strippedFields: strippedFieldsSummary,
						},
					});

					if (mergeQueue.length && openRecordDiffModal) {
						let qi = 0;
						const nextMerge = () => {
							if (qi >= mergeQueue.length) {
								return;
							}
							const item = mergeQueue[qi++];
							const importedRec = {
								id: -1 - qi,
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

			return {
				openModal: openLinkedCsvModal,
				closeModal: closeLinkedCsvModal,

				isQuickUploadMode: function () {
 return _linkedCsvQuickUploadMode; 
},
			};
		},
	};
})();
