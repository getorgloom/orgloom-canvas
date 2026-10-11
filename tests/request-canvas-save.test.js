import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/public/js/app.js', import.meta.url), 'utf8');
function section(start, end) {
	const a = source.indexOf(start),
		b = source.indexOf(end, a);
	assert.ok(a >= 0 && b > a);
	return source.slice(a, b);
}
function fixture({ cancelled = false, newlySaved = true, saveFails = false } = {}) {
	const id = '069000000000001AAA';
	const state = { currentCanvas: { id }, selectedObjects: [], bulkRecords: [], bulkAssociations: [], bulkIdSeq: 1 };
	const config = cancelled
		? null
		: {
				savedCanvasForRequest: newlySaved ? id : null,
				label: 'Add an account',
				description: 'Please complete this',
				assigneeSfUserId: '005000000000002AAA',
				assigneeName: 'Erica',
				assigneeEmail: 'erica@example.com',
			};
	const writes = [],
		messages = [],
		undos = [];
	const ctx = vm.createContext({
		canvasState: state,
		slotIdSeq: 1,
		_canAuthorSlots: () => true,
		_canvasCapBlockReason: () => null,
		ensureDescribe: async () => ({ label: 'Account', fields: [{ name: 'Name', createable: true }] }),
		showSlotConfigurationPicker: async () => config,
		addToSelection: async (name) => {
			const entry = { name, label: name, id: 1 };
			state.selectedObjects.push(entry);
			return entry;
		},
		_nextRecordPosition: () => ({ x: 1, y: 2 }),
		renderBulkView() {},
		pushUndo: (_, callback) => undos.push(callback),
		showBulkToast: (message) => messages.push(message),
		saveExistingCanvas: async () => {
			writes.push(JSON.parse(JSON.stringify(state.bulkRecords)));
			return !saveFails;
		},
	});
	vm.runInContext(
		section('async function _saveNewRequestCanvas', 'async function convertRecordToFieldSlot') +
			section('async function createStandaloneRecordRequest', 'function openStandaloneRecordRequestPicker'),
		ctx,
	);
	return { state, writes, messages, undos, create: () => ctx.createStandaloneRecordRequest('Account') };
}

test('first canvas save is followed by a save containing the configured record request', async () => {
	const f = fixture();
	assert.equal(await f.create(), true);
	assert.equal(f.writes.length, 1);
	assert.equal(f.writes[0].length, 1);
	assert.equal(f.writes[0][0].slot.kind, 'whole-record');
	assert.equal(f.writes[0][0].slot.description, 'Please complete this');
	assert.equal(f.writes[0][0].slot.assigneeSfUserId, '005000000000002AAA');
	assert.equal(f.state.selectedObjects[0].name, 'Account');
});

test('cancelling request configuration creates and saves no request', async () => {
	const f = fixture({ cancelled: true });
	assert.equal(await f.create(), false);
	assert.equal(f.state.bulkRecords.length, 0);
	assert.equal(f.writes.length, 0);
});

test('already-saved canvas retains its existing request save flow', async () => {
	const f = fixture({ newlySaved: false });
	assert.equal(await f.create(), true);
	assert.equal(f.state.bulkRecords.length, 1);
	assert.equal(f.writes.length, 0);
});

test('failed final save retains the request locally and reports that it needs saving', async () => {
	const f = fixture({ saveFails: true });
	assert.equal(await f.create(), false);
	assert.equal(f.state.bulkRecords[0].slot.description, 'Please complete this');
	assert.match(f.messages.at(-1), /could not be saved/);
	assert.ok(!f.messages.some((message) => message.startsWith('Record request created')));
	assert.equal(f.undos.length, 1);
});
