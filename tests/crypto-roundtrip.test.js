











import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';




process.env.ENCRYPTION_KEY = '0123456789abcdef'.repeat(4);

let encrypt, decrypt, isEncryptionAvailable;
before(async () => {
	const mod = await import('../src/database/crypto.js');
	encrypt = mod.encrypt;
	decrypt = mod.decrypt;
	isEncryptionAvailable = mod.isEncryptionAvailable;
});

describe('crypto round-trip', () => {
	test('encryption is available with a valid key', () => {
		assert.equal(isEncryptionAvailable(), true);
	});

	test('decrypt(encrypt(x)) === x for ascii, unicode, and long input', () => {
		const cases = [
			'hello',
			'00DAa00000abcde!ARQAQ...long.SF.refresh.token-style.string',
			'unicode: åéîøü 中文 🔐',
			'x'.repeat(4096),
		];
		for (const pt of cases) {
			const ct = encrypt(pt);
			assert.equal(decrypt(ct), pt);
		}
	});

	test('encrypting the same plaintext twice produces different ciphertext', () => {
		const pt = 'identical-token-across-rows';
		const a = encrypt(pt);
		const b = encrypt(pt);
		assert.notEqual(a, b, 'IV randomization not visible — would leak duplicates');
		assert.equal(decrypt(a), pt);
		assert.equal(decrypt(b), pt);
	});

	test('ciphertext format is iv:ct:tag (three hex parts)', () => {
		const ct = encrypt('x');
		const parts = ct.split(':');
		assert.equal(parts.length, 3);
		assert.match(parts[0], /^[0-9a-f]{24}$/, '12-byte IV (24 hex chars)');
		assert.match(parts[1], /^[0-9a-f]+$/);
		assert.match(parts[2], /^[0-9a-f]{32}$/, '16-byte auth tag (32 hex chars)');
	});

	test('flipping a bit in the ciphertext body throws', () => {
		const ct = encrypt('payload');
		const [iv, body, tag] = ct.split(':');

		const tampered = body.slice(0, 2) === '00' ? 'ff' + body.slice(2) : '00' + body.slice(2);
		assert.throws(() => decrypt(iv + ':' + tampered + ':' + tag));
	});

	test('tampering with the auth tag throws', () => {
		const ct = encrypt('payload');
		const [iv, body, tag] = ct.split(':');
		const tampered = tag.slice(0, -2) + (tag.slice(-2) === '00' ? 'ff' : '00');
		assert.throws(() => decrypt(iv + ':' + body + ':' + tampered));
	});

	test('swapping the IV between two ciphertexts throws', () => {
		const a = encrypt('alpha');
		const b = encrypt('beta');
		const [ivA, , ] = a.split(':');
		const [, bodyB, tagB] = b.split(':');
		assert.throws(() => decrypt(ivA + ':' + bodyB + ':' + tagB));
	});

	test('malformed ciphertext (wrong shape) throws a clear error', () => {
		assert.throws(() => decrypt('not-hex'), /malformed/);
		assert.throws(() => decrypt('aa:bb'), /malformed/);
		assert.throws(() => decrypt(42), /string/);
	});

	test('encrypt rejects non-string or empty plaintext', () => {
		assert.throws(() => encrypt(''), /non-empty/);
		assert.throws(() => encrypt(null), /string/);
		assert.throws(() => encrypt(undefined), /string/);
		assert.throws(() => encrypt(42), /string/);
	});
});
