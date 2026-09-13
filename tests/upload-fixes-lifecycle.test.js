import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = (name) =>
	fs.readFileSync(new URL('../src/public/js/' + name, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const csv = read('linked-csv.js');
// Exercise the actual import commit function, with metadata/network/UI dependencies stubbed.
const confirmSource = csv.slice(
	csv.indexOf('async function linkedCsvConfirm(opts)'),
	csv.indexOf('\n\t\t\treturn {\n\t\t\t\topenModal:'),
);

for (const scenario of ['replace', 'add', 'canceled', 'blocked', 'invalid']) {
	test('CSV import task lifecycle: ' + scenario, async () => {
		const oldRecord = { id: 1, objectName: 'Account', values: { Name: '' } };
		const state = {
			bulkRecords: [oldRecord],
			bulkAssociations: [],
			bulkIdSeq: 2,
			selectedObjects: [{ id: 1, name: 'Account', label: 'Account' }],
			currentCanvas: null,
		};
		const host = {
			hidden: true,
			innerHTML: '',
			dataset: {},
			querySelector: () => null,
			addEventListener: () => {},
		};
		const window = { OrgLoom: { importShared: { admitAssociation: () => true } } };
		vm.runInNewContext(read('upload-fixes-sidebar.js'), { window, document: { getElementById: () => host } });
		const issue = { recordId: 1, field: 'Name', message: 'Required' };
		const fixes = window.OrgLoom.uploadFixesSidebar.mount({
			canvasState: state,
			escapeHtml: String,
			getContext: () => ({ canvas: null, connection: 'same' }),
			validateLocal: () => ({ issues: [issue] }),
			openRecord: () => true,
			recordTitle: () => 'Account',
		});
		fixes.present([issue], 'local', [1]);
		fixes.start(1);
		let replacements = 0;
		const noop = () => {};
		const env = {
			window,
			canvasState: state,
			linkedCsvState: {
				files: [{ objectName: 'Account', headers: ['Name'], mapping: { 0: 'Name' }, rows: [['New']] }],
			},
			deps: {
				onCanvasReplace: () => {
					replacements++;
					fixes.clear();
				},
			},
			linkedCsvReady: () => scenario !== 'invalid',
			linkedCsvRender: noop,
			csvResolveExistingIds: async () => ({ liveById: new Map(), draftKeys: new Set() }),
			csvImportCanceled: () => scenario === 'canceled',
			_planMappedFieldWrites: () => ({ issues: [], omittedByRow: new Map() }),
			getGraph: () => ({ querySelector: () => null }),
			canvasCapCheck: () => ({
				cap: scenario === 'blocked' ? 0 : 100,
				reason: scenario === 'blocked' ? 'Full' : null,
			}),
			captureUndoSnapshot: null,
			clearEmptyStarterCard: noop,
			unmappedCsvColumns: () => [],
			closeLinkedCsvModal: noop,
			setSkipNextCyAutoPan: noop,
			renderBulkView: () => fixes.render(),
			relayoutNewRecords: noop,
			showBulkToast: noop,
			pingAuditEvent: noop,
		};
		const confirm = vm.runInNewContext('(' + confirmSource.trim() + ')', env);
		await confirm({ replaceCanvas: scenario !== 'add' });
		assert.equal(replacements, scenario === 'replace' ? 1 : 0);
		assert.equal(host.hidden, scenario === 'replace');
		assert.equal(fixes.refresh().length, scenario === 'replace' ? 0 : 1);
		if (scenario === 'replace') {
			assert.equal(fixes.start(1), false, 'pending issues cannot resurrect the old list');
			assert.equal(state.bulkRecords.length, 1);
			assert.equal(state.bulkRecords[0].values.Name, 'New');
		} else {
			assert.equal(state.bulkRecords[0], oldRecord);
			assert.equal(state.bulkRecords.length, scenario === 'add' ? 2 : 1);
		}
	});
}

test('app connects replacement, reset, Undo, and access-loss boundaries to fix cleanup', () => {
	const app = read('app.js');
	for (const mount of [
		'_captureCanvasUndoSnapshot = _importShared.makeUndoCapture',
		'_lcsv = window.OrgLoom.linkedCsv.mount',
		'_tpl = window.OrgLoom.templates.mount',
	]) {
		assert.ok(app.includes(mount + '({\n\t\tonCanvasReplace: () => _clearUploadFixes(),'));
	}
	assert.match(app, /function resetToBasePicker\(\)\s*{\s*_clearUploadFixes\(\)/);
	assert.match(
		app,
		/if \(detail && \(detail.revoked \|\| detail.change === 'decreased'\)\)\s*{\s*_clearUploadFixes\(\)/,
	);
});
