// Submit-only MCP server: AI clients inspect canvas state and propose changes; browsers approve them.
import * as mcpTokensDb from 'orgloom-canvas/database/mcp-tokens';
import * as accountsDb from 'orgloom-canvas/database/accounts';
import { aiProposals as proposalsDb, audit as auditDb } from '../database/index.js';
import * as relay from './relay.js';
import { ext } from '../extensions.js';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = Object.freeze({
	name: 'orgloom',
	version: '1.0.0',
});

const ERR_PARSE = -32700;
const ERR_INVALID_REQUEST = -32600;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INVALID_PARAMS = -32602;
const ERR_INTERNAL = -32603;
const ERR_AUTH = -32001; // custom: bad / missing token
const ERR_NO_WORKSPACE = -32002; // custom: token has no workspace scope
const ERR_RATE_LIMIT = -32006; // custom: per-token request throttle
const ERR_FORBIDDEN = -32004; // custom: capability denied
const ERR_NOT_FOUND = -32005; // custom: target resource missing
export const MCP_TOKEN_RATE_LIMIT = Object.freeze({ windowMs: 60_000, max: 120 });
const _tokenRequestWindows = new Map();
export function _resetMcpTokenRateLimitForTests() {
	_tokenRequestWindows.clear();
}
function _consumeTokenRequest(tokenId, now = Date.now()) {
	const cutoff = now - MCP_TOKEN_RATE_LIMIT.windowMs;
	const recent = (_tokenRequestWindows.get(tokenId) || []).filter((t) => t > cutoff);
	if (recent.length >= MCP_TOKEN_RATE_LIMIT.max) {
		return false;
	}
	recent.push(now);
	_tokenRequestWindows.set(tokenId, recent);
	return true;
}

const TOOLS = [
	{
		name: 'list_canvases',
		description:
			'List canvases the workspace has cached for AI access. Returns ' +
			'id, title, cached-at timestamp, and ownership. Empty list ' +
			'means either no canvases have been opened in Orgloom since ' +
			'the workspace enabled AI access, or the AI-on-canvas-data ' +
			'toggle is off (admin opt-in). The cache is populated when ' +
			'a human opens or saves a canvas in the Orgloom web app; AI ' +
			'is reading derived state from Orgloom, not from Salesforce. If ' +
			'more than one canvas is returned and the user has not clearly ' +
			'identified the intended canvas, DO NOT choose based on list order, ' +
			'title similarity, or contents. Ask the user which canvas to use, ' +
			"then pass that canvas's id to every subsequent canvas-scoped tool.",

		inputSchema: {
			type: 'object',
			properties: {},
			required: [],
			additionalProperties: false,
		},
	},
	{
		name: 'read_canvas',
		description:
			'Read the live canvas state: drafts, loaded records, edges, ' +
			'their field values, AND a schema map of each object type ' +
			'the user has on the canvas. The schema entries include each ' +
			"object's `referenceFields` (lookup fields with the target " +
			'objectName + the relationship name) and `requiredFields` ' +
			'(field API names that MUST be filled on new-drafts before ' +
			'upload). Use referenceFields to compose valid ' +
			'new-association calls: pick a field whose referenceTo ' +
			'includes the parent objectName, and use that fieldName in ' +
			'the association change. Use requiredFields to make sure ' +
			'every new-draft you propose includes the mandatory fields ' +
			'(or use the autofill-required change kind to let the user ' +
			'fill them with sample values). Returns NOT_FOUND when the ' +
			'user does not have this canvas open in any browser tab ' +
			'right now.',
		inputSchema: {
			type: 'object',
			properties: {
				canvasId: {
					type: 'string',
					description:
						'Canvas id: either a 15/18-char Salesforce ContentDocument id (for saved canvases, also visible in the Orgloom canvas URL) or a "draft-<uuid>" id (for canvases the user has open but has not yet saved). Always use the id field from list_canvases. If multiple canvases are open and the user did not identify one, ask which canvas to use before calling this tool; never pick one from list order.',
				},
			},
			required: ['canvasId'],
			additionalProperties: false,
		},
	},
	{
		name: 'propose_record_changes',
		description:
			'Submit a proposal of canvas changes: add new records, ' +
			'edit existing ones, modify drafts, and wire associations ' +
			'(parent → child relationships). The proposal lands in ' +
			"Orgloom's pending-proposals queue for the human to review " +
			'+ apply in the web UI. This tool DOES NOT modify the canvas ' +
			'or write to Salesforce directly; it writes a pending ' +
			'proposal record.\n\n' +
			'FIELD VALUE RULE: before proposing a field value, use ' +
			'describe_object when you do not already have the exact field ' +
			'type, writeability, format, and allowed values from Salesforce ' +
			'metadata. Never infer a field type from its label or from a ' +
			'similar field. Salesforce date fields use YYYY-MM-DD, while ' +
			'datetime fields require a complete ISO 8601 timestamp with a ' +
			'timezone, such as 2026-07-20T14:30:00.000Z. Do not send a ' +
			'date-only value to a datetime field or add a time to a date ' +
			'field. Send booleans as JSON booleans and numeric values as ' +
			'JSON numbers. For picklists, use an active value returned by ' +
			'describe_object. Include only fields whose values should change. ' +
			'Do not repeat unchanged name or identity fields for context; use ' +
			'recordId or tempId to identify the record.\n\n' +
			'NINE change shapes (each is one element in the changes array):\n' +
			'  1. ADD a brand-new draft record: provide objectName + ' +
			'fields. Optionally include `tempRef` (any short string you ' +
			'pick, e.g. "acme") so a same-proposal `new-association` can ' +
			'point at this draft. On accept, a fresh draft appears on the ' +
			'canvas with the provided field values. Works on empty canvases.\n' +
			'  2. EDIT an existing Salesforce record on the canvas: ' +
			'provide recordId + objectName + fields. Existing records ' +
			'on the canvas have a 15- or 18-char SF id; you see those ' +
			'in read_canvas under loadedRecords[].values.Id. On accept, ' +
			'the canvas-side values update (the user uploads to SF later).\n' +
			'  3. EDIT an existing draft on the canvas: provide tempId + ' +
			'objectName + fields. Drafts have numeric tempIds visible in ' +
			"read_canvas under drafts[].tempId. On accept, the draft's " +
			'values update.\n' +
			'  4. ADD a relationship between two records: set ' +
			'kind="new-association", provide fieldName (the lookup field API name on ' +
			'the CHILD record, e.g. "AccountId"), and provide `from` + ' +
			'`to` endpoints. Convention: `from` is the CHILD (the record ' +
			'that holds the lookup field), `to` is the PARENT. Endpoint shape ' +
			'(use exactly one key per endpoint): {recordId: "<sf-id>"} for ' +
			'an existing loaded record, {tempId: <number>} for an existing ' +
			'draft, {tempRef: "<string>"} for a same-proposal new-draft. ' +
			'Mix freely, e.g. add a new Contact as child of an existing ' +
			'Account in one proposal.\n' +
			'     Salesforce lookup fields are single-valued. If the child ' +
			'already has a canvas relationship for fieldName, accepting this ' +
			'new-association replaces that relationship; do not also submit a ' +
			'delete-association merely to reparent the record.\n' +
			'  5. REMOVE an association: set kind="delete-association", ' +
			'provide fieldName + from + to using the same endpoint shape ' +
			'as #4. Only matches associations already on the canvas.\n' +
			'  6. REMOVE a draft from the canvas: set kind="delete-draft", ' +
			'provide tempId. The draft and any associations touching it ' +
			'are removed. This only affects the canvas; the user has not ' +
			'pushed the draft to Salesforce so there is no SF impact.\n' +
			'  7. REMOVE a loaded record from the canvas: set ' +
			'kind="delete-record", provide recordId. Only removes the ' +
			"record's reference from the canvas view + cleans up its " +
			'associations. The underlying Salesforce record is NOT ' +
			'deleted; use this when the user is reorganizing what their ' +
			'canvas tracks, not to delete data.\n' +
			'  8. AUTO-FILL required fields on one or more drafts: set ' +
			'kind="autofill-required". Optionally provide tempIds (an ' +
			'array of draft tempIds) to scope the fill; omit tempIds to ' +
			'fill required fields on every draft on the canvas. The fill ' +
			'uses sane sample values (picklists pick a real option, ' +
			'lookups pick smart defaults when known, picklists honor ' +
			'restricted-value lists). Fields already populated are left ' +
			"alone. Use this when the AI wants to make the user's " +
			'drafts upload-ready without specifying every individual ' +
			'field value.\n' +
			'  9. LOAD an existing Salesforce record onto the canvas: ' +
			'set kind="load-record", provide objectName + recordId. ' +
			'Optionally include `fields` to retrieve only specific ' +
			"fields (omit for all). On accept, the user's browser " +
			"fetches the record from Salesforce via the user's session " +
			'(this is the only AI-proposed shape that triggers SF ' +
			'traffic; it is fully user-mediated, meaning the user sees what ' +
			'will be loaded in the proposal review before they accept). ' +
			'Use this when you want to edit/reference a record the user ' +
			'has not added to the canvas yet, for example: "I need to ' +
			'pull Account 001abc onto the canvas before I can propose ' +
			'changes to it." Duplicate (already-on-canvas) targets are ' +
			'skipped, not erroneous.\n\n' +
			'Targets for shapes 2, 3, 6, 7 are validated against the ' +
			'LIVE canvas state at submission time; the proposal tool ' +
			"reaches into the user's open browser via the MCP relay. If " +
			"the user doesn't have the canvas open in any tab right now, " +
			'the proposal call fails with NOT_FOUND and you should ask ' +
			'the user to open the canvas in Org Loom and retry. Shape 4 ' +
			'+ 5 endpoints are validated too (recordIds must exist on ' +
			'the canvas, tempIds must be drafts on the canvas, tempRefs ' +
			'must match a new-draft in this same proposal). Shape 1 ' +
			"skips target validation since there's no existing target.\n\n" +
			'Per change supply at most one of recordId / tempId. Omit ' +
			'both for a new-draft add. Returns the proposal id and a ' +
			'URL the user can open to review.',

		inputSchema: {
			type: 'object',
			properties: {
				canvasId: {
					type: 'string',
					description:
						'Canvas id: either a 15/18-char Salesforce ContentDocument id (saved canvases) or a "draft-<uuid>" id (canvases the user has open but has not saved yet). Use list_canvases to discover ids; the `id` field is what to pass here, not the `title`. If more than one canvas is open and the user did not clearly identify the target, ask which canvas the proposal should apply to before calling this tool. Never guess from list order.',
				},
				summary: {
					type: 'string',
					description: 'Human-readable summary of what these changes accomplish',
					maxLength: 500,
				},
				changes: {
					type: 'array',
					description: 'Per-record / per-draft / per-association changes',
					items: {
						type: 'object',
						properties: {
							kind: {
								type: 'string',
								enum: [
									'new-association',
									'delete-association',
									'delete-draft',
									'delete-record',
									'autofill-required',
									'load-record',
								],
								description:
									'Set explicitly for association changes (shapes 4 + 5), delete shapes (6 + 7), autofill (shape 8), and load-record (shape 9). For record/draft adds and edits, omit `kind`; it is inferred from the presence of recordId / tempId / neither.',
							},
							recordId: {
								type: 'string',
								description:
									'Salesforce record id (15 or 18 chars). Use for EDITS to records loaded onto the canvas. Mutually exclusive with tempId. Omit both recordId AND tempId to ADD a brand-new draft record (shape 1 in the tool description).',
							},
							tempId: {
								type: 'string',
								description:
									'Draft tempId from the canvas payload (drafts[].tempId), passed as a string (numeric tempIds like 1 are accepted as "1"). Use for EDITS to records that exist only on the canvas and are not yet uploaded to Salesforce. Mutually exclusive with recordId. Omit both recordId AND tempId to ADD a brand-new draft.',
							},
							objectName: {
								type: 'string',
								description:
									'SObject API name. Required for new-draft / record / draft. Ignored for association changes.',
							},
							fields: {
								type: 'object',
								description:
									'Field-name → new-value map. Required for new-draft / record / draft. Ignored for association changes. Values must match the Salesforce field metadata. If the exact type or format is not already known, call describe_object before constructing this map. In particular, date values use YYYY-MM-DD and datetime values use a complete ISO 8601 timestamp with a timezone, such as 2026-07-20T14:30:00.000Z.',
								additionalProperties: true,
							},
							tempRef: {
								type: 'string',
								description:
									'OPTIONAL short identifier for a new-draft. Pick any string (e.g. "acme"); same-proposal association changes use this to point at the not-yet-minted tempId. Only allowed on new-draft shapes.',
								maxLength: 64,
							},
							fieldName: {
								type: 'string',
								description:
									'For relationship changes (kinds new-association / delete-association). The lookup field API name on the child record (for example, "AccountId" when linking a Contact to an Account).',
							},
							from: {
								type: 'object',
								description:
									'For relationship changes. The child endpoint, which holds the lookup field. Exactly one of recordId / tempId / tempRef.',
								properties: {
									recordId: {
										type: 'string',
										description: 'Existing loaded record id (15 or 18 chars).',
									},
									tempId: {
										type: 'number',
										description: 'Existing draft tempId.',
									},
									tempRef: {
										type: 'string',
										description: 'tempRef of a new-draft in this same proposal.',
									},
								},
								additionalProperties: false,
							},
							to: {
								type: 'object',
								description:
									'For association changes. The PARENT endpoint. Exactly one of recordId / tempId / tempRef.',
								properties: {
									recordId: {
										type: 'string',
										description: 'Existing loaded record id (15 or 18 chars).',
									},
									tempId: {
										type: 'number',
										description: 'Existing draft tempId.',
									},
									tempRef: {
										type: 'string',
										description: 'tempRef of a new-draft in this same proposal.',
									},
								},
								additionalProperties: false,
							},
							tempIds: {
								type: 'array',
								description:
									'For kind="autofill-required" only. Optional list of draft tempIds to scope the fill. Omit to apply to every draft on the canvas.',
								items: { type: 'number' },
							},
						},
						additionalProperties: false,
					},
					minItems: 1,
				},
			},
			required: ['canvasId', 'changes'],
			additionalProperties: false,
		},
	},
	{
		name: 'describe_object',
		description:
			'Return the cached Salesforce describe for an SObject: field ' +
			'list, types, required flags, length limits, default values, ' +
			'picklist values (with validFor masks for dependent picklists), ' +
			'and reference targets. Use this to pick valid picklist values ' +
			"before proposing a record edit (so you don't propose " +
			'"Follow up call" for a Subject picklist that doesn\'t accept ' +
			"it), to find the canonical API name of a field (so you don't " +
			'propose "name" when the SObject uses "Name"), and to compose ' +
			'valid new-association calls (referenceTo arrays tell you ' +
			'which parent object a lookup field targets).\n\n' +
			'Call this before propose_record_changes whenever you do not ' +
			"already know a field's exact Salesforce type, writeability, " +
			'format, or allowed values. Do not infer date versus datetime ' +
			'from the field label: date uses YYYY-MM-DD; datetime requires ' +
			'a complete ISO 8601 timestamp with a timezone, such as ' +
			'2026-07-20T14:30:00.000Z. Pass the canvasId returned by ' +
			'read_canvas so the describe comes from the same open canvas and ' +
			'Salesforce connection.\n\n' +
			"IMPORTANT: this tool reads ONLY from the user's browser-side " +
			'describe cache. It will NEVER trigger a fresh Salesforce ' +
			'describe call on your behalf; that would violate the ' +
			'"AI cannot talk to Salesforce" guarantee. If the requested ' +
			'object is not in the cache, the tool returns an actionable error ' +
			'asking the user to add the object to the canvas ' +
			"(which auto-caches its describe through the user's own SF " +
			'session). Every object the user has on the canvas is cached ' +
			"automatically, so if you just need Subject's picklist " +
			'values and Task is on the canvas, this will work.\n\n' +
			'`fields` (optional) slices the describe to just the named ' +
			'fields. Use it when you only need a couple of fields; the ' +
			'full describe for a heavy object (User, Account) can be ' +
			'hundreds of KB.',
		inputSchema: {
			type: 'object',
			properties: {
				canvasId: {
					type: 'string',
					description:
						"Recommended. The id of the canvas whose schema you need, as returned by list_canvases or read_canvas. Supplying it ensures metadata comes from that canvas tab and its active Salesforce connection. When omitted, Org Loom tries the caches of the workspace's open canvases for backward compatibility.",
				},
				objectName: {
					type: 'string',
					description: 'SObject API name (e.g. "Task", "Account", "Contact"). Case-sensitive.',
				},
				fields: {
					type: 'array',
					description:
						"Optional list of field API names to include. When omitted, the full describe is returned. Use this to keep responses small when you only need specific fields' metadata.",
					items: { type: 'string' },
				},
			},
			required: ['objectName'],
			additionalProperties: false,
		},
	},
	{
		name: 'list_pending_proposals',
		description:
			'List pending (not-yet-reviewed) AI proposals for a canvas. Use ' +
			'this to check whether prior proposals are still awaiting review ' +
			'before creating new ones, or to recall what was proposed earlier ' +
			"in a session. Reads from Orgloom's own proposals DB; does not " +
			'call Salesforce.',
		inputSchema: {
			type: 'object',
			properties: {
				canvasId: {
					type: 'string',
					description: 'Canvas id: either a 15/18-char Salesforce ContentDocument id or a "draft-<uuid>" id.',
				},
			},
			required: ['canvasId'],
			additionalProperties: false,
		},
	},
	{
		name: 'withdraw_proposal',
		description:
			'Retract a proposal YOU previously submitted that is still ' +
			'pending review. Use this when you realize a proposal was ' +
			'incorrect, made against a stale snapshot, or has been ' +
			'superseded by a better one, so instead of leaving a bad ' +
			"proposal sitting in the user's review queue, withdraw it " +
			'and submit a fresh one.\n\n' +
			'Constraints (enforced server-side):\n' +
			"  • Only YOUR token's proposals can be withdrawn. Other " +
			"AI clients' proposals are not visible / actionable.\n" +
			'  • The proposal must still be `pending`. Already-applied ' +
			'or already-rejected proposals cannot be unwound; use ' +
			'list_pending_proposals to confirm before calling.\n\n' +
			'Withdrawn proposals stay in the audit log but disappear ' +
			'from the user-facing review banner automatically.',
		inputSchema: {
			type: 'object',
			properties: {
				proposalId: {
					type: 'string',
					description: 'The proposal id returned from your earlier propose_record_changes call.',
				},
			},
			required: ['proposalId'],
			additionalProperties: false,
		},
	},
	{
		name: 'read_proposal_outcome',
		description:
			'Look up the current status of a proposal you previously submitted. ' +
			'Returns one of: pending (still waiting for the user to review), ' +
			'applied (user accepted and the canvas was updated), rejected ' +
			'(user dismissed), withdrawn (you retracted it via ' +
			'withdraw_proposal). For applied proposals, also returns the ' +
			'per-change apply results so you can tell which of your proposed ' +
			'changes succeeded on the canvas vs which failed (e.g., a temp-id ' +
			'reference that did not resolve). Use this after submitting a ' +
			'proposal to close the loop instead of asking the user "did that ' +
			'work?", and BEFORE re-proposing similar changes, to avoid ' +
			'duplicates if the prior proposal is already applied or pending.\n\n' +
			"Only YOUR token's proposals are visible. Other AI clients' " +
			'proposals return NOT_FOUND.',
		inputSchema: {
			type: 'object',
			properties: {
				proposalId: {
					type: 'string',
					description: 'The proposal id returned from your earlier propose_record_changes call.',
				},
			},
			required: ['proposalId'],
			additionalProperties: false,
		},
	},
	{
		name: 'get_canvas_summary',
		description:
			'Lightweight schema-only read of a canvas. Returns the list of ' +
			'SF object types present, per-object counts (loaded vs draft), ' +
			'total association count, and pending-proposal count, but NOT ' +
			'field values. Use this when you want to cheaply orient ("what ' +
			'am I working with?") before deciding whether to spend tokens on ' +
			'the full read_canvas call. Routes through the same browser relay ' +
			'as read_canvas, so the "user must have the canvas open" rule ' +
			'still applies: NOT_FOUND when no live browser holds the canvas.',
		inputSchema: {
			type: 'object',
			properties: {
				canvasId: {
					type: 'string',
					description:
						'Canvas id: 15/18-char SF ContentDocument id or "draft-<uuid>". Use list_canvases to discover valid ids.',
				},
			},
			required: ['canvasId'],
			additionalProperties: false,
		},
	},
	{
		name: 'get_my_capabilities',
		description:
			"Surface this MCP token's permission envelope: which workspace " +
			"you're attached to, its plan tier, what's blocked by workspace " +
			'policy, and current AI/upload usage vs caps. Use this before ' +
			"proposing changes you're unsure about. Pure server-side read; " +
			'does not touch Salesforce.',
		inputSchema: {
			type: 'object',
			properties: {},
			required: [],
			additionalProperties: false,
		},
	},
	{
		name: 'request_clarification',
		description:
			'Ask the user a question via a banner in the Orgloom web UI. ' +
			'The user sees the question on whichever canvas you target, ' +
			'answers it (with free-form text, or by picking one of the ' +
			'optional choices you provide), and the response becomes ' +
			'available via read_clarification. Use this for ambiguous cases ' +
			'where guessing would produce a bad proposal, e.g., "Which ' +
			'field should the contact full name go in: Name or FirstName + ' +
			'LastName?", instead of submitting a low-confidence proposal ' +
			"that wastes the user's review attention.\n\n" +
			'Returns immediately with a clarificationId; poll ' +
			'read_clarification to check whether the user has responded. ' +
			'Clarifications are per-canvas (the banner shows on the canvas ' +
			'you specify) and expire after 24 hours if unanswered.',
		inputSchema: {
			type: 'object',
			properties: {
				canvasId: {
					type: 'string',
					description: 'Canvas id where the question should surface. Use the id from list_canvases.',
				},
				question: {
					type: 'string',
					description:
						'The question to show the user. Keep it short and specific: the user is reading it in a banner, not a chat thread.',
				},
				options: {
					type: 'array',
					description:
						'Optional array of canned response options. When provided, the user sees clickable buttons in addition to a text input. Use 2-6 short options. Omit for pure free-form questions.',
					items: { type: 'string' },
					maxItems: 6,
				},
			},
			required: ['canvasId', 'question'],
			additionalProperties: false,
		},
	},
	{
		name: 'read_clarification',
		description:
			'Read the response to a clarification you previously submitted. ' +
			'Returns one of: pending (user has not responded yet), answered ' +
			'(user has responded - includes their response text and/or ' +
			'picked option), withdrawn (you retracted it), expired (24h ' +
			'lapsed without a response). Poll this after request_clarification ' +
			"to detect when the user has answered. Only YOUR token's " +
			'clarifications are visible.',
		inputSchema: {
			type: 'object',
			properties: {
				clarificationId: {
					type: 'string',
					description: 'The clarification id returned from request_clarification.',
				},
			},
			required: ['clarificationId'],
			additionalProperties: false,
		},
	},
];

const RELAY_REQUEST_TIMEOUT_MS = 5000;

const _SF_CANVAS_ID = /^[a-zA-Z0-9]{15,18}$/;
const _DRAFT_CANVAS_ID = /^draft-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function _validateCanvasId(rawCanvasId) {
	const canvasId = String(rawCanvasId || '');
	if (_SF_CANVAS_ID.test(canvasId) || _DRAFT_CANVAS_ID.test(canvasId)) {
		return canvasId;
	}
	let receivedKind;
	if (rawCanvasId == null) {
		receivedKind = '(no canvasId field - missing from args)';
	} else if (typeof rawCanvasId !== 'string') {
		receivedKind = '(non-string value of type ' + typeof rawCanvasId + ': ' + JSON.stringify(rawCanvasId) + ')';
	} else if (canvasId === '') {
		receivedKind = '(empty string)';
	} else {
		receivedKind = '("' + canvasId + '" - length ' + canvasId.length + ')';
	}
	throw _appError(
		ERR_INVALID_PARAMS,
		'canvasId must be either a 15/18-char Salesforce id (saved canvases) ' +
			'or a draft id of the form "draft-<uuid>" (unsaved canvases). ' +
			'Received: ' +
			receivedKind +
			'. Use list_canvases to discover valid ids - the `id` field in each row is what to pass here, not the `title`.',
	);
}

async function _toolListCanvases(ctx) {
	const rows = relay.listCanvasesInWorkspace(ctx.workspaceId, ctx.account.id);
	return _textResult(
		JSON.stringify({
			canvases: rows.map((r) => ({
				id: r.canvasId,
				title: r.meta.title || '(untitled)',
				ownerSfUserId: r.meta.ownerSfUserId || null,
				liveBrowsers: r.liveBrowsers,
			})),
			selectionGuidance:
				rows.length > 1
					? 'Multiple canvases are open. If the user has not clearly identified the intended canvas, ask which canvas to use. Do not choose based on list order, title similarity, or canvas contents.'
					: undefined,
			hint:
				rows.length === 0
					? "No canvases are open in any browser in this workspace right now. Orgloom routes AI reads through the user's open browser tabs - close the tab, lose the read. Ask the user to open Orgloom and load the canvas they want you to see; the AI's list_canvases / read_canvas calls become live again instantly. If the workspace's ai_on_canvas_data_enabled toggle is off, no canvases will be visible regardless of what's open."
					: undefined,
		}),
	);
}

async function _toolReadCanvas(ctx, args) {
	const canvasId = _validateCanvasId(args && args.canvasId);
	let result;
	try {
		result = await relay.dispatchRequest({
			workspaceId: ctx.workspaceId,
			canvasId,
			accountId: ctx.account.id,
			method: 'read_canvas',
			params: { canvasId },
			timeoutMs: RELAY_REQUEST_TIMEOUT_MS,
		});
	} catch (err) {
		const code = err && err.message;
		if (code === 'no-live-browser-for-canvas') {
			throw _appError(
				ERR_NOT_FOUND,
				'No browser in this workspace currently has canvas ' +
					canvasId +
					' open. Ask the user to open the canvas in Orgloom - reads become available immediately after the page loads. If they already have it open and you still see this, the ai_on_canvas_data_enabled toggle may be off.',
			);
		}
		if (code === 'relay-request-timeout') {
			throw _appError(
				ERR_INTERNAL,
				"Timed out waiting for the user's browser to respond. The tab may be backgrounded, the network may be slow, or the page may be unresponsive. Ask the user to bring the canvas tab to the foreground and retry.",
			);
		}
		if (code === 'relay-connection-dropped') {
			throw _appError(
				ERR_NOT_FOUND,
				"The user's browser tab closed before the request completed. Ask them to re-open the canvas and retry.",
			);
		}
		throw _appError(ERR_INTERNAL, 'Relay error: ' + (code || 'unknown'));
	}

	return _textResult(
		JSON.stringify(
			Object.assign({}, result, {
				live: true,
			}),
		),
	);
}

async function _toolProposeRecordChanges(ctx, args) {
	// Validation uses the browser-provided canvas snapshot; this tool never calls Salesforce directly.
	const canvasId = _validateCanvasId(args && args.canvasId);
	const changes = (args && args.changes) || [];
	if (!Array.isArray(changes) || changes.length === 0) {
		throw _appError(ERR_INVALID_PARAMS, 'changes must be a non-empty array');
	}

	let liveRead;
	try {
		liveRead = await relay.dispatchRequest({
			workspaceId: ctx.workspaceId,
			canvasId,
			accountId: ctx.account.id,
			method: 'read_canvas',
			params: { canvasId },
			timeoutMs: RELAY_REQUEST_TIMEOUT_MS,
		});
	} catch (err) {
		const code = err && err.message;
		if (code === 'no-live-browser-for-canvas') {
			throw _appError(
				ERR_NOT_FOUND,
				'Canvas ' +
					canvasId +
					" isn't open in any browser in this workspace, so the proposal can't be validated against live state. Ask the user to open the canvas in Orgloom, then retry.",
			);
		}
		if (code === 'relay-request-timeout') {
			throw _appError(
				ERR_INTERNAL,
				'Timed out reading the live canvas state. Ask the user to bring the canvas tab to the foreground and retry.',
			);
		}
		throw _appError(ERR_INTERNAL, 'Relay error during proposal pre-validation: ' + (code || 'unknown'));
	}
	const payload = (liveRead && liveRead.payload) || {};
	const loadedRecords = Array.isArray(payload.loadedRecords) ? payload.loadedRecords : [];
	const drafts = Array.isArray(payload.drafts) ? payload.drafts : [];
	const recordById = new Map();
	for (const r of loadedRecords) {
		const id = (r.values && r.values.Id) || r.loadedFromId;
		if (id) {
			recordById.set(String(id), r);
		}
	}
	const draftByTempId = new Map();
	for (const d of drafts) {
		if (d.tempId != null) {
			draftByTempId.set(String(d.tempId), d);
		}
	}

	const cachedAssociations = Array.isArray(payload.associations) ? payload.associations : [];

	const normalized = [];
	const tempRefIndex = new Map();
	const _comparableProposalValue = (value) => {
		if (value == null) {
			return '';
		}
		if (typeof value === 'object') {
			try {
				return JSON.stringify(value);
			} catch {
				return String(value);
			}
		}
		return String(value);
	};
	const _changedFields = (target, proposedFields) => {
		const currentValues = target && target.values && typeof target.values === 'object' ? target.values : {};
		return Object.fromEntries(
			Object.entries(proposedFields).filter(
				([fieldName, proposedValue]) =>
					_comparableProposalValue(currentValues[fieldName]) !== _comparableProposalValue(proposedValue),
			),
		);
	};

	for (const c of changes) {
		if (!c || typeof c !== 'object') {
			continue;
		}
		if (c.kind === 'new-association' || c.kind === 'delete-association') {
			continue;
		}
		if (c.kind === 'delete-draft' || c.kind === 'delete-record') {
			continue;
		}
		if (c.kind === 'autofill-required' || c.kind === 'load-record') {
			continue;
		}
		const hasRecordId = c.recordId != null && c.recordId !== '';
		const hasTempId = c.tempId != null && c.tempId !== '';
		if (hasRecordId || hasTempId) {
			continue;
		}
		if (c.tempRef != null && c.tempRef !== '') {
			const ref = String(c.tempRef);
			if (!/^[a-zA-Z0-9_-]{1,64}$/.test(ref)) {
				throw _appError(ERR_INVALID_PARAMS, 'change.tempRef must be 1-64 chars of [a-zA-Z0-9_-]');
			}
			if (tempRefIndex.has(ref)) {
				throw _appError(
					ERR_INVALID_PARAMS,
					'duplicate tempRef "' + ref + '" - each new-draft tempRef must be unique within a proposal',
				);
			}
			tempRefIndex.set(ref, { objectName: c.objectName });
		}
	}

	function _normalizeAssocEndpoint(label, e) {
		if (!e || typeof e !== 'object' || Array.isArray(e)) {
			throw _appError(
				ERR_INVALID_PARAMS,
				label + ' must be an object with exactly one of recordId / tempId / tempRef',
			);
		}
		const keys = ['recordId', 'tempId', 'tempRef'].filter((k) => e[k] != null && e[k] !== '');
		if (keys.length !== 1) {
			throw _appError(
				ERR_INVALID_PARAMS,
				label + ' must have EXACTLY ONE of recordId / tempId / tempRef (got ' + keys.length + ')',
			);
		}
		const key = keys[0];
		if (key === 'recordId') {
			const id = String(e.recordId);
			if (!/^[a-zA-Z0-9]{15,18}$/.test(id)) {
				throw _appError(ERR_INVALID_PARAMS, label + '.recordId must be a 15- or 18-char Salesforce id');
			}
			if (!recordById.has(id)) {
				throw _appError(
					ERR_INVALID_PARAMS,
					label + '.recordId ' + id + ' is not a loaded record on this canvas (per the cache)',
				);
			}
			return { kind: 'loaded', ref: id };
		}
		if (key === 'tempId') {
			const n = Number(e.tempId);
			if (!Number.isInteger(n)) {
				throw _appError(ERR_INVALID_PARAMS, label + '.tempId must be an integer');
			}
			if (!draftByTempId.has(String(n))) {
				throw _appError(ERR_INVALID_PARAMS, label + '.tempId ' + n + ' is not a draft on this canvas');
			}
			return { kind: 'draft', ref: n };
		}

		const ref = String(e.tempRef);
		if (!tempRefIndex.has(ref)) {
			throw _appError(
				ERR_INVALID_PARAMS,
				label + '.tempRef "' + ref + '" does not match any new-draft tempRef in this proposal',
			);
		}
		return { kind: 'tempRef', ref };
	}

	for (const c of changes) {
		if (!c || typeof c !== 'object') {
			throw _appError(ERR_INVALID_PARAMS, 'each change must be an object');
		}

		if (c.kind === 'delete-draft') {
			if (c.tempId == null || c.tempId === '') {
				throw _appError(
					ERR_INVALID_PARAMS,
					'delete-draft requires tempId (use the tempId visible in read_canvas drafts[].tempId)',
				);
			}
			const tempIdStr = String(c.tempId);
			if (!draftByTempId.has(tempIdStr)) {
				throw _appError(
					ERR_INVALID_PARAMS,
					'delete-draft.tempId ' + tempIdStr + ' is not a draft on this canvas (per the live read)',
				);
			}
			const tempIdValue = /^-?\d+$/.test(tempIdStr) ? Number(tempIdStr) : tempIdStr;
			normalized.push({ kind: 'delete-draft', tempId: tempIdValue });
			continue;
		}
		if (c.kind === 'delete-record') {
			if (!c.recordId || typeof c.recordId !== 'string') {
				throw _appError(
					ERR_INVALID_PARAMS,
					'delete-record requires recordId (15- or 18-char SF id of a loaded record)',
				);
			}
			if (!/^[a-zA-Z0-9]{15,18}$/.test(c.recordId)) {
				throw _appError(ERR_INVALID_PARAMS, 'delete-record.recordId must be a 15- or 18-char Salesforce id');
			}
			if (!recordById.has(String(c.recordId))) {
				throw _appError(
					ERR_INVALID_PARAMS,
					'delete-record.recordId ' +
						c.recordId +
						' is not a loaded record on this canvas - only canvas-loaded records can be removed via this tool. (Note: this removes the reference from the canvas view; the underlying Salesforce record is NOT deleted.)',
				);
			}
			normalized.push({
				kind: 'delete-record',
				recordId: String(c.recordId),
			});
			continue;
		}
		if (c.kind === 'load-record') {
			if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(String(c.objectName || ''))) {
				throw _appError(ERR_INVALID_PARAMS, 'load-record.objectName must be a valid SObject API name');
			}
			if (!c.recordId || typeof c.recordId !== 'string' || !/^[a-zA-Z0-9]{15,18}$/.test(c.recordId)) {
				throw _appError(ERR_INVALID_PARAMS, 'load-record.recordId must be a 15- or 18-char Salesforce id');
			}
			if (c.fields != null && !Array.isArray(c.fields)) {
				throw _appError(
					ERR_INVALID_PARAMS,
					'load-record.fields, when present, must be an array of field API name strings',
				);
			}
			const normalizedFields = Array.isArray(c.fields)
				? c.fields.map((f) => String(f)).filter((f) => /^[a-zA-Z][a-zA-Z0-9_.]*$/.test(f))
				: null;
			normalized.push({
				kind: 'load-record',
				objectName: c.objectName,
				recordId: String(c.recordId),
				fields: normalizedFields,
			});
			continue;
		}
		if (c.kind === 'autofill-required') {
			const tempIds = Array.isArray(c.tempIds) ? c.tempIds : [];
			const normalizedTempIds = [];
			for (const raw of tempIds) {
				const n = Number(raw);
				if (!Number.isInteger(n)) {
					throw _appError(
						ERR_INVALID_PARAMS,
						'autofill-required.tempIds entries must be integer draft tempIds',
					);
				}
				if (!draftByTempId.has(String(n))) {
					throw _appError(
						ERR_INVALID_PARAMS,
						'autofill-required.tempIds[' + n + '] is not a draft on this canvas',
					);
				}
				normalizedTempIds.push(n);
			}
			normalized.push({
				kind: 'autofill-required',
				tempIds: normalizedTempIds,
			});
			continue;
		}
		if (c.kind === 'new-association' || c.kind === 'delete-association') {
			if (!c.fieldName || typeof c.fieldName !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(c.fieldName)) {
				throw _appError(
					ERR_INVALID_PARAMS,
					'association change.fieldName must be a valid SObject field API name (e.g. "AccountId")',
				);
			}
			const from = _normalizeAssocEndpoint('change.from', c.from);
			const to = _normalizeAssocEndpoint('change.to', c.to);

			if (c.kind === 'delete-association') {
				if (from.kind === 'tempRef' || to.kind === 'tempRef') {
					throw _appError(
						ERR_INVALID_PARAMS,
						'delete-association cannot reference a tempRef (the draft does not exist on the canvas yet)',
					);
				}
				const found = cachedAssociations.some(
					(a) =>
						a &&
						a.fieldName === c.fieldName &&
						a.from &&
						a.to &&
						a.from.kind === from.kind &&
						String(a.from.ref) === String(from.ref) &&
						a.to.kind === to.kind &&
						String(a.to.ref) === String(to.ref),
				);
				if (!found) {
					throw _appError(
						ERR_INVALID_PARAMS,
						'delete-association: no matching edge on the canvas (fieldName + from + to must match an existing association)',
					);
				}
			}
			normalized.push({ kind: c.kind, fieldName: c.fieldName, from, to });
			continue;
		}
		if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(String(c.objectName || ''))) {
			throw _appError(ERR_INVALID_PARAMS, 'change.objectName must be a valid SObject API name');
		}
		if (!c.fields || typeof c.fields !== 'object' || Array.isArray(c.fields)) {
			throw _appError(ERR_INVALID_PARAMS, 'change.fields must be an object');
		}
		const hasRecordId = c.recordId != null && c.recordId !== '';
		const hasTempId = c.tempId != null && c.tempId !== '';
		if (hasRecordId && hasTempId) {
			throw _appError(
				ERR_INVALID_PARAMS,
				'each change may have AT MOST one of recordId or tempId (omit both to add a new draft)',
			);
		}
		if (hasRecordId) {
			if (!/^[a-zA-Z0-9]{15,18}$/.test(String(c.recordId))) {
				throw _appError(ERR_INVALID_PARAMS, 'change.recordId must be a 15- or 18-char Salesforce id');
			}
			const target = recordById.get(String(c.recordId));
			if (!target) {
				throw _appError(
					ERR_INVALID_PARAMS,
					'change.recordId ' +
						c.recordId +
						' is not a loaded record on this canvas (per the cache; ask the user to refresh if it should be)',
				);
			}
			const fields = _changedFields(target, c.fields);
			if (Object.keys(fields).length === 0) {
				continue;
			}
			const oldValues = {};
			for (const k of Object.keys(fields)) {
				oldValues[k] = target.values && target.values[k] != null ? target.values[k] : null;
			}
			normalized.push({
				kind: 'record',
				recordId: String(c.recordId),
				objectName: c.objectName,
				fields,
				oldValues,
			});
		} else if (hasTempId) {
			const tempIdStr = String(c.tempId);
			const target = draftByTempId.get(tempIdStr);
			if (!target) {
				throw _appError(
					ERR_INVALID_PARAMS,
					'change.tempId ' +
						tempIdStr +
						' is not a draft on this canvas (per the cache; ask the user to refresh if it should be)',
				);
			}
			const fields = _changedFields(target, c.fields);
			if (Object.keys(fields).length === 0) {
				continue;
			}
			const oldValues = {};
			for (const k of Object.keys(fields)) {
				oldValues[k] = target.values && target.values[k] != null ? target.values[k] : null;
			}

			const tempIdValue = /^-?\d+$/.test(tempIdStr) ? Number(tempIdStr) : tempIdStr;
			normalized.push({
				kind: 'draft',
				tempId: tempIdValue,
				objectName: c.objectName,
				fields,
				oldValues,
			});
		} else {
			const entry = {
				kind: 'new-draft',
				objectName: c.objectName,
				fields: c.fields,
			};
			if (c.tempRef != null && c.tempRef !== '') {
				entry.tempRef = String(c.tempRef);
			}
			normalized.push(entry);
		}
	}

	if (normalized.length === 0) {
		throw _appError(
			ERR_INVALID_PARAMS,
			'Proposal contains no effective changes. Omit fields whose values already match the canvas and retry.',
		);
	}

	const proposal = await proposalsDb.create({
		canvasId,
		workspaceId: ctx.workspaceId,
		proposingAccountId: ctx.account.id,
		proposingTokenId: ctx.mcpToken.id,
		summary: args.summary || null,
		changes: normalized,
	});
	relay.broadcastCanvasEvent({
		workspaceId: ctx.workspaceId,
		canvasId,
		accountId: ctx.account.id,
		event: 'ai-proposals-changed',
	});

	const reviewUrl = '/?openCanvas=' + encodeURIComponent(canvasId);
	const recordCount = normalized.filter((c) => c.kind === 'record').length;
	const draftCount = normalized.filter((c) => c.kind === 'draft').length;
	const newDraftCount = normalized.filter((c) => c.kind === 'new-draft').length;
	const newAssocCount = normalized.filter((c) => c.kind === 'new-association').length;
	const delAssocCount = normalized.filter((c) => c.kind === 'delete-association').length;
	const delDraftCount = normalized.filter((c) => c.kind === 'delete-draft').length;
	const delRecordCount = normalized.filter((c) => c.kind === 'delete-record').length;
	const autofillCount = normalized.filter((c) => c.kind === 'autofill-required').length;
	const loadRecordCount = normalized.filter((c) => c.kind === 'load-record').length;
	const parts = [];
	if (newDraftCount) {
		parts.push(newDraftCount + ' new draft(s) to add');
	}
	if (recordCount) {
		parts.push(recordCount + ' edit(s) to existing SF record(s)');
	}
	if (draftCount) {
		parts.push(draftCount + ' edit(s) to existing draft(s)');
	}
	if (newAssocCount) {
		parts.push(newAssocCount + ' new association(s)');
	}
	if (delAssocCount) {
		parts.push(delAssocCount + ' association(s) to remove');
	}
	if (delDraftCount) {
		parts.push(delDraftCount + ' draft(s) to remove');
	}
	if (delRecordCount) {
		parts.push(delRecordCount + ' loaded record(s) to remove from canvas');
	}
	if (autofillCount) {
		parts.push(autofillCount + ' autofill pass(es)');
	}
	if (loadRecordCount) {
		parts.push(loadRecordCount + ' SF record(s) to load onto canvas');
	}
	return _textResult(
		JSON.stringify({
			proposalId: proposal.id,
			canvasId,
			changeCount: normalized.length,
			newDraftCount,
			recordChangeCount: recordCount,
			draftChangeCount: draftCount,
			newAssociationCount: newAssocCount,
			deleteAssociationCount: delAssocCount,
			deleteDraftCount: delDraftCount,
			deleteRecordCount: delRecordCount,
			autofillCount,
			loadRecordCount,
			status: 'pending',
			reviewUrl,
			message:
				'Created proposal: ' +
				parts.join(' + ') +
				'. ' +
				'On accept, changes land on the canvas - they are NOT written ' +
				'to Salesforce. The user pushes to Salesforce later via the ' +
				'canvas upload flow. Direct them to ' +
				reviewUrl +
				' to review.',
		}),
	);
}

async function _toolListPendingProposals(ctx, args) {
	const rawCanvasId = args && args.canvasId;
	const canvasId = String(rawCanvasId || '');
	const isSfId = /^[a-zA-Z0-9]{15,18}$/.test(canvasId);
	const isDraftId = /^draft-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(canvasId);
	if (!isSfId && !isDraftId) {
		let receivedKind;
		if (rawCanvasId == null) {
			receivedKind = '(no canvasId field - missing from args)';
		} else if (typeof rawCanvasId !== 'string') {
			receivedKind = '(non-string value of type ' + typeof rawCanvasId + ': ' + JSON.stringify(rawCanvasId) + ')';
		} else if (canvasId === '') {
			receivedKind = '(empty string)';
		} else {
			receivedKind =
				'("' + canvasId + '" - length ' + canvasId.length + ', expected 15 or 18 alphanumeric chars)';
		}
		throw _appError(
			ERR_INVALID_PARAMS,
			'canvasId must be a 15/18-char Salesforce id or draft-<uuid>. Received: ' +
				receivedKind +
				'. Use list_canvases to discover valid ids - the `id` field in each row is what to pass here, not the `title`.',
		);
	}
	const rows = await proposalsDb.listPendingForCanvas(canvasId);

	const visible = rows.filter((p) => p.workspaceId === ctx.workspaceId && p.proposingAccountId === ctx.account.id);
	return _textResult(
		JSON.stringify({
			canvasId,
			pending: visible.map((p) => ({
				proposalId: p.id,
				summary: p.summary,
				changeCount: p.changes.length,
				createdAt: p.createdAt,
				proposingAccountId: p.proposingAccountId,
			})),
		}),
	);
}

async function _toolDescribeObject(ctx, args) {
	const objectName = String((args && args.objectName) || '');
	if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(objectName)) {
		throw _appError(
			ERR_INVALID_PARAMS,
			'objectName must be a valid SObject API name (letters/digits/_; starts with a letter)',
		);
	}
	const fields = Array.isArray(args && args.fields) ? args.fields : null;
	const requestedCanvasId = args && args.canvasId != null ? _validateCanvasId(args.canvasId) : null;

	const liveCanvases = relay.listCanvasesInWorkspace(ctx.workspaceId, ctx.account.id);
	if (liveCanvases.length === 0) {
		return _textErrorResult(
			'No canvases are currently open in any browser in this workspace, so I have no browser to fetch the describe cache from. Ask the user to open a canvas in Org Loom - any object on the canvas is auto-cached.',
		);
	}

	const liveCanvasIds = liveCanvases.map((canvas) => canvas.canvasId);
	if (requestedCanvasId && !liveCanvasIds.includes(requestedCanvasId)) {
		return _textErrorResult(
			'Canvas ' +
				requestedCanvasId +
				' is not currently open in this workspace. Ask the user to open that canvas, then retry describe_object with the same canvasId.',
		);
	}

	const candidateCanvasIds = requestedCanvasId ? [requestedCanvasId] : liveCanvasIds;
	let lastRelayError = null;
	let receivedCacheMiss = false;
	for (const canvasId of candidateCanvasIds) {
		try {
			const result = await relay.dispatchRequest({
				workspaceId: ctx.workspaceId,
				canvasId,
				accountId: ctx.account.id,
				method: 'describe_object',
				params: { objectName, fields },
				timeoutMs: RELAY_REQUEST_TIMEOUT_MS,
			});
			if (result && !result.cacheMiss) {
				return _textResult(JSON.stringify(result));
			}
			receivedCacheMiss = true;
		} catch (err) {
			lastRelayError = err && err.message;
		}
	}

	if (!receivedCacheMiss && lastRelayError === 'relay-request-timeout') {
		return _textErrorResult(
			"Timed out waiting for the user's browser to return Salesforce field metadata. Ask the user to bring the target canvas tab to the foreground, then retry describe_object with that canvasId.",
		);
	}
	if (
		!receivedCacheMiss &&
		lastRelayError &&
		lastRelayError !== 'no-live-browser-for-canvas' &&
		lastRelayError !== 'relay-connection-dropped'
	) {
		return _textErrorResult(
			'Could not read Salesforce field metadata from the open canvas: ' + lastRelayError + '.',
		);
	}
	return _textErrorResult(
		"Object '" +
			objectName +
			"' is not in the describe cache for " +
			(requestedCanvasId ? 'the requested canvas' : 'any open canvas in this workspace') +
			". Ask the user to add an example '" +
			objectName +
			"' record to that canvas, wait for it to finish loading, then retry describe_object with the canvasId. Org Loom does not fetch schema directly from Salesforce for an AI client.",
	);
}

async function _toolWithdrawProposal(ctx, args) {
	const proposalId = String((args && args.proposalId) || '');
	if (!proposalId) {
		throw _appError(ERR_INVALID_PARAMS, 'proposalId is required');
	}
	const proposal = await proposalsDb.findById(proposalId);
	if (!proposal) {
		throw _appError(ERR_NOT_FOUND, 'Proposal ' + proposalId + ' not found.');
	}

	if (proposal.workspaceId !== ctx.workspaceId) {
		throw _appError(ERR_NOT_FOUND, 'Proposal ' + proposalId + ' not found.');
	}
	if (proposal.proposingAccountId !== ctx.account.id) {
		throw _appError(ERR_NOT_FOUND, 'Proposal ' + proposalId + ' not found.');
	}

	if (proposal.proposingTokenId && ctx.mcpToken && ctx.mcpToken.id !== proposal.proposingTokenId) {
		throw _appError(
			ERR_AUTH,
			'Only the token that submitted a proposal can withdraw it. This proposal was submitted by a different token.',
		);
	}
	if (proposal.status !== 'pending') {
		throw _appError(
			ERR_INVALID_PARAMS,
			'Proposal ' +
				proposalId +
				' is not pending (current status: ' +
				proposal.status +
				'). Already-applied / already-rejected / already-withdrawn proposals cannot be retracted.',
		);
	}
	const ok = await proposalsDb.markWithdrawn({ id: proposalId });
	if (!ok) {
		throw _appError(
			ERR_INVALID_PARAMS,
			'Proposal ' +
				proposalId +
				' is no longer pending - another action changed its status between read and withdraw.',
		);
	}
	relay.broadcastCanvasEvent({
		workspaceId: ctx.workspaceId,
		canvasId: proposal.canvasId,
		accountId: ctx.account.id,
		event: 'ai-proposals-changed',
	});
	try {
		await ext.auditWrite({
			workspaceId: ctx.workspaceId,
			actorAccountId: ctx.account.id,
			action: 'ai_proposal_withdrawn',
			targetObject: 'ai_proposals',
			targetId: proposalId,
			payload: {
				canvasId: proposal.canvasId,
				proposingTokenId: proposal.proposingTokenId,
				changeCount: proposal.changes.length,
			},
		});
	} catch (e) {}
	return _textResult(
		JSON.stringify({
			proposalId,
			status: 'withdrawn',
			message: 'Proposal withdrawn. The open canvas will update automatically.',
		}),
	);
}

async function _toolReadProposalOutcome(ctx, args) {
	const proposalId = String((args && args.proposalId) || '');
	if (!proposalId) {
		throw _appError(ERR_INVALID_PARAMS, 'proposalId is required');
	}
	const appliedRow = await auditDb
		.findLatestByTarget({
			workspaceId: ctx.workspaceId,
			action: 'ai_proposal_applied',
			targetId: proposalId,
		})
		.catch(() => null);
	const rejectedRow = await auditDb
		.findLatestByTarget({
			workspaceId: ctx.workspaceId,
			action: 'ai_proposal_rejected',
			targetId: proposalId,
		})
		.catch(() => null);
	let terminalRow = null;
	let terminalStatus = null;
	if (appliedRow && (!rejectedRow || (appliedRow.createdAt || 0) >= (rejectedRow.createdAt || 0))) {
		terminalRow = appliedRow;
		terminalStatus = 'applied';
	} else if (rejectedRow) {
		terminalRow = rejectedRow;
		terminalStatus = 'rejected';
	}
	if (terminalRow) {
		const payloadTokenId = terminalRow.payload && terminalRow.payload.proposingTokenId;
		if (payloadTokenId && ctx.mcpToken && ctx.mcpToken.id !== payloadTokenId) {
			throw _appError(ERR_NOT_FOUND, 'Proposal ' + proposalId + ' not found.');
		}
		const response = {
			proposalId,
			canvasId: (terminalRow.payload && terminalRow.payload.canvasId) || null,
			status: terminalStatus,
			decidedAt: terminalRow.createdAt,
		};
		if (terminalStatus === 'applied' && terminalRow.payload && Array.isArray(terminalRow.payload.results)) {
			response.applyResults = terminalRow.payload.results;
		}
		if (terminalRow.payload && terminalRow.payload.mode) {
			response.applyMode = terminalRow.payload.mode;
		}
		return _textResult(JSON.stringify(response));
	}
	const proposal = await proposalsDb.findById(proposalId);
	if (!proposal) {
		throw _appError(ERR_NOT_FOUND, 'Proposal ' + proposalId + ' not found.');
	}
	if (proposal.workspaceId !== ctx.workspaceId) {
		throw _appError(ERR_NOT_FOUND, 'Proposal ' + proposalId + ' not found.');
	}
	if (proposal.proposingTokenId && ctx.mcpToken && ctx.mcpToken.id !== proposal.proposingTokenId) {
		throw _appError(ERR_NOT_FOUND, 'Proposal ' + proposalId + ' not found.');
	}
	return _textResult(
		JSON.stringify({
			proposalId,
			canvasId: proposal.canvasId,
			status: proposal.status,
			summary: proposal.summary,
			changeCount: proposal.changes.length,
			createdAt: proposal.createdAt,
			decidedAt: proposal.decidedAt,
		}),
	);
}

async function _toolGetCanvasSummary(ctx, args) {
	const canvasId = _validateCanvasId(args && args.canvasId);
	let canvas;
	try {
		canvas = await relay.dispatchRequest({
			workspaceId: ctx.workspaceId,
			canvasId,
			accountId: ctx.account.id,
			method: 'read_canvas',
			params: { canvasId },
			timeoutMs: RELAY_REQUEST_TIMEOUT_MS,
		});
	} catch (err) {
		const code = err && err.message;
		if (code === 'no-live-browser-for-canvas') {
			throw _appError(
				ERR_NOT_FOUND,
				"No browser currently has canvas '" +
					canvasId +
					"' open. Ask the user to open it in Org Loom and retry.",
			);
		}
		if (code === 'relay-connection-dropped') {
			throw _appError(ERR_NOT_FOUND, "The user's browser disconnected before the canvas could be read.");
		}
		if (code === 'relay-request-timeout') {
			throw _appError(
				ERR_INTERNAL,
				"Timed out waiting for the user's browser. The tab may be backgrounded - ask them to bring it forward and retry.",
			);
		}
		throw _appError(ERR_INTERNAL, 'Relay error: ' + (code || 'unknown'));
	}
	if (!canvas) {
		throw _appError(ERR_NOT_FOUND, 'Canvas ' + canvasId + ' did not return a payload.');
	}

	const drafts = Array.isArray(canvas.drafts) ? canvas.drafts : [];
	const loaded = Array.isArray(canvas.loadedRecords) ? canvas.loadedRecords : [];
	const associations = Array.isArray(canvas.associations) ? canvas.associations : [];
	const byObject = {};
	for (const d of drafts) {
		const k = (d && d.objectName) || '(unknown)';
		if (!byObject[k]) {
			byObject[k] = { loaded: 0, drafts: 0 };
		}
		byObject[k].drafts += 1;
	}
	for (const r of loaded) {
		const k = (r && r.objectName) || '(unknown)';
		if (!byObject[k]) {
			byObject[k] = { loaded: 0, drafts: 0 };
		}
		byObject[k].loaded += 1;
	}
	let pendingProposalCount = 0;
	try {
		const pending = await proposalsDb.listPendingForCanvas(canvasId);
		pendingProposalCount = pending.filter((p) => p.workspaceId === ctx.workspaceId).length;
	} catch (_e) {}
	return _textResult(
		JSON.stringify({
			canvasId,
			title: canvas.title || null,
			objects: byObject,
			totalLoaded: loaded.length,
			totalDrafts: drafts.length,
			associationCount: associations.length,
			hasPendingProposals: pendingProposalCount > 0,
			pendingProposalCount,
		}),
	);
}

async function _toolGetMyCapabilities(ctx) {
	let workspacesDb = null;
	let usageDb = null;
	let workspaceCreditsDb = null;
	try {
		workspacesDb = await import('orgloom-saas/database/workspaces');
		usageDb = await import('orgloom-saas/database/usage');
		workspaceCreditsDb = await import('orgloom-saas/database/workspace-credits');
	} catch (_e) {
		return _textResult(
			JSON.stringify({
				workspace: {
					id: ctx.workspaceId,
					planId: 'self-host',
					planLabel: 'Self-host',
				},
				policy: {
					aiOnCanvasDataEnabled: true,
					mcpRequiredReview: true,
				},
				usage: null,
				allowedChangeKinds: _ALL_CHANGE_KINDS,
				notes: [
					'Running in canvas-standalone mode. No plan caps; the user opted into AI access by installing this instance.',
				],
			}),
		);
	}
	const { PLANS, planById } = await import('../capabilities.js');
	const plan = (await workspacesDb.getPlan(ctx.workspaceId)) || planById(null);

	let settings = null;
	try {
		const db = ext.getDb();
		settings = await db
			.selectFrom('workspace_settings')
			.selectAll()
			.where('workspace_id', '=', ctx.workspaceId)
			.executeTakeFirst();
	} catch (_e) {}
	settings = settings || {
		ai_on_canvas_data_enabled: 0,
		mcp_required_review: 1,
	};

	let usage = { aiTokens: null, uploads: null };
	try {
		const counters = await usageDb.getCountersForPeriod(ctx.workspaceId);
		const aiCap = plan.monthly_ai_tokens;
		const uploadsCap = plan.monthly_upload_cap;
		const aiUsed = counters.ai_tokens || 0;
		const uploadsUsed = counters.uploads || 0;
		let creditsRemaining = 0;
		try {
			creditsRemaining = await workspaceCreditsDb.getBalance(ctx.workspaceId);
		} catch (_e) {}
		usage = {
			aiTokens: {
				used: aiUsed,
				cap: aiCap,
				remaining: aiCap == null ? null : Math.max(0, aiCap - aiUsed),
				creditsRemaining,
			},
			uploads: {
				used: uploadsUsed,
				cap: uploadsCap,
				remaining: uploadsCap == null ? null : Math.max(0, uploadsCap - uploadsUsed),
			},
		};
	} catch (_e) {}

	const allowed = _ALL_CHANGE_KINDS.slice();

	const notes = [];
	if (!settings.ai_on_canvas_data_enabled) {
		notes.push(
			'ai_on_canvas_data_enabled is OFF. Workspace admins control this toggle; without it, every MCP tool call returns FORBIDDEN.',
		);
	}
	if (settings.mcp_required_review) {
		notes.push(
			'mcp_required_review is ON. Proposals always require human review before apply - same as the default.',
		);
	}

	return _textResult(
		JSON.stringify({
			workspace: {
				id: ctx.workspaceId,
				planId: plan.id,
				planLabel: plan.label,
			},
			policy: {
				aiOnCanvasDataEnabled: !!settings.ai_on_canvas_data_enabled,
				mcpRequiredReview: !!settings.mcp_required_review,
			},
			usage,
			allowedChangeKinds: allowed,
			notes,
		}),
	);
}

const _ALL_CHANGE_KINDS = Object.freeze([
	'new-draft',
	'record',
	'draft',
	'new-association',
	'delete-association',
	'delete-draft',
	'delete-record',
	'autofill-required',
	'load-record',
]);

async function _toolRequestClarification(ctx, args) {
	const canvasId = _validateCanvasId(args && args.canvasId);
	const question = String((args && args.question) || '').trim();
	if (!question) {
		throw _appError(ERR_INVALID_PARAMS, 'question is required and must be non-empty.');
	}
	if (question.length > 500) {
		throw _appError(
			ERR_INVALID_PARAMS,
			'question is too long (max 500 chars). Keep it short - the user reads it in a banner.',
		);
	}
	const rawOptions = args && args.options;
	let options = null;
	if (rawOptions != null) {
		if (!Array.isArray(rawOptions)) {
			throw _appError(ERR_INVALID_PARAMS, 'options must be an array of strings when provided.');
		}
		if (rawOptions.length > 6) {
			throw _appError(ERR_INVALID_PARAMS, 'options is capped at 6 entries.');
		}
		options = rawOptions.map((o) => String(o || '').slice(0, 120)).filter(Boolean);
		if (options.length === 0) {
			options = null;
		}
	}
	const { aiClarifications } = await import('../database/index.js');
	if (!aiClarifications || typeof aiClarifications.create !== 'function') {
		throw _appError(ERR_INTERNAL, 'Clarifications storage is not available in this deployment.');
	}
	const created = await aiClarifications.create({
		canvasId,
		workspaceId: ctx.workspaceId,
		requestingAccountId: ctx.account.id,
		requestingTokenId: (ctx.mcpToken && ctx.mcpToken.id) || null,
		question,
		options,
	});
	try {
		await ext.auditWrite({
			workspaceId: ctx.workspaceId,
			actorAccountId: ctx.account.id,
			action: 'ai_clarification_requested',
			targetObject: 'ai_clarifications',
			targetId: created.id,
			payload: {
				canvasId,
				hasOptions: !!options,
				optionCount: options ? options.length : 0,
			},
		});
	} catch (_e) {}
	return _textResult(
		JSON.stringify({
			clarificationId: created.id,
			canvasId,
			status: 'pending',
			expiresAt: created.expiresAt,
			message:
				'Clarification surfaced to the user. Poll read_clarification to check whether they have responded.',
		}),
	);
}

async function _toolReadClarification(ctx, args) {
	const clarificationId = String((args && args.clarificationId) || '');
	if (!clarificationId) {
		throw _appError(ERR_INVALID_PARAMS, 'clarificationId is required');
	}
	const { aiClarifications } = await import('../database/index.js');
	if (!aiClarifications || typeof aiClarifications.findById !== 'function') {
		throw _appError(ERR_INTERNAL, 'Clarifications storage is not available in this deployment.');
	}
	const row = await aiClarifications.findById(clarificationId);
	if (!row) {
		throw _appError(ERR_NOT_FOUND, 'Clarification ' + clarificationId + ' not found.');
	}
	if (row.workspaceId !== ctx.workspaceId) {
		throw _appError(ERR_NOT_FOUND, 'Clarification ' + clarificationId + ' not found.');
	}
	if (row.requestingTokenId && ctx.mcpToken && ctx.mcpToken.id !== row.requestingTokenId) {
		throw _appError(ERR_NOT_FOUND, 'Clarification ' + clarificationId + ' not found.');
	}

	let status = row.status;
	if (status === 'pending' && row.expiresAt && row.expiresAt < Date.now()) {
		status = 'expired';
	}
	return _textResult(
		JSON.stringify({
			clarificationId,
			canvasId: row.canvasId,
			question: row.question,
			options: row.options,
			status,
			responseText: row.responseText,
			responseOption: row.responseOption,
			createdAt: row.createdAt,
			respondedAt: row.respondedAt,
			expiresAt: row.expiresAt,
		}),
	);
}

const TOOL_HANDLERS = {
	list_canvases: _toolListCanvases,
	read_canvas: _toolReadCanvas,
	propose_record_changes: _toolProposeRecordChanges,
	list_pending_proposals: _toolListPendingProposals,
	describe_object: _toolDescribeObject,
	withdraw_proposal: _toolWithdrawProposal,
	read_proposal_outcome: _toolReadProposalOutcome,
	get_canvas_summary: _toolGetCanvasSummary,
	get_my_capabilities: _toolGetMyCapabilities,
	request_clarification: _toolRequestClarification,
	read_clarification: _toolReadClarification,
};

async function _handleInitialize() {
	return {
		protocolVersion: PROTOCOL_VERSION,
		capabilities: {
			tools: { listChanged: false },
		},
		serverInfo: SERVER_INFO,
	};
}

async function _handleToolsList() {
	return { tools: TOOLS };
}

async function _handleToolsCall(ctx, params) {
	const name = params && params.name;
	const args = (params && params.arguments) || {};
	if (!name || typeof name !== 'string') {
		throw _appError(ERR_INVALID_PARAMS, 'tools/call requires a name');
	}
	const handler = TOOL_HANDLERS[name];
	if (!handler) {
		throw _appError(ERR_METHOD_NOT_FOUND, 'Unknown tool: ' + name);
	}

	const cap = await ext.getCapability(ctx.account, 'ai-edit-on-canvas', {
		workspaceId: ctx.workspaceId,
		actorKind: 'mcp',
		mcpTokenId: ctx.mcpToken && ctx.mcpToken.id,
		auditAction: 'mcp_tool_call',
		auditPayload: { tool: name },
	});
	if (!cap.allowed) {
		const reason = cap.reason || 'capability-denied';
		throw _appError(ERR_FORBIDDEN, 'Capability denied: ' + reason, {
			reason,
			...cap,
		});
	}

	let result;
	try {
		result = await handler(ctx, args);
	} catch (err) {
		await ext
			.auditWrite({
				workspaceId: ctx.workspaceId,
				actorAccountId: ctx.account.id,
				actorKind: 'mcp',
				mcpTokenId: ctx.mcpToken.id,
				action: 'mcp_tool_call_failed',
				targetObject: 'mcp',
				status: 'failed',
				errorCode: 'mcp-tool-failed',
				payload: { tool: name },
			})
			.catch(() => {});
		throw err;
	}

	const toolReportedError = result && result.isError === true;
	await ext
		.auditWrite({
			workspaceId: ctx.workspaceId,
			actorAccountId: ctx.account.id,
			actorKind: 'mcp',
			mcpTokenId: ctx.mcpToken.id,
			action: toolReportedError ? 'mcp_tool_call_failed' : 'mcp_tool_call',
			targetObject: 'mcp',
			status: toolReportedError ? 'failed' : undefined,
			errorCode: toolReportedError ? 'mcp-tool-failed' : undefined,
			payload: { tool: name },
		})
		.catch(() => {});

	return result;
}

export async function mcpHandler(req, res) {
	// JSON-RPC errors remain structured, while authentication failures also carry HTTP 401.
	const body = req.body;
	if (!body || typeof body !== 'object') {
		return _sendError(res, null, ERR_PARSE, 'Body must be a JSON-RPC 2.0 object');
	}
	if (body.jsonrpc !== '2.0') {
		return _sendError(res, body.id, ERR_INVALID_REQUEST, "jsonrpc must be '2.0'");
	}
	const method = body.method;
	const id = body.id;

	if (id == null) {
		return res.status(204).end();
	}

	try {
		const ctx = await _resolveContext(req);

		let result;
		switch (method) {
			case 'initialize':
				result = await _handleInitialize();
				break;
			case 'ping':
				result = {};
				break;
			case 'tools/list':
				result = await _handleToolsList();
				break;
			case 'tools/call':
				result = await _handleToolsCall(ctx, body.params);
				break;
			default:
				throw _appError(ERR_METHOD_NOT_FOUND, 'Unknown method: ' + method);
		}
		return _sendResult(res, id, result);
	} catch (err) {
		const code = (err && err.jsonRpcCode) || ERR_INTERNAL;
		const message = (err && err.message) || 'Internal error';
		const data = err && err.data;
		if (code === ERR_AUTH) {
			res.status(401);
		} else if (code === ERR_RATE_LIMIT) {
			res.status(429);
			res.setHeader('Retry-After', '60');
		}
		return _sendError(res, id, code, message, data);
	}
}

async function _resolveContext(req) {
	// Token ownership and workspace scope are resolved before any tool handler runs.
	const authHeader = req.headers.authorization || req.headers.Authorization;
	if (!authHeader || typeof authHeader !== 'string') {
		throw _appError(ERR_AUTH, 'Missing Authorization header');
	}
	const m = authHeader.match(/^Bearer\s+(.+)$/i);
	if (!m) {
		throw _appError(ERR_AUTH, 'Authorization must be Bearer scheme');
	}
	const plaintext = m[1].trim();

	const tokenRow = await mcpTokensDb.authenticate(plaintext);
	if (!tokenRow) {
		throw _appError(ERR_AUTH, 'Invalid, expired, or revoked token');
	}
	if (!_consumeTokenRequest(tokenRow.id)) {
		throw _appError(ERR_RATE_LIMIT, 'MCP token request limit exceeded', { retryAfterSeconds: 60 });
	}

	const account = await accountsDb.findById(tokenRow.account_id);
	if (!account || account.deleted_at) {
		throw _appError(ERR_AUTH, 'Account not found or deleted');
	}

	const workspaceId = tokenRow.workspace_id;
	if (!workspaceId) {
		throw _appError(ERR_NO_WORKSPACE, 'MCP token is not bound to a workspace');
	}
	try {
		const membership = await ext
			.getDb()
			.selectFrom('workspace_members')
			.select('role')
			.where('workspace_id', '=', workspaceId)
			.where('account_id', '=', account.id)
			.executeTakeFirst();
		if (!membership) {
			throw _appError(ERR_AUTH, 'Token owner is no longer a member of this workspace');
		}
	} catch (err) {
		if (err && err.jsonRpcCode === ERR_AUTH) {
			throw err;
		}
		if (ext.saasMounted) {
			throw _appError(ERR_AUTH, 'Workspace membership could not be verified');
		}
		// Standalone installs do not have workspace membership tables.
	}

	return { account, workspaceId, mcpToken: tokenRow };
}

function _textResult(text) {
	return { content: [{ type: 'text', text }] };
}

function _textErrorResult(text) {
	return { content: [{ type: 'text', text }], isError: true };
}

function _appError(code, message, data) {
	const err = new Error(message);
	err.jsonRpcCode = code;
	if (data !== undefined) {
		err.data = data;
	}
	return err;
}

function _sendResult(res, id, result) {
	res.json({ jsonrpc: '2.0', id, result });
}

function _sendError(res, id, code, message, data) {
	const error = { code, message };
	if (data !== undefined) {
		error.data = data;
	}
	res.json({ jsonrpc: '2.0', id, error });
}
