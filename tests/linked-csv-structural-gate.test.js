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

test('cross-file matching is hidden until a custom relationship column is selected', () => {
	const start = source.indexOf('(links.length > 0\n');
	assert.ok(start !== -1, 'section visibility depends on selected links, not uploaded files');
	const end = source.indexOf('const dz = body.querySelector', start);
	const expression = source.slice(start, end).trim().replace(/;$/, '');
	const render = (links) => vm.runInNewContext(expression, { links, linksHtml: '<div>Matching controls</div>' });
	assert.equal(render([]), '', 'normal Salesforce lookup columns need no matching section');
	assert.match(render([{ fromFileIdx: 0, fromColumnIdx: 2 }]), /Cross-file matching/);
	assert.match(render([{ fromFileIdx: 0, fromColumnIdx: 2 }]), /Matching controls/);
	assert.doesNotMatch(source, /No relationship columns selected/);
	assert.match(source, /Match to a related record in another CSV - not uploaded/);
});
