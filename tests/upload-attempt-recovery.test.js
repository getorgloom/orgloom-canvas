import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { uploadAttemptRecovery } from '../src/upload-attempt-recovery.js';
import { requestGraphBatches, parseGraphResults } from '../src/sf-graph.js';

test('checkpoints preserve 75 successes when request 2 loses its response; request 3 is never sent', async () => {
	const records = Array.from({ length: 151 }, (_, i) => ({ tempId: i, objectName: 'Contact' }));
	const graphs = records.map((r) => ({
		graphId: 'g' + r.tempId,
		compositeRequest: [{ referenceId: 'r' + r.tempId }],
	}));
	const recordsByRefId = new Map(records.map((r) => ['r' + r.tempId, r]));
	let calls = 0;
	const progress = { startedTempIds: [], results: [], intendedTempIds: records.map((r) => r.tempId) };
	await assert.rejects(
		requestGraphBatches({
			graphs,
			apiBase: '/api',
			conn: {
				request: async ({ body }) => {
					assert.equal(progress.startedTempIds.length, calls ? 150 : 75, 'intent precedes network write');
					if (++calls === 2) {
						assert.equal(progress.results.length, 75);
						throw new Error('lost response');
					}
					return {
						graphs: JSON.parse(body).graphs.map((g) => ({
							graphId: g.graphId,
							isSuccessful: true,
							graphResponse: {
								compositeResponse: [
									{
										referenceId: g.compositeRequest[0].referenceId,
										httpStatusCode: 201,
										body: { id: '003' + g.graphId },
									},
								],
							},
						})),
					};
				},
			},
			beforeBatch: async (batch) => {
				progress.startedTempIds.push(
					...batch.map((g) => recordsByRefId.get(g.compositeRequest[0].referenceId).tempId),
				);
			},
			afterBatch: async (batch, response) => {
				progress.results.push(...parseGraphResults({ graphs: batch, response, recordsByRefId }).results);
			},
		}),
		/lost response/,
	);
	progress.stopped = true;
	const recovery = uploadAttemptRecovery({
		graphProgress: progress,
		status: 'pending',
		insertedIds: progress.results.map((r) => ({ ...r, sfId: r.id })),
	});
	assert.equal(calls, 2);
	assert.equal(recovery.results.length, 75);
	assert.deepEqual(recovery.retryableTempIds, [150], 'only the never-started third request is retryable');
});

test('failed checkpoints stop requests, including before the very first write', async () => {
	for (const phase of ['beforeBatch', 'afterBatch']) {
		let calls = 0;
		const graphs = Array.from({ length: 76 }, (_, graphId) => ({ graphId, compositeRequest: [] }));
		await assert.rejects(
			requestGraphBatches({
				graphs,
				conn: {
					request: async ({ body }) => {
						calls++;
						return JSON.parse(body);
					},
				},
				[phase]: async () => {
					throw new Error('checkpoint unavailable');
				},
			}),
			/checkpoint unavailable/,
		);
		assert.equal(calls, phase === 'beforeBatch' ? 0 : 1);
	}
});

test('missing subresponses stop further batches even when every graph ID is present', async () => {
	let calls = 0;
	const records = Array.from({ length: 76 }, (_, tempId) => ({ tempId, objectName: 'Contact' }));
	const recordsByRefId = new Map(records.map((r) => ['r' + r.tempId, r]));
	const graphs = records.map((r) => ({
		graphId: 'g' + r.tempId,
		compositeRequest: [{ referenceId: 'r' + r.tempId }],
	}));
	const response = await requestGraphBatches({
		graphs,
		conn: {
			request: async ({ body }) => {
				calls++;
				return {
					graphs: JSON.parse(body).graphs.map((g) => ({
						graphId: g.graphId,
						isSuccessful: true,
						graphResponse: {},
					})),
				};
			},
		},
		afterBatch: async (batch, response) =>
			!parseGraphResults({ graphs: batch, response, recordsByRefId }).hasUnknownOutcome,
	});
	assert.equal(calls, 1);
	assert.equal(response.graphs.length, 75);
});

test('active or crashed attempts never release unsent records; stopped attempts release only known failures and unsent records', () => {
	const batch = {
		status: 'pending',
		graphProgress: {
			intendedTempIds: [1, 2, 3],
			startedTempIds: [1, 2],
			results: [
				{ tempId: 1, success: false, errorCode: 'GRAPH_ROLLED_BACK' },
				{ tempId: 2, success: false, errorCode: 'GRAPH_RESPONSE_INCOMPLETE' },
			],
		},
	};
	assert.deepEqual(uploadAttemptRecovery(batch).retryableTempIds, []);
	batch.graphProgress.stopped = true;
	assert.deepEqual(uploadAttemptRecovery(batch).retryableTempIds, [1, 3]);
	assert.deepEqual(uploadAttemptRecovery({ status: 'pending' }).retryableTempIds, []);
});

const context = { window: { OrgLoom: {} } };
vm.runInNewContext(fs.readFileSync(new URL('../src/public/js/upload-modal.js', import.meta.url), 'utf8'), context);
const { createUploadRecoveryJournal } = context.window.OrgLoom.uploadModal;
test('record locks survive a fresh dialog/page and remapped canvas IDs, with no business values stored', () => {
	const saved = new Map();
	const storage = { getItem: (key) => saved.get(key), setItem: (key, value) => saved.set(key, value) };
	const journal = () => createUploadRecoveryJournal(storage, 'org', 'user', () => 'stable-record');
	const record = { id: 1, objectName: 'Contact', values: { LastName: 'Sensitive' } };
	journal().track([record], 'attempt-1234567890');
	assert(![...saved.values()].join('').includes('Sensitive'));
	const restored = { id: 99, _canvasRecordId: record._canvasRecordId };
	assert.equal(journal().entries([restored])[0].entry.tempId, 1);
	assert.equal(journal().entries([{ id: 1, _canvasRecordId: 'unrelated' }]).length, 0);
	assert.equal(createUploadRecoveryJournal(storage, 'other-org', 'user', () => '').entries([record]).length, 0);
	// Saved canvas metadata also fences the record in a new session, even for another SF user.
	saved.clear();
	assert.equal(createUploadRecoveryJournal(storage, 'org', 'other-user', () => '').entries([record]).length, 1);
	journal().clear([record]);
	assert.equal(journal().entries([record]).length, 0);
});

test('unavailable recovery storage fails closed instead of silently permitting a new write', () => {
	const journal = createUploadRecoveryJournal(
		{
			getItem: () => null,
			setItem: () => {
				throw new Error('storage full');
			},
		},
		'o',
		'u',
		() => 'r',
	);
	assert.throws(() => journal.track([{ id: 1 }], 'attempt-1234567890'), /storage full/);
});
