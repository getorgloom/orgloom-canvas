import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const routeSource = readFileSync(new URL('../src/canvas-routes.js', import.meta.url), 'utf8');
const mcpSource = readFileSync(new URL('../src/mcp/server.js', import.meta.url), 'utf8');
const presenceSource = readFileSync(new URL('../src/public/js/presence.js', import.meta.url), 'utf8');

function route(start, end) {
	const startIndex = routeSource.indexOf(start);
	assert.ok(startIndex >= 0, `missing route: ${start}`);
	const endIndex = routeSource.indexOf(end, startIndex + start.length);
	return routeSource.slice(startIndex, endIndex >= 0 ? endIndex : undefined);
}

test('browser AI queues are scoped to the account that created them', () => {
	const proposalList = route(
		"app.get('/api/canvas/:id/proposals'",
		"app.post(\n\t\t'/api/canvas/:id/proposals/:proposalId/apply'",
	);
	assert.match(proposalList, /p\.proposingAccountId === req\.account\.id/);

	const proposalApply = route(
		"'/api/canvas/:id/proposals/:proposalId/apply'",
		"app.post('/api/canvas/:id/proposals/:proposalId/reject'",
	);
	assert.match(proposalApply, /proposal\.proposingAccountId !== req\.account\.id/);
	assert.match(proposalApply, /accountId: req\.account\.id,[\s\S]*method: 'read_canvas'/);

	const proposalReject = route(
		"app.post('/api/canvas/:id/proposals/:proposalId/reject'",
		"app.get('/api/canvas/:id/clarifications'",
	);
	assert.match(proposalReject, /proposal\.proposingAccountId !== req\.account\.id/);

	const clarificationList = route(
		"app.get('/api/canvas/:id/clarifications'",
		"app.post('/api/canvas/:id/clarifications/:clarificationId/respond'",
	);
	assert.match(clarificationList, /c\.requestingAccountId === req\.account\.id/);

	const clarificationRespond = route(
		"app.post('/api/canvas/:id/clarifications/:clarificationId/respond'",
		"app.get('/api/canvas/:id/presence/subscribe'",
	);
	assert.match(clarificationRespond, /row\.requestingAccountId !== req\.account\.id/);
});

test('unsaved draft identifiers cannot open collaboration presence streams', () => {
	const presenceRoute = route(
		"app.get('/api/canvas/:id/presence/subscribe'",
		"app.post('/api/canvas/:id/presence/cursor'",
	);
	const draftDenial = presenceRoute.indexOf('if (isDraft)');
	const streamOpen = presenceRoute.indexOf("res.setHeader('Content-Type', 'text/event-stream')");
	assert.ok(draftDenial >= 0 && draftDenial < streamOpen);
	assert.match(presenceRoute, /Live collaboration is available after the canvas is saved and shared/);
	assert.match(presenceSource, /function _savedCanvasId\(value\)/);
	assert.match(presenceSource, /return _savedCanvasId\(c && c\.canvasId\)/);
});

test('MCP authentication rechecks current workspace membership', () => {
	const contextStart = mcpSource.indexOf('async function _resolveContext(req)');
	assert.ok(contextStart >= 0);
	const contextSource = mcpSource.slice(contextStart);
	assert.match(contextSource, /\.selectFrom\('workspace_members'\)/);
	assert.match(contextSource, /\.where\('workspace_id', '=', workspaceId\)/);
	assert.match(contextSource, /\.where\('account_id', '=', account\.id\)/);
	assert.match(contextSource, /Token owner is no longer a member of this workspace/);
});
