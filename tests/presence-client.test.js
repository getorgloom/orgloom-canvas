import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/public/js/presence.js', import.meta.url), 'utf8');

function element() {
	const listeners = new Map();
	const children = [];
	const attributes = new Map();
	const el = {
		classList: { add() {} },
		style: {
			setProperty(name, value) {
				this[name] = value;
			},
			removeProperty(name) {
				delete this[name];
			},
		},
		innerHTML: '',
		parentNode: null,
		appendChild(child) {
			child.parentNode = el;
			children.push(child);
			return child;
		},
		setAttribute(name, value) {
			attributes.set(name, String(value));
		},
		removeAttribute() {},
		remove() {
			if (!el.parentNode || !Array.isArray(el.parentNode._children)) return;
			const index = el.parentNode._children.indexOf(el);
			if (index >= 0) el.parentNode._children.splice(index, 1);
			el.parentNode = null;
		},
		querySelector(selector) {
			const match = /^\[data-conn="([^"]+)"\]$/.exec(selector);
			if (match) return children.find((child) => child._attributes.get('data-conn') === match[1]) || null;
			return null;
		},
		querySelectorAll() {
			return [];
		},
		addEventListener(event, handler) {
			listeners.set(event, handler);
		},
		removeEventListener(event, handler) {
			if (listeners.get(event) === handler) listeners.delete(event);
		},
		dispatch(event, payload = {}) {
			listeners.get(event)?.(payload);
		},
		getBoundingClientRect() {
			return { left: 0, top: 0, right: 800, bottom: 600 };
		},
		_children: children,
		_attributes: attributes,
	};
	return el;
}

function mountPresence({
	hostInitially = true,
	records = [],
	associations = [],
	snapshotPayload = {},
	snapshotApplyGate = null,
	fetchHandler = null,
	deferTimeouts = false,
	eventSourceOnCreate = null,
} = {}) {
	const requests = [];
	const accessChanges = [];
	const slotUpdates = [];
	const fieldLockChanges = [];
	const autoPanSuppressions = [];
	const appliedSnapshots = [];
	const toasts = [];
	let reloads = 0;
	let host = hostInitially ? element() : null;
	const graph = { querySelector: () => host };
	const cards = new Map(records.map((record) => [String(record.id), element()]));
	const document = {
		body: element(),
		createElement: element,
		getElementById: () => element(),
		querySelector: (selector) => {
			const match = /^\[data-rec-id="([^"]+)"\]$/.exec(selector);
			return match ? cards.get(match[1]) || null : null;
		},
		querySelectorAll: () => [],
	};
	const sources = [];
	const intervals = [];
	const timeouts = [];
	class EventSource {
		constructor(url) {
			this.url = url;
			this.readyState = 1;
			this.listeners = new Map();
			sources.push(this);
			if (eventSourceOnCreate) {
				Promise.resolve().then(() => eventSourceOnCreate(this, sources.length - 1));
			}
		}
		addEventListener(event, handler) {
			this.listeners.set(event, handler);
		}
		emit(event, data) {
			this.listeners.get(event)?.({ data: JSON.stringify(data) });
		}
		close() {
			this.readyState = 2;
		}
	}
	let now = 1_000;
	const window = {
		OrgLoom: {},
		Orgloom: {},
		addEventListener() {},
		crypto: {
			randomUUID: () => '11111111-1111-4111-8111-111111111111',
			subtle: webcrypto.subtle,
		},
	};
	vm.runInNewContext(source, {
		window,
		document,
		EventSource,
		AbortController,
		Date: { now: () => now },
		Math,
		Map,
		Set,
		Promise,
		JSON,
		Number,
		String,
		TextEncoder,
		Uint8Array,
		encodeURIComponent,
		setInterval: (callback) => {
			intervals.push(callback);
			return intervals.length;
		},
		setTimeout: (callback) => {
			if (deferTimeouts) {
				timeouts.push(callback);
				return timeouts.length;
			}
			callback();
			return 1;
		},
		clearInterval() {},
	});
	const canvasState = {
		bulkRecords: records,
		bulkAssociations: associations,
		bulkIdSeq: records.length + 1,
		selectedObjects: [],
		currentCanvas: null,
	};
	const api = window.OrgLoom.presence.mount({
		canvasState,
		csrfFetch: async (url, options) => {
			const request = { url, body: options && options.body ? JSON.parse(options.body) : null };
			requests.push(request);
			if (fetchHandler) return fetchHandler(request);
			return { ok: true };
		},
		escapeHtml: (value) => String(value),
		getGraph: () => graph,
		getCyInstance: () => null,
		isCanvasDirty: () => false,
		reloadCanvasFromServer: async () => {
			reloads += 1;
			return true;
		},
		showBulkToast(message, type) {
			toasts.push({ message, type });
		},
		renderBulkView() {},
		setSkipNextCyAutoPan(value) {
			autoPanSuppressions.push(!!value);
		},
		addToSelection(objectName) {
			const entry = { id: canvasState.selectedObjects.length + 1, name: objectName, label: objectName };
			canvasState.selectedObjects.push(entry);
			return entry;
		},
		buildCanvasPayload: () => structuredClone(snapshotPayload),
		async applyLiveSnapshot(payload, detail) {
			appliedSnapshots.push({ payload: structuredClone(payload), detail: structuredClone(detail) });
			if (snapshotApplyGate) {
				await snapshotApplyGate;
			}
		},
		onAccessChanged(detail) {
			accessChanges.push(detail);
		},
		onSlotUpdated(record, slot) {
			slotUpdates.push({ record, slot });
		},
		onFieldLocksChanged(reference, fieldName, lock) {
			fieldLockChanges.push({ reference, fieldName, lock });
		},
	});
	return {
		api,
		cards,
		canvasState,
		requests,
		toasts,
		accessChanges,
		slotUpdates,
		fieldLockChanges,
		autoPanSuppressions,
		appliedSnapshots,
		body: document.body,
		sources,
		reloadCount: () => reloads,
		move(x = 20, y = 30) {
			now += 101;
			host?.dispatch('mousemove', { clientX: x, clientY: y });
		},
		leaveCanvas() {
			host?.dispatch('mouseleave');
		},
		cursorConnections() {
			const layer = host?._children.find((child) => child.className === 'presence-cursor-layer');
			return (layer?._children || []).map((child) => child._attributes.get('data-conn'));
		},
		showHost() {
			host = element();
			return host;
		},
		replaceHost() {
			const previous = host;
			host = element();
			return previous;
		},
		tick() {
			intervals.forEach((callback) => callback());
		},
		advance(milliseconds) {
			now += milliseconds;
		},
	};
}

describe('presence client request gating', () => {
	test('makes access increases optional and access decreases blocking', () => {
		const increased = mountPresence();
		increased.api.subscribeToCanvas('069000000000001AAA');
		increased.sources[0].emit('presence-init', {
			you: { connectionId: 'mine', role: 'viewer', canEdit: false },
			peers: [],
		});
		increased.sources[0].emit('presence', {
			type: 'access-changed',
			previousRole: 'viewer',
			role: 'editor',
			change: 'increased',
			revoked: false,
		});
		assert.equal(increased.accessChanges.length, 1);
		assert.match(increased.body._children.at(-1).innerHTML, /Reload to use your new permissions/);
		assert.match(increased.body._children.at(-1).innerHTML, />Later</);

		const decreased = mountPresence();
		decreased.api.subscribeToCanvas('069000000000002AAA');
		decreased.sources[0].emit('presence-init', {
			you: { connectionId: 'mine', role: 'editor', canEdit: true },
			peers: [],
		});
		decreased.sources[0].emit('presence', {
			type: 'access-changed',
			previousRole: 'editor',
			role: 'viewer',
			change: 'decreased',
			revoked: false,
		});
		assert.equal(decreased.accessChanges[0].role, 'viewer');
		const modal = decreased.body._children.at(-1);
		assert.match(modal.className, /presence-access-modal/);
		assert.match(modal.innerHTML, /Editing has stopped/);
		assert.match(modal.innerHTML, /class="button"[^>]*>Reload canvas/);
		assert.doesNotMatch(modal.innerHTML, /Later|Keep editing/);
	});

	test('revocation blocks the open connection and directs the recipient out of the canvas', () => {
		const harness = mountPresence();
		harness.api.subscribeToCanvas('069000000000003AAA');
		harness.sources[0].emit('presence-init', {
			you: { connectionId: 'mine', role: 'editor', canEdit: true },
			peers: [],
		});
		harness.sources[0].emit('presence', {
			type: 'access-changed',
			previousRole: 'editor',
			role: null,
			change: 'revoked',
			revoked: true,
		});
		assert.equal(harness.accessChanges[0].revoked, true);
		assert.match(harness.body._children.at(-1).innerHTML, /Canvas access removed/);
		assert.match(harness.body._children.at(-1).innerHTML, /Return to workspace/);
	});

	test('sends cursor and focus only while another viewer is present', () => {
		const harness = mountPresence();
		harness.api.subscribeToCanvas('draft-11111111-1111-4111-8111-111111111111');
		const source = harness.sources[0];
		source.emit('presence-init', { you: { connectionId: 'mine' }, peers: [] });

		harness.api.pushFocus({ kind: 'record', ref: '001000000000001' });
		harness.move();
		harness.leaveCanvas();
		assert.equal(harness.requests.length, 0);

		source.emit('presence', {
			type: 'join',
			peer: { connectionId: 'peer', displayName: 'Peer', color: '#fff', cursor: null, focus: null },
		});
		assert.equal(harness.requests.filter((request) => request.url.endsWith('/presence/focus')).length, 1);

		harness.move();
		assert.equal(harness.requests.filter((request) => request.url.endsWith('/presence/cursor')).length, 1);

		source.emit('presence', { type: 'leave', connectionId: 'peer' });
		const cursorRequests = harness.requests.filter((request) => request.url.endsWith('/presence/cursor'));
		assert.equal(cursorRequests.length, 2);
		assert.equal(cursorRequests[1].body.x, null);

		harness.move();
		harness.api.pushFocus({ kind: 'record', ref: '001000000000002' });
		assert.equal(harness.requests.filter((request) => request.url.endsWith('/presence/cursor')).length, 2);
		assert.equal(harness.requests.filter((request) => request.url.endsWith('/presence/focus')).length, 1);
	});

	test('replaces stale cursor elements when the presence stream reconnects', () => {
		const harness = mountPresence();
		harness.api.subscribeToCanvas('draft-11111111-1111-4111-8111-111111111112');
		const source = harness.sources[0];
		source.emit('presence-init', {
			you: { connectionId: 'mine-1' },
			peers: [
				{
					connectionId: 'peer-old',
					displayName: 'Peer',
					color: '#fff',
					cursor: { x: 20, y: 30 },
					focus: null,
				},
			],
		});
		assert.deepEqual(harness.cursorConnections(), ['peer-old']);

		source.emit('presence-init', {
			you: { connectionId: 'mine-2' },
			peers: [
				{
					connectionId: 'peer-new',
					displayName: 'Peer',
					color: '#fff',
					cursor: { x: 40, y: 50 },
					focus: null,
				},
			],
		});
		assert.deepEqual(harness.cursorConnections(), ['peer-new']);
	});

	test('binds cursor tracking after the canvas DOM renders late and after host replacement', () => {
		const harness = mountPresence({ hostInitially: false });
		harness.api.subscribeToCanvas('draft-22222222-2222-4222-8222-222222222222');
		const source = harness.sources[0];
		source.emit('presence-init', {
			you: { connectionId: 'mine' },
			peers: [{ connectionId: 'peer', displayName: 'Peer', color: '#fff', cursor: null, focus: null }],
		});

		harness.showHost();
		harness.tick();
		harness.move();
		assert.equal(harness.requests.filter((request) => request.url.endsWith('/presence/cursor')).length, 1);

		const oldHost = harness.replaceHost();
		harness.tick();
		oldHost.dispatch('mousemove', { clientX: 40, clientY: 50 });
		assert.equal(harness.requests.filter((request) => request.url.endsWith('/presence/cursor')).length, 1);
		harness.move(40, 50);
		assert.equal(harness.requests.filter((request) => request.url.endsWith('/presence/cursor')).length, 2);
	});

	test('renders record focus for loaded records, drafts, and record requests', () => {
		const records = [
			{ id: 1, loadedFromId: '001000000000001' },
			{ id: 2, _persistedTempId: 'draft-2' },
			{ id: 3, slot: { slotId: 'slot-3' } },
		];
		const harness = mountPresence({ records });
		harness.api.subscribeToCanvas('draft-33333333-3333-4333-8333-333333333333');
		const source = harness.sources[0];
		source.emit('presence-init', {
			you: { connectionId: 'mine' },
			peers: [{ connectionId: 'peer', displayName: 'Peer', color: '#fff', cursor: null, focus: null }],
		});

		for (const focus of [
			{ kind: 'record', refKind: 'loaded', ref: '001000000000001' },
			{ kind: 'record', refKind: 'draft', ref: 'draft-2' },
			{ kind: 'record', refKind: 'slot', ref: 'slot-3' },
		]) {
			source.emit('presence', { type: 'focus', connectionId: 'peer', focus });
		}

		for (const card of harness.cards.values()) {
			assert.equal(card._attributes.get('data-presence-focus-by'), 'peer');
			assert.equal(card._children.at(-1).textContent, 'Peer viewing');
		}

		source.emit('presence', {
			type: 'record-layout',
			connectionId: 'peer',
			positions: [
				{ refKind: 'loaded', ref: '001000000000001', x: 100, y: 110 },
				{ refKind: 'draft', ref: 'draft-2', x: 200, y: 210 },
				{ refKind: 'slot', ref: 'slot-3', x: 300, y: 310 },
			],
		});
		assert.deepEqual(
			harness.canvasState.bulkRecords.map(({ x, y }) => ({ x, y })),
			[
				{ x: 100, y: 110 },
				{ x: 200, y: 210 },
				{ x: 300, y: 310 },
			],
		);

		harness.api.publishLayout(harness.canvasState.bulkRecords);
		const layoutRequest = harness.requests.find((request) => request.url.endsWith('/presence/layout'));
		assert.ok(layoutRequest);
		assert.deepEqual(
			layoutRequest.body.positions.map(({ refKind, ref }) => ({ refKind, ref })),
			[
				{ refKind: 'loaded', ref: '001000000000001' },
				{ refKind: 'draft', ref: 'draft-2' },
				{ refKind: 'slot', ref: 'slot-3' },
			],
		);
	});

	test('distinguishes the actively focused field from other fields retained by the same editor', () => {
		const record = {
			id: 1,
			loadedFromId: '001000000000001',
			_canvasRecordId: 'canvas-record-1',
		};
		const harness = mountPresence({ records: [record] });
		harness.api.subscribeToCanvas('draft-33333333-3333-4333-8333-333333333334');
		const source = harness.sources[0];
		source.emit('presence-init', {
			you: { connectionId: 'mine' },
			peers: [{ connectionId: 'peer', displayName: 'Peer', color: '#fff', cursor: null, focus: null }],
		});
		const targetRef = {
			refKind: 'loaded',
			ref: record.loadedFromId,
			collabRef: record._canvasRecordId,
		};
		for (const fieldName of ['Name', 'Phone']) {
			source.emit('presence', {
				type: 'field-lock',
				lock: {
					connectionId: 'peer',
					displayName: 'Peer',
					targetRef,
					fieldName,
					expiresAt: 10_000,
				},
			});
		}

		source.emit('presence', {
			type: 'focus',
			connectionId: 'peer',
			focus: { kind: 'record', ...targetRef, fieldName: 'Name' },
		});
		assert.equal(harness.api.fieldLockFor(record, 'Name').active, true);
		assert.equal(harness.api.fieldLockFor(record, 'Phone').active, false);

		source.emit('presence', {
			type: 'focus',
			connectionId: 'peer',
			focus: { kind: 'record', ...targetRef, fieldName: 'Phone' },
		});
		assert.equal(harness.api.fieldLockFor(record, 'Name').active, false);
		assert.equal(harness.api.fieldLockFor(record, 'Phone').active, true);
		assert.ok(harness.fieldLockChanges.length >= 4);
	});

	test('releases one owned field without dropping other unsaved field locks', async () => {
		const record = {
			id: 1,
			loadedFromId: '001000000000001',
			_canvasRecordId: 'canvas-record-1',
		};
		let leaseSequence = 0;
		const harness = mountPresence({
			records: [record],
			fetchHandler(request) {
				if (request.url.endsWith('/presence/field-lock')) {
					leaseSequence += 1;
					return {
						ok: true,
						json: async () => ({
							ok: true,
							lock: {
								connectionId: 'mine',
								targetRef: request.body.targetRef,
								fieldName: request.body.fieldName,
								leaseId: 'lease-' + leaseSequence,
								baseVersion: 0,
								expiresAt: 10_000,
							},
						}),
					};
				}
				return { ok: true, json: async () => ({ ok: true }) };
			},
		});
		harness.api.subscribeToCanvas('draft-33333333-3333-4333-8333-333333333335');
		harness.sources[0].emit('presence-init', {
			you: { connectionId: 'mine', role: 'contributor', canEdit: false },
			peers: [],
		});

		await harness.api.acquireFieldLock(record, 'Name');
		await harness.api.acquireFieldLock(record, 'Phone');
		assert.equal(harness.api.releaseFieldLock(record, 'Name'), true);

		assert.equal(harness.api.fieldLockFor(record, 'Name'), null);
		assert.equal(harness.api.fieldLockFor(record, 'Phone').owned, true);
		const release = harness.requests.find((request) => request.url.endsWith('/presence/field-lock/release'));
		assert.equal(release.body.leaseId, 'lease-1');
	});

	test('waits for a fresh presence identity and retries a lock rejected during reconnect', async () => {
		const record = {
			id: 1,
			loadedFromId: '001000000000009',
			_canvasRecordId: 'canvas-record-9',
		};
		let lockAttempts = 0;
		const harness = mountPresence({
			records: [record],
			deferTimeouts: true,
			eventSourceOnCreate(source, index) {
				if (index === 1) {
					source.emit('presence-init', {
						you: { connectionId: 'fresh', role: 'contributor', canEdit: false },
						peers: [],
					});
				}
			},
			fetchHandler(request) {
				if (!request.url.endsWith('/presence/field-lock')) {
					return { ok: true, json: async () => ({ ok: true }) };
				}
				lockAttempts += 1;
				if (lockAttempts === 1) {
					return {
						ok: false,
						json: async () => ({
							error: 'presence-connection-stale',
							message: 'The previous presence connection is no longer active.',
						}),
					};
				}
				return {
					ok: true,
					json: async () => ({
						ok: true,
						lock: {
							connectionId: 'fresh',
							targetRef: {
								refKind: 'loaded',
								ref: record.loadedFromId,
								collabRef: record._canvasRecordId,
							},
							fieldName: 'Name',
							expiresAt: 10_000,
						},
					}),
				};
			},
		});
		harness.api.subscribeToCanvas('draft-33333333-3333-4333-8333-333333333339');
		harness.sources[0].emit('presence-init', {
			you: { connectionId: 'stale', role: 'contributor', canEdit: false },
			peers: [],
		});

		const result = await harness.api.acquireFieldLock(record, 'Name');

		assert.equal(result.ok, true);
		assert.equal(lockAttempts, 2);
		assert.equal(harness.sources.length, 2);
		assert.equal(
			harness.requests.filter((request) => request.url.endsWith('/presence/field-lock'))[1].body.connectionId,
			'fresh',
		);
	});

	test('publishes card positions while alone so late joiners receive the current layout', () => {
		const records = [
			{
				id: 1,
				loadedFromId: '001000000000001',
				_canvasRecordId: 'account-card-1',
				x: 125,
				y: 275,
			},
		];
		const harness = mountPresence({ records });
		harness.api.subscribeToCanvas('draft-35353535-3535-4535-8535-353535353535');
		harness.sources[0].emit('presence-init', {
			you: { connectionId: 'owner', role: 'owner', canEdit: true },
			peers: [],
		});

		harness.api.publishLayout(records);

		const layoutRequest = harness.requests.find((request) => request.url.endsWith('/presence/layout'));
		assert.ok(layoutRequest);
		assert.deepEqual(layoutRequest.body.positions, [
			{
				refKind: 'loaded',
				ref: '001000000000001',
				collabRef: 'account-card-1',
				x: 125,
				y: 275,
			},
		]);
	});

	test('publishes permission-hidden card positions by their opaque placeholder id', () => {
		const records = [
			{
				id: -1,
				_permissionHidden: true,
				_inaccessible: true,
				_permissionHiddenId: 'hidden-card-1234567890abcdef12345678',
				x: 425,
				y: 575,
			},
		];
		const harness = mountPresence({ records });
		harness.api.subscribeToCanvas('draft-36363636-3636-4636-8636-363636363636');
		harness.sources[0].emit('presence-init', {
			you: { connectionId: 'restricted-editor', role: 'editor', canEdit: true },
			peers: [],
		});

		harness.api.publishLayout(records);

		const layoutRequest = harness.requests.find((request) => request.url.endsWith('/presence/layout'));
		assert.ok(layoutRequest);
		assert.deepEqual(layoutRequest.body.positions, [
			{
				hiddenId: 'hidden-card-1234567890abcdef12345678',
				x: 425,
				y: 575,
			},
		]);
	});

	test('retries unsynchronized records, fields, links, and requests after acknowledgement failures', async () => {
		const attemptsByPath = new Map();
		const records = [
			{
				id: 1,
				objectName: 'Contact',
				loadedFromId: '003000000000001',
				_canvasRecordId: 'contact-card',
				loadedValues: { LastName: 'Before' },
				values: { LastName: 'Before' },
			},
			{
				id: 2,
				objectName: 'Account',
				loadedFromId: '001000000000001',
				_canvasRecordId: 'account-card',
				loadedValues: { Name: 'Account' },
				values: { Name: 'Account' },
			},
		];
		const harness = mountPresence({
			records,
			fetchHandler(request) {
				const path = request.url.split('/presence/')[1] || request.url;
				const attempts = (attemptsByPath.get(path) || 0) + 1;
				attemptsByPath.set(path, attempts);
				return { ok: attempts > 1 };
			},
		});
		harness.api.subscribeToCanvas('draft-37373737-3737-4737-8737-373737373737');
		harness.sources[0].emit('presence-init', {
			you: { connectionId: 'owner', role: 'owner', canEdit: true },
			peers: [],
		});

		records[0].values.LastName = 'After';
		records[0].slot = {
			slotId: 7,
			kind: 'fields',
			label: 'Complete contact',
			fields: ['LastName'],
		};
		records.push({
			id: 3,
			objectName: 'Opportunity',
			values: { Name: 'New opportunity' },
			x: 300,
			y: 400,
		});
		harness.canvasState.bulkAssociations.push({
			id: 4,
			fromId: 1,
			toId: 2,
			fieldName: 'AccountId',
		});

		harness.tick();
		await new Promise((resolve) => setImmediate(resolve));
		harness.advance(1000);
		harness.tick();
		await new Promise((resolve) => setImmediate(resolve));

		for (const path of ['loaded-record', 'draft', 'slot', 'draft-link']) {
			assert.ok(
				harness.requests.filter((request) => request.url.endsWith('/presence/' + path)).length >= 2,
				path + ' should retry after the rejected acknowledgement',
			);
		}
		const draftCreates = harness.requests.filter((request) => request.url.endsWith('/presence/draft'));
		assert.ok(draftCreates.every((request) => request.body.kind === 'create'));
		assert.equal(new Set(draftCreates.map((request) => request.body.tempId)).size, 1);
		assert.ok(
			harness.toasts.some((toast) => toast.type === 'error' && /temporarily disconnected/.test(toast.message)),
		);
		assert.ok(harness.toasts.some((toast) => toast.type === 'info' && /reconnected/.test(toast.message)));

		const settledRequestCount = harness.requests.length;
		harness.advance(2000);
		harness.tick();
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(harness.requests.length, settledRequestCount);
	});

	test('keeps newer field edits pending while an earlier value awaits acknowledgement', async () => {
		let resolveFirst;
		let loadedAttempts = 0;
		const firstResponse = new Promise((resolve) => {
			resolveFirst = resolve;
		});
		const record = {
			id: 1,
			objectName: 'Account',
			loadedFromId: '001000000000001',
			_canvasRecordId: 'account-card',
			loadedValues: { Name: 'Before' },
			values: { Name: 'Before' },
		};
		const harness = mountPresence({
			records: [record],
			fetchHandler(request) {
				if (!request.url.endsWith('/presence/loaded-record')) return { ok: true };
				loadedAttempts += 1;
				return loadedAttempts === 1 ? firstResponse : { ok: true };
			},
		});
		harness.api.subscribeToCanvas('draft-38383838-3838-4838-8838-383838383838');
		harness.sources[0].emit('presence-init', {
			you: { connectionId: 'owner', role: 'owner', canEdit: true },
			peers: [],
		});

		record.values.Name = 'First edit';
		harness.tick();
		record.values.Name = 'Newer edit';
		harness.tick();
		assert.equal(harness.requests.filter((request) => request.url.endsWith('/presence/loaded-record')).length, 1);

		resolveFirst({ ok: true });
		await new Promise((resolve) => setImmediate(resolve));
		harness.advance(2000);
		harness.tick();
		await new Promise((resolve) => setImmediate(resolve));

		const updates = harness.requests.filter((request) => request.url.endsWith('/presence/loaded-record'));
		assert.equal(updates.length, 2);
		assert.deepEqual(updates[0].body.fields, { Name: 'First edit' });
		assert.deepEqual(updates[1].body.fields, { Name: 'Newer edit' });
	});

	test('queues the latest card position until presence connects and retries failed layout acknowledgement', async () => {
		let layoutAttempts = 0;
		const record = {
			id: 1,
			loadedFromId: '001000000000001',
			_canvasRecordId: 'account-card',
			x: 100,
			y: 200,
		};
		const harness = mountPresence({
			records: [record],
			fetchHandler(request) {
				if (!request.url.endsWith('/presence/layout')) return { ok: true };
				layoutAttempts += 1;
				return { ok: layoutAttempts > 1 };
			},
		});
		harness.api.subscribeToCanvas('draft-39393939-3939-4939-8939-393939393939');
		harness.api.publishLayout([record]);
		assert.equal(harness.requests.filter((request) => request.url.endsWith('/presence/layout')).length, 0);

		harness.sources[0].emit('presence-init', {
			you: { connectionId: 'owner', role: 'owner', canEdit: true },
			peers: [],
		});
		await new Promise((resolve) => setImmediate(resolve));

		record.x = 500;
		record.y = 600;
		harness.api.publishLayout([record]);
		harness.advance(1000);
		harness.tick();
		await new Promise((resolve) => setImmediate(resolve));

		const layouts = harness.requests.filter((request) => request.url.endsWith('/presence/layout'));
		assert.equal(layouts.length, 2);
		assert.deepEqual(
			layouts.map((request) => request.body.positions[0]).map(({ x, y }) => ({ x, y })),
			[
				{ x: 100, y: 200 },
				{ x: 500, y: 600 },
			],
		);

		harness.advance(2000);
		harness.tick();
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(harness.requests.filter((request) => request.url.endsWith('/presence/layout')).length, 2);
	});

	test('uses stable canvas-card identity when duplicate Salesforce records move', () => {
		const records = [
			{
				id: 1,
				loadedFromId: '001000000000001',
				_canvasRecordId: 'account-card-1',
				x: 10,
				y: 20,
			},
			{
				id: 3,
				loadedFromId: '001000000000001',
				_canvasRecordId: 'account-card-3',
				x: 30,
				y: 40,
			},
		];
		const harness = mountPresence({ records });
		harness.api.subscribeToCanvas('draft-34343434-3434-4434-8434-343434343434');
		const source = harness.sources[0];
		source.emit('presence-init', {
			you: { connectionId: 'viewer', role: 'viewer', canEdit: false },
			peers: [],
		});

		source.emit('presence', {
			type: 'record-layout',
			connectionId: 'owner',
			positions: [
				{
					refKind: 'loaded',
					ref: '001000000000001',
					collabRef: 'unknown-card',
					x: 500,
					y: 600,
				},
				{
					refKind: 'loaded',
					ref: '001000000000001',
					collabRef: 'account-card-3',
					x: 300,
					y: 400,
				},
			],
		});

		assert.deepEqual(
			harness.canvasState.bulkRecords.map(({ id, x, y }) => ({ id, x, y })),
			[
				{ id: 1, x: 10, y: 20 },
				{ id: 3, x: 300, y: 400 },
			],
		);
	});

	test('uses stable canvas-card identity for duplicate loaded-record updates and removal', () => {
		const records = [
			{
				id: 1,
				loadedFromId: '001000000000001',
				_canvasRecordId: 'account-card-1',
				values: { Name: 'First' },
			},
			{
				id: 3,
				loadedFromId: '001000000000001',
				_canvasRecordId: 'account-card-3',
				values: { Name: 'Third' },
			},
		];
		const harness = mountPresence({ records });
		harness.api.subscribeToCanvas('draft-36363636-3636-4636-8636-363636363636');
		const source = harness.sources[0];
		source.emit('presence-init', {
			you: { connectionId: 'viewer', role: 'viewer', canEdit: false },
			peers: [],
		});

		source.emit('presence', {
			type: 'loaded-record',
			kind: 'update',
			sfId: '001000000000001',
			collabRef: 'account-card-3',
			fields: { Name: 'Only third changed' },
		});
		assert.deepEqual(
			harness.canvasState.bulkRecords.map((record) => record.values.Name),
			['First', 'Only third changed'],
		);

		source.emit('presence', {
			type: 'loaded-removed',
			sfId: '001000000000001',
			collabRef: 'account-card-1',
		});
		assert.deepEqual(
			Array.from(harness.canvasState.bulkRecords, (record) => record._canvasRecordId),
			['account-card-3'],
		);
	});

	test('joining peers do not trigger an ad hoc browser snapshot upload', async () => {
		const records = [
			{
				id: 1,
				loadedFromId: '001000000000001',
				_canvasRecordId: 'account-card-1',
				x: 125,
				y: 225,
			},
		];
		const snapshotPayload = {
			schema: { objects: [{ name: 'Account', label: 'Account' }] },
			loadedRecords: [
				{
					loadedFromId: '001000000000001',
					canvasRecordId: 'account-card-1',
					objectName: 'Account',
					x: 125,
					y: 225,
				},
			],
			drafts: [],
			associations: [],
		};
		const harness = mountPresence({ records, snapshotPayload });
		harness.api.subscribeToCanvas('draft-35353535-3535-4535-8535-353535353535');
		const source = harness.sources[0];
		source.emit('presence-init', {
			you: { connectionId: 'owner', role: 'owner', canEdit: true },
			peers: [],
		});
		assert.equal(harness.requests.filter((request) => request.url.endsWith('/presence/layout')).length, 0);

		source.emit('presence', {
			type: 'join',
			peer: { connectionId: 'viewer', displayName: 'Viewer', color: '#fff' },
		});

		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(
			harness.requests.some((request) => request.url.endsWith('/presence/snapshot')),
			false,
		);
	});

	test('applies a live snapshot before later revisioned mutations', async () => {
		let releaseSnapshot;
		const snapshotApplied = new Promise((resolve) => {
			releaseSnapshot = resolve;
		});
		const harness = mountPresence({ snapshotApplyGate: snapshotApplied });
		harness.api.subscribeToCanvas('draft-34343434-3434-4434-8434-343434343434');
		const source = harness.sources[0];
		source.emit('presence-init', {
			you: { connectionId: 'viewer', role: 'viewer', canEdit: false },
			peers: [],
			revision: 4,
			durableRevision: 2,
			hasLiveSnapshot: true,
		});

		source.emit('presence', {
			type: 'live-snapshot',
			revision: 4,
			durableRevision: 2,
			payload: {
				schema: { objects: [] },
				loadedRecords: [],
				drafts: [],
				associations: [],
			},
		});
		source.emit('presence', {
			type: 'draft-update',
			kind: 'create',
			revision: 5,
			tempId: 'late-draft',
			canvasRecordId: 'late-card',
			objectName: 'Account',
			fields: { Name: 'After snapshot' },
		});
		releaseSnapshot();
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(harness.appliedSnapshots.length, 1);
		assert.equal(harness.canvasState.bulkRecords[0]._canvasRecordId, 'late-card');
		assert.equal(harness.canvasState.bulkRecords[0].values.Name, 'After snapshot');
	});

	test('restores the open owner canvas after the collaboration server restarts', async () => {
		const localRecord = {
			id: 1,
			objectName: 'Account',
			loadedFromId: '001000000000001AAA',
			_canvasRecordId: 'account-card',
			x: 640,
			y: 420,
			loadedValues: { Name: 'Last saved name' },
			values: { Name: 'Unsaved owner edit' },
		};
		const localPayload = {
			schema: { objects: [{ name: 'Account', label: 'Account' }] },
			loadedRecords: [
				{
					loadedFromId: localRecord.loadedFromId,
					canvasRecordId: localRecord._canvasRecordId,
					objectName: localRecord.objectName,
					x: localRecord.x,
					y: localRecord.y,
					changes: { Name: localRecord.values.Name },
				},
			],
			drafts: [],
			associations: [],
		};
		const harness = mountPresence({ records: [localRecord], snapshotPayload: localPayload });
		harness.api.subscribeToCanvas('069000000000198AAA');
		const source = harness.sources[0];
		source.emit('presence-init', {
			serverInstanceId: 'server-before-restart',
			you: { connectionId: 'owner-before-restart', role: 'owner', canEdit: true },
			peers: [],
			revision: 3,
			durableRevision: 1,
		});
		source.emit('presence-init', {
			serverInstanceId: 'server-after-restart',
			you: { connectionId: 'owner-after-restart', role: 'owner', canEdit: true },
			peers: [],
			revision: 1,
			durableRevision: 1,
			hasLiveSnapshot: true,
		});
		source.emit('presence', {
			type: 'live-snapshot',
			revision: 1,
			durableRevision: 1,
			payload: {
				schema: localPayload.schema,
				loadedRecords: [
					{
						loadedFromId: localRecord.loadedFromId,
						canvasRecordId: localRecord._canvasRecordId,
						objectName: localRecord.objectName,
						x: 100,
						y: 100,
					},
				],
				drafts: [],
				associations: [],
			},
		});

		await new Promise((resolve) => setImmediate(resolve));

		assert.deepEqual(harness.appliedSnapshots.at(-1).payload, localPayload);
		const restored = harness.requests.find(
			(request) => request.url.endsWith('/presence/loaded-record') && request.body.kind === 'create',
		);
		assert.ok(restored);
		assert.deepEqual(restored.body.fields, { Name: 'Unsaved owner edit' });
		assert.deepEqual(restored.body.baseline, { Name: 'Last saved name' });
		assert.equal(restored.body.x, 640);
		assert.equal(restored.body.y, 420);
	});

	test('replaces stale Salesforce values when a loaded record enters the live canvas', async () => {
		const harness = mountPresence({
			records: [
				{
					id: 1,
					objectName: 'Case',
					loadedFromId: '500000000000197AAA',
					_canvasRecordId: 'case-card',
					values: { CaseNumber: '00001027', AccountId: '001000000000197AAA' },
					loadedValues: { CaseNumber: '00001027', AccountId: '001000000000197AAA' },
				},
			],
		});
		harness.api.subscribeToCanvas('069000000000197AAA');
		const source = harness.sources[0];
		source.emit('presence-init', {
			you: { connectionId: 'viewer', role: 'viewer', canEdit: false },
			peers: [],
			revision: 1,
			durableRevision: 1,
		});
		source.emit('presence', {
			type: 'loaded-record',
			kind: 'create',
			revision: 2,
			sfId: '500000000000197AAA',
			collabRef: 'case-card',
			objectName: 'Case',
			fields: { CaseNumber: '00001027' },
			baseline: { CaseNumber: '00001027', AccountId: '001000000000197AAA' },
		});
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(harness.canvasState.bulkRecords[0].values.CaseNumber, '00001027');
		assert.equal('AccountId' in harness.canvasState.bulkRecords[0].values, false);
		assert.equal(harness.canvasState.bulkRecords[0].loadedValues.CaseNumber, '00001027');
		assert.equal(harness.canvasState.bulkRecords[0].loadedValues.AccountId, '001000000000197AAA');
	});

	test('adds only the newly projected hidden record without rebuilding prior placeholders', () => {
		const harness = mountPresence({
			records: [
				{
					id: -1,
					objectName: null,
					label: 'Hidden Salesforce content',
					x: 10,
					y: 20,
					values: {},
					_inaccessible: true,
					_permissionHidden: true,
					_permissionHiddenId: 'hidden-saved-1',
				},
			],
		});
		harness.api.subscribeToCanvas('069000000000099AAA');
		const source = harness.sources[0];
		source.emit('presence-init', {
			you: { connectionId: 'viewer', role: 'viewer', canEdit: false },
			peers: [],
			revision: 1,
			durableRevision: 1,
		});

		for (let index = 2; index <= 4; index++) {
			source.emit('presence', {
				type: 'hidden-record',
				kind: 'create',
				hiddenId: 'hidden-live-' + index,
				x: index * 100,
				y: index * 120,
				revision: index,
			});
			assert.equal(harness.canvasState.bulkRecords.length, index);
		}
		assert.deepEqual(
			harness.canvasState.bulkRecords.map((record) => record._permissionHiddenId),
			['hidden-saved-1', 'hidden-live-2', 'hidden-live-3', 'hidden-live-4'],
		);
		assert.deepEqual(harness.autoPanSuppressions, [true, true, true]);

		source.emit('presence', {
			type: 'hidden-record',
			kind: 'create',
			hiddenId: 'hidden-live-4',
			x: 999,
			y: 888,
			revision: 5,
		});
		assert.equal(harness.canvasState.bulkRecords.length, 4);
		assert.equal(harness.canvasState.bulkRecords.at(-1).x, 999);

		source.emit('presence', {
			type: 'record-layout',
			positions: [{ hiddenId: 'hidden-live-4', x: 444, y: 555 }],
			revision: 6,
		});
		assert.equal(harness.canvasState.bulkRecords.at(-1).x, 444);
		assert.equal(harness.canvasState.bulkRecords.at(-1).y, 555);

		source.emit('presence', {
			type: 'hidden-record',
			kind: 'remove',
			hiddenId: 'hidden-live-3',
			revision: 7,
		});
		assert.equal(harness.canvasState.bulkRecords.length, 3);
		assert.equal(
			harness.canvasState.bulkRecords.some((record) => record._permissionHiddenId === 'hidden-live-3'),
			false,
		);
	});

	test('never republishes permission-hidden placeholders as editor-created drafts', () => {
		const hidden = {
			id: -1,
			objectName: null,
			label: 'Hidden Salesforce content',
			x: 10,
			y: 20,
			values: {},
			_inaccessible: true,
			_permissionHidden: true,
			_permissionHiddenId: 'hidden-saved-1',
		};
		const harness = mountPresence({ records: [hidden] });
		harness.api.subscribeToCanvas('069000000000097AAA');
		harness.sources[0].emit('presence-init', {
			you: { connectionId: 'restricted-editor', role: 'editor', canEdit: true },
			peers: [{ connectionId: 'owner', displayName: 'Owner', color: '#fff' }],
			revision: 1,
			durableRevision: 1,
		});

		for (let pass = 0; pass < 10; pass++) {
			harness.advance(2_000);
			harness.tick();
		}

		assert.equal(
			harness.requests.some((request) => request.url.endsWith('/presence/draft')),
			false,
		);
		assert.equal(hidden._collabId, undefined);
		assert.equal(hidden._canvasRecordId, undefined);
		assert.equal(harness.canvasState.bulkRecords.length, 1);
	});

	test('republishes a local request record missing from the server live snapshot', async () => {
		const records = [
			{
				id: 1,
				objectName: 'Account',
				_collabId: 'existing-draft',
				_canvasRecordId: 'existing-card',
				values: { Name: 'Existing' },
			},
			{
				id: 2,
				objectName: 'Account',
				_collabId: 'missing-draft',
				_canvasRecordId: 'missing-card',
				values: { Name: 'Requested account' },
				slot: {
					slotId: 'missing-slot',
					kind: 'fields',
					fields: ['Name'],
					assigneeSfUserId: '005000000000001AAA',
				},
			},
		];
		const harness = mountPresence({
			records,
			snapshotPayload: {
				schema: { objects: [{ name: 'Account', label: 'Account' }] },
				loadedRecords: [],
				drafts: [
					{
						tempId: 'existing-draft',
						canvasRecordId: 'existing-card',
						objectName: 'Account',
						values: { Name: 'Existing' },
					},
					{
						tempId: 'missing-draft',
						canvasRecordId: 'missing-card',
						objectName: 'Account',
						values: { Name: 'Requested account' },
						slot: records[1].slot,
					},
				],
				associations: [],
			},
		});
		harness.api.subscribeToCanvas('069000000000098AAA');
		const source = harness.sources[0];
		source.emit('presence-init', {
			you: { connectionId: 'owner', role: 'owner', canEdit: true },
			peers: [],
			revision: 4,
			durableRevision: 2,
			hasLiveSnapshot: true,
		});
		source.emit('presence', {
			type: 'live-snapshot',
			revision: 4,
			durableRevision: 2,
			payload: {
				schema: { objects: [{ name: 'Account', label: 'Account' }] },
				loadedRecords: [],
				drafts: [
					{
						tempId: 'existing-draft',
						canvasRecordId: 'existing-card',
						objectName: 'Account',
						values: { Name: 'Existing' },
					},
				],
				associations: [],
			},
		});

		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(harness.appliedSnapshots[0].payload.drafts.length, 2);
		const create = harness.requests.find(
			(request) =>
				request.url.endsWith('/presence/draft') &&
				request.body.kind === 'create' &&
				request.body.tempId === 'missing-draft',
		);
		assert.ok(create);
		assert.equal(create.body.canvasRecordId, 'missing-card');
		assert.deepEqual(create.body.slot, {
			slotId: 'missing-slot',
			kind: 'fields',
			createdAt: null,
			label: null,
			description: null,
			assigneeSfUserId: '005000000000001AAA',
			assigneeName: null,
			assigneeEmail: null,
			fields: ['Name'],
		});
	});

	test('treats restricted recipient snapshots as authoritative instead of merging hidden local cards', async () => {
		const harness = mountPresence({
			snapshotPayload: {
				schema: { objects: [{ name: 'Account', label: 'Account' }] },
				loadedRecords: [],
				drafts: [
					{
						tempId: 'stale-local-account',
						canvasRecordId: 'stale-local-card',
						objectName: 'Account',
						values: { Name: 'Must not be restored' },
					},
				],
				associations: [],
			},
		});
		harness.api.subscribeToCanvas('069000000000096AAA');
		const source = harness.sources[0];
		source.emit('presence-init', {
			you: { connectionId: 'restricted-editor', role: 'editor', canEdit: true },
			peers: [{ connectionId: 'owner', role: 'owner' }],
			revision: 2,
			durableRevision: 1,
			hasLiveSnapshot: true,
		});
		source.emit('presence', {
			type: 'live-snapshot',
			revision: 2,
			durableRevision: 1,
			payload: {
				schema: { objects: [] },
				loadedRecords: [],
				drafts: [],
				hiddenRecords: [{ hiddenId: 'hidden-1', x: 10, y: 20, reason: 'salesforce-permissions' }],
				associations: [],
			},
		});

		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(harness.appliedSnapshots.length, 1);
		assert.equal(harness.appliedSnapshots[0].payload.drafts.length, 0);
		assert.equal(harness.appliedSnapshots[0].payload.hiddenRecords.length, 1);
		assert.equal(harness.autoPanSuppressions.at(-1), true);
	});

	test('preserves standalone record-request identity in live draft events', () => {
		const records = [];
		const harness = mountPresence({ records });
		harness.api.subscribeToCanvas('069000000000097AAA');
		harness.sources[0].emit('presence-init', {
			you: { connectionId: 'editor', role: 'editor', canEdit: true },
			peers: [],
		});
		records.push({
			id: 1,
			objectName: 'Opportunity',
			_collabId: 'record-request-draft',
			_canvasRecordId: 'record-request-card',
			values: {},
			slot: {
				slotId: 'record-request-slot',
				kind: 'whole-record',
				origin: 'standalone',
				assigneeSfUserId: '005000000000001AAA',
			},
		});
		harness.tick();

		const create = harness.requests.find(
			(request) =>
				request.url.endsWith('/presence/draft') &&
				request.body.kind === 'create' &&
				request.body.tempId === 'record-request-draft',
		);
		assert.ok(create);
		assert.equal(create.body.slot.origin, 'standalone');
	});

	test('replaces an editor-created request placeholder when its owner completes it', () => {
		const record = {
			id: 1,
			objectName: 'Opportunity',
			_collabId: 'record-request-draft',
			_canvasRecordId: 'record-request-card',
			values: {},
			slot: {
				slotId: 'record-request-slot',
				kind: 'whole-record',
				origin: 'standalone',
			},
		};
		const harness = mountPresence({ records: [record] });
		harness.api.subscribeToCanvas('069000000000098AAA');
		harness.sources[0].emit('presence-init', {
			you: { connectionId: 'editor', role: 'editor', canEdit: true },
			peers: [{ connectionId: 'owner', role: 'owner' }],
			revision: 0,
			durableRevision: 0,
		});
		harness.sources[0].emit('presence', {
			type: 'field-update',
			targetRef: {
				refKind: 'slot',
				ref: 'record-request-slot',
				collabRef: 'record-request-card',
			},
			fields: { Name: 'Completed by owner' },
			revision: 1,
		});

		assert.deepEqual(record.values, { Name: 'Completed by owner' });
	});

	test('removes the old canvas edge when a contributor reparents a requested lookup', () => {
		const contact = {
			id: 1,
			objectName: 'Contact',
			_collabId: 'contact-draft',
			_canvasRecordId: 'contact-card',
			values: { LastName: 'Contributor' },
			slot: {
				slotId: 'contact-request',
				kind: 'fields',
				fields: ['AccountId'],
			},
		};
		const account = {
			id: 2,
			objectName: 'Account',
			loadedFromId: '001000000000001AAA',
			_canvasRecordId: 'account-card',
			values: { Name: 'Canvas account' },
		};
		const harness = mountPresence({
			records: [contact, account],
			associations: [{ id: 3, fromId: contact.id, toId: account.id, fieldName: 'AccountId' }],
		});
		harness.api.subscribeToCanvas('069000000000100AAA');
		harness.sources[0].emit('presence-init', {
			you: { connectionId: 'owner', role: 'owner', canEdit: true },
			peers: [{ connectionId: 'contributor', role: 'contributor' }],
			revision: 0,
			durableRevision: 0,
		});
		harness.sources[0].emit('presence', {
			type: 'field-update',
			targetRef: {
				refKind: 'slot',
				ref: 'contact-request',
				collabRef: 'contact-card',
			},
			fields: { AccountId: '001000000000002AAA' },
			relationshipFields: ['AccountId'],
			revision: 1,
		});

		assert.equal(harness.canvasState.bulkAssociations.length, 0);
		assert.equal(contact.values.AccountId, '001000000000002AAA');
	});

	test('keeps the viewport in place when another user creates records', async () => {
		const harness = mountPresence();
		harness.api.subscribeToCanvas('069000000000099AAA');
		harness.sources[0].emit('presence-init', {
			you: { connectionId: 'viewer', role: 'viewer', canEdit: false },
			peers: [{ connectionId: 'editor', role: 'editor' }],
			revision: 0,
			durableRevision: 0,
		});
		harness.sources[0].emit('presence', {
			type: 'draft-update',
			kind: 'create',
			tempId: 'remote-draft',
			canvasRecordId: 'remote-draft-card',
			objectName: 'Account',
			fields: { Name: 'Remote draft' },
			x: 900,
			y: 700,
			revision: 1,
		});
		await new Promise((resolve) => setImmediate(resolve));
		harness.sources[0].emit('presence', {
			type: 'loaded-record',
			kind: 'create',
			sfId: '001000000000099AAA',
			collabRef: 'remote-loaded-card',
			objectName: 'Account',
			fields: { Name: 'Remote existing record' },
			baseline: { Name: 'Remote existing record' },
			x: 1200,
			y: 900,
			revision: 2,
		});
		await new Promise((resolve) => setImmediate(resolve));

		assert.deepEqual(harness.autoPanSuppressions, [true, true]);
		assert.equal(harness.canvasState.bulkRecords.length, 2);
	});

	test('publishes and applies links for loaded records, drafts, and record requests', () => {
		const records = [
			{
				id: 1,
				loadedFromId: '003000000000001',
				_canvasRecordId: 'contact-card',
				values: {},
			},
			{ id: 2, _persistedTempId: 'draft-2', _canvasRecordId: 'draft-card' },
			{ id: 3, slot: { slotId: 'slot-3' }, _canvasRecordId: 'slot-card' },
			{
				id: 4,
				loadedFromId: '001000000000001',
				_canvasRecordId: 'account-card',
				values: {},
			},
		];
		const harness = mountPresence({
			records,
			associations: [],
		});
		harness.api.subscribeToCanvas('draft-44444444-4444-4444-8444-444444444444');
		const source = harness.sources[0];
		source.emit('presence-init', {
			you: { connectionId: 'mine' },
			peers: [{ connectionId: 'peer', displayName: 'Peer', color: '#fff', cursor: null, focus: null }],
		});

		harness.canvasState.bulkAssociations.push(
			{ id: 10, fromId: 1, toId: 4, fieldName: 'AccountId' },
			{ id: 11, fromId: 2, toId: 3, fieldName: 'Parent__c' },
			{ id: 12, fromId: 3, toId: 2, fieldName: 'Primary_Contact__c' },
		);
		harness.tick();
		const linkRequests = harness.requests.filter((request) => request.url.endsWith('/presence/draft-link'));
		assert.equal(linkRequests.length, 3);
		assert.deepEqual(linkRequests[0].body.fromRef, {
			refKind: 'loaded',
			ref: '003000000000001',
			collabRef: 'contact-card',
		});
		assert.deepEqual(linkRequests[0].body.toRef, {
			refKind: 'loaded',
			ref: '001000000000001',
			collabRef: 'account-card',
		});
		assert.deepEqual(linkRequests[1].body.toRef, {
			refKind: 'slot',
			ref: 'slot-3',
			sourceRefKind: 'draft',
			sourceRef: '11111111-1111-4111-8111-111111111111',
			collabRef: 'slot-card',
		});
		assert.deepEqual(linkRequests[2].body.fromRef, {
			refKind: 'slot',
			ref: 'slot-3',
			sourceRefKind: 'draft',
			sourceRef: '11111111-1111-4111-8111-111111111111',
			collabRef: 'slot-card',
		});
		assert.deepEqual(linkRequests[2].body.toRef, {
			refKind: 'draft',
			ref: 'draft-2',
			collabRef: 'draft-card',
		});

		const receiving = mountPresence({ records: records.map((record) => structuredClone(record)) });
		receiving.api.subscribeToCanvas('draft-55555555-5555-4555-8555-555555555555');
		const receivingSource = receiving.sources[0];
		receivingSource.emit('presence-init', { you: { connectionId: 'receiver' }, peers: [] });
		receivingSource.emit('presence', {
			type: 'draft-link',
			kind: 'add',
			fromRef: { refKind: 'loaded', ref: '003000000000001' },
			toRef: { refKind: 'loaded', ref: '001000000000001' },
			fieldName: 'AccountId',
		});
		assert.equal(receiving.canvasState.bulkAssociations.length, 1);
		assert.equal(receiving.canvasState.bulkRecords[0].values.AccountId, '001000000000001');
		receivingSource.emit('presence', {
			type: 'draft-link',
			kind: 'remove',
			fromRef: { refKind: 'loaded', ref: '003000000000001' },
			toRef: { refKind: 'loaded', ref: '001000000000001' },
			fieldName: 'AccountId',
		});
		assert.equal(receiving.canvasState.bulkAssociations.length, 0);
		assert.equal(receiving.canvasState.bulkRecords[0].values.AccountId, undefined);
		receivingSource.emit('presence', {
			type: 'draft-link',
			kind: 'add',
			fromRef: { refKind: 'slot', ref: 'slot-3', collabRef: 'slot-card' },
			toRef: { refKind: 'draft', ref: 'draft-2', collabRef: 'draft-card' },
			fieldName: 'Primary_Contact__c',
		});
		assert.equal(receiving.canvasState.bulkAssociations.length, 1);
		assert.deepEqual(
			(({ fromId, toId, fieldName }) => ({ fromId, toId, fieldName }))(receiving.canvasState.bulkAssociations[0]),
			{
				fromId: 3,
				toId: 2,
				fieldName: 'Primary_Contact__c',
			},
		);
		const receivedLinkRequestCount = receiving.requests.filter((request) =>
			request.url.endsWith('/presence/draft-link'),
		).length;
		receiving.tick();
		assert.equal(
			receiving.requests.filter((request) => request.url.endsWith('/presence/draft-link')).length,
			receivedLinkRequestCount,
			'a received record-request link must not be echoed back as a remove/add pair',
		);
		assert.equal(receiving.canvasState.bulkAssociations.length, 1);
	});

	test('keeps an already-converged view in place when another user saves', async () => {
		const snapshotPayload = {
			_meta: { savedBy: 'owner', savedAt: 'ignored' },
			drafts: [{ objectName: 'Account', tempId: 'draft-1', values: { Name: 'Acme' } }],
			associations: [],
		};
		const canonical = JSON.stringify({
			associations: [],
			drafts: [{ objectName: 'Account', tempId: 'draft-1', values: { Name: 'Acme' } }],
		});
		const snapshotHash = createHash('sha256').update(canonical).digest('hex');
		const harness = mountPresence({ snapshotPayload });
		harness.canvasState.currentCanvas = {
			id: '069000000000010AAA',
			versionId: '068000000000000AAA',
		};
		harness.api.subscribeToCanvas('069000000000010AAA');
		harness.sources[0].emit('presence-init', {
			you: { connectionId: 'mine', role: 'viewer', canEdit: false },
			peers: [],
			revision: 4,
			durableRevision: 3,
		});
		harness.sources[0].emit('presence', {
			type: 'canvas-saved',
			savedByAccountId: 'other',
			savedByDisplayName: 'Owner',
			revision: 4,
			snapshotHash,
			versionId: '068000000000010AAA',
		});
		await new Promise((resolve) => setTimeout(resolve, 25));
		assert.equal(harness.reloadCount(), 0);
		assert.equal(harness.canvasState.currentCanvas.versionId, '068000000000010AAA');

		harness.sources[0].emit('presence', {
			type: 'canvas-saved',
			savedByAccountId: 'other',
			savedByDisplayName: 'Owner',
			revision: 5,
			snapshotHash: '0'.repeat(64),
			versionId: '068000000000011AAA',
		});
		await new Promise((resolve) => setTimeout(resolve, 25));
		assert.equal(harness.reloadCount(), 1);
		assert.equal(harness.canvasState.currentCanvas.versionId, '068000000000010AAA');
	});

	test('broadcasts committed changes to loaded Salesforce records', async () => {
		const record = {
			id: 1,
			objectName: 'Account',
			loadedFromId: '001000000000001AAA',
			loadedValues: { Name: 'Before' },
			values: { Name: 'Before' },
			x: 10,
			y: 20,
		};
		const sender = mountPresence({ records: [record] });
		sender.api.subscribeToCanvas('069000000000011AAA');
		sender.sources[0].emit('presence-init', {
			you: { connectionId: 'sender', role: 'editor', canEdit: true },
			peers: [{ connectionId: 'peer', displayName: 'Peer', color: '#fff' }],
			revision: 0,
			durableRevision: 0,
		});
		record.values.Name = 'After';
		sender.tick();
		const update = sender.requests.find((request) => request.url.endsWith('/presence/loaded-record'));
		assert.ok(update);
		assert.equal(update.body.kind, 'update');
		assert.deepEqual(update.body.fields, { Name: 'After' });
		await new Promise((resolve) => setImmediate(resolve));

		const receiver = mountPresence({ records: [structuredClone({ ...record, values: { Name: 'Before' } })] });
		receiver.api.subscribeToCanvas('069000000000012AAA');
		receiver.sources[0].emit('presence-init', {
			you: { connectionId: 'receiver', role: 'contributor', canEdit: false },
			peers: [],
			revision: 0,
			durableRevision: 0,
		});
		receiver.sources[0].emit('presence', {
			type: 'loaded-record',
			kind: 'update',
			sfId: '001000000000001AAA',
			fields: { Name: 'After' },
			revision: 1,
		});
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(receiver.canvasState.bulkRecords[0].values.Name, 'After');

		record.loadedValues = { Name: 'After' };
		sender.tick();
		await new Promise((resolve) => setImmediate(resolve));
		const rebase = sender.requests.filter((request) => request.url.endsWith('/presence/loaded-record')).at(-1);
		assert.deepEqual(rebase.body.fields, { Name: 'After' });
		assert.deepEqual(rebase.body.baseline, { Name: 'After' });
		receiver.sources[0].emit('presence', {
			type: 'loaded-record',
			kind: 'update',
			sfId: '001000000000001AAA',
			fields: rebase.body.fields,
			baseline: rebase.body.baseline,
			revision: 2,
		});
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(receiver.canvasState.bulkRecords[0].loadedValues.Name, 'After');

		record.slot = {
			slotId: 7,
			kind: 'fields',
			label: 'Complete account',
			fields: ['Name'],
			assigneeSfUserId: '005000000000001AAA',
		};
		sender.tick();
		const slotRequest = sender.requests.find((request) => request.url.endsWith('/presence/slot'));
		assert.ok(slotRequest);
		assert.deepEqual(slotRequest.body.targetRef, {
			refKind: 'loaded',
			ref: '001000000000001AAA',
			collabRef: record._canvasRecordId,
		});

		receiver.sources[0].emit('presence', {
			type: 'slot-update',
			targetRef: slotRequest.body.targetRef,
			slot: slotRequest.body.slot,
			revision: 3,
		});
		assert.equal(receiver.canvasState.bulkRecords[0].slot.label, 'Complete account');
		assert.equal(receiver.canvasState.bulkRecords[0]._recipientSlot, true);
		assert.equal(receiver.slotUpdates.length, 1);
		assert.equal(receiver.slotUpdates[0].record, receiver.canvasState.bulkRecords[0]);

		receiver.sources[0].emit('presence', {
			type: 'slot-update',
			targetRef: slotRequest.body.targetRef,
			slot: null,
			revision: 4,
		});
		assert.equal(receiver.canvasState.bulkRecords[0].slot, undefined);
		assert.equal(receiver.canvasState.bulkRecords[0]._recipientSlot, undefined);
		assert.equal(receiver.slotUpdates.length, 2);
	});

	test('promotes an uploaded draft in place when the loaded event arrives before draft removal', async () => {
		const draft = {
			id: 1,
			objectName: 'Account',
			_persistedTempId: 'draft-account',
			_canvasRecordId: 'account-card',
			values: { Name: 'Before upload' },
			slot: { slotId: 'account-request', kind: 'whole-record' },
			x: 40,
			y: 60,
		};
		const receiver = mountPresence({ records: [draft] });
		receiver.api.subscribeToCanvas('069000000000013AAA');
		receiver.sources[0].emit('presence-init', {
			you: { connectionId: 'receiver', role: 'viewer', canEdit: false },
			peers: [],
			revision: 0,
			durableRevision: 0,
		});

		receiver.sources[0].emit('presence', {
			type: 'loaded-record',
			kind: 'create',
			sfId: '001000000000013AAA',
			collabRef: 'replacement-account-card',
			promotedFrom: { refKind: 'slot', ref: 'account-request' },
			slot: null,
			objectName: 'Account',
			fields: { Id: '001000000000013AAA', Name: 'After upload' },
			baseline: { Id: '001000000000013AAA', Name: 'After upload' },
			revision: 1,
		});
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(receiver.canvasState.bulkRecords.length, 1);
		assert.equal(receiver.canvasState.bulkRecords[0], draft);
		assert.equal(draft.loadedFromId, '001000000000013AAA');
		assert.equal(draft.values.Name, 'After upload');
		assert.equal(draft._persistedTempId, undefined);
		assert.equal(draft.slot, undefined);

		receiver.sources[0].emit('presence', {
			type: 'draft-update',
			kind: 'remove',
			tempId: 'draft-account',
			revision: 2,
		});
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(receiver.canvasState.bulkRecords.length, 1);
		assert.equal(receiver.canvasState.bulkRecords[0].loadedFromId, '001000000000013AAA');
	});

	test('publishes a local draft upload as one atomic loaded-record transition', async () => {
		const draft = {
			id: 1,
			objectName: 'Account',
			_persistedTempId: 'draft-account',
			_canvasRecordId: 'account-card',
			values: { Name: 'Before upload' },
			slot: { slotId: 'account-request', kind: 'whole-record' },
			x: 40,
			y: 60,
		};
		const sender = mountPresence({ records: [draft] });
		sender.api.subscribeToCanvas('069000000000014AAA');
		sender.sources[0].emit('presence-init', {
			you: { connectionId: 'owner', role: 'owner', canEdit: true },
			peers: [{ connectionId: 'editor', displayName: 'Editor', color: '#fff' }],
			revision: 0,
			durableRevision: 0,
		});

		draft._presencePromotedFrom = {
			refKind: 'slot',
			ref: 'account-request',
			sourceRefKind: 'draft',
			sourceRef: 'draft-account',
			collabRef: 'account-card',
		};
		delete draft.slot;
		draft.loadedFromId = '001000000000014AAA';
		draft.values.Id = draft.loadedFromId;
		draft.loadedValues = structuredClone(draft.values);
		sender.tick();
		await new Promise((resolve) => setImmediate(resolve));

		const loadedCreates = sender.requests.filter(
			(request) => request.url.endsWith('/presence/loaded-record') && request.body.kind === 'create',
		);
		assert.equal(loadedCreates.length, 1);
		assert.equal(loadedCreates[0].body.collabRef, 'account-card');
		assert.equal(loadedCreates[0].body.slot, null);
		assert.deepEqual(loadedCreates[0].body.promotedFrom, {
			refKind: 'slot',
			ref: 'account-request',
			sourceRefKind: 'draft',
			sourceRef: 'draft-account',
			collabRef: 'account-card',
		});
		assert.equal(
			sender.requests.filter(
				(request) => request.url.endsWith('/presence/draft') && request.body.kind === 'remove',
			).length,
			0,
		);

		sender.advance(2000);
		sender.tick();
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(
			sender.requests.filter(
				(request) => request.url.endsWith('/presence/draft') && request.body.kind === 'remove',
			).length,
			0,
		);
	});
});
