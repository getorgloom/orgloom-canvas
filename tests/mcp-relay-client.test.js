import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/public/js/mcp-relay-client.js', import.meta.url), 'utf8');

test('relay availability controls canvas registration and forwards proposal changes', async () => {
	const requests = [];
	const availability = [];
	const proposalChanges = [];
	const windowListeners = new Map();
	const documentListeners = new Map();
	const eventSources = [];
	const window = {
		ORGLOOM_MOCK: false,
		ORGLOOM_MCP_ACTIVE: false,
		Orgloom: {
			canvasState: {
				getCurrentCanvas: () => ({ canvasId: 'draft-test', meta: { title: 'Test' } }),
			},
		},
		addEventListener(event, handler) {
			windowListeners.set(event, handler);
		},
		dispatchEvent(event) {
			if (event.type === 'orgloom:mcp-availability') {
				availability.push(event.detail.active);
			} else if (event.type === 'orgloom:ai-proposals-changed') {
				proposalChanges.push(event.detail);
			}
		},
	};
	const document = {
		visibilityState: 'visible',
		getElementById: () => ({}),
		querySelector: () => ({ getAttribute: () => 'csrf' }),
		addEventListener(event, handler) {
			documentListeners.set(event, handler);
		},
	};
	class EventSource {
		static CLOSED = 2;
		constructor(url) {
			this.url = url;
			this.listeners = new Map();
			this.readyState = 1;
			eventSources.push(this);
		}
		addEventListener(event, handler) {
			this.listeners.set(event, handler);
		}
		emit(event, data) {
			this.listeners.get(event)?.({ data: JSON.stringify(data) });
		}
	}
	class CustomEvent {
		constructor(type, options) {
			this.type = type;
			this.detail = options.detail;
		}
	}
	vm.runInNewContext(source, {
		window,
		document,
		EventSource,
		CustomEvent,
		localStorage: { getItem: () => null },
		console,
		JSON,
		Promise,
		setInterval: () => 1,
		clearInterval() {},
		fetch: async (url, options) => {
			requests.push({ url, options });
			return {
				ok: true,
				json: async () => ({ active: true }),
			};
		},
	});
	await new Promise((resolve) => setImmediate(resolve));

	assert.equal(eventSources.length, 1);
	assert.equal(requests[0].url, '/api/mcp/relay/status');
	requests.length = 0;
	eventSources[0].emit('ready', { connectionId: 'connection-1', mcpActive: false });
	assert.deepEqual(availability, [false]);
	assert.equal(requests.length, 0, 'a workspace without a token does not register the canvas');

	eventSources[0].emit('mcp-availability', { active: true });
	await Promise.resolve();
	assert.equal(window.ORGLOOM_MCP_ACTIVE, true);
	assert.deepEqual(availability, [false, true]);
	assert.equal(requests.filter((request) => request.url.endsWith('/register')).length, 1);

	eventSources[0].emit('ai-proposals-changed', { canvasId: 'draft-test' });
	assert.equal(proposalChanges.length, 1);
	assert.equal(proposalChanges[0].canvasId, 'draft-test');

	eventSources[0].emit('mcp-availability', { active: false });
	await Promise.resolve();
	assert.equal(window.ORGLOOM_MCP_ACTIVE, false);
	assert.deepEqual(availability, [false, true, false]);
	assert.equal(requests.filter((request) => request.url.endsWith('/unregister')).length, 1);
});

test('workspace without an MCP token does not consume a long-lived browser connection', async () => {
	const eventSources = [];
	const availability = [];
	const window = {
		ORGLOOM_MOCK: false,
		ORGLOOM_MCP_ACTIVE: false,
		addEventListener() {},
		dispatchEvent(event) {
			availability.push(event.detail.active);
		},
	};
	const document = {
		visibilityState: 'visible',
		getElementById: () => ({}),
		querySelector: () => ({ getAttribute: () => 'csrf' }),
		addEventListener() {},
	};
	class EventSource {
		constructor(url) {
			eventSources.push(url);
		}
	}
	class CustomEvent {
		constructor(type, options) {
			this.type = type;
			this.detail = options.detail;
		}
	}
	vm.runInNewContext(source, {
		window,
		document,
		EventSource,
		CustomEvent,
		localStorage: { getItem: () => null },
		console,
		JSON,
		Promise,
		setInterval: () => 1,
		clearInterval() {},
		fetch: async () => ({ ok: true, json: async () => ({ active: false }) }),
	});
	await new Promise((resolve) => setImmediate(resolve));

	assert.equal(eventSources.length, 0);
	assert.equal(availability.length, 1);
	assert.equal(availability[0], false);
});
