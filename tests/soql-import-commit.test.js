import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/public/js/soql-import.js', import.meta.url), 'utf8');
function harness() {
	const window = { OrgLoom: { importShared: { admitAssociation: () => true } } };
	vm.runInNewContext(source, { window });
	const state = { bulkRecords: [], bulkAssociations: [], selectedObjects: [], bulkIdSeq: 1 };
	let resolveSelection,
		cleared = 0,
		rendered = 0;
	const noop = () => {};
	const api = window.OrgLoom.soqlImport.mount({
		canvasState: state,
		showBulkToast: noop,
		escapeHtml: String,
		csrfFetch: noop,
		addToSelection: () =>
			new Promise((resolve) => {
				resolveSelection = resolve;
			}),
		renderBulkView: () => rendered++,
		getGraph: () => ({ querySelector: () => null }),
		clearBulkUserDeleted: noop,
		relayoutNewRecords: noop,
		setSkipNextCyAutoPan: noop,
		clearEmptyStarterCard: () => cleared++,
	});
	return {
		state,
		api,
		finish: () => resolveSelection({ id: 1, label: 'Account' }),
		cleared: () => cleared,
		rendered: () => rendered,
	};
}
for (const allowCommit of [true, false]) {
	test('programmatic record import rechecks the caller guard after metadata loads: ' + allowCommit, async () => {
		const h = harness();
		let allowed = true;
		const pending = h.api.commitRecords(
			{
				records: [
					{
						tempId: 'a',
						objectName: 'Account',
						loadedFromId: '001000000000001AAA',
						values: { Name: 'Fixture' },
					},
				],
			},
			{ canCommit: () => allowed },
		);
		allowed = allowCommit;
		h.finish();
		if (allowCommit) {
			assert.equal((await pending).added, 1);
			assert.equal(h.state.bulkRecords[0].values.Name, 'Fixture');
			assert.equal(h.cleared(), 1);
			assert.equal(h.rendered(), 1);
		} else {
			await assert.rejects(pending, /canvas changed/);
			assert.equal(h.state.bulkRecords.length, 0);
			assert.equal(h.cleared(), 0);
			assert.equal(h.rendered(), 0);
		}
	});
}
