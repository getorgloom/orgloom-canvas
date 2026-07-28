import { test, describe, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { initTestDb, clearTestDb, hasTestTable } from './helpers/db.js';

before(initTestDb);
beforeEach(async () => {
	await clearTestDb();
	const { _resetMcpTokenRateLimitForTests } = await import('../src/mcp/server.js');
	_resetMcpTokenRateLimitForTests();
});

const ERR_PARSE = -32700;
const ERR_INVALID_REQUEST = -32600;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INVALID_PARAMS = -32602;
const ERR_AUTH = -32001;
const ERR_FORBIDDEN = -32004;

function fakeRes() {
	const res = {
		statusCode: 200,
		body: undefined,
		ended: false,
		status(code) {
			this.statusCode = code;
			return this;
		},
		setHeader(name, value) {
			this.headers = this.headers || {};
			this.headers[name] = value;
			return this;
		},
		json(obj) {
			this.body = obj;
			this.ended = true;
			return this;
		},
		end() {
			this.ended = true;
			return this;
		},
	};
	return res;
}

function fakeSseRes() {
	const writes = [];
	const handlers = new Map();
	return {
		writes,
		write(chunk) {
			writes.push(chunk);
			return true;
		},
		on(event, handler) {
			handlers.set(event, handler);
		},
		fireClose() {
			const handler = handlers.get('close');
			if (handler) {
				handler();
			}
		},
		lastDataEvent() {
			for (let i = writes.length - 1; i >= 0; i--) {
				const match = writes[i].match(/^data: (.+)\n\n$/);
				if (match) {
					return JSON.parse(match[1]);
				}
			}
			return null;
		},
	};
}

async function waitForRequest(sse, method = 'describe_object') {
	for (let i = 0; i < 100; i++) {
		const event = sse.lastDataEvent();
		if (event && event.method === method) {
			return event;
		}
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	throw new Error('Timed out waiting for relay request: ' + method);
}

async function callMcp({ body, token }) {
	const { mcpHandler } = await import('../src/mcp/server.js');
	const headers = {};
	if (token !== undefined) {
		headers.authorization = token === null ? undefined : 'Bearer ' + token;
	}
	const req = { body, headers };
	const res = fakeRes();
	await mcpHandler(req, res);
	return res;
}

async function makeAccount(email = 'mcp@x.com') {
	const { accounts } = await import('../src/database/index.js');
	return (await accounts.upsertByEmail({ email })).account;
}

async function makeWorkspace(ownerAccountId, name = 'W') {
	const id = 'ws_' + crypto.randomUUID();
	if (!(await hasTestTable('workspace_members'))) {
		return { id };
	}
	const { ext } = await import('../src/extensions.js');
	const now = Date.now();
	await ext
		.getDb()
		.insertInto('workspaces')
		.values({
			id,
			name,
			owner_account_id: ownerAccountId,
			created_at: now,
			updated_at: now,
		})
		.execute();
	await ext
		.getDb()
		.insertInto('workspace_members')
		.values({
			workspace_id: id,
			account_id: ownerAccountId,
			role: 'admin',
			joined_at: now,
		})
		.execute();
	return { id };
}

async function makeMcpFixture() {
	const account = await makeAccount();
	const ws = await makeWorkspace(account.id);
	const mcpTokens = await import('../src/database/mcp-tokens.js');
	const issued = await mcpTokens.issue({ accountId: account.id, workspaceId: ws.id, name: 'test client' });
	return { account, ws, token: issued.plaintext, tokenId: issued.id };
}

function rpc(method, params, id = 1) {
	return { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) };
}

describe('envelope validation', () => {
	test('non-object body → ERR_PARSE', async () => {
		const res = await callMcp({ body: 'not json', token: 'irrelevant' });
		assert.equal(res.body.error.code, ERR_PARSE);
	});

	test("jsonrpc !== '2.0' → ERR_INVALID_REQUEST", async () => {
		const res = await callMcp({ body: { jsonrpc: '1.0', id: 1, method: 'ping' }, token: 'x' });
		assert.equal(res.body.error.code, ERR_INVALID_REQUEST);
	});

	test('notification (id == null) → 204, no body, no auth attempted', async () => {
		const res = await callMcp({ body: { jsonrpc: '2.0', method: 'ping' }, token: null });
		assert.equal(res.statusCode, 204);
		assert.equal(res.body, undefined);
	});

	test('unknown method → ERR_METHOD_NOT_FOUND', async () => {
		const { token } = await makeMcpFixture();
		const res = await callMcp({ body: rpc('resources/list'), token });
		assert.equal(res.body.error.code, ERR_METHOD_NOT_FOUND);
	});
});

describe('auth resolution', () => {
	test('missing Authorization header → ERR_AUTH with HTTP 401', async () => {
		const res = await callMcp({ body: rpc('ping'), token: null });
		assert.equal(res.body.error.code, ERR_AUTH);
		assert.equal(res.statusCode, 401);
	});

	test('non-Bearer scheme → ERR_AUTH', async () => {
		const { mcpHandler } = await import('../src/mcp/server.js');
		const res = fakeRes();
		await mcpHandler({ body: rpc('ping'), headers: { authorization: 'Basic abc' } }, res);
		assert.equal(res.body.error.code, ERR_AUTH);
	});

	test('well-formed but unknown token → ERR_AUTH', async () => {
		const res = await callMcp({ body: rpc('ping'), token: 'ol_mcp_' + '0'.repeat(64) });
		assert.equal(res.body.error.code, ERR_AUTH);
	});

	test('revoked token → ERR_AUTH with HTTP 401', async () => {
		const { account, token, tokenId } = await makeMcpFixture();
		const mcpTokens = await import('../src/database/mcp-tokens.js');
		await mcpTokens.revoke(tokenId, account.id);
		const res = await callMcp({ body: rpc('ping'), token });
		assert.equal(res.body.error.code, ERR_AUTH);
		assert.equal(res.statusCode, 401);
	});

	test('token of a soft-deleted account → ERR_AUTH', async () => {
		const { account, token } = await makeMcpFixture();
		const { accounts } = await import('../src/database/index.js');
		await accounts.softDelete(account.id);
		const res = await callMcp({ body: rpc('ping'), token });
		assert.equal(res.body.error.code, ERR_AUTH);
	});

	test('token is rejected after its owner loses workspace membership', async () => {
		const { account, ws, token } = await makeMcpFixture();
		if (!(await hasTestTable('workspace_members'))) {
			return;
		}
		const { ext } = await import('../src/extensions.js');
		await ext
			.getDb()
			.deleteFrom('workspace_members')
			.where('workspace_id', '=', ws.id)
			.where('account_id', '=', account.id)
			.execute();

		const res = await callMcp({ body: rpc('ping'), token });
		assert.equal(res.statusCode, 401);
		assert.equal(res.body.error.code, ERR_AUTH);
		assert.match(res.body.error.message, /no longer a member/);
	});

	test('expired token is rejected before every request method is dispatched', async () => {
		const { token, tokenId } = await makeMcpFixture();
		const { ext } = await import('../src/extensions.js');
		await ext
			.getDb()
			.updateTable('mcp_tokens')
			.set({ expires_at: Date.now() - 1 })
			.where('id', '=', tokenId)
			.execute();

		for (const body of [
			rpc('initialize'),
			rpc('ping'),
			rpc('tools/list'),
			rpc('tools/call', { name: 'list_canvases', arguments: {} }),
			rpc('unknown/method'),
		]) {
			const res = await callMcp({ body, token });
			assert.equal(res.statusCode, 401);
			assert.equal(res.body.error.code, ERR_AUTH);
			assert.match(res.body.error.message, /expired/);
		}
	});

	test('workspace switch does not retarget an existing token', async (t) => {
		if (!(await hasTestTable('workspace_members'))) {
			t.skip('hosted workspace overlay is not installed');
			return;
		}
		const { account, ws, token } = await makeMcpFixture();
		const other = await makeWorkspace(account.id, 'Other');
		const viewState = await import('../src/database/view-state.js');
		await viewState.setCurrentWorkspace(account.id, other.id);

		const res = await callMcp({ body: rpc('tools/call', { name: 'list_canvases', arguments: {} }), token });
		assert.ok(res.body.result, 'token remains usable in its issued workspace');
		const { audit } = await import('../src/database/index.js');
		const originalEvents = await audit.list({ workspaceId: ws.id });
		const otherEvents = await audit.list({ workspaceId: other.id });
		assert.ok(originalEvents.some((event) => event.action === 'mcp_tool_call'));
		assert.equal(
			otherEvents.some((event) => event.action === 'mcp_tool_call'),
			false,
		);
	});
});

describe('protocol methods', () => {
	test('initialize returns protocolVersion + serverInfo + tools capability', async () => {
		const { token } = await makeMcpFixture();
		const res = await callMcp({ body: rpc('initialize'), token });
		assert.ok(res.body.result.protocolVersion, 'protocolVersion present');
		assert.equal(res.body.result.serverInfo.name, 'orgloom');
		assert.ok(res.body.result.capabilities.tools, 'declares tools capability');
	});

	test('ping returns an empty result', async () => {
		const { token } = await makeMcpFixture();
		const res = await callMcp({ body: rpc('ping'), token });
		assert.deepEqual(res.body.result, {});
	});

	test('tools/list returns every registered tool with a name + inputSchema', async () => {
		const { token } = await makeMcpFixture();
		const res = await callMcp({ body: rpc('tools/list'), token });
		const tools = res.body.result.tools;
		assert.ok(Array.isArray(tools) && tools.length >= 11, 'expected ≥11 tools, got ' + tools.length);
		const names = tools.map((t) => t.name);
		for (const expected of [
			'list_canvases',
			'read_canvas',
			'propose_record_changes',
			'list_pending_proposals',
			'describe_object',
			'withdraw_proposal',
			'read_proposal_outcome',
			'get_canvas_summary',
			'get_my_capabilities',
			'request_clarification',
			'read_clarification',
		]) {
			assert.ok(names.includes(expected), 'tool registered: ' + expected);
		}
		for (const t of tools) {
			assert.ok(t.description, t.name + ' has a description');
			assert.ok(t.inputSchema, t.name + ' has an inputSchema');
		}
		const propose = tools.find((tool) => tool.name === 'propose_record_changes');
		assert.match(propose.description, /describe_object/);
		assert.match(propose.description, /date fields use YYYY-MM-DD/);
		assert.match(propose.description, /datetime fields require a complete ISO 8601 timestamp/);
		assert.match(propose.description, /new-association replaces that relationship/);
		assert.match(propose.description, /Do not repeat unchanged name or identity fields/);
		assert.match(propose.inputSchema.properties.changes.items.properties.fields.description, /describe_object/);
		const describe = tools.find((tool) => tool.name === 'describe_object');
		assert.match(describe.description, /Do not infer date versus datetime/);
		assert.ok(describe.inputSchema.properties.canvasId);
		const list = tools.find((tool) => tool.name === 'list_canvases');
		assert.match(list.description, /DO NOT choose based on list order/);
		const read = tools.find((tool) => tool.name === 'read_canvas');
		assert.match(read.inputSchema.properties.canvasId.description, /ask which canvas to use/);
		assert.match(
			propose.inputSchema.properties.canvasId.description,
			/ask which canvas the proposal should apply to/,
		);
	});

	test('response echoes the request id', async () => {
		const { token } = await makeMcpFixture();
		const res = await callMcp({ body: rpc('ping', undefined, 'req-42'), token });
		assert.equal(res.body.id, 'req-42');
	});
});

describe('tools/call', () => {
	test('list_canvases excludes another account browser in the same workspace', async () => {
		const { account, ws, token } = await makeMcpFixture();
		const otherAccount = await makeAccount('other-mcp@x.com');
		if (await hasTestTable('workspace_members')) {
			const { ext } = await import('../src/extensions.js');
			await ext
				.getDb()
				.insertInto('workspace_members')
				.values({
					workspace_id: ws.id,
					account_id: otherAccount.id,
					role: 'member',
					joined_at: Date.now(),
				})
				.execute();
		}
		const relay = await import('../src/mcp/relay.js');
		const ownerSse = fakeSseRes();
		const otherSse = fakeSseRes();
		const ownerConnectionId = relay.registerConnection({
			accountId: account.id,
			workspaceId: ws.id,
			sseRes: ownerSse,
		});
		const otherConnectionId = relay.registerConnection({
			accountId: otherAccount.id,
			workspaceId: ws.id,
			sseRes: otherSse,
		});
		relay.registerCanvas({
			connectionId: ownerConnectionId,
			canvasId: '001000000000011AAA',
			accountId: account.id,
			meta: { title: 'Mine' },
		});
		relay.registerCanvas({
			connectionId: otherConnectionId,
			canvasId: '001000000000012AAA',
			accountId: otherAccount.id,
			meta: { title: 'Not mine' },
		});

		try {
			const response = await callMcp({
				body: rpc('tools/call', { name: 'list_canvases', arguments: {} }),
				token,
			});
			const payload = JSON.parse(response.body.result.content[0].text);
			assert.deepEqual(
				payload.canvases.map((canvas) => canvas.id),
				['001000000000011AAA'],
			);
		} finally {
			ownerSse.fireClose();
			otherSse.fireClose();
		}
	});

	test('list_canvases tells the AI to ask the user when several canvases are open', async () => {
		const { account, ws, token } = await makeMcpFixture();
		const relay = await import('../src/mcp/relay.js');
		const first = fakeSseRes();
		const second = fakeSseRes();
		const firstConnectionId = relay.registerConnection({
			accountId: account.id,
			workspaceId: ws.id,
			sseRes: first,
		});
		const secondConnectionId = relay.registerConnection({
			accountId: account.id,
			workspaceId: ws.id,
			sseRes: second,
		});
		relay.registerCanvas({
			connectionId: firstConnectionId,
			canvasId: '001000000000001AAA',
			meta: { title: 'First canvas' },
		});
		relay.registerCanvas({
			connectionId: secondConnectionId,
			canvasId: '001000000000002AAA',
			meta: { title: 'Second canvas' },
		});

		try {
			const response = await callMcp({
				body: rpc('tools/call', { name: 'list_canvases', arguments: {} }),
				token,
			});
			const payload = JSON.parse(response.body.result.content[0].text);
			assert.equal(payload.canvases.length, 2);
			assert.match(payload.selectionGuidance, /ask which canvas to use/);
			assert.match(payload.selectionGuidance, /Do not choose based on list order/);
		} finally {
			first.fireClose();
			second.fireClose();
		}
	});

	test('describe_object targets the requested canvas and returns its cached field type', async () => {
		const { account, ws, token } = await makeMcpFixture();
		const relay = await import('../src/mcp/relay.js');
		const sse = fakeSseRes();
		const connectionId = relay.registerConnection({ accountId: account.id, workspaceId: ws.id, sseRes: sse });
		const canvasId = 'draft-11111111-1111-4111-8111-111111111111';
		relay.registerCanvas({ connectionId, canvasId, accountId: account.id });

		try {
			const responsePromise = callMcp({
				body: rpc('tools/call', {
					name: 'describe_object',
					arguments: { canvasId, objectName: 'OLQA_Issue__c', fields: ['Opened_At__c'] },
				}),
				token,
			});
			const request = await waitForRequest(sse);
			assert.equal(request.canvasId, canvasId);
			assert.deepEqual(request.params, { objectName: 'OLQA_Issue__c', fields: ['Opened_At__c'] });
			relay.recordResponse({
				connectionId,
				requestId: request.requestId,
				result: { fields: [{ name: 'Opened_At__c', type: 'datetime' }] },
				accountId: account.id,
			});

			const response = await responsePromise;
			assert.equal(response.body.error, undefined);
			assert.equal(response.body.result.isError, undefined);
			assert.deepEqual(JSON.parse(response.body.result.content[0].text), {
				fields: [{ name: 'Opened_At__c', type: 'datetime' }],
			});
		} finally {
			sse.fireClose();
		}
	});

	test('describe_object reports a cache miss as an actionable tool error', async () => {
		const { account, ws, token } = await makeMcpFixture();
		const relay = await import('../src/mcp/relay.js');
		const sse = fakeSseRes();
		const connectionId = relay.registerConnection({ accountId: account.id, workspaceId: ws.id, sseRes: sse });
		const canvasId = 'draft-22222222-2222-4222-8222-222222222222';
		relay.registerCanvas({ connectionId, canvasId, accountId: account.id });

		try {
			const responsePromise = callMcp({
				body: rpc('tools/call', {
					name: 'describe_object',
					arguments: { canvasId, objectName: 'Missing__c' },
				}),
				token,
			});
			const request = await waitForRequest(sse);
			relay.recordResponse({
				connectionId,
				requestId: request.requestId,
				result: { cacheMiss: true },
				accountId: account.id,
			});

			const response = await responsePromise;
			assert.equal(response.body.error, undefined);
			assert.equal(response.body.result.isError, true);
			assert.match(response.body.result.content[0].text, /add an example 'Missing__c' record/);
			assert.match(response.body.result.content[0].text, /retry describe_object with the canvasId/);
		} finally {
			sse.fireClose();
		}
	});

	test('describe_object without canvasId tries every open canvas cache', async () => {
		const { account, ws, token } = await makeMcpFixture();
		const relay = await import('../src/mcp/relay.js');
		const first = fakeSseRes();
		const second = fakeSseRes();
		const firstConnectionId = relay.registerConnection({
			accountId: account.id,
			workspaceId: ws.id,
			sseRes: first,
		});
		const secondConnectionId = relay.registerConnection({
			accountId: account.id,
			workspaceId: ws.id,
			sseRes: second,
		});
		relay.registerCanvas({ connectionId: firstConnectionId, canvasId: '001000000000001AAA' });
		relay.registerCanvas({ connectionId: secondConnectionId, canvasId: '001000000000002AAA' });

		try {
			const responsePromise = callMcp({
				body: rpc('tools/call', {
					name: 'describe_object',
					arguments: { objectName: 'OLQA_Issue__c', fields: ['Opened_At__c'] },
				}),
				token,
			});
			const firstRequest = await waitForRequest(first);
			relay.recordResponse({
				connectionId: firstConnectionId,
				requestId: firstRequest.requestId,
				result: { cacheMiss: true },
			});
			const secondRequest = await waitForRequest(second);
			relay.recordResponse({
				connectionId: secondConnectionId,
				requestId: secondRequest.requestId,
				result: { fields: [{ name: 'Opened_At__c', type: 'datetime' }] },
			});

			const response = await responsePromise;
			assert.equal(response.body.result.isError, undefined);
			assert.equal(JSON.parse(response.body.result.content[0].text).fields[0].type, 'datetime');
		} finally {
			first.fireClose();
			second.fireClose();
		}
	});

	test('propose_record_changes strips unchanged fields but keeps relationship changes', async () => {
		const { account, ws, token } = await makeMcpFixture();
		const relay = await import('../src/mcp/relay.js');
		const proposals = await import('../src/mcp/proposals-store.js');
		const sse = fakeSseRes();
		const connectionId = relay.registerConnection({ accountId: account.id, workspaceId: ws.id, sseRes: sse });
		const canvasId = 'draft-33333333-3333-4333-8333-333333333333';
		relay.registerCanvas({ connectionId, canvasId, accountId: account.id });

		try {
			const responsePromise = callMcp({
				body: rpc('tools/call', {
					name: 'propose_record_changes',
					arguments: {
						canvasId,
						changes: [
							{
								recordId: '003000000000020AAA',
								objectName: 'Contact',
								fields: { FirstName: 'Contact', LastName: 'Two' },
							},
							{
								kind: 'new-association',
								fieldName: 'AccountId',
								from: { recordId: '003000000000020AAA' },
								to: { tempId: 21 },
							},
						],
					},
				}),
				token,
			});
			const request = await waitForRequest(sse, 'read_canvas');
			relay.recordResponse({
				connectionId,
				requestId: request.requestId,
				result: {
					payload: {
						loadedRecords: [
							{
								objectName: 'Contact',
								loadedFromId: '003000000000020AAA',
								values: { Id: '003000000000020AAA', FirstName: 'Contact', LastName: 'Two' },
							},
						],
						drafts: [{ tempId: 21, objectName: 'Account', values: { Name: 'New Account' } }],
						associations: [],
					},
				},
				accountId: account.id,
			});

			const response = await responsePromise;
			assert.equal(response.body.error, undefined);
			const result = JSON.parse(response.body.result.content[0].text);
			const pending = await proposals.findById(result.proposalId);
			assert.deepEqual(pending.changes, [
				{
					kind: 'new-association',
					fieldName: 'AccountId',
					from: { kind: 'loaded', ref: '003000000000020AAA' },
					to: { kind: 'draft', ref: 21 },
				},
			]);
			assert.match(sse.writes.join(''), /event: ai-proposals-changed/);
			assert.deepEqual(sse.lastDataEvent(), { canvasId });
		} finally {
			sse.fireClose();
		}
	});

	test('propose_record_changes rejects a proposal containing only unchanged fields', async () => {
		const { account, ws, token } = await makeMcpFixture();
		const relay = await import('../src/mcp/relay.js');
		const sse = fakeSseRes();
		const connectionId = relay.registerConnection({ accountId: account.id, workspaceId: ws.id, sseRes: sse });
		const canvasId = 'draft-44444444-4444-4444-8444-444444444444';
		relay.registerCanvas({ connectionId, canvasId, accountId: account.id });

		try {
			const responsePromise = callMcp({
				body: rpc('tools/call', {
					name: 'propose_record_changes',
					arguments: {
						canvasId,
						changes: [
							{
								recordId: '003000000000020AAA',
								objectName: 'Contact',
								fields: { FirstName: 'Contact', LastName: 'Two' },
							},
						],
					},
				}),
				token,
			});
			const request = await waitForRequest(sse, 'read_canvas');
			relay.recordResponse({
				connectionId,
				requestId: request.requestId,
				result: {
					payload: {
						loadedRecords: [
							{
								objectName: 'Contact',
								loadedFromId: '003000000000020AAA',
								values: { Id: '003000000000020AAA', FirstName: 'Contact', LastName: 'Two' },
							},
						],
						drafts: [],
						associations: [],
					},
				},
				accountId: account.id,
			});

			const response = await responsePromise;
			assert.equal(response.body.error.code, ERR_INVALID_PARAMS);
			assert.match(response.body.error.message, /no effective changes/);
		} finally {
			sse.fireClose();
		}
	});

	test('per-token throttle returns HTTP 429', async () => {
		const { token } = await makeMcpFixture();
		for (let i = 0; i < 120; i++) {
			const allowed = await callMcp({ body: rpc('ping', undefined, i), token });
			assert.equal(allowed.statusCode, 200);
		}
		const blocked = await callMcp({ body: rpc('ping', undefined, 121), token });
		assert.equal(blocked.statusCode, 429);
		assert.equal(blocked.body.error.code, -32006);
		assert.equal(blocked.headers['Retry-After'], '60');
	});
	test('missing tool name → ERR_INVALID_PARAMS', async () => {
		const { token } = await makeMcpFixture();
		const res = await callMcp({ body: rpc('tools/call', {}), token });
		assert.equal(res.body.error.code, ERR_INVALID_PARAMS);
	});

	test('unknown tool → ERR_METHOD_NOT_FOUND', async () => {
		const { token } = await makeMcpFixture();
		const res = await callMcp({ body: rpc('tools/call', { name: 'delete_everything' }), token });
		assert.equal(res.body.error.code, ERR_METHOD_NOT_FOUND);
	});

	test('list_canvases succeeds with no live browsers and writes an mcp_tool_call audit row', async () => {
		const { ws, token, tokenId } = await makeMcpFixture();
		const res = await callMcp({ body: rpc('tools/call', { name: 'list_canvases', arguments: {} }), token });
		assert.ok(res.body.result, 'tool call succeeded: ' + JSON.stringify(res.body.error || null));
		assert.ok(Array.isArray(res.body.result.content), 'MCP content array shape');
		const { audit } = await import('../src/database/index.js');
		const events = await audit.list({ workspaceId: ws.id });
		const call = events.find((e) => e.action === 'mcp_tool_call');
		assert.ok(call, 'mcp_tool_call audit row written');
		assert.equal(call.actorKind, 'mcp');
		assert.equal(call.mcpTokenId, tokenId);
		assert.equal(call.payload.tool, 'list_canvases');
	});

	test('capability denial → ERR_FORBIDDEN with the resolver reason; no mcp_tool_call row', async () => {
		const { ext } = await import('../src/extensions.js');
		const { ws, token } = await makeMcpFixture();
		const originalResolver = ext.getCapability;
		ext.registerCapabilityResolver(async () => ({ allowed: false, reason: 'workspace-toggle-off' }));
		try {
			const res = await callMcp({ body: rpc('tools/call', { name: 'list_canvases', arguments: {} }), token });
			assert.equal(res.body.error.code, ERR_FORBIDDEN);
			assert.match(res.body.error.message, /workspace-toggle-off/);
			const { audit } = await import('../src/database/index.js');
			const events = await audit.list({ workspaceId: ws.id });
			assert.ok(!events.some((e) => e.action === 'mcp_tool_call'), 'no success audit row on denial');
		} finally {
			ext.registerCapabilityResolver(originalResolver);
		}
	});

	test('a tool handler failure writes mcp_tool_call_failed and surfaces the error', async () => {
		const { ws, token } = await makeMcpFixture();
		const res = await callMcp({
			body: rpc('tools/call', { name: 'read_canvas', arguments: { canvasId: 'cv_nope' } }),
			token,
		});
		assert.ok(res.body.error, 'tool call failed as expected');
		const { audit } = await import('../src/database/index.js');
		const events = await audit.list({ workspaceId: ws.id });
		const failed = events.find((e) => e.action === 'mcp_tool_call_failed');
		assert.ok(failed, 'mcp_tool_call_failed audit row written');
		assert.equal(failed.payload.tool, 'read_canvas');
	});
});
