
(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	const SYSTEM_FIELDS = new Set([
		'Id',
		'CreatedDate', 'CreatedById',
		'LastModifiedDate', 'LastModifiedById',
		'SystemModstamp',
		'LastReferencedDate', 'LastViewedDate',
		'IsDeleted',
	]);

	const MAX_RESULTS = 100;

	window.OrgLoom.canvasSearch = {
		mount: function mount(deps) {
			const required = ['canvasState', 'getCyInstance', 'escapeHtml'];
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
						'<div class="csr-results" id="csr-results"></div>' +
					'</div>' +
					'<div class="modal-footer">' +
						'<span class="tag csr-hint">Click a result to jump to the card. <kbd>Esc</kbd> to close.</span>' +
						'<button class="button secondary" data-csr-close>Close</button>' +
					'</div>' +
				'</div>';
			document.body.appendChild(modal);

			const input = modal.querySelector('#csr-input');
			const statsEl = modal.querySelector('#csr-stats');
			const resultsEl = modal.querySelector('#csr-results');

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
				const q = String(query || '').trim().toLowerCase();
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
						if (matches.length >= MAX_RESULTS) {
break;
}
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
					if (perRecordFieldHits === 0 && matches.length < MAX_RESULTS) {
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
					if (matches.length >= MAX_RESULTS) {
break;
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
				return escapeHtml(before) +
					'<mark class="csr-mark">' + escapeHtml(hit) + '</mark>' +
					escapeHtml(after);
			}

			function renderResults() {
				const query = input.value || '';
				const { matches, recordsScanned } = search(query);
				if (!query.trim()) {
					statsEl.textContent = '';
					resultsEl.innerHTML = '<div class="csr-empty">Start typing to find records by field value or name.</div>';
					return;
				}
				if (matches.length === 0) {
					statsEl.textContent = 'No matches in ' + recordsScanned + ' record' + (recordsScanned === 1 ? '' : 's') + '.';
					resultsEl.innerHTML = '<div class="csr-empty">No field values or record names contain that.</div>';
					return;
				}
				const cap = matches.length >= MAX_RESULTS
					? ' (showing first ' + MAX_RESULTS + ' - refine to narrow)'
					: '';
				statsEl.textContent = matches.length + ' match' + (matches.length === 1 ? '' : 'es') +
					' across ' + recordsScanned + ' record' + (recordsScanned === 1 ? '' : 's') + cap + '.';
				resultsEl.innerHTML = matches.map((m, i) => {
					const valueHtml = renderMatchedValue(m.value, m.matchStart, m.matchLen);
					const fieldChip = m.fieldName
						? '<span class="csr-field"><code>' + escapeHtml(m.fieldName) + '</code></span>'
						: (m.kind === 'id'
							? '<span class="csr-field csr-field--label">Salesforce Id</span>'
							: '<span class="csr-field csr-field--label">name</span>');
					return '<button type="button" class="csr-result" data-csr-idx="' + i + '">' +
						'<div class="csr-result-head">' +
							'<span class="csr-result-label">' + escapeHtml(m.label) + '</span>' +
							'<span class="csr-result-obj tag">' + escapeHtml(m.objectName || '') + '</span>' +
						'</div>' +
						'<div class="csr-result-body">' +
							fieldChip +
							'<span class="csr-result-value">' + valueHtml + '</span>' +
						'</div>' +
					'</button>';
				}).join('');
				resultsEl.querySelectorAll('[data-csr-idx]').forEach((btn) => {
					btn.addEventListener('click', () => {
						const i = parseInt(btn.dataset.csrIdx, 10);
						const m = matches[i];
						if (!m) {
return;
}
						jumpToRecord(m.recordId);
						closeModal();
					});
				});
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
