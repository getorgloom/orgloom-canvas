// Tests for OrgloomKekService. Cover bootstrap idempotency, wrap/unwrap
// round-trip, tamper detection on the MAC, IV uniqueness across calls,
// and rejection of unsupported envelope versions.
@isTest
private class OrgloomKekServiceTest {

	@isTest
	static void bootstrap_isIdempotent() {
		Test.startTest();
		OrgloomKekService.ensureKek();
		Org_Kek_Setting__c first = [SELECT Wrapped_Key__c, Key_Version__c FROM Org_Kek_Setting__c WHERE Name = 'default' LIMIT 1];
		System.assertNotEquals(null, first);
		System.assert(String.isNotBlank(first.Wrapped_Key__c), 'KEK should be populated');
		System.assertEquals(1, (Integer) first.Key_Version__c, 'first bootstrap should land at v1');
		String firstKey = first.Wrapped_Key__c;

		OrgloomKekService.ensureKek();
		Org_Kek_Setting__c second = [SELECT Wrapped_Key__c, Key_Version__c FROM Org_Kek_Setting__c WHERE Name = 'default' LIMIT 1];
		System.assertEquals(firstKey, second.Wrapped_Key__c, 'second ensureKek must not regenerate');
		Test.stopTest();
	}

	@isTest
	static void wrap_unwrap_roundtrip() {
		OrgloomKekService.ensureKek();
		Test.startTest();
		Blob dek = Crypto.generateAesKey(256);
		String dekB64 = EncodingUtil.base64Encode(dek);
		String wrapped = OrgloomKekService.wrapDek(dekB64);
		System.assert(String.isNotBlank(wrapped), 'wrap should return non-empty envelope');
		String unwrapped = OrgloomKekService.unwrapDek(wrapped);
		System.assertEquals(dekB64, unwrapped, 'round-trip must preserve DEK bytes exactly');
		Test.stopTest();
	}

	@isTest
	static void wrap_produces_distinct_envelopes_for_same_dek() {
		// IV is random per wrap; identical inputs must NOT produce identical
		// ciphertexts (otherwise an attacker observing two wraps would learn
		// the inputs were equal).
		OrgloomKekService.ensureKek();
		Test.startTest();
		Blob dek = Crypto.generateAesKey(256);
		String dekB64 = EncodingUtil.base64Encode(dek);
		String w1 = OrgloomKekService.wrapDek(dekB64);
		String w2 = OrgloomKekService.wrapDek(dekB64);
		System.assertNotEquals(w1, w2, 'distinct wraps of the same DEK must use fresh IVs');
		Test.stopTest();
	}

	@isTest
	static void unwrap_rejects_tampered_ciphertext() {
		OrgloomKekService.ensureKek();
		Test.startTest();
		Blob dek = Crypto.generateAesKey(256);
		String wrapped = OrgloomKekService.wrapDek(EncodingUtil.base64Encode(dek));
		Blob envelope = EncodingUtil.base64Decode(wrapped);
		// Flip one bit in the ciphertext region: byte 20 sits past the
		// version (1B) + IV (16B) = 17, so 20 is firmly inside ciphertext.
		String hex = EncodingUtil.convertToHex(envelope);
		// XOR target nibble with 0xF
		Integer targetCharIdx = 40; // hex char 40 == byte 20
		String orig = hex.substring(targetCharIdx, targetCharIdx + 1);
		Integer origVal = '0123456789abcdef'.indexOf(orig.toLowerCase());
		String flipped = '0123456789abcdef'.substring(15 - origVal, 16 - origVal);
		String tampered = hex.substring(0, targetCharIdx) + flipped + hex.substring(targetCharIdx + 1);
		String tamperedB64 = EncodingUtil.base64Encode(EncodingUtil.convertFromHex(tampered));

		Boolean threw = false;
		try {
			OrgloomKekService.unwrapDek(tamperedB64);
		} catch (OrgloomKekService.KekException e) {
			threw = true;
			System.assert(
				e.getMessage().contains('mac verification failed'),
				'tampered envelope must fail MAC check, not AES decrypt: got ' + e.getMessage()
			);
		}
		System.assert(threw, 'tampered envelope must throw');
		Test.stopTest();
	}

	@isTest
	static void unwrap_rejects_tampered_mac() {
		OrgloomKekService.ensureKek();
		Test.startTest();
		Blob dek = Crypto.generateAesKey(256);
		String wrapped = OrgloomKekService.wrapDek(EncodingUtil.base64Encode(dek));
		Blob envelope = EncodingUtil.base64Decode(wrapped);
		String hex = EncodingUtil.convertToHex(envelope);
		// Flip the last hex char (inside the MAC).
		Integer lastIdx = hex.length() - 1;
		String orig = hex.substring(lastIdx, lastIdx + 1);
		Integer origVal = '0123456789abcdef'.indexOf(orig.toLowerCase());
		String flipped = '0123456789abcdef'.substring(15 - origVal, 16 - origVal);
		String tampered = hex.substring(0, lastIdx) + flipped;
		String tamperedB64 = EncodingUtil.base64Encode(EncodingUtil.convertFromHex(tampered));

		Boolean threw = false;
		try {
			OrgloomKekService.unwrapDek(tamperedB64);
		} catch (OrgloomKekService.KekException e) {
			threw = true;
		}
		System.assert(threw, 'tampered MAC must throw');
		Test.stopTest();
	}

	@isTest
	static void unwrap_rejects_unsupported_version() {
		OrgloomKekService.ensureKek();
		Test.startTest();
		Blob dek = Crypto.generateAesKey(256);
		String wrapped = OrgloomKekService.wrapDek(EncodingUtil.base64Encode(dek));
		Blob envelope = EncodingUtil.base64Decode(wrapped);
		String hex = EncodingUtil.convertToHex(envelope);
		// Replace version byte with 0xff (unknown version).
		String tampered = 'ff' + hex.substring(2);
		String tamperedB64 = EncodingUtil.base64Encode(EncodingUtil.convertFromHex(tampered));

		Boolean threw = false;
		try {
			OrgloomKekService.unwrapDek(tamperedB64);
		} catch (OrgloomKekService.KekException e) {
			threw = true;
			System.assert(
				e.getMessage().contains('unsupported envelope version'),
				'expected version rejection, got: ' + e.getMessage()
			);
		}
		System.assert(threw, 'unknown version must throw');
		Test.stopTest();
	}

	@isTest
	static void wrap_rejects_empty_input() {
		OrgloomKekService.ensureKek();
		Test.startTest();
		Boolean threwBlank = false;
		try {
			OrgloomKekService.wrapDek('');
		} catch (OrgloomKekService.KekException e) {
			threwBlank = true;
		}
		System.assert(threwBlank, 'empty dek must reject');
		Test.stopTest();
	}

	@isTest
	static void wrap_rejects_non_32_byte_dek() {
		// The contract is a 32-byte AES-256 DEK. A short (or long) payload
		// is a corrupted caller and must be rejected at wrap time, not
		// discovered at decrypt time months later.
		OrgloomKekService.ensureKek();
		Test.startTest();
		Boolean threw = false;
		try {
			OrgloomKekService.wrapDek(EncodingUtil.base64Encode(Blob.valueOf('only-16-bytes!!!')));
		} catch (OrgloomKekService.KekException e) {
			threw = true;
			System.assert(
				e.getMessage().contains('32 bytes'),
				'expected 32-byte contract error, got: ' + e.getMessage()
			);
		}
		System.assert(threw, 'non-32-byte dek must reject');
		Test.stopTest();
	}

	@isTest
	static void unwrap_rejects_short_envelope() {
		OrgloomKekService.ensureKek();
		Test.startTest();
		Boolean threw = false;
		try {
			OrgloomKekService.unwrapDek(EncodingUtil.base64Encode(Blob.valueOf('short')));
		} catch (OrgloomKekService.KekException e) {
			threw = true;
		}
		System.assert(threw, 'too-short envelope must throw');
		Test.stopTest();
	}

	@isTest
	static void wrap_throws_without_bootstrap() {
		// No ensureKek() call: wrap should refuse to invent one silently.
		Test.startTest();
		Boolean threw = false;
		try {
			OrgloomKekService.wrapDek(EncodingUtil.base64Encode(Crypto.generateAesKey(256)));
		} catch (OrgloomKekService.KekException e) {
			threw = true;
			System.assert(
				e.getMessage().contains('not bootstrapped'),
				'expected not-bootstrapped error, got: ' + e.getMessage()
			);
		}
		System.assert(threw, 'wrap without prior ensureKek must throw');
		Test.stopTest();
	}

	@isTest
	static void constantTimeEquals_handles_lengths_and_content() {
		// White-box test of the timing-safe comparator. Same length +
		// equal contents → true. Same length + diff → false. Mismatched
		// lengths → false. Null inputs → false.
		Test.startTest();
		Blob a = EncodingUtil.convertFromHex('deadbeef');
		Blob b = EncodingUtil.convertFromHex('deadbeef');
		Blob c = EncodingUtil.convertFromHex('deadbeee');
		Blob d = EncodingUtil.convertFromHex('deadbe');
		System.assert(OrgloomKekService.constantTimeEquals(a, b), 'identical blobs must compare equal');
		System.assert(!OrgloomKekService.constantTimeEquals(a, c), 'one-bit-different blobs must compare unequal');
		System.assert(!OrgloomKekService.constantTimeEquals(a, d), 'different-length blobs must compare unequal');
		System.assert(!OrgloomKekService.constantTimeEquals(null, b), 'null must compare unequal');
		Test.stopTest();
	}
}
