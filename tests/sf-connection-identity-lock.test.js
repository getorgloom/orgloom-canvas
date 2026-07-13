import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initTestDb, clearTestDb } from './helpers/db.js';
import { getActiveSfConnection } from '../src/sf-connection.js';

before(initTestDb);
beforeEach(clearTestDb);

async function makeAccount(email = 'a@x.com') {
	const { accounts } = await import('../src/database/index.js');
	return (await accounts.upsertByEmail({ email })).account;
}

async function makeConnection(accountId, overrides = {}) {
	const { connections } = await import('../src/database/index.js');
	const base = {
		accountId,
		sfUserId: '005USER1',
		sfOrgId: '00DORG1',
		instanceUrl: 'https://acme.my.salesforce.com',
		displayUsername: 'alice@acme.com',
	};
	const { connection } = await connections.upsertFromOauth({ ...base, ...overrides });
	return connection;
}

function reqFor({ accountId, sfAuth, currentConnectionId }) {
	return {
		session: {
			accountId,
			currentConnectionId,
			sfAuth,
		},
	};
}

describe('getActiveSfConnection: basic gates', () => {
	test('no session.accountId → null', async () => {
		assert.equal(await getActiveSfConnection({ session: {} }), null);
		assert.equal(await getActiveSfConnection({}), null);
		assert.equal(await getActiveSfConnection(null), null);
	});

	test('no sfAuth on session → null', async () => {
		const a = await makeAccount();
		const r = reqFor({ accountId: a.id, sfAuth: null, currentConnectionId: 'conn_x' });
		assert.equal(await getActiveSfConnection(r), null);
	});

	test('sfAuth missing accessToken → null', async () => {
		const a = await makeAccount();
		const r = reqFor({
			accountId: a.id,
			sfAuth: { instanceUrl: 'https://acme.my.salesforce.com' },
			currentConnectionId: 'conn_x',
		});
		assert.equal(await getActiveSfConnection(r), null);
	});

	test('sfAuth missing instanceUrl → null', async () => {
		const a = await makeAccount();
		const r = reqFor({
			accountId: a.id,
			sfAuth: { accessToken: 'tok' },
			currentConnectionId: 'conn_x',
		});
		assert.equal(await getActiveSfConnection(r), null);
	});

	test('connection row not found → null', async () => {
		const a = await makeAccount();
		const r = reqFor({
			accountId: a.id,
			sfAuth: { accessToken: 'tok', instanceUrl: 'https://acme.my.salesforce.com', sfUserId: '005USER1', sfOrgId: '00DORG1' },
			currentConnectionId: 'conn_missing',
		});
		assert.equal(await getActiveSfConnection(r), null);
	});
});

describe('getActiveSfConnection: account isolation', () => {
	test('connection owned by a different account → null', async () => {
		const alice = await makeAccount('alice@x.com');
		const bob = await makeAccount('bob@x.com');
		const aliceConn = await makeConnection(alice.id);

		const r = reqFor({
			accountId: bob.id,
			sfAuth: { accessToken: 'tok', instanceUrl: aliceConn.instance_url, sfUserId: '005USER1', sfOrgId: '00DORG1' },
			currentConnectionId: aliceConn.id,
		});
		assert.equal(await getActiveSfConnection(r), null);
	});

	test('disabled connection → null', async () => {
		const { connections } = await import('../src/database/index.js');
		const a = await makeAccount();
		const conn = await makeConnection(a.id);
		await connections.disable(conn.id);
		const r = reqFor({
			accountId: a.id,
			sfAuth: { accessToken: 'tok', instanceUrl: conn.instance_url, sfUserId: '005USER1', sfOrgId: '00DORG1' },
			currentConnectionId: conn.id,
		});
		assert.equal(await getActiveSfConnection(r), null);
	});
});

describe('getActiveSfConnection: identity-mismatch lockout', () => {
	test('userMismatch (sfAuth.sfUserId != conn.sf_user_id) → null', async () => {
		const a = await makeAccount();
		const conn = await makeConnection(a.id);
		const r = reqFor({
			accountId: a.id,
			sfAuth: {
				accessToken: 'tok',
				instanceUrl: conn.instance_url,
				sfUserId: '005DIFFERENT',
				sfOrgId: '00DORG1',
			},
			currentConnectionId: conn.id,
		});
		assert.equal(await getActiveSfConnection(r), null, 'must NOT return a mismatched connection');
	});

	test('orgMismatch (sfAuth.sfOrgId != conn.sf_org_id) → null', async () => {
		const a = await makeAccount();
		const conn = await makeConnection(a.id);
		const r = reqFor({
			accountId: a.id,
			sfAuth: {
				accessToken: 'tok',
				instanceUrl: conn.instance_url,
				sfUserId: '005USER1',
				sfOrgId: '00DDIFFERENT',
			},
			currentConnectionId: conn.id,
		});
		assert.equal(await getActiveSfConnection(r), null);
	});

	test('both user and org mismatch → null', async () => {
		const a = await makeAccount();
		const conn = await makeConnection(a.id);
		const r = reqFor({
			accountId: a.id,
			sfAuth: {
				accessToken: 'tok',
				instanceUrl: conn.instance_url,
				sfUserId: '005XYZ',
				sfOrgId: '00DXYZ',
			},
			currentConnectionId: conn.id,
		});
		assert.equal(await getActiveSfConnection(r), null);
	});

	test('aligned identity + org returns the connection bundle', async () => {
		const a = await makeAccount();
		const conn = await makeConnection(a.id);
		const r = reqFor({
			accountId: a.id,
			sfAuth: {
				accessToken: 'tok',
				instanceUrl: conn.instance_url,
				sfUserId: conn.sf_user_id,
				sfOrgId: conn.sf_org_id,
			},
			currentConnectionId: conn.id,
		});
		const bundle = await getActiveSfConnection(r);
		assert.ok(bundle, 'aligned pair should resolve');
		assert.equal(bundle.sfUserId, conn.sf_user_id);
		assert.equal(bundle.sfOrgId, conn.sf_org_id);
		assert.equal(bundle.instanceUrl, conn.instance_url);
		assert.equal(bundle.connectionRow.id, conn.id);
		assert.ok(bundle.conn, 'jsforce Connection instance attached');
	});

	test('sfAuth missing sfUserId does NOT trigger mismatch (legacy session)', async () => {

		const a = await makeAccount();
		const conn = await makeConnection(a.id);
		const r = reqFor({
			accountId: a.id,
			sfAuth: { accessToken: 'tok', instanceUrl: conn.instance_url                               },
			currentConnectionId: conn.id,
		});
		const bundle = await getActiveSfConnection(r);
		assert.ok(bundle, 'legacy session without identity stamps still resolves');
	});
});
