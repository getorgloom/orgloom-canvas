// Low-level encryption helpers, exercised independently of the canvas
// store so the crypto contract is pinned down without DB or jsforce
// mocks getting in the way.
//
// Invariants we check:
//   * Envelope detection: ciphertext starts with OLE2, JSON plaintext
//     doesn't.
//   * Encrypt/decrypt round-trip returns the same plaintext.
//   * GCM auth tag rejects modified ciphertext (tamper detection).
//   * Wrong key fails to decrypt rather than returning garbage.
//
// DEK wrapping is NOT tested here: post-cutover, wrapping goes through
// the customer's SF managed package via makeSfApexKekProvider, which
// requires a live jsforce connection. The Apex side has its own test
// class (OrgloomKekServiceTest); the Node side's KekProvider call shape
// is exercised by the higher-level canvas-store / batch-store tests.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
	generateDataKey,
	encryptPayload,
	decryptPayload,
	isEncryptedEnvelope,
} from '../src/storage/canvas-encryption.js';

describe('canvas-encryption: payload encrypt/decrypt', () => {
	test('round-trips a payload', () => {
		const key = generateDataKey();
		const plaintext = JSON.stringify({ drafts: [{ tempId: 1, values: { Name: 'A' } }] });
		const envelope = encryptPayload(plaintext, key);
		assert.equal(isEncryptedEnvelope(envelope), true);
		const decrypted = decryptPayload(envelope, key);
		assert.equal(decrypted, plaintext);
	});

	test('envelope detection: legacy plaintext JSON is NOT an envelope', () => {
		const buf = Buffer.from('{"foo":1}', 'utf8');
		assert.equal(isEncryptedEnvelope(buf), false);
	});

	test('tampered ciphertext fails authentication', () => {
		const key = generateDataKey();
		const envelope = encryptPayload('{"x":1}', key);
		// Flip a bit in the ciphertext body. Buffer is mutable; modify a
		// byte past the header.
		envelope[envelope.length - 1] ^= 0x01;
		assert.throws(() => decryptPayload(envelope, key));
	});

	test('wrong data key fails to decrypt', () => {
		const k1 = generateDataKey();
		const k2 = generateDataKey();
		const envelope = encryptPayload('{"x":1}', k1);
		assert.throws(() => decryptPayload(envelope, k2));
	});

	test('decryptPayload rejects a non-envelope buffer', () => {
		const key = generateDataKey();
		const notEnv = Buffer.from('{"foo":1}', 'utf8');
		assert.throws(() => decryptPayload(notEnv, key), /not an OLE2 envelope/);
	});

	test('encryptPayload rejects non-string plaintext', () => {
		const key = generateDataKey();
		assert.throws(() => encryptPayload(Buffer.from('x'), key), /must be a string/);
	});

	test('generateDataKey returns 32 bytes', () => {
		const key = generateDataKey();
		assert.equal(key.length, 32);
	});
});
