// Tests for the CSV export escaper: RFC-4180 quoting AND the CSV
// formula-injection guard. canvas-export-csv.js is a browser IIFE that
// attaches to window.OrgLoom.canvasExportCsv; run it in a VM sandbox and
// exercise the pure helpers it exposes on the mount's `_test` surface.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let T; // the _test helper surface

before(() => {
	const src = readFileSync(new URL('../src/public/js/canvas-export-csv.js', import.meta.url), 'utf8');
	// Minimal DOM shim: mount() builds a modal element and wires close
	// handlers; we only need createElement + a body + document listeners.
	const el = () => ({
		className: '', innerHTML: '', style: {},
		classList: { add() {}, remove() {}, contains() {
 return true; 
} },
		appendChild() {}, remove() {}, setAttribute() {}, addEventListener() {},
		querySelector: () => el(), querySelectorAll: () => [],
	});
	const sandbox = {
		window: {},
		document: { createElement: () => el(), body: { appendChild() {} }, addEventListener() {} },
		console,
	};
	vm.createContext(sandbox);
	vm.runInContext(src, sandbox);
	const api = sandbox.window.OrgLoom.canvasExportCsv.mount({
		canvasState: { bulkRecords: [], bulkSelectedIds: new Set(), currentCanvas: null },
		escapeHtml: (s) => String(s),
		showBulkToast: () => {},
	});
	T = api._test;
});

describe('csvEscape: formula-injection guard', () => {
	test('prefixes an apostrophe on values starting with = + - @', () => {
		assert.equal(T.csvEscape('=HYPERLINK("x","y")'), '"\'=HYPERLINK(""x"",""y"")"');
		assert.equal(T.csvEscape('+1'), "'+1");
		assert.equal(T.csvEscape('-cmd'), "'-cmd");
		assert.equal(T.csvEscape('@SUM(A1)'), "'@SUM(A1)");
	});

	test('guards leading tab / CR that would shift the first visible char', () => {
		// Tab is guarded but not an RFC-quote trigger → apostrophe, no quotes.
		assert.equal(T.csvEscape('\t=cmd'), "'\t=cmd");
		// CR is both guarded AND an RFC-quote trigger → apostrophe + quotes.
		assert.equal(T.csvEscape('\r=cmd'), '"\'\r=cmd"');
	});

	test('ordinary values are untouched (no spurious apostrophe)', () => {
		assert.equal(T.csvEscape('Acme Corp'), 'Acme Corp');
		assert.equal(T.csvEscape('jordan@example.com'), 'jordan@example.com'); // @ not leading
		assert.equal(T.csvEscape('5 - 3 apples'), '5 - 3 apples'); // - not leading
		assert.equal(T.csvEscape(42), '42');
		assert.equal(T.csvEscape(null), '');
		assert.equal(T.csvEscape(undefined), '');
	});
});

describe('csvEscape: RFC 4180 quoting', () => {
	test('quotes values containing comma / quote / newline; doubles inner quotes', () => {
		assert.equal(T.csvEscape('a,b'), '"a,b"');
		assert.equal(T.csvEscape('he said "hi"'), '"he said ""hi"""');
		assert.equal(T.csvEscape('line1\nline2'), '"line1\nline2"');
		assert.equal(T.csvEscape('line1\r\nline2'), '"line1\r\nline2"');
	});

	test('formula guard AND quoting compose (value with = and a comma)', () => {
		// leading = → apostrophe; comma → wrapped in quotes.
		assert.equal(T.csvEscape('=a,b'), '"\'=a,b"');
	});
});

describe('buildCsv', () => {
	const recs = [
		{ values: { Name: 'Acme', Note: '=DANGER' } },
		{ values: { Name: 'Beta, Inc', Note: 'ok' } },
	];
	test('emits BOM, CRLF rows, header + escaped cells', () => {
		const csv = T.buildCsv(recs, ['Name', 'Note'], []);
		assert.ok(csv.startsWith('﻿'), 'starts with UTF-8 BOM');
		const rows = csv.replace(/^﻿/, '').split('\r\n');
		assert.equal(rows[0], 'Name,Note', 'header');
		assert.equal(rows[1], 'Acme,\'=DANGER', 'formula-guarded cell');
		assert.equal(rows[2], '"Beta, Inc",ok', 'comma-quoted cell');
	});
});

describe('orderFields', () => {
	test('priority fields first (in list order), rest alphabetical', () => {
		// Spread the sandbox-realm array into a native one so deepEqual's
		// prototype check doesn't trip on the cross-realm Array.prototype.
		const ordered = [...T.orderFields(['Zeta', 'Name', 'Alpha', 'Id', 'Email'])];
		assert.deepEqual(ordered, ['Id', 'Name', 'Email', 'Alpha', 'Zeta']);
	});
});

describe('sanitizeFilename', () => {
	test('strips unsafe chars and caps length', () => {
		assert.equal(T.sanitizeFilename('a/b\\c:d*e'), 'a_b_c_d_e');
		assert.equal(T.sanitizeFilename(''), 'canvas');
		assert.equal(T.sanitizeFilename('  ok-name.v2 '), '  ok-name.v2 ');
	});
});
