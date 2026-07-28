(function () {
	'use strict';
	// Imports related CSV files while preserving row identity and cross-file lookup intent.

	window.OrgLoom = window.OrgLoom || {};

	const _DIRECT_CSV_VALIDATED_CAP = 5000;
	// Session storage supports crash recovery without making Salesforce data durable on-device.
	const _QU_RESTORE_KEY = 'orgloom:quick-upload:restore:v1';

	function csvFieldDisposition(field, operation) {
		if (!field) {
			return 'write';
		}
		if (field.type === 'address' || field.type === 'location' || field.calculated || field.autoNumber) {
			return 'context';
		}
		if (operation === 'update') {
			return field.updateable ? 'write' : 'context';
		}
		if (operation === 'upsert') {
			return field.createable || field.updateable ? 'write' : 'warn';
		}
		return field.createable ? 'write' : 'warn';
	}

	function csvRowOperation(file, sfId, idResolution) {
		if (file && file.operation === 'upsert') {
			return 'upsert';
		}
		if (sfId && idResolution && idResolution.liveById.has(String(sfId).slice(0, 15))) {
			return 'update';
		}
		return 'create';
	}

	function csvFieldAccessSuffix(field) {
		if (!field || field.name === 'Id') {
			return '';
		}
		const canCreate = field.createable === true;
		const canUpdate = field.updateable === true;
		if (canCreate && canUpdate) {
			return '';
		}
		if (!canCreate && !canUpdate) {
			return ' - read only';
		}
		return canCreate ? ' - new records only' : ' - existing records only';
	}

	function linkedCsvReady(state) {
		if (!state || state.processingFiles || state.hasRejectedFileErrors) {
			return false;
		}
		return (
			state.files.some(
				(file) =>
					file &&
					file.objectName &&
					Array.isArray(file.headers) &&
					file.headers.length > 0 &&
					Array.isArray(file.rows) &&
					file.rows.length > 0 &&
					Object.values(file.mapping || {}).some(Boolean),
			) &&
			!state.files.some((file) => file && Array.isArray(file.blockingErrors) && file.blockingErrors.length > 0)
		);
	}

	window.OrgLoom.linkedCsv = {
		_test: { csvFieldDisposition, csvRowOperation, csvFieldAccessSuffix, linkedCsvReady },
		mount: function mount(deps) {
			if (
				!deps ||
				!deps.canvasState ||
				!deps.showBulkToast ||
				!deps.escapeHtml ||
				!deps.ensureDescribe ||
				!deps.csrfFetch ||
				!deps.renderBulkView ||
				!deps.getGraph ||
				!deps.parseCsv ||
				!deps.csvGuessObjectFromFilename ||
				!deps.csvAutoMapHeaders ||
				!deps.csvNormalizeKey ||
				!deps.pingAuditEvent ||
				!deps.addToSelection ||
				!deps.showConfirmDialog ||
				!deps.showPromptModal ||
				!deps.showReplaceOrMergeDialog ||
				!deps.canvasCapBlockReason ||
				!deps.openUploadModal ||
				!deps.setPendingUploadCleanup ||
				!deps.setPendingCsvImportMeta ||
				!deps.allObjectsReady ||
				!deps.getCyInstance ||
				!deps.setSkipNextCyAutoPan ||
				!deps.relayoutNewRecords ||
				!deps.clearEmptyStarterCard
			) {
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
			const openRecordDiffModal =
				typeof deps.openRecordDiffModal === 'function' ? deps.openRecordDiffModal : null;
			const canvasCapCheck = typeof deps.canvasCapCheck === 'function' ? deps.canvasCapCheck : null;
			const captureUndoSnapshot =
				typeof deps.captureUndoSnapshot === 'function' ? deps.captureUndoSnapshot : null;
			const showBulkToastWithAction =
				typeof deps.showBulkToastWithAction === 'function' ? deps.showBulkToastWithAction : null;

			const linkedCsvModal = document.createElement('div');
			linkedCsvModal.id = 'linked-csv-modal';
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
			linkedCsvModal
				.querySelectorAll('[data-lcsv-close]')
				.forEach((el) => el.addEventListener('click', closeLinkedCsvModal));
			document.addEventListener('keydown', (e) => {
				if (e.key === 'Escape' && !linkedCsvModal.classList.contains('hidden')) {
					closeLinkedCsvModal();
				}
			});
			let linkedCsvState = null;
			let _linkedCsvQuickUploadMode = false;

			function openLinkedCsvModal(opts) {
				opts = opts || {};
				if (opts.quickUpload && _linkedCsvQuickUploadMode) {
					showBulkToast(
						'A Quick Upload is already in progress. Finish or cancel it before starting another.',
						'warn',
					);
					return;
				}
				_linkedCsvQuickUploadMode = !!opts.quickUpload;
				const footer = linkedCsvModal.querySelector('.modal-footer');
				if (_linkedCsvQuickUploadMode) {
					footer.innerHTML =
						'<button class="button" id="linked-csv-upload" disabled title="Push these rows to Salesforce. No cap on this path - direct CSV uploads are unlimited on every plan.">Upload to Salesforce</button>';
					footer.querySelector('#linked-csv-upload').onclick = () =>
						startLinkedCsvConfirm({ uploadDirectly: true });
				} else {
					footer.innerHTML =
						'<button class="button secondary" id="linked-csv-replace" disabled title="Drop everything currently on the canvas, then load this file onto a fresh canvas.">Replace canvas</button>' +
						'<button class="button" id="linked-csv-confirm" disabled title="Load records onto the canvas alongside what is already there. Use Upload from the canvas toolbar to push them to Salesforce.">Add to canvas</button>';
					footer.querySelector('#linked-csv-replace').onclick = () =>
						linkedCsvConfirm({ uploadDirectly: false, replaceCanvas: true });
					footer.querySelector('#linked-csv-confirm').onclick = () =>
						linkedCsvConfirm({ uploadDirectly: false });
				}
				const header = linkedCsvModal.querySelector('.modal-header h3');
				if (header) {
					header.textContent = _linkedCsvQuickUploadMode
						? 'Quick Upload: Import from CSV'
						: 'Import from CSV';
				}

				linkedCsvState = {
					files: [],
					links: null,
					notices: [],
					processingFiles: false,
					hasRejectedFileErrors: false,
					preparingUpload: false,
				};
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
				if (linkedCsvState && linkedCsvState.preparingUpload && !(opts && opts.allowWhilePreparing)) {
					return;
				}
				linkedCsvModal.classList.add('hidden');
				linkedCsvModal.classList.remove('lcsv-is-preparing');
				linkedCsvModal.querySelector('.modal-body').removeAttribute('aria-busy');
				linkedCsvState = null;
				if (!opts || !opts.keepQuickUploadMode) {
					_linkedCsvQuickUploadMode = false;
				}
			}

			function setQuickUploadPreparing(state, preparing) {
				if (!state || linkedCsvState !== state) {
					return;
				}
				state.preparingUpload = preparing;
				linkedCsvModal.classList.toggle('lcsv-is-preparing', preparing);
				const modalBody = linkedCsvModal.querySelector('.modal-body');
				if (preparing) {
					modalBody.setAttribute('aria-busy', 'true');
				} else {
					modalBody.removeAttribute('aria-busy');
				}
				const uploadBtn = linkedCsvModal.querySelector('#linked-csv-upload');
				if (uploadBtn) {
					uploadBtn.disabled = preparing || !linkedCsvReady(state);
					uploadBtn.setAttribute('aria-busy', preparing ? 'true' : 'false');
					uploadBtn.innerHTML = preparing
						? '<span class="busy-spinner" aria-hidden="true"></span> Preparing upload&hellip;'
						: 'Upload to Salesforce';
				}
			}

			async function startLinkedCsvConfirm(opts) {
				const state = linkedCsvState;
				if (!state || state.preparingUpload) {
					return;
				}
				setQuickUploadPreparing(state, true);
				// Let the busy state paint before CSV planning and Salesforce checks begin.
				await new Promise((resolve) => requestAnimationFrame(resolve));
				try {
					await linkedCsvConfirm(opts);
				} finally {
					setQuickUploadPreparing(state, false);
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
				candidates.sort((a, b) => b.hits - a.hits || a.total - b.total);
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
					const sourceKey = csvNormalizeKey(fromHeader);
					if (tk === 'id' || tk === 'name') {
						bonus += 1;
					}
					if (sourceKey.endsWith('id') && tk === sourceKey.slice(0, -2)) {
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
					const lookupFields = file.describe.fields.filter(
						(f) => f.type === 'reference' && Array.isArray(f.referenceTo) && f.referenceTo.length > 0,
					);
					const lookupByName = new Map(lookupFields.map((f) => [f.name, f]));
					Object.keys(file.mapping).forEach((idxStr) => {
						const fieldName = file.mapping[idxStr];
						if (!fieldName) {
							return;
						}
						const lookupField = lookupByName.get(fieldName);
						if (!lookupField) {
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
						const allSfIds = Array.from(fromValues).every((v) =>
							/^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(v),
						);
						if (allSfIds) {
							return;
						}
						for (let toIdx = 0; toIdx < state.files.length; toIdx++) {
							const toFile = state.files[toIdx];
							if (!toFile.objectName) {
								continue;
							}
							if (!lookupField.referenceTo.includes(toFile.objectName)) {
								continue;
							}
							const isSelfRef = toIdx === fromIdx;
							const best = scoreLink(
								file,
								fromColumnIdx,
								toFile,
								fromValues,
								isSelfRef ? fromColumnIdx : -1,
							);
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
				state.notices = [];
				state.processingFiles = true;
				state.hasRejectedFileErrors = false;
				linkedCsvRender();
				const _shared = window.OrgLoom.importShared;
				const _CSV_GATE = {
					extRe: /\.csv$/i,
					extLabel: '.csv',
					maxBytes: 50 * 1024 * 1024,
					flowLabel: 'Import from CSV',
				};
				Promise.all(
					files.map(
						(f) =>
							new Promise((resolve) => {
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
								reader.onerror = () =>
									resolve({ __rejected: true, name: f.name, reason: 'unreadable' });
								reader.onload = () => {
									if (String(reader.result || '').trim() === '') {
										resolve({ __rejected: true, name: f.name, reason: 'norows' });
										return;
									}
									let parsed;
									try {
										parsed = parseCsv(String(reader.result || ''));
									} catch (e) {
										resolve({ __rejected: true, name: f.name, reason: 'unreadable' });
										return;
									}
									if (String(reader.result || '').indexOf(String.fromCharCode(0)) !== -1) {
										resolve({ __rejected: true, name: f.name, reason: 'notcsv' });
										return;
									}
									if (!parsed.headers.length) {
										resolve({ __rejected: true, name: f.name, reason: 'notcsv' });
										return;
									}
									if (!parsed.rows.length) {
										resolve({ __rejected: true, name: f.name, reason: 'norows' });
										return;
									}
									const raggedRows = parsed.rows.filter(
										(r) => r.length !== parsed.headers.length,
									).length;
									const blankDataHeaders = parsed.headers.reduce((out, header, idx) => {
										if (
											!header &&
											parsed.rows.some((row) => String(row[idx] || '').trim() !== '')
										) {
											out.push(idx + 1);
										}
										return out;
									}, []);
									const blockingErrors = (parsed.errors || []).slice();
									if (raggedRows > 0) {
										blockingErrors.push(
											raggedRows +
												' row' +
												(raggedRows === 1 ? ' has' : 's have') +
												' a different column count than the header.',
										);
									}
									if (blankDataHeaders.length > 0) {
										blockingErrors.push(
											'Data appears under blank header column' +
												(blankDataHeaders.length === 1 ? '' : 's') +
												' ' +
												blankDataHeaders.join(', ') +
												'.',
										);
									}
									if (blockingErrors.length > 0) {
										resolve({
											__rejected: true,
											name: f.name,
											reason: 'structure',
											blockingErrors,
										});
										return;
									}
									resolve({
										name: f.name,
										headers: parsed.headers,
										rows: parsed.rows,
										raggedRows,
										blockingErrors,
										objectName: null,
										describe: null,
										mapping: {},
									});
								};
								reader.readAsText(f);
							}),
					),
				).then(async (parsedFiles) => {
					state.processingFiles = false;
					const valid = parsedFiles.filter((f) => f && !f.__rejected);
					const rejected = parsedFiles.filter((f) => f && f.__rejected);
					const structural = rejected.filter((f) => f.reason === 'structure');
					state.hasRejectedFileErrors = rejected.length > 0;
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
							text:
								_newlyDuplicated.length === 1
									? 'Two or more files share the name ' +
										list +
										' - suffixed "(2)" etc. in the file list for clarity. Rename if you want a clearer distinction.'
									: 'Multiple files share names (' +
										list +
										') - suffixed "(2)" etc. in the file list. Rename if you want clearer labels.',
						});
					}
					if (structural.length > 0) {
						const list = structural.map((f) => '"' + f.name + '": ' + f.blockingErrors.join(' ')).join(' ');
						state.notices.push({
							kind: 'error',
							text:
								'Import blocked because the CSV structure is unsafe. ' +
								list +
								' Fix the file and try again; no rows were imported.',
						});
					}
					if (rejected.length > 0) {
						const _sized = rejected.filter((f) => f.reason === 'toolarge');
						_sized.forEach((f) => state.notices.push({ kind: 'error', text: f.gateMsg }));
						const _rest = rejected.filter((f) => f.reason !== 'toolarge' && f.reason !== 'structure');
						_rest.forEach((f) => {
							const name = '"' + f.name + '"';
							const text =
								f.reason === 'wrongtype'
									? name + " isn't a CSV file - Import from CSV only accepts .csv files."
									: f.reason === 'norows'
										? name + ' has no data rows - nothing to import.'
										: name +
											" couldn't be read as a CSV and was skipped - drop a .csv file with a header row.";
							state.notices.push({ kind: 'error', text });
						});
						rejected.forEach((f) =>
							_shared.captureImportFailure(
								'csv',
								f.reason === 'wrongtype' ? 'type' : f.reason === 'toolarge' ? 'size' : f.reason,
								null,
							),
						);
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
						file.describe = null;
						file.mapping = {};
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
					// External-ID upserts require a writable, filterable field that is present in the CSV.
					const eligible =
						file.describe && Array.isArray(file.describe.fields)
							? file.describe.fields.filter(
									(f) => f && f.externalId && f.filterable === true && f.createable,
								)
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
					labels.push(c === 1 ? n : n + ' (' + c + ')');
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
				const filesHtml =
					state.files.length === 0
						? '<p class="tag center">Drop CSVs above or click to choose.</p>'
						: state.files
								.map((file, i) => {
									const opts =
										'<option value=""> - Pick object - </option>' +
										allObjOptions
											.map(
												(o) =>
													'<option value="' +
													escapeHtml(o.name) +
													'"' +
													(o.name === file.objectName ? ' selected' : '') +
													'>' +
													escapeHtml(o.label) +
													' (' +
													escapeHtml(o.name) +
													')' +
													'</option>',
											)
											.join('');
									const mappedCount = Object.values(file.mapping).filter(Boolean).length;
									const unmappedCount = file.headers.length - mappedCount;
									const meta = file.objectName
										? '<span class="tag' +
											(unmappedCount > 0 ? ' warn' : '') +
											'">' +
											mappedCount +
											' / ' +
											file.headers.length +
											' columns mapped</span>'
										: '<span class="tag warn">Pick an object</span>';
									let permWarn = '';
									if (file.objectName && file.describe) {
										const hasIdCol = Object.values(file.mapping || {}).some((f) => f === 'Id');
										if (hasIdCol && file.describe.updateable === false) {
											permWarn =
												'<div class="lcsv-perm-warn">⚠ Your Salesforce user can read ' +
												escapeHtml(file.objectName) +
												' but can’t update its records - this upload will fail. Ask your admin for Edit access.</div>';
										} else if (!hasIdCol && file.describe.createable === false) {
											permWarn =
												'<div class="lcsv-perm-warn">⚠ Your Salesforce user can read ' +
												escapeHtml(file.objectName) +
												' but can’t create new records - this upload will fail. Ask your admin for Create access on ' +
												escapeHtml(file.objectName) +
												'.</div>';
										}
									}
									let columnsHtml = '';
									if (file.objectName && file.describe && Array.isArray(file.describe.fields)) {
										const fieldOpts = file.describe.fields
											.slice()
											.sort((a, b) =>
												String(a.label || a.name).localeCompare(String(b.label || b.name)),
											);
										if (file.describe.updateable !== false) {
											fieldOpts.unshift({
												name: 'Id',
												label: 'Salesforce Id - match & UPDATE existing record',
											});
										}
										const rows = file.headers
											.map((h, ci) => {
												const current = file.mapping[ci] || '';
												const opts =
													'<option value=""> - Skip - </option>' +
													fieldOpts
														.map(
															(f) =>
																'<option value="' +
																escapeHtml(f.name) +
																'"' +
																(f.name === current ? ' selected' : '') +
																'>' +
																escapeHtml(f.label || f.name) +
																' (' +
																escapeHtml(f.name) +
																')' +
																csvFieldAccessSuffix(f) +
																'</option>',
														)
														.join('');
												const status = current
													? '<span class="lcsv-col-status mapped" title="Mapped">\u2713</span>'
													: '<span class="lcsv-col-status unmapped" title="Skipped on import">\u25CB</span>';
												return (
													'<div class="lcsv-col-row">' +
													status +
													'<code class="lcsv-col-name">' +
													escapeHtml(h) +
													'</code>' +
													'<select class="lcsv-col-map" data-lcsv-col="' +
													i +
													':' +
													ci +
													'">' +
													opts +
													'</select>' +
													'</div>'
												);
											})
											.join('');
										const openByDefault = unmappedCount > 0;
										columnsHtml =
											'<details class="lcsv-cols"' +
											(openByDefault ? ' open' : '') +
											'>' +
											'<summary>Columns ' +
											'<span class="lcsv-cols-summary">' +
											(unmappedCount > 0
												? unmappedCount +
													' column' +
													(unmappedCount === 1 ? '' : 's') +
													' unmapped'
												: 'all mapped') +
											'</span>' +
											'</summary>' +
											'<div class="lcsv-col-list">' +
											rows +
											'</div>' +
											'</details>';
									}
									const fileLabel = displayNames[i] || file.name;
									const dupSuffixTitle =
										fileLabel !== file.name
											? ' title="Original filename: ' +
												escapeHtml(file.name) +
												' (suffix added because another file with this name is also loaded)"'
											: '';
									const eligibleExtIdFields =
										file.describe && Array.isArray(file.describe.fields)
											? file.describe.fields.filter(
													(f) => f && f.externalId && f.filterable === true && f.createable,
												)
											: [];
									const mappedFieldNames = new Set(Object.values(file.mapping || {}).filter(Boolean));
									const mappedExtIdFields = eligibleExtIdFields.filter((f) =>
										mappedFieldNames.has(f.name),
									);
									const opPicker =
										file.objectName && mappedExtIdFields.length > 0
											? (() => {
													const currentOp = file.operation || 'insert';
													const currentExt = file.externalIdFieldName || '';
													const extOpts = mappedExtIdFields
														.map(
															(f) =>
																'<option value="' +
																escapeHtml(f.name) +
																'"' +
																(f.name === currentExt ? ' selected' : '') +
																'>' +
																escapeHtml(f.label || f.name) +
																' (' +
																escapeHtml(f.name) +
																')' +
																'</option>',
														)
														.join('');
													return (
														'<div class="lcsv-op-row">' +
														'<label class="lcsv-op-label">Operation:</label>' +
														'<select class="lcsv-op" data-lcsv-op="' +
														i +
														'">' +
														'<option value="insert"' +
														(currentOp === 'insert' ? ' selected' : '') +
														'>Insert new records</option>' +
														'<option value="upsert"' +
														(currentOp === 'upsert' ? ' selected' : '') +
														'>Upsert by external id</option>' +
														'</select>' +
														(currentOp === 'upsert'
															? '<label class="lcsv-op-label">Key:</label>' +
																'<select class="lcsv-op-key" data-lcsv-op-key="' +
																i +
																'">' +
																extOpts +
																'</select>'
															: '') +
														'</div>'
													);
												})()
											: '';
									return (
										'<div class="lcsv-file">' +
										'<div class="lcsv-file-head">' +
										'<span class="lcsv-name"' +
										dupSuffixTitle +
										'>' +
										escapeHtml(fileLabel) +
										'</span>' +
										'<span class="lcsv-meta">' +
										file.rows.length +
										' row' +
										(file.rows.length === 1 ? '' : 's') +
										'</span>' +
										'<button type="button" class="lcsv-remove" data-lcsv-remove="' +
										i +
										'" title="Remove this file">\u00D7</button>' +
										'</div>' +
										'<div class="lcsv-file-body">' +
										'<select class="lcsv-obj" data-lcsv-obj="' +
										i +
										'">' +
										opts +
										'</select>' +
										meta +
										'</div>' +
										permWarn +
										opPicker +
										columnsHtml +
										'</div>'
									);
								})
								.join('');
				const links = state.links || [];
				const linksHtml =
					links.length === 0
						? state.files.filter((f) => f.objectName).length >= 2
							? '<p class="tag">No relationships were detected between these files. Records will import unconnected; you can connect them on the canvas afterward.</p>'
							: ''
						: links
								.map((link, i) => {
									const fromFile = state.files[link.fromFileIdx];
									const toFile = state.files[link.toFileIdx];
									const colOpts =
										'<option value=""> - Don\u2019t link - </option>' +
										toFile.headers
											.map(
												(h, ci) =>
													'<option value="' +
													ci +
													'"' +
													(ci === link.toColumnIdx ? ' selected' : '') +
													'>' +
													escapeHtml(h || '(blank)') +
													'</option>',
											)
											.join('');
									const samplesHtml =
										link.samples.length > 0
											? '<div class="lcsv-link-samples">e.g. ' +
												link.samples
													.map((s) => '<code>' + escapeHtml(s) + '</code>')
													.join(', ') +
												'</div>'
											: '';
									const ratio = link.total > 0 ? Math.round((link.matched / link.total) * 100) : 0;
									const stateClass =
										link.matched === link.total
											? 'lcsv-link-full'
											: link.matched > 0
												? 'lcsv-link-partial'
												: 'lcsv-link-empty';
									const fromLabel = displayNames[link.fromFileIdx] || fromFile.name;
									const toLabel = displayNames[link.toFileIdx] || toFile.name;
									return (
										'<div class="lcsv-link ' +
										stateClass +
										'">' +
										'<div class="lcsv-link-head">' +
										'<code>' +
										escapeHtml(fromLabel) +
										'</code>.<code>' +
										escapeHtml(link.fromHeader) +
										'</code>' +
										' <span class="lcsv-arrow">\u2192</span> ' +
										'<code>' +
										escapeHtml(toLabel) +
										'</code>.<select class="lcsv-link-col" data-lcsv-link="' +
										i +
										'">' +
										colOpts +
										'</select>' +
										'</div>' +
										'<div class="lcsv-link-stats">' +
										'<strong>' +
										link.matched +
										' / ' +
										link.total +
										'</strong> values matched (' +
										ratio +
										'%)' +
										'</div>' +
										samplesHtml +
										'</div>'
									);
								})
								.join('');
				const _validForSummary = state.files.filter(
					(f) => f.objectName && Object.values(f.mapping).filter(Boolean).length > 0,
				);
				const _totalRowsForSummary = _validForSummary.reduce((n, f) => n + f.rows.length, 0);
				const _linkedCountForSummary = (state.links || []).length;
				const _isMultiOrLinkedForSummary = _validForSummary.length > 1 || _linkedCountForSummary > 0;
				const _bulkBannerForSummary =
					!_isMultiOrLinkedForSummary && _totalRowsForSummary > _DIRECT_CSV_VALIDATED_CAP;
				const _filesSummary =
					_validForSummary.length > 0
						? _totalRowsForSummary +
							' record' +
							(_totalRowsForSummary === 1 ? '' : 's') +
							' from ' +
							_validForSummary.length +
							' file' +
							(_validForSummary.length === 1 ? '' : 's') +
							' ready'
						: 'map at least one file';
				const dropzoneHtml =
					canvasState.allObjects === null
						? '<div class="lcsv-dropzone is-loading" tabindex="-1" aria-busy="true">' +
							'<strong>Loading object catalog…</strong>' +
							'<span class="tag">First load can take 30+ seconds in a fresh org.</span>' +
							'</div>'
						: '<div class="lcsv-dropzone" id="lcsv-dropzone" tabindex="0">' +
							'<strong>Drop CSV files here</strong>' +
							'<span class="tag">or click to select</span>' +
							'<input type="file" id="lcsv-file-input" accept=".csv,text/csv,text/plain" multiple style="display:none">' +
							'</div>';
				const _noticesHtml =
					state.notices && state.notices.length
						? '<div class="lcsv-notices">' +
							state.notices
								.map(
									(n) =>
										'<div class="banner ' +
										(n.kind === 'error' ? 'error' : 'warn') +
										'" style="margin:0 0 0.5em">' +
										escapeHtml(n.text) +
										'</div>',
								)
								.join('') +
							'</div>'
						: '';
				body.innerHTML =
					_noticesHtml +
					'<div class="lcsv-step">' +
					dropzoneHtml +
					'</div>' +
					(state.files.length > 0
						? '<div class="lcsv-step">' +
							'<div class="lcsv-files-header"><strong>Files</strong><span class="tag lcsv-files-summary">' +
							_filesSummary +
							'</span></div>' +
							(_bulkBannerForSummary
								? '<div class="banner warn lcsv-bulk-banner" data-lcsv-bulk-banner>' +
									'<strong>Large upload - atomicity not guaranteed.</strong> ' +
									_totalRowsForSummary.toLocaleString() +
									' rows is past the ' +
									_DIRECT_CSV_VALIDATED_CAP.toLocaleString() +
									'-row pre-flight limit, so ' +
									'<em>Upload to Salesforce</em> will run via the Bulk API v2. Records commit independently - some may succeed while others fail, and there is no all-or-nothing rollback. Per-row failures are reported when the upload finishes.' +
									'</div>'
								: '') +
							'<div class="lcsv-files">' +
							filesHtml +
							'</div>' +
							'</div>'
						: '') +
					(links.length > 0
						? '<div class="lcsv-step"><strong>Detected links</strong>' +
							'<p class="tag">Columns that relate records are paired using matching values. Adjust or skip them below; unlinked rows still import as standalone records.</p>' +
							'<div class="lcsv-links">' +
							linksHtml +
							'</div>' +
							'</div>'
						: '');
				const dz = body.querySelector('#lcsv-dropzone');
				const fileInput = body.querySelector('#lcsv-file-input');
				if (dz && fileInput) {
					dz.addEventListener('click', () => fileInput.click());
					dz.addEventListener('dragover', (e) => {
						e.preventDefault();
						dz.classList.add('drag');
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
					sel.addEventListener('change', (e) =>
						linkedCsvSetObject(Number(e.target.dataset.lcsvObj), e.target.value),
					);
				});
				body.querySelectorAll('[data-lcsv-remove]').forEach((btn) => {
					btn.addEventListener('click', () => linkedCsvRemoveFile(Number(btn.dataset.lcsvRemove)));
				});
				body.querySelectorAll('[data-lcsv-link]').forEach((sel) => {
					sel.addEventListener('change', (e) =>
						linkedCsvUpdateLink(Number(e.target.dataset.lcsvLink), e.target.value),
					);
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
				const ready = linkedCsvReady(state);
				if (confirmBtn) {
					confirmBtn.disabled = !ready;
				}
				if (replaceBtn) {
					replaceBtn.disabled = !ready;
				}
				if (uploadBtn) {
					uploadBtn.disabled = !ready || state.preparingUpload;
				}
				if (uploadBtn && ready && !state.preparingUpload) {
					const linkedCount = (state.links || []).length;
					const isMultiOrLinked = _validForSummary.length > 1 || linkedCount > 0;
					const overValidatedCap = isMultiOrLinked && _totalRowsForSummary > _DIRECT_CSV_VALIDATED_CAP;
					if (overValidatedCap) {
						uploadBtn.disabled = true;
						uploadBtn.title =
							'Multi-file or linked uploads are capped at ' +
							_DIRECT_CSV_VALIDATED_CAP.toLocaleString() +
							' rows. Split this batch or remove the detected relationships.';
					} else if (_bulkBannerForSummary) {
						uploadBtn.title =
							'Large single-file upload - runs via Bulk API v2. Per-record success/failure; no pre-flight check, no atomic rollback.';
					} else {
						uploadBtn.title = isMultiOrLinked
							? 'Multi-file / linked upload. Records will be validated and committed together via the Composite Graph API (atomic per connected component).'
							: 'Bulk upload via Salesforce Bulk API. Per-record success/failure; no pre-flight check.';
					}
				}
			}

			function _planMappedFieldWrites(files, state, idResolution, cellKey) {
				// Keep readable-but-unwritable values as context, but never send them to Salesforce.
				const groups = new Map();
				const omittedByRow = new Map();
				const affectedRows = new Set();
				for (const file of files) {
					if (!file.describe || !Array.isArray(file.describe.fields)) {
						continue;
					}
					const fromFileIdx = state.files.indexOf(file);
					const mapping = file.mapping || {};
					const idColIdxStr = Object.keys(mapping).find((iStr) => mapping[Number(iStr)] === 'Id');
					const idColIdx = idColIdxStr != null ? Number(idColIdxStr) : null;
					const fieldByName = new Map();
					file.describe.fields.forEach((field) => {
						if (field && field.name) {
							fieldByName.set(field.name, field);
						}
					});
					file.rows.forEach((row, rowIdx) => {
						const rawId = idColIdx != null ? row[idColIdx] : null;
						const sfId = rawId != null && String(rawId).trim() !== '' ? String(rawId).trim() : null;
						const operation = csvRowOperation(file, sfId, idResolution);
						const rowKey = cellKey(fromFileIdx, rowIdx);
						Object.keys(mapping).forEach((colIdxStr) => {
							const colIdx = Number(colIdxStr);
							const fieldName = mapping[colIdx];
							if (!fieldName || fieldName === 'Id') {
								return;
							}
							const isLinkedFk = (state.links || []).some(
								(link) => link.fromFileIdx === fromFileIdx && link.fromColumnIdx === colIdx,
							);
							if (isLinkedFk) {
								return;
							}
							const field = fieldByName.get(fieldName);
							const disposition = csvFieldDisposition(field, operation);
							if (disposition === 'write') {
								return;
							}
							if (!omittedByRow.has(rowKey)) {
								omittedByRow.set(rowKey, new Set());
							}
							omittedByRow.get(rowKey).add(fieldName);
							const value = row[colIdx];
							if (disposition !== 'warn' || value == null || String(value).trim() === '') {
								return;
							}
							const groupKey = fromFileIdx + '::' + file.objectName;
							if (!groups.has(groupKey)) {
								groups.set(groupKey, {
									fileName: file.name,
									objectName: file.objectName,
									fields: new Map(),
								});
							}
							const reason = operation === 'upsert' ? 'No create or edit access' : 'No create access';
							const issueKey = fieldName + '::' + colIdx + '::' + reason;
							const fieldIssues = groups.get(groupKey).fields;
							if (!fieldIssues.has(issueKey)) {
								fieldIssues.set(issueKey, {
									csvHeader: (file.headers && file.headers[colIdx]) || '(blank)',
									fieldName,
									fieldLabel: field && field.label ? field.label : fieldName,
									reason,
									rows: new Set(),
								});
							}
							fieldIssues.get(issueKey).rows.add(rowKey);
							affectedRows.add(rowKey);
						});
					});
				}
				const issues = Array.from(groups.values()).map((group) => ({
					fileName: group.fileName,
					objectName: group.objectName,
					fields: Array.from(group.fields.values()).map((field) => ({
						csvHeader: field.csvHeader,
						fieldName: field.fieldName,
						fieldLabel: field.fieldLabel,
						reason: field.reason,
						affectedRows: field.rows.size,
					})),
				}));
				return { issues, omittedByRow, affectedRowCount: affectedRows.size };
			}

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
							issues.push({
								linkIdx,
								value,
								targetCount: rows.length,
								childCount: sourceCounts.get(value),
								fromField: link.fromField,
							});
						}
					});
				});
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
						const sfId = raw != null && String(raw).trim() !== '' ? String(raw).trim() : null;
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
								body: JSON.stringify({
									soql: 'SELECT Id FROM ' + obj + ' WHERE Id IN (' + inList + ')',
									fullFields: true,
								}),
							});
							if (resp.ok) {
								const data = await resp.json();
								(data.records || []).forEach((rec) => {
									if (rec && rec.loadedFromId) {
										liveById.set(String(rec.loadedFromId).slice(0, 15), rec.values || {});
									}
								});
							}
						} catch (e) {
							/* network/query error → rows treated as not-found */
						}
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
					const rows = items
						.map(
							(it, i) =>
								'<label class="missing-id-row" style="display:flex;align-items:center;gap:8px;padding:4px 0;">' +
								'<input type="checkbox" data-mid="' +
								i +
								'" checked>' +
								'<span>' +
								escapeHtml(it.label) +
								'</span>' +
								'</label>',
						)
						.join('');
					modal.innerHTML =
						'<div class="modal-overlay" data-mid-close></div>' +
						'<div class="modal-body" style="max-width:520px">' +
						'<div class="modal-header"><h3>Some Id rows weren’t found</h3>' +
						'<button class="modal-close" data-mid-close>&times;</button></div>' +
						'<div class="modal-content">' +
						'<p style="white-space:pre-line">' +
						items.length +
						' row' +
						(items.length === 1 ? '' : 's') +
						(items.length === 1 ? ' references' : ' reference') +
						' a Salesforce Id that doesn’t exist in this org (deleted, wrong org, or a typo). ' +
						'Pick which to add as new draft records - unchecked rows are skipped. ' +
						'Rows whose Id WAS found import as existing records regardless.</p>' +
						'<div style="display:flex;gap:12px;margin:6px 0;">' +
						'<button type="button" class="button secondary" data-mid-all>Select all</button>' +
						'<button type="button" class="button secondary" data-mid-none>Select none</button>' +
						'</div>' +
						'<div class="missing-id-list" style="max-height:280px;overflow:auto;border:1px solid var(--border);border-radius:4px;padding:8px;">' +
						rows +
						'</div>' +
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
					modal
						.querySelectorAll('[data-mid-close], [data-mid-cancel]')
						.forEach((el) => el.addEventListener('click', () => finish(null)));
					modal.querySelector('[data-mid-all]').addEventListener('click', () =>
						modal.querySelectorAll('input[data-mid]').forEach((cb) => {
							cb.checked = true;
						}),
					);
					modal.querySelector('[data-mid-none]').addEventListener('click', () =>
						modal.querySelectorAll('input[data-mid]').forEach((cb) => {
							cb.checked = false;
						}),
					);
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
						const b = modal.querySelector('[data-mid-confirm]');
						if (b) {
							b.focus();
						}
					}, 0);
				});
			}

			function showFieldWriteReview(plan) {
				return new Promise((resolve) => {
					document.querySelectorAll('.lcsv-field-review-modal').forEach((el) => el.remove());
					const fieldCount = plan.issues.reduce((count, issue) => count + issue.fields.length, 0);
					const groups = plan.issues
						.map((issue) => {
							const fields = issue.fields
								.map(
									(field) =>
										'<div class="lcsv-field-review-row">' +
										'<div class="lcsv-field-review-name">' +
										'<strong>' +
										escapeHtml(field.fieldLabel) +
										'</strong>' +
										'<code>' +
										escapeHtml(field.fieldName) +
										'</code>' +
										'<span>CSV column: ' +
										escapeHtml(field.csvHeader) +
										'</span>' +
										'</div>' +
										'<div class="lcsv-field-review-status">' +
										'<span class="tag warn">' +
										escapeHtml(field.reason) +
										'</span>' +
										'<span>' +
										field.affectedRows +
										' row' +
										(field.affectedRows === 1 ? '' : 's') +
										'</span>' +
										'</div>' +
										'</div>',
								)
								.join('');
							return (
								'<section class="lcsv-field-review-group">' +
								'<div class="lcsv-field-review-group-head">' +
								'<strong>' +
								escapeHtml(issue.fileName || 'CSV file') +
								'</strong>' +
								'<span>' +
								escapeHtml(issue.objectName) +
								'</span>' +
								'</div>' +
								fields +
								'</section>'
							);
						})
						.join('');
					const modal = document.createElement('div');
					modal.className = 'modal lcsv-field-review-modal';
					modal.innerHTML =
						'<div class="modal-overlay" data-lcsv-field-review-cancel></div>' +
						'<div class="modal-body" role="dialog" aria-modal="true" aria-labelledby="lcsv-field-review-title">' +
						'<div class="modal-header">' +
						'<h3 id="lcsv-field-review-title">Review fields that will be left out</h3>' +
						'<button class="modal-close" aria-label="Close" data-lcsv-field-review-cancel>&times;</button>' +
						'</div>' +
						'<div class="modal-content">' +
						'<p>Salesforce will not accept some CSV values for these rows. You can continue with the remaining values or go back and change the mapping.</p>' +
						'<div class="lcsv-field-review-summary">' +
						'<strong>' +
						fieldCount +
						' field' +
						(fieldCount === 1 ? '' : 's') +
						'</strong>' +
						'<span>across ' +
						plan.affectedRowCount +
						' row' +
						(plan.affectedRowCount === 1 ? '' : 's') +
						'</span>' +
						'</div>' +
						'<div class="lcsv-field-review-list">' +
						groups +
						'</div>' +
						'<p class="lcsv-field-review-note"><strong>Existing Salesforce values are not cleared.</strong> Continuing leaves only the listed CSV values out.</p>' +
						'</div>' +
						'<div class="modal-footer">' +
						'<button class="button secondary" data-lcsv-field-review-cancel>Back to mapping</button>' +
						'<button class="button" data-lcsv-field-review-confirm>Continue without these values</button>' +
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
					const onKey = (event) => {
						if (event.key === 'Escape') {
							finish(false);
						}
					};
					document.addEventListener('keydown', onKey);
					modal
						.querySelectorAll('[data-lcsv-field-review-cancel]')
						.forEach((el) => el.addEventListener('click', () => finish(false)));
					modal
						.querySelector('[data-lcsv-field-review-confirm]')
						.addEventListener('click', () => finish(true));
					setTimeout(() => modal.querySelector('button[data-lcsv-field-review-cancel]').focus(), 0);
				});
			}

			async function linkedCsvConfirm(opts) {
				opts = opts || {};
				const skipCanvas = !!opts.uploadDirectly;
				const state = linkedCsvState;
				if (!state) {
					return;
				}
				const validFiles = state.files.filter(
					(f) => f.objectName && Object.values(f.mapping).filter(Boolean).length > 0,
				);
				if (validFiles.length === 0) {
					return;
				}
				if (validFiles.some((f) => Array.isArray(f.blockingErrors) && f.blockingErrors.length > 0)) {
					showBulkToast('Fix the blocked CSV structure errors before importing.', 'error');
					return;
				}
				// Never infer a parent from file order when a relationship key is ambiguous.
				const ambiguousJoins = _detectAmbiguousJoinKeys(state);
				state._skippedAmbiguousJoinKeys = new Set();
				if (ambiguousJoins.length > 0) {
					const lines = ['Some relationship keys match more than one parent row:', ''];
					ambiguousJoins.forEach((issue) => {
						lines.push(
							'• "' +
								issue.value +
								'" → ' +
								issue.targetCount +
								' parents, ' +
								issue.childCount +
								' child' +
								(issue.childCount === 1 ? '' : 'ren') +
								' (' +
								issue.fromField +
								')',
						);
					});
					lines.push(
						'',
						'Org Loom will never pick a parent based on file order. Continue only if you want the affected children imported without those relationships.',
					);
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
					ambiguousJoins.forEach((issue) =>
						state._skippedAmbiguousJoinKeys.add(issue.linkIdx + '::' + issue.value),
					);
				}
				if (skipCanvas) {
					const linkedCount = (state.links || []).length;
					const totalRows = validFiles.reduce((n, f) => n + f.rows.length, 0);
					const isMultiOrLinked = validFiles.length > 1 || linkedCount > 0;
					if (isMultiOrLinked && totalRows > _DIRECT_CSV_VALIDATED_CAP) {
						showBulkToast(
							'Multi-file or linked uploads are capped at ' +
								_DIRECT_CSV_VALIDATED_CAP.toLocaleString() +
								' rows. Split this batch or remove the detected relationships.',
							'error',
						);
						return;
					}
				}
				const cellKey = (fi, ri) => fi + '|' + ri;
				const _idResolution = await csvResolveExistingIds(validFiles, state, cellKey);
				if (_idResolution.canceled) {
					return;
				}
				const fieldPlan = _planMappedFieldWrites(validFiles, state, _idResolution, cellKey);
				const strippedFieldsSummary = Array.from(
					new Set(
						fieldPlan.issues.flatMap((issue) =>
							issue.fields.map((field) => issue.objectName + '.' + field.fieldName),
						),
					),
				);
				if (fieldPlan.issues.length > 0 && !(await showFieldWriteReview(fieldPlan))) {
					return;
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
				const _preImportSelectedIdSeq = canvasState.selectedIdSeq;
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
							const sfId = raw != null && String(raw).trim() !== '' ? String(raw).trim() : null;
							if (sfId && existingCanvasById.has(file.objectName + '::' + sfId.slice(0, 15))) {
								return; // collision → merges onto the existing card
							}
							if (
								sfId &&
								!_idResolution.liveById.has(sfId.slice(0, 15)) &&
								!_idResolution.draftKeys.has(cellKey(fromFileIdx, rowIdx))
							) {
								return; // not found + not drafted → row skipped
							}
							plannedNewCards++;
						});
					});
					const _capProbe = canvasCapCheck ? canvasCapCheck(plannedNewCards) : null;
					const blocked = _capProbe
						? shouldReplace
							? plannedNewCards > _capProbe.cap
								? _capProbe.reason
								: null
							: _capProbe.reason
						: _canvasCapBlockReason(plannedNewCards);
					if (blocked) {
						showBulkToast(blocked, 'error');
						return;
					}
				}
				const _undoImport = !skipCanvas && captureUndoSnapshot ? captureUndoSnapshot() : null;
				const selByName = new Map();
				for (const file of validFiles) {
					let sel = canvasState.selectedObjects.find((s) => s.name === file.objectName);
					if (!sel) {
						if (skipCanvas) {
							// Mapping already loaded the describe; direct upload only needs its identity and labels.
							sel = {
								id: canvasState.selectedIdSeq++,
								name: file.objectName,
								label: (file.describe && file.describe.label) || file.objectName,
								data: null,
								addedFrom: null,
								addedVia: 'quick-upload',
								worldPos: null,
							};
							canvasState.selectedObjects.push(sel);
						} else {
							try {
								sel = await addToSelection(file.objectName);
							} catch (e) {
								console.warn('addToSelection failed for', file.objectName, e);
								continue;
							}
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
						const omittedFields = fieldPlan.omittedByRow.get(cellKey(fromFileIdx, rowIdx));
						mappedIdxs.forEach((iStr) => {
							const i = Number(iStr);
							const field = file.mapping[i];
							if (omittedFields && omittedFields.has(field)) {
								return;
							}
							const isLinkedFk = (state.links || []).some(
								(l) => l.fromFileIdx === fromFileIdx && l.fromColumnIdx === i,
							);
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
						const sfId = rawId != null && String(rawId).trim() !== '' ? String(rawId).trim() : null;
						if (!skipCanvas && sfId) {
							const _hit = existingCanvasById.get(sel.name + '::' + sfId.slice(0, 15));
							if (_hit) {
								const _vc = window.OrgLoom && window.OrgLoom.valueCompare;
								const _d =
									_vc && typeof _vc.computeRecordDiff === 'function'
										? _vc.computeRecordDiff(_hit, { objectName: _hit.objectName, values: values })
										: null;
								const _changes = _d ? _d.differing.length + _d.bOnly.length : 1;
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
						if (skipCanvas) {
							rec._csvSourceFile = file.name;
							rec._csvSourceRow = rowIdx + 2;
						}
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
				let linksSkippedAmbiguous = 0;
				const newAssocIds = new Set();
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
						if (
							state._skippedAmbiguousJoinKeys &&
							state._skippedAmbiguousJoinKeys.has(linkIdx + '::' + v)
						) {
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
				closeLinkedCsvModal({ keepQuickUploadMode: true, allowWhilePreparing: true });
				if (skipCanvas) {
					const _snapRecs = canvasState.bulkRecords.filter((r) => !newRecIds.has(r.id));
					const _snapAssocs = canvasState.bulkAssociations.filter((a) => !newAssocIds.has(a.id));
					const _snapSelectedObjects = _preImportSelectedObjects;
					try {
						// Snapshot the prior canvas before direct upload so a refresh cannot strand staged data.
						const cy = getCyInstance();
						sessionStorage.setItem(
							_QU_RESTORE_KEY,
							JSON.stringify({
								version: 1,
								sfOrgId: window.SF_ORG_ID || null,
								records: _snapRecs,
								associations: _snapAssocs,
								selectedObjects: _snapSelectedObjects,
								selectedIds: Array.from(canvasState.bulkSelectedIds || []),
								bulkIdSeq: canvasState.bulkIdSeq,
								currentCanvas: canvasState.currentCanvas || null,
								viewport: cy ? { zoom: cy.zoom(), pan: cy.pan() } : null,
							}),
						);
					} catch (e) {
						console.warn('Quick Upload recovery snapshot failed:', e);
					}
					canvasState.bulkRecords = canvasState.bulkRecords.filter((r) => newRecIds.has(r.id));
					canvasState.bulkAssociations = canvasState.bulkAssociations.filter((a) => newAssocIds.has(a.id));
					getGraph().classList.add('csv-direct-upload-active');
					setPendingUploadCleanup(() => {
						canvasState.bulkRecords = _snapRecs;
						canvasState.bulkAssociations = _snapAssocs;
						canvasState.selectedObjects = _snapSelectedObjects;
						canvasState.selectedIdSeq = _preImportSelectedIdSeq;
						getGraph().classList.remove('csv-direct-upload-active');
						_linkedCsvQuickUploadMode = false;
						try {
							sessionStorage.removeItem(_QU_RESTORE_KEY);
						} catch (e) {}
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
				const _mergeNote =
					_mergeTotal > 0
						? ' · ' +
							_mergeTotal +
							' matched a card already on the canvas' +
							(mergeQueue.length > 0 ? ' - review the merge' : ' - skipped')
						: '';
				const _unchangedNote =
					unchangedCount > 0 ? ' · ' + unchangedCount + ' already on the canvas, unchanged' : '';
				const _fkNote =
					linksSkippedFk > 0
						? ' · ' +
							linksSkippedFk +
							' link' +
							(linksSkippedFk === 1 ? '' : 's') +
							' skipped (lookup already set)'
						: '';
				const _ambiguousNote =
					linksSkippedAmbiguous > 0
						? ' · ' +
							linksSkippedAmbiguous +
							' link' +
							(linksSkippedAmbiguous === 1 ? '' : 's') +
							' skipped (ambiguous parent key)'
						: '';
				const _toastMsg =
					'Imported ' +
					totalRecords +
					' record' +
					(totalRecords === 1 ? '' : 's') +
					' from ' +
					fileCount +
					' file' +
					(fileCount === 1 ? '' : 's') +
					(linkedCount > 0 ? ' (' + linkedCount + ' link' + (linkedCount === 1 ? '' : 's') + ' wired)' : '') +
					_mergeNote +
					_unchangedNote +
					_fkNote +
					_ambiguousNote +
					'.';
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
				// Recovery is org-bound and one-shot; stale snapshots are discarded instead of merged.
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
				if (
					!snapshot ||
					snapshot.version !== 1 ||
					(snapshot.sfOrgId && window.SF_ORG_ID && snapshot.sfOrgId !== window.SF_ORG_ID)
				) {
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
				isQuickUploadMode: function () {
					return _linkedCsvQuickUploadMode;
				},
				restoreInterruptedQuickUpload: restoreInterruptedQuickUpload,
			};
		},
	};
})();
