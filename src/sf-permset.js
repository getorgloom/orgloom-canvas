export const ORGLOOM_PERMISSION_SET_NAMES = Object.freeze([
	'Orgloom_User',
	'Orgloom_Admin',
	'Orgloom_Canvas_User',
	'Orgloom_Canvas_Admin',
]);

const SF_ID_RE = /^[a-zA-Z0-9]{15,18}$/;
const ORGLOOM_ACCESS_PATH = '/services/apexrest/orgloom/orgloom/kek/access';

function _errorStatus(error) {
	return Number(error?.statusCode || error?.status || error?.response?.status || 0);
}

function _isApiDisabledError(error) {
	const details = [error?.message, error?.errorCode, error?.code, error?.name]
		.filter(Boolean)
		.join(' ');
	return /API_DISABLED_FOR_(?:ORG|USER)|API_CURRENTLY_DISABLED|api access.*disabled|api is not enabled/i.test(
		details,
	);
}

async function _checkPackagedAccessPermission(conn, timeoutMs) {
	if (typeof conn.request !== 'function') {
		return null;
	}
	let timer;
	const request = Promise.resolve().then(() =>
		conn.request({
			method: 'POST',
			url: ORGLOOM_ACCESS_PATH,
			body: '{}',
			headers: { 'Content-Type': 'application/json' },
		}),
	);
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => {
			const error = new Error('Salesforce permission-set verification timed out.');
			error.code = 'sf-permset-check-timeout';
			reject(error);
		}, timeoutMs);
	});
	try {
		let response = await Promise.race([request, timeout]);
		if (typeof response === 'string') {
			response = JSON.parse(response);
		}
		if (response?.ok !== true || typeof response?.granted !== 'boolean') {
			throw new Error('Salesforce returned an invalid Org Loom access-check response.');
		}
		return response.granted;
	} catch (error) {
		if (_isApiDisabledError(error)) {
			throw error;
		}
		const status = _errorStatus(error);
		if (status === 404 || error?.errorCode === 'NOT_FOUND' || error?.code === 'NOT_FOUND') {
			return null;
		}
		if (status === 403) {
			return false;
		}
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

async function _legacyAssignmentQuery(conn, userId, timeoutMs) {
	if (typeof conn.query !== 'function') {
		throw new TypeError('Salesforce connection with query() is required for legacy package verification');
	}

	const names = ORGLOOM_PERMISSION_SET_NAMES.map((name) => `'${name}'`).join(',');
	let timer;
	const query = conn.query(
		'SELECT Id, PermissionSet.Name, PermissionSet.NamespacePrefix ' +
			"FROM PermissionSetAssignment WHERE AssigneeId = '" +
			userId +
			"' " +
			"AND PermissionSet.NamespacePrefix = 'orgloom' " +
			'AND PermissionSet.Name IN (' +
			names +
			')',
	);
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => {
			const error = new Error('Salesforce permission-set verification timed out.');
			error.code = 'sf-permset-check-timeout';
			reject(error);
		}, timeoutMs);
	});
	let result;
	try {
		result = await Promise.race([query, timeout]);
	} finally {
		clearTimeout(timer);
	}

	return (
		Array.isArray(result?.records) &&
		result.records.some((record) => {
			const permissionSet = record?.PermissionSet;
			return (
				permissionSet?.NamespacePrefix === 'orgloom' &&
				ORGLOOM_PERMISSION_SET_NAMES.includes(permissionSet?.Name)
			);
		})
	);
}

export async function hasAssignedOrgloomPermissionSet(conn, sfUserId, options = {}) {
	if (!conn || (typeof conn.request !== 'function' && typeof conn.query !== 'function')) {
		throw new TypeError('Salesforce connection with request() or query() is required');
	}
	const userId = String(sfUserId || '');
	if (!SF_ID_RE.test(userId)) {
		throw new TypeError('Unexpected Salesforce user id shape');
	}
	const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, options.timeoutMs) : 15_000;
	const packagedAccess = await _checkPackagedAccessPermission(conn, timeoutMs);
	if (packagedAccess !== null) {
		return packagedAccess;
	}
	return _legacyAssignmentQuery(conn, userId, timeoutMs);
}
