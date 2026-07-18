import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/public/js/mcp-relay-client.js', import.meta.url), 'utf8');

test('relay availability controls canvas registration and notifies MCP pollers', async () => {
	const requests = [];
	const availability = [];
	const windowListeners = new Map();
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
			}
		},
	};
	const document = {
		visibilityState: 'visible',
		getElementById: () => ({}),
		querySelector: () => ({ getAttribute: () => 'csrf' }),
		addEventListener() {},
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
			return { ok: true };
		},
	});

	assert.equal(eventSources.length, 1);
	eventSources[0].emit('ready', { connectionId: 'connection-1', mcpActive: false });
	assert.deepEqual(availability, [false]);
	assert.equal(requests.length, 0, 'a workspace without a token does not register the canvas');

	eventSources[0].emit('mcp-availability', { active: true });
	await Promise.resolve();
	assert.equal(window.ORGLOOM_MCP_ACTIVE, true);
	assert.deepEqual(availability, [false, true]);
	assert.equal(requests.filter((request) => request.url.endsWith('/register')).length, 1);

	eventSources[0].emit('mcp-availability', { active: false });
	await Promise.resolve();
	assert.equal(window.ORGLOOM_MCP_ACTIVE, false);
	assert.deepEqual(availability, [false, true, false]);
	assert.equal(requests.filter((request) => request.url.endsWith('/unregister')).length, 1);
});
