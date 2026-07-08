import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function makeStorage() {
	const map = new Map();
	return {
		get length() { return map.size; },
		key(i) { return Array.from(map.keys())[i] ?? null; },
		getItem: (k) => (map.has(k) ? map.get(k) : null),
		setItem: (k, v) => map.set(k, String(v)),
		removeItem: (k) => map.delete(k),
		clear: () => map.clear(),
		_dump: () => Array.from(map.keys()),
	};
}

function harness() {
	const sessionStorage = makeStorage();
	const localStorage = makeStorage();
	const win = {
		ORGLOOM_ACCOUNT_ID: null,
		SF_ORG_ID: null,
		SF_USER_ID: null,
		sessionStorage,
		localStorage,
	};
	const sandbox = {
		window: win,
		document: { addEventListener() {} },
		console,

		sessionStorage,
		localStorage,
		setTimeout: (fn) => { fn(); return 1; },
		clearTimeout: () => {},
	};
	vm.createContext(sandbox);
	vm.runInContext(readFileSync(new URL('../src/public/js/canvas-autosave.js', import.meta.url), 'utf8'), sandbox);

	const canvasState = {
		selectedObjects: [],
		selectedIdSeq: 1,
		activeIndex: 0,
		bulkRecords: [],
		bulkAssociations: [],
		bulkIdSeq: 1,
		hiddenObjects: new Set(),
		graphView: 'bulk',
		currentCanvas: null,
		_draftCanvasId: null,
		bulkZoom: 1,
		diffSuppressions: {},
	};
	const api = win.OrgLoom.canvasAutosave.mount({ canvasState });
	return { api, win, sessionStorage, canvasState };
}

function setScope(win, canvasState, { account, org, user }) {
	win.ORGLOOM_ACCOUNT_ID = account;
	win.SF_ORG_ID = org;
	win.SF_USER_ID = user;
	canvasState.currentCanvas = null;
}

const REAL = { account: 'acc_real', org: '00DREAL', user: '005REAL' };
const DEMO = { account: 'playground', org: '00DDEMO000000000AAA', user: '005DEMO000000000AAA' };

describe('autosave scope-namespacing (playground vs real)', () => {
	test('opening the playground scope does NOT clear the real draft', () => {
		const { api, win, sessionStorage, canvasState } = harness();

		setScope(win, canvasState, REAL);
		canvasState.bulkRecords = [{ id: 'r1', objectName: 'Account', values: { Name: 'Real Co' } }];
		api.autosaveSchedule();
		const realKeys = sessionStorage._dump().filter((k) => k.indexOf('orgloom:canvas-draft:v1') === 0);
		assert.equal(realKeys.length, 1, 'one scoped draft key written');

		setScope(win, canvasState, DEMO);
		canvasState.bulkRecords = [];
		const restoredDemo = api.autosaveRestore();
		assert.equal(restoredDemo, false, 'no demo draft to restore');

		const afterDemo = sessionStorage._dump().filter((k) => k.indexOf('orgloom:canvas-draft:v1') === 0);
		assert.ok(afterDemo.includes(realKeys[0]), 'real scoped draft survives the playground visit');

		setScope(win, canvasState, REAL);
		canvasState.bulkRecords = [];
		const restoredReal = api.autosaveRestore();
		assert.equal(restoredReal, true, 'real draft restores');
		assert.equal(canvasState.bulkRecords.length, 1);
		assert.equal(canvasState.bulkRecords[0].values.Name, 'Real Co');
	});

	test('real and demo drafts are stored under distinct keys', () => {
		const { api, win, sessionStorage, canvasState } = harness();

		setScope(win, canvasState, REAL);
		canvasState.bulkRecords = [{ id: 'r1', objectName: 'Account', values: { Name: 'Real' } }];
		api.autosaveSchedule();

		setScope(win, canvasState, DEMO);
		canvasState.bulkRecords = [{ id: 'd1', objectName: 'Account', values: { Name: 'Demo Acme' } }];
		api.autosaveSchedule();

		const keys = sessionStorage._dump().filter((k) => k.indexOf('orgloom:canvas-draft:v1') === 0);
		assert.equal(keys.length, 2, 'real and demo drafts under separate keys');

		setScope(win, canvasState, REAL);
		canvasState.bulkRecords = [];
		api.autosaveRestore();
		assert.equal(canvasState.bulkRecords[0].values.Name, 'Real', 'no demo bleed into the real canvas');
	});
});
