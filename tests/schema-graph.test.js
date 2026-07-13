import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function mountSchemaGraph(csrfFetch) {
	const source = fs.readFileSync(new URL('../src/public/js/schema-graph.js', import.meta.url), 'utf8');
	const context = { window: {}, console, setTimeout, clearTimeout };
	vm.runInNewContext(source, context);
	const canvasState = { graphCache: {}, selectedObjects: [], hiddenObjects: new Set(), _prefetchedTypeNodeKeys: new Set(), _renderedRecIds: new Set() };
	const inertElement = { querySelector: () => null, classList: { add() {}, remove() {} } };
	return context.window.OrgLoom.schemaGraph.mount({
		canvasState,
		csrfFetch,
		escapeHtml: String,
		addToSelection: async () => {},
		renderAll() {},
		renderBulkView() {},
		renderCanvas() {},
		getGraph: () => inertElement,
	});
}

test('schema graph shares concurrent requests for the same object and caches success', async () => {
	let calls = 0;
	let release;
	const gate = new Promise((resolve) => {
 release = resolve; 
});
	const api = mountSchemaGraph(async () => {
		calls += 1;
		await gate;
		return { ok: true, json: async () => ({ name: 'Account', parents: [], children: [] }) };
	});

	const first = api.fetchGraphData('Account');
	const second = api.fetchGraphData('Account');
	assert.equal(calls, 1);
	release();
	assert.deepEqual(await first, await second);
	await api.fetchGraphData('Account');
	assert.equal(calls, 1, 'successful response is read from graphCache');
});

test('schema graph does not make a failed pending request sticky', async () => {
	let calls = 0;
	const api = mountSchemaGraph(async () => {
		calls += 1;
		if (calls === 1) {
throw new Error('network down');
}
		return { ok: true, json: async () => ({ name: 'Contact' }) };
	});

	await assert.rejects(api.fetchGraphData('Contact'), /network down/);
	assert.equal((await api.fetchGraphData('Contact')).name, 'Contact');
	assert.equal(calls, 2);
});
