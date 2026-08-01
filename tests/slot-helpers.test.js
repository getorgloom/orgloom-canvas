import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
	stripDraftsForNonOwner,
	stripDraftValuesForSave,
	applySlotFieldFilter,
	slotKind,
	slotProgress,
	aggregateSlotProgress,
	slotProgressClass,
	applyContributionsToPayload,
	projectSharedCanvasPayload,
	projectSharedRelationshipsByVisibility,
	hiddenCanvasRecordId,
} from '../src/slot-helpers.js';

describe('slotKind', () => {
	test('returns null for missing slot', () => {
		assert.equal(slotKind(null), null);
		assert.equal(slotKind(undefined), null);
	});

	test('defaults missing kind to whole-record (back-compat)', () => {
		assert.equal(slotKind({ slotId: 1 }), 'whole-record');
	});

	test('returns explicit kind verbatim', () => {
		assert.equal(slotKind({ slotId: 1, kind: 'fields' }), 'fields');
		assert.equal(slotKind({ slotId: 1, kind: 'whole-record' }), 'whole-record');
	});
});

describe('stripDraftsForNonOwner', () => {
	test('preserves draft values + structure + slot', () => {
		const out = stripDraftsForNonOwner({
			drafts: [
				{
					tempId: 't1',
					objectName: 'Account',
					x: 10,
					y: 20,
					values: { Name: 'Acme' },
					slot: { slotId: 1, label: 'Customer' },
				},
			],
			loadedRecords: [],
		});
		assert.equal(out.drafts.length, 1);
		assert.equal(out.drafts[0].tempId, 't1');
		assert.equal(out.drafts[0].objectName, 'Account');
		assert.equal(out.drafts[0].x, 10);
		assert.equal(out.drafts[0].y, 20);
		assert.deepEqual(out.drafts[0].values, { Name: 'Acme' });
		assert.deepEqual(out.drafts[0].slot, { slotId: 1, label: 'Customer' });
	});

	test('drafts with no values default to empty object', () => {
		const out = stripDraftsForNonOwner({
			drafts: [{ tempId: 't1', objectName: 'Account', x: 0, y: 0 }],
			loadedRecords: [],
		});
		assert.deepEqual(out.drafts[0].values, {});
	});

	test('whole-record slots on loaded records become identity-free request drafts', () => {
		const out = stripDraftsForNonOwner({
			drafts: [],
			loadedRecords: [
				{
					objectName: 'Account',
					x: 0,
					y: 0,
					loadedFromId: '001ABC',
					slot: { slotId: 5, kind: 'whole-record', label: 'Slot' },
				},
			],
		});
		assert.equal(out.loadedRecords.length, 0);
		assert.equal(out.drafts.length, 1);
		assert.equal(out.drafts[0].tempId, 'slot-request-5');
		assert.equal(out.drafts[0].loadedFromId, undefined);
		assert.deepEqual(out.drafts[0].values, {});
		assert.deepEqual(out.drafts[0].slot, { slotId: 5, kind: 'whole-record', label: 'Slot' });
	});

	test('legacy loaded slots are also projected as standalone request drafts', () => {
		const out = stripDraftsForNonOwner({
			drafts: [],
			loadedRecords: [
				{ objectName: 'Account', x: 0, y: 0, loadedFromId: '001LEGACY', slot: { slotId: 6, label: 'Old' } },
			],
		});
		assert.equal(out.loadedRecords.length, 0);
		assert.equal(out.drafts[0].tempId, 'slot-request-6');
		assert.equal(out.drafts[0].loadedFromId, undefined);
	});

	test('field-level slot loaded records: KEEPS loadedFromId', () => {
		const out = stripDraftsForNonOwner({
			drafts: [],
			loadedRecords: [
				{
					objectName: 'Opportunity',
					x: 100,
					y: 200,
					loadedFromId: '006FIELDS',
					slot: { slotId: 7, kind: 'fields', fields: ['StageName', 'CloseDate'], label: 'Update' },
				},
			],
		});
		assert.equal(out.loadedRecords[0].loadedFromId, '006FIELDS');
		assert.equal(out.loadedRecords[0].x, 100);
		assert.equal(out.loadedRecords[0].y, 200);
		assert.deepEqual(out.loadedRecords[0].slot.fields, ['StageName', 'CloseDate']);
	});

	test('non-slot loaded records pass through unchanged', () => {
		const out = stripDraftsForNonOwner({
			drafts: [],
			loadedRecords: [{ objectName: 'Account', x: 0, y: 0, loadedFromId: '001PLAIN' }],
		});
		assert.equal(out.loadedRecords[0].loadedFromId, '001PLAIN');
	});

	test('handles empty payload + missing arrays', () => {
		assert.deepEqual(stripDraftsForNonOwner({}), { drafts: [], loadedRecords: [] });
		assert.deepEqual(stripDraftsForNonOwner(null), { drafts: [], loadedRecords: [] });
	});
});

describe('stripDraftValuesForSave', () => {
	test('preserves drafts with values (identity pass-through)', () => {
		const input = {
			drafts: [
				{
					tempId: 't1',
					objectName: 'Account',
					x: 10,
					y: 20,
					values: { Name: 'Acme', Phone: '555' },
					slot: { slotId: 7, label: 'Lead' },
				},
				{ tempId: 't2', objectName: 'Contact', x: 30, y: 40, values: { Email: 'a@b.c' } },
			],
		};
		const out = stripDraftValuesForSave(input);
		assert.equal(out, input);
		assert.deepEqual(out.drafts[0].values, { Name: 'Acme', Phone: '555' });
		assert.deepEqual(out.drafts[1].values, { Email: 'a@b.c' });
	});

	test('does not touch loadedRecords', () => {
		const input = {
			loadedRecords: [{ tempId: 'r1', objectName: 'Account', loadedFromId: '001abc', values: { Name: 'Acme' } }],
			drafts: [],
		};
		const out = stripDraftValuesForSave(input);
		assert.deepEqual(out.loadedRecords, input.loadedRecords);
	});

	test('does not mutate the input', () => {
		const input = {
			drafts: [{ tempId: 't1', objectName: 'Account', values: { Name: 'Acme' } }],
		};
		const before = JSON.stringify(input);
		stripDraftValuesForSave(input);
		assert.equal(JSON.stringify(input), before);
	});

	test('passes through null / undefined / no-drafts payloads', () => {
		assert.equal(stripDraftValuesForSave(null), null);
		assert.equal(stripDraftValuesForSave(undefined), undefined);
		const noDrafts = { loadedRecords: [], _meta: { savedAt: 'x' } };
		assert.equal(stripDraftValuesForSave(noDrafts), noDrafts);
	});

	test('preserves _meta and other top-level fields', () => {
		const input = {
			drafts: [{ tempId: 't1', objectName: 'Account', values: { Name: 'Acme' } }],
			_meta: { savedAt: '2026-01-01T00:00:00Z' },
			associations: [{ from: 'a', to: 'b' }],
		};
		const out = stripDraftValuesForSave(input);
		assert.deepEqual(out._meta, { savedAt: '2026-01-01T00:00:00Z' });
		assert.deepEqual(out.associations, [{ from: 'a', to: 'b' }]);
		assert.deepEqual(out.drafts[0].values, { Name: 'Acme' });
	});
});

describe('canvas contributions', () => {
	test('merges draft values and existing-record changes into their persisted shapes', () => {
		const payload = {
			loadedRecords: [
				{
					loadedFromId: '001000000000001AAA',
					objectName: 'Account',
					changes: { Name: 'Before' },
					slot: { slotId: 'existing', kind: 'fields', fields: ['Name'], assigneeSfUserId: '005USER' },
				},
			],
			drafts: [
				{
					tempId: 7,
					objectName: 'Contact',
					values: { LastName: 'Before' },
					slot: { slotId: 'draft', kind: 'fields', fields: ['LastName'], assigneeSfUserId: '005USER' },
				},
			],
		};
		const result = applyContributionsToPayload(payload, [
			{
				id: 'a01000000000001AAA',
				contributorSfUserId: '005USER',
				fill: { slotId: 'existing', values: { Name: 'After', Phone: 'blocked' } },
			},
			{
				id: 'a01000000000002AAA',
				contributorSfUserId: '005USER',
				fill: { slotId: 'draft', values: { LastName: 'After', Email: 'blocked@example.com' } },
			},
		]);

		assert.deepEqual(result.appliedContributionIds, ['a01000000000001AAA', 'a01000000000002AAA']);
		assert.deepEqual(result.payload.loadedRecords[0].changes, { Name: 'After' });
		assert.equal(result.payload.loadedRecords[0].values, undefined);
		assert.deepEqual(result.payload.drafts[0].values, { LastName: 'After' });
		assert.deepEqual(payload.loadedRecords[0].changes, { Name: 'Before' });
		assert.deepEqual(payload.drafts[0].values, { LastName: 'Before' });
	});

	test('rejects a stale assignment instead of applying it to the owner canvas', () => {
		const result = applyContributionsToPayload(
			{
				loadedRecords: [],
				drafts: [
					{
						tempId: 1,
						objectName: 'Account',
						values: {},
						slot: { slotId: 's1', assigneeSfUserId: '005NEW' },
					},
				],
			},
			[
				{
					id: 'a01000000000003AAA',
					contributorSfUserId: '005OLD',
					fill: { slotId: 's1', values: { Name: 'Not applied' } },
				},
			],
		);
		assert.deepEqual(result.appliedContributionIds, []);
		assert.equal(result.skipped[0].reason, 'not_assigned_to_you');
		assert.equal(result.skipped[0].contributionId, 'a01000000000003AAA');
		assert.deepEqual(result.payload.drafts[0].values, {});
	});

	test('turns a submitted whole-record request into a draft and preserves its relationships', () => {
		const result = applyContributionsToPayload(
			{
				loadedRecords: [],
				drafts: [
					{
						tempId: 'requested-account',
						objectName: 'Account',
						values: {},
						slot: {
							slotId: 'new-account',
							kind: 'whole-record',
							origin: 'standalone',
							assigneeSfUserId: '005USER',
						},
					},
					{ tempId: 'related-contact', objectName: 'Contact', values: { LastName: 'Contact' } },
				],
				associations: [
					{
						from: { kind: 'draft', ref: 'related-contact' },
						to: { kind: 'slot', ref: 'new-account' },
						fieldName: 'AccountId',
					},
				],
			},
			[
				{
					id: 'a01000000000004AAA',
					contributorSfUserId: '005USER',
					fill: { slotId: 'new-account', values: { Name: 'Completed account' } },
				},
			],
		);

		assert.deepEqual(result.appliedContributionIds, ['a01000000000004AAA']);
		assert.deepEqual(result.payload.drafts[0].values, { Name: 'Completed account' });
		assert.equal(result.payload.drafts[0].slot, undefined);
		assert.deepEqual(result.payload.associations[0].to, {
			kind: 'draft',
			ref: 'requested-account',
		});
	});
});

describe('shared canvas projection', () => {
	test('keeps hidden placeholders linear and stable across repeated restricted projections', () => {
		const access = new Map([
			['Account', { visible: false, queryable: false, readableFields: new Set(), fields: new Map() }],
		]);
		const payload = {
			loadedRecords: [],
			drafts: [],
			associations: [],
			schema: { objects: [{ name: 'Account', label: 'Account' }] },
		};

		for (let count = 1; count <= 3; count++) {
			payload.drafts.push({
				tempId: 'draft-' + count,
				canvasRecordId: 'account-card-' + count,
				objectName: 'Account',
				x: count * 10,
				y: count * 20,
				values: { Name: 'Restricted ' + count },
			});
			const projected = projectSharedCanvasPayload(payload, access);
			assert.equal(projected.hiddenRecords.length, count);
			assert.deepEqual(
				projected.hiddenRecords.map((record) => record.hiddenId),
				Array.from({ length: count }, (_, index) => hiddenCanvasRecordId('account-card-' + (index + 1))),
			);
			assert.equal(JSON.stringify(projected).includes('account-card-'), false);
		}

		const once = projectSharedCanvasPayload(payload, access);
		const repeated = projectSharedCanvasPayload(
			{
				...once,
				hiddenRecords: [...once.hiddenRecords, once.hiddenRecords[0]],
			},
			access,
		);
		assert.equal(repeated.hiddenRecords.length, 3);
	});

	test('shows a legacy loaded record request without exposing its Salesforce record identity', () => {
		const sourceRecordId = '001000000000099AAA';
		const safePayload = stripDraftsForNonOwner({
			loadedRecords: [
				{
					objectName: 'Account',
					loadedFromId: sourceRecordId,
					x: 42,
					y: 84,
					values: { Name: 'Owner-only source record' },
					slot: { slotId: 'request-account', kind: 'whole-record', label: 'New customer' },
				},
			],
			drafts: [],
			associations: [],
			schema: { objects: [{ name: 'Account', label: 'Account' }] },
		});
		const projected = projectSharedCanvasPayload(
			safePayload,
			new Map([
				[
					'Account',
					{
						visible: true,
						queryable: false,
						createable: true,
						label: 'Account',
						readableFields: new Set(['Name']),
						fields: new Map([
							[
								'Name',
								{
									name: 'Name',
									label: 'Account Name',
									type: 'string',
									createable: true,
									updateable: false,
								},
							],
						]),
					},
				],
			]),
		);

		assert.equal(projected.loadedRecords.length, 0);
		assert.equal(projected.drafts.length, 1);
		assert.equal(projected.hiddenRecords.length, 0);
		assert.equal(projected.drafts[0].tempId, 'slot-request-request-account');
		assert.equal(projected.drafts[0].slot.kind, 'whole-record');
		assert.equal(projected.drafts[0].values, undefined);
		assert.equal(JSON.stringify(projected).includes(sourceRecordId), false);
		assert.equal(JSON.stringify(projected).includes('Owner-only source record'), false);
	});

	test('shows only objects and fields available to the recipient Salesforce user', () => {
		const payload = {
			loadedRecords: [
				{
					objectName: 'Account',
					loadedFromId: '001000000000001AAA',
					canvasRecordId: 'account-card',
					values: { Name: 'Visible', Secret__c: 'hidden' },
					changes: { Name: 'Changed', Secret__c: 'hidden change' },
					slot: {
						slotId: 'account-fields',
						kind: 'fields',
						fields: ['Name', 'Secret__c'],
					},
				},
			],
			drafts: [
				{
					objectName: 'Secret_Object__c',
					canvasRecordId: 'secret-card',
					values: { Secret__c: 'intentionally shared' },
				},
			],
			schema: {
				objects: [
					{
						name: 'Account',
						referenceFields: [{ name: 'OwnerId' }, { name: 'Secret_Lookup__c' }],
						requiredFields: ['Name', 'Secret__c'],
					},
					{
						name: 'Secret_Object__c',
						draftFields: [{ name: 'Secret__c', label: 'Secret', type: 'string' }],
					},
				],
			},
		};
		const projected = projectSharedCanvasPayload(
			payload,
			new Map([
				[
					'Account',
					{
						visible: true,
						queryable: true,
						label: 'Account',
						readableFields: new Set(['Name', 'OwnerId']),
						fields: new Map([
							['Name', { name: 'Name', label: 'Account Name', type: 'string', updateable: true }],
							['OwnerId', { name: 'OwnerId', label: 'Owner', type: 'reference', updateable: true }],
						]),
					},
				],
				['Secret_Object__c', { visible: false, readableFields: new Set(), fields: new Map() }],
			]),
		);

		assert.deepEqual(projected.loadedRecords[0].values, { Name: 'Visible' });
		assert.deepEqual(projected.loadedRecords[0].changes, { Name: 'Changed' });
		assert.deepEqual(projected.loadedRecords[0].slot.fields, ['Name']);
		assert.equal(projected.loadedRecords[0].slot.unavailableFieldCount, 1);
		assert.equal(projected.loadedRecords[0].canvasRecordId, 'account-card');
		assert.deepEqual(projected.drafts, []);
		assert.equal(projected.hiddenRecords.length, 1);
		assert.deepEqual(
			projected.schema.objects.map((object) => object.name),
			['Account'],
		);
		assert.equal(JSON.stringify(projected).includes('Secret_Object__c'), false);
		assert.equal(JSON.stringify(projected).includes('Secret__c'), false);
		assert.equal(JSON.stringify(projected).includes('secret-card'), false);
	});

	test('removes relationships that disclose unreadable fields or inaccessible existing records', () => {
		const payload = {
			loadedRecords: [
				{ objectName: 'Contact', loadedFromId: '003000000000001AAA' },
				{ objectName: 'Account', loadedFromId: '001000000000001AAA' },
			],
			drafts: [
				{ objectName: 'Contact', tempId: 'draft-contact', values: {} },
				{ objectName: 'Account', tempId: 'draft-account', values: {} },
			],
			associations: [
				{
					from: { kind: 'loaded', ref: '003000000000001AAA' },
					to: { kind: 'loaded', ref: '001000000000001AAA' },
					fieldName: 'AccountId',
				},
				{
					from: { kind: 'loaded', ref: '003000000000001AAA' },
					to: { kind: 'draft', ref: 'draft-account' },
					fieldName: 'Hidden_Lookup__c',
				},
				{
					from: { kind: 'draft', ref: 'draft-contact' },
					to: { kind: 'draft', ref: 'draft-account' },
					fieldName: 'AccountId',
				},
			],
		};
		const projected = projectSharedCanvasPayload(
			payload,
			new Map([
				['Contact', new Set(['Name', 'AccountId'])],
				['Account', new Set(['Name'])],
			]),
		);

		assert.equal(projected.associations.length, 2);
		assert.equal(
			projected.associations.some((association) => association.fieldName === 'Hidden_Lookup__c'),
			false,
		);
		assert.equal(
			projected.associations.some(
				(association) => association.from.kind === 'draft' && association.to.kind === 'draft',
			),
			true,
		);
	});

	test('filters draft values, requested fields, and embedded field metadata using recipient describe access', () => {
		const payload = {
			loadedRecords: [],
			drafts: [
				{
					tempId: 'draft-1',
					objectName: 'Opportunity',
					x: 10,
					y: 20,
					values: { Name: 'Visible', Secret__c: 'hidden' },
					slot: { slotId: 'slot-1', kind: 'fields', fields: ['Name', 'Secret__c'] },
				},
			],
			schema: {
				objects: [
					{
						name: 'Opportunity',
						label: 'Owner-side label',
						draftFields: [
							{ name: 'Name', label: 'Owner Name', type: 'string', createable: true },
							{ name: 'Secret__c', label: 'Secret', type: 'string', createable: true },
						],
					},
				],
			},
			associations: [],
		};
		const projected = projectSharedCanvasPayload(
			payload,
			new Map([
				[
					'Opportunity',
					{
						visible: true,
						queryable: true,
						label: 'Opportunity',
						readableFields: new Set(['Name', 'Phone']),
						fields: new Map([
							[
								'Name',
								{
									name: 'Name',
									label: 'Opportunity Name',
									type: 'string',
									createable: true,
									updateable: true,
								},
							],
							[
								'Phone',
								{
									name: 'Phone',
									label: 'Phone',
									type: 'phone',
									createable: true,
									updateable: true,
								},
							],
						]),
					},
				],
			]),
		);

		assert.deepEqual(projected.drafts[0].values, { Name: 'Visible' });
		assert.deepEqual(projected.drafts[0].slot.fields, ['Name']);
		assert.equal(projected.schema.objects[0].label, 'Opportunity');
		assert.deepEqual(
			projected.schema.objects[0].draftFields.map((field) => field.name),
			['Name', 'Phone'],
		);
		assert.equal(JSON.stringify(projected).includes('Secret__c'), false);
	});

	test('removes record-level inaccessible relationships before sending a shared payload', () => {
		const payload = {
			associations: [
				{
					from: { kind: 'loaded', ref: '003000000000001AAA' },
					to: { kind: 'loaded', ref: '001000000000001AAA' },
					fieldName: 'AccountId',
				},
				{
					from: { kind: 'draft', ref: 'draft-contact' },
					to: { kind: 'draft', ref: 'draft-account' },
					fieldName: 'AccountId',
				},
			],
		};
		const projected = projectSharedRelationshipsByVisibility(payload, {
			loadedRecords: {
				'003000000000001': { objectName: 'Contact', readableFields: ['AccountId'] },
			},
			slots: {},
		});

		assert.equal(projected.associations.length, 1);
		assert.equal(projected.associations[0].from.kind, 'draft');
	});
});
