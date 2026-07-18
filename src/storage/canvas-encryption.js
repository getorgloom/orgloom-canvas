// Canvas envelopes use AES-256-GCM; DEKs are wrapped by the managed package's org-local KEK.
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MAGIC = Buffer.from('OLE2', 'ascii');
const MAGIC_BYTES = MAGIC.length;
const HEADER_BYTES = MAGIC_BYTES + IV_BYTES + AUTH_TAG_BYTES;

const KEK_VERSION_SENTINEL_SF_APEX = 0;

export function generateDataKey() {
	return randomBytes(KEY_BYTES);
}

export function encryptPayload(plaintextJson, dataKey) {
	if (typeof plaintextJson !== 'string') {
		throw new Error('encryptPayload: plaintextJson must be a string');
	}
	if (!Buffer.isBuffer(dataKey) || dataKey.length !== KEY_BYTES) {
		throw new Error('encryptPayload: dataKey must be a 32-byte Buffer');
	}
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv(ALGO, dataKey, iv);
	const ciphertext = Buffer.concat([cipher.update(plaintextJson, 'utf8'), cipher.final()]);
	const authTag = cipher.getAuthTag();
	return Buffer.concat([MAGIC, iv, authTag, ciphertext]);
}

export function isEncryptedEnvelope(blob) {
	if (!Buffer.isBuffer(blob) || blob.length < HEADER_BYTES) {
		return false;
	}
	return blob.slice(0, MAGIC_BYTES).equals(MAGIC);
}

export function decryptPayload(envelope, dataKey) {
	if (!isEncryptedEnvelope(envelope)) {
		throw new Error('decryptPayload: input is not an OLE2 envelope');
	}
	if (!Buffer.isBuffer(dataKey) || dataKey.length !== KEY_BYTES) {
		throw new Error('decryptPayload: dataKey must be a 32-byte Buffer');
	}
	const iv = envelope.slice(MAGIC_BYTES, MAGIC_BYTES + IV_BYTES);
	const authTag = envelope.slice(MAGIC_BYTES + IV_BYTES, HEADER_BYTES);
	const ciphertext = envelope.slice(HEADER_BYTES);
	const decipher = createDecipheriv(ALGO, dataKey, iv);
	decipher.setAuthTag(authTag);
	const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
	return plaintext.toString('utf8');
}

export function makeSfApexKekProvider(conn) {
	// Only packaged Apex can use the protected KEK; Org Loom handles wrapped keys or transient DEKs.
	if (!conn || !conn.instanceUrl || !conn.accessToken) {
		throw new Error('makeSfApexKekProvider: conn with instanceUrl + accessToken required');
	}
	return Object.freeze({
		name: 'sf-apex',
		async wrapDataKey(dataKey) {
			if (!Buffer.isBuffer(dataKey) || dataKey.length !== KEY_BYTES) {
				throw new Error('sf-apex.wrapDataKey: dataKey must be a 32-byte Buffer');
			}
			const dekB64 = dataKey.toString('base64');
			const response = await _apexKekRequest(conn, '/wrap', { dek: dekB64 });
			if (!response || typeof response.wrapped !== 'string') {
				throw new Error('sf-apex.wrapDataKey: Apex did not return a "wrapped" string');
			}
			return {
				wrappedKey: response.wrapped,
				iv: null,
				authTag: null,
				masterKeyVersion: KEK_VERSION_SENTINEL_SF_APEX,
			};
		},
		async unwrapDataKey(wrapped) {
			if (!wrapped || typeof wrapped.wrappedKey !== 'string') {
				throw new Error('sf-apex.unwrapDataKey: wrappedKey required');
			}
			const response = await _apexKekRequest(conn, '/unwrap', { wrapped: wrapped.wrappedKey });
			if (!response || typeof response.dek !== 'string') {
				throw new Error('sf-apex.unwrapDataKey: Apex did not return a "dek" string');
			}
			const dek = Buffer.from(response.dek, 'base64');
			if (dek.length !== KEY_BYTES) {
				throw new Error(
					'sf-apex.unwrapDataKey: dek decoded to ' + dek.length + ' bytes, expected ' + KEY_BYTES,
				);
			}
			return dek;
		},
	});
}

async function _apexKekRequest(conn, suffix, body) {
	const url = conn.instanceUrl.replace(/\/+$/, '') + '/services/apexrest/orgloom/orgloom/kek' + suffix;
	const res = await fetch(url, {
		method: 'POST',
		headers: {
			Authorization: 'Bearer ' + conn.accessToken,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		let detail = 'HTTP ' + res.status;
		try {
			const parsed = await res.json();
			if (parsed && (parsed.error || parsed.message)) {
				detail = (parsed.error || 'kek-error') + ': ' + (parsed.message || '');
			}
		} catch (_) {
			/* response wasn't JSON */
		}
		throw new Error('Apex KEK call failed (POST /orgloom/kek' + suffix + '): ' + detail);
	}
	return res.json();
}

export async function ensureSfApexKek(conn) {
	if (!conn || !conn.instanceUrl || !conn.accessToken) {
		throw new Error('ensureSfApexKek: conn with instanceUrl + accessToken required');
	}
	const response = await _apexKekRequest(conn, '/ensure', {});
	if (!response || response.ok !== true) {
		throw new Error('ensureSfApexKek: Apex did not return {ok:true}, got ' + JSON.stringify(response));
	}
	return true;
}

const CACHE_ENTRY_TTL_MS = 60 * 60 * 1000; // 1h
const CACHE_MAX_ENTRIES = 5000;
const _kekCache = new Map(); // key (sessionId|scope|id) → { dek, expiresAt }

function _cacheKey(sessionId, scope, id) {
	return sessionId + '|' + scope + '|' + id;
}

function _cacheGet(key) {
	const entry = _kekCache.get(key);
	if (!entry) {
		return null;
	}
	if (entry.expiresAt < Date.now()) {
		_kekCache.delete(key);
		return null;
	}
	return entry.dek;
}

function _cachePut(key, dek) {
	if (_kekCache.size >= CACHE_MAX_ENTRIES) {
		const firstKey = _kekCache.keys().next().value;
		if (firstKey !== undefined) {
			_kekCache.delete(firstKey);
		}
	}
	_kekCache.set(key, { dek, expiresAt: Date.now() + CACHE_ENTRY_TTL_MS });
}

export function clearKekCacheForSession(sessionId) {
	// Sign-out and disconnect clear every transient DEK associated with the server session.
	if (!sessionId) {
		return 0;
	}
	const prefix = sessionId + '|';
	let n = 0;
	for (const k of _kekCache.keys()) {
		if (k.startsWith(prefix)) {
			_kekCache.delete(k);
			n += 1;
		}
	}
	return n;
}

export function getCachedDek(sessionId, scope, id) {
	if (!sessionId || !scope || !id) {
		return null;
	}
	return _cacheGet(_cacheKey(sessionId, scope, id));
}

export function putCachedDek(sessionId, scope, id, dek) {
	if (!sessionId || !scope || !id || !dek) {
		return;
	}
	_cachePut(_cacheKey(sessionId, scope, id), dek);
}

export function __resetKekCacheForTests() {
	_kekCache.clear();
}
