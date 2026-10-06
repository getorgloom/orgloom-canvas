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
	const undo = [];
	const api = window.OrgLoom.canvasMarquee.mount({
		canvasState,
		getGraph: () => ({ querySelector: () => ({ clientHeight: 800 }) }),
		clientToCanvasCoords: () => ({ x: 0, y: 0 }),
		renderBulkView: () => {},
		_canvasCapBlockReason: () => null,
		showBulkToast: () => {},
		showPromptModal: async () => null,
		pushUndo: (_label, action) => undo.push(action),
		ensureDescribe:
			ensureDescribe ||
			(async (objectName) => canvasState.describeCache && canvasState.describeCache[objectName]),
	});
	return { api, canvasState, undo };
}

function linkedRecords() {
	const accountId = '001000000000001AAA';
	const records = [
		{ id: 1, objectName: 'Account', x: 0, y: 0, loadedFromId: accountId, values: { Name: 'Parent' } },
		{
			id: 2,
			objectName: 'Contact',
			x: 300,
			y: 0,
			loadedFromId: '003000000000001AAA',
			values: { LastName: 'Child', AccountId: accountId, OwnerId: '005000000000001AAA' },
		},
	];
	const harness = mount(records, {
		Account: { fields: [{ name: 'Name', createable: true }] },
		Contact: {
			fields: [
				{ name: 'LastName', createable: true },
				{ name: 'AccountId', type: 'reference', createable: true },
				{ name: 'OwnerId', type: 'reference', createable: true },
			],
		},
	});
	harness.canvasState.bulkAssociations.push({ id: 3, fromId: 2, toId: 1, fieldName: 'AccountId' });
	return harness;
}

test('copying a Contact and its Account replaces the original lookup with the copied draft link', async () => {
	const { api, canvasState, undo } = linkedRecords();
	const original = JSON.stringify({ records: canvasState.bulkRecords, links: canvasState.bulkAssociations });
	api.copySelectionToClipboard();
	const clipboard = JSON.stringify(canvasState.bulkClipboard);
	await api.pasteFromClipboard(1);
	const clones = canvasState.bulkRecords.slice(2);
	const contact = clones.find((record) => record.objectName === 'Contact');
	const account = clones.find((record) => record.objectName === 'Account');
	assert.equal(Object.hasOwn(contact.values, 'AccountId'), false);
	assert.equal(contact.values.OwnerId, '005000000000001AAA');
	assert.equal(contact.loadedFromId, undefined);
	assert.equal(account.loadedFromId, undefined);
	const links = canvasState.bulkAssociations.filter((link) => link.fromId === contact.id);
	assert.equal(links.length, 1);
	assert.equal(links[0].toId, account.id);
	assert.equal(links[0].fieldName, 'AccountId');
	assert.equal(JSON.stringify(canvasState.bulkClipboard), clipboard);
	undo[0]();
	assert.equal(JSON.stringify({ records: canvasState.bulkRecords, links: canvasState.bulkAssociations }), original);
});

test('copying only the Contact keeps its existing Account lookup', async () => {
	const { api, canvasState } = linkedRecords();
	canvasState.bulkSelectedIds = new Set([2]);
	api.copySelectionToClipboard();
	await api.pasteFromClipboard(1);
	const contact = canvasState.bulkRecords.at(-1);
	assert.equal(contact.values.AccountId, '001000000000001AAA');
	assert.equal(canvasState.bulkAssociations.length, 1);
});

test('multiple copies and repeated paste keep each Contact linked to its own draft Account', async () => {
	const { api, canvasState } = linkedRecords();
	api.copySelectionToClipboard();
	await api.pasteFromClipboard(3);
	await api.pasteFromClipboard(1);
	const clones = canvasState.bulkRecords.slice(2);
	const targetIds = new Set();
	for (let i = 0; i < clones.length; i += 2) {
		const [account, contact] = clones.slice(i, i + 2);
		assert.equal(Object.hasOwn(contact.values, 'AccountId'), false);
		const links = canvasState.bulkAssociations.filter((link) => link.fromId === contact.id);
		assert.equal(links.length, 1);
		assert.equal(links[0].toId, account.id);
		targetIds.add(links[0].toId);
	}
	assert.equal(targetIds.size, 4);
});

test('copied custom lookup links also remove the old ID even when field casing differs', async () => {
	const { api, canvasState } = linkedRecords();
	canvasState.describeCache.Contact.fields.push({ name: 'Parent__c', type: 'reference', createable: true });
	canvasState.bulkRecords[1].values.Parent__c = '001000000000001AAA';
	canvasState.bulkAssociations.push({ id: 4, fromId: 2, toId: 1, fieldName: 'parent__c' });
	api.copySelectionToClipboard();
	await api.pasteFromClipboard(1);
	const contact = canvasState.bulkRecords.at(-1);
	assert.equal(Object.hasOwn(contact.values, 'Parent__c'), false);
	assert.equal(canvasState.bulkAssociations.filter((link) => link.fromId === contact.id).length, 2);
});

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
