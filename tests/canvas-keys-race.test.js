import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { initTestDb, clearTestDb } from './helpers/db.js';

before(initTestDb);
beforeEach(clearTestDb);

const SF_ORG = '00Dxx0000000001';
const CANVAS = '069xx0000000001';

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

		const winnerKey = crypto.randomBytes(32);
		let injected = false;

		const racingKek = {
			async wrapDataKey(dataKey) {

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

		assert.ok(Buffer.isBuffer(returned), 'returns a Buffer key');
		assert.ok(returned.equals(winnerKey), 'returns the concurrently-stored winner key, not the losing fresh mint');

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
