import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let T; // the _test helper surface

before(() => {
	const src = readFileSync(new URL('../src/public/js/canvas-export-csv.js', import.meta.url), 'utf8');
	const el = () => ({
		className: '',
		innerHTML: '',
		style: {},
		classList: {
			add() {},
			remove() {},
			contains() {
				return true;
			},
		},
		appendChild() {},
		remove() {},
		setAttribute() {},
		addEventListener() {},
		querySelector: () => el(),
		querySelectorAll: () => [],
	});
	const sandbox = {
		window: {},
		document: { createElement: () => el(), body: { appendChild() {} }, addEventListener() {} },
		console,
	};
	vm.createContext(sandbox);
	for (const file of ['encrypted-fields.js', 'value-compare.js', 'linked-csv.js', 'csv-import.js'])
		vm.runInContext(readFileSync(new URL('../src/public/js/' + file, import.meta.url), 'utf8'), sandbox);
	vm.runInContext(src, sandbox);
	const api = sandbox.window.OrgLoom.canvasExportCsv.mount({
		canvasState: {
			bulkRecords: [],
			bulkSelectedIds: new Set(),
			currentCanvas: null,
			describeCache: { Account: { fields: [{ name: 'Secret__c', type: 'encryptedstring' }] } },
		},
		csrfFetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
		escapeHtml: (s) => String(s),
		showBulkToast: () => {},
		refreshCapabilities: async () => {},
	});
	T = api._test;
	T.clearFields = sandbox.window.OrgLoom.exportedClearFields;
	T.parseCsv = sandbox.window.OrgLoom.csvImport.mount({ csrfFetch: async () => ({ ok: true }) }).parseCsv;
	T.isRecordModified = sandbox.window.OrgLoom.valueCompare.isRecordModified;
});

test('CSV exports current values for existing, modified, and draft records, never old values', () => {
	const rows = T.exportRows([
		{
			objectName: 'Account',
			loadedFromId: '001000000000001AAA',
			values: { Name: 'Private original', Phone: '123' },
			loadedValues: { Name: 'Private original', Phone: '123' },
		},
		{
			objectName: 'Account',
			loadedFromId: '001000000000002AAA',
			values: { Name: 'Unchanged secret', Phone: '', Flag__c: false, Count__c: 0 },
			loadedValues: { Name: 'Unchanged secret', Phone: 'old phone', Flag__c: true, Count__c: 1 },
		},
		{ objectName: 'Account', values: { Name: 'New draft', Phone: '456' } },
	]);
	assert.deepEqual(JSON.parse(JSON.stringify(rows[0].values)), {
		Id: '001000000000001AAA',
		Name: 'Private original',
		Phone: '123',
	});
	assert.deepEqual(JSON.parse(JSON.stringify(rows[1].values)), {
		Id: '001000000000002AAA',
		Name: 'Unchanged secret',
		Phone: '',
		Flag__c: false,
		Count__c: 0,
	});
	assert.deepEqual([...rows[1].clears], ['Phone']);
	assert.equal(rows[2].values.Name, 'New draft');
	const csv = T.buildCsv(rows, T.orderFields(T.collectFieldUnion(rows)), [
		{ header: '__OrgLoom_ClearFields', get: (r) => JSON.stringify(r.clears) },
	]);
	assert.match(csv, /Private original/);
	assert.match(csv, /Unchanged secret/);
	assert.doesNotMatch(csv, /old phone/);
	assert.match(csv, /New draft/);
	assert.deepEqual([...T.clearFields({ headers: ['__OrgLoom_ClearFields'] }, ['["Phone"]'])], ['Phone']);
	assert.equal(T.clearFields({ headers: [] }, []).size, 0);
});

test('CSV excludes protected records, encrypted fields and internal fields', () => {
	const rows = T.exportRows([
		{
			objectName: 'Account',
			loadedFromId: '001000000000001AAA',
			values: {
				Name: 'Visible',
				Secret__c: 'secret',
				_cache: 'runtime',
				attributes: { url: 'internal' },
			},
		},
		{ objectName: 'Account', values: { Name: 'Cannot read' }, _inaccessible: true },
		{ objectName: 'Account', values: { Name: 'Cannot see' }, _permissionHidden: true },
		{ objectName: 'Account', values: { Name: 'Draft', Secret__c: 'draft secret' } },
	]);
	assert.equal(rows.length, 2);
	assert.deepEqual(JSON.parse(JSON.stringify(rows[0].values)), { Name: 'Visible', Id: '001000000000001AAA' });
	assert.deepEqual(JSON.parse(JSON.stringify(rows[1].values)), { Name: 'Draft' });
});

test('CSV preserves fields cleared by removing a value key', () => {
	const [row] = T.exportRows([
		{
			objectName: 'Account',
			loadedFromId: '001000000000001AAA',
			values: { Name: 'Current' },
			loadedValues: { Name: 'Current', Phone: '123' },
		},
	]);
	assert.equal(row.values.Phone, null);
	assert.deepEqual([...row.clears], ['Phone']);
});

describe('csvEscape: formula-injection guard', () => {
	test('prefixes an apostrophe on values starting with = + - @', () => {
		assert.equal(T.csvEscape('=HYPERLINK("x","y")'), '"\'=HYPERLINK(""x"",""y"")"');
		assert.equal(T.csvEscape('+1'), "'+1");
		assert.equal(T.csvEscape('-cmd'), "'-cmd");
		assert.equal(T.csvEscape('@SUM(A1)'), "'@SUM(A1)");
	});

	test('guards leading tab / CR that would shift the first visible char', () => {
		assert.equal(T.csvEscape('\t=cmd'), "'\t=cmd");
		assert.equal(T.csvEscape('\r=cmd'), '"\'\r=cmd"');
	});

	test('ordinary values are untouched (no spurious apostrophe)', () => {
		assert.equal(T.csvEscape('Acme Corp'), 'Acme Corp');
		assert.equal(T.csvEscape('casey@example.com'), 'casey@example.com'); // @ not leading
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
		assert.equal(T.csvEscape('=a,b'), '"\'=a,b"');
	});
});

describe('buildCsv', () => {
	const recs = [{ values: { Name: 'Acme', Note: '=DANGER' } }, { values: { Name: 'Beta, Inc', Note: 'ok' } }];
	test('emits BOM, CRLF rows, header + escaped cells', () => {
		const csv = T.buildCsv(recs, ['Name', 'Note'], []);
		assert.ok(csv.startsWith('﻿'), 'starts with UTF-8 BOM');
		const rows = csv.replace(/^﻿/, '').split('\r\n');
		assert.equal(rows[0], 'Name,Note,__OrgLoom_EscapedCells', 'header');
		assert.ok(rows[1].startsWith("Acme,'=DANGER,"), 'formula-guarded cell');
		assert.equal(rows[2], '"Beta, Inc",ok,', 'comma-quoted cell');
		assert.deepEqual([...T.parseCsv(csv).rows[0]], ['Acme', '=DANGER']);
	});
});

test('export and re-import preserve international phones without creating false record edits', () => {
	const phones = ['+1 602 555 0101', '+44 20 7946 0958', '602-555-0101', "'+1 555 0100", "O'Brien"];
	const records = phones.map((Phone, i) => {
		const values = { Id: '00300000000000' + i + 'AAA', Phone };
		return { objectName: 'Contact', loadedFromId: values.Id, values, loadedValues: { ...values } };
	});
	const csv = T.buildCsv(T.exportRows(records), ['Id', 'Phone'], []);
	assert.match(csv, /'\+1 602 555 0101/);
	const parsed = T.parseCsv(csv);
	assert.deepEqual([...parsed.headers], ['Id', 'Phone'], 'metadata is consumed before mapping');
	assert.equal(parsed.errors.length, 0);
	for (const [i, row] of parsed.rows.entries()) {
		assert.equal(row[1], phones[i]);
		assert.equal(T.isRecordModified({ ...records[i], values: { Id: row[0], Phone: row[1] } }), false);
	}
	const again = T.parseCsv(
		T.buildCsv(
			parsed.rows.map((row) => ({ values: { Id: row[0], Phone: row[1] } })),
			['Id', 'Phone'],
			[],
		),
	);
	assert.equal(
		JSON.stringify(again.rows),
		JSON.stringify(parsed.rows),
		'repeated exports do not accumulate apostrophes',
	);
});

test('all protected prefixes round-trip, including quoted and multiline values', () => {
	const values = ['=SUM(1,2)', '-123', '@name', '\t=cmd', '\r=cmd', '+say "hello"\nworld'];
	const csv = T.buildCsv(
		values.map((Note) => ({ values: { Note } })),
		['Note'],
		[],
	);
	const parsed = T.parseCsv(csv);
	assert.equal(parsed.errors.length, 0);
	assert.equal(JSON.stringify(parsed.rows.map((r) => r[0])), JSON.stringify(values));
});

test('escape metadata coexists with explicit field clears', () => {
	const csv = T.buildCsv(
		[{ values: { Phone: '+1 555', Name: null } }],
		['Phone', 'Name'],
		[{ header: '__OrgLoom_ClearFields', get: () => '["Name"]' }],
	);
	const file = T.parseCsv(csv);
	assert.equal(file.errors.length, 0);
	assert.deepEqual([...T.clearFields(file, file.rows[0])], ['Name']);
	assert.equal(file.rows[0][1], '+1 555');
});

describe('orderFields', () => {
	test('priority fields first (in list order), rest alphabetical', () => {
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
