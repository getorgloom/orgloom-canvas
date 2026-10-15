import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestGraphBatches, parseGraphResults } from '../src/sf-graph.js';
import { buildGraphSubRequest, graphRefIdFor, groupConnectedComponents, topoSortRecords } from '../src/sf-upload.js';

function fixture(count = 120) {
	const records = Array.from({ length: count }, (_, index) => ({
		tempId: index + 1,
		objectName: 'Contact',
		loadedFromId: '003' + String(index).padStart(12, '0'),
		loadedValues: { Description: 'Field services contact.', Contact_Type__c: 'Field Services' },
		values: { Description: null, Contact_Type__c: null },
	}));
	const account = { tempId: 0, objectName: 'Account', loadedFromId: '001000000000000' };
	const all = [account, ...records];
	const associations = records.map((record) => ({ fromId: record.tempId, toId: 0, fieldName: 'AccountId' }));
	const { order } = topoSortRecords(all, associations);
	const submittedIds = new Set(records.map((record) => record.tempId));
	const components = groupConnectedComponents(submittedIds, order, associations);
	const recordsById = new Map(all.map((record) => [record.tempId, record]));
	const describesByObject = new Map([
		[
			'Contact',
			{
				fields: ['Description', 'Contact_Type__c', 'AccountId'].map((name) => ({
					name,
					updateable: true,
					type: 'string',
				})),
			},
		],
	]);
	const graphs = components.map((ids, i) => ({
		graphId: 'g' + i,
		compositeRequest: ids.map((tempId) =>
			buildGraphSubRequest({
				rec: recordsById.get(tempId),
				tempId,
				apiBase: '/services/data/v67.0',
				associations,
				submittedIds,
				recordsById,
				describesByObject,
			}),
		),
	}));
	return { graphs, recordsByRefId: new Map(records.map((record) => [graphRefIdFor(record.tempId), record])) };
}

function success(graph) {
	return {
		graphId: graph.graphId,
		isSuccessful: true,
		graphResponse: {
			compositeResponse: graph.compositeRequest.map((request) => ({
				referenceId: request.referenceId,
				httpStatusCode: 204,
				body: null,
			})),
		},
	};
}

test('120 Contact clears linked to one unchanged Account are sent in 75 + 45 graphs and all reported', async () => {
	const input = fixture();
	const calls = [];
	const response = await requestGraphBatches({
		conn: {
			request: async (request) => {
				assert.equal(request.url, '/services/data/v67.0/composite/graph');
				assert.equal(request.headers['Sforce-Duplicate-Rule-Header'], 'allowSave=true');
				const batch = JSON.parse(request.body).graphs;
				assert(batch.length <= 75, 'Salesforce rejects more than 75 graphs');
				for (const graph of batch) {
					assert.equal(graph.compositeRequest[0].body.Description, null);
					assert.equal(graph.compositeRequest[0].body.Contact_Type__c, null);
				}
				calls.push(batch);
				return { graphs: batch.map(success).reverse() };
			},
		},
		apiBase: '/services/data/v67.0',
		graphs: input.graphs,
		allowDuplicates: true,
	});
	assert.deepEqual(
		calls.map((batch) => batch.length),
		[75, 45],
	);
	assert.equal(new Set(calls.flat().map((graph) => graph.graphId)).size, 120);
	const parsed = parseGraphResults({ ...input, response });
	assert.equal(parsed.results.length, 120);
	assert.equal(parsed.allAtomicSuccess, true);
	assert.equal(parsed.hasUnknownOutcome, false);
	assert(parsed.results.every((result) => result.success && result.mode === 'update'));
});

test('graph-level errors produce failures for every affected record instead of omitting them', () => {
	const input = fixture(2);
	const response = {
		graphs: input.graphs.map((graph) => ({
			graphId: graph.graphId,
			isSuccessful: false,
			graphResponse: [{ errorCode: 'LIMIT_EXCEEDED', message: 'Graph limit exceeded.' }],
		})),
	};
	const parsed = parseGraphResults({ ...input, response });
	assert.equal(parsed.results.length, 2);
	assert(parsed.results.every((result) => !result.success && result.errorCode === 'LIMIT_EXCEEDED'));
	assert.equal(parsed.hasUnknownOutcome, false);
	assert.equal(parsed.allAtomicSuccess, false);
});

test('a failed record rolls back its entire connected graph, preserving field errors', () => {
	const input = fixture(2);
	input.graphs[0].compositeRequest.push(...input.graphs.pop().compositeRequest);
	const response = {
		graphs: [
			{
				graphId: 'g0',
				isSuccessful: false,
				graphResponse: {
					compositeResponse: [
						{ referenceId: 'r1', httpStatusCode: 204 },
						{
							referenceId: 'r2',
							httpStatusCode: 400,
							body: [
								{
									errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
									message: 'Description is required.',
									fields: ['Description'],
								},
							],
						},
					],
				},
			},
		],
	};
	const parsed = parseGraphResults({ ...input, response });
	assert(parsed.results.every((result) => !result.success));
	assert.equal(parsed.results[1].error, 'Description is required.');
	assert.deepEqual(parsed.results[1].fields, ['Description']);
	assert.equal(parsed.hasUnknownOutcome, false);
});

test('missing or duplicate graphs and missing successful subresponses stay uncertain', () => {
	const input = fixture(2);
	for (const response of [
		{},
		{ graphs: [success(input.graphs[0])] },
		{ graphs: [success(input.graphs[0]), success(input.graphs[0])] },
		{ graphs: input.graphs.map((graph) => ({ graphId: graph.graphId, isSuccessful: true, graphResponse: {} })) },
	]) {
		const parsed = parseGraphResults({ ...input, response });
		assert.equal(parsed.results.length, 2);
		assert.equal(parsed.hasUnknownOutcome, true);
		assert.equal(parsed.allAtomicSuccess, false);
		assert(parsed.results.some((result) => result.errorCode === 'GRAPH_RESPONSE_INCOMPLETE'));
	}
});

test('an incomplete batch stops subsequent writes and retains all requested records in results', async () => {
	const input = fixture();
	let calls = 0;
	const response = await requestGraphBatches({
		conn: {
			request: async () => {
				calls++;
				return { graphs: [success(input.graphs[0])] };
			},
		},
		apiBase: '/services/data/v67.0',
		graphs: input.graphs,
	});
	assert.equal(calls, 1);
	const parsed = parseGraphResults({ ...input, response });
	assert.equal(parsed.results.length, 120);
	assert.equal(parsed.hasUnknownOutcome, true);
	assert.equal(parsed.results.filter((result) => result.success).length, 1);
});

test('a later request failure propagates without retrying already-submitted graphs', async () => {
	const input = fixture(151);
	let calls = 0;
	await assert.rejects(
		requestGraphBatches({
			conn: {
				request: async (request) => {
					if (++calls === 2) {
						throw new Error('Connection lost');
					}
					return { graphs: JSON.parse(request.body).graphs.map(success) };
				},
			},
			apiBase: '/services/data/v67.0',
			graphs: input.graphs,
		}),
		/Connection lost/,
	);
	assert.equal(calls, 2);
});

test('unchanged-only uploads do not send an empty Composite Graph request', async () => {
	const response = await requestGraphBatches({
		conn: { request: () => assert.fail('No writes expected') },
		graphs: [],
	});
	assert.deepEqual(response, { graphs: [] });
});
