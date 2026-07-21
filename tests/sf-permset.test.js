import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { hasAssignedOrgloomPermissionSet, ORGLOOM_PERMISSION_SET_NAMES } from '../src/sf-permset.js';

const USER_ID = '005000000000001AAA';

describe('Org Loom managed permission-set assignment gate', () => {
	test('accepts each namespace-pinned packaged permission set', async () => {
		for (const name of ORGLOOM_PERMISSION_SET_NAMES) {
			const conn = {
				query: async () => ({
					records: [{ PermissionSet: { Name: name, NamespacePrefix: 'orgloom' } }],
				}),
			};
			assert.equal(await hasAssignedOrgloomPermissionSet(conn, USER_ID), true, name);
		}
	});

	test('rejects a missing assignment and a same-named subscriber spoof', async () => {
		assert.equal(
			await hasAssignedOrgloomPermissionSet(
				{
					query: async () => ({ records: [] }),
				},
				USER_ID,
			),
			false,
		);
		assert.equal(
			await hasAssignedOrgloomPermissionSet(
				{
					query: async () => ({
						records: [{ PermissionSet: { Name: 'Orgloom_User', NamespacePrefix: null } }],
					}),
				},
				USER_ID,
			),
			false,
		);
	});

	test('queries only the current user and the orgloom namespace', async () => {
		let soql = '';
		await hasAssignedOrgloomPermissionSet(
			{
				query: async (value) => {
					soql = value;
					return { records: [] };
				},
			},
			USER_ID,
		);
		assert.match(soql, new RegExp(`AssigneeId = '${USER_ID}'`));
		assert.match(soql, /PermissionSet\.NamespacePrefix = 'orgloom'/);
		assert.match(
			soql,
			/PermissionSet\.Name IN \('Orgloom_User','Orgloom_Admin','Orgloom_Canvas_User','Orgloom_Canvas_Admin'\)/,
		);
	});

	test('rejects malformed user ids before querying Salesforce', async () => {
		let queried = false;
		await assert.rejects(
			() =>
				hasAssignedOrgloomPermissionSet(
					{
						query: async () => {
							queried = true;
							return { records: [] };
						},
					},
					"005' OR Name != ''",
				),
			/Unexpected Salesforce user id shape/,
		);
		assert.equal(queried, false);
	});

	test('fails closed when Salesforce does not finish the verification query', async () => {
		await assert.rejects(
			() =>
				hasAssignedOrgloomPermissionSet(
					{
						query: () => new Promise(() => {}),
					},
					USER_ID,
					{ timeoutMs: 5 },
				),
			(error) => error && error.code === 'sf-permset-check-timeout',
		);
	});
});
