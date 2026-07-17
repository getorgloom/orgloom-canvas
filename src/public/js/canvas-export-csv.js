// Canvas → CSV export.
//
// Dumps records on the canvas to CSV as one file per object type:
// each file is a clean single-object table (its own field set, no
// cross-object column union, no discriminator column) so it maps
// straight back through CSV import. Walks canvasState.bulkRecords in
// memory; no SF round-trip. Output is RFC 4180-quoted (comma /
// newline / quote in a value triggers double-quote wrapping, internal
// quotes are escaped by doubling) and prefixed with a UTF-8 BOM so
// Excel opens accented characters cleanly instead of mangling them to
// mojibake.
//
// Public API (returned from mount):
//   openModal()
//
// Exposed as window.OrgLoom.canvasExportCsv. Load order: before app.js.

(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	// Fields we never emit in the CSV. Skipping `_`-prefix preserves
	// the internal-state convention used everywhere else (Diff, Search,
	// orphan detection). System fields are dropped because they're
	// either auto-generated on commit (Id, audit timestamps) or
	// never user-meaningful (IsDeleted); surfacing them in a CSV
	// users will hand-edit + re-import is a footgun.
	const SYSTEM_FIELDS = new Set([
		'CreatedDate', 'CreatedById',
		'LastModifiedDate', 'LastModifiedById',
		'SystemModstamp',
		'LastReferencedDate', 'LastViewedDate',
		'IsDeleted',
	]);

	// Preferred ordering for the leading columns when present. Id
	// first because it's the universal SF identifier; then identity-
	// shaped fields (Name, then FirstName/LastName, then Email) so
	// the leftmost columns are immediately recognizable when the file
	// opens. Everything else falls through to alpha order below.
	const FIELD_PRIORITY = [
		'Id',
		'Name', 'FirstName', 'LastName',
		'Subject', 'Title', 'CaseNumber',
		'Email', 'Phone',
	];

	window.OrgLoom.canvasExportCsv = {
		mount: function mount(deps) {
			const required = ['canvasState', 'escapeHtml', 'showBulkToast'];
			if (!deps) {
throw new Error('canvas-export-csv.mount: missing deps object');
}
			for (const k of required) {
				if (deps[k] === undefined || deps[k] === null) {
					throw new Error('canvas-export-csv.mount: missing dep ' + k);
				}
			}
			const canvasState = deps.canvasState;
			const escapeHtml = deps.escapeHtml;
			const showBulkToast = deps.showBulkToast;

			function sanitizeFilename(s) {
				return String(s || 'canvas')
					.replace(/[^a-zA-Z0-9_\-. ]+/g, '_')
					.slice(0, 80) || 'canvas';
			}

			// RFC 4180 escape + CSV formula-injection guard. Non-string
			// values go through String(); null/undefined become empty so
			// leading/trailing fields don't collapse columns.
			//
			// Formula guard: Excel / Google Sheets EXECUTE a cell whose
			// text begins with = + - @ (or a leading tab/CR that shifts the
			// first visible character), so a Salesforce text field carrying
			// `=HYPERLINK(...)` or `=cmd|'/c calc'!A1` would run on open.
			// RFC quoting alone does NOT stop this: the spreadsheet still
			// parses the leading `=`. Prefixing a single apostrophe forces
			// the cell to literal text (Excel/Sheets hide the apostrophe).
			// Trade-off: a re-import of such a rare formula-shaped value
			// carries the leading `'`; safety wins over that edge case.
			function csvEscape(v) {
				if (v == null) {
return '';
}
				let s = typeof v === 'string' ? v : String(v);
				if (/^[=+\-@\t\r]/.test(s)) {
					s = "'" + s;
				}
				if (/[",\r\n]/.test(s)) {
					return '"' + s.replace(/"/g, '""') + '"';
				}
				return s;
			}

			// Order field names: priority list first (in the listed
			// order), then everything else alphabetically. Stable
			// regardless of the order keys appear on the source
			// records.
			function orderFields(names) {
				const set = new Set(names);
				const head = FIELD_PRIORITY.filter((f) => set.has(f));
				const headSet = new Set(head);
				const tail = Array.from(set)
					.filter((f) => !headSet.has(f))
					.sort();
				return head.concat(tail);
			}

			// Real records only: type nodes (object placeholders) and
			// pending records (mid-spawn) are canvas chrome, not data.
			function selectScopedRecords(scope) {
				const all = (canvasState.bulkRecords || []).filter(
					(r) => r && !r.isTypeNode && !r.isPending
				);
				if (scope === 'selected') {
					const sel = canvasState.bulkSelectedIds;
					return all.filter((r) => sel && sel.has(r.id));
				}
				return all;
			}

			// Collect every value-key seen across the given records,
			// excluding `_`-prefix and the system-field set.
			function collectFieldUnion(records) {
				const set = new Set();
				records.forEach((r) => {
					const v = (r && r.values) || {};
					Object.keys(v).forEach((k) => {
						if (!k || k.startsWith('_')) {
return;
}
						if (SYSTEM_FIELDS.has(k)) {
return;
}
						set.add(k);
					});
				});
				return Array.from(set);
			}

			// Build the CSV text. `leadingColumns` is an optional list of
			// header-name → per-record extractor pairs prepended to each
			// row before the field columns. Currently unused; per-object
			// export emits just the object's own fields.
			function buildCsv(records, fields, leadingColumns) {
				const lead = Array.isArray(leadingColumns) ? leadingColumns : [];
				const headerCells = lead.map((c) => csvEscape(c.header)).concat(
					fields.map((f) => csvEscape(f))
				);
				const lines = [headerCells.join(',')];
				records.forEach((r) => {
					const values = (r && r.values) || {};
					const leadCells = lead.map((c) => csvEscape(c.get(r)));
					const fieldCells = fields.map((f) => csvEscape(values[f]));
					lines.push(leadCells.concat(fieldCells).join(','));
				});
				// CRLF line endings + UTF-8 BOM so Excel on Windows
				// opens accented characters cleanly. The blob itself
				// is text/csv; downstream parsers strip the BOM.
				return '﻿' + lines.join('\r\n');
			}

			function triggerDownload(filename, csvText) {
				const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8' });
				const url = URL.createObjectURL(blob);
				const a = document.createElement('a');
				a.href = url;
				a.download = filename;
				document.body.appendChild(a);
				a.click();
				setTimeout(() => {
 URL.revokeObjectURL(url); a.remove(); 
}, 0);
			}

			// ----- modal -----

			const modal = document.createElement('div');
			modal.className = 'modal canvas-export-csv-modal hidden';
			modal.innerHTML =
				'<div class="modal-overlay" data-cec-close></div>' +
				'<div class="modal-body" style="max-width:540px">' +
					'<div class="modal-header">' +
						'<h3>Export canvas to CSV</h3>' +
						'<button class="modal-close" data-cec-close>&times;</button>' +
					'</div>' +
					'<div class="modal-content" id="cec-content"></div>' +
					'<div class="modal-footer" id="cec-footer"></div>' +
				'</div>';
			document.body.appendChild(modal);
			modal.querySelectorAll('[data-cec-close]').forEach((el) => {
				el.addEventListener('click', closeModal);
			});
			document.addEventListener('keydown', (e) => {
				if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
					closeModal();
				}
			});

			let _state = null;

			function closeModal() {
				modal.classList.add('hidden');
				_state = null;
			}

			function openModal() {
				const selectedCount = (canvasState.bulkRecords || []).filter(
					(r) => r && !r.isTypeNode && !r.isPending
						&& canvasState.bulkSelectedIds && canvasState.bulkSelectedIds.has(r.id)
				).length;
				const allCount = (canvasState.bulkRecords || []).filter(
					(r) => r && !r.isTypeNode && !r.isPending
				).length;
				_state = {
					scope: selectedCount > 0 ? 'selected' : 'all',
					filename: defaultFilename(),
					selectedCount,
					allCount,
				};
				renderForm();
				modal.classList.remove('hidden');
			}

			function defaultFilename() {
				const title = canvasState.currentCanvas && canvasState.currentCanvas.title;
				const stem = sanitizeFilename(title || 'canvas-' + new Date().toISOString().slice(0, 10));
				return stem;
			}

			function renderForm() {
				if (!_state) {
return;
}
				const body = modal.querySelector('#cec-content');
				const footer = modal.querySelector('#cec-footer');
				const objectCounts = {};
				selectScopedRecords(_state.scope).forEach((r) => {
					const k = r.objectName || '(unknown)';
					objectCounts[k] = (objectCounts[k] || 0) + 1;
				});
				const objectNames = Object.keys(objectCounts).sort();
				const objectChips = objectNames.length === 0
					? '<span class="cec-empty">No records in scope.</span>'
					: objectNames.map((n) =>
						'<span class="cec-obj-chip"><code>' + escapeHtml(n) + '</code> &middot; ' + objectCounts[n] + '</span>'
					).join('');
				const scopeAllDisabled = _state.allCount === 0 ? ' disabled' : '';
				const scopeSelectedDisabled = _state.selectedCount === 0 ? ' disabled' : '';
				body.innerHTML =
					'<p class="tag">Downloads the records on this canvas as CSV, one file per object type. System-managed fields (audit timestamps, IsDeleted) are excluded.</p>' +
					'<div class="cec-section">' +
						'<label class="cec-section-head">Scope</label>' +
						'<label class="cec-opt"><input type="radio" name="cec-scope" value="all"' +
							(_state.scope === 'all' ? ' checked' : '') + scopeAllDisabled +
							'> All records <span class="cec-meta">(' + _state.allCount + ')</span></label>' +
						'<label class="cec-opt"><input type="radio" name="cec-scope" value="selected"' +
							(_state.scope === 'selected' ? ' checked' : '') + scopeSelectedDisabled +
							'> Selected only <span class="cec-meta">(' + _state.selectedCount + ')</span></label>' +
					'</div>' +
					'<div class="cec-section">' +
						'<label class="cec-section-head" for="cec-filename">Filename</label>' +
						'<input type="text" id="cec-filename" value="' + escapeHtml(_state.filename) + '" maxlength="80">' +
						'<div class="cec-meta">' +
							(objectNames.length > 1
								? 'One file per object: <code>' + escapeHtml(_state.filename) + '-&lt;ObjectName&gt;.csv</code>'
								: '<code>' + escapeHtml(_state.filename) + '.csv</code>') +
						'</div>' +
					'</div>' +
					'<div class="cec-section">' +
						'<label class="cec-section-head">Included objects</label>' +
						'<div class="cec-objects">' + objectChips + '</div>' +
					'</div>';
				const downloadDisabled = objectNames.length === 0 ? ' disabled aria-disabled="true"' : '';
				footer.innerHTML =
					'<button class="button secondary" data-cec-close>Cancel</button>' +
					'<button class="button" id="cec-download"' + downloadDisabled + '>Download</button>';
				footer.querySelectorAll('[data-cec-close]').forEach((el) => {
					el.addEventListener('click', closeModal);
				});
				body.querySelectorAll('input[name="cec-scope"]').forEach((el) => {
					el.addEventListener('change', () => {
						if (el.checked) {
							_state.scope = el.value;
							renderForm();
						}
					});
				});
				const filenameEl = body.querySelector('#cec-filename');
				if (filenameEl) {
					filenameEl.addEventListener('input', () => {
						_state.filename = filenameEl.value;
						// Only the meta-preview line under the input
						// needs to refresh; full re-render would steal
						// caret focus on every keystroke. Cheaper to
						// patch the preview node directly.
						const preview = body.querySelector('.cec-section .cec-meta code');
						if (preview) {
							preview.textContent = objectNames.length > 1
								? _state.filename + '-<ObjectName>.csv'
								: _state.filename + '.csv';
						}
					});
				}
				const downloadBtn = footer.querySelector('#cec-download');
				if (downloadBtn && !downloadBtn.disabled) {
					downloadBtn.addEventListener('click', runDownload);
				}
			}

			function runDownload() {
				if (!_state) {
return;
}
				const records = selectScopedRecords(_state.scope);
				if (records.length === 0) {
					showBulkToast('No records in the selected scope.', 'error');
					return;
				}
				const stem = sanitizeFilename(_state.filename || 'canvas');
				// One file per object type. Each file holds a single object's
				// own field set: no cross-object column union, no _Object /
				// _RecordId discriminator, so every file is a clean,
				// single-type table that maps straight back through CSV
				// import. A single-object canvas yields just <stem>.csv;
				// multiple objects yield <stem>-<ObjectName>.csv each.
				const byObject = new Map();
				records.forEach((r) => {
					const key = r.objectName || 'Unknown';
					if (!byObject.has(key)) {
byObject.set(key, []);
}
					byObject.get(key).push(r);
				});
				const entries = Array.from(byObject.entries()).sort((a, b) => a[0].localeCompare(b[0]));
				const single = entries.length === 1;
				// Browsers throttle rapid programmatic downloads: 120ms
				// spacing keeps Chrome / Edge / Firefox all happy through
				// ~10 files without prompting "allow multiple downloads."
				let i = 0;
				const fireNext = () => {
					if (i >= entries.length) {
						showBulkToast('Exported ' + records.length + ' record' + (records.length === 1 ? '' : 's') + ' across ' + entries.length + ' file' + (entries.length === 1 ? '' : 's') + '.');
						closeModal();
						return;
					}
					const [objName, recs] = entries[i++];
					const fields = orderFields(collectFieldUnion(recs));
					const csv = buildCsv(recs, fields, []);
					const name = single ? stem + '.csv' : stem + '-' + sanitizeFilename(objName) + '.csv';
					triggerDownload(name, csv);
					setTimeout(fireNext, 120);
				};
				fireNext();
			}

			return {
				openModal: openModal,
				// Test-only surface: the pure CSV helpers, so escaping /
				// formula-injection / field-ordering can be unit-tested
				// without standing up the modal DOM. Not used by app code.
				_test: {
					csvEscape: csvEscape,
					buildCsv: buildCsv,
					orderFields: orderFields,
					collectFieldUnion: collectFieldUnion,
					sanitizeFilename: sanitizeFilename,
				},
			};
		},
	};
})();
