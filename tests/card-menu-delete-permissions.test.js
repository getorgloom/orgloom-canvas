import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/public/js/canvas-card-menu.js', import.meta.url), 'utf8');
function setup({ deletable = true, cached = false, fails = false } = {}) {
	const target = { innerHTML: '' };
	const pop = {
		style: {},
		innerHTML: '',
		isConnected: false,
		offsetHeight: 400,
		querySelector: () => target,
		addEventListener(name, handler) {
			this[name] = handler;
		},
		remove() {
			this.isConnected = false;
		},
	};
	const document = {
		querySelectorAll: () => [],
		createElement: () => pop,
		body: {
			appendChild(el) {
				el.isConnected = true;
				el.parentNode = this;
			},
		},
		removeEventListener() {},
	};
	const window = { OrgLoom: {}, innerWidth: 1200, innerHeight: 900 };
	vm.runInNewContext(source, { window, document, setTimeout() {} });
	const state = { describeCache: cached ? { Contact: { deletable } } : {} };
	const rec = { id: 2, objectName: 'Contact', loadedFromId: '003test' };
	const env = { pop, target, state, rec, calls: 0, marked: [], editable: true };
	const noop = () => {};
	const api = window.OrgLoom.canvasCardMenu.mount({
		canvasState: state,
		csrfFetch: noop,
		escapeHtml: String,
		renderBulkView: noop,
		recordOrdinal: () => 1,
		showBulkToast: noop,
		showConfirmDialog: noop,
		isRecordModified: () => false,
		canEditCanvasStructure: () => env.editable,
		_canAuthorSlots: () => false,
		_hasCap: () => false,
		openInsertModal: noop,
		convertRecordToFieldSlot: noop,
		configureExistingSlot: noop,
		convertSlotBackToRecord: noop,
		refreshRecordFromSf: noop,
		deleteRecord: noop,
		unmarkPendingDelete: noop,
		attachSfUserPicker: noop,
		_fillSlotWithSfRecord: noop,
		markPendingDelete: (id) => env.marked.push(id),
		canDeleteRecord: (record) => state.describeCache[record.objectName]?.deletable === true && !record.denied,
		ensureDescribe: async () => {
			env.calls++;
			if (fails) throw new Error('Describe unavailable');
			return (state.describeCache.Contact = { deletable });
		},
	});
	env.open = () => api.showCardMoreMenu({ getBoundingClientRect: () => ({ left: 100, top: 100, bottom: 120 }) }, rec);
	return env;
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('related-record menu loads missing permissions and offers mark for delete without opening the editor', async () => {
	const e = setup();
	e.open();
	assert.match(e.pop.innerHTML, /Checking delete permissions/);
	assert.doesNotMatch(e.pop.innerHTML, /data-card-action="mark-delete"/);
	await settle();
	assert.equal(e.calls, 1);
	assert.match(e.target.innerHTML, /data-card-action="mark-delete"/);
	await e.pop.click({ target: { closest: () => ({ dataset: { cardAction: 'mark-delete' } }) } });
	assert.deepEqual(e.marked, [2]);
});

test('known delete permissions do not trigger another describe request', async () => {
	for (const deletable of [true, false]) {
		const e = setup({ cached: true, deletable });
		e.open();
		await settle();
		assert.equal(e.calls, 0);
		assert.equal(e.pop.innerHTML.includes('data-card-action="mark-delete"'), deletable);
	}
});

test('missing metadata fails closed and can be retried by reopening the menu', async () => {
	const e = setup({ fails: true });
	e.open();
	await settle();
	assert.match(e.target.innerHTML, /Could not check delete permissions/);
	assert.doesNotMatch(e.target.innerHTML, /data-card-action="mark-delete"/);
	e.open();
	await settle();
	assert.equal(e.calls, 2);
});

test('late permission responses respect denial, role changes and closed menus', async () => {
	for (const change of ['denied', 'role', 'closed']) {
		const e = setup();
		e.open();
		if (change === 'denied') e.rec.denied = true;
		if (change === 'role') e.editable = false;
		if (change === 'closed') e.pop.remove();
		await settle();
		assert.doesNotMatch(e.target.innerHTML, /data-card-action="mark-delete"/);
	}
});
