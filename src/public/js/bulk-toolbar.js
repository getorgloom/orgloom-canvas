(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.bulkToolbar = {
		mount: function mount(deps) {
			const required = [
				'canvasState', 'isRecordModified',
				'_aggregateSlotProgress', '_slotProgressClass',
				'showSaveMenu', 'promptCanvasSave',
				'showAddRecordsMenu', 'showBulkOperationsMenu',
				'openUploadModal', 'getGraph',
				'getReadOnlyMode',
				'openAiGenModal', 'getAiGen',
				'_wireCanvasFloatingAdd',
				'getCanvasShareCount', 'openCanvasEmailLinkModal',
				'openRecordDiffModal',
			];
			if (!deps) {
throw new Error('bulk-toolbar.mount: missing deps object');
}
			for (const k of required) {
				if (deps[k] === undefined || deps[k] === null) {
					throw new Error('bulk-toolbar.mount: missing dep ' + k);
				}
			}
			const canvasState = deps.canvasState;
			const isRecordModified = deps.isRecordModified;
			const _aggregateSlotProgress = deps._aggregateSlotProgress;
			const _slotProgressClass = deps._slotProgressClass;
			const showSaveMenu = deps.showSaveMenu;

			const _getCanvasShareCount = deps.getCanvasShareCount;

			const openCanvasEmailLinkModal = deps.openCanvasEmailLinkModal;
			const promptCanvasSave = deps.promptCanvasSave;

			const showAddRecordsMenu = deps.showAddRecordsMenu;
			const showBulkOperationsMenu = deps.showBulkOperationsMenu;
			const openUploadModal = deps.openUploadModal;
			const getGraph = deps.getGraph;
			const getReadOnlyMode = deps.getReadOnlyMode;

			const openAiGenModal = deps.openAiGenModal;
			const getAiGen = deps.getAiGen;
			const _wireCanvasFloatingAdd = deps._wireCanvasFloatingAdd;
			const openRecordDiffModal = deps.openRecordDiffModal;

			function renderBulkToolbar() {

				const cloneBar = getGraph().querySelector('#subbar-clone-btns');
				const recordsBar = getGraph().querySelector('#subbar-records');
				if (!cloneBar || !recordsBar) {
return;
}

				if (canvasState.selectedObjects.length === 0) {
					cloneBar.innerHTML = '';
				}

				const addMenuBtn = '<button type="button" class="batch-btn" data-bulk-add-menu title="Import records from a CSV or saved template">+ Import records</button>';

				const draftCountForToolbar = canvasState.bulkRecords.filter((r) => !r.loadedFromId && !r.isTypeNode).length;
				const _uploadEmpty = canvasState.bulkRecords.filter((r) => !r.isTypeNode).length === 0;

				const bulkOpsBtn = _uploadEmpty
					? '<button type="button" class="batch-btn" data-bulk-ops title="Add records to the canvas first" disabled aria-disabled="true">Tools ▾</button>'
					: '<button type="button" class="batch-btn" data-bulk-ops title="Auto-fill drafts, bulk edit fields, run a script, or diff records on the canvas">Tools ▾</button>';

				const _allRealCount = canvasState.bulkRecords.filter((r) => !r.isTypeNode).length;
				const _selectedRealCount = canvasState.bulkRecords.filter((r) => !r.isTypeNode && canvasState.bulkSelectedIds.has(r.id)).length;
				const _hasPartialSelection = _selectedRealCount > 0 && _selectedRealCount < _allRealCount;
				const uploadBtn = getReadOnlyMode()
					? '<button type="button" class="upload-btn upload-btn--locked" disabled title="Read-only mode is on \u2014 turn it off in the org banner above to upload">\uD83D\uDD12 Read-only</button>'
					: (_uploadEmpty
						? '<button type="button" class="upload-btn" data-bulk-upload disabled title="Add records to the canvas to enable upload">Upload to Salesforce</button>'
						: (_hasPartialSelection
							? '<button type="button" class="upload-btn upload-btn--scoped" data-bulk-upload data-upload-scope-default="selected" title="Review and upload the ' + _selectedRealCount + ' selected record' + (_selectedRealCount === 1 ? '' : 's') + ' (and any FK dependencies)">Upload ' + _selectedRealCount + ' selected</button>'
							: '<button type="button" class="upload-btn" data-bulk-upload title="Review and upload all records to Salesforce">Upload to Salesforce</button>'));

				const saveCanvasBtn = '<button type="button" class="batch-btn" data-bulk-save title="Save this canvas to your Salesforce org (stored as a File). Empty canvases can be saved as a starting point for AI proposals.">Save \u25BE</button>';

				const exportBtn = '';

				const helpBtn = '';

				const _shareIconSvg =
					'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px;margin-right:0.4em;display:inline-block" aria-hidden="true">' +
						'<circle cx="18" cy="5" r="3"/>' +
						'<circle cx="6" cy="12" r="3"/>' +
						'<circle cx="18" cy="19" r="3"/>' +
						'<line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>' +
						'<line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>' +
					'</svg>';

				const cc = canvasState.currentCanvas;
				const isRecipient = !!(cc && cc.id && !cc.ownedByMe);
				const isSavedOwned = !!(cc && cc.id && cc.ownedByMe);
				const _hasRealRecords = canvasState.bulkRecords.filter((r) => !r.isTypeNode).length > 0;
				let shareState = 'owned-saved';
				let shareDisabled = false;
				let shareTitle = 'Share this canvas with teammates';
				if (isRecipient) {
					shareState = 'recipient';
					shareDisabled = true;
					shareTitle = 'Only the canvas owner can share. Save a copy to share your version.';
				} else if (!_hasRealRecords && !isSavedOwned) {
					shareState = 'empty';
					shareDisabled = true;
					shareTitle = 'Add a record to start a canvas, then share it';
				} else if (!isSavedOwned) {
					shareState = 'owned-unsaved';
					shareTitle = 'Save this canvas and share it with teammates';
				}
				const shareCount = isSavedOwned ? _getCanvasShareCount(cc.id) : null;
				const shareCountBadge = (shareCount && shareCount > 0)
					? '<span class="canvas-share-btn-count" aria-label="' + shareCount + ' active share' + (shareCount === 1 ? '' : 's') + '">' + shareCount + '</span>'
					: '';
				const shareBtn = '<button type="button" class="batch-btn batch-btn-accent canvas-share-btn" data-bulk-share data-share-state="' + shareState + '"' + (shareDisabled ? ' disabled' : '') + ' title="' + shareTitle + '">' +
						_shareIconSvg +
						'Share' +
						shareCountBadge +
					'</button>';

				const _historyIconSvg =
					'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
						'<path d="M3 12a9 9 0 1 0 9-9 9.74 9.74 0 0 0-6.74 2.74L3 8"/>' +
						'<path d="M3 3v5h5"/>' +
						'<path d="M12 7v5l4 2"/>' +
					'</svg>';
				const historyBtn = '<button type="button" class="batch-btn batch-btn-icon" data-app-history title="Recent uploads — recall a previous batch" aria-label="Upload history">' +
						_historyIconSvg +
					'</button>';

				const aiGenBtn = getAiGen().isEnabled()
					? '<button type="button" class="batch-btn ai-gen-btn" data-bulk-ai-gen title="Describe what you want and let Claude draft records + relationships">\u2728 Generate with AI</button>'
					: '';
				cloneBar.innerHTML = '';

				recordsBar.innerHTML = addMenuBtn + aiGenBtn + bulkOpsBtn + '<span class="bulk-hint-spacer"></span>' + shareBtn + saveCanvasBtn + uploadBtn + historyBtn;

				const bulkOpsTrigger = getGraph().querySelector('[data-bulk-ops]');
				if (bulkOpsTrigger) {
bulkOpsTrigger.addEventListener('click', (e) => {
					e.stopPropagation();
					showBulkOperationsMenu(bulkOpsTrigger);
				});
}
				const addMenuTrigger = getGraph().querySelector('[data-bulk-add-menu]');
				if (addMenuTrigger) {
addMenuTrigger.addEventListener('click', (e) => {
					e.stopPropagation();
					showAddRecordsMenu(addMenuTrigger);
				});
}
				const shareTrigger = getGraph().querySelector('[data-bulk-share]');
				if (shareTrigger) {
shareTrigger.addEventListener('click', (e) => {
					e.stopPropagation();
					if (shareTrigger.disabled) {
return;
}

					const cc2 = canvasState.currentCanvas;
					const state = shareTrigger.dataset.shareState;
					if (state === 'owned-saved' && cc2 && cc2.id) {
						openCanvasEmailLinkModal(cc2.id, cc2.title || '');
					} else if (state === 'owned-unsaved') {

						promptCanvasSave({
							title: 'Name this canvas to share it',
							submitText: 'Save & share',
							afterSave: function (saved) {
								if (saved && saved.id) {
									openCanvasEmailLinkModal(saved.id, saved.title || '');
								}
							},
						});
					}
				});
}

				const saveCanvasTrigger = getGraph().querySelector('[data-bulk-save]');
				if (saveCanvasTrigger) {
saveCanvasTrigger.addEventListener('click', () => {

					showSaveMenu(saveCanvasTrigger);
				});
}

				const aiGenTrigger = getGraph().querySelector('[data-bulk-ai-gen]');
				if (aiGenTrigger) {
aiGenTrigger.addEventListener('click', () => {
					openAiGenModal();
				});
}
				const uploadTrigger = getGraph().querySelector('[data-bulk-upload]');
				if (uploadTrigger) {
uploadTrigger.addEventListener('click', () => {
					const scope = uploadTrigger.dataset.uploadScopeDefault === 'selected' ? 'selected' : 'all';
					openUploadModal({ initialScope: scope });
				});
}
				_wireCanvasFloatingAdd();
			}

			function renderBulkCountChip() {
				const chip = getGraph().querySelector('#bulk-count-chip');
				if (!chip) {
return;
}
				let total = 0;
				let drafts = 0;
				let modified = 0;
				let existing = 0;
				canvasState.bulkRecords.forEach((r) => {
					if (!r || r.isTypeNode) {
return;
}
					total++;
					if (!r.loadedFromId) {
						drafts++;
					} else if (isRecordModified(r)) {
						modified++;
					} else {
						existing++;
					}
				});

				if (total === 0) {
					chip.style.display = 'none';
					chip.innerHTML = '';
					return;
				}
				chip.style.display = '';
				chip.innerHTML =
					'<span class="bcc-total" title="Total records on the canvas">' + total + ' record' + (total === 1 ? '' : 's') + '</span>' +
					'<span class="bcc-sep" aria-hidden="true">·</span>' +
					'<span class="bcc-state bcc-draft" title="Drafts — new records that will be inserted">' +
						'<span class="bcc-dot" aria-hidden="true"></span>' + drafts + ' draft' +
					'</span>' +
					'<span class="bcc-state bcc-modified" title="Modified — loaded from Salesforce, edited locally; will be updated on upload">' +
						'<span class="bcc-dot" aria-hidden="true"></span>' + modified + ' modified' +
					'</span>' +
					'<span class="bcc-state bcc-existing" title="Existing — loaded from Salesforce, unchanged; will be skipped on upload">' +
						'<span class="bcc-dot" aria-hidden="true"></span>' + existing + ' existing' +
					'</span>' +

					(() => {
						const sp = _aggregateSlotProgress();
						if (sp.total === 0) {
return '';
}
						return '<span class="bcc-sep" aria-hidden="true">·</span>' +
							'<span class="slot-progress ' + _slotProgressClass(sp) + '" ' +
								'title="Slot progress across ' + sp.recordCount +
								' slot record' + (sp.recordCount === 1 ? '' : 's') + ' on this canvas.">' +
								'Slots ' + sp.filled + '/' + sp.total +
							'</span>';
					})();
			}

			function renderBulkSelectionChip() {
				const chip = getGraph().querySelector('#bulk-selection-chip');
				if (!chip) {
return;
}
				const n = canvasState.bulkSelectedIds.size;
				if (n === 0) {
					chip.style.display = 'none';
					chip.innerHTML = '';
					return;
				}

				const selectedReal = canvasState.bulkRecords.filter((r) =>
					!r.isTypeNode && !r.isPending && canvasState.bulkSelectedIds.has(r.id)
				);
				let diffBtn = '';
				if (selectedReal.length === 2) {
					diffBtn = '<button type="button" class="bsc-diff" data-sel-diff title="Compare these two records field-by-field">Diff</button>';
				} else if (selectedReal.length >= 1) {
					const diffHint = selectedReal.length === 1
						? 'need 1 more'
						: 'select only 2 (' + selectedReal.length + ' selected)';
					const diffTitle = 'Diff compares exactly two records \u2014 ' + diffHint + '.';
					diffBtn = '<button type="button" class="bsc-diff" data-sel-diff title="' + diffTitle + '" disabled aria-disabled="true">Diff <span class="bsc-diff-hint">\u00b7 ' + diffHint + '</span></button>';
				}
				chip.style.display = '';
				chip.innerHTML =
					'<span class="bsc-count">' + n + ' selected</span>' +
					diffBtn +
					'<button type="button" data-sel-copy title="Ctrl+C">Copy</button>' +
					(canvasState.bulkClipboard ? '<button type="button" data-sel-paste title="Ctrl+Shift+V">Clone\u2026</button>' : '') +
					'<button type="button" class="bsc-deselect" data-sel-clear>Deselect</button>';
				chip.querySelector('[data-sel-copy]').addEventListener('click', () => {
					copySelectionToClipboard();
					renderBulkSelectionChip();
				});
				const pasteBtn = chip.querySelector('[data-sel-paste]');
				if (pasteBtn) {
pasteBtn.addEventListener('click', () => openPasteCountPrompt());
}
				const diffTrigger = chip.querySelector('[data-sel-diff]');
				if (diffTrigger) {
diffTrigger.addEventListener('click', () => {

					const pair = canvasState.bulkRecords.filter((r) =>
						!r.isTypeNode && !r.isPending && canvasState.bulkSelectedIds.has(r.id)
					);
					if (pair.length === 2) {
openRecordDiffModal(pair[0], pair[1]);
}
				});
}
				chip.querySelector('[data-sel-clear]').addEventListener('click', () => {
					canvasState.bulkSelectedIds = new Set();
					renderBulkView();
				});
			}

			return {
				renderBulkToolbar: renderBulkToolbar,
				renderBulkCountChip: renderBulkCountChip,
				renderBulkSelectionChip: renderBulkSelectionChip,
			};
		},
	};
})();
