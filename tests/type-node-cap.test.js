import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../src/public/js/type-node.js'), 'utf8');

function harness(records, capResult) {
	const window = {};
	const toasts = [];
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
		selectedObjects: [{ id: 'sel-account', name: 'Account', label: 'Account' }],
	};
	const api = window.OrgLoom.typeNode.mount({
		canvasState: state,
		csrfFetch: async () => {
			throw new Error('not expected');
		},
		escapeHtml: String,
		showBulkToast: (message) => toasts.push(message),
		showBulkToastWithAction: () => {},
		_canvasCapBlockReason: () => null,
		canvasCapCheck: () => capResult,
		_smoothScrollCanvas: () => {},
		addToSelection: async () => {
			throw new Error('not expected');
		},
		inferAssociationsForRecord: () => 0,
		purgeRedundantTypeNodes: () => {},
		renderBulkView: () => {},
		showLargeRelatedConfirm: async () => true,
		showRelatedSearchModal: () => {},
		seedEditModeTypeNodes: async () => {},
		fetchRelatedCount: async () => 0,
		fetchByRefCached: async () => [],
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
	return { api, state, toasts };
}

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
