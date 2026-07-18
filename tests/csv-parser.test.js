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
