import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../src/public/js/linked-csv.js'), 'utf8');
const window = {};
vm.runInNewContext(source, { window, Set, Map });
const policy = window.OrgLoom.linkedCsv._test;

test('CSV field policy uses create access for new rows and edit access for existing rows', () => {
	const createOnly = { createable: true, updateable: false };
	const updateOnly = { createable: false, updateable: true };

	assert.equal(policy.csvFieldDisposition(createOnly, 'create'), 'write');
	assert.equal(policy.csvFieldDisposition(createOnly, 'update'), 'context');
	assert.equal(policy.csvFieldDisposition(updateOnly, 'create'), 'warn');
	assert.equal(policy.csvFieldDisposition(updateOnly, 'update'), 'write');
});

test('read-only Salesforce output fields remain context without producing a write warning', () => {
	assert.equal(policy.csvFieldDisposition({ calculated: true, createable: false, updateable: false }, 'create'), 'context');
	assert.equal(policy.csvFieldDisposition({ autoNumber: true, createable: false, updateable: false }, 'create'), 'context');
	assert.equal(policy.csvFieldDisposition({ type: 'address', createable: false, updateable: false }, 'update'), 'context');
});

test('upsert accepts a field writable on either branch and warns when neither branch can write it', () => {
	assert.equal(policy.csvFieldDisposition({ createable: true, updateable: false }, 'upsert'), 'write');
	assert.equal(policy.csvFieldDisposition({ createable: false, updateable: true }, 'upsert'), 'write');
	assert.equal(policy.csvFieldDisposition({ createable: false, updateable: false }, 'upsert'), 'warn');
});

test('resolved Salesforce Ids classify as updates while missing Ids remain creates', () => {
	const idResolution = { liveById: new Map([['001000000000001', {}]]) };
	assert.equal(policy.csvRowOperation({ operation: 'insert' }, '001000000000001AAA', idResolution), 'update');
	assert.equal(policy.csvRowOperation({ operation: 'insert' }, '001000000000002AAA', idResolution), 'create');
	assert.equal(policy.csvRowOperation({ operation: 'upsert' }, '001000000000001AAA', idResolution), 'upsert');
});

test('mapping choices describe field access without assuming every row is a create', () => {
	assert.equal(policy.csvFieldAccessSuffix({ name: 'Name', createable: true, updateable: true }), '');
	assert.equal(policy.csvFieldAccessSuffix({ name: 'Formula__c', createable: false, updateable: false }), ' - read only');
	assert.equal(policy.csvFieldAccessSuffix({ name: 'Create_Only__c', createable: true, updateable: false }), ' - new records only');
	assert.equal(policy.csvFieldAccessSuffix({ name: 'Update_Only__c', createable: false, updateable: true }), ' - existing records only');
});
