// Regression test for the concurrent keyless-save DEK mismatch.
//
// getOrMint() is: get() (row absent) → mint fresh key → INSERT ... ON
// CONFLICT DO NOTHING → return. If a concurrent getOrMint for the same
// canvas inserts a DIFFERENT key between our get() and our insert, our
// insert silently no-ops. The bug was that getOrMint still returned OUR
// freshly-minted key, so the caller encrypted the canvas body under a key
// that get() would never unwrap (the stored wrapped key is the other one)
// → permanent decrypt failure on the next load.
//
// The fix re-reads the row that actually persisted and returns the STORED
// key. This test forces the exact race deterministically: the fake KEK
// provider inserts a competing "winner" row as a side effect of the first
// wrap, simulating a concurrent writer landing between get() and insert.

import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { initTestDb, clearTestDb } from './helpers/db.js';

before(initTestDb);
beforeEach(clearTestDb);

const SF_ORG = '00Dxx0000000001';
const CANVAS = '069xx0000000001';

// Identity-ish KEK: wrap = base64(key) with a 'w:' tag; unwrap reverses.
function identityKek() {
	return {
		async wrapDataKey(dataKey) {
			return { wrappedKey: 'w:' + Buffer.from(dataKey).toString('base64'), iv: null, authTag: null, masterKeyVersion: 0 };
		},
		async unwrapDataKey(wrapped) {
			return Buffer.from(String(wrapped.wrappedKey).replace(/^w:/, ''), 'base64');
		},
	};
}

async function insertKeyRow(db, key) {
	const now = Date.now();
	await db.insertInto('canvas_keys').values({
		sf_org_id: SF_ORG,
		canvas_id: CANVAS,
		wrapped_key: 'w:' + Buffer.from(key).toString('base64'),
		wrap_iv: null,
		wrap_auth_tag: null,
		master_key_version: 0,
		created_at: now,
		updated_at: now,
	}).execute();
}

describe('getOrMint concurrent-mint safety', () => {
	test('adopts the concurrently-inserted winner key instead of its own fresh mint', async () => {
		const { ext } = await import('../src/extensions.js');
		const canvasKeys = await import('../src/database/canvas-keys.js');
		const db = ext.getDb();

		// The key a concurrent writer will land during our wrap.
		const winnerKey = crypto.randomBytes(32);
		let injected = false;

		const racingKek = {
			async wrapDataKey(dataKey) {
				// Simulate the concurrent winner landing its row AFTER our
				// get() returned null but BEFORE our insert: the exact race
				// window. Only on the first wrap.
				if (!injected) {
					injected = true;
					await insertKeyRow(db, winnerKey);
				}
				return { wrappedKey: 'w:' + Buffer.from(dataKey).toString('base64'), iv: null, authTag: null, masterKeyVersion: 0 };
			},
			async unwrapDataKey(wrapped) {
				return Buffer.from(String(wrapped.wrappedKey).replace(/^w:/, ''), 'base64');
			},
		};

		const returned = await canvasKeys.getOrMint({
			sfOrgId: SF_ORG, canvasId: CANVAS, kekProvider: racingKek, sessionId: 'race-session',
		});

		// The returned key MUST be the stored (winner) key, so the caller
		// encrypts under the key get() will later unwrap.
		assert.ok(Buffer.isBuffer(returned), 'returns a Buffer key');
		assert.ok(returned.equals(winnerKey), 'returns the concurrently-stored winner key, not the losing fresh mint');

		// And a fresh get() (new session, no cache) resolves the same key;
		// i.e. the row was never overwritten and the key is stable.
		const reread = await canvasKeys.get({
			sfOrgId: SF_ORG, canvasId: CANVAS, kekProvider: identityKek(), sessionId: 'reader-session',
		});
		assert.ok(reread.equals(winnerKey), 'stored key is the winner; ciphertext under `returned` will decrypt');
	});

	test('uncontended getOrMint returns its own minted key and persists it', async () => {
		const { ext } = await import('../src/extensions.js');
		const canvasKeys = await import('../src/database/canvas-keys.js');
		ext.getDb();
		const minted = await canvasKeys.getOrMint({
			sfOrgId: SF_ORG, canvasId: CANVAS, kekProvider: identityKek(), sessionId: 's1',
		});
		const reread = await canvasKeys.get({
			sfOrgId: SF_ORG, canvasId: CANVAS, kekProvider: identityKek(), sessionId: 's2',
		});
		assert.ok(minted.equals(reread), 'minted key round-trips through the DB');
	});

	test('getOrMint short-circuits to the existing key when a row already exists', async () => {
		const { ext } = await import('../src/extensions.js');
		const canvasKeys = await import('../src/database/canvas-keys.js');
		const db = ext.getDb();
		const preKey = crypto.randomBytes(32);
		await insertKeyRow(db, preKey);
		const got = await canvasKeys.getOrMint({
			sfOrgId: SF_ORG, canvasId: CANVAS, kekProvider: identityKek(), sessionId: 's3',
		});
		assert.ok(got.equals(preKey), 'existing key wins, no re-mint');
	});
});
