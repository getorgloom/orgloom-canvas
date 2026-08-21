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
		hasCapability: () => true,
		showBulkToast: (message) => messages.push(message),
		_canvasCapBlockReason: () => null,
		addToSelection: async () => {
			addCalls += 1;
		},
		ensureDescribe: async () => ({ createable: true }),
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

test('loading an existing record stops before search when Browse records is unavailable', async () => {
	const window = { OrgLoom: {} };
	vm.runInNewContext(pendingSource, { window, console });
	const messages = [];
	let pickerCalls = 0;
	const api = window.OrgLoom.pendingSpawn.mount({
		canvasState: {
			selectedObjects: [],
			bulkRecords: [{ id: 1, isPending: true }],
			bulkAssociations: [],
		},
		canEditCanvasStructure: () => true,
		hasCapability: () => false,
		showBulkToast: (message) => messages.push(message),
		_canvasCapBlockReason: () => null,
		addToSelection: async () => {
			throw new Error('object metadata should not load');
		},
		ensureDescribe: async () => ({ createable: false }),
		cloneRecord() {},
		pickRecordForFreeTypeNode() {
			pickerCalls += 1;
		},
		renderBulkView() {},
		getGraph: () => ({ querySelector: () => null }),
	});

	await api.resolvePendingRecordToLoad(1, 'Account');

	assert.equal(pickerCalls, 0);
	assert.deepEqual(messages, ['Your workspace access does not include loading existing Salesforce records.']);
});

test('Salesforce object create access is required before a pending card becomes a draft', async () => {
	const window = { OrgLoom: {} };
	vm.runInNewContext(pendingSource, { window, console });
	const record = { id: 1, isPending: true };
	const messages = [];
	let addCalls = 0;
	const api = window.OrgLoom.pendingSpawn.mount({
		canvasState: {
			selectedObjects: [],
			bulkRecords: [record],
			bulkAssociations: [],
		},
		canEditCanvasStructure: () => true,
		hasCapability: () => true,
		showBulkToast: (message) => messages.push(message),
		_canvasCapBlockReason: () => null,
		addToSelection: async () => {
			addCalls += 1;
		},
		ensureDescribe: async () => ({ createable: false }),
		cloneRecord() {},
		pickRecordForFreeTypeNode() {},
		renderBulkView() {},
		getGraph: () => ({ querySelector: () => null }),
	});

	await api.resolvePendingRecord(1, 'Account');

	assert.equal(record.isPending, true);
	assert.equal(addCalls, 0);
	assert.deepEqual(messages, ['Salesforce does not allow this user to create Account records.']);
});

test('a createable object becomes a draft immediately while stale field access refreshes', async () => {
	const window = { OrgLoom: {} };
	vm.runInNewContext(pendingSource, { window, console });
	const record = { id: 1, isPending: true };
	const describeCalls = [];
	let renderCalls = 0;
	let finishDescribe;
	const describePending = new Promise((resolve) => {
		finishDescribe = resolve;
	});
	const api = window.OrgLoom.pendingSpawn.mount({
		canvasState: {
			allObjects: [{ name: 'Account', createable: true }],
			selectedObjects: [{ id: 7, name: 'Account', label: 'Account' }],
			bulkRecords: [record],
			bulkAssociations: [],
		},
		canEditCanvasStructure: () => true,
		hasCapability: () => true,
		showBulkToast() {},
		_canvasCapBlockReason: () => null,
		addToSelection: async () => {},
		ensureDescribe: async (name, options) => {
			describeCalls.push({ name, force: !!(options && options.force) });
			return describePending;
		},
		cloneRecord() {},
		pickRecordForFreeTypeNode() {},
		renderBulkView() {
			renderCalls += 1;
		},
		getGraph: () => ({ querySelector: () => null }),
	});

	await api.resolvePendingRecord(1, 'Account');

	assert.deepEqual(describeCalls, [{ name: 'Account', force: true }]);
	assert.equal(record.isPending, false);
	assert.equal(record.objectName, 'Account');
	assert.equal(renderCalls, 1);
	finishDescribe({ createable: true });
	await describePending;
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(renderCalls, 2);
});

test('create-new object pickers only offer objects Salesforce marks createable', () => {
	const createPickerSources = appSource + recordsCanvasSource;
	assert.equal(
		(createPickerSources.match(/objectFilter: \(object\) => object && object\.createable === true/g) || []).length,
		3,
	);
});

test('pending record cards do not present an active Salesforce loader without Browse records access', () => {
	assert.match(recordsCanvasSource, /isCapabilityReady/);
	assert.match(recordsCanvasSource, /Checking access&hellip;/);
	assert.match(recordsCanvasSource, /Browse access required/);
	assert.match(recordsCanvasSource, /hasCapability\('browse-records'\)/);
});

test('record request cards use one task-oriented description', () => {
	assert.match(recordsCanvasSource, /const requestTitle = 'Create ' \+ article \+ ' ' \+ objectNoun/);
	assert.doesNotMatch(recordsCanvasSource, /const requestTitle = 'New ' \+ objLabel \+ ' needed'/);
	assert.doesNotMatch(recordsCanvasSource, /<div class="record-slot-type">/);
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
		isCapabilityReady: () => true,
		bulkAutoFill: noop,
		bulkClearAllFields: noop,
		summarizeAutoFillTargets: noop,
		openLinkedCsvModal: noop,
		openAiGenModal: noop,
		getAiGen: () => ({
			getAccessState: () => ({ ready: true, allowed: false, reason: 'member-grant-required' }),
			isEnabled: () => true,
		}),
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
		/!canEditCanvasStructure\(\)[\s\S]*!rec[\s\S]*!isLoaded[\s\S]*isTypeNode[\s\S]*isInaccessible[\s\S]*!pending && !canDeleteRecord\(rec\)/,
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
	assert.match(insertModalSource, /if \(!currentObject\) \{/);
	assert.match(insertModalSource, /if \(!canEditCurrentRecord\(\)\) \{/);
	assert.match(insertModalSource, /record\._recipientSlot/);
	assert.match(insertModalSource, /return hasRecipientRequest && assignmentState !== 'other'/);
});
