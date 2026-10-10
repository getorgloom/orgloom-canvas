// Tests for the OrgloomKekRest REST surface. Exercises the request/
// response shape end-to-end: HTTP method dispatch, JSON body parsing,
// status codes, and error envelope shape.
@isTest
private class OrgloomKekRestTest {

	private static RestRequest buildRequest(String path, String bodyJson) {
		RestRequest req = new RestRequest();
		req.requestURI = '/services/apexrest/orgloom/kek/' + path;
		req.httpMethod = 'POST';
		if (bodyJson != null) {
			req.requestBody = Blob.valueOf(bodyJson);
		}
		return req;
	}

	private static Map<String, Object> invokeAndParse(String path, String bodyJson) {
		RestContext.request = buildRequest(path, bodyJson);
		RestContext.response = new RestResponse();
		OrgloomKekRest.doPost();
		String raw = RestContext.response.responseBody == null ? '' : RestContext.response.responseBody.toString();
		return raw.length() == 0
			? new Map<String, Object>()
			: (Map<String, Object>) JSON.deserializeUntyped(raw);
	}

	@isTest
	static void accessReturnsCurrentUsersNamedAssignmentState() {
		User unassignedUser = makeUser('unassigned');
		Test.startTest();
		System.runAs(unassignedUser) {
			Map<String, Object> body = invokeAndParse('access', '{}');
			System.assertEquals(200, RestContext.response.statusCode);
			System.assertEquals(true, body.get('ok'));
			System.assertEquals(false, body.get('granted'));
			System.assertEquals('named-permission-set-assignment-v1', body.get('verification'));
		}
		Test.stopTest();
	}

	@isTest
	static void accessAcceptsExplicitOrgloomUserAssignment() {
		User assignedUser = makeUser('assigned');
		PermissionSet orgloomUser = [
			SELECT Id
			FROM PermissionSet
			WHERE NamespacePrefix = 'orgloom' AND Name = 'Orgloom_User'
			LIMIT 1
		];
		insert new PermissionSetAssignment(
			AssigneeId = assignedUser.Id,
			PermissionSetId = orgloomUser.Id
		);

		Test.startTest();
		System.runAs(assignedUser) {
			Map<String, Object> body = invokeAndParse('access', '{}');
			System.assertEquals(200, RestContext.response.statusCode);
			System.assertEquals(true, body.get('granted'));
			System.assertEquals('named-permission-set-assignment-v1', body.get('verification'));
		}
		Test.stopTest();
	}

	private static User makeUser(String suffix) {
		String unique = String.valueOf(DateTime.now().getTime()) + suffix;
		User userRecord = new User(
			Alias = ('ol' + suffix).left(8),
			Email = unique + '@example.com',
			EmailEncodingKey = 'UTF-8',
			LastName = 'Orgloom ' + suffix,
			LanguageLocaleKey = 'en_US',
			LocaleSidKey = 'en_US',
			ProfileId = UserInfo.getProfileId(),
			TimeZoneSidKey = 'America/Los_Angeles',
			Username = unique + '@example.com'
		);
		insert userRecord;
		return userRecord;
	}

	@isTest
	static void ensureReturnsOk() {
		Test.startTest();
		Map<String, Object> body = invokeAndParse('ensure', '{}');
		System.assertEquals(200, RestContext.response.statusCode);
		System.assertEquals(true, body.get('ok'));
		// Idempotent: second call must also return ok.
		body = invokeAndParse('ensure', '{}');
		System.assertEquals(200, RestContext.response.statusCode);
		System.assertEquals(true, body.get('ok'));
		Test.stopTest();
	}

	@isTest
	static void wrapThenUnwrapViaRest() {
		invokeAndParse('ensure', '{}');
		Test.startTest();
		String dekB64 = EncodingUtil.base64Encode(Crypto.generateAesKey(256));
		Map<String, Object> wrappedRes = invokeAndParse(
			'wrap',
			JSON.serialize(new Map<String, Object>{ 'dek' => dekB64 })
		);
		System.assertEquals(200, RestContext.response.statusCode);
		String wrapped = (String) wrappedRes.get('wrapped');
		System.assert(String.isNotBlank(wrapped), 'wrap response must include "wrapped"');

		Map<String, Object> unwrappedRes = invokeAndParse(
			'unwrap',
			JSON.serialize(new Map<String, Object>{ 'wrapped' => wrapped })
		);
		System.assertEquals(200, RestContext.response.statusCode);
		System.assertEquals(dekB64, (String) unwrappedRes.get('dek'), 'round-trip via REST preserves DEK');
		Test.stopTest();
	}

	@isTest
	static void wrapMissingDekReturns400() {
		invokeAndParse('ensure', '{}');
		Test.startTest();
		Map<String, Object> res = invokeAndParse('wrap', '{}');
		System.assertEquals(400, RestContext.response.statusCode);
		System.assertEquals('dek-required', (String) res.get('error'));
		Test.stopTest();
	}

	@isTest
	static void unwrapMissingWrappedReturns400() {
		invokeAndParse('ensure', '{}');
		Test.startTest();
		Map<String, Object> res = invokeAndParse('unwrap', '{}');
		System.assertEquals(400, RestContext.response.statusCode);
		System.assertEquals('wrapped-required', (String) res.get('error'));
		Test.stopTest();
	}

	@isTest
	static void unwrapWithGarbageReturnsKekError() {
		invokeAndParse('ensure', '{}');
		Test.startTest();
		Map<String, Object> res = invokeAndParse(
			'unwrap',
			JSON.serialize(new Map<String, Object>{ 'wrapped' => 'not-a-real-envelope-but-base64ish' })
		);
		System.assertEquals(400, RestContext.response.statusCode);
		System.assertEquals('kek-error', (String) res.get('error'));
		Test.stopTest();
	}

	@isTest
	static void unknownPathReturns404() {
		Test.startTest();
		Map<String, Object> res = invokeAndParse('made-up-action', '{}');
		System.assertEquals(404, RestContext.response.statusCode);
		System.assertEquals('unknown-path', (String) res.get('error'));
		Test.stopTest();
	}

	@isTest
	static void malformedJsonBodyIsRejected() {
		Test.startTest();
		Map<String, Object> res = invokeAndParse('wrap', '"not-an-object"');
		// JSON parses but is not a Map → service throws KekError → 400.
		System.assertEquals(400, RestContext.response.statusCode);
		System.assertEquals('kek-error', (String) res.get('error'));
		Test.stopTest();
	}
}
