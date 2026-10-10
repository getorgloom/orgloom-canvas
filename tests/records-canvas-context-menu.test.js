import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/public/js/records-canvas.js', import.meta.url), 'utf8');
const start = source.indexOf('function handleRecordContextMenu(');
const end = source.indexOf('function renderBulkCanvasCy()', start);

function setup({ allowed = true, direct = true, menu = true, editable = false, x = 50, hidden = false } = {}) {
	const record = { id: 7 };
	const trigger = {};
	const card = {
		getAttribute: () => '7',
		querySelector: () => (menu ? trigger : null),
		getBoundingClientRect: () => ({
			left: 10,
			right: 110,
			top: 10,
			bottom: 110,
			width: hidden ? 0 : 100,
			height: 100,
		}),
	};
	const calls = [];
	const state = { bulkRecords: [record], bulkSelectedIds: new Set([2, 3]) };
	const handler = vm.runInNewContext('(' + source.slice(start, end) + ')', {
		canArrangeCanvas: () => allowed,
		canvasState: state,
		showCardMoreMenu: (...args) => calls.push(args),
	});
	const event = {
		target: {
			closest: (selector) =>
				selector === '.record-card[data-rec-id]' ? (direct ? card : null) : editable ? {} : null,
		},
		clientX: x,
		clientY: 50,
		prevented: false,
		stopped: false,
		preventDefault() {
			this.prevented = true;
		},
		stopPropagation() {
			this.stopped = true;
		},
	};
	handler(event, { querySelectorAll: () => [card] });
	return { event, calls, record, trigger, state };
}

test('right-click on a card opens the existing menu without changing selection', () => {
	const result = setup();
	assert.equal(result.calls.length, 1);
	assert.equal(result.calls[0][0], result.trigger);
	assert.equal(result.calls[0][1], result.record);
	assert.equal(result.event.prevented, true);
	assert.equal(result.event.stopped, true);
	assert.deepEqual([...result.state.bulkSelectedIds], [2, 3]);
});

test('right-click through the Cytoscape drawing layer resolves the visible card', () => {
	const result = setup({ direct: false });
	assert.equal(result.calls.length, 1);
	assert.equal(result.calls[0][1], result.record);
});

test('blank canvas, hidden cards, editing controls, and unavailable menus retain native behavior', () => {
	for (const options of [
		{ direct: false, x: 200 },
		{ direct: false, hidden: true },
		{ editable: true },
		{ menu: false },
		{ allowed: false },
	]) {
		const result = setup(options);
		assert.equal(result.calls.length, 0, JSON.stringify(options));
		assert.equal(result.event.prevented, false, JSON.stringify(options));
		assert.equal(result.event.stopped, false, JSON.stringify(options));
	}
});
