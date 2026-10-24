import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initTestDb, clearTestDb } from './helpers/db.js';
import { ensureSalesforceUserTimeZone, getActiveSfConnection } from '../src/sf-connection.js';
import { putRefreshToken, getRefreshToken, dropSessionRefreshTokens } from '../src/sf-refresh-store.js';

before(initTestDb);
beforeEach(clearTestDb);

test('active connections persist refreshed access credentials without persisting refresh tokens or changing another active org', async () => {
	const account = await makeAccount();
	const row = await makeConnection(account.id);
	const auth = {
		accessToken: 'expired',
		instanceUrl: row.instance_url,
		sfUserId: row.sf_user_id,
		sfOrgId: row.sf_org_id,
	};
	const req = reqFor({ accountId: account.id, sfAuth: auth, currentConnectionId: row.id });
	req.session.id = 'refresh-integration';
	req.session.sfAuthByConnection = { [row.id]: { ...auth } };
	let persisted;
	req.session.save = (done) => {
		persisted = JSON.stringify(req.session);
		done();
	};
	putRefreshToken(req.session.id, row.id, 'initial-refresh-secret');
	try {
		const { conn } = await getActiveSfConnection(req);
		conn.oauth2.refreshToken = async () => ({
			access_token: 'fresh-access',
			refresh_token: 'rotated-refresh-secret',
			instance_url: row.instance_url,
		});
		await conn._refreshDelegate.refresh(Date.now() + 1);
		assert.equal(req.session.sfAuth.accessToken, 'fresh-access');
		assert.equal(req.session.sfAuthByConnection[row.id].accessToken, 'fresh-access');
		assert.equal(getRefreshToken(req.session.id, row.id), 'rotated-refresh-secret');
		assert.doesNotMatch(persisted, /refresh-secret|refreshToken|refresh_token/);

		// The request started on one connection, but the active selection changes.
		req.session.currentConnectionId = 'another-connection';
		req.session.sfAuth = { accessToken: 'other-org-token', instanceUrl: 'https://other.my.salesforce.com' };
		conn.oauth2.refreshToken = async () => ({ access_token: 'fresh-again', refresh_token: 'rotated-again' });
		await conn._refreshDelegate.refresh(Date.now() + 1);
		assert.equal(req.session.sfAuth.accessToken, 'other-org-token');
		assert.equal(req.session.sfAuthByConnection[row.id].accessToken, 'fresh-again');
	} finally {
		dropSessionRefreshTokens(req.session.id);
	}
});

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
	const { connection } = await connections.upsertSalesforceConnectionMetadata({
		...base,
		...overrides,
	});
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
			sfAuth: {
				accessToken: 'tok',
				instanceUrl: 'https://acme.my.salesforce.com',
				sfUserId: '005USER1',
				sfOrgId: '00DORG1',
			},
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
			sfAuth: {
				accessToken: 'tok',
				instanceUrl: aliceConn.instance_url,
				sfUserId: '005USER1',
				sfOrgId: '00DORG1',
			},
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
				sfUserId: '005DIFFERENT', // doesn't match conn.sf_user_id
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
				sfOrgId: '00DDIFFERENT', // wrong org
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
			sfAuth: { accessToken: 'tok', instanceUrl: conn.instance_url /* no sfUserId, no sfOrgId */ },
			currentConnectionId: conn.id,
		});
		const bundle = await getActiveSfConnection(r);
		assert.ok(bundle, 'legacy session without identity stamps still resolves');
	});
});

describe('ensureSalesforceUserTimeZone', () => {
	test('refreshes the connected Salesforce user timezone on each page load', async () => {
		let queries = 0;
		const req = {
			session: {
				currentConnectionId: 'conn_1',
				sfAuth: {},
				sfAuthByConnection: { conn_1: {} },
			},
		};
		const activeSf = {
			sfUserId: '005000000000001AAA',
			conn: {
				query: async () => {
					queries++;
					return {
						records: [
							{
								TimeZoneSidKey: queries === 1 ? 'America/Los_Angeles' : 'America/New_York',
							},
						],
					};
				},
			},
		};

		assert.equal(await ensureSalesforceUserTimeZone(req, activeSf), 'America/Los_Angeles');
		assert.equal(await ensureSalesforceUserTimeZone(req, activeSf), 'America/New_York');
		assert.equal(queries, 2);
		assert.equal(req.session.sfAuth.timeZone, 'America/New_York');
		assert.equal(req.session.sfAuthByConnection.conn_1.timeZone, 'America/New_York');
	});

	test('fails open to the browser timezone when Salesforce cannot provide one', async () => {
		const req = { session: { sfAuth: {} } };
		const activeSf = {
			sfUserId: '005000000000001AAA',
			conn: { query: async () => Promise.reject(new Error('API unavailable')) },
		};
		assert.equal(await ensureSalesforceUserTimeZone(req, activeSf), null);
	});

	test('uses the last known Salesforce timezone when a refresh fails', async () => {
		const req = { session: { sfAuth: { timeZone: 'America/Phoenix' } } };
		const activeSf = {
			sfUserId: '005000000000001AAA',
			conn: { query: async () => Promise.reject(new Error('API unavailable')) },
		};
		assert.equal(await ensureSalesforceUserTimeZone(req, activeSf), 'America/Phoenix');
	});
});
