import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/public/js/templates.js', import.meta.url), 'utf8');
const encryptedFieldsSource = readFileSync(new URL('../src/public/js/encrypted-fields.js', import.meta.url), 'utf8');

function mountTemplates(ensureDescribe) {
	const canvasState = {
		selectedObjects: [{ id: 1, name: 'Opportunity', label: 'Opportunity' }],
		selectedIdSeq: 2,
		activeIndex: 0,
		hiddenObjects: new Set(),
		currentCanvas: { id: '069000000000001AAA', ownedByMe: true },
		bulkRecords: [
			{
				id: 1,
				objectName: 'Opportunity',
				label: 'Opportunity',
				x: 10,
				y: 20,
				values: {},
				slot: { slotId: 1, kind: 'whole-record', label: 'New opportunity' },
			},
		],
		bulkAssociations: [],
		bulkIdSeq: 2,
		bulkSelectedIds: new Set(),
		_prefetchedTypeNodeKeys: new Set(),
		_renderedRecIds: new Set(),
		describeCache: {},
	};
	const window = {
		OrgLoom: {
			importShared: {
				admitAssociation: () => true,
				skipSuffix: () => '',
			},
		},
	};
	vm.runInNewContext(encryptedFieldsSource, { window, Set, Map, Array, Object, String });
	vm.runInNewContext(source, {
		window,
		localStorage: { removeItem() {} },
		console,
		Set,
		Map,
		Promise,
		Date,
	});
	let slotIdSeq = 2;
	const api = window.OrgLoom.templates.mount({
		canvasState,
		showBulkToast() {},
		escapeHtml: String,
		csrfFetch: async () => ({ ok: true, json: async () => ({}) }),
		ensureDescribe,
		addToSelection: async () => null,
		setGraphView() {},
		renderAll() {},
		showReplaceOrMergeDialog() {},
		pingAuditEvent() {},
		getCanvasRecordCap: () => 5000,
		realRecordCount: () => canvasState.bulkRecords.length,
		runSlotPreflight: async () => {},
		clearEmptyStarterCard() {},
		canvasCapCheck: () => ({ blocked: false }),
		getSlotIdSeq: () => slotIdSeq,
		setSlotIdSeq: (next) => {
			slotIdSeq = next;
		},
	});
	return { api, canvasState, window };
}

test('whole-record requests load and save minimal field metadata before publishing', async () => {
	let calls = 0;
	const describe = {
		name: 'Opportunity',
		label: 'Opportunity',
		fields: [
			{ name: 'Name', label: 'Opportunity Name', type: 'string', createable: true, required: true },
			{ name: 'Amount', label: 'Amount', type: 'currency', createable: true },
			{ name: 'Secret__c', label: 'Secret', type: 'string', createable: false },
		],
	};
	const { api, canvasState } = mountTemplates(async () => {
		calls += 1;
		return describe;
	});

	assert.deepEqual(Array.from(await api.ensureDraftSlotMetadata()), ['Opportunity']);
	assert.equal(calls, 1);
	assert.equal(canvasState.describeCache.Opportunity, describe);
	const payload = api.buildCanvasPayload();
	assert.deepEqual(
		Array.from(payload.schema.objects[0].draftFields, (field) => field.name),
		['Name', 'Amount'],
	);
});

test('legacy whole-record requests cannot be re-saved without a usable describe snapshot', async () => {
	const { api } = mountTemplates(async () => ({ name: 'Opportunity', fields: [] }));
	await assert.rejects(api.ensureDraftSlotMetadata(), /record request because no createable fields are available/);
});

test('a restricted recipient can save a copy using the safe field snapshot from the shared canvas', async () => {
	let calls = 0;
	const { api, canvasState } = mountTemplates(async () => {
		calls += 1;
		throw new Error('recipient cannot describe Opportunity');
	});
	canvasState.currentCanvas.ownedByMe = false;
	canvasState.draftDescribeCache = {
		Opportunity: {
			name: 'Opportunity',
			label: 'Opportunity',
			_canvasSnapshot: true,
			fields: [{ name: 'Name', label: 'Opportunity Name', type: 'string', createable: true }],
		},
	};

	await api.ensureDraftSlotMetadata();
	assert.equal(calls, 0);
	assert.deepEqual(
		Array.from(api.buildCanvasPayload().schema.objects[0].draftFields, (field) => field.name),
		['Name'],
	);
});

test('saved drafts and their links use the stable collaboration identity', () => {
	const { api, canvasState } = mountTemplates(async () => null);
	canvasState.bulkRecords = [
		{
			id: 41,
			_collabId: 'collab-account',
			objectName: 'Account',
			x: 10,
			y: 20,
			values: { Name: 'Acme' },
		},
		{
			id: 42,
			_persistedTempId: 'saved-contact',
			objectName: 'Contact',
			x: 30,
			y: 40,
			values: { LastName: 'Person' },
		},
	];
	canvasState.bulkAssociations = [{ fromId: 42, toId: 41, fieldName: 'AccountId' }];
	const payload = api.buildCanvasPayload();

	assert.deepEqual(
		Array.from(payload.drafts, (record) => record.tempId),
		['collab-account', 'saved-contact'],
	);
	assert.deepEqual(JSON.parse(JSON.stringify(payload.associations[0])), {
		from: { kind: 'draft', ref: 'saved-contact' },
		to: { kind: 'draft', ref: 'collab-account' },
		fieldName: 'AccountId',
	});
});

test('saved loaded-record changes preserve an explicitly cleared lookup as null', () => {
	const { api, canvasState, window } = mountTemplates(async () => null);
	window.OrgLoom.valueCompare = {
		changedFieldNames(values, loadedValues) {
			return Array.from(new Set([...Object.keys(values), ...Object.keys(loadedValues)])).filter(
				(name) => values[name] !== loadedValues[name],
			);
		},
	};
	canvasState.bulkRecords = [
		{
			id: 51,
			objectName: 'Contact',
			loadedFromId: '003000000000001AAA',
			x: 10,
			y: 20,
			loadedValues: {
				LastName: 'Viewer',
				AccountId: '001000000000001AAA',
			},
			values: { LastName: 'Viewer' },
		},
	];
	canvasState.bulkAssociations = [];

	const payload = api.buildCanvasPayload();

	assert.deepEqual(JSON.parse(JSON.stringify(payload.loadedRecords[0].changes)), {
		AccountId: null,
	});
});
