(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.recordsCanvas = {
		mount: function mount(deps) {
			const required = [
				'canvasState', 'escapeHtml', 'showBulkToast', 'isRecordModified',
				'recordOrdinal', 'attachCyEdgeMarkers', 'attachCyMarqueeSelect',
				'attachCyMiddleClickPan', 'attachCySpacePan', 'openInsertModal',
				'showFindObjectPopover', 'renderBulkView', 'renderCanvas',
				'_runAfterSchemaTransition', '_isEmptySlot', '_slotAssigneeBadgeHtml',
				'_slotAssignmentCardClass', '_slotAssignmentState', '_slotPreflightWarn',
				'_slotProgress', '_slotProgressClass', '_ensureChipProbed',
				'_relInfoForRec', '_showStaleRefMenu', '_isRecordStale',
				'fillSlotWithBlank', 'fillSlotWithLoad', 'deleteRecord',
				'onRecordClick', 'finalizeAssociation', 'openTypeNode',
				'resolvePendingRecord', 'resolvePendingRecordToLoad',
				'showCardMoreMenu', 'showRelatedPopover', 'getGraph',
				'getCyInstance', 'setCyInstance', 'getObjectFilterHidden',
				'getSelectedDerivedEdge', 'setSelectedDerivedEdge',
				'getCyPendingEdge', 'setCyPendingEdge', 'getCySchemaInstance',
				'getSkipNextCyAutoPan', 'setSkipNextCyAutoPan',
				'unmarkPendingDelete',
			];
			if (!deps) {
throw new Error('records-canvas.mount: missing deps object');
}
			for (const k of required) {
				if (deps[k] === undefined || deps[k] === null) {
					throw new Error('records-canvas.mount: missing dep ' + k);
				}
			}
			const canvasState = deps.canvasState;
			const escapeHtml = deps.escapeHtml;
			const showBulkToast = deps.showBulkToast;
			const isRecordModified = deps.isRecordModified;
			const recordOrdinal = deps.recordOrdinal;
			const attachCyEdgeMarkers = deps.attachCyEdgeMarkers;
			const attachCyMarqueeSelect = deps.attachCyMarqueeSelect;
			const attachCyMiddleClickPan = deps.attachCyMiddleClickPan;
			const attachCySpacePan = deps.attachCySpacePan;
			const openInsertModal = deps.openInsertModal;
			const showFindObjectPopover = deps.showFindObjectPopover;
			const renderBulkView = deps.renderBulkView;
			const renderCanvas = deps.renderCanvas;
			const _runAfterSchemaTransition = deps._runAfterSchemaTransition;
			const _isEmptySlot = deps._isEmptySlot;
			const _slotAssigneeBadgeHtml = deps._slotAssigneeBadgeHtml;
			const _slotAssignmentCardClass = deps._slotAssignmentCardClass;
			const _slotAssignmentState = deps._slotAssignmentState;
			const _slotPreflightWarn = deps._slotPreflightWarn;
			const _slotProgress = deps._slotProgress;
			const _slotProgressClass = deps._slotProgressClass;
			const _ensureChipProbed = deps._ensureChipProbed;
			const _relInfoForRec = deps._relInfoForRec;
			const _showStaleRefMenu = deps._showStaleRefMenu;
			const _isRecordStale = deps._isRecordStale;
			const fillSlotWithBlank = deps.fillSlotWithBlank;
			const fillSlotWithLoad = deps.fillSlotWithLoad;
			const deleteRecord = deps.deleteRecord;
			const onRecordClick = deps.onRecordClick;
			const finalizeAssociation = deps.finalizeAssociation;
			const openTypeNode = deps.openTypeNode;
			const resolvePendingRecord = deps.resolvePendingRecord;
			const resolvePendingRecordToLoad = deps.resolvePendingRecordToLoad;
			const showCardMoreMenu = deps.showCardMoreMenu;
			const showRelatedPopover = deps.showRelatedPopover;
			const getGraph = deps.getGraph;
			const getCyInstance = deps.getCyInstance;
			const setCyInstance = deps.setCyInstance;
			const getObjectFilterHidden = deps.getObjectFilterHidden;
			const getSelectedDerivedEdge = deps.getSelectedDerivedEdge;
			const setSelectedDerivedEdge = deps.setSelectedDerivedEdge;
			const getCyPendingEdge = deps.getCyPendingEdge;
			const setCyPendingEdge = deps.setCyPendingEdge;
			const getCySchemaInstance = deps.getCySchemaInstance;
			const getSkipNextCyAutoPan = deps.getSkipNextCyAutoPan;
			const setSkipNextCyAutoPan = deps.setSkipNextCyAutoPan;
			const unmarkPendingDelete = deps.unmarkPendingDelete;

			function renderBulkCanvasCy() {
				const container = getGraph().querySelector('#bulk-canvas-cy');
				if (!container) {
return;
}
				if (typeof cytoscape !== 'function') {
					container.innerHTML = '<div class="bulk-empty" style="padding:1em">Cytoscape failed to load (check /vendor/cytoscape route).</div>';
					return;
				}

				const _cyCardHtml = (rec) => {
					if (rec.isPending) {
						let pcls = 'record-card record-card-pending';
						if (canvasState.bulkSelectedIds.has(rec.id)) {
pcls += ' selected';
}
						return '<div class="cy-card-shell"><div class="' + pcls + '" data-rec-id="' + rec.id + '">' +
							'<button class="record-delete" data-record-delete title="Remove">\u00D7</button>' +
							'<div class="record-pending-title">New record</div>' +
							'<div class="record-pending-ctas">' +
								'<button class="record-pending-cta record-pending-cta-blank" data-pending-pick-blank>+ Create blank</button>' +
								'<button class="record-pending-cta record-pending-cta-load" data-pending-pick-load title="Search and load an existing record from Salesforce">\u2197 Load existing</button>' +
							'</div>' +
						'</div></div>';
					}

					if (rec._inaccessible) {
						let ncls = 'record-card record-card-noaccess';
						if (canvasState.bulkSelectedIds.has(rec.id)) {
ncls += ' selected';
}
						const objLabel = rec.label || rec.objectName;

						if (_isRecordStale(rec)) {
							return '<div class="cy-card-shell"><div class="' + ncls + ' record-card-stale" data-rec-id="' + rec.id + '" ' +
								'title="This record was deleted in Salesforce — or your access to it was removed — after it was loaded onto the canvas. Uploading changes to it will fail until you resolve it.">' +
								'<div class="record-noaccess-tag record-stale-badge">deleted in SF</div>' +
								'<div class="record-noaccess-type">' + escapeHtml(objLabel) + '</div>' +
								'<div class="record-noaccess-note">This record is no longer reachable in Salesforce.</div>' +
								'<button type="button" class="record-stale-action" data-stale-menu="' + rec.id + '" title="Choose how to handle this stale reference">fix \u25BE</button>' +
							'</div></div>';
						}
						return '<div class="cy-card-shell"><div class="' + ncls + '" data-rec-id="' + rec.id + '" ' +
							'title="This record is referenced by the canvas but Salesforce didn\u2019t return it for your user.">' +
							'<div class="record-noaccess-tag">\uD83D\uDD12 No access</div>' +
							'<div class="record-noaccess-type">' + escapeHtml(objLabel) + '</div>' +
							'<div class="record-noaccess-note">Referenced record not returned by Salesforce</div>' +
						'</div></div>';
					}

					if (_isEmptySlot(rec)) {
						let scls = 'record-card record-card-slot';
						if (canvasState.bulkSelectedIds.has(rec.id)) {
scls += ' selected';
}
						scls += _slotAssignmentCardClass(rec);
						const slotLabel = rec.slot && rec.slot.label ? rec.slot.label : 'Slot';
						const desc = rec.slot && rec.slot.description ? rec.slot.description : '';
						const objLabel = rec.label || rec.objectName;
						const warnBadge = _slotPreflightWarn(rec)
							? '<span class="record-slot-warn" title="You may not have access to records of this type.">\u26A0</span>'
							: '';
						const assigneeBadge = _slotAssigneeBadgeHtml(rec);
						const isLocked = _slotAssignmentState(rec) === 'other';
						const ctas = isLocked
							? '<div class="record-slot-locked-note">Reserved for ' + escapeHtml(rec.slot.assigneeName || rec.slot.assigneeEmail || 'another teammate') + ' \u2014 they need to fill this slot.</div>'
							: '<div class="record-slot-ctas">' +
								'<button class="record-slot-cta record-slot-cta-load" data-slot-fill-load title="Search and load an existing record into this slot">\u2197 Load existing</button>' +
								'<button class="record-slot-cta record-slot-cta-blank" data-slot-fill-blank title="Create a blank draft for this slot">+ Create blank</button>' +
							'</div>';
						return '<div class="cy-card-shell"><div class="' + scls + '" data-rec-id="' + rec.id + '">' +
							'<button class="record-delete" data-record-delete title="Remove">\u00D7</button>' +
							'<div class="record-slot-tag">SLOT' + warnBadge +
								(() => {
									const sp = _slotProgress(rec);
									return sp ? '<span class="slot-progress ' + _slotProgressClass(sp) + '" style="margin-left:0.4em">' + sp.filled + '/' + sp.total + '</span>' : '';
								})() +
								(assigneeBadge ? '<span style="margin-left:0.4em">' + assigneeBadge + '</span>' : '') +
							'</div>' +
							'<div class="record-slot-title">' + escapeHtml(slotLabel) + '</div>' +
							'<div class="record-slot-type">' + escapeHtml(objLabel) + '</div>' +
							(desc ? '<div class="record-slot-desc">' + escapeHtml(desc) + '</div>' : '') +
							ctas +
						'</div></div>';
					}
					const isExisting = !!rec.loadedFromId;
					const isModified = isExisting && isRecordModified(rec);
					const isPendingDelete = isExisting && !!rec.pendingDelete;
					let cls = 'record-card';

					if (isPendingDelete) {
cls += ' has-pending-delete';
} else if (isModified) {
cls += ' has-modified';
} else if (isExisting) {
cls += ' has-existing';
} else {
cls += ' has-draft';
}
					if (canvasState.bulkSelectedIds.has(rec.id)) {
cls += ' selected';
}
					if (getCyPendingEdge() && getCyPendingEdge().srcRec && getCyPendingEdge().srcRec.id === rec.id) {
cls += ' connect-source';
}
					if (getCyPendingEdge() && getCyPendingEdge().hoverTargetId === rec.id) {
cls += ' connect-target';
}

					if (rec._refreshPulse) {
cls += ' record-card-just-refreshed';
}
					if (rec._deletedInSf && !rec._staleAck) {
cls += ' record-card-deleted-in-sf';
}
					cls += _slotAssignmentCardClass(rec);
					const titleText = (() => {
						if (rec.values) {
							const fn = rec.values.FirstName, ln = rec.values.LastName;
							if (fn != null || ln != null) {
								const composed = ((fn || '') + ' ' + (ln || '')).trim();
								if (composed) {
return composed;
}
							}
							const desc = canvasState.describeCache[rec.objectName];
							if (desc && Array.isArray(desc.fields)) {
								const nf = desc.fields.find((f) => f.nameField);
								if (nf && rec.values[nf.name]) {
return String(rec.values[nf.name]);
}
							}

							const generic = rec.values.Name || rec.values.CaseNumber || rec.values.OrderNumber || rec.values.WorkOrderNumber || rec.values.Subject || rec.values.Title;
							if (generic) {
return String(generic);
}
						}
						return isExisting ? '(no title)' : '(no name yet)';
					})();
					let badge;
					if (isPendingDelete) {
badge = '<span class="record-pending-delete-badge" title="Staged for SF DELETE on next upload. Click Keep to unmark.">delete on upload</span>';
} else if (isModified) {
badge = '<span class="record-modified-badge" title="Unsaved changes since load — Upload to Salesforce will push them">modified</span>';
} else if (isExisting) {
badge = '<span class="record-existing-badge" title="Loaded from Salesforce id ' + escapeHtml(rec.loadedFromId) + '">existing</span>';
} else {
badge = '<span class="record-draft-badge">draft</span>';
}

					const _mig = window.Orgloom && window.Orgloom.canvasMigrate;
					if (_mig && _mig.isActive()) {
						const _ann = _mig.annotationFor(rec.id);
						if (_ann && _ann.status && _ann.status !== 'ready') {
							const _n = Array.isArray(_ann.issues) ? _ann.issues.length : 0;
							const _issueText = _n === 1 ? '1 issue' : _n + ' issues';
							if (_ann.status === 'blocked') {
								badge += '<span class="record-migrate-badge record-migrate-blocked" title="This record can’t be migrated yet — ' + _issueText + ' must be resolved. Open the record to fix them.">blocked</span>';
							} else if (_ann.status === 'warning') {
								badge += '<span class="record-migrate-badge record-migrate-warning" title="This record will migrate, but ' + _issueText + ' will be skipped or dropped (missing fields / picklist values). Open the record to review.">review</span>';
							} else if (_ann.status === 'pending') {
								badge += '<span class="record-migrate-badge record-migrate-pending" title="Checking this record against the destination org…">checking…</span>';
							}
						}
					}

					if (_isRecordStale(rec)) {
						badge += '<span class="record-stale-badge" title="This record was deleted in Salesforce — or your access to it was removed — after it was loaded onto the canvas. Uploading changes to it will fail until you resolve it.">deleted in SF</span>';
						badge += '<button type="button" class="record-stale-action" data-stale-menu="' + rec.id + '" title="Choose how to handle this stale reference">fix ▾</button>';
					}

					if (Array.isArray(rec._loadedFieldNames)) {
						const n = rec._loadedFieldNames.length;
						badge += '<span class="record-partial-badge" title="Loaded with ' + n + ' field' + (n === 1 ? '' : 's') + ' only — the rest are preserved on Salesforce, not editable here. Re-import via SOQL with Load all fields checked to see them.">partial</span>';
					}

					if (rec.values && rec._wasLoadedFromOrgId) {
						const _desc = canvasState.describeCache && canvasState.describeCache[rec.objectName];
						if (_desc && Array.isArray(_desc.fields)) {
							const _knownFieldNames = new Set(_desc.fields.map((f) => f.name));
							const _systemFields = new Set([
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
							const _orphanCount = Object.keys(rec.values).filter((k) =>
								k && !k.startsWith('_')
									&& !_systemFields.has(k)
									&& !_knownFieldNames.has(k),
							).length;
							if (_orphanCount > 0) {
								badge += '<span class="record-orphan-badge" title="' + _orphanCount + ' field value' +
									(_orphanCount === 1 ? '' : 's') +
									' on this record reference field' +
									(_orphanCount === 1 ? '' : 's') +
									' that don\'t exist on this org. Open the record to drop or remap them.">' +
									_orphanCount + ' carry-over</span>';
							}
						}
					}
					const slotBadge = (rec.slot && rec.slot.slotId != null)
						? '<span class="record-slot-badge" title="Marked as slot for recipients of this canvas. Label: ' + escapeHtml(rec.slot.label || '') + '">slot</span>'
						: '';
					const slotProgress = _slotProgress(rec);
					const slotProgressBadge = slotProgress
						? '<span class="slot-progress ' + _slotProgressClass(slotProgress) + '" title="' +
							(slotProgress.filled === slotProgress.total
								? 'All slot fields filled.'
								: slotProgress.filled + ' of ' + slotProgress.total + ' slot field' + (slotProgress.total === 1 ? '' : 's') + ' filled.') +
							'">' + slotProgress.filled + '/' + slotProgress.total + '</span>'
						: '';
					const assigneeBadge = _slotAssigneeBadgeHtml(rec);
					badge = badge + slotBadge + slotProgressBadge + assigneeBadge;

					const sfBase = (window.SF_INSTANCE_URL || '').replace(/\/+$/, '');
					const lightningUrl = (isExisting && rec.loadedFromId && sfBase)
						? sfBase + '/lightning/r/' + encodeURIComponent(rec.objectName) + '/' + encodeURIComponent(rec.loadedFromId) + '/view'
						: null;
					const titleInner = lightningUrl
						? '<a class="record-title-link" href="' + escapeHtml(lightningUrl) + '" target="_blank" rel="noopener" title="Open in Salesforce \u2197">' + escapeHtml(titleText) + '</a>'
						: escapeHtml(titleText);

					let chipHtml = '';
					if (isExisting) {
						chipHtml = '<button class="record-related-chip" data-related-pick title="See records related to this one">' +
							'\u2194 Find related' +
						'</button>';
					}

				const moreBtn = '<button class="record-more" data-card-more title="More actions">\u22EE</button>';

				const keepBtn = isPendingDelete
					? '<button class="record-keep" data-card-keep title="Unmark \u2014 cancels the delete">Keep</button>'
					: '';
					return '<div class="cy-card-shell"><div class="' + cls + '" data-rec-id="' + rec.id + '">' +
						badge +
						keepBtn +
						moreBtn +
						'<div class="record-title">' + titleInner + '</div>' +
						'<div class="record-type">' +
							'<span class="record-type-tag">' + escapeHtml(rec.label || rec.objectName) + '</span>' +
							'<span class="record-ordinal">#' + recordOrdinal(rec) + '</span>' +
						'</div>' +
						chipHtml +
					'</div></div>';
				};

				const titleFor = (rec) => {
					if (rec.isPending) {
return 'Blank record';
}
					if (rec._inaccessible) {
return 'No access';
}
					if (rec.isTypeNode) {
return rec.label || rec.objectName;
}
					if (rec.values) {
						const fn = rec.values.FirstName, ln = rec.values.LastName;
						if (fn != null || ln != null) {
							const composed = ((fn || '') + ' ' + (ln || '')).trim();
							if (composed) {
return composed;
}
						}
						const desc = canvasState.describeCache[rec.objectName];
						if (desc && Array.isArray(desc.fields)) {
							const nf = desc.fields.find((f) => f.nameField);
							if (nf && rec.values[nf.name]) {
return String(rec.values[nf.name]);
}
						}
						const generic = rec.values.Name || rec.values.Subject || rec.values.Title;
						if (generic) {
return String(generic);
}
					}
					return rec.loadedFromId ? '(no title)' : '(no name yet)';
				};

				const labelFor = (rec) => {
					if (rec.isPending) {
return 'Blank record';
}
					if (rec._inaccessible) {
return 'No access\n' + (rec.label || rec.objectName);
}
					if (rec.isTypeNode) {
return rec.label || rec.objectName;
}
					const title = titleFor(rec);
					const tag = (rec.label || rec.objectName) + ' #' + recordOrdinal(rec);
					return title + '\n' + tag;
				};

				const _hiddenRecIds = new Set();
				if (getObjectFilterHidden() && getObjectFilterHidden().size > 0) {
					canvasState.bulkRecords.forEach((r) => {
						if (r && r.isTypeNode && r.objectName && getObjectFilterHidden().has(r.objectName)) {
							_hiddenRecIds.add(r.id);
						}
					});
				}

				const elements = [];
				canvasState.bulkRecords.forEach((r) => {
					if (_hiddenRecIds.has(r.id)) {
return;
}
					if (r._chipLoader) {
return;
}
					let kind;
					if (r.isPending) {
						kind = 'card-pending';
					} else if (r._inaccessible) {
						kind = 'card-noaccess';
					} else if (_isEmptySlot(r)) {
						kind = 'card-slot';
					} else if (r.isTypeNode) {
						if (r.isFreeTypeNode) {
kind = 'tn-free';
} else if (r.direction === 'child') {
kind = 'tn-child';
} else {
kind = 'tn-parent';
}
					} else if (r.loadedFromId) {
						kind = isRecordModified(r) ? 'card-modified' : 'card-existing';
					} else {
						kind = 'card-draft';
					}
					elements.push({
						group: 'nodes',

						data: { id: 'r' + r.id, recId: r.id, kind, label: labelFor(r), boxW: 220, boxH: 110, pendingDelete: r.pendingDelete ? 1 : 0 },
						position: { x: typeof r.x === 'number' ? r.x : 0, y: typeof r.y === 'number' ? r.y : 0 },
						grabbable: true,
						selectable: !r.isTypeNode || r.isPending,
					});
				});
				canvasState.bulkAssociations.forEach((a) => {
					if (_hiddenRecIds.has(a.fromId) || _hiddenRecIds.has(a.toId)) {
return;
}
					elements.push({
						group: 'edges',
						data: { id: 'a' + a.id, source: 'r' + a.fromId, target: 'r' + a.toId, label: a.fieldName || '', kind: 'fk' },
					});
				});

				{
					const idKey15 = (i) => (i ? String(i).slice(0, 15) : '');
					const assocKeys = new Set();
					canvasState.bulkAssociations.forEach((a) => assocKeys.add(a.fromId + '->' + a.toId + '::' + (a.fieldName || '')));
					const recByLoadedId = new Map();
					canvasState.bulkRecords.forEach((r) => {
						if (r.isTypeNode || !r.loadedFromId) {
return;
}
						recByLoadedId.set(idKey15(r.loadedFromId), r);
					});
					const derivedKeys = new Set();
					canvasState.bulkRecords.forEach((r) => {
						if (r.isTypeNode || _hiddenRecIds.has(r.id) || !r.values) {
return;
}
						for (const fieldName in r.values) {
							const val = r.values[fieldName];
							if (typeof val !== 'string' || val.length < 15) {
continue;
}
							const tgt = recByLoadedId.get(idKey15(val));
							if (!tgt || tgt.id === r.id || _hiddenRecIds.has(tgt.id)) {
continue;
}
							const k = r.id + '->' + tgt.id + '::' + fieldName;
							if (assocKeys.has(k) || derivedKeys.has(k)) {
continue;
}
							derivedKeys.add(k);
							elements.push({
								group: 'edges',
								data: { id: 'd' + r.id + '_' + fieldName, source: 'r' + r.id, target: 'r' + tgt.id, label: fieldName, kind: 'fk', holderRecId: r.id, fkFieldName: fieldName },
							});
						}
					});
				}
				canvasState.bulkRecords.forEach((r) => {
					if (_hiddenRecIds.has(r.id)) {
return;
}
					if (r._chipLoader) {
return;
}
					if (r.hostRecordId != null && _hiddenRecIds.has(r.hostRecordId)) {
return;
}
					if (r.isTypeNode && r.hostRecordId != null) {

						const fieldName = r.fieldOnOther || r.fieldOnThis || '';
						const manyIsTypeNode = r.direction === 'child';
						const sourceId = manyIsTypeNode ? 'r' + r.id : 'r' + r.hostRecordId;
						const targetId = manyIsTypeNode ? 'r' + r.hostRecordId : 'r' + r.id;
						elements.push({
							group: 'edges',
							data: { id: 'h' + r.id, source: sourceId, target: targetId, kind: 'host', label: fieldName },
						});
					}
				});

				const isFirstRender = !getCyInstance();
				const newRealNodeIds = [];
				if (!getCyInstance()) {
					setCyInstance(cytoscape({
						container,
						elements,
						style: [
							{

								selector: 'core',
								style: {
									'selection-box-color': '#d68b3c',
									'selection-box-border-color': '#d68b3c',
									'selection-box-border-width': 1,
									'selection-box-opacity': 0.12,
									'active-bg-opacity': 0,
								},
							},
							{
								selector: 'node',
								style: {
									label: 'data(label)',
									'text-valign': 'center', 'text-halign': 'center',
									'text-wrap': 'wrap',
									'font-family': 'system-ui, sans-serif',
									color: '#e8e6e1',

									'overlay-opacity': 0,
								},
							},
							{

								selector: 'node[kind ^= "card"]',
								style: {
									shape: 'round-rectangle',
									width: 'data(boxW)',
									height: 'data(boxH)',
									'background-opacity': 0,
									'border-opacity': 0,
									label: '',
								},
							},
							{
								selector: 'node[kind ^= "tn-"]',
								style: {
									shape: 'ellipse',
									width: 80, height: 80,
									'background-color': '#1c2226',
									'border-width': 2,
									'text-max-width': 66,
									'font-size': 10,
									color: '#cfd6df',
								},
							},
							{ selector: 'node[kind = "tn-parent"]', style: { 'border-color': '#7ac96a' } },
							{ selector: 'node[kind = "tn-child"]', style: { 'border-color': '#6fa9d6' } },
							{ selector: 'node[kind = "tn-free"]', style: { 'border-color': '#d68b3c', 'border-style': 'dashed' } },
							{ selector: 'node:selected', style: { 'border-color': '#d68b3c', 'border-width': 3 } },

							{
								selector: 'node.csr-flash',
								style: {
									'border-color': '#f0c244',
									'border-width': 4,
									'overlay-color': '#f0c244',
									'overlay-opacity': 0.18,
									'overlay-padding': 12,
								},
							},
							{
								selector: 'edge',
								style: {
									width: 1.5,
									'line-color': '#5a6068',
									'curve-style': 'bezier',
									'target-arrow-shape': 'triangle',
									'target-arrow-color': '#5a6068',
									label: 'data(label)',
									'font-size': 10,
									color: '#9aa0a8',
									'text-rotation': 'autorotate',
									'text-background-color': '#15171b',
									'text-background-opacity': 0.85,
									'text-background-padding': 2,
									'overlay-padding': 8,
									'overlay-opacity': 0,
								},
							},
							{

								selector: 'edge[kind = "fk"]',
								style: { 'target-arrow-shape': 'none' },
							},
							{
								selector: 'edge[kind = "fk"].edge-picked',
								style: {
									'line-color': '#f0a050',
									width: 3,
									color: '#1a1c20',
									'text-background-color': '#f0a050',
									'text-background-opacity': 1,
									'text-background-padding': 3,
									'font-weight': 600,
								},
							},
							{
								selector: 'edge[kind = "host"]',
								style: {
									'line-color': '#3a3f47',
									'line-style': 'dashed',
									'target-arrow-shape': 'none',
								},
							},
						],
						layout: { name: 'preset' },

						userZoomingEnabled: false,

						userPanningEnabled: false,
						boxSelectionEnabled: false,

						autounselectify: true,
					}));

					attachCyMiddleClickPan(getCyInstance(), container);
					attachCySpacePan(getCyInstance(), container);
					attachCyEdgeMarkers(getCyInstance(), container);

					document.addEventListener('wheel', (ev) => {
						if (!getCyInstance()) {
return;
}

						if (!container.contains(ev.target)) {
return;
}
						const rect = container.getBoundingClientRect();
						if (ev.clientX < rect.left || ev.clientX > rect.right
								|| ev.clientY < rect.top || ev.clientY > rect.bottom) {
return;
}

						if (ev.ctrlKey) {
ev.preventDefault();
}

						if (ev.deltaY === 0) {
return;
}
						if (!ev.ctrlKey) {
ev.preventDefault();
}
						const rx = ev.clientX - rect.left;
						const ry = ev.clientY - rect.top;
						const step = ev.deltaY > 0 ? 0.9 : 1.1;
						const cur = getCyInstance().zoom();
						const next = Math.max(0.2, Math.min(4, cur * step));
						if (next === cur) {
return;
}
						getCyInstance().zoom({ level: next, renderedPosition: { x: rx, y: ry } });
					}, { passive: false, capture: true });

					getCyInstance().on('tap', 'node', (evt) => {
						const recId = evt.target.data('recId');
						const rec = canvasState.bulkRecords.find((r) => r.id === recId);
						if (!rec) {
return;
}
						if (_isEmptySlot(rec)) {
							const oe = evt.originalEvent;
							const cardEl = container.querySelector('.record-card[data-rec-id="' + rec.id + '"]');
							const _hits = (el) => {
								if (!el || !oe) {
return false;
}
								const r = el.getBoundingClientRect();
								return oe.clientX >= r.left && oe.clientX <= r.right &&
									oe.clientY >= r.top && oe.clientY <= r.bottom;
							};
							const delBtn = cardEl && cardEl.querySelector('[data-record-delete]');
							if (_hits(delBtn)) {
 deleteRecord(rec.id); return; 
}
							const loadBtn = cardEl && cardEl.querySelector('[data-slot-fill-load]');
							if (_hits(loadBtn)) {
 fillSlotWithLoad(rec, loadBtn); return; 
}
							const blankBtn = cardEl && cardEl.querySelector('[data-slot-fill-blank]');
							if (_hits(blankBtn)) {
 fillSlotWithBlank(rec); return; 
}
							const additive = !!(oe && (oe.metaKey || oe.ctrlKey || oe.shiftKey));
							onRecordClick(rec, { additive });
							return;
						}
						if (rec.isPending) {

							const oe = evt.originalEvent;
							const cardEl = container.querySelector('.record-card-pending[data-rec-id="' + rec.id + '"]');
							const hitInRect = (el) => {
								if (!el || !oe) {
return false;
}
								const r = el.getBoundingClientRect();
								return oe.clientX >= r.left && oe.clientX <= r.right &&
									oe.clientY >= r.top && oe.clientY <= r.bottom;
							};
							const blankBtn = cardEl && cardEl.querySelector('[data-pending-pick-blank]');
							const loadBtn = cardEl && cardEl.querySelector('[data-pending-pick-load]');
							const deleteBtn = cardEl && cardEl.querySelector('[data-record-delete]');
							if (hitInRect(deleteBtn)) {
								deleteRecord(rec.id);
								return;
							}
							if (hitInRect(blankBtn)) {
								showFindObjectPopover(blankBtn, {
									header: 'Create blank record',
									sub: 'Pick the object type for this blank draft.',
									isAdded: () => false,
									onPick: (name) => resolvePendingRecord(rec.id, name),
								});
								return;
							}
							if (hitInRect(loadBtn)) {
								showFindObjectPopover(loadBtn, {
									header: 'Load existing record',
									sub: 'Pick the object type, then search by name or paste a record ID.',
									isAdded: () => false,
									onPick: (name) => resolvePendingRecordToLoad(rec.id, name),
								});
								return;
							}
							const additive = !!(oe && (oe.metaKey || oe.ctrlKey || oe.shiftKey));
							onRecordClick(rec, { additive });
							return;
						}
						if (rec.isTypeNode) {
							if (!rec._loading) {
openTypeNode(rec);
}
							return;
						}

						{
							const oe = evt.originalEvent;
							const cardEl = container.querySelector('.record-card[data-rec-id="' + rec.id + '"]');
							const _hitsRect = (el) => {
								if (!el || !oe) {
return false;
}
								const r = el.getBoundingClientRect();
								return oe.clientX >= r.left && oe.clientX <= r.right &&
									oe.clientY >= r.top && oe.clientY <= r.bottom;
							};
							const moreBtn = cardEl && cardEl.querySelector('[data-card-more]');
							if (_hitsRect(moreBtn)) {
								showCardMoreMenu(moreBtn, rec);
								return;
							}

							const staleBtn = cardEl && cardEl.querySelector('[data-stale-menu]');
							if (_hitsRect(staleBtn)) {
								_showStaleRefMenu(staleBtn, rec);
								return;
							}

							if (rec.loadedFromId) {
								const chip = cardEl && cardEl.querySelector('[data-related-pick]');
								if (_hitsRect(chip)) {
									showRelatedPopover(chip, rec);
									return;
								}
							}
						}
						const oe = evt.originalEvent || {};
						const additive = !!(oe.metaKey || oe.ctrlKey || oe.shiftKey);
						onRecordClick(rec, { additive });
					});
					getCyInstance().on('dbltap', 'node', (evt) => {
						const recId = evt.target.data('recId');
						const rec = canvasState.bulkRecords.find((r) => r.id === recId);
						if (!rec || rec.isTypeNode || rec.isPending) {
return;
}
						if (rec._inaccessible) {
							showBulkToast('This record isn’t available to your Salesforce user, so there’s nothing to open.', 'info');
							return;
						}
						if (_slotAssignmentState(rec) === 'other') {
							const who = rec.slot.assigneeName || rec.slot.assigneeEmail || 'another teammate';
							showBulkToast('Reserved for ' + who + ' — only they can fill this slot.', 'info');
							return;
						}
						openInsertModal(rec.objectName, { record: rec });
					});

					getCyInstance().on('tap', 'edge', (evt) => {
						const edge = evt.target;
						if (edge.data('kind') !== 'fk') {
return;
}
						const eid = edge.id();
						if (!eid) {
return;
}
						canvasState.bulkSelectedIds.clear();
						if (eid[0] === 'a') {
							const assocId = parseInt(eid.slice(1), 10);
							if (!Number.isFinite(assocId)) {
return;
}
							canvasState.bulkSelectedEdgeId = assocId;
							setSelectedDerivedEdge(null);
							renderBulkView();
							const a = canvasState.bulkAssociations.find((x) => x.id === assocId);
							const fieldLabel = a && a.fieldName ? a.fieldName : 'connection';
							showBulkToast('Selected ' + fieldLabel + ' \u2014 press Delete to unlink.');
						} else if (eid[0] === 'd') {

							const recId = edge.data('holderRecId');
							const fieldName = edge.data('fkFieldName');
							if (recId == null || !fieldName) {
return;
}
							canvasState.bulkSelectedEdgeId = null;
							setSelectedDerivedEdge({ recId: recId, fieldName: fieldName });
							renderBulkView();
							showBulkToast('Selected ' + fieldName + ' \u2014 press Delete to unlink.');
						}
					});
					getCyInstance().on('tap', (evt) => {
						if (evt.target === getCyInstance()) {
							canvasState.bulkSelectedIds.clear();
							canvasState.bulkSelectedEdgeId = null;
							setSelectedDerivedEdge(null);
							renderBulkView();
						}
					});

					let _cyDragGroup = null;
					getCyInstance().on('grab', 'node', (evt) => {
						const anchor = evt.target;
						const akind = anchor.data('kind') || '';
						const arecId = anchor.data('recId');

						if (akind.indexOf('card') !== 0 || arecId == null || !canvasState.bulkSelectedIds.has(arecId)) {
							_cyDragGroup = null;
							return;
						}
						const others = [];
						getCyInstance().nodes().forEach((n) => {
							if (n.id() === anchor.id()) {
return;
}
							const kind = n.data('kind') || '';
							if (kind.indexOf('card') !== 0) {
return;
}
							const recId = n.data('recId');
							if (recId == null || !canvasState.bulkSelectedIds.has(recId)) {
return;
}
							const p = n.position();
							others.push({ node: n, start: { x: p.x, y: p.y } });
						});
						if (others.length === 0) {
							_cyDragGroup = null;
							return;
						}
						const ap = anchor.position();
						_cyDragGroup = {
							anchorId: anchor.id(),
							anchorStart: { x: ap.x, y: ap.y },
							others,
						};

						others.forEach((o) => {
 try {
 o.node.scratch('_dragFollower', true); 
} catch (_) {} 
});
					});
					getCyInstance().on('drag', 'node', (evt) => {
						if (!_cyDragGroup) {
return;
}
						if (evt.target.id() !== _cyDragGroup.anchorId) {
return;
}
						const cur = evt.target.position();
						const dx = cur.x - _cyDragGroup.anchorStart.x;
						const dy = cur.y - _cyDragGroup.anchorStart.y;
						_cyDragGroup.others.forEach((o) => {
							o.node.position({ x: o.start.x + dx, y: o.start.y + dy });
						});
					});

					getCyInstance().on('free', 'node', (evt) => {
						const recId = evt.target.data('recId');
						const rec = canvasState.bulkRecords.find((r) => r.id === recId);
						if (rec) {
							const p = evt.target.position();
							rec.x = p.x;
							rec.y = p.y;
						}
						if (_cyDragGroup && evt.target.id() === _cyDragGroup.anchorId) {
							_cyDragGroup.others.forEach((o) => {
								const oid = o.node.data('recId');
								const orec = canvasState.bulkRecords.find((r) => r.id === oid);
								if (!orec) {
return;
}
								const op = o.node.position();
								orec.x = op.x;
								orec.y = op.y;
								try {
 o.node.scratch('_dragFollower', false); 
} catch (_) {}
							});
							_cyDragGroup = null;
						}
					});

					attachCyMarqueeSelect(getCyInstance(), container, (hits, additive) => {
						const next = additive ? new Set(canvasState.bulkSelectedIds) : new Set();
						hits.forEach((node) => {
							const recId = node.data('recId');
							if (recId != null) {
next.add(recId);
}
						});
						canvasState.bulkSelectedIds = next;
						canvasState.bulkSelectedEdgeId = null;
						renderBulkView();
					});

					if (!container._ctaInterceptInstalled) {
						container._ctaInterceptInstalled = true;
						const _CTA_SELECTOR =
							'[data-record-delete], [data-card-more], [data-card-keep], ' +
							'[data-related-pick], [data-pending-pick-blank], [data-pending-pick-load], ' +
							'[data-slot-fill-load], [data-slot-fill-blank], [data-stale-menu]';
						container.addEventListener('mousedown', (ev) => {
							if (ev.target && ev.target.closest && ev.target.closest(_CTA_SELECTOR)) {

								ev.stopPropagation();
							}
						}, true              );
						container.addEventListener('click', (ev) => {
							const t = ev.target;
							if (!t || !t.closest) {
return;
}
							const cta = t.closest(_CTA_SELECTOR);
							if (!cta) {
return;
}
							const cardEl = cta.closest('[data-rec-id]');
							const recId = cardEl && Number(cardEl.getAttribute('data-rec-id'));
							if (!Number.isFinite(recId)) {
return;
}
							const rec = canvasState.bulkRecords.find((r) => r.id === recId);
							if (!rec) {
return;
}
							ev.stopPropagation();
							if (cta.matches('[data-record-delete]')) {
								deleteRecord(rec.id);
								return;
							}
							if (cta.matches('[data-card-more]')) {
								showCardMoreMenu(cta, rec);
								return;
							}
							if (cta.matches('[data-card-keep]')) {
								unmarkPendingDelete(rec.id);
								return;
							}
							if (cta.matches('[data-pending-pick-blank]')) {
								showFindObjectPopover(cta, {
									header: 'Create blank record',
									sub: 'Pick the object type for this blank draft.',
									isAdded: () => false,
									onPick: (name) => resolvePendingRecord(rec.id, name),
								});
								return;
							}
							if (cta.matches('[data-pending-pick-load]')) {
								showFindObjectPopover(cta, {
									header: 'Load existing record',
									sub: 'Pick the object type, then search by name or paste a record ID.',
									isAdded: () => false,
									onPick: (name) => resolvePendingRecordToLoad(rec.id, name),
								});
								return;
							}
							if (cta.matches('[data-slot-fill-blank]')) {
								fillSlotWithBlank(rec);
								return;
							}
							if (cta.matches('[data-slot-fill-load]')) {
								fillSlotWithLoad(rec, cta);
								return;
							}

							if (cta.matches('[data-related-pick]')) {
								if (rec.loadedFromId) {
showRelatedPopover(cta, rec);
}
								return;
							}

						});

						container.addEventListener('dblclick', (ev) => {
							const stack = document.elementsFromPoint(ev.clientX, ev.clientY);
							let cardEl = null;
							for (const el of stack) {
								if (el && el.matches && el.matches('[data-rec-id]')) {
 cardEl = el; break; 
}
								const a = el && el.closest && el.closest('[data-rec-id]');
								if (a) {
 cardEl = a; break; 
}
							}
							if (!cardEl) {
return;
}
							const recId = Number(cardEl.getAttribute('data-rec-id'));
							if (!Number.isFinite(recId)) {
return;
}
							const rec = canvasState.bulkRecords.find((r) => r.id === recId);
							if (!rec || rec.isTypeNode || rec.isPending) {
return;
}
							if (rec._inaccessible) {
								showBulkToast('This record isn’t available to your Salesforce user, so there’s nothing to open.', 'info');
								return;
							}
							if (_slotAssignmentState(rec) === 'other') {
								const who = rec.slot.assigneeName || rec.slot.assigneeEmail || 'another teammate';
								showBulkToast('Reserved for ' + who + ' — only they can fill this slot.', 'info');
								return;
							}
							openInsertModal(rec.objectName, { record: rec });
						});
					}

					if (typeof getCyInstance().nodeHtmlLabel === 'function') {
						getCyInstance().nodeHtmlLabel([
							{
								query: 'node[kind ^= "card"]',
								valign: 'center',
								halign: 'center',
								valignBox: 'center',
								halignBox: 'center',
								tpl: function (data) {
									const rec = canvasState.bulkRecords.find((r) => r.id === data.recId);
									return rec ? _cyCardHtml(rec) : '';
								},
							},
							{

								query: 'node[kind ^= "tn-"]',
								valign: 'center',
								halign: 'center',
								valignBox: 'center',
								halignBox: 'center',
								tpl: function (data) {
									const rec = canvasState.bulkRecords.find((r) => r.id === data.recId);
									if (!rec || !rec._loading) {
return '';
}
									const dir = rec.isFreeTypeNode
										? 'tn-free'
										: (rec.direction === 'parent' ? 'tn-parent' : 'tn-child');
									return '<div class="cy-tn-loading ' + dir + '"><span class="cy-tn-spinner"></span></div>';
								},
							},
						]);
					}

					const CARD_EDGE_THRESHOLD = 10;

					const CARD_EDGE_OUTSET = 15;
					const _setConnectClass = (on) => {
						if (container) {
container.classList.toggle('cy-connecting', !!on);
}
					};
					const _ns = 'http://www.w3.org/2000/svg';
					const _updatePendingLine = () => {
						const pe = getCyPendingEdge();
						if (!pe || !pe.line) {
return;
}

						const rp = pe.srcCyNode.renderedPosition();
						const ox = typeof pe.anchorOffsetX === 'number' ? pe.anchorOffsetX : 0;
						const oy = typeof pe.anchorOffsetY === 'number' ? pe.anchorOffsetY : 0;
						pe.line.setAttribute('x1', rp.x + ox);
						pe.line.setAttribute('y1', rp.y + oy);
					};

					const _CTA_EDGE_SKIP_SEL =
						'[data-record-delete], [data-card-more], ' +
						'[data-related-pick], [data-pending-pick-blank], [data-pending-pick-load], ' +
						'[data-slot-fill-load], [data-slot-fill-blank], [data-stale-menu]';

					const _findEdgeTargetAt = (x, y) => {

						const containerRect = container.getBoundingClientRect();
						const inContainer =
							x >= containerRect.left && x <= containerRect.right &&
							y >= containerRect.top && y <= containerRect.bottom;
						if (inContainer) {

							const cards = container.querySelectorAll('.record-card[data-rec-id]');
							for (let i = cards.length - 1; i >= 0; i--) {
								const el = cards[i];
								const r = el.getBoundingClientRect();
								if (r.width === 0 || r.height === 0) {
continue;
}
								if (x < r.left - CARD_EDGE_OUTSET || x > r.right + CARD_EDGE_OUTSET) {
continue;
}
								if (y < r.top - CARD_EDGE_OUTSET || y > r.bottom + CARD_EDGE_OUTSET) {
continue;
}
								return { kind: 'card', el, rect: r, recId: Number(el.getAttribute('data-rec-id')) };
							}
						}
						const modalBody = document.querySelector('.modal.is-inline .modal-body[data-inline-rec-id]');
						if (modalBody) {
							const r = modalBody.getBoundingClientRect();

							let rightAdjusted = r.right;
							const modal = modalBody.parentElement;
							const content = modal && modal.querySelector('.modal-content');
							if (content) {
								const sbW = content.offsetWidth - content.clientWidth;
								if (sbW > 0) {
rightAdjusted = r.right - sbW - 2;
}
							}
							const inside = x >= r.left && x <= rightAdjusted && y >= r.top && y <= r.bottom;
							const inOutsetBox =
								x >= r.left - CARD_EDGE_OUTSET && x <= r.right + CARD_EDGE_OUTSET &&
								y >= r.top - CARD_EDGE_OUTSET && y <= r.bottom + CARD_EDGE_OUTSET;

							const onScrollbarStrip = x > rightAdjusted && x <= r.right && y >= r.top && y <= r.bottom;
							if (r.width > 0 && r.height > 0 && (inside || (inOutsetBox && !onScrollbarStrip))) {
								return {
									kind: 'modal',
									el: modalBody,
									rect: { left: r.left, top: r.top, right: rightAdjusted, bottom: r.bottom, width: rightAdjusted - r.left, height: r.height },
									recId: Number(modalBody.getAttribute('data-inline-rec-id')),
								};
							}
						}
						return null;
					};

					const _isOnRectEdge = (rect, x, y) => {
						const insideX = x >= rect.left && x <= rect.right;
						const insideY = y >= rect.top && y <= rect.bottom;
						if (insideX && insideY) {
							const d = Math.min(x - rect.left, rect.right - x, y - rect.top, rect.bottom - y);
							return d <= CARD_EDGE_THRESHOLD;
						}
						const cx = Math.max(rect.left, Math.min(x, rect.right));
						const cy = Math.max(rect.top, Math.min(y, rect.bottom));
						const dx = x - cx;
						const dy = y - cy;
						return Math.hypot(dx, dy) <= CARD_EDGE_OUTSET;
					};
					const _setEdgeHoverCard = (recId) => {
						document.querySelectorAll('.record-card.is-edge-link, .modal.is-inline.is-edge-link').forEach((el) => el.classList.remove('is-edge-link'));
						if (recId == null) {
return;
}
						const card = container.querySelector('.record-card[data-rec-id="' + recId + '"]');
						if (card) {
card.classList.add('is-edge-link');
}
						const modal = document.querySelector('.modal.is-inline');
						if (modal) {
							const a = modal.querySelector('.modal-body[data-inline-rec-id="' + recId + '"]');
							if (a) {
modal.classList.add('is-edge-link');
}
						}
					};

					document.addEventListener('mousemove', (ev) => {
						if (getCyPendingEdge()) {
return;
}
						const hit = _findEdgeTargetAt(ev.clientX, ev.clientY);
						if (!hit) {
							if (container.classList.contains('cy-edge-hover')) {
container.classList.remove('cy-edge-hover');
}
							_setEdgeHoverCard(null);
							return;
						}
						const rec = canvasState.bulkRecords.find((r) => r.id === hit.recId);
						if (!rec || rec.isTypeNode) {
							container.classList.remove('cy-edge-hover');
							_setEdgeHoverCard(null);
							return;
						}
						const onEdge = _isOnRectEdge(hit.rect, ev.clientX, ev.clientY);
						container.classList.toggle('cy-edge-hover', onEdge);
						_setEdgeHoverCard(onEdge ? hit.recId : null);
					});

					document.addEventListener('mousedown', (ev) => {
						if (ev.button !== 0) {
return;
}
						if (getCyPendingEdge()) {
return;
}
						if (ev.target && ev.target.closest && ev.target.closest(_CTA_EDGE_SKIP_SEL)) {
return;
}

						if (ev.target && ev.target.closest && ev.target.closest('input, textarea, select, button, a, [contenteditable="true"]')) {
return;
}
						const hit = _findEdgeTargetAt(ev.clientX, ev.clientY);
						if (!hit) {
return;
}
						if (!Number.isFinite(hit.recId)) {
return;
}
						const rec = canvasState.bulkRecords.find((r) => r.id === hit.recId);
						if (!rec || rec.isTypeNode) {
return;
}
						if (!_isOnRectEdge(hit.rect, ev.clientX, ev.clientY)) {
return;
}
						const cyNode = getCyInstance().getElementById('r' + hit.recId);
						if (!cyNode || cyNode.length === 0) {
return;
}
						const svg = document.createElementNS(_ns, 'svg');
						svg.setAttribute('class', 'cy-pending-edge-svg');
						const line = document.createElementNS(_ns, 'line');
						line.setAttribute('class', 'cy-pending-edge-line');

						const _containerRect = container.getBoundingClientRect();

						const _r = hit.rect;
						const _cx = Math.max(_r.left, Math.min(ev.clientX, _r.right));
						const _cy = Math.max(_r.top, Math.min(ev.clientY, _r.bottom));
						let _clientAnchorX = _cx;
						let _clientAnchorY = _cy;
						if (_cx === ev.clientX && _cy === ev.clientY) {
							const dLeft = ev.clientX - _r.left;
							const dRight = _r.right - ev.clientX;
							const dTop = ev.clientY - _r.top;
							const dBottom = _r.bottom - ev.clientY;
							const dMin = Math.min(dLeft, dRight, dTop, dBottom);
							if (dMin === dLeft) {
_clientAnchorX = _r.left;
} else if (dMin === dRight) {
_clientAnchorX = _r.right;
} else if (dMin === dTop) {
_clientAnchorY = _r.top;
} else {
_clientAnchorY = _r.bottom;
}
						}
						const _anchorX = _clientAnchorX - _containerRect.left;
						const _anchorY = _clientAnchorY - _containerRect.top;
						const _srcRP = cyNode.renderedPosition();
						const _anchorOffsetX = _anchorX - _srcRP.x;
						const _anchorOffsetY = _anchorY - _srcRP.y;
						line.setAttribute('x1', _anchorX);
						line.setAttribute('y1', _anchorY);
						line.setAttribute('x2', _anchorX);
						line.setAttribute('y2', _anchorY);
						svg.appendChild(line);
						container.appendChild(svg);
						setCyPendingEdge({
							srcRec: rec,
							srcCyNode: cyNode,
							svg: svg,
							line: line,
							anchorOffsetX: _anchorOffsetX,
							anchorOffsetY: _anchorOffsetY,
						});
						_setConnectClass(true);
						cyNode.ungrabify();
						getCyInstance().userPanningEnabled(false);
						ev.preventDefault();
						ev.stopPropagation();
						cyNode.data('rev', (cyNode.data('rev') || 0) + 1);
					}, true                              );

					document.addEventListener('mousemove', (ev) => {
						const pe = getCyPendingEdge();
						if (!pe || !pe.line) {
return;
}
						const rect = container.getBoundingClientRect();
						const px = ev.clientX - rect.left;
						const py = ev.clientY - rect.top;
						pe.line.setAttribute('x2', px);
						pe.line.setAttribute('y2', py);
						const hit = _findEdgeTargetAt(ev.clientX, ev.clientY);
						let hoverId = null;
						if (hit && hit.recId !== pe.srcRec.id) {
							const candidate = canvasState.bulkRecords.find((r) => r.id === hit.recId);
							if (candidate && !candidate.isTypeNode) {
hoverId = hit.recId;
}
						}
						if (hoverId !== pe.hoverTargetId) {
							const prev = pe.hoverTargetId;
							pe.hoverTargetId = hoverId;
							_bumpRev(prev);
							_bumpRev(hoverId);
						}
					});

					document.addEventListener('mouseup', (ev) => {
						const pe = getCyPendingEdge();
						if (!pe) {
return;
}
						let tgtRec = null;
						const hit = _findEdgeTargetAt(ev.clientX, ev.clientY);
						if (hit && hit.recId !== pe.srcRec.id) {
							const candidate = canvasState.bulkRecords.find((r) => r.id === hit.recId);
							if (candidate && !candidate.isTypeNode) {
tgtRec = candidate;
}
						}
						const srcRec = pe.srcRec;
						const srcId = srcRec.id;
						const hoverTargetId = pe.hoverTargetId;
						if (pe.svg && pe.svg.parentNode) {
pe.svg.parentNode.removeChild(pe.svg);
}
						setCyPendingEdge(null);
						_setConnectClass(false);
						container.classList.remove('cy-edge-hover');
						getCyInstance().userPanningEnabled(false);
						getCyInstance().nodes().forEach((n) => n.grabify());
						const srcCyNode = getCyInstance().getElementById('r' + srcId);
						if (srcCyNode && srcCyNode.length) {
srcCyNode.data('rev', (srcCyNode.data('rev') || 0) + 1);
}
						if (hoverTargetId != null) {
							const tgtCyNode = getCyInstance().getElementById('r' + hoverTargetId);
							if (tgtCyNode && tgtCyNode.length) {
tgtCyNode.data('rev', (tgtCyNode.data('rev') || 0) + 1);
}
						}
						if (tgtRec) {
							finalizeAssociation(srcRec, tgtRec, ev.clientX, ev.clientY);
						}
					});
					const _bumpRev = (id) => {
						if (id == null) {
return;
}
						const n = getCyInstance().getElementById('r' + id);
						if (n && n.length) {
n.data('rev', (n.data('rev') || 0) + 1);
}
					};

					getCyInstance().on('mousemove', (evt) => {
						if (!getCyPendingEdge() || !getCyPendingEdge().line) {
return;
}
						const oe = evt.originalEvent;
						if (!oe) {
return;
}
						const rect = container.getBoundingClientRect();
						const px = oe.clientX - rect.left;
						const py = oe.clientY - rect.top;
						getCyPendingEdge().line.setAttribute('x2', px);
						getCyPendingEdge().line.setAttribute('y2', py);
						_updatePendingLine();

						let hit = null;
						getCyInstance().nodes('node[kind ^= "card"]').forEach((n) => {
							if (hit) {
return;
}
							const recId = n.data('recId');
							if (recId == null || recId === getCyPendingEdge().srcRec.id) {
return;
}
							const bb = n.renderedBoundingBox();
							if (px >= bb.x1 && px <= bb.x2 && py >= bb.y1 && py <= bb.y2) {
								hit = recId;
							}
						});
						if (hit !== getCyPendingEdge().hoverTargetId) {
							const prev = getCyPendingEdge().hoverTargetId;
							getCyPendingEdge().hoverTargetId = hit;
							_bumpRev(prev);
							_bumpRev(hit);
						}
					});

					getCyInstance().on('render', _updatePendingLine);
					getCyInstance().on('mouseup tap', (evt) => {
						if (!getCyPendingEdge()) {
return;
}
						let tgtRec = null;
						if (evt.target !== getCyInstance()) {
							const recId = evt.target.data && evt.target.data('recId');
							if (recId != null) {
								const candidate = canvasState.bulkRecords.find((r) => r.id === recId);
								if (candidate && !candidate.isTypeNode && candidate.id !== getCyPendingEdge().srcRec.id) {
									tgtRec = candidate;
								}
							}
						}
						const srcRec = getCyPendingEdge().srcRec;
						const srcId = srcRec.id;
						const hoverTargetId = getCyPendingEdge().hoverTargetId;
						if (getCyPendingEdge().svg && getCyPendingEdge().svg.parentNode) {
							getCyPendingEdge().svg.parentNode.removeChild(getCyPendingEdge().svg);
						}
						setCyPendingEdge(null);
						_setConnectClass(false);
						container.classList.remove('cy-edge-hover');

						getCyInstance().userPanningEnabled(false);
						getCyInstance().nodes().forEach((n) => n.grabify());

						const srcCyNode = getCyInstance().getElementById('r' + srcId);
						if (srcCyNode && srcCyNode.length) {
srcCyNode.data('rev', (srcCyNode.data('rev') || 0) + 1);
}
						if (hoverTargetId != null) {
							const tgtCyNode = getCyInstance().getElementById('r' + hoverTargetId);
							if (tgtCyNode && tgtCyNode.length) {
tgtCyNode.data('rev', (tgtCyNode.data('rev') || 0) + 1);
}
						}
						if (tgtRec) {
							const rect = container.getBoundingClientRect();
							const oe = evt.originalEvent;
							const cx = oe ? oe.clientX : rect.left + rect.width / 2;
							const cyy = oe ? oe.clientY : rect.top + rect.height / 2;
							finalizeAssociation(srcRec, tgtRec, cx, cyy);
						}
					});
				} else {

					const wantedIds = new Set(elements.map((e) => e.data.id));
					getCyInstance().elements().forEach((el) => {
 if (!wantedIds.has(el.id())) {
el.remove();
} 
});
					const haveIds = new Set(getCyInstance().elements().map((el) => el.id()));
					elements.forEach((el) => {
						if (!haveIds.has(el.data.id)) {
							getCyInstance().add(el);

							if (el.group === 'nodes' && el.data.kind && el.data.kind.indexOf('card') === 0) {
								newRealNodeIds.push(el.data.id);
							}
							return;
						}
						if (el.group !== 'nodes') {
return;
}
						const existing = getCyInstance().getElementById(el.data.id);
						if (el.data.label !== existing.data('label')) {
existing.data('label', el.data.label);
}
						if (el.data.kind !== existing.data('kind')) {
existing.data('kind', el.data.kind);
}
						if (el.position) {

							if (!existing.grabbed() && !existing.scratch('_dragFollower')) {
								const p = existing.position();
								if (Math.abs(p.x - el.position.x) > 0.5 || Math.abs(p.y - el.position.y) > 0.5) {
									existing.position(el.position);
								}
							}
						}

						if (el.data.kind && (el.data.kind.indexOf('card') === 0 || el.data.kind.indexOf('tn-') === 0)) {
							existing.data('rev', (existing.data('rev') || 0) + 1);
						}
					});
				}

				getCyInstance().elements('node:selected').unselect();
				canvasState.bulkSelectedIds.forEach((id) => {
					const n = getCyInstance().getElementById('r' + id);
					if (n && n.length) {
n.select();
}
				});

				getCyInstance().edges('.edge-picked').removeClass('edge-picked');
				if (canvasState.bulkSelectedEdgeId != null) {
					const e = getCyInstance().getElementById('a' + canvasState.bulkSelectedEdgeId);
					if (e && e.length) {
e.addClass('edge-picked');
}
				} else if (getSelectedDerivedEdge()) {
					const e = getCyInstance().getElementById('d' + getSelectedDerivedEdge().recId + '_' + getSelectedDerivedEdge().fieldName);
					if (e && e.length) {
e.addClass('edge-picked');
}
				}

				requestAnimationFrame(() => requestAnimationFrame(() => {
					if (!getCyInstance() || !container) {
return;
}
					const cards = container.querySelectorAll('.record-card[data-rec-id]');
					cards.forEach((el) => {
						const w = el.offsetWidth;
						const h = el.offsetHeight;
						if (!w || !h) {
return;
}
						const recId = parseInt(el.getAttribute('data-rec-id'), 10);
						if (!Number.isFinite(recId)) {
return;
}
						const node = getCyInstance().getElementById('r' + recId);
						if (!node || !node.length) {
return;
}

						if (node.data('_inlineLocked')) {
return;
}
						if (node.data('boxW') !== w) {
node.data('boxW', w);
}
						if (node.data('boxH') !== h) {
node.data('boxH', h);
}
					});
				}));

				if (isFirstRender) {

					requestAnimationFrame(() => {
						if (!getCyInstance() || getCyInstance().elements().length === 0) {
return;
}
						getCyInstance().resize();
						const baseCard = getCyInstance().nodes('[kind ^= "card"]').first();
						if (baseCard && baseCard.length) {
							getCyInstance().zoom(1);
							getCyInstance().center(baseCard);
						} else {
							getCyInstance().fit(undefined, 60);
							if (getCyInstance().zoom() > 1) {
								getCyInstance().zoom(1);
								getCyInstance().center();
							}
						}
					});
				} else if (newRealNodeIds.length > 0 && !getSkipNextCyAutoPan()) {
					const newNodes = getCyInstance().collection(
						newRealNodeIds
							.map((id) => getCyInstance().getElementById(id))
							.filter((n) => n && n.length)
					);
					if (newNodes.length > 0) {
						getCyInstance().animate({ center: { eles: newNodes }, duration: 500, easing: 'ease-out' });
					}
				}

				setSkipNextCyAutoPan(false);
			}

			return {
				renderBulkCanvasCy: renderBulkCanvasCy,
			};
		},
	};
})();
