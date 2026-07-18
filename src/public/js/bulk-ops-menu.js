(function () {
	'use strict';
	// Routes bulk actions through a shared selection model and permission-aware availability rules.

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.bulkOpsMenu = {
		mount: function mount(deps) {
			const required = [
				'canvasState',
				'_hasCap',
				'bulkAutoFill',
				'bulkClearAllFields',
				'summarizeAutoFillTargets',
				'openLinkedCsvModal',
				'openAiGenModal',
				'openSoqlImportModal',
				'openBrowseModal',
				'openBulkEditModal',
				'openBulkScriptModal',
				'openRecordDiffModal',
				'openCanvasSearchModal',
				'openFindDuplicatesModal',
				'openBulkRefreshFlow',
				'beginMigration',
				'spawnPendingRecord',
				'triggerTemplateFileInput',
				'getGraph',
				'getCyInstance',
				'getCanvasSpaceHeld',
				'setCanvasSpaceHeld',
				'getCanvasZHeld',
				'setCanvasZHeld',
				'_isOnPaidPlan',
				'isTeamAdmin',
			];
			if (!deps) {
				throw new Error('bulk-ops-menu.mount: missing deps object');
			}
			for (const k of required) {
				if (deps[k] === undefined || deps[k] === null) {
					throw new Error('bulk-ops-menu.mount: missing dep ' + k);
				}
			}
			const canvasState = deps.canvasState;
			const _hasCap = deps._hasCap;
			const beginMigration = deps.beginMigration;
			const bulkAutoFill = deps.bulkAutoFill;
			const bulkClearAllFields = deps.bulkClearAllFields;
			const summarizeAutoFillTargets = deps.summarizeAutoFillTargets;
			const openLinkedCsvModal = deps.openLinkedCsvModal;
			const openAiGenModal = deps.openAiGenModal;
			const openSoqlImportModal = deps.openSoqlImportModal;
			const openBrowseModal = deps.openBrowseModal;
			const openBulkEditModal = deps.openBulkEditModal;
			const openBulkScriptModal = deps.openBulkScriptModal;
			const openRecordDiffModal = deps.openRecordDiffModal;
			const openCanvasSearchModal = deps.openCanvasSearchModal;
			const openFindDuplicatesModal = deps.openFindDuplicatesModal;
			const openBulkRefreshFlow = deps.openBulkRefreshFlow;
			const spawnPendingRecord = deps.spawnPendingRecord;
			const triggerTemplateFileInput = deps.triggerTemplateFileInput;
			const getGraph = deps.getGraph;
			const getCyInstance = deps.getCyInstance;
			const getCanvasSpaceHeld = deps.getCanvasSpaceHeld;
			const setCanvasSpaceHeld = deps.setCanvasSpaceHeld;
			const getCanvasZHeld = deps.getCanvasZHeld;
			const setCanvasZHeld = deps.setCanvasZHeld;
			const _isOnPaidPlan = deps._isOnPaidPlan;
			const isTeamAdmin = deps.isTeamAdmin;

			function _wireCanvasFloatingAdd() {
				if (getGraph().dataset.canvasWired === '1') {
					return;
				}
				getGraph().dataset.canvasWired = '1';
				const cyContainer = getGraph().querySelector('#bulk-canvas-cy');
				const legacyContainer = getGraph().querySelector('#bulk-canvas');
				const activeContainer = () => {
					if (cyContainer && cyContainer.offsetParent !== null) {
						return cyContainer;
					}
					if (legacyContainer && legacyContainer.offsetParent !== null) {
						return legacyContainer;
					}
					return cyContainer || legacyContainer;
				};
				const worldFromClient = (clientX, clientY) => {
					const container = activeContainer();
					if (!container) {
						return null;
					}
					const rect = container.getBoundingClientRect();
					if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
						return null;
					}
					const px = clientX - rect.left;
					const py = clientY - rect.top;
					if (getCyInstance() && container === cyContainer) {
						const pan = getCyInstance().pan();
						const zoom = getCyInstance().zoom() || 1;
						return { x: (px - pan.x) / zoom, y: (py - pan.y) / zoom };
					}
					return { x: container.scrollLeft + px, y: container.scrollTop + py };
				};
				const overInteractive = (target) =>
					!!(
						target &&
						target.closest &&
						target.closest(
							'.record-card, .record-card-pending, .record-related-chip, ' +
								'.bulk-empty-placeholder, ' +
								'.bulk-toast, .modal',
						)
					);

				document.addEventListener('contextmenu', (ev) => {
					const worldPos = worldFromClient(ev.clientX, ev.clientY);
					if (!worldPos) {
						return;
					} // outside canvas: let browser default fire
					if (overInteractive(ev.target)) {
						return;
					}
					if (getCyInstance()) {
						const cont = activeContainer();
						if (cont) {
							const rect = cont.getBoundingClientRect();
							const px = ev.clientX - rect.left;
							const py = ev.clientY - rect.top;
							const nodes = getCyInstance().nodes();
							for (let i = 0; i < nodes.length; i++) {
								const bb = nodes[i].renderedBoundingBox();
								if (px >= bb.x1 && px <= bb.x2 && py >= bb.y1 && py <= bb.y2) {
									return;
								}
							}
						}
					}
					ev.preventDefault();
					_showCanvasContextMenu(ev.clientX, ev.clientY, worldPos);
				});

				document.addEventListener('keydown', (ev) => {
					const isInputTarget =
						ev.target &&
						(/^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName) || ev.target.isContentEditable);
					if (isInputTarget) {
						return;
					}
					if (ev.key === ' ' || ev.code === 'Space') {
						if (getCanvasSpaceHeld()) {
							return;
						}
						setCanvasSpaceHeld(true);
						getGraph().classList.add('canvas-pan-mode');
						ev.preventDefault(); // suppress page-down scroll
						return;
					}
					if (ev.key === 'z' || ev.key === 'Z') {
						if (ev.ctrlKey || ev.metaKey) {
							return;
						} // leave Ctrl/Cmd+Z (undo) alone
						setCanvasZHeld(true);
						return;
					}
				});
				document.addEventListener('keyup', (ev) => {
					if (ev.key === ' ' || ev.code === 'Space') {
						if (!getCanvasSpaceHeld()) {
							return;
						}
						setCanvasSpaceHeld(false);
						getGraph().classList.remove('canvas-pan-mode');
						getGraph().classList.remove('canvas-pan-mode-active');
						return;
					}
					if (ev.key === 'z' || ev.key === 'Z') {
						setCanvasZHeld(false);
						return;
					}
				});
				document.addEventListener('mousedown', () => {
					if (getCanvasSpaceHeld()) {
						getGraph().classList.add('canvas-pan-mode-active');
					}
				});
				document.addEventListener('mouseup', () => {
					getGraph().classList.remove('canvas-pan-mode-active');
				});
			}

			function _showCanvasContextMenu(clientX, clientY, worldPos) {
				document.querySelectorAll('.canvas-context-menu').forEach((el) => el.remove());
				const menu = document.createElement('div');
				menu.className = 'canvas-context-menu';
				const width = 220;
				const estHeight = 48; // single-item menu, small
				const left = Math.min(clientX, window.innerWidth - width - 8);
				const top = Math.min(clientY, window.innerHeight - estHeight - 8);
				menu.style.left = Math.max(8, left) + 'px';
				menu.style.top = Math.max(8, top) + 'px';
				menu.innerHTML =
					'<button type="button" class="ccm-item" data-ccm-action="spawn">' +
					'<span class="ccm-label">Add record here</span>' +
					'<span class="ccm-sub">Drop a pending placeholder at the click point</span>' +
					'</button>';
				document.body.appendChild(menu);
				const cleanup = () => {
					if (menu.parentNode) {
						menu.remove();
					}
					document.removeEventListener('mousedown', outside, true);
					document.removeEventListener('keydown', onEsc, true);
				};
				const outside = (ev) => {
					if (!menu.contains(ev.target)) {
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
				menu.addEventListener('click', (ev) => {
					const btn = ev.target.closest('[data-ccm-action]');
					if (!btn) {
						return;
					}
					const action = btn.dataset.ccmAction;
					cleanup();
					if (action === 'spawn') {
						spawnPendingRecord(worldPos.x, worldPos.y);
					}
				});
			}

			function showAddRecordsMenu(triggerEl) {
				document.querySelectorAll('.fill-menu-popup').forEach((el) => el.remove());
				const pop = document.createElement('div');
				pop.className = 'fill-menu-popup';
				const rect = triggerEl.getBoundingClientRect();
				const viewportW = window.innerWidth;
				const left = Math.min(rect.left, viewportW - 280);
				pop.style.left = Math.max(8, left) + 'px';
				pop.style.top = rect.bottom + 6 + 'px';
				pop.innerHTML =
					'<div class="fm-header">From Salesforce</div>' +
					'<button type="button" data-add-menu="browse" title="Filter records by field values, see live counts, then load matches onto the canvas, no SOQL knowledge required">Browse records</button>' +
					'<button type="button" data-add-menu="soql" title="Write a SOQL SELECT to pull records (and their related children via subqueries) into the canvas">Import via SOQL query</button>' +
					'<div class="fm-header">From a file</div>' +
					'<button type="button" data-add-menu="csv" title="Upload one or more CSV files; multi-file imports auto-detect FK links between rows">Import from CSV</button>' +
					'<button type="button" data-add-menu="fixture" title="Import a previously-saved canvas (with records) from a JSON file">Import saved canvas (JSON)</button>';
				document.body.appendChild(pop);
				const cleanup = () => {
					if (pop.parentNode) {
						pop.remove();
					}
					document.removeEventListener('mousedown', outside, true);
					document.removeEventListener('keydown', onEsc, true);
				};
				pop.querySelectorAll('button[data-add-menu]').forEach((b) => {
					b.addEventListener('click', () => {
						const action = b.dataset.addMenu;
						cleanup();
						if (action === 'csv') {
							openLinkedCsvModal();
						} else if (action === 'soql') {
							openSoqlImportModal();
						} else if (action === 'browse') {
							openBrowseModal();
						} else if (action === 'fixture') {
							triggerTemplateFileInput({});
						}
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

			function showBulkOperationsMenu(triggerEl) {
				document.querySelectorAll('.fill-menu-popup').forEach((el) => el.remove());
				const pop = document.createElement('div');
				pop.className = 'fill-menu-popup';
				const rect = triggerEl.getBoundingClientRect();
				const viewportW = window.innerWidth;
				const left = Math.min(rect.left, viewportW - 280);
				pop.style.left = Math.max(8, left) + 'px';
				pop.style.top = rect.bottom + 6 + 'px';
				const selectedDraftIds = canvasState.bulkRecords
					.filter((r) => !r.loadedFromId && !r.isTypeNode && canvasState.bulkSelectedIds.has(r.id))
					.map((r) => r.id);
				const allDraftCount = canvasState.bulkRecords.filter((r) => !r.loadedFromId && !r.isTypeNode).length;
				const scopeToSelected = selectedDraftIds.length > 0;
				const scopedDraftCount = scopeToSelected ? selectedDraftIds.length : allDraftCount;
				const draftHint =
					scopedDraftCount === 0
						? scopeToSelected
							? ' (selection has no draft records)'
							: ' (no draft records yet)'
						: ' on ' +
							scopedDraftCount +
							(scopeToSelected ? ' selected' : '') +
							' draft record' +
							(scopedDraftCount === 1 ? '' : 's');
				const fillLabelSuffix = scopeToSelected ? ' (selected)' : '';
				const canRunScripts = _hasCap('run-script');
				let scriptItem;
				if (canRunScripts) {
					scriptItem =
						'<button type="button" data-bulk-op="script" title="Run a JavaScript snippet against records on the canvas (no Salesforce calls)">Run script</button>';
				} else if (!_isOnPaidPlan()) {
					scriptItem =
						'<button type="button" data-bulk-op="script-upgrade" title="Run script is a Pro feature; click to upgrade" style="display:flex;align-items:center;gap:0.4em;justify-content:space-between">' +
						'<span>Run script</span>' +
						'<span class="tag" style="font-size:0.7rem;background:var(--accent-soft);color:var(--accent)">Pro</span>' +
						'</button>';
				} else {
					const offTitle = isTeamAdmin()
						? "Run script isn't granted to your account. Click to open workspace member permissions and grant it."
						: "Run script isn't enabled for your account. Ask a workspace admin to grant you access.";
					scriptItem =
						'<button type="button" data-bulk-op="script-not-granted" title="' +
						offTitle +
						'" style="display:flex;align-items:center;gap:0.4em;justify-content:space-between">' +
						'<span>Run script</span>' +
						'<span class="tag" style="font-size:0.7rem">Off</span>' +
						'</button>';
				}
				const _selectedReal = canvasState.bulkRecords.filter(
					(r) => !r.isTypeNode && !r.isPending && canvasState.bulkSelectedIds.has(r.id),
				);
				const diffEnabled = _selectedReal.length === 2;
				const diffStateHint = diffEnabled
					? ''
					: _selectedReal.length === 0
						? '<span class="fm-hint">select 2 records</span>'
						: _selectedReal.length === 1
							? '<span class="fm-hint">select 1 more record</span>'
							: '<span class="fm-hint">select only 2 (' + _selectedReal.length + ' selected)</span>';
				const diffTitle = diffEnabled
					? 'Compare the two selected records field-by-field'
					: 'Diff compares exactly two records; select 2 on the canvas to enable.';
				const diffLabel = 'Diff records' + (diffStateHint ? ' ' + diffStateHint : '');
				const diffItem = diffEnabled
					? '<button type="button" data-bulk-op="diff" title="' + diffTitle + '">' + diffLabel + '</button>'
					: '<button type="button" data-bulk-op="diff" title="' +
						diffTitle +
						'" disabled aria-disabled="true">' +
						diffLabel +
						'</button>';
				const _searchableCount = canvasState.bulkRecords.filter(
					(r) => r && !r.isTypeNode && !r.isPending,
				).length;
				const searchEnabled = _searchableCount > 0;
				const searchTitle = searchEnabled
					? 'Search field values and record names across all cards on the canvas (Cmd/Ctrl+F)'
					: 'Add records to the canvas first';
				const searchItem = searchEnabled
					? '<button type="button" data-bulk-op="search" title="' +
						searchTitle +
						'">Search canvas <span class="fm-tag">Cmd/Ctrl+F</span></button>'
					: '<button type="button" data-bulk-op="search" title="' +
						searchTitle +
						'" disabled aria-disabled="true">Search canvas</button>';
				let dupesEnabled = false;
				const _dupesCountsByObject = new Map();
				for (const r of canvasState.bulkRecords) {
					if (!r || r.isTypeNode || r.isPending) {
						continue;
					}
					_dupesCountsByObject.set(r.objectName, (_dupesCountsByObject.get(r.objectName) || 0) + 1);
				}
				for (const n of _dupesCountsByObject.values()) {
					if (n >= 2) {
						dupesEnabled = true;
						break;
					}
				}
				const dupesTitle = dupesEnabled
					? 'Group same-object records that look like duplicates so you can keep one and remove the rest'
					: _searchableCount < 2
						? 'Add at least 2 records to the canvas to find duplicates'
						: 'Find duplicates compares records of the same object type; add a second record of an existing type to enable.';
				const dupesItem = dupesEnabled
					? '<button type="button" data-bulk-op="find-dupes" title="' +
						dupesTitle +
						'">Find duplicates</button>'
					: '<button type="button" data-bulk-op="find-dupes" title="' +
						dupesTitle +
						'" disabled aria-disabled="true">Find duplicates</button>';
				const _canAutoFill = _hasCap('auto-fill-records');
				const _canBulkEdit = _hasCap('bulk-edit-records');
				const _autoFillItem = _canAutoFill
					? '<button type="button" data-bulk-op="auto-fill" title="Fill empty required fields, fill all empty fields, or clear all values; pick the mode + scope in the modal that opens.">Auto-fill</button>'
					: '';
				const _bulkEditItem = _canBulkEdit
					? '<button type="button" data-bulk-op="bulk-edit" title="Find &amp; replace or set a value across many records at once">Bulk edit</button>'
					: '';
				const _canBrowseForRefresh = _hasCap('browse-records');
				let _refreshItem = '';
				if (_canBrowseForRefresh) {
					const _allLoaded = canvasState.bulkRecords.filter(
						(r) => r && !r.isTypeNode && !r.isPending && !r.pendingDelete && r.loadedFromId,
					);
					const _selectedLoaded =
						canvasState.bulkSelectedIds && canvasState.bulkSelectedIds.size > 0
							? _allLoaded.filter((r) => canvasState.bulkSelectedIds.has(r.id))
							: _allLoaded;
					const _refreshCount = _selectedLoaded.length;
					const _hasSelection = canvasState.bulkSelectedIds && canvasState.bulkSelectedIds.size > 0;
					const _refreshSubtitle =
						_refreshCount === 0
							? _hasSelection
								? 'No loaded records in selection'
								: 'No loaded records on canvas'
							: _hasSelection
								? _refreshCount + ' selected'
								: _refreshCount + ' loaded';
					const _refreshEmptyTitle = _hasSelection
						? 'Your selection has no loaded records; clear the selection to refresh every loaded record on the canvas.'
						: 'No loaded records on the canvas to refresh.';
					_refreshItem =
						_refreshCount === 0
							? '<button type="button" data-bulk-op="refresh-sf" disabled aria-disabled="true" title="' +
								_refreshEmptyTitle +
								'">Refresh from Salesforce <span class="tag">' +
								_refreshSubtitle +
								'</span></button>'
							: '<button type="button" data-bulk-op="refresh-sf" title="Pull current Salesforce values for loaded records. Dirty cards prompt for confirmation before being clobbered.">Refresh from Salesforce <span class="tag">' +
								_refreshSubtitle +
								'</span></button>';
				}
				const _migrateHasRecords = canvasState.bulkRecords.some((r) => !r.isTypeNode);
				const _migrateItem = _migrateHasRecords
					? '<button type="button" data-bulk-op="migrate-org" title="Recreate these records in a different Salesforce org. Your canvas is saved first so the switch is safe.">Migrate to another org…</button>'
					: '<button type="button" data-bulk-op="migrate-org" disabled aria-disabled="true" title="Add or load records before migrating to another org.">Migrate to another org…</button>';
				pop.innerHTML =
					'<div class="fm-header">Modify records</div>' +
					_autoFillItem +
					_bulkEditItem +
					scriptItem +
					'<div class="fm-header">Find</div>' +
					searchItem +
					dupesItem +
					'<div class="fm-header">Compare</div>' +
					diffItem +
					'<div class="fm-header">Salesforce</div>' +
					_refreshItem +
					_migrateItem;
				document.body.appendChild(pop);
				const cleanup = () => {
					if (pop.parentNode) {
						pop.remove();
					}
					document.removeEventListener('mousedown', outside, true);
					document.removeEventListener('keydown', onEsc, true);
				};
				pop.querySelectorAll('button[data-bulk-op]').forEach((b) => {
					b.addEventListener('click', () => {
						const op = b.dataset.bulkOp;
						cleanup();
						const liveSelectedIds = canvasState.bulkRecords
							.filter((r) => !r.loadedFromId && !r.isTypeNode && canvasState.bulkSelectedIds.has(r.id))
							.map((r) => r.id);
						const scopeOpts = liveSelectedIds.length > 0 ? { tempIds: liveSelectedIds } : undefined;
						if (op === 'auto-fill') {
							_openAutoFillModal();
						} else if (op === 'bulk-edit') {
							openBulkEditModal();
						} else if (op === 'script') {
							openBulkScriptModal();
						} else if (op === 'search') {
							openCanvasSearchModal();
						} else if (op === 'find-dupes') {
							openFindDuplicatesModal();
						} else if (op === 'refresh-sf') {
							openBulkRefreshFlow();
						} else if (op === 'migrate-org') {
							beginMigration();
						} else if (op === 'diff') {
							const pair = canvasState.bulkRecords.filter(
								(r) => !r.isTypeNode && !r.isPending && canvasState.bulkSelectedIds.has(r.id),
							);
							if (pair.length === 2) {
								openRecordDiffModal(pair[0], pair[1]);
							}
						} else if (op === 'script-upgrade') {
							window.location.href = '/workspace/upgrade';
						} else if (op === 'script-not-granted') {
							if (isTeamAdmin()) {
								window.location.href = '/workspace#team';
							} else if (typeof window.olToast === 'function') {
								window.olToast(
									"Run script isn't enabled for your account. Ask a workspace admin to grant you access.",
									'info',
								);
							}
						}
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

			function showBulkHelpPopover(triggerEl) {
				document.querySelectorAll('.bulk-help-popup').forEach((el) => el.remove());
				const pop = document.createElement('div');
				pop.className = 'bulk-help-popup';
				const rect = triggerEl.getBoundingClientRect();
				const viewportW = window.innerWidth;
				const viewportH = window.innerHeight;
				const width = 320;
				const left = Math.min(rect.right - width, viewportW - width - 8);
				pop.style.left = Math.max(8, left) + 'px';
				const estimatedHeight = 280;
				const wouldOverflowBelow = rect.bottom + 6 + estimatedHeight > viewportH - 8;
				if (wouldOverflowBelow) {
					pop.style.bottom = viewportH - rect.top + 6 + 'px';
					pop.style.top = 'auto';
				} else {
					pop.style.top = rect.bottom + 6 + 'px';
				}
				pop.innerHTML =
					'<div class="bhp-header">Canvas shortcuts</div>' +
					'<ul>' +
					'<li><strong>Right-click</strong> on empty canvas to add a record at that point.</li>' +
					'<li><strong>Double-click</strong> a card to edit its fields.</li>' +
					'<li><strong>Drag</strong> a card to move it. Select several to move as a group.</li>' +
					'<li><strong>Drag from a card\u2019s edge</strong> to another card to connect them.</li>' +
					'<li><strong>Click an edge</strong>, then \u00D7 on its badge to disconnect.</li>' +
					'<li><strong>Ctrl/Cmd+Z</strong> to undo the last delete.</li>' +
					'<li>On the schema graph: <strong>click</strong> a related (dashed) node to add and navigate to it.</li>' +
					'</ul>';
				document.body.appendChild(pop);
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
			}

			window.Orgloom = window.Orgloom || {};
			window.Orgloom.canvasHelp = {
				openShortcuts: (anchorEl) => {
					if (anchorEl) {
						return showBulkHelpPopover(anchorEl);
					}
					const hint = document.getElementById('canvas-shortcut-hint');
					if (hint) {
						return showBulkHelpPopover(hint);
					}
					const synthetic = {
						getBoundingClientRect: () => {
							const w = 320;
							const x = (window.innerWidth - w) / 2;
							return { right: x + w, bottom: 80, left: x, top: 60, width: w, height: 20 };
						},
					};
					return showBulkHelpPopover(synthetic);
				},
			};

			function _openAutoFillModal() {
				// Freeze the scope when the modal opens so preview counts match the eventual action.
				const _realFilter = (r) => !r.isTypeNode && !r.isPending;
				const allRealRecords = canvasState.bulkRecords.filter(_realFilter);
				const allDrafts = allRealRecords.filter((r) => !r.loadedFromId);
				const allExisting = allRealRecords.filter((r) => r.loadedFromId);
				const allSelected = allRealRecords.filter((r) => canvasState.bulkSelectedIds.has(r.id));

				document.querySelectorAll('.auto-fill-modal').forEach((el) => el.remove());

				const overlay = document.createElement('div');
				overlay.className = 'modal auto-fill-modal';
				const scopeDraftCount = allDrafts.length;
				const scopeExistingCount = allExisting.length;
				const scopeSelCount = allSelected.length;
				const initialScope = scopeSelCount > 0 ? 'selected' : 'drafts';
				const initialMode = 'required';

				function recordsForScope(scope) {
					if (scope === 'drafts') {
						return allDrafts;
					}
					if (scope === 'existing') {
						return allExisting;
					}
					if (scope === 'selected') {
						return allSelected;
					}
					return [];
				}
				function includeLoadedForScope(scope) {
					return scope !== 'drafts';
				}

				function countFillTargets(records, mode) {
					// Relationship fields are counted separately because sample text cannot satisfy a lookup.
					let total = 0;
					for (const rec of records) {
						const desc = canvasState.describeCache && canvasState.describeCache[rec.objectName];
						if (!desc || !Array.isArray(desc.fields)) {
							return null;
						}
						const values = rec.values || {};
						if (mode === 'clear') {
							for (const k of Object.keys(values)) {
								if (k && !k.startsWith('_') && values[k] != null && values[k] !== '') {
									total++;
								}
							}
							continue;
						}
					}
					return summarizeAutoFillTargets(records, mode, 'both');
				}

				function recordNoun(n) {
					return n === 1 ? 'record' : 'records';
				}

				function renderCountLine(mode, scope) {
					const records = recordsForScope(scope);
					if (records.length === 0) {
						const altHint =
							scope === 'drafts'
								? 'No drafts on the canvas.'
								: scope === 'existing'
									? 'No loaded Salesforce records on the canvas.'
									: 'No records selected.';
						return '<em>' + altHint + '</em>';
					}
					const count = countFillTargets(records, mode);
					const noun = recordNoun(records.length);
					const includesLoaded = scope !== 'drafts' && records.some((r) => r.loadedFromId);
					const sfHint = includesLoaded
						? mode === 'clear'
							? '<span class="af-preview-hint"> Includes Salesforce-loaded records; next upload will NULL those fields in Salesforce.</span>'
							: '<span class="af-preview-hint"> Includes Salesforce-loaded records: only empty fields are filled; the next upload pushes the new values to Salesforce.</span>'
						: '';
					if (count == null) {
						return (
							'Across <strong>' +
							records.length +
							'</strong> ' +
							noun +
							'. ' +
							'<span class="af-preview-hint">' +
							'(Open one of these records once to load its schema and see the exact count.)' +
							'</span>' +
							sfHint
						);
					}
					if (mode === 'clear') {
						return (
							'<strong>' +
							count +
							'</strong> field value' +
							(count === 1 ? '' : 's') +
							' across <strong>' +
							records.length +
							'</strong> ' +
							noun +
							' will be cleared.' +
							sfHint
						);
					}
					const fillableCount = count.fillableFields;
					const relationshipCount = count.unresolvedRelationships;
					const relationshipHint =
						relationshipCount > 0
							? ' <span class="af-preview-hint"><strong>' +
								relationshipCount +
								'</strong>' +
								(mode === 'required' ? ' required' : '') +
								' relationship' +
								(relationshipCount === 1 ? '' : 's') +
								' still need' +
								(relationshipCount === 1 ? 's' : '') +
								' a canvas connection.</span>'
							: '';
					if (fillableCount === 0 && relationshipCount === 0) {
						return (
							'Nothing to do: every ' +
							(mode === 'required' ? 'required ' : '') +
							'field already has a value across the <strong>' +
							records.length +
							'</strong> ' +
							noun +
							' in scope.'
						);
					}
					const fillPreview =
						fillableCount > 0
							? '<strong>' +
								fillableCount +
								'</strong> empty ' +
								(mode === 'required' ? 'required ' : '') +
								'field' +
								(fillableCount === 1 ? '' : 's') +
								' across <strong>' +
								records.length +
								'</strong> ' +
								noun +
								' will be filled.'
							: 'No sample values can be added to the fields in scope.';
					return fillPreview + relationshipHint + sfHint;
				}

				overlay.innerHTML =
					'<div class="modal-overlay" data-af-cancel></div>' +
					'<div class="modal-body" style="max-width:520px">' +
					'<div class="modal-header">' +
					'<h3>Fill or clear records</h3>' +
					'<button class="modal-close" data-af-cancel>&times;</button>' +
					'</div>' +
					'<div class="modal-content">' +
					'<div class="af-scope">' +
					'<div class="af-label">Scope</div>' +
					'<div class="af-scope-options">' +
					'<label class="af-scope-opt' +
					(initialScope === 'drafts' ? ' af-scope-opt--active' : '') +
					(scopeDraftCount === 0 ? ' af-scope-opt--disabled' : '') +
					'">' +
					'<input type="radio" name="af-scope" value="drafts"' +
					(initialScope === 'drafts' ? ' checked' : '') +
					(scopeDraftCount === 0 ? ' disabled' : '') +
					'>' +
					'<span>All drafts</span>' +
					'<span class="tag">' +
					scopeDraftCount +
					'</span>' +
					'</label>' +
					'<label class="af-scope-opt' +
					(initialScope === 'existing' ? ' af-scope-opt--active' : '') +
					(scopeExistingCount === 0 ? ' af-scope-opt--disabled' : '') +
					'">' +
					'<input type="radio" name="af-scope" value="existing"' +
					(initialScope === 'existing' ? ' checked' : '') +
					(scopeExistingCount === 0 ? ' disabled' : '') +
					'>' +
					'<span>All existing</span>' +
					'<span class="tag">' +
					scopeExistingCount +
					'</span>' +
					'</label>' +
					'<label class="af-scope-opt' +
					(initialScope === 'selected' ? ' af-scope-opt--active' : '') +
					(scopeSelCount === 0 ? ' af-scope-opt--disabled' : '') +
					'">' +
					'<input type="radio" name="af-scope" value="selected"' +
					(initialScope === 'selected' ? ' checked' : '') +
					(scopeSelCount === 0 ? ' disabled' : '') +
					'>' +
					'<span>Selected</span>' +
					'<span class="tag">' +
					scopeSelCount +
					'</span>' +
					'</label>' +
					'</div>' +
					'</div>' +
					'<div class="af-actions" role="radiogroup" aria-label="Mode">' +
					'<button type="button" class="af-action-card af-action-card--required af-action-card--selected" data-af-mode="required" aria-pressed="true">' +
					'<div class="af-action-title">Fill required fields</div>' +
					'<div class="af-action-sub">Empty required fields get sample data. Required relationships still need canvas connections. Existing values are never overwritten.</div>' +
					'</button>' +
					'<button type="button" class="af-action-card af-action-card--all" data-af-mode="all" aria-pressed="false">' +
					'<div class="af-action-title">Fill all fields</div>' +
					'<div class="af-action-sub">Empty writable fields get sample data. Relationship fields still need canvas connections. Existing values are never overwritten.</div>' +
					'</button>' +
					'<button type="button" class="af-action-card af-action-card--clear" data-af-mode="clear" aria-pressed="false">' +
					'<div class="af-action-title">Clear all fields</div>' +
					'<div class="af-action-sub">Wipe every value from records in scope. Destructive: on loaded records, the next upload writes NULL back to Salesforce.</div>' +
					'</button>' +
					'</div>' +
					'<div class="af-preview" data-af-preview>' +
					renderCountLine(initialMode, initialScope) +
					'</div>' +
					'</div>' +
					'<div class="modal-footer">' +
					'<button class="button secondary" data-af-cancel>Cancel</button>' +
					'<button class="button" data-af-run>Run</button>' +
					'</div>' +
					'</div>';
				document.body.appendChild(overlay);

				let _mode = initialMode;
				let _scope = initialScope;
				const previewEl = overlay.querySelector('[data-af-preview]');
				function refreshPreview() {
					previewEl.innerHTML = renderCountLine(_mode, _scope);
				}

				function cleanup() {
					overlay.remove();
					document.removeEventListener('keydown', onKey, true);
				}
				function onKey(e) {
					if (e.key === 'Escape') {
						cleanup();
					} else if (e.key === 'Enter') {
						run();
					}
				}
				document.addEventListener('keydown', onKey, true);

				overlay.querySelectorAll('[data-af-cancel]').forEach((el) => {
					el.addEventListener('click', cleanup);
				});

				overlay.querySelectorAll('input[name="af-scope"]').forEach((input) => {
					input.addEventListener('change', () => {
						_scope = input.value;
						overlay.querySelectorAll('.af-scope-opt').forEach((opt) => {
							const child = opt.querySelector('input');
							opt.classList.toggle('af-scope-opt--active', !!(child && child.checked));
						});
						refreshPreview();
					});
				});

				overlay.querySelectorAll('[data-af-mode]').forEach((btn) => {
					btn.addEventListener('click', () => {
						_mode = btn.getAttribute('data-af-mode');
						overlay.querySelectorAll('[data-af-mode]').forEach((b) => {
							const active = b === btn;
							b.classList.toggle('af-action-card--selected', active);
							b.setAttribute('aria-pressed', active ? 'true' : 'false');
						});
						const runBtn = overlay.querySelector('[data-af-run]');
						if (runBtn) {
							runBtn.classList.toggle('danger', _mode === 'clear');
						}
						refreshPreview();
					});
				});

				function run() {
					const records = recordsForScope(_scope);
					if (records.length === 0) {
						return;
					}
					const includeLoaded = includeLoadedForScope(_scope);
					const scopeOpts = {
						tempIds: records.map((r) => r.id),
						includeLoaded: includeLoaded,
						selectionScope: _scope === 'selected',
					};
					cleanup();
					if (_mode === 'required') {
						bulkAutoFill('required', 'both', scopeOpts);
					} else if (_mode === 'all') {
						bulkAutoFill('all', 'both', scopeOpts);
					} else if (_mode === 'clear') {
						bulkClearAllFields(scopeOpts);
					}
				}
				overlay.querySelector('[data-af-run]').addEventListener('click', run);
			}

			return {
				_wireCanvasFloatingAdd: _wireCanvasFloatingAdd,
				_showCanvasContextMenu: _showCanvasContextMenu,
				showAddRecordsMenu: showAddRecordsMenu,
				showBulkOperationsMenu: showBulkOperationsMenu,
				showBulkHelpPopover: showBulkHelpPopover,
			};
		},
	};
})();
