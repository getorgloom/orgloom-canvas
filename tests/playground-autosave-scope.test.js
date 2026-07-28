import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function makeStorage() {
	const map = new Map();
	return {
		get length() {
			return map.size;
		},
		key(i) {
			return Array.from(map.keys())[i] ?? null;
		},
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
		setTimeout: (fn) => {
			fn();
			return 1;
		},
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
		migrateMode: { active: false, sourceSfOrgId: null, targetSfOrgId: null },
	};
	const api = win.OrgLoom.canvasAutosave.mount({ canvasState });
	return { api, win, sessionStorage, localStorage, canvasState };
}

function setScope(win, canvasState, { account, org, user }) {
	win.ORGLOOM_ACCOUNT_ID = account;
	win.SF_ORG_ID = org;
	win.SF_USER_ID = user;
	canvasState.currentCanvas = null; // both scopes are an unsaved ('new') canvas
}

const REAL = { account: 'acc_real', org: '00DREAL', user: '005REAL' };
const DEMO = { account: 'playground', org: '00DDEMO000000000AAA', user: '005DEMO000000000AAA' };

describe('autosave scope-namespacing (playground vs real)', () => {
	test('refresh restores the active saved canvas, including slot configuration', () => {
		const { api, win, sessionStorage, canvasState } = harness();
		setScope(win, canvasState, REAL);
		canvasState.currentCanvas = {
			id: '069000000000001AAA',
			title: 'Slot intake',
			ownedByMe: true,
		};
		canvasState.bulkRecords = [
			{
				id: 21,
				objectName: 'Contact',
				values: {},
				slot: {
					slotId: 7,
					kind: 'fields',
					fields: ['FirstName', 'LastName'],
					description: 'Add the contact details',
					assigneeSfUserId: '005TEAMMATE',
					assigneeName: 'Alex Teammate',
					assigneeEmail: 'alex@example.com',
				},
			},
		];
		api.autosaveSchedule();

		canvasState.currentCanvas = null; // startup has no canvas Id after the URL is cleaned
		canvasState.bulkRecords = [];
		assert.equal(api.autosaveRestore(), true);
		assert.equal(canvasState.currentCanvas.id, '069000000000001AAA');
		assert.equal(Array.from(canvasState.bulkRecords[0].slot.fields).join(','), 'FirstName,LastName');
		assert.equal(canvasState.bulkRecords[0].slot.assigneeName, 'Alex Teammate');
		assert.ok(
			sessionStorage
				._dump()
				.some((key) => key.indexOf('orgloom:canvas-draft-active:v1|acc_real:00DREAL:005REAL') === 0),
			'active saved-canvas pointer stays scoped to the account, org, and user',
		);
	});

	test('refresh preserves a shared canvas recipient role for the first render', () => {
		const { api, win, canvasState } = harness();
		setScope(win, canvasState, REAL);
		canvasState.currentCanvas = {
			id: '069000000000009AAA',
			title: 'Shared intake',
			ownedByMe: false,
			recipientRole: 'viewer',
		};
		canvasState.bulkRecords = [
			{
				id: 31,
				objectName: 'Opportunity',
				values: {},
				slot: { slotId: 9, kind: 'whole-record' },
			},
		];
		api.autosaveFlush();

		canvasState.currentCanvas = null;
		canvasState.bulkRecords = [];
		assert.equal(api.autosaveRestore(), true);
		assert.equal(canvasState.currentCanvas.ownedByMe, false);
		assert.equal(canvasState.currentCanvas.recipientRole, 'viewer');
	});

	test('refresh does not guess an unrelated saved canvas when the active pointer is missing', () => {
		const { api, win, sessionStorage, canvasState } = harness();
		setScope(win, canvasState, REAL);
		canvasState.currentCanvas = { id: '069000000000002AAA', title: 'Stale snapshot', ownedByMe: true };
		canvasState.bulkRecords = [{ id: 1, objectName: 'Account', values: { Name: 'Must not restore' } }];
		api.autosaveSchedule();

		const pointerKey = sessionStorage._dump().find((key) => key.indexOf('orgloom:canvas-draft-active:v1|') === 0);
		sessionStorage.removeItem(pointerKey);

		canvasState.currentCanvas = null;
		canvasState.bulkRecords = [];
		assert.equal(api.autosaveRestore(), false);
		assert.equal(canvasState.currentCanvas, null);
		assert.equal(canvasState.bulkRecords.length, 0);
	});

	test('page-exit flush makes the canvas active at refresh authoritative', () => {
		const { api, win, canvasState } = harness();
		setScope(win, canvasState, REAL);
		canvasState.currentCanvas = { id: '069000000000001AAA', title: 'Old canvas', ownedByMe: true };
		canvasState.bulkRecords = [{ id: 1, objectName: 'Account', values: { Name: 'Old' } }];
		api.autosaveSchedule();

		canvasState.currentCanvas = { id: '069000000000002AAA', title: 'Current canvas', ownedByMe: true };
		canvasState.bulkRecords = [{ id: 2, objectName: 'Contact', values: { LastName: 'Current' } }];
		api.autosaveFlush();

		canvasState.currentCanvas = null;
		canvasState.bulkRecords = [];
		assert.equal(api.autosaveRestore(), true);
		assert.equal(canvasState.currentCanvas.id, '069000000000002AAA');
		assert.equal(canvasState.bulkRecords[0].values.LastName, 'Current');
	});

	test('opening the playground scope does NOT clear the real draft', () => {
		const { api, win, sessionStorage, canvasState } = harness();

		setScope(win, canvasState, REAL);
		canvasState.bulkRecords = [{ id: 'r1', objectName: 'Account', values: { Name: 'Real Co' } }];
		api.autosaveSchedule();
		const realKeys = sessionStorage._dump().filter((k) => k.indexOf('orgloom:canvas-draft:v1') === 0);
		assert.equal(realKeys.length, 1, 'one scoped draft key written');

		setScope(win, canvasState, DEMO);
		canvasState.bulkRecords = []; // demo canvas starts empty
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

describe('cross-org migration session-only recovery and isolation', () => {
	test('migration snapshot stays in sessionStorage and leaves no durable localStorage copy', () => {
		const first = harness();
		setScope(first.win, first.canvasState, REAL);
		first.canvasState.bulkRecords = [
			{
				id: 1,
				objectName: 'Account',
				loadedFromId: '001SOURCE',
				values: {
					attributes: { type: 'Account', url: '/services/data/vXX.X/sobjects/Account/001SOURCE' },
					Id: '001SOURCE',
					Name: 'Durable Co',
				},
			},
		];
		assert.equal(first.api.migrationStash({ status: 'awaiting-target' }), true);
		assert.ok(first.sessionStorage.getItem('orgloom:migration:v1'));
		assert.equal(
			first.localStorage.getItem('orgloom:migration:v1'),
			null,
			'Salesforce data is not persisted beyond the tab session',
		);

		setScope(first.win, first.canvasState, { account: REAL.account, org: '00DTARGET', user: REAL.user });
		const resumed = first.api.migrationResume();
		assert.equal(resumed.restored, true);
		assert.equal(resumed.isCrossOrg, true);
		assert.equal(first.canvasState.bulkRecords[0].loadedFromId, undefined, 'source Id stripped');
		assert.equal(first.canvasState.bulkRecords[0].values.Id, undefined, 'source values.Id stripped');
		assert.equal(
			first.canvasState.bulkRecords[0].values.attributes,
			undefined,
			'Salesforce transport metadata stripped',
		);
	});

	test('another Org Loom account cannot resume the same-tab migration', () => {
		const first = harness();
		setScope(first.win, first.canvasState, REAL);
		first.canvasState.bulkRecords = [{ id: 1, objectName: 'Account', values: { Name: 'Private Co' } }];
		first.api.migrationStash({ status: 'awaiting-target' });

		setScope(first.win, first.canvasState, { account: 'acc_other', org: '00DTARGET', user: '005OTHER' });
		assert.equal(first.api.migrationResume(), false);
	});

	test('an in-progress migration is synced only by its bound destination page', () => {
		const h = harness();
		setScope(h.win, h.canvasState, REAL);
		h.canvasState.bulkRecords = [{ id: 1, objectName: 'Account', values: { Name: 'Bound Co' } }];
		h.api.migrationStash({ status: 'awaiting-target' });

		const target = { account: REAL.account, org: '00DTARGET', user: REAL.user };
		setScope(h.win, h.canvasState, target);
		assert.equal(h.api.migrationResume().restored, true);
		h.canvasState.migrateMode.active = true;
		h.canvasState.migrateMode.targetSfOrgId = target.org;
		h.canvasState.bulkRecords[0].loadedFromId = '001TARGET';
		h.canvasState.bulkRecords[0]._migrateMatchedId = '001TARGET';
		h.api.migrationSyncIfActive();

		setScope(h.win, h.canvasState, REAL);
		h.canvasState.migrateMode.active = false;
		h.canvasState.bulkRecords = [{ id: 99, objectName: 'Contact', values: { LastName: 'Wrong page' } }];
		h.api.autosaveSchedule();
		const stored = JSON.parse(h.sessionStorage.getItem('orgloom:migration:v1'));
		assert.equal(stored.targetSfOrgId, target.org);
		assert.equal(
			stored.state.bulkRecords[0].loadedFromId,
			'001TARGET',
			'destination match survives wrong-org autosave',
		);
		assert.equal(stored.state.bulkRecords[0].objectName, 'Account');

		setScope(h.win, h.canvasState, target);
		h.canvasState.bulkRecords = [];
		const recovered = h.api.migrationResume();
		assert.equal(recovered.restored, true);
		assert.equal(h.canvasState.bulkRecords[0].loadedFromId, '001TARGET');
	});
});
