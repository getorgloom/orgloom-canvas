import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../src/public/js/csv-import.js'), 'utf8');
const window = {};
vm.runInNewContext(source, { window, Set });
const csvImport = window.OrgLoom.csvImport.mount({ csrfFetch: async () => ({ ok: true }) });
const parse = csvImport.parseCsv;

const cell = (value) => '"' + String(value).replace(/"/g, '""') + '"';
const escapedFile = (value, metadata) =>
	'Phone,__OrgLoom_EscapedCells\r\n' + cell(value) + ',' + cell(JSON.stringify(metadata));

test('ordinary and older CSVs preserve literal apostrophes without escape metadata', () => {
	assert.equal(parse("Phone\r\n'+1 602 555").rows[0][0], "'+1 602 555");
	assert.equal(parse("Name\r\nO'Brien").rows[0][0], "O'Brien");
});

test('escape metadata only reverses the exact value originally escaped', () => {
	const metadata = { version: 1, cells: [['Phone', "'+1 602 555"]] };
	for (const [value, expected] of [
		["'+1 602 555", '+1 602 555'],
		['+1 602 555', '+1 602 555'],
		["'+44 123", "'+44 123"],
		["''+1 602 555", "''+1 602 555"],
	]) {
		const result = parse(escapedFile(value, metadata));
		assert.equal(result.errors.length, 0);
		assert.equal(result.rows[0][0], expected);
		assert.deepEqual([...result.headers], ['Phone']);
	}
});

test('malformed escape metadata is rejected, not silently treated as a field edit', () => {
	for (const metadata of [
		null,
		{},
		{ version: 2, cells: [] },
		{ version: 1, cells: 'bad' },
		{ version: 1, cells: [['Missing', "'+1"]] },
		{ version: 1, cells: [['Phone', 3]] },
		{ version: 1, cells: [['Phone', "'ordinary"]] },
		{
			version: 1,
			cells: [
				['Phone', "'+1"],
				['Phone', "'+1"],
			],
		},
	]) {
		assert.ok(parse(escapedFile("'+1", metadata)).errors.length);
	}
});

test('escape metadata does not hide ragged rows or ambiguous headers', () => {
	assert.ok(parse('Phone,__OrgLoom_EscapedCells\r\n123').errors.length);
	assert.ok(parse('Phone,Phone,__OrgLoom_EscapedCells\r\n123,456,').errors.length);
});

test('quoted commas, escaped quotes, embedded newlines, BOM and Unicode preserve exact values', () => {
	const out = parse('\uFEFFName,Notes\r\n"José, Jr.","line 1\nline ""two"""\r\n');
	assert.deepEqual([...out.headers], ['Name', 'Notes']);
	assert.deepEqual([...out.rows[0]], ['José, Jr.', 'line 1\nline "two"']);
	assert.deepEqual([...out.errors], []);
});

test('CRLF, LF and bare CR produce the same rows', () => {
	for (const eol of ['\r\n', '\n', '\r']) {
		const out = parse(`Name,City${eol}A,Phoenix${eol}B,Tucson${eol}`);
		assert.equal(
			JSON.stringify(out.rows),
			JSON.stringify([
				['A', 'Phoenix'],
				['B', 'Tucson'],
			]),
		);
	}
});

test('duplicate headers and malformed or unclosed quotes are explicit structural errors', () => {
	assert.match(parse('Name,name\nA,B\n').errors.join(' '), /Duplicate header/i);
	assert.match(parse('Name,Notes\nA,"never closes').errors.join(' '), /Malformed|unclosed/i);
	assert.match(parse('Name,Notes\nA,bad"quote\n').errors.join(' '), /Malformed|unclosed/i);
});

test('readable but unwritable fields stay mapped for operation-aware import review', () => {
	const mapping = csvImport.csvAutoMapHeaders(
		['Name', 'YearStarted'],
		[
			{ name: 'Name', label: 'Account Name', createable: true },
			{ name: 'YearStarted', label: 'Year Started', createable: false },
		],
	);
	assert.equal(mapping[0], 'Name');
	assert.equal(mapping[1], 'YearStarted');
});

test('an Id header maps directly to Salesforce Id without a separate matching choice', () => {
	const mapping = csvImport.csvAutoMapHeaders(
		['Id', 'Name'],
		[{ name: 'Name', label: 'Account Name', createable: true }],
	);
	assert.equal(mapping[0], 'Id');
	assert.equal(mapping[1], 'Name');
});
