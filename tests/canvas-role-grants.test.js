import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { ext } from '../src/extensions.js';
import * as canvasRoleGrants from '../src/database/canvas-role-grants.js';
import { initTestDb } from './helpers/db.js';

const ORG_ID = '00D000000000001AAA';
const RECIPIENT_ID = '005000000000001AAA';

before(async () => {
	await initTestDb();
	await ext.getDb().deleteFrom('canvas_role_grants').execute();
});

after(async () => {
	await ext.getDb().deleteFrom('canvas_role_grants').execute();
});

test('lists only active canvas roles for the requested Salesforce recipient', async () => {
	await canvasRoleGrants.set({
		sfOrgId: ORG_ID,
		canvasId: '069000000000001AAA',
		recipientSfUserId: RECIPIENT_ID,
		role: 'viewer',
	});
	await canvasRoleGrants.set({
		sfOrgId: ORG_ID,
		canvasId: '069000000000002AAA',
		recipientSfUserId: RECIPIENT_ID,
		role: 'contributor',
	});
	await canvasRoleGrants.set({
		sfOrgId: ORG_ID,
		canvasId: '069000000000003AAA',
		recipientSfUserId: '005000000000002AAA',
		role: 'editor',
	});

	const roles = await canvasRoleGrants.listForRecipient({
		sfOrgId: ORG_ID,
		recipientSfUserId: RECIPIENT_ID,
	});
	assert.deepEqual(Object.fromEntries(Object.entries(roles).map(([canvasId, grant]) => [canvasId, grant.role])), {
		'069000000000001AAA': 'viewer',
		'069000000000002AAA': 'contributor',
	});

	await canvasRoleGrants.remove({
		sfOrgId: ORG_ID,
		canvasId: '069000000000002AAA',
		recipientSfUserId: RECIPIENT_ID,
	});
	const afterRevoke = await canvasRoleGrants.listForRecipient({
		sfOrgId: ORG_ID,
		recipientSfUserId: RECIPIENT_ID,
	});
	assert.deepEqual(Object.keys(afterRevoke), ['069000000000001AAA']);
});
