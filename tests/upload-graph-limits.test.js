import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { GRAPH_PER_GRAPH_CAP, GRAPH_TOTAL_NODES_CAP, groupConnectedComponents } from '../src/sf-upload.js';
import { GRAPH_REQUEST_CAP, requestGraphBatches } from '../src/sf-graph.js';

const client = fs.readFileSync(new URL('../src/public/js/upload-modal.js', import.meta.url), 'utf8');
const server = fs.readFileSync(new URL('../src/canvas-routes.js', import.meta.url), 'utf8');
const clientCaps = client.slice(
	client.indexOf('const PER_COMPONENT_CAP ='),
	client.indexOf('const components = (() =>'),
);
const clientGate = client.slice(client.indexOf('const fitsGraph ='), client.indexOf('if (fitsGraph && !hasUpsert)'));
const serverStart = server.indexOf('const components = groupConnectedComponents(submittedIds, order, associations);');
const serverEnd = server.indexOf('try {', serverStart);

function inspectLimits(groupSizes, payloadBytes = 1) {
	const ids = [];
	const associations = [];
	for (const size of groupSizes) {
		const root = ids.length + 1;
		for (let n = 0; n < size; n++) {
			const id = ids.length + 1;
			ids.push(id);
			if (n) {
				associations.push({ fromId: id, toId: root, fieldName: 'AccountId' });
			}
		}
	}
	const clientContext = {
		uploadingCountForGate: ids.length,
		maxComponentSize: Math.max(...groupSizes),
		payloadJson: { length: payloadBytes },
		confirmBtn: {},
		content: {},
		escapeHtml: String,
	};
	vm.runInNewContext(`result = (() => { ${clientCaps} ${clientGate} return 'allowed'; })()`, clientContext);
	let rejection;
	const serverContext = {
		submittedIds: new Set(ids),
		order: ids,
		associations,
		groupConnectedComponents,
		GRAPH_PER_GRAPH_CAP,
		GRAPH_TOTAL_NODES_CAP,
		res: {
			status: (status) => ({
				json: (body) => {
					rejection = { status, ...body };
				},
			}),
		},
	};
	vm.runInNewContext(
		`result = (() => { ${server.slice(serverStart, serverEnd)} return 'allowed'; })()`,
		serverContext,
	);
	return {
		client: clientContext.result,
		clientMessage: clientContext.content.innerHTML,
		server: serverContext.result,
		rejection,
	};
}

for (const count of [76, 203, 500]) {
	test(`client and server admit a connected group of ${count} operations`, () => {
		const result = inspectLimits([count]);
		assert.equal(result.client, 'allowed');
		assert.equal(result.server, 'allowed');
		assert.equal(result.rejection, undefined);
	});
}

test('client and server retain the 500-operation limit for one or multiple groups', () => {
	for (const groups of [[501], [250, 251]]) {
		const result = inspectLimits(groups);
		assert.equal(result.client, undefined);
		assert.match(result.clientMessage, /500/);
		assert.equal(result.rejection.status, 400);
		assert.equal(
			result.rejection.error,
			groups.length === 1 ? 'graph-component-too-large' : 'graph-total-too-large',
		);
	}
});

test('larger connected groups do not bypass the client payload-size limit', () => {
	const result = inspectLimits([203], 5 * 1024 * 1024 + 1);
	assert.equal(result.client, undefined);
	assert.match(result.clientMessage, /payload is/);
});

test('500 operations stay in one graph while 75 remains the separate graph-count cap', async () => {
	assert.equal(GRAPH_REQUEST_CAP, 75);
	const graph = {
		graphId: 'connected',
		compositeRequest: Array.from({ length: 500 }, (_, i) => ({ referenceId: `r${i}` })),
	};
	const calls = [];
	await requestGraphBatches({
		conn: {
			request: async (request) => {
				const batch = JSON.parse(request.body).graphs;
				calls.push(batch);
				return { graphs: batch.map(({ graphId }) => ({ graphId })) };
			},
		},
		apiBase: '/services/data/v68.0',
		graphs: [graph],
	});
	assert.equal(calls.length, 1);
	assert.equal(calls[0].length, 1);
	assert.equal(calls[0][0].compositeRequest.length, 500);
});
