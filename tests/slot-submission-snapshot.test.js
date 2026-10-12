import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectSlotSubmissionPayload } from '../src/slot-helpers.js';

const durablePayload = {
	loadedRecords: [],
	drafts: [],
	associations: [],
};

const liveRequestPayload = {
	loadedRecords: [],
	drafts: [
		{
			tempId: 'request-opportunity',
			objectName: 'Opportunity',
			values: {},
			slot: {
				slotId: 'slot-opportunity',
				kind: 'whole-record',
				assigneeSfUserId: '005000000000001AAA',
			},
		},
	],
	associations: [],
};

test('live contributor commits validate against requests created after the last canvas save', () => {
	const selected = selectSlotSubmissionPayload({
		durablePayload,
		liveSnapshot: { payload: liveRequestPayload, revision: 4 },
		liveCommit: {
			connectionId: 'connection-1',
			targetRef: { refKind: 'slot', ref: 'slot-opportunity' },
		},
		slotIds: ['slot-opportunity'],
	});

	assert.equal(selected, liveRequestPayload);
	assert.equal(selected.drafts[0].slot.slotId, 'slot-opportunity');
});

test('legacy submissions without a collaboration lease remain bound to the durable canvas', () => {
	const selected = selectSlotSubmissionPayload({
		durablePayload,
		liveSnapshot: { payload: liveRequestPayload, revision: 4 },
		liveCommit: null,
		slotIds: ['slot-opportunity'],
	});

	assert.equal(selected, durablePayload);
	assert.deepEqual(selected.drafts, []);
});

test('incomplete live commit identity cannot opt into an unsaved snapshot', () => {
	const selected = selectSlotSubmissionPayload({
		durablePayload,
		liveSnapshot: { payload: liveRequestPayload, revision: 4 },
		liveCommit: { connectionId: 'connection-1' },
		slotIds: ['slot-opportunity'],
	});

	assert.equal(selected, durablePayload);
});

test('a live commit cannot select a snapshot for a different request', () => {
	const selected = selectSlotSubmissionPayload({
		durablePayload,
		liveSnapshot: { payload: liveRequestPayload, revision: 4 },
		liveCommit: {
			connectionId: 'connection-1',
			targetRef: { refKind: 'slot', ref: 'another-slot' },
		},
		slotIds: ['slot-opportunity'],
	});

	assert.equal(selected, durablePayload);
});
