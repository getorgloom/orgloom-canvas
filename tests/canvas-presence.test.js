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
	liveSnapshot,
	unsavedLiveSnapshot,
} from '../src/canvas-presence.js';

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
		assert.equal(snapshots.length, 2);
		assert.equal(snapshots[1].revision, 3);
		assert.deepEqual(snapshots[1].payload.drafts[1].values, { Name: 'Created live' });
		assert.equal(projectionCalls, 2);
		assert.equal(liveSnapshot({ canvasId }).payload.drafts[1].values.Secret__c, 'Still hidden');
		assert.deepEqual(unsavedLiveSnapshot({ canvasId }).payload.drafts[0].values, {
			Name: 'Visible live',
			Secret__c: 'Hidden',
		});

		owner.fire('close');
		viewer.fire('close');
		assert.equal(liveSnapshot({ canvasId }), null);
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
				sequence: 4,
				requestingAccountId: 'owner',
			}),
			true,
		);
		const visibleDraft = events(viewer).find(
			(event) => event.type === 'draft-update' && event.tempId === 'draft-visible',
		);
		assert.deepEqual(visibleDraft.fields, { Name: 'Visible draft' });

		assert.equal(
			updateDraft({
				canvasId,
				connectionId: ownerConnection,
				tempId: 'draft-hidden',
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

		owner.fire('close');
		viewer.fire('close');
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
					label: 'Create an opportunity',
				},
				sequence: 1,
				requestingAccountId: 'owner',
			}),
			true,
		);
		assert.equal(events(viewer).filter((event) => event.type === 'slot-update').length, 1);

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
});
