export const ORGLOOM_PERMISSION_SET_NAMES = Object.freeze([
	'Orgloom_User',
	'Orgloom_Admin',
	'Orgloom_Canvas_User',
	'Orgloom_Canvas_Admin',
]);

const SF_ID_RE = /^[a-zA-Z0-9]{15,18}$/;

export async function hasAssignedOrgloomPermissionSet(conn, sfUserId, options = {}) {
	if (!conn || typeof conn.query !== 'function') {
		throw new TypeError('Salesforce connection with query() is required');
	}
	const userId = String(sfUserId || '');
	if (!SF_ID_RE.test(userId)) {
		throw new TypeError('Unexpected Salesforce user id shape');
	}

	const names = ORGLOOM_PERMISSION_SET_NAMES.map((name) => `'${name}'`).join(',');
	const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, options.timeoutMs) : 15_000;
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
