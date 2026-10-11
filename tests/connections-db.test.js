import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initTestDb, clearTestDb } from './helpers/db.js';

before(initTestDb);
beforeEach(clearTestDb);

async function makeAccount(email = 'a@x.com') {
	const { accounts } = await import('../src/database/index.js');
	return (await accounts.upsertByEmail({ email })).account;
}

describe('connectionsDb.upsertSalesforceConnectionMetadata', () => {
	test('creates a new connection on first OAuth', async () => {
		const { connections } = await import('../src/database/index.js');
		const a = await makeAccount();
		const { connection, created } = await connections.upsertSalesforceConnectionMetadata({
			accountId: a.id,
			sfUserId: '005xx',
			sfOrgId: '00Dxx',
			instanceUrl: 'https://acme.my.salesforce.com',
			displayUsername: 'alice@acme.com',
		});
		assert.equal(created, true);
		assert.ok(connection.id.startsWith('conn_'));
		assert.equal(connection.account_id, a.id);
		assert.equal(connection.sf_user_id, '005xx');
		assert.equal(connection.instance_url, 'https://acme.my.salesforce.com');
		assert.equal(connection.display_username, 'alice@acme.com');
	});

	test('updates existing connection on re-OAuth (matched by account+sfUserId)', async () => {
		const { connections } = await import('../src/database/index.js');
		const a = await makeAccount();
		const first = await connections.upsertSalesforceConnectionMetadata({
			accountId: a.id,
			sfUserId: '005xx',
			sfOrgId: '00Dxx',
			instanceUrl: 'https://acme.my.salesforce.com',
		});
		const second = await connections.upsertSalesforceConnectionMetadata({
			accountId: a.id,
			sfUserId: '005xx',
			sfOrgId: '00Dxx',
			instanceUrl: 'https://acme.my.salesforce.com',
			displayUsername: 'alice@acme.com',
		});
		assert.equal(second.created, false);
		assert.equal(second.connection.id, first.connection.id, 'same row updated');
		assert.equal(second.connection.display_username, 'alice@acme.com');
	});

	test('different sfUserId on same account creates a new row', async () => {
		const { connections } = await import('../src/database/index.js');
		const a = await makeAccount();
		await connections.upsertSalesforceConnectionMetadata({
			accountId: a.id,
			sfUserId: '005a',
			sfOrgId: '00Da',
			instanceUrl: 'https://x.salesforce.com',
		});
		await connections.upsertSalesforceConnectionMetadata({
			accountId: a.id,
			sfUserId: '005b',
			sfOrgId: '00Db',
			instanceUrl: 'https://y.salesforce.com',
		});
		const list = await connections.listForAccount(a.id);
		assert.equal(list.length, 2);
	});
});

describe('connectionsDb.listForAccount', () => {
	test('isolation: only returns connections for the requested account', async () => {
		const { connections } = await import('../src/database/index.js');
		const a1 = await makeAccount('a1@x.com');
		const a2 = await makeAccount('a2@x.com');
		await connections.upsertSalesforceConnectionMetadata({
			accountId: a1.id,
			sfUserId: 's1',
			sfOrgId: '00D1',
			instanceUrl: 'https://x.salesforce.com',
		});
		await connections.upsertSalesforceConnectionMetadata({
			accountId: a2.id,
			sfUserId: 's2',
			sfOrgId: '00D2',
			instanceUrl: 'https://y.salesforce.com',
		});
		const list1 = await connections.listForAccount(a1.id);
		const list2 = await connections.listForAccount(a2.id);
		assert.equal(list1.length, 1);
		assert.equal(list2.length, 1);
		assert.notEqual(list1[0].id, list2[0].id);
	});

	test('excludes disabled connections by default', async () => {
		const { connections } = await import('../src/database/index.js');
		const a = await makeAccount();
		const { connection } = await connections.upsertSalesforceConnectionMetadata({
			accountId: a.id,
			sfUserId: 's1',
			sfOrgId: '00D1',
			instanceUrl: 'https://x.salesforce.com',
		});
		await connections.disable(connection.id);
		const visible = await connections.listForAccount(a.id);
		assert.equal(visible.length, 0);
		const all = await connections.listForAccount(a.id, { includeDisabled: true });
		assert.equal(all.length, 1);
	});
});

describe('connectionsDb.disable', () => {
	test('stamps disabled_at and hides the connection from listForAccount', async () => {
		const { connections } = await import('../src/database/index.js');
		const a = await makeAccount();
		const { connection } = await connections.upsertSalesforceConnectionMetadata({
			accountId: a.id,
			sfUserId: 's1',
			sfOrgId: '00D1',
			instanceUrl: 'https://x.salesforce.com',
		});
		await connections.disable(connection.id);
		const after = await connections.findById(connection.id);
		assert.ok(after.disabled_at, 'disabled_at is stamped');
		const visible = await connections.listForAccount(a.id);
		assert.equal(visible.length, 0, 'a disabled connection no longer surfaces');
		const all = await connections.listForAccount(a.id, { includeDisabled: true });
		assert.equal(all.length, 1, 'but is retained for history / audit references');
	});
});
