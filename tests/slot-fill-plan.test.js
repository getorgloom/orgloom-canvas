import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { planSlotFills } from '../src/slot-helpers.js';

function slotRec({ slotId, kind = 'whole-record', fields, assigneeSfUserId, loadedFromId, objectName = 'Account' }) {
	const slot = { slotId, kind };
	if (fields) {
		slot.fields = fields;
	}
	if (assigneeSfUserId) {
		slot.assigneeSfUserId = assigneeSfUserId;
	}
	const rec = { objectName, slot };
	if (loadedFromId) {
		rec.loadedFromId = loadedFromId;
	}
	return rec;
}

describe('planSlotFills: assignment authorization', () => {
	test('generic slot is fillable by any recipient with a loadedFromId', () => {
		const out = planSlotFills({
			records: [slotRec({ slotId: 1, loadedFromId: '001ABC' })],
			fills: [{ slotId: 1, values: { Industry: 'Tech' } }],
			recipientSfUserId: '005anyone',
		});
		assert.equal(out.appliedCount, 1);
		assert.deepEqual(out.recordPlan, { Account: [{ Id: '001ABC', Industry: 'Tech' }] });
		assert.deepEqual(out.skipped, []);
	});

	test('slot assigned to recipient produces an update row', () => {
		const out = planSlotFills({
			records: [slotRec({ slotId: 1, assigneeSfUserId: '005me', loadedFromId: '001ABC' })],
			fills: [{ slotId: 1, values: { Industry: 'Tech' } }],
			recipientSfUserId: '005me',
		});
		assert.equal(out.appliedCount, 1);
		assert.equal(out.recordPlan.Account[0].Industry, 'Tech');
	});

	test('slot assigned to someone else is skipped, no update row produced', () => {
		const out = planSlotFills({
			records: [
				slotRec({
					slotId: 1,
					assigneeSfUserId: '005other',
					loadedFromId: '001ABC',
				}),
			],
			fills: [{ slotId: 1, values: { Industry: 'evil' } }],
			recipientSfUserId: '005me',
		});
		assert.equal(out.appliedCount, 0);
		assert.deepEqual(out.skipped, [{ slotId: 1, reason: 'not_assigned_to_you', assignee: '005other' }]);
		assert.deepEqual(out.recordPlan, {}); // critical: no DML at all
	});

	test('mixed batch: only authorized slots reach the plan', () => {
		const out = planSlotFills({
			records: [
				slotRec({ slotId: 1, loadedFromId: '001A' }), // generic
				slotRec({ slotId: 2, assigneeSfUserId: '005me', loadedFromId: '001B' }), // mine
				slotRec({ slotId: 3, assigneeSfUserId: '005other', loadedFromId: '001C' }), // other
			],
			fills: [
				{ slotId: 1, values: { Industry: 'A' } },
				{ slotId: 2, values: { Industry: 'B' } },
				{ slotId: 3, values: { Industry: 'C' } },
			],
			recipientSfUserId: '005me',
		});
		assert.equal(out.appliedCount, 2);
		assert.equal(out.recordPlan.Account.length, 2);
		const ids = out.recordPlan.Account.map((u) => u.Id).sort();
		assert.deepEqual(ids, ['001A', '001B']);
		assert.equal(
			out.recordPlan.Account.find((u) => u.Id === '001C'),
			undefined,
		);
	});
});

describe('planSlotFills: draft handling', () => {
	test('draft slot (no loadedFromId) is skipped with reason=no_record_to_update', () => {
		const out = planSlotFills({
			records: [slotRec({ slotId: 1, kind: 'whole-record' })], // no loadedFromId
			fills: [{ slotId: 1, values: { Name: 'Acme' } }],
			recipientSfUserId: '005me',
		});
		assert.equal(out.appliedCount, 0);
		assert.deepEqual(out.skipped, [{ slotId: 1, reason: 'no_record_to_update' }]);
		assert.deepEqual(out.recordPlan, {});
	});

	test('skip-reason precedence: assignment is checked before loadedFromId presence', () => {
		const out = planSlotFills({
			records: [
				slotRec({
					slotId: 1,
					kind: 'whole-record',
					assigneeSfUserId: '005other',
				}),
			],
			fills: [{ slotId: 1, values: { Name: 'a' } }],
			recipientSfUserId: '005me',
		});
		assert.equal(out.skipped[0].reason, 'not_assigned_to_you');
	});
});

describe('planSlotFills: record coalescing', () => {
	test('two slots on the same loadedFromId merge into one update row', () => {
		const out = planSlotFills({
			records: [
				slotRec({
					slotId: 1,
					kind: 'fields',
					fields: ['Industry'],
					loadedFromId: '001ABC',
				}),
				slotRec({
					slotId: 2,
					kind: 'fields',
					fields: ['Phone'],
					loadedFromId: '001ABC',
				}),
			],
			fills: [
				{ slotId: 1, values: { Industry: 'Tech' } },
				{ slotId: 2, values: { Phone: '555-0100' } },
			],
			recipientSfUserId: '005me',
		});
		assert.equal(out.appliedCount, 2);
		assert.equal(out.recordPlan.Account.length, 1);
		assert.deepEqual(out.recordPlan.Account[0], {
			Id: '001ABC',
			Industry: 'Tech',
			Phone: '555-0100',
		});
	});

	test('last-write-wins when two fills name the same field on the same record', () => {
		const out = planSlotFills({
			records: [
				slotRec({ slotId: 1, kind: 'whole-record', loadedFromId: '001ABC' }),
				slotRec({ slotId: 2, kind: 'whole-record', loadedFromId: '001ABC' }),
			],
			fills: [
				{ slotId: 1, values: { Industry: 'first' } },
				{ slotId: 2, values: { Industry: 'second' } },
			],
			recipientSfUserId: '005me',
		});
		assert.equal(out.recordPlan.Account[0].Industry, 'second');
	});

	test('records on different objects produce separate plan buckets', () => {
		const out = planSlotFills({
			records: [
				slotRec({ slotId: 1, loadedFromId: '001A', objectName: 'Account' }),
				slotRec({ slotId: 2, loadedFromId: '003B', objectName: 'Contact' }),
				slotRec({ slotId: 3, loadedFromId: '001C', objectName: 'Account' }),
			],
			fills: [
				{ slotId: 1, values: { Industry: 'a' } },
				{ slotId: 2, values: { Email: 'b@x.com' } },
				{ slotId: 3, values: { Industry: 'c' } },
			],
			recipientSfUserId: '005me',
		});
		assert.equal(out.recordPlan.Account.length, 2);
		assert.equal(out.recordPlan.Contact.length, 1);
		assert.equal(out.recordPlan.Contact[0].Email, 'b@x.com');
	});
});

describe('planSlotFills: field allowlist enforcement', () => {
	test('field-level slot drops keys outside the allowlist', () => {
		const out = planSlotFills({
			records: [
				slotRec({
					slotId: 1,
					kind: 'fields',
					fields: ['Industry'],
					loadedFromId: '001ABC',
				}),
			],
			fills: [
				{
					slotId: 1,
					values: {
						Industry: 'Tech',
						Amount: 999999, // not in allowlist
						CreatedById: '005evil', // not in allowlist (and a sensitive field)
					},
				},
			],
			recipientSfUserId: '005me',
		});
		assert.equal(out.appliedCount, 1);
		assert.deepEqual(out.recordPlan.Account[0], {
			Id: '001ABC',
			Industry: 'Tech',
		});
		assert.equal(out.recordPlan.Account[0].Amount, undefined);
		assert.equal(out.recordPlan.Account[0].CreatedById, undefined);
	});

	test('field-level slot with empty allowlist drops all incoming keys but still counts as applied', () => {
		const out = planSlotFills({
			records: [
				slotRec({
					slotId: 1,
					kind: 'fields',
					fields: [],
					loadedFromId: '001ABC',
				}),
			],
			fills: [{ slotId: 1, values: { Industry: 'dropped' } }],
			recipientSfUserId: '005me',
		});
		assert.equal(out.appliedCount, 1);
		assert.deepEqual(out.recordPlan.Account[0], { Id: '001ABC' });
	});

	test('whole-record slot accepts any keys (no allowlist)', () => {
		const out = planSlotFills({
			records: [
				slotRec({
					slotId: 1,
					kind: 'whole-record',
					loadedFromId: '001ABC',
				}),
			],
			fills: [{ slotId: 1, values: { Industry: 'Tech', Phone: '555' } }],
			recipientSfUserId: '005me',
		});
		assert.equal(out.recordPlan.Account[0].Industry, 'Tech');
		assert.equal(out.recordPlan.Account[0].Phone, '555');
	});
});

describe('planSlotFills: purity', () => {
	test('does not mutate input records', () => {
		const original = [
			slotRec({
				slotId: 1,
				loadedFromId: '001ABC',
			}),
		];
		const snapshot = JSON.parse(JSON.stringify(original));
		planSlotFills({
			records: original,
			fills: [{ slotId: 1, values: { Industry: 'x' } }],
			recipientSfUserId: '005me',
		});
		assert.deepEqual(original, snapshot);
	});

	test('does not mutate input fills', () => {
		const fills = [{ slotId: 1, values: { Industry: 'x' } }];
		const snapshot = JSON.parse(JSON.stringify(fills));
		planSlotFills({
			records: [slotRec({ slotId: 1, loadedFromId: '001ABC' })],
			fills,
			recipientSfUserId: '005me',
		});
		assert.deepEqual(fills, snapshot);
	});
});

describe('planSlotFills: input edge cases', () => {
	test('non-array records → empty plan, all fills become unknown_slot', () => {
		const out = planSlotFills({
			records: null,
			fills: [{ slotId: 1, values: { x: 'y' } }],
			recipientSfUserId: '005me',
		});
		assert.deepEqual(out.recordPlan, {});
		assert.equal(out.skipped[0].reason, 'unknown_slot');
	});

	test('non-array fills → no-op', () => {
		const out = planSlotFills({
			records: [slotRec({ slotId: 1, loadedFromId: '001ABC' })],
			fills: undefined,
			recipientSfUserId: '005me',
		});
		assert.equal(out.appliedCount, 0);
		assert.deepEqual(out.skipped, []);
		assert.deepEqual(out.recordPlan, {});
	});

	test('non-object fill entries are silently ignored', () => {
		const out = planSlotFills({
			records: [slotRec({ slotId: 1, loadedFromId: '001ABC' })],
			fills: [null, 42, 'oops', undefined, { slotId: 1, values: { Industry: 'ok' } }],
			recipientSfUserId: '005me',
		});
		assert.equal(out.appliedCount, 1);
		assert.equal(out.skipped.length, 0);
	});

	test('unknown slotId is skipped', () => {
		const out = planSlotFills({
			records: [slotRec({ slotId: 1, loadedFromId: '001ABC' })],
			fills: [{ slotId: 999, values: {} }],
			recipientSfUserId: '005me',
		});
		assert.equal(out.appliedCount, 0);
		assert.equal(out.skipped[0].reason, 'unknown_slot');
	});
});

describe('planSlotFills: applied bookkeeping', () => {
	test('applied entry includes recordId + objectName for downstream audit', () => {
		const out = planSlotFills({
			records: [
				slotRec({
					slotId: 1,
					loadedFromId: '001ABC',
					objectName: 'Account',
				}),
			],
			fills: [{ slotId: 1, values: { Industry: 'Tech' } }],
			recipientSfUserId: '005me',
		});
		assert.deepEqual(out.applied, [
			{
				slotId: 1,
				recordId: '001ABC',
				objectName: 'Account',
				fieldCount: 1,
			},
		]);
	});

	test('fieldCount reflects attempted keys (pre-allowlist), not landed keys', () => {
		const out = planSlotFills({
			records: [
				slotRec({
					slotId: 1,
					kind: 'fields',
					fields: ['Industry'],
					loadedFromId: '001ABC',
				}),
			],
			fills: [{ slotId: 1, values: { Industry: 'x', Amount: 1, NextStep: 'y' } }],
			recipientSfUserId: '005me',
		});
		assert.equal(out.applied[0].fieldCount, 3);
		assert.deepEqual(Object.keys(out.recordPlan.Account[0]).sort(), ['Id', 'Industry']);
	});
});
