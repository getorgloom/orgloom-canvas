// Insert / edit modal: single-record CRUD form.
//
// Renders a form for creating a draft record or editing one already on
// the canvas (drafted or fetched from Salesforce). Pulls describe +
// validation rules, lays the form out per RecordType + Page Layout,
// runs live rule evaluation, wires lookup pickers and autofill, and
// includes the rule-aware sample adjuster (tryFixValidationRules and
// friends; they live here rather than in formula.js because they
// read shared canvas state).
//
// Dependencies passed to mount():
//   canvasState: shared canvas state. The modal reads/writes
//                           savedRecords, currentRecordRef, bulkRecords,
//                           bulkAssociations, describeCache.
//   csrfFetch: fetch wrapper with CSRF header.
//   escapeHtml: HTML-escape helper for template literals.
//   ensureDescribe: async; resolves object describe (fields +
//                           record types) with memory + session caching.
//   showBulkToast: top-level toast (errors, save confirmations).
//   changedFieldNames: value-compare diff helper for save banners.
//   isRecordModified: value-compare modified-state check.
//   deleteAssociation: removes a record-graph association by id;
//                           called from the modal's per-association
//                           remove button.
//   renderChips: repaint top-strip chip counters after save.
//   renderBulkView: repaint the bulk canvas after save.
//   getCanvasShareRole: returns the current share role string
//                           ('viewer', 'editor', 'contributor', or null).
//                           Wrapped as a getter because the modal needs
//                           the live value across re-renders.
//   _formatRelativeTime: humanises a timestamp ("2 minutes ago").
//   _resolveUserName: async; user id → display name for the
//                           "modified by" line.
//   _slotProgress: slot-fill progress object for a record.
//   _slotProgressClass: CSS class for the slot-progress badge.
//   markPendingDelete: (id, opts) → mark a loaded record for SF
//                           DELETE on next upload. opts.discardEdits
//                           snaps unsaved values back to loadedValues
//                           so the canvas card and the staged DELETE
//                           agree.
//   unmarkPendingDelete: (id) → cancel a previously staged DELETE.
//   showConfirmDialog: async; reusable confirm dialog used to
//                           gate destructive modal-footer actions.
//
// Public API (returned from mount):
//   openInsertModal(objectName, opts)
//   opens the modal. opts.record ties the form
//                           to an existing canvas record.
//   closeModal(): closes the modal and resets state.
//   showModalToast(message, variant)
//   floats a toast inside the modal body.
//   _prefetchLayoutForRecord(rec)
//   warms the page-layout cache for a record
//                           so opening its modal is instant. Called
//                           from renderBulkCanvas during canvas paint.
//
// Exposed as window.OrgLoom.insertModal. Load order: after formula.js,
// value-compare.js, and support-modals.js; before app.js.

(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	// Turning a loaded record into a draft changes the meaning of every
	// incoming canvas association. An existing holder (for example, a
	// loaded Contact pointing at the Account being unlinked) must not be
	// silently reparented to the newly inserted draft. Draft holders are
	// different: their relationship exists only on the canvas, so it should
	// continue to point at the new draft by default.
	function unlinkRelationshipImpact(canvasState, targetRecord) {
		const records = (canvasState && canvasState.bulkRecords) || [];
		const associations = (canvasState && canvasState.bulkAssociations) || [];
		const recordsById = new Map(records.map((record) => [record.id, record]));
		const incoming = associations.filter((association) =>
			association && targetRecord && association.toId === targetRecord.id,
		);
		const existingIncoming = incoming.filter((association) => {
			const holder = recordsById.get(association.fromId);
			return !!(holder && holder.loadedFromId);
		});
		const draftIncoming = incoming.filter((association) => {
			const holder = recordsById.get(association.fromId);
			return !!(holder && !holder.loadedFromId && !holder.isTypeNode && !holder.isPending);
		});
		return { incoming, existingIncoming, draftIncoming };
	}

	function applyLoadedRecordUnlink(canvasState, targetRecord, decision) {
		if (!canvasState || !targetRecord) {
			return { detachedExisting: 0, retainedDraft: 0 };
		}
		const impact = unlinkRelationshipImpact(canvasState, targetRecord);
		if (decision !== 'move') {
			const detachAssociations = new Set(impact.existingIncoming);
			// Deliberately filter the associations directly instead of calling
			// deleteAssociation. That helper clears the holder's lookup value;
			// here the old Salesforce Id must remain so the existing holder stays
			// related to the original Salesforce record.
			canvasState.bulkAssociations = (canvasState.bulkAssociations || []).filter(
				(association) => !detachAssociations.has(association),
			);
		}
		targetRecord.loadedFromId = null;
		return {
			detachedExisting: decision === 'move' ? 0 : impact.existingIncoming.length,
			retainedDraft: impact.draftIncoming.length,
		};
	}

	// Carry-over values normally contain Salesforce scalar field values, but
	// compound fields or defensive legacy payloads can contain arrays/objects.
	// Never let JavaScript's unhelpful "[object Object]" leak into the UI.
	function formatCarryoverValue(value) {
		if (value === null || value === undefined || value === '') {
			return '';
		}
		if (typeof value !== 'object') {
			return String(value);
		}
		try {
			const serialized = JSON.stringify(value, null, 2);
			return serialized === undefined ? '(structured value)' : serialized;
		} catch (_error) {
			return '(structured value)';
		}
	}

	window.OrgLoom.insertModal = {
		_test: {
			unlinkRelationshipImpact,
			applyLoadedRecordUnlink,
			formatCarryoverValue,
		},
		mount: function mount(deps) {
			if (!deps || !deps.canvasState || !deps.csrfFetch || !deps.escapeHtml
				|| !deps.ensureDescribe || !deps.showBulkToast
				|| !deps.changedFieldNames || !deps.isRecordModified
				|| !deps.deleteAssociation || !deps.renderChips
				|| !deps.renderBulkView || !deps.getCanvasShareRole
				|| !deps._formatRelativeTime || !deps._resolveUserName
				|| !deps._slotProgress || !deps._slotProgressClass
				|| !deps.recordOrdinal || !deps._slotAssignmentState
				|| !deps.markPendingDelete || !deps.unmarkPendingDelete
				|| !deps.showConfirmDialog || !deps.pushPresenceFocus) {
				throw new Error('insert-modal.mount: missing required deps');
			}
			const canvasState = deps.canvasState;
			const csrfFetch = deps.csrfFetch;
			const escapeHtml = deps.escapeHtml;
			const ensureDescribe = deps.ensureDescribe;
			const showBulkToast = deps.showBulkToast;
			const changedFieldNames = deps.changedFieldNames;
			const isRecordModified = deps.isRecordModified;
			const deleteAssociation = deps.deleteAssociation;
			const renderChips = deps.renderChips;
			const renderBulkView = deps.renderBulkView;
			const getCanvasShareRole = deps.getCanvasShareRole;
			const _formatRelativeTime = deps._formatRelativeTime;
			const _resolveUserName = deps._resolveUserName;
			const _slotProgress = deps._slotProgress;
			const _slotProgressClass = deps._slotProgressClass;
			const recordOrdinal = deps.recordOrdinal;
			const _slotAssignmentState = deps._slotAssignmentState;
			const markPendingDelete = deps.markPendingDelete;
			const unmarkPendingDelete = deps.unmarkPendingDelete;
			const showConfirmDialog = deps.showConfirmDialog;
			const pushPresenceFocus = deps.pushPresenceFocus;
			// Optional: required for the in-canvas expanded card mode.
			// When not provided the modal falls back to its original
			// centered-overlay behavior. Wrapped as getters so the
			// cy instance reference resolves at use time (cy is rebuilt
			// on canvas reset).
			const _getCyInstance = typeof deps.getCyInstance === 'function' ? deps.getCyInstance : null;
			const _getCyContainer = typeof deps.getCyContainer === 'function' ? deps.getCyContainer : null;

			function chooseUnlinkRelationshipBehavior(record, impact) {
				return new Promise((resolve) => {
					document.querySelectorAll('.unlink-relationship-modal').forEach((el) => el.remove());
					const choiceModal = document.createElement('div');
					choiceModal.className = 'modal unlink-relationship-modal';
					const existingCount = impact.existingIncoming.length;
					const draftCount = impact.draftIncoming.length;
					const objectLabel = record.objectLabel || record.objectName || 'record';
					const existingNoun = existingCount === 1 ? 'existing canvas record points' : 'existing canvas records point';
					const draftNote = draftCount > 0
						? '<p>' + escapeHtml(draftCount + ' draft record' + (draftCount === 1 ? '' : 's') +
							' will stay connected to the new draft in either case.') + '</p>'
						: '';
					choiceModal.innerHTML =
						'<div class="modal-overlay" data-unlink-cancel></div>' +
						'<div class="modal-body" style="max-width:520px">' +
							'<div class="modal-header">' +
								'<h3>' + escapeHtml('Unlink this ' + objectLabel + '?') + '</h3>' +
								'<button class="modal-close" data-unlink-cancel>&times;</button>' +
							'</div>' +
							'<div class="modal-content">' +
								'<p>' + escapeHtml(existingCount + ' ' + existingNoun +
									' to this ' + objectLabel + '. Choose whether those records stay with the original Salesforce record or move to the new draft when you upload.') + '</p>' +
								draftNote +
							'</div>' +
							'<div class="modal-footer">' +
								'<button class="button secondary" data-unlink-cancel>Cancel</button>' +
								'<button class="button secondary" data-unlink-move>Move to new draft</button>' +
								'<button class="button" data-unlink-keep>Keep with original</button>' +
							'</div>' +
						'</div>';
					document.body.appendChild(choiceModal);
					let settled = false;
					const finish = (value) => {
						if (settled) {
							return;
						}
						settled = true;
						document.removeEventListener('keydown', onKey);
						choiceModal.remove();
						resolve(value);
					};
					const onKey = (event) => {
						if (event.key === 'Escape') {
							finish(null);
						} else if (event.key === 'Enter') {
							finish('keep');
						}
					};
					document.addEventListener('keydown', onKey);
					choiceModal.querySelectorAll('[data-unlink-cancel]').forEach((el) =>
						el.addEventListener('click', () => finish(null)),
					);
					choiceModal.querySelector('[data-unlink-move]').addEventListener('click', () => finish('move'));
					choiceModal.querySelector('[data-unlink-keep]').addEventListener('click', () => finish('keep'));
					setTimeout(() => choiceModal.querySelector('[data-unlink-keep]').focus(), 0);
				});
			}

			// ----- Insert modal -----
			const modal = document.createElement('div');
			modal.className = 'modal record-editor-modal hidden';
			modal.innerHTML =
				'<div class="modal-overlay" data-close></div>' +
				'<div class="modal-body">' +
					'<div class="modal-header">' +
						'<h3 id="modal-title">New record</h3>' +
						// Object-type indicator next to the record name
						// e.g., the title shows "General Motors" and
						// the subtitle shows "Account · existing" /
						// "Account · draft" so the user knows what
						// type they're editing without having to read
						// the form schema.
						'<div class="modal-subtitle" id="modal-subtitle"></div>' +
						// Collapse-inward arrows instead of × so the
						// inline edit modal's close affordance doesn't
						// read as "delete this record"; the record-
						// card's delete affordance is also an ×.
						'<button class="modal-close" data-close title="Collapse to card" aria-label="Collapse to card">' +
							'<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">' +
								'<path d="M2 6h4V2M12 8H8v4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' +
							'</svg>' +
						'</button>' +
					'</div>' +
					'<div class="modal-content" id="modal-content"><p class="center">Loading…</p></div>' +
					'<div class="modal-toast" id="modal-toast" hidden></div>' +
					'<div class="modal-footer">' +
						// Mark-for-delete lives on the LEFT of the footer
						// (margin-right:auto pushes Cancel/Save to the
						// right). Only visible for loaded SF records:
						// _updateMarkDeleteButton flips visibility + label
						// based on canvasState.currentRecordRef each time
						// the modal opens. Mirrors the popover affordance
						// at app.js#4809 so users staging a delete from the
						// expanded card don’t have to collapse first.
						'<button class="button danger" id="modal-mark-delete" hidden style="margin-right:auto" title="Stages a Salesforce DELETE that ships with your next upload">Mark for delete</button>' +
						'<button class="button secondary" data-close>Cancel</button>' +
						'<button class="button" id="modal-submit" disabled>Save draft</button>' +
					'</div>' +
				'</div>';
			document.body.appendChild(modal);
			modal.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', closeModal));
			document.addEventListener('keydown', e => {
 if (e.key === 'Escape' && !document.querySelector('.unlink-relationship-modal')) {
closeModal();
} 
});

			// Mark-for-delete footer button. Shape mirrors the popover
			// affordance at app.js#4809: shown only for loaded SF records,
			// label flips between "Mark for delete in Salesforce" and
			// "Keep this record" based on pendingDelete state, modified-
			// record case prompts before discarding unsaved edits.
			// Closes the modal after the action so the user immediately
			// sees the canvas card update (renderBulkView is wired via
			// closeModal's existing post-close hooks).
			const _markDeleteBtn = modal.querySelector('#modal-mark-delete');
			function _updateMarkDeleteButton() {
				if (!_markDeleteBtn) {
return;
}
				const rec = canvasState.currentRecordRef;
				const isLoaded = !!(rec && rec.loadedFromId);
				const isTypeNode = !!(rec && rec.isTypeNode);
				const isInaccessible = !!(rec && rec.isInaccessible);
				if (!rec || !isLoaded || isTypeNode || isInaccessible) {
					_markDeleteBtn.hidden = true;
					return;
				}
				_markDeleteBtn.hidden = false;
				const pending = !!rec.pendingDelete;
				if (pending) {
					_markDeleteBtn.textContent = 'Keep record';
					_markDeleteBtn.classList.remove('danger');
					_markDeleteBtn.classList.add('secondary');
					_markDeleteBtn.title = 'Cancel the staged Salesforce DELETE for this record';
				} else {
					_markDeleteBtn.textContent = 'Mark for delete';
					_markDeleteBtn.classList.remove('secondary');
					_markDeleteBtn.classList.add('danger');
					_markDeleteBtn.title = 'Stage a DELETE that ships with your next upload';
				}
			}
			if (_markDeleteBtn) {
				_markDeleteBtn.addEventListener('click', async () => {
					const rec = canvasState.currentRecordRef;
					if (!rec || !rec.loadedFromId) {
return;
}
					if (rec.pendingDelete) {
						unmarkPendingDelete(rec.id);
						closeModal();
						return;
					}
					if (typeof isRecordModified === 'function' && isRecordModified(rec)) {
						const ok = await showConfirmDialog({
							title: 'Discard unsaved edits?',
							message: 'This record has unsaved edits. Marking it for delete will discard those edits: the record will be DELETE\'d in Salesforce on next upload regardless.',
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
					closeModal();
				});
			}

			// Inject four corner resize handles into the modal body. CSS
			// hides them outside inline mode and gives each the matching
			// resize cursor. The card edges remain available for FK links.
			(function _installResizeHandles() {
				const body = modal.querySelector('.modal-body');
				if (!body) {
return;
}
				// Corners only: the 4 edges (N/S/W/E) are reserved
				// for the FK edge-linking gesture (drag from the edge
				// of a record to another record to create an FK
				// association). Putting resize on the edges would
				// fight that gesture.
				const dirs = ['nw', 'ne', 'sw', 'se'];
				dirs.forEach((dir) => {
					const h = document.createElement('div');
					h.className = 'inline-resize-handle inline-resize-handle--' + dir;
					h.dataset.resizeDir = dir;
					h.addEventListener('mousedown', (ev) => _startResize(ev, dir, body));
					body.appendChild(h);
				});
			})();
			function _startResize(ev, dir, body) {
				ev.preventDefault();
				ev.stopPropagation();
				const startX = ev.clientX;
				const startY = ev.clientY;
				const startW = body.offsetWidth;
				const startH = body.offsetHeight;
				const minW = 320;
				const minH = 280;
				const maxW = window.innerWidth * 0.9;
				const maxH = window.innerHeight * 0.9;
				modal.classList.add('is-resizing');
				const onMove = (mev) => {
					const dx = mev.clientX - startX;
					const dy = mev.clientY - startY;
					let newW = startW;
					let newH = startH;
					if (dir.indexOf('e') >= 0) {
newW = startW + dx;
}
					if (dir.indexOf('w') >= 0) {
newW = startW - dx;
}
					if (dir.indexOf('s') >= 0) {
newH = startH + dy;
}
					if (dir.indexOf('n') >= 0) {
newH = startH - dy;
}
					newW = Math.max(minW, Math.min(maxW, newW));
					newH = Math.max(minH, Math.min(maxH, newH));
					modal.style.setProperty('--inline-width', newW + 'px');
					modal.style.setProperty('--inline-height', newH + 'px');
					// Keep the cy node's bbox in lockstep with the modal
					// so FK edges re-route to the new perimeter as the
					// user drags.
					_syncCyNodeSizeToModal();
				};
				const onUp = () => {
					modal.classList.remove('is-resizing');
					document.removeEventListener('mousemove', onMove);
					document.removeEventListener('mouseup', onUp);
					// Re-pin so the viewport clamp re-applies for the new
					// body size: the resize may have pushed the card off
					// the bottom or right edge.
					if (_inlineRenderHandler) {
_inlineRenderHandler();
}
				};
				document.addEventListener('mousemove', onMove);
				document.addEventListener('mouseup', onUp);
			}

			// ----- In-canvas expanded-card mode -----
			//
			// State for the "expanded card pinned to a cy node" mode. When
			// active, the modal renders without the dimmed overlay and
			// follows its target cy node on every render. The modal-header
			// becomes a drag handle that translates the underlying cy node
			// (so dragging the header moves the card AND the card on the
			// canvas as one unit). The body has CSS resize:both for the
			// "size is adjustable" requirement.
			//
			// Single-instance: opening a second expanded card auto-closes
			// the first because openInsertModal always tears down before
			// re-binding.
			let _inlineRecId = null;        // record id currently pinned
			let _inlineOutsideClickHandler = null;  // doc-level click-outside listener (inline mode only)
			let _inlineRenderHandler = null; // cy render listener ref for un-binding
			let _inlineSelectObserver = null; // MutationObserver mirroring card.selected → modal.is-selected
			function _enterInlineMode(rec) {
				if (!_getCyInstance || !_getCyContainer) {
return false;
}
				const cy = _getCyInstance();
				const container = _getCyContainer();
				if (!cy || !container) {
return false;
}
				const cyNode = cy.getElementById('r' + rec.id);
				if (!cyNode || cyNode.length === 0) {
return false;
}
				modal.classList.add('is-inline');
				_inlineRecId = rec.id;
				_inlineCyNode = cyNode;
				// Expose the rec id on the modal-body so the FK
				// edge-linking handlers (which live in records-canvas
				// and search via document.elementsFromPoint) can
				// recognise the modal as the visual "card" for this
				// record and initiate a link drag from its perimeter.
				const _body = modal.querySelector('.modal-body');
				if (_body) {
_body.setAttribute('data-inline-rec-id', String(rec.id));
}
				// Lock the cy node's box size to the modal's bounds
				// BEFORE syncing so records-canvas's per-render sync
				// loop skips this node (otherwise it'd read the still-
				// present underlying card's offsetWidth and shrink the
				// cy node back, stranding the FK edge endpoints + crow-
				// foot markers at the small card's perimeter, hidden
				// behind the modal at z-index 100). The underlying
				// card stays in the DOM (CSP forbids dynamic style
				// injection here) but the modal's z-index covers it.
				cyNode.data('_inlineLocked', true);
				_syncCyNodeSizeToModal();
				_inlinePinToNode(cy, cyNode, container);
				// Mirror the underlying record-card's `.selected` class
				// onto the modal so the accent ring only shows when
				// the record is actually selected, the same affordance
				// as a normal card. Cy's `:selected` state can't be
				// used directly because the canvas runs with
				// autounselectify; selection lives in
				// canvasState.bulkSelectedIds and is surfaced by the
				// html-label template stamping `.selected` on the card.
				// MutationObserver picks up the class flip without
				// relying on cy render events (which don't fire on a
				// selection-only state change since the cy node's
				// position is unchanged).
				const _syncSelected = () => {
					const card = container.querySelector(
						'.cy-card-shell .record-card[data-rec-id="' + rec.id + '"]'
					);
					modal.classList.toggle('is-selected', !!card && card.classList.contains('selected'));
				};
				_inlineRenderHandler = () => _inlinePinToNode(cy, cyNode, container);
				cy.on('render position', _inlineRenderHandler);
				// cytoscape-node-html-label replaces the entire
				// .cy-card-shell subtree on every tpl re-run rather
				// than mutating the class attribute in place, so we
				// have to listen for childList mutations too (not
				// just attribute changes) to notice when the new card
				// node arrives without `.selected`.
				_inlineSelectObserver = new MutationObserver(_syncSelected);
				_inlineSelectObserver.observe(container, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
				_syncSelected();
				// Drag-handle wiring on the header: translate the cy node
				// so the card moves with it on every render tick.
				const header = modal.querySelector('.modal-header');
				if (header) {
_attachInlineDrag(header, cy, cyNode, container);
}
				// Click-outside-to-close. Centered-overlay mode gets
				// this for free via the backdrop's data-close, but in
				// inline mode the backdrop is display:none, so we
				// hook a document-level capture-phase listener that
				// closes when the user clicks anywhere outside the
				// modal body and outside any of its subordinate
				// popovers. Field edits write straight into
				// rec.values as the user types, so there's no buffered
				// state to lose on close. Deferred by a tick so the
				// click that opened the modal doesn't immediately
				// close it.
				_inlineOutsideClickHandler = (ev) => {
					if (!modal.classList.contains('is-inline')) {
return;
}
					const t = ev.target;
					if (!t || !t.closest) {
return;
}
					// Click inside the edit modal itself: keep open.
					if (t.closest('.modal-body[data-inline-rec-id]')) {
return;
}
					// Click inside a subordinate popover the modal
					// might have spawned (FK lookup, picklist, etc.)
					//   keep open. Without this guard, opening a
					// popover would immediately close the editor
					// underneath.
					if (t.closest('.fill-menu-popup, .find-object-popup, .anchored-popup')) {
return;
}
					// Click inside any OTHER modal (e.g. a confirm
					// dialog the editor spawned): keep open. Skips
					// this modal itself because the modal-body guard
					// above already handled it.
					if (t.closest('.modal') && !t.closest('.modal').classList.contains('hidden')) {
						const closestModal = t.closest('.modal');
						if (closestModal !== modal) {
return;
}
					}
					closeModal();
				};
				setTimeout(() => {
					document.addEventListener('mousedown', _inlineOutsideClickHandler, true);
				}, 0);
				return true;
			}
			// Cy node ref captured at enter time so resize handlers
			// (which fire on the document, not in the enter scope) can
			// reach it to keep boxW/boxH in sync with the body size.
			let _inlineCyNode = null;
			function _syncCyNodeSizeToModal() {
				if (!_inlineCyNode) {
return;
}
				const body = modal.querySelector('.modal-body');
				if (!body) {
return;
}
				const w = body.offsetWidth;
				const h = body.offsetHeight;
				if (!w || !h) {
return;
}
				if (_inlineCyNode.data('boxW') !== w) {
_inlineCyNode.data('boxW', w);
}
				if (_inlineCyNode.data('boxH') !== h) {
_inlineCyNode.data('boxH', h);
}
			}
			function _inlinePinToNode(cy, cyNode, container) {
				if (!modal.classList.contains('is-inline')) {
return;
}
				const rp = cyNode.renderedPosition();
				const rect = container.getBoundingClientRect();
				let left = rect.left + rp.x;
				let top = rect.top + rp.y;
				// Clamp so the modal body fits inside the viewport. The
				// body's transform of translate(-50%, -50%) means its
				// CENTER is at (--inline-left, --inline-top), so the
				// edges are at center ± halfDim. Read the body's actual
				// rendered size so a user-resized card stays clamped.
				const body = modal.querySelector('.modal-body');
				const bodyW = body ? body.offsetWidth : 460;
				const bodyH = body ? body.offsetHeight : 600;
				const vpW = window.innerWidth;
				const vpH = window.innerHeight;
				const margin = 8;
				const halfW = bodyW / 2;
				const halfH = bodyH / 2;
				if (left - halfW < margin) {
left = margin + halfW;
}
				if (left + halfW > vpW - margin) {
left = vpW - margin - halfW;
}
				if (top - halfH < margin) {
top = margin + halfH;
}
				if (top + halfH > vpH - margin) {
top = vpH - margin - halfH;
}
				modal.style.setProperty('--inline-left', left + 'px');
				modal.style.setProperty('--inline-top', top + 'px');
			}
			function _attachInlineDrag(header, cy, cyNode, container) {
				let dragging = false;
				let startClientX = 0;
				let startClientY = 0;
				let startNodeX = 0;
				let startNodeY = 0;
				const onDown = (ev) => {
					// Ignore clicks on the close button; it's inside the
					// header. Anywhere else in the header initiates drag.
					if (ev.target && ev.target.closest && ev.target.closest('[data-close]')) {
return;
}
					dragging = true;
					startClientX = ev.clientX;
					startClientY = ev.clientY;
					const pos = cyNode.position();
					startNodeX = pos.x;
					startNodeY = pos.y;
					modal.classList.add('is-dragging');
					document.addEventListener('mousemove', onMove);
					document.addEventListener('mouseup', onUp);
					ev.preventDefault();
				};
				const onMove = (ev) => {
					if (!dragging) {
return;
}
					// Screen-pixel delta → model-unit delta (scale by zoom).
					const zoom = cy.zoom() || 1;
					const dx = (ev.clientX - startClientX) / zoom;
					const dy = (ev.clientY - startClientY) / zoom;
					cyNode.position({ x: startNodeX + dx, y: startNodeY + dy });
					// canvasState.bulkRecords.x/y is the persisted position:
					// update so the new spot survives renders + saves.
					const rec = canvasState.bulkRecords.find((r) => r.id === _inlineRecId);
					if (rec) {
						rec.x = startNodeX + dx;
						rec.y = startNodeY + dy;
					}
				};
				const onUp = () => {
					dragging = false;
					modal.classList.remove('is-dragging');
					document.removeEventListener('mousemove', onMove);
					document.removeEventListener('mouseup', onUp);
				};
				header.addEventListener('mousedown', onDown);
				// Stash on the header so teardown can remove it.
				header._inlineDragOnDown = onDown;
			}
			function _exitInlineMode() {
				if (!modal.classList.contains('is-inline')) {
return;
}
				modal.classList.remove('is-inline');
				modal.classList.remove('is-dragging');
				modal.style.removeProperty('--inline-left');
				modal.style.removeProperty('--inline-top');
				modal.style.removeProperty('--inline-width');
				modal.style.removeProperty('--inline-height');
				if (_inlineRenderHandler && _getCyInstance) {
					const cy = _getCyInstance();
					try {
 if (cy) {
cy.off('render position', _inlineRenderHandler);
} 
} catch (_) {}
					_inlineRenderHandler = null;
				}
				if (_inlineSelectObserver) {
					try {
 _inlineSelectObserver.disconnect(); 
} catch (_) {}
					_inlineSelectObserver = null;
				}
				modal.classList.remove('is-selected');
				const header = modal.querySelector('.modal-header');
				if (header && header._inlineDragOnDown) {
					header.removeEventListener('mousedown', header._inlineDragOnDown);
					header._inlineDragOnDown = null;
				}
				if (_inlineOutsideClickHandler) {
					document.removeEventListener('mousedown', _inlineOutsideClickHandler, true);
					_inlineOutsideClickHandler = null;
				}
				const _body2 = modal.querySelector('.modal-body');
				if (_body2) {
_body2.removeAttribute('data-inline-rec-id');
}
				modal.classList.remove('is-edge-link');
				// Release the lock AND immediately reset the cy node's
				// box to the card's actual size, so FK edges (+ their
				// crow-foot markers) snap back to the card's perimeter
				// in the same frame the modal closes; otherwise the
				// box stays at modal dimensions until the next
				// renderBulkView pass and the edges visibly disconnect
				// from the shrunk card. The records-canvas sync loop
				// runs in renderBulkCanvasCy (driven by canvasState
				// changes), not on every cy render, so we can't rely
				// on it to fire here.
				if (_inlineCyNode && _inlineRecId != null) {
					_inlineCyNode.removeData('_inlineLocked');
					const card = document.querySelector(
						'.cy-card-shell .record-card[data-rec-id="' + _inlineRecId + '"]'
					);
					if (card) {
						const w = card.offsetWidth;
						const h = card.offsetHeight;
						if (w && h) {
							_inlineCyNode.data('boxW', w);
							_inlineCyNode.data('boxH', h);
						}
					}
				}
				_inlineCyNode = null;
				_inlineRecId = null;
			}
			
			// Float-toast inside the modal, anchored just above the
			// footer so it's visible no matter where the user has
			// scrolled inside #modal-content. Auto-dismisses after a
			// few seconds. Used by Save Draft for "Saved N fields" and
			// "No changes" confirmations; replaces the in-form banner
			// that scrolled away with the form body.
			let _modalToastTimer = null;
			function showModalToast(message, variant) {
				const toastEl = modal.querySelector('#modal-toast');
				if (!toastEl) {
return;
}
				if (_modalToastTimer) {
					clearTimeout(_modalToastTimer);
					_modalToastTimer = null;
				}
				toastEl.className = 'modal-toast' + (variant ? ' ' + variant : '');
				toastEl.textContent = message;
				toastEl.hidden = false;
				// Force reflow before adding the visible class so the
				// CSS transition runs from the initial hidden state.
				void toastEl.offsetWidth;
				toastEl.classList.add('is-visible');
				_modalToastTimer = setTimeout(() => {
					toastEl.classList.remove('is-visible');
					setTimeout(() => {
						if (!toastEl.classList.contains('is-visible')) {
toastEl.hidden = true;
}
					}, 280);
				}, 2800);
			}
			
			let currentObject = null;
			let currentFields = [];
			let currentRules = [];
			let rulesUnavailable = null;
			// canvasState.currentRecordRef moved to canvasState. When set, the modal reads/writes to this specific record instance.
			let currentRecordTypes = []; // [{ id, name, label, isDefault }] for the open object
			let currentRecordTypeId = null; // selected record type id; filters picklist values
			let currentLayout = null; // { sections: [...], available: bool } from /api/objects/:name/layout
			const layoutCache = {}; // keyed by `${objectName}|${recordTypeId || ''}|${recordId || 'new'}`
			// Tracks (objectName, recordTypeId, recordId) keys for which a
			// background prefetch has already been kicked off this session.
			// Lets renderBulkCanvas safely call _prefetchLayoutForRecord
			// inside its per-record loop without spamming the server during
			// drag-induced re-renders.
			const _prefetchedLayoutKeys = new Set();
			function _layoutCacheKey(objectName, recordTypeId, recordId) {
				return objectName + '|' + (recordTypeId || '') + '|' + (recordId || 'new');
			}
			function _prefetchLayoutForRecord(rec) {
				if (!rec || !rec.objectName || rec.isTypeNode) {
return;
}
				const rt = (rec.values && rec.values.RecordTypeId) || null;
				const recId = rec.loadedFromId || null;
				const key = _layoutCacheKey(rec.objectName, rt, recId);
				if (_prefetchedLayoutKeys.has(key)) {
return;
}
				_prefetchedLayoutKeys.add(key);
				fetchEditLayout(rec.objectName, rt, recId).catch(() => {});
			}
			async function fetchEditLayout(objectName, recordTypeId, recordId) {
				const key = _layoutCacheKey(objectName, recordTypeId, recordId);
				if (layoutCache[key]) {
return layoutCache[key];
}
				const params = new URLSearchParams();
				if (recordTypeId) {
params.set('recordTypeId', recordTypeId);
}
				if (recordId) {
params.set('recordId', recordId);
}
				const url = '/api/objects/' + encodeURIComponent(objectName) + '/layout' + (params.toString() ? '?' + params.toString() : '');
				try {
					const r = await csrfFetch(url, { credentials: 'same-origin' });
					if (!r.ok) {
						layoutCache[key] = { sections: [], available: false };
						return layoutCache[key];
					}
					const data = await r.json();
					layoutCache[key] = data && data.sections ? data : { sections: [], available: false };
					return layoutCache[key];
				} catch (e) {
					layoutCache[key] = { sections: [], available: false };
					return layoutCache[key];
				}
			}
			// Snapshot of form values captured right before a re-render. Dependent
			// picklists look up their controller's value here rather than from the
			// DOM to avoid races between the change event and the innerHTML swap.
			let currentFormValues = {};
			// Sticky collapse state for field sections so the Optional / Rules
			// accordions don't snap back to their defaults on every re-render.
			const sectionCollapsed = { optional: true, rules: true };
			// 'new' = create a fresh record; 'existing' = the record is tied
			// to a Salesforce row (loadedFromId set), so saves become updates
			// on upload. Switching modes is no longer in-modal: see the
			// upstream entry points listed in renderForm's banner-block
			// comment.
			let modalEditMode = 'new';
			
			// Drafted records, keyed by object API name. Never sent to Salesforce
			// directly from the modal; saved client-side only.
			// canvasState.savedRecords moved to canvasState.
			
			// Cached describe responses keyed by object API name. Used to resolve
			// cross-object formula references (e.g. Account.Name on a Contact rule)
			// against related objects' saved drafts.
			// canvasState.describeCache moved to canvasState.
			
			// ----- Formula parser / evaluator (client-side, partial) -----
			// Pure parser+evaluator extracted to formula.js (loaded via
			// <script> before app.js, exposes window.OrgLoom.formula).
			// Only parseFormula + evalNode are called from app.js: the
			// other primitives (tokenize, resolveFieldValue, num,
			// looseEq) are used only inside formula.js itself. All
			// rule-fix logic that USES the formula evaluator stays in
			// app.js below because it reads module-level canvas state
			// (canvasState.savedRecords, canvasState.describeCache, canvasState.currentRecordRef,
			// canvasState.bulkRecords, canvasState.bulkAssociations), not a pure concern.
			var _formula = (window.OrgLoom && window.OrgLoom.formula) || null;
			if (!_formula) {
throw new Error('formula.js must load before app.js');
}
			var parseFormula = _formula.parseFormula;
			var evalNode = _formula.evalNode;
			// Best-effort rule-aware pre-fill adjustment. Evaluates each parsed
			// validation rule against `values`; for every firing rule, walks the
			// AST and tries to apply a fix (extend LEN, populate ISBLANK, flip a
			// comparison, etc.). Re-runs up to MAX_ITER times since fixes can
			// cascade. Unhandled formula shapes are left alone.
			function tryFixValidationRules(values, fieldList, rules) {
				if (!Array.isArray(rules) || rules.length === 0) {
return;
}
				const opts = {
					currentFields: fieldList,
					savedRecords: canvasState.savedRecords,
					describeCache: canvasState.describeCache,
					currentRecord: canvasState.currentRecordRef,
					bulkRecords: canvasState.bulkRecords,
					bulkAssociations: canvasState.bulkAssociations,
				};
				const MAX_ITER = 6;
				for (let iter = 0; iter < MAX_ITER; iter++) {
					let changed = false;
					for (const rule of rules) {
						if (!rule._tree) {
continue;
}
						let fires;
						try {
							fires = evalNode(rule._tree, values, opts) === true;
						} catch (e) {
							continue;
						}
						if (!fires) {
continue;
}
						if (tryMakeRuleFalse(rule._tree, values, fieldList)) {
							changed = true;
						}
					}
					if (!changed) {
break;
}
				}
			}
			
			function flipCmpOp(op) {
				switch (op) {
					case '>': return '<';
					case '>=': return '<=';
					case '<': return '>';
					case '<=': return '>=';
					default: return op;
				}
			}
			
			function extendStringTo(s, targetLen, cap) {
				let out = s || '';
				while (out.length < targetLen) {
out += 'x';
}
				if (cap && cap > 0 && out.length > cap) {
out = out.slice(0, cap);
}
				return out;
			}
			
			// Walk the rule tree and try to make it evaluate to FALSE (rule passes).
			function tryMakeRuleFalse(node, values, fieldList) {
				if (!node) {
return false;
}
				if (node.k === 'call' && node.name === 'NOT') {
					return tryMakeRuleTrue(node.args[0], values, fieldList);
				}
				// AND fires when every arg is TRUE: flipping any one arg to FALSE fixes it.
				if (node.k === 'call' && node.name === 'AND') {
					for (const arg of node.args) {
						if (tryMakeRuleFalse(arg, values, fieldList)) {
return true;
}
					}
					return false;
				}
				// OR fires when any arg is TRUE: need to flip each to FALSE.
				if (node.k === 'call' && node.name === 'OR') {
					let any = false;
					for (const arg of node.args) {
						if (tryMakeRuleFalse(arg, values, fieldList)) {
any = true;
}
					}
					return any;
				}
				// ISBLANK(field) fires when field is blank: set a sample value.
				if (node.k === 'call' && (node.name === 'ISBLANK' || node.name === 'ISNULL')) {
					const arg = node.args[0];
					if (arg && arg.k === 'field') {
						const f = fieldList.find(ff => ff.name === arg.name);
						if (f) {
							const sample = sampleValueForField(f, fieldList, values);
							values[arg.name] = (sample != null && sample !== '') ? sample : 'x';
							return true;
						}
					}
				}
				// Comparisons involving a field (possibly wrapped in LEN) vs a literal.
				if (node.k === 'cmp') {
					const fixed = tryFixComparison(node, values, fieldList);
					if (fixed) {
return true;
}
				}
				return false;
			}
			
			// Walk the tree and try to make it TRUE (used for the inside of NOT()).
			function tryMakeRuleTrue(node, values, fieldList) {
				if (!node) {
return false;
}
				// NOT(ISBLANK(f)) fires when f is NOT blank; we need ISBLANK to be TRUE,
				// i.e., clear the field.
				if (node.k === 'call' && (node.name === 'ISBLANK' || node.name === 'ISNULL')) {
					const arg = node.args[0];
					if (arg && arg.k === 'field' && values[arg.name]) {
						delete values[arg.name];
						return true;
					}
				}
				return false;
			}
			
			function tryFixComparison(node, values, fieldList) {
				const { left, right, op } = node;
				const isLen = (n) => n.k === 'call' && n.name === 'LEN' && n.args[0] && n.args[0].k === 'field';
				// LEN(field) op literal
				const lenSide = isLen(left) ? left : (isLen(right) ? right : null);
				const litSide = left.k === 'lit' ? left : (right.k === 'lit' ? right : null);
				if (lenSide && litSide && typeof litSide.v === 'number') {
					const fieldName = lenSide.args[0].name;
					const field = fieldList.find(ff => ff.name === fieldName);
					if (!field) {
return false;
}
					const target = litSide.v;
					const lenOnLeft = lenSide === left;
					const effOp = lenOnLeft ? op : flipCmpOp(op);
					const cur = String(values[fieldName] == null ? '' : values[fieldName]);
					const cap = field.length || 0;
					let next = cur;
					if (effOp === '>' || effOp === '>=') {
						// LEN > N fires: make LEN <= N
						next = cur.slice(0, Math.max(0, effOp === '>' ? target : target - 1));
					} else if (effOp === '<' || effOp === '<=') {
						// LEN < N fires: make LEN >= N
						next = extendStringTo(cur, effOp === '<' ? target : target + 1, cap);
					} else if (effOp === '=' || effOp === '==') {
						next = cur.length === target ? extendStringTo(cur, target + 1, cap) : cur;
					} else if (effOp === '<>' || effOp === '!=') {
						next = extendStringTo(cur.slice(0, target), target, cap);
					}
					if (next !== cur) {
						values[fieldName] = next;
						return true;
					}
					return false;
				}
				// field op literal
				const fieldNode = left.k === 'field' ? left : (right.k === 'field' ? right : null);
				const literalNode = left.k === 'lit' ? left : (right.k === 'lit' ? right : null);
				if (fieldNode && literalNode) {
					const fieldOnLeft = fieldNode === left;
					const effOp = fieldOnLeft ? op : flipCmpOp(op);
					const lv = literalNode.v;
					switch (effOp) {
						case '=': case '==':
							if (typeof lv === 'string') {
values[fieldNode.name] = lv + 'x';
} else if (typeof lv === 'number') {
values[fieldNode.name] = lv + 1;
} else {
return false;
}
							return true;
						case '<>': case '!=':
							values[fieldNode.name] = lv;
							return true;
						case '>':
							values[fieldNode.name] = typeof lv === 'number' ? lv : 0;
							return true;
						case '<':
							values[fieldNode.name] = typeof lv === 'number' ? lv : 0;
							return true;
						case '>=':
							values[fieldNode.name] = typeof lv === 'number' ? lv - 1 : 0;
							return true;
						case '<=':
							values[fieldNode.name] = typeof lv === 'number' ? lv + 1 : 0;
							return true;
					}
				}
				return false;
			}
			
			function tryParseRule(rule) {
				try {
					const tree = parseFormula(rule.formula || 'FALSE');
					return { tree, error: null };
				} catch (e) {
					return { tree: null, error: e.message };
				}
			}
			
			function openInsertModal(objectName, opts) {
				opts = opts || {};
				currentObject = objectName;
				canvasState.currentRecordRef = opts.record || null;
				currentFields = [];
				currentRules = [];
				rulesUnavailable = null;
				currentFormValues = {};
				sectionCollapsed.optional = true;
				sectionCollapsed.rules = true;
				// If the bulk record already points at an existing Salesforce row,
				// default to the existing-record edit mode.
				modalEditMode = (canvasState.currentRecordRef && canvasState.currentRecordRef.loadedFromId) ? 'existing' : 'new';
				// Auto-collapse any in-flight inline mode from a prior open
				//   single-instance, the new card replaces the old one.
				_exitInlineMode();
				modal.classList.remove('hidden');
				// Phase 2 collab: broadcast intent so peers see "User X
				// is viewing this record" on their canvas. Only fires
				// when we have a loaded SF record (loadedFromId set):
				// drafts have no SF id to share, and pushing a draft id
				// to peers would just produce a "no access" indicator
				// since their browser can't fetch from a tempId. The
				// focus is cleared in closeModal so it auto-tears down
				// on dismiss/save.
				if (canvasState.currentRecordRef && canvasState.currentRecordRef.loadedFromId) {
					try {
						pushPresenceFocus({
							kind: 'record',
							ref: canvasState.currentRecordRef.loadedFromId,
							objectName: canvasState.currentRecordRef.objectName,
						});
					} catch (_) { /* presence is best-effort */ }
				}
				// Try to enter the in-canvas expanded-card mode. Only
				// fires when (a) we have a record (vs. a fresh insert)
				// AND (b) the matching cy node exists. Fresh inserts
				// from the AI-proposal / related-records / FK-lookup
				// flows have no cy node yet; they fall through to
				// the original centered-overlay behavior.
				if (opts.record) {
_enterInlineMode(opts.record);
}
				modal.querySelector('#modal-title').textContent = 'Loading ' + objectName + '…';
				modal.querySelector('#modal-submit').disabled = true;
				modal.querySelector('#modal-content').innerHTML = '<p class="center">Loading fields…</p>';
				// Surface the right mark-for-delete state from frame 1:
				// describe load can take a few hundred ms and we don't
				// want the stale label from the previous open visible
				// during that window.
				_updateMarkDeleteButton();
			
				const encoded = encodeURIComponent(objectName);
				// Funnel through ensureDescribe so we hit memory cache,
				// then sessionStorage, before going to the network. Same
				// for the rules cache.
				const describePromise = ensureDescribe(objectName);
				const rulesPromise = csrfFetch('/api/objects/' + encoded + '/validation-rules')
					.then(r => r.ok ? r.json() : []);
			
				Promise.all([describePromise, rulesPromise])
					.then(([describe, rules]) => {
						currentFields = describe.fields;
						currentRecordTypes = describe.recordTypes || [];
						// Pick the current record type: draft value wins, else describe default,
						// else the first available.
						const draftRt = canvasState.currentRecordRef && canvasState.currentRecordRef.values && canvasState.currentRecordRef.values.RecordTypeId;
						const savedRt = !canvasState.currentRecordRef && canvasState.savedRecords[currentObject] && canvasState.savedRecords[currentObject].RecordTypeId;
						currentRecordTypeId = draftRt || savedRt
							|| describe.defaultRecordTypeId
							|| (currentRecordTypes[0] && currentRecordTypes[0].id)
							|| null;
						if (rules && rules.unavailable) {
							currentRules = [];
							rulesUnavailable = rules.reason;
						} else {
							currentRules = (Array.isArray(rules) ? rules : []).map(r => {
								const parsed = tryParseRule(r);
								return Object.assign({}, r, { _tree: parsed.tree, _parseError: parsed.error });
							});
							rulesUnavailable = null;
						}
						// Lead with the record's resolved name when one
						// is available: just "General Motors" reads
						// cleaner than "Edit General Motors". Drops
						// the "Edit" verb entirely; the modal context
						// already implies it. Falls back to the
						// object label + ordinal for fresh drafts and
						// to "New <ObjectLabel>" when there's no
						// record at all.
						const _resolveTitle = () => {
							if (!canvasState.currentRecordRef || !canvasState.currentRecordRef.values) {
return null;
}
							const v = canvasState.currentRecordRef.values;
							if (v.FirstName != null || v.LastName != null) {
								const composed = ((v.FirstName || '') + ' ' + (v.LastName || '')).trim();
								if (composed) {
return composed;
}
							}
							const fields = (describe && Array.isArray(describe.fields)) ? describe.fields : [];
							const nf = fields.find((f) => f.nameField);
							if (nf && v[nf.name]) {
return String(v[nf.name]);
}
							// Generic fallback chain for objects whose
							// describe doesn't flag a nameField
							// reliably (jsforce sometimes drops the
							// flag on auto-number fields). CaseNumber
							// covers Case, OrderNumber covers Order,
							// WorkOrderNumber covers WorkOrder. Subject
							// covers Task / Event / EmailMessage.
							return v.Name || v.CaseNumber || v.OrderNumber || v.WorkOrderNumber || v.Subject || v.Title || null;
						};
						let titlePrefix;
						let subtitleText;
						if (canvasState.currentRecordRef) {
							const resolvedName = _resolveTitle();
							titlePrefix = resolvedName || (describe.label + ' #' + recordOrdinal(canvasState.currentRecordRef));
							// Subtitle: "<ObjectLabel> · <state>".
							// State reads "existing" / "modified" /
							// "draft", same vocabulary as the record-
							// card badge so the modal context matches
							// what the user clicked.
							const isExisting = !!canvasState.currentRecordRef.loadedFromId;
							const isModified = isExisting && (typeof isRecordModified === 'function') && isRecordModified(canvasState.currentRecordRef);
							const state = isModified ? 'modified' : (isExisting ? 'existing' : 'draft');
							subtitleText = describe.label + ' \u00b7 ' + state;
						} else {
							titlePrefix = 'New ' + describe.label;
							subtitleText = describe.label + ' \u00b7 draft';
						}
						modal.querySelector('#modal-title').textContent = titlePrefix;
						const subtitleEl = modal.querySelector('#modal-subtitle');
						if (subtitleEl) {
subtitleEl.textContent = subtitleText;
}
						_updateMarkDeleteButton();
						// Fetch the user's effective Lightning page layout for
						// this object + record type. The form renders fields
						// in section order if the layout's available; falls
						// back to the flat required/optional layout otherwise.
						const recId = canvasState.currentRecordRef && canvasState.currentRecordRef.loadedFromId;
						return fetchEditLayout(currentObject, currentRecordTypeId, recId)
							.then((layout) => {
								currentLayout = layout;
								// Override picklist values from describe with
								// the UI API's record-type-filtered set when
								// available. Lightning shows the filtered set,
								// so this matches the user's expectation of
								// "what values can I pick here". Falls through
								// to describe values for fields the UI API
								// didn't return (rare but possible).
								if (layout && layout.picklistValues && currentFields) {
									currentFields.forEach((f) => {
										const pl = layout.picklistValues[f.name];
										if (pl && Array.isArray(pl.values) && pl.values.length > 0) {
											f.picklistValues = pl.values.map((v) => ({
												value: v.value,
												label: v.label,
												active: true,
												defaultValue: pl.defaultValue === v.value,
												validFor: v.validFor || null,
											}));
										}
									});
								}
							})
							.catch(() => {
 currentLayout = null; 
})
							.then(() => {
								renderForm();
								wireLiveValidation();
								const submitBtn = modal.querySelector('#modal-submit');
								submitBtn.disabled = false;
								if (getCanvasShareRole() === 'viewer') {
									// View-only share: no staging, no save. The
									// fields are all read-only and the slot-fill
									// route would 403 a viewer write anyway.
									submitBtn.disabled = true;
									submitBtn.title = 'View only: you can’t make changes to this canvas.';
								} else if (canvasState.currentRecordRef && canvasState.currentRecordRef._recipientSlot
									&& _slotAssignmentState(canvasState.currentRecordRef) === 'other') {
									submitBtn.disabled = true;
									submitBtn.title = 'Reserved for the assigned teammate; read-only for you.';
								}
								// Pre-fill: prefer the record-instance draft,
								// else the object-type draft, else the UI API's
								// record-type defaults (what Salesforce's "New"
								// button would auto-populate). Layout defaults
								// only apply when the record has no values yet
								//   never overwrites the user's input.
								let initialValues = canvasState.currentRecordRef
									? canvasState.currentRecordRef.values
									: canvasState.savedRecords[currentObject];
								const hasExplicit = initialValues && Object.keys(initialValues).length > 0;
								if (!hasExplicit && currentLayout && currentLayout.defaults && Object.keys(currentLayout.defaults).length > 0) {
									initialValues = Object.assign({}, currentLayout.defaults);
									// Defaults are modal-local until Save. Persisting here made
									// open + Cancel mutate a blank draft (OwnerId,
									// CurrencyIsoCode, etc.) without user consent.
								}
								if (initialValues && Object.keys(initialValues).length > 0) {
									populateForm(initialValues);
									// If the form has dependent picklists, the first render used
									// default controller values; re-render now that the real
									// controller values are in place so dependents filter right.
									const hasDependents = currentFields.some(f => f.controllerName);
									if (hasDependents) {
rerenderFormPreservingValues();
}
									evaluateAllRules();
								}
							});
					})
					.catch(err => {
						modal.querySelector('#modal-content').innerHTML =
							'<div class="banner error">Failed to load fields: ' + escapeHtml(err.message) + '</div>';
					});
			}
			
			function closeModal() {
				// Tear down the inline-mode pin/drag bindings before
				// hiding so the cy render listener doesn't fire against
				// a closed card. Safe to call when not in inline mode:
				// the helper short-circuits.
				_exitInlineMode();
				modal.classList.add('hidden');
				currentObject = null;
				currentFields = [];
				canvasState.currentRecordRef = null;
				currentRecordTypes = [];
				currentRecordTypeId = null;
				// Phase 2 collab: clear our focus so peers stop
				// rendering a "viewing" indicator on this record.
				try {
 pushPresenceFocus(null); 
} catch (_) { /* best-effort */ }
			}
			
			function renderForm(banner) {
				const byLabel = (a, b) => a.label.localeCompare(b.label);
				const isCompound = (f) => f && (f.type === 'address' || f.type === 'location');
				const isWritable = (f) => modalEditMode === 'new' ? !!f.createable : !!f.updateable;
				// Compact-mode SOQL imports stash the loaded field names
				// on the record. When set, the edit modal restricts
				// rendering to only those fields; otherwise the user
				// sees a wall of empty inputs for fields they didn't
				// query, all of which would no-op on save anyway because
				// only fields in `values` end up in the UPDATE payload.
				// The full-modal escape hatch is to re-import the record
				// with Load-all-fields checked.
				const partialFieldSet = (canvasState.currentRecordRef && Array.isArray(canvasState.currentRecordRef._loadedFieldNames))
					? new Set(canvasState.currentRecordRef._loadedFieldNames)
					: null;
				const isPartialLoad = !!partialFieldSet;
				const inPartial = (name) => !partialFieldSet || partialFieldSet.has(name);
				// Mirror Lightning's behavior for State/Country picklists:
				// when the org has them enabled, the legacy text fields
				// (BillingCountry, BillingState, ShippingCountry, ...) get
				// a *Code picklist sibling (BillingCountryCode, …) that
				// Lightning surfaces under the user-facing label. The text
				// versions are kept around for API/integration use only
				// and never shown on standard layouts. Hiding them here
				// also matches what auto-fill already does (it skips them
				// for the same reason: Salesforce auto-syncs text from
				// the code on save).
				const isStateCountryTextLegacy = (f) => {
					if (!f || f.type !== 'string') {
return false;
}
					return currentFields.some(cf => cf.name === f.name + 'Code' && isPicklistLikeField(cf));
				};
				// `regular` is the writable, non-compound, non-RecordTypeId field
				// pool used by the fallback Required/Optional layout AND by the
				// "Additional fields" section in the layout-driven path. The
				// layout path also reaches non-writable fields via fieldByName
				// to render them as disabled inputs (preserving the Lightning
				// look while preventing edits).
				const regular = currentFields.filter(f =>
					f.name !== 'RecordTypeId' && !isCompound(f) && !isStateCountryTextLegacy(f) && isWritable(f)
					&& inPartial(f.name)
				);
				const required = regular.filter(f => f.required).sort(byLabel);
				const optional = regular.filter(f => !f.required).sort(byLabel);
			
				// Field-level slot rendering. Two distinct concepts here:
				//   • slotFieldNames: the set of field names the author
				//     marked as slots. Always rendered with the "is-slot-
				//     field" class so BOTH owner and recipient see which
				//     fields are flagged. Authors need this so they can
				//     spot what they marked; recipients need it as the
				//     "fill these" cue.
				//   • slotLockNonSlot: whether to FORCE non-slot fields
				//     to read-only. Only true for non-owners (the
				//     `_recipientSlot` flag set during canvas-load
				//     deserialization). Authors keep full edit access on
				//     every field even when slots are marked, because
				//     slot markers are sharing metadata, not a self-
				//     imposed lock.
				const slotFieldNames = (() => {
					const rec = canvasState.currentRecordRef;
					if (!rec || !rec.slot) {
return null;
}
					const kind = rec.slot.kind || 'whole-record';
					if (kind !== 'fields') {
return null;
}
					return new Set(Array.isArray(rec.slot.fields) ? rec.slot.fields : []);
				})();
				const slotLockNonSlot = !!(slotFieldNames && canvasState.currentRecordRef && canvasState.currentRecordRef._recipientSlot);
				// How many marked slot fields can't actually be filled by
				// this viewer? A slot field is fillable only if it survived
				// the describe (field-level security READ) AND is writable
				// (FLS edit / not system-managed). FLS-hidden fields are
				// dropped from `currentFields` entirely; read-only fields
				// appear but aren't editable. Either way the recipient
				// can't fill them, so the banner needs to call this out:
				// otherwise "update the highlighted field" points at a
				// field that isn't even rendered.
				const slotFieldsInaccessible = (() => {
					if (!slotFieldNames || slotFieldNames.size === 0) {
return 0;
}
					const writableNames = new Set(currentFields.filter(isWritable).map((f) => f.name));
					let n = 0;
					for (const nm of slotFieldNames) {
 if (!writableNames.has(nm)) {
n++;
} 
}
					return n;
				})();
				// Stronger lock: recipient opened a slot assigned to a
				// different SF user. Everything is read-only (including
				// fields the author marked as slot fields), and the
				// banner explains who owns the fill. Owners viewing
				// their own canvas don't trip this; _slotAssignmentState
				// only returns 'other' when an explicit assigneeSfUserId
				// doesn't match window.SF_USER_ID. Owners without a SF
				// session simply never hit it.
				const slotAssignedToOther = !!(canvasState.currentRecordRef && canvasState.currentRecordRef._recipientSlot
					&& _slotAssignmentState(canvasState.currentRecordRef) === 'other');
				// Viewer-role recipients see the WHOLE record read-only:
				// same posture as a slot reserved for someone else, but
				// applied to the entire canvas. `forceReadOnly` folds both
				// cases so the per-field readOnly computations below stay
				// readable. The server's slot-fill route also rejects
				// viewer writes; this is the UI half of that contract.
				const viewerReadOnly = getCanvasShareRole() === 'viewer';
				const forceReadOnly = slotAssignedToOther || viewerReadOnly;
			
				let html = banner ? banner : '';
				// Partial-load notice for compact-mode SOQL imports. Sits
				// above any slot banner so it's the first thing the user
				// reads when the modal opens for a partial record.
				// Doesn't show for full-fields records; `partialFieldSet`
				// only exists when the SOQL importer flagged the record.
				if (isPartialLoad) {
					const n = partialFieldSet.size;
					html += '<div class="banner info" style="margin-bottom:0.7em">' +
						'<strong>Showing ' + n + ' loaded field' + (n === 1 ? '' : 's') + '.</strong> ' +
						'This record was imported via SOQL with a focused SELECT: fields you didn\'t query aren\'t shown here. ' +
						'They\'re preserved on Salesforce; an Update only sends the fields below. ' +
						'To edit other fields, re-import via SOQL with <strong>Load all fields</strong> checked.' +
						'</div>';
				}
				// Slot-progress chip rendered in both banner variants so the
				// recipient (and author previewing) sees N/M filled inline.
				const _bannerProgressChip = (() => {
					if (!slotFieldNames || slotFieldNames.size === 0) {
return '';
}
					const sp = _slotProgress(canvasState.currentRecordRef);
					if (!sp) {
return '';
}
					return ' <span class="slot-progress ' + _slotProgressClass(sp) + '">' +
						sp.filled + '/' + sp.total + '</span>';
				})();
				// Last-modified line for filled field-level slots; only
				// renders when the record is bound to a real SF id and we
				// have a LastModifiedDate. User name is resolved async
				// after the modal mounts (see post-render hook below).
				const _bannerLastModifiedHtml = (() => {
					if (!slotFieldNames || slotFieldNames.size === 0) {
return '';
}
					if (!canvasState.currentRecordRef || !canvasState.currentRecordRef.loadedFromId) {
return '';
}
					const v = canvasState.currentRecordRef.values || {};
					const when = v.LastModifiedDate;
					if (!when) {
return '';
}
					const rel = _formatRelativeTime(when);
					const abs = new Date(when).toLocaleString();
					const userId = v.LastModifiedById || '';
					const userAttr = userId ? ' data-slot-lastmod-userid="' + escapeHtml(userId) + '"' : '';
					return '<div class="slot-lastmod"' + userAttr + ' title="' + escapeHtml(abs) + '">' +
						'Last modified <span>' + escapeHtml(rel) + '</span>' +
						(userId ? ' by <span data-user-placeholder>…</span>' : '') +
					'</div>';
				})();
				if (slotAssignedToOther) {
					const who = (canvasState.currentRecordRef.slot && (canvasState.currentRecordRef.slot.assigneeName || canvasState.currentRecordRef.slot.assigneeEmail)) || 'another teammate';
					html += '<div class="banner info slot-banner">' +
						'<strong>Reserved for ' + escapeHtml(who) + '.</strong>' + _bannerProgressChip + ' ' +
						'Only the assigned teammate can fill this slot; everything is read-only for you.' +
						_bannerLastModifiedHtml +
					'</div>';
				} else if (viewerReadOnly && slotFieldNames && slotFieldNames.size > 0) {
					// Viewer on a record with marked slots: explain why the
					// highlighted fields aren't fillable rather than showing
					// the contributor's "update the highlighted fields" CTA.
					html += '<div class="banner info slot-banner">' +
						'<strong>View only.</strong>' + _bannerProgressChip + ' ' +
						'These fields were marked as slots, but this canvas was shared with you as view-only; they’re read-only for you.' +
						_bannerLastModifiedHtml +
					'</div>';
				} else if (slotLockNonSlot) {
					const count = slotFieldNames.size;
					const inaccessible = slotFieldsInaccessible;
					const fillable = count - inaccessible;
					const sp = _slotProgress(canvasState.currentRecordRef) || { filled: 0, total: count };
					// Sentence describing the inaccessible slot fields, if any.
					const hiddenNote = inaccessible > 0
						? ' <strong>' + inaccessible + ' slot field' + (inaccessible === 1 ? '' : 's') +
							' ' + (inaccessible === 1 ? 'isn’t' : 'aren’t') + ' shown</strong>: ' +
							(inaccessible === 1 ? "it's" : "they're") +
							' hidden by field-level security or read-only for your Salesforce user, so ' +
							(inaccessible === 1 ? "it can't" : "they can't") + ' be filled here.'
						: '';
					if (fillable <= 0) {
						// Every slot field is hidden/read-only for this
						// recipient; there is nothing to fill. Say so plainly
						// (warn tone) instead of "update the highlighted field"
						// when no such field is rendered.
						html += '<div class="banner warn slot-banner">' +
							'<strong>' + (count === 1 ? 'The field marked for you isn’t' : 'None of the ' + count + ' fields marked for you are') +
							' available to your Salesforce user.</strong>' + _bannerProgressChip + ' ' +
							(count === 1 ? "It's" : "They're") + ' hidden by field-level security or read-only for you, so this slot can’t be filled. ' +
							'Ask the sender or your Salesforce admin for access.' +
							_bannerLastModifiedHtml +
						'</div>';
					} else {
						const lead = sp.filled === sp.total
							? 'All ' + sp.total + ' slot field' + (sp.total === 1 ? '' : 's') + ' filled.'
							: sp.filled + ' of ' + sp.total + ' slot field' + (sp.total === 1 ? '' : 's') + ' filled.';
						html += '<div class="banner ' + (inaccessible > 0 ? 'warn' : 'info') + ' slot-banner">' +
							'<strong>' + lead + '</strong>' + _bannerProgressChip + ' ' +
							'Update the highlighted field' + (fillable === 1 ? '' : 's') + '; the rest of the record is read-only.' +
							hiddenNote +
							_bannerLastModifiedHtml +
						'</div>';
					}
				} else if (slotFieldNames && slotFieldNames.size > 0) {
					// Author view: confirm what's marked, no lock copy.
					const count = slotFieldNames.size;
					html += '<div class="banner info slot-banner">' +
						'<strong>' + count + ' field' + (count === 1 ? '' : 's') + ' marked as slot' + (count === 1 ? '' : 's') + '.</strong>' + _bannerProgressChip + ' ' +
						'Recipients of this canvas will only be able to update ' +
						(count === 1 ? 'that field' : 'those fields') + '.' +
						_bannerLastModifiedHtml +
					'</div>';
				}
				html += '<form id="insert-form">';
			
				// Loaded-existing banner: surfaces the SF id link + Unlink CTA
				// when the record is currently tied to a Salesforce record.
				// Switching modes is no longer in-modal; entry points for
				// creating drafts vs loading existing live upstream (pending
				// placeholder, SOQL import, related-chip, etc.). To break
				// the SF link from this modal, click Unlink.
				const loadedId = canvasState.currentRecordRef && canvasState.currentRecordRef.loadedFromId;
				if (modalEditMode === 'existing' && loadedId) {
					const sfBase = (window.SF_INSTANCE_URL || '').replace(/\/+$/, '');
					const recordUrl = sfBase
						? sfBase + '/lightning/r/' + encodeURIComponent(currentObject) + '/' + encodeURIComponent(loadedId) + '/view'
						: null;
					const idHtml = recordUrl
						? '<a href="' + escapeHtml(recordUrl) + '" target="_blank" rel="noopener"><code>' + escapeHtml(loadedId) + '</code></a>'
						: '<code>' + escapeHtml(loadedId) + '</code>';
					html += '<div class="edit-mode-existing-banner">' +
						'<span>Editing existing record ' + idHtml + ': Upload will update it in Salesforce.</span>' +
						'<button type="button" class="link-button" data-unlink-existing>Unlink</button>' +
					'</div>';
				}
			
				// Record Type selector (only when the object has more than one).
				if (currentRecordTypes.length > 1) {
					html += '<div class="field-section">' +
						'<div class="field-section-header">Record Type</div>' +
						'<div class="fields">' +
							'<div class="field" data-field="RecordTypeId" data-type="recordtype">' +
								'<label for="f_RecordTypeId">Record Type <span class="meta">picklist filtering</span></label>' +
								'<select id="f_RecordTypeId" name="RecordTypeId" data-record-type-select>' +
									currentRecordTypes.map(rt =>
										'<option value="' + escapeHtml(rt.id) + '"' + (rt.id === currentRecordTypeId ? ' selected' : '') + '>' +
											escapeHtml(rt.label || rt.name) +
										'</option>'
									).join('') +
								'</select>' +
								'<div class="help">Switching record type updates the available picklist values.</div>' +
							'</div>' +
						'</div>' +
					'</div>';
				}
			
				// Layout-driven path: when the Salesforce UI API returned a
				// page layout for this user/record type, render fields in
				// section + row order (mirrors the Lightning UI). Anything
				// not on the layout falls into a collapsed "Additional"
				// section so we don't lose access to API-only fields.
				const useLayout = currentLayout && currentLayout.available && Array.isArray(currentLayout.sections) && currentLayout.sections.length > 0;
				if (useLayout) {
					const fieldByName = {};
					currentFields.forEach((f) => {
 fieldByName[f.name] = f; 
});
					const renderedNames = new Set(['RecordTypeId']);
					currentLayout.sections.forEach((section) => {
						const rowsHtml = section.rows.map((row) => {
							const cells = row.map((cell) => {
								const f = fieldByName[cell.apiName];
								if (!f) {
return '';
}
								if (isCompound(f)) {
return '';
}
								if (isStateCountryTextLegacy(f)) {
return '';
}
								// Compact-mode SOQL imports: skip cells
								// for fields not in the loaded set so
								// the layout shows only what the user
								// queried.
								if (!inPartial(cell.apiName)) {
return '';
}
								renderedNames.add(cell.apiName);
								const layoutEditable = modalEditMode === 'new' ? cell.editableForNew : cell.editableForUpdate;
								const isSlotField = !!(slotFieldNames && slotFieldNames.has(cell.apiName));
								// Slot LOCK forces non-slot fields to read-only
								// for the recipient. Owners keep full edit
								// access (slot markers are sharing metadata,
								// not a self-lock) but still see the slot
								// highlights via isSlotField.
								const readOnly = !(layoutEditable && isWritable(f))
									|| forceReadOnly
									|| (slotLockNonSlot && !isSlotField);
								return '<div class="layout-cell">' + renderFieldHtml(f, { readOnly, isSlotField }) + '</div>';
							}).join('');
							if (!cells) {
return '';
}
							return '<div class="layout-row" style="--cols:' + Math.max(1, row.length) + '">' + cells + '</div>';
						}).filter(Boolean).join('');
						if (!rowsHtml) {
return;
}
						html += '<div class="field-section layout-section">' +
							(section.heading ? '<div class="field-section-header">' + escapeHtml(section.heading) + '</div>' : '') +
							'<div class="layout-rows">' + rowsHtml + '</div>' +
						'</div>';
					});
					// Additional fields: writable, non-compound fields not already
					// rendered by the layout. `regular` is already filtered for
					// writability and compound exclusion, so a simple set-diff
					// is enough.
					const remaining = regular.filter((f) => !renderedNames.has(f.name));
					if (remaining.length > 0) {
						const optClass = sectionCollapsed.optional ? ' collapsed' : '';
						html += '<div class="field-section collapsible' + optClass + '" data-section="optional">' +
							'<div class="field-section-header" data-toggle>Additional fields <span class="count">(' + remaining.length + ')</span>' +
								'<span class="chevron">\u25BC</span>' +
							'</div>' +
							'<div class="fields">' +
								remaining.sort(byLabel).map((f) => {
									const isSlotField = !!(slotFieldNames && slotFieldNames.has(f.name));
									const readOnly = forceReadOnly || !!(slotLockNonSlot && !isSlotField);
									return renderFieldHtml(f, { readOnly, isSlotField });
								}).join('') +
							'</div>' +
						'</div>';
					}
				} else {
				html += '<div class="field-section">' +
					'<div class="field-section-header">Required <span class="count">(' + required.length + ')</span></div>' +
					'<div class="fields">' +
						(required.length === 0
							? '<div class="field-section-empty">This object has no required fields: fill in anything below that matters to you.</div>'
							: required.map((f) => {
								const isSlotField = !!(slotFieldNames && slotFieldNames.has(f.name));
								const readOnly = forceReadOnly || !!(slotLockNonSlot && !isSlotField);
								return renderFieldHtml(f, { readOnly, isSlotField });
							}).join('')) +
					'</div>' +
				'</div>';
			
				if (optional.length > 0) {
					const optClass = sectionCollapsed.optional ? ' collapsed' : '';
					html += '<div class="field-section collapsible' + optClass + '" data-section="optional">' +
						'<div class="field-section-header" data-toggle>Optional <span class="count">(' + optional.length + ')</span>' +
							'<span class="chevron">\u25BC</span>' +
						'</div>' +
						'<div class="fields">' +
							optional.map((f) => {
								const isSlotField = !!(slotFieldNames && slotFieldNames.has(f.name));
								const readOnly = forceReadOnly || !!(slotLockNonSlot && !isSlotField);
								return renderFieldHtml(f, { readOnly, isSlotField });
							}).join('') +
						'</div>' +
					'</div>';
				}
				}
			
				// Orphan / carry-over fields. After a cross-org switch,
				// the canvas keeps values for fields that are not available
				// in the running user's new-org describe (for example, a
				// sandbox-only field or one hidden by destination FLS).
				// Uploading them would 4xx; silently
				// stripping would lose data. Surface them in their own
				// section so the user can decide per-field: drop, or copy
				// to a field that DOES exist in this org.
				//
				// System-managed fields (Id, audit timestamps, audit
				// user refs, ownership, record type, merge audit) are
				// filtered out; they ARE on every org's describe, but
				// loadDescribeForObject only returns CREATEABLE fields,
				// and several of these are non-createable system fields
				// that ride along on queried records. A naive
				// currentFields.has(k) check mis-flags them as missing.
				// Surfacing them would be a lie and would invite the
				// user to "copy" or "drop" something they have no
				// power to change anyway.
				const _SYSTEM_FIELDS = new Set([
					'attributes',
					'Id',
					'CreatedDate', 'CreatedById',
					'LastModifiedDate', 'LastModifiedById',
					'SystemModstamp',
					'LastReferencedDate', 'LastViewedDate',
					'IsDeleted',
					'OwnerId',
					'RecordTypeId',
					'MasterRecordId',
				]);
				const _orphanRecord = canvasState.currentRecordRef;
				// Cross-org carry-over gate. The orphan UI exists for
				// the case where a record traveled across orgs (via the
				// org-switch loaded→draft conversion in app.js) and now
				// carries values for fields absent from the running user's
				// target createable-field describe. Outside that case, "field present
				// in values but not in createable describe" is just
				// noise; silent strip on upload (see upload-modal.js)
				// is the right behavior, not a scary warning. Without
				// this gate, the warning fires on any loaded record
				// with non-createable fields and the copy/drop options
				// are meaningless (the user can't fix the underlying
				// shape). _wasLoadedFromOrgId is set ONLY during the
				// cross-org conversion path, so it's the right signal.
				const _isCrossOrgCarryover = !!(_orphanRecord && _orphanRecord._wasLoadedFromOrgId);
				const _canvasMigration = window.Orgloom && window.Orgloom.canvasMigrate;
				const _guidedMigrationActive = !!(
					_canvasMigration && _canvasMigration.isActive && _canvasMigration.isActive() &&
					_canvasMigration.usesGuidedResolution && _canvasMigration.usesGuidedResolution()
				);
				const _orphanValues = (_orphanRecord && _orphanRecord.values) || {};
				const _orphanFieldSet = new Set(currentFields.map((f) => f.name));
				const _orphanNames = (!_isCrossOrgCarryover || _guidedMigrationActive) ? [] : Object.keys(_orphanValues).filter((k) => {
					if (!k || k.startsWith('_')) {
return false;
}
					if (_SYSTEM_FIELDS.has(k)) {
return false;
}
					return !_orphanFieldSet.has(k);
				}).sort();
				if (_orphanNames.length > 0) {
					const _orphanWritableOptions = currentFields
						.filter((f) => isWritable(f) && !isCompound(f))
						.sort(byLabel)
						.map((f) => '<option value="' + escapeHtml(f.name) + '">' +
							escapeHtml(f.label || f.name) +
							' (' + escapeHtml(f.name) + ')</option>')
						.join('');
					html += '<div class="field-section field-section--orphans" data-section="orphans">' +
						'<div class="field-section-header">' +
							'Fields unavailable in destination <span class="count">(' + _orphanNames.length + ')</span>' +
						'</div>' +
						'<div class="orphan-banner banner warn">' +
							'These values traveled with the record when you switched Salesforce orgs. ' +
							'These fields are not available through your current Salesforce connection. ' +
							'They may not exist on <code>' + escapeHtml(currentObject) +
							'</code> in this org, or your Salesforce permissions may hide them. ' +
							'Salesforce cannot accept them through this connection. Ask an admin if you expected access. ' +
							'Otherwise, <strong>drop</strong> values you do not need or <strong>copy</strong> ' +
							'each value to an available destination field.' +
							'<div><button type="button" class="button secondary orphan-refresh" data-orphan-refresh>' +
								'Refresh Salesforce fields</button></div>' +
						'</div>' +
						'<div class="orphan-fields">' +
							_orphanNames.map((name) => {
								const val = _orphanValues[name];
								const valDisplay = (val == null || val === '')
									? '<span class="orphan-empty">(empty)</span>'
									: '<code>' + escapeHtml(formatCarryoverValue(val)) + '</code>';
								return '<div class="orphan-row" data-orphan-field="' + escapeHtml(name) + '">' +
									'<div class="orphan-meta">' +
										'<div class="orphan-name"><code>' + escapeHtml(name) + '</code></div>' +
										'<div class="orphan-value">' + valDisplay + '</div>' +
									'</div>' +
									'<div class="orphan-actions">' +
										'<select class="orphan-target" data-orphan-target="' + escapeHtml(name) + '">' +
											'<option value="">Copy to…</option>' +
											_orphanWritableOptions +
										'</select>' +
										'<button type="button" class="button secondary orphan-copy" data-orphan-copy="' + escapeHtml(name) + '" disabled>Copy</button>' +
										'<button type="button" class="button secondary danger orphan-drop" data-orphan-drop="' + escapeHtml(name) + '">Drop</button>' +
									'</div>' +
								'</div>';
							}).join('') +
						'</div>' +
					'</div>';
				}

				// Cross-org migration reconciliation. Only while migrate mode
				// is active and this record has record-type / picklist issues
				// against the destination org. Lets the user pick a target
				// record type and remap invalid picklist values so the record
				// can be recreated. Overrides ride on the record itself
				// (_migrateRecordTypeId / _migrateClearRecordType /
				// _migratePicklistRemap) so they persist in the migration
				// snapshot; the annotation engine honors them.
				const _migApi = window.Orgloom && window.Orgloom.canvasMigrate;
				const _migRec = canvasState.currentRecordRef;
				if (_migApi && _migApi.isActive() && _migRec && !_guidedMigrationActive) {
					const _ann = _migApi.annotationFor(_migRec.id);
					const _annIssues = (_ann && _ann.issues) || [];
					const _rtIssue = _annIssues.find((i) => i.kind === 'recordtype-unresolved');
					const _plIssues = _annIssues.filter((i) => i.kind === 'picklist-mismatch');
					const _rtResolved = !!(_migRec._migrateRecordTypeId || _migRec._migrateClearRecordType);
					if (_rtIssue || _plIssues.length || _rtResolved) {
						let _migRows = '';
						// Record type: show whenever it was blocked OR the user
						// already resolved it (so they can change their choice).
						if (_rtIssue || _rtResolved) {
							const _rtOpts = (currentRecordTypes || [])
								.map((rt) => '<option value="' + escapeHtml(rt.id) + '"' +
									(_migRec._migrateRecordTypeId === rt.id ? ' selected' : '') +
									'>' + escapeHtml(rt.label || rt.name) + '</option>')
								.join('');
							const _srcDev = (_rtIssue && _rtIssue.developerName) ||
								_migRec._sourceRecordTypeDeveloperName || '';
							_migRows += '<div class="migrate-row">' +
								'<div class="migrate-meta">' +
									'<div class="migrate-label">Record type</div>' +
									'<div class="migrate-sub">Source: <code>' + escapeHtml(_srcDev) + '</code>' +
										(_rtIssue ? ' (not in this org)' : '') + '</div>' +
								'</div>' +
								'<select class="migrate-select" data-migrate-rt-select>' +
									'<option value="">Pick a record type…</option>' +
									_rtOpts +
									'<option value="__clear__"' +
										(_migRec._migrateClearRecordType ? ' selected' : '') +
										'>No record type</option>' +
								'</select>' +
							'</div>';
						}
						// Picklist values: one row per still-invalid source value.
						_plIssues.forEach((iss) => {
							const _tf = (currentFields || []).find(
								(f) => f.name && String(f.name).toLowerCase() === String(iss.field).toLowerCase(),
							);
							const _plOpts = (_tf && Array.isArray(_tf.picklistValues) ? _tf.picklistValues : [])
								.map((v) => '<option value="' + escapeHtml(v.value) + '">' +
									escapeHtml(v.label || v.value) + '</option>')
								.join('');
							(iss.invalidValues || []).forEach((sv) => {
								_migRows += '<div class="migrate-row">' +
									'<div class="migrate-meta">' +
										'<div class="migrate-label">' + escapeHtml(iss.field) + '</div>' +
										'<div class="migrate-sub">Value <code>' + escapeHtml(sv) + '</code> isn’t valid here</div>' +
									'</div>' +
									'<select class="migrate-select" data-migrate-pl-field="' + escapeHtml(iss.field) + '" data-migrate-pl-source="' + escapeHtml(sv) + '">' +
										'<option value="__keep__">Keep as-is (will warn)</option>' +
										_plOpts +
										'<option value="">Drop value</option>' +
									'</select>' +
								'</div>';
							});
						});
						const _migCount = (_rtIssue ? 1 : 0) +
							_plIssues.reduce((n, i) => n + (i.invalidValues ? i.invalidValues.length : 0), 0);
						const _migBannerCls = _migCount > 0 ? 'banner warn' : 'banner';
						const _migBanner = _migCount > 0
							? 'Resolve these so the record can be recreated in the destination org.'
							: 'All migration issues on this record are resolved.';
						html += '<div class="field-section field-section--migrate" data-section="migrate">' +
							'<div class="field-section-header">Migration fixes' +
								(_migCount > 0 ? ' <span class="count">(' + _migCount + ')</span>' : '') +
							'</div>' +
							'<div class="orphan-banner ' + _migBannerCls + '">' + _migBanner + '</div>' +
							'<div class="migrate-fixes">' + _migRows + '</div>' +
						'</div>';
					}
				}

				html += '</form>';

				html += renderRulesSectionHtml();

				modal.querySelector('#modal-content').innerHTML = html;
			
				// Async resolve the LastModifiedBy user name for any slot
				// last-modified indicators in the banner. Synchronous
				// render shows "by …" as a placeholder; this swaps in
				// the real name once the User fetch lands. Cached
				// across re-renders so flips between records don't
				// re-fetch the same user.
				modal.querySelectorAll('[data-slot-lastmod-userid]').forEach((el) => {
					const userId = el.dataset.slotLastmodUserid;
					const placeholder = el.querySelector('[data-user-placeholder]');
					if (!userId || !placeholder) {
return;
}
					_resolveUserName(userId).then((name) => {
						if (!name) {
 placeholder.textContent = 'unknown'; return; 
}
						placeholder.textContent = name;
					});
				});
			
				modal.querySelectorAll('[data-toggle]').forEach(h => {
					h.addEventListener('click', () => {
						const section = h.parentElement;
						section.classList.toggle('collapsed');
						const key = section.dataset.section;
						if (key && key in sectionCollapsed) {
							sectionCollapsed[key] = section.classList.contains('collapsed');
						}
					});
				});
				modal.querySelectorAll('[data-disconnect-assoc]').forEach(btn => {
					btn.addEventListener('click', (e) => {
						e.preventDefault();
						const assocId = parseInt(btn.dataset.disconnectAssoc, 10);
						// deleteAssociation rerenders the bulk canvas; the modal needs
						// its own rerender so the unlocked field becomes editable.
						deleteAssociation(assocId);
						rerenderFormPreservingValues();
					});
				});
				// Wire every lookup picker in the form. Each picker
				// becomes a debounced typeahead over /api/objects/
				// <source>/lookup, with a dropdown of matching SF
				// records. On pick: hidden input gets the SF id,
				// visible UI flips to a "selected pill" with the
				// record's Name + a clear button. See _wireLookupPickers
				// for the per-picker setup.
				modal.querySelectorAll('.lookup-picker').forEach(_wireLookupPicker);
				// Unlink: break the SF tie and flip into draft (new-record)
				// mode so the form's writability switches to createable
				// fields. To load a different SF record, close the modal
				// and use the upstream entry points (pending placeholder,
				// SOQL import, related-chip).
				const unlinkBtn = modal.querySelector('[data-unlink-existing]');
				if (unlinkBtn) {
					unlinkBtn.addEventListener('click', async () => {
						const record = canvasState.currentRecordRef;
						if (!record) {
							return;
						}
						const impact = unlinkRelationshipImpact(canvasState, record);
						let decision = 'keep';
						if (impact.existingIncoming.length > 0) {
							decision = await chooseUnlinkRelationshipBehavior(record, impact);
							if (!decision) {
								return;
							}
						}
						if (record.pendingDelete) {
							unmarkPendingDelete(record.id);
						}
						applyLoadedRecordUnlink(canvasState, record, decision);
						modalEditMode = 'new';
						rerenderFormPreservingValues();
						if (canvasState.graphView === 'bulk') {
renderBulkView();
}
					});
				}
				const rtSelect = modal.querySelector('[data-record-type-select]');
				if (rtSelect) {
					rtSelect.addEventListener('change', () => {
						currentRecordTypeId = rtSelect.value;
						// Refetch layout for the new record type: different
						// record types can have different page layouts.
						const recId = canvasState.currentRecordRef && canvasState.currentRecordRef.loadedFromId;
						fetchEditLayout(currentObject, currentRecordTypeId, recId)
							.then((layout) => {
 currentLayout = layout; 
})
							.catch(() => {
 currentLayout = null; 
})
							.then(() => rerenderFormPreservingValues());
					});
				}
				modal.querySelectorAll('[data-formula-toggle]').forEach(b => {
					b.addEventListener('click', () => {
						const target = document.getElementById(b.dataset.target);
						if (!target) {
return;
}
						const hidden = target.style.display === 'none' || !target.style.display;
						target.style.display = hidden ? 'block' : 'none';
						b.textContent = hidden ? 'Hide formula' : 'Show formula';
					});
				});

				// Orphan-field handlers (carry-over from a previous org).
				// `Drop` removes the value from record.values entirely.
				// `Copy` writes the orphan's value to the selected target
				// field on the same record, then drops the orphan. Both
				// re-render the form so the row disappears and (for copy)
				// the target field's input shows the new value.
				const orphanRefresh = modal.querySelector('[data-orphan-refresh]');
				if (orphanRefresh) {
					orphanRefresh.addEventListener('click', async () => {
						orphanRefresh.disabled = true;
						orphanRefresh.textContent = 'Refreshing...';
						try {
							const refreshedDescribe = await ensureDescribe(currentObject, { force: true });
							currentFields = refreshedDescribe.fields || [];
							currentRecordTypes = refreshedDescribe.recordTypes || [];
							const migrate = window.Orgloom && window.Orgloom.canvasMigrate;
							if (migrate && migrate.recompute) {
								await migrate.recompute();
							}
							rerenderFormPreservingValues();
							if (canvasState.graphView === 'bulk') {
								renderBulkView();
							}
							showBulkToast('Salesforce fields refreshed.');
						} catch (error) {
							orphanRefresh.disabled = false;
							orphanRefresh.textContent = 'Refresh Salesforce fields';
							showBulkToast('Could not refresh Salesforce fields. Check the connection and try again.', 'error');
						}
					});
				}
				modal.querySelectorAll('[data-orphan-target]').forEach((sel) => {
					sel.addEventListener('change', () => {
						const rec = canvasState.currentRecordRef;
						if (!rec) {
return;
}
						const fieldName = sel.getAttribute('data-orphan-target');
						const btn = modal.querySelector('[data-orphan-copy="' + fieldName.replace(/"/g, '') + '"]');
						if (btn) {
btn.disabled = !sel.value;
}
					});
				});
				modal.querySelectorAll('[data-orphan-copy]').forEach((btn) => {
					btn.addEventListener('click', () => {
						const rec = canvasState.currentRecordRef;
						if (!rec || !rec.values) {
return;
}
						const sourceName = btn.getAttribute('data-orphan-copy');
						const sel = modal.querySelector('[data-orphan-target="' + sourceName.replace(/"/g, '') + '"]');
						const targetName = sel ? sel.value : '';
						if (!targetName) {
return;
}
						const rawSourceVal = rec.values[sourceName];
						const sourceVal = rawSourceVal && typeof rawSourceVal === 'object'
							? formatCarryoverValue(rawSourceVal)
							: rawSourceVal;
						rec.values[targetName] = sourceVal;
						delete rec.values[sourceName];
						rerenderFormPreservingValues();
						if (canvasState.graphView === 'bulk') {
renderBulkView();
}
					});
				});
				modal.querySelectorAll('[data-orphan-drop]').forEach((btn) => {
					btn.addEventListener('click', () => {
						const rec = canvasState.currentRecordRef;
						if (!rec || !rec.values) {
return;
}
						const sourceName = btn.getAttribute('data-orphan-drop');
						delete rec.values[sourceName];
						rerenderFormPreservingValues();
						if (canvasState.graphView === 'bulk') {
renderBulkView();
}
					});
				});

				// Migration remap handlers. Set the override on the record,
				// recompute annotations, then re-render the form so the row
				// shows the resolved state.
				function _afterMigrateRemap() {
					const _m = window.Orgloom && window.Orgloom.canvasMigrate;
					if (_m && _m.recompute) {
						_m.recompute();
					}
					rerenderFormPreservingValues();
					if (canvasState.graphView === 'bulk') {
						renderBulkView();
					}
				}
				modal.querySelectorAll('[data-migrate-rt-select]').forEach((sel) => {
					sel.addEventListener('change', () => {
						const rec = canvasState.currentRecordRef;
						if (!rec) {
return;
}
						const v = sel.value;
						if (v === '__clear__') {
							rec._migrateClearRecordType = true;
							delete rec._migrateRecordTypeId;
						} else if (v) {
							rec._migrateRecordTypeId = v;
							delete rec._migrateClearRecordType;
						} else {
							delete rec._migrateRecordTypeId;
							delete rec._migrateClearRecordType;
						}
						_afterMigrateRemap();
					});
				});
				modal.querySelectorAll('[data-migrate-pl-field]').forEach((sel) => {
					sel.addEventListener('change', () => {
						const rec = canvasState.currentRecordRef;
						if (!rec) {
return;
}
						const field = sel.getAttribute('data-migrate-pl-field');
						const source = sel.getAttribute('data-migrate-pl-source');
						const v = sel.value;
						rec._migratePicklistRemap = rec._migratePicklistRemap || {};
						rec._migratePicklistRemap[field] = rec._migratePicklistRemap[field] || {};
						if (v === '__keep__') {
							delete rec._migratePicklistRemap[field][source];
						} else {
							// '' (drop) and a target value are both explicit
							// resolutions.
							rec._migratePicklistRemap[field][source] = v;
						}
						_afterMigrateRemap();
					});
				});
			}
			
			function renderRulesSectionHtml() {
				const count = currentRules.length;
				const collapsedClass = (sectionCollapsed.rules && count > 0) ? ' collapsed' : '';
				let inner;
				if (rulesUnavailable) {
					inner = '<div class="field-section-empty">Couldn\'t load validation rules: ' + escapeHtml(rulesUnavailable) + '</div>';
				} else if (count === 0) {
					inner = '<div class="field-section-empty">No active validation rules for this object.</div>';
				} else {
					// One-line disclaimer establishing the engine's epistemic
					// scope: predictions are best-effort against the supported
					// formula subset, and Salesforce is always the final
					// authority on whether an upload is accepted. Sits ABOVE
					// the rule cards so users see it before reading the
					// individual badges.
					const disclaimer = '<div class="field-section-note">'
						+ 'Predictions are client-side based on the values in this form. '
						+ 'Salesforce checks every rule on upload: that\u2019s the source of truth.'
						+ '</div>';
					inner = disclaimer + currentRules.map(renderRuleHtml).join('');
				}
				return '<div class="field-section collapsible' + collapsedClass + '" data-section="rules">' +
					'<div class="field-section-header" data-toggle>Validation Rules <span class="count">(' + count + ')</span>' +
						'<span class="rules-summary" id="rules-summary-badge" style="display:none"></span>' +
						'<span class="chevron">\u25BC</span>' +
					'</div>' +
					'<div class="fields">' + inner + '</div>' +
				'</div>';
			}
			
			// Initial badge for each rule before evaluateAllRules() runs.
			// Three states:
			//   - "Can't predict" (gray) when the formula didn't parse OR uses
			//     a construct the engine doesn't support ($User, NOW, REGEX,
			//     VLOOKUP, etc.). Tooltip explains why.
			//   - "Pending" (gray) when the formula DID parse; we just
			//     haven't run evaluateAllRules yet on the current values.
			//     Flips to "Likely fail" or "Looks OK" on the first
			//     evaluation pass.
			// "Likely fail" / "Looks OK" never appear at initial render
			// because they require evaluated values to be honest.
			function renderRuleHtml(r, i) {
				const formulaId = 'formula-' + i;
				const description = r.description ? '<div class="rule-description">' + escapeHtml(r.description) + '</div>' : '';
				const errorOn = r.errorDisplayField ? ' <span class="meta">(shown on ' + escapeHtml(r.errorDisplayField) + ')</span>' : '';
				const errorMessage = r.errorMessage
					? '<div class="rule-error-message"><span class="rule-error-label">Error:</span>' + escapeHtml(r.errorMessage) + errorOn + '</div>'
					: '';
				const formula = r.formula
					? '<div class="rule-formula">' +
						'<button type="button" class="rule-formula-toggle" data-formula-toggle data-target="' + formulaId + '">Show formula</button>' +
						'<pre id="' + formulaId + '" style="display:none">' + escapeHtml(r.formula) + '</pre>' +
					'</div>'
					: '';
				const status = r._parseError
					? {
						cls: 'status-unknown',
						label: "Can't predict",
						title: 'Engine couldn\u2019t parse this formula (' + r._parseError + '). Salesforce will still enforce the rule on upload.',
					}
					: {
						cls: 'status-unknown',
						label: 'Pending',
						title: 'Fill in fields to see a prediction.',
					};
				return '<div class="rule ' + status.cls + '" data-rule-index="' + i + '">' +
					'<div class="rule-name">' + escapeHtml(r.name || '(unnamed)') +
						'<span class="rule-status" title="' + escapeHtml(status.title) + '">' + status.label + '</span>' +
					'</div>' +
					errorMessage + description + formula +
				'</div>';
			}
			
			function wireLiveValidation() {
				const form = modal.querySelector('#insert-form');
				if (!form) {
return;
}
				form.addEventListener('input', (e) => {
					// Clear the explicit invalid-ref highlight as soon as the
					// user edits a flagged reference field; feels stuck if it
					// only clears on a fresh save attempt.
					const div = e.target.closest && e.target.closest('.field[data-type="reference"]');
					if (div) {
div.classList.remove('field-invalid-ref');
}
					evaluateAllRules();
				});
				form.addEventListener('change', (e) => {
					evaluateAllRules();
					// Rebuild the form if the changed field might affect a dependent
					// picklist. We trigger on any <select> change when the form has
					// at least one dependent field, since Salesforce's describe
					// doesn't always populate `controllerName` reliably for standard
					// state/country picklists.
					if (e.target.tagName !== 'SELECT') {
return;
}
					const hasDependent = currentFields.some(f => f.controllerName)
						|| currentFields.some(f => f.controllerValuesByRecordType && Object.keys(f.controllerValuesByRecordType).length > 0);
					if (!hasDependent) {
return;
}
					const fieldDiv = e.target.closest('.field');
					const changedName = fieldDiv && fieldDiv.dataset.field;
					// Avoid infinite-loopy rerenders triggered by the RecordType
					// selector: it has its own dedicated handler.
					if (changedName === 'RecordTypeId') {
return;
}
					rerenderFormPreservingValues();
				});
				// Initial pass so any defaults get reflected.
				evaluateAllRules();
			}
			
			// (Removed: wireLoadExisting + loadExistingRecord; these powered
			// the in-modal "Find record to load" search panel that was tied
			// to the New record / Load existing toggle. Both were removed
			// once the upstream entry points (pending placeholder, SOQL
			// import, related-chip) covered the load-existing flow.)
			
			// Re-render the modal form while preserving whatever the user has in it.
			// Used when a controlling field changes value so dependents can refilter.
			// Writes the captured values into `currentFormValues` BEFORE renderForm
			// runs so picklistValuesForField can see the controller's fresh value
			// instead of racing the DOM swap.
			function rerenderFormPreservingValues() {
				// `collectFormValues` deliberately skips read-only fields
				// (data-readonly="true") so their values don't write back
				// into rec.values. But we still need those values to
				// re-render on the rebuilt form; otherwise read-only
				// cells go blank after a dependent-picklist re-render.
				// Merge: rec.values as base (covers everything, including
				// read-only), collected form values as overrides (covers
				// in-flight edits to editable fields that haven't been
				// committed back to rec.values yet).
				const recValues = (canvasState.currentRecordRef && canvasState.currentRecordRef.values) || {};
				currentFormValues = Object.assign({}, recValues, collectFormValues());
				renderForm();
				wireLiveValidation();
				populateForm(currentFormValues);
				evaluateAllRules();
			}
			
			// Mark required fields as `.is-empty` only while they have no value, so
			// the red border shows only on empty required fields (not every required
			// field, regardless of content).
			function updateRequiredFieldStyles() {
				const form = modal.querySelector('#insert-form');
				if (!form) {
return;
}
				form.querySelectorAll('.field.required').forEach(div => {
					const type = div.dataset.type;
					let empty = false;
					if (type === 'boolean') {
						empty = false;
					} else if (type === 'multipicklist') {
						const sel = div.querySelector('select');
						empty = !sel || !Array.from(sel.selectedOptions).some(o => o.value);
					} else {
						const el = div.querySelector('input, textarea, select');
						empty = !el || el.value == null || String(el.value).trim() === '';
					}
					div.classList.toggle('is-empty', empty);
				});
			}
			
			function evaluateAllRules() {
				updateRequiredFieldStyles();
				if (!currentRules.length) {
					const sb = modal.querySelector('#rules-summary-badge');
					if (sb) {
sb.style.display = 'none';
}
					return;
				}
				const values = collectFormValues();
				const opts = {
					currentFields: currentFields,
					savedRecords: canvasState.savedRecords,
					describeCache: canvasState.describeCache,
					currentRecord: canvasState.currentRecordRef,
					bulkRecords: canvasState.bulkRecords,
					bulkAssociations: canvasState.bulkAssociations,
				};
				// Wording rules. The three statuses are deliberately
				// hedged:
				//   - "Likely fail" (red): engine evaluated the formula AND
				//     it returned TRUE. SF would reject the upload, but
				//     we hedge because we might be wrong about a value
				//     coercion or a cross-object resolution.
				//   - "Looks OK" (green): engine evaluated the formula AND
				//     it returned FALSE. "Looks" because the engine only
				//     models a subset of the formula language; SF still
				//     gets the final word at upload.
				//   - "Can't predict" (gray): the formula uses something
				//     the engine doesn't model ($User, NOW, REGEX,
				//     VLOOKUP, etc.) or throws mid-evaluation. The
				//     tooltip names the specific reason.
				// A non-boolean evaluation result also lands in "Can't
				// predict"; distinguishing it as "Indeterminate" added
				// UX noise without changing what the user should do
				// (defer to SF).
				let passing = 0, failing = 0, unknown = 0;
				currentRules.forEach((r, i) => {
					const card = modal.querySelector('[data-rule-index="' + i + '"]');
					let status;
					if (r._parseError || !r._tree) {
						status = {
							cls: 'status-unknown',
							label: "Can't predict",
							title: 'Engine couldn’t parse this formula (' + (r._parseError || 'unsupported syntax') + '). Salesforce will still enforce it on upload.',
						};
					} else {
						try {
							const out = evalNode(r._tree, values, opts);
							if (out === true) {
								status = {
									cls: 'status-violated',
									label: 'Likely fail',
									title: 'On these values the formula evaluates to TRUE, so Salesforce will likely reject the upload. Edit the flagged fields or expect to see the error message above.',
								};
							} else if (out === false) {
								status = {
									cls: 'status-ok',
									label: 'Looks OK',
									title: 'On these values the formula evaluates to FALSE. Salesforce confirms on upload.',
								};
							} else {
								status = {
									cls: 'status-unknown',
									label: "Can't predict",
									title: 'Formula didn’t return a boolean; engine can’t map the result onto pass/fail. Salesforce will enforce it on upload.',
								};
							}
						} catch (e) {
							status = {
								cls: 'status-unknown',
								label: "Can't predict",
								title: 'Engine couldn’t evaluate this formula (' + e.message + '). Common causes: $User / $Profile refs, NOW / TODAY, REGEX, VLOOKUP. Salesforce will enforce it on upload.',
							};
						}
					}
					if (status.cls === 'status-ok') {
passing++;
} else if (status.cls === 'status-violated') {
failing++;
} else {
unknown++;
}
					if (card) {
						card.classList.remove('status-violated', 'status-ok', 'status-unknown');
						card.classList.add(status.cls);
						const badge = card.querySelector('.rule-status');
						if (badge) {
							badge.textContent = status.label;
							badge.title = status.title;
						}
					}
				});
				const summaryBadge = modal.querySelector('#rules-summary-badge');
				if (summaryBadge) {
					let cls, text, title;
					const total = passing + failing + unknown;
					if (failing > 0) {
						cls = 'status-violated';
						text = failing + (failing === 1 ? ' likely fail' : ' likely to fail');
						title = failing + ' rule' + (failing === 1 ? '' : 's') + ' would block upload on these values';
					} else if (unknown > 0) {
						// Any unpredictable rule taints the summary: claiming
						// "all clear" when one or more rules can't be evaluated
						// would mislead the user, since SF could still reject
						// the upload on the rule the engine doesn't model.
						cls = 'status-unknown';
						text = unknown + ' to verify';
						title = unknown + ' rule' + (unknown === 1 ? '' : 's') + " the engine can't evaluate client-side; Salesforce will check on upload";
					} else if (passing > 0) {
						cls = 'status-ok';
						text = 'looks clear';
						title = 'All ' + passing + ' rule' + (passing === 1 ? '' : 's') + ' evaluate cleanly on these values. Salesforce confirms on upload.';
					} else {
						cls = 'status-unknown';
						text = '';
						title = '';
					}
					summaryBadge.className = 'rules-summary ' + cls;
					summaryBadge.textContent = text;
					summaryBadge.title = title;
					summaryBadge.style.display = text ? '' : 'none';
				}
			}
			
			function renderFieldHtml(f, opts) {
				const readOnly = !!(opts && opts.readOnly);
				const isSlotField = !!(opts && opts.isSlotField);
				const req = f.required ? '<span class="req" title="Required">*</span>' : '';
				const slotBadge = isSlotField ? ' <span class="meta meta-slot" title="The author marked this field as a slot for you to fill in.">slot</span>' : '';
				const roBadge = readOnly ? ' <span class="meta meta-readonly" title="Read-only in Salesforce for your profile or because the field is system-managed">read-only</span>' : '';
				const meta = '<span class="meta">' + escapeHtml(f.type) + (f.referenceTo && f.referenceTo.length ? ' &rarr; ' + escapeHtml(f.referenceTo.join(', ')) : '') + '</span>';
				const labelInner = escapeHtml(f.label) + req + ' ' + meta + slotBadge + roBadge;
				const labelBlock = '<div class="field-head">' +
						'<label for="f_' + escapeHtml(f.name) + '">' + labelInner + '</label>' +
					'</div>';
				const help = f.helpText ? '<div class="help">' + escapeHtml(f.helpText) + '</div>' : '';
				const input = readOnly ? readOnlyInputForField(f) : inputForField(f);
				const lock = !readOnly && f.type === 'reference' ? associationLockForField(f.name) : null;
				const assocHelp = lock && lock.target
					? '<div class="assoc-help">Linked via association to <strong>' + escapeHtml(describeLinkedTarget(lock.target)) + '</strong>. ' +
						'<button type="button" class="link-button" data-disconnect-assoc="' + lock.association.id + '">Disconnect</button> to edit manually.</div>'
					: '';
				// textarea and multi-select picklists get an entire row; they're
				// visually tall and shrinking them halfway looks cramped.
				const fullWidth = f.type === 'textarea' || f.type === 'multipicklist';
				const classes = 'field'
					+ (f.required ? ' required' : '')
					+ (fullWidth ? ' full-width' : '')
					+ (readOnly ? ' is-readonly' : '')
					+ (isSlotField ? ' is-slot-field' : '');
				const roAttr = readOnly ? ' data-readonly="true"' : '';
				return '<div class="' + classes + '" data-field="' + escapeHtml(f.name) + '" data-type="' + escapeHtml(f.type) + '"' + roAttr + '>' + labelBlock + input + help + assocHelp + '</div>';
			}
			
			// Used by renderFieldHtml when the cell is read-only. We render a
			// disabled text input regardless of the underlying field type so
			// populateForm's `el.value = display` lands cleanly. collectFormValues
			// skips this div via data-readonly so the value never re-enters
			// rec.values; the upload-time strip on the server is still in place
			// as a backstop.
			function readOnlyInputForField(f) {
				const id = 'f_' + escapeHtml(f.name);
				const name = escapeHtml(f.name);
				// Reference fields (e.g. OwnerId, CreatedById,
				// LastModifiedById) render here when read-only; the
				// regular lookup-picker branch is skipped. Stamp the
				// referenceTo target on the input so populateForm can
				// resolve the SF id to a display Name instead of
				// leaving the raw 18-char id in the disabled field.
				let targetAttr = '';
				if (f.type === 'reference' && Array.isArray(f.referenceTo) && f.referenceTo[0]) {
					targetAttr = ' data-target-object="' + escapeHtml(f.referenceTo[0]) + '"';
				}
				return '<input type="text" id="' + id + '" name="' + name + '" disabled aria-readonly="true" value=""' + targetAttr + '>';
			}
			
			// Resolve the picklist value list for a field given the currently-selected
			// record type AND, for dependent picklists (state/country, custom
			// dependent picklists), the current value of its controller field.
			// Prefers record-type-specific values; falls back to the default list.
			// Returns { values, state } where state is one of:
			//   'ok': normal picklist with options available
			//   'controller-missing': controller field hasn't been set yet
			//   'not-applicable': controller is set, but no dependent values
			//                         exist for its current value (e.g., a country
			//                         with no active state picklist entries)
			// `ctxValues` optionally overrides the modal's live state; used by
			// bulk pre-fill where no modal is open. `rtIdOverride` overrides the
			// modal's currentRecordTypeId so bulk pre-fill can use each record's
			// own RT (or the describe's default) for picklist filtering.
			function picklistValuesForField(f, ctxValues, rtIdOverride) {
				const rtId = rtIdOverride || currentRecordTypeId;
				const rtValues = (rtId && f.picklistValuesByRecordType)
					? f.picklistValuesByRecordType[rtId]
					: null;
				let values = (Array.isArray(rtValues) && rtValues.length > 0)
					? rtValues
					: (f.picklistValues || []);
				let state = 'ok';
				if (f.controllerName) {
					const controllerVal = (ctxValues && ctxValues[f.controllerName])
						|| (currentFormValues && currentFormValues[f.controllerName])
						|| getControllerFieldValue(f.controllerName);
					// Prefer the record-type-specific map when we have one; fall
					// back to the top-level `controllerValues` for objects where
					// the UI API didn't return any record types (e.g. User in
					// many orgs). Both sources describe the same controller->
					// index mapping, so either works for validFor filtering.
					const ctrlMap = (f.controllerValuesByRecordType && rtId
							&& f.controllerValuesByRecordType[rtId]
							&& Object.keys(f.controllerValuesByRecordType[rtId]).length > 0
							? f.controllerValuesByRecordType[rtId] : null)
						|| f.controllerValues
						|| null;
					if (ctrlMap && controllerVal && Object.prototype.hasOwnProperty.call(ctrlMap, controllerVal)) {
						const idx = ctrlMap[controllerVal];
						const hasValidFor = values.some(v => Array.isArray(v.validFor) && v.validFor.length > 0);
						if (hasValidFor) {
							values = values.filter(v => Array.isArray(v.validFor) && v.validFor.includes(idx));
						}
						if (values.length === 0) {
state = 'not-applicable';
}
					} else if (ctrlMap && !controllerVal) {
						values = [];
						state = 'controller-missing';
					}
				}
				return { values, state };
			}
			
			// Read a field's currently-rendered value from the open modal (used to
			// filter dependent picklists against their controller's live value).
			function getControllerFieldValue(fieldName) {
				const div = modal.querySelector('.field[data-field="' + CSS.escape(fieldName) + '"]');
				if (!div) {
return null;
}
				const el = div.querySelector('select, input, textarea');
				if (!el) {
return null;
}
				return el.value || null;
			}
			
			// If the open record is linked to another record via a bulk-edit
			// association on this reference field, return the association + target
			// record so the form can lock the field and display the link instead.
			function associationLockForField(fieldName) {
				if (!canvasState.currentRecordRef) {
return null;
}
				const assoc = canvasState.bulkAssociations.find(a => a.fromId === canvasState.currentRecordRef.id && a.fieldName === fieldName);
				if (!assoc) {
return null;
}
				const target = canvasState.bulkRecords.find(r => r.id === assoc.toId);
				return { association: assoc, target };
			}
			
			function describeLinkedTarget(target) {
				if (!target) {
return '';
}
				const nameVal = target.values && (target.values.Name || target.values.Subject || target.values.Title);
				return nameVal
					? String(nameVal) + ' \u00b7 ' + target.label + ' #' + recordOrdinal(target)
					: target.label + ' #' + recordOrdinal(target);
			}
			
			// Wire a single lookup-picker. Called for each picker in
			// the rendered edit modal after innerHTML lands.
			//
			// State machine: the picker has two visible modes:
			//   \u2022 search (default): typeahead input + results dropdown
			//   \u2022 selected: pill with the linked record's name + \u00d7
			// The hidden input always carries the SF id (or empty). On
			// pick we flip to selected mode; on \u00d7 we flip back. If the
			// hidden input arrives with a pre-existing value (modal
			// opened on a record with AccountId already set), we
			// resolve the id to a display name via /api/objects/<target>/
			// records/<id> and start in selected mode; that's
			// populateForm's job; this function handles its initial
			// render too in case populateForm hasn't fired yet.
			const _lookupSearchCache = new Map(); // 'src|field|q' -> records
			function _wireLookupPicker(picker) {
				if (!picker || picker.dataset._wired === '1') {
return;
}
				picker.dataset._wired = '1';
				const sourceObject = picker.dataset.sourceObject;
				const fieldName = picker.dataset.fieldName;
				const targetObject = picker.dataset.targetObject;
				const hidden = picker.querySelector('input[type="hidden"]');
				const searchInput = picker.querySelector('.lookup-search');
				const resultsBox = picker.querySelector('.lookup-results');
				const selectedBox = picker.querySelector('.lookup-selected');
				const selectedLabel = picker.querySelector('.lookup-selected-label');
				const clearBtn = picker.querySelector('.lookup-clear');
				if (!hidden || !searchInput || !resultsBox || !selectedBox) {
return;
}
			
				function _showSearchMode() {
					selectedBox.hidden = true;
					searchInput.hidden = false;
					resultsBox.hidden = true;
					resultsBox.innerHTML = '';
				}
				function _showSelectedMode(displayText) {
					selectedLabel.textContent = displayText || hidden.value || '(linked)';
					selectedBox.hidden = false;
					searchInput.hidden = true;
					resultsBox.hidden = true;
					resultsBox.innerHTML = '';
				}
				// If the hidden input already has a value when we
				// wire (populated by inputForField from f.defaultValue,
				// or pre-set by an earlier populateForm call), start in
				// selected mode. Resolve the SF id to a display name in
				// the background; until it returns we show the id.
				if (hidden.value) {
					_showSelectedMode(hidden.value);
					_resolveLookupDisplay(targetObject, hidden.value).then((name) => {
						if (hidden.value && selectedBox && !selectedBox.hidden) {
							_showSelectedMode(name || hidden.value);
						}
					}).catch(() => {});
				}
			
				clearBtn.addEventListener('click', () => {
					hidden.value = '';
					_showSearchMode();
					setTimeout(() => searchInput.focus(), 0);
				});
			
				// Debounced search. 200ms is short enough to feel
				// responsive while typing and long enough to coalesce
				// the per-keystroke fetches into a single request
				// when the user lands on a long enough prefix.
				// Two-char minimum mirrors Salesforce's SOSL backend
				// (queries shorter than 2 chars return INVALID_SEARCH
				// from the UI API). Surface a hint instead of firing
				// the request and rendering a misleading "No matches."
				const MIN_QUERY_LEN = 2;
				let _searchTimer = null;
				searchInput.addEventListener('input', () => {
					const q = searchInput.value.trim();
					if (_searchTimer) {
clearTimeout(_searchTimer);
}
					if (q.length === 0) {
						resultsBox.hidden = true;
						resultsBox.innerHTML = '';
						return;
					}
					if (q.length < MIN_QUERY_LEN) {
						resultsBox.innerHTML = '<div class="lookup-result lookup-result--empty">Type at least ' + MIN_QUERY_LEN + ' characters to search</div>';
						resultsBox.hidden = false;
						return;
					}
					_searchTimer = setTimeout(() => _runLookupSearch(q), 200);
				});
				searchInput.addEventListener('focus', () => {
					const q = searchInput.value.trim();
					if (q.length >= MIN_QUERY_LEN) {
_runLookupSearch(q);
}
				});
			
				async function _runLookupSearch(q) {
					// Pass the loaded record's SF id as sourceRecordId so
					// Salesforce excludes it from its own lookup results:
					// e.g., "Americas Division" can't appear as a potential
					// Parent Account of "Americas Division". Matches what
					// Lightning's UI sends. Only set when the modal is open
					// on a loaded (not draft) record; drafts have no SF id
					// yet so there's nothing to exclude.
					const editing = canvasState.currentRecordRef;
					const sourceRecordId = (editing && editing.loadedFromId && /^[a-zA-Z0-9]{15,18}$/.test(editing.loadedFromId))
						? editing.loadedFromId
						: null;
					// Cache key includes sourceRecordId so a fresh modal on
					// a different record doesn't reuse stale "exclude self"
					// results; same q against record A and record B should
					// each get the right exclusion applied.
					const cacheKey = sourceObject + '|' + fieldName + '|' + q + '|' + (sourceRecordId || '');
					if (_lookupSearchCache.has(cacheKey)) {
						_renderResults(_lookupSearchCache.get(cacheKey));
						return;
					}
					try {
						const url = '/api/objects/' + encodeURIComponent(sourceObject) +
							'/lookup?fieldName=' + encodeURIComponent(fieldName) +
							'&q=' + encodeURIComponent(q) +
							(sourceRecordId ? '&sourceRecordId=' + encodeURIComponent(sourceRecordId) : '');
						const r = await csrfFetch(url, { credentials: 'same-origin' });
						if (!r.ok) {
							_renderResults([]);
							return;
						}
						const data = await r.json();
						const records = (data && Array.isArray(data.records)) ? data.records : [];
						_lookupSearchCache.set(cacheKey, records);
						_renderResults(records);
					} catch (e) {
						_renderResults([]);
					}
				}
			
				function _renderResults(records) {
					if (!records || records.length === 0) {
						resultsBox.innerHTML = '<div class="lookup-result lookup-result--empty">No matches</div>';
						resultsBox.hidden = false;
						return;
					}
					resultsBox.innerHTML = records.map((rec) => {
						const sub = rec.subtitle ? '<span class="lookup-result-sub">' + escapeHtml(rec.subtitle) + '</span>' : '';
						return '<button type="button" class="lookup-result" data-pick-id="' + escapeHtml(rec.id) + '" data-pick-title="' + escapeHtml(rec.title || '') + '">' +
							'<span class="lookup-result-title">' + escapeHtml(rec.title || rec.id) + '</span>' +
							sub +
						'</button>';
					}).join('');
					resultsBox.hidden = false;
					resultsBox.querySelectorAll('.lookup-result[data-pick-id]').forEach((btn) => {
						btn.addEventListener('click', () => {
							hidden.value = btn.getAttribute('data-pick-id') || '';
							_showSelectedMode(btn.getAttribute('data-pick-title') || hidden.value);
						});
					});
				}
			
				// Close dropdown on outside click.
				document.addEventListener('mousedown', (ev) => {
					if (!picker.contains(ev.target)) {
						resultsBox.hidden = true;
					}
				});
				searchInput.addEventListener('keydown', (ev) => {
					if (ev.key === 'Escape') {
resultsBox.hidden = true;
}
				});
			}
			
			// Resolve an SF id to a display name (Name field) for the
			// selected-pill UI. Best-effort; falls back to returning
			// null on any failure, and the caller keeps showing the
			// raw id.
			const _lookupDisplayCache = new Map();
			async function _resolveLookupDisplay(targetObject, recordId) {
				if (!targetObject || !recordId) {
return null;
}
				const key = targetObject + '|' + recordId;
				if (_lookupDisplayCache.has(key)) {
return _lookupDisplayCache.get(key);
}
				try {
					const r = await csrfFetch('/api/objects/' + encodeURIComponent(targetObject) + '/records/' + encodeURIComponent(recordId), { credentials: 'same-origin' });
					if (!r.ok) {
 _lookupDisplayCache.set(key, null); return null; 
}
					const rec = await r.json();
					const name = rec && (rec.Name || rec.Subject || rec.Title || rec.CaseNumber || null);
					_lookupDisplayCache.set(key, name);
					return name;
				} catch (e) {
					_lookupDisplayCache.set(key, null);
					return null;
				}
			}
			
			// Derive numeric bounds for a field based on its Salesforce metadata +
			// name heuristics for fields Salesforce enforces but doesn't expose in
			// describe (e.g., latitude/longitude). Returns null if no bounds apply.
			function fieldBounds(f) {
				if (!f) {
return null;
}
				if (/Latitude$/.test(f.name)) {
return { min: -90, max: 90, stepAny: true };
}
				if (/Longitude$/.test(f.name)) {
return { min: -180, max: 180, stepAny: true };
}
				if (f.type === 'percent') {
return { min: -100, max: 100, stepAny: true };
}
				if (typeof f.precision === 'number' && f.precision > 0) {
					const scale = (typeof f.scale === 'number' && f.scale >= 0) ? f.scale : 0;
					const intDigits = f.precision - scale;
					const maxAbs = intDigits > 0 ? Math.pow(10, intDigits) - (scale > 0 ? Math.pow(10, -scale) : 1) : 0;
					return { min: -maxAbs, max: maxAbs, stepAny: scale > 0 };
				}
				if (f.type === 'int') {
return { min: -2147483648, max: 2147483647, stepAny: false };
}
				return null;
			}
			
			// A field is treated as a picklist (restricted select) whenever it has
			// ANY picklist values defined for some record type OR its declared type
			// is a picklist variant, even if the currently-resolved option list is
			// empty (e.g., a dependent picklist whose controller isn't selected yet).
			function isPicklistLikeField(f) {
				if (f.type === 'picklist' || f.type === 'multipicklist' || f.type === 'combobox') {
return true;
}
				if (Array.isArray(f.picklistValues) && f.picklistValues.length > 0) {
return true;
}
				if (f.picklistValuesByRecordType) {
					for (const k in f.picklistValuesByRecordType) {
						if (Array.isArray(f.picklistValuesByRecordType[k]) && f.picklistValuesByRecordType[k].length > 0) {
return true;
}
					}
				}
				return false;
			}
			
			function inputForField(f) {
				const id = 'f_' + escapeHtml(f.name);
				const name = escapeHtml(f.name);
				const def = f.defaultValue != null ? ' value="' + escapeHtml(f.defaultValue) + '"' : '';
				const pvResult = picklistValuesForField(f);
				const picklistValues = pvResult.values;
				// Multi-picklist always renders as a multi-select of org values.
				if (f.type === 'multipicklist') {
					const opts = picklistValues.map(pv => '<option value="' + escapeHtml(pv.value) + '"' + (pv.defaultValue ? ' selected' : '') + '>' + escapeHtml(pv.label) + '</option>').join('');
					return '<select multiple size="4" id="' + id + '" name="' + name + '">' + opts + '</select>';
				}
				// Picklist-like fields always render as a restricted select, even
				// when the filtered option list is empty. Placeholder + disabled
				// state communicate why: pick the controller first, or no dependent
				// values exist for the current controller value.
				if (isPicklistLikeField(f)) {
					const controllerField = f.controllerName ? currentFields.find(cf => cf.name === f.controllerName) : null;
					const controllerLabel = controllerField ? controllerField.label : f.controllerName;
					let placeholder = '-- Select --';
					let disabled = false;
					if (pvResult.state === 'controller-missing') {
						placeholder = 'Select ' + controllerLabel + ' first';
						disabled = true;
					} else if (pvResult.state === 'not-applicable') {
						placeholder = 'Not applicable for this ' + controllerLabel;
						disabled = true;
					}
					const opts = ['<option value="">' + escapeHtml(placeholder) + '</option>'].concat(
						picklistValues.map(pv => '<option value="' + escapeHtml(pv.value) + '"' + (pv.defaultValue ? ' selected' : '') + '>' + escapeHtml(pv.label) + '</option>')
					).join('');
					const dAttr = disabled ? ' disabled' : '';
					return '<select id="' + id + '" name="' + name + '"' + dAttr + '>' + opts + '</select>';
				}
				const maxlenAttr = f.length ? ' maxlength="' + f.length + '"' : '';
				switch (f.type) {
					case 'boolean':
						return '<input type="checkbox" id="' + id + '" name="' + name + '"' + (f.defaultValue ? ' checked' : '') + '>';
					case 'int':
					case 'double':
					case 'currency':
					case 'percent': {
						const b = fieldBounds(f);
						const rangeAttrs = b
							? ' min="' + b.min + '" max="' + b.max + '" step="' + (b.stepAny ? 'any' : 1) + '"'
							: ' step="any"';
						return '<input type="number"' + rangeAttrs + ' id="' + id + '" name="' + name + '"' + def + '>';
					}
					case 'date':
						return '<input type="date" id="' + id + '" name="' + name + '"' + def + '>';
					case 'datetime':
						return '<input type="datetime-local" id="' + id + '" name="' + name + '">';
					case 'time':
						return '<input type="time" id="' + id + '" name="' + name + '"' + def + '>';
					case 'email':
						return '<input type="email" id="' + id + '" name="' + name + '"' + maxlenAttr + def + '>';
					case 'phone':
						// Require at least one digit anywhere. Salesforce itself accepts
						// a wide range of characters for phone (parens, dashes, "ext", +),
						// but "asdf" and other letter-only values round-trip as bad data,
						// so we block them at draft time rather than letting them fail
						// at upload.
						return '<input type="tel" id="' + id + '" name="' + name + '"' +
							' placeholder="(555) 555-1234"' +
							' pattern=".*\\d.*"' +
							' title="Enter a phone number containing at least one digit."' +
							maxlenAttr + def + '>';
					case 'url':
						// type="text" with inputmode="url": Salesforce
						// stores URLs without a scheme (e.g. "www.x.com")
						// so type="url" rejects valid SF data with the
						// browser's "please enter a url" popup. The
						// soft warning at the validation layer (search
						// for f.type === 'url') still flags missing
						// schemes without blocking submit.
						return '<input type="text" inputmode="url" id="' + id + '" name="' + name + '"' + maxlenAttr + def + '>';
					case 'textarea':
						return '<textarea id="' + id + '" name="' + name + '"' + maxlenAttr + '>' + escapeHtml(f.defaultValue || '') + '</textarea>';
					case 'reference': {
						const lock = associationLockForField(f.name);
						if (lock && lock.target) {
							const display = describeLinkedTarget(lock.target);
							return '<input type="text" id="' + id + '" name="' + name + '" value="' + escapeHtml(display) + '" readonly data-locked-assoc="' + lock.association.id + '">';
						}
						// Searchable lookup picker. The hidden input
						// carries the actual SF id (what
						// collectFormValues + populateForm read via
						// the unchanged name/id attrs). The visible
						// UI is a typeahead search box that swaps
						// itself out for a selected-pill once the
						// user picks a record. The pill's × clears
						// back to the search input.
						//
						// referenceTo[0] is the target object for the
						// search. Polymorphic refs (Task.WhoId,
						// Task.WhatId; referenceTo has multiple
						// entries) only pick the first target in V1;
						// extending to a "Lead or Contact?" sub-picker
						// is a future iteration.
						//
						// data-source-object + data-field-name +
						// data-target-object are read by the
						// wireLookupPickers function below to call
						// /api/objects/<source>/lookup with the right
						// fieldName + parse responses.
						const targetObject = Array.isArray(f.referenceTo) && f.referenceTo[0] ? f.referenceTo[0] : '';
						const sourceObject = currentObject || (canvasState.currentRecordRef && canvasState.currentRecordRef.objectName) || '';
						return '<div class="lookup-picker"' +
							' data-source-object="' + escapeHtml(sourceObject) + '"' +
							' data-field-name="' + escapeHtml(f.name) + '"' +
							' data-target-object="' + escapeHtml(targetObject) + '">' +
							'<input type="hidden" id="' + id + '" name="' + name + '" value="' + escapeHtml(f.defaultValue || '') + '">' +
							'<input type="text" class="lookup-search" autocomplete="off" placeholder="Search ' + escapeHtml(targetObject || 'records') + '…" aria-label="Search ' + escapeHtml(targetObject || 'records') + '">' +
							'<div class="lookup-results" hidden role="listbox"></div>' +
							'<div class="lookup-selected" hidden>' +
								'<span class="lookup-selected-label"></span>' +
								'<button type="button" class="lookup-clear" aria-label="Clear">×</button>' +
							'</div>' +
						'</div>';
					}
					default:
						return '<input type="text" id="' + id + '" name="' + name + '"' + maxlenAttr + def + '>';
				}
			}
			
			// Generate a "generous" sample value for a field, biased toward values
			// that pass common validation rules (long strings, moderate positive
			// numbers, valid-looking emails, etc). Not a full constraint solver;
			// unusual rules may still fire after auto-fill.
			// `fieldList` is the relevant set of fields for the current record
			// (the modal's currentFields OR the bulk describe.fields). `ctxValues`
			// is the record values accumulated so far in the same pre-fill pass,
			// used to filter dependent picklists by already-chosen controller vals.
			function sampleValueForField(f, fieldList, ctxValues, rtIdOverride, objectName) {
				// Randomize the suffix so every pre-filled record gets a unique string,
				// which dodges org-level uniqueness constraints (e.g. unique Name on
				// custom objects).
				const randomDigits = String(Math.floor(Math.random() * 1e10)).padStart(10, '0');
				const longSample = 'Auto-filled sample value ' + randomDigits;
				const capped = (s) => (f.length && f.length > 0 && s.length > f.length) ? s.slice(0, f.length) : s;
				const list = (Array.isArray(fieldList) && fieldList.length > 0) ? fieldList : (Array.isArray(currentFields) ? currentFields : []);
				// State/Country Picklists: if this field has a sibling `*Code`
				// picklist (e.g. BillingCountry + BillingCountryCode), skip
				// pre-filling the text field. Salesforce syncs it from the code
				// automatically and rejects any manual mismatch with a
				// "Mismatched integration value and ISO code" error.
				if (f.type === 'string' && list.length > 0) {
					const codeSibling = list.find(cf => cf.name === f.name + 'Code' && isPicklistLikeField(cf));
					if (codeSibling) {
return null;
}
				}
				// Any field with a picklist-values list gets filled from those values
				// so we never invent a value the org wouldn't accept, regardless of
				// the underlying type (picklist, combobox, etc).
				const pv = picklistValuesForField(f, ctxValues, rtIdOverride).values;
				if (Array.isArray(pv) && pv.length > 0) {
					const def = pv.find(v => v.defaultValue) || pv[0];
					return def ? def.value : '';
				}
				// Dependent picklist with no applicable values right now: leave blank.
				if (f.controllerName && isPicklistLikeField(f)) {
return null;
}
				const clamped = (n) => {
					const b = fieldBounds(f);
					if (!b) {
return n;
}
					let v = Math.max(b.min, Math.min(b.max, n));
					if (!b.stepAny) {
v = Math.trunc(v);
}
					return v;
				};
				switch (f.type) {
					case 'boolean': return f.defaultValue === true;
					case 'int': return clamped(100);
					case 'double':
					case 'currency':
					case 'percent': return clamped(100);
					case 'date': return new Date().toISOString().slice(0, 10);
					case 'datetime': return new Date().toISOString();
					case 'time': return '12:00';
					case 'email': return capped('autofill' + randomDigits + '@example' + randomDigits + '.com');
					case 'phone': return '+15555551234';
					case 'url': return capped('https://example' + randomDigits + '.com');
					case 'textarea': return capped(longSample);
					case 'picklist':
					case 'multipicklist': {
						const list = f.picklistValues || [];
						const def = list.find(v => v.defaultValue) || list[0];
						return def ? def.value : '';
					}
					case 'reference':
						// Lookups are intentionally skipped by pre-fill; wire them up
						// via the bulk canvas associations or the Load-existing flow
						// instead. A fake id would just cause the insert to fail.
						return null;
					case 'string':
					default:
						return capped(longSample);
				}
			}
			
			// Returns true if the field is a custom field (either flagged by the
			// describe response or following Salesforce's `__c` suffix convention).
			function isCustomField(f) {
				if (!f) {
return false;
}
				if (f.custom === true) {
return true;
}
				return typeof f.name === 'string' && f.name.endsWith('__c');
			}
			
			// Builds a predicate that filters by the chosen fieldType option.
			function fieldTypeFilter(fieldType) {
				if (fieldType === 'standard') {
return (f) => !isCustomField(f);
}
				if (fieldType === 'custom') {
return (f) => isCustomField(f);
}
				return () => true;
			}
			
			// Show a small popup anchored near `triggerEl` with Standard/Custom/Both
			// options; invokes onPick('both' | 'standard' | 'custom').
			// Bulk-toolbar seed menu: flat list of (scope, fieldType) combos.
			// Replaces the old pair of split buttons. onPick receives
			// (scope: 'required'|'all', fieldType: 'both'|'standard'|'custom').
			function showSeedMenu(triggerEl, onPick) {
				document.querySelectorAll('.fill-menu-popup').forEach(el => el.remove());
				const pop = document.createElement('div');
				pop.className = 'fill-menu-popup';
				const rect = triggerEl.getBoundingClientRect();
				const viewportW = window.innerWidth;
				const left = Math.min(rect.left, viewportW - 240);
				pop.style.left = Math.max(8, left) + 'px';
				pop.style.top = (rect.bottom + 6) + 'px';
				const item = (scope, fieldType, label, isDefault) =>
					'<button type="button" data-seed-scope="' + scope + '" data-seed-type="' + fieldType + '">' +
						escapeHtml(label) + (isDefault ? ' <span class="fm-tag">default</span>' : '') +
					'</button>';
				pop.innerHTML =
					'<div class="fm-subheader">Applies to draft records only; loaded-existing records are not touched.</div>' +
					'<div class="fm-header">Required fields only</div>' +
					item('required', 'both', 'Required fields', true) +
					item('required', 'standard', 'Required, standard only', false) +
					item('required', 'custom', 'Required, custom only', false) +
					'<div class="fm-header">All empty fields</div>' +
					item('all', 'both', 'All empty fields', false) +
					item('all', 'standard', 'All empty, standard only', false) +
					item('all', 'custom', 'All empty, custom only', false);
				document.body.appendChild(pop);
				const cleanup = () => {
					if (pop.parentNode) {
pop.remove();
}
					document.removeEventListener('mousedown', outside, true);
					document.removeEventListener('keydown', onEsc, true);
				};
				pop.querySelectorAll('button[data-seed-scope]').forEach(b => {
					b.addEventListener('click', () => {
 cleanup(); onPick(b.dataset.seedScope, b.dataset.seedType); 
});
				});
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
			}
			
			function showFillScopeMenu(triggerEl, onPick) {
				document.querySelectorAll('.fill-menu-popup').forEach(el => el.remove());
				const pop = document.createElement('div');
				pop.className = 'fill-menu-popup';
				const rect = triggerEl.getBoundingClientRect();
				const viewportW = window.innerWidth;
				const left = Math.min(rect.left, viewportW - 220);
				pop.style.left = Math.max(8, left) + 'px';
				pop.style.top = (rect.bottom + 6) + 'px';
				pop.innerHTML =
					'<div class="fm-header">Include fields</div>' +
					'<button type="button" data-fill-type="both">Standard + Custom</button>' +
					'<button type="button" data-fill-type="standard">Standard only</button>' +
					'<button type="button" data-fill-type="custom">Custom only</button>';
				document.body.appendChild(pop);
				const cleanup = () => {
					if (pop.parentNode) {
pop.remove();
}
					document.removeEventListener('mousedown', outside, true);
					document.removeEventListener('keydown', onEsc, true);
				};
				pop.querySelectorAll('button[data-fill-type]').forEach(b => {
					b.addEventListener('click', () => {
 cleanup(); onPick(b.dataset.fillType); 
});
				});
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
			}
			
			function autoFillFields(scope, fieldType) {
				const pick = scope === 'required'
					? (f) => f.required
					: scope === 'optional'
						? (f) => !f.required
						: () => true;
				const typePick = fieldTypeFilter(fieldType);
				// Controllers first so dependent picklists (e.g. state) see the
				// just-assigned controller value (e.g. country) when filtering.
				const ordered = [
					...currentFields.filter(f => !f.controllerName),
					...currentFields.filter(f => f.controllerName),
				];
				const values = {};
				ordered.filter(pick).filter(typePick).forEach(f => {
					const sample = sampleValueForField(f, currentFields, values);
					if (sample === null || sample === undefined || sample === '') {
return;
}
					values[f.name] = sample;
				});
				// Adjust values to pass as many validation rules as we can.
				tryFixValidationRules(values, currentFields, currentRules);
				populateForm(values);
				evaluateAllRules();
			}
			
			modal.querySelector('#modal-submit').addEventListener('click', () => {
				if (!currentObject) {
return;
}
				// Block save when any input fails HTML5 validation (min/max/maxlength/
				// email-format, etc.) so we don't ship a draft that Salesforce is going
				// to reject at upload time.
				const form = modal.querySelector('#insert-form');
				if (form && typeof form.checkValidity === 'function' && !form.checkValidity()) {
					if (typeof form.reportValidity === 'function') {
form.reportValidity();
}
					return;
				}
				// Explicit reference-field check: the input's HTML5 pattern catches
				// most cases but leaks pastes with trailing whitespace / zero-width
				// chars / non-ASCII. Re-check each visible reference field's value
				// against the SF ID format; mark invalid ones and bail.
				const SF_ID_RE = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;
				const refErrors = [];
				modal.querySelectorAll('.field[data-type="reference"]').forEach((div) => {
					div.classList.remove('field-invalid-ref');
					if (div.dataset.readonly === 'true') {
return;
}
					const el = div.querySelector('input');
					if (!el || el.dataset.lockedAssoc) {
return;
}
					const v = (el.value || '').trim();
					if (!v) {
return;
}
					if (!SF_ID_RE.test(v)) {
						const labelEl = div.querySelector('label');
						refErrors.push({
							name: div.dataset.field,
							label: labelEl ? labelEl.textContent.replace(/\*$/, '').trim() : div.dataset.field,
							el,
							div,
						});
						div.classList.add('field-invalid-ref');
					}
				});
				if (refErrors.length) {
					const first = refErrors[0];
					first.el.focus();
					first.el.select();
					const which = refErrors.map((e) => e.label || e.name).join(', ');
					const msg = refErrors.length === 1
						? 'Invalid Salesforce ID in "' + which + '". Expected 15 or 18 alphanumeric characters.'
						: refErrors.length + ' reference fields have invalid IDs: ' + which + '. Each must be 15 or 18 alphanumeric characters.';
					if (typeof showBulkToast === 'function') {
showBulkToast(msg, 'error');
}
					return;
				}
				let payload = collectFormValues();
				let target;
				let msg;
				let toastVariant = 'success';
				if (canvasState.currentRecordRef) {
					target = canvasState.currentRecordRef.label + ' #' + recordOrdinal(canvasState.currentRecordRef);
					// For loaded records: the form intentionally skips some
					// fields (association-locked refs, non-createable system
					// fields) that we DO want to keep locally so Load Related
					// and round-tripping work. Fold them in from loadedValues
					// when they're absent from the form payload, but only
					// fields the form genuinely doesn't surface, otherwise
					// "clear this field" gets ignored.
					const isLoaded = !!canvasState.currentRecordRef.loadedFromId && canvasState.currentRecordRef.loadedValues;
					if (isLoaded) {
						const formFields = new Set();
						modal.querySelectorAll('.field').forEach(div => {
							if (div.dataset.field) {
formFields.add(div.dataset.field);
}
						});
						const hidden = {};
						Object.keys(canvasState.currentRecordRef.loadedValues || {}).forEach(k => {
							if (!formFields.has(k)) {
								// Field never appeared in the form (system or
								// non-createable): preserve the loaded value.
								hidden[k] = canvasState.currentRecordRef.loadedValues[k];
							} else {
								// Field IS in the form. collectFormValues skips
								// it for two reasons:
								//   1. dataset.lockedAssoc: association-locked
								//      reference field. User couldn't edit it.
								//   2. data-readonly on the .field div: the
								//      field is read-only in SF for this user's
								//      profile OR is system-managed (OwnerId,
								//      CreatedById, LastModifiedById, etc.).
								//      readOnlyInputForField also resolves the
								//      input to a display Name, so the disabled
								//      input's value is a person/record label,
								//      not an id; definitely not what we want
								//      writing back.
								// In both cases, fold the original loaded value
								// back in so save preserves it instead of
								// dropping it.
								const div = modal.querySelector('.field[data-field="' + CSS.escape(k) + '"]');
								if (!div) {
return;
}
								if (div.dataset.readonly === 'true' && !(k in payload)) {
									hidden[k] = canvasState.currentRecordRef.loadedValues[k];
									return;
								}
								const el = div.querySelector('input, textarea, select');
								if (el && el.dataset.lockedAssoc && !(k in payload)) {
									hidden[k] = canvasState.currentRecordRef.loadedValues[k];
								}
							}
						});
						payload = Object.assign({}, hidden, payload);
					}
					// Compare against the record's CURRENT values (last-saved
					// local state) so opening the modal and clicking Save
					// without typing anything reports "no changes" instead
					// of the misleading "saved N fields", including for
					// drafts and for loaded records that already diverge
					// from their SF baseline. The previous logic only
					// suppressed the toast when payload matched
					// loadedValues, which missed both of those cases.
					const previousValues = canvasState.currentRecordRef.values || {};
					const changed = changedFieldNames(payload, previousValues);
					if (changed.length === 0) {
						toastVariant = 'info';
						msg = 'No changes to save for ' + target + '.';
					} else {
						canvasState.currentRecordRef.values = payload;
						canvasState.currentRecordRef._valuesRevision =
							(Number(canvasState.currentRecordRef._valuesRevision) || 0) + 1;
						msg = 'Saved ' + changed.length + ' changed field' + (changed.length === 1 ? '' : 's') +
							' for ' + target + ' locally.';
					}
				} else {
					target = currentObject;
					const previousValues = canvasState.savedRecords[currentObject] || {};
					const changed = changedFieldNames(payload, previousValues);
					if (changed.length === 0) {
						toastVariant = 'info';
						msg = 'No changes to save for ' + target + '.';
					} else {
						canvasState.savedRecords[currentObject] = payload;
						msg = 'Saved ' + changed.length + ' changed field' + (changed.length === 1 ? '' : 's') +
							' for ' + target + ' locally.';
					}
				}
				// Editing an existing card: Save is the "done" action, so
				// collapse the modal. Surface the result as a GLOBAL toast
				// (the modal-scoped showModalToast would vanish with the
				// modal) and refresh the canvas so the card reflects the
				// edits. When inserting/building a draft, keep the modal
				// open: "Save draft" is a checkpoint, not a finish.
				if (canvasState.currentRecordRef) {
					if (typeof renderChips === 'function') {
						renderChips();
					}
					if (canvasState.graphView === 'bulk') {
						renderBulkView();
					}
					closeModal();
					if (typeof showBulkToast === 'function') {
						showBulkToast(msg, toastVariant);
					}
				} else {
					renderForm();
					showModalToast(msg, toastVariant);
					populateForm(payload);
					evaluateAllRules();
					if (typeof renderChips === 'function') {
						renderChips();
					}
					// Refresh bulk view so the draft badge / subtitle updates.
					if (canvasState.graphView === 'bulk') {
						renderBulkView();
					}
				}
			});
			
			function populateForm(values) {
				if (!values) {
return;
}
				Object.keys(values).forEach(field => {
					const div = modal.querySelector('.field[data-field="' + CSS.escape(field) + '"]');
					if (!div) {
return;
}
					const ftype = div.dataset.type;
					const val = values[field];
					if (ftype === 'boolean') {
						const cb = div.querySelector('input[type="checkbox"]');
						if (cb) {
cb.checked = val === true || val === 'true';
}
					} else if (ftype === 'multipicklist') {
						const sel = div.querySelector('select');
						if (sel) {
							const vals = String(val).split(';');
							Array.from(sel.options).forEach(opt => {
								opt.selected = vals.indexOf(opt.value) !== -1;
							});
						}
					} else if (ftype === 'reference') {
						// Reference fields render as the lookup picker:
						// a hidden input (the actual id) + visible UI
						// that swaps between search + selected modes.
						// Skip when a picker isn't present (e.g.,
						// association-lock branch rendered a plain
						// readonly input instead).
						const picker = div.querySelector('.lookup-picker');
						if (!picker) {
							const lockedEl = div.querySelector('input[data-locked-assoc]');
							if (lockedEl) {
return;
} // association lock owns the display
							const fallbackEl = div.querySelector('input, textarea, select');
							if (!fallbackEl) {
return;
}
							// Read-only references (OwnerId, CreatedById,
							// LastModifiedById, etc.) land here because
							// readOnlyInputForField rendered a plain
							// disabled <input>. Show the raw id as a
							// placeholder first, then resolve to a Name
							// in the background. readOnlyInputForField
							// stamps data-target-object on these so we
							// know which SObject to retrieve from.
							const initial = val == null ? '' : val;
							fallbackEl.value = initial;
							const targetObject = fallbackEl.dataset && fallbackEl.dataset.targetObject;
							if (targetObject && initial) {
								_resolveLookupDisplay(targetObject, initial).then((name) => {
									// Guard against the user typing into
									// the field or another populateForm
									// landing before the async returns.
									if (name && fallbackEl.value === initial) {
										fallbackEl.value = name;
									}
								}).catch(() => {});
							}
							return;
						}
						const hidden = picker.querySelector('input[type="hidden"]');
						const selectedBox = picker.querySelector('.lookup-selected');
						const selectedLabel = picker.querySelector('.lookup-selected-label');
						const searchInput = picker.querySelector('.lookup-search');
						const resultsBox = picker.querySelector('.lookup-results');
						if (!hidden) {
return;
}
						hidden.value = val == null ? '' : val;
						if (!hidden.value) {
							// Cleared: flip back to search mode.
							if (selectedBox) {
selectedBox.hidden = true;
}
							if (searchInput) {
searchInput.hidden = false;
}
							if (resultsBox) {
 resultsBox.hidden = true; resultsBox.innerHTML = ''; 
}
							return;
						}
						// Show selected mode with the raw id as a
						// placeholder, then resolve to a Name in
						// the background; keeps the modal
						// responsive while the lookup fires.
						if (selectedLabel) {
selectedLabel.textContent = hidden.value;
}
						if (selectedBox) {
selectedBox.hidden = false;
}
						if (searchInput) {
searchInput.hidden = true;
}
						if (resultsBox) {
resultsBox.hidden = true;
}
						const targetObject = picker.dataset.targetObject || '';
						_resolveLookupDisplay(targetObject, hidden.value).then((name) => {
							if (name && selectedLabel && hidden.value === val) {
								selectedLabel.textContent = name;
							}
						}).catch(() => {});
					} else {
						const el = div.querySelector('input, textarea, select');
						// Don't clobber the display text on association-locked fields.
						if (el && el.dataset.lockedAssoc) {
return;
}
						if (el) {
							let display = val;
							// datetime-local inputs want YYYY-MM-DDTHH:MM (no seconds or tz)
							if (ftype === 'datetime' && typeof val === 'string') {
								const m = val.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/);
								if (m) {
display = m[1];
}
							}
							el.value = display;
						}
					}
				});
			}
			
			function collectFormValues() {
				const out = {};
				modal.querySelectorAll('.field').forEach(div => {
					// Read-only cells display the loaded value but don't participate
					// in the writeback; we don't want their value flowing into the
					// upload payload (the server-side strip would drop it anyway,
					// but skipping here keeps rec.values clean too).
					if (div.dataset.readonly === 'true') {
return;
}
					const fname = div.dataset.field;
					const ftype = div.dataset.type;
					if (ftype === 'boolean') {
						const cb = div.querySelector('input[type="checkbox"]');
						out[fname] = !!cb.checked;
						return;
					}
					if (ftype === 'multipicklist') {
						const sel = div.querySelector('select');
						const vals = Array.from(sel.selectedOptions).map(o => o.value).filter(Boolean);
						if (vals.length) {
out[fname] = vals.join(';');
}
						return;
					}
					const el = div.querySelector('input, textarea, select');
					if (!el) {
return;
}
					// Reference fields locked by an association are driven by the
					// linked record's real Salesforce id at upload time; never write
					// the display text back to rec.values.
					if (el.dataset.lockedAssoc) {
return;
}
					let v = el.value;
					// datetime-local inputs give YYYY-MM-DDTHH:MM; Salesforce's
					// JSON parser rejects that; upgrade to full ISO 8601.
					if (ftype === 'datetime' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) {
						v = v + ':00.000Z';
					}
					if (v !== '' && v != null) {
out[fname] = v;
}
				});
				return out;
			}

			return {
				openInsertModal: openInsertModal,
				closeModal: closeModal,
				showModalToast: showModalToast,
				_prefetchLayoutForRecord: _prefetchLayoutForRecord,
				// tryParseRule + tryFixValidationRules + fieldTypeFilter
				// + sampleValueForField are called from app.js outside
				// the modal (rules-cache loader and the bulk-autofill
				// fill path). They live here because they share the
				// formula evaluator and the same canvas-state closure.
				tryParseRule: tryParseRule,
				tryFixValidationRules: tryFixValidationRules,
				fieldTypeFilter: fieldTypeFilter,
				sampleValueForField: sampleValueForField,
			};
		},
	};
})();
