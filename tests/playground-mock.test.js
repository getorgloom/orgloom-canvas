// Playground mock-layer tests. Loads mock-data.js + mock-sf.js (browser
// IIFEs) in a VM sandbox and drives the installed fetch interceptor the
// way the canvas would. Locks the three properties the demo's safety
// story rests on:
//
//   1. INTERCEPTION POLICY: same-origin /api/* is default-blocked: every
//      unmatched call gets a local 501, and the REAL fetch is never
//      invoked (a demo page must never fire authenticated app calls; a
//      signed-in visitor's stale session cookie would ride along).
//   2. DATASET INTEGRITY: describes and records agree: every reference
//      field targets an object that exists in the dataset, every seeded
//      record's object has a describe, seeded FK values point at records
//      that exist.
//   3. CORE FLOWS round-trip through the mock: canvas save/list/get and
//      an upload happy path return production-shaped responses.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ORIGIN = 'https://demo.orgloom.test';

let W; // sandbox window
let realFetchCalls; // URLs the interceptor passed through to "real" fetch

function makeStorage() {
	const map = new Map();
	return {
		getItem: (k) => (map.has(k) ? map.get(k) : null),
		setItem: (k, v) => map.set(k, String(v)),
		removeItem: (k) => map.delete(k),
		clear: () => map.clear(),
	};
}

before(() => {
	realFetchCalls = [];
	const windowShim = {
		ORGLOOM_MOCK: true,
		location: { origin: ORIGIN },
		localStorage: makeStorage(),
		sessionStorage: makeStorage(),
		SF_ORG_ID: '00DDEMO000000000AAA',
		SF_USER_ID: '005DEMO000000000AAA',
	};
	// The pre-existing "real" fetch the interceptor wraps. Recording stub:
	// the whole point is asserting it is (or isn't) reached.
	windowShim.fetch = (input) => {
		realFetchCalls.push(typeof input === 'string' ? input : input.url);
		return Promise.resolve(new Response('{}', { status: 200 }));
	};
	const sandbox = {
		window: windowShim,
		document: { addEventListener() {}, getElementById() {
 return null; 
} },
		console: { log() {}, warn() {}, error() {} },
		URL, Response, Request, Headers,
		JSON, Math, Date,
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

// Drive the interceptor like the canvas would.
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
			['POST', '/api/records/refresh'],
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

describe('dataset integrity: describes vs records', () => {
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
					// Reference targets must be resolvable inside the demo:
					// User is the only allowed external (owner fields).
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
					assert.ok(
						allIds.has(v),
						obj + ' ' + rec.Id + ' field ' + f.name + ' → dangling id ' + v,
					);
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
});
