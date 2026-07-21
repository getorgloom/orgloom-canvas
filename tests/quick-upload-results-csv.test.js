import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const uploadSource = fs.readFileSync(path.resolve(here, '../src/public/js/upload-modal.js'), 'utf8');
const linkedCsvSource = fs.readFileSync(path.resolve(here, '../src/public/js/linked-csv.js'), 'utf8');
const context = { window: { OrgLoom: {} } };
vm.runInNewContext(uploadSource, context);

test('Quick Upload result CSV identifies source rows, created records, and failures', () => {
	const csv = context.window.OrgLoom.uploadModal.buildUploadResultsCsv(
		[
			{ tempId: 10, objectName: 'Account', success: true, id: '001xx', mode: 'create' },
			{ tempId: 11, objectName: 'Contact', success: false, error: 'Required field missing' },
		],
		[
			{ id: 10, _csvSourceFile: 'Accounts.csv', _csvSourceRow: 2 },
			{ id: 11, _csvSourceFile: 'Contacts.csv', _csvSourceRow: 4 },
		],
	);

	assert.equal(
		csv,
		'"Source file","CSV row","Object","Status","Salesforce ID","Error"\r\n' +
			'"Accounts.csv","2","Account","Created","001xx",""\r\n' +
			'"Contacts.csv","4","Contact","Failed","","Required field missing"\r\n',
	);
});

test('Quick Upload result CSV escapes quotes and neutralizes spreadsheet formulas', () => {
	const csv = context.window.OrgLoom.uploadModal.buildUploadResultsCsv(
		[{ tempId: 1, objectName: 'Contact', success: false, error: '=HYPERLINK("bad")' }],
		[{ id: 1, _csvSourceFile: '+input.csv', _csvSourceRow: 2 }],
	);

	assert.match(csv, /"'\+input\.csv"/);
	assert.match(csv, /"'=HYPERLINK\(""bad""\)"/);
});

test('Quick Upload tracks original file and one-based CSV line number and renders the report action', () => {
	assert.match(linkedCsvSource, /rec\._csvSourceFile = file\.name/);
	assert.match(linkedCsvSource, /rec\._csvSourceRow = rowIdx \+ 2/);
	assert.match(uploadSource, /Download CSV report/);
	assert.match(uploadSource, /org-loom-quick-upload-results-/);
});

test('the result report action is the leftmost upload-modal footer action', () => {
	assert.match(
		uploadSource,
		/<div class="modal-footer">[\s\S]*?id="upload-results-csv"[\s\S]*?id="upload-cancel"[\s\S]*?id="upload-confirm"/,
	);
	assert.match(uploadSource, /id="upload-results-csv" hidden style="margin-right:auto"/);
	assert.match(uploadSource, /resultsCsvBtn\.hidden = false/);
	assert.match(uploadSource, /resetResultsCsvAction\(\)/);
});
