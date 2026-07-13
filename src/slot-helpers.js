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
		if (records.some((record) => record && typeof record === 'object'
			&& record.slot && record.slot.slotId != null)) {
return true;
}
	}
	return false;
}

export function stripDraftsForNonOwner(payload) {

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
			if (d.slot) {
out.slot = d.slot;
}
			return out;
		})
		: [];
	const safeLoaded = Array.isArray(payload && payload.loadedRecords)
		? payload.loadedRecords.map((l) => {
			if (!l.slot) {
return l;
}
			const kind = slotKind(l.slot);
			if (kind === 'fields') {

				return l;
			}

			return {
				objectName: l.objectName,
				x: typeof l.x === 'number' ? l.x : 0,
				y: typeof l.y === 'number' ? l.y : 0,
				slot: l.slot,
			};
		})
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
 hasValue = true; break; 
}
	}
	return { filled: (loaded || hasValue) ? 1 : 0, total: 1 };
}

export function aggregateSlotProgress(records) {
	let filled = 0, total = 0, recordCount = 0;
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
		const assigneeSfUserId = rec.slot && rec.slot.assigneeSfUserId
			? String(rec.slot.assigneeSfUserId)
			: null;
		if (assigneeSfUserId && assigneeSfUserId !== recipientSfUserId) {
			skipped.push({ slotId, reason: 'not_assigned_to_you', assignee: assigneeSfUserId });
			continue;
		}
		const kind = slotKind(rec.slot);
		const incoming = (fill.values && typeof fill.values === 'object') ? fill.values : {};
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

export function planSlotFills({ records, fills, recipientSfUserId }) {
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

	const updateByRecordId = new Map();

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
		const assigneeSfUserId = rec.slot && rec.slot.assigneeSfUserId
			? String(rec.slot.assigneeSfUserId)
			: null;
		if (assigneeSfUserId && assigneeSfUserId !== recipientSfUserId) {
			skipped.push({ slotId, reason: 'not_assigned_to_you', assignee: assigneeSfUserId });
			continue;
		}
		if (!rec.loadedFromId) {
			skipped.push({ slotId, reason: 'no_record_to_update' });
			continue;
		}
		const kind = slotKind(rec.slot);
		const incoming = (fill.values && typeof fill.values === 'object') ? fill.values : {};

		const allowedKeys = kind === 'fields'
			? new Set(Array.isArray(rec.slot.fields) ? rec.slot.fields : [])
			: null;
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
			console.warn('[slot-filter] dropped non-allowlisted fields',
				'tempId=', r.tempId, 'object=', r.objectName, 'dropped=', dropped);
		}
	}
}
