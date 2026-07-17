// Server-side encryption for canvas payloads.
//
// Model:
//   * Each canvas (and upload batch) has a 32-byte AES-256-GCM data key
//     (DEK), generated server-side on first save.
//   * The DEK is wrapped via the customer's installed Org Loom managed
//     package by calling /services/apexrest/orgloom/orgloom/kek/wrap.
//     The KEK material lives in `Org_Kek_Setting__c` inside the
//     customer's SF org; Org Loom's database alone holds nothing that
//     can decrypt the data.
//   * Canvas payload JSON is encrypted with the DEK under AES-256-GCM.
//     The envelope (magic + IV + auth tag + ciphertext) goes into SF's
//     ContentVersion.VersionData.
//
// Envelope format (binary, base64-encoded for the SF blob):
//   bytes  0..3   ASCII "OLE2": magic + version tag (Org Loom
//                                  Encryption v2)
//   bytes  4..15  IV: 12 bytes (AES-GCM)
//   bytes 16..31  auth tag: 16 bytes
//   bytes 32..    ciphertext: variable
//
// The magic + fixed-size header lets the loader detect the envelope in
// one read. Legacy plaintext canvases (pre-encryption) start with `{`,
// which can't collide with "OLE2".
//
// History: pre-cutover, DEKs were wrapped with a local master keyring
// driven by ORGLOOM_MASTER_KEYS / ORGLOOM_MASTER_ENCRYPTION_KEY. That
// model required Org Loom to hold a key that could decrypt every
// customer's data. It was removed once the v0.5 managed package made
// KEK-in-org the only path; the masterKeyVersion column in
// canvas_keys / batch_keys is now always 0 (the sf-apex sentinel) and
// the iv / auth_tag columns are unused, kept for migration-free schema
// compatibility.

import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MAGIC = Buffer.from('OLE2', 'ascii');
const MAGIC_BYTES = MAGIC.length;
const HEADER_BYTES = MAGIC_BYTES + IV_BYTES + AUTH_TAG_BYTES;

// Sentinel stored in canvas_keys.master_key_version for every row
// written by this provider. The column existed in the master-keyring
// era as a real version number (1..N); the schema kept it and we
// stamp 0 to signal "KEK-wrapped, envelope is self-describing".
const KEK_VERSION_SENTINEL_SF_APEX = 0;

// Generate a fresh per-canvas / per-batch data key.
export function generateDataKey() {
	return randomBytes(KEY_BYTES);
}

// Encrypt a canvas payload (JSON string) with the given data key.
// Returns a Buffer containing the envelope: magic + IV + auth tag +
// ciphertext. Caller base64-encodes for SF's VersionData field.
export function encryptPayload(plaintextJson, dataKey) {
	if (typeof plaintextJson !== 'string') {
		throw new Error('encryptPayload: plaintextJson must be a string');
	}
	if (!Buffer.isBuffer(dataKey) || dataKey.length !== KEY_BYTES) {
		throw new Error('encryptPayload: dataKey must be a 32-byte Buffer');
	}
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv(ALGO, dataKey, iv);
	const ciphertext = Buffer.concat([
		cipher.update(plaintextJson, 'utf8'),
		cipher.final(),
	]);
	const authTag = cipher.getAuthTag();
	return Buffer.concat([MAGIC, iv, authTag, ciphertext]);
}

// Detect whether a blob is an OLE2 envelope by checking the magic
// header. Returns true for ciphertext, false for legacy plaintext
// (JSON starting with `{`). Cheap: just a Buffer compare on 4 bytes.
export function isEncryptedEnvelope(blob) {
	if (!Buffer.isBuffer(blob) || blob.length < HEADER_BYTES) {
		return false;
	}
	return blob.slice(0, MAGIC_BYTES).equals(MAGIC);
}

// Decrypt an OLE2 envelope. Throws if magic is missing, size is too
// small, or auth tag fails. Caller catches and surfaces a clear
// "decrypt failed"; corruption or tampering must NOT return mangled
// plaintext.
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
	const plaintext = Buffer.concat([
		decipher.update(ciphertext),
		decipher.final(),
	]);
	return plaintext.toString('utf8');
}

// ===========================================================================
// KekProvider: calls into the customer's SF Org Loom managed package
// ===========================================================================
//
// The provider is bound to a jsforce-style connection (must expose
// instanceUrl + accessToken). Tokens are read from the connection
// object on every call so a renewal in the same store instance flows
// through without rebinding.
//
// Persisted row shape (canvas_keys / batch_keys):
//   { wrappedKey: string, iv: null, authTag: null, masterKeyVersion: 0 }
//
// wrappedKey is the self-describing Apex envelope; iv / authTag are
// nullable holdovers from the pre-cutover schema.

export function makeSfApexKekProvider(conn) {
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
				throw new Error('sf-apex.unwrapDataKey: dek decoded to ' + dek.length + ' bytes, expected ' + KEY_BYTES);
			}
			return dek;
		},
	});
}

async function _apexKekRequest(conn, suffix, body) {
	// Managed-package REST endpoints are mounted under the package
	// namespace by Salesforce: the @RestResource urlMapping in
	// OrgloomKekRest is '/orgloom/kek/*', and SF prefixes it with the
	// installed namespace 'orgloom', giving the doubled segment
	// /services/apexrest/orgloom/orgloom/kek/*.
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
		} catch (_) { /* response wasn't JSON */ }
		throw new Error('Apex KEK call failed (POST /orgloom/kek' + suffix + '): ' + detail);
	}
	return res.json();
}

// Bootstrap the KEK in the customer's org. Idempotent: safe to call
// from the OAuth callback every sign-in. Returns true on success and
// throws on the first network / permission failure so the caller can
// route to /kek-bootstrap-failed instead of letting canvas reads break
// later.
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

// ===========================================================================
// Per-session DEK cache
// ===========================================================================
//
// Avoids a SF round-trip on every canvas read. Cache key =
// (sessionId, scope, id) where scope is 'canvas' / 'batch'.
//
// Lifetime:
//   * In-process Map; never persisted.
//   * Per-entry TTL of 1 hour.
//   * Eviction on logout via clearKekCacheForSession(sessionId), wired
//     into /auth/logout and /auth/sf-signout.
//   * Hard cap on cache size to bound memory; oldest evicted first.

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
		// Drop the oldest insertion. Map iteration order is insertion
		// order, so the first key is the oldest. Cheap LRU-ish.
		const firstKey = _kekCache.keys().next().value;
		if (firstKey !== undefined) {
			_kekCache.delete(firstKey);
		}
	}
	_kekCache.set(key, { dek, expiresAt: Date.now() + CACHE_ENTRY_TTL_MS });
}

export function clearKekCacheForSession(sessionId) {
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

// Test-only: drop all entries.
export function __resetKekCacheForTests() {
	_kekCache.clear();
}
