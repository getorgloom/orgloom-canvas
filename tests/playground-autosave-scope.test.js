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
	vm.runInContext(readFileSync(new URL('../src/public/js/encrypted-fields.js', import.meta.url), 'utf8'), sandbox);
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
		describeCache: {},
		draftDescribeCache: {},
		migrateMode: { active: false, sourceSfOrgId: null, targetSfOrgId: null },
	};
	const encryptedFields = win.OrgLoom.encryptedFields;
	const api = win.OrgLoom.canvasAutosave.mount({ canvasState, encryptedFields });
	return { api, win, sessionStorage, localStorage, canvasState };
}

function setScope(win, canvasState, { account, org, user }) {
	win.ORGLOOM_ACCOUNT_ID = account;
	win.SF_ORG_ID = org;
	win.SF_USER_ID = user;
	canvasState.currentCanvas = null; // both scopes are an unsaved ('new') canvas
}

const REAL = { account: 'acc_real', org: '00DREAL', user: '005REAL' };
const DEMO = { account: 'playground', org: '00DDEMO00000000AAA', user: '005DEMO00000000AAA' };

describe('autosave scope-namespacing (playground vs real)', () => {
	test('encrypted values never enter autosave storage and intent survives restore', () => {
		const { api, win, sessionStorage, canvasState } = harness();
		setScope(win, canvasState, REAL);
		canvasState.describeCache.Account = {
			fields: [
				{ name: 'Name', type: 'string' },
				{ name: 'Secret__c', type: 'encryptedstring' },
			],
		};
		const record = {
			id: 1,
			objectName: 'Account',
			values: { Name: 'Safe name', Secret__c: 'do not persist' },
			loadedValues: { Name: 'Original name', Secret__c: 'do not persist either' },
		};
		win.OrgLoom.encryptedFields.markIntent(record, 'Secret__c');
		canvasState.bulkRecords = [record];

		api.autosaveFlush();
		const storedKey = sessionStorage._dump().find((key) => key.indexOf('orgloom:canvas-draft:v1') === 0);
		const raw = sessionStorage.getItem(storedKey);
		assert.equal(raw.includes('do not persist'), false);
		const stored = JSON.parse(raw);
		assert.deepEqual(stored.state.bulkRecords[0].values, { Name: 'Safe name' });
		assert.deepEqual(stored.state.bulkRecords[0].loadedValues, { Name: 'Original name' });
		assert.deepEqual(stored.state.bulkRecords[0].encryptedFieldIntents, ['Secret__c']);

		canvasState.bulkRecords = [];
		assert.equal(api.autosaveRestore(), true);
		assert.deepEqual(Array.from(win.OrgLoom.encryptedFields.intentNames(canvasState.bulkRecords[0], canvasState)), [
			'Secret__c',
		]);
		assert.equal(canvasState.bulkRecords[0].values.Secret__c, undefined);
	});

	test('a same-org Salesforce user switch starts with a blank canvas', () => {
		const { api, win, canvasState } = harness();
		setScope(win, canvasState, REAL);
		canvasState.currentCanvas = {
			id: '069000000000001AAA',
			title: 'Shared intake',
			ownedByMe: true,
		};
		canvasState.bulkRecords = [{ id: 1, objectName: 'Account', values: { Name: 'Owner-only value' } }];
		api.orgSwitchStash({ intent: 'switch', hadUnsavedChanges: true });

		setScope(win, canvasState, { account: REAL.account, org: REAL.org, user: '005OTHER' });
		canvasState.bulkRecords = [];
		assert.equal(api.consumeUserSwitchCanvasId(), null);
		assert.equal(api.orgSwitchRestore(), true);
		assert.equal(canvasState.bulkRecords.length, 0);
	});

	test('an ordinary cross-org connection switch starts with a blank canvas', () => {
		const { api, win, canvasState } = harness();
		setScope(win, canvasState, REAL);
		canvasState.currentCanvas = {
			id: '069000000000001AAA',
			title: 'Source canvas',
			ownedByMe: true,
		};
		canvasState.bulkRecords = [
			{ id: 1, objectName: 'Account', loadedFromId: '001SOURCE', values: { Name: 'Source value' } },
		];
		api.orgSwitchStash({ intent: 'switch', preserveState: true });

		setScope(win, canvasState, { account: REAL.account, org: '00DOTHER', user: '005OTHER' });
		canvasState.bulkRecords = [];
		assert.equal(api.consumeUserSwitchCanvasId(), null);
		assert.equal(api.orgSwitchRestore(), true);
		assert.equal(canvasState.currentCanvas, null);
		assert.equal(canvasState.bulkRecords.length, 0);
	});

	test('an explicit migration handoff preserves and converts the source canvas', () => {
		const { api, win, canvasState } = harness();
		setScope(win, canvasState, REAL);
		canvasState.bulkRecords = [
			{
				id: 1,
				objectName: 'Account',
				loadedFromId: '001SOURCE',
				values: { Id: '001SOURCE', Name: 'Move me' },
			},
		];
		api.orgSwitchStash({ intent: 'migration', preserveState: true });

		setScope(win, canvasState, { account: REAL.account, org: '00DTARGET', user: '005TARGET' });
		canvasState.bulkRecords = [];
		assert.equal(api.orgSwitchRestore(), true);
		assert.equal(canvasState.bulkRecords.length, 1);
		assert.equal(canvasState.bulkRecords[0].loadedFromId, undefined);
		assert.equal(canvasState.bulkRecords[0].values.Id, undefined);
		assert.equal(canvasState.bulkRecords[0].values.Name, 'Move me');
	});

	test('reconnecting the same Salesforce user retains the normal handoff snapshot', () => {
		const { api, win, canvasState } = harness();
		setScope(win, canvasState, REAL);
		canvasState.currentCanvas = {
			id: '069000000000001AAA',
			title: 'My canvas',
			ownedByMe: true,
		};
		canvasState._presenceCanvasId = '069000000000001AAA';
		canvasState._presenceRevision = 7;
		canvasState.bulkRecords = [{ id: 1, objectName: 'Account', values: { Name: 'Unsaved value' } }];
		api.orgSwitchStash({ intent: 'reauth', hadUnsavedChanges: true });

		canvasState.bulkRecords = [];
		canvasState.currentCanvas = null;
		assert.equal(api.consumeUserSwitchCanvasId(), null);
		assert.equal(api.orgSwitchRestore(), true);
		assert.equal(canvasState.bulkRecords[0].values.Name, 'Unsaved value');
		assert.equal(canvasState.currentCanvas.id, '069000000000001AAA');
		assert.equal(canvasState._presenceCanvasId, '069000000000001AAA');
		assert.equal(canvasState._presenceRevision, 7);
		assert.equal(canvasState.currentCanvas.title, 'My canvas');
	});

	test('a reconnect that returns as another Salesforce identity starts blank', () => {
		const { api, win, canvasState } = harness();
		setScope(win, canvasState, REAL);
		canvasState.currentCanvas = {
			id: '069000000000001AAA',
			title: 'Original identity canvas',
			ownedByMe: true,
		};
		canvasState.bulkRecords = [{ id: 1, objectName: 'Account', values: { Name: 'Do not carry over' } }];
		api.orgSwitchStash({ intent: 'reauth', preserveState: true });

		setScope(win, canvasState, { account: REAL.account, org: REAL.org, user: '005OTHER' });
		canvasState.bulkRecords = [];
		assert.equal(api.consumeUserSwitchCanvasId(), null);
		assert.equal(api.orgSwitchRestore(), true);
		assert.equal(canvasState.currentCanvas, null);
		assert.equal(canvasState.bulkRecords.length, 0);
	});

	test('reconnect falls back to the last saved canvas when its full snapshot is unavailable', () => {
		const { api, win, sessionStorage, canvasState } = harness();
		setScope(win, canvasState, REAL);
		canvasState.currentCanvas = {
			id: '069000000000001AAA',
			title: 'My canvas',
			ownedByMe: true,
		};
		canvasState.bulkRecords = [{ id: 1, objectName: 'Account', values: { Name: 'Unsaved value' } }];
		api.orgSwitchStash({ intent: 'reauth', hadUnsavedChanges: true });

		const key = 'orgloom:org-switch-stash:v1';
		const payload = JSON.parse(sessionStorage.getItem(key));
		payload.state = null;
		sessionStorage.setItem(key, JSON.stringify(payload));
		canvasState.bulkRecords = [];
		canvasState.currentCanvas = null;

		assert.equal(api.consumeUserSwitchCanvasId(), '069000000000001AAA');
		assert.equal(api.consumeReauthFallbackCanvasId(), '069000000000001AAA');
		assert.equal(api.orgSwitchRestore(), false);
		assert.equal(canvasState.bulkRecords.length, 0);
	});

	test('continuing an intentional user switch without saving does not restore discarded changes', () => {
		const { api, win, canvasState } = harness();
		setScope(win, canvasState, REAL);
		canvasState.currentCanvas = {
			id: '069000000000001AAA',
			title: 'My canvas',
			ownedByMe: true,
		};
		canvasState.bulkRecords = [{ id: 1, objectName: 'Account', values: { Name: 'Discard me' } }];
		api.orgSwitchStash({
			intent: 'switch',
			preserveState: false,
			hadUnsavedChanges: true,
		});

		canvasState.bulkRecords = [];
		canvasState.currentCanvas = null;
		assert.equal(api.consumeUserSwitchCanvasId(), '069000000000001AAA');
		assert.equal(api.orgSwitchRestore(), false);
		assert.equal(canvasState.bulkRecords.length, 0);
	});

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

	test('refresh preserves the identity of an empty saved canvas', () => {
		const { api, win, canvasState } = harness();
		setScope(win, canvasState, REAL);
		canvasState.currentCanvas = {
			id: '069000000000008AAA',
			title: 'Empty planning canvas',
			ownedByMe: true,
		};
		api.autosaveFlush();

		canvasState.currentCanvas = null;
		assert.equal(api.autosaveRestore(), true);
		assert.equal(canvasState.currentCanvas.id, '069000000000008AAA');
		assert.equal(canvasState.currentCanvas.title, 'Empty planning canvas');
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
	test('migration strips collaboration requests and excludes unfinished request artifacts', () => {
		const h = harness();
		setScope(h.win, h.canvasState, REAL);
		h.canvasState.bulkRecords = [
			{ id: 1, objectName: 'Account', values: { Name: 'Ordinary record' } },
			{
				id: 2,
				objectName: 'Opportunity',
				values: {},
				slot: { slotId: 'unfinished', kind: 'whole-record', assigneeEmail: 'user@example.com' },
			},
			{
				id: 3,
				objectName: 'Opportunity',
				values: { Name: 'Completed request', AccountId: '001SOURCE' },
				slot: { slotId: 'completed', kind: 'whole-record', assigneeEmail: 'user@example.com' },
				_recipientSlot: true,
			},
			{
				id: 4,
				objectName: 'Contact',
				values: { LastName: 'Contributor value' },
				slot: { slotId: 'fields', kind: 'fields', fields: ['LastName'] },
				_recipientSlot: true,
			},
			{ id: 5, objectName: 'Account', _inaccessible: true },
		];
		h.canvasState.bulkAssociations = [
			{ id: 10, fromId: 4, toId: 1, fieldName: 'AccountId' },
			{ id: 11, fromId: 3, toId: 2, fieldName: 'AccountId' },
		];

		assert.deepEqual(JSON.parse(JSON.stringify(h.api.migrationPreparation())), {
			recordCount: 3,
			excludedRecordRequestCount: 1,
			removedRequestMetadataCount: 2,
			excludedArtifactCount: 1,
			excludedAssociationCount: 1,
		});
		assert.equal(h.api.migrationStash({ status: 'awaiting-target' }), true);

		const payload = JSON.parse(h.sessionStorage.getItem('orgloom:migration:v1'));
		assert.deepEqual(
			payload.state.bulkRecords.map((record) => record.id),
			[1, 3, 4],
		);
		assert.equal(
			payload.state.bulkRecords.some((record) => record.slot),
			false,
		);
		assert.equal(
			payload.state.bulkRecords.some((record) => record._recipientSlot),
			false,
		);
		assert.equal(
			payload.state.bulkRecords.find((record) => record.id === 3).values.AccountId,
			undefined,
			'lookup values pointing at excluded requests do not leak into the destination org',
		);
		assert.deepEqual(payload.state.bulkAssociations, [{ id: 10, fromId: 4, toId: 1, fieldName: 'AccountId' }]);
		assert.equal(h.canvasState.bulkRecords[2].slot.slotId, 'completed', 'source canvas remains unchanged');
		assert.equal(h.canvasState.bulkRecords[2].values.AccountId, '001SOURCE', 'source lookup remains unchanged');
		assert.equal(h.canvasState.bulkRecords[3].slot.slotId, 'fields', 'field request remains on source');
	});

	test('migration does not start when the canvas contains only unfinished record requests', () => {
		const h = harness();
		setScope(h.win, h.canvasState, REAL);
		h.canvasState.bulkRecords = [
			{
				id: 1,
				objectName: 'Account',
				values: {},
				slot: { slotId: 'unfinished', kind: 'whole-record' },
			},
		];

		assert.equal(h.api.migrationPreparation().recordCount, 0);
		assert.equal(h.api.migrationStash({ status: 'awaiting-target' }), false);
		assert.equal(h.sessionStorage.getItem('orgloom:migration:v1'), null);
	});

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
