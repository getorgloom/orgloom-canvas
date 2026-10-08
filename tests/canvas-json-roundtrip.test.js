import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = (file) => fs.readFileSync(new URL('../src/public/js/' + file, import.meta.url), 'utf8');
const app = read('app.js');
const plain = (value) => JSON.parse(JSON.stringify(value));
const noop = () => {};

function mount() {
	const window = { OrgLoom: {}, SF_ORG_ID: 'test-org' };
	const state = {
		selectedObjects: [],
		selectedIdSeq: 1,
		activeIndex: 0,
		hiddenObjects: new Set(),
		bulkRecords: [],
		bulkAssociations: [],
		bulkIdSeq: 10,
		bulkSelectedIds: new Set(),
		_prefetchedTypeNodeKeys: new Set(),
		_renderedRecIds: new Set(),
		describeCache: {},
	};
	const messages = [];
	const context = vm.createContext({
		window,
		canvasState: state,
		localStorage: { removeItem() {} },
		console,
		Set,
		Map,
		Promise,
		Date,
		_canEditCanvasStructure: () => true,
		_userDeletedSelectionIds: new Set(),
		showBulkToast: (message) => messages.push(message),
		renderBulkView: noop,
	});
	vm.runInContext(
		app.slice(app.indexOf('\tconst undoStack = [];'), app.indexOf('\tfunction deleteRecord(id)')),
		context,
	);
	vm.runInContext(
		app.slice(app.indexOf('\tfunction deleteRecord(id)'), app.indexOf('\tfunction markPendingDelete(id')),
		context,
	);
	vm.runInContext(
		'globalThis.undo = () => { const op = undoStack.pop(); return op?.fn(); }; globalThis.undoCount = () => undoStack.length;',
		context,
	);
	for (const file of [
		'encrypted-fields.js',
		'value-compare.js',
		'import-shared.js',
		'templates.js',
		'canvas-associations.js',
	]) {
		vm.runInContext(read(file), context);
	}
	const api = window.OrgLoom.templates.mount({
		canvasState: state,
		showBulkToast: context.showBulkToast,
		escapeHtml: String,
		csrfFetch: async (url) => ({
			ok: fresh.has(url.split('/').at(-1)),
			json: async () => plain(fresh.get(url.split('/').at(-1))),
		}),
		ensureDescribe: async () => null,
		addToSelection: async (name) => {
			const e = { id: state.selectedIdSeq++, name };
			state.selectedObjects.push(e);
			return e;
		},
		setGraphView: noop,
		renderAll: noop,
		showReplaceOrMergeDialog: noop,
		pingAuditEvent: noop,
		getCanvasRecordCap: () => 500,
		realRecordCount: () => state.bulkRecords.length,
		runSlotPreflight: async () => {},
		clearEmptyStarterCard: noop,
		getSlotIdSeq: () => 1,
		setSlotIdSeq: noop,
		onCanvasReplace: context.clearUndoHistory,
	});
	const associations = window.OrgLoom.canvasAssociations.mount({
		canvasState: state,
		canEditCanvasStructure: () => true,
		renderBulkView: noop,
		showBulkToast: context.showBulkToast,
		ensureDescribe: async () => {},
		pushUndo: context.pushUndo,
		showFieldPicker: noop,
		getSelectedDerivedEdge: () => null,
		setSelectedDerivedEdge: noop,
		_sfIdValue: (v) => v,
		_sfIdMatch: (a, b) => a === b,
	});
	const a = {
		id: 1,
		objectName: 'Account',
		label: 'Account',
		x: 0,
		y: 0,
		loadedFromId: '001000000000001AAA',
		values: { Name: 'Account A' },
		loadedValues: { Name: 'Account A' },
	};
	const b = {
		id: 2,
		objectName: 'Account',
		label: 'Account',
		x: 300,
		y: 0,
		loadedFromId: '001000000000002AAA',
		values: { Name: 'Account B' },
		loadedValues: { Name: 'Account B' },
	};
	const child = {
		id: 3,
		objectName: 'Contact',
		label: 'Contact',
		x: 0,
		y: 300,
		loadedFromId: '003000000000001AAA',
		values: { LastName: 'Person', AccountId: a.loadedFromId },
		loadedValues: { LastName: 'Before', AccountId: a.loadedFromId },
	};
	state.bulkRecords = [a, b, child];
	const fresh = new Map(state.bulkRecords.map((r) => [r.loadedFromId, { Id: r.loadedFromId, ...r.loadedValues }]));
	state.bulkAssociations = [{ id: 4, fromId: 3, toId: 1, fieldName: 'AccountId' }];
	return {
		state,
		api,
		associations,
		context,
		a,
		b,
		child,
		messages,
		fresh,
		exportJson: () => plain(api.buildTemplate({ preserveLoadedLinks: true })),
	};
}

test('delete, reconnect, undo twice, then JSON replace preserves exactly the current records and links', async () => {
	const h = mount();
	h.associations.deleteAssociation(4);
	h.associations.createAssociation(h.child, h.b, 'fwd', 'AccountId');
	assert.equal(h.context.undoCount(), 2);
	h.context.undo();
	assert.equal(h.state.bulkAssociations.length, 0);
	assert.equal(h.child.values.AccountId, undefined);
	h.context.undo();
	assert.equal(h.state.bulkAssociations.length, 1);
	assert.equal(h.child.values.AccountId, h.a.loadedFromId);
	const file = h.exportJson();
	await h.api.applyTemplate(file, { merge: false });
	assert.deepEqual(h.exportJson().records, file.records);
	assert.deepEqual(h.exportJson().associations, file.associations);
	assert.equal(h.state.bulkRecords.length, 3);
	assert.equal(h.state.bulkRecords[0].x, 0);
	assert.equal(h.state.bulkRecords[0].y, 0);
});

test('connection creation refuses occupied fields and its undo preserves later field edits', () => {
	const h = mount();
	assert.equal(h.associations.createAssociation(h.child, h.b, 'fwd', 'AccountId'), false);
	assert.equal(h.state.bulkAssociations.length, 1);
	h.associations.deleteAssociation(4);
	h.associations.createAssociation(h.child, h.b, 'fwd', 'AccountId');
	h.child.values.AccountId = '001000000000003AAA';
	h.context.undo();
	assert.equal(h.child.values.AccountId, '001000000000003AAA');
	h.context.undo();
	assert.equal(h.state.bulkAssociations.length, 0);
	assert.equal(h.child.values.AccountId, '001000000000003AAA');
});

test('stale connection undo cannot create conflicting or dangling links', () => {
	const h = mount();
	let restore;
	h.context.pushUndo('Capture', noop);
	h.associations.deleteAssociation(4);
	restore = vm.runInContext('undoStack.at(-1).fn', h.context);
	h.associations.createAssociation(h.child, h.b, 'fwd', 'AccountId');
	restore();
	assert.equal(h.state.bulkAssociations.length, 1);
	assert.equal(h.child.values.AccountId, h.b.loadedFromId);
	const other = mount();
	other.associations.deleteAssociation(4);
	other.state.bulkRecords = other.state.bulkRecords.filter((r) => r !== other.a);
	other.context.undo();
	assert.equal(other.state.bulkAssociations.length, 0);
});

test('derived lookup undo cannot overwrite a later connection', () => {
	const h = mount();
	h.state.bulkAssociations = [];
	h.associations.deleteDerivedFkEdge(3, 'AccountId');
	const restore = vm.runInContext('undoStack.at(-1).fn', h.context);
	h.associations.createAssociation(h.child, h.b, 'fwd', 'AccountId');
	restore();
	assert.equal(h.child.values.AccountId, h.b.loadedFromId);
	assert.equal(h.state.bulkAssociations.length, 1);
});

test('canvas replacement clears previous undo actions and invalidates stale toast callbacks', async () => {
	const h = mount();
	const original = h.exportJson();
	h.context.deleteRecord(3);
	const stale = vm.runInContext('undoStack.at(-1).fn', h.context);
	await h.api.applyTemplate(original, { merge: false });
	assert.equal(h.context.undoCount(), 0);
	assert.equal(stale(), false);
	assert.equal(h.state.bulkRecords.length, 3);
	assert.equal(new Set(h.state.bulkRecords.map((r) => r.id)).size, 3);
	assert.equal(h.exportJson().associations.length, 1);
	assert.match(app, /const once = pushUndo\(actionLabel, action\)/);
	for (const owner of ['_lcsv = window.OrgLoom.linkedCsv.mount', '_tpl = window.OrgLoom.templates.mount']) {
		const start = app.indexOf(owner);
		assert.match(app.slice(start, start + 180), /onCanvasReplace: \(\) => \{\s*clearUndoHistory\(\)/);
	}
});

test('record deletion undo cannot duplicate a Salesforce record reloaded afterward', () => {
	const h = mount();
	h.context.deleteRecord(3);
	h.state.bulkRecords.push({ ...h.child, id: 99 });
	h.context.undo();
	assert.equal(h.state.bulkRecords.length, 3);
	assert.equal(h.state.bulkRecords.filter((r) => r.loadedFromId === h.child.loadedFromId).length, 1);
});

test('JSON validation rejects ambiguous IDs, dangling edges and conflicting lookups before changing the canvas', async () => {
	for (const corrupt of [
		(file) => file.records.push({ ...file.records[0] }),
		(file) => file.records.push({ ...file.records[0], id: '1' }),
		(file) => delete file.records[0].id,
		(file) => file.associations.push({ fromId: 3, toId: 999, fieldName: 'OtherId' }),
		(file) => file.associations.push({ fromId: 3, toId: 2, fieldName: 'AccountId' }),
		(file) => {
			file.records[2].values.AccountId = file.records[1].loadedFromId;
		},
	]) {
		const h = mount();
		const file = h.exportJson();
		file.associations = [{ fromId: 3, toId: 1, fieldName: 'AccountId' }];
		const before = plain(h.state.bulkRecords);
		corrupt(file);
		await assert.rejects(h.api.applyTemplate(file, { merge: false }), /Invalid canvas snapshot/);
		assert.deepEqual(plain(h.state.bulkRecords), before);
	}
});

test('JSON export refuses corrupt internal IDs and relationships without mutating records', () => {
	for (const corrupt of [
		(h) => h.state.bulkRecords.push({ ...h.a }),
		(h) => h.state.bulkAssociations.push({ id: 5, fromId: 3, toId: 2, fieldName: 'AccountId' }),
		(h) => {
			h.state.bulkAssociations[0].toId = 999;
		},
		(h) => {
			h.child.values.AccountId = h.b.loadedFromId;
		},
	]) {
		const h = mount();
		corrupt(h);
		const before = plain(h.state.bulkRecords);
		assert.throws(h.exportJson, /Invalid canvas snapshot/);
		assert.deepEqual(plain(h.state.bulkRecords), before);
	}
});

test('repeated same-org linked JSON merges reuse records and links without overwriting edits', async () => {
	const h = mount();
	const file = h.exportJson();
	h.child.values.LastName = 'Keep local edits';
	await h.api.applyTemplate(file, { merge: true });
	await h.api.applyTemplate(file, { merge: true });
	assert.equal(h.state.bulkRecords.length, 3);
	assert.equal(h.state.bulkAssociations.length, 1);
	assert.equal(h.child.values.LastName, 'Keep local edits');
	assert.ok(h.messages.some((m) => m.includes('3 already on the canvas')));
});

test('merge remaps a new child to an existing parent and preserves an edited existing lookup', async () => {
	const h = mount();
	const file = h.exportJson();
	file.associations = [{ fromId: 3, toId: 1, fieldName: 'AccountId' }];
	h.state.bulkRecords = [h.a, h.b];
	h.state.bulkAssociations = [];
	await h.api.applyTemplate(file, { merge: true });
	assert.equal(h.state.bulkRecords.length, 3);
	const child = h.state.bulkRecords.find((r) => r.objectName === 'Contact');
	assert.equal(h.state.bulkAssociations[0].fromId, child.id);
	assert.equal(h.state.bulkAssociations[0].toId, h.a.id);
	h.state.bulkAssociations = [];
	child.values.AccountId = h.b.loadedFromId;
	await h.api.applyTemplate(file, { merge: true });
	assert.equal(h.state.bulkAssociations.length, 0);
	assert.equal(child.values.AccountId, h.b.loadedFromId);
});

test('portable draft and cross-org imports do not deduplicate records by foreign Salesforce IDs', async () => {
	for (const portable of [true, false]) {
		const h = mount();
		const file = {
			_meta: { app: 'Org Loom', version: 1, exportedFrom: 'test-org', preservesLoadedLinks: !portable },
			schema: { objects: [] },
			records: plain(h.state.bulkRecords),
			associations: plain(h.state.bulkAssociations),
		};
		if (portable) file.records.forEach((r) => delete r.loadedFromId);
		if (!portable) file._meta.exportedFrom = 'different-org';
		await h.api.applyTemplate(file, { merge: true });
		assert.equal(h.state.bulkRecords.length, 6);
		assert.ok(h.state.bulkRecords.slice(3).every((r) => !r.loadedFromId));
	}
});

test('merge never restores a lookup that was cleared locally', async () => {
	const h = mount();
	const file = h.exportJson();
	h.associations.deleteAssociation(4);
	await h.api.applyTemplate(file, { merge: true });
	assert.equal(h.state.bulkRecords.length, 3);
	assert.equal(h.state.bulkAssociations.length, 0);
	assert.equal(h.child.values.AccountId, undefined);
});

test('undoing a merge leaves earlier same-canvas undo history available', async () => {
	const h = mount();
	h.associations.deleteAssociation(4);
	const capture = h.context.window.OrgLoom.importShared.makeUndoCapture({
		canvasState: h.state,
		renderAll: noop,
		showBulkToast: noop,
		onCanvasReplace: noop,
	});
	const restore = capture();
	const file = plain(h.api.buildTemplate());
	await h.api.applyTemplate(file, { merge: true });
	h.context.pushUndo('Undo import', restore.arm());
	h.context.undo();
	assert.equal(h.state.bulkRecords.length, 3);
	assert.equal(h.context.undoCount(), 1);
	h.context.undo();
	assert.equal(h.state.bulkAssociations.length, 1);
	assert.equal(h.child.values.AccountId, h.a.loadedFromId);
	const start = app.indexOf('const _captureCanvasUndoSnapshot');
	assert.doesNotMatch(app.slice(start, start + 220), /clearUndoHistory/);
});

test('a single undo callback cannot restore a removed record twice', () => {
	const h = mount();
	h.context.deleteRecord(3);
	const callback = vm.runInContext('undoStack.at(-1).fn', h.context);
	callback();
	assert.equal(callback(), false);
	h.context.undo();
	assert.equal(h.state.bulkRecords.length, 3);
	assert.equal(h.state.bulkAssociations.length, 1);
});

test('a full canvas can merge the same linked records without falsely exceeding the cap', async () => {
	const h = mount();
	const file = h.exportJson();
	for (let id = 100; h.state.bulkRecords.length < 500; id++)
		h.state.bulkRecords.push({ id, objectName: 'Account', values: {} });
	await h.api.applyTemplate(file, { merge: true });
	assert.equal(h.state.bulkRecords.length, 500);
});

test('JSON exports self-contained current values with only changed-field baselines', async () => {
	const h = mount();
	h.a.unmappedCsvColumns = [{ name: 'import context', value: 'keep imported data' }];
	h.state.bulkRecords.push({
		id: 8,
		objectName: 'Contact',
		values: { LastName: 'Draft person', Phone: 'Draft phone' },
	});
	const file = h.exportJson();
	assert.equal(file._meta.version, 2);
	assert.deepEqual(file.records[2].originalValues, { LastName: 'Before' });
	for (const r of file.records.slice(0, 3)) {
		assert.ok('values' in r);
		assert.ok(!('loadedValues' in r));
	}
	assert.deepEqual(file.records[0].originalValues, {});
	assert.equal(file.records[0].values.Name, 'Account A');
	assert.equal(file.records[0].unmappedCsvColumns[0].value, 'keep imported data');
	assert.equal(file.records[3].values.Phone, 'Draft phone');
	h.fresh.get(h.a.loadedFromId).Name = 'Latest Salesforce value';
	h.fresh.get(h.child.loadedFromId).LastName = 'New baseline';
	h.fresh.clear(); // No record fetch is needed to restore the snapshot.
	await h.api.applyTemplate(file, { merge: false });
	assert.equal(h.state.bulkRecords[0].values.Name, 'Account A');
	assert.equal(h.state.bulkRecords[2].loadedValues.LastName, 'Before');
	assert.equal(h.state.bulkRecords[2].values.LastName, 'Person');
});

test('snapshot JSON import preserves clears and draft relationships', async () => {
	const h = mount();
	h.associations.deleteAssociation(4);
	const draft = { id: 8, objectName: 'Account', values: { Name: 'Draft target' } };
	h.state.bulkRecords.push(draft);
	h.associations.createAssociation(h.child, draft, 'fwd', 'AccountId');
	const file = h.exportJson();
	assert.equal(file.records[2].values.AccountId, null);
	assert.equal(file.associations.length, 1);
	await h.api.applyTemplate(file, { merge: false });
	const child = h.state.bulkRecords.find((r) => r.objectName === 'Contact');
	const target = h.state.bulkRecords.find((r) => !r.loadedFromId);
	assert.equal(child.values.AccountId, null);
	assert.equal(h.state.bulkAssociations[0].fromId, child.id);
	assert.equal(h.state.bulkAssociations[0].toId, target.id);
});

test('minimal JSON refuses wrong-org and failed re-queries without replacing the current canvas', async () => {
	for (const wrongOrg of [true, false]) {
		const h = mount();
		const file = h.exportJson();
		file._meta.recordData = 'references-and-changes';
		file.records.forEach((r) => {
			r.changes = r.objectName === 'Contact' ? { LastName: 'Person' } : {};
			delete r.values;
			delete r.originalValues;
		});
		const before = plain(h.state.bulkRecords);
		if (wrongOrg) file._meta.exportedFrom = 'another-org';
		else h.fresh.delete(h.child.loadedFromId);
		await assert.rejects(h.api.applyTemplate(file, { merge: false }), /Connect to|Could not reload/);
		assert.deepEqual(plain(h.state.bulkRecords), before);
	}
});

test('snapshot exports work without a loaded baseline and never serialize encrypted values', () => {
	const h = mount();
	delete h.a.loadedValues;
	assert.equal(h.exportJson().records[0].values.Name, 'Account A');
	h.a.loadedValues = { Name: 'Account A' };
	h.state.describeCache.Contact = { fields: [{ name: 'Secret__c', type: 'encryptedstring' }] };
	h.child.values.Secret__c = 'new secret';
	h.child.loadedValues.Secret__c = 'old secret';
	const data = JSON.stringify(h.exportJson());
	assert.doesNotMatch(data, /new secret|old secret/);
});

test('JSON omits inaccessible and permission-hidden cards and their edges', () => {
	const h = mount();
	h.a._inaccessible = true;
	h.b._permissionHidden = true;
	const file = h.exportJson();
	assert.equal(file.records.length, 1);
	assert.equal(file.associations.length, 0);
	assert.doesNotMatch(JSON.stringify(file), /Account A|Account B/);
});

test('snapshot cross-org import keeps field values as drafts', async () => {
	const h = mount();
	const file = h.exportJson();
	file._meta.exportedFrom = 'another-org';
	await h.api.applyTemplate(file, { merge: false });
	assert.equal(h.state.bulkRecords[0].values.Name, 'Account A');
	assert.ok(h.state.bulkRecords.every((r) => !r.loadedFromId));
	assert.equal(h.state.bulkAssociations.length, 1);
});
