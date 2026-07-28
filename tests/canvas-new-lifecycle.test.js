import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/public/js/canvas-save-load.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/public/js/app.js', import.meta.url), 'utf8');

function createHarness({
	currentCanvas = null,
	hasContent = true,
	choice = 'discard',
	promptName = 'Saved before new',
	records = [{ id: 1, objectName: 'Account' }],
} = {}) {
	const requests = [];
	const choiceCalls = [];
	let starts = 0;
	const window = { OrgLoom: {}, Orgloom: {} };
	const document = {
		querySelectorAll: () => [],
		createElement: () => ({}),
		body: { appendChild() {} },
		addEventListener() {},
		removeEventListener() {},
	};
	vm.runInNewContext(source, {
		window,
		document,
		console,
		Promise,
		JSON,
		encodeURIComponent,
		setTimeout,
	});

	const canvasState = {
		currentCanvas,
		selectedObjects: [{ id: 1 }],
		bulkRecords: records,
	};
	const api = window.OrgLoom.canvasSaveLoad.mount({
		canvasState,
		csrfFetch: async (url, options = {}) => {
			requests.push({ url, options });
			if (options.method === 'POST') {
				return {
					ok: true,
					status: 200,
					json: async () => ({ id: 'saved-new', versionId: 'v1' }),
				};
			}
			return {
				ok: true,
				status: 200,
				json: async () => ({ title: 'Existing canvas', versionId: 'v2' }),
			};
		},
		escapeHtml: String,
		showBulkToast() {},
		showConfirmDialog: async () => true,
		showPromptModal: async () => promptName,
		_openAnchoredPopup() {
			throw new Error('not used by lifecycle tests');
		},
		_formatRelativeTime: String,
		_setStaleRefsFromLoad() {},
		_addStaleRefIds() {},
		_staleIdKey: String,
		_watchProposalsForCurrentCanvas() {},
		applyCanvasPayload() {},
		buildCanvasPayload: () => ({ drafts: [{}], loadedRecords: [] }),
		ensureDraftSlotMetadata: async () => {},
		downloadTemplate() {},
		openCanvasEmailLinkModal() {},
		pingAuditEvent() {},
		getCurrentTeam: () => null,
		openExportCsvModal() {},
		renderBulkView() {},
		summarizeCanvasContent: () => ({ hasContent }),
		notePresenceLocalSave() {},
		rehydrateSessionDraftValues() {},
		_hasCap: () => true,
		clearAutosave() {},
		startNewCanvas: async () => {
			starts += 1;
		},
		chooseNewCanvasAction: async (options) => {
			choiceCalls.push(options);
			return choice;
		},
	});

	return {
		api,
		canvasState,
		requests,
		choiceCalls,
		get starts() {
			return starts;
		},
	};
}

test('Canvases menu exposes a first-class New canvas action', () => {
	assert.match(source, /data-new-canvas/);
	assert.match(source, />\+ New canvas</);
});

test('loading a saved canvas replaces instead of merging', () => {
	assert.doesNotMatch(source, /showReplaceOrMergeDialog/);
	assert.match(source, /title: 'Load saved canvas\?'/);
	assert.match(source, /confirmLabel: 'Replace canvas'/);
	assert.match(source, /applyCanvasPayload\(td\.payload \|\| \{\}, \{\s*merge: false,/s);
	assert.doesNotMatch(source, /merge: mode === 'merge'/);
});

test('starting fresh clears transient state and mints a new draft identity', () => {
	const lifecycle = appSource.match(/async function startNewCanvas\(\) \{([\s\S]*?)\n\t\}\n\n\tconst _csl =/);
	assert.ok(lifecycle, 'startNewCanvas lifecycle should be wired before canvas save/load');
	assert.match(lifecycle[1], /_autosaveClear\(\)/);
	assert.match(lifecycle[1], /clearAllSessionDraftsForCanvas\(previousCanvasId\)/);
	assert.match(lifecycle[1], /_presence\.unsubscribe\(\)/);
	assert.match(lifecycle[1], /canvasState\.currentCanvas = null/);
	assert.match(lifecycle[1], /_clearDraftCanvasId\(\)/);
	assert.match(lifecycle[1], /_ensureDraftCanvasId\(\)/);
	assert.match(lifecycle[1], /undoStack\.length = 0/);
});

test('new canvas is a no-op when the user is already on a fresh blank canvas', async () => {
	const harness = createHarness({ hasContent: false, records: [] });

	assert.equal(await harness.api.beginNewCanvas(), false);
	assert.equal(harness.starts, 0);
	assert.equal(harness.choiceCalls.length, 0);
	assert.equal(harness.requests.length, 0);
});

test('an empty loaded canvas can still be left for a fresh canvas', async () => {
	const harness = createHarness({
		currentCanvas: { id: 'canvas-1', title: 'Empty canvas', ownedByMe: true },
		hasContent: false,
		records: [],
	});

	assert.equal(await harness.api.beginNewCanvas(), true);
	assert.equal(harness.starts, 1);
	assert.equal(harness.choiceCalls.length, 0);
});

test('unsaved work can be named and saved before starting a new canvas', async () => {
	const harness = createHarness({ choice: 'save' });

	assert.equal(await harness.api.beginNewCanvas(), true);
	assert.equal(harness.requests.length, 1);
	assert.equal(harness.requests[0].url, '/api/canvas');
	assert.equal(harness.requests[0].options.method, 'POST');
	assert.equal(harness.starts, 1);
});

test('an owned saved canvas is updated before starting new when requested', async () => {
	const harness = createHarness({
		currentCanvas: { id: 'canvas-1', title: 'Existing canvas', ownedByMe: true, versionId: 'v1' },
		choice: 'save',
	});

	assert.equal(await harness.api.beginNewCanvas(), true);
	assert.equal(harness.requests.length, 1);
	assert.equal(harness.requests[0].url, '/api/canvas/canvas-1');
	assert.equal(harness.requests[0].options.method, 'PUT');
	assert.equal(harness.starts, 1);
});

test('cancel preserves the current canvas and shared canvases cannot be overwritten', async () => {
	const cancelled = createHarness({ choice: 'cancel' });
	assert.equal(await cancelled.api.beginNewCanvas(), false);
	assert.equal(cancelled.starts, 0);
	assert.equal(cancelled.requests.length, 0);

	const shared = createHarness({
		currentCanvas: { id: 'shared-1', title: 'Shared', ownedByMe: false, recipientRole: 'viewer' },
		choice: 'discard',
	});
	assert.equal(await shared.api.beginNewCanvas(), true);
	assert.equal(shared.choiceCalls[0].canSave, false);
	assert.equal(shared.requests.length, 0);
	assert.equal(shared.starts, 1);
});
