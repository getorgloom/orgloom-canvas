import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../src/public/js/type-node.js'), 'utf8');

function harness(records, capResult, overrides = {}) {
	const window = {};
	const toasts = [];
	const events = [];
	const undo = [];
	vm.runInNewContext(source, {
		window,
		Set,
		Map,
		Promise,
		Object,
		Math,
		String,
		encodeURIComponent,
		setTimeout,
		clearTimeout,
	});
	const state = {
		bulkRecords: records,
		bulkAssociations: [],
		bulkSelectedIds: new Set(),
		bulkIdSeq: 1000,
		bulkZoom: 1,
		selectedObjects: [
			{ id: 'sel-account', name: 'Account', label: 'Account' },
			{ id: 'sel-contact', name: 'Contact', label: 'Contact' },
			{ id: 'sel-opportunity', name: 'Opportunity', label: 'Opportunity' },
		],
	};
	const api = window.OrgLoom.typeNode.mount({
		canvasState: state,
		pushUndo: (label, fn) => undo.push({ label, fn }),
		csrfFetch: async () => {
			throw new Error('not expected');
		},
		escapeHtml: String,
		showBulkToast: (message) => {
			toasts.push(message);
			events.push('toast');
		},
		showBulkToastWithAction: () => {},
		_canvasCapBlockReason: () => null,
		canvasCapCheck: () => capResult,
		_smoothScrollCanvas: () => {},
		addToSelection: async () => {
			throw new Error('not expected');
		},
		inferAssociationsForRecord: () => 0,
		purgeRedundantTypeNodes: () => {},
		renderBulkView: () => events.push('render'),
		showLargeRelatedConfirm: async () => true,
		showRelatedSearchModal: () => {},
		seedEditModeTypeNodes: async () => {},
		fetchRelatedCount: overrides.fetchRelatedCount || (async () => 0),
		fetchByRefCached: overrides.fetchByRefCached || (async () => []),
		_countCacheKey: () => '',
		_sfIdMatch: (a, b) => a === b,
		_relatedCountCache: new Map(),
		_byRefCache: new Map(),
		_RELATED_BULK_LOAD_CAP: 50,
		_RELATED_SOFT_THRESHOLD: 50,
		getGraph: () => ({ querySelector: () => null }),
		getBulkRenderShiftX: () => 0,
		getBulkRenderShiftY: () => 0,
	});
	return { api, state, toasts, events, undo };
}

function relatedFixture({ chip = true } = {}) {
	const base = { id: 1, objectName: 'Account', loadedFromId: '001base', values: { Name: 'Keep me' }, x: 0, y: 0 };
	const loader = {
		id: 2,
		isTypeNode: true,
		_chipLoader: chip,
		hostRecordId: 1,
		objectName: 'Contact',
		direction: 'child',
		fieldOnOther: 'AccountId',
		x: 0,
		y: 160,
	};
	return { base, loader };
}

test('a related load is one undo step that removes only new records and links', async () => {
	const { base, loader } = relatedFixture();
	const existing = {
		id: 3,
		objectName: 'Contact',
		loadedFromId: '003existing',
		values: { LastName: 'Keep edits' },
		x: 500,
		y: 0,
	};
	const { api, state, undo } = harness([base, loader, existing], { ok: true, blocked: false });
	const oldLink = { id: 900, fromId: 3, toId: 1, fieldName: 'OtherId' };
	state.bulkAssociations.push(oldLink);
	await api.openTypeNode(loader, {
		recordsOverride: [
			{ Id: '003new', LastName: 'New' },
			{ Id: '003existing', LastName: 'Server name' },
		],
	});
	assert.equal(undo.length, 1);
	const added = state.bulkRecords.find((record) => record.loadedFromId === '003new');
	state.bulkSelectedIds.add(added.id);
	assert.equal(existing.values.AccountId, base.loadedFromId);
	base.values.Name = 'Unrelated change';
	undo.pop().fn();
	assert.deepEqual(state.bulkRecords, [base, existing]);
	assert.deepEqual(state.bulkAssociations, [oldLink]);
	assert.equal(existing.values.LastName, 'Keep edits');
	assert.equal(Object.hasOwn(existing.values, 'AccountId'), false);
	assert.equal(base.values.Name, 'Unrelated change');
	assert.equal(state.bulkSelectedIds.has(added.id), false);
});

test('undo restores a consumed related placeholder and allows reloading', async () => {
	const { base, loader } = relatedFixture({ chip: false });
	const { api, state, undo } = harness([base, loader], { ok: true, blocked: false });
	const options = { recordsOverride: [{ Id: '003new' }] };
	await api.openTypeNode(loader, options);
	undo.pop().fn();
	assert.deepEqual(state.bulkRecords, [base, loader]);
	assert.equal(loader._loading, false);
	await api.openTypeNode(loader, options);
	assert.equal(state.bulkRecords.filter((record) => record.loadedFromId === '003new').length, 1);
	assert.equal(undo.length, 1);
});

test('successive related search picks can each be undone without removing earlier picks', async () => {
	const { base, loader } = relatedFixture();
	const { api, state, undo } = harness([base, loader], { ok: true, blocked: false });
	for (const id of ['003first', '003second']) {
		await api.openTypeNode(loader, { recordsOverride: [{ Id: id }], preserveTypeNode: true });
	}
	assert.equal(undo.length, 2);
	undo.pop().fn();
	assert.equal(
		state.bulkRecords.some((record) => record.loadedFromId === '003second'),
		false,
	);
	assert.equal(
		state.bulkRecords.some((record) => record.loadedFromId === '003first'),
		true,
	);
	undo.pop().fn();
	assert.deepEqual(state.bulkRecords, [base, loader]);
});

test('blocked, failed, and empty related loads do not create undo entries', async () => {
	for (const mode of ['blocked', 'failed', 'empty']) {
		const { base, loader } = relatedFixture();
		const { api, undo } = harness(
			[base, loader],
			{ ok: mode !== 'blocked', blocked: mode === 'blocked', reason: 'Full' },
			{
				fetchByRefCached: async () => {
					if (mode === 'failed') throw new Error('Network');
					return [];
				},
			},
		);
		await api.openTypeNode(loader, mode === 'blocked' ? { recordsOverride: [{ Id: '003new' }] } : {});
		assert.equal(undo.length, 0);
	}
});

test('undoing a related parent load restores the existing child relationship value', async () => {
	const base = { id: 1, objectName: 'Contact', loadedFromId: '003child', values: { AccountId: null }, x: 0, y: 0 };
	const loader = {
		id: 2,
		isTypeNode: true,
		_chipLoader: true,
		hostRecordId: 1,
		objectName: 'Account',
		direction: 'parent',
		fieldOnThis: 'AccountId',
		x: 0,
		y: 160,
	};
	const { api, state, undo } = harness([base, loader], { ok: true, blocked: false });
	await api.openTypeNode(loader, { recordsOverride: [{ Id: '001parent', Name: 'Parent' }] });
	assert.equal(base.values.AccountId, '001parent');
	undo.pop().fn();
	assert.equal(base.values.AccountId, null);
	assert.deepEqual(state.bulkRecords, [base]);
	assert.equal(state.bulkAssociations.length, 0);
});

test('an empty related-record query shows a no-records toast', async () => {
	const base = { id: 1, objectName: 'Account', loadedFromId: '001000000000001AAA', x: 0, y: 0 };
	const relatedType = {
		id: 2,
		isTypeNode: true,
		hostRecordId: base.id,
		objectName: 'Contact',
		direction: 'child',
		fieldOnOther: 'AccountId',
		x: 0,
		y: 160,
	};
	const { api, toasts, events } = harness([base, relatedType], { ok: true, blocked: false });

	await api.openTypeNode(relatedType);

	assert.deepEqual(toasts, ['No related records found.']);
	assert.deepEqual(events.slice(-2), ['toast', 'render']);
});

test('load-existing rechecks the cap when the picked record materializes', async () => {
	const pending = { id: 42, isTypeNode: true, isPending: true, objectName: 'Account', x: 10, y: 20 };
	const { api, state, toasts } = harness([pending], { ok: false, blocked: true, reason: 'Canvas is full.' });
	await api.loadRecordIntoFreeTypeNode(pending, { Id: '001000000000001AAA', Name: 'Blocked' });
	assert.equal(state.bulkRecords.length, 1);
	assert.equal(state.bulkRecords[0], pending, 'placeholder stays intact and retryable');
	assert.deepEqual(toasts, ['Canvas is full.']);
});

test('a duplicate pick does not consume cap headroom and focuses the existing card', async () => {
	const existing = { id: 7, objectName: 'Account', loadedFromId: '001000000000001AAA', x: 1, y: 2 };
	const pending = { id: 42, isTypeNode: true, isPending: true, objectName: 'Account', x: 10, y: 20 };
	const { api, state, toasts } = harness([existing, pending], {
		ok: false,
		blocked: true,
		reason: 'Canvas is full.',
	});
	await api.loadRecordIntoFreeTypeNode(pending, { Id: existing.loadedFromId, Name: 'Already here' });
	assert.deepEqual(state.bulkRecords, [existing]);
	assert.deepEqual(Array.from(state.bulkSelectedIds), [existing.id]);
	assert.deepEqual(toasts, ['That record is already on the canvas.']);
});

test('related records are pushed outward when their preferred positions overlap existing cards', async () => {
	const base = { id: 1, objectName: 'Account', loadedFromId: '001000000000001AAA', x: 0, y: 0 };
	const relatedType = {
		id: 2,
		isTypeNode: true,
		hostRecordId: base.id,
		objectName: 'Opportunity',
		direction: 'child',
		fieldOnOther: 'AccountId',
		x: 0,
		y: 160,
	};
	const radius = 165;
	const arcSpan = Math.PI * 0.95;
	const existingContacts = [0, 1, 2].map((index) => {
		const angle = Math.PI / 2 - arcSpan / 2 + (arcSpan * index) / 2;
		return {
			id: 10 + index,
			objectName: 'Contact',
			loadedFromId: `00300000000000${index}AAA`,
			x: relatedType.x + radius * Math.cos(angle),
			y: relatedType.y + radius * Math.sin(angle),
		};
	});
	const { api, state } = harness([base, relatedType, ...existingContacts], {
		ok: true,
		blocked: false,
	});

	await api.openTypeNode(relatedType, {
		recordsOverride: [
			{ Id: '006000000000001AAA', Name: 'One' },
			{ Id: '006000000000002AAA', Name: 'Two' },
			{ Id: '006000000000003AAA', Name: 'Three' },
		],
	});

	const opportunities = state.bulkRecords.filter((record) => record.objectName === 'Opportunity');
	assert.equal(opportunities.length, 3);
	const bounds = (record) => ({
		left: record.x - 120,
		right: record.x + 120,
		top: record.y - 90,
		bottom: record.y + 90,
	});
	const overlaps = (a, b) => !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
	for (const opportunity of opportunities) {
		for (const contact of existingContacts) {
			assert.equal(overlaps(bounds(opportunity), bounds(contact)), false);
		}
	}
	for (let i = 0; i < opportunities.length; i++) {
		for (let j = i + 1; j < opportunities.length; j++) {
			assert.equal(overlaps(bounds(opportunities[i]), bounds(opportunities[j])), false);
		}
	}
});
