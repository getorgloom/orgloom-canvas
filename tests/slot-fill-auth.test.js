import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyContributionsToPayload, mergeSlotFills } from '../src/slot-helpers.js';

function slotRec({ slotId, kind = 'whole-record', fields, assigneeSfUserId, values, objectName = 'Account' }) {
	const slot = { slotId, kind };
	if (fields) {
		slot.fields = fields;
	}
	if (assigneeSfUserId) {
		slot.assigneeSfUserId = assigneeSfUserId;
	}
	return {
		objectName,
		values: values || {},
		slot,
	};
}

describe('mergeSlotFills, assignment authorization', () => {
	test('generic slot (no assignee) is fillable by any recipient', () => {
		const records = [slotRec({ slotId: 1 })];
		const out = mergeSlotFills({
			records,
			fills: [{ slotId: 1, values: { Name: 'Acme' } }],
			recipientSfUserId: '005anyone',
		});
		assert.equal(out.appliedCount, 1);
		assert.deepEqual(out.applied, [{ slotId: 1, fieldCount: 1 }]);
		assert.deepEqual(out.skipped, []);
		assert.equal(out.records[0].values.Name, 'Acme');
	});

	test('slot assigned to recipient is filled', () => {
		const records = [slotRec({ slotId: 1, assigneeSfUserId: '005me' })];
		const out = mergeSlotFills({
			records,
			fills: [{ slotId: 1, values: { Name: 'Acme' } }],
			recipientSfUserId: '005me',
		});
		assert.equal(out.appliedCount, 1);
		assert.equal(out.records[0].values.Name, 'Acme');
		assert.deepEqual(out.skipped, []);
	});

	test('slot assigned to someone else is skipped, not filled', () => {
		const records = [
			slotRec({
				slotId: 1,
				assigneeSfUserId: '005other',
				values: { Name: 'original' },
			}),
		];
		const out = mergeSlotFills({
			records,
			fills: [{ slotId: 1, values: { Name: 'evil-overwrite' } }],
			recipientSfUserId: '005me',
		});
		assert.equal(out.appliedCount, 0);
		assert.deepEqual(out.applied, []);
		assert.deepEqual(out.skipped, [{ slotId: 1, reason: 'not_assigned_to_you', assignee: '005other' }]);
		assert.equal(out.records[0].values.Name, 'original');
	});

	test('mixed batch: applied + skipped land in the right buckets', () => {
		const records = [
			slotRec({ slotId: 1 }), // generic
			slotRec({ slotId: 2, assigneeSfUserId: '005me' }), // mine
			slotRec({ slotId: 3, assigneeSfUserId: '005other' }), // other
		];
		const out = mergeSlotFills({
			records,
			fills: [
				{ slotId: 1, values: { Name: 'a' } },
				{ slotId: 2, values: { Name: 'b' } },
				{ slotId: 3, values: { Name: 'c' } },
			],
			recipientSfUserId: '005me',
		});
		assert.equal(out.appliedCount, 2);
		assert.deepEqual(out.applied.map((a) => a.slotId).sort(), [1, 2]);
		assert.deepEqual(out.skipped, [{ slotId: 3, reason: 'not_assigned_to_you', assignee: '005other' }]);
		assert.equal(out.records[0].values.Name, 'a');
		assert.equal(out.records[1].values.Name, 'b');
		assert.deepEqual(out.records[2].values, {});
	});

	test('assigneeSfUserId comparison is strict-string (15 vs 18 char ids do NOT match)', () => {
		const records = [slotRec({ slotId: 1, assigneeSfUserId: '005xx0000000001' })];
		const out = mergeSlotFills({
			records,
			fills: [{ slotId: 1, values: { Name: 'a' } }],
			recipientSfUserId: '005xx0000000001AAA',
		});
		assert.equal(out.appliedCount, 0);
		assert.equal(out.skipped[0].reason, 'not_assigned_to_you');
	});

	test('empty-string assigneeSfUserId is treated as unassigned (generic)', () => {
		const records = [
			{
				objectName: 'Account',
				values: {},
				slot: { slotId: 1, kind: 'whole-record', assigneeSfUserId: '' },
			},
		];
		const out = mergeSlotFills({
			records,
			fills: [{ slotId: 1, values: { Name: 'a' } }],
			recipientSfUserId: '005anyone',
		});
		assert.equal(out.appliedCount, 1);
		assert.equal(out.records[0].values.Name, 'a');
	});

	test('coerces non-string assigneeSfUserId via String() before comparing', () => {
		const records = [
			{
				objectName: 'Account',
				values: {},
				slot: { slotId: 1, kind: 'whole-record', assigneeSfUserId: 12345 },
			},
		];
		const out = mergeSlotFills({
			records,
			fills: [{ slotId: 1, values: { Name: 'a' } }],
			recipientSfUserId: '12345',
		});
		assert.equal(out.appliedCount, 1);
	});
});

describe('mergeSlotFills, unknown / malformed fills', () => {
	test('fill referencing a non-existent slotId is skipped', () => {
		const records = [slotRec({ slotId: 1 })];
		const out = mergeSlotFills({
			records,
			fills: [{ slotId: 999, values: { Name: 'a' } }],
			recipientSfUserId: '005me',
		});
		assert.equal(out.appliedCount, 0);
		assert.deepEqual(out.skipped, [{ slotId: 999, reason: 'unknown_slot' }]);
	});

	test('fill with null slotId is skipped', () => {
		const records = [slotRec({ slotId: 1 })];
		const out = mergeSlotFills({
			records,
			fills: [{ slotId: null, values: { Name: 'a' } }],
			recipientSfUserId: '005me',
		});
		assert.equal(out.appliedCount, 0);
		assert.equal(out.skipped[0].reason, 'unknown_slot');
	});

	test('non-object fill entries are quietly ignored (not appliedCount, not skipped)', () => {
		const records = [slotRec({ slotId: 1 })];
		const out = mergeSlotFills({
			records,
			fills: [null, undefined, 'oops', 42, { slotId: 1, values: { Name: 'ok' } }],
			recipientSfUserId: '005me',
		});
		assert.equal(out.appliedCount, 1);
		assert.equal(out.skipped.length, 0);
	});

	test('fill missing values is treated as empty object (slot is touched but nothing merges)', () => {
		const records = [slotRec({ slotId: 1, values: { Name: 'pre-existing' } })];
		const out = mergeSlotFills({
			records,
			fills: [{ slotId: 1 }],
			recipientSfUserId: '005me',
		});
		assert.equal(out.appliedCount, 1);
		assert.deepEqual(out.applied, [{ slotId: 1, fieldCount: 0 }]);
		assert.equal(out.records[0].values.Name, 'pre-existing');
	});
});

describe('mergeSlotFills, slot kind / field allowlist', () => {
	test('field-level slot drops non-allowlisted keys', () => {
		const records = [
			slotRec({
				slotId: 1,
				kind: 'fields',
				fields: ['StageName', 'CloseDate'],
				values: { StageName: 'Prospecting', CloseDate: '2030-01-01', Amount: 100 },
			}),
		];
		const out = mergeSlotFills({
			records,
			fills: [
				{
					slotId: 1,
					values: {
						StageName: 'Closed Won',
						CloseDate: '2030-12-31',
						Amount: 999999, // not in allowlist
						Name: 'evil', // not in allowlist
					},
				},
			],
			recipientSfUserId: '005me',
		});
		assert.equal(out.appliedCount, 1);
		assert.equal(out.records[0].values.StageName, 'Closed Won');
		assert.equal(out.records[0].values.CloseDate, '2030-12-31');
		assert.equal(out.records[0].values.Amount, 100);
		assert.equal(out.records[0].values.Name, undefined);
	});

	test('field-level slot with empty fields array drops everything', () => {
		const records = [
			slotRec({
				slotId: 1,
				kind: 'fields',
				fields: [],
				values: { Existing: 'x' },
			}),
		];
		const out = mergeSlotFills({
			records,
			fills: [{ slotId: 1, values: { StageName: 'will-be-dropped' } }],
			recipientSfUserId: '005me',
		});
		assert.equal(out.appliedCount, 1);
		assert.equal(out.records[0].values.StageName, undefined);
		assert.equal(out.records[0].values.Existing, 'x');
	});

	test('whole-record slot merges all incoming keys (no allowlist)', () => {
		const records = [
			slotRec({
				slotId: 1,
				kind: 'whole-record',
				values: { Existing: 'x' },
			}),
		];
		const out = mergeSlotFills({
			records,
			fills: [{ slotId: 1, values: { Name: 'Acme', Industry: 'Tech', Phone: '555' } }],
			recipientSfUserId: '005me',
		});
		assert.equal(out.appliedCount, 1);
		assert.equal(out.records[0].values.Name, 'Acme');
		assert.equal(out.records[0].values.Industry, 'Tech');
		assert.equal(out.records[0].values.Phone, '555');
		assert.equal(out.records[0].values.Existing, 'x');
	});

	test('legacy slot (no kind property) is treated as whole-record', () => {
		const records = [
			{
				objectName: 'Account',
				values: {},
				slot: { slotId: 1, label: 'Customer' }, // no kind
			},
		];
		const out = mergeSlotFills({
			records,
			fills: [{ slotId: 1, values: { Name: 'Acme' } }],
			recipientSfUserId: '005me',
		});
		assert.equal(out.appliedCount, 1);
		assert.equal(out.records[0].values.Name, 'Acme');
	});
});

describe('mergeSlotFills, purity / immutability', () => {
	test('does not mutate the input records array', () => {
		const original = [slotRec({ slotId: 1, values: { Name: 'old' } })];
		const snapshot = JSON.parse(JSON.stringify(original));
		mergeSlotFills({
			records: original,
			fills: [{ slotId: 1, values: { Name: 'new' } }],
			recipientSfUserId: '005me',
		});
		assert.deepEqual(original, snapshot);
	});

	test('returns a new array (different reference from input)', () => {
		const records = [slotRec({ slotId: 1 })];
		const out = mergeSlotFills({
			records,
			fills: [{ slotId: 1, values: { Name: 'x' } }],
			recipientSfUserId: '005me',
		});
		assert.notEqual(out.records, records);
	});

	test('non-touched records pass through by reference (no needless cloning)', () => {
		const untouched = slotRec({ slotId: 1 });
		const target = slotRec({ slotId: 2 });
		const records = [untouched, target];
		const out = mergeSlotFills({
			records,
			fills: [{ slotId: 2, values: { Name: 'x' } }],
			recipientSfUserId: '005me',
		});
		assert.equal(out.records[0], untouched);
		assert.notEqual(out.records[1], target);
	});
});

describe('mergeSlotFills, input edge cases', () => {
	test('non-array records yields empty result', () => {
		const out = mergeSlotFills({
			records: null,
			fills: [{ slotId: 1, values: { Name: 'a' } }],
			recipientSfUserId: '005me',
		});
		assert.deepEqual(out.records, []);
		assert.equal(out.appliedCount, 0);
		assert.equal(out.skipped[0].reason, 'unknown_slot');
	});

	test('non-array fills is a no-op', () => {
		const records = [slotRec({ slotId: 1 })];
		const out = mergeSlotFills({
			records,
			fills: null,
			recipientSfUserId: '005me',
		});
		assert.equal(out.appliedCount, 0);
		assert.deepEqual(out.skipped, []);
		assert.equal(out.records.length, 1);
	});

	test('empty fills array returns appliedCount=0', () => {
		const out = mergeSlotFills({
			records: [slotRec({ slotId: 1 })],
			fills: [],
			recipientSfUserId: '005me',
		});
		assert.equal(out.appliedCount, 0);
		assert.deepEqual(out.skipped, []);
	});

	test('records without slot are ignored when building the index', () => {
		const records = [
			{ objectName: 'Account', values: { Name: 'plain' } }, // not a slot
			slotRec({ slotId: 1 }),
		];
		const out = mergeSlotFills({
			records,
			fills: [{ slotId: 1, values: { Name: 'a' } }],
			recipientSfUserId: '005me',
		});
		assert.equal(out.appliedCount, 1);
		assert.equal(out.records[0].values.Name, 'plain');
	});

	test('slotId can be a number or string; index uses the same key type', () => {
		const records = [slotRec({ slotId: 7 })];
		const out = mergeSlotFills({
			records,
			fills: [{ slotId: 7, values: { Name: 'a' } }],
			recipientSfUserId: '005me',
		});
		assert.equal(out.appliedCount, 1);
	});
});

describe('mergeSlotFills, fieldCount accounting', () => {
	test('fieldCount reflects the number of incoming keys, not the merged count', () => {
		const records = [
			slotRec({
				slotId: 1,
				kind: 'fields',
				fields: ['StageName'],
				values: {},
			}),
		];
		const out = mergeSlotFills({
			records,
			fills: [{ slotId: 1, values: { StageName: 'x', Amount: 100, NextStep: 'y' } }],
			recipientSfUserId: '005me',
		});
		assert.equal(out.applied[0].fieldCount, 3);
		assert.deepEqual(Object.keys(out.records[0].values), ['StageName']);
	});

	test('fieldCount is 0 for fills with no values key', () => {
		const out = mergeSlotFills({
			records: [slotRec({ slotId: 1 })],
			fills: [{ slotId: 1 }],
			recipientSfUserId: '005me',
		});
		assert.equal(out.applied[0].fieldCount, 0);
	});
});

describe('applyContributionsToPayload, requested relationships', () => {
	test('replacing a requested lookup removes the old canvas association', () => {
		const payload = {
			loadedRecords: [],
			drafts: [
				{
					tempId: 'contact',
					objectName: 'Contact',
					values: { LastName: 'Recipient' },
					slot: { slotId: 7, kind: 'fields', fields: ['AccountId'] },
				},
				{ tempId: 'account', objectName: 'Account', values: { Name: 'Old account' } },
			],
			associations: [
				{
					from: { kind: 'slot', ref: 7 },
					to: { kind: 'draft', ref: 'account' },
					fieldName: 'AccountId',
				},
			],
		};
		const result = applyContributionsToPayload(payload, [
			{
				id: 'contribution-1',
				contributorSfUserId: '005recipient',
				fill: {
					slotId: 7,
					values: { AccountId: '001000000000001AAA' },
					relationshipFields: ['AccountId'],
				},
			},
		]);

		assert.equal(result.payload.associations.length, 0);
		assert.equal(result.payload.drafts[0].values.AccountId, '001000000000001AAA');
		assert.deepEqual(result.appliedContributionIds, ['contribution-1']);
	});

	test('clearing a requested lookup removes its value and canvas association', () => {
		const payload = {
			loadedRecords: [],
			drafts: [
				{
					tempId: 'contact',
					objectName: 'Contact',
					values: { LastName: 'Recipient', AccountId: '001000000000001AAA' },
					slot: { slotId: 7, kind: 'fields', fields: ['AccountId'] },
				},
				{ tempId: 'account', objectName: 'Account', values: { Name: 'Old account' } },
			],
			associations: [
				{
					from: { kind: 'slot', ref: 7 },
					to: { kind: 'draft', ref: 'account' },
					fieldName: 'AccountId',
				},
			],
		};
		const result = applyContributionsToPayload(payload, [
			{
				id: 'contribution-clear',
				contributorSfUserId: '005recipient',
				fill: {
					slotId: 7,
					values: { AccountId: null },
					relationshipFields: ['AccountId'],
				},
			},
		]);

		assert.equal(result.payload.associations.length, 0);
		assert.equal(result.payload.drafts[0].values.AccountId, null);
		assert.deepEqual(result.appliedContributionIds, ['contribution-clear']);
	});

	test('an unchanged lookup value does not remove its canvas association', () => {
		const association = {
			from: { kind: 'slot', ref: 7 },
			to: { kind: 'loaded', ref: '001000000000001AAA' },
			fieldName: 'AccountId',
		};
		const payload = {
			loadedRecords: [{ loadedFromId: '001000000000001AAA', objectName: 'Account' }],
			drafts: [
				{
					tempId: 'contact',
					objectName: 'Contact',
					values: { LastName: 'Recipient' },
					slot: { slotId: 7, kind: 'fields', fields: ['AccountId'] },
				},
			],
			associations: [association],
		};
		const result = applyContributionsToPayload(payload, [
			{
				id: 'contribution-2',
				contributorSfUserId: '005recipient',
				fill: { slotId: 7, values: { AccountId: '001000000000001AAA' } },
			},
		]);

		assert.deepEqual(result.payload.associations, [association]);
	});
});
