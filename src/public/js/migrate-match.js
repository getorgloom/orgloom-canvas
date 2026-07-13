(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	const KEYABLE_TYPES = new Set([
		'string', 'email', 'phone', 'url', 'textarea',
		'int', 'double', 'currency', 'percent',
	]);

	function _distinctObjects(canvasState) {
		const map = new Map();
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
			(f) => f && f.name && KEYABLE_TYPES.has(f.type),
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
		return fields.slice().sort((a, b) =>
			rank(a) - rank(b) ||
			String(a.label || a.name).localeCompare(String(b.label || b.name)),
		);
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
				const overlay = document.createElement('div');
				overlay.className = 'modal migrate-match-modal';
				overlay.innerHTML =
					'<div class="modal-overlay" data-mm-close></div>' +
					'<div class="modal-body" style="max-width:760px">' +
						'<div class="modal-header">' +
							'<h3>Match existing records in the destination</h3>' +
							'<button class="modal-close" data-mm-close>&times;</button>' +
						'</div>' +
						'<div class="modal-content mm-content">' +
							'<p class="tag">Pick a field per object to look up records that already exist in this org. Matching runs automatically as you choose: matches become <strong>updates</strong> instead of new inserts, so re-running a migration won’t create duplicates. Switch a field back to “insert as new” to undo its matches.</p>' +
							'<div class="mm-rows"></div>' +
							'<div class="mm-summary"></div>' +
						'</div>' +
						'<div class="modal-footer">' +
							'<button class="button" data-mm-close>Done</button>' +
						'</div>' +
					'</div>';
				document.body.appendChild(overlay);

				const cleanup = () => {
					document.removeEventListener('keydown', onEsc, true);
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
				overlay.querySelectorAll('[data-mm-close]').forEach((el) =>
					el.addEventListener('click', cleanup),
				);

				const rowsEl = overlay.querySelector('.mm-rows');
				const summaryEl = overlay.querySelector('.mm-summary');

				const _seqByObject = {};

				const names = Array.from(objects.keys());
				Promise.all(
					names.map((n) =>
						(ensureDescribe ? ensureDescribe(n) : Promise.resolve(null)).catch(() => null),
					),
				).then(() => renderRows());

				function renderRows() {
					rowsEl.innerHTML = names.map((name) => {
						const describe = canvasState.describeCache[name];
						const recs = objects.get(name) || [];
						const candidates = _keyCandidates(describe);
						const opts = candidates.map((f) =>
							'<option value="' + escapeHtml(f.name) + '">' +
							escapeHtml(f.label || f.name) + ' (' + escapeHtml(f.name) + ')' +
							escapeHtml(_tierLabel(f)) + '</option>',
						).join('');
						const disabled = candidates.length === 0 ? ' disabled' : '';
						const note = candidates.length === 0
							? '<span class="mm-row-note">No queryable key fields, so these will insert as new.</span>'
							: '';
						return '<div class="mm-row" data-mm-object="' + escapeHtml(name) + '">' +
							'<div class="mm-row-meta">' +
								'<div class="mm-row-obj">' + escapeHtml(name) + '</div>' +
								'<div class="mm-row-sub">' + recs.length + ' record' + (recs.length === 1 ? '' : 's') + ' on canvas</div>' +
							'</div>' +
							'<div class="mm-row-key">' +
								'<select class="mm-key-select"' + disabled + '>' +
									'<option value="">(insert as new)</option>' +
									opts +
								'</select>' +
								note +
								'<span class="mm-row-result"></span>' +
							'</div>' +
						'</div>';
					}).join('');

					overlay.querySelectorAll('.mm-row').forEach((row) => {
						const name = row.getAttribute('data-mm-object');
						const sel = row.querySelector('.mm-key-select');
						const resultEl = row.querySelector('.mm-row-result');
						if (!sel) {
							return;
						}
						sel.addEventListener('change', async () => {
							await _runMatchForObject(name, sel.value, resultEl);
							_recomputeSummary();
							renderBulkView();
							onApplied();
						});
					});
				}

				async function _runMatchForObject(name, keyField, resultEl) {
					const recs = objects.get(name) || [];

					recs.forEach((r) => {
						if (r._migrateMatchedId) {
							delete r.loadedFromId;
							delete r._migrateMatchedId;
							delete r._migrateMatchKey;
						}
						delete r._migrateMatchAmbiguous;
					});
					if (!keyField) {
						if (resultEl) {
							resultEl.textContent = '';
						}
						return;
					}
					const seq = (_seqByObject[name] || 0) + 1;
					_seqByObject[name] = seq;

					const valByRec = new Map();
					const values = [];
					recs.forEach((r) => {
						const v = _lookup(r.values, keyField);
						if (v !== null && v !== undefined && String(v) !== '') {
							valByRec.set(r, String(v));
							values.push(String(v));
						}
					});
					if (values.length === 0) {
						if (resultEl) {
							resultEl.textContent = 'no values to match';
						}
						return;
					}
					if (resultEl) {
						resultEl.textContent = 'matching…';
					}
					let resp;
					try {
						resp = await csrfFetch('/api/migrate/match', {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ objectName: name, keyField: keyField, values: values }),
						});
					} catch (err) {
						if (_seqByObject[name] === seq && resultEl) {
							resultEl.textContent = 'error';
						}
						return;
					}
					if (_seqByObject[name] !== seq) {
						return;
					}
					if (!resp.ok) {
						let msg = resp.statusText;
						try {
							const e = await resp.json();
							msg = e.message || e.error || msg;
						} catch (_e) {}
						if (resultEl) {
							resultEl.textContent = 'error: ' + msg;
						}
						return;
					}
					const data = await resp.json();
					if (_seqByObject[name] !== seq) {
						return;
					}
					const matchesByValue = (data && data.matchesByValue) || {};
					const ambiguous = new Set((data && data.ambiguous) || []);
					let converted = 0;
					valByRec.forEach((val, rec) => {
						if (Object.prototype.hasOwnProperty.call(matchesByValue, val)) {

							rec.loadedFromId = matchesByValue[val];
							rec._migrateMatchedId = matchesByValue[val];
							rec._migrateMatchKey = keyField;
							converted++;
						} else if (ambiguous.has(val)) {
							rec._migrateMatchAmbiguous = true;
						}
					});
					if (resultEl) {
						resultEl.textContent = converted > 0
							? converted + ' matched → update' +
								(ambiguous.size ? ', ' + ambiguous.size + ' ambiguous (left as new)' : '')
							: (ambiguous.size ? ambiguous.size + ' ambiguous (left as new)' : 'no matches, all insert as new');
					}
				}

				function _recomputeSummary() {
					let updates = 0;
					let ambiguous = 0;
					let total = 0;
					objects.forEach((recs) => {
						recs.forEach((r) => {
							total++;
							if (r._migrateMatchedId) {
								updates++;
							} else if (r._migrateMatchAmbiguous) {
								ambiguous++;
							}
						});
					});
					const inserts = total - updates;
					summaryEl.innerHTML =
						'<div class="banner ' + (updates > 0 ? 'ok' : '') + '">' +
							escapeHtml(
								updates + ' record' + (updates === 1 ? '' : 's') + ' will update an existing record in the destination. ' +
								(ambiguous ? ambiguous + ' had multiple matches and stay as new. ' : '') +
								inserts + ' will insert as new.',
							) +
						'</div>';
				}
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

			return { open: open };
		},
	};
})();
