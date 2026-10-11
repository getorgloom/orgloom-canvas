import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/public/js/find-duplicates-modal.js', import.meta.url), 'utf8');
function scan(values, fields = ['Name', 'Rating'], op = 'or') {
	const normalizeStart = source.indexOf('function _normalize(v)');
	const normalizeEnd = source.indexOf('function _matchKey(', normalizeStart);
	const scanStart = source.indexOf('function _sortGroupRecords(');
	const scanEnd = source.indexOf('const SYSTEM_FIELDS', scanStart);
	assert.ok(normalizeStart >= 0 && normalizeEnd > normalizeStart && scanStart >= 0 && scanEnd > scanStart);
	const context = {
		canvasState: { bulkRecords: values.map((v, i) => ({ id: i + 1, objectName: 'Account', values: v })) },
		recordOrdinal: (r) => r.id,
		isRecordPendingDelete: () => false,
	};
	const run = vm.runInNewContext(
		source.slice(normalizeStart, normalizeEnd) + source.slice(scanStart, scanEnd) + '\n_scanForObject;',
		context,
	);
	const result = run('Account', fields, op);
	return result ? Array.from(result.groups, (g) => Array.from(g.records, (r) => r.id)) : [];
}

test('Match any does not connect blank ratings to the testa name group', () => {
	for (const blank of [null, undefined, '', '   ', '\t\n']) {
		assert.deepEqual(
			scan([
				{ Name: 'testa', Rating: blank },
				{ Name: 'testa', Rating: blank },
				{ Name: 'Other account', Rating: blank },
				{ Name: 'Another account', Rating: 'Hot' },
			]),
			[[1, 2]],
		);
	}
});

test('Match any ignores a field when every record has a blank value', () => {
	assert.deepEqual(scan([{ Rating: null }, {}, { Rating: '' }, { Rating: ' ' }], ['Rating']), []);
});

test('Match any can connect name and rating groups through a populated bridge record', () => {
	const values = [
		{ Name: 'testa', Rating: null },
		{ Name: 'testa', Rating: null },
		{ Name: 'testa', Rating: 'Hot' },
		{ Name: 'Other account', Rating: 'Hot' },
	];
	assert.deepEqual(scan(values, ['Name']), [[1, 2, 3]]);
	assert.deepEqual(scan(values), [[1, 2, 3, 4]]);
});

test('Match any still compares real zero and false values', () => {
	assert.deepEqual(scan([{ Score: 0 }, { Score: 0 }, { Score: null }], ['Score']), [[1, 2]]);
	assert.deepEqual(scan([{ Active: false }, { Active: false }, {}], ['Active']), [[1, 2]]);
});
