// SOQL Import modal: lets the user write a SELECT (with optional
// child subqueries) and pull records onto the canvas.
//
// Two-step UX: preview surfaces counts + the first few rows so users
// can catch typos / over-fetches before committing. Hits /api/query
// which validates + caps the query server-side.
//
// Full-fields mode (default ON): refetches each matching record with
// all FLS-allowed fields before adding to the canvas. Off → only the
// SELECT-projection fields are loaded (compact mode).
//
// Dependencies passed to mount():
//   canvasState: shared canvas state. Reads selectedObjects
//                        and bulkRecords for the dedupe index; mutates
//                        bulkRecords + bulkAssociations + bulkIdSeq
//                        on commit.
//   showBulkToast: toast notification.
//   escapeHtml: HTML escape utility.
//   csrfFetch: fetch wrapper (POSTs to /api/query).
//   addToSelection: async; registers an object on the canvas if
//                        not already present (the canvas needs the
//                        schema entry before record cards can render).
//   renderBulkView: re-renders the bulk canvas after commit.
//   getGraph: () => Element; canvas root, queried for the
//                        '#bulk-canvas' element to compute layout
//                        positions for new records.
//   clearBulkUserDeleted: callback that sets the
//                          _bulkUserDeleted closure flag in app.js
//                          back to false. soqlImportCommitToCanvas
//                          calls this on commit so subsequent renders
//                          treat the canvas as "intentionally
//                          populated" again rather than the empty
//                          intentional-empty state.
//
// Public API:
//   openModal(): show the SOQL import modal.
//
// Exposed as window.OrgLoom.soqlImport. Load order: before app.js.

(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.soqlImport = {
		mount: function mount(deps) {
			if (!deps || !deps.canvasState || !deps.showBulkToast || !deps.escapeHtml
				|| !deps.csrfFetch || !deps.addToSelection || !deps.renderBulkView
				|| !deps.getGraph || !deps.clearBulkUserDeleted
				|| !deps.relayoutNewRecords
				|| !deps.setSkipNextCyAutoPan
				|| !deps.clearEmptyStarterCard) {
				throw new Error('soql-import.mount: missing required deps');
			}
			const canvasState = deps.canvasState;
			const showBulkToast = deps.showBulkToast;
			const escapeHtml = deps.escapeHtml;
			const csrfFetch = deps.csrfFetch;
			// Canvas record-cap gate (single source of truth). Optional dep
			// so older mounts don't throw; defaults to "always allowed".
			const canvasCapCheck = typeof deps.canvasCapCheck === 'function'
				? deps.canvasCapCheck
				: function () {
 return { ok: true, blocked: false, reason: null }; 
};
			const addToSelection = deps.addToSelection;
			const renderBulkView = deps.renderBulkView;
			const getGraph = deps.getGraph;
			const clearBulkUserDeleted = deps.clearBulkUserDeleted;
			const relayoutNewRecords = deps.relayoutNewRecords;
			const setSkipNextCyAutoPan = deps.setSkipNextCyAutoPan;
			const clearEmptyStarterCard = deps.clearEmptyStarterCard;
			// Optional (present in the normal app.js mount): undo snapshot +
			// action-toast for the modal's post-commit Undo. The programmatic
			// runAndCommitSoql path deliberately does NOT snapshot; its
			// caller (Browse) owns the snapshot/rollback there.
			const captureUndoSnapshot = typeof deps.captureUndoSnapshot === 'function'
				? deps.captureUndoSnapshot : null;
			const showBulkToastWithAction = typeof deps.showBulkToastWithAction === 'function'
				? deps.showBulkToastWithAction : null;
			// Shared import helpers (telemetry, association admission).
			const _shared = window.OrgLoom.importShared;

			// Render the descriptive message from a non-ok /api/query
			// response. The backend returns { error: '<code>', message:
			// '<descriptive>' }; code is something like 'query-failed'
			// or 'aggregate-not-supported', while message carries the
			// actual reason (Salesforce's MALFORMED_QUERY text, the
			// specific aggregate that's banned, etc.). Showing just
			// the code is a dead-end for the visitor; this helper
			// renders message first and uses code only as a fallback
			// or eyebrow tag when both are present and they add value
			// together.
			function formatQueryError(body, status) {
				const code = body && body.error ? String(body.error) : '';
				const msg = body && body.message ? String(body.message) : '';
				if (msg && code && code !== 'query-failed') {
					return '<strong>' + escapeHtml(code) + '</strong> &middot; ' + escapeHtml(msg);
				}
				if (msg) {
return escapeHtml(msg);
}
				if (code) {
return escapeHtml(code);
}
				return 'HTTP ' + status;
			}



				// SOQL import modal: lets the user write a SELECT (with optional
				// child subqueries) and pull records onto the canvas. Two-step:
				// preview surfaces counts + the first few rows so users can
				// catch typos / over-fetches before committing. Hits /api/query
				// which validates + caps the query server-side.
				//
				// In playground mode (window.ORGLOOM_MOCK), the textarea is
				// locked to a single preset query so visitors can experience
				// the SOQL-import flow without an SF connection and without
				// the ability to execute arbitrary code through the mock.
				const PLAYGROUND_PRESET_SOQL =
					"SELECT Id, Name, Industry, Phone, Type,\n" +
					"       (SELECT Id, FirstName, LastName, Email, Title FROM Contacts)\n" +
					"FROM Account\n" +
					"WHERE Industry = 'Technology'\n" +
					"LIMIT 5";
				function openSoqlImportModal(opts) {
					opts = opts || {};
					document.querySelectorAll('.soql-import-modal').forEach((el) => el.remove());
					const isPlayground = !!window.ORGLOOM_MOCK;
					// presetSoql: caller-supplied SOQL string used to pre-fill
					// the textarea. Used by the Browse panel's Load-to-canvas
					// flow: it compiles its filter UI to a SOQL query and
					// hands it here so the user can review/edit before
					// committing. In playground mode the textarea is still
					// readonly, but the preset takes precedence over the
					// canned playground query so the browse-derived load
					// still reflects the user's intent.
					const presetSoql = typeof opts.presetSoql === 'string' && opts.presetSoql.trim()
						? opts.presetSoql.trim()
						: null;
					const modal = document.createElement('div');
					modal.className = 'modal soql-import-modal';
					const headerCopy = isPlayground && !presetSoql
						? '<p class="tag"><strong>Imports are capped at 500 records.</strong> Demo mode &middot; the query below is preset for the playground. Sign up to write your own SOQL against your real org.</p>'
						: '<p class="tag"><strong>Up to 500 records per import.</strong> Read-only SELECT, must include <code>Id</code>. Subqueries on child relationships are supported (e.g. <code>SELECT Id, Name, (SELECT Id, FirstName FROM Contacts) FROM Account</code>).</p>';
					const textareaAttrs = isPlayground && !presetSoql
						? ' readonly aria-readonly="true" style="width:100%;font-family:monospace;font-size:13px;background:var(--bg-elev);color:var(--ink-soft);cursor:not-allowed;"'
						: ' autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="SELECT Id, Name FROM Account WHERE CreatedDate = LAST_N_DAYS:30 LIMIT 50" style="width:100%;font-family:monospace;font-size:13px;"';
					const textareaValue = presetSoql || (isPlayground ? PLAYGROUND_PRESET_SOQL : '');
					modal.innerHTML =
						'<div class="modal-overlay" data-soql-close></div>' +
						'<div class="modal-body" style="max-width:720px">' +
							'<div class="modal-header">' +
								'<h3>Import via SOQL query</h3>' +
								'<button class="modal-close" data-soql-close>&times;</button>' +
							'</div>' +
							'<div class="modal-content">' +
								headerCopy +
								'<textarea id="soql-query" rows="8"' + textareaAttrs + '>' + escapeHtml(textareaValue) + '</textarea>' +
								// Full-fields mode: default ON. Refetches each
								// matching record with all FLS-allowed fields
								// before adding to the canvas, so the cards
								// show the full record state instead of just
								// the SELECT projection. Compact mode preserves
								// the historical lean behavior for users who
								// deliberately wrote a focused query.
								'<label class="soql-full-fields-toggle" style="display:flex;align-items:center;gap:0.5em;margin-top:0.6em;font-size:0.88rem;color:var(--ink-soft)' + (isPlayground ? ';opacity:0.7;cursor:not-allowed' : '') + '">' +
									'<input type="checkbox" id="soql-full-fields" checked' + (isPlayground ? ' disabled aria-disabled="true"' : '') + '>' +
									'<span><strong>Load all fields</strong> &middot; refetch each record with every field you can read in Salesforce, not just the ones in your SELECT. Uncheck for a compact view of only the fields you queried.</span>' +
								'</label>' +
								'<div id="soql-preview" class="soql-preview"></div>' +
							'</div>' +
							'<div class="modal-footer">' +
								'<button class="button secondary" data-soql-close>Cancel</button>' +
								'<button class="button secondary" id="soql-preview-btn">Run preview</button>' +
								'<button class="button" id="soql-commit-btn">Add to canvas</button>' +
							'</div>' +
						'</div>';
					document.body.appendChild(modal);
					const close = () => {
						modal.remove();
						document.removeEventListener('keydown', onEsc);
					};
					const onEsc = (e) => {
 if (e.key === 'Escape') {
close();
} 
};
					document.addEventListener('keydown', onEsc);
					modal.querySelectorAll('[data-soql-close]').forEach((el) => el.addEventListener('click', close));

					const textarea = modal.querySelector('#soql-query');
					const previewPane = modal.querySelector('#soql-preview');
					const previewBtn = modal.querySelector('#soql-preview-btn');
					const commitBtn = modal.querySelector('#soql-commit-btn');
					const fullFieldsCb = modal.querySelector('#soql-full-fields');
					let lastResult = null;
					setTimeout(() => textarea.focus(), 0);

					// Cache the last query string used to populate lastResult so
					// commit() can know whether the user has changed the query
					// since the last preview (in which case we re-run rather
					// than commit a stale snapshot). The mode flag is part of
					// the cache key; flipping the checkbox should re-run.
					let lastResultSoql = null;
					let lastResultFullFields = null;

					async function runQuery(soql) {
						const fullFields = !!(fullFieldsCb && fullFieldsCb.checked);
						const r = await csrfFetch('/api/query', {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							credentials: 'same-origin',
							body: JSON.stringify({ soql, fullFields }),
						});
						const body = await r.json().catch(() => ({}));
						return { ok: r.ok, status: r.status, body, fullFields };
					}

					function renderPreview(body) {
						const byObject = {};
						for (const rec of body.records) {
							byObject[rec.objectName] = (byObject[rec.objectName] || 0) + 1;
						}
						const breakdown = Object.entries(byObject)
							.map(([n, c]) => escapeHtml(n) + ': ' + c)
							.join(' \u00b7 ');
						// When the server imposed the 500-row cap it can't know the
						// true match count (a LIMIT'd query reports totalSize ==
						// returned), so `capped` is the honest signal: don't claim
						// "matches N" with a number we know is just the cap.
						const truncationNote = body.capped
							? '<div class="banner">Hit the ' + (body.cap || 500) + '-record import cap; showing the first ' + body.returned + '. There may be more; add a WHERE clause or a smaller LIMIT to narrow.</div>'
							: body.truncated
							? '<div class="banner">Query matches ' + body.totalSize + ' records; showing the first ' + body.returned + '. Add a WHERE clause or LIMIT to narrow.</div>'
							: '';
						// SF deep-link base: empty in playground/mock, where we render plain text.
						const sfBase = (window.SF_INSTANCE_URL || '').replace(/[/]+$/, '');
						// Pick the most human identifier from a record's loaded values: Name
						// first, then common name-like fields, then the first non-Id value.
						const ID_PRIORITY = ['Name', 'CaseNumber', 'Subject', 'Title', 'Label', 'DeveloperName', 'Username', 'Email', 'FullName', 'LastName'];
						function pickIdentifier(values) {
							if (!values) {
 return null; 
}
							for (const k of ID_PRIORITY) {
								const v = values[k];
								if (v != null && typeof v !== 'object' && String(v).trim() !== '') {
 return { field: k, value: String(v) }; 
}
							}
							for (const k of Object.keys(values)) {
								if (k === 'Id' || k === 'attributes') {
 continue; 
}
								const v = values[k];
								if (v != null && typeof v !== 'object' && String(v).trim() !== '') {
 return { field: k, value: String(v) }; 
}
							}
							return null;
						}
						const MAX_PREVIEW_ROWS = 200;
						// Display ordering: group by object (A→Z), then by each row's
						// identifier (A→Z, natural + case-insensitive). Sort a COPY so
						// body.records keeps its original order; the commit-to-canvas
						// dedup + association wiring is unaffected; this is purely how the
						// preview reads.
						const decorated = body.records.map((rec) => {
							const id = rec.loadedFromId || (rec.values && rec.values.Id) || '';
							const ident = pickIdentifier(rec.values);
							return { rec: rec, id: id, ident: ident, sortName: ident ? ident.value : id };
						});
						const COLLATE = { numeric: true, sensitivity: 'base' };
						decorated.sort((a, b) => {
							const byObj = String(a.rec.objectName || '').localeCompare(String(b.rec.objectName || ''), undefined, COLLATE);
							if (byObj !== 0) {
 return byObj; 
}
							return String(a.sortName || '').localeCompare(String(b.sortName || ''), undefined, COLLATE);
						});
						const shownRows = decorated.slice(0, MAX_PREVIEW_ROWS);
						const moreCount = decorated.length - shownRows.length;
						const rowsHtml = shownRows.map((row) => {
							const rec = row.rec, id = row.id, ident = row.ident;
							const identText = ident ? ident.value : (id || '—');
							let nameCell;
							if (sfBase && id) {
								const url = sfBase + '/lightning/r/' + encodeURIComponent(rec.objectName) + '/' + encodeURIComponent(id) + '/view';
								nameCell = '<a class="soql-id-link" href="' + escapeHtml(url) + '" target="_blank" rel="noopener" title="Open in Salesforce">' + escapeHtml(identText) + '</a>';
							} else {
								nameCell = escapeHtml(identText);
							}
							const fieldHint = ident && ident.field !== 'Name' ? ' <span class="soql-field-hint">' + escapeHtml(ident.field) + '</span>' : '';
							return '<tr><td class="soql-col-obj"><span class="tag">' + escapeHtml(rec.objectName) + '</span></td>' +
								'<td class="soql-col-id">' + escapeHtml(id) + '</td>' +
								'<td class="soql-col-name">' + nameCell + fieldHint + '</td></tr>';
						}).join('');
						const moreNote = moreCount > 0
							? '<div class="soql-more-note">…and ' + moreCount + ' more not shown · all ' + body.records.length + ' will be added.</div>'
							: '';
						const tableHtml = body.records.length
							? '<div class="soql-preview-tablewrap"><table class="soql-preview-table">' +
								'<thead><tr><th>Object</th><th>ID</th><th>Name</th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div>' + moreNote
							: '';
						const componentNote = body.records.length > 75
							? '<div class="banner">Heads-up: ' + body.records.length + ' records added in one go won’t fit Composite Graph upload (cap is 75 per connected component). You can still browse / edit them; uploads will need bulk fallback.</div>'
							: '';
						previewPane.innerHTML =
							truncationNote +
							componentNote +
							'<div class="soql-summary"><strong>' + body.records.length + ' record' + (body.records.length === 1 ? '' : 's') + '</strong> ready to add' + (breakdown ? ' (' + breakdown + ')' : '') + '. Total in SF: ' + body.totalSize + '.</div>' +
							tableHtml;
					}

					async function runPreview() {
						const soql = (textarea.value || '').trim();
						if (!soql) {
 previewPane.innerHTML = '<div class="banner">Type a SOQL query first.</div>'; return; 
}
						previewBtn.disabled = true;
						commitBtn.disabled = true;
						previewPane.innerHTML = '<p class="tag center">Running query\u2026</p>';
						lastResult = null;
						lastResultSoql = null;
						lastResultFullFields = null;
						try {
							const { ok, status, body, fullFields } = await runQuery(soql);
							if (!ok) {
								previewPane.innerHTML = '<div class="banner error">' + formatQueryError(body, status) + '</div>';
								return;
							}
							lastResult = body;
							lastResultSoql = soql;
							lastResultFullFields = fullFields;
							renderPreview(body);
						} catch (err) {
							previewPane.innerHTML = '<div class="banner error">' + escapeHtml(err.message || String(err)) + '</div>';
						} finally {
							previewBtn.disabled = false;
							commitBtn.disabled = false;
						}
					}

					// Add to canvas works directly: if we have a fresh preview
					// (same SOQL string, non-empty result), reuse it; otherwise
					// run the query and commit on success.
					async function commit() {
						const soql = (textarea.value || '').trim();
						if (!soql) {
							previewPane.innerHTML = '<div class="banner">Type a SOQL query first.</div>';
							return;
						}
						commitBtn.disabled = true;
						previewBtn.disabled = true;
						const originalLabel = commitBtn.textContent;
						commitBtn.textContent = 'Adding\u2026';
						// Assigned right before the canvas mutates; the catch
						// below rolls back through it if the commit failed
						// part-way (e.g. a schema describe error mid-batch).
						let _undo = null;
						try {
							let result = lastResult;
							const currentFullFields = !!(fullFieldsCb && fullFieldsCb.checked);
							const cacheStale = !result
								|| lastResultSoql !== soql
								|| lastResultFullFields !== currentFullFields;
							if (cacheStale) {
								// No fresh preview, or query has changed; re-run.
								previewPane.innerHTML = '<p class="tag center">Running query\u2026</p>';
								const { ok, status, body, fullFields } = await runQuery(soql);
								if (!ok) {
									_shared.captureImportFailure('soql', 'query', (body && (body.error || body.message)) || ('HTTP ' + status));
									previewPane.innerHTML = '<div class="banner error">' + formatQueryError(body, status) + '</div>';
									return;
								}
								result = body;
								lastResult = body;
								lastResultSoql = soql;
								lastResultFullFields = fullFields;
							}
							if (!result.records || result.records.length === 0) {
								previewPane.innerHTML = '<div class="banner">Query returned 0 records; nothing to add.</div>';
								return;
							}
							_undo = captureUndoSnapshot ? captureUndoSnapshot() : null;
							const summary = await soqlImportCommitToCanvas(result);
							if (summary.blocked) {
								previewPane.innerHTML = '<div class="banner error">' + escapeHtml(summary.capReason || 'Canvas is at the record limit.') + '</div>';
								return;
							}
							const addedNote = summary.added + ' record' + (summary.added === 1 ? '' : 's');
							const skippedNote = summary.skipped > 0
								? ' \u00b7 ' + summary.skipped + ' already on canvas (skipped)'
								: '';
							if (summary.added === 0) {
								previewPane.innerHTML = '<div class="banner">All ' + summary.skipped + ' record' + (summary.skipped === 1 ? '' : 's') + ' from this query are already on the canvas; nothing new to add.</div>';
								return;
							}
							const fkNote = summary.associationsSkippedFk > 0
								? ' · ' + summary.associationsSkippedFk + ' link' + (summary.associationsSkippedFk === 1 ? '' : 's') + ' skipped (lookup already set)'
								: '';
							const _msg = 'Added ' + addedNote + ' from SOQL.' + skippedNote + fkNote;
							if (_undo && showBulkToastWithAction) {
								showBulkToastWithAction(_msg, 'Undo', _undo);
							} else {
								showBulkToast(_msg);
							}
							close();
						} catch (err) {
							// Roll a part-committed batch back to the pre-commit
							// snapshot; no half-load survives an error.
							if (_undo) {
								_undo();
							}
							_shared.captureImportFailure('soql', 'commit', err.message || String(err));
							previewPane.innerHTML = '<div class="banner error">Could not add to canvas: ' + escapeHtml(err.message || String(err)) + (_undo ? ' The canvas was restored; nothing changed.' : '') + '</div>';
						} finally {
							commitBtn.disabled = false;
							previewBtn.disabled = false;
							commitBtn.textContent = originalLabel;
						}
					}

					previewBtn.addEventListener('click', runPreview);
					commitBtn.addEventListener('click', commit);
					if (fullFieldsCb) {
						// Flipping the toggle invalidates any cached preview:
						// the next commit() (or preview-rerun) needs to refetch
						// to honor the new mode. We don't auto-rerun the
						// preview on flip; that would burn a SF API call on
						// every accidental click. The user gets the new mode
						// on next explicit Run preview / Add to canvas.
						fullFieldsCb.addEventListener('change', () => {
							lastResult = null;
							lastResultSoql = null;
							lastResultFullFields = null;
						});
					}
					textarea.addEventListener('keydown', (e) => {
						// Ctrl/Cmd+Enter triggers preview; modifier-free Enter
						// inserts a newline (default textarea behavior).
						if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
							e.preventDefault();
							runPreview();
						}
					});
				}

				// Wire a successful /api/query response into canvasState.bulkRecords +
				// canvasState.bulkAssociations. Ensures each unique object type has a
				// canvasState.selectedObjects entry first (records canvas needs the schema
				// metadata to render cards). Dedupes by `objectName + loadedFromId`
				// against existing canvas records; re-importing the same SOQL
				// won't pile on duplicate cards. Returns a summary so the caller
				// can toast counts.
				async function soqlImportCommitToCanvas(result, opts) {
					const records = Array.isArray(result.records) ? result.records : [];
					const associations = Array.isArray(result.associations) ? result.associations : [];
					if (records.length === 0) {
return { added: 0, skipped: 0 };
}

					// Existing-on-canvas index: maps `objectName::sfId` to the
					// existing bulkRec.id. Used to dedupe new records AND to
					// route associations targeting an already-loaded parent.
					const existingByKey = new Map();
					canvasState.bulkRecords.forEach((br) => {
						if (br.isTypeNode || !br.loadedFromId) {
return;
}
						existingByKey.set(br.objectName + '::' + br.loadedFromId, br.id);
					});

					// Decide up-front which incoming records are duplicates.
					const dupTempIds = new Set();
					const newRecords = [];
					records.forEach((rec) => {
						const key = rec.objectName + '::' + rec.loadedFromId;
						if (existingByKey.has(key)) {
dupTempIds.add(rec.tempId);
} else {
newRecords.push(rec);
}
					});

					// Canvas record-cap enforcement: measured against the
					// NEW (post-dedup) records, since already-on-canvas dups
					// don't consume new slots. Refuse the WHOLE batch if it
					// would exceed the cap (no silent partial-fill). This is
					// the choke point for Browse + SOQL import, so neither can
					// push the canvas past the limit regardless of entry UI.
					// /api/query row-caps its result (SOQL_ROW_CAP) by appending
					// LIMIT, so `records` can be a truncated slice of a larger
					// match set AND the server's reported totalSize is the capped
					// count; it can't see the real total. Checking only the
					// returned (capped) length let a "Load all 600" against a 500
					// cap silently load 500 and report success. Callers that know
					// the true match size (Browse, from /api/browse) pass it as
					// opts.knownTotal; we cap-check against that. When the true
					// total exceeds the returned rows we can't tell new-vs-dup for
					// the unseen rows, so we refuse the whole batch rather than
					// partial-fill.
					const knownTotal = opts && typeof opts.knownTotal === 'number' ? opts.knownTotal : 0;
					const reportedTotal = typeof result.totalSize === 'number' ? result.totalSize : records.length;
					const totalMatch = Math.max(knownTotal, reportedTotal, records.length);
					const capAttempt = totalMatch > records.length ? totalMatch : newRecords.length;
					const _cap = canvasCapCheck(capAttempt);
					if (_cap.blocked) {
						return { added: 0, skipped: dupTempIds.size, blocked: true, capReason: _cap.reason };
					}

					// Resolve / create a canvasState.selectedObjects entry per unique
					// object type that's actually new. (Skipping objects whose
					// records are all duplicates avoids gratuitous schema
					// graph entries.)
					const orderedObjectNames = [];
					const seenObjects = new Set();
					if (result.objectName && newRecords.some((r) => r.objectName === result.objectName)) {
						orderedObjectNames.push(result.objectName);
						seenObjects.add(result.objectName);
					}
					for (const rec of newRecords) {
						if (!seenObjects.has(rec.objectName)) {
							orderedObjectNames.push(rec.objectName);
							seenObjects.add(rec.objectName);
						}
					}
					const selByName = {};
					for (const objName of orderedObjectNames) {
						let sel = canvasState.selectedObjects.find((s) => s.name === objName);
						if (!sel) {
							const parentSel = selByName[result.objectName] || null;
							sel = await addToSelection(
								objName,
								parentSel && parentSel.name !== objName ? parentSel.id : null,
								null,
								null,
							);
						}
						selByName[objName] = sel;
					}

					// Drop the lone empty starter card BEFORE measuring layout
					// so the import's startY falls back to the canvas-top
					// path (length === 0) instead of stacking the imported
					// records below the placeholder.
					clearEmptyStarterCard();
					// Layout: stack new records into a grid below existing
					// canvas content so they're visible without overlapping.
					const canvasEl = getGraph().querySelector("#bulk-canvas");
					const startX = (canvasEl ? canvasEl.clientWidth / 2 : 600) - 220;
					const existingMaxY = canvasState.bulkRecords.reduce((m, r) => Math.max(m, r.y || 0), 0);
					const startY = (canvasState.bulkRecords.length === 0 ? 120 : existingMaxY + 220);
					const colStep = 240;
					const rowStep = 180;
					const cols = 4;

					// Map server tempId → client bulkRec id. Pre-populate with
					// existing-canvas matches so associations whose targets
					// were skipped still wire to the correct card.
					const clientIdByTempId = {};
					records.forEach((rec) => {
						const key = rec.objectName + '::' + rec.loadedFromId;
						const existingId = existingByKey.get(key);
						if (existingId != null) {
clientIdByTempId[rec.tempId] = existingId;
}
					});
					// Compact-load marker. When the user imported via SOQL
					// with fullFields=false, the response only contains the
					// SELECT-listed fields. Stash the loaded field names on
					// the bulk record so the edit modal can hide everything
					// else (otherwise the user sees a wall of empty inputs
					// for fields they didn't ask for) and so preflight knows
					// not to flag required-and-missing on fields whose
					// values still live unchanged in Salesforce. Full-fields
					// mode (the default) doesn't set this; the modal
					// renders the full Lightning layout as it always has.
					const isCompact = result && result.fullFields === false;
					// Track new bulkRecord ids so the post-render tree
					// layout pass below knows which subset of the canvas
					// to re-arrange. Records added earlier in other
					// sessions keep their hand-positioned coordinates.
					const newBulkIds = new Set();
					newRecords.forEach((rec, idx) => {
						const sel = selByName[rec.objectName];
						const col = idx % cols;
						const row = Math.floor(idx / cols);
						const newRec = {
							id: canvasState.bulkIdSeq++,
							objectName: rec.objectName,
							label: sel ? sel.label : rec.objectName,
							// Grid coords are a safety fallback in case
							// the tree layout below bails (e.g. cy not
							// ready). When tree layout runs it overrides
							// these positions.
							x: startX + col * colStep,
							y: startY + row * rowStep,
							values: Object.assign({}, rec.values || {}),
							loadedFromId: rec.loadedFromId,
							loadedValues: Object.assign({}, rec.values || {}),
							fromSelectionId: sel ? sel.id : null,
						};
						if (isCompact) {
							newRec._loadedFieldNames = Object.keys(rec.values || {});
						}
						canvasState.bulkRecords.push(newRec);
						clientIdByTempId[rec.tempId] = newRec.id;
						newBulkIds.add(newRec.id);
					});

					// Build a set of existing association triples so we don't
					// re-add a link that's already on the canvas (common when
					// the user re-imports a parent + its kids).
					const existingAssocKey = new Set(
						canvasState.bulkAssociations.map((a) => a.fromId + '->' + a.toId + '::' + a.fieldName),
					);
					// A lookup is single-value: at most one association per
					// (holder, fieldName). Seed from the canvas so a DEDUPED
					// record whose subquery edge targets a different parent
					// card can't double-wire a lookup that card already has:
					// e.g. a contact hand-wired to a draft account, then
					// re-imported under its real parent. Admission rules are
					// shared with the CSV + JSON importers (import-shared.js).
					// The exact-duplicate check above runs FIRST so re-imports
					// of an existing edge count as dedup, not as a skip.
					const _admitAssociation = window.OrgLoom.importShared.admitAssociation;
					const _usedFk = new Set();
					canvasState.bulkAssociations.forEach((a) => {
						_usedFk.add(a.fromId + '::' + a.fieldName);
					});
					let assocsAdded = 0;
					let assocsSkippedFk = 0;
					for (const a of associations) {
						const fromId = clientIdByTempId[a.fromTempId];
						const toId = clientIdByTempId[a.toTempId];
						if (fromId == null || toId == null) {
continue;
}
						const key = fromId + '->' + toId + '::' + a.fieldName;
						if (existingAssocKey.has(key)) {
continue;
}
						if (!_admitAssociation(_usedFk, fromId, toId, a.fieldName)) {
							assocsSkippedFk++;
							continue;
						}
						canvasState.bulkAssociations.push({ id: canvasState.bulkIdSeq++, fromId, toId, fieldName: a.fieldName });
						existingAssocKey.add(key);
						assocsAdded++;
					}
					clearBulkUserDeleted();
					// Suppress renderBulkCanvasCy's own auto-pan-to-new
					// animation for this render; without this, the
					// canvas fires an animate(center: newNodes, 500ms)
					// that races with tree-layout's fit() below.
					// linked-csv does the same dance for the same
					// reason.
					if (newBulkIds.size > 0) {
setSkipNextCyAutoPan(true);
}
					if (typeof renderBulkView === 'function') {
renderBulkView();
}
					// Tree-aware layout of just-added records. renderBulkView
					// commits the new cy nodes synchronously, so by here cy
					// has them indexed and the layout helper can find them
					// via the recId data field. Uses breadthfirst per
					// connected component for >=5 nodes with FK edges, cose
					// otherwise (same algorithm CSV import uses).
					if (newBulkIds.size > 0) {
relayoutNewRecords(newBulkIds);
}
					return { added: newRecords.length, skipped: dupTempIds.size, associationsAdded: assocsAdded, associationsSkippedFk: assocsSkippedFk };
				}


			// Programmatic SOQL run + commit. Used by the Browse panel's
			// Load-to-canvas flow so users don't have to traverse the
			// SOQL importer modal for the simple "load these records"
			// case. Same fetch path the importer's commit() uses, but
			// without any UI side effects; the caller toasts the
			// summary itself.
			async function runAndCommitSoql(soql, opts) {
				opts = opts || {};
				const fullFields = opts.fullFields !== false;
				const r = await csrfFetch('/api/query', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					credentials: 'same-origin',
					body: JSON.stringify({ soql, fullFields }),
				});
				const body = await r.json().catch(() => ({}));
				if (!r.ok) {
					const err = new Error((body && body.message) || (body && body.error) || ('HTTP ' + r.status));
					err.body = body;
					err.status = r.status;
					throw err;
				}
				if (!body.records || body.records.length === 0) {
					return { added: 0, skipped: 0, totalSize: body.totalSize || 0, body };
				}
				const summary = await soqlImportCommitToCanvas(body, opts);
				return Object.assign({ totalSize: body.totalSize || 0, body }, summary);
			}

			return {
				openModal: openSoqlImportModal,
				runAndCommitSoql: runAndCommitSoql,
			};
		},
	};
})();
