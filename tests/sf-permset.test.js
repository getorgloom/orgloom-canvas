import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { hasAssignedOrgloomPermissionSet, ORGLOOM_PERMISSION_SET_NAMES } from '../src/sf-permset.js';

const USER_ID = '005000000000001AAA';

describe('Org Loom managed permission-set assignment gate', () => {
	test('accepts the packaged custom-permission proof without querying setup objects', async () => {
		let queried = false;
		const conn = {
			request: async (request) => {
				assert.equal(request.method, 'POST');
				assert.equal(request.url, '/services/apexrest/orgloom/orgloom/kek/access');
				return { ok: true, granted: true };
			},
			query: async () => {
				queried = true;
				throw new Error('restricted users cannot query PermissionSetAssignment');
			},
		};
		assert.equal(await hasAssignedOrgloomPermissionSet(conn, USER_ID), true);
		assert.equal(queried, false);
	});

	test('fails closed when the packaged custom permission is not granted', async () => {
		const conn = {
			request: async () => ({ ok: true, granted: false }),
			query: async () => {
				throw new Error('legacy query must not override a negative packaged result');
			},
		};
		assert.equal(await hasAssignedOrgloomPermissionSet(conn, USER_ID), false);
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

	test('managed User and Admin permission sets grant the packaged access marker', () => {
		for (const name of ['Orgloom_User', 'Orgloom_Admin']) {
			const xml = fs.readFileSync(
				new URL(
					'../../../orgloom-package/force-app/main/default/permissionsets/' +
						name +
						'.permissionset-meta.xml',
					import.meta.url,
				),
				'utf8',
			);
			assert.match(xml, /<customPermissions>[\s\S]*<name>Orgloom_Access<\/name>[\s\S]*<\/customPermissions>/);
		}
		const customPermission = fs.readFileSync(
			new URL(
				'../../../orgloom-package/force-app/main/default/customPermissions/Orgloom_Access.customPermission-meta.xml',
				import.meta.url,
			),
			'utf8',
		);
		assert.match(customPermission, /<label>Org Loom Access<\/label>/);
	});

	test('managed User and Admin permission sets can store and merge canvas contributions', () => {
		for (const name of ['Orgloom_User', 'Orgloom_Admin']) {
			const xml = fs.readFileSync(
				new URL(
					'../../../orgloom-package/force-app/main/default/permissionsets/' +
						name +
						'.permissionset-meta.xml',
					import.meta.url,
				),
				'utf8',
			);
			assert.match(xml, /<object>Canvas_Contribution__c<\/object>/, `${name} needs contribution object access`);
			assert.match(xml, /Canvas_Contribution__c\.Payload__c/, `${name} needs encrypted payload access`);
			assert.match(xml, /<allowCreate>true<\/allowCreate>/);
			assert.match(xml, /<allowEdit>true<\/allowEdit>/);
		}
	});
});
