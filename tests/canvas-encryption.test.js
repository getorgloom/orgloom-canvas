
















import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
	generateDataKey,
	encryptPayload,
	decryptPayload,
	isEncryptedEnvelope,
} from '../src/storage/canvas-encryption.js';

describe('canvas-encryption — payload encrypt/decrypt', () => {
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
