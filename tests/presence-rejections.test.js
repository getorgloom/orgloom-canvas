import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import * as presence from '../src/canvas-presence.js';

function connection(canEdit = true) {
	const canvasId = 'diagnostic-' + crypto.randomUUID();
	const connectionId = presence.subscribe({
		canvasId,
		workspaceId: 'w',
		accountId: 'owner',
		canEdit,
		sseRes: {
			write() {
				return true;
			},
			on() {},
		},
	});
	return { canvasId, connectionId, requestingAccountId: 'owner' };
}

function rejected(fn, input, reason) {
	const diagnostics = [];
	assert.equal(fn({ ...input, onRejected: (detail) => diagnostics.push(detail) }), false);
	assert.equal(diagnostics.length, 1);
	assert.equal(diagnostics[0].error, 'presence-event-rejected');
	assert.equal(diagnostics[0].reason, reason);
	assert.ok(diagnostics[0].message);
	return diagnostics[0];
}

test('all live mutation routes return specific diagnostics and preserve missing-connection validation', async () => {
	const source = readFileSync(new URL('../src/canvas-routes.js', import.meta.url), 'utf8');
	for (const path of ['cursor', 'focus', 'layout', 'draft', 'draft-link', 'slot', 'record-remove', 'loaded-record']) {
		const start = source.indexOf("app.post('/api/canvas/:id/presence/" + path + "'");
		assert.ok(start >= 0, path);
		const end = source.indexOf('\n\t});', start) + '\n\t});'.length;
		let handler;
		vm.runInNewContext(source.slice(start, end), {
			app: {
				post(_path, ...handlers) {
					handler = handlers.at(-1);
				},
			},
			requireAccount() {},
			requireSfOrgApproval() {},
			canvasPresence: presence,
		});
		let status = 200;
		let response;
		const res = {
			status(code) {
				status = code;
				return this;
			},
			json(body) {
				response = body;
			},
		};
		const body = {
			connectionId: 'unknown',
			sequence: 1,
			kind: path === 'draft-link' ? 'add' : 'create',
			tempId: 'draft',
			sfId: '001000000000001AAA',
			fields: {},
			fromSyncId: 'one',
			toSyncId: 'two',
			fieldName: 'AccountId',
		};
		const req = { params: { id: 'canvas' }, account: { id: 'owner' }, body };
		await handler(req, res, (error) => {
			throw error;
		});
		assert.equal(status, 409, path);
		assert.equal(response.reason, 'presence-connection-stale', path);
		assert.equal(response.error, 'presence-event-rejected');
		assert.ok(response.message);
		delete body.connectionId;
		await handler(req, res, (error) => {
			throw error;
		});
		assert.equal(status, 400, path);
		assert.equal(response.error, 'missing-connectionId');
	}
});

test('layout diagnostics distinguish permissions, input, ordering, and snapshot mismatch', () => {
	const common = connection();
	const viewer = connection(false);
	try {
		const positions = [{ refKind: 'draft', ref: 'one', x: 93, y: 83.46875 }];
		const input = { ...common, positions, sequence: 1 };
		const missing = rejected(
			presence.updateLayout,
			{ ...input, connectionId: 'missing' },
			'presence-connection-stale',
		);
		const foreign = rejected(
			presence.updateLayout,
			{ ...input, requestingAccountId: 'other' },
			'presence-connection-stale',
		);
		assert.deepEqual(foreign, missing, 'diagnostics must not reveal foreign connection ownership');
		rejected(presence.updateLayout, { ...viewer, positions, sequence: 1 }, 'presence-edit-not-permitted');
		rejected(presence.updateLayout, { ...input, sequence: '1' }, 'presence-invalid-sequence');
		rejected(presence.updateLayout, { ...input, positions: [] }, 'presence-invalid-positions');
		rejected(presence.updateLayout, input, 'presence-stale-sequence');
		rejected(
			presence.updateLayout,
			{ ...input, sequence: 2, positions: [{ ...positions[0], x: NaN }] },
			'presence-invalid-position',
		);
		rejected(
			presence.updateLayout,
			{ ...input, sequence: 3, positions: [{ ...positions[0], refKind: 'unknown' }] },
			'presence-invalid-record-reference',
		);
		rejected(
			presence.updateLayout,
			{ ...input, sequence: 4, positions: [{ hiddenId: 'unknown', x: 1, y: 1 }] },
			'presence-hidden-reference-unavailable',
		);
		presence.seedLiveSnapshot({
			canvasId: common.canvasId,
			payload: {
				schema: { objects: [] },
				drafts: [],
				loadedRecords: [],
				associations: [],
			},
		});
		rejected(presence.updateLayout, { ...input, sequence: 5 }, 'presence-record-not-in-snapshot');
		assert.equal(
			presence.updateDraft({
				...common,
				tempId: 'one',
				kind: 'create',
				objectName: 'Contact',
				fields: {},
				sequence: 6,
			}),
			true,
		);
		assert.equal(
			presence.updateLayout({
				...input,
				sequence: 7,
				onRejected() {
					assert.fail('success must not emit rejection');
				},
			}),
			true,
		);
	} finally {
		presence.unsubscribe(common);
		presence.unsubscribe(viewer);
	}
});

test('draft payload and permission diagnostics contain no field values or record identifiers', () => {
	const common = connection();
	try {
		const input = { ...common, tempId: 'private-record-id', sequence: 1, fields: null };
		rejected(presence.updateDraft, input, 'presence-invalid-fields');
		const fields = Object.fromEntries(Array.from({ length: 101 }, (_, i) => ['Field' + i, 'private-value']));
		const tooMany = rejected(presence.updateDraft, { ...input, sequence: 2, fields }, 'presence-too-many-fields');
		assert.doesNotMatch(JSON.stringify(tooMany), /private-value|private-record-id|Field0/);
		rejected(
			presence.updateDraft,
			{ ...input, sequence: 3, fields: { Name: 'x'.repeat(65536) } },
			'presence-payload-too-large',
		);
		rejected(
			presence.updateDraft,
			{ ...input, sequence: 4, fields: { 'invalid-name': 1 } },
			'presence-invalid-fields',
		);
		rejected(
			presence.updateDraft,
			{ ...input, sequence: 5, kind: 'create', objectName: '?', fields: {} },
			'presence-invalid-object',
		);
	} finally {
		presence.unsubscribe(common);
	}
});

test('cursor and focus explain stale sequences without weakening replay checks', () => {
	const common = connection();
	try {
		for (const fn of [presence.updateCursor, presence.updateFocus]) {
			assert.equal(fn({ ...common, sequence: 2 }), true);
			rejected(fn, { ...common, sequence: 1 }, 'presence-stale-sequence');
			rejected(fn, { ...common, sequence: 2 }, 'presence-stale-sequence');
			rejected(fn, { ...common, sequence: NaN }, 'presence-invalid-sequence');
		}
	} finally {
		presence.unsubscribe(common);
	}
});
