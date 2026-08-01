import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../src/public/js/templates.js'), 'utf8');

test('saved canvases with record slots load and advance the shared slot id counter', async () => {
	const window = {
		OrgLoom: {
			importShared: {
				admitAssociation(used, fromId, toId, fieldName) {
					if (fromId == null || toId == null || !fieldName) {
						return false;
					}
					const key = `${fromId}::${fieldName}`;
					if (used.has(key)) {
						return false;
					}
					used.add(key);
					return true;
				},
				skipSuffix: () => '',
			},
		},
	};
	vm.runInNewContext(source, {
		window,
		localStorage: { removeItem() {} },
		console,
		Set,
		Map,
		Promise,
		Date,
	});

	const canvasState = {
		selectedObjects: [],
		selectedIdSeq: 1,
		activeIndex: 0,
		hiddenObjects: new Set(),
		currentCanvas: null,
		bulkRecords: [],
		bulkAssociations: [],
		bulkIdSeq: 1,
		bulkSelectedIds: new Set(),
		_prefetchedTypeNodeKeys: new Set(),
		_renderedRecIds: new Set(),
		describeCache: {},
	};
	let slotIdSeq = 1;
	let firstRenderRole = null;
	let selectionCalls = 0;
	let slotPreflightCalls = 0;
	const api = window.OrgLoom.templates.mount({
		canvasState,
		showBulkToast() {},
		escapeHtml: (value) => String(value),
		csrfFetch: async () => ({
			ok: true,
			json: async () => ({ Id: '001000000000001AAA', Name: 'Existing account' }),
		}),
		ensureDescribe: async () => {},
		addToSelection: async (name) => {
			selectionCalls += 1;
			const entry = { id: canvasState.selectedIdSeq++, name, label: name };
			canvasState.selectedObjects.push(entry);
			return entry;
		},
		setGraphView() {},
		renderAll() {
			firstRenderRole ??= canvasState._renderCanvasShareRole;
		},
		showReplaceOrMergeDialog() {},
		pingAuditEvent() {},
		getCanvasRecordCap: () => 5000,
		realRecordCount: () => canvasState.bulkRecords.length,
		runSlotPreflight: async () => {
			slotPreflightCalls += 1;
		},
		clearEmptyStarterCard() {},
		canvasCapCheck: () => ({ blocked: false }),
		getSlotIdSeq: () => slotIdSeq,
		setSlotIdSeq: (next) => {
			slotIdSeq = next;
		},
	});

	await api.applyCanvasPayload(
		{
			schema: { objects: [{ name: 'Account' }, { name: 'Contact' }, { name: 'Opportunity' }] },
			loadedRecords: [
				{
					objectName: 'Account',
					loadedFromId: '001000000000001AAA',
					canvasRecordId: 'saved-account-card',
					x: 0,
					y: 0,
					slot: {
						slotId: 2,
						label: 'Account',
						description: 'Complete the account details',
						kind: 'fields',
						fields: ['Name', 'Type'],
						assigneeSfUserId: '005000000000001AAA',
						assigneeName: 'Alex Chen',
						assigneeEmail: 'alex@example.com',
					},
				},
			],
			drafts: [
				{ objectName: 'Contact', tempId: 2, values: { AccountId: '001000000000001AAA' } },
				{
					objectName: 'Opportunity',
					tempId: 4,
					values: { Name: 'Draft opportunity' },
					slot: { slotId: 1, label: 'Opportunity', kind: 'whole-record' },
				},
			],
			associations: [
				{
					from: { kind: 'draft', ref: 2 },
					to: { kind: 'slot', ref: 2 },
					fieldName: 'AccountId',
				},
			],
		},
		{ ownedByMe: false, recipientRole: 'viewer' },
	);

	assert.equal(slotIdSeq, 3);
	assert.equal(selectionCalls, 0);
	assert.equal(slotPreflightCalls, 0);
	assert.equal(firstRenderRole, 'viewer');
	assert.deepEqual(
		Array.from(canvasState.selectedObjects, (object) => object.name),
		['Account', 'Contact', 'Opportunity'],
	);
	assert.equal(canvasState.bulkRecords.length, 3);
	assert.equal(canvasState.bulkAssociations.length, 1);
	assert.equal(canvasState.bulkAssociations[0].fieldName, 'AccountId');
	const restoredAccount = canvasState.bulkRecords.find((record) => record.loadedFromId);
	assert.equal(restoredAccount._canvasRecordId, 'saved-account-card');
	assert.equal(restoredAccount.x, 0);
	assert.equal(restoredAccount.y, 0);
	assert.equal(restoredAccount.slot.description, 'Complete the account details');
	assert.deepEqual(Array.from(restoredAccount.slot.fields), ['Name', 'Type']);
	assert.equal(restoredAccount.slot.assigneeSfUserId, '005000000000001AAA');
	assert.equal(restoredAccount.slot.assigneeName, 'Alex Chen');
	assert.equal(restoredAccount.slot.assigneeEmail, 'alex@example.com');
	assert.equal(api.buildCanvasPayload().loadedRecords[0].canvasRecordId, 'saved-account-card');
});

test('shared payload permission placeholders do not require Salesforce object or record identifiers', () => {
	assert.match(source, /const hiddenRecords = Array\.isArray\(payload\.hiddenRecords\)/);
	assert.match(source, /objectName: null/);
	assert.match(source, /label: 'Hidden Salesforce content'/);
	assert.match(source, /_permissionHidden: true/);
	assert.match(source, /!r\._permissionHidden/);
	assert.match(source, /id: -\(hiddenIndex \+ 1\)/);
	assert.match(source, /_permissionHiddenId: hidden\.hiddenId/);
});
