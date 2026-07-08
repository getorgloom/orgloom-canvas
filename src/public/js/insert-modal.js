


























































(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.insertModal = {
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





			const _getCyInstance = typeof deps.getCyInstance === 'function' ? deps.getCyInstance : null;
			const _getCyContainer = typeof deps.getCyContainer === 'function' ? deps.getCyContainer : null;


			const modal = document.createElement('div');
			modal.className = 'modal hidden';
			modal.innerHTML =
				'<div class="modal-overlay" data-close></div>' +
				'<div class="modal-body">' +
					'<div class="modal-header">' +
						'<h3 id="modal-title">New record</h3>' +






						'<div class="modal-subtitle" id="modal-subtitle"></div>' +




						'<button class="modal-close" data-close title="Collapse to card" aria-label="Collapse to card">' +
							'<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">' +
								'<path d="M2 6h4V2M12 8H8v4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' +
							'</svg>' +
						'</button>' +
					'</div>' +
					'<div class="modal-content" id="modal-content"><p class="center">Loading…</p></div>' +
					'<div class="modal-toast" id="modal-toast" hidden></div>' +
					'<div class="modal-footer">' +








						'<button class="button danger" id="modal-mark-delete" hidden style="margin-right:auto" title="Stages a Salesforce DELETE that ships with your next upload">Mark for delete</button>' +
						'<button class="button secondary" data-close>Cancel</button>' +
						'<button class="button" id="modal-submit" disabled>Save draft</button>' +
					'</div>' +
				'</div>';
			document.body.appendChild(modal);
			modal.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', closeModal));
			document.addEventListener('keydown', e => {
 if (e.key === 'Escape') {
closeModal();
} 
});









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
							message: 'This record has unsaved edits. Marking it for delete will discard those edits — the record will be DELETE\'d in Salesforce on next upload regardless.',
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





			(function _installResizeHandles() {
				const body = modal.querySelector('.modal-body');
				if (!body) {
return;
}





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



					_syncCyNodeSizeToModal();
				};
				const onUp = () => {
					modal.classList.remove('is-resizing');
					document.removeEventListener('mousemove', onMove);
					document.removeEventListener('mouseup', onUp);



					if (_inlineRenderHandler) {
_inlineRenderHandler();
}
				};
				document.addEventListener('mousemove', onMove);
				document.addEventListener('mouseup', onUp);
			}














			let _inlineRecId = null;
			let _inlineOutsideClickHandler = null;
			let _inlineRenderHandler = null;
			let _inlineSelectObserver = null;
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





				const _body = modal.querySelector('.modal-body');
				if (_body) {
_body.setAttribute('data-inline-rec-id', String(rec.id));
}









				cyNode.data('_inlineLocked', true);
				_syncCyNodeSizeToModal();
				_inlinePinToNode(cy, cyNode, container);












				const _syncSelected = () => {
					const card = container.querySelector(
						'.cy-card-shell .record-card[data-rec-id="' + rec.id + '"]'
					);
					modal.classList.toggle('is-selected', !!card && card.classList.contains('selected'));
				};
				_inlineRenderHandler = () => _inlinePinToNode(cy, cyNode, container);
				cy.on('render position', _inlineRenderHandler);






				_inlineSelectObserver = new MutationObserver(_syncSelected);
				_inlineSelectObserver.observe(container, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
				_syncSelected();


				const header = modal.querySelector('.modal-header');
				if (header) {
_attachInlineDrag(header, cy, cyNode, container);
}











				_inlineOutsideClickHandler = (ev) => {
					if (!modal.classList.contains('is-inline')) {
return;
}
					const t = ev.target;
					if (!t || !t.closest) {
return;
}

					if (t.closest('.modal-body[data-inline-rec-id]')) {
return;
}





					if (t.closest('.fill-menu-popup, .find-object-popup, .anchored-popup')) {
return;
}




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

					const zoom = cy.zoom() || 1;
					const dx = (ev.clientX - startClientX) / zoom;
					const dy = (ev.clientY - startClientY) / zoom;
					cyNode.position({ x: startNodeX + dx, y: startNodeY + dy });


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

			let currentRecordTypes = [];
			let currentRecordTypeId = null;
			let currentLayout = null;
			const layoutCache = {};





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



			let currentFormValues = {};


			const sectionCollapsed = { optional: true, rules: true };





			let modalEditMode = 'new';
			



			




			










			var _formula = (window.OrgLoom && window.OrgLoom.formula) || null;
			if (!_formula) {
throw new Error('formula.js must load before app.js');
}
			var parseFormula = _formula.parseFormula;
			var evalNode = _formula.evalNode;





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
			

			function tryMakeRuleFalse(node, values, fieldList) {
				if (!node) {
return false;
}
				if (node.k === 'call' && node.name === 'NOT') {
					return tryMakeRuleTrue(node.args[0], values, fieldList);
				}

				if (node.k === 'call' && node.name === 'AND') {
					for (const arg of node.args) {
						if (tryMakeRuleFalse(arg, values, fieldList)) {
return true;
}
					}
					return false;
				}

				if (node.k === 'call' && node.name === 'OR') {
					let any = false;
					for (const arg of node.args) {
						if (tryMakeRuleFalse(arg, values, fieldList)) {
any = true;
}
					}
					return any;
				}

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

				if (node.k === 'cmp') {
					const fixed = tryFixComparison(node, values, fieldList);
					if (fixed) {
return true;
}
				}
				return false;
			}
			

			function tryMakeRuleTrue(node, values, fieldList) {
				if (!node) {
return false;
}


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

						next = cur.slice(0, Math.max(0, effOp === '>' ? target : target - 1));
					} else if (effOp === '<' || effOp === '<=') {

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


				modalEditMode = (canvasState.currentRecordRef && canvasState.currentRecordRef.loadedFromId) ? 'existing' : 'new';


				_exitInlineMode();
				modal.classList.remove('hidden');








				if (canvasState.currentRecordRef && canvasState.currentRecordRef.loadedFromId) {
					try {
						pushPresenceFocus({
							kind: 'record',
							ref: canvasState.currentRecordRef.loadedFromId,
							objectName: canvasState.currentRecordRef.objectName,
						});
					} catch (_) {                               }
				}






				if (opts.record) {
_enterInlineMode(opts.record);
}
				modal.querySelector('#modal-title').textContent = 'Loading ' + objectName + '…';
				modal.querySelector('#modal-submit').disabled = true;
				modal.querySelector('#modal-content').innerHTML = '<p class="center">Loading fields…</p>';




				_updateMarkDeleteButton();
			
				const encoded = encodeURIComponent(objectName);



				const describePromise = ensureDescribe(objectName);
				const rulesPromise = csrfFetch('/api/objects/' + encoded + '/validation-rules')
					.then(r => r.ok ? r.json() : []);
			
				Promise.all([describePromise, rulesPromise])
					.then(([describe, rules]) => {
						currentFields = describe.fields;
						currentRecordTypes = describe.recordTypes || [];


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







							return v.Name || v.CaseNumber || v.OrderNumber || v.WorkOrderNumber || v.Subject || v.Title || null;
						};
						let titlePrefix;
						let subtitleText;
						if (canvasState.currentRecordRef) {
							const resolvedName = _resolveTitle();
							titlePrefix = resolvedName || (describe.label + ' #' + recordOrdinal(canvasState.currentRecordRef));





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




						const recId = canvasState.currentRecordRef && canvasState.currentRecordRef.loadedFromId;
						return fetchEditLayout(currentObject, currentRecordTypeId, recId)
							.then((layout) => {
								currentLayout = layout;







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



									submitBtn.disabled = true;
									submitBtn.title = 'View only — you can’t make changes to this canvas.';
								} else if (canvasState.currentRecordRef && canvasState.currentRecordRef._recipientSlot
									&& _slotAssignmentState(canvasState.currentRecordRef) === 'other') {
									submitBtn.disabled = true;
									submitBtn.title = 'Reserved for the assigned teammate — read-only for you.';
								}






								let initialValues = canvasState.currentRecordRef
									? canvasState.currentRecordRef.values
									: canvasState.savedRecords[currentObject];
								const hasExplicit = initialValues && Object.keys(initialValues).length > 0;
								if (!hasExplicit && currentLayout && currentLayout.defaults && Object.keys(currentLayout.defaults).length > 0) {
									initialValues = Object.assign({}, currentLayout.defaults);


									if (canvasState.currentRecordRef) {
										canvasState.currentRecordRef.values = Object.assign({}, initialValues, canvasState.currentRecordRef.values || {});
									}
								}
								if (initialValues && Object.keys(initialValues).length > 0) {
									populateForm(initialValues);



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




				_exitInlineMode();
				modal.classList.add('hidden');
				currentObject = null;
				currentFields = [];
				canvasState.currentRecordRef = null;
				currentRecordTypes = [];
				currentRecordTypeId = null;


				try {
 pushPresenceFocus(null); 
} catch (_) {                   }
			}
			
			function renderForm(banner) {
				const byLabel = (a, b) => a.label.localeCompare(b.label);
				const isCompound = (f) => f && (f.type === 'address' || f.type === 'location');
				const isWritable = (f) => modalEditMode === 'new' ? !!f.createable : !!f.updateable;








				const partialFieldSet = (canvasState.currentRecordRef && Array.isArray(canvasState.currentRecordRef._loadedFieldNames))
					? new Set(canvasState.currentRecordRef._loadedFieldNames)
					: null;
				const isPartialLoad = !!partialFieldSet;
				const inPartial = (name) => !partialFieldSet || partialFieldSet.has(name);










				const isStateCountryTextLegacy = (f) => {
					if (!f || f.type !== 'string') {
return false;
}
					return currentFields.some(cf => cf.name === f.name + 'Code' && isPicklistLikeField(cf));
				};






				const regular = currentFields.filter(f =>
					f.name !== 'RecordTypeId' && !isCompound(f) && !isStateCountryTextLegacy(f) && isWritable(f)
					&& inPartial(f.name)
				);
				const required = regular.filter(f => f.required).sort(byLabel);
				const optional = regular.filter(f => !f.required).sort(byLabel);
			














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








				const slotAssignedToOther = !!(canvasState.currentRecordRef && canvasState.currentRecordRef._recipientSlot
					&& _slotAssignmentState(canvasState.currentRecordRef) === 'other');






				const viewerReadOnly = getCanvasShareRole() === 'viewer';
				const forceReadOnly = slotAssignedToOther || viewerReadOnly;
			
				let html = banner ? banner : '';





				if (isPartialLoad) {
					const n = partialFieldSet.size;
					html += '<div class="banner info" style="margin-bottom:0.7em">' +
						'<strong>Showing ' + n + ' loaded field' + (n === 1 ? '' : 's') + '.</strong> ' +
						'This record was imported via SOQL with a focused SELECT — fields you didn\'t query aren\'t shown here. ' +
						'They\'re preserved on Salesforce; an Update only sends the fields below. ' +
						'To edit other fields, re-import via SOQL with <strong>Load all fields</strong> checked.' +
						'</div>';
				}


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
						'Only the assigned teammate can fill this slot — everything is read-only for you.' +
						_bannerLastModifiedHtml +
					'</div>';
				} else if (viewerReadOnly && slotFieldNames && slotFieldNames.size > 0) {



					html += '<div class="banner info slot-banner">' +
						'<strong>View only.</strong>' + _bannerProgressChip + ' ' +
						'These fields were marked as slots, but this canvas was shared with you as view-only — they’re read-only for you.' +
						_bannerLastModifiedHtml +
					'</div>';
				} else if (slotLockNonSlot) {
					const count = slotFieldNames.size;
					const inaccessible = slotFieldsInaccessible;
					const fillable = count - inaccessible;
					const sp = _slotProgress(canvasState.currentRecordRef) || { filled: 0, total: count };

					const hiddenNote = inaccessible > 0
						? ' <strong>' + inaccessible + ' slot field' + (inaccessible === 1 ? '' : 's') +
							' ' + (inaccessible === 1 ? 'isn’t' : 'aren’t') + ' shown</strong> — ' +
							(inaccessible === 1 ? "it's" : "they're") +
							' hidden by field-level security or read-only for your Salesforce user, so ' +
							(inaccessible === 1 ? "it can't" : "they can't") + ' be filled here.'
						: '';
					if (fillable <= 0) {




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

					const count = slotFieldNames.size;
					html += '<div class="banner info slot-banner">' +
						'<strong>' + count + ' field' + (count === 1 ? '' : 's') + ' marked as slot' + (count === 1 ? '' : 's') + '.</strong>' + _bannerProgressChip + ' ' +
						'Recipients of this canvas will only be able to update ' +
						(count === 1 ? 'that field' : 'those fields') + '.' +
						_bannerLastModifiedHtml +
					'</div>';
				}
				html += '<form id="insert-form">';
			






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
						'<span>Editing existing record ' + idHtml + ' \u2014 Upload will update it in Salesforce.</span>' +
						'<button type="button" class="link-button" data-unlink-existing>Unlink</button>' +
					'</div>';
				}
			

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




								if (!inPartial(cell.apiName)) {
return '';
}
								renderedNames.add(cell.apiName);
								const layoutEditable = modalEditMode === 'new' ? cell.editableForNew : cell.editableForUpdate;
								const isSlotField = !!(slotFieldNames && slotFieldNames.has(cell.apiName));





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
							? '<div class="field-section-empty">This object has no required fields — fill in anything below that matters to you.</div>'
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
			


















				const _SYSTEM_FIELDS = new Set([
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













				const _isCrossOrgCarryover = !!(_orphanRecord && _orphanRecord._wasLoadedFromOrgId);
				const _orphanValues = (_orphanRecord && _orphanRecord.values) || {};
				const _orphanFieldSet = new Set(currentFields.map((f) => f.name));
				const _orphanNames = !_isCrossOrgCarryover ? [] : Object.keys(_orphanValues).filter((k) => {
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
							'Carry-over fields not on this org <span class="count">(' + _orphanNames.length + ')</span>' +
						'</div>' +
						'<div class="orphan-banner banner warn">' +
							'These values traveled with the record when you switched Salesforce orgs. ' +
							'The fields don\'t exist on <code>' + escapeHtml(currentObject) +
							'</code> in this org, so Salesforce would reject them on upload. ' +
							'<strong>Drop</strong> the ones you don\'t need, or <strong>copy</strong> ' +
							'each value to a target field that does exist.' +
						'</div>' +
						'<div class="orphan-fields">' +
							_orphanNames.map((name) => {
								const val = _orphanValues[name];
								const valDisplay = (val == null || val === '')
									? '<span class="orphan-empty">(empty)</span>'
									: '<code>' + escapeHtml(String(val)) + '</code>';
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









				const _migApi = window.Orgloom && window.Orgloom.canvasMigrate;
				const _migRec = canvasState.currentRecordRef;
				if (_migApi && _migApi.isActive() && _migRec) {
					const _ann = _migApi.annotationFor(_migRec.id);
					const _annIssues = (_ann && _ann.issues) || [];
					const _rtIssue = _annIssues.find((i) => i.kind === 'recordtype-unresolved');
					const _plIssues = _annIssues.filter((i) => i.kind === 'picklist-mismatch');
					const _rtResolved = !!(_migRec._migrateRecordTypeId || _migRec._migrateClearRecordType);
					if (_rtIssue || _plIssues.length || _rtResolved) {
						let _migRows = '';


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
										(_rtIssue ? ' — not in this org' : '') + '</div>' +
								'</div>' +
								'<select class="migrate-select" data-migrate-rt-select>' +
									'<option value="">Pick a record type…</option>' +
									_rtOpts +
									'<option value="__clear__"' +
										(_migRec._migrateClearRecordType ? ' selected' : '') +
										'>— No record type —</option>' +
								'</select>' +
							'</div>';
						}

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
										'<option value="">— Drop value —</option>' +
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


						deleteAssociation(assocId);
						rerenderFormPreservingValues();
					});
				});







				modal.querySelectorAll('.lookup-picker').forEach(_wireLookupPicker);





				const unlinkBtn = modal.querySelector('[data-unlink-existing]');
				if (unlinkBtn) {
					unlinkBtn.addEventListener('click', () => {
						if (canvasState.currentRecordRef) {
canvasState.currentRecordRef.loadedFromId = null;
}
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
						const sourceVal = rec.values[sourceName];
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






					const disclaimer = '<div class="field-section-note">'
						+ 'Predictions are client-side based on the values in this form. '
						+ 'Salesforce checks every rule on upload &mdash; that\u2019s the source of truth.'
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



					const div = e.target.closest && e.target.closest('.field[data-type="reference"]');
					if (div) {
div.classList.remove('field-invalid-ref');
}
					evaluateAllRules();
				});
				form.addEventListener('change', (e) => {
					evaluateAllRules();





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


					if (changedName === 'RecordTypeId') {
return;
}
					rerenderFormPreservingValues();
				});

				evaluateAllRules();
			}
			





			





			function rerenderFormPreservingValues() {









				const recValues = (canvasState.currentRecordRef && canvasState.currentRecordRef.values) || {};
				currentFormValues = Object.assign({}, recValues, collectFormValues());
				renderForm();
				wireLiveValidation();
				populateForm(currentFormValues);
				evaluateAllRules();
			}
			



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
									title: 'Formula didn’t return a boolean — engine can’t map the result onto pass/fail. Salesforce will enforce it on upload.',
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




						cls = 'status-unknown';
						text = unknown + ' to verify';
						title = unknown + ' rule' + (unknown === 1 ? '' : 's') + " the engine can't evaluate client-side — Salesforce will check on upload";
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


				const fullWidth = f.type === 'textarea' || f.type === 'multipicklist';
				const classes = 'field'
					+ (f.required ? ' required' : '')
					+ (fullWidth ? ' full-width' : '')
					+ (readOnly ? ' is-readonly' : '')
					+ (isSlotField ? ' is-slot-field' : '');
				const roAttr = readOnly ? ' data-readonly="true"' : '';
				return '<div class="' + classes + '" data-field="' + escapeHtml(f.name) + '" data-type="' + escapeHtml(f.type) + '"' + roAttr + '>' + labelBlock + input + help + assocHelp + '</div>';
			}
			






			function readOnlyInputForField(f) {
				const id = 'f_' + escapeHtml(f.name);
				const name = escapeHtml(f.name);






				let targetAttr = '';
				if (f.type === 'reference' && Array.isArray(f.referenceTo) && f.referenceTo[0]) {
					targetAttr = ' data-target-object="' + escapeHtml(f.referenceTo[0]) + '"';
				}
				return '<input type="text" id="' + id + '" name="' + name + '" disabled aria-readonly="true" value=""' + targetAttr + '>';
			}
			














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
			














			const _lookupSearchCache = new Map();
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







					const editing = canvasState.currentRecordRef;
					const sourceRecordId = (editing && editing.loadedFromId && /^[a-zA-Z0-9]{15,18}$/.test(editing.loadedFromId))
						? editing.loadedFromId
						: null;




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

				if (f.type === 'multipicklist') {
					const opts = picklistValues.map(pv => '<option value="' + escapeHtml(pv.value) + '"' + (pv.defaultValue ? ' selected' : '') + '>' + escapeHtml(pv.label) + '</option>').join('');
					return '<select multiple size="4" id="' + id + '" name="' + name + '">' + opts + '</select>';
				}




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





						return '<input type="tel" id="' + id + '" name="' + name + '"' +
							' placeholder="(555) 555-1234"' +
							' pattern=".*\\d.*"' +
							' title="Enter a phone number containing at least one digit."' +
							maxlenAttr + def + '>';
					case 'url':







						return '<input type="text" inputmode="url" id="' + id + '" name="' + name + '"' + maxlenAttr + def + '>';
					case 'textarea':
						return '<textarea id="' + id + '" name="' + name + '"' + maxlenAttr + '>' + escapeHtml(f.defaultValue || '') + '</textarea>';
					case 'reference': {
						const lock = associationLockForField(f.name);
						if (lock && lock.target) {
							const display = describeLinkedTarget(lock.target);
							return '<input type="text" id="' + id + '" name="' + name + '" value="' + escapeHtml(display) + '" readonly data-locked-assoc="' + lock.association.id + '">';
						}





















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
			








			function sampleValueForField(f, fieldList, ctxValues, rtIdOverride, objectName) {



				const randomDigits = String(Math.floor(Math.random() * 1e10)).padStart(10, '0');
				const longSample = 'Auto-filled sample value ' + randomDigits;
				const capped = (s) => (f.length && f.length > 0 && s.length > f.length) ? s.slice(0, f.length) : s;
				const list = (Array.isArray(fieldList) && fieldList.length > 0) ? fieldList : (Array.isArray(currentFields) ? currentFields : []);





				if (f.type === 'string' && list.length > 0) {
					const codeSibling = list.find(cf => cf.name === f.name + 'Code' && isPicklistLikeField(cf));
					if (codeSibling) {
return null;
}
				}



				const pv = picklistValuesForField(f, ctxValues, rtIdOverride).values;
				if (Array.isArray(pv) && pv.length > 0) {
					const def = pv.find(v => v.defaultValue) || pv[0];
					return def ? def.value : '';
				}

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



						return null;
					case 'string':
					default:
						return capped(longSample);
				}
			}
			


			function isCustomField(f) {
				if (!f) {
return false;
}
				if (f.custom === true) {
return true;
}
				return typeof f.name === 'string' && f.name.endsWith('__c');
			}
			

			function fieldTypeFilter(fieldType) {
				if (fieldType === 'standard') {
return (f) => !isCustomField(f);
}
				if (fieldType === 'custom') {
return (f) => isCustomField(f);
}
				return () => true;
			}
			





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
					'<div class="fm-subheader">Applies to draft records only \u2014 loaded-existing records are not touched.</div>' +
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

				tryFixValidationRules(values, currentFields, currentRules);
				populateForm(values);
				evaluateAllRules();
			}
			
			modal.querySelector('#modal-submit').addEventListener('click', () => {
				if (!currentObject) {
return;
}



				const form = modal.querySelector('#insert-form');
				if (form && typeof form.checkValidity === 'function' && !form.checkValidity()) {
					if (typeof form.reportValidity === 'function') {
form.reportValidity();
}
					return;
				}




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


								hidden[k] = canvasState.currentRecordRef.loadedValues[k];
							} else {
















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








					const previousValues = canvasState.currentRecordRef.values || {};
					const changed = changedFieldNames(payload, previousValues);
					if (changed.length === 0) {
						toastVariant = 'info';
						msg = 'No changes to save for ' + target + '.';
					} else {
						canvasState.currentRecordRef.values = payload;
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
				renderForm();
				showModalToast(msg, toastVariant);
				populateForm(payload);
				evaluateAllRules();
				if (typeof renderChips === 'function') {
renderChips();
}

				if (canvasState.graphView === 'bulk') {
renderBulkView();
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






						const picker = div.querySelector('.lookup-picker');
						if (!picker) {
							const lockedEl = div.querySelector('input[data-locked-assoc]');
							if (lockedEl) {
return;
}
							const fallbackEl = div.querySelector('input, textarea, select');
							if (!fallbackEl) {
return;
}








							const initial = val == null ? '' : val;
							fallbackEl.value = initial;
							const targetObject = fallbackEl.dataset && fallbackEl.dataset.targetObject;
							if (targetObject && initial) {
								_resolveLookupDisplay(targetObject, initial).then((name) => {



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

						if (el && el.dataset.lockedAssoc) {
return;
}
						if (el) {
							let display = val;

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



					if (el.dataset.lockedAssoc) {
return;
}
					let v = el.value;


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





				tryParseRule: tryParseRule,
				tryFixValidationRules: tryFixValidationRules,
				fieldTypeFilter: fieldTypeFilter,
				sampleValueForField: sampleValueForField,
			};
		},
	};
})();
