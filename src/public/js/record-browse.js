// Browse panel: explore records by filter without committing them to
// the canvas. Pick an object, build filter chips (operators driven by
// the field's describe type), see a live count + first-page preview,
// then hand the compiled query off to the SOQL importer to load the
// matched set onto the canvas.
//
// Distinct from SOQL import in two ways:
//   1. No SOQL knowledge required: filter chips compile to the WHERE
//      clause server-side.
//   2. Browse is non-committal: the canvas isn't touched until the
//      user explicitly clicks "Load to canvas." Useful for the
//      "how many records match X?" question that SF list views and
//      Reports answer today.
//
// Server endpoint: POST /api/browse, which takes { objectName, filters,
// sort, limit, offset }, returns { count, records, hasMore,
// previewFields, previewSoql, loadSoql }. The loadSoql comes back
// pre-built so the Load-to-canvas hand-off doesn't need to re-derive
// the WHERE clause client-side.
//
// Dependencies passed to mount():
//   canvasState: describeCache lookups
//   csrfFetch: XHR wrapper
//   escapeHtml: XSS-safe HTML interpolation
//   ensureDescribe: load a describe on-demand into canvasState.describeCache
//   showBulkToast: success / error toasts
//   openSoqlImportModal: hand-off target for Load to canvas
//
// Public API (returned from mount):
//   openBrowseModal(initialObjectName?)
//
// Exposed as window.OrgLoom.recordBrowse. Load order: before app.js.

(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	// Operator labels + value-input types per SF field type. Drives the
	// filter chip's operator dropdown so users see only options that
	// make sense for the field they picked (no "contains" on a number,
	// no "greater than" on a picklist).
	const STRING_TYPES = new Set(['string', 'textarea', 'phone', 'url', 'email', 'encryptedstring']);
	const NUMERIC_TYPES = new Set(['int', 'double', 'currency', 'percent']);
	const PICKLIST_TYPES = new Set(['picklist', 'combobox']);
	function _operatorsFor(field) {
		if (!field) {
return [{ op: 'equals', label: 'equals' }];
}
		const t = field.type;
		if (STRING_TYPES.has(t)) {
			return [
				{ op: 'equals', label: 'equals' },
				{ op: 'notEquals', label: 'does not equal' },
				{ op: 'contains', label: 'contains' },
				{ op: 'startsWith', label: 'starts with' },
				{ op: 'isNull', label: 'is empty' },
				{ op: 'isNotNull', label: 'is not empty' },
			];
		}
		if (NUMERIC_TYPES.has(t)) {
			return [
				{ op: 'equals', label: '=' },
				{ op: 'notEquals', label: '≠' },
				{ op: 'gt', label: '>' },
				{ op: 'gte', label: '≥' },
				{ op: 'lt', label: '<' },
				{ op: 'lte', label: '≤' },
				{ op: 'isNull', label: 'is empty' },
				{ op: 'isNotNull', label: 'is not empty' },
			];
		}
		if (PICKLIST_TYPES.has(t)) {
			return [
				{ op: 'equals', label: 'equals' },
				{ op: 'notEquals', label: 'does not equal' },
				{ op: 'in', label: 'is any of' },
				{ op: 'isNull', label: 'is empty' },
				{ op: 'isNotNull', label: 'is not empty' },
			];
		}
		if (t === 'reference') {
			return [
				{ op: 'equals', label: 'equals (Id)' },
				{ op: 'notEquals', label: 'not equals (Id)' },
				{ op: 'isNull', label: 'is empty' },
				{ op: 'isNotNull', label: 'is not empty' },
			];
		}
		if (t === 'date' || t === 'datetime') {
			return [
				{ op: 'equals', label: 'equals' },
				{ op: 'notEquals', label: 'does not equal' },
				{ op: 'before', label: 'before' },
				{ op: 'after', label: 'after' },
				{ op: 'isNull', label: 'is empty' },
				{ op: 'isNotNull', label: 'is not empty' },
			];
		}
		if (t === 'boolean') {
			return [{ op: 'equals', label: 'equals' }];
		}
		return [{ op: 'equals', label: 'equals' }];
	}

	// Some operators don't take a value (isNull / isNotNull). Centralized
	// so the renderer can hide the value input cleanly.
	function _opTakesValue(op) {
		return op !== 'isNull' && op !== 'isNotNull';
	}

	window.OrgLoom.recordBrowse = {
		mount: function mount(deps) {
			const required = [
				'canvasState', 'csrfFetch', 'escapeHtml',
				'ensureDescribe', 'showBulkToast',
				'runAndCommitSoql', 'canvasCapCheck',
			];
			if (!deps) {
throw new Error('record-browse.mount: missing deps object');
}
			for (const k of required) {
				if (deps[k] === undefined || deps[k] === null) {
					throw new Error('record-browse.mount: missing dep ' + k);
				}
			}
			const canvasState = deps.canvasState;
			const csrfFetch = deps.csrfFetch;
			const escapeHtml = deps.escapeHtml;
			const ensureDescribe = deps.ensureDescribe;
			const showBulkToast = deps.showBulkToast;
			const runAndCommitSoql = deps.runAndCommitSoql;
			const canvasCapCheck = deps.canvasCapCheck;
			// Optional (all present in the normal app.js mount):
			//   captureUndoSnapshot: pre-load canvas snapshot; powers the
			//                             Undo toast AND the all-or-nothing
			//                             rollback on mid-basket failure.
			//   showBulkToastWithAction: action-toast for that Undo.
			//   pingAuditEvent: Activity History for Browse loads.
			const captureUndoSnapshot = typeof deps.captureUndoSnapshot === 'function'
				? deps.captureUndoSnapshot : null;
			const showBulkToastWithAction = typeof deps.showBulkToastWithAction === 'function'
				? deps.showBulkToastWithAction : null;
			const pingAuditEvent = typeof deps.pingAuditEvent === 'function'
				? deps.pingAuditEvent : null;
			// Shared import helpers (telemetry). Loaded before app.js.
			const _shared = window.OrgLoom.importShared;

			// Object list cache: /api/objects is workspace-stable for the
			// session, so fetch once on first open and reuse. The
			// endpoint returns the array directly (not wrapped in
			// { objects: [...] }). Defensively handle both shapes
			// in case the response is ever wrapped in the future.
			// Filter to queryable objects (SOQL won't work on the
			// non-queryable ones, and surfacing them just makes the
			// picker noisier).
			let _objectsCache = null;
			async function _loadObjects() {
				if (_objectsCache) {
return _objectsCache;
}
				// /api/objects is noise-filtered server-side (single source
				// of truth), so the picker only sees real business objects.
				const r = await csrfFetch('/api/objects', { credentials: 'same-origin' });
				const data = await r.json().catch(() => null);
				if (!r.ok) {
throw new Error((data && data.error) || 'HTTP ' + r.status);
}
				const list = Array.isArray(data) ? data : (data && Array.isArray(data.objects) ? data.objects : []);
				_objectsCache = list.filter((o) => o && o.queryable !== false);
				return _objectsCache;
			}

			// State for an open modal. Reset on open. Keeping this at
			// module scope (rather than reconstructing inside the modal
			// fn) so the debounced fetcher closes over a stable ref.
			let _state = null;
			let _fetchTimer = null;
			// Monotonic request token. The debounce only gates SENDING:
			// two in-flight /api/browse responses can resolve out of
			// order, and without this check the older one overwrites the
			// newer count/preview AND lastResult.loadSoql (so Load would
			// execute a stale query for records the user filtered away).
			let _fetchSeq = 0;
			function _newState(initialObjectName) {
				return {
					objectName: initialObjectName || null,
					filters: [], // [{ id, field, op, value }]
					sort: null, // { field, direction }
					limit: 25,
					offset: 0,
					filterIdSeq: 1,
					lastResult: null, // { count, records, hasMore, previewFields, loadSoql }
					// Cross-object selection basket: objectName → Set<SF Id>.
					// Selections survive pagination AND object switches, so a
					// user can assemble a related working set across objects
					// (3 Accounts + 5 Contacts + 10 Tasks) and load it in one
					// go. The current object's set is the live target for the
					// preview checkboxes; the others wait in the basket until
					// load. Per-object filter state still resets on switch.
					basket: new Map(),
				};
			}
			// Cap on individual-Id selections: Salesforce's WHERE Id IN
			// (...) tops out around 1000 elements per SOQL clause, but
			// well before that the UX of "I clicked 800 checkboxes" is
			// already bad. Cap conservatively; if users hit it they're
			// asking for "load all matches" anyway.
			const SELECTION_CAP = 500;

			// --- Cross-object basket helpers ---
			// The live selection target is the current object's Set, created
			// lazily on first pick. _basketTotal / _basketEntries aggregate
			// across every object so the Load button + basket section can
			// reason about the whole working set, not just the current view.
			function _currentSel() {
				if (!_state.objectName) {
					return new Set();
				}
				if (!_state.basket.has(_state.objectName)) {
					_state.basket.set(_state.objectName, new Set());
				}
				return _state.basket.get(_state.objectName);
			}
			function _basketTotal() {
				let n = 0;
				for (const set of _state.basket.values()) {
					n += set.size;
				}
				return n;
			}
			// Non-empty basket entries in object insertion order.
			function _basketEntries() {
				const out = [];
				for (const [name, set] of _state.basket) {
					if (set.size > 0) {
						out.push({ objectName: name, ids: set, count: set.size });
					}
				}
				return out;
			}
			function _objectLabel(name) {
				const list = _objectsCache || [];
				const o = list.find((x) => x && x.name === name);
				return (o && o.label) || name;
			}

			function _availableFilterFields(objectName) {
				const desc = canvasState.describeCache[objectName];
				if (!desc || !Array.isArray(desc.fields)) {
return [];
}
				// Only offer fields Salesforce permits in a WHERE clause.
				// The server repeats this validation because UI constraints
				// cannot protect stale or forged requests.
				const UNUSABLE_TYPES = new Set(['base64', 'address', 'location', 'anyType', 'complexvalue']);
				return desc.fields
					.filter((f) => f && f.name && f.type && f.filterable === true && !UNUSABLE_TYPES.has(f.type))
					.slice()
					.sort((a, b) => (a.label || a.name).localeCompare(b.label || b.name));
			}
			function _fieldByName(objectName, fieldName) {
				const desc = canvasState.describeCache[objectName];
				if (!desc || !Array.isArray(desc.fields)) {
return null;
}
				return desc.fields.find((f) => f && f.name === fieldName) || null;
			}

			// Render the value input appropriate for a filter's field+op.
			// Picklist gets a <select>, multipicklist + "in" gets a multi-
			// select, date gets type=date, boolean gets a yes/no select,
			// number gets type=number, everything else is text. Inputs
			// are named filter-${id}-value so the change handler can
			// pluck them out without re-rendering the whole chip on
			// every keystroke.
			function _renderValueInput(filter, field) {
				const id = 'filter-' + filter.id + '-value';
				if (!_opTakesValue(filter.op)) {
					return '<span class="rb-filter-value-disabled" id="' + id + '" data-no-value>(no value)</span>';
				}
				const v = filter.value;
				if (field && (field.type === 'picklist' || field.type === 'combobox')
					&& Array.isArray(field.picklistValues) && filter.op !== 'in') {
					const opts = field.picklistValues
						.filter((p) => p && p.active !== false)
						.map((p) => '<option value="' + escapeHtml(p.value) + '"' + (String(v) === p.value ? ' selected' : '') + '>' + escapeHtml(p.label || p.value) + '</option>')
						.join('');
					return '<select class="rb-filter-value" id="' + id + '" data-filter-id="' + filter.id + '">' +
						'<option value="">(pick)</option>' + opts +
					'</select>';
				}
				if (field && (field.type === 'picklist' || field.type === 'combobox') && filter.op === 'in') {
					const selected = Array.isArray(v) ? new Set(v) : new Set();
					const opts = (field.picklistValues || [])
						.filter((p) => p && p.active !== false)
						.map((p) => '<option value="' + escapeHtml(p.value) + '"' + (selected.has(p.value) ? ' selected' : '') + '>' + escapeHtml(p.label || p.value) + '</option>')
						.join('');
					return '<select multiple class="rb-filter-value rb-filter-value-multi" id="' + id + '" data-filter-id="' + filter.id + '" size="4">' +
						opts +
					'</select>';
				}
				if (field && field.type === 'boolean') {
					return '<select class="rb-filter-value" id="' + id + '" data-filter-id="' + filter.id + '">' +
						'<option value="">(pick)</option>' +
						'<option value="true"' + (String(v) === 'true' ? ' selected' : '') + '>Yes</option>' +
						'<option value="false"' + (String(v) === 'false' ? ' selected' : '') + '>No</option>' +
					'</select>';
				}
				if (field && field.type === 'date') {
					return '<input type="date" class="rb-filter-value" id="' + id + '" data-filter-id="' + filter.id + '" value="' + escapeHtml(v || '') + '">';
				}
				if (field && field.type === 'datetime') {
					return '<input type="datetime-local" class="rb-filter-value" id="' + id + '" data-filter-id="' + filter.id + '" value="' + escapeHtml(v || '') + '">';
				}
				if (field && NUMERIC_TYPES.has(field.type)) {
					return '<input type="number" class="rb-filter-value" id="' + id + '" data-filter-id="' + filter.id + '" value="' + escapeHtml(v == null ? '' : String(v)) + '" placeholder="0">';
				}
				return '<input type="text" class="rb-filter-value" id="' + id + '" data-filter-id="' + filter.id + '" value="' + escapeHtml(v == null ? '' : String(v)) + '" placeholder="value">';
			}

			function _renderFilterChip(filter) {
				const fields = _availableFilterFields(_state.objectName);
				const fieldOptions = fields.map((f) =>
					'<option value="' + escapeHtml(f.name) + '"' + (filter.field === f.name ? ' selected' : '') + '>' + escapeHtml(f.label || f.name) + '</option>'
				).join('');
				const fieldDef = filter.field ? _fieldByName(_state.objectName, filter.field) : null;
				const ops = _operatorsFor(fieldDef);
				const opOptions = ops.map((o) =>
					'<option value="' + escapeHtml(o.op) + '"' + (filter.op === o.op ? ' selected' : '') + '>' + escapeHtml(o.label) + '</option>'
				).join('');
				return '<div class="rb-filter-chip" data-filter-id="' + filter.id + '">' +
					'<select class="rb-filter-field" data-filter-id="' + filter.id + '">' +
						'<option value="">(field)</option>' + fieldOptions +
					'</select>' +
					'<select class="rb-filter-op" data-filter-id="' + filter.id + '">' + opOptions + '</select>' +
					_renderValueInput(filter, fieldDef) +
					'<button type="button" class="rb-filter-remove" data-filter-remove="' + filter.id + '" title="Remove this filter">×</button>' +
				'</div>';
			}

			// SF Ids already loaded on the canvas for the current object.
			// These rows render as locked + pre-checked in the preview: they
			// can't be unchecked (Browse only adds, never removes), and they
			// don't count toward the selection: the canvas already has them.
			function _onCanvasIds() {
				const set = new Set();
				const recs = (canvasState && canvasState.bulkRecords) || [];
				for (const r of recs) {
					if (r && !r.isTypeNode && r.loadedFromId && r.objectName === _state.objectName) {
						set.add(r.loadedFromId);
					}
				}
				return set;
			}

			function _renderPreviewTable(result) {
				if (!result || result.count === 0) {
					return '<p class="rb-empty">No records match your filters.</p>';
				}
				const fields = result.previewFields || ['Id'];
				// Checkbox column lives first. Header checkbox toggles
				// the current page's selection state: checked when ALL
				// records visible on this page are selected,
				// indeterminate when some are. Per-row checkboxes track
				// individual Ids; selection survives pagination via
				// _state.selectedIds, so users can build a cross-page
				// basket without losing prior picks.
				const pageRecords = result.records || [];
				const pageIds = pageRecords.map((r) => r.Id).filter(Boolean);
				const onCanvas = _onCanvasIds();
				const sel = _currentSel();
				// Instance URL for deep-linking a cell to the record in
				// Salesforce (new tab). Empty on canvas-standalone / mock,
				// where we fall back to plain text.
				const sfBase = (window.SF_INSTANCE_URL || '').replace(/\/+$/, '');
				// Salesforce convention: the NAME field is the record link, not
				// the opaque Id (Id stays plain text, easier to copy). Objects
				// with no name field in the preview fall back to linking the Id.
				const _desc = canvasState.describeCache[_state.objectName];
				const _nameField = _desc && Array.isArray(_desc.fields)
					? (_desc.fields.find((fl) => fl && fl.nameField) || null) : null;
				const linkField = (_nameField && _nameField.name && fields.indexOf(_nameField.name) !== -1)
					? _nameField.name : 'Id';
				// Header "select page" reflects only the SELECTABLE rows:
				// on-canvas (locked) rows are excluded so the checkbox isn't
				// stuck unchecked just because some rows can't be picked.
				const selectablePageIds = pageIds.filter((id) => !onCanvas.has(id));
				const allPageSelected = selectablePageIds.length > 0 && selectablePageIds.every((id) => sel.has(id));
				const head =
					'<tr>' +
						'<th class="rb-th-select">' +
							'<input type="checkbox" class="rb-select-all" data-rb-select-page' +
							(allPageSelected ? ' checked' : '') + ' title="Select all records on this page">' +
						'</th>' +
						fields.map((f) => '<th>' + escapeHtml(f) + '</th>').join('') +
					'</tr>';
				const rows = pageRecords.map((rec) => {
					const isOnCanvas = rec.Id && onCanvas.has(rec.Id);
					// On-canvas rows are pre-checked + disabled (locked).
					const checked = isOnCanvas || (rec.Id && sel.has(rec.Id)) ? ' checked' : '';
					const idAttr = rec.Id ? ' data-rb-row-id="' + escapeHtml(rec.Id) + '"' : '';
					const cells = fields.map((f) => {
						const v = rec[f];
						const s = v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
						// Deep-link the record's NAME cell to Salesforce (new
						// tab), following SF convention; the Id stays plain copyable text.
						// Objects with no name field link the Id instead. The
						// href always uses rec.Id; only the linked column varies.
						// Lightning /r/.../view redirects correctly for Classic
						// too. Plain text when there's no instance URL (mock).
						if (f === linkField && s && rec.Id && sfBase) {
							const url = sfBase + '/lightning/r/' + encodeURIComponent(_state.objectName) + '/' + encodeURIComponent(rec.Id) + '/view';
							return '<td><a class="rb-id-link" href="' + escapeHtml(url) + '" target="_blank" rel="noopener" title="Open in Salesforce">' + escapeHtml(s) + '</a></td>';
						}
						return '<td>' + escapeHtml(s) + '</td>';
					}).join('');
					return '<tr' + idAttr + (isOnCanvas ? ' class="rb-row--on-canvas"' : '') + '>' +
						'<td class="rb-td-select">' +
							(rec.Id
								? '<input type="checkbox" class="rb-row-select" data-rb-row-checkbox="' + escapeHtml(rec.Id) + '"' + checked
									+ (isOnCanvas ? ' disabled title="Already on the canvas"' : '') + '>'
								: '') +
						'</td>' +
						cells +
					'</tr>';
				}).join('');
				return '<table class="rb-preview-table">' +
					'<thead>' + head + '</thead>' +
					'<tbody>' + rows + '</tbody>' +
				'</table>';
			}

			async function _fetchResults(content) {
				const validFilters = _state.filters.filter((f) =>
					f.field && f.op && (!_opTakesValue(f.op)
						? true
						: (f.value != null && f.value !== '' && !(Array.isArray(f.value) && f.value.length === 0))
					)
				);
				const statusEl = content.querySelector('.rb-count');
				statusEl.textContent = 'Counting…';
				statusEl.classList.remove('rb-count-error');
				const _seq = ++_fetchSeq;
				try {
					const r = await csrfFetch('/api/browse', {
						method: 'POST',
						credentials: 'same-origin',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							objectName: _state.objectName,
							filters: validFilters,
							sort: _state.sort,
							limit: _state.limit,
							offset: _state.offset,
							// On-canvas ids for this object so the server can
							// report a net-new "loadableCount" (these dedup on
							// load: the "Load all N" number shouldn't count them).
							onCanvasIds: Array.from(_onCanvasIds()),
						}),
					});
					const body = await r.json().catch(() => ({}));
					// A newer request superseded this one while it was in
					// flight; drop the stale response (see _fetchSeq).
					if (_seq !== _fetchSeq) {
						return;
					}
					if (!r.ok) {
throw new Error((body && (body.message || body.error)) || 'HTTP ' + r.status);
}
					_state.lastResult = body;
					const count = body.count || 0;
					const loadable = typeof body.loadableCount === 'number' ? body.loadableCount : count;
					const onCanvasInMatch = Math.max(0, count - loadable);
					statusEl.textContent = count + ' record' + (count === 1 ? '' : 's') + ' match'
						+ (onCanvasInMatch > 0 ? ' · ' + onCanvasInMatch + ' already on canvas' : '');
					content.querySelector('.rb-preview').innerHTML = _renderPreviewTable(body);
					_renderSelectionSummary(content);
					_updateLoadButton(content);
					// Pagination: render simple prev/next when more pages exist.
					const pageInfo = content.querySelector('.rb-page-info');
					if (body.count > _state.limit) {
						const start = _state.offset + 1;
						const end = _state.offset + (body.records || []).length;
						pageInfo.innerHTML = 'Showing ' + start + '–' + end + ' of ' + body.count + ' · ' +
							'<button type="button" class="rb-page-btn" data-rb-prev' + (_state.offset === 0 ? ' disabled' : '') + '>Prev</button> ' +
							'<button type="button" class="rb-page-btn" data-rb-next' + (!body.hasMore ? ' disabled' : '') + '>Next</button>';
					} else {
						pageInfo.innerHTML = '';
					}
				} catch (e) {
					if (_seq !== _fetchSeq) {
						return;
					}
					_shared.captureImportFailure('browse', 'count', e.message || String(e));
					statusEl.textContent = 'Error: ' + (e.message || String(e));
					statusEl.classList.add('rb-count-error');
					content.querySelector('.rb-preview').innerHTML = '';
					content.querySelector('.rb-page-info').innerHTML = '';
					_state.lastResult = null;
					_updateLoadButton(content);
				}
			}

			function _scheduleFetch(content) {
				if (_fetchTimer) {
clearTimeout(_fetchTimer);
}
				// Invalidate the displayed query immediately, not 300ms later when
				// the debounced request starts. Otherwise Load remains clickable
				// during the debounce window and can execute lastResult.loadSoql for
				// a filter the user has already changed away from. Bumping the token
				// here also prevents an older in-flight response from rendering in
				// that window.
				_fetchSeq += 1;
				_state.lastResult = null;
				_updateLoadButton(content);
				_fetchTimer = setTimeout(() => _fetchResults(content), 300);
			}

			function _updateLoadButton(content) {
				// The Load button lives in .modal-footer (sibling of
				// .rb-content), so query from the modal root rather
				// than the content container: the previous version
				// queried inside content, got null back, and the
				// button never updated from its initial disabled state.
				const overlay = content.closest('.record-browse-modal');
				const loadBtn = overlay && overlay.querySelector('.rb-load-btn');
				if (!loadBtn) {
return;
}
				const count = (_state.lastResult && _state.lastResult.count) || 0;
				// Net-new matches (gross minus what's already on the canvas):
				// the "Load all N" number reflects what actually gets added.
				const loadable = _state.lastResult && typeof _state.lastResult.loadableCount === 'number'
					? _state.lastResult.loadableCount : count;
				const basketTotal = _basketTotal();
				const basketObjects = _basketEntries().length;
				// Basket-mode: when the user has explicitly picked records (in
				// ANY object), the button loads the whole cross-object basket,
				// overriding the per-object "load all matches" default. An
				// empty basket falls back to all NEW matches for the current object.
				const hasBasket = basketTotal > 0;
				loadBtn.disabled = hasBasket ? false : (!_state.objectName || loadable === 0);
				if (hasBasket) {
					loadBtn.textContent = basketObjects > 1
						? 'Load ' + basketTotal + ' selected (' + basketObjects + ' objects) to canvas'
						: 'Load ' + basketTotal + ' selected to canvas';
				} else if (loadable > 0) {
					loadBtn.textContent = 'Load all ' + loadable + ' to canvas';
				} else if (count > 0) {
					// Every match is already on the canvas: nothing to add.
					loadBtn.textContent = 'All ' + count + ' already on canvas';
				} else {
					loadBtn.textContent = 'Load to canvas';
				}
			}

			// Render the selection summary line, which sits between the
			// page-info row and the preview table. Empty when nothing
			// is selected. Surfaces a Clear button so users can dump
			// the selection without per-row uncheck clicks.
			function _renderSelectionSummary(content) {
				const summary = content.querySelector('.rb-selection-summary');
				if (!summary) {
return;
}
				const n = _basketTotal();
				const entries = _basketEntries();
				if (n === 0) {
 summary.innerHTML = ''; return; 
}
				const items = entries.map((e) =>
					'<li class="rb-basket-item' + (e.objectName === _state.objectName ? ' rb-basket-item--current' : '') + '">' +
						'<button type="button" class="rb-basket-goto" data-rb-goto-object="' + escapeHtml(e.objectName) + '" title="Show this object">' +
							escapeHtml(_objectLabel(e.objectName)) +
						'</button>' +
						'<span class="rb-basket-count">' + e.count + '</span>' +
						'<button type="button" class="rb-basket-drop" data-rb-clear-object="' + escapeHtml(e.objectName) + '" title="Remove these from the basket">&times;</button>' +
					'</li>'
				).join('');
				summary.innerHTML =
					'<div class="rb-basket">' +
						'<div class="rb-basket-head">' +
							'<span class="rb-basket-total">' + n + ' selected' +
								(entries.length > 1 ? ' across ' + entries.length + ' objects' : '') + '</span>' +
							'<button type="button" class="rb-clear-selection" data-rb-clear-all>Clear all</button>' +
						'</div>' +
						'<ul class="rb-basket-list">' + items + '</ul>' +
					'</div>';
			}

			// Empty state shown when /api/objects reports no active SF
			// connection (409 no-active-connection). Replaces the picker /
			// filters with a clear "connect an org" prompt + a button that
			// opens the connections modal (falls back to /connect on
			// canvas-standalone where the modal isn't mounted).
			function _renderNoConnection(content) {
				content.innerHTML =
					'<div class="rb-empty-state">' +
						'<p class="rb-empty-title">No Salesforce org connected</p>' +
						'<p class="tag">Connect a Salesforce org to browse and load its records onto the canvas.</p>' +
						'<button type="button" class="button rb-connect-btn">Connect a Salesforce org</button>' +
					'</div>';
				const btn = content.querySelector('.rb-connect-btn');
				if (btn) {
					btn.addEventListener('click', () => {
						if (window.Orgloom && window.Orgloom.sfConnectionsModal
							&& typeof window.Orgloom.sfConnectionsModal.open === 'function') {
							window.Orgloom.sfConnectionsModal.open();
						} else {
							window.location.assign('/connect');
						}
					});
				}
			}

			function _renderBody(content) {
				const objectPicker = content.querySelector('.rb-object-picker');
				const filterArea = content.querySelector('.rb-filters');
				// Object picker: only render if we don't already have one,
				// or the cache changed. Keep state across re-renders by
				// reading the live value.
				if (!objectPicker.dataset.populated) {
					_loadObjects().then((objs) => {
						const opts = objs.map((o) =>
							'<option value="' + escapeHtml(o.name) + '"' + (_state.objectName === o.name ? ' selected' : '') + '>' + escapeHtml(o.label || o.name) + ' (' + escapeHtml(o.name) + ')</option>'
						).join('');
						objectPicker.innerHTML = '<option value="">(pick an object)</option>' + opts;
						objectPicker.dataset.populated = '1';
					}).catch((e) => {
						const msg = (e && e.message) || String(e);
						// No active connection → show the connect empty state
						// instead of a broken "Error: no-active-connection"
						// option in the picker.
						if (/no-active-connection|not-connected/i.test(msg)) {
							_renderNoConnection(content);
							return;
						}
						objectPicker.innerHTML = '<option value="">' + escapeHtml('Error: ' + msg) + '</option>';
					});
				}
				// Filter chips re-render on every body refresh so type
				// changes (picking a new field) flip the operator menu
				// and value input correctly.
				filterArea.innerHTML = _state.filters.map(_renderFilterChip).join('') +
					(_state.objectName
						? '<button type="button" class="rb-add-filter" data-rb-add-filter>+ Add filter</button>'
						: '<p class="tag">Pick an object above to start filtering.</p>');
				// Results header carries a top border, so showing it before an
				// object is chosen (e.g. no active connection) reads as a stray
				// separator with nothing under it. Only show it once an object
				// is selected and there are results to head.
				const resultsHead = content.querySelector('.rb-results-head');
				if (resultsHead) {
					resultsHead.style.display = _state.objectName ? '' : 'none';
				}
				_updateLoadButton(content);
			}

			function _wireBodyHandlers(content) {
				// Object picker change.
				content.querySelector('.rb-object-picker').addEventListener('change', async (ev) => {
					const name = ev.target.value;
					_state.objectName = name || null;
					_state.filters = [];
					_state.offset = 0;
					_state.lastResult = null;
					// Object change KEEPS the basket: selections persist across
					// objects so the user can assemble a cross-object set. The
					// new object's set (possibly empty) becomes the live target;
					// the preview + on-canvas lock state re-render for it below.
					content.querySelector('.rb-count').textContent = name ? 'Loading describe…' : '';
					content.querySelector('.rb-preview').innerHTML = '';
					content.querySelector('.rb-page-info').innerHTML = '';
					_renderSelectionSummary(content);
					_updateLoadButton(content);
					if (!name) {
						_renderBody(content);
						return;
					}
					try {
						await ensureDescribe(name);
					} catch (e) {
						content.querySelector('.rb-count').textContent = 'Describe load failed: ' + (e.message || String(e));
						return;
					}
					_renderBody(content);
					content.querySelector('.rb-count').textContent = '';
					// Auto-fetch on object change so the user sees a
					// total-records count right away (no filters yet, so
					// it's the unfiltered count).
					_scheduleFetch(content);
				});

				// Delegated handlers for filter chips. These listen on the
				// persistent `.rb-filters` CONTAINER (not the chips), so they
				// survive `_renderBody` replacing the chips' innerHTML: wired
				// ONCE here, never re-wired. (Re-wiring would stack duplicate
				// listeners on every container, so one "+ Add filter" click
				// would push several filters, Next would skip pages, etc.)
				// For typing-into-text-inputs we listen on the area itself
				// without re-rendering so focus persists.
				content.querySelector('.rb-filters').addEventListener('input', (ev) => {
					const t = ev.target;
					if (!t || !t.dataset || !t.dataset.filterId) {
return;
}
					const filterId = Number(t.dataset.filterId);
					const filt = _state.filters.find((f) => f.id === filterId);
					if (!filt) {
return;
}
					if (t.classList.contains('rb-filter-value-multi')) {
						filt.value = Array.from(t.selectedOptions).map((o) => o.value);
					} else {
						filt.value = t.value;
					}
					_state.offset = 0;
					_scheduleFetch(content);
				});
				content.querySelector('.rb-filters').addEventListener('change', (ev) => {
					const t = ev.target;
					if (!t || !t.dataset || !t.dataset.filterId) {
return;
}
					const filterId = Number(t.dataset.filterId);
					const filt = _state.filters.find((f) => f.id === filterId);
					if (!filt) {
return;
}
					if (t.classList.contains('rb-filter-field')) {
						filt.field = t.value;
						const fieldDef = _fieldByName(_state.objectName, filt.field);
						const ops = _operatorsFor(fieldDef);
						// Reset op if the previously-selected one isn't valid
						// for the new field type.
						if (!ops.find((o) => o.op === filt.op)) {
filt.op = ops[0] ? ops[0].op : 'equals';
}
						filt.value = '';
						_renderBody(content);
						_state.offset = 0;
						_scheduleFetch(content);
					} else if (t.classList.contains('rb-filter-op')) {
						filt.op = t.value;
						// Switching to a no-value op clears the value;
						// switching FROM a no-value op resets to empty.
						if (!_opTakesValue(filt.op)) {
filt.value = '';
}
						_renderBody(content);
						_state.offset = 0;
						_scheduleFetch(content);
					} else if (t.classList.contains('rb-filter-value-multi')) {
						filt.value = Array.from(t.selectedOptions).map((o) => o.value);
						_state.offset = 0;
						_scheduleFetch(content);
					}
				});
				content.querySelector('.rb-filters').addEventListener('click', (ev) => {
					if (ev.target && ev.target.dataset && ev.target.dataset.rbAddFilter !== undefined) {
						_state.filters.push({
							id: _state.filterIdSeq++,
							field: null,
							op: 'equals',
							value: '',
						});
						_renderBody(content);
					} else if (ev.target && ev.target.dataset && ev.target.dataset.filterRemove) {
						const removeId = Number(ev.target.dataset.filterRemove);
						_state.filters = _state.filters.filter((f) => f.id !== removeId);
						_renderBody(content);
						_state.offset = 0;
						_scheduleFetch(content);
					}
				});

				// Pagination handlers (delegated on .rb-page-info).
				content.querySelector('.rb-page-info').addEventListener('click', (ev) => {
					if (ev.target.disabled) {
return;
}
					if (ev.target.dataset && ev.target.dataset.rbPrev !== undefined) {
						_state.offset = Math.max(0, _state.offset - _state.limit);
						_fetchResults(content);
					} else if (ev.target.dataset && ev.target.dataset.rbNext !== undefined) {
						_state.offset += _state.limit;
						_fetchResults(content);
					}
				});

				// Preview-table selection: delegated on .rb-preview so
				// the handler survives table re-renders on filter/page
				// changes without re-wiring. Per-row checkboxes toggle
				// individual ids; the page-header checkbox toggles every
				// id on the current page in one shot. Cap-enforced so
				// users can't blow past the SOQL Id-list limit by
				// chord-clicking.
				content.querySelector('.rb-preview').addEventListener('change', (ev) => {
					const t = ev.target;
					if (!t || t.type !== 'checkbox') {
return;
}
					// Cap messages render on the in-modal status line; a canvas
					// toast would sit behind the modal overlay, unreadable.
					const _capNotice = (msg) => {
						const statusEl = content.querySelector('.rb-count');
						if (statusEl) {
							statusEl.classList.add('rb-count-error');
							statusEl.textContent = msg;
						}
					};
					const sel = _currentSel();
					if (t.dataset && t.dataset.rbRowCheckbox) {
						const id = t.dataset.rbRowCheckbox;
						if (t.checked) {
							// Cap is on the WHOLE basket (across objects), since
							// the canvas cap is a single 500-record total.
							if (_basketTotal() >= SELECTION_CAP) {
								t.checked = false;
								_capNotice('Selection cap is ' + SELECTION_CAP + ' records. Load these first, then come back to pick more.');
								return;
							}
							sel.add(id);
						} else {
							sel.delete(id);
						}
						_renderSelectionSummary(content);
						_updateLoadButton(content);
						// Refresh the header checkbox to reflect the new
						// page-level state: checked when ALL page rows
						// are selected. Cheaper than re-rendering the
						// whole table.
						const headerCb = content.querySelector('.rb-select-all');
						if (headerCb) {
							const pageRecords = (_state.lastResult && _state.lastResult.records) || [];
							const onCanvas = _onCanvasIds();
							const selectableIds = pageRecords.map((r) => r.Id).filter((id) => id && !onCanvas.has(id));
							headerCb.checked = selectableIds.length > 0 && selectableIds.every((rid) => sel.has(rid));
						}
					} else if (t.dataset && t.dataset.rbSelectPage !== undefined) {
						const pageRecords = (_state.lastResult && _state.lastResult.records) || [];
						const onCanvas = _onCanvasIds();
						// Only the selectable rows: locked on-canvas rows stay
						// checked-and-disabled regardless of the page toggle.
						const pageIds = pageRecords.map((r) => r.Id).filter((id) => id && !onCanvas.has(id));
						if (t.checked) {
							for (const id of pageIds) {
								if (_basketTotal() >= SELECTION_CAP) {
									_capNotice('Selection cap is ' + SELECTION_CAP + ' records. Some rows on this page were not added.');
									break;
								}
								sel.add(id);
							}
						} else {
							for (const id of pageIds) {
sel.delete(id);
}
						}
						// Re-render to flip every row checkbox's checked state.
						content.querySelector('.rb-preview').innerHTML = _renderPreviewTable(_state.lastResult);
						_renderSelectionSummary(content);
						_updateLoadButton(content);
					}
				});

				// Clear-selection button lives in the selection-summary
				// row; delegated on the row so a re-render doesn't lose
				// the handler.
				content.querySelector('.rb-selection-summary').addEventListener('click', (ev) => {
					const t = ev.target;
					if (!t || !t.dataset) {
						return;
					}
					if (t.dataset.rbClearAll !== undefined) {
						// Dump the whole cross-object basket.
						_state.basket.clear();
						content.querySelector('.rb-preview').innerHTML = _renderPreviewTable(_state.lastResult);
						_renderSelectionSummary(content);
						_updateLoadButton(content);
					} else if (t.dataset.rbClearObject) {
						// Drop one object's picks from the basket.
						_state.basket.delete(t.dataset.rbClearObject);
						content.querySelector('.rb-preview').innerHTML = _renderPreviewTable(_state.lastResult);
						_renderSelectionSummary(content);
						_updateLoadButton(content);
					} else if (t.dataset.rbGotoObject) {
						// Jump the picker to a basket object to refine it.
						const obj = t.dataset.rbGotoObject;
						if (obj === _state.objectName) {
							return;
						}
						const picker = content.querySelector('.rb-object-picker');
						if (picker) {
							picker.value = obj;
							picker.dispatchEvent(new Event('change', { bubbles: true }));
						}
					}
				});

				// Load to canvas: runs the compiled SOQL directly via
				// runAndCommitSoql so users get one-click load. The
				// commit pipeline (FK auto-derivation, tree layout,
				// autosave) is the same the SOQL importer uses; we
				// just skip the importer's confirm step since the user
				// already saw the count + preview here.
				// Button lives in .modal-footer (sibling of .rb-content),
				// so resolve via the modal root.
				const overlay = content.closest('.record-browse-modal');
				const loadBtn = overlay && overlay.querySelector('.rb-load-btn');
				if (loadBtn) {
					loadBtn.addEventListener('click', async () => {
						const entries = _basketEntries();
						const basketTotal = _basketTotal();
						// Build the unit(s) of work. Basket-mode loads the whole
						// cross-object selection (one WHERE Id IN query per object).
						// All-mode loads the current object's full filter match via
						// the server-supplied loadSoql.
						let jobs;
						if (basketTotal > 0) {
							jobs = entries.map((e) => ({
								objectName: e.objectName,
								count: e.count,
								soql: 'SELECT Id FROM ' + e.objectName + ' WHERE Id IN (' +
									Array.from(e.ids).map((id) => "'" + String(id).replace(/'/g, "\\'") + "'").join(', ') + ')',
							}));
						} else {
							if (!_state.lastResult || !_state.lastResult.loadSoql) {
								return;
							}
							jobs = [{
								objectName: _state.objectName,
								// Net-new count for the cap pre-check: loadSoql
								// pulls all matches but on-canvas ones dedup out.
								count: (typeof _state.lastResult.loadableCount === 'number'
									? _state.lastResult.loadableCount
									: (_state.lastResult.count || 0)),
								soql: _state.lastResult.loadSoql,
							}];
						}
						const originalLabel = loadBtn.textContent;
						const statusEl = content.querySelector('.rb-count');
						const showErr = (msg) => {
							loadBtn.disabled = false;
							loadBtn.textContent = originalLabel;
							if (statusEl) {
								statusEl.classList.add('rb-count-error');
								statusEl.textContent = msg;
							}
						};
						// Refuse the WHOLE batch up-front if the combined load would
						// exceed the canvas cap: never partial-fill, and for a basket
						// never load some objects but not others.
						const attempt = jobs.reduce((sum, j) => sum + j.count, 0);
						const cap = canvasCapCheck(attempt);
						if (cap.blocked) {
							showErr(cap.reason || 'Canvas is at the record limit.');
							showBulkToast(cap.reason || 'Canvas is at the record limit.', 'error');
							return;
						}
						loadBtn.disabled = true;
						loadBtn.textContent = 'Loading…';
						// Snapshot before any commit: powers the post-load Undo
						// toast AND the all-or-nothing rollback below.
						const _undo = captureUndoSnapshot ? captureUndoSnapshot() : null;
						let added = 0;
						let skipped = 0;
						try {
							for (const job of jobs) {
								const summary = await runAndCommitSoql(job.soql, { knownTotal: job.count });
								if (summary.blocked) {
									// The canvas can fill concurrently after the up-front
									// check. Preserve basket atomicity even when the commit
									// pipeline reports a block instead of throwing.
									const rolledBack = added > 0 && _undo;
									if (rolledBack) {
										_undo();
									}
									const reason = summary.capReason || 'Canvas is at the record limit.';
									const msg = reason + (rolledBack
										? ' (rolled back the ' + added + ' record' + (added === 1 ? '' : 's') + ' already added; nothing changed).'
										: '');
									showErr(msg);
									showBulkToast(msg, 'error');
									return;
								}
								added += summary.added || 0;
								skipped += summary.skipped || 0;
							}
						} catch (err) {
							// Multi-object baskets are all-or-nothing: if a later
							// object's load fails after an earlier one committed,
							// roll the canvas back to the pre-load snapshot rather
							// than leaving a partial load.
							const rolledBack = added > 0 && _undo;
							if (rolledBack) {
								_undo();
							}
							const _msg = 'Load failed: ' + (err.message || String(err)) +
								(rolledBack ? ' (rolled back the ' + added + ' record' + (added === 1 ? '' : 's') + ' already added; nothing changed).' : '');
							_shared.captureImportFailure('browse', 'load', err.message || String(err));
							showErr(_msg);
							// Replaces the restore's own "Import undone." toast so
							// the visible message explains WHY the canvas reverted.
							showBulkToast(_msg, 'error');
							return;
						}
						// Audit: a Browse load is a bulk SF read onto the canvas:
						// record object names + counts (never filter values, which
						// can carry PII in user-typed literals).
						if (pingAuditEvent && (added > 0 || skipped > 0)) {
							pingAuditEvent('canvas_browse_load', {
								recordCount: added,
								payload: {
									objects: jobs.map((j) => j.objectName),
									added,
									skipped,
									mode: basketTotal > 0 ? 'basket' : 'all-matches',
								},
							});
						}
						const objCount = jobs.length;
						const acrossNote = objCount > 1 ? ' across ' + objCount + ' objects' : '';
						const skippedNote = skipped > 0 ? ' · ' + skipped + ' already on canvas (skipped)' : '';
						if (added === 0 && skipped > 0) {
							showBulkToast('All ' + skipped + ' record' + (skipped === 1 ? '' : 's') + ' from your selection are already on the canvas.');
						} else if (added === 0) {
							showBulkToast('Nothing to add.');
						} else {
							const _msg = 'Added ' + added + ' record' + (added === 1 ? '' : 's') + acrossNote + ' from Browse.' + skippedNote;
							if (_undo && showBulkToastWithAction) {
								showBulkToastWithAction(_msg, 'Undo', _undo);
							} else {
								showBulkToast(_msg);
							}
						}
						_state.basket.clear();
						overlay.remove();
					});
				}
			}

			function openBrowseModal(initialObjectName) {
				document.querySelectorAll('.record-browse-modal').forEach((el) => el.remove());
				_state = _newState(initialObjectName);
				const overlay = document.createElement('div');
				overlay.className = 'modal record-browse-modal';
				overlay.innerHTML =
					'<div class="modal-overlay" data-rb-close></div>' +
					'<div class="modal-body" style="max-width:880px">' +
						'<div class="modal-header">' +
							'<h3>Browse records</h3>' +
							'<button class="modal-close" data-rb-close>&times;</button>' +
						'</div>' +
						'<div class="modal-content rb-content">' +
							'<p class="tag">Filter records by field values. The count updates live as you build. Load matching records onto the canvas when you’re ready.</p>' +
							'<div class="rb-toolbar">' +
								'<label class="rb-label">Object</label>' +
								'<select class="rb-object-picker"><option value="">Loading objects…</option></select>' +
							'</div>' +
							'<div class="rb-section-head">Filters</div>' +
							'<div class="rb-filters"></div>' +
							'<div class="rb-results-head">' +
								'<span class="rb-count"></span>' +
								'<span class="rb-page-info"></span>' +
							'</div>' +
							'<div class="rb-selection-summary"></div>' +
							'<div class="rb-preview"></div>' +
						'</div>' +
						'<div class="modal-footer">' +
							'<button class="button secondary" data-rb-close>Cancel</button>' +
							'<button class="button rb-load-btn" disabled>Load to canvas</button>' +
						'</div>' +
					'</div>';
				document.body.appendChild(overlay);
				const content = overlay.querySelector('.rb-content');
				const cleanup = () => {
					document.removeEventListener('keydown', onEsc, true);
					if (_fetchTimer) {
 clearTimeout(_fetchTimer); _fetchTimer = null; 
}
					if (overlay.parentNode) {
overlay.remove();
}
				};
				const onEsc = (e) => {
 if (e.key === 'Escape') {
cleanup();
} 
};
				document.addEventListener('keydown', onEsc, true);
				overlay.querySelectorAll('[data-rb-close]').forEach((el) => el.addEventListener('click', cleanup));

				_renderBody(content);
				_wireBodyHandlers(content);

				// Auto-trigger if an initial object was passed (caller
				// opened browse with a specific object already in mind).
				if (initialObjectName) {
					ensureDescribe(initialObjectName).then(() => {
						_renderBody(content);
						_scheduleFetch(content);
					}).catch(() => {});
				}
			}

			return {
				openBrowseModal: openBrowseModal,
			};
		},
	};
})();
