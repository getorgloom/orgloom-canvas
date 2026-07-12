(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.bulkAutofill = {
		mount: function mount(deps) {
			const required = [
				'canvasState', 'ensureDescribe',
				'fieldTypeFilter', 'getSmartDefault', 'renderBulkView',
				'sampleValueForField', 'showBulkToast',
				'showConfirmDialog',
				'loadSmartDefaults',
			];
			if (!deps) {
throw new Error('bulk-autofill.mount: missing deps object');
}
			for (const k of required) {
				if (deps[k] === undefined || deps[k] === null) {
					throw new Error('bulk-autofill.mount: missing dep ' + k);
				}
			}
			const canvasState = deps.canvasState;
			const ensureDescribe = deps.ensureDescribe;
			const fieldTypeFilter = deps.fieldTypeFilter;
			const getSmartDefault = deps.getSmartDefault;
			const renderBulkView = deps.renderBulkView;
			const sampleValueForField = deps.sampleValueForField;
			const showBulkToast = deps.showBulkToast;
			const showConfirmDialog = deps.showConfirmDialog;
			const loadSmartDefaults = deps.loadSmartDefaults;

			const showBulkToastWithAction = typeof deps.showBulkToastWithAction === 'function'
				? deps.showBulkToastWithAction : null;

			function _replaceValues(rec, values) {
				rec.values = values;
				rec._valuesRevision = (Number(rec._valuesRevision) || 0) + 1;
			}

			function _valuesFingerprint(values) {
				try {
					return JSON.stringify(values || {});
				} catch (_e) {
					return null;
				}
			}

			function _captureValuesUndo(records) {
				const priorByRecord = new Map(records.map((r) => [r, r.values]));
				return function arm(touchedRecords) {
					const entries = touchedRecords.map((rec) => ({
						rec: rec,
						priorValues: priorByRecord.get(rec),
						expectedRevision: Number(rec._valuesRevision) || 0,
						expectedValues: rec.values,
						expectedFingerprint: _valuesFingerprint(rec.values),
					}));
					return function restore() {
						const stale = entries.some((p) =>
							(Number(p.rec._valuesRevision) || 0) !== p.expectedRevision ||
							p.rec.values !== p.expectedValues ||
							_valuesFingerprint(p.rec.values) !== p.expectedFingerprint
						);
						if (stale) {
							showBulkToast(
								'Can\u2019t undo Auto-fill because one or more affected records were edited afterward.',
								'info',
							);
							return;
						}
						entries.forEach((p) => _replaceValues(p.rec, p.priorValues));
						renderBulkView();
						showBulkToast('Restored the previous field values.');
					};
				};
			}

			async function bulkAutoFill(scope, fieldType, opts) {
				opts = opts || {};
				const onlyIds = Array.isArray(opts.tempIds) && opts.tempIds.length > 0
					? new Set(opts.tempIds)
					: null;

				const selectionScope = opts.selectionScope !== undefined ? !!opts.selectionScope : !!onlyIds;
				const silent = !!opts.silent;

				const includeLoaded = !!opts.includeLoaded;
				if (canvasState.bulkRecords.length === 0) {
					if (!silent) {
showBulkToast('No records to fill.');
}
					return;
				}

				let draftRecords = canvasState.bulkRecords.filter((r) => {
					if (r.isTypeNode || r.isPending) {
return false;
}
					if (r.loadedFromId && !includeLoaded) {
return false;
}
					return true;
				});
				const skippedLoaded = includeLoaded
					? 0
					: canvasState.bulkRecords.filter((r) => r.loadedFromId && !r.isTypeNode).length;
				if (onlyIds) {
draftRecords = draftRecords.filter((r) => onlyIds.has(r.id));
}
				if (draftRecords.length === 0) {
					const msg = skippedLoaded > 0
						? 'No draft records to fill. Seed only applies to new records - loaded-existing records keep their Salesforce values.'
						: 'No records to fill.';
					if (!silent) {
showBulkToast(msg);
}
					return;
				}
				const objectNames = Array.from(new Set(draftRecords.map(r => r.objectName)));

				if (!silent) {
					const objCounts = new Map();
					draftRecords.forEach((r) => {
						objCounts.set(r.objectName, (objCounts.get(r.objectName) || 0) + 1);
					});
					const objSummary = Array.from(objCounts.entries())
						.sort((a, b) => b[1] - a[1])
						.slice(0, 3)
						.map(([name, n]) => n + ' ' + name)
						.join(', ');
					const moreObjs = objCounts.size > 3 ? ' + ' + (objCounts.size - 3) + ' more' : '';
					const recordWord = draftRecords.length === 1 ? 'record' : 'records';
					const scopeNoun = scope === 'required' ? 'required' : 'all';
					const scopeLine = scope === 'required'
						? '• Fills empty required fields only. Fields that already have a value are left alone.'
						: '• Fills every empty field (required and optional). Fields that already have a value are left alone.';

					const skipLine = selectionScope
						? '• Only draft records in your selection are changed.'
						: (skippedLoaded > 0
							? '• Skips ' + skippedLoaded + ' loaded Salesforce record' + (skippedLoaded === 1 ? '' : 's') + ' on the canvas - only draft records are changed.'
							: '• Only draft records on the canvas are changed.');
					const scopeQualifier = selectionScope ? ' selected' : '';
					const message =
						'Fill ' + scopeNoun + ' fields on ' + draftRecords.length + scopeQualifier + ' draft ' + recordWord +
						' (' + objSummary + moreObjs + ').\n\n' +
						'What this does:\n' +
						scopeLine + '\n' +
						skipLine + '\n\n' +
						'Sample data is fictional (e.g. "Acme Corp", "name@example.com"). You can edit any field afterward.';
					const ok = await showConfirmDialog({
						title: scope === 'required' ? 'Fill required fields?' : 'Fill all fields?',
						message: message,
						confirmLabel: scope === 'required' ? 'Fill required' : 'Fill all',
					});
					if (!ok) {
return;
}
				}

				Promise.all([
					loadSmartDefaults(),
					...objectNames.map(n => ensureDescribe(n)),
				])
					.then(() => {

						const _undo = _captureValuesUndo(draftRecords);
						let touchedCount = 0;
						const touchedRecords = [];
						draftRecords.forEach(rec => {
							const describe = canvasState.describeCache[rec.objectName];
							if (!describe || !describe.fields) {
return;
}
							const values = Object.assign({}, rec.values || {});

							if (rec.objectName === 'User'
								&& (values.IsActive === undefined || values.IsActive === '' || values.IsActive === null)) {
								values.IsActive = false;
							}

							const recRtId = (values.RecordTypeId) || describe.defaultRecordTypeId || null;
							let touched = false;

							const ordered = [
								...describe.fields.filter(f => !f.controllerName),
								...describe.fields.filter(f => f.controllerName),
							];
							const typePick = fieldTypeFilter(fieldType);
							ordered.forEach(f => {
								if (scope === 'required' && !f.required) {
return;
}
								if (!typePick(f)) {
return;
}
								const existing = values[f.name];
								if (existing === undefined || existing === '' || existing === null) {

									if (f.type === 'reference') {
										const smartId = getSmartDefault(rec.objectName, f.name);
										if (smartId) {
											values[f.name] = smartId;
											touched = true;
											return;
										}
									}
									const sample = sampleValueForField(f, describe.fields, values, recRtId, rec.objectName);
									if (sample !== undefined && sample !== '' && sample !== null) {
										values[f.name] = sample;
										touched = true;
									}
								}
							});

							if (rec.objectName === 'User' && rec.values && rec.values.IsActive !== values.IsActive) {
								touched = true;
							}
							if (touched) {
								_replaceValues(rec, values);
								touchedRecords.push(rec);
								touchedCount++;
							}
						});
						renderBulkView();
						const label = scope === 'required' ? 'required fields' : 'all fields';
						const skipNote = skippedLoaded > 0
							? ' Skipped ' + skippedLoaded + ' loaded record' + (skippedLoaded === 1 ? '' : 's') + ' (Seed only applies to drafts).'
							: '';

						const recNoun = includeLoaded ? 'record' : 'draft record';
						const scopeNote = selectionScope ? ' selected' : '';
						const _msg = 'Pre-filled ' + label + ' on ' + touchedCount + scopeNote + ' ' + recNoun + (touchedCount === 1 ? '' : 's') + '.' + skipNote;
						if (!silent) {
							if (touchedCount > 0 && showBulkToastWithAction) {
								showBulkToastWithAction(_msg, 'Undo', _undo(touchedRecords));
							} else {
								showBulkToast(_msg);
							}
						}
					})
					.catch(err => {
						if (!silent) {
showBulkToast('Failed to load field metadata: ' + (err.message || err), 'error');
}
					});
			}

			async function bulkClearAllFields(opts) {
				opts = opts || {};
				const onlyIds = Array.isArray(opts.tempIds) && opts.tempIds.length > 0
					? new Set(opts.tempIds)
					: null;

				const selectionScope = opts.selectionScope !== undefined ? !!opts.selectionScope : !!onlyIds;

				const includeLoaded = !!opts.includeLoaded;
				if (canvasState.bulkRecords.length === 0) {
					showBulkToast('No records to clear.');
					return;
				}
				let draftRecords = canvasState.bulkRecords.filter((r) => {
					if (r.isTypeNode || r.isPending) {
return false;
}
					if (r.loadedFromId && !includeLoaded) {
return false;
}
					return true;
				});
				const skippedLoaded = includeLoaded
					? 0
					: canvasState.bulkRecords.filter((r) => r.loadedFromId && !r.isTypeNode).length;
				if (onlyIds) {
draftRecords = draftRecords.filter((r) => onlyIds.has(r.id));
}
				if (draftRecords.length === 0) {
					const msg = onlyIds
						? 'No draft records in the selection. Clear only applies to drafts - loaded-existing records keep their Salesforce values.'
						: (skippedLoaded > 0
							? 'No draft records to clear. Clear only applies to drafts - loaded-existing records keep their Salesforce values.'
							: 'No records to clear.');
					showBulkToast(msg);
					return;
				}
				const loadedInScope = includeLoaded
					? draftRecords.filter((r) => r.loadedFromId).length
					: 0;
				const recordWord = draftRecords.length === 1 ? 'record' : 'records';
				const objCounts = new Map();
				draftRecords.forEach((r) => {
					objCounts.set(r.objectName, (objCounts.get(r.objectName) || 0) + 1);
				});
				const objSummary = Array.from(objCounts.entries())
					.sort((a, b) => b[1] - a[1])
					.slice(0, 3)
					.map(([name, n]) => n + ' ' + name)
					.join(', ');
				const moreObjs = objCounts.size > 3 ? ' + ' + (objCounts.size - 3) + ' more' : '';

				let skipLine;
				if (includeLoaded && loadedInScope > 0) {
					skipLine = '\u2022 Includes ' + loadedInScope + ' loaded Salesforce record' +
						(loadedInScope === 1 ? '' : 's') +
						' - next upload will NULL those fields in Salesforce.';
				} else if (selectionScope) {
					skipLine = '\u2022 Only draft records in your selection are wiped.';
				} else if (skippedLoaded > 0) {
					skipLine = '\u2022 Skips ' + skippedLoaded + ' loaded Salesforce record' +
						(skippedLoaded === 1 ? '' : 's') +
						' on the canvas - only draft records are wiped.';
				} else {
					skipLine = '\u2022 Only draft records on the canvas are wiped.';
				}
				const scopeQualifier = selectionScope
					? ' selected'
					: (includeLoaded ? '' : ' draft');
				const noun = includeLoaded ? recordWord : ('draft ' + recordWord);
				const ok = await showConfirmDialog({
					title: includeLoaded && loadedInScope > 0 ? 'Clear fields - including Salesforce records?' : 'Clear all fields?',
					message:
						'Wipe every field value from ' + draftRecords.length + scopeQualifier + ' ' + noun +
						' (' + objSummary + moreObjs + ').\n\n' +
						'What this does:\n' +
						'\u2022 Removes every value from each record (required and optional fields).\n' +
						skipLine + '\n' +
						'\u2022 You can Undo from the toast right after - once it expires, the values are gone.',
					confirmLabel: 'Clear fields',
					danger: true,
				});
				if (!ok) {
return;
}

				const _undo = _captureValuesUndo(draftRecords);
				let touchedCount = 0;
				const touchedRecords = [];
				draftRecords.forEach((rec) => {
					const hadValues = rec.values && Object.keys(rec.values).length > 0;
					if (hadValues) {
						_replaceValues(rec, {});
						touchedRecords.push(rec);
						touchedCount++;
}
				});
				renderBulkView();
				const skipNote = selectionScope
					? ''
					: (skippedLoaded > 0
						? ' Skipped ' + skippedLoaded + ' loaded record' + (skippedLoaded === 1 ? '' : 's') + ' (Clear only applies to drafts).'
						: '');
				const scopeNote = selectionScope ? ' selected' : '';

				const recNoun = includeLoaded ? 'record' : 'draft record';
				const _msg = 'Cleared all fields on ' + touchedCount + scopeNote + ' ' + recNoun + (touchedCount === 1 ? '' : 's') + '.' + skipNote;
				if (touchedCount > 0 && showBulkToastWithAction) {
					showBulkToastWithAction(_msg, 'Undo', _undo(touchedRecords));
				} else {
					showBulkToast(_msg);
				}
			}

			return {
				bulkAutoFill: bulkAutoFill,
				bulkClearAllFields: bulkClearAllFields,
			};
		},
	};
})();
