import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/public/js/record-browse.js', import.meta.url), 'utf8');
const anchor = '\twindow.OrgLoom.recordBrowse = {';
assert.ok(source.includes(anchor), 'record-browse test injection anchor must remain available');
const instrumented = source.replace(anchor, '\twindow.__salesforceIdInList = _salesforceIdInList;\n\n' + anchor);
const context = { window: { OrgLoom: {} } };
vm.runInNewContext(instrumented, context);
const salesforceIdInList = context.window.__salesforceIdInList;

test('Browse builds an IN list only from 15- or 18-character Salesforce IDs', () => {
	assert.equal(
		salesforceIdInList(new Set(['001000000000001', '001000000000001AAA'])),
		"'001000000000001', '001000000000001AAA'",
	);
});

test('Browse rejects malformed and injection-shaped selected record IDs', () => {
	for (const id of ['001000000000001A', '001000000000001AA', "001000000000001' OR Name != ''", '00100000000000\\']) {
		assert.throws(() => salesforceIdInList(new Set([id])), /invalid Salesforce ID/);
	}
	assert.doesNotMatch(source, /String\(id\)\.replace/);
});
