// REST surface for OrgloomKekService. The Org Loom server (running
// outside SF) calls these endpoints via the user's OAuth bearer token
// to bootstrap the per-org KEK and wrap / unwrap canvas + batch data
// encryption keys.
//
// URL space (after the standard /services/apexrest prefix):
//   POST /orgloom/kek/ensure  → idempotent bootstrap. Body: {}.
//   POST /orgloom/kek/wrap    → body: {"dek": "<base64 32-byte DEK>"}.
//                               returns: {"wrapped": "<base64 envelope>"}.
//   POST /orgloom/kek/unwrap  → body: {"wrapped": "<base64 envelope>"}.
//                               returns: {"dek": "<base64 32-byte DEK>"}.
//
// Errors come back as:
//   { "error": "<machine code>", "message": "<human reason>" }
//
// All paths require the caller's session to include access to the
// OrgloomKekService Apex class (granted by the Org Loom permsets). The
// Custom Setting holding the KEK material is Protected, so even an
// authenticated user with broad SOQL rights cannot read it directly:
// they have to go through this REST surface, which means going through
// the audited Apex methods that the package owns.
@RestResource(urlMapping='/orgloom/kek/*')
global without sharing class OrgloomKekRest {
	private static final String ACCESS_VERIFICATION = 'named-permission-set-assignment-v1';
	private static final Set<String> ACCESS_PERMISSION_SET_NAMES = new Set<String>{
		'Orgloom_User',
		'Orgloom_Admin',
		'Orgloom_Canvas_User',
		'Orgloom_Canvas_Admin'
	};

	@HttpPost
	global static void doPost() {
		RestRequest req = RestContext.request;
		RestResponse res = RestContext.response;
		res.addHeader('Content-Type', 'application/json');
		String path = req.requestURI == null ? '' : req.requestURI;
		try {
			if (path.endsWith('/access')) {
				writeJson(res, 200, new Map<String, Object>{
					'ok' => true,
					'granted' => hasNamedPermissionSetAssignment(),
					'verification' => ACCESS_VERIFICATION
				});
				return;
			}
			if (path.endsWith('/ensure')) {
				OrgloomKekService.ensureKek();
				writeJson(res, 200, new Map<String, Object>{ 'ok' => true });
				return;
			}
			Map<String, Object> body = parseBody(req);
			if (path.endsWith('/wrap')) {
				String dek = stringOrNull(body, 'dek');
				if (String.isBlank(dek)) {
					writeError(res, 400, 'dek-required', 'Request body must include a base64 "dek" field.');
					return;
				}
				String wrapped = OrgloomKekService.wrapDek(dek);
				writeJson(res, 200, new Map<String, Object>{ 'wrapped' => wrapped });
				return;
			}
			if (path.endsWith('/unwrap')) {
				String wrapped = stringOrNull(body, 'wrapped');
				if (String.isBlank(wrapped)) {
					writeError(res, 400, 'wrapped-required', 'Request body must include a base64 "wrapped" field.');
					return;
				}
				String dek = OrgloomKekService.unwrapDek(wrapped);
				writeJson(res, 200, new Map<String, Object>{ 'dek' => dek });
				return;
			}
			writeError(res, 404, 'unknown-path', 'Unknown KEK operation: ' + path);
		} catch (OrgloomKekService.KekException ke) {
			// Service-level rejection (bad input, MAC fail, unbootstrapped,
			// version mismatch). 400, so the caller can act on it.
			writeError(res, 400, 'kek-error', ke.getMessage());
		} catch (Exception e) {
			// Unexpected: surface as 500 but don't include the SF stack
			// trace in the body (it can leak schema names). Keep the
			// debug log path for an admin to grep.
			System.debug(LoggingLevel.ERROR, 'OrgloomKekRest unexpected: ' + e);
			writeError(res, 500, 'internal-error', 'KEK service failed unexpectedly.');
		}
	}

	@TestVisible
	private static Boolean hasNamedPermissionSetAssignment() {
		Id currentUserId = UserInfo.getUserId();
		// This query intentionally runs in system mode. PermissionSetAssignment
		// is unavailable to many ordinary Salesforce users, while this managed
		// Apex method must be able to verify only the caller's own explicit,
		// namespace-pinned Org Loom assignment. Profile-owned grants created by
		// an "Install for All Users" package installation do not match these
		// permission-set names or namespace.
		// code-analyzer-suppress-next-line pmd:ApexCRUDViolation
		List<PermissionSetAssignment> assignments = [
			SELECT Id
			FROM PermissionSetAssignment
			WHERE AssigneeId = :currentUserId
			AND PermissionSet.NamespacePrefix = 'orgloom'
			AND PermissionSet.Name IN :ACCESS_PERMISSION_SET_NAMES
			LIMIT 1
		];
		return !assignments.isEmpty();
	}

	private static Map<String, Object> parseBody(RestRequest req) {
		if (req.requestBody == null || req.requestBody.size() == 0) {
			return new Map<String, Object>();
		}
		String raw = req.requestBody.toString();
		Object parsed = JSON.deserializeUntyped(raw);
		if (parsed instanceof Map<String, Object>) {
			return (Map<String, Object>) parsed;
		}
		throw new OrgloomKekService.KekException('request body must be a JSON object');
	}

	private static String stringOrNull(Map<String, Object> body, String key) {
		Object v = body.get(key);
		return v instanceof String ? (String) v : null;
	}

	private static void writeJson(RestResponse res, Integer status, Map<String, Object> obj) {
		res.statusCode = status;
		res.responseBody = Blob.valueOf(JSON.serialize(obj));
	}

	private static void writeError(RestResponse res, Integer status, String code, String message) {
		writeJson(res, status, new Map<String, Object>{
			'error' => code,
			'message' => message
		});
	}
}
