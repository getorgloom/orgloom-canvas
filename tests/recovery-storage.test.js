import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function storage() {
	const data = new Map();
	return {
		get length() {
			return data.size;
		},
		key: (i) => [...data.keys()][i],
		getItem: (k) => data.get(k) ?? null,
		setItem: (k, v) => data.set(k, String(v)),
		removeItem: (k) => data.delete(k),
	};
}
function harness() {
	let now = 1_000_000_000;
	const listeners = {};
	const window = {
		sessionStorage: storage(),
		localStorage: storage(),
		addEventListener: (name, fn) => {
			listeners[name] = fn;
		},
		setInterval: (fn) => {
			listeners.interval = fn;
		},
	};
	vm.runInNewContext(fs.readFileSync(new URL('../src/public/js/recovery-storage.js', import.meta.url), 'utf8'), {
		window,
		Date: { now: () => now },
	});
	return {
		window,
		listeners,
		api: window.OrgLoom.recoveryStorage,
		advance: (ms) => {
			now += ms;
		},
		payload: () => JSON.stringify({ v: 1, ts: now, state: { records: ['private'] } }),
	};
}
const snapshot = 'orgloom:canvas-draft:v1|account:org:user:new';
const pointer = 'orgloom:canvas-draft-active:v1|account:org:user';

test('fresh recovery works; two-hour expiration deletes snapshots and dangling pointers', () => {
	const h = harness();
	h.api.setItem(snapshot, h.payload());
	h.api.setItem(pointer, snapshot);
	assert.ok(h.api.getItem(snapshot));
	h.advance(2 * 60 * 60 * 1000);
	h.listeners.interval();
	assert.equal(h.window.sessionStorage.getItem(snapshot), null);
	assert.equal(h.api.getItem(pointer), null);
});

test('all draft and migration copies expire, including non-active canvases', () => {
	const h = harness();
	const keys = [
		snapshot,
		'orgloom:canvas-draft:v1|other:org:user:old',
		'orgloom:draftValues:canvas1',
		'orgloom:migration:v1',
	];
	keys.forEach((key) => h.api.setItem(key, h.payload()));
	h.advance(2 * 60 * 60 * 1000);
	h.listeners.pageshow();
	keys.forEach((key) => assert.equal(h.window.sessionStorage.getItem(key), null));
});

test('handoff expires at ten minutes without expiring newer canvas recovery', () => {
	const h = harness();
	h.api.setItem('orgloom:org-switch-stash:v1', h.payload());
	h.api.setItem(snapshot, h.payload());
	h.advance(10 * 60 * 1000);
	assert.equal(h.api.getItem('orgloom:org-switch-stash:v1'), null);
	assert.ok(h.api.getItem(snapshot));
});

test('malformed, undated and future-dated data is removed rather than restored', () => {
	const h = harness();
	for (const raw of ['{', 'null', '{}', JSON.stringify({ ts: 2_000_000_000 })]) {
		h.window.sessionStorage.setItem(snapshot, raw);
		assert.equal(h.api.getItem(snapshot), null);
		assert.equal(h.window.sessionStorage.getItem(snapshot), null);
	}
});

test('session termination clears records and metadata but preserves preferences and blocks late writers', () => {
	const h = harness();
	for (const key of [
		snapshot,
		pointer,
		'orgloom:draftValues:1',
		'orgloom:migration:v1',
		'orgloom:org-switch-stash:v1',
		'orgloom:reauth-fallback:v1',
		'orgloom-describe-v8|org|user|Account',
		'orgloom:sfOfflineMode',
	])
		h.window.sessionStorage.setItem(key, h.payload());
	h.window.localStorage.setItem('orgloom:migration:v1', h.payload());
	h.window.localStorage.setItem('theme', 'dark');
	h.window.localStorage.setItem('orgloom.playground.records', 'demo');
	h.window.sessionStorage.setItem('unrelated', 'keep');
	h.window.OrgLoom.sessionEnded = true;
	h.listeners['orgloom:session-ended']();
	assert.equal(h.window.sessionStorage.length, 1);
	assert.equal(h.window.localStorage.getItem('orgloom:migration:v1'), null);
	assert.equal(h.window.localStorage.getItem('theme'), 'dark');
	assert.equal(h.window.localStorage.getItem('orgloom.playground.records'), 'demo');
	h.api.setItem(snapshot, h.payload());
	assert.equal(h.window.sessionStorage.getItem(snapshot), null);
});

test('blocked browser storage does not break cleanup or recovery', () => {
	const h = harness();
	Object.defineProperty(h.window, 'sessionStorage', {
		get() {
			throw new Error('blocked');
		},
	});
	Object.defineProperty(h.window, 'localStorage', {
		get() {
			throw new Error('blocked');
		},
	});
	assert.doesNotThrow(() => {
		h.api.clear();
		h.api.prune();
		h.api.setItem(snapshot, 'x');
	});
	assert.equal(h.api.getItem(snapshot), null);
});
