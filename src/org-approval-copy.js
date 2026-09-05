export function buildOrgApprovalDeniedPayload(orgGate, orgType) {
	const gate = orgGate || {};
	return {
		error: gate.reason || 'org-not-allowed',
		orgType: orgType || 'unknown',
		message:
			'This Salesforce org is not on the active workspace allowlist. Ask a workspace administrator to add its Current My Domain URL in Workspace settings.',
	};
}
