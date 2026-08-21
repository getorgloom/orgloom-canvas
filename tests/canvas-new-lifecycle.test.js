import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/public/js/canvas-save-load.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/public/js/app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function createHarness({
	currentCanvas = null,
	hasContent = true,
	choice = 'discard',
	promptName = 'Saved before new',
	records = [{ id: 1, objectName: 'Account' }],
	exportAllowed = true,
	supportsModal = false,
} = {}) {
	const requests = [];
	const choiceCalls = [];
	const promptCalls = [];
	const toasts = [];
	const appendedModals = [];
	let starts = 0;
	let downloads = 0;
	let capabilityRefreshes = 0;
	const window = { OrgLoom: {}, Orgloom: {} };
	const document = {
		querySelectorAll: () => [],
		createElement: () =>
			supportsModal
				? {
						className: '',
						innerHTML: '',
						querySelectorAll: () => [{ addEventListener() {} }],
						remove() {},
					}
				: {},
		body: {
			appendChild(element) {
				appendedModals.push(element);
			},
		},
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
			if (url === '/api/capabilities/export-canvas/check') {
				return {
					ok: exportAllowed,
					status: exportAllowed ? 200 : 403,
					json: async () =>
						exportAllowed
							? { ok: true }
							: { message: 'Ask a workspace admin to grant you file export access.' },
				};
			}
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
		showBulkToast(message, kind) {
			toasts.push({ message, kind });
		},
		showConfirmDialog: async () => true,
		showPromptModal: async (options) => {
			promptCalls.push(options);
			return promptName;
		},
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
		downloadTemplate() {
			downloads += 1;
		},
		openCanvasEmailLinkModal() {},
		pingAuditEvent() {},
		getCurrentTeam: () => null,
		openExportCsvModal() {},
		renderBulkView() {},
		summarizeCanvasContent: () => ({ hasContent }),
		notePresenceLocalSave() {},
		rehydrateSessionDraftValues() {},
		_hasCap: () => true,
		isCapabilityReady: () => true,
		refreshCapabilities: async () => {
			capabilityRefreshes += 1;
		},
		canvasSaveState: {
			getState: () => ({ phase: hasContent ? 'dirty' : 'clean', dirty: hasContent }),
			hasUnsavedChanges: () => hasContent,
			canPersistCurrentCanvas: () =>
				!canvasState.currentCanvas ||
				!canvasState.currentCanvas.id ||
				canvasState.currentCanvas.ownedByMe ||
				canvasState.currentCanvas.recipientRole === 'editor',
			markSaving: () => true,
			markDirty() {},
			markFailed() {},
			captureSaved() {},
			refresh() {},
		},
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
		promptCalls,
		toasts,
		appendedModals,
		get starts() {
			return starts;
		},
		get downloads() {
			return downloads;
		},
		get capabilityRefreshes() {
			return capabilityRefreshes;
		},
	};
}

test('Canvases menu exposes a first-class New canvas action', () => {
	assert.match(source, /data-new-canvas/);
	assert.match(source, />\+ New canvas</);
});

test('saved canvas timestamps identify what the time represents', () => {
	assert.match(source, /date \? 'Last saved ' \+ escapeHtml\(date\) : ''/);
});

test('loading a saved canvas replaces instead of merging', () => {
	assert.doesNotMatch(source, /showReplaceOrMergeDialog/);
	assert.match(source, /title: 'Load saved canvas\?'/);
	assert.match(source, /saveLabel: 'Save and continue'/);
	assert.match(source, /discardLabel: 'Continue without saving'/);
	assert.match(
		source,
		/const finishCanvasLoad = beginCanvasReplacementLoad\('Loading canvas\\u2026'\);[\s\S]*finally \{\s*finishCanvasLoadOnce\(\)/,
	);
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
	assert.equal(harness.choiceCalls[0].saveLabel, 'Save current and start new');
	assert.equal(harness.choiceCalls[0].message, undefined);
	assert.equal(harness.promptCalls[0].title, 'Save your current canvas');
	assert.equal(harness.promptCalls[0].label, 'Current canvas name');
	assert.equal(harness.promptCalls[0].helpText, 'Org Loom will save this canvas, then open a new blank canvas.');
	assert.equal(harness.promptCalls[0].submitText, 'Save and start new');
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

test('file export fails closed when permission is revoked after the flow opens', async () => {
	const harness = createHarness({ exportAllowed: false });

	assert.equal(await harness.api.promptFileExport(), false);
	assert.equal(harness.downloads, 0);
	assert.equal(harness.capabilityRefreshes, 1);
	assert.equal(harness.requests.at(-1).url, '/api/capabilities/export-canvas/check');
	assert.deepEqual(harness.toasts.at(-1), {
		message: 'Ask a workspace admin to grant you file export access.',
		kind: 'error',
	});
});

test('direct file export shows a persistent permission error when access was revoked', async () => {
	const harness = createHarness({ exportAllowed: false, supportsModal: true });

	assert.equal(await harness.api.promptFileExport(), false);
	assert.equal(harness.downloads, 0);
	assert.equal(harness.appendedModals.length, 1);
	assert.match(harness.appendedModals[0].innerHTML, /Unable to export canvas/);
	assert.match(harness.appendedModals[0].innerHTML, /Ask a workspace admin to grant you file export access/);
	assert.match(harness.appendedModals[0].innerHTML, /No file was downloaded/);
});

test('navigation warns before discarding tab-local encrypted upload choices', () => {
	assert.match(appSource, /function _hasPendingEncryptedUploadValues\(\)/);
	assert.match(appSource, /Encrypted replacements and clear choices exist only in this tab\./);
	assert.match(appSource, /confirmLabel: 'Leave and discard'/);
	assert.match(appSource, /if \(!_hasUnsavedCanvasWork\(\) && !hasPendingEncryptedValues\)/);
	assert.match(appSource, /window\.__sfRedirectingToReauth = !hasPendingEncryptedValues/);
});
