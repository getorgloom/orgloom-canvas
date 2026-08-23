import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/public/js/canvas-marquee.js', import.meta.url), 'utf8');

function mount(records, describeCache, ensureDescribe) {
	const window = { OrgLoom: {} };
	vm.runInNewContext(source, { window, document: {}, Set, Map, Math, Number, Object, Array });
	const canvasState = {
		bulkRecords: records,
		bulkAssociations: [],
		bulkSelectedIds: new Set(records.map((record) => record.id)),
		bulkSelectedEdgeId: null,
		bulkClipboard: null,
		bulkIdSeq: 100,
		describeCache,
	};
	const api = window.OrgLoom.canvasMarquee.mount({
		canvasState,
		getGraph: () => ({ querySelector: () => ({ clientHeight: 800 }) }),
		clientToCanvasCoords: () => ({ x: 0, y: 0 }),
		renderBulkView: () => {},
		_canvasCapBlockReason: () => null,
		showBulkToast: () => {},
		showPromptModal: async () => null,
		ensureDescribe:
			ensureDescribe ||
			(async (objectName) => canvasState.describeCache && canvasState.describeCache[objectName]),
	});
	return { api, canvasState };
}

test('pasting a loaded record keeps only fields Salesforce permits on create', async () => {
	const original = {
		id: 1,
		objectName: 'Account',
		label: 'Account',
		x: 100,
		y: 100,
		loadedFromId: '001000000000001AAA',
		values: {
			Id: '001000000000001AAA',
			Name: 'Cloned account',
			OwnerId: '005000000000001AAA',
			RecordTypeId: '012000000000001AAA',
			CreatedDate: '2026-08-22T00:00:00.000Z',
			Formula__c: 'calculated',
			Auto_Number__c: 'AUTO-1',
			BillingAddress: { city: 'Phoenix' },
			_internalState: 'canvas-only',
		},
	};
	const { api, canvasState } = mount([original], {
		Account: {
			fields: [
				{ name: 'Id', type: 'id', createable: false },
				{ name: 'Name', type: 'string', createable: true },
				{ name: 'OwnerId', type: 'reference', createable: true },
				{ name: 'RecordTypeId', type: 'reference', createable: true },
				{ name: 'CreatedDate', type: 'datetime', createable: false },
				{ name: 'Formula__c', type: 'string', createable: true, calculated: true },
				{ name: 'Auto_Number__c', type: 'string', createable: true, autoNumber: true },
				{ name: 'BillingAddress', type: 'address', createable: true },
			],
		},
	});

	assert.equal(api.copySelectionToClipboard(), true);
	await api.pasteFromClipboard(1);

	const clone = canvasState.bulkRecords.find((record) => record.id === 100);
	assert.ok(clone);
	assert.equal(clone.loadedFromId, undefined);
	assert.deepEqual(JSON.parse(JSON.stringify(clone.values)), {
		Name: 'Cloned account',
		OwnerId: '005000000000001AAA',
		RecordTypeId: '012000000000001AAA',
	});
});

test('pasting loads missing metadata before selecting createable fields', async () => {
	const original = {
		id: 1,
		objectName: 'Account',
		label: 'Account',
		x: 100,
		y: 100,
		values: {
			Id: '001000000000001AAA',
			Name: 'Cloned account',
			CreatedDate: '2026-08-22T00:00:00.000Z',
			attributes: { type: 'Account' },
			_internalState: true,
		},
	};
	let describeCalls = 0;
	const { api, canvasState } = mount([original], {}, async () => {
		describeCalls++;
		return {
			fields: [
				{ name: 'Id', type: 'id', createable: false },
				{ name: 'Name', type: 'string', createable: true },
				{ name: 'CreatedDate', type: 'datetime', createable: false },
			],
		};
	});

	api.copySelectionToClipboard();
	await api.pasteFromClipboard(1);

	const clone = canvasState.bulkRecords.find((record) => record.id === 100);
	assert.equal(describeCalls, 1);
	assert.deepEqual(JSON.parse(JSON.stringify(clone.values)), { Name: 'Cloned account' });
});
