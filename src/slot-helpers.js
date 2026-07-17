// Slot-helpers: extracted from server.js so unit tests can exercise the
// strip + write-filter rules directly without spinning up Express.
//
// See docs/FIELD_LEVEL_SLOTS.md for the model. Pure functions here:
//   • stripDraftValuesForSave(payload): what gets persisted to the SF
//     file. Drafts keep their structural fields AND `values`. Saves
//     used to strip draft values (drafts as "session scratch only"),
//     which made the canvas file load-incomplete: every reload lost
//     the user's WIP drafts. The new contract is drafts-as-data:
//     drafts persist with their values, recipients see them, the
//     save→load round-trip preserves what the user was working on.
//     The function is kept as a pass-through so existing call sites
//     don't churn; they no longer mutate the payload.
//   • stripDraftsForNonOwner(payload): load-side filter for non-owners.
//     Drafts pass through with values (matching the new persistence
//     model). Whole-record slot loaded records lose `loadedFromId` so
//     the recipient builds a fresh draft; field-level slot loaded
//     records keep `loadedFromId` so the recipient's session re-
//     fetches live.
//   • applySlotFieldFilter(records): defense-in-depth on upload. For
//     records carrying `slot.kind === 'fields'` and a `loadedFromId`,
//     drops any submitted `values` whose keys aren't in `slot.fields`.

export function slotKind(slot) {
	if (!slot) {
return null;
}
	return slot.kind || 'whole-record';
}

// Persistence-side hook. Pre-change this stripped `values` from every
// draft so draft data never landed in the canvas file (drafts-as-
// session-scratch model). Post-change the function is an identity
// pass; drafts persist with values so the canvas file is a complete
// snapshot the user can come back to (and shared recipients can see).
// Kept as a callable function so existing call sites in the save +
// update paths don't need to change. Returns the payload as-is; do
// not mutate.
export function stripDraftValuesForSave(payload) {
	return payload;
}

// Client-side capability hiding is only UX. Detect authored slot markers
// again at the persistence boundary so crafted POST/PUT bodies cannot bypass
// `create-slot-canvas`.
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
	// Drafts pass through with their full structure including `values`.
	// The owner's draft data is part of the canvas's persisted state
	// now, so recipients see what the owner was working on - matching
	// the experience they'd already get during live presence.
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
				// Field-level slot: recipient sees the live record + fills
				// only the listed fields. Keep loadedFromId so their session
				// re-fetches live; everything else passes through unchanged.
				return l;
			}
			// Whole-record slot (legacy + explicit). Strip loadedFromId so
			// the recipient builds a fresh draft.
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

// Compute slot-fill progress for a single record.
//   - Field-level slot (kind='fields'):
//       total = slot.fields.length
//       filled = count of slot.fields whose values[name] is non-empty.
//   - Whole-record slot:
//       total = 1
//       filled = 1 once recipient has loaded a record (loadedFromId set)
//       OR typed any non-empty value into the draft.
// Returns null when the record has no slot - caller short-circuits.
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
	// Whole-record slot.
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

// Sum slot progress across an array of records (the canvas's bulkRecords).
// Skips type-nodes / pending records and anything without a slot. Returns
// { filled, total, recordCount } where recordCount is the number of slot
// records that contributed to the sum.
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

// Color band for a slot-progress object. Returns the CSS class name the
// card badge / banner / toolbar pill all use.
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

// Merge incoming slot-fill payloads into a canvas's records, applying
// per-slot assignment authorization (D6) and field-allowlist filtering.
// Called by POST /api/canvas/:id/slot-fill - extracted as a pure
// function so the auth + merge logic can be unit-tested without
// spinning up Express + a SF connection.
//
// Authorization rules per slot:
//   * No assigneeSfUserId  → any recipient with a valid share grant fills
//   * Has assigneeSfUserId → only the matching SF user fills; everyone
//     else gets skipped with reason='not_assigned_to_you'
//
// Other skip reasons:
//   * unknown_slot - the fill's slotId doesn't exist on the canvas
//     (canvas was edited after the share link was sent)
//
// Field-level slots additionally allowlist values: only keys named in
// rec.slot.fields land in the merged values; everything else is
// silently dropped (defense vs a recipient pushing audit fields, etc).
//
// Returns a NEW records array (input is not mutated). The applied/
// skipped arrays match the shapes the route returns to the client + the
// audit log, so the route is a thin wrapper around this helper.
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

// Plan a batch of slot-fill submissions against the canvas's records,
// producing an update plan ready for `conn.sobject(name).update(...)`.
// Companion to mergeSlotFills but emits the SHAPE the new architecture
// needs: real SF record updates grouped by SObject, not a merged JSON
// payload. Used by POST /api/canvas/:id/slot-fill under the
// custom-object backend.
//
// Same authorization rules as mergeSlotFills (D6 per-slot assignment +
// field-level allowlist). Additionally:
//   * Drafts (no loadedFromId) are skipped with reason='no_record_to_update'.
//     Under the new model, drafts can't be filled by recipients -
//     there's no SF record to UPDATE. The owner promotes drafts to
//     real records before sharing.
//   * Multiple fills targeting the same loadedFromId are merged into
//     a single update. A recipient submitting two field-slots on the
//     same Account collapses to one DML row.
//
// Returns { applied, skipped, appliedCount, recordPlan }:
//   recordPlan = { Account: [{ Id, ...allowedFields }, ...], Contact: [...] }
// suitable for `conn.sobject(name).update(recordPlan[name])` per object.
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

	// Coalesce updates by recordId (not by slot) - a recipient can hit
	// the same loadedFromId from multiple slots on the same canvas
	// (e.g., two field-level slots over different field sets on the
	// same Account). One record → one DML row, with all allowed fields
	// merged in submission order.
	const updateByRecordId = new Map();  // recordId → { objectName, fields }

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

		// Apply the field allowlist for field-level slots before the
		// values land in the plan. Whole-record slots accept any keys
		// the recipient sent - the owner deliberately marked the
		// record itself as recipient-fillable.
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
		// Merge accepted fields into the per-record bucket. Later
		// submissions for the same field overwrite earlier ones - last
		// write wins within a single batch, matching SF's semantics.
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
