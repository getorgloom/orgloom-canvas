(function () {
	'use strict';
	// Implements marquee selection and in-memory copy/paste for canvas records and their internal links.

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.canvasMarquee = {
		mount: function mount(deps) {
			const required = [
				'canvasState',
				'getGraph',
				'clientToCanvasCoords',
				'renderBulkView',
				'_canvasCapBlockReason',
				'showBulkToast',
				'showPromptModal',
			];
			if (!deps) {
				throw new Error('canvas-marquee.mount: missing deps object');
			}
			for (const k of required) {
				if (deps[k] === undefined || deps[k] === null) {
					throw new Error('canvas-marquee.mount: missing dep ' + k);
				}
			}
			const canvasState = deps.canvasState;
			const getGraph = deps.getGraph;
			const clientToCanvasCoords = deps.clientToCanvasCoords;
			const renderBulkView = deps.renderBulkView;
			const _canvasCapBlockReason = deps._canvasCapBlockReason;
			const showBulkToast = deps.showBulkToast;
			const pushUndo = deps.pushUndo;
			const showPromptModal = deps.showPromptModal;

			function startMarquee(e) {
				const pt = clientToCanvasCoords(e.clientX, e.clientY);
				canvasState.bulkMarquee = {
					startX: pt.x,
					startY: pt.y,
					currentX: pt.x,
					currentY: pt.y,
					additive: e.shiftKey || e.ctrlKey || e.metaKey,
					moved: false,
					el: null,
				};
				const graph = getGraph();
				const content = graph.querySelector('#bulk-content');
				if (content) {
					const el = document.createElement('div');
					el.className = 'bulk-marquee';
					el.style.left = pt.x + 'px';
					el.style.top = pt.y + 'px';
					el.style.width = '0px';
					el.style.height = '0px';
					content.appendChild(el);
					canvasState.bulkMarquee.el = el;
				}
			}

			function updateMarqueeElement() {
				if (!canvasState.bulkMarquee || !canvasState.bulkMarquee.el) {
					return;
				}
				const x1 = Math.min(canvasState.bulkMarquee.startX, canvasState.bulkMarquee.currentX);
				const y1 = Math.min(canvasState.bulkMarquee.startY, canvasState.bulkMarquee.currentY);
				const x2 = Math.max(canvasState.bulkMarquee.startX, canvasState.bulkMarquee.currentX);
				const y2 = Math.max(canvasState.bulkMarquee.startY, canvasState.bulkMarquee.currentY);
				canvasState.bulkMarquee.el.style.left = x1 + 'px';
				canvasState.bulkMarquee.el.style.top = y1 + 'px';
				canvasState.bulkMarquee.el.style.width = x2 - x1 + 'px';
				canvasState.bulkMarquee.el.style.height = y2 - y1 + 'px';
			}

			function clearMarqueeElement() {
				if (canvasState.bulkMarquee && canvasState.bulkMarquee.el && canvasState.bulkMarquee.el.parentNode) {
					canvasState.bulkMarquee.el.parentNode.removeChild(canvasState.bulkMarquee.el);
				}
			}

			function finalizeMarqueeSelection() {
				const x1 = Math.min(canvasState.bulkMarquee.startX, canvasState.bulkMarquee.currentX);
				const y1 = Math.min(canvasState.bulkMarquee.startY, canvasState.bulkMarquee.currentY);
				const x2 = Math.max(canvasState.bulkMarquee.startX, canvasState.bulkMarquee.currentX);
				const y2 = Math.max(canvasState.bulkMarquee.startY, canvasState.bulkMarquee.currentY);
				const hits = new Set();
				canvasState.bulkRecords.forEach((rec) => {
					if (rec.x >= x1 && rec.x <= x2 && rec.y >= y1 && rec.y <= y2) {
						hits.add(rec.id);
					}
				});
				if (canvasState.bulkMarquee.additive) {
					hits.forEach((id) => canvasState.bulkSelectedIds.add(id));
				} else {
					canvasState.bulkSelectedIds = hits;
				}
				canvasState.bulkSelectedEdgeId = null;
				renderBulkView();
			}

			function copySelectionToClipboard() {
				if (canvasState.bulkSelectedIds.size === 0) {
					return false;
				}
				const selRecs = canvasState.bulkRecords.filter((r) => canvasState.bulkSelectedIds.has(r.id));
				const selIds = new Set(selRecs.map((r) => r.id));
				const selAssocs = canvasState.bulkAssociations.filter(
					(a) => selIds.has(a.fromId) && selIds.has(a.toId),
				);
				canvasState.bulkClipboard = {
					records: selRecs.map((r) => ({
						origId: r.id,
						objectName: r.objectName,
						label: r.label,
						values: Object.assign({}, r.values || {}),
						x: r.x,
						y: r.y,
					})),
					associations: selAssocs.map((a) => ({
						fromOrigId: a.fromId,
						toOrigId: a.toId,
						fieldName: a.fieldName,
					})),
				};
				showBulkToast('Copied ' + selRecs.length + ' record' + (selRecs.length === 1 ? '' : 's') + '.');
				return true;
			}

			function pasteFromClipboard(count) {
				if (!canvasState.bulkClipboard || !canvasState.bulkClipboard.records.length) {
					showBulkToast('Clipboard is empty. Select records then press Ctrl+C.');
					return;
				}
				const n = Math.max(1, Math.floor(Number(count) || 1));
				const wouldAdd = n * canvasState.bulkClipboard.records.length;
				const blocked = _canvasCapBlockReason(wouldAdd);
				if (blocked) {
					showBulkToast(blocked);
					return;
				}

				const xs = canvasState.bulkClipboard.records.map((r) => r.x);
				const ys = canvasState.bulkClipboard.records.map((r) => r.y);
				const minX = Math.min.apply(null, xs);
				const maxX = Math.max.apply(null, xs);
				const minY = Math.min.apply(null, ys);
				const maxY = Math.max.apply(null, ys);
				const clusterW = Math.max(240, maxX - minX + 240);
				const clusterH = Math.max(180, maxY - minY + 180);

				const canvasMaxX = canvasState.bulkRecords.reduce((m, r) => Math.max(m, r.x), 0);
				const baseX = canvasMaxX + 260 - minX;
				const graph = getGraph();
				const baseY = Math.max(80, graph.querySelector('#bulk-canvas').clientHeight / 2 - clusterH / 2) - minY;

				const cols = Math.max(1, Math.ceil(Math.sqrt(n)));

				const newIds = [];
				for (let i = 0; i < n; i++) {
					const col = i % cols;
					const row = Math.floor(i / cols);
					const offX = baseX + col * clusterW;
					const offY = baseY + row * clusterH;
					const origToNew = new Map();
					canvasState.bulkClipboard.records.forEach((r) => {
						const newId = canvasState.bulkIdSeq++;
						origToNew.set(r.origId, newId);
						canvasState.bulkRecords.push({
							id: newId,
							objectName: r.objectName,
							label: r.label,
							x: r.x + offX,
							y: r.y + offY,
							values: Object.assign({}, r.values || {}),
						});
						newIds.push(newId);
					});
					canvasState.bulkClipboard.associations.forEach((a) => {
						const fromId = origToNew.get(a.fromOrigId);
						const toId = origToNew.get(a.toOrigId);
						if (fromId != null && toId != null) {
							canvasState.bulkAssociations.push({
								id: canvasState.bulkIdSeq++,
								fromId,
								toId,
								fieldName: a.fieldName,
							});
						}
					});
				}

				canvasState.bulkSelectedIds = new Set(newIds);
				canvasState.bulkSelectedEdgeId = null;
				renderBulkView();
				showBulkToast('Pasted ' + n + ' cop' + (n === 1 ? 'y' : 'ies') + '.');
				const _pastedIds = new Set(newIds);
				if (typeof pushUndo === 'function' && _pastedIds.size > 0) {
					pushUndo('Paste', function () {
						canvasState.bulkRecords = canvasState.bulkRecords.filter((r) => !r || !_pastedIds.has(r.id));
						canvasState.bulkAssociations = canvasState.bulkAssociations.filter(
							(a) => a && !_pastedIds.has(a.fromId) && !_pastedIds.has(a.toId),
						);
						canvasState.bulkSelectedIds = new Set();
						renderBulkView();
					});
				}
			}

			function openPasteCountPrompt() {
				if (!canvasState.bulkClipboard || !canvasState.bulkClipboard.records.length) {
					showBulkToast('Clipboard is empty. Select records then press Ctrl+C.');
					return;
				}
				showPromptModal({
					title: 'Paste N copies',
					label: 'How many copies?',
					submitText: 'Paste',
					defaultValue: '10',
					placeholder: '10',
					helpText:
						'Each copy is a fresh record with a new temp id. Internal associations are preserved per cluster.',
				}).then((val) => {
					if (val == null) {
						return;
					}
					const n = parseInt(val, 10);
					if (!Number.isFinite(n) || n < 1) {
						showBulkToast('Invalid count.', 'error');
						return;
					}
					pasteFromClipboard(n);
				});
			}

			return {
				startMarquee: startMarquee,
				updateMarqueeElement: updateMarqueeElement,
				clearMarqueeElement: clearMarqueeElement,
				finalizeMarqueeSelection: finalizeMarqueeSelection,
				copySelectionToClipboard: copySelectionToClipboard,
				pasteFromClipboard: pasteFromClipboard,
				openPasteCountPrompt: openPasteCountPrompt,
			};
		},
	};
})();
