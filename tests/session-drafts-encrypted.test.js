import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function storage() {
	const entries = new Map();
	return {
		getItem: (key) => (entries.has(key) ? entries.get(key) : null),
		setItem: (key, value) => entries.set(key, String(value)),
		removeItem: (key) => entries.delete(key),
	};
}

function harness() {
	const sessionStorage = storage();
	const window = { OrgLoom: {}, sessionStorage };
	const context = vm.createContext({ window, console });
	vm.runInContext(readFileSync(new URL('../src/public/js/encrypted-fields.js', import.meta.url), 'utf8'), context);
	vm.runInContext(readFileSync(new URL('../src/public/js/session-drafts.js', import.meta.url), 'utf8'), context);
	const canvasState = {
		bulkRecords: [],
		describeCache: {
			Account: {
				fields: [
					{ name: 'Name', type: 'string' },
					{ name: 'Secret__c', type: 'encryptedstring' },
				],
			},
		},
	};
	const api = window.OrgLoom.sessionDrafts.mount({
		canvasState,
		encryptedFields: window.OrgLoom.encryptedFields,
	});
	return { api, canvasState, sessionStorage };
}

test('session draft recovery neither writes nor restores encrypted field values', () => {
	const { api, canvasState, sessionStorage } = harness();
	canvasState.bulkRecords = [
		{ id: 4, objectName: 'Account', values: { Name: 'Safe', Secret__c: 'never store this' } },
	];
	api.persistDraftValues('canvas-1');
	const raw = sessionStorage.getItem('orgloom:draftValues:canvas-1');
	assert.equal(raw.includes('never store this'), false);
	assert.deepEqual(JSON.parse(raw), { 4: { Name: 'Safe' } });

	sessionStorage.setItem(
		'orgloom:draftValues:canvas-1',
		JSON.stringify({ 4: { Name: 'Restored', Secret__c: 'legacy leaked value' } }),
	);
	canvasState.bulkRecords[0].values = {};
	assert.equal(api.rehydrateDraftValues('canvas-1'), 1);
	assert.deepEqual(JSON.parse(JSON.stringify(canvasState.bulkRecords[0].values)), { Name: 'Restored' });
});
