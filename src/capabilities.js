// Single source of truth for every gated capability in the app. Adding a
// new gated feature is one entry here: no new helper functions, no plan-
// flag fields, no scattered gate logic. Removing a feature flag is one
// deletion. Moving a feature between plans is one set edit.
//
// The resolver in src/policy.js consumes this registry and is the only
// place that knows how to combine plan, workspace settings, and approval
// state. Gate sites call hasCapability() and read a boolean.
//
// One axis per gate, all evaluated against the ACTIVE WORKSPACE:
//   plan capabilities: each plan in PLANS lists which capabilities it
//                        unlocks. The active workspace's plan governs
//                        both feature access and consumption, with no more
//                        per-account license vs per-workspace quota
//                        split. A capability is enabled iff it's in
//                        the workspace's plan.capabilities set.
//   workspaceToggle: optional workspace_settings column name. When
//                        non-null, the toggle must be true for the
//                        capability to fire. KILL SWITCH: binding for
//                        everyone in the workspace, including users
//                        with explicit per-member grants. An admin can
//                        disable a feature for the whole workspace
//                        even if the plan permits it.
//   memberOverride: when true, the workspaceToggle is necessary
//                        but not sufficient: per-user grants in
//                        member_capabilities decide who can use the
//                        capability among workspace members. New
//                        members start at `defaultGranted`.
//   defaultGranted: when memberOverride is true, the default for
//                        a member without an explicit grant. Sensitive
//                        capabilities default to false (deny).
//   scope: 'workspace' (resolves against active workspace
//                        + plan) or 'connection' (also considers the
//                        active SF connection / sf_org_id at action
//                        time). Connection-scoped caps may also
//                        require approval (see requiresApproval).
//   requiresApproval: optional (context) => boolean. Returns true
//                        when the action requires an approved row in
//                        member_capabilities for (workspace_id,
//                        account_id, capability, sf_org_id). Only
//                        consulted when scope === 'connection'.
//                        Connection-scoped caps with requiresApproval
//                        implicitly behave as memberOverride: true,
//                        with sf_org_id as the per-grant target.

export const CAPABILITIES = Object.freeze({
	'create-slot-canvas': {
		// Authoring canvases with slot mechanics. Personal productivity
		// feature; available on Pro and above.
		workspaceToggle: null,
		scope: 'workspace',
	},
	'run-script': {
		// Sandboxed JS execution against the canvas. Two-axis gate:
		// Pro+ unlocks the feature for the plan, then admins grant it
		// per-user, since arbitrary code against SF data is a per-user
		// permission, not a workspace-wide default. No workspace-level
		// kill switch: run-script is governed purely per-member.
		workspaceToggle: null,
		memberOverride: true,
		defaultGranted: false,
		scope: 'workspace',
	},
	'invite-members': {
		// Multi-member workspaces. Team-only: Pro is single-seat by
		// design. The personal-kind workspace doesn't surface this
		// action in the UI at all.
		workspaceToggle: null,
		scope: 'workspace',
	},
	'share-canvas': {
		// Canvas sharing: covers BOTH the default direct-share flow
		// (POST /api/canvas/:id/direct-share, creates a ContentDocument
		// Link for a SF user with notification email; no token, no cap)
		// AND the secure-link flow (POST /api/canvas/:id/share-link,
		// magic-link token capped at monthly_share_cap). Sharing
		// implies a recipient who'll consume the share, which only
		// makes sense above the locked tier. The locked/Inactive tier
		// is blocked at this gate for both flows. Per-user gated
		// because outbound data flow is
		// the dominant security-review concern for sharing.
		workspaceToggle: null,
		memberOverride: true,
		defaultGranted: false,
		scope: 'workspace',
	},
	// ----- Salesforce read paths -------------------------------------
	'browse-records': {
		// Point-and-click SOQL builder (/api/browse). Reads SF records.
		// Per-user gated so an admin can restrict who can pull data
		// out of SF on this workspace's behalf.
		workspaceToggle: null,
		memberOverride: true,
		defaultGranted: false,
		scope: 'workspace',
	},
	'soql-import': {
		// Raw SOQL import path. Same risk shape as browse but with no
		// type-aware guardrails; gating it separately lets admins
		// allow browse but not raw SOQL for less-trusted users.
		workspaceToggle: null,
		memberOverride: true,
		defaultGranted: false,
		scope: 'workspace',
	},
	'open-saved-canvas': {
		// Load one of the member's own saved canvases (canvas-store
		// reads). receive-canvas is a separate cap for canvases
		// shared INTO this account by another user.
		workspaceToggle: null,
		memberOverride: true,
		defaultGranted: false,
		scope: 'workspace',
	},
	// ----- Salesforce write paths ------------------------------------
	'save-canvas': {
		// Persist canvas state to SF (ContentDocument upload). Writes
		// canvas blob; reversible by deleting the saved file.
		workspaceToggle: null,
		memberOverride: true,
		defaultGranted: false,
		scope: 'workspace',
	},
	'upload-records': {
		// Mass write to SF: covers /api/upload, /api/upload/bulk,
		// /api/upload/graph, /api/upload-batches (batch ledger),
		// /api/upload/preflight, AND the linked-CSV quick-upload
		// shortcut. Single capability for every write path: splitting
		// quick-upload from standard upload would let an admin allow
		// the dangerous path while denying the safe one, which doesn't
		// model anything useful.
		workspaceToggle: null,
		memberOverride: true,
		defaultGranted: false,
		scope: 'workspace',
	},
	'recall-upload': {
		// Reverse a prior upload via /api/upload-batches/:id/recall.
		// Writes to SF (DELETEs or value-reverts). Gated separately
		// from upload because the destructive shape is different and
		// an admin might want to deny recall to a user who CAN upload.
		// Per-user only: admins grant individual members, no
		// workspace-wide kill-switch (different from run-script /
		// ai-edit-on-canvas, which sit behind a workspace toggle
		// because they can run arbitrary code / send data off-platform).
		workspaceToggle: null,
		memberOverride: true,
		defaultGranted: false,
		scope: 'workspace',
	},
	'bulk-edit-records': {
		// Bulk-edit field values across many records on the canvas.
		// Doesn't write to SF until upload, but the staging mutation
		// itself is a power-user move worth gating. Per-user only.
		workspaceToggle: null,
		memberOverride: true,
		defaultGranted: false,
		scope: 'workspace',
	},
	// ----- AI on data -----------------------------------------------
	'generate-records-with-ai': {
		// Generate with AI sends the user's prompt plus selected object
		// schema to the model and returns NEW draft records. It does not
		// read records already on the canvas, so it must not inherit the
		// ai_on_canvas_data_enabled kill switch used by MCP. Keep the
		// per-member grant so Team admins can still govern who may spend
		// workspace-funded AI quota.
		workspaceToggle: null,
		memberOverride: true,
		defaultGranted: false,
		scope: 'workspace',
	},
	'auto-fill-records': {
		// AI-driven auto-fill of empty fields on staged records. Same
		// data-exposure shape as ai-edit-on-canvas but a separate
		// gate so admins can allow generation-from-prompt without
		// allowing fill-against-existing-records (or vice versa).
		// Per-user only.
		workspaceToggle: null,
		memberOverride: true,
		defaultGranted: false,
		scope: 'workspace',
	},
	// ----- Export paths ---------------------------------------------
	'export-canvas': {
		// Download the entire canvas (canvas blob + records) as a
		// .orgloom-canvas file. Off-network data exfil; admins of
		// regulated workspaces will want this denied by default.
		// Per-user only.
		workspaceToggle: null,
		memberOverride: true,
		defaultGranted: false,
		scope: 'workspace',
	},
	'export-records': {
		// CSV export of canvas records. Same data-exfil shape as
		// export-canvas but a separate gate because CSV is the common
		// case (sharing data with non-Orgloom tools). Per-user only.
		workspaceToggle: null,
		memberOverride: true,
		defaultGranted: false,
		scope: 'workspace',
	},
	'receive-canvas': {
		// Opening a shared canvas as Contributor or Editor. Direct Viewer
		// grants are intentionally free and bypass this plan capability only
		// after Salesforce read access plus the exact org/canvas/user role row
		// are verified. A ContentDocumentLink or URL by itself never bypasses
		// the gate. Contributor/Editor recipients need their own active trial,
		// subscription, or Team seat.
		// Locked-tier users hitting the gate get a 402 with currentPlan +
		// required so the client can render an upgrade CTA.
		workspaceToggle: null,
		scope: 'workspace',
	},
	'filter-orgs': {
		// Production-org approval flow. Pro and above.
		workspaceToggle: null,
		scope: 'workspace',
	},
	'ai-edit-on-canvas': {
		// AI tools (currently MCP) reading canvas
		// record values + proposing changes back. Three-axis gate:
		// Pro+ unlocks the feature for the plan, workspace admin opts
		// in via ai_on_canvas_data_enabled (kill switch), per-user
		// grant decides who can let an MCP client read or propose changes under
		// their SF identity.
		workspaceToggle: 'ai_on_canvas_data_enabled',
		memberOverride: true,
		defaultGranted: false,
		scope: 'workspace',
	},
	'connect-sf-org': {
		// Use a Salesforce connection against an org. Two independent
		// allowlist toggles: one for production orgs, one for
		// everything else (sandbox / Developer Edition / scratch). When
		// the matching allowlist is ON, the (user, sf_org) pair needs
		// an approved row in member_capabilities before that user can
		// act against the org. Approval is per-(workspace, account,
		// sf_org): admin approves Carol-for-prod-OrgA, Dave is still
		// blocked. Available on every plan (no SF connection = no
		// product).
		//
		// Plan gate: approval is Team-only. On non-Team plans the
		// requester IS the approver (single-seat workspace), so the gate would
		// just create theatrical paperwork against yourself, and the
		// UI doesn't surface the approval queue for solo plans. The
		// resolver short-circuits to "no approval needed" for those
		// regardless of either allowlist setting, so a downgrade from
		// Team that leaves a flag at TRUE doesn't brick org writes on
		// the solo plan.
		workspaceToggle: null,
		scope: 'connection',
		requiresApproval: ({ orgType, settings, plan }) => {
			if (!plan || plan.id !== 'team') {
return false;
}
			// Fail CLOSED on unknown org type: if we couldn't determine
			// whether this is production (the Organization probe fails for
			// low-privilege profiles), treat it as production whenever the
			// prod allowlist is on. Otherwise an org that is actually
			// production but reads as `null`/`unknown` would fall through to
			// the (usually-off) non-prod branch and skip approval entirely.
			if (orgType === 'production') {
				return !!settings.prod_org_allowlist_enabled;
			}
			// Known-safe classes only: sandbox / developer (scratch orgs are
			// labelled 'sandbox'). Anything else, null / 'unknown' from a
			// failed Organization probe, is treated as production and needs
			// approval if EITHER allowlist is on. We can't prove it's safe.
			if (orgType !== 'sandbox' && orgType !== 'developer') {
				return !!settings.prod_org_allowlist_enabled || !!settings.nonprod_org_allowlist_enabled;
			}
			return !!settings.nonprod_org_allowlist_enabled;
		},
	},
});

// ----- Plans ---------------------------------------------------------
//
// One PLANS dictionary. Each entry holds both capability access and
// consumption caps; the resolver reads from the active workspace's
// plan for everything. Replaces the old LICENSE_TIERS × QUOTA_TIERS
// split: those concepts collapsed into a single per-workspace
// `plan` column in migration 006.
//
// Capabilities are listed per plan as a Set. Higher plans are
// supersets of lower plans (team includes everything pro has, pro
// includes everything free has). The resolver does plain set
// membership; rank only matters for "is plan A at least plan B"
// comparisons (planMeetsRequirement, retained for callers that
// reason about plan hierarchy).
//
// The baseline data-CRUD capabilities every PAID tier (Pro, Team) builds
// on. This is NOT the free tier's set anymore: with the perpetual Free
// tier dropped, the 'free' plan is the locked / trial-expired state (see
// _LOCKED_CAPS below). Workspace-toggle and approval gates still apply on
// top regardless of plan.
const _BASE_DATA_CAPS = [
	'connect-sf-org',
	// Baseline data CRUD: the floor a SF user needs to do any work.
	// Available on every PAID plan; per-user grants still gate them in
	// Team workspaces.
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

// The locked / trial-expired tier ('free' plan). A user whose trial has
// ended (or who hasn't started one yet) can still CONNECT Salesforce,
// which is what starts the trial in the first place, and RE-OPEN their
// saved canvases read-only (their work lives in their own SF org). Every
// value-creating action (load, upload, save, edit, export, AI, share,
// run-script) is plan-gated off until they upgrade. save-canvas is NOT
// here, so reopened canvases are view-only.
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
	'generate-records-with-ai',
	'ai-edit-on-canvas',
	// AI auto-fill rides the Pro plan with the rest of AI features.
	'auto-fill-records',
];

const _TEAM_ADDS = [
	'invite-members',
];

export const PLANS = Object.freeze({
	// The 'free' id is retained as the DEFAULT + locked/expired tier (the
	// planById fallback and a new workspace's starting plan both resolve
	// here). It is no longer an offered/usable plan; it's the state a
	// workspace sits in before a trial starts and after one expires.
	free: Object.freeze({
		id: 'free',
		label: 'Inactive',
		rank: 0,
		monthly_ai_tokens: 0,
		monthly_ai_spend_cents: 0,
		monthly_upload_cap: 0,
		// All consumption caps are 0: the locked tier denies the underlying
		// capabilities outright (save/upload/share/AI aren't in _LOCKED_CAPS),
		// so these caps are belt-and-suspenders documentation.
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
		monthly_upload_cap: null, // unlimited
		// Caps SECURE-LINK (magic-link) issuance only. The default
		// direct-share flow (POST /api/canvas/:id/direct-share) creates
		// a ContentDocumentLink + sends a notification: no token, no
		// expiry, no cap. Pro consultants reviewing client work get
		// unlimited direct shares to SF teammates and 10/month time-
		// bound secure links for external recipients or one-off review
		// windows. Team is unlimited on both axes.
		monthly_share_cap: 10,
		saved_canvas_cap: null, // unlimited
		audit_retention_days: 365,
		capabilities: new Set([..._BASE_DATA_CAPS, ..._PRO_ADDS]),
	}),
	team: Object.freeze({
		id: 'team',
		label: 'Team',
		rank: 2,
		monthly_ai_tokens: 500_000, // per seat
		monthly_ai_spend_cents: 500,
		monthly_upload_cap: null,
		monthly_share_cap: null, // unlimited
		saved_canvas_cap: null, // unlimited
		audit_retention_days: 365,
		capabilities: new Set([..._BASE_DATA_CAPS, ..._PRO_ADDS, ..._TEAM_ADDS]),
	}),
});

// Plan A meets requirement R when A's rank >= R's rank. Lets call
// sites reason about plan hierarchy without poking at the Set. Reads
// from PLANS by default; accepts either a plan object or a plan id.
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

// Returns the PLANS entry for an id, with `free` as the safe fallback.
// Use when a workspace's plan column is null / unknown / mis-set,
// gives the resolver a deterministic shape rather than crashing.
export function planById(planId) {
	return PLANS[planId] || PLANS.free;
}
