import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const sandbox = { window: { OrgLoom: {} } };
vm.createContext(sandbox);
vm.runInContext(
	readFileSync(new URL('../src/public/js/value-compare.js', import.meta.url), 'utf8'),
	sandbox,
);
const { isRecordModified } = sandbox.window.OrgLoom.valueCompare;

test('a cross-org matched record uploads once even without local source edits', () => {
	const rec = {
		loadedFromId: '001TARGET',
		_migrateMatchedId: '001TARGET',
		values: { Name: 'Acme' },
		loadedValues: { Name: 'Acme' },
	};
	assert.equal(isRecordModified(rec), true);

	delete rec._migrateMatchedId;
	assert.equal(isRecordModified(rec), false);
});
