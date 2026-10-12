import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../src/public/js/find-duplicates-modal.js', import.meta.url), 'utf8');
const appSource = fs.readFileSync(new URL('../src/public/js/app.js', import.meta.url), 'utf8');
function fixture({ deny = false, productionMark = false } = {}) {
	const records = [1, 2, 3, 4].map((id) => ({
		id,
		objectName: 'Account',
		values: { Name: 'Acme' },
		...(id < 3 ? { loadedFromId: '001' + id } : {}),
	}));
	const canvasState = {
		bulkRecords: [...records],
		bulkAssociations: [{ fromId: 3, toId: 1 }],
		bulkSelectedIds: new Set([1, 3]),
		describeCache: { Account: { deletable: true } },
	};
	let undo, message;
	const calls = [];
	const window = {};
	vm.runInNewContext(source, { window });
	let marking;
	if (productionMark) {
		const start = appSource.indexOf('function markPendingDelete(id, opts)');
		const end = appSource.indexOf('async function refreshRecordFromSf', start);
		assert.ok(start >= 0 && end > start);
		marking = vm.runInNewContext(appSource.slice(start, end) + '\n({ markPendingDelete, unmarkPendingDelete });', {
			canvasState,
			_canEditCanvasStructure: () => !deny,
			isRecordModified: (rec) =>
				!!rec.loadedValues && JSON.stringify(rec.values) !== JSON.stringify(rec.loadedValues),
			showBulkToast() {},
			renderBulkView() {},
			pushUndo() {},
			console: { warn() {} },
		});
	}
	const api = window.OrgLoom.findDuplicatesModal.mount({
		canvasState,
		escapeHtml: String,
		recordOrdinal: (r) => r.id,
		renderBulkView() {},
		getCyInstance() {},
		isRecordPendingDelete: (r) => !!r.pendingDelete,
		deleteRecord(id) {
			calls.push(['remove', id]);
			if (deny) return false;
			canvasState.bulkRecords = canvasState.bulkRecords.filter((r) => r.id !== id);
			canvasState.bulkAssociations = canvasState.bulkAssociations.filter((a) => a.fromId !== id && a.toId !== id);
			canvasState.bulkSelectedIds.delete(id);
			return true;
		},
		markPendingDelete(id, opts) {
			calls.push(['delete', id]);
			if (marking) return marking.markPendingDelete(id, opts);
			if (deny) return false;
			canvasState.bulkRecords.find((r) => r.id === id).pendingDelete = true;
			return true;
		},
		showBulkToast: (msg) => {
			message = msg;
		},
		showBulkToastWithAction: (msg, label, fn) => {
			message = msg;
			undo = fn;
		},
	})._test;
	const sections = [{ objectName: 'Account', groups: [{ records, fields: ['Name'] }], actions: new Map() }];
	return { api, records, canvasState, sections, calls, marking, undo: () => undo(), message: () => message };
}

test('no row action is selected automatically', () => {
	const f = fixture();
	f.api.apply(f.sections);
	assert.deepEqual(f.calls, []);
	assert.equal(f.canvasState.bulkRecords.length, 4);
	assert.equal(f.api.applyLabel(f.sections), 'Apply changes');
});

test('existing records can be removed locally or marked for delete independently', () => {
	const f = fixture();
	f.sections[0].actions = new Map([
		[1, 'remove'],
		[2, 'delete'],
		[3, 'remove'],
	]);
	assert.equal(f.api.applyLabel(f.sections), 'Apply changes (3)');
	f.api.apply(f.sections);
	assert.deepEqual(f.calls, [
		['delete', 2],
		['remove', 1],
		['remove', 3],
	]);
	assert.deepEqual(
		f.canvasState.bulkRecords.map((r) => r.id),
		[2, 4],
	);
	assert.equal(f.records[1].pendingDelete, true);
	assert.equal(f.records[0].pendingDelete, undefined);
	assert.match(f.message(), /2 records removed from canvas/);
	f.undo();
	assert.deepEqual(
		f.canvasState.bulkRecords.map((r) => r.id),
		[1, 2, 3, 4],
	);
	assert.equal(f.records[1].pendingDelete, false);
	assert.equal(f.canvasState.bulkAssociations.length, 1);
	assert.deepEqual([...f.canvasState.bulkSelectedIds], [1, 3]);
});

test('every record in a group can be selected, with no enforced survivor', () => {
	const f = fixture();
	f.sections[0].actions = new Map(f.records.map((r) => [r.id, 'remove']));
	f.api.apply(f.sections);
	assert.equal(f.canvasState.bulkRecords.length, 0);
});

test('draft Salesforce deletion and actions on records outside the results are ignored', () => {
	const f = fixture();
	f.sections[0].actions = new Map([
		[3, 'delete'],
		[999, 'remove'],
	]);
	f.api.apply(f.sections);
	assert.deepEqual(f.calls, []);
});

test('records removed or marked after scanning are not acted on again', () => {
	const f = fixture();
	f.sections[0].actions = new Map([
		[1, 'delete'],
		[2, 'remove'],
	]);
	f.records[0].pendingDelete = true;
	f.canvasState.bulkRecords = f.canvasState.bulkRecords.filter((r) => r.id !== 2);
	f.api.apply(f.sections);
	assert.deepEqual(f.calls, []);
});

test('shared helper refusals leave records untouched and report skips', () => {
	const f = fixture({ deny: true });
	f.sections[0].actions = new Map([
		[1, 'delete'],
		[3, 'remove'],
	]);
	f.api.apply(f.sections);
	assert.equal(f.canvasState.bulkRecords.length, 4);
	assert.equal(f.records[0].pendingDelete, undefined);
	assert.match(f.message(), /2 skipped/);
});

test('undo cannot overwrite a subsequent edit', () => {
	const f = fixture();
	f.sections[0].actions.set(3, 'remove');
	f.api.apply(f.sections);
	f.records[0].values.Name = 'Later edit';
	f.undo();
	assert.equal(f.records[0].values.Name, 'Later edit');
	assert.equal(f.canvasState.bulkRecords.length, 3);
	assert.match(f.message(), /edited afterward/);
});

test('Find duplicates marks a modified record through the real helper and cancellation keeps edits', () => {
	const f = fixture({ productionMark: true });
	const record = f.records[0];
	record.loadedValues = { Name: 'Original' };
	record.values = { Name: 'Edited', Rating: 'Hot' };
	const editedValues = record.values;
	f.sections[0].actions.set(record.id, 'delete');
	f.api.apply(f.sections);
	assert.equal(record.pendingDelete, true);
	assert.equal(record.values, editedValues);
	assert.equal(record.loadedValues.Name, 'Original');
	assert.match(f.message(), /1 existing record marked for delete/);
	assert.equal(f.marking.unmarkPendingDelete(record.id), true);
	assert.equal(record.pendingDelete, false);
	assert.equal(record.values, editedValues);
});

test('batch Undo keeps modified values when reversing a deletion mark', () => {
	const f = fixture({ productionMark: true });
	f.records[0].loadedValues = { Name: 'Original' };
	f.sections[0].actions.set(1, 'delete');
	f.api.apply(f.sections);
	f.undo();
	assert.equal(f.records[0].pendingDelete, false);
	assert.equal(f.records[0].values.Name, 'Acme');
});

test('allowing modified records does not bypass Salesforce or canvas delete permissions', () => {
	for (const denial of ['canvas', 'object', 'record', 'inaccessible']) {
		const f = fixture({ productionMark: true, deny: denial === 'canvas' });
		f.records[0].loadedValues = { Name: 'Original' };
		if (denial === 'object') f.canvasState.describeCache.Account.deletable = false;
		if (denial === 'record') f.records[0]._recordAccess = { checked: true, hasDeleteAccess: false };
		if (denial === 'inaccessible') f.records[0]._inaccessible = true;
		f.sections[0].actions.set(1, 'delete');
		f.api.apply(f.sections);
		assert.equal(f.records[0].pendingDelete, undefined);
		assert.equal(f.records[0].values.Name, 'Acme');
		assert.match(f.message(), /1 skipped/);
	}
});
