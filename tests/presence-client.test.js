import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/public/js/presence.js', import.meta.url), 'utf8');

function element() {
	return {
		classList: { add() {} },
		style: {},
		innerHTML: '',
		appendChild() {},
		setAttribute() {},
		removeAttribute() {},
		remove() {},
		querySelector() {
			return null;
		},
		querySelectorAll() {
			return [];
		},
		getBoundingClientRect() {
			return { left: 0, top: 0, right: 800, bottom: 600 };
		},
	};
}

function mountPresence() {
	const requests = [];
	const hostListeners = new Map();
	const host = element();
	host.addEventListener = (event, handler) => hostListeners.set(event, handler);
	const graph = { querySelector: () => host };
	const document = {
		body: element(),
		createElement: element,
		getElementById: () => element(),
		querySelector: () => null,
		querySelectorAll: () => [],
	};
	const sources = [];
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
		crypto: { randomUUID: () => '11111111-1111-4111-8111-111111111111' },
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
		encodeURIComponent,
		setInterval: () => 1,
		clearInterval() {},
	});
	const api = window.OrgLoom.presence.mount({
		canvasState: { bulkRecords: [], bulkAssociations: [], currentCanvas: null },
		csrfFetch: async (url, options) => {
			requests.push({ url, body: JSON.parse(options.body) });
			return { ok: true };
		},
		escapeHtml: (value) => String(value),
		getGraph: () => graph,
		getCyInstance: () => null,
		isCanvasDirty: () => false,
		reloadCanvasFromServer: async () => {},
		showBulkToast() {},
		renderBulkView() {},
		addToSelection() {},
	});
	return {
		api,
		requests,
		sources,
		move(x = 20, y = 30) {
			now += 101;
			hostListeners.get('mousemove')?.({ clientX: x, clientY: y });
		},
		leaveCanvas() {
			hostListeners.get('mouseleave')?.();
		},
	};
}

describe('presence client request gating', () => {
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
});
