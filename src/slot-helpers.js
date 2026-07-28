// Contributor-slot projection and server-side field allowlisting.
export function slotKind(slot) {
	if (!slot) {
		return null;
	}
	return slot.kind || 'whole-record';
}

export function stripDraftValuesForSave(payload) {
	return payload;
}

export function payloadContainsSlots(payload) {
	if (!payload || typeof payload !== 'object') {
		return false;
	}
	for (const key of ['loadedRecords', 'drafts']) {
		const records = Array.isArray(payload[key]) ? payload[key] : [];
		if (
			records.some((record) => record && typeof record === 'object' && record.slot && record.slot.slotId != null)
		) {
			return true;
		}
	}
	return false;
}

export function stripDraftsForNonOwner(payload) {
	// Non-owners receive only drafts intentionally exposed through assigned slots.
	const safeDrafts = Array.isArray(payload && payload.drafts)
		? payload.drafts.map((d) => {
				if (!d || typeof d !== 'object') {
					return d;
				}
				const out = {
					tempId: d.tempId,
					objectName: d.objectName,
					x: typeof d.x === 'number' ? d.x : 0,
					y: typeof d.y === 'number' ? d.y : 0,
					values: d.values || {},
				};
				if (d.canvasRecordId != null) {
					out.canvasRecordId = d.canvasRecordId;
				}
				if (d.slot) {
					out.slot = d.slot;
				}
				return out;
			})
		: [];
	const safeLoaded = Array.isArray(payload && payload.loadedRecords)
		? payload.loadedRecords
				.map((l) => {
					if (!l.slot) {
						return l;
					}
					const kind = slotKind(l.slot);
					if (kind === 'fields') {
						return l;
					}
					safeDrafts.push({
						tempId: 'slot-request-' + String(l.slot.slotId),
						objectName: l.objectName,
						x: typeof l.x === 'number' ? l.x : 0,
						y: typeof l.y === 'number' ? l.y : 0,
						values: {},
						slot: l.slot,
						...(l.canvasRecordId != null ? { canvasRecordId: l.canvasRecordId } : {}),
					});
					return null;
				})
				.filter(Boolean)
		: [];
	return Object.assign({}, payload || {}, {
		drafts: safeDrafts,
		loadedRecords: safeLoaded,
	});
}

export function slotProgress(rec) {
	if (!rec || !rec.slot || rec.slot.slotId == null) {
		return null;
	}
	const kind = slotKind(rec.slot);
	if (kind === 'fields') {
		const fields = Array.isArray(rec.slot.fields) ? rec.slot.fields : [];
		const total = fields.length;
		const v = rec.values || {};
		let filled = 0;
		for (const f of fields) {
			const x = v[f];
			if (x != null && x !== '') {
				filled++;
			}
		}
		return { filled, total };
	}
	const loaded = !!rec.loadedFromId;
	let hasValue = false;
	const v = rec.values || {};
	for (const k in v) {
		if (v[k] != null && v[k] !== '') {
			hasValue = true;
			break;
		}
	}
	return { filled: loaded || hasValue ? 1 : 0, total: 1 };
}

export function aggregateSlotProgress(records) {
	let filled = 0,
		total = 0,
		recordCount = 0;
	if (!Array.isArray(records)) {
		return { filled, total, recordCount };
	}
	for (const r of records) {
		if (!r || r.isTypeNode || r.isPending) {
			continue;
		}
		const p = slotProgress(r);
		if (!p) {
			continue;
		}
		filled += p.filled;
		total += p.total;
		recordCount++;
	}
	return { filled, total, recordCount };
}

export function slotProgressClass(progress) {
	if (!progress || progress.total === 0) {
		return 'slot-progress-empty';
	}
	if (progress.filled >= progress.total) {
		return 'slot-progress-full';
	}
	if (progress.filled === 0) {
		return 'slot-progress-empty';
	}
	return 'slot-progress-partial';
}

export function mergeSlotFills({ records, fills, recipientSfUserId }) {
	const safeRecords = Array.isArray(records) ? records.slice() : [];
	const safeFills = Array.isArray(fills) ? fills : [];

	const slotIndexById = new Map();
	safeRecords.forEach((rec, idx) => {
		if (rec && rec.slot && rec.slot.slotId != null) {
			slotIndexById.set(rec.slot.slotId, idx);
		}
	});

	let appliedCount = 0;
	const applied = [];
	const skipped = [];

	for (const fill of safeFills) {
		if (!fill || typeof fill !== 'object') {
			continue;
		}
		const slotId = fill.slotId;
		if (slotId == null || !slotIndexById.has(slotId)) {
			skipped.push({ slotId, reason: 'unknown_slot' });
			continue;
		}
		const idx = slotIndexById.get(slotId);
		const rec = safeRecords[idx];
		const assigneeSfUserId = rec.slot && rec.slot.assigneeSfUserId ? String(rec.slot.assigneeSfUserId) : null;
		if (assigneeSfUserId && assigneeSfUserId !== recipientSfUserId) {
			skipped.push({ slotId, reason: 'not_assigned_to_you', assignee: assigneeSfUserId });
			continue;
		}
		const kind = slotKind(rec.slot);
		const incoming = fill.values && typeof fill.values === 'object' ? fill.values : {};
		const merged = Object.assign({}, rec.values || {});
		if (kind === 'fields') {
			const allowed = new Set(Array.isArray(rec.slot.fields) ? rec.slot.fields : []);
			for (const k of Object.keys(incoming)) {
				if (allowed.has(k)) {
					merged[k] = incoming[k];
				}
			}
		} else {
			Object.assign(merged, incoming);
		}
		safeRecords[idx] = Object.assign({}, rec, { values: merged });
		appliedCount += 1;
		applied.push({ slotId, fieldCount: Object.keys(incoming).length });
	}

	return { records: safeRecords, applied, skipped, appliedCount };
}

export function applyContributionsToPayload(payload, contributions) {
	const source = payload && typeof payload === 'object' ? payload : {};
	const loaded = Array.isArray(source.loadedRecords) ? source.loadedRecords : [];
	const drafts = Array.isArray(source.drafts) ? source.drafts : [];
	let records = loaded
		.map((record) => Object.assign({}, record, { values: Object.assign({}, record.changes || {}) }))
		.concat(drafts.map((record) => Object.assign({}, record, { values: Object.assign({}, record.values || {}) })));
	const appliedContributionIds = [];
	const skipped = [];
	const completedWholeRequests = new Map();

	for (const contribution of Array.isArray(contributions) ? contributions : []) {
		if (!contribution || !contribution.fill) {
			continue;
		}
		const submittedSlotId = contribution.fill.slotId;
		const submittedRecordIndex = records.findIndex(
			(record) =>
				record &&
				record.slot &&
				record.slot.slotId != null &&
				String(record.slot.slotId) === String(submittedSlotId),
		);
		const submittedRecord = submittedRecordIndex >= 0 ? records[submittedRecordIndex] : null;
		const completesWholeRequest = submittedRecord && slotKind(submittedRecord.slot) === 'whole-record';
		const result = mergeSlotFills({
			records,
			fills: [contribution.fill],
			recipientSfUserId: contribution.contributorSfUserId || null,
		});
		if (result.appliedCount > 0) {
			records = result.records;
			if (completesWholeRequest && submittedRecordIndex >= 0) {
				const completedRecord = Object.assign({}, records[submittedRecordIndex]);
				delete completedRecord.slot;
				delete completedRecord._recipientSlot;
				records[submittedRecordIndex] = completedRecord;
				const endpoint = completedRecord.loadedFromId
					? { kind: 'loaded', ref: completedRecord.loadedFromId }
					: completedRecord.tempId != null
						? { kind: 'draft', ref: completedRecord.tempId }
						: null;
				if (endpoint) {
					completedWholeRequests.set(String(submittedSlotId), endpoint);
				}
			}
			if (contribution.id) {
				appliedContributionIds.push(contribution.id);
			}
		} else {
			skipped.push(...result.skipped.map((entry) => Object.assign({ contributionId: contribution.id }, entry)));
		}
	}

	const associations = Array.isArray(source.associations)
		? source.associations.map((association) => {
				if (!association || typeof association !== 'object') {
					return association;
				}
				const rewriteEndpoint = (endpoint) => {
					if (!endpoint || endpoint.kind !== 'slot' || endpoint.ref == null) {
						return endpoint;
					}
					return completedWholeRequests.get(String(endpoint.ref)) || endpoint;
				};
				return Object.assign({}, association, {
					from: rewriteEndpoint(association.from),
					to: rewriteEndpoint(association.to),
				});
			})
		: source.associations;

	return {
		payload: Object.assign({}, source, {
			loadedRecords: records.slice(0, loaded.length).map((record, index) => {
				const out = Object.assign({}, loaded[index], { changes: Object.assign({}, record.values || {}) });
				delete out.values;
				return out;
			}),
			drafts: records.slice(loaded.length),
			...(Array.isArray(associations) ? { associations } : {}),
		}),
		appliedContributionIds,
		skipped,
	};
}

function _pickAllowedValues(values, allowed) {
	if (!values || typeof values !== 'object' || Array.isArray(values)) {
		return undefined;
	}
	const out = {};
	for (const [name, value] of Object.entries(values)) {
		if (allowed && allowed.has(name)) {
			out[name] = value;
		}
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function _objectAccess(accessByObject, objectName) {
	const raw = accessByObject instanceof Map ? accessByObject.get(objectName) : null;
	if (raw instanceof Set) {
		return {
			visible: raw.size > 0,
			label: objectName,
			queryable: raw.size > 0,
			createable: false,
			updateable: false,
			readableFields: raw,
			fields: new Map(),
		};
	}
	if (!raw || typeof raw !== 'object' || raw.visible === false) {
		return {
			visible: false,
			label: null,
			queryable: false,
			createable: false,
			updateable: false,
			readableFields: new Set(),
			fields: new Map(),
		};
	}
	const readableFields =
		raw.readableFields instanceof Set
			? raw.readableFields
			: new Set(Array.isArray(raw.readableFields) ? raw.readableFields : []);
	const fields =
		raw.fields instanceof Map
			? raw.fields
			: new Map(
					Array.isArray(raw.fields)
						? raw.fields.filter((field) => field && field.name).map((field) => [field.name, field])
						: [],
				);
	return {
		visible: raw.visible !== false,
		label: raw.label || objectName,
		queryable: raw.queryable !== false,
		createable: !!raw.createable,
		updateable: !!raw.updateable,
		readableFields,
		fields,
	};
}

function _projectSlot(slot, readableFields) {
	if (!slot || typeof slot !== 'object') {
		return slot;
	}
	const projected = Object.assign({}, slot);
	if ((projected.kind || 'whole-record') === 'fields') {
		projected.fields = (Array.isArray(projected.fields) ? projected.fields : []).filter((name) =>
			readableFields.has(name),
		);
	}
	return projected;
}

function _hiddenCanvasEntry(record, ordinal) {
	return {
		hiddenId: 'hidden-' + ordinal,
		x: typeof record.x === 'number' ? record.x : 0,
		y: typeof record.y === 'number' ? record.y : 0,
		reason: 'salesforce-permissions',
	};
}

function _projectFieldMetadata(field) {
	if (!field || typeof field !== 'object' || !field.name) {
		return null;
	}
	return {
		name: field.name,
		label: field.label || field.name,
		type: field.type || 'string',
		createable: !!field.createable,
		updateable: !!field.updateable,
		required: !!field.required,
		nillable: field.nillable !== false,
		defaultedOnCreate: !!field.defaultedOnCreate,
		calculated: !!field.calculated,
		autoNumber: !!field.autoNumber,
		nameField: !!field.nameField,
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
	};
}

export function projectSharedCanvasPayload(payload, accessByObject) {
	const source = payload && typeof payload === 'object' ? payload : {};
	const access = accessByObject instanceof Map ? accessByObject : new Map();
	const hiddenRecords = Array.isArray(source.hiddenRecords) ? source.hiddenRecords.slice() : [];
	const loadedRecords = [];
	for (const record of Array.isArray(source.loadedRecords) ? source.loadedRecords : []) {
		if (!record || typeof record !== 'object') {
			continue;
		}
		const objectAccess = _objectAccess(access, record.objectName);
		if (!objectAccess.visible || !objectAccess.queryable) {
			hiddenRecords.push(_hiddenCanvasEntry(record, hiddenRecords.length + 1));
			continue;
		}
		const allowed = objectAccess.readableFields;
		const projected = Object.assign({}, record);
		const values = _pickAllowedValues(record.values, allowed);
		const changes = _pickAllowedValues(record.changes, allowed);
		delete projected.values;
		delete projected.changes;
		if (values) {
			projected.values = values;
		}
		if (changes) {
			projected.changes = changes;
		}
		if (projected.slot) {
			projected.slot = _projectSlot(projected.slot, allowed);
		}
		loadedRecords.push(projected);
	}

	const drafts = [];
	for (const record of Array.isArray(source.drafts) ? source.drafts : []) {
		if (!record || typeof record !== 'object') {
			continue;
		}
		const objectAccess = _objectAccess(access, record.objectName);
		if (!objectAccess.visible) {
			hiddenRecords.push(_hiddenCanvasEntry(record, hiddenRecords.length + 1));
			continue;
		}
		const projected = Object.assign({}, record);
		projected.objectName = record.objectName;
		const values = _pickAllowedValues(record.values, objectAccess.readableFields);
		delete projected.values;
		if (values) {
			projected.values = values;
		}
		if (projected.slot) {
			projected.slot = _projectSlot(projected.slot, objectAccess.readableFields);
		}
		drafts.push(projected);
	}

	const schema = source.schema && typeof source.schema === 'object' ? source.schema : null;
	const intendedFieldsByObject = new Map();
	const wholeRecordRequests = new Set();
	for (const record of drafts) {
		if (!record || !record.objectName) {
			continue;
		}
		if (!intendedFieldsByObject.has(record.objectName)) {
			intendedFieldsByObject.set(record.objectName, new Set());
		}
		const intended = intendedFieldsByObject.get(record.objectName);
		Object.keys(record.values || {}).forEach((name) => intended.add(name));
		if (record.slot && (record.slot.kind || 'whole-record') === 'fields') {
			(record.slot.fields || []).forEach((name) => intended.add(name));
		} else if (record.slot) {
			wholeRecordRequests.add(record.objectName);
		}
	}
	const projectedSchema = schema
		? Object.assign({}, schema, {
				objects: (Array.isArray(schema.objects) ? schema.objects : [])
					.map((object) => {
						if (!object || typeof object !== 'object' || !object.name) {
							return null;
						}
						const objectAccess = _objectAccess(access, object.name);
						if (!objectAccess.visible) {
							return null;
						}
						const intended = intendedFieldsByObject.get(object.name) || new Set();
						if (wholeRecordRequests.has(object.name)) {
							for (const [name, field] of objectAccess.fields) {
								if (field && field.createable) {
									intended.add(name);
								}
							}
						}
						const draftFields = Array.from(intended)
							.map((name) => _projectFieldMetadata(objectAccess.fields.get(name)))
							.filter(Boolean);
						const projected = {
							name: object.name,
							label: objectAccess.label || object.name,
							worldPos: object.worldPos || null,
						};
						if (draftFields.length > 0) {
							projected.draftFields = draftFields;
						}
						return projected;
					})
					.filter(Boolean),
			})
		: schema;

	const loadedById = new Map();
	const draftById = new Map();
	const slotById = new Map();
	for (const record of loadedRecords) {
		if (!record || typeof record !== 'object') {
			continue;
		}
		if (record.loadedFromId) {
			loadedById.set(String(record.loadedFromId), record);
		}
		if (record.slot && record.slot.slotId != null) {
			slotById.set(String(record.slot.slotId), record);
		}
	}
	for (const draft of drafts) {
		if (!draft || typeof draft !== 'object') {
			continue;
		}
		if (draft.tempId != null) {
			draftById.set(String(draft.tempId), draft);
		}
		if (draft.slot && draft.slot.slotId != null) {
			slotById.set(String(draft.slot.slotId), draft);
		}
	}
	const recordForEndpoint = (endpoint) => {
		if (!endpoint || endpoint.ref == null) {
			return null;
		}
		const ref = String(endpoint.ref);
		if (endpoint.kind === 'loaded') {
			return loadedById.get(ref) || null;
		}
		if (endpoint.kind === 'draft') {
			return draftById.get(ref) || null;
		}
		if (endpoint.kind === 'slot') {
			return slotById.get(ref) || null;
		}
		return null;
	};
	const projectedAssociations = (Array.isArray(source.associations) ? source.associations : []).filter(
		(association) => {
			if (!association || typeof association !== 'object' || !association.fieldName) {
				return false;
			}
			const fromRecord = recordForEndpoint(association.from);
			const toRecord = recordForEndpoint(association.to);
			if (!fromRecord || !toRecord) {
				return false;
			}
			if (fromRecord.loadedFromId) {
				const allowed = _objectAccess(access, fromRecord.objectName).readableFields;
				if (!allowed.has(association.fieldName)) {
					return false;
				}
			}
			if (toRecord.loadedFromId) {
				if (!_objectAccess(access, toRecord.objectName).visible) {
					return false;
				}
			}
			return true;
		},
	);

	return Object.assign({}, source, {
		loadedRecords,
		drafts,
		hiddenRecords,
		associations: projectedAssociations,
		...(projectedSchema ? { schema: projectedSchema } : {}),
	});
}

export function projectSharedRelationshipsByVisibility(payload, visibility) {
	const source = payload && typeof payload === 'object' ? payload : {};
	const policy = visibility && typeof visibility === 'object' ? visibility : {};
	const loadedRecords = policy.loadedRecords && typeof policy.loadedRecords === 'object' ? policy.loadedRecords : {};
	const slots = policy.slots && typeof policy.slots === 'object' ? policy.slots : {};
	const sfIdKey = (value) =>
		String(value || '')
			.slice(0, 15)
			.toLowerCase();
	const endpointVisible = (endpoint) => {
		if (!endpoint || endpoint.ref == null) {
			return false;
		}
		if (endpoint.kind === 'draft') {
			return true;
		}
		if (endpoint.kind === 'loaded') {
			return !!loadedRecords[sfIdKey(endpoint.ref)];
		}
		if (endpoint.kind === 'slot') {
			return !!(slots[String(endpoint.ref)] && slots[String(endpoint.ref)].visible);
		}
		return false;
	};
	const hiddenRecords = Array.isArray(source.hiddenRecords) ? source.hiddenRecords.slice() : [];
	const projectedLoadedRecords = [];
	for (const record of Array.isArray(source.loadedRecords) ? source.loadedRecords : []) {
		if (!record || !loadedRecords[sfIdKey(record.loadedFromId)]) {
			if (record && typeof record === 'object') {
				hiddenRecords.push(_hiddenCanvasEntry(record, hiddenRecords.length + 1));
			}
			continue;
		}
		projectedLoadedRecords.push(record);
	}
	return Object.assign({}, source, {
		loadedRecords: projectedLoadedRecords,
		hiddenRecords,
		associations: (Array.isArray(source.associations) ? source.associations : []).filter(
			(association) => association && endpointVisible(association.from) && endpointVisible(association.to),
		),
	});
}

export function planSlotFills({ records, fills, recipientSfUserId }) {
	// Treat client fills as requests: derive writable fields from the saved slot manifest, not the payload.
	const safeRecords = Array.isArray(records) ? records : [];
	const safeFills = Array.isArray(fills) ? fills : [];

	const slotIndexById = new Map();
	safeRecords.forEach((rec, idx) => {
		if (rec && rec.slot && rec.slot.slotId != null) {
			slotIndexById.set(rec.slot.slotId, idx);
		}
	});

	const applied = [];
	const skipped = [];
	let appliedCount = 0;

	const updateByRecordId = new Map(); // recordId → { objectName, fields }

	for (const fill of safeFills) {
		if (!fill || typeof fill !== 'object') {
			continue;
		}
		const slotId = fill.slotId;
		if (slotId == null || !slotIndexById.has(slotId)) {
			skipped.push({ slotId, reason: 'unknown_slot' });
			continue;
		}
		const idx = slotIndexById.get(slotId);
		const rec = safeRecords[idx];
		const assigneeSfUserId = rec.slot && rec.slot.assigneeSfUserId ? String(rec.slot.assigneeSfUserId) : null;
		if (assigneeSfUserId && assigneeSfUserId !== recipientSfUserId) {
			skipped.push({ slotId, reason: 'not_assigned_to_you', assignee: assigneeSfUserId });
			continue;
		}
		if (!rec.loadedFromId) {
			skipped.push({ slotId, reason: 'no_record_to_update' });
			continue;
		}
		const kind = slotKind(rec.slot);
		const incoming = fill.values && typeof fill.values === 'object' ? fill.values : {};

		const allowedKeys = kind === 'fields' ? new Set(Array.isArray(rec.slot.fields) ? rec.slot.fields : []) : null;
		const accepted = {};
		for (const k of Object.keys(incoming)) {
			if (allowedKeys && !allowedKeys.has(k)) {
				continue;
			}
			accepted[k] = incoming[k];
		}

		const recordId = rec.loadedFromId;
		let entry = updateByRecordId.get(recordId);
		if (!entry) {
			entry = { objectName: rec.objectName, fields: {} };
			updateByRecordId.set(recordId, entry);
		}
		Object.assign(entry.fields, accepted);

		appliedCount += 1;
		applied.push({
			slotId,
			recordId,
			objectName: rec.objectName,
			fieldCount: Object.keys(incoming).length,
		});
	}

	const recordPlan = {};
	for (const [recordId, { objectName, fields }] of updateByRecordId) {
		if (!recordPlan[objectName]) {
			recordPlan[objectName] = [];
		}
		recordPlan[objectName].push(Object.assign({ Id: recordId }, fields));
	}

	return { applied, skipped, appliedCount, recordPlan };
}

export function applySlotFieldFilter(records) {
	// Remove values outside the slot allowlist before any Salesforce DML is built.
	if (!Array.isArray(records)) {
		return;
	}
	for (const r of records) {
		if (!r || !r.values || !r.slot) {
			continue;
		}
		const kind = slotKind(r.slot);
		if (kind !== 'fields') {
			continue;
		}
		if (!r.loadedFromId) {
			continue;
		}
		const allow = new Set(Array.isArray(r.slot.fields) ? r.slot.fields : []);
		const dropped = [];
		for (const k of Object.keys(r.values)) {
			if (!allow.has(k)) {
				dropped.push(k);
				delete r.values[k];
			}
		}
		if (dropped.length) {
			console.warn(
				'[slot-filter] dropped non-allowlisted fields',
				'tempId=',
				r.tempId,
				'object=',
				r.objectName,
				'dropped=',
				dropped,
			);
		}
	}
}
