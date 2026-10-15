import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/public/js/app.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const start = source.indexOf(
	"document.addEventListener('keydown', (e) => {\n\t\tif (graph.classList.contains('hidden'))",
);
const end = source.indexOf('\n\tasync function addToSelection(', start);
assert.ok(start >= 0 && end > start);

function setup({ modalVisible = false, selectionText = '' } = {}) {
	let handler;
	const calls = [];
	const state = {
		graph: { classList: { contains: () => false } },
		document: {
			addEventListener: (_type, callback) => {
				handler = callback;
			},
			querySelectorAll: () => [{ getClientRects: () => (modalVisible ? [{}] : []) }],
			querySelector: () => null,
		},
		window: { getSelection: () => ({ isCollapsed: !selectionText, toString: () => selectionText }) },
		canvasState: { graphView: 'bulk', bulkSelectedIds: new Set(['record']) },
		copySelectionToClipboard: () => {
			calls.push('copy');
			return true;
		},
		pasteFromClipboard: () => calls.push('paste'),
		openPasteCountPrompt: () => calls.push('paste-many'),
		deleteRecord: () => calls.push('delete'),
	};
	vm.runInNewContext(source.slice(start, end), state);
	return {
		calls,
		press(key, options = {}) {
			let prevented = false;
			handler({
				key,
				ctrlKey: true,
				target: { tagName: 'DIV' },
				preventDefault: () => {
					prevented = true;
				},
				...options,
			});
			return prevented;
		},
	};
}

test('visible modals leave copy, paste, select-all and delete to the dialog/browser', () => {
	const env = setup({ modalVisible: true, selectionText: 'AssistantPhone cannot be null' });
	for (const key of ['c', 'v', 'a', 'Delete']) {
		assert.equal(env.press(key), false);
		assert.equal(env.press(key, { ctrlKey: false, metaKey: true }), false);
	}
	assert.deepEqual(env.calls, []);
});

test('selected text and editable targets keep native copy behavior', () => {
	const selected = setup({ selectionText: 'Validation error' });
	assert.equal(selected.press('c'), false);
	assert.deepEqual(selected.calls, []);
	for (const target of [{ tagName: 'INPUT' }, { tagName: 'DIV', isContentEditable: true }]) {
		const env = setup();
		assert.equal(env.press('c', { target }), false);
		assert.deepEqual(env.calls, []);
	}
});

test('canvas copy still works with hidden dialogs and no text selection', () => {
	const env = setup();
	assert.equal(env.press('c'), true);
	assert.equal(env.press('C', { ctrlKey: false, metaKey: true }), true);
	assert.deepEqual(env.calls, ['copy', 'copy']);
});

test('already handled keyboard events do not trigger canvas copying', () => {
	const env = setup();
	assert.equal(env.press('c', { defaultPrevented: true }), false);
	assert.deepEqual(env.calls, []);
});
