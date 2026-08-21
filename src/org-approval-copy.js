export function buildOrgApprovalDeniedPayload(orgGate, orgType) {
	const gate = orgGate || {};
	const payload = {
		error: gate.reason || 'workspace-policy-blocked',
		approvalStatus: gate.approvalStatus,
	};
	if (gate.reason !== 'approval-required') {
		payload.message = 'This action is blocked by workspace policy.';
		return payload;
	}

	const orgLabel =
		orgType === 'production'
			? 'production Salesforce org'
			: orgType === 'sandbox' || orgType === 'developer'
				? 'non-production Salesforce org'
				: 'Salesforce org';
	if (gate.approvalStatus === 'pending') {
		payload.message =
			'Org Loom automatically created an access request for this ' +
			orgLabel +
			'. Any workspace admin can approve it in Workspace settings. After approval, retry this action.';
		return payload;
	}

	const status = gate.approvalStatus ? ' is currently ' + gate.approvalStatus : ' requires approval';
	payload.message =
		'Access to this ' +
		orgLabel +
		status +
		'. Any workspace admin can review and approve it in Workspace settings. After approval, retry this action.';
	return payload;
}
