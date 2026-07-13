import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
	subscribe, unsubscribe, updateCursor, updateDraft, updateDraftLink,
	removeLoadedRecord, updateFocus, summary, purgeAccountFromWorkspace, purgeWorkspace,
} from '../src/canvas-presence.js';

function response() {
	const handlers = new Map();
	const writes = [];
	return {
		writes,
		write(chunk) {
 writes.push(chunk); return true; 
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
	test('binds writes to account+canvas and rejects stale/out-of-order events', () => {
		const a = response();
		const b = response();
		const ca = subscribe({ canvasId: 'draft-11111111-1111-4111-8111-111111111111', workspaceId: 'w1', accountId: 'a', displayName: 'A', sseRes: a });
		subscribe({ canvasId: 'draft-11111111-1111-4111-8111-111111111111', workspaceId: 'w2', accountId: 'b', displayName: 'B', sseRes: b });
		assert.equal(updateCursor({ canvasId: 'draft-11111111-1111-4111-8111-111111111111', connectionId: ca, x: 1, y: 2, sequence: 2, requestingAccountId: 'a' }), true);
		assert.equal(updateCursor({ canvasId: 'draft-11111111-1111-4111-8111-111111111111', connectionId: ca, x: 9, y: 9, sequence: 1, requestingAccountId: 'a' }), false);
		assert.equal(updateFocus({ canvasId: 'draft-11111111-1111-4111-8111-111111111111', connectionId: ca, focus: {}, sequence: 3, requestingAccountId: 'attacker' }), false);
		assert.equal(updateFocus({ canvasId: 'draft-22222222-2222-4222-8222-222222222222', connectionId: ca, focus: {}, sequence: 3, requestingAccountId: 'a' }), false);
		const cursorEvents = events(b).filter((e) => e.type === 'cursor');
		assert.equal(cursorEvents.length, 1);
		assert.deepEqual(cursorEvents[0].cursor, { x: 1, y: 2, world: false });
		a.fire('close'); b.fire('close');
	});

	test('bounds draft fields and relays valid structural mutations once', () => {
		const a = response(); const b = response();
		const canvasId = 'draft-33333333-3333-4333-8333-333333333333';
		const ca = subscribe({ canvasId, workspaceId: 'w', accountId: 'a', sseRes: a });
		subscribe({ canvasId, workspaceId: 'w', accountId: 'b', sseRes: b });
		assert.equal(updateDraft({ canvasId, connectionId: ca, tempId: 'd1', fields: { Name: 'ok' }, sequence: 1, requestingAccountId: 'a' }), true);
		assert.equal(updateDraft({ canvasId, connectionId: ca, tempId: 'd1', fields: { 'bad-name': 'bad' }, sequence: 2, requestingAccountId: 'a' }), false);
		assert.equal(updateDraft({ canvasId, connectionId: ca, tempId: 'd1', fields: { Description: 'x'.repeat(70_000) }, sequence: 3, requestingAccountId: 'a' }), false);
		assert.equal(updateDraftLink({ canvasId, connectionId: ca, kind: 'add', fromSyncId: 'd1', toSyncId: 'd2', fieldName: 'AccountId', sequence: 4, requestingAccountId: 'a' }), true);
		assert.equal(removeLoadedRecord({ canvasId, connectionId: ca, sfId: '001000000000001', sequence: 5, requestingAccountId: 'a' }), true);
		const relayed = events(b).filter((e) => ['draft-update', 'draft-link', 'loaded-removed'].includes(e.type));
		assert.deepEqual(relayed.map((e) => e.type), ['draft-update', 'draft-link', 'loaded-removed']);
		a.fire('close'); b.fire('close');
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

	test('read-only peers cannot send structural mutations and revocation purges immediately', () => {
		const a = response(); const b = response(); const c = response();
		const canvasId = 'draft-55555555-5555-4555-8555-555555555555';
		const ca = subscribe({ canvasId, workspaceId: 'w1', accountId: 'a', canEdit: false, sseRes: a });
		subscribe({ canvasId, workspaceId: 'w1', accountId: 'b', sseRes: b });
		subscribe({ canvasId, workspaceId: 'w2', accountId: 'c', sseRes: c });
		assert.equal(updateCursor({ canvasId, connectionId: ca, x: 1, y: 1, sequence: 1, requestingAccountId: 'a' }), true);
		assert.equal(updateDraft({ canvasId, connectionId: ca, tempId: 'd1', fields: { Name: 'forged' }, sequence: 2, requestingAccountId: 'a' }), false);
		assert.equal(purgeAccountFromWorkspace({ workspaceId: 'w1', accountId: 'a' }), 1);
		assert.equal(updateFocus({ canvasId, connectionId: ca, focus: {}, sequence: 3, requestingAccountId: 'a' }), false);
		assert.equal(summary({ canvasId }).count, 2);
		assert.equal(purgeWorkspace({ workspaceId: 'w1' }), 1);
		assert.equal(summary({ canvasId }).count, 1);
		assert.equal(purgeWorkspace({ workspaceId: 'w2' }), 1);
	});
});
