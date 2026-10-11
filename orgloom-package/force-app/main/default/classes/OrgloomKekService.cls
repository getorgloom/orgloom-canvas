// Key-encryption-key (KEK) service. Stores a per-org KEK in the
// Org_Kek_Setting__c custom object (one record per org) and exposes
// wrap/unwrap of per-canvas data encryption keys (DEKs) via Apex.
//
// Protection model:
//   * Org_Kek_Setting__c is a PROTECTED List custom setting. Protected
//     visibility means the subscriber org cannot read the KEK material by
//     ANY route: not via SOQL, not in the Setup UI, not through the
//     REST/SOAP API, and not from Apex outside the orgloom namespace.
//     This holds even against a subscriber System Administrator with
//     View All Data / Modify All Data (unlike a plain custom object,
//     which such a profile could read directly).
//   * Only Apex compiled in the Org Loom (orgloom) namespace, meaning this
//     managed package's own classes, can read or write the setting.
//   * Net result: only the Org Loom managed package's Apex methods can
//     use the KEK. The KEK material never leaves SF.
//
// Why this lives in the customer's org:
//   * Compromise of Org Loom's databases yields no decryption capability.
//     The KEK never leaves SF; only wrapped DEKs (which require the KEK
//     to unwrap) are stored on Org Loom's side.
//   * Subscriber boundary: the Protected setting cannot be inspected,
//     edited, or deleted by subscriber users or administrators. The v1
//     REST surface intentionally exposes no key-destruction operation.
//
// Crypto:
//   * Apex's Crypto class supports AES-128/192/256 in CBC mode only;
//     no GCM. We therefore use AES-256-CBC for confidentiality and
//     HMAC-SHA256 for integrity (encrypt-then-MAC).
//   * Single 32-byte KEK material. The HMAC key is derived from the
//     KEK via HMAC-SHA256(KEK, "orgloom-kek-hmac-v1") so we don't have
//     to store / version two keys independently.
//   * Envelope = version(1) || IV(16) || ciphertext(N) || mac(32).
public without sharing class OrgloomKekService {

	// The single KEK row is keyed by the built-in Name field of the List
	// custom setting. One KEK per org.
	@TestVisible
	private static final String DEFAULT_SETTING_NAME = 'default';

	private static final String ALGO_TAG = 'AES-256-CBC+HMAC-SHA256';
	private static final Integer ENVELOPE_VERSION = 1;
	private static final Integer IV_BYTES = 16;
	private static final Integer MAC_BYTES = 32; // SHA-256 output
	private static final Integer MIN_ENVELOPE_BYTES = 1 + IV_BYTES + MAC_BYTES;

	// Domain-separation context for HMAC subkey derivation. Bumping this
	// string is equivalent to invalidating all wrapped DEKs (every prior
	// wrap was MAC'd under the old derivation), so don't change it
	// casually.
	private static final Blob HMAC_DERIVATION_INFO = Blob.valueOf('orgloom-kek-hmac-v1');

	// Custom exception. Apex auto-generates the standard Exception
	// constructors (no-arg, String, Exception, String+Exception) when
	// you extend Exception; declaring them explicitly is a compile
	// error. We just declare the class and use `new KekException('...')`
	// directly.
	public class KekException extends Exception {}

	// Idempotent bootstrap. Safe to call repeatedly: generates the KEK
	// on first call, returns silently thereafter. Should be invoked
	// during the Org Loom OAuth callback flow, behind permset gating.
	public static void ensureKek() {
		Org_Kek_Setting__c existing = loadKekRecord();
		if (existing != null && String.isNotBlank(existing.Wrapped_Key__c)) {
			return;
		}
		Blob kek = Crypto.generateAesKey(256);
		Org_Kek_Setting__c rec = existing != null
			? existing
			: new Org_Kek_Setting__c(Name = DEFAULT_SETTING_NAME);
		rec.Wrapped_Key__c = EncodingUtil.base64Encode(kek);
		rec.Algorithm__c = ALGO_TAG;
		rec.Key_Version__c = 1;
		// Intentional system-mode operation. Org_Kek_Setting__c is a protected
		// package custom setting: subscriber CRUD/FLS cannot grant direct access,
		// and only Apex in this namespace can read or write it. The caller must
		// separately have access to OrgloomKekRest/OrgloomKekService through an
		// Orgloom permission set. User-mode DML would defeat the protected-secret
		// boundary by making KEK bootstrap depend on subscriber object grants.
		// code-analyzer-suppress-next-line pmd:ApexCRUDViolation
		upsert rec;
	}

	// Wrap a DEK under the org's KEK. dekBase64 is a 32-byte AES-256 key
	// encoded as base64. Returns base64(version || iv || ciphertext || mac).
	public static String wrapDek(String dekBase64) {
		if (String.isBlank(dekBase64)) {
			throw new KekException('dek required');
		}
		Blob dek;
		try {
			dek = EncodingUtil.base64Decode(dekBase64);
		} catch (Exception e) {
			throw new KekException('dek not valid base64');
		}
		if (dek == null || dek.size() == 0) {
			throw new KekException('dek empty');
		}
		// The contract is a 32-byte AES-256 DEK (the Node caller generates
		// exactly that). Enforcing it here catches a corrupted caller
		// early, at wrap time, not months later when a malformed key
		// fails to decrypt someone's canvas.
		if (dek.size() != 32) {
			throw new KekException('dek must be 32 bytes (got ' + dek.size() + ')');
		}
		Blob kek = loadKek();
		Blob hmacKey = deriveHmacKey(kek);
		Blob iv = Crypto.generateAesKey(128); // 128-bit AES key happens to be 16 random bytes, exactly the IV width we want
		Blob ciphertext = Crypto.encrypt('AES256', kek, iv, dek);
		Blob versionBlob = EncodingUtil.convertFromHex(hex2(ENVELOPE_VERSION));
		Blob macInput = concat(new Blob[]{ versionBlob, iv, ciphertext });
		Blob mac = Crypto.generateMac('HmacSHA256', macInput, hmacKey);
		Blob envelope = concat(new Blob[]{ versionBlob, iv, ciphertext, mac });
		return EncodingUtil.base64Encode(envelope);
	}

	// Unwrap a previously-wrapped DEK. Verifies MAC in constant time
	// before decrypting; tampered envelopes fail before the ciphertext
	// ever reaches the AES decrypt call.
	public static String unwrapDek(String wrappedBase64) {
		if (String.isBlank(wrappedBase64)) {
			throw new KekException('wrapped required');
		}
		Blob envelope;
		try {
			envelope = EncodingUtil.base64Decode(wrappedBase64);
		} catch (Exception e) {
			throw new KekException('wrapped not valid base64');
		}
		Integer total = envelope.size();
		if (total < MIN_ENVELOPE_BYTES) {
			throw new KekException('envelope too short');
		}
		Blob versionBlob = slice(envelope, 0, 1);
		Integer version = firstByte(versionBlob);
		if (version != ENVELOPE_VERSION) {
			throw new KekException('unsupported envelope version');
		}
		Blob iv = slice(envelope, 1, IV_BYTES);
		Integer ctLen = total - 1 - IV_BYTES - MAC_BYTES;
		if (ctLen <= 0) {
			throw new KekException('ciphertext missing');
		}
		Blob ciphertext = slice(envelope, 1 + IV_BYTES, ctLen);
		Blob providedMac = slice(envelope, 1 + IV_BYTES + ctLen, MAC_BYTES);
		Blob kek = loadKek();
		Blob hmacKey = deriveHmacKey(kek);
		Blob macInput = concat(new Blob[]{ versionBlob, iv, ciphertext });
		Blob expectedMac = Crypto.generateMac('HmacSHA256', macInput, hmacKey);
		if (!constantTimeEquals(providedMac, expectedMac)) {
			throw new KekException('mac verification failed');
		}
		Blob dek = Crypto.decrypt('AES256', kek, iv, ciphertext);
		return EncodingUtil.base64Encode(dek);
	}

	// ---- Internals --------------------------------------------------------

	// Single SOQL against the singleton row, keyed by the custom setting's
	// Name. Because the setting is Protected, only orgloom-namespace Apex
	// (this class) can see the object at all; subscriber SOQL can't.
	//
	// ORDER BY is load-bearing: custom-setting Name is NOT uniqueness-
	// enforced at the DB tier, and ensureKek() is check-then-insert (two
	// concurrent bootstrap calls can both insert). If duplicate 'default'
	// rows ever exist with different KEKs, an unordered LIMIT 1 would flip
	// between them across calls: wrap under one KEK, unwrap under the
	// other, making canvases INTERMITTENTLY undecryptable. Deterministic
	// oldest-wins means every reader agrees on one KEK forever; a losing
	// duplicate is dead weight, never a decryption fault.
	private static Org_Kek_Setting__c loadKekRecord() {
		// Intentional system-mode query for the same protected-setting boundary
		// described in ensureKek(). No subscriber permission can expose this row;
		// package-class access is the authorization gate. WITH USER_MODE would
		// make ordinary authorized Orgloom users unable to use envelope encryption.
		// code-analyzer-suppress-next-line pmd:ApexCRUDViolation
		List<Org_Kek_Setting__c> rows = [
			SELECT Id, Name, Wrapped_Key__c, Algorithm__c, Key_Version__c
			FROM Org_Kek_Setting__c
			WHERE Name = :DEFAULT_SETTING_NAME
			ORDER BY CreatedDate ASC, Id ASC
			LIMIT 1
		];
		return rows.isEmpty() ? null : rows[0];
	}

	private static Blob loadKek() {
		Org_Kek_Setting__c rec = loadKekRecord();
		if (rec == null || String.isBlank(rec.Wrapped_Key__c)) {
			throw new KekException('KEK not bootstrapped; call ensureKek() first');
		}
		Blob kek = EncodingUtil.base64Decode(rec.Wrapped_Key__c);
		if (kek.size() != 32) {
			throw new KekException('KEK is not 256-bit');
		}
		return kek;
	}

	private static Blob deriveHmacKey(Blob kek) {
		// HMAC-SHA256(KEK, "orgloom-kek-hmac-v1"): single-step KDF.
		// Sufficient because the input KEK is uniformly random and the
		// label is fixed. Matches the Node-side derivation in
		// canvas-encryption.js once the KekProvider lands.
		return Crypto.generateMac('HmacSHA256', HMAC_DERIVATION_INFO, kek);
	}

	// Apex Blob has no native slice. Round-trip through hex for clarity;
	// payloads are small (KEK = 32 bytes, envelope < 200 bytes) so the
	// O(n) string overhead is irrelevant.
	@TestVisible
	private static Blob slice(Blob source, Integer offset, Integer length) {
		String hex = EncodingUtil.convertToHex(source);
		return EncodingUtil.convertFromHex(hex.substring(offset * 2, (offset + length) * 2));
	}

	@TestVisible
	private static Blob concat(Blob[] parts) {
		String hex = '';
		for (Blob p : parts) {
			hex += EncodingUtil.convertToHex(p);
		}
		return EncodingUtil.convertFromHex(hex);
	}

	@TestVisible
	private static Integer firstByte(Blob b) {
		return parseHex(EncodingUtil.convertToHex(b).substring(0, 2));
	}

	// 2-digit lowercase hex of a byte value (0–255). Apex has no
	// Integer.toString(value, base) overload, so we do the nibble
	// lookup by hand. Cheap and obvious; bytes only.
	private static final String[] HEX_DIGITS = new String[]{
		'0','1','2','3','4','5','6','7','8','9','a','b','c','d','e','f'
	};
	private static String hex2(Integer b) {
		Integer hi = (b / 16) & 15;
		Integer lo = b & 15;
		return HEX_DIGITS[hi] + HEX_DIGITS[lo];
	}

	// Apex has no Integer.valueOf(s, base). For our use this only
	// parses 2-char hex (a version byte / first envelope byte), so a
	// simple hand-rolled parser keeps the dependency footprint small.
	private static Integer parseHex(String hex) {
		String lower = hex.toLowerCase();
		Integer result = 0;
		for (Integer i = 0; i < lower.length(); i++) {
			Integer c = lower.charAt(i);
			Integer digit;
			if (c >= 48 && c <= 57) { // '0'..'9'
				digit = c - 48;
			} else if (c >= 97 && c <= 102) { // 'a'..'f'
				digit = c - 97 + 10;
			} else {
				throw new KekException('invalid hex character in envelope');
			}
			result = (result * 16) + digit;
		}
		return result;
	}

	// Constant-time blob equality. Differential timing would otherwise
	// leak which prefix of an attacker-supplied MAC matches; the loop
	// runs to full length regardless.
	@TestVisible
	private static Boolean constantTimeEquals(Blob a, Blob b) {
		if (a == null || b == null) {
			return false;
		}
		String hexA = EncodingUtil.convertToHex(a);
		String hexB = EncodingUtil.convertToHex(b);
		if (hexA.length() != hexB.length()) {
			return false;
		}
		Integer diff = 0;
		for (Integer i = 0; i < hexA.length(); i++) {
			diff |= (Integer) hexA.charAt(i) ^ (Integer) hexB.charAt(i);
		}
		return diff == 0;
	}
}
