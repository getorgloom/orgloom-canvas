import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = (name) => fs.readFileSync(new URL('../src/public/js/' + name, import.meta.url), 'utf8');
const app = read('app.js');
const editor = read('insert-modal.js');

function setup(loaded = true) {
	const record = { id: 1, objectName: 'Account', values: { Name: 'Original', Phone: '123' } };
	if (loaded) {
		record.loadedFromId = '001000000000001AAA';
		record.loadedValues = { ...record.values };
	}
	const state = { bulkRecords: [record], bulkAssociations: [], graphView: 'bulk' };
	const messages = [],
		commits = [],
		refreshes = [];
	let keydown;
	const context = vm.createContext({
		window: { OrgLoom: {} },
		canvasState: state,
		document: {
			addEventListener: (_event, fn) => {
				keydown = fn;
			},
		},
		showBulkToast: (message) => messages.push(message),
	});
	vm.runInContext(read('value-compare.js'), context);
	vm.runInContext(editor, context);
	vm.runInContext(
		app.slice(app.indexOf('\tconst undoStack = [];'), app.indexOf('\tfunction deleteRecord(id)')),
		context,
	);
	const keyStart = app.indexOf("\tdocument.addEventListener('keydown', async (e) => {");
	vm.runInContext(app.slice(keyStart, app.indexOf('\n\tfunction onRecordClick', keyStart)), context);
	const deps = {
		canvasState: state,
		pushUndo: context.pushUndo,
		canUndoFields: () => true,
		commitRecordFields: async (_record, fields, options) => {
			options.beforeCommit();
			commits.push(fields);
		},
		releaseRecordFieldLocks() {},
		renderChips() {},
		renderBulkView() {},
		onFieldsUndone: (_record, fields) => refreshes.push(fields),
		showBulkToast: (message) => messages.push(message),
	};
	const save = (fields) => {
		const before = { ...record.values };
		const links = state.bulkAssociations.slice();
		record.values = { ...record.values, ...fields };
		context.window.OrgLoom.insertModal._test.registerFieldEditUndo(
			deps,
			record,
			before,
			Object.keys(fields),
			links,
		);
	};
	const undo = (target = { tagName: 'DIV' }) => keydown({ key: 'z', ctrlKey: true, target, preventDefault() {} });
	return { record, state, context, deps, save, undo, messages, commits, refreshes };
}

test('saved edits undo one save at a time without replacing unrelated record fields', async () => {
	const h = setup();
	h.save({ Name: 'First' });
	h.save({ Name: 'Second' });
	h.record.values.Phone = 'Changed elsewhere';
	await h.undo();
	assert.equal(h.record.values.Name, 'First');
	await h.undo();
	assert.equal(h.record.values.Name, 'Original');
	assert.equal(h.record.values.Phone, 'Changed elsewhere');
	assert.equal(h.refreshes.length, 2);
});

test('draft edit undo restores absent fields, nulls, false and zero', async () => {
	const h = setup(false);
	h.record.values = { Flag: false, Count: 0, Empty: null };
	h.save({ Flag: true, Count: 3, Empty: 'filled', NewField: 'added' });
	await h.undo();
	assert.deepEqual(h.record.values, { Flag: false, Count: 0, Empty: null });
	assert.equal(h.commits[0].NewField, null);
});

test('clearing a field can be undone and native text undo is left alone', async () => {
	const h = setup();
	h.save({ Phone: null });
	await h.undo({ tagName: 'INPUT' });
	assert.equal(h.record.values.Phone, null);
	await h.undo();
	assert.equal(h.record.values.Phone, '123');
});

for (const [label, invalidate] of [
	[
		'newer same-field edit',
		(h) => {
			h.record.values.Name = 'Peer edit';
		},
	],
	[
		'upload or refresh',
		(h) => {
			h.record.loadedValues = { ...h.record.values };
		},
	],
	[
		'draft uploaded',
		(h) => {
			h.record.loadedFromId = '001000000000002AAA';
		},
	],
	[
		'removed record',
		(h) => {
			h.state.bulkRecords = [];
		},
	],
	[
		'lost permission',
		(h) => {
			h.deps.canUndoFields = () => false;
		},
	],
	[
		'replaced canvas',
		(h) => {
			h.context.clearUndoHistory();
		},
	],
]) {
	test('undo does not overwrite after ' + label, async () => {
		const h = setup();
		h.save({ Name: 'Edited' });
		invalidate(h);
		const expected = h.record.values.Name;
		await h.undo();
		assert.equal(h.record.values.Name, expected);
		assert.equal(h.commits.length, 0);
	});
}

test('failed shared commit keeps the edit and allows retry', async () => {
	const h = setup();
	h.save({ Name: 'Edited' });
	const commit = h.deps.commitRecordFields;
	h.deps.commitRecordFields = async () => {
		throw new Error('Field locked');
	};
	await h.undo();
	assert.equal(h.record.values.Name, 'Edited');
	assert.match(h.messages[0], /Field locked/);
	h.deps.commitRecordFields = commit;
	await h.undo();
	assert.equal(h.record.values.Name, 'Original');
});

test('async undo cannot run twice or apply into a replaced canvas', async () => {
	const h = setup();
	h.save({ Name: 'Edited' });
	let finish;
	h.deps.commitRecordFields = () =>
		new Promise((resolve) => {
			finish = resolve;
		});
	const pending = h.undo();
	await h.undo();
	h.context.clearUndoHistory();
	finish();
	await pending;
	assert.equal(h.record.values.Name, 'Edited');
	assert.equal(h.refreshes.length, 0);
});

test('lookup edits restore their original canvas connection', async () => {
	const h = setup();
	const parent = { id: 2 };
	h.state.bulkRecords.push(parent);
	const oldLink = { id: 3, fromId: 1, toId: 2, fieldName: 'ParentId' };
	const before = { ...h.record.values, ParentId: '001000000000002AAA' };
	h.record.values.ParentId = '001000000000003AAA';
	h.context.window.OrgLoom.insertModal._test.registerFieldEditUndo(h.deps, h.record, before, ['ParentId'], [oldLink]);
	await h.undo();
	assert.equal(h.record.values.ParentId, before.ParentId);
	assert.equal(JSON.stringify(h.state.bulkAssociations), JSON.stringify([oldLink]));
});

test('shared undo rechecks changes after waiting for field locks', async () => {
	const h = setup();
	h.save({ Name: 'Edited' });
	h.deps.commitRecordFields = async (_record, _fields, options) => {
		h.record.values.Name = 'Changed while acquiring lock';
		options.beforeCommit();
		assert.fail('must not send a stale undo');
	};
	await h.undo();
	assert.equal(h.record.values.Name, 'Changed while acquiring lock');
	assert.equal(h.refreshes.length, 0);
});

test('a shared commit echo can apply restored values before the response', async () => {
	const h = setup();
	h.save({ Name: 'Edited' });
	h.deps.commitRecordFields = async (_record, fields, options) => {
		options.beforeCommit();
		Object.assign(h.record.values, fields);
	};
	await h.undo();
	assert.equal(h.record.values.Name, 'Original');
	assert.equal(h.refreshes.length, 1);
});

test('editor save registers undo after its field commit and excludes encrypted values', () => {
	const save = editor.slice(
		editor.indexOf('const previousValues = canvasState.currentRecordRef.values'),
		editor.indexOf('const savedCount = changed.length'),
	);
	assert.ok(save.indexOf('await commitRecordFields(') < save.indexOf('registerFieldEditUndo('));
	assert.match(save, /changed = changed.filter\(\(fieldName\) => !encryptedFieldNames.has\(fieldName\)\)/);
	assert.match(app, /mountMultiple\(\{\s*pushUndo: pushUndo/);
});
