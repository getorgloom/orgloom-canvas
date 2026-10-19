import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/public/js/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function ensureDescribe(name, options)');
const end = source.indexOf('function enterMigrateMode', start);
assert.ok(start >= 0 && end > start);

function setup() {
	const state = { describeCache: {}, describeRequests: {} };
	const requests = [];
	const storage = new Map();
	const ensureDescribe = vm.runInNewContext(source.slice(start, end) + '\nensureDescribe;', {
		canvasState: state,
		csrfFetch: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
		sessionStorage: { removeItem: (key) => storage.delete(key) },
		_describeStorageKey: (name) => name,
		_loadDescribeFromStorage: (name) => storage.get(name),
		_saveDescribeToStorage: (name, describe) => storage.set(name, describe),
	});
	return { state, requests, storage, ensureDescribe };
}

const complete = (request, describe) => request.resolve({ ok: true, json: async () => describe });
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('queued schema refresh cannot erase permissions between menu load and permission check', async () => {
	const { state, requests, ensureDescribe } = setup();
	const first = ensureDescribe('Contact');
	// Import and menu load share metadata; another panel forces a refresh while it loads.
	const refresh = ensureDescribe('Contact', { force: true });
	const menu = first
		.then(() => settle())
		.then(() => {
			assert.equal(state.describeCache.Contact.deletable, true);
		});
	complete(requests[0], { deletable: true, fields: [] });
	await menu;
	assert.equal(requests.length, 2);
	// New async consumers must wait for refreshed permissions, not receive the old cache.
	let resolved = false;
	const later = ensureDescribe('Contact').then((describe) => {
		resolved = true;
		return describe;
	});
	await settle();
	assert.equal(resolved, false);
	complete(requests[1], { deletable: false, fields: [] });
	assert.equal((await refresh).deletable, false);
	assert.equal((await later).deletable, false);
	assert.equal(state.describeCache.Contact.deletable, false);
});

test('failed forced refresh discards stale permissions and allows a fresh retry', async () => {
	const { state, requests, storage, ensureDescribe } = setup();
	state.describeCache.Contact = { deletable: true };
	storage.set('Contact', state.describeCache.Contact);
	const refresh = ensureDescribe('Contact', { force: true });
	assert.equal(state.describeCache.Contact.deletable, true);
	assert.equal(storage.has('Contact'), false);
	requests[0].reject(new Error('Metadata unavailable'));
	await assert.rejects(refresh, /Metadata unavailable/);
	assert.equal(state.describeCache.Contact, undefined);
	assert.equal(state.describeRequests.Contact, undefined);
	const retry = ensureDescribe('Contact');
	complete(requests[1], { deletable: false });
	assert.equal((await retry).deletable, false);
});
