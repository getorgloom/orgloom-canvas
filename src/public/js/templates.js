(function () {
	'use strict';
	// Serializes schema templates or canvas snapshots and validates them before changing state.

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.templates = {
		mount: function mount(deps) {
			const _required = [
				'canvasState',
				'showBulkToast',
				'escapeHtml',
				'csrfFetch',
				'ensureDescribe',
				'addToSelection',
				'setGraphView',
				'renderAll',
				'showReplaceOrMergeDialog',
				'pingAuditEvent',
				'getCanvasRecordCap',
				'realRecordCount',
				'runSlotPreflight',
				'clearEmptyStarterCard',
				'getSlotIdSeq',
				'setSlotIdSeq',
			];
			for (const k of _required) {
				if (deps == null || deps[k] == null) {
					throw new Error('templates.mount: missing required dep: ' + k);
				}
			}
			const canvasState = deps.canvasState;
			const showBulkToast = deps.showBulkToast;
			const escapeHtml = deps.escapeHtml;
			const csrfFetch = deps.csrfFetch;
			const ensureDescribe = deps.ensureDescribe;
			const addToSelection = deps.addToSelection;
			const setGraphView = deps.setGraphView;
			const renderAll = deps.renderAll;
			const showReplaceOrMergeDialog = deps.showReplaceOrMergeDialog;
			const pingAuditEvent = deps.pingAuditEvent;
			const _getCanvasRecordCap = deps.getCanvasRecordCap;
			const _realRecordCount = deps.realRecordCount;
			const _runSlotPreflight = deps.runSlotPreflight;
			const clearEmptyStarterCard = deps.clearEmptyStarterCard;
			const getSlotIdSeq = deps.getSlotIdSeq;
			const setSlotIdSeq = deps.setSlotIdSeq;
			const encryptedFields = window.OrgLoom && window.OrgLoom.encryptedFields;
			if (!encryptedFields) {
				throw new Error('encrypted-fields.js must load before templates.js');
			}
			const _observeSlotId = (slotId) => {
				setSlotIdSeq(Math.max(getSlotIdSeq(), Number(slotId) + 1));
			};
			const canvasCapCheck =
				typeof deps.canvasCapCheck === 'function'
					? deps.canvasCapCheck
					: function () {
							return { ok: true, blocked: false, reason: null };
						};
			const showBulkToastWithAction =
				typeof deps.showBulkToastWithAction === 'function' ? deps.showBulkToastWithAction : null;

			const _CANVAS_RECORD_CAP_get = () => _getCanvasRecordCap();

			const TEMPLATE_VERSION = 1;
			const TEMPLATE_RECORD_CAP = 500;
			try {
				localStorage.removeItem('sf-loader-templates-v1');
			} catch (_) {}

			function serializeObjects(includeIdx) {
				const idxById = new Map();
				canvasState.selectedObjects.forEach((s, i) => idxById.set(s.id, i));
				return canvasState.selectedObjects.map((s, idx) => {
					const o = {
						name: s.name,
						label: s.label || s.name,
						addedFromIdx: s.addedFrom != null ? idxById.get(s.addedFrom) : null,
						addedVia: s.addedVia || null,
						worldPos: s.worldPos || null,
					};
					if (includeIdx) {
						o.idx = idx;
					}
					return o;
				});
			}

			function _serializedEncryptedIntents(record) {
				const encrypted = encryptedFields.fieldNames(canvasState, record && record.objectName);
				const intents = new Set(encryptedFields.intentNames(record, canvasState));
				if (record && record.loadedFromId) {
					const vc = window.OrgLoom && window.OrgLoom.valueCompare;
					const changed =
						vc && typeof vc.changedFieldNames === 'function'
							? vc.changedFieldNames(record.values || {}, record.loadedValues || {})
							: [];
					changed.forEach((fieldName) => {
						if (encrypted.has(fieldName)) {
							intents.add(fieldName);
						}
					});
				} else if (record) {
					for (const fieldName of Object.keys(record.values || {})) {
						if (encrypted.has(fieldName)) {
							intents.add(fieldName);
						}
					}
				}
				return Array.from(intents).sort();
			}

			function recordCommonParts(r) {
				const out = {};
				if (r.slot) {
					out.slot = r.slot;
				}
				if (r.pendingDelete) {
					out.pendingDelete = true;
				}
				const encryptedFieldIntents = _serializedEncryptedIntents(r);
				if (encryptedFieldIntents.length > 0) {
					out.encryptedFieldIntents = encryptedFieldIntents;
				}
				return out;
			}

			function _mintCanvasRecordId() {
				try {
					if (window.crypto && typeof window.crypto.randomUUID === 'function') {
						return window.crypto.randomUUID();
					}
				} catch (_) {}
				return 'card_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
			}

			function _ensureCanvasRecordId(record) {
				if (
					record._canvasRecordId != null &&
					String(record._canvasRecordId) &&
					String(record._canvasRecordId).length <= 128
				) {
					return String(record._canvasRecordId);
				}
				record._canvasRecordId = _mintCanvasRecordId();
				return record._canvasRecordId;
			}

			function loadedEditDelta(r) {
				// Preserve only edits relative to the loaded Salesforce baseline when requested.
				if (!r.loadedValues) {
					return null;
				}
				const vc = (window.OrgLoom && window.OrgLoom.valueCompare) || null;
				if (!vc || typeof vc.changedFieldNames !== 'function') {
					return null;
				}
				const encrypted = encryptedFields.fieldNames(canvasState, r.objectName);
				const changed = vc
					.changedFieldNames(r.values || {}, r.loadedValues || {})
					.filter((fieldName) => !encrypted.has(fieldName));
				if (!changed.length) {
					return null;
				}
				const changes = {};
				changed.forEach((f) => {
					const value = (r.values || {})[f];
					changes[f] = value === undefined ? null : value;
				});
				return changes;
			}

			function draftFieldMetadata(objects, draftRecords) {
				const namesByObject = new Map();
				const wholeRecordRequests = new Set();
				for (const record of draftRecords) {
					if (!record || !record.objectName) {
						continue;
					}
					if (!namesByObject.has(record.objectName)) {
						namesByObject.set(record.objectName, new Set());
					}
					Object.keys(record.values || {}).forEach((name) => namesByObject.get(record.objectName).add(name));
					(Array.isArray(record.encryptedFieldIntents) ? record.encryptedFieldIntents : []).forEach((name) =>
						namesByObject.get(record.objectName).add(name),
					);
					if (record.slot && record.slot.kind === 'fields') {
						(record.slot.fields || []).forEach((name) => namesByObject.get(record.objectName).add(name));
					} else if (record.slot) {
						wholeRecordRequests.add(record.objectName);
					}
				}
				return objects.map((object) => {
					const describe =
						canvasState.describeCache[object.name] ||
						(canvasState.draftDescribeCache && canvasState.draftDescribeCache[object.name]);
					const requested = namesByObject.get(object.name) || new Set();
					const sourceFields = describe && Array.isArray(describe.fields) ? describe.fields : [];
					if (wholeRecordRequests.has(object.name)) {
						sourceFields
							.filter((field) => field && field.createable)
							.forEach((field) => requested.add(field.name));
					}
					const fields = sourceFields
						.filter((field) => field && requested.has(field.name))
						.map((field) => ({
							name: field.name,
							label: field.label || field.name,
							type: field.type || 'string',
							createable: wholeRecordRequests.has(object.name) ? !!field.createable : true,
							updateable: !!field.updateable,
							required: !!field.required,
							nillable: field.nillable !== false,
							defaultedOnCreate: !!field.defaultedOnCreate,
							calculated: !!field.calculated,
							autoNumber: !!field.autoNumber,
							nameField: !!field.nameField,
							compoundFieldName: field.compoundFieldName || null,
							length: field.length,
							precision: field.precision,
							scale: field.scale,
							referenceTo: Array.isArray(field.referenceTo) ? field.referenceTo.slice() : [],
							relationshipName: field.relationshipName || null,
							picklistValues: Array.isArray(field.picklistValues)
								? field.picklistValues
										.filter((value) => value && value.active !== false)
										.map((value) => ({
											label: value.label,
											value: value.value,
											active: true,
											defaultValue: !!value.defaultValue,
										}))
								: [],
						}));
					for (const name of requested) {
						if (!fields.some((field) => field.name === name)) {
							fields.push({ name, label: name, type: 'string', createable: true, updateable: false });
						}
					}
					return fields.length > 0 ? Object.assign({}, object, { draftFields: fields }) : object;
				});
			}

			async function ensureDraftSlotMetadata() {
				const objectNames = Array.from(
					new Set(
						(canvasState.bulkRecords || [])
							.filter(
								(record) =>
									record &&
									!record.isTypeNode &&
									!record.isPending &&
									!record.loadedFromId &&
									record.slot &&
									(record.slot.kind || 'whole-record') === 'whole-record' &&
									record.objectName,
							)
							.map((record) => record.objectName),
					),
				);
				for (const objectName of objectNames) {
					let describe = canvasState.describeCache && canvasState.describeCache[objectName];
					const mayReuseSharedSnapshot =
						canvasState.currentCanvas && canvasState.currentCanvas.ownedByMe === false;
					if (
						(!describe || !Array.isArray(describe.fields) || describe.fields.length === 0) &&
						mayReuseSharedSnapshot
					) {
						describe = canvasState.draftDescribeCache && canvasState.draftDescribeCache[objectName];
					}
					if (!describe || !Array.isArray(describe.fields) || describe.fields.length === 0) {
						try {
							describe = await ensureDescribe(objectName, { force: true });
						} catch (error) {
							throw new Error(
								'Could not prepare the ' +
									objectName +
									' record request for sharing. Reconnect Salesforce and try again. ' +
									(error && error.message ? error.message : ''),
							);
						}
					}
					if (
						!describe ||
						!Array.isArray(describe.fields) ||
						!describe.fields.some((field) => field && field.createable)
					) {
						throw new Error(
							'Could not prepare the ' +
								objectName +
								' record request because no createable fields are available.',
						);
					}
					if (!mayReuseSharedSnapshot || describe !== canvasState.draftDescribeCache?.[objectName]) {
						canvasState.describeCache[objectName] = describe;
					}
				}
				return objectNames;
			}

			function buildTemplate(opts) {
				opts = opts || {};
				const schemaOnly = !!opts.schemaOnly;
				const preserveLoadedLinks = !!opts.preserveLoadedLinks;
				const objects = serializeObjects(false);
				let records;
				let associations;
				let includesLoadedData = false;
				if (schemaOnly) {
					records = [];
					associations = [];
				} else {
					const base = canvasState.bulkRecords.filter((r) => !r.isTypeNode);
					includesLoadedData = base.some((r) => !!r.loadedFromId);
					records = base.map((r) => {
						const rec = Object.assign(
							{
								id: r.id,
								objectName: r.objectName,
								label: r.label,
								x: r.x,
								y: r.y,
								values: encryptedFields.stripValues(canvasState, r.objectName, r.values),
							},
							recordCommonParts(r),
						);
						if (preserveLoadedLinks && r.loadedFromId) {
							rec.loadedFromId = r.loadedFromId;
							if (r.loadedValues) {
								rec.loadedValues = encryptedFields.stripValues(
									canvasState,
									r.objectName,
									r.loadedValues,
								);
							}
						}
						return rec;
					});
					if (records.length > TEMPLATE_RECORD_CAP) {
						throw new Error(
							'Template exceeds the ' +
								TEMPLATE_RECORD_CAP +
								'-record cap (found ' +
								records.length +
								').',
						);
					}
					const keptIds = new Set(records.map((r) => r.id));
					associations = canvasState.bulkAssociations
						.filter((a) => keptIds.has(a.fromId) && keptIds.has(a.toId))
						.map((a) => ({ fromId: a.fromId, toId: a.toId, fieldName: a.fieldName }));
				}
				return {
					_meta: {
						app: 'Org Loom',
						version: TEMPLATE_VERSION,
						exportedFrom: window.SF_ORG_ID || null,
						exportedBy: window.SF_USER_ID || null,
						exportedByName: window.SF_USER_NAME || null,
						exportedAt: new Date().toISOString(),
						schemaOnly,
						includesLoadedData,
						preservesLoadedLinks: preserveLoadedLinks && includesLoadedData,
						includedLoadedObjects: includesLoadedData
							? Array.from(
									new Set(
										canvasState.bulkRecords
											.filter((r) => !r.isTypeNode && r.loadedFromId)
											.map((r) => r.objectName),
									),
								)
							: [],
						recordCount: records.length,
					},
					schema: { objects },
					records,
					associations,
				};
			}

			function sanitizeFilename(s) {
				return (
					String(s || 'orgloom-template')
						.replace(/[^a-zA-Z0-9_\-. ]+/g, '_')
						.slice(0, 80) || 'orgloom-template'
				);
			}

			function buildCanvasPayload() {
				let objects = serializeObjects(true);
				const real = canvasState.bulkRecords.filter(
					(r) => !r.isTypeNode && !r.isPending && !r._permissionHidden,
				);
				const stableDraftRef = (record) =>
					record._persistedTempId != null ? record._persistedTempId : record._collabId || record.id;
				const loadedRecords = real
					.filter((r) => !!r.loadedFromId)
					.map((r) => {
						const base = Object.assign(
							{
								loadedFromId: r.loadedFromId,
								canvasRecordId: _ensureCanvasRecordId(r),
								objectName: r.objectName,
								x: r.x,
								y: r.y,
							},
							recordCommonParts(r),
						);
						const changes = loadedEditDelta(r);
						if (changes) {
							base.changes = changes;
						}
						return base;
					});
				const drafts = real
					.filter((r) => !r.loadedFromId)
					.map((r) =>
						Object.assign(
							{
								tempId: stableDraftRef(r),
								canvasRecordId: _ensureCanvasRecordId(r),
								objectName: r.objectName,
								x: r.x,
								y: r.y,
								values: encryptedFields.stripValues(canvasState, r.objectName, r.values),
							},
							recordCommonParts(r),
						),
					);
				objects = draftFieldMetadata(objects, drafts);
				const resolveRefKey = (rec) => {
					if (!rec) {
						return null;
					}
					if (rec.slot && rec.slot.slotId != null) {
						return { kind: 'slot', ref: rec.slot.slotId };
					}
					if (rec.loadedFromId) {
						return { kind: 'loaded', ref: rec.loadedFromId };
					}
					return { kind: 'draft', ref: stableDraftRef(rec) };
				};
				const draftIds = new Set(drafts.filter((d) => !d.slot).map((d) => d.tempId));
				const loadedSet = new Set(loadedRecords.filter((l) => !l.slot).map((l) => l.loadedFromId));
				const slotIds = new Set(real.filter((r) => r.slot).map((r) => r.slot.slotId));
				const associations = canvasState.bulkAssociations
					.map((a) => {
						const fromRec = real.find((r) => r.id === a.fromId);
						const toRec = real.find((r) => r.id === a.toId);
						if (!fromRec || !toRec) {
							return null;
						}
						const fromKey = resolveRefKey(fromRec);
						const toKey = resolveRefKey(toRec);
						if (!fromKey || !toKey) {
							return null;
						}
						const inSet = (k) =>
							k.kind === 'loaded'
								? loadedSet.has(k.ref)
								: k.kind === 'draft'
									? draftIds.has(k.ref)
									: slotIds.has(k.ref);
						if (!inSet(fromKey) || !inSet(toKey)) {
							return null;
						}
						return { from: fromKey, to: toKey, fieldName: a.fieldName };
					})
					.filter(Boolean);
				return {
					_meta: {
						app: 'Org Loom',
						version: TEMPLATE_VERSION,
						savedFrom: window.SF_ORG_ID || null,
						savedBy: window.SF_USER_ID || null,
						savedByName: window.SF_USER_NAME || null,
					},
					schema: { objects },
					loadedRecords,
					drafts,
					associations,
				};
			}

			function downloadTemplate(name, schemaOnly, opts) {
				opts = opts || {};
				let payload;
				try {
					payload = buildTemplate({
						schemaOnly,
						preserveLoadedLinks: !!opts.preserveLoadedLinks,
					});
				} catch (e) {
					showBulkToast(e.message, 'error');
					return;
				}
				const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
				const url = URL.createObjectURL(blob);
				const a = document.createElement('a');
				a.href = url;
				a.download = sanitizeFilename(name) + '.orgloom.json';
				document.body.appendChild(a);
				a.click();
				setTimeout(() => {
					URL.revokeObjectURL(url);
					a.remove();
				}, 0);
				const msg = schemaOnly
					? 'Downloaded schema (' +
						payload.schema.objects.length +
						' object' +
						(payload.schema.objects.length === 1 ? '' : 's') +
						').'
					: 'Downloaded ' + payload.records.length + '-record template.';
				showBulkToast(msg);
				pingAuditEvent('canvas_export_file', {
					recordCount: payload.records.length,
					payload: {
						name,
						schemaOnly: !!schemaOnly,
						objectCount: payload.schema.objects.length,
						includesLoadedData: !!(payload._meta && payload._meta.includesLoadedData),
					},
				});
			}

			async function saveTemplateRemote(name, scope) {
				let payload;
				try {
					payload = buildTemplate({ schemaOnly: true });
				} catch (e) {
					showBulkToast(e.message, 'error');
					return;
				}
				try {
					const r = await csrfFetch('/api/templates', {
						method: 'POST',
						credentials: 'same-origin',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ name, scope: scope === 'team' ? 'team' : 'personal', payload }),
					});
					const data = await r.json().catch(() => ({}));
					if (!r.ok) {
						throw new Error((data && data.error) || 'HTTP ' + r.status);
					}
					const where = scope === 'team' ? 'team workspace' : 'your personal workspace';
					showBulkToast('Saved schema \u201c' + name + '\u201d to ' + where + '.');
				} catch (e) {
					showBulkToast('Save failed: ' + (e.message || e), 'error');
				}
			}

			const ACCEPTED_APP_TAGS = ['Orgloom', 'Org Loom', 'Seedsmith'];

			function _checkFileVersion(meta) {
				const v = meta && meta.version;
				if (v != null && Number(v) > TEMPLATE_VERSION) {
					throw new Error(
						'This file was exported by a newer version of Org Loom (file format v' +
							v +
							', this app reads v' +
							TEMPLATE_VERSION +
							'). Refresh the app and try again.',
					);
				}
			}

			function _isRecordEntry(r) {
				return !!(r && typeof r === 'object' && typeof r.objectName === 'string' && r.objectName);
			}

			function _cleanValues(v) {
				return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
			}

			function _savedCoordinate(value, fallback) {
				const number = Number(value);
				return Number.isFinite(number) ? number : fallback;
			}

			function _payloadCanvasRecordIds(loadedRecords, drafts) {
				const ids = new Map();
				const counts = new Map();
				const assign = (record, kind, naturalRef) => {
					if (
						record &&
						record.canvasRecordId != null &&
						String(record.canvasRecordId) &&
						String(record.canvasRecordId).length <= 128
					) {
						ids.set(record, String(record.canvasRecordId));
						return;
					}
					const base = kind + ':' + String(naturalRef || 'unknown');
					const occurrence = (counts.get(base) || 0) + 1;
					counts.set(base, occurrence);
					ids.set(record, 'legacy:' + base + ':' + occurrence);
				};
				for (const record of loadedRecords) {
					const naturalRef =
						record && record.slot && record.slot.slotId != null
							? 'slot:' + record.slot.slotId
							: record && record.loadedFromId;
					assign(record, 'loaded', naturalRef);
				}
				for (const record of drafts) {
					const naturalRef =
						record && record.slot && record.slot.slotId != null
							? 'slot:' + record.slot.slotId
							: record && record.tempId;
					assign(record, 'draft', naturalRef);
				}
				return ids;
			}

			function _restoreSlot(slot) {
				const restored = {
					slotId: slot.slotId,
					createdAt: Number.isFinite(Number(slot.createdAt)) ? Number(slot.createdAt) : null,
					label: slot.label,
					description: slot.description || null,
					kind: slot.kind || 'whole-record',
					origin: slot.origin || null,
					assigneeSfUserId: slot.assigneeSfUserId || null,
					assigneeName: slot.assigneeName || null,
					assigneeEmail: slot.assigneeEmail || null,
				};
				if (restored.kind === 'fields' && Array.isArray(slot.fields)) {
					restored.fields = slot.fields.slice();
				}
				const unavailableFieldCount = Number(slot.unavailableFieldCount);
				if (Number.isSafeInteger(unavailableFieldCount) && unavailableFieldCount > 0) {
					restored.unavailableFieldCount = unavailableFieldCount;
				}
				return restored;
			}

			const _admitAssociation = window.OrgLoom.importShared.admitAssociation;
			const _skipSuffix = window.OrgLoom.importShared.skipSuffix;

			function _summaryToast(msg, variant, opts) {
				if (opts && typeof opts.undo === 'function' && showBulkToastWithAction) {
					if (typeof opts.undo.arm === 'function') {
						opts.undo.arm();
					}
					showBulkToastWithAction(msg, 'Undo', opts.undo, variant);
				} else {
					showBulkToast(msg, variant);
				}
			}

			function _mergeOffsetY(merge, incomingYs) {
				if (!merge || !incomingYs.length) {
					return 0;
				}
				const existing = canvasState.bulkRecords.filter((r) => !r.isTypeNode);
				if (!existing.length) {
					return 0;
				}
				const maxY = Math.max.apply(
					null,
					existing.map((r) => Number(r.y) || 0),
				);
				const minIncoming = Math.min.apply(null, incomingYs);
				return maxY + 260 - minIncoming;
			}

			function validateTemplate(t) {
				// Treat imported JSON as untrusted input even when it was exported by Org Loom.
				if (!t || typeof t !== 'object') {
					throw new Error('Invalid template: not an object.');
				}
				if (!t._meta || !ACCEPTED_APP_TAGS.includes(t._meta.app)) {
					throw new Error('Not an Orgloom template file.');
				}
				_checkFileVersion(t._meta);
				if (!t.schema || !Array.isArray(t.schema.objects)) {
					throw new Error('Invalid template: missing schema.objects.');
				}
				if (!Array.isArray(t.records)) {
					throw new Error('Invalid template: missing records.');
				}
				if (!Array.isArray(t.associations)) {
					throw new Error('Invalid template: missing associations.');
				}
				if (t.records.length > TEMPLATE_RECORD_CAP) {
					throw new Error('Template exceeds the ' + TEMPLATE_RECORD_CAP + '-record cap.');
				}
			}

			function validateCanvasPayload(p) {
				if (!p || typeof p !== 'object') {
					throw new Error('Invalid canvas file: not an object.');
				}
				if (!p._meta || !ACCEPTED_APP_TAGS.includes(p._meta.app)) {
					throw new Error('Not an Orgloom canvas file.');
				}
				_checkFileVersion(p._meta);
				if (!p.schema || !Array.isArray(p.schema.objects)) {
					throw new Error('Invalid canvas file: missing schema.objects.');
				}
				if (!Array.isArray(p.associations)) {
					throw new Error('Invalid canvas file: missing associations.');
				}
			}

			async function applyTemplate(t, opts) {
				opts = opts || {};
				const schemaOnly = !!opts.schemaOnly;
				const merge = !!opts.merge;
				validateTemplate(t);
				{
					const incoming = Array.isArray(t.records) ? t.records.length : 0;
					const existingCount = merge ? _realRecordCount() : 0;
					if (existingCount + incoming > _CANVAS_RECORD_CAP_get()) {
						throw new Error(
							'Loading this template would put the canvas over the ' +
								_CANVAS_RECORD_CAP_get() +
								'-record cap (' +
								(existingCount + incoming) +
								'). Remove some records or reset the canvas first.',
						);
					}
				}
				// Cross-org imports remain drafts unless the destination matching flow resolves them.
				const _crossOrg = !!(
					t._meta.exportedFrom &&
					window.SF_ORG_ID &&
					t._meta.exportedFrom !== window.SF_ORG_ID
				);
				clearEmptyStarterCard();
				if (!merge) {
					canvasState.selectedObjects = [];
					canvasState.selectedIdSeq = 1;
					canvasState.activeIndex = 0;
					canvasState.hiddenObjects.clear();
					canvasState.bulkRecords = [];
					canvasState.bulkAssociations = [];
					canvasState.bulkIdSeq = 1;
					canvasState.bulkSelectedIds = new Set();
					canvasState.bulkSelectedEdgeId = null;
					canvasState.bulkInitialized = false;
					canvasState._bulkUserDeleted = false;
					canvasState._lastBulkZoomSig = null;
					canvasState._bulkSeenIds = null;
					canvasState._prefetchedTypeNodeKeys.clear();
					canvasState._renderedRecIds.clear();
				}
				const idByIdx = [];
				for (let i = 0; i < t.schema.objects.length; i++) {
					const obj = t.schema.objects[i];
					const parentId = obj.addedFromIdx != null ? idByIdx[obj.addedFromIdx] : null;
					try {
						const entry = await addToSelection(
							obj.name,
							parentId,
							obj.addedVia || null,
							obj.worldPos || null,
						);
						idByIdx.push(entry.id);
					} catch (e) {
						console.warn('Template apply: failed to re-add', obj.name, e);
						idByIdx.push(null);
					}
				}
				let skippedRecords = 0;
				let skippedAssoc = 0;
				let demotedToDrafts = 0;
				if (!schemaOnly) {
					const idMap = new Map();
					const sameOrg = !!(t._meta && t._meta.exportedFrom) && t._meta.exportedFrom === window.SF_ORG_ID;
					const honorLoadedLinks = !!(t._meta && t._meta.preservesLoadedLinks) && sameOrg;
					const _offY = _mergeOffsetY(
						merge,
						t.records.filter(_isRecordEntry).map((r) => Number(r.y) || 200),
					);
					t.records.forEach((r) => {
						if (!_isRecordEntry(r)) {
							skippedRecords += 1;
							return;
						}
						const newId = canvasState.bulkIdSeq++;
						idMap.set(r.id, newId);
						const matchingSel = canvasState.selectedObjects.find((s) => s.name === r.objectName);
						const rec = {
							id: newId,
							objectName: r.objectName,
							label: (matchingSel && matchingSel.label) || r.label || r.objectName,
							x: Number(r.x) || 200,
							y: (Number(r.y) || 200) + _offY,
							values: _cleanValues(r.values),
						};
						encryptedFields.hydrateIntents(rec, r.encryptedFieldIntents, canvasState);
						if (r.loadedFromId) {
							if (honorLoadedLinks) {
								rec.loadedFromId = r.loadedFromId;
								if (r.loadedValues && typeof r.loadedValues === 'object') {
									rec.loadedValues = Object.assign({}, r.loadedValues);
								}
								if (r.pendingDelete) {
									rec.pendingDelete = true;
								}
							} else {
								demotedToDrafts += 1;
							}
						}
						if (r.slot && r.slot.slotId != null) {
							rec.slot = r.slot;
							_observeSlotId(r.slot.slotId);
						}
						canvasState.bulkRecords.push(rec);
					});
					const usedFk = new Set();
					t.associations.forEach((a) => {
						const from = idMap.get(a && a.fromId);
						const to = idMap.get(a && a.toId);
						if (!_admitAssociation(usedFk, from, to, a && a.fieldName)) {
							skippedAssoc += 1;
							return;
						}
						canvasState.bulkAssociations.push({
							id: canvasState.bulkIdSeq++,
							fromId: from,
							toId: to,
							fieldName: a.fieldName,
						});
					});
				}
				canvasState.bulkInitialized = true;
				canvasState.activeIndex = 0;
				if (typeof setGraphView === 'function') {
					setGraphView(schemaOnly ? 'schema' : 'bulk');
				}
				renderAll();
				const _objectCount = (t.schema.objects || []).length;
				if (schemaOnly) {
					_summaryToast(
						'Imported schema: ' +
							_objectCount +
							' object' +
							(_objectCount === 1 ? '' : 's') +
							'. Records were not included.',
						undefined,
						opts,
					);
					if (opts.importFileName) {
						pingAuditEvent('canvas_load_file', {
							recordCount: 0,
							payload: {
								name: opts.importFileName || null,
								mode: merge ? 'merge' : 'replace',
								schemaOnly: true,
								objectCount: _objectCount,
							},
						});
					}
				} else {
					const totalRecords = t.records.length;
					const importedCount = totalRecords - skippedRecords;
					let msg =
						'Imported ' +
						importedCount +
						' of ' +
						totalRecords +
						' record' +
						(totalRecords === 1 ? '' : 's') +
						'.';
					msg += _skipSuffix(skippedRecords, skippedAssoc);
					if (demotedToDrafts > 0) {
						msg +=
							' ' +
							demotedToDrafts +
							' loaded record' +
							(demotedToDrafts === 1 ? '' : 's') +
							' re-imported as draft' +
							(demotedToDrafts === 1 ? '' : 's') +
							' (exported from a different org).';
					} else if (_crossOrg) {
						msg += ' Exported from a different org; Salesforce id references may not match here.';
					}
					const _caveats = skippedRecords > 0 || skippedAssoc > 0 || demotedToDrafts > 0 || _crossOrg;
					_summaryToast(msg, _caveats ? 'error' : undefined, opts);
					if (opts.importFileName) {
						pingAuditEvent('canvas_load_file', {
							recordCount: importedCount,
							payload: {
								name: opts.importFileName || null,
								mode: merge ? 'merge' : 'replace',
								schemaOnly: false,
								objectCount: _objectCount,
								skippedRecords,
								skippedAssoc,
							},
						});
					}
				}
			}

			async function applyCanvasPayload(payload, opts) {
				opts = opts || {};
				const merge = !!opts.merge;
				const loadingCanvasShareRole = opts.ownedByMe === false ? opts.recipientRole || 'viewer' : null;
				const loadingCanvasIdentity =
					opts.canvasIdentity && typeof opts.canvasIdentity === 'object'
						? Object.assign({}, opts.canvasIdentity)
						: null;
				if (!payload || typeof payload !== 'object') {
					showBulkToast('Empty payload: nothing to load.', 'error');
					return;
				}
				const schemaObjects = (payload.schema && payload.schema.objects) || [];
				const loadedRefs = Array.isArray(payload.loadedRecords) ? payload.loadedRecords : [];
				const drafts = Array.isArray(payload.drafts) ? payload.drafts : [];
				const hiddenRecords = Array.isArray(payload.hiddenRecords) ? payload.hiddenRecords : [];
				const associations = Array.isArray(payload.associations) ? payload.associations : [];
				const canvasRecordIds = _payloadCanvasRecordIds(loadedRefs, drafts);
				const recipientUsesSavedMetadata =
					loadingCanvasShareRole === 'viewer' || loadingCanvasShareRole === 'contributor';

				const incomingCount = loadedRefs.length + drafts.length + hiddenRecords.length;
				let _cap;
				if (merge) {
					_cap = canvasCapCheck(incomingCount);
				} else {
					const _probe = canvasCapCheck(incomingCount);
					_cap =
						incomingCount > _probe.cap
							? { blocked: true, reason: _probe.reason }
							: { blocked: false, reason: null };
				}
				if (_cap.blocked) {
					showBulkToast(_cap.reason, 'error');
					return;
				}
				canvasState._renderCanvasShareRole = loadingCanvasShareRole;
				clearEmptyStarterCard();
				if (!merge) {
					canvasState.selectedObjects = [];
					canvasState.selectedIdSeq = 1;
					canvasState.activeIndex = 0;
					canvasState.hiddenObjects.clear();
					canvasState.currentCanvas = loadingCanvasIdentity;
					if (window.Orgloom && window.Orgloom.canvasState && window.Orgloom.canvasState.clearDraft) {
						window.Orgloom.canvasState.clearDraft();
					}
					canvasState.bulkRecords = [];
					canvasState.bulkAssociations = [];
					canvasState.bulkIdSeq = 1;
					canvasState.bulkSelectedIds = new Set();
					canvasState.bulkSelectedEdgeId = null;
					canvasState.bulkInitialized = false;
					canvasState._bulkUserDeleted = false;
					canvasState._lastBulkZoomSig = null;
					canvasState._bulkSeenIds = null;
					canvasState._prefetchedTypeNodeKeys.clear();
					canvasState._renderedRecIds.clear();
					canvasState._autoSpawnedPending = true; // suppress auto-spawn after load
					canvasState.draftDescribeCache = {};
				}
				for (const object of schemaObjects) {
					if (!object || !object.name || !Array.isArray(object.draftFields)) {
						continue;
					}
					canvasState.draftDescribeCache[object.name] = {
						name: object.name,
						label: object.label || object.name,
						fields: object.draftFields.map((field) => Object.assign({}, field)),
						recordTypes: [],
						_canvasSnapshot: true,
					};
				}
				for (const draft of drafts) {
					if (!draft || !draft.objectName || canvasState.draftDescribeCache[draft.objectName]) {
						continue;
					}
					canvasState.draftDescribeCache[draft.objectName] = {
						name: draft.objectName,
						label: draft.objectName,
						fields: Object.keys(draft.values || {}).map((name) => ({
							name,
							label: name,
							type: 'string',
							createable: true,
							updateable: false,
						})),
						recordTypes: [],
						_canvasSnapshot: true,
					};
				}

				const idByIdx = [];
				for (let i = 0; i < schemaObjects.length; i++) {
					const obj = schemaObjects[i];
					const parentId = obj.addedFromIdx != null ? idByIdx[obj.addedFromIdx] : null;
					if (recipientUsesSavedMetadata) {
						const entry = {
							id: canvasState.selectedIdSeq++,
							name: obj.name,
							label: obj.label || obj.name,
							data: null,
							addedFrom: parentId != null ? parentId : null,
							addedVia: obj.addedVia || null,
							worldPos: obj.worldPos || { x: 0, y: i * 260 },
						};
						canvasState.selectedObjects.push(entry);
						canvasState.activeIndex = canvasState.selectedObjects.length - 1;
						idByIdx.push(entry.id);
						continue;
					}
					try {
						const entry = await addToSelection(
							obj.name,
							parentId,
							obj.addedVia || null,
							obj.worldPos || null,
						);
						idByIdx.push(entry.id);
					} catch (e) {
						console.warn('Canvas apply: failed to re-add', obj.name, e);
						idByIdx.push(null);
					}
				}

				const loadedById = new Map(); // loadedFromId → bulkId
				const slotById = new Map(); // slotId → bulkId
				let droppedFromAccess = 0;
				let skippedRecords = 0;
				const _offY = _mergeOffsetY(
					merge,
					loadedRefs
						.filter(_isRecordEntry)
						.map((r) => _savedCoordinate(r.y, 200))
						.concat(drafts.filter(_isRecordEntry).map((d) => _savedCoordinate(d.y, 200)))
						.concat(hiddenRecords.map((record) => _savedCoordinate(record && record.y, 200))),
				);
				const pushInaccessiblePlaceholder = (ref, isSlot) => {
					droppedFromAccess++;
					const hideMetadata = !!loadingCanvasShareRole;
					const matchingSel = hideMetadata
						? null
						: canvasState.selectedObjects.find((s) => s.name === ref.objectName);
					const newId = canvasState.bulkIdSeq++;
					if (ref.loadedFromId) {
						loadedById.set(ref.loadedFromId, newId);
					}
					const recObj = {
						id: newId,
						objectName: hideMetadata ? null : ref.objectName,
						label: hideMetadata
							? 'Hidden Salesforce content'
							: (matchingSel && matchingSel.label) || ref.objectName,
						fromSelectionId: matchingSel ? matchingSel.id : null,
						loadedFromId: hideMetadata ? null : ref.loadedFromId || null,
						x: _savedCoordinate(ref.x, 200),
						y: _savedCoordinate(ref.y, 200) + _offY,
						values: {},
						...(hideMetadata ? {} : { _canvasRecordId: canvasRecordIds.get(ref) }),
						_inaccessible: true,
						_permissionHidden: hideMetadata,
					};
					if (!hideMetadata && isSlot && ref.slot && ref.slot.slotId != null) {
						recObj.slot = _restoreSlot(ref.slot);
						slotById.set(ref.slot.slotId, newId);
						_observeSlotId(ref.slot.slotId);
					}
					canvasState.bulkRecords.push(recObj);
				};
				for (let hiddenIndex = 0; hiddenIndex < hiddenRecords.length; hiddenIndex++) {
					const hidden = hiddenRecords[hiddenIndex];
					if (!hidden || typeof hidden !== 'object') {
						continue;
					}
					droppedFromAccess++;
					canvasState.bulkRecords.push({
						id: -(hiddenIndex + 1),
						objectName: null,
						label: 'Hidden Salesforce content',
						x: _savedCoordinate(hidden.x, 200),
						y: _savedCoordinate(hidden.y, 200) + _offY,
						values: {},
						_inaccessible: true,
						_permissionHidden: true,
						_permissionHiddenId: hidden.hiddenId || 'hidden-' + (hiddenIndex + 1),
					});
				}
				const mergeExistingByKey = new Map();
				if (merge) {
					canvasState.bulkRecords.forEach((br) => {
						if (br.isTypeNode || !br.loadedFromId) {
							return;
						}
						mergeExistingByKey.set(br.objectName + '::' + br.loadedFromId, br.id);
					});
				}
				let skippedExistingMerge = 0;
				const _fetchJobs = [];
				for (const ref of loadedRefs) {
					if (!_isRecordEntry(ref)) {
						skippedRecords += 1;
						continue;
					}
					const isSlot = ref.slot && ref.slot.slotId != null;
					const hasLoadedId = !!ref.loadedFromId;
					if (merge && hasLoadedId) {
						const existingId = mergeExistingByKey.get(ref.objectName + '::' + ref.loadedFromId);
						if (existingId != null) {
							loadedById.set(ref.loadedFromId, existingId);
							skippedExistingMerge++;
							continue;
						}
					}
					if (isSlot && !hasLoadedId) {
						const matchingSel = canvasState.selectedObjects.find((s) => s.name === ref.objectName);
						const newId = canvasState.bulkIdSeq++;
						slotById.set(ref.slot.slotId, newId);
						_observeSlotId(ref.slot.slotId);
						canvasState.bulkRecords.push({
							id: newId,
							objectName: ref.objectName,
							label: (matchingSel && matchingSel.label) || ref.objectName,
							fromSelectionId: matchingSel ? matchingSel.id : null,
							x: _savedCoordinate(ref.x, 200),
							y: _savedCoordinate(ref.y, 200) + _offY,
							values: {},
							_canvasRecordId: canvasRecordIds.get(ref),
							slot: _restoreSlot(ref.slot),
							_recipientSlot: true,
						});
						continue;
					}
					_fetchJobs.push({ ref: ref, isSlot: isSlot });
				}
				const _fetchResults = new Array(_fetchJobs.length);
				{
					let _next = 0;
					const _fetchWorker = async () => {
						for (;;) {
							const idx = _next++;
							if (idx >= _fetchJobs.length) {
								return;
							}
							const job = _fetchJobs[idx];
							try {
								const r = await csrfFetch(
									'/api/objects/' +
										encodeURIComponent(job.ref.objectName) +
										'/records/' +
										encodeURIComponent(job.ref.loadedFromId),
									{ credentials: 'same-origin' },
								);
								_fetchResults[idx] = r.ok ? { ok: true, sf: await r.json() } : { ok: false };
							} catch (e) {
								_fetchResults[idx] = { ok: false };
							}
						}
					};
					await Promise.all(Array.from({ length: Math.min(6, _fetchJobs.length) }, _fetchWorker));
				}
				_fetchJobs.forEach((job, jobIdx) => {
					const ref = job.ref;
					const isSlot = job.isSlot;
					const _result = _fetchResults[jobIdx];
					if (!_result || !_result.ok) {
						pushInaccessiblePlaceholder(ref, isSlot);
						return;
					}
					const matchingSel = canvasState.selectedObjects.find((s) => s.name === ref.objectName);
					const newId = canvasState.bulkIdSeq++;
					loadedById.set(ref.loadedFromId, newId);
					const _fresh = _result.sf || {};
					const recObj = {
						id: newId,
						objectName: ref.objectName,
						label: (matchingSel && matchingSel.label) || ref.objectName,
						fromSelectionId: matchingSel ? matchingSel.id : null,
						loadedFromId: ref.loadedFromId,
						x: _savedCoordinate(ref.x, 200),
						y: _savedCoordinate(ref.y, 200) + _offY,
						_canvasRecordId: canvasRecordIds.get(ref),
						loadedValues: Object.assign({}, _fresh),
						values:
							ref.changes && typeof ref.changes === 'object'
								? Object.assign({}, _fresh, ref.changes)
								: _fresh,
					};
					encryptedFields.hydrateIntents(recObj, ref.encryptedFieldIntents, canvasState);
					if (ref.pendingDelete) {
						recObj.pendingDelete = true;
					}
					if (isSlot) {
						recObj.slot = _restoreSlot(ref.slot);
						if (recObj.slot.kind === 'fields') {
							if (!opts.ownedByMe) {
								recObj._recipientSlot = true;
							}
						}
						slotById.set(ref.slot.slotId, newId);
						_observeSlotId(ref.slot.slotId);
					}
					canvasState.bulkRecords.push(recObj);
				});

				const draftById = new Map(); // payload tempId → bulkId
				drafts.forEach((d) => {
					if (!_isRecordEntry(d)) {
						skippedRecords += 1;
						return;
					}
					const newId = canvasState.bulkIdSeq++;
					draftById.set(d.tempId, newId);
					const matchingSel = canvasState.selectedObjects.find((s) => s.name === d.objectName);
					const recObj = {
						id: newId,
						objectName: d.objectName,
						label: (matchingSel && matchingSel.label) || d.objectName,
						fromSelectionId: matchingSel ? matchingSel.id : null,
						x: _savedCoordinate(d.x, 200),
						y: _savedCoordinate(d.y, 200) + _offY,
						values: _cleanValues(d.values),
						_persistedTempId: d.tempId,
						_canvasRecordId: canvasRecordIds.get(d),
					};
					encryptedFields.hydrateIntents(recObj, d.encryptedFieldIntents, canvasState);
					if (d.slot && d.slot.slotId != null) {
						recObj.slot = _restoreSlot(d.slot);
						slotById.set(d.slot.slotId, newId);
						_observeSlotId(d.slot.slotId);
						if (!opts.ownedByMe) {
							recObj._recipientSlot = true;
						}
					}
					canvasState.bulkRecords.push(recObj);
				});

				const resolveEndpoint = (e) => {
					if (!e) {
						return null;
					}
					if (e.kind === 'loaded') {
						return loadedById.get(e.ref);
					}
					if (e.kind === 'draft') {
						return draftById.get(e.ref);
					}
					if (e.kind === 'slot') {
						return slotById.get(e.ref);
					}
					return null;
				};
				const existingAssocKey = new Set();
				const usedFk = new Set();
				canvasState.bulkAssociations.forEach((a) => {
					if (merge) {
						existingAssocKey.add(a.fromId + '->' + a.toId + '::' + a.fieldName);
					}
					usedFk.add(a.fromId + '::' + a.fieldName);
				});
				let skippedAssoc = 0;
				associations.forEach((a) => {
					if (!a || typeof a !== 'object') {
						skippedAssoc += 1;
						return;
					}
					const fromId = resolveEndpoint(a.from);
					const toId = resolveEndpoint(a.to);
					if (loadingCanvasShareRole) {
						const fromRecord = canvasState.bulkRecords.find((record) => record && record.id === fromId);
						const toRecord = canvasState.bulkRecords.find((record) => record && record.id === toId);
						if ((fromRecord && fromRecord._inaccessible) || (toRecord && toRecord._inaccessible)) {
							skippedAssoc += 1;
							return;
						}
					}
					const key = fromId + '->' + toId + '::' + a.fieldName;
					if (merge && existingAssocKey.has(key)) {
						return;
					}
					if (!_admitAssociation(usedFk, fromId, toId, a.fieldName)) {
						skippedAssoc += 1;
						return;
					}
					canvasState.bulkAssociations.push({
						id: canvasState.bulkIdSeq++,
						fromId,
						toId,
						fieldName: a.fieldName,
					});
					if (merge) {
						existingAssocKey.add(key);
					}
				});

				canvasState.bulkInitialized = true;
				if (typeof setGraphView === 'function') {
					setGraphView('bulk');
				}
				const shouldPreflight = !recipientUsesSavedMetadata || loadingCanvasShareRole === 'contributor';
				if (shouldPreflight && loadingCanvasShareRole) {
					try {
						await _runSlotPreflight();
					} catch (error) {
						console.warn('slot preflight failed:', error);
					}
				}
				renderAll();
				if (shouldPreflight && !loadingCanvasShareRole) {
					_runSlotPreflight().catch((e) => console.warn('slot preflight failed:', e));
				}
				let msg =
					'Loaded canvas: ' +
					loadedById.size +
					' existing record' +
					(loadedById.size === 1 ? '' : 's') +
					', ' +
					draftById.size +
					' draft' +
					(draftById.size === 1 ? '' : 's') +
					'.';
				if (droppedFromAccess > 0) {
					msg +=
						' (' +
						droppedFromAccess +
						' item' +
						(droppedFromAccess === 1 ? '' : 's') +
						' hidden by your Salesforce permissions.)';
				}
				if (skippedExistingMerge > 0) {
					msg +=
						' Skipped ' +
						skippedExistingMerge +
						' record' +
						(skippedExistingMerge === 1 ? '' : 's') +
						' already on the canvas.';
				}
				const _skips = _skipSuffix(skippedRecords, skippedAssoc);
				msg += _skips;
				const pendingEncrypted = canvasState.bulkRecords.flatMap((record) =>
					encryptedFields.unresolvedIntentNames(record, canvasState).map((fieldName) => {
						const describe = canvasState.describeCache && canvasState.describeCache[record.objectName];
						const field =
							describe && Array.isArray(describe.fields)
								? describe.fields.find((candidate) => candidate && candidate.name === fieldName)
								: null;
						return (record.label || record.objectName) + ' · ' + ((field && field.label) || fieldName);
					}),
				);
				if (pendingEncrypted.length > 0) {
					msg +=
						' Encrypted field changes without a replacement will be left unchanged on upload: ' +
						pendingEncrypted.slice(0, 4).join(', ') +
						(pendingEncrypted.length > 4 ? ', and ' + (pendingEncrypted.length - 4) + ' more.' : '.');
				}
				_summaryToast(msg, _skips ? 'error' : undefined, opts);
				if (opts.importFileName) {
					pingAuditEvent('canvas_load_file', {
						recordCount: loadedById.size + draftById.size,
						payload: {
							name: opts.importFileName || null,
							mode: merge ? 'merge' : 'replace',
							shape: 'saved-canvas',
							loadedCount: loadedById.size,
							draftCount: draftById.size,
							droppedFromAccess,
							skippedExistingMerge,
							skippedRecords,
							skippedAssoc,
						},
					});
				}
			}

			return {
				buildTemplate: buildTemplate,
				sanitizeFilename: sanitizeFilename,
				buildCanvasPayload: buildCanvasPayload,
				ensureDraftSlotMetadata: ensureDraftSlotMetadata,
				downloadTemplate: downloadTemplate,
				saveTemplateRemote: saveTemplateRemote,
				validateTemplate: validateTemplate,
				validateCanvasPayload: validateCanvasPayload,
				applyTemplate: applyTemplate,
				applyCanvasPayload: applyCanvasPayload,
			};
		},
	};
})();
