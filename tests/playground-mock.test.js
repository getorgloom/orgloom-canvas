import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ORIGIN = 'https://demo.orgloom.test';
const toolbarSource = readFileSync(new URL('../src/public/js/bulk-toolbar.js', import.meta.url), 'utf8');
const indexSource = readFileSync(new URL('../src/views/index.ejs', import.meta.url), 'utf8');

let W; // sandbox window
let realFetchCalls; // URLs the interceptor passed through to "real" fetch

function makeStorage() {
	const map = new Map();
	return {
		getItem: (k) => (map.has(k) ? map.get(k) : null),
		setItem: (k, v) => map.set(k, String(v)),
		removeItem: (k) => map.delete(k),
		clear: () => map.clear(),
		key: (index) => Array.from(map.keys())[index] || null,
		get length() {
			return map.size;
		},
	};
}

before(() => {
	realFetchCalls = [];
	const playgroundStorage = makeStorage();
	playgroundStorage.setItem('orgloom.playground.datasetVersion', '1');
	playgroundStorage.setItem('orgloom.playground.canvases', JSON.stringify({ stale: true }));
	const windowShim = {
		ORGLOOM_MOCK: true,
		location: { origin: ORIGIN },
		localStorage: playgroundStorage,
		sessionStorage: makeStorage(),
		SF_ORG_ID: '00DDEMO00000000AAA',
		SF_USER_ID: '005DEMO00000000AAA',
	};
	windowShim.fetch = (input) => {
		realFetchCalls.push(typeof input === 'string' ? input : input.url);
		return Promise.resolve(new Response('{}', { status: 200 }));
	};
	const sandbox = {
		window: windowShim,
		document: {
			addEventListener() {},
			getElementById() {
				return null;
			},
		},
		console: { log() {}, warn() {}, error() {} },
		URL,
		URLSearchParams,
		Response,
		Request,
		Headers,
		JSON,
		Math,
		Date,
		localStorage: windowShim.localStorage,
		sessionStorage: windowShim.sessionStorage,
	};
	vm.createContext(sandbox);
	vm.runInContext(readFileSync(new URL('../src/public/js/mock-data.js', import.meta.url), 'utf8'), sandbox);
	vm.runInContext(readFileSync(new URL('../src/public/js/mock-sf.js', import.meta.url), 'utf8'), sandbox);
	W = windowShim;
	assert.ok(W.OrgLoomMock, 'mock dataset loaded');
	assert.equal(W.fetch.name, 'mockFetch', 'fetch interceptor installed');
});

test('reset=1 clears playground state without touching real canvas drafts', () => {
	const local = makeStorage();
	const session = makeStorage();
	const localCanvasId = '069LOCAL0000000AAA';
	const demoIdentity = 'playground:00DDEMO00000000AAA:005DEMO00000000AAA';
	const demoDraftKey = 'orgloom:canvas-draft:v1|' + demoIdentity + ':new';
	const realDraftKey = 'orgloom:canvas-draft:v1|real-account:00DREAL:005REAL:new';
	local.setItem('orgloom.playground.datasetVersion', '3');
	local.setItem('orgloom.playground.canvases', JSON.stringify({ [localCanvasId]: { id: localCanvasId } }));
	local.setItem('orgloom.playground.records', '{"Account":[]}');
	local.setItem('orgloom.real.preference', 'keep');
	session.setItem(demoDraftKey, '{"state":{}}');
	session.setItem('orgloom:canvas-draft-active:v1|' + demoIdentity, demoDraftKey);
	session.setItem('orgloom:draftValues:' + localCanvasId, '{"1":{"Name":"Demo edit"}}');
	session.setItem(realDraftKey, '{"state":{"bulkRecords":[{"id":1}]}}');

	let replacedUrl = '';
	const windowShim = {
		ORGLOOM_MOCK: true,
		location: {
			origin: ORIGIN,
			search: '?reset=1',
			href: ORIGIN + '/playground?reset=1',
		},
		history: {
			replaceState(_state, _title, url) {
				replacedUrl = url;
			},
		},
		localStorage: local,
		sessionStorage: session,
		fetch: () => Promise.resolve(new Response('{}', { status: 200 })),
	};
	const sandbox = {
		window: windowShim,
		document: { addEventListener() {}, getElementById() {} },
		console: { log() {}, warn() {}, error() {} },
		URL,
		URLSearchParams,
		Response,
		Request,
		Headers,
		JSON,
		Math,
		Date,
		Set,
	};
	vm.createContext(sandbox);
	vm.runInContext(readFileSync(new URL('../src/public/js/mock-data.js', import.meta.url), 'utf8'), sandbox);
	vm.runInContext(readFileSync(new URL('../src/public/js/mock-sf.js', import.meta.url), 'utf8'), sandbox);

	assert.equal(local.getItem('orgloom.playground.records'), null);
	assert.equal(local.getItem('orgloom.playground.datasetVersion'), '3');
	assert.equal(local.getItem('orgloom.real.preference'), 'keep');
	assert.equal(session.getItem(demoDraftKey), null);
	assert.equal(session.getItem('orgloom:draftValues:' + localCanvasId), null);
	assert.ok(session.getItem(realDraftKey));
	assert.equal(replacedUrl, '/playground');
});

test('Reset demo appears in the action strip immediately before Share', () => {
	assert.match(toolbarSource, /window\.ORGLOOM_MOCK[\s\S]*data-playground-reset[\s\S]*Reset demo/);
	assert.match(toolbarSource, /playgroundResetBtn \+[\s\S]*shareBtn \+/);
	assert.doesNotMatch(indexSource, /app-playground-banner-reset/);
});

async function call(method, path, body) {
	const res = await W.fetch(ORIGIN + path, {
		method,
		headers: { 'Content-Type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	let json = null;
	try {
		json = await res.json();
	} catch (_) {}
	return { status: res.status, body: json };
}

describe('interception policy: default-block for /api/*', () => {
	test('unmatched /api/* returns a local 501, never the real fetch', async () => {
		const beforeCount = realFetchCalls.length;
		const paths = [
			['POST', '/api/mcp-tokens'],
			['GET', '/api/activity/workspace'],
			['POST', '/api/workspaces'],
			['DELETE', '/api/connections/abc'],
			['GET', '/api/made-up-endpoint'],
		];
		for (const [m, p] of paths) {
			const r = await call(m, p);
			assert.equal(r.status, 501, m + ' ' + p + ' → 501, got ' + r.status);
		}
		assert.equal(realFetchCalls.length, beforeCount, 'real fetch untouched by /api/* misses');
	});

	test('cross-origin and non-/api requests pass through to the real fetch', async () => {
		const beforeCount = realFetchCalls.length;
		await W.fetch('https://analytics.example.com/capture', { method: 'POST' });
		await W.fetch(ORIGIN + '/docs/walkthroughs/recall-upload');
		assert.equal(realFetchCalls.length, beforeCount + 2, 'both passed through');
	});
});

describe('playground feature access', () => {
	test('Auto-fill, Bulk edit, and Run script pass their live permission checks', async () => {
		for (const capability of ['auto-fill-records', 'bulk-edit-records', 'run-script']) {
			const result = await call('POST', '/api/capabilities/' + capability + '/check');
			assert.equal(result.status, 200, capability);
			assert.equal(result.body.ok, true, capability);
		}
	});

	test('demo upload passes the final access check', async () => {
		const result = await call('POST', '/api/upload/access-check', { canvasId: '069PRESEED000000AAA' });
		assert.equal(result.status, 200);
		assert.equal(result.body.ok, true);
	});
});

describe('dataset integrity: describes vs records', () => {
	test('a dataset update removes stale playground-local fixtures', () => {
		assert.equal(W.localStorage.getItem('orgloom.playground.datasetVersion'), '3');
		assert.equal(W.localStorage.getItem('orgloom.playground.canvases'), null);
	});

	test('playground identities and owner fields use valid Salesforce ID lengths', () => {
		const sfIdPattern = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;
		assert.match(W.OrgLoomMock.demoOrgId, sfIdPattern);
		assert.match(W.OrgLoomMock.demoUserId, sfIdPattern);
		for (const records of Object.values(W.OrgLoomMock.records)) {
			for (const record of records) {
				if (record.OwnerId) {
					assert.match(record.OwnerId, sfIdPattern, record.Id + ' has an invalid OwnerId');
				}
			}
		}
	});

	test('public fixtures use clearly fictional brands and reserved contact details', () => {
		const serialized = JSON.stringify(W.OrgLoomMock.records);
		for (const recognizableName of [
			'Stark Industries',
			'Wayne Manufacturing',
			'Wonka',
			'Dunder Mifflin',
			'Gringotts',
			'Weyland-Yutani',
		]) {
			assert.doesNotMatch(serialized, new RegExp(recognizableName, 'i'));
		}
		assert.ok(W.OrgLoomMock.records.Account.every((record) => /\(Demo\)$/.test(record.Name)));
		assert.ok(W.OrgLoomMock.records.User.every((record) => /@example\.com$/.test(record.Email)));
		assert.ok(W.OrgLoomMock.records.Contact.every((record) => /\.example\.com$/.test(record.Email)));
	});

	test('owner fields match writable Salesforce describe metadata', async () => {
		const ownerableObjects = [
			'Account',
			'Contact',
			'Opportunity',
			'Lead',
			'Case',
			'Task',
			'Event',
			'Campaign',
			'Contract',
			'Order',
		];
		for (const objectName of ownerableObjects) {
			const response = await call('GET', '/api/objects/' + objectName + '/describe');
			const ownerField = response.body.fields.find((field) => field.name === 'OwnerId');
			assert.ok(ownerField, objectName + ' exposes OwnerId');
			assert.equal(ownerField.createable, true, objectName + '.OwnerId is createable');
			assert.equal(ownerField.updateable, true, objectName + '.OwnerId is updateable');
		}
	});

	test('every seeded record type has a describe; every describe FK targets a dataset object', async () => {
		const MOCK = W.OrgLoomMock;
		const objectNames = new Set(Object.keys(MOCK.records));
		for (const objName of objectNames) {
			const d = await call('GET', '/api/objects/' + objName + '/describe');
			assert.equal(d.status, 200, 'describe for ' + objName);
			assert.ok(Array.isArray(d.body.fields) && d.body.fields.length > 0, objName + ' has fields');
			for (const f of d.body.fields) {
				if (f.type !== 'reference' || !Array.isArray(f.referenceTo)) {
					continue;
				}
				for (const target of f.referenceTo) {
					assert.ok(
						objectNames.has(target) || target === 'User',
						objName + '.' + f.name + ' references ' + target + ' which is not in the dataset',
					);
				}
			}
		}
	});

	test('seeded FK values point at records that exist', async () => {
		const MOCK = W.OrgLoomMock;
		const idsByObject = new Map();
		for (const [obj, recs] of Object.entries(MOCK.records)) {
			idsByObject.set(obj, new Set(recs.map((r) => r.Id)));
		}
		const allIds = new Set([...idsByObject.values()].flatMap((s) => [...s]));
		for (const [obj, recs] of Object.entries(MOCK.records)) {
			const d = await call('GET', '/api/objects/' + obj + '/describe');
			const refFields = d.body.fields.filter((f) => f.type === 'reference');
			for (const rec of recs) {
				for (const f of refFields) {
					const v = rec[f.name];
					if (!v) {
						continue;
					}
					const refersToUser = (f.referenceTo || []).includes('User');
					if (refersToUser && String(v).startsWith('005')) {
						continue; // demo user ids are synthesized, not in records
					}
					assert.ok(allIds.has(v), obj + ' ' + rec.Id + ' field ' + f.name + ' → dangling id ' + v);
				}
			}
		}
	});

	test('single-record fetch round-trips a seeded record', async () => {
		const MOCK = W.OrgLoomMock;
		const [obj, recs] = Object.entries(MOCK.records)[0];
		const seed = recs[0];
		const r = await call('GET', '/api/objects/' + obj + '/records/' + seed.Id);
		assert.equal(r.status, 200);
		assert.equal(r.body.Id, seed.Id);
	});
});

describe('core flows round-trip through the mock', () => {
	test('refresh returns current demo values using the production response contract', async () => {
		const seed = W.OrgLoomMock.records.Account[0];
		const result = await call('POST', '/api/records/refresh', {
			records: [{ objectName: 'Account', sfId: seed.Id }],
		});
		assert.equal(result.status, 200);
		assert.equal(result.body.results.length, 1);
		assert.equal(result.body.results[0].objectName, 'Account');
		assert.equal(result.body.results[0].sfId, seed.Id);
		assert.equal(result.body.results[0].ok, true);
		assert.equal(JSON.stringify(result.body.results[0].values), JSON.stringify(seed));
	});

	test('refresh reports missing and malformed demo records without failing the batch', async () => {
		const result = await call('POST', '/api/records/refresh', {
			records: [
				{ objectName: 'Account', sfId: '001999999999999AAA' },
				{ objectName: 'Account', sfId: 'bad-id' },
				{ objectName: '!bad!', sfId: '001000000000001AAA' },
			],
		});
		assert.equal(result.status, 200);
		assert.deepEqual(
			result.body.results.map((row) => row.error),
			['not-found', 'invalid-id', 'invalid-object'],
		);
	});

	test('refresh reads the latest playground overlay after an existing record is updated', async () => {
		const seed = W.OrgLoomMock.records.Account[0];
		const updatedName = 'Updated in the demo org';
		const upload = await call('POST', '/api/upload', {
			records: [
				{
					tempId: 'refresh-update',
					objectName: 'Account',
					loadedFromId: seed.Id,
					values: { ...seed, Name: updatedName },
				},
			],
			associations: [],
		});
		assert.equal(upload.status, 200);
		assert.equal(upload.body.results[0].mode, 'update');

		const result = await call('POST', '/api/records/refresh', {
			records: [{ objectName: 'Account', sfId: seed.Id }],
		});
		assert.equal(result.status, 200);
		assert.equal(result.body.results[0].ok, true);
		assert.equal(result.body.results[0].values.Name, updatedName);
		W.localStorage.removeItem('orgloom.playground.records');
	});

	test('the preset SOQL query resolves its outer Account FROM and returns linked contacts', async () => {
		const preset =
			'SELECT Id, Name, Industry, Phone, Type,\n' +
			'       (SELECT Id, FirstName, LastName, Email, Title FROM Contacts)\n' +
			'FROM Account\n' +
			"WHERE Industry = 'Technology'\n" +
			'LIMIT 5';
		const result = await call('POST', '/api/query', { soql: preset, fullFields: true });
		assert.equal(result.status, 200);
		assert.equal(result.body.objectName, 'Account');
		assert.equal(result.body.totalSize, 5);
		assert.equal(result.body.records.filter((record) => record.objectName === 'Account').length, 5);
		assert.ok(result.body.records.some((record) => record.objectName === 'Contact'));
		assert.ok(result.body.associations.length > 0);
	});

	test('canvas save → list → get → delete (localStorage-backed)', async () => {
		const save = await call('POST', '/api/canvas', {
			name: 'demo canvas',
			payload: { drafts: [{ tempId: 1, objectName: 'Account', values: { Name: 'X' } }], loadedRecords: [] },
		});
		assert.ok(save.status === 200 || save.status === 201, 'save ok, got ' + save.status);
		assert.ok(save.body.id, 'save returns an id');

		const list = await call('GET', '/api/canvas');
		const items = list.body.items || list.body || [];
		assert.ok(
			(Array.isArray(items) ? items : []).some((i) => i.id === save.body.id),
			'saved canvas appears in list',
		);

		const got = await call('GET', '/api/canvas/' + save.body.id);
		assert.equal(got.status, 200);
		assert.equal(got.body.payload.drafts[0].values.Name, 'X', 'payload round-trips');

		const del = await call('DELETE', '/api/canvas/' + save.body.id);
		assert.ok(del.status === 200 || del.status === 204);
	});

	test('upload happy path returns production-shaped per-record results', async () => {
		const r = await call('POST', '/api/upload', {
			records: [{ tempId: 7, objectName: 'Account', values: { Name: 'Demo Upload Co' } }],
			associations: [],
		});
		assert.equal(r.status, 200);
		assert.ok(Array.isArray(r.body.results), 'results array');
		const row = r.body.results[0];
		assert.equal(row.tempId, 7);
		assert.equal(row.success, true);
		assert.ok(row.id, 'assigned an id');
		assert.ok(row.mode === 'create' || row.mode === 'created', 'mode present');
	});

	test('mixed graph upload skips unchanged loaded records and records only actual writes', async () => {
		const account = W.OrgLoomMock.records.Account[0];
		const contact = W.OrgLoomMock.records.Contact.find((record) => record.AccountId === account.Id);
		const existingAsset = W.OrgLoomMock.records.Asset[0];
		const body = {
			records: [
				{
					tempId: 'unchanged-account',
					objectName: 'Account',
					loadedFromId: account.Id,
					values: account,
				},
				{
					tempId: 'draft-asset',
					objectName: 'Asset',
					values: { Name: 'Demo draft asset', AccountId: account.Id, Status: 'Installed' },
				},
				{
					tempId: 'modified-asset',
					objectName: 'Asset',
					loadedFromId: existingAsset.Id,
					values: { ...existingAsset, Description: 'Modified on canvas' },
				},
				{
					tempId: 'unchanged-contact',
					objectName: 'Contact',
					loadedFromId: contact.Id,
					values: contact,
				},
			],
			associations: [],
			skipTempIds: ['unchanged-account', 'unchanged-contact'],
		};
		const result = await call('POST', '/api/upload/graph', body);
		assert.equal(result.status, 200);
		assert.equal(result.body.atomicSuccess, true);
		assert.deepEqual(
			result.body.results.map((row) => [row.tempId, row.mode]),
			[
				['unchanged-account', 'unchanged'],
				['draft-asset', 'create'],
				['modified-asset', 'update'],
				['unchanged-contact', 'unchanged'],
			],
		);

		const batch = await call('GET', '/api/upload-batches/' + result.body.batchId);
		assert.equal(batch.status, 200);
		assert.equal(batch.body.batch.recordCount, 2);
		assert.deepEqual(
			batch.body.batch.insertedIds.map((row) => row.tempId),
			['draft-asset', 'modified-asset'],
		);
		W.localStorage.removeItem('orgloom.playground.records');
	});
});
