(function () {
	'use strict';
	// Imports related CSV files while preserving row identity and cross-file lookup intent.

	window.OrgLoom = window.OrgLoom || {};

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

	function csvFieldOptionLabel(field) {
		if (field && field.name === 'Id') {
			return 'Salesforce ID';
		}
		return field && (field.label || field.name) ? field.label || field.name : '';
	}

	function isSalesforceId(value) {
		return /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(String(value || '').trim());
	}

	function isExternalKeyReferenceField(field) {
		return !!(
			field &&
			field.type === 'reference' &&
			(field.referenceTargetField ||
				(Array.isArray(field.referenceTo) &&
					field.referenceTo.some((target) => typeof target === 'string' && /__x$/i.test(target))))
		);
	}

	function relationshipSemanticVariants(value) {
		const raw = String(value || '')
			.replace(/__(c|r|x)$/i, '')
			.trim();
		const normalized = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
		const parts = raw.split(/_+/).filter(Boolean);
		const finalPart = parts.length > 1 ? parts[parts.length - 1].toLowerCase().replace(/[^a-z0-9]/g, '') : '';
		return Array.from(new Set([normalized, finalPart].filter((part) => part.length >= 3)));
	}

	function relationshipSemanticBonus(sourceHeader, field, targetObjectName, targetObjectLabel) {
		const source = String(sourceHeader || '')
			.toLowerCase()
			.replace(/[^a-z0-9]/g, '');
		const fieldSignals = [field && field.label, field && field.name, field && field.relationshipName]
			.flatMap(relationshipSemanticVariants)
			.some((signal) => source.includes(signal));
		const targetSignals = [targetObjectName, targetObjectLabel]
			.flatMap(relationshipSemanticVariants)
			.some((signal) => source.includes(signal));
		return (fieldSignals ? 4 : 0) + (targetSignals ? 2 : 0);
	}

	function csvImportCanceled(state, currentState) {
		return !state || state.cancelRequested === true || currentState !== state;
	}

	function linkedCsvReady(state) {
		if (!state || state.processingFiles || state.hasRejectedFileErrors) {
			return false;
		}
		if (
			(state.links || []).some(
				(link) =>
					link.fromFileIdx == null ||
					link.fromColumnIdx == null ||
					!link.fromField ||
					link.toFileIdx == null ||
					link.toColumnIdx == null ||
					Number(link.unmatched || 0) > 0 ||
					Number(link.ambiguous || 0) > 0 ||
					(Array.isArray(link.duplicateTargetKeys) && link.duplicateTargetKeys.length > 0),
			) ||
			state.files.some(
				(file) =>
					(file && Array.isArray(file.lookupErrors) && file.lookupErrors.length > 0) ||
					(file && Array.isArray(file.relationshipErrors) && file.relationshipErrors.length > 0) ||
					duplicateDirectFieldMappings(file).length > 0,
			)
		) {
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

	function duplicateDirectFieldMappings(file) {
		if (!file) {
			return [];
		}
		const columnsByField = new Map();
		Object.keys(file.mapping || {}).forEach((columnIdx) => {
			const fieldName = file.mapping[columnIdx];
			if (!fieldName) {
				return;
			}
			if (!columnsByField.has(fieldName)) {
				columnsByField.set(fieldName, []);
			}
			columnsByField.get(fieldName).push(Number(columnIdx));
		});
		return Array.from(columnsByField.entries())
			.filter(([, columnIdxs]) => columnIdxs.length > 1)
			.map(([fieldName, columnIdxs]) => ({
				fieldName,
				columnIdxs,
				headers: columnIdxs.map((columnIdx) => (file.headers || [])[columnIdx] || String(columnIdx + 1)),
			}));
	}

	function uniqueDirectFieldMapping(mapping) {
		const uniqueMapping = {};
		const usedFields = new Set();
		Object.keys(mapping || {}).forEach((columnIdx) => {
			const fieldName = mapping[columnIdx];
			if (!fieldName || usedFields.has(fieldName)) {
				return;
			}
			usedFields.add(fieldName);
			uniqueMapping[columnIdx] = fieldName;
		});
		return uniqueMapping;
	}

	function syncDuplicateFileNameNotice(state) {
		if (!state) {
			return;
		}
		state.notices = (state.notices || []).filter((notice) => notice.code !== 'duplicate-file-name');
		const counts = new Map();
		(state.files || []).forEach((file) => {
			const name = String((file && file.name) || '');
			if (name) {
				counts.set(name, (counts.get(name) || 0) + 1);
			}
		});
		const duplicates = Array.from(counts.entries())
			.filter(([, count]) => count > 1)
			.map(([name]) => name)
			.sort((left, right) => left.localeCompare(right));
		if (duplicates.length === 0) {
			return;
		}
		const list = duplicates.map((name) => '"' + name + '"').join(', ');
		state.notices.push({
			kind: 'warn',
			code: 'duplicate-file-name',
			text:
				duplicates.length === 1
					? 'Two or more files share the name ' +
						list +
						' - suffixed "(2)" etc. in the file list for clarity. Rename if you want a clearer distinction.'
					: 'Multiple files share names (' +
						list +
						') - suffixed "(2)" etc. in the file list. Rename if you want clearer labels.',
		});
	}

	function mixedRelationshipSources(state, fileIdx) {
		const file = state && Array.isArray(state.files) ? state.files[fileIdx] : null;
		if (!file) {
			return [];
		}
		const seen = new Set();
		return (state.links || []).reduce((sources, link) => {
			if (link.fromFileIdx !== fileIdx || link.fromColumnIdx == null || !link.fromField) {
				return sources;
			}
			const directColumnIdx = Object.keys(file.mapping || {}).find(
				(columnIdx) => file.mapping[columnIdx] === link.fromField,
			);
			const key = link.fromField + ':' + directColumnIdx + ':' + link.fromColumnIdx;
			if (directColumnIdx == null || seen.has(key)) {
				return sources;
			}
			seen.add(key);
			sources.push({
				fieldName: link.fromField,
				directHeader: file.headers[Number(directColumnIdx)] || link.fromField,
				relationshipHeader: file.headers[link.fromColumnIdx] || '',
			});
			return sources;
		}, []);
	}

	function resolveRelationshipRows(fromRows, fromColumnIdx, toRows, toColumnIdx, ignoredFromRowIdxs) {
		const ignoredRows = ignoredFromRowIdxs instanceof Set ? ignoredFromRowIdxs : new Set();
		const targetRowsByValue = new Map();
		(toRows || []).forEach((row, rowIdx) => {
			const value = String((row && row[toColumnIdx]) || '').trim();
			if (!value) {
				return;
			}
			if (!targetRowsByValue.has(value)) {
				targetRowsByValue.set(value, []);
			}
			targetRowsByValue.get(value).push(rowIdx);
		});

		const matches = [];
		const unmatchedRows = [];
		const ambiguousRows = [];
		const sourceRowsByValue = new Map();
		(fromRows || []).forEach((row, rowIdx) => {
			if (ignoredRows.has(rowIdx)) {
				return;
			}
			const value = String((row && row[fromColumnIdx]) || '').trim();
			if (!value) {
				return;
			}
			if (!sourceRowsByValue.has(value)) {
				sourceRowsByValue.set(value, []);
			}
			sourceRowsByValue.get(value).push(rowIdx);
			const targets = targetRowsByValue.get(value) || [];
			if (targets.length === 1) {
				matches.push({ fromRowIdx: rowIdx, toRowIdx: targets[0], value });
			} else if (targets.length === 0) {
				unmatchedRows.push({ fromRowIdx: rowIdx, value });
			} else {
				ambiguousRows.push({ fromRowIdx: rowIdx, value, toRowIdxs: targets.slice() });
			}
		});

		const duplicateTargetKeys = [];
		targetRowsByValue.forEach((rowIdxs, value) => {
			if (rowIdxs.length > 1) {
				duplicateTargetKeys.push({
					value,
					toRowIdxs: rowIdxs.slice(),
					fromRowIdxs: (sourceRowsByValue.get(value) || []).slice(),
				});
			}
		});

		return {
			sourceRowCount: matches.length + unmatchedRows.length + ambiguousRows.length,
			matches,
			unmatchedRows,
			ambiguousRows,
			duplicateTargetKeys,
		};
	}

	function shouldSelectRelationshipField(link, selectableFields) {
		return !link || !link.fromField || (selectableFields || []).length > 1;
	}

	function relationshipFieldAvailableForLink(state, linkIndex, fromFileIdx, fieldName) {
		return !(state && Array.isArray(state.links) ? state.links : []).some(
			(otherLink, otherIndex) =>
				otherIndex !== linkIndex && otherLink.fromFileIdx === fromFileIdx && otherLink.fromField === fieldName,
		);
	}

	function compatibleTargetFileIndexes(files, relationshipFields) {
		const fields = Array.isArray(relationshipFields) ? relationshipFields : [];
		return (Array.isArray(files) ? files : []).reduce((indexes, file, fileIdx) => {
			if (
				file &&
				fields.some((field) => Array.isArray(field.referenceTo) && field.referenceTo.includes(file.objectName))
			) {
				indexes.push(fileIdx);
			}
			return indexes;
		}, []);
	}

	function relationshipMatchTargetColumn(file, columnIdx) {
		if (!file || !Array.isArray(file.headers)) {
			return false;
		}
		if ((file.mapping || {})[columnIdx]) {
			return true;
		}
		if ((file.relationshipChoices || {})[columnIdx] === 'relationship') {
			return false;
		}
		const normalizedHeader = String(file.headers[columnIdx] || '')
			.toLowerCase()
			.replace(/[^a-z0-9]/g, '');
		return !normalizedHeader.endsWith('key');
	}

	window.OrgLoom.linkedCsv = {
		_test: {
			csvFieldDisposition,
			csvRowOperation,
			csvFieldAccessSuffix,
			csvFieldOptionLabel,
			isSalesforceId,
			isExternalKeyReferenceField,
			relationshipSemanticBonus,
			csvImportCanceled,
			linkedCsvReady,
			duplicateDirectFieldMappings,
			uniqueDirectFieldMapping,
			syncDuplicateFileNameNotice,
			mixedRelationshipSources,
			resolveRelationshipRows,
			shouldSelectRelationshipField,
			relationshipFieldAvailableForLink,
			compatibleTargetFileIndexes,
			relationshipMatchTargetColumn,
		},
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
				!deps.allObjectsReady ||
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
			const _allObjectsReady = deps.allObjectsReady;
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
				'<button type="button" class="modal-close" data-lcsv-close aria-label="Close importer">&times;</button>' +
				'</div>' +
				'<div class="modal-content" id="linked-csv-content"></div>' +
				'<div class="modal-footer"></div>' +
				'</div>';
			document.body.appendChild(linkedCsvModal);
			linkedCsvModal
				.querySelectorAll('[data-lcsv-close]')
				.forEach((el) => el.addEventListener('click', () => closeLinkedCsvModal()));
			document.addEventListener('keydown', (e) => {
				if (e.key === 'Escape' && !linkedCsvModal.classList.contains('hidden')) {
					closeLinkedCsvModal();
				}
			});
			let linkedCsvState = null;

			function openLinkedCsvModal() {
				const footer = linkedCsvModal.querySelector('.modal-footer');
				footer.innerHTML =
					'<button class="button secondary" id="linked-csv-replace" disabled title="Drop everything currently on the canvas, then load this file onto a fresh canvas.">Replace canvas</button>' +
					'<button class="button" id="linked-csv-confirm" disabled title="Load records onto the canvas alongside what is already there. Use Upload from the canvas toolbar to push them to Salesforce.">Add to canvas</button>';
				footer.querySelector('#linked-csv-replace').onclick = () =>
					runLinkedCsvAction('replace', () => linkedCsvConfirm({ replaceCanvas: true }));
				footer.querySelector('#linked-csv-confirm').onclick = () =>
					runLinkedCsvAction('add', () => linkedCsvConfirm());
				const header = linkedCsvModal.querySelector('.modal-header h3');
				if (header) {
					header.textContent = 'Import from CSV';
				}

				linkedCsvState = {
					files: [],
					relationships: [],
					links: [],
					nextRelationshipId: 1,
					notices: [],
					processingFiles: false,
					hasRejectedFileErrors: false,
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

			function closeLinkedCsvModal(force) {
				if (!force && linkedCsvState && linkedCsvState.importing) {
					linkedCsvState.cancelRequested = true;
				}
				linkedCsvModal.classList.add('hidden');
				linkedCsvState = null;
			}

			async function runLinkedCsvAction(mode, action) {
				const state = linkedCsvState;
				if (!state || state.importing) {
					return;
				}
				state.importing = true;
				state.cancelRequested = false;
				linkedCsvModal.classList.add('lcsv-is-preparing');
				const buttons = linkedCsvModal.querySelectorAll('#linked-csv-replace, #linked-csv-confirm');
				buttons.forEach((button) => {
					button.disabled = true;
				});
				const activeButton = linkedCsvModal.querySelector(
					mode === 'replace' ? '#linked-csv-replace' : '#linked-csv-confirm',
				);
				if (activeButton) {
					activeButton.setAttribute('aria-busy', 'true');
					activeButton.innerHTML =
						'<span class="busy-spinner" aria-hidden="true"></span>' +
						(mode === 'replace' ? 'Replacing…' : 'Adding…');
				}
				try {
					await action();
				} finally {
					if (linkedCsvState === state) {
						state.importing = false;
						linkedCsvModal.classList.remove('lcsv-is-preparing');
						openLinkedCsvActionButtons();
						linkedCsvRender();
					}
				}
			}

			function openLinkedCsvActionButtons() {
				const replaceButton = linkedCsvModal.querySelector('#linked-csv-replace');
				const addButton = linkedCsvModal.querySelector('#linked-csv-confirm');
				if (replaceButton) {
					replaceButton.removeAttribute('aria-busy');
					replaceButton.textContent = 'Replace canvas';
				}
				if (addButton) {
					addButton.removeAttribute('aria-busy');
					addButton.textContent = 'Add to canvas';
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
				const candidates = [];
				for (let i = 0; i < toFile.headers.length; i++) {
					if (
						(excludeColumnIdx != null && i === excludeColumnIdx) ||
						!relationshipMatchTargetColumn(toFile, i)
					) {
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
					if (tk.length >= 3 && sourceKey.includes(tk)) {
						bonus += 2;
					}
					const score = hits + bonus;
					candidates.push({ score, hits, toColumnIdx: i, toHeader });
				}
				candidates.sort((a, b) => b.score - a.score || a.toColumnIdx - b.toColumnIdx);
				if (candidates.length === 0) {
					return { best: null, ambiguous: false };
				}
				const best = candidates[0];
				return {
					best,
					ambiguous: candidates.length > 1 && candidates[1].score === best.score,
				};
			}

			function refreshLinkStats(link) {
				const state = linkedCsvState;
				const fromFile = state && state.files[link.fromFileIdx];
				const toFile = state && state.files[link.toFileIdx];
				link.total = 0;
				link.matched = 0;
				link.unmatched = 0;
				link.ambiguous = 0;
				link.unmatchedRows = [];
				link.ambiguousRows = [];
				link.duplicateTargetKeys = [];
				link.toHeader = null;
				if (!fromFile || link.fromColumnIdx == null || !toFile || link.toColumnIdx == null) {
					return;
				}
				link.toHeader = toFile.headers[link.toColumnIdx];
				const resolution = resolveRelationshipRows(
					fromFile.rows,
					link.fromColumnIdx,
					toFile.rows,
					link.toColumnIdx,
					new Set(link.conflictRowIdxs || []),
				);
				link.total = resolution.sourceRowCount;
				link.matched = resolution.matches.length;
				link.unmatched = resolution.unmatchedRows.length;
				link.ambiguous = resolution.ambiguousRows.length;
				link.unmatchedRows = resolution.unmatchedRows;
				link.ambiguousRows = resolution.ambiguousRows;
				link.duplicateTargetKeys = resolution.duplicateTargetKeys;
			}

			function relationshipFieldsFor(file) {
				return file && file.describe && Array.isArray(file.describe.fields)
					? file.describe.fields.filter(
							(field) =>
								field.type === 'reference' &&
								!isExternalKeyReferenceField(field) &&
								Array.isArray(field.referenceTo) &&
								field.referenceTo.length > 0 &&
								(field.createable === true || field.updateable === true),
						)
					: [];
			}

			function relationshipFieldLabel(field) {
				const label = field && (field.label || field.name) ? field.label || field.name : '';
				return field && field.label ? label.replace(/\s+ID$/i, '') : label;
			}

			function suggestRelationshipForColumn(state, fromFileIdx, fromColumnIdx) {
				const fromFile = state.files[fromFileIdx];
				if (!fromFile || !fromFile.objectName || !fromFile.describe) {
					return null;
				}
				const fromValues = new Set(
					fromFile.rows.map((row) => String(row[fromColumnIdx] || '').trim()).filter(Boolean),
				);
				if (fromValues.size === 0) {
					return null;
				}
				const header = fromFile.headers[fromColumnIdx] || '';
				const usedFields = new Set(
					(state.relationships || [])
						.filter((relationship) => relationship.fromFileIdx === fromFileIdx)
						.map((relationship) => relationship.fromField)
						.filter(Boolean),
				);
				const availableFields = relationshipFieldsFor(fromFile).filter((field) => !usedFields.has(field.name));
				const candidates = [];
				state.files.forEach((toFile, toFileIdx) => {
					if (!toFile.objectName) {
						return;
					}
					const compatibleFields = availableFields.filter((field) =>
						field.referenceTo.includes(toFile.objectName),
					);
					if (compatibleFields.length === 0) {
						return;
					}
					const scored = scoreLink(
						fromFile,
						fromColumnIdx,
						toFile,
						fromValues,
						toFileIdx === fromFileIdx ? fromColumnIdx : -1,
					);
					if (!scored.best || scored.ambiguous) {
						return;
					}
					const semanticBonus = Math.max(
						...compatibleFields.map((field) =>
							relationshipSemanticBonus(
								header,
								field,
								toFile.objectName,
								toFile.describe && toFile.describe.label,
							),
						),
					);
					candidates.push({
						score: scored.best.score + semanticBonus,
						hits: scored.best.hits,
						semanticBonus,
						field: compatibleFields.length === 1 ? compatibleFields[0] : null,
						toFileIdx,
						toColumnIdx: scored.best.toColumnIdx,
					});
				});
				candidates.sort((left, right) => right.score - left.score);
				const winner =
					candidates.length > 0 &&
					candidates[0].hits > 0 &&
					candidates[0].semanticBonus > 0 &&
					(!candidates[1] || candidates[1].score !== candidates[0].score)
						? candidates[0]
						: null;
				if (!winner) {
					return null;
				}
				return winner;
			}

			function addRelationshipForColumn(state, fromFileIdx, fromColumnIdx, suggestion) {
				state.relationships.push({
					id: state.nextRelationshipId++,
					fromFileIdx,
					fromColumnIdx,
					fromField: suggestion && suggestion.field ? suggestion.field.name : null,
					toFileIdx: suggestion ? suggestion.toFileIdx : null,
					toColumnIdx: suggestion ? suggestion.toColumnIdx : null,
				});
			}

			function autoSelectRelationshipColumns(state) {
				const usedSources = new Set(
					(state.relationships || []).map(
						(relationship) => relationship.fromFileIdx + ':' + relationship.fromColumnIdx,
					),
				);
				state.files.forEach((file, fromFileIdx) => {
					file.relationshipChoices = file.relationshipChoices || {};
					file.headers.forEach((header, fromColumnIdx) => {
						if (
							file.relationshipChoices[fromColumnIdx] === 'declined' ||
							(file.mapping || {})[fromColumnIdx] ||
							usedSources.has(fromFileIdx + ':' + fromColumnIdx) ||
							!csvNormalizeKey(header).endsWith('key')
						) {
							return;
						}
						const suggestion = suggestRelationshipForColumn(state, fromFileIdx, fromColumnIdx);
						if (!suggestion) {
							return;
						}
						file.relationshipChoices[fromColumnIdx] = 'relationship';
						addRelationshipForColumn(state, fromFileIdx, fromColumnIdx, suggestion);
						usedSources.add(fromFileIdx + ':' + fromColumnIdx);
					});
				});
			}

			function analyzeLinkedCsvs() {
				if (!linkedCsvState) {
					return;
				}
				const state = linkedCsvState;
				state.files.forEach((file) => {
					file.lookupErrors = [];
					file.relationshipErrors = [];
					if (!file.objectName || !file.describe) {
						return;
					}
					const directLookupByName = new Map(
						file.describe.fields
							.filter(
								(field) =>
									field.type === 'reference' &&
									Array.isArray(field.referenceTo) &&
									field.referenceTo.length > 0,
							)
							.map((field) => [field.name, field]),
					);
					Object.keys(file.mapping || {}).forEach((idxStr) => {
						const fieldName = file.mapping[idxStr];
						const lookupField = directLookupByName.get(fieldName);
						if (!lookupField || isExternalKeyReferenceField(lookupField)) {
							return;
						}
						const invalid = file.rows
							.map((row) => String(row[Number(idxStr)] || '').trim())
							.filter((value) => value && !isSalesforceId(value));
						if (invalid.length > 0) {
							file.lookupErrors.push({
								header: file.headers[Number(idxStr)],
								fieldName,
								count: invalid.length,
							});
						}
					});
				});

				autoSelectRelationshipColumns(state);
				const fieldUseByFile = new Map();
				(state.relationships || []).forEach((relationship, relationshipIndex) => {
					const fromFile = state.files[relationship.fromFileIdx];
					const fields = relationshipFieldsFor(fromFile);
					const field = fields.find((candidate) => candidate.name === relationship.fromField) || null;
					const candidateFields = field
						? [field]
						: fields.filter((candidate) =>
								relationshipFieldAvailableForLink(
									state,
									relationshipIndex,
									relationship.fromFileIdx,
									candidate.name,
								),
							);
					relationship.fromHeader =
						fromFile && relationship.fromColumnIdx != null
							? fromFile.headers[relationship.fromColumnIdx]
							: null;
					relationship.fromFieldLabel = field ? relationshipFieldLabel(field) : null;
					relationship.compatibleToFileIdxs = compatibleTargetFileIndexes(state.files, candidateFields);
					if (!relationship.compatibleToFileIdxs.includes(relationship.toFileIdx)) {
						relationship.toFileIdx =
							relationship.compatibleToFileIdxs.length === 1
								? relationship.compatibleToFileIdxs[0]
								: null;
						relationship.toColumnIdx = null;
					}
					if (
						fromFile &&
						relationship.fromColumnIdx != null &&
						relationship.toFileIdx != null &&
						relationship.toColumnIdx == null
					) {
						const fromValues = new Set(
							fromFile.rows
								.map((row) => String(row[relationship.fromColumnIdx] || '').trim())
								.filter(Boolean),
						);
						const scored = scoreLink(
							fromFile,
							relationship.fromColumnIdx,
							state.files[relationship.toFileIdx],
							fromValues,
							relationship.toFileIdx === relationship.fromFileIdx ? relationship.fromColumnIdx : -1,
						);
						if (scored.best && !scored.ambiguous) {
							relationship.toColumnIdx = scored.best.toColumnIdx;
						}
					}
					relationship.conflictRowIdxs = [];
					if (fromFile && relationship.fromField) {
						const fileFieldKey = relationship.fromFileIdx + ':' + relationship.fromField;
						fieldUseByFile.set(fileFieldKey, (fieldUseByFile.get(fileFieldKey) || 0) + 1);
						const directColumn = Object.keys(fromFile.mapping || {}).find(
							(columnIdx) => fromFile.mapping[columnIdx] === relationship.fromField,
						);
						if (directColumn != null && relationship.fromColumnIdx != null) {
							const conflictRowIdxs = fromFile.rows.reduce((rowIdxs, row, rowIdx) => {
								if (
									String(row[relationship.fromColumnIdx] || '').trim() &&
									String(row[Number(directColumn)] || '').trim()
								) {
									rowIdxs.push(rowIdx);
								}
								return rowIdxs;
							}, []);
							relationship.conflictRowIdxs = conflictRowIdxs;
							if (conflictRowIdxs.length > 0) {
								fromFile.relationshipErrors.push({
									fieldName: relationship.fromField,
									directHeader: fromFile.headers[Number(directColumn)],
									relationshipHeader: relationship.fromHeader,
									count: conflictRowIdxs.length,
									rowIdxs: conflictRowIdxs,
								});
							}
						}
					}
					refreshLinkStats(relationship);
				});
				fieldUseByFile.forEach((count, key) => {
					if (count < 2) {
						return;
					}
					const [fileIdx, fieldName] = key.split(':');
					const file = state.files[Number(fileIdx)];
					if (file) {
						file.relationshipErrors.push({
							fieldName,
							message: 'Only one relationship key can populate ' + fieldName + '.',
						});
					}
				});
				state.links = state.relationships;
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
					state.files = state.files.concat(valid);
					syncDuplicateFileNameNotice(state);
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
								file.mapping = uniqueDirectFieldMapping(
									csvAutoMapHeaders(file.headers, file.describe.fields || []),
								);
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
				state.relationships = (state.relationships || []).filter(
					(relationship) => relationship.fromFileIdx !== fileIdx,
				);
				file.relationshipChoices = {};
				file.objectName = objectName || null;
				if (objectName) {
					try {
						file.describe = await ensureDescribe(objectName);
						file.mapping = uniqueDirectFieldMapping(
							csvAutoMapHeaders(file.headers, file.describe.fields || []),
						);
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
				syncDuplicateFileNameNotice(state);
				state.relationships = (state.relationships || [])
					.filter((relationship) => relationship.fromFileIdx !== fileIdx)
					.map((relationship) => {
						if (relationship.fromFileIdx > fileIdx) {
							relationship.fromFileIdx--;
						}
						if (relationship.toFileIdx === fileIdx) {
							relationship.toFileIdx = null;
							relationship.toColumnIdx = null;
						} else if (relationship.toFileIdx > fileIdx) {
							relationship.toFileIdx--;
						}
						return relationship;
					});
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
				file.relationshipChoices = file.relationshipChoices || {};
				const relationshipValue = '__relationship_key__';
				if (fieldName && fieldName !== relationshipValue) {
					const existingColumnIdx = Object.keys(file.mapping).find(
						(otherColumnIdx) =>
							Number(otherColumnIdx) !== columnIdx && file.mapping[otherColumnIdx] === fieldName,
					);
					if (existingColumnIdx != null) {
						showBulkToast(
							fieldName +
								' is already mapped from ' +
								(file.headers[Number(existingColumnIdx)] || 'another CSV column') +
								'. Choose a different field or skip this column.',
							'error',
						);
						linkedCsvRender();
						return;
					}
				}
				const existingRelationship = (state.relationships || []).find(
					(relationship) => relationship.fromFileIdx === fileIdx && relationship.fromColumnIdx === columnIdx,
				);
				if (fieldName === relationshipValue) {
					file.relationshipChoices[columnIdx] = 'relationship';
					delete file.mapping[columnIdx];
					if (!existingRelationship) {
						addRelationshipForColumn(
							state,
							fileIdx,
							columnIdx,
							suggestRelationshipForColumn(state, fileIdx, columnIdx),
						);
					}
				} else {
					file.relationshipChoices[columnIdx] = 'declined';
					state.relationships = (state.relationships || []).filter(
						(relationship) =>
							relationship.fromFileIdx !== fileIdx || relationship.fromColumnIdx !== columnIdx,
					);
				}
				if (fieldName && fieldName !== relationshipValue) {
					file.mapping[columnIdx] = fieldName;
				} else if (fieldName !== relationshipValue) {
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

			function linkedCsvUpdateLinkTarget(linkIdx, targetValue) {
				const state = linkedCsvState;
				if (!state || !state.links || !state.links[linkIdx]) {
					return;
				}
				const link = state.links[linkIdx];
				const parts = String(targetValue || '').split(':');
				const nextFileIdx = parts.length === 2 ? Number(parts[0]) : null;
				const nextColumnIdx = parts.length === 2 ? Number(parts[1]) : null;
				link.toFileIdx = nextFileIdx;
				link.toColumnIdx =
					nextFileIdx === link.fromFileIdx && nextColumnIdx === link.fromColumnIdx ? null : nextColumnIdx;
				analyzeLinkedCsvs();
				linkedCsvRender();
			}

			function linkedCsvUpdateLinkField(linkIdx, fieldName) {
				const state = linkedCsvState;
				const link = state && state.links && state.links[linkIdx];
				if (!link) {
					return;
				}
				const fromFile = state.files[link.fromFileIdx];
				const targetFile = state.files[link.toFileIdx];
				const nextField = relationshipFieldsFor(fromFile).find((field) => field.name === fieldName);
				const preserveTarget = nextField && targetFile && nextField.referenceTo.includes(targetFile.objectName);
				link.fromField = fieldName || null;
				if (!preserveTarget) {
					link.toFileIdx = null;
					link.toColumnIdx = null;
				}
				analyzeLinkedCsvs();
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
									const mappedCount = Object.values(file.mapping || {}).filter(Boolean).length;
									const relationshipColumnIdxs = new Set(
										(state.links || [])
											.filter((link) => link.fromFileIdx === i && link.fromColumnIdx != null)
											.map((link) => link.fromColumnIdx),
									);
									const relationshipCount = relationshipColumnIdxs.size;
									const unmappedCount = file.headers.length - mappedCount - relationshipCount;
									const meta = file.objectName
										? '<span class="tag' +
											(unmappedCount > 0 ? ' warn' : '') +
											'">' +
											mappedCount +
											' field' +
											(mappedCount === 1 ? '' : 's') +
											(relationshipCount > 0
												? ' · ' +
													relationshipCount +
													' relationship key' +
													(relationshipCount === 1 ? '' : 's')
												: '') +
											(unmappedCount > 0 ? ' · ' + unmappedCount + ' skipped' : '') +
											'</span>'
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
									const mappingErrors = [];
									(file.lookupErrors || []).forEach((issue) => {
										mappingErrors.push(
											'<strong>' +
												escapeHtml(issue.header) +
												'</strong> → <code>' +
												escapeHtml(issue.fieldName) +
												'</code>: ' +
												issue.count +
												' value' +
												(issue.count === 1 ? '' : 's') +
												(issue.count === 1 ? ' is' : ' are') +
												' not Salesforce IDs.',
										);
									});
									duplicateDirectFieldMappings(file).forEach((issue) => {
										const field = (file.describe.fields || []).find(
											(candidate) => candidate.name === issue.fieldName,
										);
										mappingErrors.push(
											'<strong>' +
												issue.headers.map(escapeHtml).join(' and ') +
												'</strong> are both mapped to <code>' +
												escapeHtml((field && (field.label || field.name)) || issue.fieldName) +
												' (' +
												escapeHtml(issue.fieldName) +
												')</code>. Choose one source column.',
										);
									});
									const mappingErrorsHtml = mappingErrors
										.map(
											(message) =>
												'<div class="lcsv-perm-warn lcsv-map-error">' + message + '</div>',
										)
										.join('');
									let columnsHtml = '';
									if (file.objectName && file.describe && Array.isArray(file.describe.fields)) {
										const fieldOpts = file.describe.fields.slice().sort((a, b) => {
											if (a.name === 'Id') {
												return -1;
											}
											if (b.name === 'Id') {
												return 1;
											}
											return String(a.label || a.name).localeCompare(String(b.label || b.name));
										});
										const rows = file.headers
											.map((h, ci) => {
												const usedByRelationship = relationshipColumnIdxs.has(ci);
												const current = file.mapping[ci] || '';
												const opts =
													'<option value=""> - Skip - </option>' +
													'<option value="__relationship_key__"' +
													(usedByRelationship ? ' selected' : '') +
													'>Match to a related record in another CSV - not uploaded</option>' +
													fieldOpts
														.map((f) => {
															const mappedFromColumnIdx = Object.keys(
																file.mapping || {},
															).find(
																(columnIdx) =>
																	Number(columnIdx) !== ci &&
																	file.mapping[columnIdx] === f.name,
															);
															const mappedElsewhere = mappedFromColumnIdx != null;
															const mappedElsewhereSuffix = mappedElsewhere
																? ' - already mapped from ' +
																	(file.headers[Number(mappedFromColumnIdx)] ||
																		'another CSV column')
																: '';
															return (
																'<option value="' +
																escapeHtml(f.name) +
																'"' +
																(f.name === current ? ' selected' : '') +
																(mappedElsewhere ? ' disabled' : '') +
																'>' +
																escapeHtml(csvFieldOptionLabel(f)) +
																' (' +
																escapeHtml(f.name) +
																')' +
																escapeHtml(mappedElsewhereSuffix) +
																csvFieldAccessSuffix(f) +
																'</option>'
															);
														})
														.join('');
												const status = usedByRelationship
													? '<span class="lcsv-col-status mapped" title="Used by relationship">↗</span>'
													: current
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
										columnsHtml =
											'<details class="lcsv-cols" data-lcsv-cols="' +
											i +
											'"' +
											(file.columnsOpen ? ' open' : '') +
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
										mappingErrorsHtml +
										opPicker +
										columnsHtml +
										'</div>'
									);
								})
								.join('');
				const links = state.links || [];
				const orderedLinks = links
					.map((link, index) => ({ link, index }))
					.sort((left, right) => {
						const leftFileIdx =
							left.link.fromFileIdx == null ? Number.MAX_SAFE_INTEGER : left.link.fromFileIdx;
						const rightFileIdx =
							right.link.fromFileIdx == null ? Number.MAX_SAFE_INTEGER : right.link.fromFileIdx;
						return leftFileIdx - rightFileIdx || left.index - right.index;
					});
				const linksHtml =
					links.length === 0
						? '<p class="tag">No relationship columns selected. In a file\'s column mapper, choose “Match to a related record in another CSV - not uploaded” for a column that identifies a related record.</p>'
						: orderedLinks
								.map(({ link, index: i }, position) => {
									const fromFile = link.fromFileIdx == null ? null : state.files[link.fromFileIdx];
									const toFile = link.toFileIdx == null ? null : state.files[link.toFileIdx];
									const availableRelationshipFields = relationshipFieldsFor(fromFile);
									const compatibleRelationshipFields = toFile
										? availableRelationshipFields.filter((field) =>
												field.referenceTo.includes(toFile.objectName),
											)
										: availableRelationshipFields;
									const selectableRelationshipFields = compatibleRelationshipFields.filter(
										(field) =>
											field.name === link.fromField ||
											relationshipFieldAvailableForLink(state, i, link.fromFileIdx, field.name),
									);
									const lookupFieldOpts =
										'<option value=""> - Pick relationship - </option>' +
										selectableRelationshipFields
											.map(
												(field) =>
													'<option value="' +
													escapeHtml(field.name) +
													'"' +
													(field.name === link.fromField ? ' selected' : '') +
													'>' +
													escapeHtml(relationshipFieldLabel(field)) +
													' (' +
													escapeHtml(
														(fromFile && fromFile.objectName
															? fromFile.objectName + '.'
															: '') + field.name,
													) +
													')</option>',
											)
											.join('');
									const targetKeyOpts =
										'<option value=""> - Pick matching CSV value - </option>' +
										(link.compatibleToFileIdxs || [])
											.map((toFileIdx) =>
												state.files[toFileIdx].headers
													.map((header, columnIdx) => ({ header, columnIdx }))
													.filter(
														(entry) =>
															relationshipMatchTargetColumn(
																state.files[toFileIdx],
																entry.columnIdx,
															) &&
															(toFileIdx !== link.fromFileIdx ||
																entry.columnIdx !== link.fromColumnIdx),
													)
													.map(
														(entry) =>
															'<option value="' +
															toFileIdx +
															':' +
															entry.columnIdx +
															'"' +
															(toFileIdx === link.toFileIdx &&
															entry.columnIdx === link.toColumnIdx
																? ' selected'
																: '') +
															'>' +
															escapeHtml(
																(displayNames[toFileIdx] ||
																	state.files[toFileIdx].name) +
																	'.' +
																	(entry.header || '(blank)'),
															) +
															'</option>',
													)
													.join(''),
											)
											.join('');
									const complete =
										link.fromFileIdx != null &&
										link.fromColumnIdx != null &&
										!!link.fromField &&
										link.toFileIdx != null &&
										link.toColumnIdx != null;
									const sourceHeader =
										fromFile && link.fromColumnIdx != null
											? fromFile.headers[link.fromColumnIdx] || '(blank)'
											: '(source not selected)';
									const linkRelationshipErrors = fromFile
										? (fromFile.relationshipErrors || []).filter(
												(issue) =>
													issue.fieldName === link.fromField &&
													(!issue.relationshipHeader ||
														issue.relationshipHeader === sourceHeader),
											)
										: [];
									const hasLinkMappingErrors = linkRelationshipErrors.length > 0;
									const hasResolutionErrors =
										Number(link.unmatched || 0) > 0 ||
										Number(link.ambiguous || 0) > 0 ||
										(Array.isArray(link.duplicateTargetKeys) &&
											link.duplicateTargetKeys.length > 0);
									const stateClass =
										!complete || hasLinkMappingErrors || hasResolutionErrors
											? 'lcsv-link-empty'
											: link.matched === link.total
												? 'lcsv-link-full'
												: link.matched > 0
													? 'lcsv-link-partial'
													: 'lcsv-link-empty';
									const sourceKeyReference = fromFile
										? (displayNames[link.fromFileIdx] || fromFile.name) + '.' + sourceHeader
										: sourceHeader;
									const relationshipControl = shouldSelectRelationshipField(
										link,
										compatibleRelationshipFields,
									)
										? '<select class="lcsv-link-inline-select" aria-label="Relationship to set" data-lcsv-link-field="' +
											i +
											'">' +
											lookupFieldOpts +
											'</select>'
										: '<strong>' +
											escapeHtml(link.fromFieldLabel || link.fromField) +
											'</strong><code class="lcsv-link-reference">(' +
											escapeHtml(fromFile.objectName + '.' + link.fromField) +
											')</code>';
									const mixedSource =
										fromFile && link.fromField
											? mixedRelationshipSources(state, link.fromFileIdx).find(
													(source) =>
														source.fieldName === link.fromField &&
														source.relationshipHeader === sourceHeader,
												) || null
											: null;
									const sourceConflictError = linkRelationshipErrors.find(
										(issue) => !issue.message && Array.isArray(issue.rowIdxs),
									);
									const relationshipErrorsHtml = (
										sourceConflictError ? [sourceConflictError] : linkRelationshipErrors
									)
										.map((issue) => {
											if (issue.message) {
												return (
													'<div class="lcsv-perm-warn lcsv-map-error">' +
													escapeHtml(issue.message) +
													'</div>'
												);
											}
											const rowNumbers = (issue.rowIdxs || []).map((rowIdx) => rowIdx + 2);
											return (
												'<div class="lcsv-perm-warn lcsv-map-error">' +
												(rowNumbers.length === 1 ? 'Row ' : 'Rows ') +
												rowNumbers.join(', ') +
												(rowNumbers.length === 1 ? ' has both ' : ' have both ') +
												escapeHtml(issue.directHeader) +
												' and ' +
												escapeHtml(issue.relationshipHeader) +
												'. Edit the CSV so ' +
												(rowNumbers.length === 1 ? 'this row uses' : 'these rows use') +
												' only one, then re-import.</div>'
											);
										})
										.join('');
									const relationshipHelpText =
										'Org Loom uses this CSV column as a reference: its value finds a related record and sets the selected Salesforce lookup. The column itself is not uploaded.' +
										(mixedSource
											? ' Use one method per row: provide an existing Salesforce ID in ' +
												mixedSource.directHeader +
												', or use ' +
												mixedSource.relationshipHeader +
												' to find the related record in another CSV. Leave the unused column blank.'
											: '');
									const targetKeyReference = toFile
										? (displayNames[link.toFileIdx] || toFile.name) +
											'.' +
											(link.toHeader || '(target not selected)')
										: '(target not selected)';
									const resolutionErrorMessages = [];
									if (
										Array.isArray(link.duplicateTargetKeys) &&
										link.duplicateTargetKeys.length > 0
									) {
										const duplicateExamples = link.duplicateTargetKeys
											.slice(0, 3)
											.map(
												(item) =>
													'“' +
													escapeHtml(item.value) +
													'” appears in rows ' +
													item.toRowIdxs.map((rowIdx) => rowIdx + 2).join(', '),
											)
											.join('; ');
										resolutionErrorMessages.push(
											'<strong>' +
												escapeHtml(targetKeyReference) +
												' is not unique.</strong> ' +
												duplicateExamples +
												(link.duplicateTargetKeys.length > 3
													? '; and ' +
														(link.duplicateTargetKeys.length - 3) +
														' more duplicate values'
													: '') +
												'. Choose a unique target column or correct the duplicate values.',
										);
									}
									if (Array.isArray(link.unmatchedRows) && link.unmatchedRows.length > 0) {
										const unmatchedExamples = link.unmatchedRows
											.slice(0, 3)
											.map(
												(item) =>
													'“' +
													escapeHtml(item.value) +
													'” (row ' +
													(item.fromRowIdx + 2) +
													')',
											)
											.join(', ');
										resolutionErrorMessages.push(
											'<strong>' +
												link.unmatchedRows.length +
												' source row' +
												(link.unmatchedRows.length === 1 ? ' has' : 's have') +
												' no matching target.</strong> ' +
												unmatchedExamples +
												(link.unmatchedRows.length > 3
													? ', and ' + (link.unmatchedRows.length - 3) + ' more rows'
													: '') +
												'. Add the target row, correct the value, or leave the source key blank.',
										);
									}
									const resolutionErrorsHtml = hasLinkMappingErrors
										? ''
										: resolutionErrorMessages
												.map(
													(message) =>
														'<div class="lcsv-perm-warn lcsv-map-error">' +
														message +
														'</div>',
												)
												.join('');
									const previousLink = position > 0 ? orderedLinks[position - 1].link : null;
									const nextLink =
										position < orderedLinks.length - 1 ? orderedLinks[position + 1].link : null;
									const startsFileGroup =
										!previousLink || previousLink.fromFileIdx !== link.fromFileIdx;
									const endsFileGroup = !nextLink || nextLink.fromFileIdx !== link.fromFileIdx;
									const fileGroupCount = orderedLinks.filter(
										(entry) => entry.link.fromFileIdx === link.fromFileIdx,
									).length;
									const fileGroupName = fromFile
										? displayNames[link.fromFileIdx] || fromFile.name
										: 'Source file not selected';
									const fileGroupObject = fromFile
										? (fromFile.describe && fromFile.describe.label) || fromFile.objectName || 'CSV'
										: 'Complete these mappings';
									const fileGroupOpen = startsFileGroup
										? '<section class="lcsv-link-group" data-lcsv-relationship-file="' +
											(link.fromFileIdx == null ? '' : link.fromFileIdx) +
											'"><div class="lcsv-link-group-head"><strong>' +
											escapeHtml(fileGroupName) +
											'</strong><span>' +
											escapeHtml(fileGroupObject) +
											' · ' +
											fileGroupCount +
											' relationship' +
											(fileGroupCount === 1 ? '' : 's') +
											'</span></div><div class="lcsv-link-group-body">'
										: '';
									const fileGroupClose = endsFileGroup ? '</div></section>' : '';
									const cardOpen =
										'<div class="lcsv-link ' +
										stateClass +
										'" data-lcsv-relationship-source="' +
										(link.fromFileIdx == null || link.fromColumnIdx == null
											? ''
											: link.fromFileIdx + ':' + link.fromColumnIdx) +
										'" data-lcsv-relationship-field="' +
										escapeHtml(link.fromField || '') +
										'" data-lcsv-target-column="' +
										(link.toColumnIdx == null ? '' : link.toColumnIdx) +
										'">';
									return (
										fileGroupOpen +
										cardOpen +
										'<div class="lcsv-link-key-head"><code>' +
										escapeHtml(sourceKeyReference) +
										'</code><button type="button" class="lcsv-link-key-help" aria-label="About this relationship column" title="' +
										escapeHtml(relationshipHelpText) +
										'">?</button></div>' +
										'<div class="lcsv-link-summary"><div class="lcsv-link-sentence"><div class="lcsv-link-sentence-line"><span>Match against:</span><select class="lcsv-link-inline-select" aria-label="Matching target CSV value" data-lcsv-link-target="' +
										i +
										'">' +
										targetKeyOpts +
										'</select></div><span class="lcsv-link-flow-arrow" aria-hidden="true">→</span><div class="lcsv-link-sentence-line"><span>Populate:</span><div class="lcsv-link-set-control">' +
										relationshipControl +
										'</div></div></div></div>' +
										relationshipErrorsHtml +
										resolutionErrorsHtml +
										(complete && !hasLinkMappingErrors && !hasResolutionErrors && link.total > 0
											? '<div class="lcsv-link-stats"><strong>' +
												link.matched +
												'</strong> of <strong>' +
												link.total +
												'</strong> relationship values matched' +
												'</div>'
											: '') +
										'</div>' +
										fileGroupClose
									);
								})
								.join('');
				const _validForSummary = state.files.filter(
					(f) => f.objectName && Object.values(f.mapping).filter(Boolean).length > 0,
				);
				const _totalRowsForSummary = _validForSummary.reduce((n, f) => n + f.rows.length, 0);
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
				const dropzoneHtml = state.processingFiles
					? '<div class="lcsv-dropzone is-loading" tabindex="-1" aria-busy="true" aria-live="polite">' +
						'<span class="busy-spinner" aria-hidden="true"></span>' +
						'<strong>Reading CSV files…</strong>' +
						'<span class="tag">Checking rows and preparing field mappings.</span>' +
						'</div>'
					: canvasState.allObjects === null
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
							'<div class="lcsv-files">' +
							filesHtml +
							'</div>' +
							'</div>'
						: '') +
					(state.files.length > 0
						? '<div class="lcsv-step"><strong>Relationships</strong>' +
							'<p class="tag">Use this section when a value in one CSV row identifies a related record. These matching values build canvas relationships and are not uploaded as Salesforce field values.</p>' +
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
				body.querySelectorAll('[data-lcsv-link-target]').forEach((sel) => {
					sel.addEventListener('change', (e) =>
						linkedCsvUpdateLinkTarget(Number(e.target.dataset.lcsvLinkTarget), e.target.value),
					);
				});
				body.querySelectorAll('[data-lcsv-link-field]').forEach((sel) => {
					sel.addEventListener('change', (e) =>
						linkedCsvUpdateLinkField(Number(e.target.dataset.lcsvLinkField), e.target.value),
					);
				});
				body.querySelectorAll('[data-lcsv-cols]').forEach((details) => {
					details.addEventListener('toggle', () => {
						const fileIdx = Number(details.dataset.lcsvCols);
						if (state.files[fileIdx]) {
							state.files[fileIdx].columnsOpen = details.open;
						}
					});
				});
				body.querySelectorAll('[data-lcsv-col]').forEach((sel) => {
					sel.addEventListener('change', (e) => {
						const [fileIdx, colIdx] = e.target.dataset.lcsvCol.split(':').map(Number);
						const details = e.target.closest('[data-lcsv-cols]');
						if (details && state.files[fileIdx]) {
							state.files[fileIdx].columnsOpen = details.open;
						}
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
				const ready = linkedCsvReady(state);
				if (confirmBtn) {
					confirmBtn.disabled = !ready;
				}
				if (replaceBtn) {
					replaceBtn.disabled = !ready;
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
				if (!linkedCsvReady(state)) {
					showBulkToast('Fix the CSV mapping errors before importing.', 'error');
					linkedCsvRender();
					return;
				}
				const cellKey = (fi, ri) => fi + '|' + ri;
				const _idResolution = await csvResolveExistingIds(validFiles, state, cellKey);
				if (csvImportCanceled(state, linkedCsvState) || _idResolution.canceled) {
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
				const continueWithWritableFields =
					fieldPlan.issues.length === 0 || (await showFieldWriteReview(fieldPlan));
				if (csvImportCanceled(state, linkedCsvState) || !continueWithWritableFields) {
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
				const existingCanvasById = new Map();
				const mergeQueue = [];
				let mergeSkippedNoModal = 0;
				let unchangedCount = 0;
				if (!shouldReplace) {
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
				const _undoImport = captureUndoSnapshot ? captureUndoSnapshot() : null;
				const selByName = new Map();
				for (const file of validFiles) {
					let sel = canvasState.selectedObjects.find((s) => s.name === file.objectName);
					if (!sel) {
						try {
							sel = await addToSelection(file.objectName);
						} catch (e) {
							console.warn('addToSelection failed for', file.objectName, e);
							continue;
						}
						if (csvImportCanceled(state, linkedCsvState)) {
							return;
						}
					}
					selByName.set(file.objectName, sel);
				}
				if (csvImportCanceled(state, linkedCsvState)) {
					return;
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
						if (sfId) {
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
					const resolution = resolveRelationshipRows(
						fromFile.rows,
						link.fromColumnIdx,
						toFile.rows,
						link.toColumnIdx,
					);
					resolution.matches.forEach(({ fromRowIdx, toRowIdx }) => {
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
						linkedCount++;
					});
				});
				const totalRecords = validFiles.reduce((n, f) => n + f.rows.length, 0);
				const fileCount = validFiles.length;
				closeLinkedCsvModal(true);
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

			return {
				openModal: openLinkedCsvModal,
				closeModal: closeLinkedCsvModal,
			};
		},
	};
})();
