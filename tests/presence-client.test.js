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
} = {}) {
	const requests = [];
	const accessChanges = [];
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
	class EventSource {
		constructor(url) {
			this.url = url;
			this.readyState = 1;
			this.listeners = new Map();
			sources.push(this);
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
	});
	return {
		api,
		cards,
		canvasState,
		requests,
		toasts,
		accessChanges,
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
		assert.match(modal.innerHTML, /Reload canvas/);
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
			collabRef: 'slot-card',
		});
		assert.deepEqual(linkRequests[2].body.fromRef, {
			refKind: 'slot',
			ref: 'slot-3',
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

		const receiver = mountPresence({ records: [structuredClone({ ...record, values: { Name: 'Before' } })] });
		receiver.api.subscribeToCanvas('069000000000012AAA');
		receiver.sources[0].emit('presence-init', {
			you: { connectionId: 'receiver', role: 'viewer', canEdit: false },
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
			revision: 2,
		});
		assert.equal(receiver.canvasState.bulkRecords[0].slot.label, 'Complete account');
	});
});
