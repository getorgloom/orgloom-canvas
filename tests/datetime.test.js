import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/public/js/datetime.js', import.meta.url), 'utf8');
const sandbox = { window: { OrgLoom: {}, SF_USER_TIME_ZONE: 'America/Los_Angeles' }, Intl, Date, Set };
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const datetime = sandbox.window.OrgLoom.datetime;

test('Salesforce UTC instants display as wall time in the Salesforce user timezone', () => {
	assert.equal(datetime.toDateTimeLocal('2026-01-15T20:30:00.000Z'), '2026-01-15T12:30');
	assert.equal(datetime.toDateTimeLocal('2026-07-15T19:30:00.000Z'), '2026-07-15T12:30');
});

test('edited Salesforce wall time converts back to a UTC instant across DST offsets', () => {
	assert.equal(datetime.fromDateTimeLocal('2026-01-15T12:30'), '2026-01-15T20:30:00.000Z');
	assert.equal(datetime.fromDateTimeLocal('2026-07-15T12:30'), '2026-07-15T19:30:00.000Z');
});

test('a nonexistent daylight-saving wall time is rejected instead of silently shifted', () => {
	assert.equal(datetime.fromDateTimeLocal('2026-03-08T02:30'), null);
});

test('an explicit timezone overrides the connected Salesforce user timezone', () => {
	assert.equal(datetime.toDateTimeLocal('2026-07-15T19:30:00.000Z', 'America/Phoenix'), '2026-07-15T12:30');
});
