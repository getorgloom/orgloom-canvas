(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.bulkEditModal = {
		mount: function mount(deps) {
			if (!deps || !deps.canvasState || !deps.ensureDescribe || !deps.escapeHtml
				|| !deps.renderBulkView || !deps.showBulkToast) {
				throw new Error('bulk-edit-modal.mount: missing required deps');
			}
			const canvasState = deps.canvasState;
			const ensureDescribe = deps.ensureDescribe;
			const escapeHtml = deps.escapeHtml;
			const renderBulkView = deps.renderBulkView;
			const showBulkToast = deps.showBulkToast;

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
							showBulkToast('Can\u2019t undo Bulk edit because one or more affected records were edited afterward.', 'info');
							return;
						}
						entries.forEach((p) => _replaceValues(p.rec, p.priorValues));
						renderBulkView();
						showBulkToast('Restored the previous field values.');
					};
				};
			}

				const bulkEditModal = document.createElement('div');
				bulkEditModal.className = 'modal hidden';
				bulkEditModal.innerHTML =
					'<div class="modal-overlay" data-be-close></div>' +
					'<div class="modal-body" style="max-width:560px">' +
						'<div class="modal-header">' +
							'<h3>Bulk edit</h3>' +
							'<button class="modal-close" data-be-close>&times;</button>' +
						'</div>' +
						'<div class="modal-content" id="bulk-edit-content"></div>' +
						'<div class="modal-footer">' +
							'<button class="button secondary" data-be-close>Cancel</button>' +
							'<button class="button" id="bulk-edit-apply">Apply</button>' +
						'</div>' +
					'</div>';
				document.body.appendChild(bulkEditModal);
				bulkEditModal.querySelectorAll('[data-be-close]').forEach(el => el.addEventListener('click', closeBulkEditModal));
				document.addEventListener('keydown', e => {
 if (e.key === 'Escape' && !bulkEditModal.classList.contains('hidden')) {
closeBulkEditModal();
} 
});

				let _beState = null;

				function openBulkEditModal() {
					if (canvasState.bulkRecords.length === 0) {
						showBulkToast('Add some records first.', 'error');
						return;
					}

					const objCounts = new Map();
					canvasState.bulkRecords.forEach(r => objCounts.set(r.objectName, (objCounts.get(r.objectName) || 0) + 1));
					const activeObj = (canvasState.selectedObjects[canvasState.activeIndex] && objCounts.has(canvasState.selectedObjects[canvasState.activeIndex].name))
						? canvasState.selectedObjects[canvasState.activeIndex].name
						: Array.from(objCounts.keys())[0];
					_beState = {
						action: 'replace',
						objectName: activeObj,
						scope: canvasState.bulkSelectedIds.size > 0 ? 'selected' : 'all',
						fieldName: null,
						find: '',
						replace: '',
						caseSensitive: false,
						wholeField: false,
						value: '',
					};

					ensureDescribe(activeObj).then(() => {
						renderBulkEditModal();
					}).catch(() => renderBulkEditModal());
					bulkEditModal.classList.remove('hidden');
				}
				function closeBulkEditModal() {
					bulkEditModal.classList.add('hidden');
					_beState = null;
				}

				function _isStringLikeField(f) {
					if (!f) {
return false;
}
					return ['string', 'textarea', 'email', 'phone', 'url', 'encryptedstring', 'picklist', 'multipicklist', 'combobox', 'reference', 'id'].indexOf(f.type) !== -1;
				}

				function _renderSetValueInput(field, current) {
					const cur = current == null ? '' : String(current);
					if (!field) {
						return '<input type="text" id="be-value" value="' + escapeHtml(cur) + '" placeholder="Pick a field first">';
					}
					switch (field.type) {
						case 'boolean': {
							const opt = (v, label) =>
								'<option value="' + v + '"' + (cur === v ? ' selected' : '') + '>' + label + '</option>';
							return '<select id="be-value">' +
								'<option value=""' + (cur === '' ? ' selected' : '') + '>(unset)</option>' +
								opt('true', 'True') + opt('false', 'False') +
								'</select>';
						}
						case 'picklist':
						case 'combobox': {
							const opts = (Array.isArray(field.picklistValues) ? field.picklistValues : [])
								.filter(p => p && p.active !== false)
								.map(p => '<option value="' + escapeHtml(p.value) + '"' + (cur === p.value ? ' selected' : '') + '>' + escapeHtml(p.label || p.value) + '</option>')
								.join('');
							return '<select id="be-value"><option value=""' + (cur === '' ? ' selected' : '') + '>(clear)</option>' + opts + '</select>';
						}
						case 'multipicklist': {
							const cur2 = cur ? cur.split(';') : [];
							const opts = (Array.isArray(field.picklistValues) ? field.picklistValues : [])
								.filter(p => p && p.active !== false)
								.map(p => '<option value="' + escapeHtml(p.value) + '"' + (cur2.indexOf(p.value) !== -1 ? ' selected' : '') + '>' + escapeHtml(p.label || p.value) + '</option>')
								.join('');
							return '<select id="be-value" multiple size="6" style="height:auto">' + opts + '</select>' +
								'<p class="tag" style="margin-top:0.3em">Hold Ctrl/Cmd to select multiple values.</p>';
						}
						case 'date':
							return '<input type="date" id="be-value" value="' + escapeHtml(cur) + '">';
						case 'datetime':
							return '<input type="datetime-local" id="be-value" value="' + escapeHtml(cur) + '">';
						case 'int':
						case 'double':
						case 'currency':
						case 'percent': {
							const stepAttr = field.type === 'int' ? ' step="1"' : ' step="any"';
							return '<input type="number" id="be-value" value="' + escapeHtml(cur) + '"' + stepAttr + ' placeholder="Number">';
						}
						case 'email':
							return '<input type="email" id="be-value" value="' + escapeHtml(cur) + '" placeholder="name@example.com">';
						case 'url':
							return '<input type="text" inputmode="url" id="be-value" value="' + escapeHtml(cur) + '" placeholder="https://\u2026">';
						case 'phone':
							return '<input type="tel" id="be-value" value="' + escapeHtml(cur) + '" placeholder="+1 555 0100">';
						case 'reference':
							return '<input type="text" id="be-value" value="' + escapeHtml(cur) + '" placeholder="Salesforce Id (15 or 18 chars)">' +
								'<p class="tag" style="margin-top:0.3em">Lookup fields take a Salesforce Id. For relationship-style linking, use the canvas drag-to-link instead.</p>';
						case 'textarea':
							return '<textarea id="be-value" rows="3" placeholder="(leave blank to clear)">' + escapeHtml(cur) + '</textarea>';
						default:
							return '<input type="text" id="be-value" value="' + escapeHtml(cur) + '" placeholder="(leave blank to clear)">';
					}
				}

				function _readSetValueFromInput(field, container) {
					if (!field) {
return '';
}
					if (field.type === 'multipicklist') {
						const sel = container.querySelector('#be-value');
						if (!sel) {
return '';
}
						return Array.from(sel.selectedOptions || []).map(o => o.value).filter(Boolean).join(';');
					}
					const el = container.querySelector('#be-value');
					return el ? String(el.value || '') : '';
				}

				function renderBulkEditModal() {
					if (!_beState) {
return;
}
					const content = bulkEditModal.querySelector('#bulk-edit-content');
					const describe = canvasState.describeCache[_beState.objectName];
					const fields = (describe && Array.isArray(describe.fields))
						? describe.fields.filter(f => f.createable).slice().sort((a, b) => (a.label || a.name).localeCompare(b.label || b.name))
						: [];
					if (!_beState.fieldName && fields.length > 0) {
_beState.fieldName = fields[0].name;
}
					const currentField = fields.find(f => f.name === _beState.fieldName) || null;
					const stringLike = _isStringLikeField(currentField);

					if (_beState.action === 'replace' && !stringLike && currentField) {
						_beState.action = 'set';
					}

					const objCounts = new Map();
					canvasState.bulkRecords.forEach(r => objCounts.set(r.objectName, (objCounts.get(r.objectName) || 0) + 1));
					const objOptions = Array.from(objCounts.keys()).map(name => {
						const sel = canvasState.selectedObjects.find(s => s.name === name);
						const label = (sel && sel.label) || name;
						const sel2 = name === _beState.objectName ? ' selected' : '';
						return '<option value="' + escapeHtml(name) + '"' + sel2 + '>' + escapeHtml(label) + ' (' + objCounts.get(name) + ')</option>';
					}).join('');

					const fieldOptions = fields.length === 0
						? '<option value="">No editable fields available</option>'
						: fields.map(f => {
							const sel = f.name === _beState.fieldName ? ' selected' : '';
							return '<option value="' + escapeHtml(f.name) + '"' + sel + '>' + escapeHtml(f.label || f.name) + ' (' + escapeHtml(f.name) + ')</option>';
						}).join('');

					const selectedScopeCount = canvasState.bulkRecords.filter(r => canvasState.bulkSelectedIds.has(r.id) && r.objectName === _beState.objectName).length;
					const allScopeCount = objCounts.get(_beState.objectName) || 0;
					const scopeRadios =
						'<label class="be-scope"><input type="radio" name="be-scope" value="all"' + (_beState.scope === 'all' ? ' checked' : '') + '> All ' + escapeHtml((canvasState.selectedObjects.find(s => s.name === _beState.objectName) || {}).label || _beState.objectName) + ' records (' + allScopeCount + ')</label>' +
						'<label class="be-scope"><input type="radio" name="be-scope" value="selected"' + (_beState.scope === 'selected' ? ' checked' : '') + (selectedScopeCount === 0 ? ' disabled' : '') + '> Selected only (' + selectedScopeCount + ')</label>';

					const replaceDisabledAttr = stringLike ? '' : ' disabled title="Find & replace works on text-like fields only"';
					const actionTabs =
						'<div class="be-tabs">' +
							'<button type="button" class="be-tab' + (_beState.action === 'replace' ? ' active' : '') + '" data-be-action="replace"' + replaceDisabledAttr + '>Find &amp; replace</button>' +
							'<button type="button" class="be-tab' + (_beState.action === 'set' ? ' active' : '') + '" data-be-action="set">Set value</button>' +
						'</div>';

					const actionPanel = _beState.action === 'replace'
						? '<div class="be-panel">' +
								'<div class="field"><label>Find</label><input type="text" id="be-find" value="' + escapeHtml(_beState.find) + '" placeholder="Text to search for"></div>' +
								'<div class="field"><label>Replace with</label><input type="text" id="be-replace" value="' + escapeHtml(_beState.replace) + '" placeholder="Replacement text"></div>' +
								'<label class="be-opt"><input type="checkbox" id="be-cs"' + (_beState.caseSensitive ? ' checked' : '') + '> Case sensitive</label>' +
								'<label class="be-opt"><input type="checkbox" id="be-whole"' + (_beState.wholeField ? ' checked' : '') + '> Match whole field only</label>' +
							'</div>'
						: '<div class="be-panel">' +
								'<div class="field"><label>New value</label>' + _renderSetValueInput(currentField, _beState.value) + '</div>' +
							'</div>';

					content.innerHTML =
						'<div class="be-row"><label>Object</label><select id="be-object">' + objOptions + '</select></div>' +
						'<div class="be-row"><label>Field</label><select id="be-field">' + fieldOptions + '</select></div>' +
						'<div class="be-row be-row--scope"><label>Scope</label><div class="be-scopes">' + scopeRadios + '</div></div>' +
						actionTabs +
						actionPanel +
						'<div class="be-preview" id="be-preview"></div>';

					const objSel = content.querySelector('#be-object');
					objSel.addEventListener('change', () => {
						_beState.objectName = objSel.value;
						_beState.fieldName = null;
						ensureDescribe(_beState.objectName).then(renderBulkEditModal).catch(renderBulkEditModal);
					});
					const fldSel = content.querySelector('#be-field');
					if (fldSel) {
fldSel.addEventListener('change', () => {
						_beState.fieldName = fldSel.value;
						renderBulkEditModal();
					});
}
					content.querySelectorAll('input[name="be-scope"]').forEach(r => {
						r.addEventListener('change', () => {
							if (r.checked) {
 _beState.scope = r.value; updateBulkEditPreview(); 
}
						});
					});
					content.querySelectorAll('[data-be-action]').forEach(b => {
						b.addEventListener('click', () => {
							if (b.disabled) {
return;
}
							_beState.action = b.dataset.beAction;
							renderBulkEditModal();
						});
					});
					const findEl = content.querySelector('#be-find');
					if (findEl) {
findEl.addEventListener('input', () => {
 _beState.find = findEl.value; updateBulkEditPreview(); 
});
}
					const repEl = content.querySelector('#be-replace');
					if (repEl) {
repEl.addEventListener('input', () => {
 _beState.replace = repEl.value; 
});
}
					const csEl = content.querySelector('#be-cs');
					if (csEl) {
csEl.addEventListener('change', () => {
 _beState.caseSensitive = csEl.checked; updateBulkEditPreview(); 
});
}
					const wholeEl = content.querySelector('#be-whole');
					if (wholeEl) {
wholeEl.addEventListener('change', () => {
 _beState.wholeField = wholeEl.checked; updateBulkEditPreview(); 
});
}

					const valEl = content.querySelector('#be-value');
					if (valEl) {
						const sync = () => {
 _beState.value = _readSetValueFromInput(currentField, content); 
};
						valEl.addEventListener('input', sync);
						valEl.addEventListener('change', sync);
					}

					updateBulkEditPreview();
				}

				function bulkEditAffectedRecords() {
					if (!_beState) {
return [];
}

					const recs = canvasState.bulkRecords.filter(r =>
						r.objectName === _beState.objectName && !r.isTypeNode && !r.isPending);
					if (_beState.scope === 'selected') {
return recs.filter(r => canvasState.bulkSelectedIds.has(r.id));
}
					return recs;
				}

				function bulkEditLoadedInScope() {
					return bulkEditAffectedRecords().filter(r => r.loadedFromId).length;
				}

				function bulkEditMatchCount() {
					if (!_beState) {
return 0;
}
					if (_beState.action === 'set') {
return bulkEditAffectedRecords().length;
}

					const affected = bulkEditAffectedRecords();
					const f = _beState.find || '';
					if (f === '') {
return 0;
}
					let n = 0;
					affected.forEach(r => {
						const v = r.values && r.values[_beState.fieldName];
						if (v == null || v === '') {
return;
}
						if (recordMatchesFind(String(v), f, _beState)) {
n++;
}
					});
					return n;
				}

				function recordMatchesFind(value, find, opts) {
					const cs = !!opts.caseSensitive;
					const whole = !!opts.wholeField;
					if (whole) {
return cs ? value === find : value.toLowerCase() === find.toLowerCase();
}
					return cs ? value.includes(find) : value.toLowerCase().includes(find.toLowerCase());
				}

				function updateBulkEditPreview() {
					const el = bulkEditModal.querySelector('#be-preview');
					const apply = bulkEditModal.querySelector('#bulk-edit-apply');
					if (!el || !_beState) {
return;
}
					if (!_beState.fieldName) {
						el.textContent = 'Pick a field to continue.';
						if (apply) {
apply.disabled = true;
}
						return;
					}

					const _loaded = bulkEditLoadedInScope();
					const sfHint = _loaded > 0
						? ' Includes ' + _loaded + ' Salesforce-loaded record' + (_loaded === 1 ? '' : 's') +
							' - the next upload writes these changes to Salesforce.'
						: '';
					if (_beState.action === 'replace') {
						const n = bulkEditMatchCount();
						const total = bulkEditAffectedRecords().length;
						el.textContent = (_beState.find === '')
							? 'Type something to find. (' + total + ' record' + (total === 1 ? '' : 's') + ' in scope.)' + sfHint
							: n + ' of ' + total + ' record' + (total === 1 ? '' : 's') + ' will be updated.' + sfHint;
						if (apply) {
apply.disabled = _beState.find === '' || n === 0;
}
					} else {
						const n = bulkEditAffectedRecords().length;
						el.textContent = n + ' record' + (n === 1 ? '' : 's') + ' will be updated.' + sfHint;
						if (apply) {
apply.disabled = n === 0;
}
					}
				}

				function _coerceForField(field, raw) {
					if (raw === '' || raw == null) {
return null;
}
					if (!field) {
return raw;
}
					switch (field.type) {
						case 'boolean':
							return raw === 'true' || raw === true;
						case 'int':
							return parseInt(raw, 10);
						case 'double':
						case 'currency':
						case 'percent':
							return Number(raw);
						default:
							return raw;
					}
				}

				function applyBulkEdit() {
					if (!_beState || !_beState.fieldName) {
return;
}
					const describe = canvasState.describeCache[_beState.objectName];
					const field = (describe && Array.isArray(describe.fields))
						? describe.fields.find(f => f.name === _beState.fieldName)
						: null;
					const affected = bulkEditAffectedRecords();

					const _undo = _captureValuesUndo(affected);
					let updatedCount = 0;
					const touchedRecords = [];
					if (_beState.action === 'replace') {
						const find = _beState.find;
						if (find === '') {
return;
}
						affected.forEach(r => {
							const v = (r.values || {})[_beState.fieldName];
							if (v == null || v === '') {
return;
}
							const sv = String(v);
							if (!recordMatchesFind(sv, find, _beState)) {
return;
}
							let nv;
							if (_beState.wholeField) {
								nv = _beState.replace;
							} else if (_beState.caseSensitive) {
								nv = sv.split(find).join(_beState.replace);
							} else {

								const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
								const rep = _beState.replace;
								nv = sv.replace(new RegExp(escaped, 'gi'), () => rep);
							}
							_replaceValues(r, Object.assign({}, r.values || {}, { [_beState.fieldName]: nv }));
							touchedRecords.push(r);
							updatedCount++;
						});
					} else {
						const coerced = _coerceForField(field, _beState.value);
						affected.forEach(r => {
							const next = Object.assign({}, r.values || {});
							if (coerced === null) {
delete next[_beState.fieldName];
} else {
next[_beState.fieldName] = coerced;
}
							_replaceValues(r, next);
							touchedRecords.push(r);
							updatedCount++;
						});
					}
					closeBulkEditModal();
					renderBulkView();
					const _msg = 'Updated ' + updatedCount + ' record' + (updatedCount === 1 ? '' : 's') + '.';
					if (updatedCount > 0 && showBulkToastWithAction) {
						showBulkToastWithAction(_msg, 'Undo', _undo(touchedRecords));
					} else {
						showBulkToast(_msg);
					}
				}
				bulkEditModal.querySelector('#bulk-edit-apply').onclick = applyBulkEdit;

			return {
				openModal: openBulkEditModal,
			};
		},
	};
})();
