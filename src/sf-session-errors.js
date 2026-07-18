export function isSalesforceSessionExpiredError(error) {
	if (!error) {
		return false;
	}
	const code = String(error.errorCode || error.code || error.name || '');
	if (code === 'INVALID_SESSION_ID' || code === 'invalid_grant') {
		return true;
	}
	const message = String(error.message || error.error_description || error);
	return /INVALID_SESSION_ID|session expired(?: or invalid)?|invalid session|invalid_grant|authentication failure/i.test(
		message,
	);
}
