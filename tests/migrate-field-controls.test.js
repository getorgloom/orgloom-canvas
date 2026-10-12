import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';

const source = readFileSync(new URL('../src/public/js/migrate-match.js', import.meta.url), 'utf8');
const functions = new Map();
function visit(node) {
	if (!node || typeof node !== 'object') {
		return;
	}
	if (node.type === 'FunctionDeclaration') {
		functions.set(node.id.name, source.slice(node.start, node.end));
	}
	for (const value of Object.values(node)) {
		if (Array.isArray(value)) {
			value.forEach(visit);
		} else if (value && typeof value === 'object') {
			visit(value);
		}
	}
}
visit(parse(source, { ecmaVersion: 'latest' }));

// Execute the actual private render helpers, with their surrounding state supplied explicitly.
function harness(field, annotation = {}) {
	const context = vm.createContext({
		canvasState: { describeCache: { Account: { defaultRecordTypeId: 'default-type' } } },
		_annotationFor: () => annotation,
		_fieldFor: () => field,
		_picklistValuesForRecordType: (_field, recordType) => {
			assert.equal(recordType, annotation.resolvedRecordTypeId || 'default-type');
			return [
				{ value: 'Open', active: true },
				{ value: 'Old', active: false },
			];
		},
		escapeHtml: (value) => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;'),
		window: { OrgLoom: { datetime: { toDateTimeLocal: () => '2026-09-10T09:30' } } },
	});
	for (const name of ['_lookup', '_dateTimeForInput', '_effectiveRecordTypeId', '_requiredFieldControl']) {
		assert.ok(functions.has(name), name);
		vm.runInContext(functions.get(name), context);
	}
	return context;
}

test('migration record type resolution uses the annotation, then destination default, then null', () => {
	const rec = { objectName: 'Account' };
	assert.equal(harness({}, { resolvedRecordTypeId: 'mapped-type' })._effectiveRecordTypeId(rec), 'mapped-type');
	const context = harness({});
	assert.equal(context._effectiveRecordTypeId(rec), 'default-type');
	assert.equal(context._effectiveRecordTypeId({ objectName: 'Other' }), null);
});

test('migration required field controls render empty, text, zero, date and datetime values', () => {
	for (const [type, value, expected] of [
		['string', undefined, null],
		['string', 'A "name"', 'A &quot;name&quot;'],
		['currency', 0, '0'],
		['date', '2026-09-10', '2026-09-10'],
		['datetime', '2026-09-10T16:30:00.000Z', '2026-09-10T09:30'],
	]) {
		const context = harness({ name: 'Required__c', type });
		const html = context._requiredFieldControl(
			{ objectName: 'Account', values: { Required__c: value } },
			{ field: 'Required__c' },
			0,
		);
		assert.ok(html.includes('data-mm-required-field="Required__c"'));
		if (expected === null) {
			assert.ok(!html.includes(' value='));
		} else {
			assert.ok(html.includes(' value="' + expected + '"'), html);
		}
		if (type === 'datetime') {
			assert.ok(html.includes('type="datetime-local"'));
		}
	}
});

test('migration required picklists use destination record type and preserve selection', () => {
	const context = harness({ name: 'Stage__c', type: 'picklist' }, { resolvedRecordTypeId: 'mapped-type' });
	const html = context._requiredFieldControl(
		{ objectName: 'Account', values: { Stage__c: 'Open' } },
		{ field: 'Stage__c' },
		0,
	);
	assert.ok(html.includes('<option value="Open" selected>'));
	assert.ok(!html.includes('Old'));
});
