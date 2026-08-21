import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/public/js/canvas-save-state.js', import.meta.url), 'utf8');

function createHarness({ currentCanvas = null, payload = {} } = {}) {
	let currentPayload = payload;
	const events = [];
	class CustomEvent {
		constructor(type, options) {
			this.type = type;
			this.detail = options && options.detail;
		}
	}
	const window = {
		OrgLoom: {},
		CustomEvent,
		dispatchEvent(event) {
			events.push(event);
		},
	};
	vm.runInNewContext(source, { window, JSON, Date });
	const canvasState = { currentCanvas };
	const tracker = window.OrgLoom.canvasSaveState.mount({ canvasState });
	tracker.setPayloadProvider(() => currentPayload);
	return {
		canvasState,
		events,
		tracker,
		setPayload(next) {
			currentPayload = next;
		},
	};
}

test('new blank and populated canvases report the correct save state', () => {
	const harness = createHarness({ payload: { drafts: [], loadedRecords: [], associations: [] } });

	assert.equal(harness.tracker.hasUnsavedChanges(), false);
	assert.equal(harness.tracker.getState().phase, 'new');
	assert.equal(harness.tracker.getState().dirty, false);
	assert.equal(harness.tracker.getState().savedAt, null);
	assert.equal(harness.tracker.getState().error, null);

	harness.setPayload({ drafts: [{ objectName: 'Account', values: {} }], loadedRecords: [] });
	harness.tracker.refresh();
	assert.equal(harness.tracker.hasUnsavedChanges(), true);
	assert.equal(harness.tracker.getState().phase, 'new');
	assert.equal(harness.tracker.getState().dirty, true);
});

test('saved canvases become dirty only when the persisted payload changes', () => {
	const payload = {
		drafts: [{ id: 1, objectName: 'Account', x: 40, y: 70, values: { Name: 'Acme' } }],
		loadedRecords: [],
		associations: [],
	};
	const harness = createHarness({
		currentCanvas: { id: 'canvas-1', ownedByMe: true },
		payload,
	});

	harness.tracker.captureSaved({ payload, savedAt: '2026-07-30T12:00:00Z' });
	assert.equal(harness.tracker.hasUnsavedChanges(), false);
	assert.equal(harness.tracker.getState().phase, 'clean');

	harness.setPayload({
		...payload,
		drafts: [{ ...payload.drafts[0], x: 120 }],
	});
	harness.tracker.refresh();
	assert.equal(harness.tracker.hasUnsavedChanges(), true);
	assert.equal(harness.tracker.getState().phase, 'dirty');
});

test('fingerprints ignore object key order but retain relationships and field changes', () => {
	const { fingerprint } = (() => {
		const window = { OrgLoom: {} };
		vm.runInNewContext(source, { window, JSON, Date });
		return window.OrgLoom.canvasSaveState._test;
	})();
	const original = {
		drafts: [{ values: { Name: 'Acme', Rating: 'Hot' }, id: 1 }],
		associations: [{ fromId: 1, toId: 2, fieldName: 'AccountId' }],
	};
	const reordered = {
		associations: [{ fieldName: 'AccountId', toId: 2, fromId: 1 }],
		drafts: [{ id: 1, values: { Rating: 'Hot', Name: 'Acme' } }],
	};
	assert.equal(fingerprint(original), fingerprint(reordered));
	assert.notEqual(
		fingerprint(original),
		fingerprint({
			...original,
			associations: [{ fromId: 1, toId: 3, fieldName: 'AccountId' }],
		}),
	);
});

test('viewers are not prompted to save while editors can save shared canvases', () => {
	const viewer = createHarness({
		currentCanvas: { id: 'shared-1', ownedByMe: false, recipientRole: 'viewer' },
		payload: { drafts: [{ id: 1 }] },
	});
	viewer.tracker.captureSaved();
	viewer.setPayload({ drafts: [{ id: 1, values: { Name: 'Changed' } }] });
	viewer.tracker.refresh();
	assert.equal(viewer.tracker.getState().phase, 'shared');
	assert.equal(viewer.tracker.hasUnsavedChanges(), false);
	assert.equal(viewer.tracker.canPersistCurrentCanvas(), false);

	const editor = createHarness({
		currentCanvas: { id: 'shared-2', ownedByMe: false, recipientRole: 'editor' },
		payload: { drafts: [{ id: 1 }] },
	});
	editor.tracker.captureSaved();
	editor.setPayload({ drafts: [{ id: 1, values: { Name: 'Changed' } }] });
	editor.tracker.refresh();
	assert.equal(editor.tracker.getState().phase, 'dirty');
	assert.equal(editor.tracker.hasUnsavedChanges(), true);
	assert.equal(editor.tracker.canPersistCurrentCanvas(), true);
});

test('failed saves remain dirty and successful retries establish a new baseline', () => {
	const payload = { drafts: [{ id: 1 }] };
	const harness = createHarness({
		currentCanvas: { id: 'canvas-1', ownedByMe: true },
		payload,
	});
	harness.tracker.captureSaved({ payload });
	harness.setPayload({ drafts: [{ id: 1, values: { Name: 'Changed' } }] });
	harness.tracker.refresh();
	assert.equal(harness.tracker.markSaving(), true);
	harness.tracker.markFailed('network error');
	assert.equal(harness.tracker.getState().phase, 'error');
	assert.equal(harness.tracker.hasUnsavedChanges(), true);

	harness.tracker.captureSaved({ payload: { drafts: [{ id: 1, values: { Name: 'Changed' } }] } });
	assert.equal(harness.tracker.getState().phase, 'clean');
	assert.equal(harness.tracker.hasUnsavedChanges(), false);
});
