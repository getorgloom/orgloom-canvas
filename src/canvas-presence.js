// Real-time canvas presence: Phase 1 of the collaboration story.
//
// Each browser tab with a canvas open subscribes to an SSE channel keyed
// by canvasId. The server holds presence state (cursor coordinates,
// display name, assigned color) in memory only, never persisted, never
// surfaced through any other API. When a tab disconnects (close/reload),
// the SSE 'close' handler drops the entry and broadcasts a 'leave' event
// to remaining subscribers.
//
// Posture properties this module enforces:
//   - Since Phase 4, draft field VALUES (record contents typed into a
//     collaborative draft) DO flow through this channel alongside cursor
//     xy and identity metadata. Access to the channel is therefore gated
//     the same way as loading the canvas itself.
//   - Presence state is in-memory; nothing is at-rest on disk.
//   - Subscriptions are canvas-scoped and access-checked: the subscribe
//     route verifies the caller can actually read the canvas (SF File
//     sharing for SF-backed canvases; the unguessable random draft-UUID
//     is the capability for draft canvases) BEFORE opening the channel.
//     This still permits cross-workspace collaboration (a share-link
//     guest granted SF File access passes the check and sees the owner's
//     cursor + drafts, and vice versa) while blocking a signed-in user
//     who merely guessed/learned a canvas id.
//   - Presence writes are bound to the authenticated account: a write
//     whose connectionId isn't owned by the caller is rejected, so a
//     peer's connectionId can't be replayed to spoof or inject events.
//   - Display-name leakage is bounded: anyone signed into the workspace
//     and able to load the canvas already had visibility into who else
//     is in the workspace via the account/members surface, so showing
//     names of co-viewers does not expose new identity information.
//
// Single-process assumption mirrors mcp/relay.js: sticky sessions
// required if horizontally scaled. The relay already needs this.

import crypto from 'node:crypto';

// canvasId → Map(connectionId → {workspaceId, accountId, displayName, color, cursor, focus, lastSeenAt, sseRes})
const _presenceByCanvas = new Map();

// Idle sweep removes stale subscriptions where the SSE write failed but
// no 'close' handler fired (rare, but happens with some proxies). Runs
// every 60s, drops entries older than the idle threshold.
const IDLE_THRESHOLD_MS = 90 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
export const MAX_PRESENCE_FIELDS = 100;
export const MAX_PRESENCE_PAYLOAD_BYTES = 64 * 1024;

// Color palette for cursor assignment. Picked from the warm-orange
// brand alongside a few complementary hues so cursors stand out
// distinctly while staying in the visual identity. Server assigns from
// this list using the order entries appear; client trusts the assignment.
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
	// All palette exhausted - wrap around with hue rotation from accent
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
		// Write failed - connection dead. The 'close' handler on the
		// response will fire and clean up; nothing to do here.
		return false;
	}
}

// Ownership guard for presence writes. A connectionId is exposed to all
// peers via _toPeerPayload (the client needs it to attribute cursors), so
// a subscribed attacker could otherwise replay a victim's connectionId to
// spoof cursor/draft/link events attributed to them - or inject draft
// field values into peers' canvases. Bind every write to the account that
// opened the connection: reject when the caller's account doesn't own the
// entry. requestingAccountId is required; a missing value fails closed.
function _ownsConnection(entry, requestingAccountId) {
	if (!requestingAccountId) {
		return false;
	}
	return entry.accountId === requestingAccountId;
}

function _acceptSequence(entry, sequence) {
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

// Broadcast a presence event to every connection on a canvas except
// `excludeConnId`. Used for join/leave/cursor updates that the
// originating tab doesn't need echoed back.
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
		if (_writeSseEvent(entry.sseRes, 'presence', payload)) {
delivered++;
}
	}
	return delivered;
}

// Subscribe a tab to a canvas's presence channel. Returns the
// connectionId so the caller can pass it back on cursor updates and
// unsubscribe. Initial peers list is delivered on the same SSE
// connection via a 'presence-init' event, then a 'join' is broadcast
// to remaining peers.
export function subscribe({ canvasId, workspaceId, accountId, displayName, canEdit = true, sseRes }) {
	if (!canvasId || !workspaceId || !accountId || !sseRes) {
		throw new Error('subscribe: missing required field');
	}
	if (!_presenceByCanvas.has(canvasId)) {
_presenceByCanvas.set(canvasId, new Map());
}
	const conns = _presenceByCanvas.get(canvasId);
	const connectionId = crypto.randomUUID();
	const color = _pickColor(conns);
	const entry = {
		connectionId,
		workspaceId,
		accountId,
		displayName: displayName || 'Someone',
		canEdit: !!canEdit,
		color,
		cursor: null,
		focus: null,
		lastSeenAt: Date.now(),
		lastSequence: 0,
		sseRes,
	};
	// Initial sync - send the new tab the list of peers it joined
	// alongside, plus its own assigned color and connection id. Peers
	// are scoped per-canvas, NOT per-workspace: two users from
	// different workspaces who both have SF File access to the same
	// canvas are legitimately collaborating and need to see each other.
	// Workspace was previously filtered here; that broke the realistic
	// case (canvas owner in workspace W1, share-link guest in W2 →
	// they couldn't see each other's cursors).
	const peers = [];
	for (const other of conns.values()) {
		peers.push(_toPeerPayload(other));
	}
	conns.set(connectionId, entry);
	_writeSseEvent(sseRes, 'presence-init', {
		you: _toPeerPayload(entry),
		peers,
	});
	// Periodic keepalive - proxies often time out idle SSE at 30-60s.
	const keepalive = setInterval(() => {
		try {
			if (sseRes.destroyed || sseRes.writableEnded) {
				clearInterval(keepalive);
				unsubscribe({ canvasId, connectionId });
				return;
			}
			sseRes.write(': keepalive\n\n');
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
	// Notify other peers in the same workspace.
	_broadcast(canvasId, { type: 'join', peer: _toPeerPayload(entry) }, connectionId);
	return connectionId;
}

export function unsubscribe({ canvasId, connectionId }) {
	const conns = _presenceByCanvas.get(canvasId);
	if (!conns) {
return false;
}
	const entry = conns.get(connectionId);
	if (!entry) {
return false;
}
	if (entry.keepalive) {
clearInterval(entry.keepalive);
}
	conns.delete(connectionId);
	if (conns.size === 0) {
_presenceByCanvas.delete(canvasId);
}
	_broadcast(canvasId, { type: 'leave', connectionId }, connectionId);
	return true;
}

// Cursor update. Throttling is the client's responsibility - server
// just stamps + rebroadcasts. xy travels in one of two coord spaces:
//   - cytoscape world coords when `world: true` - the receiver
//     translates via its own cy.pan/zoom inverse so cursors track
//     records across pan/zoom regardless of each browser's viewport.
//   - viewport-absolute clientX/clientY when `world: false` or absent
// - used when cy is unavailable (no records loaded yet, canvas
//     still settling). The receiver translates against its current
//     #graph-bulk rect so layout shifts during load don't desync.
// Server is dumb to which it is - just preserves the flag and
// broadcasts it through.
export function updateCursor({ canvasId, connectionId, x, y, world, sequence, requestingAccountId }) {
	const conns = _presenceByCanvas.get(canvasId);
	if (!conns) {
return false;
}
	const entry = conns.get(connectionId);
	if (!entry) {
return false;
}
	if (!_ownsConnection(entry, requestingAccountId)) {
return false;
}
	if (!_acceptSequence(entry, sequence)) {
return false;
}
	const cx = typeof x === 'number' ? x : null;
	const cy = typeof y === 'number' ? y : null;
	entry.cursor = (cx == null || cy == null) ? null : { x: cx, y: cy, world: !!world };
	entry.lastSeenAt = Date.now();
	_broadcast(canvasId, {
		type: 'cursor',
		connectionId,
		cursor: entry.cursor,
	}, connectionId);
	return true;
}

// Phase 4 collab - relay a draft field-value update from one peer to
// the others. Same model as cursor / focus: nothing persisted server-
// side, values pass through process memory only during the broadcast.
// tempId scopes the update to a specific draft on the canvas; fields
// is a sparse object containing ONLY the changed keys (the sender's
// client computed the diff against its last-broadcast snapshot).
//
// Posture: this IS a new dimension of what flows through presence -
// previously identity + cursor xy + record-id refs; now also draft
// field deltas. The data is typed by the sending user into a draft
// (they consented by typing it into a collaborative canvas); it
// never lands at rest on our servers.
export function updateDraft({ canvasId, connectionId, tempId, fields, kind, objectName, x, y, position, sequence, requestingAccountId }) {
	const conns = _presenceByCanvas.get(canvasId);
	if (!conns) {
return false;
}
	const entry = conns.get(connectionId);
	if (!entry) {
return false;
}
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
	// Phase 4.5:
	//   - 'create' kind = brand-new draft; carries structural info
	//     (objectName + position) so receivers can materialize the
	//     draft locally.
	//   - 'remove' kind = draft was removed locally; receivers drop
	//     their matching draft. fields can be empty.
	//   - position payload (separate from fields) = the user moved
	//     the draft on the canvas. Carried alongside (or without)
	//     value deltas.
	if (kind === 'create') {
		payload.kind = 'create';
		if (typeof objectName === 'string') {
payload.objectName = objectName;
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
	if (position && typeof position === 'object'
		&& typeof position.x === 'number' && typeof position.y === 'number') {
		payload.position = { x: position.x, y: position.y };
	}
	_broadcast(canvasId, payload, connectionId);
	return true;
}

// Phase 5 collab - relay an association add/remove between two drafts
// on the canvas. Endpoints are identified by sync ids (either the
// persisted tempId from a saved canvas OR the _collabId minted for
// brand-new drafts), which match the same identifiers Phase 4 / 4.5
// uses for value + position sync. Server stays a dumb relay; the
// receiver resolves sync ids to local runtime ids and mutates
// bulkAssociations.
//
// Posture: identical to draft / cursor / focus / loaded-removed
// broadcasts. Payload carries object identifiers and a field name
// (FK on the source object); no record contents.
export function updateDraftLink({ canvasId, connectionId, kind, fromSyncId, toSyncId, fieldName, sequence, requestingAccountId }) {
	const conns = _presenceByCanvas.get(canvasId);
	if (!conns) {
return false;
}
	const entry = conns.get(connectionId);
	if (!entry) {
return false;
}
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
	if (!fromSyncId || !toSyncId || !fieldName) {
return false;
}
	entry.lastSeenAt = Date.now();
	_broadcast(canvasId, {
		type: 'draft-link',
		connectionId,
		kind,
		fromSyncId: String(fromSyncId),
		toSyncId: String(toSyncId),
		fieldName: String(fieldName),
	}, connectionId);
	return true;
}

// Phase 5 collab - relay a "loaded record removed from canvas" event
// so peers' views catch up the moment a teammate removes a record,
// without having to wait for a canvas save + Phase 3 auto-apply.
// This matters for the "no access" placeholder scenario: peer B can't
// read the record from SF (no permission), so the canvas shows a
// "🔒 No access" card. When peer A removes the underlying canvas
// reference, B's placeholder should disappear too - but the canvas
// File save can lag (peer A might not save for minutes). Broadcasting
// the removal immediately keeps B's view consistent.
//
// Posture: identical to draft / cursor / focus broadcasts -
// in-memory routing only, nothing persisted server-side. The payload
// carries only the SF record id (a reference, not record contents).
export function removeLoadedRecord({ canvasId, connectionId, sfId, sequence, requestingAccountId }) {
	const conns = _presenceByCanvas.get(canvasId);
	if (!conns) {
return false;
}
	const entry = conns.get(connectionId);
	if (!entry) {
return false;
}
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
	entry.lastSeenAt = Date.now();
	_broadcast(canvasId, {
		type: 'loaded-removed',
		connectionId,
		sfId: String(sfId),
	}, connectionId);
	return true;
}

// Focus update - what record / panel the user is currently looking at.
// Phase 1 doesn't surface this visually beyond a brief mention in the
// presence list; Phase 2 (intent broadcast) will use this to drive
// per-user data fetching for shared records.
export function updateFocus({ canvasId, connectionId, focus, sequence, requestingAccountId }) {
	const conns = _presenceByCanvas.get(canvasId);
	if (!conns) {
return false;
}
	const entry = conns.get(connectionId);
	if (!entry) {
return false;
}
	if (!_ownsConnection(entry, requestingAccountId)) {
return false;
}
	if (!_acceptSequence(entry, sequence)) {
return false;
}
	entry.focus = focus || null;
	entry.lastSeenAt = Date.now();
	_broadcast(canvasId, {
		type: 'focus',
		connectionId,
		focus: entry.focus,
	}, connectionId);
	return true;
}

// Phase 3 collab - broadcast a "this canvas just saved" event to all
// connected peers. Carries who saved (display name + accountId) and
// the new versionId so receivers can decide whether to reload,
// compare, or ignore. Server is the broadcast trigger - called from
// the canvas PUT route after a successful persistence. Payload
// contains no record values; just the metadata needed for the
// receiver's conflict-resolution UI.
export function broadcastCanvasSaved({ canvasId, savedByAccountId, savedByDisplayName, versionId, title }) {
	if (!canvasId) {
return 0;
}
	return _broadcast(canvasId, {
		type: 'canvas-saved',
		savedByAccountId: savedByAccountId || null,
		savedByDisplayName: savedByDisplayName || 'Someone',
		versionId: versionId || null,
		title: title || null,
		at: Date.now(),
	}, null);
}

// Optional admin/observability helper - workspace settings panel can
// call this to display "N people on canvas X" without exposing names
// or cursor positions.
export function summary({ canvasId }) {
	const conns = _presenceByCanvas.get(canvasId);
	if (!conns) {
return { count: 0 };
}
	return { count: conns.size };
}

// Immediate authorization revocation hooks used by hosted membership and
// workspace lifecycle routes. Closing the matching in-memory connections also
// broadcasts leave events, so peers stop showing a user as active without
// waiting for the idle sweep.
export function purgeAccountFromWorkspace({ workspaceId, accountId }) {
	let removed = 0;
	for (const [canvasId, conns] of _presenceByCanvas.entries()) {
		for (const entry of [...conns.values()]) {
			if (entry.workspaceId === workspaceId && entry.accountId === accountId) {
				if (unsubscribe({ canvasId, connectionId: entry.connectionId })) {
removed++;
}
			}
		}
	}
	return removed;
}

export function purgeWorkspace({ workspaceId }) {
	let removed = 0;
	for (const [canvasId, conns] of _presenceByCanvas.entries()) {
		for (const entry of [...conns.values()]) {
			if (entry.workspaceId === workspaceId) {
				if (unsubscribe({ canvasId, connectionId: entry.connectionId })) {
removed++;
}
			}
		}
	}
	return removed;
}

// Idle sweep - defensive cleanup for connections whose 'close' handler
// never fired. Drops entries with no activity in IDLE_THRESHOLD_MS.
function _sweep() {
	const now = Date.now();
	for (const [canvasId, conns] of _presenceByCanvas.entries()) {
		for (const [connectionId, entry] of conns.entries()) {
			if (now - entry.lastSeenAt > IDLE_THRESHOLD_MS) {
				conns.delete(connectionId);
				_broadcast(canvasId, { type: 'leave', connectionId }, connectionId);
			}
		}
		if (conns.size === 0) {
_presenceByCanvas.delete(canvasId);
}
	}
}

const _sweepTimer = setInterval(_sweep, SWEEP_INTERVAL_MS);
if (_sweepTimer.unref) {
_sweepTimer.unref();
}
