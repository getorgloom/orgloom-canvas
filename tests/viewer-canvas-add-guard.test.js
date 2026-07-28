import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const pendingSource = readFileSync(new URL('../src/public/js/pending-spawn.js', import.meta.url), 'utf8');
const bulkOpsSource = readFileSync(new URL('../src/public/js/bulk-ops-menu.js', import.meta.url), 'utf8');
const toolbarSource = readFileSync(new URL('../src/public/js/bulk-toolbar.js', import.meta.url), 'utf8');
const recordsCanvasSource = readFileSync(new URL('../src/public/js/records-canvas.js', import.meta.url), 'utf8');
const cardMenuSource = readFileSync(new URL('../src/public/js/canvas-card-menu.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/public/js/app.js', import.meta.url), 'utf8');
const associationsSource = readFileSync(new URL('../src/public/js/canvas-associations.js', import.meta.url), 'utf8');
const insertModalSource = readFileSync(new URL('../src/public/js/insert-modal.js', import.meta.url), 'utf8');

test('a read-only shared-canvas session cannot create pending or draft records', async () => {
	const window = { OrgLoom: {} };
	vm.runInNewContext(pendingSource, { window, console });
	const canvasState = {
		selectedObjects: [],
		bulkRecords: [],
		bulkAssociations: [],
		bulkIdSeq: 1,
	};
	const messages = [];
	let addCalls = 0;
	const api = window.OrgLoom.pendingSpawn.mount({
		canvasState,
		canEditCanvasStructure: () => false,
		showBulkToast: (message) => messages.push(message),
		_canvasCapBlockReason: () => null,
		addToSelection: async () => {
			addCalls += 1;
		},
		cloneRecord() {},
		pickRecordForFreeTypeNode() {},
		renderBulkView() {},
		getGraph: () => ({ querySelector: () => null }),
	});

	api.spawnPendingRecord(10, 20);
	await api.spawnDraftRecord('Account');

	assert.equal(canvasState.bulkRecords.length, 0);
	assert.equal(canvasState.bulkIdSeq, 1);
	assert.equal(addCalls, 0);
	assert.deepEqual(messages, [
		'Only the canvas owner or an editor can add records.',
		'Only the canvas owner or an editor can add records.',
	]);
});

test('read-only sessions cannot open canvas add menus', () => {
	const window = { OrgLoom: {} };
	const document = {
		querySelectorAll() {
			throw new Error('the add-menu DOM must not be touched');
		},
	};
	vm.runInNewContext(bulkOpsSource, { window, document, console, setTimeout });
	const noop = () => {};
	const api = window.OrgLoom.bulkOpsMenu.mount({
		canvasState: { bulkRecords: [], bulkSelectedIds: new Set() },
		canEditCanvasStructure: () => false,
		_hasCap: () => false,
		bulkAutoFill: noop,
		bulkClearAllFields: noop,
		summarizeAutoFillTargets: noop,
		openLinkedCsvModal: noop,
		openAiGenModal: noop,
		openSoqlImportModal: noop,
		openBrowseModal: noop,
		openBulkEditModal: noop,
		openBulkScriptModal: noop,
		openRecordDiffModal: noop,
		openCanvasSearchModal: noop,
		openFindDuplicatesModal: noop,
		openBulkRefreshFlow: noop,
		beginMigration: noop,
		openStandaloneRecordRequestPicker: noop,
		spawnPendingRecord: noop,
		triggerTemplateFileInput: noop,
		getGraph: () => ({}),
		getCyInstance: () => null,
		getCanvasSpaceHeld: () => false,
		setCanvasSpaceHeld: noop,
		getCanvasZHeld: () => false,
		setCanvasZHeld: noop,
		_isOnPaidPlan: () => false,
		isTeamAdmin: () => false,
	});

	assert.equal(api._showCanvasContextMenu(10, 20, { x: 1, y: 2 }), false);
	assert.equal(api.showAddRecordsMenu({}), false);
});

test('the toolbar omits general import controls when canvas structure is read-only', () => {
	assert.match(toolbarSource, /const addMenuBtn = canEditCanvasStructure\(\)/);
});

test('only owners and editors can move cards, and completed moves are published once', () => {
	assert.match(recordsCanvasSource, /return !role \|\| role === 'editor'/);
	assert.match(recordsCanvasSource, /grabbable: canArrangeCanvas\(\)/);
	assert.match(recordsCanvasSource, /publishPresenceLayout\(movedRecords\)/);
});

test('read-only sessions cannot open the card action menu', () => {
	const window = { OrgLoom: {} };
	const document = {
		querySelectorAll() {
			throw new Error('the card-menu DOM must not be touched');
		},
	};
	vm.runInNewContext(cardMenuSource, { window, document, console, setTimeout });
	const noop = () => {};
	const messages = [];
	const api = window.OrgLoom.canvasCardMenu.mount({
		canvasState: {},
		csrfFetch: noop,
		escapeHtml: String,
		renderBulkView: noop,
		recordOrdinal: () => 1,
		showBulkToast: (message) => messages.push(message),
		showConfirmDialog: noop,
		isRecordModified: () => false,
		canEditCanvasStructure: () => false,
		_canAuthorSlots: () => false,
		_hasCap: () => false,
		openInsertModal: noop,
		convertRecordToFieldSlot: noop,
		configureExistingSlot: noop,
		convertSlotBackToRecord: noop,
		refreshRecordFromSf: noop,
		deleteRecord: noop,
		markPendingDelete: noop,
		unmarkPendingDelete: noop,
		attachSfUserPicker: noop,
		_fillSlotWithSfRecord: noop,
	});

	assert.equal(api.showCardMoreMenu({}, {}), false);
	assert.deepEqual(messages, ['Only the canvas owner or an editor can manage card actions.']);
});

test('viewer and contributor card mutation controls are hidden and centrally guarded', () => {
	assert.match(recordsCanvasSource, /if \(isExisting && canArrangeCanvas\(\)\)/);
	assert.match(recordsCanvasSource, /const moreBtn = canArrangeCanvas\(\)/);
	assert.match(recordsCanvasSource, /const keepBtn =\s*isPendingDelete && canArrangeCanvas\(\)/);
	assert.match(appSource, /function deleteRecord\(id\) \{\s*if \(!_canEditCanvasStructure\(\)\)/);
	assert.match(appSource, /function markPendingDelete\(id, opts\) \{\s*if \(!_canEditCanvasStructure\(\)\)/);
	assert.match(appSource, /function unmarkPendingDelete\(id\) \{\s*if \(!_canEditCanvasStructure\(\)\)/);
	assert.match(associationsSource, /function deleteAssociation\(id\) \{\s*if \(!canEditCanvasStructure\(\)\)/);
	assert.match(
		associationsSource,
		/function deleteDerivedFkEdge\(recId, fieldName\) \{\s*if \(!canEditCanvasStructure\(\)\)/,
	);
});

test('viewer and contributor edit modals omit delete and unlink controls', () => {
	assert.match(
		insertModalSource,
		/if \(!canEditCanvasStructure\(\) \|\| !rec \|\| !isLoaded \|\| isTypeNode \|\| isInaccessible\)/,
	);
	assert.match(insertModalSource, /canEditCanvasStructure\(\)\s*\? '<button[^']+data-unlink-existing/);
	assert.match(insertModalSource, /canEditCanvasStructure\(\)\s*\? ' <button[^']+data-disconnect-assoc/);
	assert.match(
		insertModalSource,
		/unlinkBtn\.addEventListener\('click', async \(\) => \{\s*if \(!canEditCanvasStructure\(\)\)/,
	);
});

test('viewer and non-requested contributor edit modals omit the save action', () => {
	assert.match(insertModalSource, /submitBtn\.hidden = !canSubmit/);
	assert.match(insertModalSource, /if \(!currentObject \|\| !canEditCurrentRecord\(\)\)/);
	assert.match(insertModalSource, /record\._recipientSlot/);
	assert.match(insertModalSource, /return hasRecipientRequest && assignmentState !== 'other'/);
});
