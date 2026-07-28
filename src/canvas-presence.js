// Ephemeral in-process collaboration state. Presence is never a durable source of canvas truth.
import crypto from 'node:crypto';

const _presenceByCanvas = new Map();
const _revisionByCanvas = new Map();
const _liveSnapshotsByCanvas = new Map();
const _scopeByConnection = new Map();

const IDLE_THRESHOLD_MS = 90 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
export const MAX_PRESENCE_FIELDS = 100;
export const MAX_PRESENCE_PAYLOAD_BYTES = 64 * 1024;
export const MAX_LAYOUT_RECORDS = 500;
export const MAX_LIVE_SNAPSHOT_BYTES = 5 * 1024 * 1024;
export const MAX_LIVE_SNAPSHOT_RECORDS = 5000;

const _COLOR_PALETTE = [
	'#e09240', // accent orange (brand)
	'#6fa9d6', // info blue
	'#7ac96a', // success green
	'#d36fb0', // pink
	'#9d7fd3', // purple
	'#e0a048', // warm amber
	'#5fbfbf', // teal
	'#d36f6f', // coral
];

function _pickColor(canvasState) {
	const used = new Set();
	for (const entry of canvasState.values()) {
		used.add(entry.color);
	}
	for (const c of _COLOR_PALETTE) {
		if (!used.has(c)) {
			return c;
		}
	}
	const idx = canvasState.size % _COLOR_PALETTE.length;
	return _COLOR_PALETTE[idx];
}

function _writeSseEvent(res, event, data) {
	try {
		if (event) {
			res.write('event: ' + event + '\n');
		}
		res.write('data: ' + JSON.stringify(data) + '\n\n');
		return true;
	} catch (e) {
		return false;
	}
}

function _ownsConnection(entry, requestingAccountId) {
	if (!requestingAccountId) {
		return false;
	}
	return entry.accountId === requestingAccountId;
}

function _sameSalesforceIdentity(entry, sfOrgId, sfUserId) {
	const key = (value) => (value == null ? '' : String(value).slice(0, 15));
	return key(entry.sfOrgId) === key(sfOrgId) && key(entry.sfUserId) === key(sfUserId);
}

function _sameCanvasId(left, right) {
	if (left === right) {
		return true;
	}
	return (
		/^[a-zA-Z0-9]{15,18}$/.test(left) &&
		/^[a-zA-Z0-9]{15,18}$/.test(right) &&
		left.slice(0, 15) === right.slice(0, 15)
	);
}

function _presenceScopeId(canvasId, sfOrgId) {
	const normalizedCanvasId = /^[a-zA-Z0-9]{15,18}$/.test(String(canvasId || ''))
		? String(canvasId).slice(0, 15)
		: String(canvasId || '');
	const normalizedOrgId = /^[a-zA-Z0-9]{15,18}$/.test(String(sfOrgId || ''))
		? String(sfOrgId).slice(0, 15)
		: String(sfOrgId || 'legacy');
	return normalizedOrgId + '|' + normalizedCanvasId;
}

function _scopeForConnection(canvasId, connectionId) {
	const scopeId = _scopeByConnection.get(connectionId);
	if (!scopeId) {
		return null;
	}
	const conns = _presenceByCanvas.get(scopeId);
	const entry = conns && conns.get(connectionId);
	if (!entry || !_sameCanvasId(entry.canvasId, canvasId)) {
		return null;
	}
	return { scopeId, conns, entry };
}

function _roleRank(role) {
	return role === 'editor' ? 3 : role === 'contributor' ? 2 : role === 'viewer' ? 1 : 0;
}

function _acceptSequence(entry, sequence) {
	// Ignore out-of-order browser events so a delayed cursor or draft cannot overwrite newer state.
	if (!Number.isSafeInteger(sequence) || sequence <= entry.lastSequence) {
		return false;
	}
	entry.lastSequence = sequence;
	return true;
}

function _toPeerPayload(entry) {
	return {
		connectionId: entry.connectionId,
		accountId: entry.accountId,
		displayName: entry.displayName,
		color: entry.color,
		cursor: entry.cursor,
		focus: entry.focus,
	};
}

function _cloneSnapshot(payload) {
	return JSON.parse(JSON.stringify(payload));
}

function _validLiveSnapshot(payload) {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
		return false;
	}
	if (!payload.schema || !Array.isArray(payload.schema.objects) || !Array.isArray(payload.associations)) {
		return false;
	}
	const loaded = Array.isArray(payload.loadedRecords) ? payload.loadedRecords : [];
	const drafts = Array.isArray(payload.drafts) ? payload.drafts : [];
	if (loaded.length + drafts.length > MAX_LIVE_SNAPSHOT_RECORDS) {
		return false;
	}
	try {
		return Buffer.byteLength(JSON.stringify(payload), 'utf8') <= MAX_LIVE_SNAPSHOT_BYTES;
	} catch (_error) {
		return false;
	}
}

function _payloadRecordForRef(payload, reference) {
	if (!payload || !reference || reference.ref == null) {
		return null;
	}
	const ref = String(reference.ref);
	const collabRef = reference.collabRef == null ? null : String(reference.collabRef);
	const records = [
		...(Array.isArray(payload.loadedRecords) ? payload.loadedRecords : []),
		...(Array.isArray(payload.drafts) ? payload.drafts : []),
	];
	const primaryMatches = (record) => {
		if (reference.refKind === 'loaded') {
			return record.loadedFromId && _sfIdKey(record.loadedFromId) === _sfIdKey(ref);
		}
		if (reference.refKind === 'draft') {
			return record.tempId != null && String(record.tempId) === ref;
		}
		if (reference.refKind === 'slot') {
			return record.slot && record.slot.slotId != null && String(record.slot.slotId) === ref;
		}
		return false;
	};
	if (collabRef != null) {
		return (
			records.find(
				(record) =>
					record &&
					primaryMatches(record) &&
					record.canvasRecordId != null &&
					String(record.canvasRecordId) === collabRef,
			) || null
		);
	}
	return records.find((record) => record && primaryMatches(record)) || null;
}

function _associationEndpoint(reference) {
	return reference && reference.refKind && reference.ref != null
		? { kind: reference.refKind, ref: reference.ref }
		: null;
}

function _sameEndpoint(left, right) {
	return !!(
		left &&
		right &&
		left.kind === right.kind &&
		left.ref != null &&
		right.ref != null &&
		String(left.ref) === String(right.ref)
	);
}

function _ensureSnapshotSchemaObject(payload, objectName) {
	if (!objectName) {
		return;
	}
	payload.schema = payload.schema && typeof payload.schema === 'object' ? payload.schema : { objects: [] };
	payload.schema.objects = Array.isArray(payload.schema.objects) ? payload.schema.objects : [];
	if (!payload.schema.objects.some((object) => object && object.name === objectName)) {
		payload.schema.objects.push({ name: objectName, label: objectName });
	}
}

function _removeSnapshotRecord(payload, record) {
	if (!record) {
		return;
	}
	const endpoints = [];
	if (record.loadedFromId) {
		endpoints.push({ kind: 'loaded', ref: record.loadedFromId });
	}
	if (record.tempId != null) {
		endpoints.push({ kind: 'draft', ref: record.tempId });
	}
	if (record.slot && record.slot.slotId != null) {
		endpoints.push({ kind: 'slot', ref: record.slot.slotId });
	}
	payload.loadedRecords = (payload.loadedRecords || []).filter((candidate) => candidate !== record);
	payload.drafts = (payload.drafts || []).filter((candidate) => candidate !== record);
	payload.associations = (payload.associations || []).filter(
		(association) =>
			!endpoints.some(
				(endpoint) =>
					_sameEndpoint(association && association.from, endpoint) ||
					_sameEndpoint(association && association.to, endpoint),
			),
	);
}

function _applySnapshotMutation(canvasId, event, revisionValue) {
	const live = _liveSnapshotsByCanvas.get(canvasId);
	if (!live || !live.payload || !event) {
		return;
	}
	const payload = live.payload;
	if (event.type === 'draft-update') {
		let record = _payloadRecordForRef(payload, { refKind: 'draft', ref: event.tempId });
		if (event.kind === 'remove') {
			_removeSnapshotRecord(payload, record);
		} else {
			if (!record && event.kind === 'create') {
				record = {
					tempId: event.tempId,
					canvasRecordId: event.canvasRecordId || event.tempId,
					objectName: event.objectName,
					x: Number.isFinite(event.x) ? event.x : 200,
					y: Number.isFinite(event.y) ? event.y : 200,
					values: {},
				};
				payload.drafts = Array.isArray(payload.drafts) ? payload.drafts : [];
				payload.drafts.push(record);
				_ensureSnapshotSchemaObject(payload, event.objectName);
			}
			if (record) {
				record.values = record.values && typeof record.values === 'object' ? record.values : {};
				for (const [name, value] of Object.entries(event.fields || {})) {
					if (value === null) {
						delete record.values[name];
					} else {
						record.values[name] = value;
					}
				}
				if (event.position) {
					record.x = event.position.x;
					record.y = event.position.y;
				}
			}
		}
	} else if (event.type === 'loaded-record') {
		let record = _payloadRecordForRef(payload, {
			refKind: 'loaded',
			ref: event.sfId,
			collabRef: event.collabRef,
		});
		if (!record && event.kind === 'create') {
			record = {
				loadedFromId: event.sfId,
				canvasRecordId: event.collabRef || event.sfId,
				objectName: event.objectName,
				x: Number.isFinite(event.x) ? event.x : 200,
				y: Number.isFinite(event.y) ? event.y : 200,
			};
			payload.loadedRecords = Array.isArray(payload.loadedRecords) ? payload.loadedRecords : [];
			payload.loadedRecords.push(record);
			_ensureSnapshotSchemaObject(payload, event.objectName);
		}
		if (record) {
			record.changes = record.changes && typeof record.changes === 'object' ? record.changes : {};
			for (const [name, value] of Object.entries(event.fields || {})) {
				record.changes[name] = value;
			}
			if (Object.keys(record.changes).length === 0) {
				delete record.changes;
			}
			if (typeof event.pendingDelete === 'boolean') {
				if (event.pendingDelete) {
					record.pendingDelete = true;
				} else {
					delete record.pendingDelete;
				}
			}
		}
	} else if (event.type === 'loaded-removed') {
		_removeSnapshotRecord(
			payload,
			_payloadRecordForRef(payload, {
				refKind: 'loaded',
				ref: event.sfId,
				collabRef: event.collabRef,
			}),
		);
	} else if (event.type === 'slot-update') {
		const record = _payloadRecordForRef(payload, event.targetRef);
		if (record) {
			if (event.slot === null) {
				delete record.slot;
			} else {
				record.slot = _cloneSnapshot(event.slot);
			}
		}
	} else if (event.type === 'draft-link') {
		const from = _associationEndpoint(event.fromRef);
		const to = _associationEndpoint(event.toRef);
		if (from && to) {
			payload.associations = Array.isArray(payload.associations) ? payload.associations : [];
			const matches = (association) =>
				association &&
				association.fieldName === event.fieldName &&
				_sameEndpoint(association.from, from) &&
				_sameEndpoint(association.to, to);
			if (event.kind === 'remove') {
				payload.associations = payload.associations.filter((association) => !matches(association));
			} else if (!payload.associations.some(matches)) {
				payload.associations.push({ from, to, fieldName: event.fieldName });
			}
		}
	} else if (event.type === 'record-layout') {
		for (const position of event.positions || []) {
			const record = _payloadRecordForRef(payload, position);
			if (record) {
				record.x = position.x;
				record.y = position.y;
			}
		}
	}
	live.revision = revisionValue;
	live.updatedAt = Date.now();
}

function _sfIdKey(value) {
	return String(value || '')
		.slice(0, 15)
		.toLowerCase();
}

function _visibilityForRef(entry, reference) {
	if (!entry.visibility || entry.role === 'owner') {
		return { visible: true, readableFields: null };
	}
	if (!reference || typeof reference !== 'object') {
		return { visible: false, readableFields: null };
	}
	if (reference.refKind === 'draft') {
		const draft = entry.visibility.drafts && entry.visibility.drafts[String(reference.ref)];
		return draft && draft.visible
			? { visible: true, readableFields: new Set(draft.readableFields || []) }
			: { visible: false, readableFields: null };
	}
	if (reference.refKind === 'loaded') {
		const record = entry.visibility.loadedRecords[_sfIdKey(reference.ref)];
		return record
			? { visible: true, readableFields: new Set(record.readableFields || []) }
			: { visible: false, readableFields: null };
	}
	if (reference.refKind === 'slot') {
		const slot = entry.visibility.slots[String(reference.ref)];
		if (!slot || !slot.visible) {
			return { visible: false, readableFields: null };
		}
		if (slot.loadedRecordId) {
			const record = entry.visibility.loadedRecords[_sfIdKey(slot.loadedRecordId)];
			return record
				? { visible: true, readableFields: new Set(record.readableFields || []) }
				: { visible: false, readableFields: null };
		}
		if (slot.draftId) {
			const draft = entry.visibility.drafts && entry.visibility.drafts[String(slot.draftId)];
			return draft && draft.visible
				? { visible: true, readableFields: new Set(draft.readableFields || []) }
				: { visible: false, readableFields: null };
		}
		return { visible: false, readableFields: null };
	}
	return { visible: false, readableFields: null };
}

function _pickReadableFields(values, allowed) {
	if (!values || typeof values !== 'object' || !allowed) {
		return {};
	}
	const projected = {};
	for (const [name, value] of Object.entries(values)) {
		if (allowed.has(name)) {
			projected[name] = value;
		}
	}
	return projected;
}

function _syncSlotVisibility(entry, targetRef, slot) {
	if (!entry.visibility || !targetRef || !['loaded', 'draft'].includes(targetRef.refKind)) {
		return;
	}
	const slots = entry.visibility.slots || (entry.visibility.slots = {});
	const targetRefValue = String(targetRef.ref || '');
	const targetsRecord = (candidate) => {
		if (!candidate) {
			return false;
		}
		if (targetRef.refKind === 'loaded') {
			return candidate.loadedRecordId && _sfIdKey(candidate.loadedRecordId) === _sfIdKey(targetRefValue);
		}
		return candidate.draftId != null && String(candidate.draftId) === targetRefValue;
	};
	for (const [slotId, candidate] of Object.entries(slots)) {
		if (targetsRecord(candidate)) {
			delete slots[slotId];
		}
	}
	if (!slot || slot.slotId == null) {
		return;
	}
	slots[String(slot.slotId)] =
		targetRef.refKind === 'loaded'
			? { visible: true, loadedRecordId: targetRefValue }
			: { visible: true, loadedRecordId: null, draftId: targetRefValue };
}

function _projectPresencePayload(entry, payload) {
	if (!entry.visibility || entry.role === 'owner' || !payload || typeof payload !== 'object') {
		return payload;
	}
	if (payload.type === 'loaded-record') {
		const visibility = _visibilityForRef(entry, { refKind: 'loaded', ref: payload.sfId });
		if (!visibility.visible) {
			return null;
		}
		return {
			...payload,
			fields: _pickReadableFields(payload.fields, visibility.readableFields),
			...(payload.baseline ? { baseline: _pickReadableFields(payload.baseline, visibility.readableFields) } : {}),
		};
	}
	if (payload.type === 'loaded-removed') {
		return _visibilityForRef(entry, { refKind: 'loaded', ref: payload.sfId }).visible ? payload : null;
	}
	if (payload.type === 'draft-update') {
		if (payload.kind === 'create') {
			const objectVisibility =
				entry.visibility.objects && entry.visibility.objects[String(payload.objectName || '')];
			entry.visibility.drafts = entry.visibility.drafts || {};
			entry.visibility.drafts[String(payload.tempId)] =
				objectVisibility && objectVisibility.visible
					? {
							visible: true,
							objectName: payload.objectName,
							readableFields: Array.from(objectVisibility.readableFields || []),
						}
					: { visible: false };
		}
		const visibility = _visibilityForRef(entry, { refKind: 'draft', ref: payload.tempId });
		if (!visibility.visible) {
			return null;
		}
		const projected = {
			...payload,
			fields: _pickReadableFields(payload.fields, visibility.readableFields),
		};
		if (payload.kind === 'remove' && entry.visibility.drafts) {
			delete entry.visibility.drafts[String(payload.tempId)];
		}
		return projected;
	}
	if (payload.type === 'draft-link') {
		const fromVisibility = _visibilityForRef(entry, payload.fromRef);
		const toVisibility = _visibilityForRef(entry, payload.toRef);
		if (!fromVisibility.visible || !toVisibility.visible) {
			return null;
		}
		if (fromVisibility.readableFields && !fromVisibility.readableFields.has(payload.fieldName)) {
			return null;
		}
		return payload;
	}
	if (payload.type === 'slot-update') {
		const visibility = _visibilityForRef(entry, payload.targetRef);
		if (!visibility.visible) {
			return null;
		}
		_syncSlotVisibility(entry, payload.targetRef, payload.slot);
		if (payload.slot && payload.slot.kind === 'fields' && visibility.readableFields) {
			const fields = (payload.slot.fields || []).filter((field) => visibility.readableFields.has(field));
			return { ...payload, slot: { ...payload.slot, fields } };
		}
		return payload;
	}
	if (payload.type === 'record-layout') {
		const positions = (payload.positions || []).filter((position) => _visibilityForRef(entry, position).visible);
		return positions.length > 0 ? { ...payload, positions } : null;
	}
	if (payload.type === 'focus' && payload.focus && payload.focus.refKind) {
		return _visibilityForRef(entry, payload.focus).visible ? payload : null;
	}
	return payload;
}

async function _deliverLiveSnapshot(canvasId, entry, live) {
	if (!entry || !live || !live.payload || entry.accessRevoked) {
		return false;
	}
	if (entry.role !== 'owner' && typeof entry.projectSnapshot !== 'function') {
		entry.awaitingSnapshot = false;
		entry.snapshotSyncing = false;
		return false;
	}
	const snapshotRevision = live.revision;
	entry.snapshotSyncing = true;
	entry.snapshotRevision = snapshotRevision;
	try {
		let projected = { payload: _cloneSnapshot(live.payload), visibility: entry.visibility };
		if (entry.role !== 'owner') {
			projected = await entry.projectSnapshot(_cloneSnapshot(live.payload));
		}
		if (!projected || !projected.payload || entry.accessRevoked) {
			throw new Error('live snapshot projection unavailable');
		}
		if (projected.visibility) {
			entry.visibility = projected.visibility;
		}
		const delivered = _writeSseEvent(entry.sseRes, 'presence', {
			type: 'live-snapshot',
			payload: projected.payload,
			revision: snapshotRevision,
			durableRevision: _revisionState(canvasId).durableRevision,
		});
		entry.awaitingSnapshot = false;
		entry.snapshotSyncing = false;
		const queued = entry.pendingSnapshotEvents.splice(0);
		for (const event of queued) {
			if (Number.isSafeInteger(event.revision) && event.revision <= snapshotRevision) {
				continue;
			}
			const safe = _projectPresencePayload(entry, event);
			if (safe) {
				_writeSseEvent(entry.sseRes, 'presence', safe);
			}
		}
		return delivered;
	} catch (_error) {
		entry.snapshotSyncing = false;
		entry.awaitingSnapshot = false;
		entry.pendingSnapshotEvents.length = 0;
		_writeSseEvent(entry.sseRes, 'presence', {
			type: 'live-snapshot-unavailable',
			revision: snapshotRevision,
		});
		return false;
	}
}

function _broadcast(canvasId, payload, excludeConnId) {
	const conns = _presenceByCanvas.get(canvasId);
	if (!conns) {
		return 0;
	}
	let delivered = 0;
	for (const [connId, entry] of conns.entries()) {
		if (connId === excludeConnId) {
			continue;
		}
		if (entry.snapshotSyncing && Number.isSafeInteger(payload && payload.revision)) {
			entry.pendingSnapshotEvents.push(payload);
			continue;
		}
		const projected = _projectPresencePayload(entry, payload);
		if (projected && _writeSseEvent(entry.sseRes, 'presence', projected)) {
			delivered++;
		}
	}
	return delivered;
}

function _revisionState(canvasId) {
	if (!_revisionByCanvas.has(canvasId)) {
		_revisionByCanvas.set(canvasId, { revision: 0, durableRevision: 0 });
	}
	return _revisionByCanvas.get(canvasId);
}

function _broadcastMutation(canvasId, entry, payload, excludeConnId) {
	const state = _revisionState(canvasId);
	state.revision += 1;
	entry.lastCanvasRevision = state.revision;
	const revisioned = Object.assign({}, payload, { revision: state.revision });
	_applySnapshotMutation(canvasId, revisioned, state.revision);
	const live = _liveSnapshotsByCanvas.get(canvasId);
	const refreshVisibility =
		live &&
		((revisioned.type === 'draft-update' && revisioned.kind === 'create') ||
			(revisioned.type === 'loaded-record' && revisioned.kind === 'create'));
	if (refreshVisibility) {
		const conns = _presenceByCanvas.get(canvasId);
		for (const candidate of conns ? conns.values() : []) {
			if (candidate.connectionId !== excludeConnId && candidate.role !== 'owner') {
				_deliverLiveSnapshot(canvasId, candidate, live).catch(() => {});
			}
		}
	}
	_broadcast(canvasId, revisioned, excludeConnId);
	return state.revision;
}

function _canonicalSnapshot(value, isRoot = false, depth = 0) {
	if (depth > 64) {
		throw new Error('canvas snapshot exceeds the supported nesting depth');
	}
	if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
		return undefined;
	}
	if (value === null || typeof value === 'string' || typeof value === 'boolean') {
		return value;
	}
	if (typeof value === 'number') {
		return Number.isFinite(value) ? value : null;
	}
	if (Array.isArray(value)) {
		return value.map((item) => {
			const normalized = _canonicalSnapshot(item, false, depth + 1);
			return normalized === undefined ? null : normalized;
		});
	}
	if (typeof value === 'object') {
		const out = {};
		for (const key of Object.keys(value).sort()) {
			if (isRoot && key === '_meta') {
				continue;
			}
			const normalized = _canonicalSnapshot(value[key], false, depth + 1);
			if (normalized !== undefined) {
				out[key] = normalized;
			}
		}
		return out;
	}
	return undefined;
}

export function canvasSnapshotHash(payload) {
	const canonical = JSON.stringify(_canonicalSnapshot(payload || {}, true));
	return crypto.createHash('sha256').update(canonical).digest('hex');
}

export function revision({ canvasId, sfOrgId, connectionId }) {
	const scopeId = connectionId
		? _scopeByConnection.get(connectionId)
		: _presenceScopeId(canvasId, sfOrgId);
	const state = _revisionByCanvas.get(scopeId);
	return state ? state.revision : 0;
}

export function seedLiveSnapshot({ canvasId, sfOrgId, payload }) {
	const scopeId = _presenceScopeId(canvasId, sfOrgId);
	if (!canvasId || _liveSnapshotsByCanvas.has(scopeId) || !_validLiveSnapshot(payload)) {
		return false;
	}
	const state = _revisionState(scopeId);
	_liveSnapshotsByCanvas.set(scopeId, {
		payload: _cloneSnapshot(payload),
		revision: state.revision,
		updatedAt: Date.now(),
	});
	return true;
}

export function subscribe({
	canvasId,
	workspaceId,
	accountId,
	displayName,
	canEdit = true,
	role = canEdit ? 'editor' : 'viewer',
	sfOrgId = null,
	sfUserId = null,
	visibility = null,
	projectSnapshot = null,
	sseRes,
}) {
	// Workspace identity is captured at subscription time and checked by every later mutation.
	if (!canvasId || !workspaceId || !accountId || !sseRes) {
		throw new Error('subscribe: missing required field');
	}
	const scopeId = _presenceScopeId(canvasId, sfOrgId);
	if (!_presenceByCanvas.has(scopeId)) {
		_presenceByCanvas.set(scopeId, new Map());
	}
	const conns = _presenceByCanvas.get(scopeId);
	const revisionState = _revisionState(scopeId);
	const connectionId = crypto.randomUUID();
	const color = _pickColor(conns);
	const entry = {
		connectionId,
		canvasId,
		workspaceId,
		accountId,
		displayName: displayName || 'Someone',
		canEdit: !!canEdit,
		role,
		sfOrgId,
		sfUserId,
		visibility,
		projectSnapshot,
		accessRevoked: false,
		awaitingSnapshot:
			!!_liveSnapshotsByCanvas.get(scopeId) &&
			_liveSnapshotsByCanvas.get(scopeId).revision > revisionState.durableRevision,
		snapshotSyncing: false,
		snapshotRevision: null,
		pendingSnapshotEvents: [],
		color,
		cursor: null,
		focus: null,
		lastSeenAt: Date.now(),
		lastSequence: 0,
		lastCanvasRevision: revisionState.durableRevision,
		sseRes,
	};
	const peers = [];
	for (const other of conns.values()) {
		peers.push(_toPeerPayload(other));
	}
	conns.set(connectionId, entry);
	_scopeByConnection.set(connectionId, scopeId);
	_writeSseEvent(sseRes, 'presence-init', {
		you: Object.assign(_toPeerPayload(entry), { role: entry.role, canEdit: entry.canEdit }),
		peers,
		revision: revisionState.revision,
		durableRevision: revisionState.durableRevision,
		hasLiveSnapshot: _liveSnapshotsByCanvas.has(scopeId),
	});
	const keepalive = setInterval(() => {
		try {
			if (sseRes.destroyed || sseRes.writableEnded) {
				clearInterval(keepalive);
				unsubscribe({ canvasId, connectionId });
				return;
			}
			sseRes.write(': keepalive\n\n');
			// The open SSE stream, rather than cursor traffic, proves this browser is still present.
			entry.lastSeenAt = Date.now();
		} catch (e) {
			clearInterval(keepalive);
			unsubscribe({ canvasId, connectionId });
		}
	}, 25 * 1000);
	entry.keepalive = keepalive;
	sseRes.on('close', () => {
		clearInterval(keepalive);
		unsubscribe({ canvasId, connectionId });
	});
	sseRes.on('error', () => {
		clearInterval(keepalive);
		unsubscribe({ canvasId, connectionId });
	});
	_broadcast(scopeId, { type: 'join', peer: _toPeerPayload(entry) }, connectionId);
	const live = _liveSnapshotsByCanvas.get(scopeId);
	if (live && entry.awaitingSnapshot) {
		queueMicrotask(() => {
			_deliverLiveSnapshot(scopeId, entry, live).catch(() => {});
		});
	}
	return connectionId;
}

export function updateCanvasAccess({ canvasId, sfOrgId, sfUserId, role = null, revoked = false }) {
	if (!canvasId || !sfOrgId || !sfUserId) {
		return 0;
	}
	let delivered = 0;
	for (const conns of _presenceByCanvas.values()) {
		for (const entry of conns.values()) {
			if (!_sameCanvasId(entry.canvasId, canvasId)) {
				continue;
			}
			if (!_sameSalesforceIdentity(entry, sfOrgId, sfUserId)) {
				continue;
			}
			const previousRole = entry.role || (entry.canEdit ? 'editor' : 'viewer');
			const nextRole = revoked ? null : role;
			if (!revoked && previousRole === nextRole) {
				continue;
			}
			entry.role = nextRole;
			entry.canEdit = nextRole === 'editor';
			entry.accessRevoked = !!revoked;
			entry.lastSeenAt = Date.now();
			const change = revoked
				? 'revoked'
				: _roleRank(nextRole) > _roleRank(previousRole)
					? 'increased'
					: 'decreased';
			if (
				_writeSseEvent(entry.sseRes, 'presence', {
					type: 'access-changed',
					previousRole,
					role: nextRole,
					change,
					revoked: !!revoked,
					at: Date.now(),
				})
			) {
				delivered += 1;
			}
		}
	}
	return delivered;
}

export function unsubscribe({ canvasId, connectionId }) {
	const scoped = _scopeForConnection(canvasId, connectionId);
	if (!scoped) {
		return false;
	}
	const { scopeId, conns, entry } = scoped;
	if (entry.keepalive) {
		clearInterval(entry.keepalive);
	}
	conns.delete(connectionId);
	_scopeByConnection.delete(connectionId);
	if (conns.size === 0) {
		_presenceByCanvas.delete(scopeId);
		_revisionByCanvas.delete(scopeId);
		_liveSnapshotsByCanvas.delete(scopeId);
	}
	_broadcast(scopeId, { type: 'leave', connectionId }, connectionId);
	return true;
}

export function updateCursor({ canvasId, connectionId, x, y, world, sequence, requestingAccountId }) {
	const scoped = _scopeForConnection(canvasId, connectionId);
	if (!scoped) {
		return false;
	}
	const { scopeId, entry } = scoped;
	if (!_ownsConnection(entry, requestingAccountId)) {
		return false;
	}
	if (entry.accessRevoked) {
		return false;
	}
	if (!_acceptSequence(entry, sequence)) {
		return false;
	}
	const cx = typeof x === 'number' ? x : null;
	const cy = typeof y === 'number' ? y : null;
	entry.cursor = cx == null || cy == null ? null : { x: cx, y: cy, world: !!world };
	entry.lastSeenAt = Date.now();
	_broadcast(
		scopeId,
		{
			type: 'cursor',
			connectionId,
			cursor: entry.cursor,
		},
		connectionId,
	);
	return true;
}

export function updateDraft({
	canvasId,
	connectionId,
	tempId,
	fields,
	kind,
	objectName,
	canvasRecordId,
	x,
	y,
	position,
	sequence,
	requestingAccountId,
}) {
	const scoped = _scopeForConnection(canvasId, connectionId);
	if (!scoped) {
		return false;
	}
	const { scopeId, entry } = scoped;
	if (!_ownsConnection(entry, requestingAccountId)) {
		return false;
	}
	if (!entry.canEdit) {
		return false;
	}
	if (!_acceptSequence(entry, sequence)) {
		return false;
	}
	if (tempId == null) {
		return false;
	}
	if (!fields || typeof fields !== 'object') {
		return false;
	}
	const keys = Object.keys(fields);
	if (keys.length > MAX_PRESENCE_FIELDS || keys.some((key) => !/^[A-Za-z][A-Za-z0-9_]*$/.test(key))) {
		return false;
	}
	if (Buffer.byteLength(JSON.stringify(fields), 'utf8') > MAX_PRESENCE_PAYLOAD_BYTES) {
		return false;
	}
	entry.lastSeenAt = Date.now();
	const payload = {
		type: 'draft-update',
		connectionId,
		tempId,
		fields,
	};
	if (kind === 'create') {
		payload.kind = 'create';
		if (typeof objectName === 'string') {
			payload.objectName = objectName;
		}
		if (canvasRecordId != null) {
			const cleanCanvasRecordId = String(canvasRecordId);
			if (!cleanCanvasRecordId || cleanCanvasRecordId.length > 128) {
				return false;
			}
			payload.canvasRecordId = cleanCanvasRecordId;
		}
		if (typeof x === 'number') {
			payload.x = x;
		}
		if (typeof y === 'number') {
			payload.y = y;
		}
	} else if (kind === 'remove') {
		payload.kind = 'remove';
	}
	if (position && typeof position === 'object' && typeof position.x === 'number' && typeof position.y === 'number') {
		payload.position = { x: position.x, y: position.y };
	}
	_broadcastMutation(scopeId, entry, payload, connectionId);
	return true;
}

export function updateLoadedRecord({
	canvasId,
	connectionId,
	kind,
	sfId,
	collabRef,
	objectName,
	fields,
	baseline,
	x,
	y,
	pendingDelete,
	sequence,
	requestingAccountId,
}) {
	const scoped = _scopeForConnection(canvasId, connectionId);
	const entry = scoped && scoped.entry;
	if (!entry || !_ownsConnection(entry, requestingAccountId) || !entry.canEdit) {
		return false;
	}
	if (!_acceptSequence(entry, sequence)) {
		return false;
	}
	if (!['create', 'update'].includes(kind) || !/^[A-Za-z0-9]{15,18}$/.test(String(sfId || ''))) {
		return false;
	}
	if (!fields || typeof fields !== 'object') {
		return false;
	}
	const validFields = (candidate) => {
		const keys = Object.keys(candidate || {});
		return (
			keys.length <= MAX_PRESENCE_FIELDS &&
			keys.every((key) => /^[A-Za-z][A-Za-z0-9_]*$/.test(key)) &&
			keys.every((key) => {
				const value = candidate[key];
				return (
					value === null ||
					typeof value === 'string' ||
					typeof value === 'number' ||
					typeof value === 'boolean'
				);
			}) &&
			Buffer.byteLength(JSON.stringify(candidate || {}), 'utf8') <= MAX_PRESENCE_PAYLOAD_BYTES
		);
	};
	if (!validFields(fields) || (baseline && !validFields(baseline))) {
		return false;
	}
	if (kind === 'create' && (!objectName || objectName.length > 255 || !/^[A-Za-z][A-Za-z0-9_]*$/.test(objectName))) {
		return false;
	}
	if (
		(kind === 'create' && Number.isFinite(x) && Math.abs(x) > 10_000_000) ||
		(kind === 'create' && Number.isFinite(y) && Math.abs(y) > 10_000_000)
	) {
		return false;
	}
	entry.lastSeenAt = Date.now();
	const payload = {
		type: 'loaded-record',
		connectionId,
		kind,
		sfId: String(sfId),
		fields,
	};
	if (collabRef != null) {
		const cleanCollabRef = String(collabRef);
		if (!cleanCollabRef || cleanCollabRef.length > 128) {
			return false;
		}
		payload.collabRef = cleanCollabRef;
	}
	if (kind === 'create') {
		payload.objectName = objectName;
		payload.baseline = baseline || {};
		if (Number.isFinite(x)) {
			payload.x = x;
		}
		if (Number.isFinite(y)) {
			payload.y = y;
		}
	}
	if (typeof pendingDelete === 'boolean') {
		payload.pendingDelete = pendingDelete;
	}
	_broadcastMutation(scoped.scopeId, entry, payload, connectionId);
	return true;
}

function _cleanSlot(slot) {
	if (slot === null) {
		return null;
	}
	if (!slot || typeof slot !== 'object') {
		return undefined;
	}
	const slotId = slot.slotId == null ? '' : String(slot.slotId);
	const kind = slot.kind === 'fields' ? 'fields' : 'whole-record';
	if (!slotId || slotId.length > 128) {
		return undefined;
	}
	const bounded = (value, max) => {
		if (value == null || value === '') {
			return null;
		}
		const text = String(value);
		return text.length <= max ? text : undefined;
	};
	const label = bounded(slot.label, 255);
	const description = bounded(slot.description, 2000);
	const assigneeSfUserId = bounded(slot.assigneeSfUserId, 18);
	const assigneeName = bounded(slot.assigneeName, 255);
	const assigneeEmail = bounded(slot.assigneeEmail, 320);
	if ([label, description, assigneeSfUserId, assigneeName, assigneeEmail].includes(undefined)) {
		return undefined;
	}
	if (assigneeSfUserId && !/^[A-Za-z0-9]{15,18}$/.test(assigneeSfUserId)) {
		return undefined;
	}
	const clean = {
		slotId,
		kind,
		label,
		description,
		assigneeSfUserId,
		assigneeName,
		assigneeEmail,
	};
	if (kind === 'fields') {
		if (
			!Array.isArray(slot.fields) ||
			slot.fields.length > MAX_PRESENCE_FIELDS ||
			slot.fields.some((field) => !/^[A-Za-z][A-Za-z0-9_]*$/.test(String(field)))
		) {
			return undefined;
		}
		clean.fields = Array.from(new Set(slot.fields.map(String)));
	}
	return clean;
}

export function updateSlot({ canvasId, connectionId, targetRef, slot, sequence, requestingAccountId }) {
	const scoped = _scopeForConnection(canvasId, connectionId);
	const entry = scoped && scoped.entry;
	if (!entry || !_ownsConnection(entry, requestingAccountId) || !entry.canEdit) {
		return false;
	}
	if (!_acceptSequence(entry, sequence)) {
		return false;
	}
	const refKind = targetRef && targetRef.refKind;
	const ref = targetRef && targetRef.ref != null ? String(targetRef.ref) : '';
	if (!['loaded', 'draft'].includes(refKind) || !ref || ref.length > 128) {
		return false;
	}
	if (refKind === 'loaded' && !/^[A-Za-z0-9]{15,18}$/.test(ref)) {
		return false;
	}
	let collabRef = null;
	if (targetRef && targetRef.collabRef != null) {
		collabRef = String(targetRef.collabRef);
		if (!collabRef || collabRef.length > 128) {
			return false;
		}
	}
	const cleanSlot = _cleanSlot(slot);
	if (cleanSlot === undefined) {
		return false;
	}
	entry.lastSeenAt = Date.now();
	_broadcastMutation(
		scoped.scopeId,
		entry,
		{
			type: 'slot-update',
			connectionId,
			targetRef: { refKind, ref, ...(collabRef ? { collabRef } : {}) },
			slot: cleanSlot,
		},
		connectionId,
	);
	return true;
}

export function updateDraftLink({
	canvasId,
	connectionId,
	kind,
	fromRef,
	toRef,
	fromSyncId,
	toSyncId,
	fieldName,
	sequence,
	requestingAccountId,
}) {
	const scoped = _scopeForConnection(canvasId, connectionId);
	if (!scoped) {
		return false;
	}
	const { scopeId, entry } = scoped;
	if (!_ownsConnection(entry, requestingAccountId)) {
		return false;
	}
	if (!entry.canEdit) {
		return false;
	}
	if (!_acceptSequence(entry, sequence)) {
		return false;
	}
	if (kind !== 'add' && kind !== 'remove') {
		return false;
	}
	const cleanReference = (reference, legacyId) => {
		const candidate =
			reference && typeof reference === 'object'
				? reference
				: legacyId
					? { refKind: 'draft', ref: String(legacyId), collabRef: String(legacyId) }
					: null;
		if (!candidate || !['loaded', 'draft', 'slot'].includes(candidate.refKind)) {
			return null;
		}
		const ref = candidate.ref == null ? '' : String(candidate.ref);
		if (!ref || ref.length > 128) {
			return null;
		}
		const clean = { refKind: candidate.refKind, ref };
		if (candidate.collabRef != null) {
			const collabRef = String(candidate.collabRef);
			if (!collabRef || collabRef.length > 128) {
				return null;
			}
			clean.collabRef = collabRef;
		}
		return clean;
	};
	const cleanFromRef = cleanReference(fromRef, fromSyncId);
	const cleanToRef = cleanReference(toRef, toSyncId);
	if (
		!cleanFromRef ||
		!cleanToRef ||
		!fieldName ||
		String(fieldName).length > 255 ||
		!/^[A-Za-z][A-Za-z0-9_]*$/.test(String(fieldName))
	) {
		return false;
	}
	entry.lastSeenAt = Date.now();
	_broadcastMutation(
		scopeId,
		entry,
		{
			type: 'draft-link',
			connectionId,
			kind,
			fromRef: cleanFromRef,
			toRef: cleanToRef,
			fieldName: String(fieldName),
		},
		connectionId,
	);
	return true;
}

export function removeLoadedRecord({ canvasId, connectionId, sfId, collabRef, sequence, requestingAccountId }) {
	const scoped = _scopeForConnection(canvasId, connectionId);
	if (!scoped) {
		return false;
	}
	const { scopeId, entry } = scoped;
	if (!_ownsConnection(entry, requestingAccountId)) {
		return false;
	}
	if (!entry.canEdit) {
		return false;
	}
	if (!_acceptSequence(entry, sequence)) {
		return false;
	}
	if (!sfId) {
		return false;
	}
	const cleanCollabRef = collabRef == null ? null : String(collabRef);
	if (cleanCollabRef != null && (!cleanCollabRef || cleanCollabRef.length > 128)) {
		return false;
	}
	entry.lastSeenAt = Date.now();
	_broadcastMutation(
		scopeId,
		entry,
		{
			type: 'loaded-removed',
			connectionId,
			sfId: String(sfId),
			...(cleanCollabRef ? { collabRef: cleanCollabRef } : {}),
		},
		connectionId,
	);
	return true;
}

export function updateFocus({ canvasId, connectionId, focus, sequence, requestingAccountId }) {
	const scoped = _scopeForConnection(canvasId, connectionId);
	if (!scoped) {
		return false;
	}
	const { scopeId, entry } = scoped;
	if (!_ownsConnection(entry, requestingAccountId)) {
		return false;
	}
	if (entry.accessRevoked) {
		return false;
	}
	if (!_acceptSequence(entry, sequence)) {
		return false;
	}
	entry.focus = focus || null;
	entry.lastSeenAt = Date.now();
	_broadcast(
		scopeId,
		{
			type: 'focus',
			connectionId,
			focus: entry.focus,
		},
		connectionId,
	);
	return true;
}

export function updateLayout({ canvasId, connectionId, positions, sequence, requestingAccountId }) {
	const scoped = _scopeForConnection(canvasId, connectionId);
	const entry = scoped && scoped.entry;
	if (!entry || !_ownsConnection(entry, requestingAccountId) || !entry.canEdit) {
		return false;
	}
	if (!_acceptSequence(entry, sequence)) {
		return false;
	}
	if (!Array.isArray(positions) || positions.length === 0 || positions.length > MAX_LAYOUT_RECORDS) {
		return false;
	}
	const clean = [];
	for (const position of positions) {
		const refKind = position && position.refKind;
		const ref = position && position.ref != null ? String(position.ref) : '';
		const x = position && position.x;
		const y = position && position.y;
		if (!['loaded', 'draft', 'slot'].includes(refKind) || !ref || ref.length > 128) {
			return false;
		}
		if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 10_000_000 || Math.abs(y) > 10_000_000) {
			return false;
		}
		const next = { refKind, ref, x, y };
		if (position.collabRef != null) {
			const collabRef = String(position.collabRef);
			if (!collabRef || collabRef.length > 128) {
				return false;
			}
			next.collabRef = collabRef;
		}
		clean.push(next);
	}
	entry.lastSeenAt = Date.now();
	_broadcastMutation(scoped.scopeId, entry, { type: 'record-layout', connectionId, positions: clean }, connectionId);
	return true;
}

export function broadcastCanvasSaved({
	canvasId,
	sfOrgId,
	savedByAccountId,
	savedByDisplayName,
	versionId,
	title,
	snapshotHash,
	payload,
}) {
	if (!canvasId) {
		return 0;
	}
	const scopeId = _presenceScopeId(canvasId, sfOrgId);
	const state = _revisionState(scopeId);
	state.durableRevision = state.revision;
	if (_validLiveSnapshot(payload)) {
		_liveSnapshotsByCanvas.set(scopeId, {
			payload: _cloneSnapshot(payload),
			revision: state.revision,
			updatedAt: Date.now(),
		});
	}
	return _broadcast(
		scopeId,
		{
			type: 'canvas-saved',
			savedByAccountId: savedByAccountId || null,
			savedByDisplayName: savedByDisplayName || 'Someone',
			versionId: versionId || null,
			title: title || null,
			revision: state.durableRevision,
			snapshotHash: snapshotHash || null,
			at: Date.now(),
		},
		null,
	);
}

export function summary({ canvasId, sfOrgId }) {
	const scopeId = _presenceScopeId(canvasId, sfOrgId);
	const conns = _presenceByCanvas.get(scopeId);
	if (!conns) {
		return { count: 0 };
	}
	const live = _liveSnapshotsByCanvas.get(scopeId);
	return {
		count: conns.size,
		liveRevision: live ? live.revision : null,
		hasLiveSnapshot: !!live,
	};
}

export function liveSnapshot({ canvasId, sfOrgId }) {
	const live = _liveSnapshotsByCanvas.get(_presenceScopeId(canvasId, sfOrgId));
	return live
		? {
				payload: _cloneSnapshot(live.payload),
				revision: live.revision,
				updatedAt: live.updatedAt,
			}
		: null;
}

export function unsavedLiveSnapshot({ canvasId, sfOrgId }) {
	const scopeId = _presenceScopeId(canvasId, sfOrgId);
	const live = _liveSnapshotsByCanvas.get(scopeId);
	const state = _revisionByCanvas.get(scopeId);
	if (!live || !state || live.revision <= state.durableRevision) {
		return null;
	}
	return {
		payload: _cloneSnapshot(live.payload),
		revision: live.revision,
		durableRevision: state.durableRevision,
		updatedAt: live.updatedAt,
	};
}

export function purgeAccountFromWorkspace({ workspaceId, accountId }) {
	let removed = 0;
	for (const conns of _presenceByCanvas.values()) {
		for (const entry of [...conns.values()]) {
			if (entry.workspaceId === workspaceId && entry.accountId === accountId) {
				if (unsubscribe({ canvasId: entry.canvasId, connectionId: entry.connectionId })) {
					removed++;
				}
			}
		}
	}
	return removed;
}

export function purgeWorkspace({ workspaceId }) {
	let removed = 0;
	for (const conns of _presenceByCanvas.values()) {
		for (const entry of [...conns.values()]) {
			if (entry.workspaceId === workspaceId) {
				if (unsubscribe({ canvasId: entry.canvasId, connectionId: entry.connectionId })) {
					removed++;
				}
			}
		}
	}
	return removed;
}

function _sweep() {
	// Idle peers disappear even when a browser vanishes without closing its SSE connection cleanly.
	const now = Date.now();
	for (const [scopeId, conns] of _presenceByCanvas.entries()) {
		for (const [connectionId, entry] of conns.entries()) {
			if (now - entry.lastSeenAt > IDLE_THRESHOLD_MS) {
				conns.delete(connectionId);
				_scopeByConnection.delete(connectionId);
				_broadcast(scopeId, { type: 'leave', connectionId }, connectionId);
			}
		}
		if (conns.size === 0) {
			_presenceByCanvas.delete(scopeId);
			_revisionByCanvas.delete(scopeId);
			_liveSnapshotsByCanvas.delete(scopeId);
		}
	}
}

const _sweepTimer = setInterval(_sweep, SWEEP_INTERVAL_MS);
if (_sweepTimer.unref) {
	_sweepTimer.unref();
}
