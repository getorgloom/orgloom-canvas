import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
	isCompoundContainer,
	isRequiredOnCreate,
	isWritableForOperation,
	isPolymorphicReference,
} from '../src/sf-field-structure.js';
import { stripUnwritableFields } from '../src/sf-upload.js';
import { buildAiDescribeSummary, validateAiPlan } from '../src/ai-plan.js';
import { loadDescribeForObject } from '../src/sf-describe.js';

describe('Salesforce field-structure matrix', () => {
	const rows = [
		['Contact compound Name', { name: 'Name', type: 'string', createable: false, updateable: false, nillable: false }, false],
		['Contact LastName', { name: 'LastName', type: 'string', createable: true, updateable: true, nillable: false }, true],
		['compound address', { name: 'BillingAddress', type: 'address', createable: true, updateable: true, nillable: false }, false],
		['compound geolocation', { name: 'Location__c', type: 'location', createable: true, updateable: true, nillable: false }, false],
		['defaulted field', { name: 'Status', type: 'picklist', createable: true, updateable: true, nillable: false, defaultedOnCreate: true }, false],
		['formula field', { name: 'Score__c', type: 'double', createable: true, updateable: false, nillable: false, calculated: true }, false],
		['auto number', { name: 'Sequence__c', type: 'string', createable: true, updateable: false, nillable: false, autoNumber: true }, false],
	];

	for (const [label, field, required] of rows) {
		test(`${label}: required-on-create=${required}`, () => {
			assert.equal(isRequiredOnCreate(field), required);
		});
	}

	test('compound containers are never writable, but their constituents are', () => {
		const fields = [
			{ name: 'BillingAddress', type: 'address', createable: true, updateable: true },
			{ name: 'BillingStreet', type: 'string', compoundFieldName: 'BillingAddress', createable: true, updateable: true },
			{ name: 'Location__c', type: 'location', createable: true, updateable: true },
			{ name: 'Location__Latitude__s', type: 'double', compoundFieldName: 'Location__c', createable: true, updateable: true },
		];
		assert.equal(isCompoundContainer(fields[0]), true);
		assert.deepEqual(stripUnwritableFields({
			BillingAddress: {}, BillingStreet: '1 Main', Location__c: {}, Location__Latitude__s: 33.4,
		}, { fields }, false), { BillingStreet: '1 Main', Location__Latitude__s: 33.4 });
	});

	test('create/update/upsert respect asymmetric FLS', () => {
		const createOnly = { name: 'CreateOnly__c', type: 'string', createable: true, updateable: false };
		const updateOnly = { name: 'UpdateOnly__c', type: 'string', createable: false, updateable: true };
		assert.equal(isWritableForOperation(createOnly, 'create'), true);
		assert.equal(isWritableForOperation(createOnly, 'update'), false);
		assert.equal(isWritableForOperation(updateOnly, 'create'), false);
		assert.equal(isWritableForOperation(updateOnly, 'update'), true);
		assert.equal(isWritableForOperation(createOnly, 'upsert'), true);
		assert.equal(isWritableForOperation(updateOnly, 'upsert'), true);
	});

	test('polymorphic references accept listed target types and reject all others', () => {
		const describes = [
			{ name: 'Task', describe: { fields: [
				{ name: 'Subject', type: 'string', createable: true, nillable: false },
				{ name: 'WhoId', type: 'reference', createable: true, referenceTo: ['Contact', 'Lead'] },
			] } },
			{ name: 'Contact', describe: { fields: [{ name: 'LastName', type: 'string', createable: true, nillable: false }] } },
			{ name: 'Lead', describe: { fields: [{ name: 'LastName', type: 'string', createable: true, nillable: false }] } },
			{ name: 'Account', describe: { fields: [{ name: 'Name', type: 'string', createable: true, nillable: false }] } },
		];
		assert.equal(isPolymorphicReference(describes[0].describe.fields[1]), true);
		const baseRecords = [
			{ tempId: 1, objectName: 'Task', values: { Subject: 'Follow up' } },
			{ tempId: 2, objectName: 'Contact', values: { LastName: 'C' } },
			{ tempId: 3, objectName: 'Lead', values: { LastName: 'L' } },
			{ tempId: 4, objectName: 'Account', values: { Name: 'A' } },
		];
		const result = validateAiPlan({ records: baseRecords, associations: [
			{ fromTempId: 1, toTempId: 2, fieldName: 'WhoId' },
			{ fromTempId: 1, toTempId: 3, fieldName: 'WhoId' },
			{ fromTempId: 1, toTempId: 4, fieldName: 'WhoId' },
		] }, describes);
		assert.equal(result.associations.length, 2);
		assert.match(result.warnings.join('\n'), /target type mismatch/);
	});

	test('AI summary never marks non-createable/defaulted/compound/server-managed fields required', () => {
		const fields = rows.map(([, field]) => field);
		const summary = buildAiDescribeSummary([{ name: 'Fixture__c', describe: { fields } }]);
		assert.match(summary, /LastName: string REQUIRED/);
		assert.doesNotMatch(summary, /\n  - Name:/);
		assert.doesNotMatch(summary, /BillingAddress/);
		assert.doesNotMatch(summary, /Location__c/);
		assert.doesNotMatch(summary, /Status: picklist REQUIRED/);
		assert.doesNotMatch(summary, /Score__c: double REQUIRED/);
		assert.doesNotMatch(summary, /Sequence__c: string REQUIRED/);
	});

	test('projected describes preserve record-type, dependency, indirect-lookup, and master-detail metadata', async () => {
		const fields = [
			{ name: 'Controller__c', type: 'picklist', createable: true, updateable: true, nillable: true,
				picklistValues: [{ label: 'A', value: 'A', active: true }] },
			{ name: 'Dependent__c', type: 'picklist', createable: true, updateable: true, nillable: true,
				dependentPicklist: true, controllerName: 'Controller__c', restrictedPicklist: true,
				picklistValues: [{ label: 'A1', value: 'A1', active: true, validFor: 'gA==' }] },
			{ name: 'ExternalParent__c', type: 'reference', createable: true, updateable: true, nillable: true,
				referenceTo: ['ExternalParent__x'], referenceTargetField: 'External_Key__c' },
			{ name: 'Master__c', type: 'reference', createable: true, updateable: false, nillable: false,
				referenceTo: ['Account'], reparentableMasterDetail: false },
		];
		const conn = {
			version: '60.0',
			sobject: () => ({ describe: async () => ({
				name: 'Fixture__c', label: 'Fixture', createable: true, updateable: true, queryable: true,
				fields, recordTypeInfos: [],
			}) }),
			request: async () => ({ defaultRecordTypeId: null, fields: {}, recordTypeInfos: {} }),
		};
		const projected = await loadDescribeForObject(conn, 'Fixture__c');
		const byName = new Map(projected.fields.map((field) => [field.name, field]));
		assert.equal(byName.get('Dependent__c').controllerName, 'Controller__c');
		assert.equal(byName.get('Dependent__c').restrictedPicklist, true);
		assert.deepEqual(byName.get('Dependent__c').picklistValues[0].validFor, [0]);
		assert.equal(byName.get('ExternalParent__c').referenceTargetField, 'External_Key__c');
		assert.equal(byName.get('Master__c').reparentableMasterDetail, false);
		assert.equal(byName.get('Master__c').required, true);
	});
});
