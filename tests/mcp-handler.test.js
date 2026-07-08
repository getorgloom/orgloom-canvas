import { test, describe, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { initTestDb, clearTestDb } from './helpers/db.js';

before(initTestDb);
beforeEach(clearTestDb);

const ERR_PARSE = -32700;
const ERR_INVALID_REQUEST = -32600;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INVALID_PARAMS = -32602;
const ERR_AUTH = -32001;
const ERR_NO_WORKSPACE = -32002;
const ERR_FORBIDDEN = -32004;

function fakeRes() {
	const res = {
		statusCode: 200,
		body: undefined,
		ended: false,
		status(code) { this.statusCode = code; return this; },
		json(obj) { this.body = obj; this.ended = true; return this; },
		end() { this.ended = true; return this; },
	};
	return res;
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
	const { ext } = await import('../src/extensions.js');
	const db = ext.getDb();
	const id = 'ws_' + crypto.randomUUID();
	const now = Date.now();
	await db.insertInto('workspaces').values({
		id, name, owner_account_id: ownerAccountId,
		created_at: now, updated_at: now,
	}).execute();

	await db.insertInto('workspace_members').values({
		workspace_id: id, account_id: ownerAccountId, role: 'admin', joined_at: now,
	}).execute();
	return { id };
}

async function makeMcpFixture() {
	const account = await makeAccount();
	const ws = await makeWorkspace(account.id);
	const viewState = await import('../src/database/view-state.js');
	await viewState.setCurrentWorkspace(account.id, ws.id);
	const mcpTokens = await import('../src/database/mcp-tokens.js');
	const issued = await mcpTokens.issue({ accountId: account.id, name: 'test client' });
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

	test('valid token but no active workspace → ERR_NO_WORKSPACE', async () => {
		const account = await makeAccount();
		const mcpTokens = await import('../src/database/mcp-tokens.js');
		const issued = await mcpTokens.issue({ accountId: account.id, name: 't' });
		const res = await callMcp({ body: rpc('ping'), token: issued.plaintext });
		assert.equal(res.body.error.code, ERR_NO_WORKSPACE);
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
			'list_canvases', 'read_canvas', 'propose_record_changes',
			'list_pending_proposals', 'describe_object', 'withdraw_proposal',
			'read_proposal_outcome', 'get_canvas_summary', 'get_my_capabilities',
			'request_clarification', 'read_clarification',
		]) {
			assert.ok(names.includes(expected), 'tool registered: ' + expected);
		}
		for (const t of tools) {
			assert.ok(t.description, t.name + ' has a description');
			assert.ok(t.inputSchema, t.name + ' has an inputSchema');
		}
	});

	test('response echoes the request id', async () => {
		const { token } = await makeMcpFixture();
		const res = await callMcp({ body: rpc('ping', undefined, 'req-42'), token });
		assert.equal(res.body.id, 'req-42');
	});
});

describe('tools/call', () => {
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

		const res = await callMcp({ body: rpc('tools/call', { name: 'read_canvas', arguments: { canvasId: 'cv_nope' } }), token });
		assert.ok(res.body.error, 'tool call failed as expected');
		const { audit } = await import('../src/database/index.js');
		const events = await audit.list({ workspaceId: ws.id });
		const failed = events.find((e) => e.action === 'mcp_tool_call_failed');
		assert.ok(failed, 'mcp_tool_call_failed audit row written');
		assert.equal(failed.payload.tool, 'read_canvas');
	});
});
