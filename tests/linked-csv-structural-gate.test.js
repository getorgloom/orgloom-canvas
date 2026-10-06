import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../src/public/js/linked-csv.js'), 'utf8');
const window = {};
vm.runInNewContext(source, { window, Set, Map });
const { linkedCsvReady } = window.OrgLoom.linkedCsv._test;

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
