import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import session from 'express-session';
import { createSqliteSessionStore } from '../src/database/sqlite-session-store.js';

const SqliteSessionStore = createSqliteSessionStore(session.Store);

function makeStore() {
	const db = new Database(':memory:');
	const store = new SqliteSessionStore({ client: db, cleanupIntervalMs: 0 });
	return { db, store };
}

function call(store, method, ...args) {
	return new Promise((resolve, reject) => {
		store[method](...args, (error, value) => {
			if (error) {
				reject(error);
			} else {
				resolve(value);
			}
		});
	});
}

test('requires a better-sqlite3 client', () => {
	assert.throws(() => new SqliteSessionStore(), /better-sqlite3 client/);
});

test('stores, replaces, lists, counts, and destroys sessions', async (t) => {
	const { db, store } = makeStore();
	t.after(() => {
		store.close();
		db.close();
	});

	await call(store, 'set', 'one', { accountId: 'acct-1', cookie: { maxAge: 60_000 } });
	await call(store, 'set', 'two', { accountId: 'acct-2', cookie: { maxAge: 60_000 } });
	await call(store, 'set', 'one', { accountId: 'acct-updated', cookie: { maxAge: 60_000 } });

	assert.equal((await call(store, 'get', 'one')).accountId, 'acct-updated');
	assert.equal(await call(store, 'length'), 2);
	assert.deepEqual(
		(await call(store, 'all')).map((value) => value.accountId).sort(),
		['acct-2', 'acct-updated'],
	);

	await call(store, 'destroy', 'one');
	assert.equal(await call(store, 'get', 'one'), null);
	assert.equal(await call(store, 'length'), 1);

	await call(store, 'clear');
	assert.equal(await call(store, 'length'), 0);
});

test('ignores expired rows and clears them without counting them', async (t) => {
	const { db, store } = makeStore();
	t.after(() => {
		store.close();
		db.close();
	});

	db.prepare('INSERT INTO sessions (sid, sess, expire) VALUES (?, ?, ?)')
		.run('expired', JSON.stringify({ accountId: 'old' }), '2000-01-01T00:00:00.000Z');
	await call(store, 'set', 'active', { accountId: 'current', cookie: { maxAge: 60_000 } });

	assert.equal(await call(store, 'get', 'expired'), null);
	assert.equal(await call(store, 'length'), 1);
	assert.deepEqual((await call(store, 'all')).map((value) => value.accountId), ['current']);

	store.statements.clearExpired.run();
	assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 1);
});

test('touch updates expiry and existing table rows remain readable', async (t) => {
	const { db, store } = makeStore();
	t.after(() => {
		store.close();
		db.close();
	});

	db.prepare('INSERT INTO sessions (sid, sess, expire) VALUES (?, ?, ?)')
		.run('legacy', JSON.stringify({ accountId: 'legacy-account' }), '2099-01-01T00:00:00.000Z');
	assert.equal((await call(store, 'get', 'legacy')).accountId, 'legacy-account');

	await call(store, 'touch', 'legacy', { cookie: { expires: '2099-02-01T00:00:00.000Z' } });
	assert.equal(
		db.prepare('SELECT expire FROM sessions WHERE sid = ?').get('legacy').expire,
		'2099-02-01T00:00:00.000Z',
	);
});

test('reports corrupt stored JSON through the callback', async (t) => {
	const { db, store } = makeStore();
	t.after(() => {
		store.close();
		db.close();
	});
	db.prepare('INSERT INTO sessions (sid, sess, expire) VALUES (?, ?, ?)')
		.run('corrupt', '{not-json', '2099-01-01T00:00:00.000Z');

	await assert.rejects(call(store, 'get', 'corrupt'), SyntaxError);
});
