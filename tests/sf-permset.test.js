import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { hasAssignedOrgloomPermissionSet, ORGLOOM_PERMISSION_SET_NAMES } from '../src/sf-permset.js';

const USER_ID = '005000000000001AAA';

describe('Org Loom managed permission-set assignment gate', () => {
	test('accepts the packaged named-assignment proof without querying setup objects', async () => {
		let queried = false;
		const conn = {
			request: async (request) => {
				assert.equal(request.method, 'POST');
				assert.equal(request.url, '/services/apexrest/orgloom/orgloom/kek/access');
				return {
					ok: true,
					granted: true,
					verification: 'named-permission-set-assignment-v1',
				};
			},
			query: async () => {
				queried = true;
				throw new Error('restricted users cannot query PermissionSetAssignment');
			},
		};
		assert.equal(await hasAssignedOrgloomPermissionSet(conn, USER_ID), true);
		assert.equal(queried, false);
	});

	test('fails closed when the packaged named permission set is not assigned', async () => {
		const conn = {
			request: async () => ({
				ok: true,
				granted: false,
				verification: 'named-permission-set-assignment-v1',
			}),
			query: async () => {
				throw new Error('legacy query must not override a negative packaged result');
			},
		};
		assert.equal(await hasAssignedOrgloomPermissionSet(conn, USER_ID), false);
	});

	test('does not trust the legacy custom-permission result after install-for-all profile grants', async () => {
		let queried = false;
		const conn = {
			request: async () => ({ ok: true, granted: true }),
			query: async () => {
				queried = true;
				return { records: [] };
			},
		};

		assert.equal(await hasAssignedOrgloomPermissionSet(conn, USER_ID), false);
		assert.equal(queried, true);
	});

	test('fails closed when a restricted user has an old package that cannot prove a named assignment', async () => {
		const setupObjectsUnavailable = new Error('PermissionSetAssignment is not supported');
		setupObjectsUnavailable.errorCode = 'INVALID_TYPE';
		await assert.rejects(
			() =>
				hasAssignedOrgloomPermissionSet(
					{
						request: async () => ({ ok: true, granted: true }),
						query: async () => {
							throw setupObjectsUnavailable;
						},
					},
					USER_ID,
				),
			(error) => error === setupObjectsUnavailable,
		);
	});

	test('treats missing Apex class access as a missing Org Loom permission', async () => {
		const conn = {
			request: async () => {
				const error = new Error('Forbidden');
				error.statusCode = 403;
				throw error;
			},
		};
		assert.equal(await hasAssignedOrgloomPermissionSet(conn, USER_ID), false);
	});

	test('does not misclassify API-disabled 403 responses as a missing permission set', async () => {
		const apiDisabled = new Error('API access is disabled for this user');
		apiDisabled.statusCode = 403;
		apiDisabled.errorCode = 'API_DISABLED_FOR_USER';
		await assert.rejects(
			() =>
				hasAssignedOrgloomPermissionSet(
					{
						request: async () => {
							throw apiDisabled;
						},
					},
					USER_ID,
				),
			(error) => error === apiDisabled,
		);
	});

	test('recognizes API-disabled errors nested in a Salesforce response body', async () => {
		const apiDisabled = new Error('Forbidden');
		apiDisabled.statusCode = 403;
		apiDisabled.data = [
			{
				message: 'The REST API is not enabled for this Organization.',
				errorCode: 'API_DISABLED_FOR_USER',
			},
		];
		await assert.rejects(
			() =>
				hasAssignedOrgloomPermissionSet(
					{
						request: async () => {
							throw apiDisabled;
						},
					},
					USER_ID,
				),
			(error) => error === apiDisabled,
		);
	});

	test('falls back to the legacy assignment query only when the package endpoint is unavailable', async () => {
		let queried = false;
		const conn = {
			request: async () => {
				const error = new Error('Not Found');
				error.statusCode = 404;
				throw error;
			},
			query: async () => {
				queried = true;
				return { records: [{ PermissionSet: { Name: 'Orgloom_User', NamespacePrefix: 'orgloom' } }] };
			},
		};
		assert.equal(await hasAssignedOrgloomPermissionSet(conn, USER_ID), true);
		assert.equal(queried, true);
	});

	test('falls back when an older package reports the access path as an unknown KEK operation', async () => {
		let queried = false;
		const conn = {
			request: async () => {
				const error = new Error('Unknown KEK operation: /orgloom/orgloom/kek/access');
				error.data = {
					error: 'unknown-path',
					message: 'Unknown KEK operation: /orgloom/orgloom/kek/access',
				};
				throw error;
			},
			query: async () => {
				queried = true;
				return {
					records: [
						{
							PermissionSet: {
								Name: 'Orgloom_Admin',
								NamespacePrefix: 'orgloom',
							},
						},
					],
				};
			},
		};

		assert.equal(await hasAssignedOrgloomPermissionSet(conn, USER_ID), true);
		assert.equal(queried, true);
	});

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
