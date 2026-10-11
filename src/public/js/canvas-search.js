(function () {
	'use strict';
	// Searches canvas values and selects matching records by object.

	window.OrgLoom = window.OrgLoom || {};

	const SYSTEM_FIELDS = new Set([
		'Id',
		'CreatedDate',
		'CreatedById',
		'LastModifiedDate',
		'LastModifiedById',
		'SystemModstamp',
		'LastReferencedDate',
		'LastViewedDate',
		'IsDeleted',
	]);

	window.OrgLoom.canvasSearch = {
		mount: function mount(deps) {
			const required = ['canvasState', 'getCyInstance', 'escapeHtml', 'setSelection'];
			if (!deps) {
				throw new Error('canvas-search.mount: missing deps object');
			}
			for (const k of required) {
				if (deps[k] === undefined || deps[k] === null) {
					throw new Error('canvas-search.mount: missing dep ' + k);
				}
			}
			const canvasState = deps.canvasState;
			const getCyInstance = deps.getCyInstance;
			const escapeHtml = deps.escapeHtml;
			let activeObject = null;
			let activeRecords = [];

			const modal = document.createElement('div');
			modal.className = 'modal canvas-search-modal hidden';
			modal.innerHTML =
				'<div class="modal-overlay" data-csr-close></div>' +
				'<div class="modal-body" style="max-width:640px">' +
				'<div class="modal-header">' +
				'<h3>Search canvas</h3>' +
				'<button class="modal-close" data-csr-close>&times;</button>' +
				'</div>' +
				'<div class="modal-content">' +
				'<input type="search" id="csr-input" class="csr-input" ' +
				'placeholder="Search field values across all cards on the canvas…" ' +
				'autocomplete="off" spellcheck="false">' +
				'<div class="csr-stats" id="csr-stats"></div>' +
				'<div class="csr-tabs" id="csr-tabs"></div>' +
				'<div class="csr-results" id="csr-results" role="region" aria-label="Search results"></div>' +
				'</div>' +
				'<div class="modal-footer">' +
				'<button class="button secondary" data-csr-close>Close</button>' +
				'</div>' +
				'</div>';
			document.body.appendChild(modal);

			const input = modal.querySelector('#csr-input');
			const statsEl = modal.querySelector('#csr-stats');
			const resultsEl = modal.querySelector('#csr-results');
			const tabsEl = modal.querySelector('#csr-tabs');

			function closeModal() {
				modal.classList.add('hidden');
				input.blur();
			}
			function openModal(initialQuery) {
				modal.classList.remove('hidden');
				if (typeof initialQuery === 'string' && initialQuery.length > 0) {
					input.value = initialQuery;
				}
				renderResults();
				requestAnimationFrame(() => {
					input.focus();
					input.select();
				});
			}

			modal.querySelectorAll('[data-csr-close]').forEach((el) => {
				el.addEventListener('click', closeModal);
			});
			document.addEventListener('keydown', (e) => {
				if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
					e.preventDefault();
					closeModal();
				}
			});

			function recordLabel(rec) {
				const v = (rec && rec.values) || {};
				if (v.Name) {
					return String(v.Name);
				}
				const fn = v.FirstName || '';
				const ln = v.LastName || '';
				if (fn || ln) {
					return (fn + ' ' + ln).trim();
				}
				if (v.Subject) {
					return String(v.Subject);
				}
				if (v.Title) {
					return String(v.Title);
				}
				if (v.CaseNumber) {
					return String(v.CaseNumber);
				}
				return rec && rec.objectName ? '(unnamed ' + rec.objectName + ')' : '(unnamed)';
			}

			function search(query) {
				const q = String(query || '')
					.trim()
					.toLowerCase();
				if (!q) {
					return { matches: [], recordsScanned: 0 };
				}
				const recs = Array.isArray(canvasState.bulkRecords) ? canvasState.bulkRecords : [];
				const matches = [];
				let recordsScanned = 0;
				for (const rec of recs) {
					if (!rec || rec.isTypeNode || rec.isPending) {
						continue;
					}
					recordsScanned++;
					const label = recordLabel(rec);
					const labelLower = label.toLowerCase();
					const labelHit = labelLower.indexOf(q) !== -1;
					let perRecordFieldHits = 0;
					const values = (rec && rec.values) || {};
					for (const k of Object.keys(values)) {
						if (!k || k.startsWith('_')) {
							continue;
						}
						if (SYSTEM_FIELDS.has(k)) {
							continue;
						}
						const v = values[k];
						if (v == null || v === '') {
							continue;
						}
						const sv = String(v);
						const svLower = sv.toLowerCase();
						const idx = svLower.indexOf(q);
						if (idx === -1) {
							continue;
						}
						matches.push({
							recordId: rec.id,
							objectName: rec.objectName,
							label,
							fieldName: k,
							value: sv,
							matchStart: idx,
							matchLen: q.length,
							kind: 'field',
						});
						perRecordFieldHits++;
					}
					if (perRecordFieldHits === 0) {
						if (labelHit) {
							matches.push({
								recordId: rec.id,
								objectName: rec.objectName,
								label,
								fieldName: null,
								value: label,
								matchStart: labelLower.indexOf(q),
								matchLen: q.length,
								kind: 'label',
							});
						} else if (rec.loadedFromId) {
							const idStr = String(rec.loadedFromId);
							const idIdx = idStr.toLowerCase().indexOf(q);
							if (idIdx !== -1) {
								matches.push({
									recordId: rec.id,
									objectName: rec.objectName,
									label,
									fieldName: null,
									value: idStr,
									matchStart: idIdx,
									matchLen: q.length,
									kind: 'id',
								});
							}
						}
					}
				}
				return { matches, recordsScanned };
			}

			function renderMatchedValue(value, matchStart, matchLen) {
				if (matchStart < 0) {
					return escapeHtml(value);
				}
				const before = value.slice(0, matchStart);
				const hit = value.slice(matchStart, matchStart + matchLen);
				const after = value.slice(matchStart + matchLen);
				return escapeHtml(before) + '<mark class="csr-mark">' + escapeHtml(hit) + '</mark>' + escapeHtml(after);
			}

			function renderResults() {
				const query = input.value || '';
				const { matches, recordsScanned } = search(query);
				activeRecords = [];
				tabsEl.innerHTML = '';
				tabsEl.removeAttribute('role');
				resultsEl.removeAttribute('aria-labelledby');
				resultsEl.setAttribute('role', 'region');
				if (!query.trim()) {
					statsEl.textContent = '';
					resultsEl.innerHTML = '';
					return;
				}
				if (matches.length === 0) {
					statsEl.textContent =
						'No matches in ' + recordsScanned + ' record' + (recordsScanned === 1 ? '' : 's') + '.';
					resultsEl.innerHTML = '<div class="csr-empty">No field values or record names contain that.</div>';
					return;
				}
				statsEl.textContent = '';
				const groups = new Map();
				for (const match of matches) {
					const object = match.objectName || 'Record';
					if (!groups.has(object)) groups.set(object, new Map());
					const records = groups.get(object);
					if (!records.has(match.recordId)) records.set(match.recordId, { ...match, hits: [] });
					records.get(match.recordId).hits.push(match);
				}
				const objects = Array.from(groups.keys()).sort();
				if (!groups.has(activeObject)) activeObject = objects[0];
				activeRecords = Array.from(groups.get(activeObject).values());
				if (objects.length === 1) {
					tabsEl.innerHTML =
						'<div class="csr-object-heading">' +
						escapeHtml(activeObject) +
						' (' +
						activeRecords.length +
						')</div>';
				} else {
					tabsEl.setAttribute('role', 'tablist');
					tabsEl.setAttribute('aria-label', 'Matching objects');
					tabsEl.innerHTML = objects
						.map(
							(object, i) =>
								'<button type="button" class="csr-tab" role="tab" id="csr-tab-' +
								i +
								'" aria-controls="csr-results" aria-selected="' +
								(object === activeObject) +
								'" tabindex="' +
								(object === activeObject ? '0' : '-1') +
								'" data-csr-tab="' +
								i +
								'">' +
								escapeHtml(object) +
								' (' +
								groups.get(object).size +
								')</button>',
						)
						.join('');
					resultsEl.setAttribute('role', 'tabpanel');
					resultsEl.setAttribute('aria-labelledby', 'csr-tab-' + objects.indexOf(activeObject));
					tabsEl.querySelectorAll('[data-csr-tab]').forEach((tab, i) => {
						tab.addEventListener('click', () => {
							activeObject = objects[i];
							renderResults();
							tabsEl.querySelector('[aria-selected="true"]').focus();
						});
						tab.addEventListener('keydown', (e) => {
							const next =
								e.key === 'ArrowRight'
									? (i + 1) % objects.length
									: e.key === 'ArrowLeft'
										? (i + objects.length - 1) % objects.length
										: e.key === 'Home'
											? 0
											: e.key === 'End'
												? objects.length - 1
												: null;
							if (next === null) return;
							e.preventDefault();
							tabsEl.querySelector('[data-csr-tab="' + next + '"]').click();
						});
					});
				}
				resultsEl.scrollTop = 0;
				resultsEl.innerHTML =
					'<table class="csr-table"><thead><tr><th class="csr-select-cell"><input type="checkbox" data-csr-all aria-label="Select all matching ' +
					escapeHtml(activeObject) +
					' records"></th><th scope="col">Record</th><th scope="col">Matches</th></tr></thead><tbody>' +
					activeRecords
						.map(
							(record, i) =>
								'<tr><td class="csr-select-cell"><input type="checkbox" data-csr-select="' +
								i +
								'" aria-label="Select ' +
								escapeHtml(record.label) +
								'"></td><td><button type="button" class="csr-result" data-csr-idx="' +
								i +
								'">' +
								escapeHtml(record.label) +
								'</button></td><td>' +
								record.hits
									.map(
										(m) =>
											'<div class="csr-result-body"><span class="csr-field">' +
											escapeHtml(m.fieldName || (m.kind === 'id' ? 'Salesforce Id' : 'Name')) +
											'</span><span class="csr-result-value">' +
											renderMatchedValue(m.value, m.matchStart, m.matchLen) +
											'</span></div>',
									)
									.join('') +
								'</td></tr>',
						)
						.join('') +
					'</tbody></table>';
				resultsEl.querySelector('[data-csr-all]').addEventListener('change', (e) => {
					applySelection(e.target.checked ? activeRecords.map((r) => r.recordId) : []);
				});
				resultsEl.querySelectorAll('[data-csr-select]').forEach((checkbox, i) => {
					checkbox.addEventListener('change', () => {
						const ids = new Set(
							activeRecords
								.filter((r) => canvasState.bulkSelectedIds?.has(r.recordId))
								.map((r) => r.recordId),
						);
						if (checkbox.checked) ids.add(activeRecords[i].recordId);
						else ids.delete(activeRecords[i].recordId);
						applySelection(Array.from(ids));
					});
				});
				syncCheckboxes();
				resultsEl.querySelectorAll('[data-csr-idx]').forEach((btn) => {
					btn.addEventListener('click', () => {
						const i = parseInt(btn.dataset.csrIdx, 10);
						const m = activeRecords[i];
						if (!m) {
							return;
						}
						jumpToRecord(m.recordId);
						closeModal();
					});
				});
			}

			function applySelection(ids) {
				// Resolve against live records so removed/pending records cannot be selected.
				const liveIds = new Set(
					canvasState.bulkRecords
						.filter((r) => r && !r.isTypeNode && !r.isPending && r.objectName === activeObject)
						.map((r) => r.id),
				);
				deps.setSelection(ids.filter((id) => liveIds.has(id)));
				if (activeRecords.some((r) => !liveIds.has(r.recordId))) {
					const scrollTop = resultsEl.scrollTop;
					renderResults();
					resultsEl.scrollTop = scrollTop;
					return;
				}
				syncCheckboxes();
			}

			function syncCheckboxes() {
				let selected = 0;
				resultsEl.querySelectorAll('[data-csr-select]').forEach((checkbox, i) => {
					checkbox.checked = !!canvasState.bulkSelectedIds?.has(activeRecords[i].recordId);
					checkbox.closest('tr').classList.toggle('csr-selected', checkbox.checked);
					if (checkbox.checked) selected++;
				});
				const all = resultsEl.querySelector('[data-csr-all]');
				if (all) {
					all.checked = activeRecords.length > 0 && selected === activeRecords.length;
					all.indeterminate = selected > 0 && selected < activeRecords.length;
				}
			}

			let _debounce = null;
			input.addEventListener('input', () => {
				if (_debounce) {
					clearTimeout(_debounce);
				}
				_debounce = setTimeout(renderResults, 60);
			});
			input.addEventListener('keydown', (e) => {
				if (e.key !== 'Enter') {
					return;
				}
				const first = resultsEl.querySelector('[data-csr-idx]');
				if (first) {
					first.click();
				}
			});

			function jumpToRecord(recordId) {
				const cy = getCyInstance && getCyInstance();
				if (!cy) {
					return;
				}
				const node = cy.getElementById('r' + recordId);
				if (!node || !node.length) {
					return;
				}
				cy.animate({
					center: { eles: node },
					duration: 380,
					easing: 'ease-out',
				});
				try {
					node.addClass('csr-flash');
				} catch (_) {}
				setTimeout(() => {
					try {
						node.removeClass('csr-flash');
					} catch (_) {}
				}, 1400);
			}

			return { openModal: openModal };
		},
	};
})();
