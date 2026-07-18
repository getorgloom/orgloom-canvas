(function () {
	'use strict';
	// Guides destination matching and field mapping without mutating Salesforce until upload.

	window.OrgLoom = window.OrgLoom || {};

	// Match keys must also be marked filterable by the destination describe response.
	const KEYABLE_TYPES = new Set([
		'string',
		'email',
		'phone',
		'url',
		'textarea',
		'int',
		'double',
		'currency',
		'percent',
	]);

	function _distinctObjects(canvasState) {
		const map = new Map(); // objectName -> records[]
		(canvasState.bulkRecords || []).forEach((r) => {
			if (!r || r.isTypeNode || !r.objectName) {
				return;
			}
			if (!map.has(r.objectName)) {
				map.set(r.objectName, []);
			}
			map.get(r.objectName).push(r);
		});
		return map;
	}

	function _keyCandidates(describe) {
		const fields = ((describe && describe.fields) || []).filter(
			(f) => f && f.name && f.filterable === true && KEYABLE_TYPES.has(f.type),
		);
		function rank(f) {
			if (f.externalId || f.idLookup) {
				return 0;
			}
			if (f.unique) {
				return 1;
			}
			if (f.nameField) {
				return 2;
			}
			return 3;
		}
		return fields
			.slice()
			.sort((a, b) => rank(a) - rank(b) || String(a.label || a.name).localeCompare(String(b.label || b.name)));
	}

	function _tierLabel(f) {
		if (f.externalId || f.idLookup) {
			return ' (external id)';
		}
		if (f.unique) {
			return ' (unique)';
		}
		if (f.nameField) {
			return ' (name)';
		}
		return '';
	}

	function _preferredKeyCandidate(describe, rec) {
		return (
			_keyCandidates(describe).find((field) => {
				const value = _lookup(rec && rec.values, field.name);
				return value !== null && value !== undefined && String(value) !== '';
			}) || null
		);
	}

	function _lookup(values, fieldName) {
		if (!values || !fieldName) {
			return undefined;
		}
		if (Object.prototype.hasOwnProperty.call(values, fieldName)) {
			return values[fieldName];
		}
		const lk = String(fieldName).toLowerCase();
		const keys = Object.keys(values);
		for (let i = 0; i < keys.length; i++) {
			if (keys[i].toLowerCase() === lk) {
				return values[keys[i]];
			}
		}
		return undefined;
	}

	function _clearMatchState(rec) {
		if (rec._migrateMatchedId) {
			delete rec.loadedFromId;
		}
		delete rec._migrateMatchedId;
		delete rec._migrateMatchKey;
		delete rec._migrateMatchValue;
		delete rec._migrateMatchAmbiguous;
		delete rec._migrateMatchResolution;
		delete rec._migrateMatchIntent;
		delete rec._migrateMatchCandidates;
		delete rec._migrateMatchSearched;
		delete rec._migrateMatchSearchError;
	}

	function _clone(value) {
		if (value === undefined) {
			return undefined;
		}
		return JSON.parse(JSON.stringify(value));
	}

	function _displayValue(value) {
		if (value === null || value === undefined || value === '') {
			return '(empty)';
		}
		if (typeof value === 'object') {
			try {
				return JSON.stringify(value, null, 2);
			} catch (_e) {
				return '(structured value)';
			}
		}
		return String(value);
	}

	function _activePicklistValues(field) {
		return ((field && field.picklistValues) || [])
			.filter((entry) => entry && entry.active !== false && entry.value !== undefined)
			.map((entry) => String(entry.value));
	}

	function _fieldMapDisposition(raw, field) {
		if (!field || !field.name || raw === null || raw === undefined || typeof raw === 'object') {
			return 'incompatible';
		}
		const type = String(field.type || 'string').toLowerCase();
		if (['reference', 'address', 'location', 'base64', 'complexvalue', 'anytype'].includes(type)) {
			return 'incompatible';
		}
		if (type === 'picklist') {
			const allowed = _activePicklistValues(field);
			if (!allowed.length) {
				return 'incompatible';
			}
			return allowed.includes(String(raw)) ? 'direct' : 'choice';
		}
		if (type === 'multipicklist') {
			const allowed = new Set(_activePicklistValues(field));
			const values = String(raw)
				.split(';')
				.map((value) => value.trim())
				.filter(Boolean);
			return values.length > 0 && values.every((value) => allowed.has(value)) ? 'direct' : 'incompatible';
		}
		if (['int', 'double', 'currency', 'percent'].includes(type)) {
			if (typeof raw === 'string' && raw.trim() === '') {
				return 'incompatible';
			}
			const number = Number(raw);
			return Number.isFinite(number) && (type !== 'int' || Number.isInteger(number)) ? 'direct' : 'incompatible';
		}
		if (type === 'boolean') {
			return typeof raw === 'boolean' || /^(true|false)$/i.test(String(raw)) ? 'direct' : 'incompatible';
		}
		if (type === 'date') {
			const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw));
			if (!match) {
				return 'incompatible';
			}
			const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
			return date.getUTCFullYear() === Number(match[1]) &&
				date.getUTCMonth() === Number(match[2]) - 1 &&
				date.getUTCDate() === Number(match[3])
				? 'direct'
				: 'incompatible';
		}
		if (type === 'datetime') {
			return Number.isFinite(Date.parse(String(raw))) ? 'direct' : 'incompatible';
		}
		if (type === 'time') {
			return /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z)?$/.test(String(raw))
				? 'direct'
				: 'incompatible';
		}
		if (
			Number.isFinite(Number(field.length)) &&
			Number(field.length) >= 0 &&
			String(raw).length > Number(field.length)
		) {
			return 'incompatible';
		}
		return 'direct';
	}

	function _candidateList(candidatesByValue, value) {
		if (!candidatesByValue || value === null || value === undefined) {
			return [];
		}
		const exact = candidatesByValue[String(value)];
		if (Array.isArray(exact)) {
			return exact;
		}
		const wanted = String(value).toLowerCase();
		const key = Object.keys(candidatesByValue).find((k) => k.toLowerCase() === wanted);
		return key && Array.isArray(candidatesByValue[key]) ? candidatesByValue[key] : [];
	}

	function _applyMatchResponse(recs, keyField, data) {
		const candidatesByValue = (data && data.candidatesByValue) || {};
		const byValue = new Map();
		recs.forEach((rec) => {
			const raw = _lookup(rec.values, keyField);
			rec._migrateMatchKey = keyField;
			rec._migrateMatchValue = raw == null ? '' : String(raw);
			if (raw === null || raw === undefined || String(raw) === '') {
				return;
			}
			const value = String(raw);
			if (!byValue.has(value)) {
				byValue.set(value, []);
			}
			byValue.get(value).push(rec);
		});

		let matched = 0;
		let unresolved = 0;
		byValue.forEach((sourceRecords, value) => {
			const candidates = _candidateList(candidatesByValue, value).filter((c) => c && typeof c.id === 'string');
			if (candidates.length === 1 && sourceRecords.length === 1) {
				const rec = sourceRecords[0];
				rec.loadedFromId = candidates[0].id;
				rec._migrateMatchedId = candidates[0].id;
				rec._migrateMatchCandidates = candidates.map((c) => ({
					id: c.id,
					label: c.label == null ? '' : String(c.label),
					lastModifiedDate: c.lastModifiedDate || null,
					matchField: keyField,
					matchValue: value,
				}));
				rec._migrateMatchResolution = 'automatic';
				matched++;
				return;
			}
			if (candidates.length > 1 || (candidates.length === 1 && sourceRecords.length > 1)) {
				sourceRecords.forEach((rec) => {
					rec._migrateMatchAmbiguous = true;
					rec._migrateMatchCandidates = candidates.map((c) => ({
						id: c.id,
						label: c.label == null ? '' : String(c.label),
						lastModifiedDate: c.lastModifiedDate || null,
						matchField: keyField,
						matchValue: value,
					}));
					unresolved++;
				});
			}
		});
		return { matched: matched, unresolved: unresolved };
	}

	function _resolveRecord(rec, choice, allRecords) {
		if (!rec) {
			return { ok: false, error: 'not-matchable' };
		}
		if (rec._migrateMatchedId) {
			delete rec.loadedFromId;
			delete rec._migrateMatchedId;
		}
		if (choice === 'new') {
			rec._migrateMatchAmbiguous = true;
			rec._migrateMatchResolution = 'new';
			rec._migrateMatchIntent = 'new';
			return { ok: true };
		}
		if (choice === 'update') {
			rec._migrateMatchAmbiguous = true;
			delete rec._migrateMatchResolution;
			rec._migrateMatchIntent = 'existing';
			return { ok: true, pending: true };
		}
		if (!Array.isArray(rec._migrateMatchCandidates) || rec._migrateMatchCandidates.length === 0) {
			return { ok: false, error: 'not-matchable' };
		}
		const candidate = (rec._migrateMatchCandidates || []).find((c) => c.id === choice);
		if (!candidate) {
			delete rec._migrateMatchResolution;
			rec._migrateMatchIntent = 'existing';
			return { ok: false, error: 'unknown-candidate' };
		}
		const claimed = (allRecords || []).some(
			(other) => other && other !== rec && other._migrateMatchedId === candidate.id,
		);
		// One destination row may satisfy only one canvas record in a migration plan.
		if (claimed) {
			delete rec._migrateMatchResolution;
			rec._migrateMatchIntent = 'existing';
			return { ok: false, error: 'candidate-already-used' };
		}
		rec.loadedFromId = candidate.id;
		rec._migrateMatchedId = candidate.id;
		rec._migrateMatchResolution = 'existing';
		rec._migrateMatchIntent = 'existing';
		return { ok: true };
	}

	window.OrgLoom.migrateMatch = {
		mount: function mount(deps) {
			const canvasState = deps.canvasState;
			const csrfFetch = deps.csrfFetch;
			const escapeHtml = deps.escapeHtml;
			const showBulkToast = deps.showBulkToast || function () {};
			const ensureDescribe = deps.ensureDescribe;
			const renderBulkView = deps.renderBulkView || function () {};
			const onApplied = deps.onApplied || function () {};
			function open(opts) {
				opts = opts || {};
				const onClose = typeof opts.onClose === 'function' ? opts.onClose : null;
				document.querySelectorAll('.migrate-match-modal').forEach((el) => el.remove());
				const objects = _distinctObjects(canvasState);
				const snapshotFields = [
					'values',
					'loadedFromId',
					'_migrateMatchedId',
					'_migrateMatchKey',
					'_migrateMatchValue',
					'_migrateMatchAmbiguous',
					'_migrateMatchResolution',
					'_migrateMatchIntent',
					'_migrateMatchCandidates',
					'_migrateRecordTypeId',
					'_migrateClearRecordType',
					'_migratePicklistRemap',
					'_migrateFieldResolutions',
					'_migrateMatchSearched',
					'_migrateMatchSearchError',
				];
				const matchSnapshot = new Map();
				objects.forEach((recs) =>
					recs.forEach((rec) => {
						const state = {};
						snapshotFields.forEach((field) => {
							if (Object.prototype.hasOwnProperty.call(rec, field)) {
								state[field] = _clone(rec[field]);
							}
						});
						matchSnapshot.set(rec, state);
					}),
				);
				let committed = false;
				let closed = false;
				const overlay = document.createElement('div');
				overlay.className = 'modal migrate-match-modal';
				const destinationHost =
					(window.SF_INSTANCE_URL || '').replace(/^https?:\/\//, '').replace(/\/$/, '') ||
					window.SF_ORG_ID ||
					'the connected Salesforce org';
				overlay.innerHTML =
					'<div class="modal-overlay" data-mm-close></div>' +
					'<div class="modal-body mm-modal-body">' +
					'<div class="modal-header">' +
					'<div><h3>Prepare migration</h3>' +
					'<div class="mm-destination">Destination: <strong>' +
					escapeHtml(destinationHost) +
					'</strong></div></div>' +
					'<button class="modal-close" data-mm-close>&times;</button>' +
					'</div>' +
					'<div class="modal-content mm-content">' +
					'<div class="mm-stepper" aria-label="Migration progress">' +
					'<button type="button" class="mm-step is-active" data-mm-step="matches"><span>1</span><strong>Decide record actions</strong></button>' +
					'<span class="mm-step-line" aria-hidden="true"></span>' +
					'<button type="button" class="mm-step" data-mm-step="differences"><span>2</span><strong>Resolve differences</strong></button>' +
					'<span class="mm-step-line" aria-hidden="true"></span>' +
					'<button type="button" class="mm-step" data-mm-step="review"><span>3</span><strong>Review migration</strong></button>' +
					'</div>' +
					'<div class="mm-summary"></div>' +
					'<section class="mm-panel" data-mm-panel="matches">' +
					'<div class="mm-decision-intro"><div><strong>Choose what happens to each canvas record</strong><span>Records start as Create new. Choose Update existing when a record should target one already in this Salesforce org.</span></div></div>' +
					'<div class="mm-record-decisions"></div>' +
					'</section>' +
					'<section class="mm-panel" data-mm-panel="differences" hidden>' +
					'<div class="mm-difference-intro"><div><strong>Resolve destination differences</strong><span>Resolve values the destination cannot accept. An unavailable field may not exist in this org or may be hidden by Salesforce permissions. Don\'t map leaves that source field out of this migration; it does not clear or overwrite destination data. The source canvas remains unchanged.</span></div></div>' +
					'<div class="mm-differences"></div>' +
					'</section>' +
					'<section class="mm-panel" data-mm-panel="review" hidden>' +
					'<div class="mm-final-review"></div>' +
					'</section>' +
					'</div>' +
					'<div class="modal-footer mm-footer">' +
					'<button type="button" class="button secondary mm-back" data-mm-back hidden>Back</button>' +
					'<span class="mm-footer-spacer"></span>' +
					'<button type="button" class="button secondary" data-mm-close>Cancel</button>' +
					'<button type="button" class="button mm-primary" data-mm-primary disabled>Loading fields…</button>' +
					'</div>' +
					'</div>';
				document.body.appendChild(overlay);

				const cleanup = () => {
					if (closed) {
						return;
					}
					closed = true;
					document.removeEventListener('keydown', onEsc, true);
					pendingMatches.clear();
					pendingFieldMaps.clear();
					resolvedFieldMaps.clear();
					if (!committed) {
						matchSnapshot.forEach((state, rec) => {
							snapshotFields.forEach((field) => delete rec[field]);
							Object.keys(state).forEach((field) => {
								rec[field] = _clone(state[field]);
							});
						});
						renderBulkView();
						onApplied();
					}
					if (overlay.parentNode) {
						overlay.remove();
					}
					if (onClose) {
						onClose();
					}
				};
				const onEsc = (e) => {
					if (e.key === 'Escape') {
						cleanup();
					}
				};
				document.addEventListener('keydown', onEsc, true);
				overlay.querySelectorAll('[data-mm-close]').forEach((el) => el.addEventListener('click', cleanup));

				const summaryEl = overlay.querySelector('.mm-summary');
				const decisionsEl = overlay.querySelector('.mm-record-decisions');
				const differencesEl = overlay.querySelector('.mm-differences');
				const finalReviewEl = overlay.querySelector('.mm-final-review');
				const primaryBtn = overlay.querySelector('[data-mm-primary]');
				const backBtn = overlay.querySelector('[data-mm-back]');
				const pendingMatches = new Map();
				const pendingFieldMaps = new Map();
				const resolvedFieldMaps = new Map();
				_allRecords().forEach((rec, recordIndex) => {
					const stored = rec && rec._migrateFieldResolutions;
					if (!stored || typeof stored !== 'object') {
						return;
					}
					Object.keys(stored).forEach((key) => {
						const resolution = _clone(stored[key]);
						if (!resolution || !resolution.sourceField || !resolution.sourceKey || !resolution.resolution) {
							return;
						}
						resolution.recordIndex = recordIndex;
						resolvedFieldMaps.set(_fieldMapKey(recordIndex, resolution.sourceField), resolution);
					});
				});
				const stepOrder = ['matches', 'differences', 'review'];
				let currentStep = 'matches';
				let describesReady = false;

				const names = Array.from(objects.keys());
				Promise.all(
					names.map((n) =>
						(ensureDescribe ? ensureDescribe(n, { force: true }) : Promise.resolve(null)).catch(() => null),
					),
				).then(() => {
					describesReady = true;
					_initializeRecordDecisions();
					_renderRecordDecisions();
				});

				overlay.querySelectorAll('[data-mm-step]').forEach((stepBtn) => {
					stepBtn.addEventListener('click', () => {
						if (!describesReady || pendingMatches.size > 0) {
							return;
						}
						const requested = stepBtn.getAttribute('data-mm-step');
						const counts = _statusCounts();
						const differences = _differenceCounts();
						if (requested !== 'matches' && counts.unresolved > 0) {
							showBulkToast(
								'Decide whether every record should update an existing record or be created as new.',
								'warning',
							);
							return;
						}
						if (
							requested === 'review' &&
							(differences.blocked > 0 || differences.pending > 0 || pendingFieldMaps.size > 0)
						) {
							showBulkToast(
								pendingFieldMaps.size > 0
									? 'Choose a destination value for each pending field mapping before reviewing the migration.'
									: 'Resolve the blocked destination differences before reviewing the migration.',
								'warning',
							);
							return;
						}
						_setStep(requested);
					});
				});
				backBtn.addEventListener('click', () => {
					const index = stepOrder.indexOf(currentStep);
					_setStep(stepOrder[Math.max(0, index - 1)]);
				});
				primaryBtn.addEventListener('click', () => {
					if (currentStep === 'matches') {
						_setStep('differences');
						return;
					}
					if (currentStep === 'differences') {
						_setStep('review');
						return;
					}
					if (!primaryBtn.disabled) {
						committed = true;
						onApplied();
						cleanup();
					}
				});
				function _setStep(step) {
					if (!stepOrder.includes(step)) {
						return;
					}
					currentStep = step;
					overlay.querySelectorAll('[data-mm-panel]').forEach((panel) => {
						panel.hidden = panel.getAttribute('data-mm-panel') !== step;
					});
					overlay.querySelectorAll('[data-mm-step]').forEach((stepBtn) => {
						const active = stepBtn.getAttribute('data-mm-step') === step;
						stepBtn.classList.toggle('is-active', active);
						if (active) {
							stepBtn.setAttribute('aria-current', 'step');
						} else {
							stepBtn.removeAttribute('aria-current');
						}
					});
					backBtn.hidden = step === 'matches';
					if (step === 'matches') {
						_renderRecordDecisions();
					} else if (step === 'differences') {
						_renderDifferences();
					} else if (step === 'review') {
						_renderFinalReview();
					}
					_recomputeSummary();
				}

				function _preferredKeyForRecord(rec) {
					const describe = rec && canvasState.describeCache[rec.objectName];
					return _preferredKeyCandidate(describe, rec);
				}

				async function _requestMatches(objectName, keyField, values) {
					let resp;
					try {
						resp = await csrfFetch('/api/migrate/match', {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ objectName: objectName, keyField: keyField, values: values }),
						});
					} catch (_err) {
						return { ok: false, error: 'Could not search Salesforce. Try again.' };
					}
					if (!resp.ok) {
						let message = resp.statusText || 'Salesforce search failed';
						try {
							const body = await resp.json();
							message = body.message || body.error || message;
						} catch (_e) {}
						return { ok: false, error: message };
					}
					return { ok: true, data: await resp.json() };
				}

				function _markCreate(rec) {
					rec._migrateMatchCandidates = [];
					rec._migrateMatchResolution = 'new';
					rec._migrateMatchIntent = 'new';
					delete rec._migrateMatchAmbiguous;
					delete rec._migrateMatchSearchError;
				}

				function _markUpdateWithoutMatch(rec) {
					rec._migrateMatchCandidates = [];
					delete rec.loadedFromId;
					delete rec._migrateMatchedId;
					delete rec._migrateMatchResolution;
					delete rec._migrateMatchSearchError;
					rec._migrateMatchAmbiguous = true;
					rec._migrateMatchIntent = 'existing';
				}

				function _initializeRecordDecisions() {
					_allRecords()
						.filter(
							(rec) =>
								!rec._migrateMatchSearched &&
								!rec._migrateMatchedId &&
								!rec._migrateMatchResolution &&
								!rec._migrateMatchAmbiguous,
						)
						.forEach((rec) => {
							_clearMatchState(rec);
							_markCreate(rec);
						});
					_recomputeSummary();
				}

				function _allRecords() {
					const out = [];
					objects.forEach((recs) => recs.forEach((rec) => out.push(rec)));
					return out;
				}

				function _annotationFor(rec) {
					const engine = window.Orgloom && window.Orgloom.migrateAnnotate;
					const describe = rec && canvasState.describeCache[rec.objectName];
					if (!engine || !engine.computeMigrationStatus || !describe) {
						return { status: 'pending', issues: [], resolvedRecordTypeId: null };
					}
					return engine.computeMigrationStatus(rec, describe);
				}

				function _differenceCounts() {
					const counts = {
						blocked: 0,
						warnings: 0,
						pending: 0,
						unavailableValues: 0,
						omittedPicklistValues: 0,
					};
					_allRecords().forEach((rec, recordIndex) => {
						const annotation = _annotationFor(rec);
						if (annotation.status === 'pending') {
							counts.pending++;
						}
						(annotation.issues || []).forEach((issue) => {
							if (
								issue.kind === 'missing-field' &&
								resolvedFieldMaps.has(_fieldMapKey(recordIndex, issue.field))
							) {
								return;
							}
							if (issue.severity === 'blocked') {
								counts.blocked++;
							} else if (issue.severity === 'warning') {
								counts.warnings++;
							}
							if (issue.kind === 'missing-field') {
								counts.unavailableValues++;
							} else if (issue.kind === 'picklist-mismatch') {
								counts.omittedPicklistValues += Array.isArray(issue.invalidValues)
									? issue.invalidValues.length
									: 1;
							}
						});
					});
					resolvedFieldMaps.forEach((resolved) => {
						if (resolved.resolution === '__omit__') {
							counts.unavailableValues++;
						}
					});
					return counts;
				}

				function _fieldFor(rec, fieldName) {
					const describe = rec && canvasState.describeCache[rec.objectName];
					return (
						((describe && describe.fields) || []).find(
							(field) =>
								field &&
								field.name &&
								String(field.name).toLowerCase() === String(fieldName).toLowerCase(),
						) || null
					);
				}

				function _valueKey(rec, fieldName) {
					return (
						(rec &&
							rec.values &&
							Object.keys(rec.values).find(
								(key) => key.toLowerCase() === String(fieldName).toLowerCase(),
							)) ||
						null
					);
				}

				function _writableFields(rec, excludedField) {
					const describe = rec && canvasState.describeCache[rec.objectName];
					return ((describe && describe.fields) || [])
						.filter((field) => {
							if (
								!field ||
								!field.name ||
								String(field.name).toLowerCase() === String(excludedField).toLowerCase() ||
								field.calculated ||
								field.autoNumber
							) {
								return false;
							}
							if (field.compoundFieldName || field.type === 'address' || field.type === 'location') {
								return false;
							}
							return rec.loadedFromId ? field.updateable !== false : field.createable !== false;
						})
						.sort((a, b) => String(a.label || a.name).localeCompare(String(b.label || b.name)));
				}

				function _writableFieldOptions(rec, excludedField, raw, selectedTarget) {
					return _writableFields(rec, excludedField)
						.map((field) => ({ field: field, disposition: _fieldMapDisposition(raw, field) }))
						.filter((entry) => entry.disposition !== 'incompatible')
						.map(
							(entry) =>
								'<option value="' +
								escapeHtml(entry.field.name) +
								'"' +
								(entry.field.name === selectedTarget ? ' selected' : '') +
								'>' +
								'Map to ' +
								escapeHtml(entry.field.label || entry.field.name) +
								' (' +
								escapeHtml(entry.field.name) +
								')' +
								(entry.disposition === 'choice' ? ' (value selection required)' : '') +
								'</option>',
						)
						.join('');
				}

				function _fieldMapKey(recordIndex, sourceField) {
					return recordIndex + ':' + String(sourceField).toLowerCase();
				}

				function _resolvedFieldMapsForRecord(recordIndex) {
					return Array.from(resolvedFieldMaps.entries()).filter(
						(entry) => entry[1].recordIndex === recordIndex,
					);
				}

				function _persistResolvedFieldMap(rec, resolved) {
					if (!rec || !resolved || !resolved.sourceField) {
						return;
					}
					const stored = _clone(resolved);
					delete stored.recordIndex;
					// Store the decision on the record so closing the guide does not erase user choices.
					rec._migrateFieldResolutions = rec._migrateFieldResolutions || {};
					rec._migrateFieldResolutions[String(resolved.sourceField).toLowerCase()] = stored;
				}

				function _removePersistedFieldMap(rec, sourceField) {
					if (!rec || !rec._migrateFieldResolutions || !sourceField) {
						return;
					}
					delete rec._migrateFieldResolutions[String(sourceField).toLowerCase()];
					if (!Object.keys(rec._migrateFieldResolutions).length) {
						delete rec._migrateFieldResolutions;
					}
				}

				function _restoreResolvedFieldMap(rec, mapKey) {
					const resolved = resolvedFieldMaps.get(mapKey);
					if (!rec || !resolved) {
						return null;
					}
					if (resolved.targetField) {
						const currentTargetKey = _valueKey(rec, resolved.targetField);
						const currentTargetValue = currentTargetKey ? rec.values[currentTargetKey] : undefined;
						if (currentTargetKey && currentTargetValue === resolved.mappedValue) {
							if (resolved.targetHadValue) {
								rec.values[resolved.targetKey] = _clone(resolved.targetPreviousValue);
							} else {
								delete rec.values[currentTargetKey];
							}
						}
					}
					rec.values[resolved.sourceKey] = _clone(resolved.sourceValue);
					resolvedFieldMaps.delete(mapKey);
					_removePersistedFieldMap(rec, resolved.sourceField);
					return resolved;
				}

				function _commitFieldResolution(recordIndex, rec, sourceField, sourceKey, resolution, mappedValue) {
					if (!rec || !sourceKey || !resolution) {
						return false;
					}
					const mapKey = _fieldMapKey(recordIndex, sourceField);
					const sourceValue = rec.values[sourceKey];
					const resolved = {
						recordIndex: recordIndex,
						sourceField: sourceField,
						sourceKey: sourceKey,
						sourceValue: _clone(sourceValue),
						resolution: resolution,
						targetField: null,
						targetKey: null,
						targetHadValue: false,
						targetPreviousValue: undefined,
						mappedValue: undefined,
					};
					if (resolution !== '__omit__') {
						const targetField = _fieldFor(rec, resolution);
						if (!targetField) {
							return false;
						}
						const targetKey = _valueKey(rec, targetField.name);
						const writeKey = targetKey || targetField.name;
						const targetValue = mappedValue === undefined ? sourceValue : mappedValue;
						resolved.targetField = targetField.name;
						resolved.targetKey = writeKey;
						resolved.targetHadValue = Boolean(targetKey);
						resolved.targetPreviousValue = targetKey ? _clone(rec.values[targetKey]) : undefined;
						resolved.mappedValue = _clone(targetValue);
						rec.values[writeKey] = targetValue;
					}
					delete rec.values[sourceKey];
					pendingFieldMaps.delete(mapKey);
					resolvedFieldMaps.set(mapKey, resolved);
					_persistResolvedFieldMap(rec, resolved);
					return true;
				}

				function _fieldMapValueControl(raw, field, recordIndex, sourceField, selectedValue) {
					const options = ((field && field.picklistValues) || [])
						.filter((entry) => entry && entry.active !== false && entry.value !== undefined)
						.map(
							(entry) =>
								'<option value="' +
								escapeHtml(entry.value) +
								'"' +
								(String(entry.value) === String(selectedValue) ? ' selected' : '') +
								'>' +
								escapeHtml(entry.label || entry.value) +
								'</option>',
						)
						.join('');
					return (
						'<div class="mm-map-value-resolution">' +
						'<span>Source value <code>' +
						escapeHtml(_displayValue(raw)) +
						'</code> is not available for ' +
						escapeHtml(field.label || field.name) +
						'.</span>' +
						'<label>Destination value<select data-mm-map-value data-mm-map-record="' +
						recordIndex +
						'" data-mm-map-source="' +
						escapeHtml(sourceField) +
						'" data-mm-map-target="' +
						escapeHtml(field.name) +
						'">' +
						'<option value=""' +
						(selectedValue ? '' : ' selected') +
						'>Choose a destination value...</option>' +
						options +
						'</select></label></div>'
					);
				}

				function _requiredFieldControl(rec, issue, recordIndex) {
					const field = _fieldFor(rec, issue.field) || {
						name: issue.field,
						label: issue.field,
						type: 'string',
					};
					const attrs =
						' data-mm-required-record="' +
						recordIndex +
						'" data-mm-required-field="' +
						escapeHtml(field.name) +
						'"';
					if (field.type === 'picklist' || field.type === 'multipicklist') {
						const options = (field.picklistValues || [])
							.filter((value) => value && value.active !== false)
							.map(
								(value) =>
									'<option value="' +
									escapeHtml(value.value) +
									'">' +
									escapeHtml(value.label || value.value) +
									'</option>',
							)
							.join('');
						return (
							'<select class="mm-difference-input"' +
							attrs +
							'><option value="">Select a value...</option>' +
							options +
							'</select>'
						);
					}
					if (field.type === 'textarea') {
						return (
							'<textarea class="mm-difference-input" rows="2" placeholder="Enter ' +
							escapeHtml(field.label || field.name) +
							'"' +
							attrs +
							'></textarea>'
						);
					}
					const numeric = ['int', 'double', 'currency', 'percent'].includes(field.type);
					const inputType = numeric
						? 'number'
						: field.type === 'date'
							? 'date'
							: field.type === 'datetime'
								? 'datetime-local'
								: 'text';
					return (
						'<input class="mm-difference-input" type="' +
						inputType +
						'"' +
						(numeric ? ' step="any"' : '') +
						' placeholder="Enter ' +
						escapeHtml(field.label || field.name) +
						'"' +
						attrs +
						'>'
					);
				}

				function _differenceIssueHtml(rec, issue, recordIndex) {
					const fieldLabel = (_fieldFor(rec, issue.field) || {}).label || issue.field || 'Destination field';
					if (issue.kind === 'missing-field') {
						const mapKey = _fieldMapKey(recordIndex, issue.field);
						const resolvedMap = resolvedFieldMaps.get(mapKey);
						const sourceKey = resolvedMap ? resolvedMap.sourceKey : _valueKey(rec, issue.field);
						const raw = resolvedMap
							? resolvedMap.sourceValue
							: sourceKey
								? rec.values[sourceKey]
								: undefined;
						const pendingMap = pendingFieldMaps.get(mapKey);
						let selectedTarget =
							(resolvedMap && resolvedMap.targetField) || (pendingMap && pendingMap.targetField);
						let selectedField = selectedTarget && _fieldFor(rec, selectedTarget);
						if (!resolvedMap && selectedTarget && _fieldMapDisposition(raw, selectedField) !== 'choice') {
							pendingFieldMaps.delete(mapKey);
							selectedTarget = '';
							selectedField = null;
						}
						const mapOptions = _writableFieldOptions(rec, issue.field, raw, selectedTarget);
						const valueControl =
							selectedField && _fieldMapDisposition(raw, selectedField) === 'choice'
								? _fieldMapValueControl(
										raw,
										selectedField,
										recordIndex,
										issue.field,
										resolvedMap && resolvedMap.mappedValue,
									)
								: '';
						const statusText = resolvedMap
							? 'Resolved'
							: pendingMap
								? 'Needs destination value'
								: 'Needs attention';
						const statusClass = resolvedMap ? 'resolved' : pendingMap ? 'pending' : 'attention';
						const statusId =
							'mm-field-status-' + recordIndex + '-' + String(issue.field).replace(/[^a-z0-9_-]/gi, '-');
						return (
							'<div class="mm-difference-row' +
							(resolvedMap ? ' mm-difference-row--resolved' : '') +
							'" data-mm-missing-record="' +
							recordIndex +
							'" data-mm-missing-field="' +
							escapeHtml(issue.field) +
							'">' +
							'<div class="mm-difference-meta"><strong>' +
							escapeHtml(issue.field) +
							'</strong></div>' +
							'<div class="mm-difference-actions"><div class="mm-field-resolution-head"><span>Destination action</span>' +
							'<span id="' +
							statusId +
							'" class="mm-field-resolution-state mm-field-resolution-state--' +
							statusClass +
							'">' +
							statusText +
							'</span></div>' +
							'<select data-mm-field-resolution aria-label="How to handle ' +
							escapeHtml(issue.field) +
							'" aria-describedby="' +
							statusId +
							'">' +
							'<option value=""' +
							(!resolvedMap && !pendingMap ? ' selected' : '') +
							'>Choose how to handle this field...</option>' +
							'<option value="__omit__"' +
							(resolvedMap && resolvedMap.resolution === '__omit__' ? ' selected' : '') +
							">Don't map (destination unchanged)</option>" +
							(mapOptions
								? '<optgroup label="Map to a destination field">' + mapOptions + '</optgroup>'
								: '') +
							'</select>' +
							valueControl +
							'</div>' +
							'</div>'
						);
					}
					if (issue.kind === 'required-unfilled') {
						return (
							'<div class="mm-difference-row mm-difference-row--blocked"><div class="mm-difference-meta"><strong>' +
							escapeHtml(fieldLabel) +
							'</strong>' +
							'<span>Required when creating this record in the destination</span></div>' +
							_requiredFieldControl(rec, issue, recordIndex) +
							'</div>'
						);
					}
					if (issue.kind === 'recordtype-unresolved') {
						const describe = canvasState.describeCache[rec.objectName] || {};
						const options = (describe.recordTypes || [])
							.map(
								(recordType) =>
									'<option value="' +
									escapeHtml(recordType.id) +
									'">' +
									escapeHtml(recordType.label || recordType.name || recordType.developerName) +
									'</option>',
							)
							.join('');
						return (
							'<div class="mm-difference-row mm-difference-row--blocked"><div class="mm-difference-meta"><strong>Record type</strong>' +
							'<span>Source record type ' +
							escapeHtml(issue.developerName || '') +
							' is not available in the destination</span></div>' +
							'<select class="mm-difference-input" data-mm-recordtype-record="' +
							recordIndex +
							'"><option value="">Choose a destination record type...</option>' +
							options +
							'<option value="__clear__">No record type</option></select></div>'
						);
					}
					if (issue.kind === 'picklist-mismatch') {
						const field = _fieldFor(rec, issue.field) || {};
						const options = (field.picklistValues || [])
							.filter((value) => value && value.active !== false)
							.map(
								(value) =>
									'<option value="' +
									escapeHtml(value.value) +
									'">' +
									escapeHtml(value.label || value.value) +
									'</option>',
							)
							.join('');
						return (issue.invalidValues || [])
							.map(
								(sourceValue) =>
									'<div class="mm-difference-row"><div class="mm-difference-meta"><strong>' +
									escapeHtml(fieldLabel) +
									'</strong>' +
									'<span><code>' +
									escapeHtml(sourceValue) +
									'</code> is not valid in the destination</span></div>' +
									'<select class="mm-difference-input" data-mm-picklist-record="' +
									recordIndex +
									'" data-mm-picklist-field="' +
									escapeHtml(issue.field) +
									'" data-mm-picklist-source="' +
									escapeHtml(sourceValue) +
									'">' +
									'<option value="__unresolved__">Omit on upload</option>' +
									options +
									'<option value="__drop__">Don\'t map this value</option></select></div>',
							)
							.join('');
					}
					return '';
				}

				function _renderDifferences() {
					const all = _allRecords();
					const activeMissingFields = new Set();
					all.forEach((rec, recordIndex) => {
						(_annotationFor(rec).issues || []).forEach((issue) => {
							if (issue.kind === 'missing-field') {
								activeMissingFields.add(_fieldMapKey(recordIndex, issue.field));
							}
						});
					});
					pendingFieldMaps.forEach((_value, key) => {
						if (!activeMissingFields.has(key)) {
							pendingFieldMaps.delete(key);
						}
					});
					resolvedFieldMaps.forEach((resolved, key) => {
						if (!all[resolved.recordIndex]) {
							resolvedFieldMaps.delete(key);
						}
					});
					const rows = [];
					all.forEach((rec, recordIndex) => {
						const annotation = _annotationFor(rec);
						if (annotation.status === 'pending') {
							rows.push(
								'<section class="mm-difference-record mm-difference-record--blocked"><div class="mm-difference-record-head"><div><strong>' +
									escapeHtml(_differenceRecordLabel(rec)) +
									'</strong></div><span>Schema unavailable</span></div><p>Org Loom could not read this object\'s destination fields. Check the connection and try again.</p><button type="button" class="button secondary" data-mm-retry-schema="' +
									escapeHtml(rec.objectName) +
									'">Retry</button></section>',
							);
							return;
						}
						const issues = annotation.issues || [];
						const renderedMapKeys = new Set();
						const issueEntries = issues.map((issue) => {
							const key = issue.kind === 'missing-field' ? _fieldMapKey(recordIndex, issue.field) : null;
							if (key) {
								renderedMapKeys.add(key);
							}
							return { issue: issue, resolved: key ? resolvedFieldMaps.get(key) : null };
						});
						_resolvedFieldMapsForRecord(recordIndex).forEach(([key, resolved]) => {
							if (!renderedMapKeys.has(key)) {
								issueEntries.push({
									issue: { kind: 'missing-field', field: resolved.sourceField, severity: 'resolved' },
									resolved: resolved,
								});
							}
						});
						if (!issueEntries.length) {
							return;
						}
						const resolvedCount = issueEntries.filter((entry) => entry.resolved).length;
						const attentionCount = issueEntries.length - resolvedCount;
						const recordStatus = attentionCount
							? attentionCount +
								' need' +
								(attentionCount === 1 ? 's' : '') +
								' attention' +
								(resolvedCount ? ' \u00b7 ' + resolvedCount + ' resolved' : '')
							: resolvedCount + ' resolved';
						rows.push(
							'<section class="mm-difference-record' +
								(annotation.status === 'blocked' && attentionCount
									? ' mm-difference-record--blocked'
									: '') +
								(!attentionCount ? ' mm-difference-record--resolved' : '') +
								'">' +
								'<div class="mm-difference-record-head"><div><strong>' +
								escapeHtml(_differenceRecordLabel(rec)) +
								'</strong></div>' +
								'<span>' +
								recordStatus +
								'</span></div>' +
								'<div class="mm-difference-record-body">' +
								issueEntries
									.map((entry) => _differenceIssueHtml(rec, entry.issue, recordIndex))
									.join('') +
								'</div></section>',
						);
					});
					differencesEl.innerHTML = rows.length
						? rows.join('')
						: '<div class="mm-difference-empty"><strong>No destination differences need attention.</strong><span>The current record values are available through this Salesforce connection.</span></div>';

					differencesEl.querySelectorAll('[data-mm-retry-schema]').forEach((button) => {
						button.addEventListener('click', async () => {
							const objectName = button.getAttribute('data-mm-retry-schema');
							button.disabled = true;
							button.textContent = 'Retrying...';
							try {
								await ensureDescribe(objectName, { force: true });
								await Promise.resolve(onApplied()).catch(() => null);
							} catch (_err) {
								showBulkToast(
									'Could not read Salesforce fields. Check the connection and try again.',
									'warning',
								);
							}
							if (!closed) {
								_renderDifferences();
								_recomputeSummary();
							}
						});
					});

					differencesEl.querySelectorAll('[data-mm-field-resolution]').forEach((select) => {
						select.addEventListener('change', () => {
							const row = select.closest('[data-mm-missing-record]');
							const recordIndex = Number(row.getAttribute('data-mm-missing-record'));
							const rec = all[recordIndex];
							const sourceField = row.getAttribute('data-mm-missing-field');
							const mapKey = _fieldMapKey(recordIndex, sourceField);
							if (resolvedFieldMaps.has(mapKey)) {
								_restoreResolvedFieldMap(rec, mapKey);
							}
							const sourceKey = _valueKey(rec, sourceField);
							if (!select.value) {
								pendingFieldMaps.delete(mapKey);
								_afterDifferenceDecision();
								return;
							}
							if (!rec || !sourceKey) {
								pendingFieldMaps.delete(mapKey);
								_renderDifferences();
								_recomputeSummary();
								return;
							}
							if (select.value === '__omit__') {
								_commitFieldResolution(recordIndex, rec, sourceField, sourceKey, '__omit__');
								_afterDifferenceDecision();
								return;
							}
							const raw = rec.values[sourceKey];
							const targetField = _fieldFor(rec, select.value);
							const disposition = _fieldMapDisposition(raw, targetField);
							if (disposition === 'choice') {
								pendingFieldMaps.set(mapKey, { targetField: targetField.name });
								_renderDifferences();
								_recomputeSummary();
								return;
							}
							if (disposition === 'incompatible') {
								pendingFieldMaps.delete(mapKey);
								showBulkToast(
									'That destination field cannot safely accept this source value.',
									'warning',
								);
								_renderDifferences();
								_recomputeSummary();
								return;
							}
							pendingFieldMaps.delete(mapKey);
							_commitFieldResolution(recordIndex, rec, sourceField, sourceKey, targetField.name);
							_afterDifferenceDecision();
						});
					});
					differencesEl.querySelectorAll('[data-mm-map-value]').forEach((select) => {
						select.addEventListener('change', () => {
							const recordIndex = Number(select.getAttribute('data-mm-map-record'));
							const rec = all[recordIndex];
							const sourceField = select.getAttribute('data-mm-map-source');
							const targetField = select.getAttribute('data-mm-map-target');
							const mapKey = _fieldMapKey(recordIndex, sourceField);
							if (resolvedFieldMaps.has(mapKey)) {
								_restoreResolvedFieldMap(rec, mapKey);
							}
							const sourceKey = _valueKey(rec, sourceField);
							if (!rec || !sourceKey || !targetField) {
								pendingFieldMaps.delete(mapKey);
								_renderDifferences();
								_recomputeSummary();
								return;
							}
							if (!select.value) {
								pendingFieldMaps.set(mapKey, { targetField: targetField });
								_afterDifferenceDecision();
								return;
							}
							_commitFieldResolution(recordIndex, rec, sourceField, sourceKey, targetField, select.value);
							_afterDifferenceDecision();
						});
					});
					differencesEl.querySelectorAll('[data-mm-required-record]').forEach((control) => {
						control.addEventListener('change', () => {
							const rec = all[Number(control.getAttribute('data-mm-required-record'))];
							const field = control.getAttribute('data-mm-required-field');
							if (!rec || !field) {
								return;
							}
							if (control.value === '') {
								delete rec.values[field];
							} else {
								rec.values[field] = control.value;
							}
							_afterDifferenceDecision();
						});
					});
					differencesEl.querySelectorAll('[data-mm-recordtype-record]').forEach((select) => {
						select.addEventListener('change', () => {
							const rec = all[Number(select.getAttribute('data-mm-recordtype-record'))];
							if (!rec || !select.value) {
								return;
							}
							if (select.value === '__clear__') {
								rec._migrateClearRecordType = true;
								delete rec._migrateRecordTypeId;
							} else {
								rec._migrateRecordTypeId = select.value;
								delete rec._migrateClearRecordType;
							}
							_afterDifferenceDecision();
						});
					});
					differencesEl.querySelectorAll('[data-mm-picklist-record]').forEach((select) => {
						select.addEventListener('change', () => {
							const rec = all[Number(select.getAttribute('data-mm-picklist-record'))];
							const field = select.getAttribute('data-mm-picklist-field');
							const sourceValue = select.getAttribute('data-mm-picklist-source');
							if (!rec || !field) {
								return;
							}
							rec._migratePicklistRemap = rec._migratePicklistRemap || {};
							rec._migratePicklistRemap[field] = rec._migratePicklistRemap[field] || {};
							if (select.value === '__unresolved__') {
								delete rec._migratePicklistRemap[field][sourceValue];
							} else {
								rec._migratePicklistRemap[field][sourceValue] =
									select.value === '__drop__' ? '' : select.value;
							}
							_afterDifferenceDecision();
						});
					});
				}

				function _afterDifferenceDecision() {
					onApplied();
					renderBulkView();
					_renderDifferences();
					_recomputeSummary();
				}

				function _renderFinalReview() {
					// This is a plan summary only; the separate Upload action performs Salesforce DML.
					const status = _statusCounts();
					const differences = _differenceCounts();
					const omitted = differences.unavailableValues + differences.omittedPicklistValues;
					const warning =
						omitted > 0
							? '<div class="mm-final-note mm-final-note--warn"><strong>' +
								omitted +
								' value' +
								(omitted === 1 ? '' : 's') +
								' will be omitted</strong><span>Return to Resolve differences if you want to map them. Unmapped values do not clear or overwrite destination data.</span></div>'
							: '<div class="mm-final-note"><strong>No unresolved destination values</strong><span>The reviewed values can be sent through the current Salesforce connection.</span></div>';
					finalReviewEl.innerHTML =
						'<div class="mm-final-heading"><strong>Review the migration plan</strong><span>Nothing is written to Salesforce until you use Upload from the canvas.</span></div>' +
						'<div class="mm-final-counts"><div><strong>' +
						status.updates +
						'</strong><span>Update existing</span></div><div><strong>' +
						status.creates +
						'</strong><span>Create new</span></div><div><strong>' +
						omitted +
						'</strong><span>Values omitted</span></div></div>' +
						warning +
						'<div class="mm-final-note"><strong>Source remains unchanged</strong><span>This plan only affects the connected destination org.</span></div>';
				}

				function _differenceRecordLabel(rec) {
					const describe = canvasState.describeCache[rec.objectName];
					const objectLabel = (describe && describe.label) || rec.objectName;
					const nameField = ((describe && describe.fields) || []).find((field) => field && field.nameField);
					const nameValue = nameField && _lookup(rec && rec.values, nameField.name);
					let recordLabel = rec && rec.label ? String(rec.label) : '';
					if (
						!recordLabel ||
						recordLabel.toLowerCase() === String(objectLabel).toLowerCase() ||
						recordLabel.toLowerCase() === String(objectLabel + ' record').toLowerCase()
					) {
						recordLabel = nameValue == null ? '' : String(nameValue);
					}
					return !recordLabel || recordLabel.toLowerCase() === String(objectLabel).toLowerCase()
						? String(objectLabel)
						: objectLabel + ' \u00b7 ' + recordLabel;
				}

				function _candidateText(candidate) {
					const bits = [];
					if (candidate.label) {
						bits.push(candidate.label);
					}
					bits.push('ID ' + candidate.id);
					if (candidate.lastModifiedDate) {
						const d = new Date(candidate.lastModifiedDate);
						if (!Number.isNaN(d.getTime())) {
							bits.push('modified ' + d.toLocaleDateString());
						}
					}
					return bits.join(' \u00b7 ');
				}

				function _recordKeyText(rec) {
					const preferred = _preferredKeyForRecord(rec);
					const key = rec._migrateMatchKey || (preferred && preferred.name);
					if (!key) {
						return '';
					}
					const field = _fieldFor(rec, key);
					const value = rec._migrateMatchKey ? rec._migrateMatchValue : _lookup(rec.values, key);
					return ((field && field.label) || key) + ' = ' + _displayValue(value);
				}

				function _recordOpenUrl(rec) {
					const sfBase = (window.SF_INSTANCE_URL || '').replace(/\/+$/, '');
					return rec._migrateMatchedId && sfBase
						? sfBase +
								'/lightning/r/' +
								encodeURIComponent(rec.objectName) +
								'/' +
								encodeURIComponent(rec._migrateMatchedId) +
								'/view'
						: '';
				}

				function _canvasIdentity(rec) {
					const describe = canvasState.describeCache[rec.objectName];
					const objectLabel = (describe && describe.label) || rec.objectName;
					const keyText = _recordKeyText(rec);
					return (
						'<strong class="mm-record-identity">' +
						escapeHtml(objectLabel + (keyText ? ' \u00b7 ' + keyText : '')) +
						'</strong>'
					);
				}

				function _candidateReason(rec, candidate) {
					if (!candidate || !candidate.matchField) {
						return '';
					}
					const field = _fieldFor(rec, candidate.matchField);
					return (
						'Matched using ' +
						((field && field.label) || candidate.matchField) +
						' = ' +
						(candidate.matchValue == null ? '' : candidate.matchValue)
					);
				}

				function _decisionCard(rec, index, all) {
					const candidates = rec._migrateMatchCandidates || [];
					const pending = pendingMatches.has(rec);
					const action = rec._migrateMatchedId || rec._migrateMatchIntent === 'existing' ? 'existing' : 'new';
					const needsDecision = action === 'existing' && !rec._migrateMatchedId;
					let badge = '<span class="mm-plan-badge">Create new</span>';
					if (pending) {
						badge = '<span class="mm-plan-badge">Searching...</span>';
					} else if (rec._migrateMatchSearchError) {
						badge = '<span class="mm-plan-badge mm-plan-badge--warn">Search failed</span>';
					} else if (needsDecision) {
						badge = '<span class="mm-plan-badge mm-plan-badge--warn">Needs decision</span>';
					} else if (rec._migrateMatchedId) {
						badge = '<span class="mm-plan-badge mm-plan-badge--ok">Update existing</span>';
					}
					const candidateOptions = candidates
						.map((candidate) => {
							const claimedByOther = all.some(
								(other) => other && other !== rec && other._migrateMatchedId === candidate.id,
							);
							const reason = _candidateReason(rec, candidate);
							const label =
								_candidateText(candidate) +
								(reason ? ' \u00b7 ' + reason : '') +
								(claimedByOther ? ' (already selected)' : '');
							return (
								'<option value="' +
								escapeHtml(candidate.id) +
								'"' +
								(candidate.id === rec._migrateMatchedId ? ' selected' : '') +
								(claimedByOther ? ' disabled' : '') +
								'>' +
								escapeHtml(label) +
								'</option>'
							);
						})
						.join('');
					const targetControl = candidates.length
						? '<label>Destination record</label><select class="mm-resolution-select" aria-label="Destination record"><option value="">Select a Salesforce record...</option>' +
							candidateOptions +
							'</select>'
						: '<div class="mm-no-suggestions"><strong>No destination suggestions found</strong><span>Choose a different identifying field below, or create this as a new record.</span></div>';
					const keyFields = _keyCandidates(canvasState.describeCache[rec.objectName]).filter((field) => {
						const value = _lookup(rec.values, field.name);
						return value !== null && value !== undefined && String(value) !== '';
					});
					const keyOptions = keyFields
						.map(
							(field) =>
								'<option value="' +
								escapeHtml(field.name) +
								'"' +
								(rec._migrateMatchKey === field.name ? ' selected' : '') +
								'>' +
								escapeHtml(field.label || field.name) +
								' (' +
								escapeHtml(field.name) +
								')' +
								escapeHtml(_tierLabel(field)) +
								'</option>',
						)
						.join('');
					const searchMessage =
						action === 'existing' && rec._migrateMatchSearchError
							? '<div class="mm-search-error"><span>' +
								escapeHtml(rec._migrateMatchSearchError) +
								'</span><button type="button" class="link-button" data-mm-retry-search>Retry</button></div>'
							: '';
					const matchOptions =
						action === 'existing'
							? '<details class="mm-match-options"' +
								(rec._migrateMatchSearchError || candidates.length === 0 ? ' open' : '') +
								'><summary>Change how matches are found</summary>' +
								(keyOptions
									? '<label>Identifying field for this record</label><select class="mm-record-key-select"><option value="">Choose a field...</option>' +
										keyOptions +
										'</select>'
									: '<p>No populated, queryable identifying fields are available on this record.</p>') +
								'<small>This changes suggestions for this record only.</small></details>'
							: '';
					const openUrl = _recordOpenUrl(rec);
					const radioName = 'mm-action-' + index;
					return (
						'<section class="mm-decision-card' +
						(needsDecision || rec._migrateMatchSearchError ? ' mm-decision-card--needs' : '') +
						'" data-mm-record-index="' +
						index +
						'">' +
						'<div class="mm-decision-head">' +
						_canvasIdentity(rec) +
						badge +
						'</div>' +
						searchMessage +
						'<fieldset class="mm-review-choice"' +
						(pending ? ' disabled' : '') +
						'><legend>What should happen to this record?</legend>' +
						'<label class="mm-action-option"><input type="radio" class="mm-action-radio" name="' +
						radioName +
						'" value="new"' +
						(action === 'new' ? ' checked' : '') +
						'>' +
						'<span><strong>Create new</strong><small>Insert this as a separate destination record.</small></span></label>' +
						'<label class="mm-action-option"><input type="radio" class="mm-action-radio" name="' +
						radioName +
						'" value="existing"' +
						(action === 'existing' ? ' checked' : '') +
						'>' +
						'<span><strong>Update existing</strong><small>Apply this canvas record to a destination record.</small></span></label>' +
						'<div class="mm-target-choice"' +
						(action === 'existing' ? '' : ' hidden') +
						'>' +
						targetControl +
						(openUrl
							? '<a class="mm-open-record" href="' +
								escapeHtml(openUrl) +
								'" target="_blank" rel="noopener">Open selected record in Salesforce</a>'
							: '') +
						'</div>' +
						'</fieldset>' +
						matchOptions +
						'</section>'
					);
				}

				function _renderRecordDecisions() {
					const all = _allRecords();
					decisionsEl.innerHTML = all.length
						? all.map((rec, index) => _decisionCard(rec, index, all)).join('')
						: '<div class="mm-empty-differences"><strong>No records to migrate</strong><span>Add records to the canvas before starting a migration.</span></div>';
					decisionsEl.querySelectorAll('.mm-decision-card').forEach((card) => {
						const rec = all[Number(card.getAttribute('data-mm-record-index'))];
						card.querySelectorAll('.mm-action-radio').forEach((radio) => {
							radio.addEventListener('change', () => {
								if (!radio.checked) {
									return;
								}
								if (radio.value === 'new') {
									_resolveRecord(rec, 'new', all);
									delete rec._migrateMatchSearchError;
								} else {
									const available = (rec._migrateMatchCandidates || []).filter(
										(candidate) =>
											!all.some(
												(other) =>
													other && other !== rec && other._migrateMatchedId === candidate.id,
											),
									);
									let searchField = '';
									if (available.length === 1) {
										_resolveRecord(rec, available[0].id, all);
									} else {
										_resolveRecord(rec, 'update', all);
										if (available.length === 0 && !rec._migrateMatchSearched) {
											searchField = (_preferredKeyForRecord(rec) || {}).name || '';
											if (!searchField) {
												rec._migrateMatchSearched = true;
											}
										}
									}
									_afterRecordDecision();
									if (searchField) {
										_runMatchForRecord(rec, searchField);
									}
									return;
								}
								_afterRecordDecision();
							});
						});
						const resolution = card.querySelector('.mm-resolution-select');
						if (resolution) {
							resolution.addEventListener('change', () => {
								const result = _resolveRecord(rec, resolution.value || 'update', all);
								if (!result.ok && result.error === 'candidate-already-used') {
									showBulkToast(
										'That Salesforce record is already matched to another canvas record.',
										'warning',
									);
								}
								_afterRecordDecision();
							});
						}
						const keySelect = card.querySelector('.mm-record-key-select');
						if (keySelect) {
							keySelect.addEventListener('change', () => {
								if (keySelect.value) {
									_runMatchForRecord(rec, keySelect.value);
								}
							});
						}
						const retry = card.querySelector('[data-mm-retry-search]');
						if (retry) {
							retry.addEventListener('click', () => {
								const preferred = rec._migrateMatchKey || (_preferredKeyForRecord(rec) || {}).name;
								if (preferred) {
									_runMatchForRecord(rec, preferred);
								}
							});
						}
					});
					_recomputeSummary();
				}

				async function _runMatchForRecord(rec, keyField) {
					const all = _allRecords();
					const value = _lookup(rec.values, keyField);
					const token = {};
					_clearMatchState(rec);
					rec._migrateMatchSearched = true;
					rec._migrateMatchKey = keyField;
					rec._migrateMatchValue = value == null ? '' : String(value);
					rec._migrateMatchAmbiguous = true;
					rec._migrateMatchIntent = 'existing';
					pendingMatches.set(rec, token);
					_renderRecordDecisions();
					if (value === null || value === undefined || String(value) === '') {
						_markUpdateWithoutMatch(rec);
					} else {
						const result = await _requestMatches(rec.objectName, keyField, [String(value)]);
						if (closed || pendingMatches.get(rec) !== token) {
							return;
						}
						if (!result.ok) {
							rec._migrateMatchCandidates = [];
							rec._migrateMatchSearchError = result.error;
							rec._migrateMatchAmbiguous = true;
							rec._migrateMatchIntent = 'existing';
							delete rec._migrateMatchResolution;
						} else {
							delete rec._migrateMatchAmbiguous;
							_applyMatchResponse([rec], keyField, result.data);
							if (!rec._migrateMatchedId && !rec._migrateMatchAmbiguous) {
								_markUpdateWithoutMatch(rec);
							} else if (
								rec._migrateMatchedId &&
								all.some(
									(other) =>
										other && other !== rec && other._migrateMatchedId === rec._migrateMatchedId,
								)
							) {
								delete rec.loadedFromId;
								delete rec._migrateMatchedId;
								delete rec._migrateMatchResolution;
								rec._migrateMatchAmbiguous = true;
								rec._migrateMatchIntent = 'existing';
							}
						}
					}
					if (pendingMatches.get(rec) === token) {
						pendingMatches.delete(rec);
					}
					_afterRecordDecision();
				}

				function _afterRecordDecision() {
					_renderRecordDecisions();
					_recomputeSummary();
					renderBulkView();
					onApplied();
				}

				function _statusCounts() {
					let updates = 0;
					let unresolved = 0;
					let explicitNew = 0;
					let total = 0;
					objects.forEach((recs) => {
						recs.forEach((r) => {
							total++;
							if (r._migrateMatchedId) {
								updates++;
							} else if (r._migrateMatchAmbiguous && !r._migrateMatchResolution) {
								unresolved++;
							} else if (r._migrateMatchResolution === 'new') {
								explicitNew++;
							}
						});
					});
					return {
						updates: updates,
						unresolved: unresolved,
						explicitNew: explicitNew,
						creates: total - updates - unresolved,
						total: total,
					};
				}

				function _updateFooter(counts) {
					counts = counts || _statusCounts();
					const pending = pendingMatches.size;
					const pendingFieldMapCount = pendingFieldMaps.size;
					const differences = _differenceCounts();
					const differencesStep = overlay.querySelector('[data-mm-step="differences"]');
					const reviewStep = overlay.querySelector('[data-mm-step="review"]');
					differencesStep.disabled = !describesReady || pending > 0 || counts.unresolved > 0;
					reviewStep.disabled =
						differencesStep.disabled ||
						differences.blocked > 0 ||
						differences.pending > 0 ||
						pendingFieldMapCount > 0;
					if (currentStep === 'matches') {
						primaryBtn.disabled = !describesReady || pending > 0 || counts.unresolved > 0;
						primaryBtn.textContent = !describesReady
							? 'Loading fields…'
							: pending > 0
								? 'Searching for ' + pending + ' record' + (pending === 1 ? '' : 's') + '…'
								: counts.unresolved > 0
									? 'Resolve ' +
										counts.unresolved +
										' record decision' +
										(counts.unresolved === 1 ? '' : 's')
									: 'Next: Resolve differences';
						return;
					}
					if (currentStep === 'differences') {
						primaryBtn.disabled =
							differences.blocked > 0 || differences.pending > 0 || pendingFieldMapCount > 0;
						primaryBtn.textContent =
							differences.pending > 0
								? 'Waiting for destination fields...'
								: differences.blocked > 0
									? 'Resolve ' +
										differences.blocked +
										' required difference' +
										(differences.blocked === 1 ? '' : 's')
									: pendingFieldMapCount > 0
										? 'Choose ' +
											pendingFieldMapCount +
											' destination value' +
											(pendingFieldMapCount === 1 ? '' : 's')
										: 'Next: Review migration';
						return;
					}
					primaryBtn.disabled = false;
					primaryBtn.textContent = 'Apply migration plan';
				}

				function _recomputeSummary() {
					const counts = _statusCounts();
					const differences = _differenceCounts();
					const attention =
						counts.unresolved + differences.blocked + differences.warnings + differences.pending;
					summaryEl.innerHTML =
						'<div class="mm-summary-item mm-summary-item--update"><strong>' +
						counts.updates +
						'</strong><span>Updating</span></div>' +
						'<div class="mm-summary-item mm-summary-item--new"><strong>' +
						counts.creates +
						'</strong><span>Creating</span></div>' +
						'<div class="mm-summary-item' +
						(attention ? ' mm-summary-item--warn' : '') +
						'"><strong>' +
						attention +
						'</strong><span>Need attention</span></div>';
					_updateFooter(counts);
				}
			}

			return { open: open };
		},
		_test: {
			applyMatchResponse: _applyMatchResponse,
			resolveRecord: _resolveRecord,
			clearMatchState: _clearMatchState,
			keyCandidates: _keyCandidates,
			preferredKeyCandidate: _preferredKeyCandidate,
			fieldMapDisposition: _fieldMapDisposition,
		},
	};
})();
