// Ephemeral in-process collaboration state. Presence is never a durable source of canvas truth.
import crypto from 'node:crypto';
import { hiddenCanvasRecordId } from './slot-helpers.js';

const _presenceByCanvas = new Map();
const _revisionByCanvas = new Map();
const _liveSnapshotsByCanvas = new Map();
const _orphanedLiveSnapshotsByCanvas = new Map();
const _scopeByConnection = new Map();
const _fieldLocksByCanvas = new Map();
const _fieldVersionsByCanvas = new Map();
const PRESENCE_INSTANCE_ID = crypto.randomUUID();

const IDLE_THRESHOLD_MS = 90 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
const LIVE_SNAPSHOT_HANDOFF_TTL_MS = 10 * 60 * 1000;
const LIVE_SNAPSHOT_REFRESH_DEBOUNCE_MS = 100;
export const FIELD_LOCK_LEASE_MS = 45 * 1000;
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

function _discardCanvasState(scopeId) {
	_revisionByCanvas.delete(scopeId);
	_liveSnapshotsByCanvas.delete(scopeId);
	_orphanedLiveSnapshotsByCanvas.delete(scopeId);
	_fieldLocksByCanvas.delete(scopeId);
	_fieldVersionsByCanvas.delete(scopeId);
}

function _handleEmptyPresenceScope(scopeId, workspaceId, now = Date.now()) {
	_presenceByCanvas.delete(scopeId);
	_fieldLocksByCanvas.delete(scopeId);
	_fieldVersionsByCanvas.delete(scopeId);
	const live = _liveSnapshotsByCanvas.get(scopeId);
	const state = _revisionByCanvas.get(scopeId);
	if (live && state && live.revision > state.durableRevision) {
		_orphanedLiveSnapshotsByCanvas.set(scopeId, { workspaceId, orphanedAt: now });
		return;
	}
	_discardCanvasState(scopeId);
}

function _fieldKey(reference, fieldName) {
	if (
		!reference ||
		!['loaded', 'draft', 'slot'].includes(reference.refKind) ||
		reference.ref == null ||
		!/^[A-Za-z][A-Za-z0-9_]*$/.test(String(fieldName || ''))
	) {
		return null;
	}
	if (
		(reference.sourceRefKind != null || reference.sourceRef != null) &&
		(!['loaded', 'draft'].includes(reference.sourceRefKind) ||
			reference.sourceRef == null ||
			!String(reference.sourceRef) ||
			String(reference.sourceRef).length > 128)
	) {
		return null;
	}
	return JSON.stringify([
		reference.refKind,
		String(reference.ref),
		reference.collabRef == null ? null : String(reference.collabRef),
		String(fieldName),
	]);
}

function _cleanRecordReference(reference) {
	if (!reference || typeof reference !== 'object' || !['loaded', 'draft', 'slot'].includes(reference.refKind)) {
		return null;
	}
	const ref = reference.ref == null ? '' : String(reference.ref);
	if (!ref || ref.length > 128) {
		return null;
	}
	const clean = { refKind: reference.refKind, ref };
	if (reference.collabRef != null) {
		const collabRef = String(reference.collabRef);
		if (!collabRef || collabRef.length > 128) {
			return null;
		}
		clean.collabRef = collabRef;
	}
	if (reference.sourceRefKind != null || reference.sourceRef != null) {
		if (!['loaded', 'draft'].includes(reference.sourceRefKind)) {
			return null;
		}
		const sourceRef = reference.sourceRef == null ? '' : String(reference.sourceRef);
		if (!sourceRef || sourceRef.length > 128) {
			return null;
		}
		clean.sourceRefKind = reference.sourceRefKind;
		clean.sourceRef = sourceRef;
	}
	return clean;
}

function _activeFieldLocks(scopeId) {
	const now = Date.now();
	const locks = _fieldLocksByCanvas.get(scopeId);
	if (!locks) {
		return new Map();
	}
	for (const [key, lock] of locks) {
		if (!lock || lock.expiresAt <= now) {
			locks.delete(key);
		}
	}
	if (locks.size === 0) {
		_fieldLocksByCanvas.delete(scopeId);
	}
	return locks;
}

function _publicFieldLock(lock) {
	return lock
		? {
				leaseId: lock.leaseId,
				connectionId: lock.connectionId,
				accountId: lock.accountId,
				displayName: lock.displayName,
				color: lock.color,
				targetRef: lock.targetRef,
				fieldName: lock.fieldName,
				expiresAt: lock.expiresAt,
				baseVersion: lock.baseVersion,
			}
		: null;
}

function _releaseConnectionLocks(scopeId, connectionId) {
	const locks = _activeFieldLocks(scopeId);
	let released = 0;
	for (const [key, lock] of locks) {
		if (lock.connectionId !== connectionId) {
			continue;
		}
		locks.delete(key);
		released += 1;
		_broadcast(
			scopeId,
			{ type: 'field-lock', lock: null, targetRef: lock.targetRef, fieldName: lock.fieldName },
			connectionId,
		);
	}
	return released;
}

function _fieldVersions(scopeId) {
	if (!_fieldVersionsByCanvas.has(scopeId)) {
		_fieldVersionsByCanvas.set(scopeId, new Map());
	}
	return _fieldVersionsByCanvas.get(scopeId);
}

function _slotAllowsContributor(entry, record, fieldName) {
	if (!entry || entry.role !== 'contributor' || !record || !record.slot) {
		return false;
	}
	const slot = record.slot;
	if ((slot.kind || 'whole-record') === 'fields') {
		if (!Array.isArray(slot.fields) || !slot.fields.includes(fieldName)) {
			return false;
		}
	}
	const assignee = slot.assigneeSfUserId == null ? '' : String(slot.assigneeSfUserId).slice(0, 15);
	const actor = entry.sfUserId == null ? '' : String(entry.sfUserId).slice(0, 15);
	return !assignee || (actor && assignee === actor);
}

function _entryCanEditField(entry, record, fieldName) {
	if (!entry || !record || !fieldName || entry.accessRevoked) {
		return false;
	}
	if (entry.role === 'owner' || entry.role === 'editor') {
		return true;
	}
	return _slotAllowsContributor(entry, record, fieldName);
}

function _projectFieldLock(entry, lock) {
	if (!lock) {
		return null;
	}
	const visibility = _visibilityForRef(entry, lock.targetRef);
	if (!visibility.visible || (visibility.readableFields && !visibility.readableFields.has(lock.fieldName))) {
		return null;
	}
	return _publicFieldLock(lock);
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

const SNAPSHOT_CARD_GAP_X = 260;
const SNAPSHOT_CARD_GAP_Y = 180;

function _snapshotRecords(payload) {
	return [
		...(Array.isArray(payload && payload.loadedRecords) ? payload.loadedRecords : []),
		...(Array.isArray(payload && payload.drafts) ? payload.drafts : []),
	].filter(Boolean);
}

function _sameCardPosition(left, right) {
	return Math.abs(left.x - right.x) < 1 && Math.abs(left.y - right.y) < 1;
}

function _cardPositionIsOpen(placed, candidate) {
	return !placed.some(
		(position) =>
			Math.abs(position.x - candidate.x) < SNAPSHOT_CARD_GAP_X &&
			Math.abs(position.y - candidate.y) < SNAPSHOT_CARD_GAP_Y,
	);
}

function _nearestOpenCardPosition(placed, origin) {
	for (let ring = 1; ring <= 100; ring++) {
		const offsets = [
			[0, ring],
			[ring, 0],
			[-ring, 0],
			[0, -ring],
			[ring, ring],
			[-ring, ring],
			[ring, -ring],
			[-ring, -ring],
		];
		for (const [column, row] of offsets) {
			const candidate = {
				x: origin.x + column * SNAPSHOT_CARD_GAP_X,
				y: origin.y + row * SNAPSHOT_CARD_GAP_Y,
			};
			if (_cardPositionIsOpen(placed, candidate)) {
				return candidate;
			}
		}
	}
	return { x: origin.x, y: origin.y + (placed.length + 1) * SNAPSHOT_CARD_GAP_Y };
}

function _spreadExactCardOverlaps(payload) {
	const placed = [];
	for (const record of _snapshotRecords(payload)) {
		const origin = {
			x: Number.isFinite(record.x) ? record.x : 200,
			y: Number.isFinite(record.y) ? record.y : 200,
		};
		if (placed.some((position) => _sameCardPosition(position, origin))) {
			const open = _nearestOpenCardPosition(placed, origin);
			record.x = open.x;
			record.y = open.y;
		} else {
			record.x = origin.x;
			record.y = origin.y;
		}
		placed.push({ x: record.x, y: record.y });
	}
	return payload;
}

export function normalizeSnapshotLayout(payload) {
	return _spreadExactCardOverlaps(_cloneSnapshot(payload));
}

function _availableCreatePosition(payload, x, y) {
	const origin = {
		x: Number.isFinite(x) ? x : 200,
		y: Number.isFinite(y) ? y : 200,
	};
	const placed = _snapshotRecords(payload)
		.filter((record) => Number.isFinite(record.x) && Number.isFinite(record.y))
		.map((record) => ({ x: record.x, y: record.y }));
	return placed.some((position) => _sameCardPosition(position, origin))
		? _nearestOpenCardPosition(placed, origin)
		: origin;
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
	const matchesReference = (record, refKind, target) => {
		if (refKind === 'loaded') {
			return record.loadedFromId && _sfIdKey(record.loadedFromId) === _sfIdKey(target);
		}
		if (refKind === 'draft') {
			return record.tempId != null && String(record.tempId) === target;
		}
		if (refKind === 'slot') {
			return record.slot && record.slot.slotId != null && String(record.slot.slotId) === target;
		}
		return false;
	};
	const matchingRecords = records.filter((record) => record && matchesReference(record, reference.refKind, ref));
	if (collabRef != null) {
		const exact = matchingRecords.find(
			(record) => record.canvasRecordId != null && String(record.canvasRecordId) === collabRef,
		);
		if (exact) {
			return exact;
		}
		const cardMatches = records.filter(
			(record) => record && record.canvasRecordId != null && String(record.canvasRecordId) === collabRef,
		);
		if (cardMatches.length === 1) {
			return cardMatches[0];
		}
		// Legacy payloads have no canvasRecordId. Their natural reference is safe only when unique.
		if (matchingRecords.length === 1) {
			return matchingRecords[0];
		}
	}
	if (matchingRecords.length === 1) {
		return matchingRecords[0];
	}
	const sourceRefKind = reference.sourceRefKind;
	const sourceRef = reference.sourceRef == null ? null : String(reference.sourceRef);
	if (['loaded', 'draft'].includes(sourceRefKind) && sourceRef) {
		const sourceMatches = records.filter((record) => record && matchesReference(record, sourceRefKind, sourceRef));
		if (sourceMatches.length === 1) {
			return sourceMatches[0];
		}
	}
	return collabRef == null ? matchingRecords[0] || null : null;
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

function _promoteSnapshotDraft(payload, record, event) {
	if (!record || record.loadedFromId || event.kind !== 'create') {
		return false;
	}
	const draftRef = record.tempId;
	const slotRef = record.slot && record.slot.slotId;
	payload.drafts = (payload.drafts || []).filter((candidate) => candidate !== record);
	payload.loadedRecords = Array.isArray(payload.loadedRecords) ? payload.loadedRecords : [];
	if (!payload.loadedRecords.includes(record)) {
		payload.loadedRecords.push(record);
	}
	record.loadedFromId = event.sfId;
	record.canvasRecordId = event.collabRef || record.canvasRecordId || event.sfId;
	record.objectName = event.objectName || record.objectName;
	delete record.tempId;
	delete record.values;
	delete record.changes;
	if (draftRef != null || (event.slot === null && slotRef != null)) {
		for (const association of payload.associations || []) {
			for (const endpointName of ['from', 'to']) {
				const endpoint = association && association[endpointName];
				const matchesDraft =
					draftRef != null &&
					endpoint &&
					endpoint.kind === 'draft' &&
					String(endpoint.ref) === String(draftRef);
				const matchesSlot =
					event.slot === null &&
					slotRef != null &&
					endpoint &&
					endpoint.kind === 'slot' &&
					String(endpoint.ref) === String(slotRef);
				if (matchesDraft || matchesSlot) {
					association[endpointName] = { kind: 'loaded', ref: event.sfId };
				}
			}
		}
	}
	return true;
}

function _initialLoadedRecordChanges(fields, baseline) {
	const current = fields && typeof fields === 'object' ? fields : {};
	const original = baseline && typeof baseline === 'object' ? baseline : {};
	const changes = {};
	for (const name of new Set([...Object.keys(original), ...Object.keys(current)])) {
		const hasCurrent = Object.prototype.hasOwnProperty.call(current, name);
		const hasOriginal = Object.prototype.hasOwnProperty.call(original, name);
		if (!hasCurrent && hasOriginal) {
			changes[name] = null;
		} else if (!hasOriginal || JSON.stringify(current[name]) !== JSON.stringify(original[name])) {
			changes[name] = current[name];
		}
	}
	return changes;
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
				if (event.slot !== undefined) {
					if (event.slot === null) {
						delete record.slot;
					} else {
						record.slot = _cloneSnapshot(event.slot);
					}
				}
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
		const loadedRecord = _payloadRecordForRef(payload, {
			refKind: 'loaded',
			ref: event.sfId,
			collabRef: event.collabRef,
		});
		let record = event.promotedFrom ? _payloadRecordForRef(payload, event.promotedFrom) : null;
		if (record && loadedRecord && record !== loadedRecord) {
			payload.loadedRecords = (payload.loadedRecords || []).filter((candidate) => candidate !== loadedRecord);
		}
		record = record || loadedRecord;
		_promoteSnapshotDraft(payload, record, event);
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
			if (event.kind === 'create') {
				record.loadedFromId = event.sfId;
				record.canvasRecordId = event.collabRef || record.canvasRecordId || event.sfId;
				record.objectName = event.objectName || record.objectName;
				delete record.tempId;
			}
			if (event.slot !== undefined) {
				if (event.slot === null) {
					delete record.slot;
				} else {
					record.slot = _cloneSnapshot(event.slot);
				}
			}
			if (event.kind === 'create' || (event.kind === 'update' && event.baseline)) {
				record.changes = _initialLoadedRecordChanges(event.fields, event.baseline);
			} else if (event.kind === 'update') {
				record.changes = record.changes && typeof record.changes === 'object' ? record.changes : {};
				for (const [name, value] of Object.entries(event.fields || {})) {
					record.changes[name] = value;
				}
			}
			if (record.changes && Object.keys(record.changes).length === 0) {
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
	} else if (event.type === 'field-update') {
		const record = _payloadRecordForRef(payload, event.targetRef);
		if (record) {
			const target =
				event.targetRef.refKind === 'loaded'
					? (record.changes = record.changes && typeof record.changes === 'object' ? record.changes : {})
					: (record.values = record.values && typeof record.values === 'object' ? record.values : {});
			for (const [name, value] of Object.entries(event.fields || {})) {
				if (value === null && event.targetRef.refKind !== 'loaded') {
					delete target[name];
				} else {
					target[name] = value;
				}
			}
			const relationshipFields = new Set(Array.isArray(event.relationshipFields) ? event.relationshipFields : []);
			if (relationshipFields.size > 0) {
				const recordEndpoints = [];
				if (record.loadedFromId) {
					recordEndpoints.push({ kind: 'loaded', ref: record.loadedFromId });
				}
				if (record.tempId != null) {
					recordEndpoints.push({ kind: 'draft', ref: record.tempId });
				}
				if (record.slot && record.slot.slotId != null) {
					recordEndpoints.push({ kind: 'slot', ref: record.slot.slotId });
				}
				payload.associations = (payload.associations || []).filter(
					(association) =>
						!relationshipFields.has(association && association.fieldName) ||
						!recordEndpoints.some((endpoint) => _sameEndpoint(association && association.from, endpoint)),
				);
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

function _projectRecipientSlot(slot, readableFields) {
	if (!slot || typeof slot !== 'object' || (slot.kind || 'whole-record') !== 'fields' || !readableFields) {
		return slot;
	}
	const fields = Array.isArray(slot.fields) ? slot.fields : [];
	const projectedFields = fields.filter((field) => readableFields.has(field));
	const priorUnavailable = Number.isSafeInteger(Number(slot.unavailableFieldCount))
		? Math.max(0, Number(slot.unavailableFieldCount))
		: 0;
	const unavailableFieldCount = priorUnavailable + fields.length - projectedFields.length;
	const projected = { ...slot, fields: projectedFields };
	if (unavailableFieldCount > 0) {
		projected.unavailableFieldCount = unavailableFieldCount;
	} else {
		delete projected.unavailableFieldCount;
	}
	return projected;
}

function _hiddenRecordKey(reference) {
	if (reference && reference.collabRef != null && String(reference.collabRef)) {
		return 'card:' + String(reference.collabRef);
	}
	return _hiddenRecordReferenceKey(reference);
}

function _hiddenRecordReferenceKey(reference) {
	return reference && reference.refKind && reference.ref != null
		? String(reference.refKind) + ':' + String(reference.ref)
		: null;
}

function _hiddenRecordId(entry, reference, create = false) {
	const key = _hiddenRecordKey(reference);
	if (!key || !(entry.hiddenRecordIds instanceof Map)) {
		return null;
	}
	const stableId = hiddenCanvasRecordId(reference && reference.collabRef);
	if (stableId) {
		entry.hiddenRecordIds.set(key, stableId);
		const referenceKey = _hiddenRecordReferenceKey(reference);
		if (referenceKey) {
			entry.hiddenRecordIds.set(referenceKey, stableId);
		}
	} else if (!entry.hiddenRecordIds.has(key) && create) {
		entry.hiddenRecordIds.set(key, 'hidden-live-' + crypto.randomUUID());
	}
	const hiddenId = stableId || entry.hiddenRecordIds.get(key) || null;
	if (hiddenId && entry.hiddenRecordReferences instanceof Map) {
		entry.hiddenRecordReferences.set(hiddenId, {
			refKind: String(reference.refKind),
			ref: String(reference.ref),
			...(reference.collabRef != null ? { collabRef: String(reference.collabRef) } : {}),
			...(reference.sourceRefKind != null ? { sourceRefKind: String(reference.sourceRefKind) } : {}),
			...(reference.sourceRef != null ? { sourceRef: String(reference.sourceRef) } : {}),
		});
	}
	return hiddenId;
}

function _forgetHiddenRecordId(entry, hiddenId) {
	for (const [key, value] of entry.hiddenRecordIds instanceof Map ? entry.hiddenRecordIds : []) {
		if (value === hiddenId) {
			entry.hiddenRecordIds.delete(key);
		}
	}
	if (entry.hiddenRecordReferences instanceof Map) {
		entry.hiddenRecordReferences.delete(hiddenId);
	}
}

function _snapshotRecordReference(record) {
	if (!record || typeof record !== 'object') {
		return null;
	}
	let reference;
	if (record.slot && record.slot.slotId != null) {
		reference = { refKind: 'slot', ref: String(record.slot.slotId) };
		if (record.loadedFromId) {
			reference.sourceRefKind = 'loaded';
			reference.sourceRef = String(record.loadedFromId);
		} else if (record.tempId != null) {
			reference.sourceRefKind = 'draft';
			reference.sourceRef = String(record.tempId);
		}
	} else if (record.loadedFromId) {
		reference = { refKind: 'loaded', ref: String(record.loadedFromId) };
	} else if (record.tempId != null) {
		reference = { refKind: 'draft', ref: String(record.tempId) };
	} else {
		return null;
	}
	if (record.canvasRecordId != null && String(record.canvasRecordId)) {
		reference.collabRef = String(record.canvasRecordId);
	}
	return reference;
}

function _seedHiddenRecordReferences(entry, payload) {
	if (!entry || entry.role === 'owner' || !entry.visibility) {
		return;
	}
	for (const record of _snapshotRecords(payload)) {
		const reference = _snapshotRecordReference(record);
		if (reference && !_visibilityForRef(entry, reference).visible) {
			_hiddenRecordId(entry, reference, true);
		}
	}
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

function _forgetLoadedVisibility(entry, reference) {
	_syncSlotVisibility(entry, reference, null);
	const loadedRecords = entry.visibility && entry.visibility.loadedRecords;
	if (!loadedRecords) {
		return;
	}
	const targetKey = _sfIdKey(reference && reference.ref);
	for (const key of Object.keys(loadedRecords)) {
		if (_sfIdKey(key) === targetKey) {
			delete loadedRecords[key];
		}
	}
}

function _projectPresencePayload(entry, payload) {
	if (!payload || typeof payload !== 'object') {
		return payload;
	}
	if (payload.type === 'field-update' && entry.role !== 'owner') {
		payload = { ...payload, contributionIds: undefined };
	}
	if (!entry.visibility || entry.role === 'owner') {
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
			...(payload.slot !== undefined
				? { slot: _projectRecipientSlot(payload.slot, visibility.readableFields) }
				: {}),
		};
	}
	if (payload.type === 'loaded-removed') {
		const loadedRef = {
			refKind: 'loaded',
			ref: payload.sfId,
			...(payload.collabRef != null ? { collabRef: String(payload.collabRef) } : {}),
		};
		const visible = _visibilityForRef(entry, loadedRef).visible;
		const hiddenId = visible ? null : _hiddenRecordId(entry, loadedRef);
		_forgetLoadedVisibility(entry, loadedRef);
		if (visible) {
			return payload;
		}
		if (!hiddenId) {
			return null;
		}
		_forgetHiddenRecordId(entry, hiddenId);
		return { type: 'hidden-record', kind: 'remove', hiddenId, revision: payload.revision };
	}
	if (payload.type === 'draft-update') {
		const draftRef = {
			refKind: 'draft',
			ref: payload.tempId,
			...(payload.canvasRecordId != null ? { collabRef: String(payload.canvasRecordId) } : {}),
		};
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
		const visibility = _visibilityForRef(entry, draftRef);
		if (!visibility.visible) {
			const hiddenId = _hiddenRecordId(entry, draftRef, payload.kind === 'create');
			if (!hiddenId) {
				return null;
			}
			if (payload.kind === 'remove') {
				_forgetHiddenRecordId(entry, hiddenId);
				if (entry.visibility.drafts) {
					delete entry.visibility.drafts[String(payload.tempId)];
				}
				return { type: 'hidden-record', kind: 'remove', hiddenId, revision: payload.revision };
			}
			if (payload.kind === 'create' || payload.position) {
				return {
					type: 'hidden-record',
					kind: payload.kind === 'create' ? 'create' : 'update',
					hiddenId,
					x: payload.position && Number.isFinite(payload.position.x) ? payload.position.x : payload.x,
					y: payload.position && Number.isFinite(payload.position.y) ? payload.position.y : payload.y,
					revision: payload.revision,
				};
			}
			return null;
		}
		if (payload.kind === 'create' && payload.slot !== undefined) {
			_syncSlotVisibility(entry, draftRef, payload.slot);
		}
		const projected = {
			...payload,
			fields: _pickReadableFields(payload.fields, visibility.readableFields),
			...(payload.slot !== undefined
				? { slot: _projectRecipientSlot(payload.slot, visibility.readableFields) }
				: {}),
		};
		if (payload.kind === 'remove' && entry.visibility.drafts) {
			_syncSlotVisibility(entry, draftRef, null);
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
		if (payload.slot && payload.slot.kind === 'fields') {
			return { ...payload, slot: _projectRecipientSlot(payload.slot, visibility.readableFields) };
		}
		return payload;
	}
	if (payload.type === 'record-layout') {
		const positions = [];
		for (const position of payload.positions || []) {
			if (_visibilityForRef(entry, position).visible) {
				positions.push(position);
				continue;
			}
			const hiddenId = _hiddenRecordId(entry, position);
			if (hiddenId) {
				positions.push({ hiddenId, x: position.x, y: position.y });
			}
		}
		return positions.length > 0 ? { ...payload, positions } : null;
	}
	if (payload.type === 'field-update') {
		const visibility = _visibilityForRef(entry, payload.targetRef);
		if (!visibility.visible) {
			return null;
		}
		const fields = visibility.readableFields
			? _pickReadableFields(payload.fields, visibility.readableFields)
			: payload.fields;
		const relationshipFields = (Array.isArray(payload.relationshipFields) ? payload.relationshipFields : []).filter(
			(fieldName) => Object.prototype.hasOwnProperty.call(fields || {}, fieldName),
		);
		return {
			...payload,
			contributionIds: entry.role === 'owner' ? payload.contributionIds : undefined,
			fields,
			relationshipFields: relationshipFields.length > 0 ? relationshipFields : undefined,
		};
	}
	if (payload.type === 'field-lock') {
		const targetRef = payload.lock ? payload.lock.targetRef : payload.targetRef;
		const fieldName = payload.lock ? payload.lock.fieldName : payload.fieldName;
		const visibility = _visibilityForRef(entry, targetRef);
		if (!visibility.visible || (visibility.readableFields && !visibility.readableFields.has(fieldName))) {
			return null;
		}
		return { ...payload, lock: payload.lock ? _publicFieldLock(payload.lock) : null };
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
		_seedHiddenRecordReferences(entry, live.payload);
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

function _scheduleLiveSnapshotRefresh(scopeId, entry) {
	if (!entry || entry.accessRevoked) {
		return;
	}
	entry.snapshotRefreshPending = true;
	if (entry.snapshotRefreshTimer) {
		clearTimeout(entry.snapshotRefreshTimer);
	}
	entry.snapshotRefreshTimer = setTimeout(async () => {
		entry.snapshotRefreshTimer = null;
		const conns = _presenceByCanvas.get(scopeId);
		if (!conns || conns.get(entry.connectionId) !== entry || entry.accessRevoked) {
			entry.snapshotRefreshPending = false;
			return;
		}
		if (entry.snapshotSyncing) {
			_scheduleLiveSnapshotRefresh(scopeId, entry);
			return;
		}
		entry.snapshotRefreshPending = false;
		const live = _liveSnapshotsByCanvas.get(scopeId);
		if (live) {
			await _deliverLiveSnapshot(scopeId, entry, live);
		}
		if (entry.snapshotRefreshPending) {
			_scheduleLiveSnapshotRefresh(scopeId, entry);
		}
	}, LIVE_SNAPSHOT_REFRESH_DEBOUNCE_MS);
	if (entry.snapshotRefreshTimer.unref) {
		entry.snapshotRefreshTimer.unref();
	}
}

function _broadcast(canvasId, payload, excludeConnId) {
	const conns = _presenceByCanvas.get(canvasId);
	if (!conns) {
		return 0;
	}
	let delivered = 0;
	for (const [connId, entry] of conns.entries()) {
		const projected = _projectPresencePayload(entry, payload);
		if (connId === excludeConnId) {
			continue;
		}
		if (entry.snapshotSyncing && Number.isSafeInteger(payload && payload.revision)) {
			entry.pendingSnapshotEvents.push(payload);
			continue;
		}
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
	const createsDraft = revisioned.type === 'draft-update' && revisioned.kind === 'create';
	const createsLoadedRecord = revisioned.type === 'loaded-record' && revisioned.kind === 'create';
	const refreshVisibility = live && (createsDraft || createsLoadedRecord);
	if (refreshVisibility) {
		const conns = _presenceByCanvas.get(canvasId);
		for (const candidate of conns ? conns.values() : []) {
			const objectVisibilityKnown = !!(
				createsDraft &&
				candidate.visibility &&
				candidate.visibility.objects &&
				Object.prototype.hasOwnProperty.call(candidate.visibility.objects, revisioned.objectName)
			);
			if (
				candidate.connectionId !== excludeConnId &&
				candidate.role !== 'owner' &&
				(!createsDraft || !objectVisibilityKnown)
			) {
				_scheduleLiveSnapshotRefresh(canvasId, candidate);
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
	const scopeId = connectionId ? _scopeByConnection.get(connectionId) : _presenceScopeId(canvasId, sfOrgId);
	const state = _revisionByCanvas.get(scopeId);
	return state ? state.revision : 0;
}

export function seedLiveSnapshot({ canvasId, sfOrgId, payload, replaceIfDurable = false }) {
	const scopeId = _presenceScopeId(canvasId, sfOrgId);
	if (!canvasId || !_validLiveSnapshot(payload)) {
		return false;
	}
	const state = _revisionState(scopeId);
	const existing = _liveSnapshotsByCanvas.get(scopeId);
	if (existing) {
		if (!replaceIfDurable || existing.revision > state.durableRevision) {
			return false;
		}
		_liveSnapshotsByCanvas.set(scopeId, {
			payload: normalizeSnapshotLayout(payload),
			revision: state.durableRevision,
			updatedAt: Date.now(),
		});
		return true;
	}
	_liveSnapshotsByCanvas.set(scopeId, {
		payload: normalizeSnapshotLayout(payload),
		revision: state.revision,
		updatedAt: Date.now(),
	});
	return true;
}

// Repair a missing live record from the trusted durable canvas without
// replacing newer in-memory edits on other records.
export function mergeLiveSnapshotRecord({ canvasId, sfOrgId, payload, targetRef }) {
	const scopeId = _presenceScopeId(canvasId, sfOrgId);
	const live = _liveSnapshotsByCanvas.get(scopeId);
	if (!canvasId || !live || !_validLiveSnapshot(payload) || !targetRef) {
		return false;
	}
	if (_payloadRecordForRef(live.payload, targetRef)) {
		return true;
	}
	const durableRecord = _payloadRecordForRef(payload, targetRef);
	if (!durableRecord) {
		return false;
	}
	const clonedRecord = _cloneSnapshot(durableRecord);
	if (clonedRecord.loadedFromId) {
		live.payload.loadedRecords = Array.isArray(live.payload.loadedRecords) ? live.payload.loadedRecords : [];
		live.payload.loadedRecords.push(clonedRecord);
	} else {
		live.payload.drafts = Array.isArray(live.payload.drafts) ? live.payload.drafts : [];
		live.payload.drafts.push(clonedRecord);
	}
	const durableSchemaObject = (
		payload.schema && Array.isArray(payload.schema.objects) ? payload.schema.objects : []
	).find((object) => object && object.name === clonedRecord.objectName);
	if (durableSchemaObject) {
		live.payload.schema =
			live.payload.schema && typeof live.payload.schema === 'object' ? live.payload.schema : { objects: [] };
		live.payload.schema.objects = Array.isArray(live.payload.schema.objects) ? live.payload.schema.objects : [];
		if (!live.payload.schema.objects.some((object) => object && object.name === clonedRecord.objectName)) {
			live.payload.schema.objects.push(_cloneSnapshot(durableSchemaObject));
		}
	}
	live.updatedAt = Date.now();
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
	const orphaned = _orphanedLiveSnapshotsByCanvas.get(scopeId);
	if (orphaned && orphaned.workspaceId !== workspaceId) {
		_discardCanvasState(scopeId);
	} else {
		_orphanedLiveSnapshotsByCanvas.delete(scopeId);
	}
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
		// Every subscriber receives the server's current view. Owners use it to
		// reconcile tab-restored records that the in-memory snapshot is missing.
		awaitingSnapshot: !!_liveSnapshotsByCanvas.get(scopeId),
		snapshotSyncing: false,
		snapshotRefreshPending: false,
		snapshotRefreshTimer: null,
		snapshotRevision: null,
		pendingSnapshotEvents: [],
		hiddenRecordIds: new Map(),
		hiddenRecordReferences: new Map(),
		color,
		cursor: null,
		focus: null,
		lastSeenAt: Date.now(),
		lastSequence: 0,
		lastCanvasRevision: revisionState.durableRevision,
		sseRes,
	};
	const live = _liveSnapshotsByCanvas.get(scopeId);
	if (live) {
		_seedHiddenRecordReferences(entry, live.payload);
	}
	const peers = [];
	for (const other of conns.values()) {
		peers.push(_toPeerPayload(other));
	}
	conns.set(connectionId, entry);
	_scopeByConnection.set(connectionId, scopeId);
	_writeSseEvent(sseRes, 'presence-init', {
		serverInstanceId: PRESENCE_INSTANCE_ID,
		you: Object.assign(_toPeerPayload(entry), { role: entry.role, canEdit: entry.canEdit }),
		peers,
		fieldLocks: Array.from(_activeFieldLocks(scopeId).values())
			.map((lock) => _projectFieldLock(entry, lock))
			.filter(Boolean),
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
	if (keepalive.unref) {
		keepalive.unref();
	}
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
	if (entry.snapshotRefreshTimer) {
		clearTimeout(entry.snapshotRefreshTimer);
		entry.snapshotRefreshTimer = null;
	}
	_releaseConnectionLocks(scopeId, connectionId);
	conns.delete(connectionId);
	_scopeByConnection.delete(connectionId);
	if (conns.size === 0) {
		_handleEmptyPresenceScope(scopeId, entry.workspaceId);
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

export function acquireFieldLock({
	canvasId,
	connectionId,
	targetRef,
	fieldName,
	requestingAccountId,
	takeover = false,
}) {
	const scoped = _scopeForConnection(canvasId, connectionId);
	const entry = scoped && scoped.entry;
	const key = _fieldKey(targetRef, fieldName);
	const live = scoped && _liveSnapshotsByCanvas.get(scoped.scopeId);
	const record = live && _payloadRecordForRef(live.payload, targetRef);
	if (!scoped || !entry || !_ownsConnection(entry, requestingAccountId)) {
		return { ok: false, reason: 'presence-connection-stale' };
	}
	if (!key) {
		return { ok: false, reason: 'invalid-field-lock' };
	}
	if (!record) {
		return { ok: false, reason: 'canvas-record-not-found' };
	}
	if (!_entryCanEditField(entry, record, fieldName)) {
		return { ok: false, reason: 'field-not-editable' };
	}
	const locks = _activeFieldLocks(scoped.scopeId);
	const existing = locks.get(key);
	if (existing && existing.connectionId !== connectionId && !takeover) {
		return { ok: false, reason: 'field-locked', lock: _publicFieldLock(existing) };
	}
	const versions = _fieldVersions(scoped.scopeId);
	const lock = {
		leaseId: existing && existing.connectionId === connectionId ? existing.leaseId : crypto.randomUUID(),
		connectionId,
		accountId: entry.accountId,
		displayName: entry.displayName,
		color: entry.color,
		targetRef: _cloneSnapshot(targetRef),
		fieldName,
		expiresAt: Date.now() + FIELD_LOCK_LEASE_MS,
		baseVersion: versions.get(key) || 0,
	};
	locks.set(key, lock);
	_fieldLocksByCanvas.set(scoped.scopeId, locks);
	entry.lastSeenAt = Date.now();
	_broadcast(scoped.scopeId, { type: 'field-lock', lock: _publicFieldLock(lock) }, null);
	return { ok: true, lock: _publicFieldLock(lock) };
}

export function renewFieldLock({ canvasId, connectionId, leaseId, requestingAccountId }) {
	const scoped = _scopeForConnection(canvasId, connectionId);
	if (!scoped || !_ownsConnection(scoped.entry, requestingAccountId) || !leaseId) {
		return { ok: false, reason: 'field-lock-rejected' };
	}
	const locks = _activeFieldLocks(scoped.scopeId);
	const lock = Array.from(locks.values()).find(
		(candidate) => candidate.connectionId === connectionId && candidate.leaseId === leaseId,
	);
	if (!lock) {
		return { ok: false, reason: 'field-lock-expired' };
	}
	lock.expiresAt = Date.now() + FIELD_LOCK_LEASE_MS;
	scoped.entry.lastSeenAt = Date.now();
	return { ok: true, lock: _publicFieldLock(lock) };
}

export function releaseFieldLock({ canvasId, connectionId, leaseId, requestingAccountId }) {
	const scoped = _scopeForConnection(canvasId, connectionId);
	if (!scoped || !_ownsConnection(scoped.entry, requestingAccountId) || !leaseId) {
		return false;
	}
	const locks = _activeFieldLocks(scoped.scopeId);
	for (const [key, lock] of locks) {
		if (lock.connectionId !== connectionId || lock.leaseId !== leaseId) {
			continue;
		}
		locks.delete(key);
		_broadcast(
			scoped.scopeId,
			{ type: 'field-lock', lock: null, targetRef: lock.targetRef, fieldName: lock.fieldName },
			null,
		);
		return true;
	}
	return false;
}

function _validateFieldCommit({ scoped, connectionId, targetRef, fields, leases, allowContributor = false }) {
	const entry = scoped && scoped.entry;
	const live = scoped && _liveSnapshotsByCanvas.get(scoped.scopeId);
	const record = live && _payloadRecordForRef(live.payload, targetRef);
	const names = Object.keys(fields || {});
	if (
		!entry ||
		!record ||
		names.length === 0 ||
		names.length > MAX_PRESENCE_FIELDS ||
		names.some((name) => !/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) ||
		names.some((name) => {
			const value = fields[name];
			return !(
				value === null ||
				typeof value === 'string' ||
				typeof value === 'number' ||
				typeof value === 'boolean'
			);
		}) ||
		Buffer.byteLength(JSON.stringify(fields || {}), 'utf8') > MAX_PRESENCE_PAYLOAD_BYTES
	) {
		return { ok: false, reason: 'invalid-field-update' };
	}
	const locks = _activeFieldLocks(scoped.scopeId);
	const versions = _fieldVersions(scoped.scopeId);
	const conflicts = [];
	for (const name of names) {
		if ((entry.role === 'contributor' && !allowContributor) || !_entryCanEditField(entry, record, name)) {
			conflicts.push({ fieldName: name, reason: 'field-not-editable' });
			continue;
		}
		const key = _fieldKey(targetRef, name);
		const lease = leases && leases[name];
		const lock = key && locks.get(key);
		if (
			!lease ||
			!lock ||
			lock.connectionId !== connectionId ||
			lock.leaseId !== lease.leaseId ||
			lock.expiresAt <= Date.now()
		) {
			conflicts.push({
				fieldName: name,
				reason: lock && lock.connectionId !== connectionId ? 'field-locked' : 'field-lock-required',
				lock: lock ? _publicFieldLock(lock) : null,
			});
			continue;
		}
		const expected = Number.isSafeInteger(lease.baseVersion) ? lease.baseVersion : -1;
		const current = versions.get(key) || 0;
		if (expected !== current) {
			conflicts.push({ fieldName: name, reason: 'stale-field', currentVersion: current });
		}
	}
	return conflicts.length > 0 ? { ok: false, reason: 'field-conflict', conflicts } : { ok: true };
}

function _hasForeignFieldLock(scopeId, connectionId, targetRef, fieldNames) {
	const locks = _activeFieldLocks(scopeId);
	const live = _liveSnapshotsByCanvas.get(scopeId);
	const targetRecord = live && _payloadRecordForRef(live.payload, targetRef);
	return (fieldNames || []).some((fieldName) => {
		for (const lock of locks.values()) {
			if (lock.fieldName !== fieldName || lock.connectionId === connectionId) {
				continue;
			}
			const lockedRecord = live && _payloadRecordForRef(live.payload, lock.targetRef);
			if (targetRecord && lockedRecord === targetRecord) {
				return true;
			}
		}
		return false;
	});
}

export function validateFieldCommit({
	canvasId,
	connectionId,
	targetRef,
	fields,
	leases,
	requestingAccountId,
	allowContributor = false,
}) {
	const scoped = _scopeForConnection(canvasId, connectionId);
	if (!scoped || !_ownsConnection(scoped.entry, requestingAccountId)) {
		return { ok: false, reason: 'field-update-rejected' };
	}
	return _validateFieldCommit({ scoped, connectionId, targetRef, fields, leases, allowContributor });
}

export function commitFieldValues({
	canvasId,
	connectionId,
	targetRef,
	fields,
	leases,
	requestingAccountId,
	allowContributor = false,
	contributionIds = [],
	relationshipFields = [],
}) {
	const scoped = _scopeForConnection(canvasId, connectionId);
	if (!scoped || !_ownsConnection(scoped.entry, requestingAccountId)) {
		return { ok: false, reason: 'field-update-rejected' };
	}
	const validation = _validateFieldCommit({
		scoped,
		connectionId,
		targetRef,
		fields,
		leases,
		allowContributor,
	});
	if (!validation.ok) {
		return validation;
	}
	const cleanRelationshipFields = Array.from(
		new Set(
			(Array.isArray(relationshipFields) ? relationshipFields : [])
				.map(String)
				.filter(
					(fieldName) =>
						/^[A-Za-z][A-Za-z0-9_]*$/.test(fieldName) &&
						Object.prototype.hasOwnProperty.call(fields, fieldName),
				),
		),
	).slice(0, MAX_PRESENCE_FIELDS);
	const revisionValue = _broadcastMutation(
		scoped.scopeId,
		scoped.entry,
		{
			type: 'field-update',
			connectionId,
			targetRef: _cloneSnapshot(targetRef),
			fields: _cloneSnapshot(fields),
			...(cleanRelationshipFields.length > 0
				? { relationshipFields: _cloneSnapshot(cleanRelationshipFields) }
				: {}),
			contributionIds: (Array.isArray(contributionIds) ? contributionIds : [])
				.map(String)
				.filter((id) => /^[a-zA-Z0-9]{15,18}$/.test(id))
				.slice(0, 100),
		},
		connectionId,
	);
	const locks = _activeFieldLocks(scoped.scopeId);
	const versions = _fieldVersions(scoped.scopeId);
	for (const name of Object.keys(fields)) {
		const key = _fieldKey(targetRef, name);
		versions.set(key, revisionValue);
		const lock = locks.get(key);
		if (lock && lock.connectionId === connectionId) {
			locks.delete(key);
			_broadcast(
				scoped.scopeId,
				{ type: 'field-lock', lock: null, targetRef: lock.targetRef, fieldName: lock.fieldName },
				null,
			);
		}
	}
	return { ok: true, revision: revisionValue };
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
	slot,
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
	if (kind !== 'create' && _hasForeignFieldLock(scopeId, connectionId, { refKind: 'draft', ref: tempId }, keys)) {
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
		if (typeof objectName !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(objectName)) {
			return false;
		}
		const live = _liveSnapshotsByCanvas.get(scopeId);
		const createPosition = _availableCreatePosition(live && live.payload, x, y);
		const cleanSlot = _cleanSlot(slot);
		if (slot !== undefined && cleanSlot === undefined) {
			return false;
		}
		payload.kind = 'create';
		payload.objectName = objectName;
		if (canvasRecordId != null) {
			const cleanCanvasRecordId = String(canvasRecordId);
			if (!cleanCanvasRecordId || cleanCanvasRecordId.length > 128) {
				return false;
			}
			payload.canvasRecordId = cleanCanvasRecordId;
		}
		payload.x = createPosition.x;
		payload.y = createPosition.y;
		if (cleanSlot !== undefined) {
			payload.slot = cleanSlot;
		}
	} else if (kind === 'remove') {
		payload.kind = 'remove';
	}
	if (position && typeof position === 'object' && typeof position.x === 'number' && typeof position.y === 'number') {
		payload.position = { x: position.x, y: position.y };
	}
	const revisionValue = _broadcastMutation(scopeId, entry, payload, connectionId);
	if (kind === 'create' && (payload.x !== x || payload.y !== y)) {
		_broadcast(
			scopeId,
			{
				type: 'record-layout',
				connectionId,
				revision: revisionValue,
				positions: [
					{
						refKind: 'draft',
						ref: tempId,
						...(canvasRecordId != null ? { collabRef: String(canvasRecordId) } : {}),
						x: payload.x,
						y: payload.y,
					},
				],
			},
			null,
		);
	}
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
	slot,
	promotedFrom,
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
	if (
		kind === 'update' &&
		_hasForeignFieldLock(
			scoped.scopeId,
			connectionId,
			{ refKind: 'loaded', ref: sfId, ...(collabRef ? { collabRef } : {}) },
			Object.keys(fields),
		)
	) {
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
		const live = _liveSnapshotsByCanvas.get(scoped.scopeId);
		const createPosition = _availableCreatePosition(live && live.payload, x, y);
		const cleanSlot = _cleanSlot(slot);
		const cleanPromotedFrom = promotedFrom == null ? null : _cleanRecordReference(promotedFrom);
		if (slot !== undefined && cleanSlot === undefined) {
			return false;
		}
		if (promotedFrom != null && !cleanPromotedFrom) {
			return false;
		}
		payload.objectName = objectName;
		payload.baseline = baseline || {};
		payload.x = createPosition.x;
		payload.y = createPosition.y;
		if (cleanSlot !== undefined) {
			payload.slot = cleanSlot;
		}
		if (cleanPromotedFrom) {
			payload.promotedFrom = cleanPromotedFrom;
		}
	} else if (baseline && typeof baseline === 'object') {
		payload.baseline = baseline;
	}
	if (typeof pendingDelete === 'boolean') {
		payload.pendingDelete = pendingDelete;
	}
	const revisionValue = _broadcastMutation(scoped.scopeId, entry, payload, connectionId);
	if (kind === 'create' && (payload.x !== x || payload.y !== y)) {
		_broadcast(
			scoped.scopeId,
			{
				type: 'record-layout',
				connectionId,
				revision: revisionValue,
				positions: [
					{
						refKind: 'loaded',
						ref: String(sfId),
						...(collabRef != null ? { collabRef: String(collabRef) } : {}),
						x: payload.x,
						y: payload.y,
					},
				],
			},
			null,
		);
	}
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
	if (slot.origin != null && slot.origin !== '' && (kind !== 'whole-record' || slot.origin !== 'standalone')) {
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
	const createdAt =
		slot.createdAt == null || slot.createdAt === ''
			? null
			: Number.isSafeInteger(Number(slot.createdAt)) && Number(slot.createdAt) > 0
				? Number(slot.createdAt)
				: undefined;
	if ([label, description, assigneeSfUserId, assigneeName, assigneeEmail, createdAt].includes(undefined)) {
		return undefined;
	}
	if (assigneeSfUserId && !/^[A-Za-z0-9]{15,18}$/.test(assigneeSfUserId)) {
		return undefined;
	}
	const clean = {
		slotId,
		kind,
		createdAt,
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
	} else if (slot.origin === 'standalone') {
		clean.origin = 'standalone';
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
		const x = position && position.x;
		const y = position && position.y;
		if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 10_000_000 || Math.abs(y) > 10_000_000) {
			return false;
		}
		let next;
		if (position && position.hiddenId != null) {
			const hiddenId = String(position.hiddenId);
			const reference = entry.hiddenRecordReferences.get(hiddenId);
			if (!hiddenId || hiddenId.length > 128 || !reference || _visibilityForRef(entry, reference).visible) {
				return false;
			}
			next = { ...reference, x, y };
		} else {
			const refKind = position && position.refKind;
			const ref = position && position.ref != null ? String(position.ref) : '';
			if (!['loaded', 'draft', 'slot'].includes(refKind) || !ref || ref.length > 128) {
				return false;
			}
			next = { refKind, ref, x, y };
			if (position.collabRef != null) {
				const collabRef = String(position.collabRef);
				if (!collabRef || collabRef.length > 128) {
					return false;
				}
				next.collabRef = collabRef;
			}
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

export function loadedRecordObjectName({ canvasId, connectionId, sfId, collabRef, requestingAccountId }) {
	const scoped = _scopeForConnection(canvasId, connectionId);
	if (!scoped || !_ownsConnection(scoped.entry, requestingAccountId)) {
		return null;
	}
	const live = _liveSnapshotsByCanvas.get(scoped.scopeId);
	const record =
		live &&
		_payloadRecordForRef(live.payload, {
			refKind: 'loaded',
			ref: sfId,
			collabRef,
		});
	return record && record.objectName ? String(record.objectName) : null;
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
	for (const [scopeId, orphaned] of _orphanedLiveSnapshotsByCanvas.entries()) {
		if (orphaned.workspaceId === workspaceId) {
			_discardCanvasState(scopeId);
		}
	}
	return removed;
}

function _sweep() {
	// Idle peers disappear even when a browser vanishes without closing its SSE connection cleanly.
	const now = Date.now();
	for (const [scopeId, conns] of _presenceByCanvas.entries()) {
		const workspaceId = conns.values().next().value?.workspaceId || null;
		for (const [connectionId, entry] of conns.entries()) {
			if (now - entry.lastSeenAt > IDLE_THRESHOLD_MS) {
				_releaseConnectionLocks(scopeId, connectionId);
				conns.delete(connectionId);
				_scopeByConnection.delete(connectionId);
				_broadcast(scopeId, { type: 'leave', connectionId }, connectionId);
			}
		}
		if (conns.size === 0) {
			_handleEmptyPresenceScope(scopeId, workspaceId, now);
		}
	}
	for (const [scopeId, orphaned] of _orphanedLiveSnapshotsByCanvas.entries()) {
		if (now - orphaned.orphanedAt > LIVE_SNAPSHOT_HANDOFF_TTL_MS) {
			_discardCanvasState(scopeId);
		}
	}
}

const _sweepTimer = setInterval(_sweep, SWEEP_INTERVAL_MS);
if (_sweepTimer.unref) {
	_sweepTimer.unref();
}
