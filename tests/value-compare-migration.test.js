import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const sandbox = { window: { OrgLoom: {} } };
vm.createContext(sandbox);
vm.runInContext(readFileSync(new URL('../src/public/js/value-compare.js', import.meta.url), 'utf8'), sandbox);
const { isRecordModified, relationshipChangesRecord } = sandbox.window.OrgLoom.valueCompare;

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

test('an unchanged existing child linked to a draft parent is pending an update', () => {
	const contact = {
		id: 'contact',
		objectName: 'Contact',
		loadedFromId: '003000000000001AAA',
		values: { LastName: 'Tester', AccountId: '001000000000001AAA' },
		loadedValues: { LastName: 'Tester', AccountId: '001000000000001AAA' },
	};
	const account = { id: 'account', objectName: 'Account', values: { Name: 'New parent' } };
	const associations = [{ fromId: 'contact', toId: 'account', fieldName: 'AccountId' }];

	assert.equal(isRecordModified(contact), false, 'field values alone are unchanged');
	assert.equal(relationshipChangesRecord(contact, associations, [account, contact]), true);
});

test('an association that mirrors the original existing parent is not a change', () => {
	const contact = {
		id: 'contact',
		loadedFromId: '003000000000001AAA',
		values: { AccountId: '001000000000001AAA' },
		loadedValues: { AccountId: '001000000000001AAA' },
	};
	const account = { id: 'account', loadedFromId: '001000000000001' };

	assert.equal(
		relationshipChangesRecord(
			contact,
			[{ fromId: 'contact', toId: 'account', fieldName: 'AccountId' }],
			[account, contact],
		),
		false,
	);
});

test('a draft-parent relationship remains a change when a legacy record lacks a loaded snapshot', () => {
	const contact = { id: 'contact', loadedFromId: '003000000000001AAA', values: {} };
	const account = { id: 'account', values: { Name: 'New parent' } };

	assert.equal(
		relationshipChangesRecord(
			contact,
			[{ fromId: 'contact', toId: 'account', fieldName: 'AccountId' }],
			[account, contact],
		),
		true,
	);
});
