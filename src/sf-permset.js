// Org Loom's managed permission-set assignment is a product prerequisite,
// even when a broad Salesforce profile (for example System Administrator)
// happens to grant equivalent object/class access. Checking the named,
// namespace-pinned assignment keeps onboarding deterministic and prevents an
// unrelated subscriber permission set with the same API name from passing.

export const ORGLOOM_PERMISSION_SET_NAMES = Object.freeze([
	'Orgloom_User',
	'Orgloom_Admin',
	// Accepted for customers upgrading from package versions that used the
	// older Canvas-specific names.
	'Orgloom_Canvas_User',
	'Orgloom_Canvas_Admin',
]);

const SF_ID_RE = /^[a-zA-Z0-9]{15,18}$/;

export async function hasAssignedOrgloomPermissionSet(conn, sfUserId) {
	if (!conn || typeof conn.query !== 'function') {
		throw new TypeError('Salesforce connection with query() is required');
	}
	const userId = String(sfUserId || '');
	if (!SF_ID_RE.test(userId)) {
		throw new TypeError('Unexpected Salesforce user id shape');
	}

	const names = ORGLOOM_PERMISSION_SET_NAMES.map((name) => `'${name}'`).join(',');
	const result = await conn.query(
		"SELECT Id, PermissionSet.Name, PermissionSet.NamespacePrefix "
		+ "FROM PermissionSetAssignment WHERE AssigneeId = '" + userId + "' "
		+ "AND PermissionSet.NamespacePrefix = 'orgloom' "
		+ 'AND PermissionSet.Name IN (' + names + ')'
	);

	return Array.isArray(result?.records) && result.records.some((record) => {
		const permissionSet = record?.PermissionSet;
		return permissionSet?.NamespacePrefix === 'orgloom'
			&& ORGLOOM_PERMISSION_SET_NAMES.includes(permissionSet?.Name);
	});
}
