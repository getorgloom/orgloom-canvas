import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
	SHARED_CANVAS_ENTRY,
	canvasEntryStartsTrial,
	classifySharedCanvasEntry,
	isFreeSharedRecipientGrant,
	isFreeViewerGrant,
	recipientRequiresPlan,
} from '../src/shared-canvas-entitlement.js';

const CANVAS_ID = 'a01xx0000000001AAA';
const SF_ORG_ID = '00Dxx0000000001AAA';
const SF_USER_ID = '005xx0000000001AAA';

function classify({ item = { ownedByMe: false }, grant = { role: 'viewer' } } = {}) {
	return classifySharedCanvasEntry({
		canvasId: CANVAS_ID,
		sfOrgId: SF_ORG_ID,
		sfUserId: SF_USER_ID,
		getCanvas: async () => item,
		getGrant: async (key) => {
			assert.deepEqual(key, {
				sfOrgId: SF_ORG_ID,
				canvasId: CANVAS_ID,
				recipientSfUserId: SF_USER_ID,
			});
			return grant;
		},
	});
}

describe('shared canvas recipient entitlement', () => {
	test('Viewer and Contributor grants are free while Editor remains paid', () => {
		assert.equal(isFreeViewerGrant({ role: 'viewer' }), true);
		assert.equal(isFreeSharedRecipientGrant({ role: 'viewer' }), true);
		assert.equal(isFreeSharedRecipientGrant({ role: 'contributor' }), true);
		for (const grant of [null, {}, { role: 'editor' }]) {
			assert.equal(isFreeViewerGrant(grant), false);
			assert.equal(recipientRequiresPlan(grant), true);
		}
		assert.equal(recipientRequiresPlan({ role: 'viewer' }), false);
		assert.equal(recipientRequiresPlan({ role: 'contributor' }), false);
	});

	test('only owner and paid-recipient deep links start an unused trial', () => {
		assert.equal(canvasEntryStartsTrial(SHARED_CANVAS_ENTRY.OWNER), true);
		assert.equal(canvasEntryStartsTrial(SHARED_CANVAS_ENTRY.PAID_RECIPIENT), true);
		for (const kind of [
			SHARED_CANVAS_ENTRY.FREE_VIEWER,
			SHARED_CANVAS_ENTRY.FREE_CONTRIBUTOR,
			SHARED_CANVAS_ENTRY.INACCESSIBLE,
			SHARED_CANVAS_ENTRY.INVALID,
			SHARED_CANVAS_ENTRY.UNCLASSIFIED_RECIPIENT,
		]) {
			assert.equal(canvasEntryStartsTrial(kind), false);
		}
	});

	test('classifies an accessible non-owner Viewer without a paid entitlement', async () => {
		const result = await classify();
		assert.equal(result.kind, SHARED_CANVAS_ENTRY.FREE_VIEWER);
		assert.equal(result.grant.role, 'viewer');
	});

	test('Contributor entry is free and Editor requires a trial, subscription, or seat', async () => {
		const contributor = await classify({ grant: { role: 'contributor' } });
		assert.equal(contributor.kind, SHARED_CANVAS_ENTRY.FREE_CONTRIBUTOR);
		assert.equal(canvasEntryStartsTrial(contributor.kind), false);

		const editor = await classify({ grant: { role: 'editor' } });
		assert.equal(editor.kind, SHARED_CANVAS_ENTRY.PAID_RECIPIENT);
		assert.equal(canvasEntryStartsTrial(editor.kind), true);
	});

	test('an owner opening their own canvas counts as product use', async () => {
		const result = await classify({ item: { ownedByMe: true }, grant: null });
		assert.equal(result.kind, SHARED_CANVAS_ENTRY.OWNER);
	});

	test('a forwarded URL, stale role row, or missing role row never becomes free access', async () => {
		assert.equal((await classify({ item: null })).kind, SHARED_CANVAS_ENTRY.INACCESSIBLE);
		assert.equal((await classify({ grant: null })).kind, SHARED_CANVAS_ENTRY.UNCLASSIFIED_RECIPIENT);
	});

	test('rejects malformed or incomplete identity input before any lookup', async () => {
		let called = false;
		const result = await classifySharedCanvasEntry({
			canvasId: 'not-an-id',
			sfOrgId: SF_ORG_ID,
			sfUserId: SF_USER_ID,
			getCanvas: async () => {
				called = true;
				return {};
			},
			getGrant: async () => {
				called = true;
				return {};
			},
		});
		assert.equal(result.kind, SHARED_CANVAS_ENTRY.INVALID);
		assert.equal(called, false);
	});
});
