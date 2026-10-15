import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/public/js/record-browse.js', import.meta.url), 'utf8');
const anchor = '\twindow.OrgLoom.recordBrowse = {';
assert.ok(source.includes(anchor), 'record-browse test injection anchor must remain available');

const instrumented = source.replace(
	anchor,
	'\twindow.__datetimeLocalToIso = _datetimeLocalToIso;\n' +
		'\twindow.__updateFilterValueFromInput = _updateFilterValueFromInput;\n\n' +
		anchor,
);
const context = { window: { OrgLoom: {} } };
vm.runInNewContext(instrumented, context);
const datetimeLocalToIso = context.window.__datetimeLocalToIso;
const updateFilterValueFromInput = context.window.__updateFilterValueFromInput;

test('Browse serializes datetime-local values as complete UTC instants', () => {
	const localValue = '2026-07-19T00:00';
	const result = datetimeLocalToIso(localValue);
	assert.match(result, /^2026-07-19T\d{2}:00:00\.000Z$/);
	assert.equal(Date.parse(result), new Date(localValue).getTime());
});

test('Browse leaves malformed datetime values for server-side rejection', () => {
	assert.equal(datetimeLocalToIso('not-a-date'), 'not-a-date');
});

test('changing a filter operator does not overwrite its datetime value', () => {
	const filter = { op: 'equals', value: '2026-07-19T00:00' };
	const operatorControl = {
		value: 'notEquals',
		classList: { contains: (name) => name === 'rb-filter-op' },
	};

	assert.equal(updateFilterValueFromInput(filter, operatorControl), false);
	assert.equal(filter.value, '2026-07-19T00:00');
});

test('the actual filter value input still updates filter state', () => {
	const filter = { op: 'equals', value: '2026-07-19T00:00' };
	const valueControl = {
		value: '2026-07-20T00:00',
		classList: { contains: (name) => name === 'rb-filter-value' },
	};

	assert.equal(updateFilterValueFromInput(filter, valueControl), true);
	assert.equal(filter.value, '2026-07-20T00:00');
});
