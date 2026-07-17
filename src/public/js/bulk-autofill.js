// Bulk autofill + clear-all-fields.
//
//   bulkAutoFill(scope, fieldType, opts)
//     "Fill required fields" / "Fill all fields" actions from the
//     Bulk operations menu. Walks every draft on the canvas, runs
//     sampleValueForField per empty field, and writes a sensible
//     default. NEVER modifies a field that already has a value:
//     auto-fill is strictly additive on empty slots. Skips loaded
//     records, type-nodes, and pending placeholders.
//   bulkClearAllFields()
//     "Clear all fields" with a confirm dialog. Wipes every drafted
//     record's values on the canvas: loaded records keep their
//     loadedValues unchanged.
//
// Dependencies passed to mount(): see the required list in code.
// Several deps (sampleValueForField, fieldTypeFilter) live on the
// insert-modal module; they're wrapped lazily so this can mount
// before insert-modal in the boot chain.
//
// Exposed as window.OrgLoom.bulkAutofill. Load order: before app.js.

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
			// Optional: action-toast for the post-run Undo. Fill/clear mutate
			// rec.values in place, so the canvas-level snapshot the importers
			// use doesn't cover them: undo here is a per-record VALUES
			// snapshot instead.
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

			// Capture pre-operation values, then arm Undo only for records the
			// operation genuinely touched. The armed closure records each
			// post-operation revision/reference/fingerprint. Any later mutation
			// to a touched record invalidates the WHOLE undo, preventing an old
			// bulk snapshot from erasing newer manual work.
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

			// Return an honest preview of what Auto-fill can populate. Reference
			// fields are different from scalar fields: unless a safe smart default
			// exists, Auto-fill must not invent a Salesforce Id or choose a parent
			// record for the user. Existing canvas associations satisfy the field;
			// unresolved references are reported separately so the UI never claims
			// they "will be filled."
			function summarizeAutoFillTargets(records, scope, fieldType) {
				const linkedFieldsByRecord = new Map();
				(canvasState.bulkAssociations || []).forEach((association) => {
					if (!association || association.fromId == null || !association.fieldName) {
						return;
					}
					let linked = linkedFieldsByRecord.get(association.fromId);
					if (!linked) {
						linked = new Set();
						linkedFieldsByRecord.set(association.fromId, linked);
					}
					linked.add(association.fieldName);
				});

				let fillableFields = 0;
				let unresolvedRelationships = 0;
				const relationshipLabels = new Set();
				const typePick = fieldTypeFilter(fieldType || 'both');
				for (const rec of records || []) {
					const describe = canvasState.describeCache[rec.objectName];
					if (!describe || !Array.isArray(describe.fields)) {
						return null;
					}
					const values = rec.values || {};
					const linkedFields = linkedFieldsByRecord.get(rec.id) || new Set();
					for (const f of describe.fields) {
						if (!f || !f.name || (scope === 'required' && !f.required) || !typePick(f)) {
							continue;
						}
						const existing = values[f.name];
						const hasValue = existing !== undefined && existing !== '' && existing !== null;
						if (hasValue || (f.type === 'reference' && linkedFields.has(f.name))) {
							continue;
						}
						if (f.type === 'reference' && !getSmartDefault(rec.objectName, f.name)) {
							unresolvedRelationships++;
							relationshipLabels.add(f.label || f.name);
							continue;
						}
						fillableFields++;
					}
				}
				return {
					fillableFields,
					unresolvedRelationships,
					relationshipLabels: Array.from(relationshipLabels),
				};
			}

			async function bulkAutoFill(scope, fieldType, opts) {
				opts = opts || {};
				const onlyIds = Array.isArray(opts.tempIds) && opts.tempIds.length > 0
					? new Set(opts.tempIds)
					: null;
				// tempIds is a mechanical snapshot (the modal passes it for
				// EVERY scope so a drifting live selection can't change the
				// run): it does NOT mean the user chose "Selected". Copy that
				// says "selected" keys on this explicit flag; the tempIds
				// fallback keeps legacy direct callers reading as before.
				const selectionScope = opts.selectionScope !== undefined ? !!opts.selectionScope : !!onlyIds;
				const silent = !!opts.silent;
				// includeLoaded: when true, auto-fill also operates on
				// loaded-existing records. The per-field fill logic
				// further down still only fills EMPTY fields, so SF
				// values are never overwritten by fill; only
				// previously-empty fields get a value. Loaded records
				// touched this way pick up the modified badge so the
				// next upload pushes the new fields to SF. Default
				// false preserves the historical "loaded records are
				// not touched" guarantee for all existing callers
				// (AI proposal apply, manifest seed, etc.).
				const includeLoaded = !!opts.includeLoaded;
				if (canvasState.bulkRecords.length === 0) {
					if (!silent) {
showBulkToast('No records to fill.');
}
					return;
				}
				// Eligibility: drafts always in. Loaded records only when
				// includeLoaded is set (the modal's "All existing" /
				// "Selected" scopes pass this). Type-nodes and pending
				// placeholders are transient render states with no real
				// values; always excluded (the modal pre-filters these,
				// but direct callers (AI proposal apply, manifest seed)
				// don't).
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
						? 'No draft records to fill. Seed only applies to new records; loaded-existing records keep their Salesforce values.'
						: 'No records to fill.';
					if (!silent) {
showBulkToast(msg);
}
					return;
				}
				const objectNames = Array.from(new Set(draftRecords.map(r => r.objectName)));

				// Confirm dialog. Skipped when `silent` is set: the AI
				// proposal-apply path passes silent:true because the user
				// already consented to the proposal as a whole. Direct
				// invocations from the Bulk Operations menu always confirm
				// so the user knows which records will be modified and
				// what gets filled.
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
						? '• Adds sample data to empty required fields. Required relationships still need canvas connections.'
						: '• Adds sample data to empty fields. Relationship fields still need canvas connections.';
					// Skip-loaded line: when scoped to a selection, the
					// "skipped loaded on canvas" count would mislead (the
					// user is operating on a subset; loaded records they
					// didn't select aren't relevant). Just say which
					// scope we're operating on.
					const skipLine = selectionScope
						? '• Only draft records in your selection are changed.'
						: (skippedLoaded > 0
							? '• Skips ' + skippedLoaded + ' loaded Salesforce record' + (skippedLoaded === 1 ? '' : 's') + ' on the canvas; only draft records are changed.'
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
				// Load smart defaults in parallel with describe/rules. They
				// supply sane lookup ids for required reference fields the
				// generic sample pass would otherwise leave empty (e.g.,
				// User.ProfileId → Standard User profile id).
				Promise.all([
					loadSmartDefaults(),
					...objectNames.map(n => ensureDescribe(n)),
				])
					.then(() => {
						// Values snapshot for the post-fill Undo toast:
						// captured before any record is touched.
						const _undo = _captureValuesUndo(draftRecords);
						let touchedCount = 0;
						const touchedRecords = [];
						draftRecords.forEach(rec => {
							const describe = canvasState.describeCache[rec.objectName];
							if (!describe || !describe.fields) {
return;
}
							const values = Object.assign({}, rec.values || {});
							// User records: force IsActive=false on seed.
							// Suppresses Salesforce welcome emails on insert
							// and prevents unintended provisioning until the
							// admin explicitly activates the user.
							if (rec.objectName === 'User'
								&& (values.IsActive === undefined || values.IsActive === '' || values.IsActive === null)) {
								values.IsActive = false;
							}
							// Record type for THIS record: required so dependent
							// picklists can be filtered against the right controller
							// values map during the sample pass.
							const recRtId = (values.RecordTypeId) || describe.defaultRecordTypeId || null;
							let touched = false;
							// Controllers first, so dependent picklists see the
							// just-chosen controller value when filtering.
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
									// Reference field with a known smart default
									// (e.g., User.ProfileId → Standard User id):
									// honor it before falling back to sampleValueForField.
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
							// User IsActive=false counts as "touched" if it wasn't
							// already set, so the toast count reflects that.
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
						// "draft record" is only accurate when loaded records
						// were excluded from the scope.
						const recNoun = includeLoaded ? 'record' : 'draft record';
						const scopeNote = selectionScope ? ' selected' : '';
						const remaining = summarizeAutoFillTargets(draftRecords, scope, fieldType);
						const relationshipCount = remaining ? remaining.unresolvedRelationships : 0;
						const relationshipNote = relationshipCount > 0
							? ' ' + relationshipCount + (scope === 'required' ? ' required' : '') +
								' relationship' + (relationshipCount === 1 ? '' : 's') +
								' still need' + (relationshipCount === 1 ? 's' : '') + ' a canvas connection.'
							: '';
						const _msg = 'Pre-filled ' + label + ' on ' + touchedCount + scopeNote + ' ' + recNoun + (touchedCount === 1 ? '' : 's') + '.' + relationshipNote + skipNote;
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
			
			// Wipe every field value from draft records on the canvas.
			// Loaded-existing records are skipped (the same constraint
			// bulkAutoFill applies; they hold real Salesforce values).
			// Confirms before wiping; there's no undo.
			//
			// opts.tempIds: optional array of record ids to scope the
			// clear to a selection. When omitted, every draft on the
			// canvas is targeted. Same shape as bulkAutoFill's opts so
			// the bulk-ops menu can pass selection through uniformly.
			async function bulkClearAllFields(opts) {
				opts = opts || {};
				const onlyIds = Array.isArray(opts.tempIds) && opts.tempIds.length > 0
					? new Set(opts.tempIds)
					: null;
				// See bulkAutoFill: tempIds is a snapshot, not a statement of
				// scope; "selected" copy keys on the explicit flag.
				const selectionScope = opts.selectionScope !== undefined ? !!opts.selectionScope : !!onlyIds;
				// includeLoaded: when true, also wipe loaded-existing
				// records. This IS destructive in a different way than
				// clearing drafts: it marks loaded records modified,
				// and the next upload nulls those fields out in SF.
				// The caller (typically the auto-fill modal's "All
				// existing" / "Selected" scopes) is expected to surface
				// that consequence in its own confirmation copy; the
				// confirm dialog below picks up amended wording when
				// includeLoaded is set so the user sees the SF impact
				// here too.
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
						? 'No draft records in the selection. Clear only applies to drafts; loaded-existing records keep their Salesforce values.'
						: (skippedLoaded > 0
							? 'No draft records to clear. Clear only applies to drafts; loaded-existing records keep their Salesforce values.'
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
				// Skip-loaded line. Three cases:
				//   * includeLoaded: call out SF impact (uploading after
				//     this wipes those fields in Salesforce).
				//   * onlyIds (draft-only scope): say "your selection."
				//   * default: surface the count of skipped loaded
				//     records on the canvas.
				let skipLine;
				if (includeLoaded && loadedInScope > 0) {
					skipLine = '\u2022 Includes ' + loadedInScope + ' loaded Salesforce record' +
						(loadedInScope === 1 ? '' : 's') +
						': next upload will NULL those fields in Salesforce.';
				} else if (selectionScope) {
					skipLine = '\u2022 Only draft records in your selection are wiped.';
				} else if (skippedLoaded > 0) {
					skipLine = '\u2022 Skips ' + skippedLoaded + ' loaded Salesforce record' +
						(skippedLoaded === 1 ? '' : 's') +
						' on the canvas; only draft records are wiped.';
				} else {
					skipLine = '\u2022 Only draft records on the canvas are wiped.';
				}
				const scopeQualifier = selectionScope
					? ' selected'
					: (includeLoaded ? '' : ' draft');
				const noun = includeLoaded ? recordWord : ('draft ' + recordWord);
				const ok = await showConfirmDialog({
					title: includeLoaded && loadedInScope > 0 ? 'Clear fields (including Salesforce records)?' : 'Clear all fields?',
					message:
						'Wipe every field value from ' + draftRecords.length + scopeQualifier + ' ' + noun +
						' (' + objSummary + moreObjs + ').\n\n' +
						'What this does:\n' +
						'\u2022 Removes every value from each record (required and optional fields).\n' +
						skipLine + '\n' +
						'\u2022 You can Undo from the toast right after; once it expires, the values are gone.',
					confirmLabel: 'Clear fields',
					danger: true,
				});
				if (!ok) {
return;
}
				// Values snapshot for the post-clear Undo toast: captured
				// before any record is touched.
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
				// "draft record" is only accurate when loaded records were
				// excluded from the scope.
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
				summarizeAutoFillTargets: summarizeAutoFillTargets,
			};
		},
	};
})();
