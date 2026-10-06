export function isSalesforceSessionExpiredError(error) {
	if (!error) {
		return false;
	}
	const status = Number(error.statusCode || error.status || error.response?.status || 0);
	if (status === 401) {
		return true;
	}
	const code = String(
		error.errorCode ||
			error.code ||
			error.name ||
			error.data?.errorCode ||
			error.data?.error ||
			error.body?.errorCode ||
			error.body?.error ||
			'',
	);
	if (code === 'INVALID_SESSION_ID' || code === 'invalid_grant') {
		return true;
	}
	const details = [
		error.message,
		error.error_description,
		error.data?.message,
		error.body?.message,
		error.response?.data?.message,
		error.response?.body,
	]
		.filter(Boolean)
		.map((value) => {
			if (typeof value === 'string') {
				return value;
			}
			try {
				return JSON.stringify(value);
			} catch (_error) {
				return String(value);
			}
		})
		.join(' ');
	if (
		/INVALID_SESSION_ID|session expired(?: or invalid)?|invalid session|invalid_grant|authentication failure|unable to refresh session|expired access\/refresh token/i.test(
			details,
		)
	) {
		return true;
	}
	return !!(error.cause && error.cause !== error && isSalesforceSessionExpiredError(error.cause));
}
