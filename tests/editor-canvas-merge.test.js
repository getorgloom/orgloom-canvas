import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeEditorCanvasPayload } from '../src/slot-helpers.js';

function access(fields, overrides = {}) {
	return {
		visible: true,
		queryable: true,
		createable: true,
		updateable: true,
		fields: new Map(fields.map((field) => [field.name, field])),
		...overrides,
	};
}

test('editor save preserves hidden records and fields while applying writable changes', () => {
	const source = {
		schema: {
			objects: [
				{
					name: 'Account',
					draftFields: [
						{ name: 'Name', createable: true, updateable: true },
						{ name: 'Secret__c', createable: true, updateable: true },
					],
				},
				{ name: 'Secret_Object__c', draftFields: [{ name: 'Name' }] },
			],
		},
		loadedRecords: [
			{
				canvasRecordId: 'account-card',
				loadedFromId: '001000000000001AAA',
				objectName: 'Account',
				x: 10,
				y: 20,
				changes: { Name: 'Before', Secret__c: 'owner only' },
			},
			{
				canvasRecordId: 'secret-card',
				loadedFromId: 'a00000000000001AAA',
				objectName: 'Secret_Object__c',
				x: 30,
				y: 40,
			},
		],
		drafts: [],
		associations: [],
	};
	const baseline = {
		schema: { objects: [{ name: 'Account', draftFields: [{ name: 'Name' }] }] },
		loadedRecords: [
			{
				canvasRecordId: 'account-card',
				loadedFromId: '001000000000001AAA',
				objectName: 'Account',
				x: 10,
				y: 20,
				changes: { Name: 'Before' },
			},
		],
		drafts: [],
		associations: [],
	};
	const submitted = structuredClone(baseline);
	submitted.loadedRecords[0].x = 75;
	submitted.loadedRecords[0].changes = { Name: 'After', Secret__c: 'spoofed' };
	const merged = mergeEditorCanvasPayload({
		source,
		baseline,
		submitted,
		accessByObject: new Map([['Account', access([{ name: 'Name', updateable: true, createable: true }])]]),
	});

	assert.equal(merged.loadedRecords.length, 2);
	assert.equal(merged.loadedRecords[0].x, 75);
	assert.deepEqual(merged.loadedRecords[0].changes, {
		Name: 'After',
		Secret__c: 'owner only',
	});
	assert.equal(merged.loadedRecords[1].canvasRecordId, 'secret-card');
	assert.equal(
		merged.schema.objects.some((object) => object.name === 'Secret_Object__c'),
		true,
	);
});

test('editor save removes visible content but preserves hidden relationships', () => {
	const account = {
		canvasRecordId: 'account-card',
		tempId: 'draft-account',
		objectName: 'Account',
		values: { Name: 'Visible' },
	};
	const contact = {
		canvasRecordId: 'contact-card',
		tempId: 'draft-contact',
		objectName: 'Contact',
		values: { LastName: 'Visible', AccountId: 'draft-account' },
	};
	const hidden = {
		canvasRecordId: 'hidden-card',
		tempId: 'draft-hidden',
		objectName: 'Hidden__c',
		values: { Name: 'Hidden' },
	};
	const visibleLink = {
		from: { kind: 'draft', ref: 'draft-contact' },
		to: { kind: 'draft', ref: 'draft-account' },
		fieldName: 'AccountId',
	};
	const hiddenLink = {
		from: { kind: 'draft', ref: 'draft-hidden' },
		to: { kind: 'draft', ref: 'draft-account' },
		fieldName: 'Account__c',
	};
	const source = {
		schema: { objects: [] },
		loadedRecords: [],
		drafts: [account, contact, hidden],
		associations: [visibleLink, hiddenLink],
	};
	const baseline = {
		schema: { objects: [] },
		loadedRecords: [],
		drafts: [account, contact],
		associations: [visibleLink],
	};
	const submitted = {
		schema: { objects: [] },
		loadedRecords: [],
		drafts: [contact],
		associations: [],
	};
	const merged = mergeEditorCanvasPayload({
		source,
		baseline,
		submitted,
		accessByObject: new Map([
			['Account', access([{ name: 'Name', createable: true, updateable: true }])],
			[
				'Contact',
				access([
					{ name: 'LastName', createable: true, updateable: true },
					{ name: 'AccountId', createable: true, updateable: true },
				]),
			],
		]),
	});

	assert.deepEqual(
		merged.drafts.map((record) => record.canvasRecordId),
		['contact-card', 'hidden-card'],
	);
	assert.deepEqual(merged.associations, [hiddenLink]);
});

test('editor save accepts only accessible createable fields on new drafts', () => {
	const submitted = {
		schema: { objects: [{ name: 'Account' }] },
		loadedRecords: [],
		drafts: [
			{
				canvasRecordId: 'new-account',
				tempId: 'draft-new',
				objectName: 'Account',
				values: { Name: 'Allowed', OwnerId: 'spoofed' },
			},
		],
		associations: [],
	};
	const merged = mergeEditorCanvasPayload({
		source: { schema: { objects: [] }, loadedRecords: [], drafts: [], associations: [] },
		baseline: { schema: { objects: [] }, loadedRecords: [], drafts: [], associations: [] },
		submitted,
		accessByObject: new Map([
			[
				'Account',
				access([
					{ name: 'Name', createable: true, updateable: true },
					{ name: 'OwnerId', createable: false, updateable: false },
				]),
			],
		]),
	});

	assert.deepEqual(merged.drafts[0].values, { Name: 'Allowed' });
});

test('editor save cannot request or submit encrypted fields', () => {
	const submitted = {
		schema: { objects: [{ name: 'Account' }] },
		loadedRecords: [],
		drafts: [
			{
				canvasRecordId: 'new-account',
				tempId: 'draft-new',
				objectName: 'Account',
				values: { Name: 'Allowed', Secret__c: 'spoofed' },
				slot: { slotId: 'field-request', kind: 'fields', fields: ['Name', 'Secret__c'] },
			},
		],
		associations: [],
	};
	const merged = mergeEditorCanvasPayload({
		source: { schema: { objects: [] }, loadedRecords: [], drafts: [], associations: [] },
		baseline: { schema: { objects: [] }, loadedRecords: [], drafts: [], associations: [] },
		submitted,
		accessByObject: new Map([
			[
				'Account',
				access(
					[
						{ name: 'Name', type: 'string', createable: true, updateable: true },
						{ name: 'Secret__c', type: 'encryptedstring', createable: true, updateable: true },
					],
					{ encryptedFields: new Set(['Secret__c']) },
				),
			],
		]),
	});

	assert.deepEqual(merged.drafts[0].values, { Name: 'Allowed' });
	assert.deepEqual(merged.drafts[0].slot.fields, ['Name']);
});
