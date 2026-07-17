// Normalize the different shapes jsforce and Salesforce use when an access
// token or its in-memory refresh token is no longer valid. Callers use this
// to distinguish a normal reconnect state from an authorization/configuration
// failure such as an unreadable PermissionSetAssignment object.

export function isSalesforceSessionExpiredError(error) {
	if (!error) {
		return false;
	}
	const code = String(error.errorCode || error.code || error.name || '');
	if (code === 'INVALID_SESSION_ID' || code === 'invalid_grant') {
		return true;
	}
	const message = String(error.message || error.error_description || error);
	return /INVALID_SESSION_ID|session expired(?: or invalid)?|invalid session|invalid_grant|authentication failure/i.test(message);
}
