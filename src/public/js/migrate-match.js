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

	function _dateTimeForInput(value) {
		const api = window.OrgLoom && window.OrgLoom.datetime;
		return api && typeof api.toDateTimeLocal === 'function' ? api.toDateTimeLocal(value) : String(value || '');
	}

	function _dateTimeFromInput(value) {
		const api = window.OrgLoom && window.OrgLoom.datetime;
		return api && typeof api.fromDateTimeLocal === 'function' ? api.fromDateTimeLocal(value) : String(value || '');
	}

	function _meaningfulRecordLabel(rec, describe) {
		const objectLabel = (describe && describe.label) || (rec && rec.objectName) || 'Record';
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
		return recordLabel && recordLabel.toLowerCase() !== String(objectLabel).toLowerCase() ? recordLabel : '';
	}

	function _recordDisplayLabel(rec, describe, allRecords, ordinal) {
		const objectLabel = (describe && describe.label) || (rec && rec.objectName) || 'Record';
		const recordLabel = _meaningfulRecordLabel(rec, describe);
		if (recordLabel) {
			return objectLabel + ' \u00b7 ' + recordLabel;
		}
		if (Number.isSafeInteger(ordinal) && ordinal > 0) {
			return objectLabel + ' #' + ordinal;
		}
		const unnamedSiblings = (allRecords || []).filter(
			(candidate) =>
				candidate && candidate.objectName === rec.objectName && !_meaningfulRecordLabel(candidate, describe),
		);
		const fallbackOrdinal = unnamedSiblings.indexOf(rec);
		return unnamedSiblings.length > 1 && fallbackOrdinal >= 0
			? objectLabel + ' #' + (fallbackOrdinal + 1)
			: String(objectLabel);
	}

	function _picklistValuesForRecordType(field, recordTypeId) {
		const byRecordType = field && field.picklistValuesByRecordType;
		if (recordTypeId && byRecordType && Object.prototype.hasOwnProperty.call(byRecordType, recordTypeId)) {
			return Array.isArray(byRecordType[recordTypeId]) ? byRecordType[recordTypeId] : [];
		}
		if (recordTypeId && byRecordType && Object.keys(byRecordType).length > 0) {
			return [];
		}
		return field && Array.isArray(field.picklistValues) ? field.picklistValues : [];
	}

	function _supportsCustomPicklistValue(field) {
		return Boolean(
			field &&
				(field.type === 'combobox' ||
					((field.type === 'picklist' || field.type === 'multipicklist') &&
						field.restrictedPicklist === false)),
		);
	}

	function _activePicklistValues(field, recordTypeId) {
		return _picklistValuesForRecordType(field, recordTypeId)
			.filter((entry) => entry && entry.active !== false && entry.value !== undefined)
			.map((entry) => String(entry.value));
	}

	function _fieldMapDisposition(raw, field, recordTypeId) {
		if (!field || !field.name || raw === null || raw === undefined || typeof raw === 'object') {
			return 'incompatible';
		}
		const type = String(field.type || 'string').toLowerCase();
		if (['reference', 'address', 'location', 'base64', 'complexvalue', 'anytype'].includes(type)) {
			return 'incompatible';
		}
		if (type === 'picklist') {
			if (_supportsCustomPicklistValue(field)) {
				return 'direct';
			}
			const allowed = _activePicklistValues(field, recordTypeId);
			if (!allowed.length) {
				return 'incompatible';
			}
			return allowed.includes(String(raw)) ? 'direct' : 'choice';
		}
		if (type === 'multipicklist') {
			if (_supportsCustomPicklistValue(field)) {
				return 'direct';
			}
			const allowed = new Set(_activePicklistValues(field, recordTypeId));
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

	function _fieldIdentity(value, apiName) {
		let normalized = String(value || '')
			.trim()
			.toLowerCase();
		if (apiName) {
			normalized = normalized.replace(/__(?:c|pc)$/i, '');
			// Compare only the field portion of namespaced custom fields so packaged and
			// unpackaged destination fields can match each other.
			if (normalized.includes('__')) {
				normalized = normalized.slice(normalized.lastIndexOf('__') + 2);
			}
		}
		return normalized.replace(/[^a-z0-9]/g, '');
	}

	function _automaticFieldCandidate(sourceField, raw, fields, recordTypeId) {
		const sourceName = String(sourceField || '').toLowerCase();
		const sourceIdentity = _fieldIdentity(sourceField, true);
		if (!sourceIdentity) {
			return null;
		}
		const ranked = (fields || [])
			.map((field) => {
				if (!field || !field.name) {
					return null;
				}
				const disposition = _fieldMapDisposition(raw, field, recordTypeId);
				if (disposition === 'incompatible') {
					return null;
				}
				let score = 0;
				if (String(field.name).toLowerCase() === sourceName) {
					score = 3;
				} else if (_fieldIdentity(field.name, true) === sourceIdentity) {
					score = 2;
				} else if (_fieldIdentity(field.label, false) === sourceIdentity) {
					score = 1;
				}
				return score ? { field: field, disposition: disposition, score: score } : null;
			})
			.filter(Boolean)
			.sort((a, b) => b.score - a.score);
		if (!ranked.length || (ranked[1] && ranked[1].score === ranked[0].score)) {
			return null;
		}
		return ranked[0];
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

	function _searchCandidate(record) {
		if (!record || typeof record.id !== 'string' || !record.id) {
			return null;
		}
		return {
			id: record.id,
			label: record.name == null ? '' : String(record.name),
			lastModifiedDate: null,
			matchField: null,
			matchValue: null,
		};
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
			const onCommitPlan = deps.onCommitPlan || onApplied;
			const recordOrdinal = typeof deps.recordOrdinal === 'function' ? deps.recordOrdinal : null;
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
					'<button class="modal-close" data-mm-close aria-label="Close">&times;</button>' +
					'</div>' +
					'<div class="modal-content mm-content">' +
					'<div class="mm-stepper" aria-label="Migration progress">' +
					'<button type="button" class="mm-step is-active" data-mm-step="matches"><span>1</span><strong>Records</strong></button>' +
					'<span class="mm-step-line" aria-hidden="true"></span>' +
					'<button type="button" class="mm-step" data-mm-step="differences"><span>2</span><strong>Fields</strong></button>' +
					'<span class="mm-step-line" aria-hidden="true"></span>' +
					'<button type="button" class="mm-step" data-mm-step="review"><span>3</span><strong>Summary</strong></button>' +
					'</div>' +
					'<div class="mm-summary"></div>' +
					'<section class="mm-panel" data-mm-panel="matches">' +
					'<div class="mm-decision-intro"><div><strong>Choose what happens to each canvas record</strong><span>Records start as Create new. Choose Update existing when a record should target one already in this Salesforce org.</span></div></div>' +
					'<div class="mm-record-decisions"></div>' +
					'</section>' +
					'<section class="mm-panel" data-mm-panel="differences" hidden>' +
					'<div class="mm-differences"></div>' +
					'</section>' +
					'<section class="mm-panel" data-mm-panel="review" hidden>' +
					'<div class="mm-final-review"></div>' +
					'</section>' +
					'</div>' +
					'<div class="modal-footer mm-footer">' +
					'<button type="button" class="button secondary mm-back" data-mm-back hidden>Back</button>' +
					'<span class="mm-footer-spacer"></span>' +
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
					destinationSearches.forEach((state) => clearTimeout(state.timer));
					destinationSearches.clear();
					reviewedRequiredFields.clear();
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
				const destinationSearches = new Map();
				const reviewedRequiredFields = new Map();
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
				let automaticFieldMappingsApplied = false;

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
				primaryBtn.addEventListener('click', async () => {
					if (currentStep === 'matches') {
						_setStep('differences');
						return;
					}
					if (currentStep === 'differences') {
						_setStep('review');
						return;
					}
					if (!primaryBtn.disabled) {
						primaryBtn.disabled = true;
						primaryBtn.textContent = 'Applying to canvas…';
						try {
							await Promise.resolve(onCommitPlan());
							committed = true;
							cleanup();
						} catch (error) {
							showBulkToast(
								(error && error.message) || 'Could not apply the migration to the canvas.',
								'error',
							);
							_recomputeSummary();
						}
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
					summaryEl.hidden = step === 'review';
					if (step === 'matches') {
						_renderRecordDecisions();
					} else if (step === 'differences') {
						if (!automaticFieldMappingsApplied) {
							_applyAutomaticFieldMappings();
							automaticFieldMappingsApplied = true;
						}
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

				function _destinationSearchState(rec) {
					if (!destinationSearches.has(rec)) {
						const selectedCandidate = (rec._migrateMatchCandidates || []).find(
							(candidate) => candidate && candidate.id === rec._migrateMatchedId,
						);
						const selectedLabel = selectedCandidate && (selectedCandidate.label || selectedCandidate.id);
						destinationSearches.set(rec, {
							query: selectedLabel || rec._migrateMatchedId || '',
							results: [],
							open: !rec._migrateMatchedId,
							attempted: false,
							loading: false,
							error: '',
							sequence: 0,
							timer: null,
						});
					}
					return destinationSearches.get(rec);
				}

				function _collapseDestinationSearch(rec, candidate) {
					const state = _destinationSearchState(rec);
					clearTimeout(state.timer);
					state.sequence++;
					state.loading = false;
					state.error = '';
					state.attempted = false;
					state.results = [];
					state.query = (candidate && candidate.label) || (candidate && candidate.id) || '';
					state.open = false;
				}

				async function _searchDestinationRecords(rec) {
					const state = _destinationSearchState(rec);
					const query = state.query.trim();
					const sequence = ++state.sequence;
					if (!query) {
						state.results = [];
						state.attempted = false;
						state.loading = false;
						state.error = '';
						_renderDestinationSearchResults(rec);
						return;
					}
					state.loading = true;
					state.error = '';
					state.attempted = false;
					_renderDestinationSearchResults(rec);
					try {
						const resp = await csrfFetch(
							'/api/objects/' +
								encodeURIComponent(rec.objectName) +
								'/search?q=' +
								encodeURIComponent(query),
							{ credentials: 'same-origin' },
						);
						if (!resp.ok) {
							const body = await resp.json().catch(() => ({}));
							throw new Error(body.message || body.error || resp.statusText || 'Search failed.');
						}
						const data = await resp.json();
						if (closed || state.sequence !== sequence) {
							return;
						}
						state.results = ((data && data.records) || []).map(_searchCandidate).filter(Boolean);
						state.attempted = true;
					} catch (error) {
						if (closed || state.sequence !== sequence) {
							return;
						}
						state.results = [];
						state.attempted = true;
						state.error = error && error.message ? error.message : 'Search failed.';
					} finally {
						if (!closed && state.sequence === sequence) {
							state.loading = false;
							_renderDestinationSearchResults(rec);
						}
					}
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

				function _effectiveRecordTypeId(rec) {
					const describe = rec && canvasState.describeCache[rec.objectName];
					const annotation = _annotationFor(rec);
					const displayedValue =
						field.type === 'datetime' && currentValue ? _dateTimeForInput(currentValue) : currentValue;
					return (
						(annotation && annotation.resolvedRecordTypeId) ||
						(describe && describe.defaultRecordTypeId) ||
						null
					);
				}

				function _differenceCounts() {
					const counts = {
						blocked: 0,
						requiredFields: 0,
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
								if (issue.kind === 'required-unfilled') {
									counts.requiredFields++;
								}
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
						.map((field) => ({
							field: field,
							disposition: _fieldMapDisposition(raw, field, _effectiveRecordTypeId(rec)),
						}))
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

				function _commitFieldResolution(
					recordIndex,
					rec,
					sourceField,
					sourceKey,
					resolution,
					mappedValue,
					options,
				) {
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
					if (options && options.automatic) {
						resolved.automatic = true;
					}
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

				function _applyAutomaticFieldMappings() {
					const all = _allRecords();
					const reservedTargets = new Map();
					resolvedFieldMaps.forEach((resolved) => {
						if (resolved && resolved.targetField) {
							const reserved = reservedTargets.get(resolved.recordIndex) || new Set();
							reserved.add(String(resolved.targetField).toLowerCase());
							reservedTargets.set(resolved.recordIndex, reserved);
						}
					});
					all.forEach((rec, recordIndex) => {
						const reserved = reservedTargets.get(recordIndex) || new Set();
						(_annotationFor(rec).issues || []).forEach((issue) => {
							if (issue.kind !== 'missing-field') {
								return;
							}
							const mapKey = _fieldMapKey(recordIndex, issue.field);
							const sourceKey = _valueKey(rec, issue.field);
							if (!sourceKey || resolvedFieldMaps.has(mapKey) || pendingFieldMaps.has(mapKey)) {
								return;
							}
							const raw = rec.values[sourceKey];
							const candidate = _automaticFieldCandidate(
								issue.field,
								raw,
								_writableFields(rec, issue.field),
								_effectiveRecordTypeId(rec),
							);
							if (!candidate) {
								return;
							}
							const targetName = String(candidate.field.name);
							if (reserved.has(targetName.toLowerCase())) {
								return;
							}
							const targetKey = _valueKey(rec, targetName);
							const targetValue = targetKey ? rec.values[targetKey] : undefined;
							if (
								targetValue !== null &&
								targetValue !== undefined &&
								targetValue !== '' &&
								String(targetValue) !== String(raw)
							) {
								return;
							}
							reserved.add(targetName.toLowerCase());
							if (candidate.disposition === 'choice') {
								pendingFieldMaps.set(mapKey, { targetField: targetName, automatic: true });
								return;
							}
							_commitFieldResolution(recordIndex, rec, issue.field, sourceKey, targetName, undefined, {
								automatic: true,
							});
						});
						reservedTargets.set(recordIndex, reserved);
					});
				}

				function _fieldMapValueControl(raw, field, rec, recordIndex, sourceField, selectedValue) {
					const options = _picklistValuesForRecordType(field, _effectiveRecordTypeId(rec))
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
					const currentValue = _lookup(rec.values, field.name);
					if (field.type === 'picklist' || field.type === 'multipicklist') {
						const options = _picklistValuesForRecordType(field, _effectiveRecordTypeId(rec))
							.filter((value) => value && value.active !== false)
							.map(
								(value) =>
									'<option value="' +
									escapeHtml(value.value) +
									'"' +
									(String(value.value) === String(currentValue) ? ' selected' : '') +
									'>' +
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
							'>' +
							escapeHtml(currentValue == null ? '' : String(currentValue)) +
							'</textarea>'
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
						(displayedValue == null || displayedValue === ''
							? ''
							: ' value="' + escapeHtml(String(displayedValue)) + '"') +
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
						if (
							!resolvedMap &&
							selectedTarget &&
							_fieldMapDisposition(raw, selectedField, _effectiveRecordTypeId(rec)) !== 'choice'
						) {
							pendingFieldMaps.delete(mapKey);
							selectedTarget = '';
							selectedField = null;
						}
						const mapOptions = _writableFieldOptions(rec, issue.field, raw, selectedTarget);
						const valueControl =
							selectedField &&
							_fieldMapDisposition(raw, selectedField, _effectiveRecordTypeId(rec)) === 'choice'
								? _fieldMapValueControl(
										raw,
										selectedField,
										rec,
										recordIndex,
										issue.field,
										resolvedMap && resolvedMap.mappedValue,
									)
								: '';
						const statusText = resolvedMap
							? resolvedMap.automatic
								? 'Auto-matched'
								: 'Resolved'
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
							escapeHtml(
								issue._groupedLabel || (issue._grouped ? _differenceRecordLabel(rec) : issue.field),
							) +
							'</strong></div>' +
							'<div class="mm-difference-actions"><div class="mm-field-resolution-head">' +
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
					if (issue.kind === 'required-unfilled' || issue.kind === 'required-reviewed') {
						return (
							'<div class="mm-difference-row ' +
							(issue.kind === 'required-reviewed'
								? 'mm-difference-row--resolved'
								: 'mm-difference-row--blocked') +
							'"><div class="mm-difference-meta"><strong>' +
							escapeHtml(
								issue.kind === 'required-reviewed'
									? _differenceRecordLabel(rec) + ' \u00b7 ' + fieldLabel
									: fieldLabel,
							) +
							'</strong>' +
							'<span>' +
							(issue.kind === 'required-reviewed'
								? 'Required field completed'
								: 'Required when creating this record in the destination') +
							'</span></div>' +
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
						const options = _picklistValuesForRecordType(field, _effectiveRecordTypeId(rec))
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

				function _fieldMappingGroupHtml(group) {
					const resolvedCount = group.entries.filter((entry) => entry.resolved).length;
					const attentionCount = group.entries.length - resolvedCount;
					return (
						'<section class="mm-field-map-group' +
						(attentionCount ? '' : ' mm-field-map-group--resolved') +
						'">' +
						'<div class="mm-field-map-head"><div><strong>' +
						escapeHtml(group.objectLabel + ' \u00b7 ' + group.sourceField) +
						'</strong><span>' +
						group.entries.length +
						' record' +
						(group.entries.length === 1 ? '' : 's') +
						'</span></div></div>' +
						'<div class="mm-field-map-body">' +
						group.entries
							.map((entry) => {
								const recordLabel = _differenceRecordLabel(entry.rec);
								const objectPrefix = group.objectLabel + ' \u00b7 ';
								return _differenceIssueHtml(
									entry.rec,
									Object.assign({}, entry.issue, {
										_grouped: true,
										_groupedLabel: recordLabel.toLowerCase().startsWith(objectPrefix.toLowerCase())
											? recordLabel.slice(objectPrefix.length)
											: recordLabel,
									}),
									entry.recordIndex,
								);
							})
							.join('') +
						'</div></section>'
					);
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
					const recordRows = [];
					const completedRequiredRows = [];
					const fieldGroups = new Map();
					function addFieldEntry(rec, recordIndex, issue, resolved) {
						const describe = canvasState.describeCache[rec.objectName] || {};
						const objectLabel = describe.label || rec.objectName;
						const key = String(rec.objectName).toLowerCase() + ':' + String(issue.field).toLowerCase();
						if (!fieldGroups.has(key)) {
							fieldGroups.set(key, {
								objectLabel: objectLabel,
								sourceField: issue.field,
								entries: [],
							});
						}
						fieldGroups.get(key).entries.push({
							rec: rec,
							recordIndex: recordIndex,
							issue: issue,
							resolved: resolved,
						});
					}
					all.forEach((rec, recordIndex) => {
						const annotation = _annotationFor(rec);
						if (annotation.status === 'pending') {
							recordRows.push(
								'<section class="mm-difference-record mm-difference-record--blocked"><div class="mm-difference-record-head"><div><strong>' +
									escapeHtml(_differenceRecordLabel(rec)) +
									'</strong></div><span>Schema unavailable</span></div><p>Org Loom could not read this object\'s destination fields. Check the connection and try again.</p><button type="button" class="button secondary" data-mm-retry-schema="' +
									escapeHtml(rec.objectName) +
									'">Retry</button></section>',
							);
							return;
						}
						const issues = annotation.issues || [];
						const activeRequiredFields = new Set(
							issues
								.filter((issue) => issue.kind === 'required-unfilled')
								.map((issue) => String(issue.field).toLowerCase()),
						);
						reviewedRequiredFields.forEach((reviewed) => {
							if (
								reviewed.recordIndex === recordIndex &&
								!rec._migrateMatchedId &&
								!activeRequiredFields.has(String(reviewed.field).toLowerCase()) &&
								_lookup(rec.values, reviewed.field) !== null &&
								_lookup(rec.values, reviewed.field) !== undefined &&
								String(_lookup(rec.values, reviewed.field)) !== ''
							) {
								completedRequiredRows.push(
									_differenceIssueHtml(
										rec,
										{ kind: 'required-reviewed', field: reviewed.field, severity: 'resolved' },
										recordIndex,
									),
								);
							}
						});
						const renderedMapKeys = new Set();
						const issueEntries = [];
						issues.forEach((issue) => {
							const key = issue.kind === 'missing-field' ? _fieldMapKey(recordIndex, issue.field) : null;
							if (key) {
								renderedMapKeys.add(key);
								addFieldEntry(rec, recordIndex, issue, resolvedFieldMaps.get(key));
								return;
							}
							issueEntries.push({ issue: issue, resolved: null });
						});
						_resolvedFieldMapsForRecord(recordIndex).forEach(([key, resolved]) => {
							if (!renderedMapKeys.has(key)) {
								addFieldEntry(
									rec,
									recordIndex,
									{ kind: 'missing-field', field: resolved.sourceField, severity: 'resolved' },
									resolved,
								);
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
						recordRows.push(
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
					const groups = Array.from(fieldGroups.values());
					const attentionGroups = groups.filter((group) => group.entries.some((entry) => !entry.resolved));
					const automaticGroups = groups.filter((group) =>
						group.entries.every((entry) => entry.resolved && entry.resolved.automatic),
					);
					const reviewedGroups = groups.filter(
						(group) => !attentionGroups.includes(group) && !automaticGroups.includes(group),
					);
					const sections = [];
					if (attentionGroups.length || recordRows.length) {
						sections.push(
							'<div class="mm-section-heading"><strong>Needs your input</strong></div>' +
								attentionGroups.map(_fieldMappingGroupHtml).join('') +
								recordRows.join(''),
						);
					}
					if (reviewedGroups.length) {
						sections.push(
							'<div class="mm-section-heading"><strong>Reviewed mappings</strong></div>' +
								reviewedGroups.map(_fieldMappingGroupHtml).join(''),
						);
					}
					if (completedRequiredRows.length) {
						sections.push(
							'<div class="mm-section-heading"><strong>Completed required fields</strong></div>' +
								completedRequiredRows.join(''),
						);
					}
					if (automaticGroups.length) {
						const automaticCount = automaticGroups.reduce(
							(total, group) => total + group.entries.length,
							0,
						);
						sections.push(
							'<details class="mm-auto-matches"><summary>Automatically matched (' +
								automaticCount +
								')</summary><div class="mm-auto-match-list">' +
								automaticGroups.map(_fieldMappingGroupHtml).join('') +
								'</div></details>',
						);
					}
					differencesEl.innerHTML = sections.length
						? sections.join('')
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
							const disposition = _fieldMapDisposition(raw, targetField, _effectiveRecordTypeId(rec));
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
							const recordIndex = Number(control.getAttribute('data-mm-required-record'));
							const rec = all[recordIndex];
							const field = control.getAttribute('data-mm-required-field');
							if (!rec || !field) {
								return;
							}
							if (control.value === '') {
								delete rec.values[field];
								reviewedRequiredFields.delete(_fieldMapKey(recordIndex, field));
							} else {
								const fieldDef = _fieldFor(rec, field);
								const value =
									fieldDef && fieldDef.type === 'datetime'
										? _dateTimeFromInput(control.value)
										: control.value;
								if (!value) {
									showBulkToast('Enter a time that exists in your Salesforce time zone.', 'warning');
									return;
								}
								rec.values[field] = value;
								reviewedRequiredFields.set(_fieldMapKey(recordIndex, field), {
									recordIndex: recordIndex,
									field: field,
								});
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
					// Applying compiles the reviewed plan into ordinary canvas records; Upload remains separate.
					const status = _statusCounts();
					const differences = _differenceCounts();
					const omitted = differences.unavailableValues + differences.omittedPicklistValues;
					const omissionItem =
						omitted > 0
							? '<li class="is-warn"><strong>' +
								omitted +
								' field value' +
								(omitted === 1 ? '' : 's') +
								' will be omitted.</strong> Return to Fields if you want to map them. Unmapped values do not clear or overwrite destination data.</li>'
							: '';
					const blankUpdateItem =
						status.updates > 0
							? '<li>Blank source fields won\u2019t replace existing Salesforce values. To clear a field, apply the migration, open the record, and clear it on the canvas before uploading.</li>'
							: '';
					finalReviewEl.innerHTML =
						'<div class="mm-plan-summary" aria-label="Migration record plan">' +
						'<div><strong>' +
						status.updates +
						'</strong><span>Existing record' +
						(status.updates === 1 ? '' : 's') +
						' to update</span></div>' +
						'<div><strong>' +
						status.creates +
						'</strong><span>New record' +
						(status.creates === 1 ? '' : 's') +
						' to create</span></div></div>' +
						'<div class="mm-before-upload"><strong>Apply to canvas</strong><ul>' +
						'<li>The plan will replace migration choices with normal canvas records. Nothing is written to Salesforce until you use Upload.</li>' +
						blankUpdateItem +
						omissionItem +
						'</ul></div>';
				}

				function _differenceRecordLabel(rec) {
					const describe = canvasState.describeCache[rec.objectName];
					return _recordDisplayLabel(rec, describe, _allRecords(), recordOrdinal ? recordOrdinal(rec) : null);
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
						escapeHtml(keyText ? objectLabel + ' \u00b7 ' + keyText : _differenceRecordLabel(rec)) +
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

				function _destinationCandidates(rec) {
					const state = _destinationSearchState(rec);
					const source = state.query.trim() ? state.results : rec._migrateMatchCandidates || [];
					const byId = new Map();
					(rec._migrateMatchCandidates || []).forEach((candidate) => {
						if (candidate && candidate.id === rec._migrateMatchedId) {
							byId.set(candidate.id, candidate);
						}
					});
					source.forEach((candidate) => {
						if (candidate && candidate.id && !byId.has(candidate.id)) {
							byId.set(candidate.id, candidate);
						}
					});
					return Array.from(byId.values());
				}

				function _destinationResultsMarkup(rec, all) {
					const state = _destinationSearchState(rec);
					if (state.loading) {
						return '<div class="mm-search-status">Searching Salesforce...</div>';
					}
					if (state.error) {
						return (
							'<div class="mm-search-status mm-search-status--error">' +
							escapeHtml(state.error) +
							'</div>'
						);
					}
					const candidates = _destinationCandidates(rec);
					if (!candidates.length) {
						return (
							'<div class="mm-search-status">' +
							(state.query.trim()
								? 'No destination records found.'
								: 'Type a record name to search the destination org.') +
							'</div>'
						);
					}
					return candidates
						.map((candidate) => {
							const selected = candidate.id === rec._migrateMatchedId;
							const claimedByOther = all.some(
								(other) => other && other !== rec && other._migrateMatchedId === candidate.id,
							);
							const reason = _candidateReason(rec, candidate);
							return (
								'<button type="button" class="mm-search-result' +
								(selected ? ' is-selected' : '') +
								'" data-mm-destination-id="' +
								escapeHtml(candidate.id) +
								'" role="option" aria-selected="' +
								(selected ? 'true' : 'false') +
								'"' +
								(claimedByOther ? ' disabled title="Already selected for another canvas record"' : '') +
								'><span><strong>' +
								escapeHtml(candidate.label || '(no name)') +
								'</strong><small>ID ' +
								escapeHtml(candidate.id) +
								(reason ? ' &middot; ' + escapeHtml(reason) : '') +
								(claimedByOther ? ' &middot; already selected' : '') +
								'</small></span>' +
								(selected ? '<span class="mm-search-selected">Selected</span>' : '') +
								'</button>'
							);
						})
						.join('');
				}

				function _renderDestinationSearchResults(rec) {
					const index = _allRecords().indexOf(rec);
					const card = decisionsEl.querySelector('[data-mm-record-index="' + index + '"]');
					const results = card && card.querySelector('.mm-search-results');
					if (results) {
						results.hidden = !_destinationSearchState(rec).open;
						results.innerHTML = _destinationResultsMarkup(rec, _allRecords());
					}
					const matchOptions = card && card.querySelector('.mm-match-options');
					if (matchOptions) {
						matchOptions.hidden = !_showAdvancedMatchOptions(rec);
					}
				}

				function _showAdvancedMatchOptions(rec) {
					const state = _destinationSearchState(rec);
					return Boolean(
						rec._migrateMatchSearchError ||
							(state.attempted && !state.loading && (state.error || state.results.length === 0)),
					);
				}

				function _decisionCard(rec, index, all) {
					const destinationSearch = _destinationSearchState(rec);
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
					const describe = canvasState.describeCache[rec.objectName];
					const objectLabel =
						(describe && describe.labelPlural) || (describe && describe.label) || rec.objectName;
					const targetControl =
						'<label for="mm-destination-search-' +
						index +
						'">Search destination ' +
						escapeHtml(objectLabel) +
						'</label><div class="mm-search-input-wrap"><input id="mm-destination-search-' +
						index +
						'" class="mm-destination-search" type="search" autocomplete="off" role="combobox" aria-autocomplete="list" aria-controls="mm-search-results-' +
						index +
						'" aria-expanded="' +
						(destinationSearch.open ? 'true' : 'false') +
						'" placeholder="Type a record name..." value="' +
						escapeHtml(destinationSearch.query) +
						'"></div><div id="mm-search-results-' +
						index +
						'" class="mm-search-results" role="listbox"' +
						(destinationSearch.open ? '' : ' hidden') +
						'>' +
						_destinationResultsMarkup(rec, all) +
						'</div>';
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
					const showMatchOptions = _showAdvancedMatchOptions(rec);
					const matchOptions =
						action === 'existing'
							? '<details class="mm-match-options"' +
								(showMatchOptions ? '' : ' hidden') +
								(rec._migrateMatchSearchError ? ' open' : '') +
								'><summary>Try another identifying field</summary>' +
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
										_collapseDestinationSearch(rec, available[0]);
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
						const destinationInput = card.querySelector('.mm-destination-search');
						if (destinationInput) {
							destinationInput.addEventListener('input', () => {
								const state = _destinationSearchState(rec);
								state.query = destinationInput.value;
								state.open = true;
								state.error = '';
								state.sequence++;
								clearTimeout(state.timer);
								if (!state.query.trim()) {
									state.results = [];
									state.attempted = false;
									state.loading = false;
									_renderDestinationSearchResults(rec);
									return;
								}
								state.loading = true;
								_renderDestinationSearchResults(rec);
								state.timer = setTimeout(() => _searchDestinationRecords(rec), 250);
							});
						}
						const destinationResults = card.querySelector('.mm-search-results');
						if (destinationResults) {
							destinationResults.addEventListener('click', (event) => {
								const button = event.target.closest('[data-mm-destination-id]');
								if (!button || button.disabled) {
									return;
								}
								const id = button.getAttribute('data-mm-destination-id');
								const candidate = _destinationCandidates(rec).find((item) => item.id === id);
								if (candidate && !(rec._migrateMatchCandidates || []).some((item) => item.id === id)) {
									rec._migrateMatchCandidates = (rec._migrateMatchCandidates || []).concat([
										candidate,
									]);
								}
								const result = _resolveRecord(rec, id, all);
								if (!result.ok && result.error === 'candidate-already-used') {
									showBulkToast(
										'That Salesforce record is already matched to another canvas record.',
										'warning',
									);
								}
								if (result.ok) {
									_collapseDestinationSearch(rec, candidate);
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
							if (rec._migrateMatchedId) {
								_collapseDestinationSearch(
									rec,
									(rec._migrateMatchCandidates || []).find(
										(candidate) => candidate.id === rec._migrateMatchedId,
									),
								);
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
									: 'Continue to fields';
						return;
					}
					if (currentStep === 'differences') {
						primaryBtn.disabled =
							differences.blocked > 0 || differences.pending > 0 || pendingFieldMapCount > 0;
						primaryBtn.textContent =
							differences.pending > 0
								? 'Waiting for destination fields...'
								: differences.blocked > 0
									? differences.requiredFields === differences.blocked
										? 'Complete ' +
											differences.requiredFields +
											' required field' +
											(differences.requiredFields === 1 ? '' : 's')
										: 'Resolve ' +
											differences.blocked +
											' required item' +
											(differences.blocked === 1 ? '' : 's')
									: pendingFieldMapCount > 0
										? 'Choose ' +
											pendingFieldMapCount +
											' destination value' +
											(pendingFieldMapCount === 1 ? '' : 's')
										: 'View summary';
						return;
					}
					primaryBtn.disabled = false;
					primaryBtn.textContent = 'Apply migration to canvas';
				}

				function _recomputeSummary() {
					const counts = _statusCounts();
					const differences = _differenceCounts();
					const attention =
						counts.unresolved + differences.blocked + differences.warnings + differences.pending;
					summaryEl.innerHTML =
						'<div class="mm-summary-line"><span><strong>' +
						counts.updates +
						'</strong> existing record' +
						(counts.updates === 1 ? '' : 's') +
						' to update</span><i>\u00b7</i><span><strong>' +
						counts.creates +
						'</strong> new record' +
						(counts.creates === 1 ? '' : 's') +
						' to create</span><i>\u00b7</i><span class="' +
						(attention ? 'is-warn' : 'is-ready') +
						'">' +
						(attention ? attention + ' need' + (attention === 1 ? 's' : '') + ' attention' : 'Ready') +
						'</span></div>';
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
			automaticFieldCandidate: _automaticFieldCandidate,
			recordDisplayLabel: _recordDisplayLabel,
			searchCandidate: _searchCandidate,
		},
	};
})();
