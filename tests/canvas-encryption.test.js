import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
	generateDataKey,
	encryptPayload,
	decryptPayload,
	isEncryptedEnvelope,
	makeSfApexKekProvider,
	__resetKekCacheForTests,
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

describe('canvas-encryption: Salesforce KEK recovery', () => {
	test('an unbootstrapped package is ensured once and the wrap is retried', async () => {
		__resetKekCacheForTests();
		const realFetch = global.fetch;
		const calls = [];
		global.fetch = async (url, options) => {
			calls.push({ url: String(url), body: JSON.parse(options.body) });
			if (String(url).endsWith('/kek/wrap') && calls.length === 1) {
				return {
					ok: false,
					status: 400,
					async json() {
						return {
							error: 'kek-error',
							message: 'KEK not bootstrapped; call ensureKek() first',
						};
					},
				};
			}
			if (String(url).endsWith('/kek/ensure')) {
				return {
					ok: true,
					status: 200,
					async json() {
						return { ok: true };
					},
				};
			}
			return {
				ok: true,
				status: 200,
				async json() {
					return { wrapped: 'wrapped-dek' };
				},
			};
		};
		try {
			const provider = makeSfApexKekProvider({
				instanceUrl: 'https://example.my.salesforce.com',
				accessToken: 'token',
			});
			const wrapped = await provider.wrapDataKey(generateDataKey());
			assert.equal(wrapped.wrappedKey, 'wrapped-dek');
			assert.deepEqual(
				calls.map((call) => new URL(call.url).pathname),
				[
					'/services/apexrest/orgloom/orgloom/kek/wrap',
					'/services/apexrest/orgloom/orgloom/kek/ensure',
					'/services/apexrest/orgloom/orgloom/kek/wrap',
				],
			);
		} finally {
			global.fetch = realFetch;
			__resetKekCacheForTests();
		}
	});

	test('other wrapping failures are not retried or converted into bootstrap attempts', async () => {
		__resetKekCacheForTests();
		const realFetch = global.fetch;
		let callCount = 0;
		global.fetch = async () => {
			callCount += 1;
			return {
				ok: false,
				status: 403,
				async json() {
					return { error: 'forbidden', message: 'Apex class access required' };
				},
			};
		};
		try {
			const provider = makeSfApexKekProvider({
				instanceUrl: 'https://example.my.salesforce.com',
				accessToken: 'token',
			});
			await assert.rejects(() => provider.wrapDataKey(generateDataKey()), /forbidden/);
			assert.equal(callCount, 1);
		} finally {
			global.fetch = realFetch;
			__resetKekCacheForTests();
		}
	});
});
