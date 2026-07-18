import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
	registerConnection,
	unregisterConnection,
	registerCanvas,
	unregisterCanvas,
	listCanvasesInWorkspace,
	dispatchRequest,
	recordResponse,
	purgeWorkspace,
	workspaceLiveSummary,
} from '../src/mcp/relay.js';

function mockSseRes() {
	const writes = [];
	const closeHandlers = [];
	const errorHandlers = [];
	return {
		writes,
		write(chunk) {
			writes.push(chunk);
			return true;
		},
		on(event, handler) {
			if (event === 'close') {
				closeHandlers.push(handler);
			}
			if (event === 'error') {
				errorHandlers.push(handler);
			}
		},
		fireClose() {
			closeHandlers.forEach((h) => h());
		},
		fireError() {
			errorHandlers.forEach((h) => h(new Error('socket failed')));
		},
		lastDataEvent() {
			for (let i = writes.length - 1; i >= 0; i--) {
				const m = writes[i].match(/^data: (.+)\n\n$/);
				if (m) {
					return JSON.parse(m[1]);
				}
			}
			return null;
		},
	};
}

beforeEach(() => {});

describe('register / unregister symmetry', () => {
	test('SSE error eagerly removes a half-open registration', () => {
		const sse = mockSseRes();
		const id = registerConnection({ accountId: 'a', workspaceId: 'ws-error', sseRes: sse });
		registerCanvas({ connectionId: id, canvasId: 'cv', meta: {}, accountId: 'a' });
		assert.equal(workspaceLiveSummary('ws-error').canvasCount, 1);
		sse.fireError();
		assert.equal(workspaceLiveSummary('ws-error').canvasCount, 0);
	});
	test('registerConnection writes the connectionId via SSE ready event', () => {
		const sse = mockSseRes();
		const id = registerConnection({ accountId: 'a1', workspaceId: 'ws1', sseRes: sse });
		assert.equal(typeof id, 'string');
		assert.ok(id.length > 0);
		const ready = sse.lastDataEvent();
		assert.deepEqual(ready, { connectionId: id });
		sse.fireClose();
	});

	test('SSE close handler invokes unregisterConnection (canvas drops off list)', () => {
		const sse = mockSseRes();
		const id = registerConnection({ accountId: 'a1', workspaceId: 'wsClose', sseRes: sse });
		registerCanvas({ connectionId: id, canvasId: 'c1', meta: { title: 'Hello' } });
		assert.equal(listCanvasesInWorkspace('wsClose').length, 1);
		sse.fireClose();
		assert.equal(listCanvasesInWorkspace('wsClose').length, 0);
	});

	test('unregisterCanvas only removes that canvas (other registrations stay)', () => {
		const sse = mockSseRes();
		const id = registerConnection({ accountId: 'a1', workspaceId: 'wsMulti', sseRes: sse });
		registerCanvas({ connectionId: id, canvasId: 'c1' });
		registerCanvas({ connectionId: id, canvasId: 'c2' });
		assert.equal(listCanvasesInWorkspace('wsMulti').length, 2);
		unregisterCanvas({ connectionId: id, canvasId: 'c1' });
		const remaining = listCanvasesInWorkspace('wsMulti');
		assert.equal(remaining.length, 1);
		assert.equal(remaining[0].canvasId, 'c2');
		sse.fireClose();
	});
});

describe('listCanvasesInWorkspace', () => {
	test('two browsers on the same canvas → one entry, liveBrowsers=2', () => {
		const sseA = mockSseRes();
		const sseB = mockSseRes();
		const idA = registerConnection({ accountId: 'a1', workspaceId: 'wsShared', sseRes: sseA });
		const idB = registerConnection({ accountId: 'a1', workspaceId: 'wsShared', sseRes: sseB });
		registerCanvas({ connectionId: idA, canvasId: 'cX', meta: { title: 'X' } });
		registerCanvas({ connectionId: idB, canvasId: 'cX', meta: { title: 'X' } });
		const rows = listCanvasesInWorkspace('wsShared');
		assert.equal(rows.length, 1);
		assert.equal(rows[0].canvasId, 'cX');
		assert.equal(rows[0].liveBrowsers, 2);
		sseA.fireClose();
		sseB.fireClose();
	});

	test('meta updates on re-register (most-recent wins)', () => {
		const sse = mockSseRes();
		const id = registerConnection({ accountId: 'a1', workspaceId: 'wsMeta', sseRes: sse });
		registerCanvas({ connectionId: id, canvasId: 'c1', meta: { title: 'Old' } });
		registerCanvas({ connectionId: id, canvasId: 'c1', meta: { title: 'New' } });
		const rows = listCanvasesInWorkspace('wsMeta');
		assert.equal(rows[0].meta.title, 'New');
		sse.fireClose();
	});

	test('unknown workspace returns []', () => {
		assert.deepEqual(listCanvasesInWorkspace('nope'), []);
	});
});

describe('dispatchRequest → recordResponse round-trip', () => {
	test('successful response resolves the awaiting promise', async () => {
		const sse = mockSseRes();
		const id = registerConnection({ accountId: 'a1', workspaceId: 'wsReq', sseRes: sse });
		registerCanvas({ connectionId: id, canvasId: 'c1' });
		const p = dispatchRequest({
			workspaceId: 'wsReq',
			canvasId: 'c1',
			method: 'read',
			params: { rows: 10 },
		});
		const evt = sse.lastDataEvent();
		assert.equal(evt.method, 'read');
		assert.deepEqual(evt.params, { rows: 10 });
		const ok = recordResponse({
			connectionId: id,
			requestId: evt.requestId,
			result: { ok: true, data: 'payload' },
		});
		assert.equal(ok, true);
		const value = await p;
		assert.deepEqual(value, { ok: true, data: 'payload' });
		sse.fireClose();
	});

	test('error response rejects with the error message', async () => {
		const sse = mockSseRes();
		const id = registerConnection({ accountId: 'a1', workspaceId: 'wsErr', sseRes: sse });
		registerCanvas({ connectionId: id, canvasId: 'c1' });
		const p = dispatchRequest({ workspaceId: 'wsErr', canvasId: 'c1', method: 'read' });
		const evt = sse.lastDataEvent();
		recordResponse({ connectionId: id, requestId: evt.requestId, error: 'permission-denied' });
		await assert.rejects(p, /permission-denied/);
		sse.fireClose();
	});

	test('no live browser for canvas → rejects immediately', async () => {
		await assert.rejects(
			dispatchRequest({ workspaceId: 'wsAbsent', canvasId: 'c1', method: 'read' }),
			/no-live-browser-for-canvas/,
		);
	});

	test('timeout rejects with relay-request-timeout', async () => {
		const sse = mockSseRes();
		const id = registerConnection({ accountId: 'a1', workspaceId: 'wsTo', sseRes: sse });
		registerCanvas({ connectionId: id, canvasId: 'c1' });
		await assert.rejects(
			dispatchRequest({
				workspaceId: 'wsTo',
				canvasId: 'c1',
				method: 'read',
				timeoutMs: 25,
			}),
			/relay-request-timeout/,
		);
		sse.fireClose();
	});

	test('mid-flight connection close rejects with relay-connection-dropped', async () => {
		const sse = mockSseRes();
		const id = registerConnection({ accountId: 'a1', workspaceId: 'wsDrop', sseRes: sse });
		registerCanvas({ connectionId: id, canvasId: 'c1' });
		const p = dispatchRequest({ workspaceId: 'wsDrop', canvasId: 'c1', method: 'read' });
		sse.fireClose();
		await assert.rejects(p, /relay-connection-dropped/);
	});

	test('response from a different connection is ignored (anti-spoof)', async () => {
		const sseA = mockSseRes();
		const sseB = mockSseRes();
		const idA = registerConnection({ accountId: 'a1', workspaceId: 'wsAnti', sseRes: sseA });
		const idB = registerConnection({ accountId: 'a1', workspaceId: 'wsAnti', sseRes: sseB });
		registerCanvas({ connectionId: idA, canvasId: 'c1' });
		const p = dispatchRequest({
			workspaceId: 'wsAnti',
			canvasId: 'c1',
			method: 'read',
			timeoutMs: 50,
		});
		const evt = sseA.lastDataEvent();
		const ok = recordResponse({
			connectionId: idB,
			requestId: evt.requestId,
			result: { evil: true },
		});
		assert.equal(ok, false, 'spoof must be rejected');
		await assert.rejects(p, /relay-request-timeout/);
		sseA.fireClose();
		sseB.fireClose();
	});
});

describe('purgeWorkspace', () => {
	test('drops every registration in the workspace + rejects in-flight requests', async () => {
		const sse = mockSseRes();
		const id = registerConnection({ accountId: 'a1', workspaceId: 'wsPurge', sseRes: sse });
		registerCanvas({ connectionId: id, canvasId: 'c1' });
		registerCanvas({ connectionId: id, canvasId: 'c2' });
		const p = dispatchRequest({
			workspaceId: 'wsPurge',
			canvasId: 'c1',
			method: 'read',
		});
		const removed = purgeWorkspace('wsPurge');
		assert.equal(removed, 2);
		assert.equal(listCanvasesInWorkspace('wsPurge').length, 0);
		await assert.rejects(p, /relay-workspace-purged/);
		sse.fireClose();
	});
});

describe('workspaceLiveSummary', () => {
	test('reports canvas + browser counts without exposing meta beyond title/owner', () => {
		const sse = mockSseRes();
		const id = registerConnection({ accountId: 'a1', workspaceId: 'wsSum', sseRes: sse });
		registerCanvas({
			connectionId: id,
			canvasId: 'c1',
			meta: { title: 'C1', ownerSfUserId: '005abc', secret: 'should-not-leak' },
		});
		const summary = workspaceLiveSummary('wsSum');
		assert.equal(summary.canvasCount, 1);
		assert.equal(summary.browserCount, 1);
		assert.deepEqual(summary.canvases, [
			{
				canvasId: 'c1',
				title: 'C1',
				ownerSfUserId: '005abc',
				liveBrowsers: 1,
			},
		]);
		const keys = Object.keys(summary.canvases[0]).sort();
		assert.deepEqual(keys, ['canvasId', 'liveBrowsers', 'ownerSfUserId', 'title']);
		sse.fireClose();
	});
});

describe('account binding (defense-in-depth)', () => {
	test('registerCanvas with a mismatched accountId is rejected', () => {
		const sse = mockSseRes();
		const id = registerConnection({ accountId: 'owner', workspaceId: 'wsBind', sseRes: sse });
		assert.equal(registerCanvas({ connectionId: id, canvasId: 'c1', accountId: 'attacker' }), false);
		assert.equal(listCanvasesInWorkspace('wsBind').length, 0, 'nothing registered');
		assert.equal(registerCanvas({ connectionId: id, canvasId: 'c1', accountId: 'owner' }), true);
		sse.fireClose();
	});

	test('unregisterCanvas with a mismatched accountId is rejected', () => {
		const sse = mockSseRes();
		const id = registerConnection({ accountId: 'owner', workspaceId: 'wsBind2', sseRes: sse });
		registerCanvas({ connectionId: id, canvasId: 'c1', accountId: 'owner' });
		assert.equal(unregisterCanvas({ connectionId: id, canvasId: 'c1', accountId: 'attacker' }), false);
		assert.equal(listCanvasesInWorkspace('wsBind2').length, 1, 'canvas still registered');
		sse.fireClose();
	});

	test('recordResponse with a mismatched accountId is rejected; request still resolvable by owner', async () => {
		const sse = mockSseRes();
		const id = registerConnection({ accountId: 'owner', workspaceId: 'wsBind3', sseRes: sse });
		registerCanvas({ connectionId: id, canvasId: 'c1', accountId: 'owner' });
		const p = dispatchRequest({ workspaceId: 'wsBind3', canvasId: 'c1', method: 'read_canvas', timeoutMs: 500 });
		const { requestId } = sse.lastDataEvent();
		assert.equal(
			recordResponse({ connectionId: id, requestId, result: { spoofed: true }, accountId: 'attacker' }),
			false,
			'spoofed response rejected',
		);
		assert.equal(
			recordResponse({ connectionId: id, requestId, result: { real: true }, accountId: 'owner' }),
			true,
			'owner response accepted',
		);
		assert.deepEqual(await p, { real: true });
		sse.fireClose();
	});

	test('omitting accountId preserves the legacy contract (no binding check)', () => {
		const sse = mockSseRes();
		const id = registerConnection({ accountId: 'owner', workspaceId: 'wsBind4', sseRes: sse });
		assert.equal(registerCanvas({ connectionId: id, canvasId: 'c1' }), true);
		sse.fireClose();
	});
});
