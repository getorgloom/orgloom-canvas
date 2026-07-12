(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.canvasCardMenu = {
		mount: function mount(deps) {
			const required = [
				'canvasState',
				'csrfFetch',
				'escapeHtml',
				'renderBulkView',
				'recordOrdinal',
				'showBulkToast',
				'showConfirmDialog',
				'isRecordModified',
				'_canAuthorSlots',
				'_hasCap',

				'openInsertModal',
				'convertRecordToSlot',
				'convertRecordToFieldSlot',
				'convertSlotBackToRecord',
				'refreshRecordFromSf',
				'deleteRecord',
				'markPendingDelete',
				'unmarkPendingDelete',
				'attachSfUserPicker',
				'_fillSlotWithSfRecord',
			];
			if (!deps) {
				throw new Error('canvas-card-menu.mount: missing deps object');
			}
			for (const k of required) {
				if (deps[k] === undefined || deps[k] === null) {
					throw new Error('canvas-card-menu.mount: missing dep ' + k);
				}
			}
			const canvasState = deps.canvasState;
			const csrfFetch = deps.csrfFetch;
			const escapeHtml = deps.escapeHtml;
			const renderBulkView = deps.renderBulkView;
			const recordOrdinal = deps.recordOrdinal;
			const showBulkToast = deps.showBulkToast;
			const showConfirmDialog = deps.showConfirmDialog;
			const isRecordModified = deps.isRecordModified;
			const _canAuthorSlots = deps._canAuthorSlots;
			const _hasCap = deps._hasCap;
			const openInsertModal = deps.openInsertModal;
			const convertRecordToSlot = deps.convertRecordToSlot;
			const convertRecordToFieldSlot = deps.convertRecordToFieldSlot;
			const convertSlotBackToRecord = deps.convertSlotBackToRecord;
			const refreshRecordFromSf = deps.refreshRecordFromSf;
			const deleteRecord = deps.deleteRecord;
			const markPendingDelete = deps.markPendingDelete;
			const unmarkPendingDelete = deps.unmarkPendingDelete;
			const attachSfUserPicker = deps.attachSfUserPicker;
			const _fillSlotWithSfRecord = deps._fillSlotWithSfRecord;

			function showFieldPicker(
				clientX,
				clientY,
				options,
				srcRec,
				targetRec,
				onPick,
			) {
				document.querySelectorAll('.field-picker').forEach((el) => el.remove());
				const pop = document.createElement('div');
				pop.className = 'field-picker';
				const x = Math.min(clientX, window.innerWidth - 260);
				const y = Math.min(
					clientY,
					window.innerHeight - (options.length * 36 + 80),
				);
				pop.style.left = Math.max(8, x) + 'px';
				pop.style.top = Math.max(8, y) + 'px';
				pop.innerHTML =
					'<div class="field-picker-header">Pick reference field</div>' +
					options
						.map((o, i) => {
							const holderRec =
								o.direction === 'fwd' ? srcRec : targetRec;
							const holderLabel =
								'#' + recordOrdinal(holderRec) + ' ' + holderRec.label;
							return (
								'<button type="button" data-idx="' +
								i +
								'">' +
								escapeHtml(o.fieldName) +
								'<span class="fp-hint">on ' +
								escapeHtml(holderLabel) +
								'</span>' +
								'</button>'
							);
						})
						.join('') +
					'<button type="button" class="fp-cancel">Cancel</button>';
				document.body.appendChild(pop);
				const cleanup = () => {
					pop.remove();
					document.removeEventListener('mousedown', outside, true);
					document.removeEventListener('keydown', onEsc, true);
				};
				pop.querySelectorAll('button[data-idx]').forEach((b) => {
					b.addEventListener('click', () => {
						const idx = parseInt(b.dataset.idx, 10);
						cleanup();
						onPick(options[idx]);
					});
				});
				pop.querySelector('.fp-cancel').addEventListener('click', () => {
					cleanup();
					renderBulkView();
				});
				const outside = (e) => {
					if (!pop.contains(e.target)) {
						cleanup();
						renderBulkView();
					}
				};
				const onEsc = (e) => {
					if (e.key === 'Escape') {
						e.stopPropagation();
						cleanup();
						renderBulkView();
					}
				};
				setTimeout(() => {
					document.addEventListener('mousedown', outside, true);
					document.addEventListener('keydown', onEsc, true);
				}, 0);
			}

			function showCardMoreMenu(triggerEl, rec) {
				document
					.querySelectorAll('.card-more-popup')
					.forEach((el) => el.remove());
				const pop = document.createElement('div');
				pop.className = 'find-object-popup card-more-popup';
				pop.style.width = '280px';
				const r = triggerEl.getBoundingClientRect();
				pop.style.left =
					Math.max(8, Math.min(r.left, window.innerWidth - 288)) + 'px';
				pop.style.top = r.bottom + 6 + 'px';
				const isSlot = !!(rec.slot && rec.slot.slotId != null);
				const isLoaded = !!rec.loadedFromId;
				const isTypeNode = !!rec.isTypeNode;
				const isInaccessible = !!rec._inaccessible;
				const isPendingDelete = !!rec.pendingDelete;
				const isPending = !!rec.isPending;
				const slotKind = isSlot ? rec.slot.kind || 'whole-record' : null;

				let editItem = '';
				if (!isTypeNode && !isInaccessible && !isPending) {
					editItem =
						'<button type="button" class="fop-item" data-card-action="edit">' +
						'<span class="fop-label">Edit</span>' +
						'<span class="fop-name">Open the record editor (or double-click the card)</span>' +
						'</button>';
				}
				let refreshItem = '';
				if (
					isLoaded &&
					!isPendingDelete &&
					!isPending &&
					!isInaccessible &&
					!isTypeNode &&
					rec.loadedFromId &&
					_hasCap('browse-records')
				) {
					refreshItem =
						'<button type="button" class="fop-item" data-card-action="refresh-sf">' +
						'<span class="fop-label">Refresh from Salesforce</span>' +
						'<span class="fop-name">Replace this card&rsquo;s values with the current Salesforce state</span>' +
						'</button>';
				}
				let slotItems;
				if (isSlot) {
					slotItems =
						'<button type="button" class="fop-item" data-card-action="unslot">' +
						'<span class="fop-label">Convert back to record</span>' +
						'<span class="fop-name">Remove the slot marker' +
						(slotKind === 'fields' ? ' (currently field-level)' : '') +
						'</span>' +
						'</button>';
				} else {
					const slotsAllowed = _canAuthorSlots();
					if (slotsAllowed) {
						slotItems =
							'<button type="button" class="fop-item" data-card-action="to-slot">' +
							'<span class="fop-label">Convert to slot</span>' +
							'<span class="fop-name">Whole record: recipient creates a fresh draft</span>' +
							'</button>';
						if (isLoaded) {
							slotItems +=
								'<button type="button" class="fop-item" data-card-action="to-field-slot">' +
								'<span class="fop-label">Mark fields for recipient&hellip;</span>' +
								'<span class="fop-name">Field-level: recipient updates only the fields you pick</span>' +
								'</button>';
						} else {
							slotItems +=
								'<button type="button" class="fop-item is-disabled" disabled aria-disabled="true" ' +
								'title="Field-level slots target an existing Salesforce record. Upload this draft first, then return here.">' +
								'<span class="fop-label">Mark fields for recipient&hellip;</span>' +
								'<span class="fop-name">Upload this draft first: field-level slots target an existing record</span>' +
								'</button>';
						}
					} else {
						slotItems =
							'<button type="button" class="fop-item is-disabled" disabled aria-disabled="true" ' +
							'title="Slot canvases require Pro or higher.">' +
							'<span class="fop-label">Convert to slot <span class="tag">Pro</span></span>' +
							'<span class="fop-name">Upgrade to Pro to author slot canvases</span>' +
							'</button>';
						slotItems +=
							'<button type="button" class="fop-item is-disabled" disabled aria-disabled="true" ' +
							'title="Slot canvases require Pro or higher.">' +
							'<span class="fop-label">Mark fields for recipient&hellip; <span class="tag">Pro</span></span>' +
							'<span class="fop-name">Upgrade to Pro to mark fields as recipient slots</span>' +
							'</button>';
					}
				}
				let dangerItems = '';
				if (!isTypeNode) {
					dangerItems += '<div class="fop-divider"></div>';
					dangerItems +=
						'<button type="button" class="fop-item" data-card-action="remove-from-canvas">' +
						'<span class="fop-label">Remove from canvas</span>' +
						'<span class="fop-name">' +
						(isLoaded
							? 'Take this card off the canvas; the Salesforce record stays intact'
							: 'Delete this draft; it only exists in your browser') +
						'</span>' +
						'</button>';
					if (isLoaded && !isInaccessible) {
						if (isPendingDelete) {
							dangerItems +=
								'<button type="button" class="fop-item fop-item-warn" data-card-action="unmark-delete">' +
								'<span class="fop-label">Keep this record</span>' +
								'<span class="fop-name">Unmark: Salesforce DELETE on next upload is cancelled</span>' +
								'</button>';
						} else {
							dangerItems +=
								'<button type="button" class="fop-item fop-item-danger" data-card-action="mark-delete">' +
								'<span class="fop-label">Mark for delete in Salesforce</span>' +
								'<span class="fop-name">Stages a DELETE that ships with your next upload</span>' +
								'</button>';
						}
					}
				}
				pop.innerHTML =
					editItem +
					refreshItem +
					((editItem || refreshItem) && slotItems ? '<div class="fop-divider"></div>' : '') +
					slotItems +
					dangerItems;
				document.body.appendChild(pop);
				{
					const margin = 8;
					const menuH = pop.offsetHeight;
					const vpH = window.innerHeight;
					const spaceBelow = vpH - (r.bottom + 6) - margin;
					const spaceAbove = r.top - 6 - margin;
					if (menuH <= spaceBelow) {

					} else if (menuH <= spaceAbove) {
						pop.style.top = r.top - 6 - menuH + 'px';
					} else {
						pop.style.top = margin + 'px';
						pop.style.maxHeight = vpH - margin * 2 + 'px';
						pop.style.overflowY = 'auto';
					}
				}
				const cleanup = () => {
					if (pop.parentNode) {
						pop.remove();
					}
					document.removeEventListener('mousedown', outside, true);
					document.removeEventListener('keydown', onEsc, true);
				};
				const outside = (ev) => {
					if (!pop.contains(ev.target) && ev.target !== triggerEl) {
						cleanup();
					}
				};
				const onEsc = (ev) => {
					if (ev.key === 'Escape') {
						cleanup();
					}
				};
				setTimeout(() => {
					document.addEventListener('mousedown', outside, true);
					document.addEventListener('keydown', onEsc, true);
				}, 0);
				pop.addEventListener('click', async (ev) => {
					const btn = ev.target.closest('[data-card-action]');
					if (!btn) {
						return;
					}
					const action = btn.dataset.cardAction;
					cleanup();
					if (action === 'edit') {
						openInsertModal(rec.objectName, { record: rec });
					} else if (action === 'to-slot') {
						await convertRecordToSlot(rec);
					} else if (action === 'to-field-slot') {
						await convertRecordToFieldSlot(rec);
					} else if (action === 'unslot') {
						convertSlotBackToRecord(rec);
					} else if (action === 'refresh-sf') {
						await refreshRecordFromSf(rec);
					} else if (action === 'remove-from-canvas') {
						deleteRecord(rec.id);
					} else if (action === 'mark-delete') {
						if (isRecordModified(rec)) {
							const ok = await showConfirmDialog({
								title: 'Discard unsaved edits?',
								message:
									"This record has unsaved edits. Marking it for delete will discard those edits: the record will be DELETE'd in Salesforce on next upload regardless.",
								confirmLabel: 'Discard edits and mark for delete',
								cancelLabel: 'Cancel',
								danger: true,
							});
							if (!ok) {
								return;
							}
							markPendingDelete(rec.id, { discardEdits: true });
						} else {
							markPendingDelete(rec.id);
						}
					} else if (action === 'unmark-delete') {
						unmarkPendingDelete(rec.id);
					}
				});
			}

			function showFieldSlotPicker(objectName, fields) {
				return new Promise((resolve) => {
					const overlay = document.createElement('div');
					overlay.className = 'modal';
					const fieldRows = fields
						.map(
							(f) =>
								'<label class="field-slot-pick-row">' +
								'<input type="checkbox" data-fname="' +
								escapeHtml(f.name) +
								'">' +
								'<span class="field-slot-pick-label">' +
								escapeHtml(f.label) +
								'</span>' +
								'<span class="meta">' +
								escapeHtml(f.name) +
								' · ' +
								escapeHtml(f.type) +
								'</span>' +
								'</label>',
						)
						.join('');
					overlay.innerHTML =
						'<div class="modal-overlay" data-cancel></div>' +
						'<div class="modal-body" style="max-width:520px">' +
						'<div class="modal-header">' +
						'<h3>Pick fields for the recipient to fill</h3>' +
						'<button class="modal-close" data-cancel>&times;</button>' +
						'</div>' +
						'<div class="modal-content">' +
						'<p class="tag">Recipient sees the live ' +
						escapeHtml(objectName) +
						' record; only the fields you check here are editable for them. Everything else stays read-only.</p>' +
						'<div class="field-slot-pick-list">' +
						fieldRows +
						'</div>' +
						'</div>' +
						'<div class="modal-footer">' +
						'<button class="button secondary" data-cancel>Cancel</button>' +
						'<button class="button" data-submit>Continue</button>' +
						'</div>' +
						'</div>';
					document.body.appendChild(overlay);
					const close = (val) => {
						overlay.remove();
						resolve(val);
					};
					overlay
						.querySelectorAll('[data-cancel]')
						.forEach((el) =>
							el.addEventListener('click', () => close(null)),
						);
					overlay
						.querySelector('[data-submit]')
						.addEventListener('click', () => {
							const checked = Array.from(
								overlay.querySelectorAll(
									'input[type="checkbox"]:checked',
								),
							).map((cb) => cb.dataset.fname);
							close(checked);
						});
				});
			}

			function showSlotMetaPicker(opts) {
				const title = opts && opts.title;
				const initial = opts && opts.initial;
				const safeTitle = title || 'Slot configuration';
				return new Promise((resolve) => {
					document
						.querySelectorAll('.slot-meta-modal')
						.forEach((el) => el.remove());
					const overlay = document.createElement('div');
					overlay.className = 'modal slot-meta-modal';
					overlay.innerHTML =
						'<div class="modal-overlay" data-sm-close></div>' +
						'<div class="modal-body" style="max-width:520px">' +
						'<div class="modal-header">' +
						'<h3>' +
						escapeHtml(safeTitle) +
						'</h3>' +
						'<button class="modal-close" data-sm-close>&times;</button>' +
						'</div>' +
						'<div class="modal-content">' +
						'<div class="field" style="margin-bottom:0.9em">' +
						'<label for="sm-label">Slot label <span class="meta">required</span></label>' +
						'<input type="text" id="sm-label" placeholder="e.g. Customer Account" autocomplete="off" value="' +
						escapeHtml((initial && initial.label) || '') +
						'">' +
						'</div>' +
						'<div class="field" style="margin-bottom:0.9em">' +
						'<label for="sm-desc">Description <span class="meta">optional</span></label>' +
						'<input type="text" id="sm-desc" placeholder="e.g. Your assigned territory account" autocomplete="off" value="' +
						escapeHtml((initial && initial.description) || '') +
						'">' +
						'</div>' +
						'<div class="field">' +
						'<label>Assign to <span class="meta">optional</span></label>' +
						'<div class="help" style="margin-bottom:0.4em">If assigned, only this teammate can fill the slot. Leave blank to let any recipient fill it.</div>' +
						'<div id="sm-assignee-picker"></div>' +
						'</div>' +
						'</div>' +
						'<div class="modal-footer">' +
						'<button class="button secondary" data-sm-close>Cancel</button>' +
						'<button class="button" data-sm-save>Save</button>' +
						'</div>' +
						'</div>';
					document.body.appendChild(overlay);

					const labelInput = overlay.querySelector('#sm-label');
					const descInput = overlay.querySelector('#sm-desc');
					const assigneeHost = overlay.querySelector('#sm-assignee-picker');
					const picker = attachSfUserPicker(assigneeHost, {
						placeholder: 'Search a teammate to assign…',
					});
					setTimeout(() => labelInput.focus(), 0);

					const cleanup = (result) => {
						overlay.remove();
						document.removeEventListener('keydown', onKey);
						resolve(result);
					};
					const onKey = (e) => {
						if (e.key === 'Escape') {
							cleanup(null);
						}
					};
					document.addEventListener('keydown', onKey);
					overlay
						.querySelectorAll('[data-sm-close]')
						.forEach((el) =>
							el.addEventListener('click', () => cleanup(null)),
						);
					overlay
						.querySelector('[data-sm-save]')
						.addEventListener('click', () => {
							const label = (labelInput.value || '').trim();
							if (!label) {
								labelInput.focus();
								return;
							}
							const description = (descInput.value || '').trim() || null;
							const assignee = picker.getPicked();
							cleanup({
								label,
								description,
								assigneeSfUserId: assignee ? assignee.id : null,
								assigneeName: assignee ? assignee.name : null,
								assigneeEmail: assignee ? assignee.email : null,
							});
						});
					labelInput.addEventListener('keydown', (e) => {
						if (e.key === 'Enter') {
							e.preventDefault();
							descInput.focus();
						}
					});
				});
			}

			function _openSlotRecordPicker(rec, anchorEl) {
				document
					.querySelectorAll(
						'.find-object-popup, .free-tn-picker, .slot-picker',
					)
					.forEach((el) => el.remove());
				const pop = document.createElement('div');
				pop.className = 'find-object-popup slot-picker';
				pop.style.width = '320px';
				if (anchorEl && typeof anchorEl.getBoundingClientRect === 'function') {
					const r = anchorEl.getBoundingClientRect();
					pop.style.left =
						Math.max(8, Math.min(r.left, window.innerWidth - 328)) + 'px';
					pop.style.top = r.bottom + 6 + 'px';
				} else {
					pop.style.left = '50%';
					pop.style.top = '20%';
					pop.style.transform = 'translateX(-50%)';
				}
				const slotLabel =
					rec.slot && rec.slot.label
						? rec.slot.label
						: rec.label || rec.objectName;
				pop.innerHTML =
					'<div class="fop-header">Fill slot: ' +
					escapeHtml(slotLabel) +
					'</div>' +
					'<div class="fop-sub">Search ' +
					escapeHtml(rec.label || rec.objectName) +
					' by Name or paste a 15/18-char id.</div>' +
					'<input type="search" class="fop-search slot-search" placeholder="Search…" autocomplete="off">' +
					'<div class="fop-list slot-list"></div>';
				document.body.appendChild(pop);
				const input = pop.querySelector('.slot-search');
				const list = pop.querySelector('.slot-list');
				let seq = 0;
				const cleanup = () => {
					if (pop.parentNode) {
						pop.remove();
					}
					document.removeEventListener('mousedown', outside, true);
					document.removeEventListener('keydown', onEsc, true);
				};
				const outside = (ev) => {
					if (!pop.contains(ev.target)) {
						cleanup();
					}
				};
				const onEsc = (ev) => {
					if (ev.key === 'Escape') {
						cleanup();
					}
				};
				const fetchById = async (id) => {
					list.innerHTML =
						'<div class="fop-empty">Loading record…</div>';
					try {
						const resp = await csrfFetch(
							'/api/objects/' +
								encodeURIComponent(rec.objectName) +
								'/records/' +
								encodeURIComponent(id),
							{ credentials: 'same-origin' },
						);
						if (!resp.ok) {
							throw new Error(resp.statusText);
						}
						const single = await resp.json();
						cleanup();
						await _fillSlotWithSfRecord(rec, single);
					} catch (e) {
						list.innerHTML = '<div class="fop-empty">Not found.</div>';
					}
				};
				const runSearch = async () => {
					const q = (input.value || '').trim();
					if (/^[a-zA-Z0-9]{15,18}$/.test(q)) {
						fetchById(q);
						return;
					}
					if (!q) {
						list.innerHTML = '';
						return;
					}
					const mySeq = ++seq;
					list.innerHTML = '<div class="fop-empty">Searching…</div>';
					try {
						const resp = await csrfFetch(
							'/api/objects/' +
								encodeURIComponent(rec.objectName) +
								'/search?q=' +
								encodeURIComponent(q),
							{ credentials: 'same-origin' },
						);
						if (!resp.ok) {
							throw new Error(resp.statusText);
						}
						const data = await resp.json();
						if (mySeq !== seq) {
							return;
						}
						const records = (data && data.records) || [];
						if (records.length === 0) {
							list.innerHTML =
								'<div class="fop-empty">No matches. (Empty results may also mean limited sharing access; ask your admin if you expected to see this record.)</div>';
							return;
						}
						const onCanvas = new Set(
							canvasState.bulkRecords
								.filter(
									(b) =>
										!b.isTypeNode &&
										b.id !== rec.id &&
										b.objectName === rec.objectName &&
										b.loadedFromId,
								)
								.map((b) => b.loadedFromId),
						);
						list.innerHTML = records
							.map((r) => {
								const already = onCanvas.has(r.id);
								return (
									'<button type="button" class="fop-item' +
									(already ? ' is-already' : '') +
									'" data-pick-id="' +
									escapeHtml(r.id) +
									'"' +
									(already
										? ' disabled title="Already on the canvas"'
										: '') +
									'>' +
									'<span class="fop-label">' +
									escapeHtml(r.name || '(no name)') +
									'</span>' +
									'<span class="fop-name">' +
									escapeHtml(r.id) +
									(already ? ' · already loaded' : '') +
									'</span>' +
									'</button>'
								);
							})
							.join('');
					} catch (e) {
						if (mySeq !== seq) {
							return;
						}
						list.innerHTML =
							'<div class="fop-empty">Search failed: ' +
							escapeHtml(e.message || String(e)) +
							'</div>';
					}
				};
				let timer;
				input.addEventListener('input', () => {
					clearTimeout(timer);
					timer = setTimeout(runSearch, 250);
				});
				list.addEventListener('click', (ev) => {
					const btn = ev.target.closest('[data-pick-id]');
					if (!btn || btn.disabled) {
						return;
					}
					fetchById(btn.dataset.pickId);
				});
				setTimeout(() => input.focus(), 0);
				setTimeout(() => {
					document.addEventListener('mousedown', outside, true);
					document.addEventListener('keydown', onEsc, true);
				}, 0);
			}

			return {
				showFieldPicker: showFieldPicker,
				showCardMoreMenu: showCardMoreMenu,
				showFieldSlotPicker: showFieldSlotPicker,
				showSlotMetaPicker: showSlotMetaPicker,
				_openSlotRecordPicker: _openSlotRecordPicker,
			};
		},
	};
})();
