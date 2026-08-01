import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
	subscribe,
	unsubscribe,
	updateCursor,
	updateDraft,
	updateLoadedRecord,
	updateSlot,
	updateDraftLink,
	removeLoadedRecord,
	updateFocus,
	updateLayout,
	updateCanvasAccess,
	summary,
	purgeAccountFromWorkspace,
	purgeWorkspace,
	broadcastCanvasSaved,
	canvasSnapshotHash,
	seedLiveSnapshot,
	normalizeSnapshotLayout,
	mergeLiveSnapshotRecord,
	liveSnapshot,
	loadedRecordObjectName,
	unsavedLiveSnapshot,
	acquireFieldLock,
	renewFieldLock,
	releaseFieldLock,
	validateFieldCommit,
	commitFieldValues,
} from '../src/canvas-presence.js';
import { hiddenCanvasRecordId } from '../src/slot-helpers.js';

function response() {
	const handlers = new Map();
	const writes = [];
	return {
		writes,
		write(chunk) {
			writes.push(chunk);
			return true;
		},
		on(event, fn) {
			handlers.set(event, fn);
		},
		fire(event) {
			handlers.get(event)?.(new Error(event));
		},
	};
}

function events(res) {
	return res.writes.filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
}

describe('canvas presence security and ordering', () => {
	test('separates exactly stacked cards without changing the durable payload', () => {
		const payload = {
			schema: { objects: [{ name: 'Account', label: 'Account' }] },
			loadedRecords: [],
			drafts: [
				{ tempId: 'one', objectName: 'Account', x: 320, y: 250, values: {} },
				{ tempId: 'two', objectName: 'Account', x: 320, y: 250, values: {} },
				{ tempId: 'three', objectName: 'Account', x: 320, y: 250, values: {} },
			],
			associations: [],
		};

		const normalized = normalizeSnapshotLayout(payload);
		assert.equal(new Set(normalized.drafts.map((record) => record.x + ':' + record.y)).size, 3);
		assert.deepEqual(
			payload.drafts.map((record) => [record.x, record.y]),
			[
				[320, 250],
				[320, 250],
				[320, 250],
			],
		);
	});

	test('moves a newly shared draft when its requested position is occupied', () => {
		const canvasId = 'draft-position-collision';
		const ownerResponse = response();
		assert.equal(
			seedLiveSnapshot({
				canvasId,
				payload: {
					schema: { objects: [{ name: 'Account', label: 'Account' }] },
					loadedRecords: [],
					drafts: [{ tempId: 'existing', objectName: 'Account', x: 320, y: 250, values: {} }],
					associations: [],
				},
			}),
			true,
		);
		const connectionId = subscribe({
			canvasId,
			workspaceId: 'w',
			accountId: 'owner-position-collision',
			role: 'owner',
			canEdit: true,
			sseRes: ownerResponse,
		});
		assert.equal(
			updateDraft({
				canvasId,
				connectionId,
				tempId: 'new',
				canvasRecordId: 'new-card',
				kind: 'create',
				objectName: 'Account',
				fields: {},
				x: 320,
				y: 250,
				sequence: 1,
				requestingAccountId: 'owner-position-collision',
			}),
			true,
		);
		const records = liveSnapshot({ canvasId }).payload.drafts;
		assert.notDeepEqual(
			[records.find((record) => record.tempId === 'new').x, records.find((record) => record.tempId === 'new').y],
			[320, 250],
		);
		assert.ok(
			events(ownerResponse).some(
				(event) => event.type === 'record-layout' && event.positions[0].collabRef === 'new-card',
			),
		);
		ownerResponse.fire('close');
	});

	test('allows an assigned contributor to lock a uniquely identified legacy record request', () => {
		const canvasId = '069000000000091AAA';
		const sfOrgId = '00D000000000091AAA';
		const contributorResponse = response();
		const payload = {
			schema: { objects: [{ name: 'Opportunity', label: 'Opportunity' }] },
			loadedRecords: [],
			drafts: [
				{
					tempId: 'draft-opportunity',
					objectName: 'Opportunity',
					values: {},
					slot: {
						slotId: 'slot-opportunity',
						kind: 'whole-record',
						assigneeSfUserId: '005000000000091AAA',
					},
				},
			],
			associations: [],
		};
		assert.equal(seedLiveSnapshot({ canvasId, sfOrgId, payload }), true);
		const contributorConnection = subscribe({
			canvasId,
			workspaceId: 'w',
			accountId: 'contributor-legacy',
			role: 'contributor',
			canEdit: false,
			sfOrgId,
			sfUserId: '005000000000091AAA',
			sseRes: contributorResponse,
		});

		const acquired = acquireFieldLock({
			canvasId,
			connectionId: contributorConnection,
			targetRef: {
				refKind: 'slot',
				ref: 'slot-opportunity',
				collabRef: 'legacy:draft:slot:slot-opportunity:1',
			},
			fieldName: 'Name',
			requestingAccountId: 'contributor-legacy',
		});

		assert.equal(acquired.ok, true);
		contributorResponse.fire('close');
	});

	test('uses stable card identity when a record request reference changes representation', () => {
		const canvasId = '069000000000093AAA';
		const sfOrgId = '00D000000000093AAA';
		const contributorResponse = response();
		assert.equal(
			seedLiveSnapshot({
				canvasId,
				sfOrgId,
				payload: {
					schema: { objects: [{ name: 'Opportunity', label: 'Opportunity' }] },
					loadedRecords: [],
					drafts: [
						{
							tempId: 'draft-opportunity',
							canvasRecordId: 'canvas-opportunity',
							objectName: 'Opportunity',
							values: {},
							slot: {
								slotId: 'current-slot',
								kind: 'whole-record',
								assigneeSfUserId: '005000000000093AAA',
							},
						},
					],
					associations: [],
				},
			}),
			true,
		);
		const contributorConnection = subscribe({
			canvasId,
			workspaceId: 'w',
			accountId: 'contributor-stable-card',
			role: 'contributor',
			canEdit: false,
			sfOrgId,
			sfUserId: '005000000000093AAA',
			sseRes: contributorResponse,
		});

		const acquired = acquireFieldLock({
			canvasId,
			connectionId: contributorConnection,
			targetRef: {
				refKind: 'slot',
				ref: 'previous-slot',
				collabRef: 'canvas-opportunity',
			},
			fieldName: 'Name',
			requestingAccountId: 'contributor-stable-card',
		});

		assert.equal(acquired.ok, true);
		contributorResponse.fire('close');
	});

	test('uses the underlying record identity when request and card references are stale', () => {
		const canvasId = '069000000000096AAA';
		const sfOrgId = '00D000000000096AAA';
		const contributorResponse = response();
		assert.equal(
			seedLiveSnapshot({
				canvasId,
				sfOrgId,
				payload: {
					schema: { objects: [{ name: 'Opportunity', label: 'Opportunity' }] },
					loadedRecords: [],
					drafts: [
						{
							tempId: 'draft-opportunity',
							canvasRecordId: 'current-card',
							objectName: 'Opportunity',
							values: {},
							slot: {
								slotId: 'current-slot',
								kind: 'whole-record',
								assigneeSfUserId: '005000000000096AAA',
							},
						},
					],
					associations: [],
				},
			}),
			true,
		);
		const contributorConnection = subscribe({
			canvasId,
			workspaceId: 'w',
			accountId: 'contributor-underlying-record',
			role: 'contributor',
			canEdit: false,
			sfOrgId,
			sfUserId: '005000000000096AAA',
			sseRes: contributorResponse,
		});

		const acquired = acquireFieldLock({
			canvasId,
			connectionId: contributorConnection,
			targetRef: {
				refKind: 'slot',
				ref: 'previous-slot',
				collabRef: 'previous-card',
				sourceRefKind: 'draft',
				sourceRef: 'draft-opportunity',
			},
			fieldName: 'Name',
			requestingAccountId: 'contributor-underlying-record',
		});

		assert.equal(acquired.ok, true);
		contributorResponse.fire('close');
	});

	test('refreshes a durable live snapshot before authorizing contributor fields', () => {
		const canvasId = '069000000000094AAA';
		const sfOrgId = '00D000000000094AAA';
		const basePayload = {
			schema: { objects: [{ name: 'Contact', label: 'Contact' }] },
			loadedRecords: [],
			drafts: [
				{
					tempId: 'draft-contact',
					canvasRecordId: 'canvas-contact',
					objectName: 'Contact',
					values: {},
				},
			],
			associations: [],
		};
		assert.equal(seedLiveSnapshot({ canvasId, sfOrgId, payload: basePayload }), true);
		const refreshedPayload = structuredClone(basePayload);
		refreshedPayload.drafts[0].slot = {
			slotId: 'slot-contact',
			kind: 'fields',
			fields: ['LastName'],
			assigneeSfUserId: '005000000000094AAA',
		};
		assert.equal(
			seedLiveSnapshot({
				canvasId,
				sfOrgId,
				payload: refreshedPayload,
				replaceIfDurable: true,
			}),
			true,
		);

		const contributorResponse = response();
		const contributorConnection = subscribe({
			canvasId,
			workspaceId: 'w',
			accountId: 'contributor-durable-refresh',
			role: 'contributor',
			canEdit: false,
			sfOrgId,
			sfUserId: '005000000000094AAA',
			sseRes: contributorResponse,
		});
		assert.equal(
			acquireFieldLock({
				canvasId,
				connectionId: contributorConnection,
				targetRef: {
					refKind: 'slot',
					ref: 'slot-contact',
					collabRef: 'canvas-contact',
				},
				fieldName: 'LastName',
				requestingAccountId: 'contributor-durable-refresh',
			}).ok,
			true,
		);
		contributorResponse.fire('close');
	});

	test('does not replace a live snapshot containing newer unsaved edits', () => {
		const canvasId = '069000000000095AAA';
		const sfOrgId = '00D000000000095AAA';
		const payload = {
			schema: { objects: [{ name: 'Contact', label: 'Contact' }] },
			loadedRecords: [],
			drafts: [
				{
					tempId: 'draft-contact',
					canvasRecordId: 'canvas-contact',
					objectName: 'Contact',
					values: { LastName: 'Before' },
				},
			],
			associations: [],
		};
		assert.equal(seedLiveSnapshot({ canvasId, sfOrgId, payload }), true);
		const ownerResponse = response();
		const ownerConnection = subscribe({
			canvasId,
			workspaceId: 'w',
			accountId: 'owner-unsaved',
			role: 'owner',
			canEdit: true,
			sfOrgId,
			sfUserId: '005000000000095AAA',
			sseRes: ownerResponse,
		});
		assert.equal(
			updateDraft({
				canvasId,
				connectionId: ownerConnection,
				tempId: 'draft-contact',
				fields: { LastName: 'Unsaved' },
				sequence: 1,
				requestingAccountId: 'owner-unsaved',
			}),
			true,
		);
		assert.equal(seedLiveSnapshot({ canvasId, sfOrgId, payload, replaceIfDurable: true }), false);
		assert.equal(liveSnapshot({ canvasId, sfOrgId }).payload.drafts[0].values.LastName, 'Unsaved');
		ownerResponse.fire('close');
	});

	test('preserves fields cleared before an existing record enters the live snapshot', () => {
		const canvasId = '069000000000197AAA';
		const sfOrgId = '00D000000000197AAA';
		assert.equal(
			seedLiveSnapshot({
				canvasId,
				sfOrgId,
				payload: { schema: { objects: [] }, loadedRecords: [], drafts: [], associations: [] },
			}),
			true,
		);
		const ownerResponse = response();
		const ownerConnection = subscribe({
			canvasId,
			workspaceId: 'w',
			accountId: 'owner-cleared-lookup',
			role: 'owner',
			canEdit: true,
			sfOrgId,
			sfUserId: '005000000000197AAA',
			sseRes: ownerResponse,
		});

		assert.equal(
			updateLoadedRecord({
				canvasId,
				connectionId: ownerConnection,
				kind: 'create',
				sfId: '500000000000197AAA',
				collabRef: 'case-card',
				objectName: 'Case',
				fields: { Id: '500000000000197AAA', CaseNumber: '00001027' },
				baseline: {
					Id: '500000000000197AAA',
					CaseNumber: '00001027',
					AccountId: '001000000000197AAA',
				},
				x: 100,
				y: 200,
				sequence: 1,
				requestingAccountId: 'owner-cleared-lookup',
			}),
			true,
		);

		assert.deepEqual(liveSnapshot({ canvasId, sfOrgId }).payload.loadedRecords[0].changes, {
			AccountId: null,
		});
		assert.equal(
			loadedRecordObjectName({
				canvasId,
				connectionId: ownerConnection,
				sfId: '500000000000197AAA',
				collabRef: 'case-card',
				requestingAccountId: 'owner-cleared-lookup',
			}),
			'Case',
		);
		assert.equal(
			loadedRecordObjectName({
				canvasId,
				connectionId: ownerConnection,
				sfId: '500000000000197AAA',
				requestingAccountId: 'another-account',
			}),
			null,
		);
		ownerResponse.fire('close');
	});

	test('repairs a missing live request from durable state without replacing newer edits', () => {
		const canvasId = '069000000000097AAA';
		const sfOrgId = '00D000000000097AAA';
		const contributorResponse = response();
		const livePayload = {
			schema: { objects: [{ name: 'Account', label: 'Account' }] },
			loadedRecords: [],
			drafts: [
				{
					tempId: 'existing-draft',
					canvasRecordId: 'existing-card',
					objectName: 'Account',
					values: { Name: 'Live unsaved value' },
				},
			],
			associations: [],
		};
		const durablePayload = structuredClone(livePayload);
		durablePayload.drafts[0].values.Name = 'Older saved value';
		durablePayload.drafts.push({
			tempId: 'requested-draft',
			canvasRecordId: 'requested-card',
			objectName: 'Account',
			values: {},
			slot: {
				slotId: 'requested-slot',
				kind: 'whole-record',
				assigneeSfUserId: '005000000000097AAA',
			},
		});
		assert.equal(seedLiveSnapshot({ canvasId, sfOrgId, payload: livePayload }), true);
		const contributorConnection = subscribe({
			canvasId,
			workspaceId: 'w',
			accountId: 'contributor-repair',
			role: 'contributor',
			canEdit: false,
			sfOrgId,
			sfUserId: '005000000000097AAA',
			sseRes: contributorResponse,
		});
		const targetRef = {
			refKind: 'slot',
			ref: 'requested-slot',
			collabRef: 'requested-card',
			sourceRefKind: 'draft',
			sourceRef: 'requested-draft',
		};
		assert.equal(
			acquireFieldLock({
				canvasId,
				connectionId: contributorConnection,
				targetRef,
				fieldName: 'Name',
				requestingAccountId: 'contributor-repair',
			}).reason,
			'canvas-record-not-found',
		);
		assert.equal(
			mergeLiveSnapshotRecord({
				canvasId,
				sfOrgId,
				payload: durablePayload,
				targetRef,
			}),
			true,
		);
		assert.equal(
			acquireFieldLock({
				canvasId,
				connectionId: contributorConnection,
				targetRef,
				fieldName: 'Name',
				requestingAccountId: 'contributor-repair',
			}).ok,
			true,
		);
		const repaired = liveSnapshot({ canvasId, sfOrgId }).payload;
		assert.equal(repaired.drafts[0].values.Name, 'Live unsaved value');
		assert.equal(repaired.drafts[1].slot.slotId, 'requested-slot');
		contributorResponse.fire('close');
	});

	test('stores request metadata with a newly published live draft before field locking', () => {
		const canvasId = '069000000000098AAA';
		const sfOrgId = '00D000000000098AAA';
		const ownerResponse = response();
		const contributorResponse = response();
		assert.equal(
			seedLiveSnapshot({
				canvasId,
				sfOrgId,
				payload: {
					schema: { objects: [{ name: 'Account', label: 'Account' }] },
					loadedRecords: [],
					drafts: [],
					associations: [],
				},
			}),
			true,
		);
		const ownerConnection = subscribe({
			canvasId,
			workspaceId: 'w',
			accountId: 'owner-create-request',
			role: 'owner',
			canEdit: true,
			sfOrgId,
			sfUserId: '005000000000098AAA',
			sseRes: ownerResponse,
		});
		assert.equal(
			updateDraft({
				canvasId,
				connectionId: ownerConnection,
				tempId: 'new-request-draft',
				canvasRecordId: 'new-request-card',
				kind: 'create',
				objectName: 'Account',
				fields: { Name: 'Requested account' },
				slot: {
					slotId: 'new-request-slot',
					kind: 'fields',
					fields: ['Name'],
					assigneeSfUserId: '005000000000099AAA',
				},
				sequence: 1,
				requestingAccountId: 'owner-create-request',
			}),
			true,
		);
		assert.equal(liveSnapshot({ canvasId, sfOrgId }).payload.drafts[0].slot.slotId, 'new-request-slot');
		const contributorConnection = subscribe({
			canvasId,
			workspaceId: 'w',
			accountId: 'contributor-created-request',
			role: 'contributor',
			canEdit: false,
			sfOrgId,
			sfUserId: '005000000000099AAA',
			sseRes: contributorResponse,
		});
		assert.equal(
			acquireFieldLock({
				canvasId,
				connectionId: contributorConnection,
				targetRef: {
					refKind: 'slot',
					ref: 'new-request-slot',
					collabRef: 'new-request-card',
					sourceRefKind: 'draft',
					sourceRef: 'new-request-draft',
				},
				fieldName: 'Name',
				requestingAccountId: 'contributor-created-request',
			}).ok,
			true,
		);
		ownerResponse.fire('close');
		contributorResponse.fire('close');
	});

	test('does not use the legacy fallback when a record reference is ambiguous', () => {
		const canvasId = '069000000000092AAA';
		const sfOrgId = '00D000000000092AAA';
		const contributorResponse = response();
		const request = {
			objectName: 'Opportunity',
			values: {},
			slot: {
				slotId: 'duplicate-slot',
				kind: 'whole-record',
				assigneeSfUserId: '005000000000092AAA',
			},
		};
		assert.equal(
			seedLiveSnapshot({
				canvasId,
				sfOrgId,
				payload: {
					schema: { objects: [{ name: 'Opportunity', label: 'Opportunity' }] },
					loadedRecords: [],
					drafts: [
						{ ...request, tempId: 'first-request' },
						{ ...request, tempId: 'second-request' },
					],
					associations: [],
				},
			}),
			true,
		);
		const contributorConnection = subscribe({
			canvasId,
			workspaceId: 'w',
			accountId: 'contributor-ambiguous',
			role: 'contributor',
			canEdit: false,
			sfOrgId,
			sfUserId: '005000000000092AAA',
			sseRes: contributorResponse,
		});

		const acquired = acquireFieldLock({
			canvasId,
			connectionId: contributorConnection,
			targetRef: {
				refKind: 'slot',
				ref: 'duplicate-slot',
				collabRef: 'unknown-card',
			},
			fieldName: 'Name',
			requestingAccountId: 'contributor-ambiguous',
		});

		assert.equal(acquired.ok, false);
		assert.equal(acquired.reason, 'canvas-record-not-found');
		contributorResponse.fire('close');
	});

	test('field leases serialize requested edits and revisions reject stale commits', () => {
		const canvasId = '069000000000088AAA';
		const payload = {
			schema: { objects: [{ name: 'Contact', label: 'Contact' }] },
			loadedRecords: [],
			drafts: [
				{
					tempId: 'draft-contact',
					canvasRecordId: 'card-contact',
					objectName: 'Contact',
					values: { LastName: 'Original' },
					slot: {
						slotId: 'slot-contact',
						kind: 'fields',
						fields: ['LastName'],
						assigneeSfUserId: '005000000000001AAA',
					},
				},
			],
			associations: [],
		};
		assert.equal(seedLiveSnapshot({ canvasId, payload }), true);
		const ownerResponse = response();
		const contributorResponse = response();
		const otherResponse = response();
		const ownerConnection = subscribe({
			canvasId,
			workspaceId: 'w',
			accountId: 'owner',
			role: 'owner',
			canEdit: true,
			sfUserId: '005000000000099AAA',
			sseRes: ownerResponse,
		});
		const contributorConnection = subscribe({
			canvasId,
			workspaceId: 'w',
			accountId: 'contributor',
			role: 'contributor',
			canEdit: false,
			sfUserId: '005000000000001AAA',
			sseRes: contributorResponse,
		});
		const otherConnection = subscribe({
			canvasId,
			workspaceId: 'w',
			accountId: 'other',
			role: 'editor',
			canEdit: true,
			sfUserId: '005000000000002AAA',
			sseRes: otherResponse,
		});
		const targetRef = { refKind: 'slot', ref: 'slot-contact' };
		const acquired = acquireFieldLock({
			canvasId,
			connectionId: contributorConnection,
			targetRef,
			fieldName: 'LastName',
			requestingAccountId: 'contributor',
		});
		assert.equal(acquired.ok, true);
		assert.equal(acquired.lock.baseVersion, 0);
		assert.equal(
			renewFieldLock({
				canvasId,
				connectionId: contributorConnection,
				leaseId: acquired.lock.leaseId,
				requestingAccountId: 'contributor',
			}).ok,
			true,
		);
		const blocked = acquireFieldLock({
			canvasId,
			connectionId: otherConnection,
			targetRef,
			fieldName: 'LastName',
			requestingAccountId: 'other',
		});
		assert.equal(blocked.reason, 'field-locked');
		assert.equal(blocked.lock.displayName, 'Someone');
		const takenOver = acquireFieldLock({
			canvasId,
			connectionId: otherConnection,
			targetRef,
			fieldName: 'LastName',
			takeover: true,
			requestingAccountId: 'other',
		});
		assert.equal(takenOver.ok, true);
		assert.notEqual(takenOver.lock.leaseId, acquired.lock.leaseId);
		const reacquired = acquireFieldLock({
			canvasId,
			connectionId: contributorConnection,
			targetRef,
			fieldName: 'LastName',
			takeover: true,
			requestingAccountId: 'contributor',
		});
		assert.equal(reacquired.ok, true);
		assert.equal(
			updateDraft({
				canvasId,
				connectionId: ownerConnection,
				tempId: 'draft-contact',
				fields: { LastName: 'Owner overwrite' },
				sequence: 1,
				requestingAccountId: 'owner',
			}),
			false,
		);
		const leases = {
			LastName: { leaseId: reacquired.lock.leaseId, baseVersion: reacquired.lock.baseVersion },
		};
		assert.equal(
			validateFieldCommit({
				canvasId,
				connectionId: contributorConnection,
				targetRef,
				fields: { LastName: 'Contributor value' },
				leases,
				requestingAccountId: 'contributor',
			}).ok,
			false,
		);
		assert.equal(
			validateFieldCommit({
				canvasId,
				connectionId: contributorConnection,
				targetRef,
				fields: { LastName: 'Contributor value' },
				leases,
				requestingAccountId: 'contributor',
				allowContributor: true,
			}).ok,
			true,
		);
		const committed = commitFieldValues({
			canvasId,
			connectionId: contributorConnection,
			targetRef,
			fields: { LastName: 'Contributor value' },
			leases,
			requestingAccountId: 'contributor',
			allowContributor: true,
			contributionIds: ['a01000000000001AAA'],
		});
		assert.equal(committed.ok, true);
		assert.equal(liveSnapshot({ canvasId }).payload.drafts[0].values.LastName, 'Contributor value');
		assert.equal(
			events(ownerResponse).some((event) => event.type === 'field-update'),
			true,
		);
		assert.deepEqual(events(ownerResponse).find((event) => event.type === 'field-update').contributionIds, [
			'a01000000000001AAA',
		]);
		assert.equal(events(otherResponse).find((event) => event.type === 'field-update').contributionIds, undefined);
		assert.equal(
			commitFieldValues({
				canvasId,
				connectionId: contributorConnection,
				targetRef,
				fields: { LastName: 'Stale replay' },
				leases,
				requestingAccountId: 'contributor',
				allowContributor: true,
			}).ok,
			false,
		);
		assert.equal(
			releaseFieldLock({
				canvasId,
				connectionId: contributorConnection,
				leaseId: acquired.lock.leaseId,
				requestingAccountId: 'contributor',
			}),
			false,
		);
		ownerResponse.fire('close');
		contributorResponse.fire('close');
		otherResponse.fire('close');
	});

	test('broadcasts contributor lookup reparenting and removes the old live relationship', () => {
		const canvasId = '069000000000087AAA';
		const payload = {
			schema: {
				objects: [
					{ name: 'Contact', label: 'Contact' },
					{ name: 'Account', label: 'Account' },
				],
			},
			loadedRecords: [
				{
					loadedFromId: '001000000000087AAA',
					canvasRecordId: 'account-card',
					objectName: 'Account',
					values: { Name: 'Canvas account' },
				},
			],
			drafts: [
				{
					tempId: 'draft-contact',
					canvasRecordId: 'contact-card',
					objectName: 'Contact',
					values: { LastName: 'Contributor' },
					slot: {
						slotId: 'contact-request',
						kind: 'fields',
						fields: ['AccountId'],
						assigneeSfUserId: '005000000000087AAA',
					},
				},
			],
			associations: [
				{
					from: { kind: 'slot', ref: 'contact-request' },
					to: { kind: 'loaded', ref: '001000000000087AAA' },
					fieldName: 'AccountId',
				},
			],
		};
		assert.equal(seedLiveSnapshot({ canvasId, payload }), true);
		const ownerResponse = response();
		const contributorResponse = response();
		subscribe({
			canvasId,
			workspaceId: 'w',
			accountId: 'owner-reparent',
			role: 'owner',
			canEdit: true,
			sseRes: ownerResponse,
		});
		const contributorConnection = subscribe({
			canvasId,
			workspaceId: 'w',
			accountId: 'contributor-reparent',
			role: 'contributor',
			canEdit: false,
			sfUserId: '005000000000087AAA',
			sseRes: contributorResponse,
		});
		const targetRef = {
			refKind: 'slot',
			ref: 'contact-request',
			collabRef: 'contact-card',
		};
		const lock = acquireFieldLock({
			canvasId,
			connectionId: contributorConnection,
			targetRef,
			fieldName: 'AccountId',
			requestingAccountId: 'contributor-reparent',
		});
		assert.equal(lock.ok, true);

		const committed = commitFieldValues({
			canvasId,
			connectionId: contributorConnection,
			targetRef,
			fields: { AccountId: '001000000000088AAA' },
			leases: {
				AccountId: {
					leaseId: lock.lock.leaseId,
					baseVersion: lock.lock.baseVersion,
				},
			},
			requestingAccountId: 'contributor-reparent',
			allowContributor: true,
			relationshipFields: ['AccountId', 'NotSubmitted__c', 'not-valid'],
		});

		assert.equal(committed.ok, true);
		const snapshot = liveSnapshot({ canvasId }).payload;
		assert.equal(snapshot.associations.length, 0);
		assert.equal(snapshot.drafts[0].values.AccountId, '001000000000088AAA');
		const update = events(ownerResponse).find((event) => event.type === 'field-update');
		assert.deepEqual(update.relationshipFields, ['AccountId']);
		assert.deepEqual(update.fields, { AccountId: '001000000000088AAA' });

		ownerResponse.fire('close');
		contributorResponse.fire('close');
	});

	test('serves a revisioned, permission-projected snapshot to late joiners', async () => {
		const canvasId = '069000000000099AAA';
		const sourcePayload = {
			schema: {
				objects: [
					{
						name: 'Account',
						label: 'Account',
						fields: [
							{ name: 'Name', label: 'Account Name' },
							{ name: 'Secret__c', label: 'Secret' },
						],
					},
				],
			},
			loadedRecords: [],
			drafts: [
				{
					tempId: 'draft-1',
					canvasRecordId: 'card-1',
					objectName: 'Account',
					values: { Name: 'Visible', Secret__c: 'Hidden' },
				},
			],
			associations: [],
		};
		assert.equal(seedLiveSnapshot({ canvasId, payload: sourcePayload }), true);
		assert.equal(unsavedLiveSnapshot({ canvasId }), null);
		const owner = response();
		const ownerConnection = subscribe({
			canvasId,
			workspaceId: 'w',
			accountId: 'owner-account',
			role: 'owner',
			canEdit: true,
			sseRes: owner,
		});
		assert.equal(
			updateDraft({
				canvasId,
				connectionId: ownerConnection,
				tempId: 'draft-1',
				fields: { Name: 'Visible live' },
				sequence: 1,
				requestingAccountId: 'owner-account',
			}),
			true,
		);
		assert.equal(
			updateLayout({
				canvasId,
				connectionId: ownerConnection,
				positions: [
					{
						refKind: 'draft',
						ref: 'draft-1',
						collabRef: 'card-1',
						x: 320,
						y: 460,
					},
				],
				sequence: 2,
				requestingAccountId: 'owner-account',
			}),
			true,
		);
		const viewer = response();
		let projectionCalls = 0;
		subscribe({
			canvasId,
			workspaceId: 'w',
			accountId: 'viewer-account',
			role: 'viewer',
			canEdit: false,
			visibility: {},
			projectSnapshot: async (payload) => {
				projectionCalls += 1;
				const projected = structuredClone(payload);
				for (const draft of projected.drafts) {
					delete draft.values.Secret__c;
				}
				return {
					payload: projected,
					visibility: {
						objects: {
							Account: { visible: true, readableFields: new Set(['Name']) },
							Secret_Object__c: { visible: false },
						},
						loadedRecords: {},
						drafts: {
							'draft-1': { visible: true, readableFields: ['Name'] },
						},
						slots: {},
					},
				};
			},
			sseRes: viewer,
		});
		await new Promise((resolve) => setImmediate(resolve));
		const snapshotEvent = events(viewer).find((event) => event.type === 'live-snapshot');
		assert.ok(snapshotEvent);
		assert.equal(snapshotEvent.revision, 2);
		assert.deepEqual(snapshotEvent.payload.drafts[0].values, { Name: 'Visible live' });
		assert.equal(snapshotEvent.payload.drafts[0].canvasRecordId, 'card-1');
		assert.equal(snapshotEvent.payload.drafts[0].x, 320);
		assert.equal(snapshotEvent.payload.drafts[0].y, 460);
		assert.equal(projectionCalls, 1);

		assert.equal(
			updateDraft({
				canvasId,
				connectionId: ownerConnection,
				tempId: 'draft-2',
				canvasRecordId: 'card-2',
				kind: 'create',
				objectName: 'Account',
				fields: { Name: 'Created live', Secret__c: 'Still hidden' },
				sequence: 3,
				requestingAccountId: 'owner-account',
			}),
			true,
		);
		await new Promise((resolve) => setImmediate(resolve));
		const snapshots = events(viewer).filter((event) => event.type === 'live-snapshot');
		assert.equal(snapshots.length, 1);
		const createdDraft = events(viewer).find(
			(event) => event.type === 'draft-update' && event.tempId === 'draft-2',
		);
		assert.deepEqual(createdDraft.fields, { Name: 'Created live' });
		assert.equal(projectionCalls, 1);
		assert.equal(liveSnapshot({ canvasId }).payload.drafts[1].values.Secret__c, 'Still hidden');
		assert.deepEqual(unsavedLiveSnapshot({ canvasId }).payload.drafts[0].values, {
			Name: 'Visible live',
			Secret__c: 'Hidden',
		});

		assert.equal(
			updateDraft({
				canvasId,
				connectionId: ownerConnection,
				tempId: 'draft-hidden-known-object',
				kind: 'create',
				objectName: 'Secret_Object__c',
				fields: { Secret__c: 'never projected' },
				x: 640,
				y: 720,
				sequence: 4,
				requestingAccountId: 'owner-account',
			}),
			true,
		);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(events(viewer).filter((event) => event.type === 'live-snapshot').length, 1);
		const hiddenIncrement = events(viewer).find(
			(event) => event.type === 'hidden-record' && event.kind === 'create',
		);
		assert.ok(hiddenIncrement);
		assert.equal(hiddenIncrement.x, 640);
		assert.equal(hiddenIncrement.y, 720);
		assert.equal(hiddenIncrement.revision, 4);
		assert.equal(projectionCalls, 1);

		owner.fire('close');
		viewer.fire('close');
		assert.ok(liveSnapshot({ canvasId }));
		purgeWorkspace({ workspaceId: 'w' });
		assert.equal(liveSnapshot({ canvasId }), null);
	});

	test('preserves unsaved live state across an OAuth connection handoff', async () => {
		const canvasId = '069000000000097AAA';
		const sfOrgId = '00D000000000097AAA';
		const workspaceId = 'oauth-handoff-workspace';
		const payload = {
			schema: { objects: [{ name: 'Account', label: 'Account' }] },
			loadedRecords: [],
			drafts: [{ tempId: 'saved-account', objectName: 'Account', values: { Name: 'Saved' }, x: 10, y: 20 }],
			associations: [],
		};
		assert.equal(seedLiveSnapshot({ canvasId, sfOrgId, payload }), true);
		const beforeOauth = response();
		const firstConnection = subscribe({
			canvasId,
			sfOrgId,
			workspaceId,
			accountId: 'account-before-oauth',
			role: 'owner',
			canEdit: true,
			sseRes: beforeOauth,
		});
		assert.equal(
			updateDraft({
				canvasId,
				connectionId: firstConnection,
				tempId: 'unsaved-account',
				kind: 'create',
				objectName: 'Account',
				fields: { Name: 'Unsaved but recoverable' },
				sequence: 1,
				requestingAccountId: 'account-before-oauth',
			}),
			true,
		);
		beforeOauth.fire('close');
		assert.equal(summary({ canvasId, sfOrgId }).count, 0);
		assert.equal(unsavedLiveSnapshot({ canvasId, sfOrgId }).payload.drafts.length, 2);

		const afterOauth = response();
		subscribe({
			canvasId,
			sfOrgId,
			workspaceId,
			accountId: 'account-after-oauth',
			role: 'owner',
			canEdit: true,
			sseRes: afterOauth,
		});
		await new Promise((resolve) => setImmediate(resolve));
		const restored = events(afterOauth).find((event) => event.type === 'live-snapshot');
		assert.equal(restored.payload.drafts.length, 2);
		assert.equal(restored.payload.drafts[1].values.Name, 'Unsaved but recoverable');

		afterOauth.fire('close');
		purgeWorkspace({ workspaceId });
		assert.equal(liveSnapshot({ canvasId, sfOrgId }), null);
	});

	test('exposes live load state only while it is newer than the durable canvas', () => {
		const canvasId = '069000000000098AAA';
		const payload = {
			schema: { objects: [] },
			loadedRecords: [],
			drafts: [{ tempId: 'draft-1', objectName: 'Account', values: { Name: 'Saved' }, x: 10, y: 20 }],
			associations: [],
		};
		assert.equal(seedLiveSnapshot({ canvasId, payload }), true);
		const owner = response();
		const ownerConnection = subscribe({
			canvasId,
			workspaceId: 'w',
			accountId: 'owner-account',
			role: 'owner',
			canEdit: true,
			sseRes: owner,
		});

		assert.equal(unsavedLiveSnapshot({ canvasId }), null);
		assert.equal(
			updateLayout({
				canvasId,
				connectionId: ownerConnection,
				positions: [{ refKind: 'draft', ref: 'draft-1', x: 350, y: 475 }],
				sequence: 1,
				requestingAccountId: 'owner-account',
			}),
			true,
		);
		const unsaved = unsavedLiveSnapshot({ canvasId });
		assert.equal(unsaved.revision, 1);
		assert.equal(unsaved.durableRevision, 0);
		assert.equal(unsaved.payload.drafts[0].x, 350);
		assert.equal(unsaved.payload.drafts[0].y, 475);

		broadcastCanvasSaved({
			canvasId,
			savedByAccountId: 'owner-account',
			payload: unsaved.payload,
		});
		assert.equal(unsavedLiveSnapshot({ canvasId }), null);
		owner.fire('close');
	});

	test('applies live role changes to the exact Salesforce identity', () => {
		const recipient = response();
		const unrelated = response();
		const canvasId = '069000000000001AAA';
		const recipientConnection = subscribe({
			canvasId,
			workspaceId: 'w',
			accountId: 'recipient-account',
			role: 'editor',
			canEdit: true,
			sfOrgId: '00D000000000001AAA',
			sfUserId: '005000000000001AAA',
			sseRes: recipient,
		});
		subscribe({
			canvasId,
			workspaceId: 'w',
			accountId: 'recipient-account',
			role: 'editor',
			canEdit: true,
			sfOrgId: '00D000000000001AAA',
			sfUserId: '005000000000002AAA',
			sseRes: unrelated,
		});

		assert.equal(
			updateCanvasAccess({
				canvasId: canvasId.slice(0, 15),
				sfOrgId: '00D000000000001',
				sfUserId: '005000000000001',
				role: 'viewer',
			}),
			1,
		);
		const decrease = events(recipient).find((event) => event.type === 'access-changed');
		assert.deepEqual(
			{
				previousRole: decrease.previousRole,
				role: decrease.role,
				change: decrease.change,
				revoked: decrease.revoked,
			},
			{ previousRole: 'editor', role: 'viewer', change: 'decreased', revoked: false },
		);
		assert.equal(
			events(unrelated).some((event) => event.type === 'access-changed'),
			false,
		);
		assert.equal(
			updateDraft({
				canvasId,
				connectionId: recipientConnection,
				tempId: 'draft-1',
				fields: { Name: 'blocked' },
				sequence: 1,
				requestingAccountId: 'recipient-account',
			}),
			false,
		);

		assert.equal(
			updateCanvasAccess({
				canvasId,
				sfOrgId: '00D000000000001AAA',
				sfUserId: '005000000000001AAA',
				role: 'editor',
			}),
			1,
		);
		assert.equal(
			updateDraft({
				canvasId,
				connectionId: recipientConnection,
				tempId: 'draft-1',
				fields: { Name: 'allowed' },
				sequence: 2,
				requestingAccountId: 'recipient-account',
			}),
			true,
		);
		assert.equal(
			updateCanvasAccess({
				canvasId,
				sfOrgId: '00D000000000001AAA',
				sfUserId: '005000000000001AAA',
				revoked: true,
			}),
			1,
		);
		assert.equal(
			updateCursor({
				canvasId,
				connectionId: recipientConnection,
				x: 1,
				y: 1,
				sequence: 3,
				requestingAccountId: 'recipient-account',
			}),
			false,
		);
		recipient.fire('close');
		unrelated.fire('close');
	});

	test('binds writes to account+canvas and rejects stale/out-of-order events', () => {
		const a = response();
		const b = response();
		const ca = subscribe({
			canvasId: 'draft-11111111-1111-4111-8111-111111111111',
			workspaceId: 'w1',
			accountId: 'a',
			displayName: 'A',
			sseRes: a,
		});
		subscribe({
			canvasId: 'draft-11111111-1111-4111-8111-111111111111',
			workspaceId: 'w2',
			accountId: 'b',
			displayName: 'B',
			sseRes: b,
		});
		assert.equal(
			updateCursor({
				canvasId: 'draft-11111111-1111-4111-8111-111111111111',
				connectionId: ca,
				x: 1,
				y: 2,
				sequence: 2,
				requestingAccountId: 'a',
			}),
			true,
		);
		assert.equal(
			updateCursor({
				canvasId: 'draft-11111111-1111-4111-8111-111111111111',
				connectionId: ca,
				x: 9,
				y: 9,
				sequence: 1,
				requestingAccountId: 'a',
			}),
			false,
		);
		assert.equal(
			updateFocus({
				canvasId: 'draft-11111111-1111-4111-8111-111111111111',
				connectionId: ca,
				focus: {},
				sequence: 3,
				requestingAccountId: 'attacker',
			}),
			false,
		);
		assert.equal(
			updateFocus({
				canvasId: 'draft-22222222-2222-4222-8222-222222222222',
				connectionId: ca,
				focus: {},
				sequence: 3,
				requestingAccountId: 'a',
			}),
			false,
		);
		const cursorEvents = events(b).filter((e) => e.type === 'cursor');
		assert.equal(cursorEvents.length, 1);
		assert.deepEqual(cursorEvents[0].cursor, { x: 1, y: 2, world: false });
		a.fire('close');
		b.fire('close');
	});

	test('bounds draft fields and relays valid structural mutations once', () => {
		const a = response();
		const b = response();
		const canvasId = 'draft-33333333-3333-4333-8333-333333333333';
		const ca = subscribe({ canvasId, workspaceId: 'w', accountId: 'a', sseRes: a });
		subscribe({ canvasId, workspaceId: 'w', accountId: 'b', sseRes: b });
		assert.equal(
			updateDraft({
				canvasId,
				connectionId: ca,
				tempId: 'd1',
				fields: { Name: 'ok' },
				sequence: 1,
				requestingAccountId: 'a',
			}),
			true,
		);
		assert.equal(
			updateDraft({
				canvasId,
				connectionId: ca,
				tempId: 'd1',
				fields: { 'bad-name': 'bad' },
				sequence: 2,
				requestingAccountId: 'a',
			}),
			false,
		);
		assert.equal(
			updateDraft({
				canvasId,
				connectionId: ca,
				tempId: 'd1',
				fields: { Description: 'x'.repeat(70_000) },
				sequence: 3,
				requestingAccountId: 'a',
			}),
			false,
		);
		assert.equal(
			updateDraftLink({
				canvasId,
				connectionId: ca,
				kind: 'add',
				fromSyncId: 'd1',
				toSyncId: 'd2',
				fieldName: 'AccountId',
				sequence: 4,
				requestingAccountId: 'a',
			}),
			true,
		);
		assert.equal(
			removeLoadedRecord({
				canvasId,
				connectionId: ca,
				sfId: '001000000000001',
				sequence: 5,
				requestingAccountId: 'a',
			}),
			true,
		);
		assert.equal(
			updateLayout({
				canvasId,
				connectionId: ca,
				positions: [
					{
						refKind: 'draft',
						ref: 'd1',
						collabRef: 'canvas-card-d1',
						x: 120,
						y: 240,
					},
				],
				sequence: 6,
				requestingAccountId: 'a',
			}),
			true,
		);
		const relayed = events(b).filter((e) =>
			['draft-update', 'draft-link', 'loaded-removed', 'record-layout'].includes(e.type),
		);
		assert.deepEqual(
			relayed.map((e) => e.type),
			['draft-update', 'draft-link', 'loaded-removed', 'record-layout'],
		);
		assert.equal(relayed.at(-1).positions[0].collabRef, 'canvas-card-d1');
		a.fire('close');
		b.fire('close');
	});

	test('projects loaded-record and relationship events through recipient Salesforce visibility', () => {
		const owner = response();
		const viewer = response();
		const canvasId = '069000000000009AAA';
		const ownerConnection = subscribe({
			canvasId,
			workspaceId: 'w',
			accountId: 'owner',
			role: 'owner',
			canEdit: true,
			sseRes: owner,
		});
		subscribe({
			canvasId,
			workspaceId: 'w',
			accountId: 'viewer',
			role: 'viewer',
			canEdit: false,
			visibility: {
				loadedRecords: {
					'003000000000001': {
						objectName: 'Contact',
						readableFields: ['Name', 'AccountId'],
					},
					'001000000000001': {
						objectName: 'Account',
						readableFields: ['Name'],
					},
				},
				drafts: {},
				objects: {
					Contact: { visible: true, readableFields: ['Name', 'AccountId'] },
					Secret_Object__c: { visible: false },
				},
				slots: {},
			},
			sseRes: viewer,
		});

		assert.equal(
			updateLoadedRecord({
				canvasId,
				connectionId: ownerConnection,
				kind: 'update',
				sfId: '003000000000001AAA',
				fields: { Name: 'Visible', Secret__c: 'hidden' },
				sequence: 1,
				requestingAccountId: 'owner',
			}),
			true,
		);
		assert.deepEqual(events(viewer).find((event) => event.type === 'loaded-record').fields, { Name: 'Visible' });

		assert.equal(
			updateDraftLink({
				canvasId,
				connectionId: ownerConnection,
				kind: 'add',
				fromRef: { refKind: 'loaded', ref: '003000000000001AAA' },
				toRef: { refKind: 'loaded', ref: '001000000000999AAA' },
				fieldName: 'AccountId',
				sequence: 2,
				requestingAccountId: 'owner',
			}),
			true,
		);
		assert.equal(events(viewer).filter((event) => event.type === 'draft-link').length, 0);

		assert.equal(
			updateDraftLink({
				canvasId,
				connectionId: ownerConnection,
				kind: 'add',
				fromRef: { refKind: 'loaded', ref: '003000000000001AAA' },
				toRef: { refKind: 'loaded', ref: '001000000000001AAA' },
				fieldName: 'AccountId',
				sequence: 3,
				requestingAccountId: 'owner',
			}),
			true,
		);
		assert.equal(events(viewer).filter((event) => event.type === 'draft-link').length, 1);

		assert.equal(
			updateDraft({
				canvasId,
				connectionId: ownerConnection,
				tempId: 'draft-visible',
				kind: 'create',
				objectName: 'Contact',
				fields: { Name: 'Visible draft', Secret__c: 'hidden draft value' },
				slot: {
					slotId: 'visible-fields',
					kind: 'fields',
					fields: ['Name', 'Secret__c'],
				},
				sequence: 4,
				requestingAccountId: 'owner',
			}),
			true,
		);
		const visibleDraft = events(viewer).find(
			(event) => event.type === 'draft-update' && event.tempId === 'draft-visible',
		);
		assert.deepEqual(visibleDraft.fields, { Name: 'Visible draft' });
		assert.deepEqual(visibleDraft.slot.fields, ['Name']);
		assert.equal(visibleDraft.slot.unavailableFieldCount, 1);

		assert.equal(
			updateDraft({
				canvasId,
				connectionId: ownerConnection,
				tempId: 'draft-hidden',
				canvasRecordId: 'hidden-card-reference',
				kind: 'create',
				objectName: 'Secret_Object__c',
				fields: { Secret__c: 'must not leave the server' },
				sequence: 5,
				requestingAccountId: 'owner',
			}),
			true,
		);
		assert.equal(
			events(viewer).filter((event) => event.type === 'draft-update' && event.tempId === 'draft-hidden').length,
			0,
		);
		const hiddenCreate = events(viewer).find((event) => event.type === 'hidden-record' && event.kind === 'create');
		assert.ok(hiddenCreate);
		assert.match(hiddenCreate.hiddenId, /^hidden-card-[a-f0-9]{24}$/);
		assert.equal(hiddenCreate.tempId, undefined);
		assert.equal(hiddenCreate.objectName, undefined);
		assert.equal(hiddenCreate.fields, undefined);
		assert.equal(hiddenCreate.revision, 5);

		assert.equal(
			updateLayout({
				canvasId,
				connectionId: ownerConnection,
				positions: [
					{
						refKind: 'draft',
						ref: 'draft-hidden',
						collabRef: 'hidden-card-reference',
						x: 410,
						y: 520,
					},
				],
				sequence: 6,
				requestingAccountId: 'owner',
			}),
			true,
		);
		const hiddenLayout = events(viewer).find(
			(event) =>
				event.type === 'record-layout' &&
				event.positions.some((position) => position.hiddenId && position.x === 410),
		);
		assert.deepEqual(hiddenLayout.positions, [{ hiddenId: hiddenCreate.hiddenId, x: 410, y: 520 }]);

		assert.equal(
			updateDraft({
				canvasId,
				connectionId: ownerConnection,
				tempId: 'draft-hidden',
				kind: 'remove',
				fields: {},
				sequence: 7,
				requestingAccountId: 'owner',
			}),
			true,
		);
		const hiddenRemove = events(viewer).find((event) => event.type === 'hidden-record' && event.kind === 'remove');
		assert.equal(hiddenRemove.hiddenId, hiddenCreate.hiddenId);
		assert.equal(hiddenRemove.revision, 7);

		assert.equal(
			removeLoadedRecord({
				canvasId,
				connectionId: ownerConnection,
				sfId: '500000000000001AAA',
				collabRef: 'hidden-loaded-card',
				sequence: 8,
				requestingAccountId: 'owner',
			}),
			true,
		);
		const hiddenLoadedRemove = events(viewer).find(
			(event) => event.type === 'hidden-record' && event.kind === 'remove' && event.revision === 8,
		);
		assert.ok(hiddenLoadedRemove);
		assert.equal(hiddenLoadedRemove.hiddenId, hiddenCanvasRecordId('hidden-loaded-card'));
		assert.equal(hiddenLoadedRemove.sfId, undefined);
		assert.equal(hiddenLoadedRemove.collabRef, undefined);

		owner.fire('close');
		viewer.fire('close');
	});

	test('resolves a restricted editor placeholder move to the owner record without exposing its identity', () => {
		const canvasId = 'hidden-editor-layout';
		const payload = {
			schema: { objects: [{ name: 'Secret_Object__c', label: 'Secret object' }] },
			loadedRecords: [],
			drafts: [
				{
					tempId: 'secret-draft',
					canvasRecordId: 'secret-card',
					objectName: 'Secret_Object__c',
					x: 100,
					y: 200,
					values: { Secret__c: 'hidden' },
				},
			],
			associations: [],
		};
		assert.equal(seedLiveSnapshot({ canvasId, payload }), true);
		const owner = response();
		subscribe({
			canvasId,
			workspaceId: 'w',
			accountId: 'owner-hidden-layout',
			role: 'owner',
			canEdit: true,
			sseRes: owner,
		});
		const editor = response();
		const editorConnection = subscribe({
			canvasId,
			workspaceId: 'w',
			accountId: 'editor-hidden-layout',
			role: 'editor',
			canEdit: true,
			visibility: {
				loadedRecords: {},
				drafts: { 'secret-draft': { visible: false } },
				objects: { Secret_Object__c: { visible: false } },
				slots: {},
			},
			sseRes: editor,
		});

		assert.equal(
			updateLayout({
				canvasId,
				connectionId: editorConnection,
				positions: [{ hiddenId: hiddenCanvasRecordId('secret-card'), x: 450, y: 550 }],
				sequence: 1,
				requestingAccountId: 'editor-hidden-layout',
			}),
			true,
		);

		const ownerLayout = events(owner)
			.filter((event) => event.type === 'record-layout')
			.at(-1);
		assert.deepEqual(ownerLayout.positions, [
			{ refKind: 'draft', ref: 'secret-draft', collabRef: 'secret-card', x: 450, y: 550 },
		]);
		assert.equal(liveSnapshot({ canvasId }).payload.drafts[0].x, 450);
		assert.equal(liveSnapshot({ canvasId }).payload.drafts[0].y, 550);
	});

	test('keeps live slot visibility in sync so new record requests can publish relationships', () => {
		const owner = response();
		const viewer = response();
		const canvasId = 'draft-19191919-1919-4919-8919-191919191919';
		const ownerConnection = subscribe({
			canvasId,
			workspaceId: 'w',
			accountId: 'owner',
			role: 'owner',
			canEdit: true,
			sseRes: owner,
		});
		subscribe({
			canvasId,
			workspaceId: 'w',
			accountId: 'viewer',
			role: 'viewer',
			canEdit: false,
			visibility: {
				loadedRecords: {},
				drafts: {
					'draft-opportunity': {
						visible: true,
						objectName: 'Opportunity',
						readableFields: ['Name', 'Primary_Contact__c'],
					},
					'draft-contact': {
						visible: true,
						objectName: 'Contact',
						readableFields: ['Name'],
					},
				},
				objects: {
					Opportunity: { visible: true, readableFields: ['Name', 'Primary_Contact__c'] },
					Contact: { visible: true, readableFields: ['Name'] },
				},
				slots: {},
			},
			sseRes: viewer,
		});

		assert.equal(
			updateSlot({
				canvasId,
				connectionId: ownerConnection,
				targetRef: { refKind: 'draft', ref: 'draft-opportunity', collabRef: 'opportunity-card' },
				slot: {
					slotId: 'opportunity-request',
					kind: 'whole-record',
					origin: 'standalone',
					label: 'Create an opportunity',
				},
				sequence: 1,
				requestingAccountId: 'owner',
			}),
			true,
		);
		assert.equal(events(viewer).filter((event) => event.type === 'slot-update').length, 1);
		assert.equal(events(viewer).find((event) => event.type === 'slot-update').slot.origin, 'standalone');

		assert.equal(
			updateDraftLink({
				canvasId,
				connectionId: ownerConnection,
				kind: 'add',
				fromRef: {
					refKind: 'slot',
					ref: 'opportunity-request',
					collabRef: 'opportunity-card',
				},
				toRef: { refKind: 'draft', ref: 'draft-contact', collabRef: 'contact-card' },
				fieldName: 'Primary_Contact__c',
				sequence: 2,
				requestingAccountId: 'owner',
			}),
			true,
		);
		assert.equal(events(viewer).filter((event) => event.type === 'draft-link').length, 1);

		assert.equal(
			updateSlot({
				canvasId,
				connectionId: ownerConnection,
				targetRef: { refKind: 'draft', ref: 'draft-opportunity', collabRef: 'opportunity-card' },
				slot: null,
				sequence: 3,
				requestingAccountId: 'owner',
			}),
			true,
		);
		assert.equal(
			updateDraftLink({
				canvasId,
				connectionId: ownerConnection,
				kind: 'add',
				fromRef: { refKind: 'slot', ref: 'opportunity-request', collabRef: 'opportunity-card' },
				toRef: { refKind: 'draft', ref: 'draft-contact', collabRef: 'contact-card' },
				fieldName: 'Primary_Contact__c',
				sequence: 4,
				requestingAccountId: 'owner',
			}),
			true,
		);
		assert.equal(events(viewer).filter((event) => event.type === 'draft-link').length, 1);

		assert.equal(
			updateSlot({
				canvasId,
				connectionId: ownerConnection,
				targetRef: { refKind: 'draft', ref: 'draft-opportunity', collabRef: 'opportunity-card' },
				slot: {
					slotId: 'replacement-opportunity-request',
					kind: 'whole-record',
					label: 'Create an opportunity',
				},
				sequence: 5,
				requestingAccountId: 'owner',
			}),
			true,
		);
		assert.equal(
			updateDraftLink({
				canvasId,
				connectionId: ownerConnection,
				kind: 'add',
				fromRef: {
					refKind: 'slot',
					ref: 'replacement-opportunity-request',
					collabRef: 'opportunity-card',
				},
				toRef: { refKind: 'draft', ref: 'draft-contact', collabRef: 'contact-card' },
				fieldName: 'Primary_Contact__c',
				sequence: 6,
				requestingAccountId: 'owner',
			}),
			true,
		);
		assert.equal(events(viewer).filter((event) => event.type === 'draft-link').length, 2);

		owner.fire('close');
		viewer.fire('close');
	});

	test('returns an owner-completed record request to the editor who created it', () => {
		const editor = response();
		const owner = response();
		const canvasId = 'draft-20202020-2020-4020-8020-202020202020';
		assert.equal(
			seedLiveSnapshot({
				canvasId,
				payload: {
					schema: { objects: [{ name: 'Opportunity', label: 'Opportunity' }] },
					loadedRecords: [],
					drafts: [],
					associations: [],
				},
			}),
			true,
		);
		const editorConnection = subscribe({
			canvasId,
			workspaceId: 'w',
			accountId: 'editor',
			role: 'editor',
			canEdit: true,
			visibility: {
				loadedRecords: {},
				drafts: {},
				objects: {
					Opportunity: { visible: true, readableFields: ['Name'] },
				},
				slots: {},
			},
			sseRes: editor,
		});
		const ownerConnection = subscribe({
			canvasId,
			workspaceId: 'w',
			accountId: 'owner',
			role: 'owner',
			canEdit: true,
			sseRes: owner,
		});

		assert.equal(
			updateDraft({
				canvasId,
				connectionId: editorConnection,
				tempId: 'draft-opportunity',
				canvasRecordId: 'opportunity-card',
				kind: 'create',
				objectName: 'Opportunity',
				fields: {},
				slot: {
					slotId: 'opportunity-request',
					kind: 'whole-record',
					origin: 'standalone',
					label: 'Create an opportunity',
				},
				sequence: 1,
				requestingAccountId: 'editor',
			}),
			true,
		);

		const targetRef = {
			refKind: 'slot',
			ref: 'opportunity-request',
			collabRef: 'opportunity-card',
		};
		const lock = acquireFieldLock({
			canvasId,
			connectionId: ownerConnection,
			targetRef,
			fieldName: 'Name',
			requestingAccountId: 'owner',
		});
		assert.equal(lock.ok, true);
		assert.equal(
			commitFieldValues({
				canvasId,
				connectionId: ownerConnection,
				targetRef,
				fields: { Name: 'Completed by owner' },
				leases: {
					Name: {
						leaseId: lock.lock.leaseId,
						baseVersion: lock.lock.baseVersion,
					},
				},
				requestingAccountId: 'owner',
			}).ok,
			true,
		);

		const completed = events(editor).find(
			(event) => event.type === 'field-update' && event.targetRef.ref === 'opportunity-request',
		);
		assert.deepEqual(completed.fields, { Name: 'Completed by owner' });

		editor.fire('close');
		owner.fire('close');
	});

	test('SSE errors clean up half-open subscriptions', () => {
		const a = response();
		const canvasId = 'draft-44444444-4444-4444-8444-444444444444';
		subscribe({ canvasId, workspaceId: 'w', accountId: 'a', sseRes: a });
		assert.equal(summary({ canvasId }).count, 1);
		a.fire('error');
		assert.equal(summary({ canvasId }).count, 0);
		assert.equal(unsubscribe({ canvasId, connectionId: 'missing' }), false);
	});

	test('namespaces identical canvas ids by Salesforce org', () => {
		const canvasId = '069000000000777AAA';
		const orgA = '00D000000000001AAA';
		const orgB = '00D000000000002AAA';
		const a1 = response();
		const a2 = response();
		const b1 = response();
		const connectionA = subscribe({
			canvasId,
			sfOrgId: orgA,
			workspaceId: 'workspace-a',
			accountId: 'account-a',
			sseRes: a1,
		});
		subscribe({
			canvasId,
			sfOrgId: orgA,
			workspaceId: 'workspace-a',
			accountId: 'account-a-peer',
			sseRes: a2,
		});
		subscribe({
			canvasId,
			sfOrgId: orgB,
			workspaceId: 'workspace-b',
			accountId: 'account-b',
			sseRes: b1,
		});

		assert.equal(summary({ canvasId, sfOrgId: orgA }).count, 2);
		assert.equal(summary({ canvasId, sfOrgId: orgB }).count, 1);
		assert.equal(
			updateCursor({
				canvasId,
				connectionId: connectionA,
				x: 10,
				y: 20,
				sequence: 1,
				requestingAccountId: 'account-a',
			}),
			true,
		);
		assert.equal(events(a2).filter((event) => event.type === 'cursor').length, 1);
		assert.equal(events(b1).filter((event) => event.type === 'cursor').length, 0);

		a1.fire('close');
		a2.fire('close');
		b1.fire('close');
	});

	test('viewer and contributor peers can share cursor/focus but not structural mutations', () => {
		const a = response();
		const b = response();
		const c = response();
		const canvasId = 'draft-55555555-5555-4555-8555-555555555555';
		const ca = subscribe({ canvasId, workspaceId: 'w1', accountId: 'a', canEdit: false, sseRes: a });
		subscribe({ canvasId, workspaceId: 'w1', accountId: 'b', sseRes: b });
		subscribe({ canvasId, workspaceId: 'w2', accountId: 'c', sseRes: c });
		assert.equal(
			updateCursor({ canvasId, connectionId: ca, x: 1, y: 1, sequence: 1, requestingAccountId: 'a' }),
			true,
		);
		assert.equal(
			updateFocus({
				canvasId,
				connectionId: ca,
				focus: { kind: 'record', ref: 'slot-1' },
				sequence: 2,
				requestingAccountId: 'a',
			}),
			true,
		);
		assert.equal(
			updateDraft({
				canvasId,
				connectionId: ca,
				tempId: 'd1',
				fields: { Name: 'forged' },
				sequence: 3,
				requestingAccountId: 'a',
			}),
			false,
		);
		assert.equal(
			updateLayout({
				canvasId,
				connectionId: ca,
				positions: [{ refKind: 'slot', ref: 'slot-1', x: 10, y: 20 }],
				sequence: 3,
				requestingAccountId: 'a',
			}),
			false,
		);
		assert.equal(purgeAccountFromWorkspace({ workspaceId: 'w1', accountId: 'a' }), 1);
		assert.equal(
			updateFocus({ canvasId, connectionId: ca, focus: {}, sequence: 4, requestingAccountId: 'a' }),
			false,
		);
		assert.equal(summary({ canvasId }).count, 2);
		assert.equal(purgeWorkspace({ workspaceId: 'w1' }), 1);
		assert.equal(summary({ canvasId }).count, 1);
		assert.equal(purgeWorkspace({ workspaceId: 'w2' }), 1);
	});

	test('relays bounded relationship references for every canvas record kind', () => {
		const a = response();
		const b = response();
		const canvasId = 'draft-66666666-6666-4666-8666-666666666666';
		const ca = subscribe({ canvasId, workspaceId: 'w', accountId: 'a', sseRes: a });
		subscribe({ canvasId, workspaceId: 'w', accountId: 'b', sseRes: b });
		assert.equal(
			updateDraftLink({
				canvasId,
				connectionId: ca,
				kind: 'add',
				fromRef: { refKind: 'loaded', ref: '003000000000001' },
				toRef: { refKind: 'slot', ref: 'slot-9' },
				fieldName: 'AccountId',
				sequence: 1,
				requestingAccountId: 'a',
			}),
			true,
		);
		const link = events(b).find((event) => event.type === 'draft-link');
		assert.deepEqual(link.fromRef, { refKind: 'loaded', ref: '003000000000001' });
		assert.deepEqual(link.toRef, { refKind: 'slot', ref: 'slot-9' });
		assert.equal(link.fieldName, 'AccountId');
		assert.equal(
			updateDraftLink({
				canvasId,
				connectionId: ca,
				kind: 'add',
				fromRef: { refKind: 'unknown', ref: 'bad' },
				toRef: { refKind: 'slot', ref: 'slot-9' },
				fieldName: 'AccountId',
				sequence: 2,
				requestingAccountId: 'a',
			}),
			false,
		);
		a.fire('close');
		b.fire('close');
	});

	test('revisions structural events and marks the matching snapshot durable on save', () => {
		const editor = response();
		const viewer = response();
		const canvasId = '069000000000020AAA';
		const editorConnection = subscribe({
			canvasId,
			workspaceId: 'w',
			accountId: 'editor',
			role: 'editor',
			canEdit: true,
			sseRes: editor,
		});
		const viewerConnection = subscribe({
			canvasId,
			workspaceId: 'w',
			accountId: 'viewer',
			role: 'viewer',
			canEdit: false,
			sseRes: viewer,
		});
		assert.equal(
			updateLoadedRecord({
				canvasId,
				connectionId: editorConnection,
				kind: 'update',
				sfId: '001000000000001AAA',
				collabRef: 'account-card',
				fields: { Name: 'Live' },
				sequence: 1,
				requestingAccountId: 'editor',
			}),
			true,
		);
		const update = events(viewer).find((event) => event.type === 'loaded-record');
		assert.equal(update.revision, 1);
		assert.equal(update.collabRef, 'account-card');
		assert.equal(
			updateSlot({
				canvasId,
				connectionId: editorConnection,
				targetRef: {
					refKind: 'loaded',
					ref: '001000000000001AAA',
					collabRef: 'account-card',
				},
				slot: {
					slotId: 9,
					kind: 'fields',
					label: 'Complete account',
					fields: ['Name'],
					assigneeSfUserId: '005000000000001AAA',
				},
				sequence: 2,
				requestingAccountId: 'editor',
			}),
			true,
		);
		const slot = events(viewer).find((event) => event.type === 'slot-update');
		assert.equal(slot.revision, 2);
		assert.deepEqual(slot.slot.fields, ['Name']);
		assert.equal(slot.targetRef.collabRef, 'account-card');
		assert.equal(
			updateLoadedRecord({
				canvasId,
				connectionId: viewerConnection,
				kind: 'update',
				sfId: '001000000000001AAA',
				fields: { Name: 'Forged' },
				sequence: 1,
				requestingAccountId: 'viewer',
			}),
			false,
		);

		const payload = {
			_meta: { savedAt: 'one value' },
			loadedRecords: [{ loadedFromId: '001000000000001AAA', changes: { Name: 'Live' } }],
		};
		const snapshotHash = canvasSnapshotHash(payload);
		assert.equal(
			snapshotHash,
			canvasSnapshotHash({
				_meta: { savedAt: 'another value' },
				loadedRecords: [{ changes: { Name: 'Live' }, loadedFromId: '001000000000001AAA' }],
			}),
		);
		broadcastCanvasSaved({
			canvasId,
			savedByAccountId: 'editor',
			versionId: '068000000000020AAA',
			snapshotHash,
		});
		const saved = events(viewer).find((event) => event.type === 'canvas-saved');
		assert.equal(saved.revision, 2);
		assert.equal(saved.snapshotHash, snapshotHash);
		editor.fire('close');
		viewer.fire('close');
	});

	test('promotes a draft atomically when upload events arrive before draft removal', () => {
		const canvasId = '069000000000021AAA';
		const owner = response();
		const connectionId = subscribe({
			canvasId,
			workspaceId: 'w',
			accountId: 'owner',
			role: 'owner',
			canEdit: true,
			sseRes: owner,
		});
		seedLiveSnapshot({
			canvasId,
			payload: {
				schema: { objects: [{ name: 'Account', label: 'Account' }] },
				loadedRecords: [],
				drafts: [
					{
						tempId: 'draft-account',
						canvasRecordId: 'account-card',
						objectName: 'Account',
						x: 10,
						y: 20,
						values: { Name: 'Before upload' },
						slot: { slotId: 'account-request', kind: 'whole-record' },
					},
				],
				associations: [
					{
						from: { kind: 'slot', ref: 'account-request' },
						to: { kind: 'loaded', ref: '001000000000099AAA' },
						fieldName: 'ParentId',
					},
				],
			},
		});

		assert.equal(
			updateLoadedRecord({
				canvasId,
				connectionId,
				kind: 'create',
				sfId: '001000000000021AAA',
				collabRef: 'account-card',
				objectName: 'Account',
				fields: { Id: '001000000000021AAA', Name: 'After upload' },
				baseline: { Id: '001000000000021AAA', Name: 'After upload' },
				promotedFrom: {
					refKind: 'slot',
					ref: 'account-request',
					sourceRefKind: 'draft',
					sourceRef: 'draft-account',
					collabRef: 'account-card',
				},
				slot: null,
				x: 10,
				y: 20,
				sequence: 1,
				requestingAccountId: 'owner',
			}),
			true,
		);
		let snapshot = liveSnapshot({ canvasId }).payload;
		assert.equal(snapshot.drafts.length, 0);
		assert.equal(snapshot.loadedRecords.length, 1);
		assert.equal(snapshot.loadedRecords[0].loadedFromId, '001000000000021AAA');
		assert.equal(snapshot.loadedRecords[0].x, 10);
		assert.equal(snapshot.loadedRecords[0].y, 20);
		assert.equal(snapshot.loadedRecords[0].slot, undefined);
		assert.deepEqual(snapshot.associations[0].from, {
			kind: 'loaded',
			ref: '001000000000021AAA',
		});
		assert.equal(
			events(owner).filter((event) => event.type === 'record-layout').length,
			0,
			'promoting a draft must not move its card to avoid colliding with itself',
		);

		assert.equal(
			updateDraft({
				canvasId,
				connectionId,
				tempId: 'draft-account',
				kind: 'remove',
				fields: {},
				sequence: 2,
				requestingAccountId: 'owner',
			}),
			true,
		);
		snapshot = liveSnapshot({ canvasId }).payload;
		assert.equal(snapshot.drafts.length, 0);
		assert.equal(snapshot.loadedRecords.length, 1);
		owner.fire('close');
	});

	test('rebases a modified live record after Salesforce accepts the upload', () => {
		const canvasId = '069000000000023AAA';
		const owner = response();
		const viewer = response();
		const ownerConnection = subscribe({
			canvasId,
			workspaceId: 'w',
			accountId: 'owner',
			role: 'owner',
			canEdit: true,
			sseRes: owner,
		});
		subscribe({
			canvasId,
			workspaceId: 'w',
			accountId: 'viewer',
			role: 'viewer',
			canEdit: false,
			sseRes: viewer,
		});
		seedLiveSnapshot({
			canvasId,
			payload: {
				schema: { objects: [{ name: 'Account', label: 'Account' }] },
				loadedRecords: [
					{
						loadedFromId: '001000000000023AAA',
						canvasRecordId: 'account-card',
						objectName: 'Account',
						changes: { Name: 'After' },
					},
				],
				drafts: [],
				associations: [],
			},
		});

		assert.equal(
			updateLoadedRecord({
				canvasId,
				connectionId: ownerConnection,
				kind: 'update',
				sfId: '001000000000023AAA',
				collabRef: 'account-card',
				fields: { Name: 'After' },
				baseline: { Name: 'After' },
				sequence: 1,
				requestingAccountId: 'owner',
			}),
			true,
		);
		const snapshot = liveSnapshot({ canvasId }).payload;
		assert.equal(snapshot.loadedRecords[0].changes, undefined);
		const rebase = events(viewer).find((event) => event.type === 'loaded-record');
		assert.deepEqual(rebase.baseline, { Name: 'After' });
		owner.fire('close');
		viewer.fire('close');
	});

	test('coalesces uploaded draft visibility refreshes into one final recipient snapshot', async () => {
		const canvasId = '069000000000022AAA';
		const sfOrgId = '00D000000000022AAA';
		const payload = {
			schema: { objects: [{ name: 'Account', label: 'Account' }] },
			loadedRecords: [],
			drafts: [
				{
					tempId: 'draft-one',
					canvasRecordId: 'account-card-one',
					objectName: 'Account',
					x: 100,
					y: 200,
					values: { Name: 'One' },
				},
				{
					tempId: 'draft-two',
					canvasRecordId: 'account-card-two',
					objectName: 'Account',
					x: 500,
					y: 600,
					values: { Name: 'Two' },
				},
			],
			associations: [],
		};
		assert.equal(seedLiveSnapshot({ canvasId, sfOrgId, payload }), true);
		const owner = response();
		const ownerConnection = subscribe({
			canvasId,
			sfOrgId,
			workspaceId: 'w',
			accountId: 'owner',
			role: 'owner',
			canEdit: true,
			sseRes: owner,
		});
		let projectionCalls = 0;
		const editor = response();
		subscribe({
			canvasId,
			sfOrgId,
			workspaceId: 'w',
			accountId: 'editor',
			role: 'editor',
			canEdit: true,
			projectSnapshot: async (snapshot) => {
				projectionCalls += 1;
				return {
					payload: snapshot,
					visibility: {
						loadedRecords: {},
						drafts: {},
						objects: { Account: { visible: true, readableFields: ['Name'] } },
						slots: {},
					},
				};
			},
			sseRes: editor,
		});
		await new Promise((resolve) => setImmediate(resolve));
		projectionCalls = 0;
		editor.writes.length = 0;

		assert.equal(
			updateLoadedRecord({
				canvasId,
				connectionId: ownerConnection,
				kind: 'create',
				sfId: '001000000000021AAA',
				collabRef: 'account-card-one',
				objectName: 'Account',
				fields: { Name: 'One' },
				baseline: { Name: 'One' },
				x: 100,
				y: 200,
				sequence: 1,
				requestingAccountId: 'owner',
			}),
			true,
		);
		assert.equal(
			updateLoadedRecord({
				canvasId,
				connectionId: ownerConnection,
				kind: 'create',
				sfId: '001000000000022AAA',
				collabRef: 'account-card-two',
				objectName: 'Account',
				fields: { Name: 'Two' },
				baseline: { Name: 'Two' },
				x: 500,
				y: 600,
				sequence: 2,
				requestingAccountId: 'owner',
			}),
			true,
		);

		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.equal(projectionCalls, 1);
		const snapshots = events(editor).filter((event) => event.type === 'live-snapshot');
		assert.equal(snapshots.length, 1);
		assert.equal(snapshots[0].payload.drafts.length, 0);
		assert.deepEqual(
			snapshots[0].payload.loadedRecords.map((record) => [record.canvasRecordId, record.x, record.y]),
			[
				['account-card-one', 100, 200],
				['account-card-two', 500, 600],
			],
		);

		owner.fire('close');
		editor.fire('close');
	});
});
