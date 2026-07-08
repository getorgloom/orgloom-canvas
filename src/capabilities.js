












































export const CAPABILITIES = Object.freeze({
	'create-slot-canvas': {


		workspaceToggle: null,
		scope: 'workspace',
	},
	'run-script': {





		workspaceToggle: null,
		memberOverride: true,
		defaultGranted: false,
		scope: 'workspace',
	},
	'invite-members': {



		workspaceToggle: null,
		scope: 'workspace',
	},
	'share-canvas': {










		workspaceToggle: null,
		memberOverride: true,
		defaultGranted: false,
		scope: 'workspace',
	},

	'browse-records': {



		workspaceToggle: null,
		memberOverride: true,
		defaultGranted: false,
		scope: 'workspace',
	},
	'soql-import': {



		workspaceToggle: null,
		memberOverride: true,
		defaultGranted: false,
		scope: 'workspace',
	},
	'open-saved-canvas': {



		workspaceToggle: null,
		memberOverride: true,
		defaultGranted: false,
		scope: 'workspace',
	},

	'save-canvas': {


		workspaceToggle: null,
		memberOverride: true,
		defaultGranted: false,
		scope: 'workspace',
	},
	'upload-records': {







		workspaceToggle: null,
		memberOverride: true,
		defaultGranted: false,
		scope: 'workspace',
	},
	'recall-upload': {








		workspaceToggle: null,
		memberOverride: true,
		defaultGranted: false,
		scope: 'workspace',
	},
	'bulk-edit-records': {



		workspaceToggle: null,
		memberOverride: true,
		defaultGranted: false,
		scope: 'workspace',
	},

	'auto-fill-records': {





		workspaceToggle: null,
		memberOverride: true,
		defaultGranted: false,
		scope: 'workspace',
	},

	'export-canvas': {




		workspaceToggle: null,
		memberOverride: true,
		defaultGranted: false,
		scope: 'workspace',
	},
	'export-records': {



		workspaceToggle: null,
		memberOverride: true,
		defaultGranted: false,
		scope: 'workspace',
	},
	'receive-canvas': {













		workspaceToggle: null,
		scope: 'workspace',
	},
	'filter-orgs': {

		workspaceToggle: null,
		scope: 'workspace',
	},
	'ai-edit-on-canvas': {






		workspaceToggle: 'ai_on_canvas_data_enabled',
		memberOverride: true,
		defaultGranted: false,
		scope: 'workspace',
	},
	'connect-sf-org': {


















		workspaceToggle: null,
		scope: 'connection',
		requiresApproval: ({ orgType, settings, plan }) => {
			if (!plan || plan.id !== 'team') {
return false;
}






			if (orgType === 'production') {
				return !!settings.prod_org_allowlist_enabled;
			}




			if (orgType !== 'sandbox' && orgType !== 'developer') {
				return !!settings.prod_org_allowlist_enabled || !!settings.nonprod_org_allowlist_enabled;
			}
			return !!settings.nonprod_org_allowlist_enabled;
		},
	},
});





















const _BASE_DATA_CAPS = [
	'connect-sf-org',



	'browse-records',
	'soql-import',
	'open-saved-canvas',
	'save-canvas',
	'upload-records',
	'recall-upload',
	'bulk-edit-records',
	'export-records',
	'export-canvas',
];








const _LOCKED_CAPS = [
	'connect-sf-org',
	'open-saved-canvas',
];

const _PRO_ADDS = [
	'create-slot-canvas',
	'run-script',
	'share-canvas',
	'receive-canvas',
	'filter-orgs',
	'ai-edit-on-canvas',

	'auto-fill-records',
];

const _TEAM_ADDS = [
	'invite-members',
];

export const PLANS = Object.freeze({




	free: Object.freeze({
		id: 'free',
		label: 'Inactive',
		rank: 0,
		monthly_ai_tokens: 0,
		monthly_ai_spend_cents: 0,
		monthly_upload_cap: 0,



		monthly_share_cap: 0,
		saved_canvas_cap: 0,
		audit_retention_days: 30,
		capabilities: new Set(_LOCKED_CAPS),
	}),
	pro: Object.freeze({
		id: 'pro',
		label: 'Pro',
		rank: 1,
		monthly_ai_tokens: 500_000,
		monthly_ai_spend_cents: 500,
		monthly_upload_cap: null,







		monthly_share_cap: 10,
		saved_canvas_cap: null,
		audit_retention_days: 365,
		capabilities: new Set([..._BASE_DATA_CAPS, ..._PRO_ADDS]),
	}),
	team: Object.freeze({
		id: 'team',
		label: 'Team',
		rank: 2,
		monthly_ai_tokens: 500_000,
		monthly_ai_spend_cents: 500,
		monthly_upload_cap: null,
		monthly_share_cap: null,
		saved_canvas_cap: null,
		audit_retention_days: 365,
		capabilities: new Set([..._BASE_DATA_CAPS, ..._PRO_ADDS, ..._TEAM_ADDS]),
	}),
});




export function planMeetsRequirement(planOrId, requirement) {
	if (!requirement) {
return true;
}
	const plan = typeof planOrId === 'string' ? PLANS[planOrId] : planOrId;
	const required = PLANS[requirement];
	if (!plan || !required) {
return false;
}
	return plan.rank >= required.rank;
}




export function planById(planId) {
	return PLANS[planId] || PLANS.free;
}
