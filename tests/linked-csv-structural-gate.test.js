import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../src/public/js/linked-csv.js'), 'utf8').replace(/\r\n/g, '\n');
const window = {};
vm.runInNewContext(source, { window, Set, Map });
const { linkedCsvReady } = window.OrgLoom.linkedCsv._test;

test('clear-field metadata is hidden from column mapping and unmapped counts without shifting indexes', () => {
	const file = {
		headers: ['__OrgLoom_ClearFields', 'Id', 'Phone', 'Notes'],
		mapping: { 1: 'Id', 2: 'Phone' },
		rows: [['["Phone"]', '001000000000001AAA', '', 'local note']],
	};
	const dataColumns = window.OrgLoom.linkedCsv._test.csvDataColumns(file);
	assert.equal(
		JSON.stringify(dataColumns),
		JSON.stringify([
			{ name: 'Id', index: 1 },
			{ name: 'Phone', index: 2 },
			{ name: 'Notes', index: 3 },
		]),
	);
	const start = source.indexOf('const unmappedCount = dataColumns');
	const end = source.indexOf('let permWarn', start);
	const counts = vm.runInNewContext(source.slice(start, end) + '\n({ unmappedCount })', {
		dataColumns,
		file,
		state: { links: [] },
		i: 0,
	});
	assert.equal(counts.unmappedCount, 1);
	const rowStart = source.indexOf('const rows = dataColumns');
	const rowEnd = source.indexOf('columnsHtml =', rowStart);
	const html = vm.runInNewContext(source.slice(rowStart, rowEnd) + '\nrows', {
		dataColumns,
		file,
		relationshipColumnIdxs: new Set(),
		fieldOpts: [],
		escapeHtml: String,
		i: 0,
	});
	assert.doesNotMatch(html, /__OrgLoom_ClearFields/);
	assert.match(html, /data-lcsv-col="0:2"/);
	assert.deepEqual([...window.OrgLoom.exportedClearFields(file, file.rows[0])], ['Phone']);
});

const validFile = {
	objectName: 'Account',
	headers: ['Name'],
	rows: [['Acme']],
	mapping: { 0: 'Name' },
	blockingErrors: [],
};

test('CSV actions start disabled and enable only after a usable mapped file exists', () => {
	assert.equal(linkedCsvReady({ files: [] }), false);
	assert.equal(linkedCsvReady({ files: [validFile] }), true);
	assert.match(source, /id="linked-csv-replace" disabled/);
	assert.match(source, /id="linked-csv-confirm" disabled/);
});

test('file processing and structural parser failures keep CSV actions disabled', () => {
	assert.equal(linkedCsvReady({ files: [validFile], processingFiles: true }), false);
	assert.equal(linkedCsvReady({ files: [validFile], hasRejectedFileErrors: true }), false);
	assert.equal(linkedCsvReady({ files: [{ ...validFile, blockingErrors: ['Duplicate header'] }] }), false);
});

test('structurally broken files are rejected before entering the mapper collection', () => {
	assert.match(source, /reason: 'structure'/);
	assert.match(source, /const valid = parsedFiles\.filter\(\(f\) => f && !f\.__rejected\)/);
	assert.match(source, /state\.files = state\.files\.concat\(valid\)/);
});
