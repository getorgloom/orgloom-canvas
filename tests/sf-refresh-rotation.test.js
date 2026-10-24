import assert from 'node:assert/strict';
import { test } from 'node:test';
import jsforce from 'jsforce';
import {
	createSfRefreshFn,
	putRefreshToken,
	getRefreshToken,
	dropRefreshToken,
	dropSessionRefreshTokens,
} from '../src/sf-refresh-store.js';

function client(sid, exchange, onRefresh) {
	const conn = new jsforce.Connection({
		instanceUrl: 'https://example.my.salesforce.com',
		accessToken: 'old-access',
		refreshToken: getRefreshToken(sid, 'connection'),
		refreshFn: createSfRefreshFn(sid, 'connection', onRefresh),
	});
	conn.oauth2.refreshToken = exchange;
	return conn;
}
const refresh = (conn) => conn._refreshDelegate.refresh(Date.now() + 1);

test('concurrent clients share one exchange, late clients reuse it, next refresh uses rotated token', async () => {
	const sid = 'rotation';
	putRefreshToken(sid, 'connection', 'refresh-1');
	const tokens = [];
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const exchange = async (token) => {
		tokens.push(token);
		await gate;
		return {
			access_token: `access-${tokens.length}`,
			refresh_token: `refresh-${tokens.length + 1}`,
			instance_url: 'https://new.my.salesforce.com',
		};
	};
	const a = client(sid, exchange),
		b = client(sid, exchange),
		late = client(sid, exchange);
	const pending = Promise.all([refresh(a), refresh(b)]);
	assert.deepEqual(tokens, ['refresh-1']);
	release();
	await pending;
	assert.equal(a.accessToken, 'access-1');
	assert.equal(b.refreshToken, 'refresh-2');
	assert.equal(b.instanceUrl, 'https://new.my.salesforce.com');
	assert.equal(getRefreshToken(sid, 'connection'), 'refresh-2');
	await refresh(late);
	assert.deepEqual(tokens, ['refresh-1']);
	await refresh(a);
	assert.deepEqual(tokens, ['refresh-1', 'refresh-2']);
	assert.equal(getRefreshToken(sid, 'connection'), 'refresh-3');
	dropSessionRefreshTokens(sid);
});

test('responses without rotation retain the current refresh token', async () => {
	putRefreshToken('legacy', 'connection', 'refresh');
	const conn = client('legacy', async () => ({ access_token: 'new-access' }));
	await refresh(conn);
	assert.equal(getRefreshToken('legacy', 'connection'), 'refresh');
	dropSessionRefreshTokens('legacy');
});

for (const action of ['disconnect', 'logout', 'reauthenticate']) {
	test(`in-flight refresh cannot restore or overwrite credentials after ${action}`, async () => {
		putRefreshToken(action, 'connection', 'old-refresh');
		let release,
			saved = false;
		const conn = client(
			action,
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
			() => {
				saved = true;
			},
		);
		const result = refresh(conn);
		if (action === 'disconnect') {
			dropRefreshToken(action, 'connection');
		}
		if (action === 'logout') {
			dropSessionRefreshTokens(action);
		}
		if (action === 'reauthenticate') {
			putRefreshToken(action, 'connection', 'reauth-refresh');
		}
		release({ access_token: 'late-access', refresh_token: 'late-refresh' });
		await assert.rejects(result, /connection changed/);
		assert.equal(saved, false);
		assert.equal(getRefreshToken(action, 'connection'), action === 'reauthenticate' ? 'reauth-refresh' : null);
		dropSessionRefreshTokens(action);
	});
}

test('failed or lost refresh responses require reconnect rather than reuse an uncertain token', async () => {
	putRefreshToken('failed', 'connection', 'old-refresh');
	let calls = 0;
	const conn = client('failed', async () => {
		calls++;
		throw new Error('connection lost');
	});
	await assert.rejects(refresh(conn), /connection lost/);
	assert.equal(getRefreshToken('failed', 'connection'), null);
	await assert.rejects(refresh(conn), /connection changed/);
	assert.equal(calls, 1);
});

test('refreshes are isolated across sessions and connections', async () => {
	putRefreshToken('isolation', 'connection', 'one');
	putRefreshToken('isolation', 'other', 'two');
	putRefreshToken('other-session', 'connection', 'three');
	await refresh(client('isolation', async () => ({ access_token: 'access', refresh_token: 'rotated' })));
	assert.equal(getRefreshToken('isolation', 'other'), 'two');
	assert.equal(getRefreshToken('other-session', 'connection'), 'three');
	dropSessionRefreshTokens('isolation');
	dropSessionRefreshTokens('other-session');
});
