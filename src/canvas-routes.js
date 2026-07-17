// Routes for the post-rewrite workspace + plan + security model. Mounted
// from server.js via mountRoutesV2(app) once the rest of server.js is
// updated to import from the new database modules.
//
// Surface area covered here:
//   - Account session: GET /api/me, GET /api/me/capabilities
//   - Workspace lifecycle: list, create, activate, rename, settings,
//     invite, join, members
//   - Connection lifecycle: list, activate, disconnect
//   - Org approval lifecycle: list, decide, pre-approve
//
// Every action that takes a side-effect goes through ext.getCapability()
// from src/extensions.js (the plug-point registry; saas-extensions.js
// registers policy.js's hasCapability as the implementation). There are
// no ad-hoc gates in this file: adding a new gated capability is one
// entry in src/capabilities.js. buildCapabilityMap is still imported
// directly from policy.js because it's a saas-specific bulk helper used
// by /api/me/capabilities; canvas standalone doesn't expose that route.

// Use the package self-reference, matching the SaaS registration shim.
// On Windows npm workspace junctions, mixing `./extensions.js` with
// `orgloom-canvas/extensions` can instantiate two ESM registries; routes
// then retain the permissive canvas fallback instead of the SaaS sink.
import { ext as defaultExt } from 'orgloom-canvas/extensions';
let ext = defaultExt;
import { connections as connectionsDb } from './database/index.js';
import { audit as auditDb } from './database/index.js';
import { aiProposals as proposalsDb, aiClarifications as clarificationsDb } from './database/index.js';
import { canvasRoleGrants as canvasRoleGrantsDb } from './database/index.js';
import * as accountsDb from './database/accounts.js';
import * as viewStateDb from './database/view-state.js';
import { dropRefreshToken } from './sf-refresh-store.js';
import * as mcpRelay from './mcp/relay.js';
import * as canvasPresence from './canvas-presence.js';
import { PLANS, planById } from './capabilities.js';
import { getActiveSfConnection } from './sf-connection.js';
import { hasAssignedOrgloomPermissionSet } from './sf-permset.js';
import { isSalesforceSessionExpiredError } from './sf-session-errors.js';
import { canvasStoreFromSfConnection } from './storage/canvas-store.js';
import { uploadBatchesStoreFromSfConnection } from './storage/upload-batches-store.js';
import { stripDraftsForNonOwner, planSlotFills, payloadContainsSlots } from './slot-helpers.js';
import { recordsToShareFromManifest } from './sf-record-share.js';
import { recipientRequiresPlan } from './shared-canvas-entitlement.js';

// ---- SaaS-side dependencies (loaded conditionally) ---------------------
//
// Routes in this file that conditionally extend their behavior when the
// saas layer is mounted (saved-canvas-cap preflight, magic-link share
// flow, plan-aware AI quotas, share-notification emails, etc.) reach
// these through the bindings below. In the saas monorepo, the imports
// resolve via the orgloom-saas package; in canvas-standalone, they
// throw MODULE_NOT_FOUND and `_saasAvailable` stays false so every
// conditional block is skipped. Routes that exist ONLY in saas mode
// live in apps/saas/src/saas-routes.js; they don't need these bindings.
let workspacesDb = null;
let usageDb = null;
let magicLinkTokensDb = null;
let workspaceCreditsDb = null;
let buildCapabilityMap = null;
let sendCanvasShareInvite = null;
let sendCanvasFillNotification = null;
let sendDirectCanvasShareNotification = null;
let _saasAvailable = false;
try {
	workspacesDb = await import('orgloom-saas/database/workspaces');
	usageDb = await import('orgloom-saas/database/usage');
	magicLinkTokensDb = await import('orgloom-saas/database/magic-link-tokens');
	workspaceCreditsDb = await import('orgloom-saas/database/workspace-credits');
	({ buildCapabilityMap } = await import('orgloom-saas/policy'));
	({ sendCanvasShareInvite, sendCanvasFillNotification, sendDirectCanvasShareNotification }
		= await import('orgloom-saas/email'));
	_saasAvailable = true;
} catch (_e) {
	// Canvas standalone build: orgloom-saas isn't installed. Conditional
	// blocks below check `_saasAvailable` (or a non-null binding) before
	// touching these.
}


import { isEnabled as anthropicEnabled, getClient as getAnthropicClient, ANTHROPIC_MODEL } from './anthropic-client.js';
import {
	AI_MAX_RECORDS,
	AI_MAX_OBJECTS,
	AI_MAX_PROMPT_CHARS,
	buildAiDescribeSummary,
	buildAiSystemPrompt,
	AI_PLAN_TOOL,
	validateAiPlan,
} from './ai-plan.js';
import {
	rejectIfOverPayloadCap,
	makeDescribeCache,
	stripUnwritableFields,
	formatUploadError,
	extractUploadErrorCode,
	topoSortRecords,
	normalizeValuesForUpload,
	groupConnectedComponents,
	graphRefIdFor,
	buildGraphSubRequest,
	GRAPH_PER_GRAPH_CAP,
	GRAPH_TOTAL_NODES_CAP,
} from './sf-upload.js';
import { applySlotFieldFilter } from './slot-helpers.js';
import { executeRecall, classifyBatchDrift, classifyValueDrift, detectCascadeConflicts, planDeleteOrder } from './upload-recall.js';
import { runBulkJob } from './sf-bulk.js';
import { listObjects, loadDescribeForObject, getQueryableSObjects, cleanLabel, isNoiseSObject } from './sf-describe.js';
import {
	escapeSoqlLiteral,
	formatSoqlFieldLiteral,
	normalizeSoqlFieldValue,
	validateSoqlFilterField,
} from './sf-soql.js';
import { transformToolingRecords } from './validation-rules.js';
import { makeLimiter } from './rate-limit.js';

import { withSfRetry } from './sf-upload.js';

// Close the check-then-create race between two simultaneous submissions that
// carry the same client attempt id. The durable Salesforce ledger protects
// retries after the first request has written its intent row; this process-local
// claim protects the smaller window before that row is visible. A second
// request is refused, never queued, because the first request may have an
// unknown commit outcome that must be reconciled before retrying.
const _activeUploadAttempts = new Set();
const UPLOAD_ATTEMPT_ID_RE = /^[a-zA-Z0-9-]{16,64}$/;

export function _requireUploadAttemptIdForTests(req, res) {
	const raw = req.body && req.body.attemptId;
	if (typeof raw !== 'string' || raw.trim().length === 0) {
		res.status(400).json({
			error: 'attempt-id-required',
			message: 'A stable upload attemptId is required so the operation can be reconciled safely.',
		});
		return null;
	}
	const attemptId = raw.trim();
	if (!UPLOAD_ATTEMPT_ID_RE.test(attemptId)) {
		res.status(400).json({
			error: 'attempt-id-invalid',
			message: 'Upload attemptId must be 16-64 letters, numbers, or hyphens.',
		});
		return null;
	}
	return attemptId;
}

const _requireUploadAttemptId = _requireUploadAttemptIdForTests;

function _rejectUploadLedgerUnavailable(res, err, mode) {
	console.warn('[two-phase unavailable/' + mode + ']:', err && (err.message || err));
	return res.status(503).json({
		error: 'upload-ledger-unavailable',
		message: 'Org Loom could not establish the encrypted upload intent. No Salesforce records were written; retry when the connection is healthy.',
	});
}

export function _claimUploadAttemptForTests(req, res, attemptId) {
	if (!attemptId) {
return true;
}
	const accountId = req.account && req.account.id ? req.account.id : 'anonymous';
	const sfUserId = req.sf && req.sf.sfUserId ? req.sf.sfUserId : 'no-sf-user';
	const key = accountId + ':' + sfUserId + ':' + attemptId;
	if (_activeUploadAttempts.has(key)) {
return false;
}
	_activeUploadAttempts.add(key);
	let released = false;
	const release = () => {
		if (released) {
return;
}
		released = true;
		_activeUploadAttempts.delete(key);
	};
	res.once('finish', release);
	res.once('close', release);
	return true;
}
const _claimUploadAttempt = _claimUploadAttemptForTests;

// Close a two-phase intent after Salesforce gave us a deterministic
// no-commit result. The terminal rewrite is the safety boundary: deleting a
// ContentDocument is merely cleanup and may be denied even when the user can
// append ContentVersions. If the rewrite fails, deletion is still a safe
// fallback because the caller has already established that no business
// record committed. Only a failure of both operations leaves a stale pending
// row, and that is logged instead of being silently swallowed.
export async function _settleKnownNoCommitForTests(store, batchId, details = {}) {
	if (!store || !batchId) {
		return { settled: true, method: 'none' };
	}
	let terminal = false;
	try {
		await store.markFailed(batchId, details);
		terminal = true;
	} catch (rewriteErr) {
		console.warn('[upload-ledger] failed to mark known rollback terminal:', rewriteErr && (rewriteErr.message || rewriteErr));
	}
	try {
		await store.remove(batchId);
		return { settled: true, method: 'removed' };
	} catch (removeErr) {
		if (!terminal) {
			console.warn('[upload-ledger] failed to remove known rollback intent:', removeErr && (removeErr.message || removeErr));
			return { settled: false, method: 'pending' };
		}
		// The retained row is status='failed', so retry remains safe. File
		// deletion is cleanup only and must not turn a known rollback into an
		// ambiguous outcome.
		console.warn('[upload-ledger] terminal rollback retained because file cleanup failed:', removeErr && (removeErr.message || removeErr));
		return { settled: true, method: 'failed-row' };
	}
}

const _settleKnownNoCommit = _settleKnownNoCommitForTests;
export function _countCommittedMutationsForTests(results) {
	return (Array.isArray(results) ? results : []).filter((result) =>
		result && result.success && result.mode !== 'unchanged' && result.id,
	).length;
}
const _countCommittedMutations = _countCommittedMutationsForTests;
const UPLOAD_ATTEMPT_UNCERTAIN_MESSAGE =
	'Org Loom could not confirm whether Salesforce saved the previous attempt. To prevent duplicate records, this retry was paused. Check Upload History and Salesforce, then make the canvas match what was saved before starting a new upload.';
export function _resetUploadAttemptClaimsForTests() {
	_activeUploadAttempts.clear();
}


// Derive structural-only metadata about a canvas payload (counts and
// object names, never field values) for audit enrichment. The audit
// row lives in the customer's SF org, so it's safe to include object
// names (already visible to admins running SOQL); we still avoid
// surfacing the actual record values stored in cards/drafts.
function _summarizeCanvasPayload(payload) {
	if (!payload || typeof payload !== 'object') {
		return { cardCount: 0, draftCount: 0, objectCounts: {} };
	}
	const loaded = Array.isArray(payload.loadedRecords) ? payload.loadedRecords : [];
	const drafts = Array.isArray(payload.drafts) ? payload.drafts : [];
	const objectCounts = {};
	for (const r of loaded.concat(drafts)) {
		const obj = r && r.objectName;
		if (!obj) {
			continue;
		}
		objectCounts[obj] = (objectCounts[obj] || 0) + 1;
	}
	const associations = Array.isArray(payload.associations) ? payload.associations.length : 0;
	const summary = {
		cardCount: loaded.length,
		draftCount: drafts.length,
		objectCounts,
	};
	if (associations) {
		summary.associationCount = associations;
	}
	return summary;
}

// Find an active canvas-share grant for the requesting user. Queries
// the canvas_role_grants table by (sfOrgId, canvasId, recipientSfUserId)
// since direct-share is the only share path now, and it writes that row
// at share time. Returns a session-grant-shaped object so the old
// call sites don't need to change shape. expiresAt is Infinity
// because direct shares don't auto-expire (the SF-side
// ContentDocumentLink is the source of truth; revoke = delete the
// link).
//
// Pre-migration this was a synchronous session lookup of
// req.session.canvasShareGrants; call sites are inside async
// handlers, so awaiting the DB query here is benign.
async function _findCanvasShareGrant(req, canvasId) {
	if (!req.sf || !req.sf.sfUserId || !req.sf.sfOrgId) {
return null;
}
	try {
		const grant = await canvasRoleGrantsDb.get({
			sfOrgId: req.sf.sfOrgId,
			canvasId,
			recipientSfUserId: req.sf.sfUserId,
		});
		if (!grant) {
return null;
}
		return {
			canvasId,
			role: grant.role,
			recipientSfUserId: req.sf.sfUserId,
			expiresAt: Infinity,
		};
	} catch (e) {
		console.warn('[canvas-share] role-grant lookup failed:', e.message || e);
		return null;
	}
}

// Remove the SF-side share grant(s) for a single recipient on a canvas.
// store.removeShare takes the *share row id* (ContentDocumentLink.Id),
// not the recipient's SF user id, so we list the shares, match by
// entityId, and destroy each matching row. Returns the count removed.
// Best-effort by contract: callers decide whether a failure is fatal.
async function _removeSfShareForRecipient(store, canvasId, recipientSfUserId) {
	if (!recipientSfUserId || typeof store.listShares !== 'function' || typeof store.removeShare !== 'function') {
		return 0;
	}
	const listed = await store.listShares(canvasId);
	const rows = Array.isArray(listed) ? listed : (listed && Array.isArray(listed.shares) ? listed.shares : []);
	const matching = rows.filter((r) => r && r.entityId === recipientSfUserId);
	let removed = 0;
	for (const row of matching) {
		await store.removeShare(canvasId, row.id);
		removed += 1;
	}
	return removed;
}

// Helper: route requires an active SF connection. Returns the resolved
// connection bundle to the handler via req.sf, or 401/409 with a
// discriminated error code so the client can route to the right
// recovery (sign-in vs. re-auth-this-connection).
async function requireSfConnection(req, res, next) {
	try {
		// If an upstream layer already resolved the active connection, trust
		// it and skip re-resolution. Inert in production (nothing populates
		// req.sf before this guard); lets tests/composed middleware inject a
		// pre-resolved bundle.
		if (req.sf && req.sf.conn) {
			return next();
		}
		const bundle = await getActiveSfConnection(req);
		if (!bundle) {
			// Three failure modes collapsed into one shape; the client
			// renders "connect a Salesforce org" for each. Slice 4
			// item 5b will refine this when re-auth specificity matters.
			return res.status(409).json({
				error: 'no-active-connection',
				message: 'Connect or activate a Salesforce org to continue.',
			});
		}
		// Salesforce cannot notify Org Loom when an admin revokes the managed
		// permission set from an already-connected user. Recheck immediately
		// before any non-safe Salesforce request so an open canvas cannot keep
		// uploading or saving under a stale onboarding decision. GET/HEAD reads
		// rely on the full-page check in the hosted server, avoiding a setup SOQL
		// query for every object/field fetch during normal canvas startup.
		if (ext.saasMounted && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
			try {
				const assigned = await hasAssignedOrgloomPermissionSet(bundle.conn, bundle.sfUserId);
				if (!assigned) {
					return res.status(403).json({
						error: 'orgloom-permission-set-required',
						message: 'Ask a Salesforce admin to assign Org Loom User or Org Loom Admin before continuing.',
						redirect: '/permset-required',
					});
				}
			} catch (error) {
				console.warn('[canvas-permset] API verification errored:', error?.message || error);
				if (isSalesforceSessionExpiredError(error)) {
					const connectionId = req.session && req.session.currentConnectionId;
					dropRefreshToken(req.session && req.session.id, connectionId);
					if (req.session) {
						delete req.session.sfAuth;
						if (connectionId && req.session.sfAuthByConnection) {
							delete req.session.sfAuthByConnection[connectionId];
						}
					}
					return res.status(401).json({
						error: 'sf-session-expired',
						message: 'Your Salesforce session has expired. Reconnect Salesforce and try again.',
					});
				}
				return res.status(503).json({
					error: 'orgloom-permission-set-check-failed',
					message: 'Org Loom could not verify the required Salesforce permission set. Retry the connection.',
				});
			}
		}
		req.sf = bundle;
		next();
	} catch (err) {
 next(err); 
}
}

// Skip the SF-connection check when the request is targeting a draft
// canvas: drafts are browser-only state, no SF round-trip, so an
// active connection isn't needed. Keeps the rest of the request flow
// (apply proposal logic etc.) reachable for users who haven't
// connected SF yet but are sketching a canvas locally.
async function requireSfConnectionUnlessDraft(req, res, next) {
	const id = req.params && req.params.id;
	if (id && /^draft-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
		return next();
	}
	return requireSfConnection(req, res, next);
}

// ---------- self-host setup wizard helpers ----------------------------

let _envWriteTail = Promise.resolve();

// Write key=value pairs into .env at the repo root, preserving existing
// lines. If a key already exists, its value is updated in place. If it
// doesn't, it's appended. This intentionally edits .env (a user-owned
// file) rather than calling process.env.X = value at runtime, since Node
// caches env reads in many places, and a server restart picks up the
// new values cleanly. Only invoked from the first-boot setup wizard.
async function _writeEnvUpdates(updates) {
	// Reject CR/LF in any value: .env is line-oriented, so an embedded
	// newline would inject arbitrary additional env lines (String().trim()
	// upstream does NOT strip interior newlines). Keys are already
	// constrained by the /^[A-Z_][A-Z0-9_]*$/ match below.
	for (const [key, value] of Object.entries(updates)) {
		if (/[\r\n]/.test(String(value))) {
			throw new Error('invalid value for ' + key + ': contains a newline');
		}
	}
	const fs = await import('node:fs/promises');
	const path = await import('node:path');
	// .env sits at the repo root (process.cwd() when invoked via
	// `npm start` from the root, which is the only supported way).
	const envPath = path.resolve(process.cwd(), '.env');
	let existing = '';
	try {
 existing = await fs.readFile(envPath, 'utf8'); 
} catch (_) { /* file may not exist yet */ }
	const lines = existing.split(/\r?\n/);
	const seen = new Set();
	const encode = (value) => JSON.stringify(String(value));
	const updated = lines.map((line) => {
		const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=/);
		if (!m) {
return line;
}
		const key = m[1];
		if (!(key in updates)) {
return line;
}
		seen.add(key);
		return key + '=' + encode(updates[key]);
	});
	// Append keys that weren't in the existing file.
	for (const key of Object.keys(updates)) {
		if (seen.has(key)) {
continue;
}
		updated.push(key + '=' + encode(updates[key]));
	}
	const out = updated.join('\n').replace(/\n+$/, '') + '\n';
	await fs.writeFile(envPath, out, 'utf8');
}

// ---------- setup wizard ------------------------------------------------

// First-boot setup wizard. Exported separately from mountCanvasRoutes so
// the host bootstrap (server.js) can mount it EARLY (before any other
// app.use / app.get handlers) so the wizard's redirect middleware
// catches every unconfigured request.
//
// When canvas is running standalone (saas not mounted) AND SF_CLIENT_ID
// is unset, every request that isn't already aimed at /setup or a
// static asset gets redirected to /setup. The wizard collects the SF
// Connected App credentials, writes them to the repo root's .env file,
// and prompts the user to restart. After restart, SF_CLIENT_ID is
// populated and the gate falls through.
//
// The gate is a no-op in saas mode (ext.saasMounted=true) since the hosted
// product pre-configures SF credentials at deploy time and a setup
// wizard would be confusing/wrong there.
export function mountSetupWizard(app) {
	const _setupNeeded = () => !ext.saasMounted && !process.env.SF_CLIENT_ID;
	app.use((req, res, next) => {
		if (!_setupNeeded()) {
return next();
}
		const p = req.path;
		if (p === '/setup' || p.startsWith('/css/') || p.startsWith('/js/')
			|| p.startsWith('/img/') || p.startsWith('/vendor/')
			|| p === '/favicon.ico') {
			return next();
		}
		if (p.startsWith('/api/') || p === '/mcp/v1') {
			return res.status(503).json({ error: 'setup-required', setupUrl: '/setup' });
		}
		return res.redirect('/setup');
	});

	app.get('/setup', (req, res) => {
		if (process.env.SF_CLIENT_ID) {
return res.redirect('/');
}
		const appUrl = (process.env.APP_URL || ('http://localhost:' + (process.env.PORT || '3000'))).replace(/\/$/, '');
		res.render('setup', { appUrl, submitError: null, submitted: false });
	});

	app.post('/setup', async (req, res) => {
		const appUrl = (process.env.APP_URL || ('http://localhost:' + (process.env.PORT || '3000'))).replace(/\/$/, '');
		const body = req.body || {};
		const sfClientId = String(body.sf_client_id || '').trim();
		const sfClientSecret = String(body.sf_client_secret || '').trim();
		const anthropicKey = String(body.anthropic_api_key || '').trim();
		if (!sfClientId || !sfClientSecret) {
			return res.status(400).render('setup', {
				appUrl,
				submitError: 'Both Consumer Key and Consumer Secret are required.',
				submitted: false,
			});
		}
		// SF Consumer Keys are ~85 chars, base64-ish. Reject obviously
		// bogus inputs early: saves a confusing OAuth error 20 minutes
		// later when the user realizes they pasted the Secret as the Key.
		if (!/^[A-Za-z0-9._-]{20,200}$/.test(sfClientId)) {
			return res.status(400).render('setup', {
				appUrl,
				submitError: 'Consumer Key doesn\'t look right (got ' + sfClientId.length + ' chars; expected ~85). Double-check you copied the Consumer Key and not the Secret.',
				submitted: false,
			});
		}
		if (sfClientSecret.length > 1000 || anthropicKey.length > 1000
			|| /[\r\n]/.test(sfClientSecret) || /[\r\n]/.test(anthropicKey)) {
			return res.status(400).render('setup', {
				appUrl,
				submitError: 'Secrets must be single-line values of at most 1000 characters.',
				submitted: false,
			});
		}
		try {
			const updates = {
				SF_CLIENT_ID: sfClientId,
				SF_CLIENT_SECRET: sfClientSecret,
				SF_CALLBACK_URL: appUrl + '/auth/callback',
				...(anthropicKey ? { ANTHROPIC_API_KEY: anthropicKey } : {}),
			};
			// Serialize submissions so concurrent setup requests cannot interleave
			// read/modify/write cycles and leave a partially mixed .env file.
			const write = _envWriteTail.then(() => _writeEnvUpdates(updates));
			_envWriteTail = write.catch(() => undefined);
			await write;
		} catch (err) {
			console.error('[setup] .env write failed:', err);
			return res.status(500).render('setup', {
				appUrl,
				submitError: 'Could not write to .env: ' + (err.message || String(err)) + '. You can paste the values into .env manually and restart.',
				submitted: false,
			});
		}
		res.render('setup', { appUrl, submitError: null, submitted: true });
	});
}

// ---------- middleware --------------------------------------------------

// Resolves the signed-in account from the session and stamps it onto
// `req.account`. The session shape is:
//   req.session.accountId: the human (set on sign-in)
//   req.session.currentConnectionId: active SF credential (set on OAuth /
//                                    activate)
// Both are populated by the auth flow; this middleware is read-only.
//
// Returns 401 with a discriminated error when no account is signed in,
// so the client can route to /auth/login. Soft-deleted accounts also
// 401: they exist in the DB but can't act.
export async function requireAccount(req, res, next) {
	try {
		const account = await ext.getCurrentAccount(req);
		if (!account) {
			// Distinguish "no session" from "session pointed at a
			// missing/deleted account"; for the client's purposes the
			// response is the same (401 → route to /auth/login), but the
			// stale-session case gets a session-clear side effect so the
			// next request doesn't pay the lookup cost again.
			if (!req.session || !req.session.accountId) {
				return res.status(401).json({ error: 'not-signed-in' });
			}
			req.session.accountId = null;
			return res.status(401).json({ error: 'account-stale' });
		}
		req.account = account;
		next();
	} catch (err) {
 next(err); 
}
}

// Record workspace boundary attacks without letting an outsider pollute the
// target workspace's activity stream. A real member denied for insufficient
// role is audited in the target workspace; a non-member denial is attributed
// to the caller's current workspace (or null when they have none) while the
// attempted workspace remains the target id/payload. Authorization responses
// stay enumeration-safe and audit failure never changes the denial outcome.
async function _auditWorkspaceAccessDenied(req, attemptedWorkspaceId, errorCode, actualRole, requiredRole) {
	try {
		let auditWorkspaceId = attemptedWorkspaceId;
		if (!actualRole) {
			const view = await viewStateDb.get(req.account.id);
			auditWorkspaceId = (view && view.current_workspace_id) || null;
		}
		await ext.auditWrite({
			req,
			workspaceId: auditWorkspaceId,
			actorAccountId: req.account.id,
			action: 'workspace_access_denied',
			targetObject: 'workspaces',
			targetId: attemptedWorkspaceId,
			status: 'denied',
			errorCode,
			payload: {
				attemptedWorkspaceId,
				actualRole: actualRole || null,
				requiredRole,
			},
		});
	} catch (err) {
		try {
			ext.captureException(err, {
				where: 'workspace-access-denied-audit',
				attemptedWorkspaceId,
				errorCode,
			});
		} catch (_) {}
	}
}

// Requires the account to be a member of the target workspace AND have
// admin role. Used on workspace-admin endpoints (settings, invite,
// approve/deny, etc.). Reads workspaceId from req.params.id by default;
// pass an extractor for non-standard route shapes.
export function requireWorkspaceAdmin(extractWorkspaceId = (req) => req.params.id) {
	return async (req, res, next) => {
		try {
			const workspaceId = extractWorkspaceId(req);
			if (!workspaceId) {
				return res.status(400).json({ error: 'workspace-id-required' });
			}
			const role = await workspacesDb.findMemberRole(workspaceId, req.account.id);
			if (!role) {
				await _auditWorkspaceAccessDenied(req, workspaceId, 'not-a-member', null, 'admin');
				return res.status(403).json({ error: 'not-a-member' });
}
			if (role !== 'admin') {
				await _auditWorkspaceAccessDenied(req, workspaceId, 'admin-only', role, 'admin');
				return res.status(403).json({ error: 'admin-only' });
}
			req.workspaceId = workspaceId;
			req.workspaceRole = role;
			next();
		} catch (err) {
 next(err); 
}
	};
}

// Like requireWorkspaceAdmin but admits any member (admin OR member).
// Sets req.workspaceId + req.workspaceRole so the handler can scope
// what it returns by role (e.g. members see only their own rows).
export function requireWorkspaceMember(extractWorkspaceId = (req) => req.params.id) {
	return async (req, res, next) => {
		try {
			const workspaceId = extractWorkspaceId(req);
			if (!workspaceId) {
				return res.status(400).json({ error: 'workspace-id-required' });
			}
			const role = await workspacesDb.findMemberRole(workspaceId, req.account.id);
			if (!role) {
				await _auditWorkspaceAccessDenied(req, workspaceId, 'not-a-member', null, 'member');
				return res.status(403).json({ error: 'not-a-member' });
}
			req.workspaceId = workspaceId;
			req.workspaceRole = role;
			next();
		} catch (err) {
 next(err); 
}
	};
}

// Per-user capability gate for data-touching routes. Wraps the
// ext.getCapability call so handlers can express "this action requires
// capability X" as a one-liner instead of repeating the 8-line check.
//
// Returns true when the caller has the capability (handler should
// continue) and false when denied (the response has already been
// written, handler should `return`). The auditAction string controls
// the audit_log row written on denial. Pass a stable verb-shaped
// name like 'upload' or 'export_records' so dashboards can pivot on it.
//
// Use this AFTER requireAccount + requireSfConnection, before the route
// does any side-effecting work.
async function _gateCapability(req, res, capability, auditAction, opts = {}) {
	const cap = await ext.getCapability(req.account, capability, {
		req,
		auditAction: auditAction + '_denied',
		auditPayload: opts.auditPayload || undefined,
		...(opts.extra || {}),
	});
	if (!cap.allowed) {
		res.status(403).json({
			error: cap.reason || 'permission-denied',
			capability,
			approvalStatus: cap.approvalStatus,
			message: (opts.messages && opts.messages[cap.reason])
				|| opts.message
				|| `You don't have permission to ${auditAction.replace(/_/g, ' ')}. Ask a workspace admin to grant the '${capability}' permission.`,
		});
		return false;
	}
	return true;
}

// Records a denied audit when a caller touches a connection that exists
// but belongs to ANOTHER account (the routes still return 404 so the
// caller can't tell "exists but not yours" from "doesn't exist", but the
// attempt is logged under the caller's workspace so ops can spot abuse).
async function _auditCrossAccountConnAccess(req, attemptedConnectionId, ownerAccountId, route) {
	try {
		const view = await viewStateDb.get(req.account.id);
		await ext.auditWrite({
			req,
			workspaceId: (view && view.current_workspace_id) || null,
			action: 'connection_access_denied',
			targetObject: 'connections',
			targetId: attemptedConnectionId,
			status: 'denied',
			errorCode: 'cross-account-connection-access',
			payload: { attemptedConnectionId, ownerAccountId, route },
		});
	} catch (e) {
 console.warn('[audit] cross-account conn access failed:', e && e.message);
}
}

// Audit a successful connection activation (switching the active SF
// credential). Switching the active connection changes which org every
// subsequent write targets, so it's forensically load-bearing:
// reconstructing "why did that upload land in prod" needs it. Mirrors
// connection_disconnected's shape. `mode` distinguishes an in-session
// token flip from re-pointing the already-active identity. Workspace
// attribution is left to the audit sink (derives current workspace).
// Best-effort: activation must not fail on an audit write.
async function _auditConnectionActivated(req, c, mode) {
	try {
		await ext.auditWrite({
			req,
			actorConnectionId: c.id,
			action: 'connection_activated',
			targetObject: 'connections',
			targetId: c.id,
			targetSfOrgId: c.sf_org_id,
			payload: {
				instanceUrl: c.instance_url,
				sfUserId: c.sf_user_id,
				displayUsername: c.display_username,
				mode,
			},
		});
	} catch (e) {
		console.warn('[audit] connection_activated failed:', e && e.message);
	}
}

// ---------- mount -------------------------------------------------------

// Build a recall-ledger entry from one upload result + the input
// record. For UPDATE records carrying a loadedValues snapshot, also
// compute the per-field diff and persist priorValues (SF baseline
// pre-upload) + uploadedValues (what we actually wrote). Recall
// then has enough metadata to PATCH each field back to its prior
// state, with drift detection by comparing SF-current to
// uploadedValues. INSERT records get no values, so recall on those
// remains the existing "delete the SF record" semantics.
//
// Backwards-compat: when rec.loadedValues is missing (older clients,
// or non-canvas upload paths that don't send a baseline), the values
// fields are simply omitted and recall falls back to delete-only.
// SF object + field name shape used to defend the post-upload re-query
// SOQL against object/field names that snuck through earlier validation.
// Same regex shape upload-recall.js uses for the drift probe.
const _SF_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_.]*$/;

// Position-preserving mask of a SOQL string: every character inside a
// single-quoted string literal, OR inside any parenthesized group
// (subqueries / function args), is replaced with a space, and the quotes
// and parens themselves are spaced out too. The result is the SAME length
// as the input, so a structural-regex match index maps 1:1 back to the
// original string. That lets /api/query detect and rewrite the OUTER LIMIT
// in place without disturbing inner-subquery LIMITs, and prevents a WHERE
// value like '%LIMIT 5%' from masquerading as the outer LIMIT and
// suppressing the safety cap append (IR-014).
function _maskSoqlSkeleton(soql) {
	const out = String(soql).split('');
	const n = out.length;
	// 1) Mask single-quoted string literals (backslash escapes respected).
	let i = 0;
	let inStr = false;
	while (i < n) {
		const c = out[i];
		if (!inStr) {
			if (c === "'") {
				inStr = true;
				out[i] = ' ';
			}
			i++;
			continue;
		}
		if (c === '\\') {
			out[i] = ' ';
			if (i + 1 < n) {
				out[i + 1] = ' ';
			}
			i += 2;
			continue;
		}
		if (c === "'") {
			inStr = false;
		}
		out[i] = ' ';
		i++;
	}
	// 2) Mask everything nested inside parentheses (depth >= 1) plus the
	//    parens themselves. Operates on the already string-masked array so
	//    quotes inside literals can't throw off the paren depth count.
	let depth = 0;
	for (let j = 0; j < n; j++) {
		const c = out[j];
		if (c === '(') {
			depth++;
			out[j] = ' ';
			continue;
		}
		if (c === ')') {
			if (depth > 0) {
				depth--;
			}
			out[j] = ' ';
			continue;
		}
		if (depth > 0) {
			out[j] = ' ';
		}
	}
	return out.join('');
}

// Single source of truth for objects the record-reading endpoints refuse to
// touch: code, metadata, and security/setup objects the data API exposes but
// that aren't business records. Shared by /api/query, /api/browse, and
// /api/migrate/match so the block is byte-identical everywhere. Match is on the
// outer FROM object; child subqueries are checked against this same set.
//
// User is intentionally NOT here: it's a legitimate object to read/browse.
// Profile IS denied (no useful canvas-editable fields, and it leaks security
// config). The object pickers apply a separate noise+createable filter
// (sf-describe.isNoiseSObject) that already hides most of these from the UI;
// this list is the hard read-time block that holds even for a typed/raw name.
const SOQL_OBJECT_DENYLIST = new Set([
	// Code / metadata (IR-013).
	'apexclass', 'apextrigger', 'apexcomponent', 'apexpage',
	'apexlog', 'apextestresult', 'apexcodecoverage', 'apexcodecoverageaggregate',
	'apextestqueueitem', 'apexemailnotification', 'apexpageinfo',
	'staticresource', 'entitydefinition', 'fielddefinition', 'flowdefinitionview',
	// Security / identity / auth / setup (IR-015).
	'userlogin', 'profile', 'permissionset', 'permissionsetassignment',
	'permissionsetgroup', 'permissionsetlicense', 'permissionsetlicenseassign',
	'objectpermissions', 'fieldpermissions', 'setupentityaccess',
	'organization', 'authsession', 'authconfig', 'authconfigproviders',
	'authprovider', 'oauthtoken', 'connectedapplication', 'samlssoconfig',
	'loginhistory', 'loginip', 'logingeo', 'sessionpermsetactivation',
	'setupaudittrail', 'apianomalyeventstore', 'credentialstuffingeventstore',
]);

// Sliding-window rate limit for the Salesforce-read endpoints (/api/query,
// /api/browse, /api/migrate/match), keyed by account. Each of those can drive
// a SOQL query plus a Collections retrieve fan-out, so a scripted loop could
// otherwise drain the org's daily API quota or spike server memory. 60/min is
// generous for interactive use (a human won't preview/browse 60x a minute) but
// tight enough to stop a runaway loop. Per-process: a coarse backstop, not a
// billing-grade global limiter (see rate-limit.js); a multi-instance tier will
// swap the store without changing this call site.
export const SF_READ_RATE_LIMIT = { windowMs: 60_000, max: 60 };
const _sfReadLimiter = makeLimiter(SF_READ_RATE_LIMIT);
function _rateLimitSfReads(req, res, next) {
	const key = (req.account && req.account.id) || req.ip || 'anon';
	if (!_sfReadLimiter.take(key)) {
		res.set('Retry-After', String(Math.ceil(SF_READ_RATE_LIMIT.windowMs / 1000)));
		return res.status(429).json({
			error: 'rate-limited',
			message: 'Too many Salesforce read requests in a short window. Wait a minute and try again.',
		});
	}
	next();
}

// Test hook: clear the SF-read limiter between cases. Not used in production.
export function _resetSfReadRateLimitForTests() {
	_sfReadLimiter.reset();
}

// Post-upload re-query. After SF accepts the upload, we SOQL-select the
// committed records to get back the canonical post-trigger field
// values. Used for two things:
//
//   1. Batch ledger: uploadedValues stores what SF ACTUALLY HAS after
//      triggers, workflows, formula recomputes, etc., not what we
//      wrote. Without this, drift detection in recall mis-classifies
//      every trigger-transformed field as "drifted" and demands user
//      confirmation for benign trigger work.
//   2. Client canvas state: returned to the client so it can patch
//      rec.values + rec.loadedValues to match SF. The canvas then
//      shows the post-trigger truth, and subsequent edits compute the
//      modified badge against the post-trigger baseline.
//
// Returns a Map: tempId → { sfId, objectName, values } where `values`
// is the canonical post-trigger field map. Records that fail the
// SOQL probe (perm error, deleted-out-of-band, etc.) are simply
// missing from the returned map; callers fall back to using what
// the client sent, preserving the legacy behavior.
//
// Performance: one SOQL per object type, batched at 200 ids. Negligible
// against the upload cost itself.
// Exported for unit testing. Not part of the public route API; tests
// in packages/canvas/tests/post-upload-requery.test.js consume these
// directly because the upload-route end-to-end paths would require
// standing up the full DB + ext infrastructure.
export async function _fetchCanonicalValuesForUpload({ conn, results, recordsById }) {
	const out = new Map();
	if (!conn || !Array.isArray(results) || results.length === 0) {
return out;
}
	// Group by object name. For each object, the SELECT list is the
	// union of all "interesting" field names across the records of
	// that object: what we WROTE plus (for updates) what we had as
	// the baseline. Trigger transforms might touch a field we wrote
	// OR a field we didn't write, so the union catches both.
	const byObject = new Map();
	for (const r of results) {
		if (!r || !r.success || !r.id || !r.objectName) {
continue;
}
		if (r.mode === 'unchanged') {
continue;
}
		const rec = recordsById.get(r.tempId);
		if (!rec) {
continue;
}
		const objName = r.objectName;
		if (!_SF_NAME_RE.test(objName)) {
continue;
}
		if (!byObject.has(objName)) {
			byObject.set(objName, { rows: [], fields: new Set() });
		}
		const entry = byObject.get(objName);
		entry.rows.push({ tempId: r.tempId, sfId: r.id });
		if (rec.values && typeof rec.values === 'object') {
			for (const k of Object.keys(rec.values)) {
				if (k && !k.startsWith('_') && _SF_NAME_RE.test(k)) {
entry.fields.add(k);
}
			}
		}
		if (rec.loadedValues && typeof rec.loadedValues === 'object') {
			for (const k of Object.keys(rec.loadedValues)) {
				if (k && !k.startsWith('_') && _SF_NAME_RE.test(k)) {
entry.fields.add(k);
}
			}
		}
	}
	for (const [objName, entry] of byObject) {
		if (entry.fields.size === 0) {
continue;
}
		const fieldList = ['Id', ...Array.from(entry.fields)].join(', ');
		const ids = entry.rows.map((r) => r.sfId);
		// jsforce echoes 18-char ids; index canonical-values by both
		// the 15-char prefix AND the full id so callers' `Map.get(id)`
		// works regardless of which form was stored.
		for (let i = 0; i < ids.length; i += 200) {
			const slice = ids.slice(i, i + 200);
			const inList = slice.map((id) => "'" + escapeSoqlLiteral(id) + "'").join(',');
			const soql = 'SELECT ' + fieldList + ' FROM ' + objName +
				' WHERE Id IN (' + inList + ')';
			try {
				const result = await conn.query(soql);
				const records = result.records || [];
				const sfById = new Map();
				for (const sfRec of records) {
					if (!sfRec || !sfRec.Id) {
continue;
}
					sfById.set(String(sfRec.Id).slice(0, 15), sfRec);
					sfById.set(sfRec.Id, sfRec);
				}
				for (const row of entry.rows.slice(i, i + 200)) {
					const sfRec = sfById.get(row.sfId) || sfById.get(String(row.sfId).slice(0, 15));
					if (!sfRec) {
continue;
}
					// Strip jsforce's "attributes" wrapper and the Id itself
					// (we already have it on the row entry). What's left
					// is the canonical field map.
					const canonical = {};
					for (const k of Object.keys(sfRec)) {
						if (k === 'attributes' || k === 'Id') {
continue;
}
						canonical[k] = sfRec[k];
					}
					out.set(row.tempId, {
						sfId: row.sfId,
						objectName: objName,
						values: canonical,
					});
				}
			} catch (e) {
				// Object query failed: leave those tempIds without a
				// canonical-values entry. Callers fall back to using
				// what the client sent.
			}
		}
	}
	return out;
}

// Order pending-delete entries children-first so Salesforce never sees a
// parent DELETE while a to-be-deleted child still references it (restrict
// lookups reject; master-detail cascade-deletes the child, making its own
// DELETE fail with "already deleted"). Reuses planDeleteOrder from the
// recall module: same problem, same leaves-first answer. Upload
// associations use fromId/toId (child references parent); planDeleteOrder
// expects fromTempId/toTempId. Best-effort: entries the planner can't
// place (missing tempId/sfId) run last in their original order, and
// unlinked entries keep their relative order, never worse than today's
// receive-order behavior.
//
// Exported for unit testing.
export function _orderDeletesChildrenFirst(deletesIn, associations) {
	if (!Array.isArray(deletesIn) || deletesIn.length <= 1) {
		return Array.isArray(deletesIn) ? deletesIn : [];
	}
	const plannable = deletesIn.filter((d) => d && d.tempId != null && d.sfId);
	const unplannable = deletesIn.filter((d) => !(d && d.tempId != null && d.sfId));
	// Only edges where BOTH endpoints are being deleted constrain the
	// order: an edge to a record that stays in SF says nothing about
	// which of the deleted records must go first.
	const deletingIds = new Set(plannable.map((d) => d.tempId));
	const assoc = (associations || [])
		.filter((a) => a && deletingIds.has(a.fromId) && deletingIds.has(a.toId))
		.map((a) => ({ fromTempId: a.fromId, toTempId: a.toId }));
	const levels = planDeleteOrder(plannable, assoc);
	const ordered = [];
	for (const level of levels) {
		for (const row of level) {
			ordered.push(row);
		}
	}
	return ordered.concat(unplannable);
}

// Exported for unit testing; see _fetchCanonicalValuesForUpload.
export function _buildBatchEntryFromResult(r, rec, canonical) {
	const entry = {
		tempId: r.tempId,
		sfId: r.id,
		objectName: r.objectName,
		mode: r.mode || 'create',
		label: rec && rec.label ? rec.label : null,
	};
	if (entry.mode === 'update' && rec && rec.values && rec.loadedValues) {
		const priorValues = {};
		const uploadedValues = {};
		const canonicalValues = canonical && canonical.values ? canonical.values : null;
		for (const k of Object.keys(rec.values)) {
			if (!k || k.startsWith('_')) {
continue;
}
			const cur = rec.values[k];
			const prior = rec.loadedValues[k];
			// SF field values are scalars (strings, numbers, booleans,
			// null). Identity-equal would miss type coercions; loose
			// equality covers the JSON round-trip ("5" vs 5 etc.).
			// Records where cur and prior compare equal didn't actually
			// change for this upload, so skip them.
			 
			if (cur == prior) {
continue;
}
			priorValues[k] = prior == null ? null : prior;
			// Prefer the canonical post-trigger value when we have it.
			// Falls back to what we wrote when the post-upload re-query
			// failed (perm error, deleted-out-of-band, etc.) so
			// uploadedValues is never empty for a field we changed.
			// Trigger transformations land here transparently;
			// uploadedValues records what SF actually stored, which is
			// exactly what drift detection compares against.
			uploadedValues[k] = canonicalValues && k in canonicalValues
				? canonicalValues[k]
				: cur;
		}
		if (Object.keys(uploadedValues).length > 0) {
			entry.priorValues = priorValues;
			entry.uploadedValues = uploadedValues;
		}
	}
	return entry;
}

export function mountCanvasRoutes(app, options = {}) {
	// Hosted SaaS injects the registry it already configured at boot. This
	// avoids Windows workspace-junction ESM identity splits. Standalone
	// canvas callers omit the option and keep the permissive defaults.
	if (options.ext) {
		ext = options.ext;
	}

	// POST /api/workspaces/:id/leave
	// Self-leave. Removes the requester's own membership from the
	// workspace, with three guards:

	// ===== Canvas CRUD =================================================
	//
	// Saved canvases live in the user's Salesforce org as JSON files
	// (ContentVersion). The store layer owns the SF mechanics; the
	// route layer just owns the auth/policy gating + payload shaping.
	//
	// Workspace scoping note: the legacy listing partitioned canvases
	// by their owner's bound_team_id (immutable workspace stamp on the
	// connection at OAuth time). Post-rewrite there is no bound_team_id
	// since connections are account-owned and roam across workspaces with
	// the user's view. So the listing now returns every canvas the
	// active SF connection can read; cross-workspace partitioning, if
	// it returns, comes from a per-canvas workspace tag (custom object
	// field) rather than from the credential row.
	//
	// Slot-canvas authoring (POST/PUT with slot markers) is gated via
	// hasCapability('create-slot-canvas') in 5b; for now create/update
	// are open to any signed-in user with an active connection.

	// GET /api/canvas: list canvases visible to the active SF user.
	app.get('/api/canvas', requireAccount, requireSfConnection, async (req, res, next) => {
		try {
			const store = await canvasStoreFromSfConnection(req.sf.conn, req.sf.sfUserId, req.sf.sfOrgId, { sessionId: req.session && req.session.id });
			const result = await store.list();
			res.json(result);
		} catch (err) {
 next(err); 
}
	});

	// GET /api/canvas/:id: load a single canvas. Owners get the full
	// payload; non-owners get drafts stripped. Recipient flow (magic-
	// link share grant) lands in 5b.
	app.get('/api/canvas/:id', requireAccount, requireSfConnection, async (req, res, next) => {
		try {
			const id = req.params.id;
			if (!/^[a-zA-Z0-9]{15,18}$/.test(id)) {
				return res.status(400).json({ error: 'invalid-id' });
			}
			const store = await canvasStoreFromSfConnection(req.sf.conn, req.sf.sfUserId, req.sf.sfOrgId, { sessionId: req.session && req.session.id });
			const item = await store.get(id);
			if (!item) {
return res.status(404).json({ error: 'not-found' });
}
			// Gate the owner-load path with open-saved-canvas. Shared-
			// canvas recipients fall through to the receive-canvas
			// branch below (separate cap, asymmetric rules).
			if (item.ownedByMe) {
				if (!await _gateCapability(req, res, 'open-saved-canvas', 'open_saved_canvas', { auditPayload: { canvasId: id } })) {
return;
}
			}

			// Direct Viewer shares are a free recipient entitlement. They
			// require both Salesforce read access (proved by store.get above)
			// and an exact role row for this org + canvas + SF user. The URL
			// alone grants nothing. Contributor and Editor are product-use
			// roles, so they still require the recipient's own active trial,
			// subscription, or Team seat. A Salesforce share with no role row
			// also stays plan-gated; never infer a free entitlement from a
			// permissive or stale ContentDocumentLink alone.
			let grant = null;
			if (!item.ownedByMe) {
				grant = await _findCanvasShareGrant(req, id);
				if (recipientRequiresPlan(grant)) {
					const cap = await ext.getCapability(req.account, 'receive-canvas', {
						req,
						auditAction: 'canvas_receive_denied',
						auditPayload: { canvasId: id, ownerSfUserId: item.ownerId },
					});
					if (!cap.allowed) {
						return res.status(402).json({
							error: cap.reason || 'upgrade-required',
							message: 'Contributor and Editor access requires an active Pro trial, Pro subscription, or Team seat. If your trial is unused, open Your workspace to start it. Otherwise, upgrade or ask the owner to share this canvas as Viewer.',
							required: cap.required,
							currentPlan: cap.plan,
						});
					}
				}
			}

			const payload = item.ownedByMe ? item.payload : stripDraftsForNonOwner(item.payload);
			// Surface the direct-share role so the client can render the
			// right recipient mode (viewer = read-only, contributor =
			// slot-fill, editor = full authoring). When no role row exists,
			// fall back to viewer (read-only) - the recipient still has
			// SF read access via the ContentDocumentLink that put the
			// canvas in their Saved Canvases, but that fallback does not
			// receive the free-Viewer plan bypass above.
			let recipientRole = null;
			let recipientHasAccount = false;
			if (!item.ownedByMe) {
				if (grant) {
					recipientRole = grant.role || 'viewer';
				} else {
					recipientRole = 'viewer';
				}
				// Drives the "← Back to your workspace" affordance. Any
				// signed-in Org Loom account has at least a personal
				// workspace to return to.
				recipientHasAccount = !!req.session.accountId;
			}

			// Stale-ref probe. Canvases reference SF records via
			// loadedFromId. Those records can disappear between save and
			// next load (user recall, teammate manual delete, SF workflow
			// purge, etc.) - without this probe, the canvas opens with
			// stale references that look fine until the user tries to
			// save and SF errors with INVALID_CROSS_REFERENCE_KEY. The
			// probe runs one SOQL per distinct object type, gathers the
			// set of live (non-deleted) ids, and flags every loadedFromId
			// that's missing. Returned as a top-level staleRefs array so
			// the client can render badges on affected cards without
			// mutating the payload (payload format stays stable across
			// shape evolutions - staleRefs is purely a derived view).
			//
			// Best-effort: if the probe fails entirely (no perm to read
			// the object, network blip, etc.), the response just omits
			// staleRefs and the canvas opens normally. Better to load
			// without stale-detection than to block the load on a probe
			// failure.
			let staleRefs = [];
			try {
				const loadedRecs = recordsToShareFromManifest(payload);
				if (loadedRecs.length > 0) {
					const byObject = new Map();
					for (const r of loadedRecs) {
						if (!byObject.has(r.objectName)) {
byObject.set(r.objectName, new Set());
}
						byObject.get(r.objectName).add(r.recordId);
					}
					const apiVersion = req.sf.conn.version || '60.0';
					const _STALE_OBJ_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;
					for (const [objName, idSet] of byObject) {
						// objectName comes from the saved manifest (canvas payload),
						// which a hostile recipient could craft. Skip anything that
						// isn't a valid SObject name before interpolating it raw.
						if (!_STALE_OBJ_NAME_RE.test(objName)) {
continue;
}
						const ids = Array.from(idSet);
						const liveIds = new Set();
						const idKey = (i) => (i ? String(i).slice(0, 15) : '');
						for (let i = 0; i < ids.length; i += 200) {
							const slice = ids.slice(i, i + 200);
							const inList = slice.map((id) => "'" + escapeSoqlLiteral(id) + "'").join(',');
							// Plain query (not queryAll) is intentional -
							// soft-deleted records (IsDeleted=true, still in
							// Recycle Bin) are also "stale" from the canvas's
							// perspective: edits can't be saved against them.
							// Plain query excludes them, so they land in the
							// stale bucket.
							const soql = 'SELECT Id FROM ' + objName + ' WHERE Id IN (' + inList + ')';
							try {
								const url = '/services/data/v' + apiVersion + '/query/?q=' + encodeURIComponent(soql);
								const r = await req.sf.conn.request({ method: 'GET', url });
								(r.records || []).forEach((rec) => liveIds.add(idKey(rec.Id)));
							} catch (e) {
								// Probe failure for this object - leave its
								// records OUT of the stale list (conservative:
								// no false-stale flags when we couldn't even
								// check). Log so admins can spot perm gaps.
								console.warn('[canvas-load] stale-ref probe failed for', objName + ':', (e && e.message) || String(e));
								slice.forEach((id) => liveIds.add(idKey(id))); // treat as live
							}
						}
						for (const id of ids) {
							if (!liveIds.has(idKey(id))) {
								staleRefs.push({ sfId: id, objectName: objName });
							}
						}
					}
				}
				// Classify each stale ref: deleted vs. no-access vs.
				// unknown. The Id-IN query above only tells us a record
				// is "missing from the live set" - it can't tell us
				// WHY. A second per-record probe via the sobject GET
				// endpoint distinguishes the cases:
				//   - 404 / NOT_FOUND / INVALID_CROSS_REFERENCE_KEY
				//       → record purged from SF (true deletion).
				//   - 403 / INSUFFICIENT_ACCESS
				//       → record exists but THIS user lacks read perm.
				//       Critical for multi-user canvases: the record
				//       isn't gone, the current viewer just can't see
				//       it. Mislabeling this as "deleted" misleads users
				//       into removing valid records from the canvas.
				//   - anything else → 'unknown' (network blip, perm
				//       error on the probe itself, etc.). Client renders
				//       this conservatively as an unavailable indicator
				//       rather than asserting deletion.
				// Probes run in parallel - at typical canvas sizes
				// (1-3 stale refs out of dozens) this adds <300 ms to
				// load. Heavy fan-out is capped at 50 parallel probes
				// to stay polite with SF's per-org concurrency budget.
				if (staleRefs.length > 0) {
					const apiVersion = req.sf.conn.version || '60.0';
					// The canvas owner is the only user for whom 404
					// reliably means "deleted." Non-owners (share-link
					// guests, workspace members opening a canvas saved
					// by someone else) get 404 even for records that
					// exist but are filtered out by SF sharing rules -
					// labeling those as "deleted" would mislead them
					// into removing references that are valid for the
					// owner. So for non-owners, treat every probe
					// failure as 'no-access'. The "deleted in SF" UX
					// (with Convert/Remove/Dismiss fix actions) is
					// owner-only by construction.
					const _ownerCanDistinguishDeletion = !!item.ownedByMe;
					const _classify = async (ref) => {
						try {
							const url = '/services/data/v' + apiVersion
								+ '/sobjects/' + encodeURIComponent(ref.objectName)
								+ '/' + encodeURIComponent(ref.sfId);
							await req.sf.conn.request({ method: 'GET', url });
							// 2xx means the record IS accessible - race
							// with the initial query (e.g., soft-delete
							// was just restored, or sharing rule landed
							// between the two probes). Treat as live by
							// returning a sentinel the caller filters out.
							return null;
						} catch (e) {
							// jsforce wraps SF REST errors in several
							// possible shapes depending on which error
							// path triggered. Pull errorCode + status
							// from every known location so the
							// classification holds across them.
							const codes = [];
							const codeFrom = (v) => {
								if (typeof v === 'string') {
codes.push(v);
} else if (v && typeof v === 'object' && typeof v.errorCode === 'string') {
codes.push(v.errorCode);
}
							};
							codeFrom(e && e.errorCode);
							codeFrom(e && e.name);
							if (Array.isArray(e && e.body)) {
e.body.forEach(codeFrom);
}
							if (e && e.body && typeof e.body === 'object') {
codeFrom(e.body);
}
							const status = (e && (e.statusCode || e.status)) || 0;
							const has = (c) => codes.indexOf(c) >= 0;
							if (has('INSUFFICIENT_ACCESS')
								|| has('INSUFFICIENT_ACCESS_OR_READONLY')
								|| has('INVALID_FIELD_FOR_INSERT_UPDATE')
								|| status === 403) {
								return 'no-access';
							}
							if (has('NOT_FOUND')
								|| has('INVALID_CROSS_REFERENCE_KEY')
								|| has('ENTITY_IS_DELETED')
								|| has('MALFORMED_ID')
								|| status === 404) {
								// 404 for a non-owner is almost always
								// a sharing-rule filter, not real
								// deletion - SF returns 404 for records
								// the requesting user can't see. Only
								// the owner is reasonably positioned to
								// interpret 404 as deletion (they once
								// had access, the record is now gone).
								return _ownerCanDistinguishDeletion ? 'deleted' : 'no-access';
							}
							console.warn('[stale-classify] unrecognized error shape for', ref.objectName, ref.sfId, '- status:', status, 'codes:', codes, 'message:', (e && e.message) || String(e));
							return 'unknown';
						}
					};
					const BATCH = 50;
					const refined = [];
					for (let i = 0; i < staleRefs.length; i += BATCH) {
						const slice = staleRefs.slice(i, i + BATCH);
						const reasons = await Promise.all(slice.map(_classify));
						for (let j = 0; j < slice.length; j++) {
							const reason = reasons[j];
							if (reason === null) {
continue;
} // probe contradicts initial query - drop
							refined.push(Object.assign({}, slice[j], { reason }));
						}
					}
					staleRefs = refined;
				}
			} catch (_eProbe) { /* best-effort */ }

			// Mirror to the MCP-read cache when the workspace has opted
			// in. Caches whatever the user is seeing (the FLS-respecting
			// `payload` variable above - drafts stripped for non-owners),
			// so AI access from a workspace inherits the same visibility
			// boundary the human has. Best-effort; never blocks the
			// response.
			res.json({
				id: item.id,
				// The optimistic-concurrency token the client echoes back on
				// the next in-place save (PUT expectedVersionId). Without it
				// here, a canvas opened via load has no version token, so its
				// save skips the conflict check and silently last-write-wins
				// over a concurrent edit - the exact load-then-edit race the
				// lock exists to catch.
				versionId: item.versionId,
				title: item.title,
				ownerId: item.ownerId,
				ownedByMe: item.ownedByMe,
				createdAt: item.createdAt,
				updatedAt: item.updatedAt,
				payload,
				recipientRole,
				recipientHasAccount,
				staleRefs,
			});
		} catch (err) {
 next(err); 
}
	});

	// POST /api/canvas - create a new canvas. Body: { name, payload }.
	app.post('/api/canvas', requireAccount, requireSfConnection, async (req, res, next) => {
		try {
			if (!await _gateCapability(req, res, 'save-canvas', 'save_canvas')) {
return;
}
			const name = String((req.body && req.body.name) || '').trim();
			const payload = req.body && req.body.payload;
			if (!name) {
return res.status(400).json({ error: 'name-required' });
}
			if (!payload || typeof payload !== 'object') {
				return res.status(400).json({ error: 'payload-required' });
			}
			if (payloadContainsSlots(payload)
				&& !await _gateCapability(req, res, 'create-slot-canvas', 'save_slot_canvas')) {
				return;
			}
			const store = await canvasStoreFromSfConnection(req.sf.conn, req.sf.sfUserId, req.sf.sfOrgId, { sessionId: req.session && req.session.id });

			// Saved-canvas-cap preflight. Free is capped at 3 owned
			// canvases (PUT in-place save doesn't consume the cap;
			// only POST does). Pro/Team's saved_canvas_cap is null
			// → skip the SOQL count. Only fires in saas mode where a
			// workspace plan exists; canvas-standalone keeps the
			// historical no-cap behavior.
			if (_saasAvailable && workspacesDb && viewStateDb) {
				try {
					const view = await viewStateDb.get(req.account.id);
					const workspaceId = view && view.current_workspace_id;
					const plan = workspaceId
						? ((await workspacesDb.getPlan(workspaceId)) || planById(null))
						: null;
					const cap = plan && plan.saved_canvas_cap;
					if (cap != null && typeof store.countOwned === 'function') {
						const used = await store.countOwned();
						if (used >= cap) {
							await auditDb.record({
								req,
								action: 'canvas_save_cap_reached',
								status: 'denied',
								errorCode: 'saved-canvas-cap-reached',
								targetObject: 'canvas',
								targetSfOrgId: req.sf.sfOrgId,
								payload: { used, cap, plan: plan.id, attemptedName: name },
							}).catch(() => {});
							return res.status(402).json({
								error: 'saved-canvas-cap-reached',
								message: "You've saved " + used + ' of your ' + cap + ' canvases on the ' + plan.label + ' plan. Delete a saved canvas or upgrade to Pro for unlimited saves.',
								savedCount: used,
								savedCap: cap,
								currentPlan: plan.id,
							});
						}
					}
				} catch (_e) { /* don't block save on cap-check failure */ }
			}

			const result = await store.save({ name, payload });
			await ext.auditWrite({
				req,
				action: 'canvas_created',
				targetObject: 'canvas',
				targetId: result.id,
				targetSfOrgId: req.sf.sfOrgId,
				payload: { name, ..._summarizeCanvasPayload(payload) },
			});
			// Funnel telemetry - first canvas save for this account is
			// a major conversion milestone (the user is now actually
			// using the product). Idempotent on (account, action).
			auditDb.recordFirstTime(req, {
				actorAccountId: req.account.id,
				action: 'canvas_first_save',
				targetObject: 'canvas',
				targetId: result.id,
				targetSfOrgId: req.sf.sfOrgId,
				payload: { name },
			}).catch(() => {});
			res.status(201).json(result);
		} catch (err) {
			await auditDb.recordFailure(req, 'canvas_created', err, {
				targetObject: 'canvas',
				targetSfOrgId: (req.sf && req.sf.sfOrgId) || null,
			});
			// Tagged permission errors from the canvas stores get a
			// structured 403 instead of a generic 500 from the global
			// error handler. Lets the client show actionable guidance
			// (which SF perm / permission set to ask the admin for)
			// inline on the Save button instead of a console-only error.
			if (err && err.statusCode === 403 && err.code) {
				return res.status(403).json({
					error: err.code,
					message: err.message,
					sfError: err.sfError || null,
				});
			}
			next(err);
		}
	});

	// PUT /api/canvas/:id - in-place update. Owner OR editor-role
	// recipient (via canvas-share session grant). Optimistic concurrency
	// via expectedVersionId: client sends the versionId from the most
	// recent GET; mismatch means someone else saved (parallel editor
	// or recipient slot-fill) and the store returns 409 so the client
	// can refresh-and-merge rather than overwrite.
	//
	// Editor-recipient flow: a non-owner who redeemed a share with
	// role='editor' (per /canvas/share/:token) has a session grant
	// stored in req.session.canvasShareGrants. The SF-side gate (their
	// own connection has ShareType='C' on the ContentDocument) is
	// what actually authorizes the underlying ContentVersion insert;
	// this route just checks that the Orgloom-side intent matches
	// (don't let a viewer-role recipient hit PUT even if they have
	// SF-side edit access for some reason).
	app.put('/api/canvas/:id', requireAccount, requireSfConnection, async (req, res, next) => {
		try {
			const id = req.params.id;
			if (!/^[a-zA-Z0-9]{15,18}$/.test(id)) {
				return res.status(400).json({ error: 'invalid-id' });
			}
			if (!await _gateCapability(req, res, 'save-canvas', 'save_canvas', { auditPayload: { canvasId: id } })) {
return;
}
			const payload = req.body && req.body.payload;
			const expectedVersionId = req.body && req.body.expectedVersionId;
			if (!payload || typeof payload !== 'object') {
				return res.status(400).json({ error: 'payload-required' });
			}
			if (payloadContainsSlots(payload)
				&& !await _gateCapability(req, res, 'create-slot-canvas', 'save_slot_canvas', { auditPayload: { canvasId: id } })) {
				return;
			}
			const store = await canvasStoreFromSfConnection(req.sf.conn, req.sf.sfUserId, req.sf.sfOrgId, { sessionId: req.session && req.session.id });
			if (typeof store.update !== 'function') {
				return res.status(501).json({ error: 'in-place-update-not-supported' });
			}
			const existing = await store.get(id);
			if (!existing) {
return res.status(404).json({ error: 'not-found' });
}
			if (!existing.ownedByMe) {
				// Allow editor-role recipients (canvas-share grant with
				// role='editor'). Contributor and viewer still get 403 -
				// contributor uses /slot-fill, viewer is read-only.
				const grant = await _findCanvasShareGrant(req, id);
				if (!grant || grant.role !== 'editor') {
					return res.status(403).json({
						error: grant ? 'recipient-role-insufficient' : 'not-owner',
						message: grant
							? 'Editor role required to save this canvas. Contributors fill slots; viewers are read-only.'
							: 'Only the canvas owner can save this canvas, unless you were granted editor access.',
					});
				}
			}
			const safePayload = Object.assign({}, payload, {
				_meta: Object.assign({}, payload._meta || {}, {
					savedAt: new Date().toISOString(),
				}),
			});
			// Pass expectedVersionId through to the store, which does the
			// version-check and the ContentVersion write under a per-canvas
			// in-process lock - so two concurrent PUTs to the same canvas
			// can't both pass the check and clobber each other within this
			// server process. (Salesforce offers no cross-call transaction,
			// so cross-instance races still lean on SF read-your-writes
			// consistency; see _acquireUpdateLock in canvas-store.js.) This
			// replaced an earlier route-level pre-check that compared
			// existing.versionId before calling update, which left a wider TOCTOU
			// window between the get and the update.
			const result = await store.update(id, { payload: safePayload, expectedVersionId });
			await ext.auditWrite({
				req,
				action: 'canvas_updated',
				targetObject: 'canvas',
				targetId: id,
				targetSfOrgId: req.sf.sfOrgId,
				payload: _summarizeCanvasPayload(safePayload),
			});
			// Phase 3 collab: notify other open browsers viewing this
			// canvas that a new version landed so they can decide
			// whether to reload (accept), continue (overwrite on next
			// save), or compare. Best-effort; never blocks the
			// response. Display name comes from the account row so
			// the recipient banner can read like "Jordan saved this
			// canvas." Falls back to the email local-part for
			// accounts without display_name set.
			try {
				const me = req.account || {};
				canvasPresence.broadcastCanvasSaved({
					canvasId: id,
					savedByAccountId: me.id || null,
					savedByDisplayName: me.display_name
						|| (me.email && me.email.split('@')[0])
						|| 'Someone',
					versionId: (result && result.versionId) || existing.versionId,
					title: existing.title || null,
				});
			} catch (_eBroadcast) { /* presence is best-effort */ }
			// Refresh the MCP-read cache with the just-saved state.
			res.json(Object.assign({ ok: true, backend: store.backend }, result));
		} catch (err) {
			await auditDb.recordFailure(req, 'canvas_updated', err, {
				targetObject: 'canvas',
				targetId: req.params.id,
				targetSfOrgId: (req.sf && req.sf.sfOrgId) || null,
			});
			// Mirror the POST handler's 403 surface for tagged perm
			// errors so the client sees the same structured shape on
			// updates. err.statusCode may also be 404 (canvas not
			// found) or 409 (version mismatch) for store-level guards.
			if (err && err.statusCode && err.code) {
				return res.status(err.statusCode).json({
					error: err.code,
					message: err.message,
					sfError: err.sfError || null,
					currentVersionId: err.currentVersionId || undefined,
				});
			}
			next(err);
		}
	});

	// DELETE /api/canvas/:id - soft-deletes the canvas in SF (moves
	// the ContentDocument to recycle bin or marks the custom-object
	// row IsDeleted, depending on backend). Owner-only.
	app.delete('/api/canvas/:id', requireAccount, requireSfConnection, async (req, res, next) => {
		try {
			const id = req.params.id;
			if (!/^[a-zA-Z0-9]{15,18}$/.test(id)) {
				return res.status(400).json({ error: 'invalid-id' });
			}
			const store = await canvasStoreFromSfConnection(req.sf.conn, req.sf.sfUserId, req.sf.sfOrgId, { sessionId: req.session && req.session.id });
			const existing = await store.get(id);
			if (!existing) {
return res.status(404).json({ error: 'not-found' });
}
			if (!existing.ownedByMe) {
				return res.status(403).json({ error: 'not-owner' });
			}
			await store.remove(id);
			// No MCP cache to purge here - canvas_cache table was
			// retired in favor of the live-browser relay (mcp/relay.js).
			// When the canvas's host tab closes (deletion implies it
			// either was closed or will be closed shortly), the relay
			// drops it from list_canvases automatically.
			await ext.auditWrite({
				req,
				action: 'canvas_deleted',
				targetObject: 'canvas',
				targetId: id,
				targetSfOrgId: req.sf.sfOrgId,
				payload: {
					name: (existing && existing.title) || null,
					..._summarizeCanvasPayload(existing && existing.payload),
				},
			});
			res.json({ ok: true });
		} catch (err) {
			await auditDb.recordFailure(req, 'canvas_deleted', err, {
				targetObject: 'canvas',
				targetId: req.params.id,
				targetSfOrgId: (req.sf && req.sf.sfOrgId) || null,
			});
			next(err);
		}
	});

	// ===== Canvas direct share =========================================
	//
	// Default canvas-sharing path. Sender picks a SF user in their org;
	// system creates a ContentDocumentLink granting that SF user access
	// to the underlying canvas file, persists the Orgloom-side role in
	// canvas_role_grants, and sends an informational email. No magic-
	// link token, no redemption URL, no expiry. The SF-side
	// ContentDocumentLink is the durable authorization; the recipient
	// sees the canvas in their Saved Canvases whenever they're signed
	// into Org Loom with a connection to the same SF org - past,
	// present, or future (their connection materializes access
	// automatically via the existing SOQL-against-ContentDocument list
	// query, which respects SF sharing rules).
	//
	// Three-tier role ladder: viewer (read-only on canvas) / contributor
	// (read-only canvas + can fill the
	// slots assigned to them) / editor (full canvas authoring). SF's
	// ShareType only distinguishes 'V' (read) from 'C' (edit), so
	// contributor maps to 'V' on the SF side and the slot-fill
	// distinction comes from the role stored in canvas_role_grants -
	// the canvas-load resolver reads it and surfaces recipientRole to
	// the client, which renders the contributor UI accordingly.
	//
	// Does NOT count against monthly_share_cap. Direct shares are a
	// Salesforce share row + a role-grant row + a notification email.
	//
	// Sending is Pro-gated via share-canvas. Receiving an explicit Viewer
	// grant is free; Contributor and Editor remain receive-canvas gated.
	app.post('/api/canvas/:id/direct-share', requireAccount, requireSfConnection, async (req, res, next) => {
		try {
			const id = req.params.id;
			if (!/^[a-zA-Z0-9]{15,18}$/.test(id)) {
				return res.status(400).json({ error: 'invalid-canvas-id' });
			}
			const cap = await ext.getCapability(req.account, 'share-canvas', {
				req,
				auditAction: 'canvas_shared',
				auditPayload: { canvasId: id, mechanism: 'direct' },
			});
			if (!cap.allowed) {
				return res.status(402).json({
					error: cap.reason,
					message: 'Sharing canvases requires Pro or higher.',
					required: cap.required,
					currentPlan: cap.plan,
				});
			}

			const recipientSfUserId = String((req.body && req.body.recipientSfUserId) || '').trim();
			if (!recipientSfUserId || !/^[a-zA-Z0-9]{15,18}$/.test(recipientSfUserId)) {
				return res.status(400).json({ error: 'recipient-sf-user-id-required' });
			}
			const rawRole = String((req.body && req.body.role) || '').trim();
			// Three-tier ladder: viewer < contributor < editor. Mapping:
			//   * SF-side ContentDocumentLink ShareType - 'V' for viewer
			//     AND contributor (both are read-only on the canvas
			//     file; contributor's slot-fill writes target separate
			//     records via the recipient's own SF connection), 'C'
			//     for editor.
			//   * Orgloom-side role granularity - persisted in
			//     canvas_role_grants (PK sf_org_id + canvas_id +
			//     recipient_sf_user_id) so the canvas-load resolver can
			//     return recipientRole='contributor' to the client even
			//     though SF can't express that distinction. The magic-
			//     link path stores the same three-tier role in its
			//     token payload; both sources normalize to the same
			//     recipientRole shape downstream.
			const role = rawRole === 'editor' ? 'editor'
				: rawRole === 'contributor' ? 'contributor'
				: 'viewer';

			// Confirm canvas exists and the active connection owns it.
			const store = await canvasStoreFromSfConnection(req.sf.conn, req.sf.sfUserId, req.sf.sfOrgId, { sessionId: req.session && req.session.id });
			const item = await store.get(id);
			if (!item) {
return res.status(404).json({ error: 'canvas-not-found' });
}
			if (!item.ownedByMe) {
				return res.status(403).json({
					error: 'share-owner-only',
					message: 'Only the canvas owner can share.',
				});
			}

			// Resolve the recipient SF user, using the same validation as the
			// magic-link route (active, standard license, has email).
			let recipientRecord;
			try {
				recipientRecord = await req.sf.conn.sobject('User').retrieve(recipientSfUserId);
			} catch (e) {
				return res.status(404).json({ error: 'recipient-not-found-in-org' });
			}
			if (!recipientRecord) {
				return res.status(404).json({ error: 'recipient-not-found-in-org' });
			}
			if (!recipientRecord.IsActive) {
				return res.status(400).json({ error: 'recipient-inactive' });
			}
			if (recipientRecord.UserType !== 'Standard') {
				return res.status(400).json({ error: 'recipient-not-standard-license' });
			}
			if (!recipientRecord.Email) {
				return res.status(400).json({ error: 'recipient-missing-email' });
			}
			const recipientSfEmail = String(recipientRecord.Email).trim().toLowerCase();
			const recipientSfName = recipientRecord.Name || null;

			// SF-side share grant. Idempotent at the store layer:
			// re-sharing the same recipient with a different role
			// returns {updated: true} after updating the existing
			// ContentDocumentLink's ShareType rather than throwing
			// DUPLICATE_VALUE. Lets senders upgrade viewer→editor (or
			// downgrade) by simply resending - no separate role-change
			// endpoint needed for the direct flow.
			const accessLevel = role === 'editor' ? 'Edit' : 'Read';
			let shareResult = null;
			try {
				shareResult = await store.addShare(id, { entityId: recipientSfUserId, accessLevel });
			} catch (e) {
				return res.status(e.statusCode || 500).json({
					error: 'sf-share-grant-failed',
					message: (e && e.message) || String(e),
				});
			}
			const shareWasUpdated = !!(shareResult && shareResult.updated);

			// Persist the Orgloom-side role. Upsert keyed by (sf_org,
			// canvas, recipient): re-share with a different role just
			// updates the row. Done AFTER the SF grant succeeds so a
			// failed SF write doesn't leave an orphan role row that
			// hints at access the recipient doesn't actually have.
			try {
				await canvasRoleGrantsDb.set({
					sfOrgId: req.sf.sfOrgId,
					canvasId: id,
					recipientSfUserId,
					role,
					grantedByAccountId: req.account.id,
				});
			} catch (e) {
				// Don't roll back the SF grant on a DB hiccup - the SF
				// link is what controls access. The role row will fall
				// back to viewer semantics on the load resolver if the
				// row is missing, which is the safest default.
				console.warn('[canvas-direct-share] role-grant persist failed:', e.message || e);
			}

			// Recipient-state lookup for the email body. Both queries are
			// cheap indexed reads. We learn:
			//   recipientHasAccount - there's an Orgloom account at
			//                             this SF email (matches the SF
			//                             User.Email we just retrieved)
			//   recipientHasConnection - that account has a saved
			//                             connection to the same sf_org_id
			//                             the canvas lives in
			// Both flags shape the email's call-to-action sentence. If
			// we can't determine state (DB error / empty result), the
			// email falls back to the generic onboarding copy.
			let recipientHasAccount = false;
			let recipientHasConnection = false;
			try {
				const acct = await accountsDb.findByEmail(recipientSfEmail);
				if (acct) {
					recipientHasAccount = true;
					const conns = await connectionsDb.listForAccount(acct.id);
					recipientHasConnection = (conns || []).some((c) => c.sf_org_id === req.sf.sfOrgId);
				}
			} catch (_eLookup) { /* leave flags false; email uses generic copy */ }

			// sfOrgLabel: instance URL hostname is the most-recognizable
			// label we can offer without an extra SF query. "acme.my.
			// salesforce.com" is what the recipient sees in their address
			// bar. Falling back to the org id (15-char) reads as gibberish.
			let sfOrgLabel = null;
			try {
				const u = new URL(req.sf.instanceUrl || (req.sf.connectionRow && req.sf.connectionRow.instance_url) || '');
				sfOrgLabel = u.hostname;
			} catch (_eUrl) {
 sfOrgLabel = null; 
}

			// App URL for the notification CTA.
			const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
			const host = req.get('host');
			const appUrl = process.env.APP_URL ? process.env.APP_URL.replace(/\/$/, '') : `${proto}://${host}`;

			try {
				await sendDirectCanvasShareNotification({
					to: recipientSfEmail,
					appUrl,
					// Deep-link through standard Org Loom account sign-in,
					// then Salesforce connection when one is still needed.
					canvasId: id,
					senderName: req.account.display_name || req.account.email,
					senderEmail: req.account.email,
					canvasName: item.title,
					sfOrgLabel,
					role,
					recipientHasAccount,
					recipientHasConnection,
				});
			} catch (e) {
				console.error('[canvas-direct-share] email send failed:', e.message || e);
				// SF-side grant succeeded; recipient can still find the
				// canvas via their Saved Canvases. The email is a
				// notification, not the access mechanism, so we don't
				// roll back. Audit reflects "shared but notification
				// delivery failed" so the trail is honest.
				try {
					await ext.auditWrite({
						req,
						action: 'canvas_shared',
						targetObject: 'canvas',
						targetId: id,
						targetSfOrgId: req.sf.sfOrgId,
						status: 'partial',
						errorCode: 'email-deliver-failed',
						payload: {
							mechanism: 'direct',
							recipientSfUserId,
							role,
							error: (e && e.message) || String(e),
						},
					});
				} catch (_eAudit) { /* best-effort */ }
				return res.status(200).json({
					ok: true,
					mechanism: 'direct',
					emailDeliverFailed: true,
					message: 'Canvas access was granted, but the notification email failed to send. The recipient can still find the canvas in their Saved Canvases.',
				});
			}

			await ext.auditWrite({
				req,
				action: 'canvas_shared',
				targetObject: 'canvas',
				targetId: id,
				targetSfOrgId: req.sf.sfOrgId,
				payload: {
					// recipientSfUserId identifies who the canvas was shared
					// with; the recipient's email + name are third-party PII
					// that recipientSfUserId already stands in for, so they're
					// kept out of the audit trail.
					mechanism: 'direct',
					recipientSfUserId,
					role,
					updated: shareWasUpdated,
					recipientHasAccount,
					recipientHasConnection,
				},
			});

			res.status(201).json({
				ok: true,
				mechanism: 'direct',
				role,
				updated: shareWasUpdated,
				recipient: {
					sfUserId: recipientSfUserId,
					email: recipientSfEmail,
					name: recipientSfName,
					hasAccount: recipientHasAccount,
					hasConnection: recipientHasConnection,
				},
			});
		} catch (err) {
			await auditDb.recordFailure(req, 'canvas_shared', err, {
				targetObject: 'canvas',
				targetId: req.params.id,
				targetSfOrgId: (req.sf && req.sf.sfOrgId) || null,
			});
			next(err);
		}
	});

	// GET /api/canvas/:id/share-links
	// Lists the SF-side direct shares for this canvas. Endpoint name kept
	// for client compatibility post-migration; previously also returned a
	// `shares` bucket for magic-link tokens. The magic-link share path
	// was removed - direct shares (ContentDocumentLink + canvas_role_grants)
	// are the only share mechanism now.
	app.get('/api/canvas/:id/share-links', requireAccount, requireSfConnection, async (req, res, next) => {
		try {
			const id = req.params.id;
			if (!/^[a-zA-Z0-9]{15,18}$/.test(id)) {
				return res.status(400).json({ error: 'invalid-canvas-id' });
			}
			const store = await canvasStoreFromSfConnection(req.sf.conn, req.sf.sfUserId, req.sf.sfOrgId, { sessionId: req.session && req.session.id });
			const item = await store.get(id);
			if (!item) {
return res.status(404).json({ error: 'canvas-not-found' });
}
			// Non-owners get an empty list (don't leak the recipient
			// list for canvases they don't own).
			if (!item.ownedByMe) {
return res.json({ shares: [], directShares: [] });
}

			// Direct shares: SF ContentDocumentLink rows filtered to User
			// entityType (excludes library/group grants the user can't
			// revoke from this UI) and the owner's own implicit link.
			// Hydrate each row with the Orgloom-side role from
			// canvas_role_grants - SF's accessLevel only distinguishes
			// view from edit; the three-tier role (viewer/contributor/
			// editor) lives in our DB. Missing role rows fall back to a
			// derived role so legacy ContentDocumentLinks created before
			// the table existed still render sensibly.
			let directShares = [];
			let roleByRecipient = {};
			try {
				roleByRecipient = await canvasRoleGrantsDb.listForCanvas({
					sfOrgId: req.sf.sfOrgId,
					canvasId: id,
				});
			} catch (e) {
				console.warn('[canvas-share] role-grants list failed for', id + ':', e.message || e);
			}
			try {
				const sfShares = await store.listShares(id);
				directShares = (sfShares || [])
					.filter((s) => s.entityType === 'User' && s.entityId !== req.sf.sfUserId)
					.map((s) => {
						const grant = roleByRecipient[s.entityId];
						const fallbackRole = s.accessLevel === 'Collaborator' ? 'editor' : 'viewer';
						return {
							linkId: s.id,
							sfUserId: s.entityId,
							name: s.entityName,
							accessLevel: s.accessLevel,
							role: (grant && grant.role) || fallbackRole,
						};
					});
			} catch (e) {
				console.warn('[canvas-share] listShares failed for', id + ':', e.message || e);
			}

			// `shares: []` retained for backwards compat - old clients
			// still in-flight expect the field; the new modal ignores it.
			res.json({ shares: [], directShares });
		} catch (err) {
 next(err); 
}
	});

	// DELETE /api/canvas/:id/direct-shares/:sfUserId
	// Revoke a direct (SF-side) share grant. Owner-only; removes the
	// recipient's ContentDocumentLink row. Unlike
	// magic-link revoke, there's no Orgloom token to invalidate - the
	// SF-side grant IS the authorization, so deleting the link revokes
	// access immediately for the recipient. They'd discover this on
	// their next SOQL list refresh (canvas vanishes from Saved Canvases).
	app.delete('/api/canvas/:id/direct-shares/:sfUserId', requireAccount, requireSfConnection, async (req, res, next) => {
		try {
			const id = req.params.id;
			const recipientSfUserId = req.params.sfUserId;
			if (!/^[a-zA-Z0-9]{15,18}$/.test(id)) {
				return res.status(400).json({ error: 'invalid-canvas-id' });
			}
			if (!/^[a-zA-Z0-9]{15,18}$/.test(recipientSfUserId)) {
				return res.status(400).json({ error: 'invalid-recipient-sf-user-id' });
			}
			const store = await canvasStoreFromSfConnection(req.sf.conn, req.sf.sfUserId, req.sf.sfOrgId, { sessionId: req.session && req.session.id });
			const item = await store.get(id);
			if (!item) {
return res.status(404).json({ error: 'canvas-not-found' });
}
			if (!item.ownedByMe) {
				return res.status(403).json({ error: 'revoke-owner-only' });
			}
			// Guard against self-revoke, which would orphan the owner from
			// their own canvas. Cheap check, but the symmetry of the SF
			// API would happily let an owner do it.
			if (recipientSfUserId === req.sf.sfUserId) {
				return res.status(400).json({ error: 'cannot-revoke-self' });
			}
			let removed = 0;
			try {
				removed = await _removeSfShareForRecipient(store, id, recipientSfUserId);
			} catch (e) {
				return res.status(e.statusCode || 500).json({
					error: 'sf-share-revoke-failed',
					message: (e && e.message) || String(e),
				});
			}
			// Clear the Orgloom-side role grant too. Done after the SF
			// revoke succeeds so a failed SF call doesn't strip the role
			// metadata for a recipient who actually still has access.
			// Best-effort: a left-behind row is harmless (the canvas-load
			// resolver gates on SF read first, so the row is dormant
			// without the matching ContentDocumentLink).
			try {
				await canvasRoleGrantsDb.remove({
					sfOrgId: req.sf.sfOrgId,
					canvasId: id,
					recipientSfUserId,
				});
			} catch (e) {
				console.warn('[canvas-direct-share] role-grant remove failed:', e.message || e);
			}
			await ext.auditWrite({
				req,
				action: 'canvas_share_revoked',
				targetObject: 'canvas',
				targetId: id,
				targetSfOrgId: req.sf.sfOrgId,
				payload: { mechanism: 'direct', recipientSfUserId, sfGrantsRemoved: removed },
			});
			res.json({ ok: true, sfGrantsRemoved: removed });
		} catch (err) {
			await auditDb.recordFailure(req, 'canvas_share_revoked', err, {
				targetObject: 'canvas',
				targetId: req.params.id,
				targetSfOrgId: (req.sf && req.sf.sfOrgId) || null,
			});
			next(err);
		}
	});


	// ===== Slot-fill (recipient submission) ============================
	//
	// Recipient endpoint. Accepts an array of { recordId, fields, ... }
	// fills, runs them through planSlotFills (the auth/allowlist gate
	// from slot-helpers), then issues per-object batched UPDATEs via
	// the recipient's own SF connection. SF enforces the recipient's
	// FLS / sharing - planSlotFills is the manifest-level gate that
	// runs first so we don't even submit DML the recipient shouldn't
	// have proposed.
	//
	// Auth posture: requires (a) an active SF connection belonging to
	// the recipient, and (b) a canvas_role_grants row (written at
	// direct-share time) for that SF identity on this canvas. The SF
	// connection proves who you are; the role grant is the
	// authorization. The connection MUST be resolved before the grant
	// lookup - _findCanvasShareGrant resolves grants by req.sf's
	// identity, and this route has no requireSfConnection middleware
	// to populate it. (That ordering was inverted post-magic-link
	// migration, which made every slot-fill 403 with
	// no-canvas-share-grant.)
	//
	// Every recipient has an Org Loom identity, but Viewer access does not
	// consume a trial or seat. Contributor and Editor are value-creating
	// roles, so after the role check they must also pass receive-canvas.
	app.post('/api/canvas/:id/slot-fill', requireAccount, async (req, res, next) => {
		try {
			const id = req.params.id;
			if (!/^[a-zA-Z0-9]{15,18}$/.test(id)) {
				return res.status(400).json({ error: 'invalid-canvas-id' });
			}
			const sfBundle = await getActiveSfConnection(req);
			if (!sfBundle) {
				return res.status(401).json({
					error: 'sf-session-expired',
					message: 'Salesforce session expired. Sign in to Salesforce again, then retry.',
				});
			}
			req.sf = sfBundle;
			const grant = await _findCanvasShareGrant(req, id);
			if (!grant) {
				return res.status(403).json({
					error: 'no-canvas-share-grant',
					message: 'No active share grant for this canvas. Ask the canvas owner to share it with you.',
				});
			}
			// Viewer is read-only: it can load the canvas but must not write
			// any underlying records. The recipient UI hides the slot-fill
			// affordances for viewers, so this is the server-side backstop
			// (a hand-crafted request, or a stale UI). SF FLS would catch a
			// genuinely unauthorized write too, but a viewer may legitimately
			// have edit access to the records in SF - the read-only promise
			// is the SHARE's contract, enforced here regardless.
			if (grant.role === 'viewer') {
				return res.status(403).json({
					error: 'role-read-only',
					message: 'This canvas was shared with you as view-only. Ask the owner for contributor access to fill slots.',
				});
			}
			if (!await _gateCapability(req, res, 'receive-canvas', 'fill_shared_canvas', {
				auditPayload: { canvasId: id, recipientRole: grant.role },
				message: 'Contributor and Editor access requires an active Pro trial, Pro subscription, or Team seat. If your trial is unused, open Your workspace to start it. Otherwise, upgrade or ask the owner for Viewer access.',
			})) {
				return;
			}

			const fills = req.body && Array.isArray(req.body.fills) ? req.body.fills : null;
			if (!fills || fills.length === 0) {
				return res.status(400).json({ error: 'fills-required' });
			}

			const store = await canvasStoreFromSfConnection(sfBundle.conn, sfBundle.sfUserId, sfBundle.sfOrgId, { sessionId: req.session && req.session.id });
			const item = await store.get(id);
			if (!item) {
return res.status(404).json({ error: 'canvas-not-found' });
}

			const payload = (item.payload && typeof item.payload === 'object') ? item.payload : {};
			const unifiedRecords = [].concat(
				Array.isArray(payload.loadedRecords) ? payload.loadedRecords : [],
				Array.isArray(payload.drafts) ? payload.drafts : [],
			);
			const { skipped, appliedCount, recordPlan } = planSlotFills({
				records: unifiedRecords,
				fills,
				recipientSfUserId: sfBundle.sfUserId,
			});

			if (appliedCount === 0) {
				const allBlockedByAssignment = skipped.length > 0 && skipped.every((s) => s.reason === 'not_assigned_to_you');
				if (allBlockedByAssignment) {
					return res.status(403).json({
						error: 'all-slots-assigned-elsewhere',
						message: 'These slots are assigned to a different teammate. Ask the canvas owner to share with you for those specific slots.',
						skipped,
					});
				}
				return res.status(400).json({
					error: 'no-matching-slots',
					message: 'None of the submitted fills matched a slot on this canvas. The canvas may have been edited since the link was created.',
					skipped,
				});
			}

			// Per-object batched updates via the recipient's connection.
			// Skip empty-update rows (allowlist dropped everything except
			// Id). SF would 400 on update({Id}-only) with a useless
			// "no fields to update" - drop them client-side here.
			const successes = [];
			const failures = [];
			for (const [objectName, updates] of Object.entries(recordPlan)) {
				const nonEmpty = updates.filter((u) => Object.keys(u).length > 1);
				if (nonEmpty.length === 0) {
continue;
}
				try {
					const results = await sfBundle.conn.sobject(objectName).update(nonEmpty);
					const arr = Array.isArray(results) ? results : [results];
					arr.forEach((r, i) => {
						if (r.success) {
							successes.push({ id: nonEmpty[i].Id, objectName });
						} else {
							failures.push({
								id: nonEmpty[i].Id,
								objectName,
								errors: (r.errors || []).map((e) => e.message || String(e)),
							});
						}
					});
				} catch (err) {
					console.warn('[slot-fill] batch update failed for ' + objectName + ':', err.message || err);
					nonEmpty.forEach((u) => {
						failures.push({
							id: u.Id,
							objectName,
							errors: [err.message || String(err)],
						});
					});
				}
			}

			await ext.auditWrite({
				req,
				action: 'canvas_slot_filled',
				targetObject: 'canvas',
				targetId: id,
				targetSfOrgId: sfBundle.sfOrgId,
				payload: {
					recipientSfUserId: sfBundle.sfUserId,
					applied: successes.length,
					failed: failures.length,
					skipped: skipped.length,
				},
			});

			// Best-effort owner notification. Pre-migration the owner's
			// email came from the share-token payload; post-migration
			// (direct-share only) we look it up via the canvas owner's
			// SF User record. Failures here don't roll back the slot-
			// fill - the data is already in SF.
			try {
				let ownerEmail = null;
				if (item.ownerId && /^[a-zA-Z0-9]{15,18}$/.test(item.ownerId)) {
					try {
						const owner = await req.sf.conn.sobject('User').retrieve(item.ownerId);
						if (owner && owner.Email) {
ownerEmail = String(owner.Email).trim();
}
					} catch (_eOwner) { /* owner lookup failed - skip notification */ }
				}
				if (ownerEmail) {
					const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
					const host = req.get('host');
					const baseUrl = process.env.APP_URL ? process.env.APP_URL.replace(/\/$/, '') : `${proto}://${host}`;
					await sendCanvasFillNotification({
						to: ownerEmail,
						recipientName: sfBundle.connectionRow.display_name || sfBundle.connectionRow.email,
						recipientEmail: sfBundle.connectionRow.email,
						canvasName: item.title,
						appliedCount: successes.length,
						viewLink: baseUrl + '/?canvas=' + encodeURIComponent(id),
					});
				}
			} catch (e) {
				console.warn('[slot-fill] owner notification failed:', e.message || e);
			}

			res.json({
				ok: true,
				applied: successes.length,
				failed: failures.length,
				successes,
				failures,
				skipped,
			});
		} catch (err) {
			await auditDb.recordFailure(req, 'canvas_slot_filled', err, {
				targetObject: 'canvas',
				targetId: req.params.id,
				targetSfOrgId: (req.sf && req.sf.sfOrgId) || null,
			});
			next(err);
		}
	});

	// ===== AI generation ===============================================

	// GET /api/ai/status - feature-flag probe + auth-aware usage. Drives
	// the AI button's visibility (enabled/model - same for everyone) AND
	// the AI modal's approaching-cap banner (usage - per signed-in
	// account+workspace). Always 200; the auth check is opportunistic, so
	// unauthenticated callers (lobby/landing-page button gating) just get
	// the feature-flag fields with no `usage` block.
	app.get('/api/ai/status', async (req, res) => {
		const base = {
			enabled: anthropicEnabled(),
			model: anthropicEnabled() ? ANTHROPIC_MODEL : null,
		};
		try {
			const accountId = req.session && req.session.accountId;
			if (accountId) {
				const view = await viewStateDb.get(accountId);
				const workspaceId = view && view.current_workspace_id;
				if (workspaceId) {
					const plan = (await workspacesDb.getPlan(workspaceId)) || PLANS.free;
					const tokenCap = plan.monthly_ai_tokens;
					if (tokenCap != null) {
						const counters = await usageDb.getCountersForPeriodByAccount(workspaceId, accountId);
						const tokensUsed = counters.ai_tokens || 0;
						const creditsRemaining = await workspaceCreditsDb.getBalance(workspaceId);
						base.usage = {
							tokensUsed,
							tokenCap,
							percentUsed: tokenCap > 0 ? Math.round((tokensUsed / tokenCap) * 100) : 0,
							atCap: tokensUsed >= tokenCap,
							creditsRemaining,
							plan: plan.id,
							planLabel: plan.label,
						};
					}
				}
			}
		} catch (e) {
			// Don't break the feature-flag probe if the usage lookup
			// fails - the modal just skips the banner.
			console.warn('[ai/status] usage lookup failed:', e.message || e);
		}
		res.json(base);
	});

	// POST /api/ai/plan - generate a Salesforce records plan.
	// Body: { text, objectNames, fkFields? }
	//
	// Cap math:
	//   1. plan.monthly_ai_tokens null = unlimited (no plan currently
	//      maps to null - Free/Pro/Team all carry numeric caps in
	//      capabilities.js, so the null branch is a future hook).
	//   2. tokens used this month >= cap → fall back to workspace
	//      AI credits. Both empty → 402.
	//   3. inCreditMode flags the call so the post-call accounting
	//      block deducts actual usage from the credit balance.
	app.post('/api/ai/plan', requireAccount, requireSfConnection, async (req, res, next) => {
		try {
			if (!anthropicEnabled()) {
				return res.status(501).json({
					error: 'ai-disabled',
					message: ext.saasMounted
						? 'Generate with AI is temporarily unavailable. Try again later or contact Org Loom support if the problem continues.'
						: 'AI generation is not enabled on this server. Set ANTHROPIC_API_KEY and restart to enable.',
				});
			}
			if (!await _gateCapability(req, res, 'generate-records-with-ai', 'generate records with AI', {
				messages: {
					'plan-insufficient': 'Generate with AI is available on Pro and Team plans. Upgrade the active workspace to use it.',
					'member-grant-required': 'Generate with AI is not enabled for your account in this workspace. Ask a workspace admin to grant the Generate with AI permission.',
					'no-workspace': 'Select or create a workspace before using Generate with AI.',
					'not-a-member': 'Your account is not a member of the active workspace. Switch workspaces or ask a workspace admin to add you.',
				},
			})) {
				return;
			}
			const { text, objectNames, fkFields } = req.body || {};
			if (typeof text !== 'string' || text.trim().length === 0) {
				return res.status(400).json({ error: 'description-required' });
			}
			if (text.length > AI_MAX_PROMPT_CHARS) {
				return res.status(400).json({
					error: 'description-too-long',
					message: 'Description too long (max ' + AI_MAX_PROMPT_CHARS + ' characters).',
				});
			}
			if (!Array.isArray(objectNames) || objectNames.length === 0) {
				return res.status(400).json({
					error: 'objects-required',
					message: 'At least one selected object is required. Pick objects on the schema view first.',
				});
			}
			if (objectNames.length > AI_MAX_OBJECTS) {
				return res.status(400).json({
					error: 'too-many-objects',
					message: 'Too many objects (max ' + AI_MAX_OBJECTS + ' in one generation).',
				});
			}
			for (const name of objectNames) {
				if (typeof name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
					return res.status(400).json({
						error: 'invalid-object-name',
						message: 'Invalid object name: ' + String(name),
					});
				}
			}

			// Resolve the active workspace - billing target for this
			// call. The view-state lookup runs as part of /api/me and
			// the resolver, so by here we know it's set (requireAccount
			// + requireSfConnection both rely on it transitively).
			const view = await viewStateDb.get(req.account.id);
			const workspaceId = view && view.current_workspace_id;
			if (!workspaceId) {
				return res.status(409).json({ error: 'no-active-workspace' });
			}
			// Quota is workspace-funded - the workspace where the work
			// happens pays the AI bill, regardless of who's licensed to
			// trigger it. See /architecture for the license-vs-quota split.
			// Pre-flight cap check via the quota registry. Saas implementation
			// reads plan + per-account counters + workspace credits; canvas
			// standalone's default returns no-cap. `blocked` is true iff
			// the plan cap is reached AND no workspace credits remain;
			// `inCreditMode` (still tracked for the audit payload) is true
			// when plan is exhausted but credits will absorb this call.
			const quota = await ext.getQuota(req.account, 'ai_tokens');
			const inCreditMode = quota.cap != null && quota.used >= quota.cap && !quota.blocked;
			if (quota.blocked) {
				// Audit: AI quota exceeded. Denied - workspace hit its
				// monthly token cap and has no credits. Tracking this
				// separately from a generic 'failed' status because admins
				// frequently want to query "who tried to generate after
				// the cap?" to decide on top-ups.
				try {
					await ext.auditWrite({
						req,
						workspaceId,
						action: 'ai_generate',
						targetObject: 'ai',
						targetSfOrgId: req.sf.sfOrgId,
						status: 'denied',
						errorCode: 'quota-exceeded',
						payload: { tokensUsed: quota.used, tokenCap: quota.cap, plan: quota.planId, objectNames },
					});
				} catch (_eAudit) { /* best-effort */ }
				return res.status(402).json({
					error: 'cap-reached',
					message: "You've reached your " + quota.cap.toLocaleString() + ' tokens monthly AI quota on the ' + quota.planLabel + ' plan. Wait for the cap to reset, ask your admin to top up workspace AI credits, or upgrade for unlimited generations.',
					tokensUsed: quota.used,
					tokenCap: quota.cap,
					creditsRemaining: 0,
					currentPlan: quota.planId,
				});
			}

			// Resolve SF describes for the selected objects via the
			// recipient's connection. One round-trip per object;
			// jsforce describes are cached on the connection so
			// repeated generations against the same selection are
			// cheap.
			//
			// Wrap the describe pass so a stale SF session surfaces as
			// a clean 401 sf-session-expired rather than the raw
			// jsforce/HTML noise. The global INVALID_SESSION_ID
			// handler in server.js catches the canonical jsforce error
			// code, but stale-session redirects arrive as an HTML login
			// page wrapped in a 4xx and miss that path - match the
			// observed pattern explicitly here.
			const conn = req.sf.conn;
			let describes;
			try {
				describes = await Promise.all(objectNames.map(async (name) => ({
					name,
					describe: await conn.sobject(name).describe(),
				})));
			} catch (sfErr) {
				const code = sfErr && (sfErr.errorCode || sfErr.name);
				const msg = String((sfErr && sfErr.message) || '');
				const isSfAuth = code === 'INVALID_SESSION_ID'
					|| code === 'INVALID_OAUTH_TOKEN'
					|| (sfErr && sfErr.statusCode === 401)
					|| /URL No Longer Exists|Session expired|Invalid Session|invalid_grant|authentication failure/i.test(msg);
				if (isSfAuth) {
					try {
						await ext.auditWrite({
							req,
							workspaceId,
							action: 'ai_generate',
							targetObject: 'ai',
							targetSfOrgId: req.sf.sfOrgId,
							status: 'failed',
							errorCode: 'sf-session-expired',
							payload: { objectNames },
						});
					} catch (_eAudit) { /* best-effort */ }
					// 401 (not 409) so the global sf-fetch.js interceptor
					// surfaces the interactive reauth UI - same contract as
					// the global INVALID_SESSION_ID handler in server.js.
					// The stale-session-via-HTML-redirect path otherwise
					// misses that handler.
					return res.status(401).json({
						error: 'sf-session-expired',
						message: 'Your Salesforce session has expired. Reconnect Salesforce and try again.',
					});
				}
				throw sfErr;
			}

			let fkFieldsByObject = null;
			if (fkFields && typeof fkFields === 'object') {
				fkFieldsByObject = {};
				for (const [obj, fields] of Object.entries(fkFields)) {
					if (!Array.isArray(fields)) {
continue;
}
					fkFieldsByObject[obj] = fields.filter((f) => typeof f === 'string' && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(f));
				}
			}
			const summary = buildAiDescribeSummary(describes, fkFieldsByObject);
			const systemPrompt = buildAiSystemPrompt(summary);

			const anthropic = getAnthropicClient();
			const response = await anthropic.messages.create({
				model: ANTHROPIC_MODEL,
				max_tokens: 4096,
				// cache_control on the system block makes repeated
				// generations against the same selection cheap - the
				// describe summary is the biggest chunk and stays
				// identical across calls.
				system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
				tools: [AI_PLAN_TOOL],
				tool_choice: { type: 'tool', name: 'create_plan' },
				messages: [{ role: 'user', content: text.trim() }],
			});
			const toolUse = (response.content || []).find((b) => b.type === 'tool_use' && b.name === 'create_plan');
			if (!toolUse) {
				// Audit: model returned no plan. Failure (not denial) -
				// the prompt got through quota + auth but the model
				// declined to produce structured output. Useful for
				// spotting prompts that need rewording or model regressions.
				try {
					await ext.auditWrite({
						req,
						workspaceId,
						action: 'ai_generate',
						targetObject: 'ai',
						targetSfOrgId: req.sf.sfOrgId,
						status: 'failed',
						errorCode: 'no-plan',
						payload: { objectNames, promptLength: text.length },
					});
				} catch (_eAudit) { /* best-effort */ }
				return res.status(502).json({ error: 'no-plan', message: 'Model returned no plan. Try rephrasing.' });
			}
			const validated = validateAiPlan(toolUse.input || {}, describes);
			if (validated.records.length === 0) {
				// Log shape, not content: the prompt is tenant-supplied text
				// and must not land in server/log aggregation.
				console.warn('[ai/plan] empty plan after validation', {
					promptLength: typeof text === 'string' ? text.length : 0,
					objectNames,
					rawRecordCount: Array.isArray(toolUse.input && toolUse.input.records) ? toolUse.input.records.length : 0,
					warnings: validated.warnings,
				});
			}

			// Usage accounting via the quota registry. Best-effort -
			// don't fail the response on accounting errors since the
			// LLM call already happened and the cost is sunk. The
			// saas-registered provider handles both the per-account
			// usage counter increment AND the workspace credit
			// deduction (for the portion of this charge that fell
			// past the plan cap). Canvas-standalone's default no-ops.
			const tokensSpent = usageDb.totalTokensFromUsage(response.usage);
			const costCents = usageDb.costCentsFromUsage(response.usage);
			let chargeResult = { chargedToPlan: tokensSpent, chargedToCredits: 0 };
			try {
				chargeResult = await ext.chargeQuota(req.account, 'ai_tokens', tokensSpent, {
					spendCents: costCents,
					generations: 1,
				});
			} catch (e) {
 console.warn('[usage] chargeQuota failed:', e.message || e); 
}

			// Audit any credit draw. balanceBefore is reconstructed from
			// the post-charge balance + the consumed amount - accurate
			// as long as no other consumer raced in between (same race
			// the old code had with its before/consumeCredits pair).
			if (chargeResult.chargedToCredits > 0) {
				try {
					const balanceAfter = await workspaceCreditsDb.getBalance(workspaceId);
					await ext.auditWrite({
						req,
						workspaceId,
						action: 'credits_consumed',
						targetObject: 'workspace_credits',
						payload: {
							source: 'ai_generation',
							requested: tokensSpent,
							consumed: chargeResult.chargedToCredits,
							balanceBefore: balanceAfter + chargeResult.chargedToCredits,
							balanceAfter,
						},
					});
				} catch (e) {
 console.warn('[credits] audit failed:', e.message || e); 
}
			}

			await ext.auditWrite({
				req,
				workspaceId,
				action: 'ai_generate',
				targetObject: 'ai',
				targetSfOrgId: req.sf.sfOrgId,
				payload: {
					objectNames,
					recordCount: validated.records.length,
					warningsCount: validated.warnings.length,
					tokens: tokensSpent,
					costCents,
					creditMode: inCreditMode,
				},
			});

			res.json({
				records: validated.records,
				associations: validated.associations,
				warnings: validated.warnings,
				usage: {
					tokens: tokensSpent,
					costCents,
					creditMode: inCreditMode,
				},
			});
		} catch (err) {
			console.error('[ai/plan] failed:', err);
			// Audit the failure so the trail records exceptions thrown
			// out of the Anthropic call (rate limits, network errors,
			// invalid plan validation, etc.) - these otherwise just
			// 500'd silently. workspaceId may be undefined in scope
			// if the failure happened before view-state resolution;
			// fall back to a fresh lookup.
			try {
				let _wsId = null;
				try {
					const _view = await viewStateDb.get(req.account.id);
					_wsId = (_view && _view.current_workspace_id) || null;
				} catch (_eVs) { /* leave _wsId null */ }
				await ext.auditWrite({
					req,
					workspaceId: _wsId,
					action: 'ai_generate',
					targetObject: 'ai',
					targetSfOrgId: (req.sf && req.sf.sfOrgId) || null,
					status: 'failed',
					errorCode: (err && (err.errorCode || err.name)) || 'ai-error',
					payload: null,
				});
			} catch (_eAudit) { /* best-effort */ }
			next(err);
		}
	});

	// ===== Upload =====================================================
	//
	// Single-canvas upload to Salesforce. Topological-sort the records
	// by their reference dependencies, insert/update each via the
	// active SF connection, substitute real Salesforce IDs into FK
	// fields as parents commit, surface per-record results.
	//
	// Cap math:
	//   1. Production-org gate: if the workspace requires approval and
	//      the active connection's org is production, the SF org needs
	//      an approved row in org_approvals for capability
	//      'connect-sf-org'. Auto-creates a pending row when missing
	//      so admins have something to act on. Sandboxes / Developer
	//      Edition orgs are always allowed.
	//   2. Monthly upload cap: plan.monthly_upload_cap (null = unlimited)
	//      compared against usage_counters.uploads for the current
	//      period. Direct CSV uploads (directUpload=true in body) skip
	//      the cap entirely: pricing promises unlimited direct CSV
	//      against the Data Loader competitor.
	//   3. Payload byte cap: 5 MB hard cap on the request body.
	//
	// Variants like /api/upload/graph, /api/upload/preflight,
	// /api/upload/bulk port in 5e-follow-up - they share most of the
	// helpers in sf-upload.js but each has its own SF mechanics.
	app.post('/api/upload', requireAccount, requireSfConnection, async (req, res, next) => {
		try {
			if (rejectIfOverPayloadCap(req, res)) {
return;
}
			if (!await _gateCapability(req, res, 'upload-records', 'upload')) {
return;
}

			// Production-org policy check via the resolver. The active
			// connection's sf_org_id is the target; org_type drives
			// whether requiresApproval fires.
			const orgGate = await ext.getCapability(req.account, 'connect-sf-org', {
				sfOrgId: req.sf.sfOrgId,
				orgType: req.sf.orgType || 'unknown',
				createPendingOnDeny: true,
				req,
				auditAction: 'upload',
			});
			if (!orgGate.allowed) {
				return res.status(403).json({
					error: orgGate.reason,
					approvalStatus: orgGate.approvalStatus,
					message: orgGate.reason === 'approval-required'
						? 'Writes to this production org are pending admin approval.'
						: 'This action is blocked by workspace policy.',
				});
			}

			const records = Array.isArray(req.body?.records) ? req.body.records : [];
			applySlotFieldFilter(records);
			const associations = Array.isArray(req.body?.associations) ? req.body.associations : [];
			const skipTempIds = new Set(Array.isArray(req.body?.skipTempIds) ? req.body.skipTempIds : []);
			const directUpload = !!req.body?.directUpload;
			// Explicit duplicate-rule override (client's "Upload anyway"
			// after DUPLICATES_DETECTED). Passed to jsforce create/update as
			// the Sforce-Duplicate-Rule-Header so ALERT-severity rules record
			// their alert but accept the save; BLOCK-severity rules still
			// reject. Matches what the user could do in the SF UI.
			const allowDuplicates = !!req.body?.allowDuplicates;
			const _writeOpts = allowDuplicates
				? { headers: { 'Sforce-Duplicate-Rule-Header': 'allowSave=true' } }
				: undefined;
			// Pending-delete records ship in a parallel `deletes` array.
			// Each entry is { tempId, sfId, objectName }; sfId is the
			// 15/18-char Salesforce id the canvas captured at load time.
			// Executed AFTER creates/updates (separate loop below) so the
			// same upload can edit-then-delete (uncommon but legal)
			// without ordering surprises. The server sorts children-first
			// via _orderDeletesChildrenFirst before executing - the client
			// sends canvas order, which is NOT delete-safe for
			// master-detail / restricted lookups.
			const deletesIn = _orderDeletesChildrenFirst(
				Array.isArray(req.body?.deletes) ? req.body.deletes : [],
				associations,
			);
			if (records.length === 0 && deletesIn.length === 0) {
				return res.status(400).json({ error: 'no-records' });
			}

			// Two-phase ledger + server-side idempotency (attemptId). See the
			// matching block in /api/upload/graph for full rationale. Also
			// covers the graph→REST same-click fall-through: the graph route
			// already wrote a batch under this attemptId, so the REST attempt
			// replays it instead of re-inserting.
			const _attemptId = _requireUploadAttemptId(req, res);
			if (!_attemptId) {
				return;
			}
			if (!_claimUploadAttempt(req, res, _attemptId)) {
				return res.status(409).json({
					error: 'upload-attempt-in-progress',
					message: 'This upload attempt is already running. Wait for it to finish, then reconcile before retrying.',
				});
			}
			let _twoPhaseStore = null;
			let _pendingBatchId = null;
			try {
				_twoPhaseStore = await uploadBatchesStoreFromSfConnection(req.sf.conn, req.sf.sfUserId, req.sf.sfOrgId, { sessionId: req.session && req.session.id });
				const prior = await _twoPhaseStore.findByAttemptId(_attemptId);
				if (prior && prior.status === 'uploaded') {
					return res.json({
						results: (prior.insertedIds || []).map((i) => ({ success: true, tempId: i.tempId, id: i.sfId, objectName: i.objectName, mode: i.mode === 'update' ? 'update' : 'create' })),
						deletes: (prior.deletedIds || []).map((d) => ({ success: true, tempId: d.tempId, id: d.sfId, objectName: d.objectName })),
						instanceUrl: req.sf.conn.instanceUrl,
						batchId: prior.id,
						canonicalValues: {},
						idempotentReplay: true,
					});
				}
				if (prior && prior.status === 'pending') {
					return res.status(409).json({
						error: 'upload-attempt-incomplete',
						batchId: prior.id,
						message: UPLOAD_ATTEMPT_UNCERTAIN_MESSAGE,
					});
				}
			} catch (e) {
				return _rejectUploadLedgerUnavailable(res, e, 'rest-prepare');
			}

			// Resolve workspace for audit attribution.
			const view = await viewStateDb.get(req.account.id);
			const workspaceId = view && view.current_workspace_id;
			if (!workspaceId) {
return res.status(409).json({ error: 'no-active-workspace' });
}

			// Monthly upload cap via the quota registry (skipped for
			// directUpload - that's the unlimited Quick Upload path).
			// Canvas-standalone's default no-cap quota provider always
			// returns blocked=false so self-hosters are never gated here.
			if (!directUpload) {
				const uploadQuota = await ext.getQuota(req.account, 'uploads');
				if (uploadQuota.blocked) {
					return res.status(402).json({
						error: 'upload-cap-reached',
						message: "You've used " + uploadQuota.used + ' of your ' + uploadQuota.cap + ' monthly uploads on the ' + uploadQuota.planLabel + ' plan. Upgrade for unlimited uploads, or wait for the cap to reset.',
						uploadsUsed: uploadQuota.used,
						uploadCap: uploadQuota.cap,
						currentPlan: uploadQuota.planId,
					});
				}
			}

			// Record the two-phase INTENT row only after every validation
			// early-return above has passed - i.e. immediately before work
			// that can actually commit to Salesforce. Writing it any
			// earlier leaks a permanently-'pending' row when a request is
			// refused (no workspace, quota cap), and a later retry with the
			// same attemptId would then be refused with
			// upload-attempt-incomplete even though nothing ever committed.
			try {
				const pendingB = await _twoPhaseStore.createPending({
					source: directUpload ? 'csv-direct' : 'canvas',
					note: (req.body && typeof req.body.note === 'string') ? req.body.note : null,
					attemptId: _attemptId,
					intendedRecords: records.map((r) => ({ tempId: r.tempId, objectName: r.objectName })),
				});
				_pendingBatchId = pendingB.id;
			} catch (e) {
				return _rejectUploadLedgerUnavailable(res, e, 'rest-intent');
			}

			const conn = req.sf.conn;
			const recordsById = new Map();
			records.forEach((r) => {
 if (r && r.tempId != null) {
recordsById.set(r.tempId, r);
} 
});
			const { order, cycleIds, deps } = topoSortRecords(records, associations);

			const realIdByTempId = new Map();
			const results = [];
			const getDescribe = makeDescribeCache(conn);
			for (const tempId of order) {
				const rec = recordsById.get(tempId);
				if (!rec || !rec.objectName) {
continue;
}

				if (cycleIds.has(tempId)) {
					results.push({ tempId, objectName: rec.objectName, success: false, error: 'Record is part of a reference cycle - upload it manually or break the cycle.' });
					continue;
				}

				// Unchanged loaded record - register the loadedFromId so
				// dependent children can substitute it in their FK fields,
				// but don't issue the update. Records the result as
				// "unchanged" so the UI can show it distinctly.
				if (skipTempIds.has(tempId) && rec.loadedFromId) {
					realIdByTempId.set(tempId, rec.loadedFromId);
					results.push({ tempId, objectName: rec.objectName, success: true, id: rec.loadedFromId, mode: 'unchanged' });
					continue;
				}

				// Bail if any parent didn't upload successfully.
				let parentFailure = null;
				for (const pid of (deps.get(tempId) || [])) {
					if (!realIdByTempId.has(pid)) {
 parentFailure = pid; break; 
}
				}
				if (parentFailure != null) {
					results.push({ tempId, objectName: rec.objectName, success: false, error: 'Skipped: parent record #' + parentFailure + ' did not upload.' });
					continue;
				}

				const values = normalizeValuesForUpload(rec, tempId, associations, realIdByTempId);

				try {
					const describe = await getDescribe(rec.objectName);
					if (rec.loadedFromId) {
						const cleanValues = stripUnwritableFields(values, describe, true);
						const updatePayload = Object.assign({}, cleanValues, { Id: rec.loadedFromId });
						const sf = await conn.sobject(rec.objectName).update(updatePayload, _writeOpts);
						if (sf && sf.success) {
							realIdByTempId.set(tempId, rec.loadedFromId);
							results.push({ tempId, objectName: rec.objectName, success: true, id: rec.loadedFromId, mode: 'update' });
						} else {
							const msg = (sf && Array.isArray(sf.errors) && sf.errors.length)
								? formatUploadError({ errors: sf.errors })
								: 'Update returned no success';
							results.push({ tempId, objectName: rec.objectName, success: false, error: msg, errorCode: extractUploadErrorCode({ errors: sf && sf.errors }) });
						}
					} else {
						const cleanValues = stripUnwritableFields(values, describe, false);
						const sf = await conn.sobject(rec.objectName).create(cleanValues, _writeOpts);
						if (sf && sf.success) {
							realIdByTempId.set(tempId, sf.id);
							results.push({ tempId, objectName: rec.objectName, success: true, id: sf.id, mode: 'create' });
						} else {
							const msg = (sf && Array.isArray(sf.errors) && sf.errors.length)
								? formatUploadError({ errors: sf.errors })
								: 'Create returned no id';
							results.push({ tempId, objectName: rec.objectName, success: false, error: msg, errorCode: extractUploadErrorCode({ errors: sf && sf.errors }) });
						}
					}
				} catch (err) {
					console.error('[upload] error for', rec.objectName, '#' + tempId, ':', err);
					results.push({ tempId, objectName: rec.objectName, success: false, error: formatUploadError(err), errorCode: extractUploadErrorCode(err) });
				}
			}

			// Keep the response order aligned with the input order so
			// the client can render sensibly (not topo order).
			const byId = new Map(results.map((r) => [r.tempId, r]));
			const orderedResults = records.map((r) => byId.get(r.tempId)).filter(Boolean);

			const successCount = orderedResults.filter((r) => r && r.success).length;
			const mutationSuccessCount = _countCommittedMutations(orderedResults);
			const failureCount = orderedResults.length - successCount;

			// Deletes pass - runs AFTER creates/updates. Each entry is
			// independent; jsforce's per-record .delete() call fires a
			// DELETE /services/data/vXX.X/sobjects/{name}/{id} verb.
			// Per-record error capture so a single bad id (already
			// deleted, no CRUD permission, locked) doesn't block the
			// rest of the batch. The deletes lane intentionally does
			// NOT participate in the upload-cap counter (cap is a
			// monthly write-cap, deletes are net-negative changes
			// we don't want to discourage with a counter).
			const deleteResults = [];
			for (const d of deletesIn) {
				if (!d || !d.sfId || !d.objectName) {
					deleteResults.push({
						tempId: d && d.tempId,
						sfId: d && d.sfId,
						objectName: d && d.objectName,
						success: false,
						error: 'Missing sfId or objectName.',
					});
					continue;
				}
				try {
					const sf = await conn.sobject(d.objectName).delete(d.sfId);
					if (sf && sf.success) {
						deleteResults.push({
							tempId: d.tempId || null,
							sfId: d.sfId,
							objectName: d.objectName,
							success: true,
							mode: 'delete',
						});
					} else {
						const errMsg = sf && sf.errors && sf.errors.length
							? sf.errors.map((e) => e.message || e.errorCode).join('; ')
							: 'Salesforce refused the delete (no error message returned).';
						deleteResults.push({
							tempId: d.tempId || null,
							sfId: d.sfId,
							objectName: d.objectName,
							success: false,
							error: errMsg,
						});
					}
				} catch (err) {
					deleteResults.push({
						tempId: d.tempId || null,
						sfId: d.sfId,
						objectName: d.objectName,
						success: false,
						error: (err && err.message) || String(err),
					});
				}
			}
			const deleteSuccessCount = deleteResults.filter((r) => r.success).length;
			const deleteFailureCount = deleteResults.length - deleteSuccessCount;

			// Usage counter - only successful uploads count, and only
			// non-direct uploads count toward the monthly cap.
			if (!directUpload && mutationSuccessCount > 0) {
				try {
					await ext.chargeQuota(req.account, 'uploads', 1);
				} catch (e) {
 console.warn('[usage] upload increment failed:', e.message || e); 
}
			}

			// Audit log: one correlation id for the whole upload action, a
			// per-record row for each write, then a summary row. The
			// per-record rows give the trail forensic granularity (which
			// records were created/updated/failed and why); the shared
			// request_id lets the Activity tab fold them into one
			// collapsible group under the summary. Summary is written LAST
			// so it's the most-recent row in the group - the UI uses that
			// as the group's parent header. All fire-and-forget.
			try {
				const uploadRequestId = auditDb.newRequestId();
				const objects = Array.from(new Set(records.map((r) => r && r.objectName).filter(Boolean)));
				// Keep per-record rows sequential so display ordering and the
				// request-group summary remain deterministic.
				for (const r of orderedResults) {
					if (!r) {
continue;
}
					await ext.auditWrite({
						req,
						workspaceId,
						action: 'record_upserted',
						targetObject: r.objectName || null,
						targetId: r.success ? (r.id || null) : null,
						targetSfOrgId: req.sf.sfOrgId,
						requestId: uploadRequestId,
						status: r.success ? 'ok' : 'failed',
						errorCode: r.success ? null : 'sf-write-failed',
						payload: {
							tempId: r.tempId != null ? r.tempId : null,
							mode: r.mode || (r.success ? 'create' : null),
						},
					});
				}
				// Per-delete audit rows. action='record_deleted' is the
				// destructive counterpart to record_upserted above -
				// keeps the activity log explicit about destructive vs.
				// constructive intent so trail consumers can filter on
				// it. Status reflects per-row SF outcome.
				for (const d of deleteResults) {
					if (!d) {
continue;
}
					await ext.auditWrite({
						req,
						workspaceId,
						action: 'record_deleted',
						targetObject: d.objectName || null,
						targetId: d.sfId || null,
						targetSfOrgId: req.sf.sfOrgId,
						requestId: uploadRequestId,
						status: d.success ? 'ok' : 'failed',
						errorCode: d.success ? null : 'sf-delete-failed',
						payload: {
							tempId: d.tempId != null ? d.tempId : null,
						},
					});
				}
				const uploadObjectBreakdown = {};
				const uploadErrorCodes = {};
				for (const r of orderedResults) {
					if (!r) {
						continue;
					}
					const rec = recordsById && r.tempId != null ? recordsById.get(r.tempId) : null;
					const obj = (rec && rec.objectName) || r.objectName || 'unknown';
					const bucket = uploadObjectBreakdown[obj] || (uploadObjectBreakdown[obj] = { created: 0, updated: 0, unchanged: 0, failed: 0 });
					if (!r.success) {
						bucket.failed += 1;
						const code = (r.errorCode || 'sf-write-failed').toString();
						uploadErrorCodes[code] = (uploadErrorCodes[code] || 0) + 1;
						continue;
					}
					const mode = r.mode || 'create';
					if (mode === 'update') {
						bucket.updated += 1;
					} else if (mode === 'unchanged') {
						bucket.unchanged += 1;
					} else {
						bucket.created += 1;
					}
				}
				for (const d of deleteResults) {
					if (!d) {
						continue;
					}
					const obj = d.objectName || 'unknown';
					const bucket = uploadObjectBreakdown[obj] || (uploadObjectBreakdown[obj] = { created: 0, updated: 0, unchanged: 0, failed: 0, deleted: 0 });
					if (d.success) {
						bucket.deleted = (bucket.deleted || 0) + 1;
					} else {
						bucket.failed += 1;
						uploadErrorCodes['sf-delete-failed'] = (uploadErrorCodes['sf-delete-failed'] || 0) + 1;
					}
				}
				const uploadAssocCounts = {};
				for (const a of associations || []) {
					if (!a || !a.fieldName) {
						continue;
					}
					uploadAssocCounts[a.fieldName] = (uploadAssocCounts[a.fieldName] || 0) + 1;
				}
				await ext.auditWrite({
					req,
					workspaceId,
					action: 'upload',
					targetObject: objects.length === 1 ? objects[0] : null,
					targetSfOrgId: req.sf.sfOrgId,
					requestId: uploadRequestId,
					payload: {
						objects,
						successCount,
						mutationSuccessCount,
						failureCount,
						deleteSuccessCount,
						deleteFailureCount,
						requested: records.length,
						requestedDeletes: deletesIn.length,
						directUpload,
						// Duplicate-rule override used - auditable so an admin
						// can see which uploads bypassed alert-severity rules.
						allowDuplicates: allowDuplicates || undefined,
						objectBreakdown: uploadObjectBreakdown,
						errorCodeCounts: Object.keys(uploadErrorCodes).length ? uploadErrorCodes : undefined,
						associations: Object.keys(uploadAssocCounts).length ? uploadAssocCounts : undefined,
					},
				});
				// Funnel telemetry - first successful upload for this
				// account counts as the "user actually pushed data to
				// Salesforce" conversion. Only fires when at least one
				// record made it to SF (zero successes = not a real
				// conversion); idempotent thereafter.
				if (mutationSuccessCount > 0) {
					auditDb.recordFirstTime(req, {
						actorAccountId: req.account.id,
						action: 'records_first_upload',
						workspaceId,
						targetSfOrgId: req.sf.sfOrgId,
						payload: { successCount: mutationSuccessCount, objects },
					}).catch(() => {});
				}
			} catch (e) {
 console.warn('[audit] upload log failed:', e.message || e); 
}

			// Persist the batch for the recall flow. Successful inserts
			// AND successful deletes get recorded - deletes are NOT
			// recall-able (the SF recycle-bin recovery path is the
			// user's only undo), but the ledger still tracks them so
			// the History view can render an accurate audit trail.
			let batchId = null;
			// Post-upload re-query for canonical post-trigger values. Runs
			// AFTER SF accepts the commit and BEFORE the batch ledger gets
			// persisted, so the ledger's uploadedValues is what SF
			// actually stored (trigger output) rather than what we sent.
			// Returns an empty map on failure - _buildBatchEntryFromResult
			// falls back to the client-sent values for any tempId not
			// in the map.
			let canonicalByTempId;
			try {
				canonicalByTempId = await _fetchCanonicalValuesForUpload({
					conn,
					results: orderedResults,
					recordsById,
				});
			} catch (e) {
				console.warn('[upload] canonical re-query failed:', e.message || e);
				canonicalByTempId = new Map();
			}
			const successfulDeletes = deleteResults.filter((d) => d && d.success);
			if (mutationSuccessCount > 0 || successfulDeletes.length > 0) {
				try {
					const insertedIds = orderedResults
						.filter((r) => r && r.success && r.id && r.mode !== 'unchanged')
						.map((r) => _buildBatchEntryFromResult(r, recordsById.get(r.tempId), canonicalByTempId.get(r.tempId)));
					const deletedIds = successfulDeletes.map((d) => ({
						tempId: d.tempId,
						sfId: d.sfId,
						objectName: d.objectName,
					}));
					if (insertedIds.length > 0 || deletedIds.length > 0) {
						const batchStore = _twoPhaseStore || await uploadBatchesStoreFromSfConnection(req.sf.conn, req.sf.sfUserId, req.sf.sfOrgId, { sessionId: req.session && req.session.id });
						const _assoc = associations.map((a) => ({
							fromTempId: a.fromId,
							toTempId: a.toId,
							fieldName: a.fieldName,
						}));
						if (_pendingBatchId) {
							await batchStore.finalize(_pendingBatchId, {
								insertedIds,
								deletedIds,
								recordCount: insertedIds.length + deletedIds.length,
								associations: _assoc,
							});
							batchId = _pendingBatchId;
						} else {
							const batch = await batchStore.create({
								source: directUpload ? 'csv-direct' : 'canvas',
								recordCount: insertedIds.length + deletedIds.length,
								note: req.body && typeof req.body.note === 'string' ? req.body.note : null,
								attemptId: null,
								insertedIds,
								deletedIds,
								associations: _assoc,
							});
							batchId = batch.id;
						}
					}
				} catch (e) {
 console.warn('[upload-batches] persist failed:', e.message || e);
}
			}
			// A known zero-commit outcome is terminal, not ambiguous. Mark it
			// failed before optional file cleanup so a ContentDocument delete
			// denial cannot strand this attempt as `pending`.
			if (_pendingBatchId && mutationSuccessCount === 0 && successfulDeletes.length === 0) {
				const firstFailure = orderedResults.find((r) => r && !r.success)
					|| deleteResults.find((r) => r && !r.success);
				await _settleKnownNoCommit(_twoPhaseStore, _pendingBatchId, {
					errorCode: firstFailure && (firstFailure.errorCode || 'sf-write-failed'),
					message: firstFailure && firstFailure.error,
				});
			}

			// canonicalValues: keyed by tempId, holds the post-trigger
			// SF state per uploaded record. Client uses this to patch
			// rec.values + rec.loadedValues so the canvas reflects what
			// SF actually stored (not what was sent). Empty when the
			// re-query failed; client treats missing entries as "no
			// change" and leaves the record's local values alone.
			const canonicalForResponse = {};
			for (const [tempId, info] of canonicalByTempId) {
				canonicalForResponse[tempId] = info.values;
			}
			res.json({
				results: orderedResults,
				deletes: deleteResults,
				instanceUrl: conn.instanceUrl,
				batchId,
				canonicalValues: canonicalForResponse,
			});
		} catch (err) {
 next(err); 
}
	});

	// ===== Upload batches (recall ledger) ==============================

	// POST /api/upload-batches - create a new batch record after a
	// successful upload. The client writes here from the upload
	// confirm flow (see app.js insertedIds construction); the
	// stored row backs the History modal + the Recall action.
	// Workspace + connection scope comes from req.sf / view_state so
	// the client can't spoof ownership.
	app.post('/api/upload-batches', requireAccount, requireSfConnection, async (req, res, next) => {
		try {
			if (!await _gateCapability(req, res, 'upload-records', 'upload_batch_record')) {
return;
}
			const view = await viewStateDb.get(req.account.id);
			const workspaceId = view && view.current_workspace_id;
			if (!workspaceId) {
return res.status(409).json({ error: 'no-active-workspace' });
}
			const { source, recordCount, insertedIds, deletedIds, associations, note } = req.body || {};
			if (!Array.isArray(insertedIds)) {
				return res.status(400).json({ error: 'insertedIds must be an array' });
			}
			const _deletedIds = Array.isArray(deletedIds) ? deletedIds : [];
			const batchStore = await uploadBatchesStoreFromSfConnection(req.sf.conn, req.sf.sfUserId, req.sf.sfOrgId, { sessionId: req.session && req.session.id });
			const created = await batchStore.create({
				source: source || 'canvas',
				recordCount: typeof recordCount === 'number' ? recordCount : insertedIds.length + _deletedIds.length,
				note: note || null,
				insertedIds,
				deletedIds: _deletedIds,
				associations: Array.isArray(associations) ? associations : null,
			});
			try {
				await ext.auditWrite({
					req,
					workspaceId,
					action: 'upload_batch_created',
					targetObject: 'upload_batches',
					targetId: created.id,
					targetSfOrgId: req.sf.sfOrgId,
					payload: { source: source || 'canvas', recordCount: typeof recordCount === 'number' ? recordCount : insertedIds.length },
				});
			} catch (e) { /* audit best-effort */ }
			res.json(created);
		} catch (err) {
 next(err); 
}
	});

	// GET /api/upload-batches - list recent batches for the active
	// (workspace, connection). Paginated via ?limit=N (default 50,
	// max 200).
	app.get('/api/upload-batches', requireAccount, requireSfConnection, async (req, res, next) => {
		try {
			const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
			const batchStore = await uploadBatchesStoreFromSfConnection(req.sf.conn, req.sf.sfUserId, req.sf.sfOrgId, { sessionId: req.session && req.session.id });
			const batches = await batchStore.list({ limit });
			// Store already returns the camelCase shape the modal renders
			// (id, externalId, createdAt, status, source, recordCount,
			// note, recalledAt, sfOrgId).
			res.json({ batches });
		} catch (err) {
 next(err); 
}
	});

	// GET /api/upload-batches/:id - full batch detail (insertedIds +
	// associations). Used by the recall confirmation modal in app.js.
	app.get('/api/upload-batches/:id', requireAccount, requireSfConnection, async (req, res, next) => {
		try {
			const batchStore = await uploadBatchesStoreFromSfConnection(req.sf.conn, req.sf.sfUserId, req.sf.sfOrgId, { sessionId: req.session && req.session.id });
			// store.get returns null when the file doesn't exist OR isn't
			// owned by the caller's SF identity. Either way the client
			// sees the same 404 - SF-layer tenant isolation replaces the
			// pre-cutover connection_id check.
			const batch = await batchStore.get(req.params.id);
			if (!batch) {
return res.status(404).json({ error: 'not-found' });
}
			res.json({ batch });
		} catch (err) {
 next(err); 
}
	});

	// POST /api/upload-batches/:id/recall - actually delete the records.
	// Reverse-FK-order delete (children first, parents last) lives in
	// upload-recall.js. Updates the batch row with the result for
	// audit-trail purposes.
	app.post('/api/upload-batches/:id/recall', requireAccount, requireSfConnection, async (req, res, next) => {
		try {
			if (!await _gateCapability(req, res, 'recall-upload', 'recall_upload', { auditPayload: { batchId: req.params.id } })) {
return;
}
			const batchStore = await uploadBatchesStoreFromSfConnection(req.sf.conn, req.sf.sfUserId, req.sf.sfOrgId, { sessionId: req.session && req.session.id });
			const batch = await batchStore.get(req.params.id);
			if (!batch) {
return res.status(404).json({ error: 'not-found' });
}
			if (batch.recalledAt) {
				return res.status(409).json({ error: 'already-recalled' });
			}
			// Production-org policy check on recall too - deleting
			// from prod is a write operation that should respect the
			// same workspace approval gate as upload.
			const orgGate = await ext.getCapability(req.account, 'connect-sf-org', {
				sfOrgId: req.sf.sfOrgId,
				orgType: req.sf.orgType || 'unknown',
				createPendingOnDeny: true,
				req,
				auditAction: 'upload_recalled',
				auditPayload: { batchId: req.params.id },
			});
			if (!orgGate.allowed) {
				return res.status(403).json({
					error: orgGate.reason,
					approvalStatus: orgGate.approvalStatus,
				});
			}
			// skipSfIds: opt-out list from the client's preflight modal.
			// Two sources today: (1) drifted records the user chose to
			// leave alone (default), (2) already-deleted records the
			// client filters proactively to keep the result tally
			// clean. Was silently dropped pre-fix - the drift-skip
			// feature wasn't actually working server-side.
			const skipSfIds = Array.isArray(req.body && req.body.skipSfIds) ? req.body.skipSfIds.slice() : [];
			// Re-check created-record drift at execution time too. A record
			// that changed after Review was not part of the user's consent and
			// must not be deleted. Conservatively skip newly drifted or
			// unverified rows; the user can reopen Review once SF is stable.
			const executionCreateDrift = await classifyBatchDrift({
				conn: req.sf.conn,
				batch: { insertedIds: batch.insertedIds, associations: batch.associations },
				uploaderSfUserId: req.sf.sfUserId,
				uploadTimeMs: batch.createdAt,
			});
			const skipAtExecution = new Set(skipSfIds.map(String));
			for (const row of [...(executionCreateDrift.drifted || []), ...(executionCreateDrift.unverified || [])]) {
				if (row && row.sfId) {
skipAtExecution.add(String(row.sfId));
}
			}
			skipSfIds.splice(0, skipSfIds.length, ...skipAtExecution);
			// revertSelections: per-record per-field opt-in for the
			// value-revert flow. Shape: [{ sfId, fields: [...] }].
			// Empty / missing → no value reverts attempted (legacy
			// delete-only recall path). The server matches each entry
			// against batch.insertedIds rows of mode='update' carrying
			// priorValues; mismatches are silently ignored - defense
			// against a client that supplied stale or malformed
			// selections.
			const revertSelections = Array.isArray(req.body && req.body.revertSelections)
				? req.body.revertSelections
				: [];
			// Mark in-flight before deletion so the list-view shows
			// "Recalling…" if the user reopens the modal mid-delete.
			try {
 await batchStore.markRecalling(batch.id); 
} catch (_e) { /* best-effort */ }
			let recallResult;
			try {
				recallResult = await executeRecall({
					conn: req.sf.conn,
					batch: {
						insertedIds: batch.insertedIds,
						associations: batch.associations,
					},
					skipSfIds,
					revertSelections,
				});
			} catch (e) {
				console.error('[recall] failed:', e.message || e);
				return res.status(500).json({ error: 'recall-failed', message: e.message });
			}
			// executeRecall returns status that already accounts for the
			// "alreadyDeleted satisfies intent" rule - use it instead of
			// recomputing locally (the local recompute treated already-
			// deleted as failures, giving misleading recall_partial /
			// recall_failed banners on batches where everything had
			// already been cleaned up by hand).
			const succeeded = recallResult.succeeded || 0;
			const alreadyDeleted = recallResult.alreadyDeleted || 0;
			const failed = recallResult.failed || 0;
			const preservedUpdatesCount = recallResult.preservedUpdatesCount || 0;
			const status = recallResult.status || 'recalled';
			try {
 await batchStore.markRecallResult(batch.id, { status, recallResult }); 
} catch (_e) { /* best-effort */ }
			// workspace_id comes from the user's CURRENT view state at
			// recall time (not the upload's original workspace, which we
			// no longer persist). Matches "recall happens in the
			// workspace the user is in right now" - same semantic the
			// audit_log row for the recall action records.
			let _recallWorkspaceId = null;
			try {
				const _view = await viewStateDb.get(req.account.id);
				_recallWorkspaceId = (_view && _view.current_workspace_id) || null;
			} catch (_eVs) { /* leave null */ }
			// Per-object structural breakdown so the SF-side activity log
			// can answer "which objects did this recall touch and how
			// did each one fare?" without paging into the batch ledger.
			const recallObjectBreakdown = {};
			const recallErrorCodes = {};
			for (const r of Array.isArray(recallResult.results) ? recallResult.results : []) {
				if (!r) {
					continue;
				}
				const obj = r.objectName || 'unknown';
				const bucket = recallObjectBreakdown[obj] || (recallObjectBreakdown[obj] = { deleted: 0, alreadyDeleted: 0, failed: 0 });
				if (r.success) {
					if (r.note === 'Already deleted') {
						bucket.alreadyDeleted += 1;
					} else {
						bucket.deleted += 1;
					}
					continue;
				}
				bucket.failed += 1;
				const code = (r.errorCode || 'recall-failed').toString();
				recallErrorCodes[code] = (recallErrorCodes[code] || 0) + 1;
			}
			await ext.auditWrite({
				req,
				workspaceId: _recallWorkspaceId,
				action: 'upload_recalled',
				targetObject: 'upload_batch',
				targetId: batch.id,
				targetSfOrgId: batch.sfOrgId || req.sf.sfOrgId,
				payload: {
					successCount: succeeded,
					alreadyDeletedCount: alreadyDeleted,
					failureCount: failed,
					preservedUpdatesCount,
					revertedCount: recallResult.revertedCount || 0,
					revertFailedCount: recallResult.revertFailedCount || 0,
					revertDriftSkippedCount: recallResult.revertDriftSkippedCount || 0,
					skippedCount: skipSfIds.length,
					status,
					objectBreakdown: recallObjectBreakdown,
					errorCodeCounts: Object.keys(recallErrorCodes).length ? recallErrorCodes : undefined,
				},
			});
			res.json({
				ok: true,
				status,
				successCount: succeeded,
				alreadyDeletedCount: alreadyDeleted,
				failureCount: failed,
				preservedUpdatesCount,
				revertedCount: recallResult.revertedCount || 0,
				revertFailedCount: recallResult.revertFailedCount || 0,
				revertDriftSkippedCount: recallResult.revertDriftSkippedCount || 0,
				revertResults: recallResult.revertResults || [],
				results: recallResult.results,
			});
		} catch (err) {
 next(err); 
}
	});

	// POST /api/upload/graph - Composite Graph upload for small canvases.
	// Atomic per-component: if any sub-request in a connected component
	// fails, the whole component rolls back; siblings stay independent.
	// Caps: 75 records per connected component, 500 total. The frontend
	// prefers this path for canvases under those caps; larger canvases
	// route to /api/upload (REST) or /api/upload/bulk (Bulk API, Slice
	// 5e-follow).
	app.post('/api/upload/graph', requireAccount, requireSfConnection, async (req, res, next) => {
		try {
			if (rejectIfOverPayloadCap(req, res)) {
return;
}
			if (!await _gateCapability(req, res, 'upload-records', 'upload_graph')) {
return;
}

			const orgGate = await ext.getCapability(req.account, 'connect-sf-org', {
				sfOrgId: req.sf.sfOrgId,
				orgType: req.sf.orgType || 'unknown',
				createPendingOnDeny: true,
				req,
				auditAction: 'upload',
				auditPayload: { mode: 'graph' },
			});
			if (!orgGate.allowed) {
				return res.status(403).json({
					error: orgGate.reason,
					approvalStatus: orgGate.approvalStatus,
				});
			}

			const records = Array.isArray(req.body?.records) ? req.body.records : [];
			applySlotFieldFilter(records);
			const associations = Array.isArray(req.body?.associations) ? req.body.associations : [];
			const skipTempIds = new Set(Array.isArray(req.body?.skipTempIds) ? req.body.skipTempIds : []);
			const directUpload = !!req.body?.directUpload;
			// Explicit duplicate-rule override (client's "Upload anyway"
			// after DUPLICATES_DETECTED). Sets the SF duplicate-rule header
			// on the graph request so ALERT-severity rules record their
			// alert but accept the save, matching what a user could do in
			// the SF UI. BLOCK-severity rules ignore allowSave and still
			// reject, preserving the org admin's intent.
			const allowDuplicates = !!req.body?.allowDuplicates;
			// Pending-delete records. Composite Graph doesn't accept DELETE
			// in the same payload as creates/updates; the graph node
			// schema is for upsert verbs only. We execute deletes
			// sequentially AFTER the graph commits (or skip them if the
			// graph rolls back), ordered children-first so parent deletes
			// never hit restrict-lookup / cascade surprises.
			const deletesIn = _orderDeletesChildrenFirst(
				Array.isArray(req.body?.deletes) ? req.body.deletes : [],
				associations,
			);
			if (records.length === 0 && deletesIn.length === 0) {
				return res.status(400).json({ error: 'no-records' });
			}

			// Two-phase ledger + server-side idempotency (attemptId). The
			// client sends a stable attemptId per upload attempt:
			//  - prior batch already 'uploaded' under this id → replay its
			//    result, skip the commit entirely (idempotent retry).
			//  - prior attempt still 'pending' (committed-but-not-finalized,
			//    or crashed mid-commit) → refuse rather than risk a duplicate.
			//  - otherwise record the INTENT now, BEFORE the commit, so a
			//    committed batch is never left entirely unrecorded (which is
			//    what made a lost-response retry duplicate).
			const _attemptId = _requireUploadAttemptId(req, res);
			if (!_attemptId) {
				return;
			}
			if (!_claimUploadAttempt(req, res, _attemptId)) {
				return res.status(409).json({
					error: 'upload-attempt-in-progress',
					message: 'This upload attempt is already running. Wait for it to finish, then reconcile before retrying.',
				});
			}
			let _twoPhaseStore = null;
			let _pendingBatchId = null;
			try {
				_twoPhaseStore = await uploadBatchesStoreFromSfConnection(req.sf.conn, req.sf.sfUserId, req.sf.sfOrgId, { sessionId: req.session && req.session.id });
				const prior = await _twoPhaseStore.findByAttemptId(_attemptId);
				if (prior && prior.status === 'uploaded') {
					return res.json({
						results: (prior.insertedIds || []).map((i) => ({ success: true, tempId: i.tempId, id: i.sfId, objectName: i.objectName, mode: i.mode === 'update' ? 'update' : 'create' })),
						deletes: (prior.deletedIds || []).map((d) => ({ success: true, tempId: d.tempId, id: d.sfId, objectName: d.objectName })),
						instanceUrl: req.sf.conn.instanceUrl,
						mode: 'graph',
						atomicSuccess: true,
						batchId: prior.id,
						canonicalValues: {},
						idempotentReplay: true,
					});
				}
				if (prior && prior.status === 'pending') {
					return res.status(409).json({
						error: 'upload-attempt-incomplete',
						batchId: prior.id,
						message: UPLOAD_ATTEMPT_UNCERTAIN_MESSAGE,
					});
				}
			} catch (e) {
				return _rejectUploadLedgerUnavailable(res, e, 'graph-prepare');
			}

			const view = await viewStateDb.get(req.account.id);
			const workspaceId = view && view.current_workspace_id;
			if (!workspaceId) {
return res.status(409).json({ error: 'no-active-workspace' });
}
			// Monthly upload cap via the quota registry: the SAME source
			// the REST path checks and ext.chargeQuota increments. The
			// previous direct plan+usageDb read was a separate source of
			// truth that could disagree with the registry (and always
			// diverged in canvas-standalone, where the registry's no-cap
			// default is the intended behavior).
			if (!directUpload) {
				const uploadQuota = await ext.getQuota(req.account, 'uploads');
				if (uploadQuota.blocked) {
					return res.status(402).json({
						error: 'upload-cap-reached',
						message: "You've used " + uploadQuota.used + ' of your ' + uploadQuota.cap + ' monthly uploads on the ' + uploadQuota.planLabel + ' plan. Upgrade for unlimited uploads, or wait for the cap to reset.',
						uploadsUsed: uploadQuota.used,
						uploadCap: uploadQuota.cap,
						currentPlan: uploadQuota.planId,
					});
				}
			}

			const conn = req.sf.conn;
			const apiVersion = conn.version || '60.0';
			const apiBase = '/services/data/v' + apiVersion;
			const getDescribe = makeDescribeCache(conn);

			const recordsById = new Map();
			records.forEach((r) => {
 if (r && r.tempId != null) {
recordsById.set(r.tempId, r);
} 
});
			const { order, cycleIds } = topoSortRecords(records, associations);

			// Records to actually submit through Composite Graph: skip
			// cycles (rolled back per-component is the wrong semantic
			// for an unresolvable cycle) and unchanged-loaded records
			// (their loadedFromId substitutes directly without a SF
			// call). Both surface in the response with appropriate
			// modes.
			const submittedIds = new Set();
			for (const id of order) {
				if (cycleIds.has(id)) {
continue;
}
				const rec = recordsById.get(id);
				if (!rec || !rec.objectName) {
continue;
}
				if (skipTempIds.has(id) && rec.loadedFromId) {
continue;
}
				submittedIds.add(id);
			}

			const components = groupConnectedComponents(submittedIds, order, associations);
			const maxComponentSize = components.reduce((m, c) => Math.max(m, c.length), 0);
			if (maxComponentSize > GRAPH_PER_GRAPH_CAP) {
				return res.status(400).json({
					error: 'graph-component-too-large',
					message: 'A connected record component exceeds ' + GRAPH_PER_GRAPH_CAP + ' nodes; fall back to REST or Bulk.',
				});
			}
			const totalSubmitted = components.reduce((n, c) => n + c.length, 0);
			if (totalSubmitted > GRAPH_TOTAL_NODES_CAP) {
				return res.status(400).json({
					error: 'graph-total-too-large',
					message: 'Total nodes exceed ' + GRAPH_TOTAL_NODES_CAP + '; fall back to REST or Bulk.',
				});
			}

			// Record the two-phase INTENT row only after every validation
			// early-return has passed, critically AFTER the size-cap
			// rejections above. Those 400s tell the client to retry the
			// SAME attemptId via REST/Bulk; a pending row written before
			// them would make that documented fallback land on
			// upload-attempt-incomplete (409) even though nothing committed.
			try {
				const pendingB = await _twoPhaseStore.createPending({
					source: directUpload ? 'csv-direct' : 'canvas-graph',
					note: (req.body && typeof req.body.note === 'string') ? req.body.note : null,
					attemptId: _attemptId,
					intendedRecords: records.map((r) => ({ tempId: r.tempId, objectName: r.objectName })),
				});
				_pendingBatchId = pendingB.id;
			} catch (e) {
				return _rejectUploadLedgerUnavailable(res, e, 'graph-intent');
			}

			// Pre-fetch describes for every object we'll write so the
			// per-record build stays sync.
			const objNamesToDescribe = new Set();
			submittedIds.forEach((id) => {
				const rec = recordsById.get(id);
				if (rec && rec.objectName) {
objNamesToDescribe.add(rec.objectName);
}
			});
			const describesByObject = new Map();
			for (const name of objNamesToDescribe) {
				try {
					describesByObject.set(name, await getDescribe(name));
				} catch (err) {
					// Per-object describe failure during upload prep is
					// usually a real signal (auth expired, FLS revoked,
					// custom object dropped); report it so a sustained
					// regression is visible. The loop continues without
					// the describe; the downstream upload may still
					// succeed for objects whose describes did load.
					try {
						ext.captureException(err, {
							where: 'canvas-routes/upload/buildDescribesMap',
							objectName: name,
						});
					} catch (_) { /* never break the upload prep on a telemetry failure */ }
				}
			}

			const graphsPayload = components.map((tempIds, i) => ({
				graphId: 'g' + i,
				compositeRequest: tempIds.map((tempId) => buildGraphSubRequest({
					rec: recordsById.get(tempId),
					tempId,
					apiBase,
					associations,
					submittedIds,
					recordsById,
					describesByObject,
				})),
			}));

			let graphResp;
			try {
				graphResp = await conn.request({
					method: 'POST',
					url: apiBase + '/composite/graph',
					body: JSON.stringify({ graphs: graphsPayload }),
					headers: Object.assign(
						{ 'Content-Type': 'application/json' },
						// Top-level header applies to every subrequest in the
						// graph call. Alert-rules save (with the alert
						// recorded); block-rules still reject.
						allowDuplicates ? { 'Sforce-Duplicate-Rule-Header': 'allowSave=true' } : {},
					),
				});
			} catch (err) {
				console.error('[upload/graph] failed:', err && (err.errorCode || err.message));
				try {
					await ext.auditWrite({
						req,
						workspaceId,
						action: 'upload',
						targetSfOrgId: req.sf.sfOrgId,
						status: 'failed',
						errorCode: 'graph-upload-failed',
						payload: { mode: 'graph', requested: records.length },
					});
				} catch (e) {
 console.warn('[audit] graph error log failed:', e.message || e); 
}
				// The request crossed the pre-commit intent boundary, but the
				// transport did not provide a trustworthy Graph result. Keep the
				// row pending and surface the same reconciliation guard used by a
				// retry. Automatically falling through to REST here could duplicate
				// records if Salesforce committed before the response was lost.
				return res.status(409).json({
					error: 'upload-attempt-incomplete',
					batchId: _pendingBatchId,
					results: [],
					message: UPLOAD_ATTEMPT_UNCERTAIN_MESSAGE,
					cause: (err && err.message) || 'Composite Graph upload failed.',
				});
			}

			const respGraphs = (graphResp && graphResp.graphs) || [];
			const results = [];

			// Cycle records → failure rows.
			cycleIds.forEach((id) => {
				const rec = recordsById.get(id);
				if (rec) {
					results.push({
						tempId: id,
						objectName: rec.objectName,
						success: false,
						error: 'Record is part of a reference cycle; break the cycle and re-upload.',
					});
				}
			});
			// Unchanged-loaded records → mode 'unchanged'.
			skipTempIds.forEach((id) => {
				if (cycleIds.has(id)) {
return;
}
				const rec = recordsById.get(id);
				if (!rec || !rec.loadedFromId) {
return;
}
				results.push({
					tempId: id,
					objectName: rec.objectName,
					success: true,
					id: rec.loadedFromId,
					mode: 'unchanged',
				});
			});

			let allAtomicSuccess = respGraphs.length > 0;
			respGraphs.forEach((respGraph) => {
				const graphId = respGraph && respGraph.graphId;
				const isSuccessful = !!(respGraph && respGraph.isSuccessful);
				if (!isSuccessful) {
allAtomicSuccess = false;
}
				const responses = (respGraph && respGraph.graphResponse && respGraph.graphResponse.compositeResponse) || [];
				const componentIdx = typeof graphId === 'string' && graphId.startsWith('g')
					? parseInt(graphId.slice(1), 10) : NaN;
				const componentTempIds = (Number.isInteger(componentIdx) && components[componentIdx]) || [];
				const tempIdByRefId = new Map();
				componentTempIds.forEach((tempId) => tempIdByRefId.set(graphRefIdFor(tempId), tempId));

				responses.forEach((r) => {
					if (!r || !r.referenceId) {
return;
}
					const tempId = tempIdByRefId.get(r.referenceId);
					if (tempId == null) {
return;
}
					const rec = recordsById.get(tempId);
					if (!rec) {
return;
}
					const status = r.httpStatusCode || 0;
					if (isSuccessful) {
						const isUpdate = !!rec.loadedFromId;
						const id = isUpdate ? rec.loadedFromId : (r.body && r.body.id) || null;
						results.push({ tempId, objectName: rec.objectName, success: true, id, mode: isUpdate ? 'update' : 'create' });
						return;
					}
					if (status < 400) {
						results.push({
							tempId,
							objectName: rec.objectName,
							success: false,
							error: 'Rolled back: another record in the same component failed.',
						});
						return;
					}
					const bodies = Array.isArray(r.body) ? r.body : (r.body ? [r.body] : []);
					if (bodies.length === 0) {
						results.push({ tempId, objectName: rec.objectName, success: false, error: 'HTTP ' + status });
						return;
					}
					bodies.forEach((b) => {
						results.push({
							tempId,
							objectName: rec.objectName,
							success: false,
							error: (b && b.message) || ('HTTP ' + status),
							errorCode: b && b.errorCode,
							fields: Array.isArray(b && b.fields) ? b.fields : [],
						});
					});
				});
			});

			const byId = new Map(results.map((r) => [r.tempId, r]));
			const orderedResults = records.map((r) => byId.get(r.tempId)).filter(Boolean);
			const successCount = orderedResults.filter((r) => r && r.success).length;
			const mutationSuccessCount = _countCommittedMutations(orderedResults);

			if (!directUpload && mutationSuccessCount > 0) {
				try {
 await ext.chargeQuota(req.account, 'uploads', 1); 
} catch (e) {
 console.warn('[usage]:', e.message || e); 
}
			}
			// Deletes pass: runs AFTER the graph commits. Composite
			// Graph is upsert-only, so deletes go through sequential
			// jsforce calls. We only execute deletes if at least one
			// graph component committed (atomicSuccess OR partial-
			// success); if everything rolled back we skip deletes too
			// (the user's intent was "do everything I queued" and
			// "everything" is gone). Per-record error capture so a
			// single bad id (already deleted, permission denied) doesn't
			// poison the rest of the batch.
			const deleteResults = [];
			const someGraphCommitted = mutationSuccessCount > 0;
			if (deletesIn.length > 0 && (records.length === 0 || someGraphCommitted)) {
				for (const d of deletesIn) {
					if (!d || !d.sfId || !d.objectName) {
						deleteResults.push({
							tempId: d && d.tempId,
							sfId: d && d.sfId,
							objectName: d && d.objectName,
							success: false,
							error: 'Missing sfId or objectName.',
						});
						continue;
					}
					try {
						const sf = await conn.sobject(d.objectName).delete(d.sfId);
						if (sf && sf.success) {
							deleteResults.push({
								tempId: d.tempId || null,
								sfId: d.sfId,
								objectName: d.objectName,
								success: true,
								mode: 'delete',
							});
						} else {
							const errMsg = sf && sf.errors && sf.errors.length
								? sf.errors.map((e) => e.message || e.errorCode).join('; ')
								: 'Salesforce refused the delete.';
							deleteResults.push({
								tempId: d.tempId || null,
								sfId: d.sfId,
								objectName: d.objectName,
								success: false,
								error: errMsg,
							});
						}
					} catch (err) {
						deleteResults.push({
							tempId: d.tempId || null,
							sfId: d.sfId,
							objectName: d.objectName,
							success: false,
							error: (err && err.message) || String(err),
						});
					}
				}
			} else if (deletesIn.length > 0) {
				// Graph rolled back entirely + deletes queued: mark each
				// delete skipped so the response shape stays consistent
				// (client renders each row as "skipped: graph rollback").
				for (const d of deletesIn) {
					deleteResults.push({
						tempId: (d && d.tempId) || null,
						sfId: (d && d.sfId) || null,
						objectName: (d && d.objectName) || null,
						success: false,
						error: 'Skipped: the creates/updates phase rolled back, so deletes were not attempted.',
					});
				}
			}
			const deleteSuccessCount = deleteResults.filter((r) => r.success).length;
			const deleteFailureCount = deleteResults.length - deleteSuccessCount;

			try {
				// Per-record audit rows + a summary, all sharing one
				// request_id so the Activity tab folds them into a single
				// collapsible group. This is the primary canvas upload path
				// (composite graph), so the grouping that the Activity UI
				// supports actually fires here. Summary written last → it's
				// the group's parent header.
				const uploadRequestId = auditDb.newRequestId();
				const objects = Array.from(new Set(records.map((r) => r && r.objectName).filter(Boolean)));
				for (const r of orderedResults) {
					if (!r) {
continue;
}
					await ext.auditWrite({
						req,
						workspaceId,
						action: 'record_upserted',
						targetObject: r.objectName || null,
						targetId: r.success ? (r.id || null) : null,
						targetSfOrgId: req.sf.sfOrgId,
						requestId: uploadRequestId,
						status: r.success ? 'ok' : 'failed',
						errorCode: r.success ? null : (r.errorCode || 'sf-write-failed'),
						payload: {
							tempId: r.tempId != null ? r.tempId : null,
							mode: r.mode || (r.success ? 'create' : null),
						},
					});
				}
				// Per-delete audit rows under the same request_id so the
				// activity group shows the full intent (creates + deletes)
				// together.
				for (const d of deleteResults) {
					if (!d) {
continue;
}
					await ext.auditWrite({
						req,
						workspaceId,
						action: 'record_deleted',
						targetObject: d.objectName || null,
						targetId: d.sfId || null,
						targetSfOrgId: req.sf.sfOrgId,
						requestId: uploadRequestId,
						status: d.success ? 'ok' : 'failed',
						errorCode: d.success ? null : 'sf-delete-failed',
						payload: {
							tempId: d.tempId != null ? d.tempId : null,
						},
					});
				}
				const graphObjectBreakdown = {};
				const graphErrorCodes = {};
				for (const r of orderedResults) {
					if (!r) {
						continue;
					}
					const rec = recordsById && r.tempId != null ? recordsById.get(r.tempId) : null;
					const obj = (rec && rec.objectName) || r.objectName || 'unknown';
					const bucket = graphObjectBreakdown[obj] || (graphObjectBreakdown[obj] = { created: 0, updated: 0, unchanged: 0, failed: 0 });
					if (!r.success) {
						bucket.failed += 1;
						const code = (r.errorCode || 'sf-write-failed').toString();
						graphErrorCodes[code] = (graphErrorCodes[code] || 0) + 1;
						continue;
					}
					const mode = r.mode || 'create';
					if (mode === 'update') {
						bucket.updated += 1;
					} else if (mode === 'unchanged') {
						bucket.unchanged += 1;
					} else {
						bucket.created += 1;
					}
				}
				for (const d of deleteResults) {
					if (!d) {
						continue;
					}
					const obj = d.objectName || 'unknown';
					const bucket = graphObjectBreakdown[obj] || (graphObjectBreakdown[obj] = { created: 0, updated: 0, unchanged: 0, failed: 0, deleted: 0 });
					if (d.success) {
						bucket.deleted = (bucket.deleted || 0) + 1;
					} else {
						bucket.failed += 1;
						graphErrorCodes['sf-delete-failed'] = (graphErrorCodes['sf-delete-failed'] || 0) + 1;
					}
				}
				const graphAssocCounts = {};
				for (const a of associations || []) {
					if (!a || !a.fieldName) {
						continue;
					}
					graphAssocCounts[a.fieldName] = (graphAssocCounts[a.fieldName] || 0) + 1;
				}
				await ext.auditWrite({
					req,
					workspaceId,
					action: 'upload',
					targetObject: objects.length === 1 ? objects[0] : null,
					targetSfOrgId: req.sf.sfOrgId,
					requestId: uploadRequestId,
					payload: {
						mode: 'graph',
						objects,
						successCount,
						mutationSuccessCount,
						failureCount: orderedResults.length - successCount,
						deleteSuccessCount,
						deleteFailureCount,
						requested: records.length,
						requestedDeletes: deletesIn.length,
						directUpload,
						atomicSuccess: allAtomicSuccess,
						// Duplicate-rule override used, auditable so an admin
						// can see WHICH uploads bypassed alert-severity rules.
						allowDuplicates: allowDuplicates || undefined,
						objectBreakdown: graphObjectBreakdown,
						errorCodeCounts: Object.keys(graphErrorCodes).length ? graphErrorCodes : undefined,
						associations: Object.keys(graphAssocCounts).length ? graphAssocCounts : undefined,
					},
				});
			} catch (e) {
 console.warn('[audit]:', e.message || e); 
}

			let batchId = null;
			// See /api/upload's matching block for rationale on the
			// post-upload re-query. Same shape, same fallback.
			let canonicalByTempId;
			try {
				canonicalByTempId = await _fetchCanonicalValuesForUpload({
					conn,
					results: orderedResults,
					recordsById,
				});
			} catch (e) {
				console.warn('[upload/graph] canonical re-query failed:', e.message || e);
				canonicalByTempId = new Map();
			}
			const successfulDeletes = deleteResults.filter((d) => d && d.success);
			if (mutationSuccessCount > 0 || successfulDeletes.length > 0) {
				try {
					const insertedIds = orderedResults
						.filter((r) => r && r.success && r.id && r.mode !== 'unchanged')
						.map((r) => _buildBatchEntryFromResult(r, recordsById.get(r.tempId), canonicalByTempId.get(r.tempId)));
					const deletedIds = successfulDeletes.map((d) => ({
						tempId: d.tempId,
						sfId: d.sfId,
						objectName: d.objectName,
					}));
					if (insertedIds.length > 0 || deletedIds.length > 0) {
						const batchStore = _twoPhaseStore || await uploadBatchesStoreFromSfConnection(req.sf.conn, req.sf.sfUserId, req.sf.sfOrgId, { sessionId: req.session && req.session.id });
						const _assoc = associations.map((a) => ({
							fromTempId: a.fromId,
							toTempId: a.toId,
							fieldName: a.fieldName,
						}));
						if (_pendingBatchId) {
							// Phase 2: flip the pre-commit intent to 'uploaded'
							// with the real SF ids.
							await batchStore.finalize(_pendingBatchId, {
								insertedIds,
								deletedIds,
								recordCount: insertedIds.length + deletedIds.length,
								associations: _assoc,
							});
							batchId = _pendingBatchId;
						} else {
							// No attemptId (older client): single-phase write.
							const batch = await batchStore.create({
								source: directUpload ? 'csv-direct' : 'canvas-graph',
								recordCount: insertedIds.length + deletedIds.length,
								note: req.body && typeof req.body.note === 'string' ? req.body.note : null,
								attemptId: null,
								insertedIds,
								deletedIds,
								associations: _assoc,
							});
							batchId = batch.id;
						}
					}
				} catch (e) {
 console.warn('[upload-batches]:', e.message || e);
}
			}
			// A Graph response that reports zero committed mutations is a known
			// rollback, not an uncertain attempt. Settle it terminal before
			// optional cleanup. Unchanged loaded records are deliberately not
			// counted as commits.
			if (_pendingBatchId && mutationSuccessCount === 0 && successfulDeletes.length === 0) {
				const firstFailure = orderedResults.find((r) => r && !r.success)
					|| deleteResults.find((r) => r && !r.success);
				await _settleKnownNoCommit(_twoPhaseStore, _pendingBatchId, {
					errorCode: firstFailure && (firstFailure.errorCode || 'graph-rolled-back'),
					message: firstFailure && firstFailure.error,
				});
			}

			const canonicalForResponse = {};
			for (const [tempId, info] of canonicalByTempId) {
				canonicalForResponse[tempId] = info.values;
			}
			res.json({
				results: orderedResults,
				deletes: deleteResults,
				instanceUrl: conn.instanceUrl,
				mode: 'graph',
				atomicSuccess: allAtomicSuccess,
				graphCount: graphsPayload.length,
				batchId,
				canonicalValues: canonicalForResponse,
			});
		} catch (err) {
 next(err); 
}
	});

	// POST /api/upload/preflight - dry-run a sample through Composite
	// Graph to surface validation rule / FLS / trigger errors before
	// the user clicks Upload. Records that succeed are immediately
	// deleted via composite/sobjects DELETE so the dry-run leaves no
	// residue. The first NEW record per object type seeds the sample;
	// ancestors are walked in to keep FK chains intact.
	app.post('/api/upload/preflight', requireAccount, requireSfConnection, async (req, res, next) => {
		try {
			if (rejectIfOverPayloadCap(req, res)) {
return;
}
			if (!await _gateCapability(req, res, 'upload-records', 'upload_preflight')) {
return;
}
			const orgGate = await ext.getCapability(req.account, 'connect-sf-org', {
				sfOrgId: req.sf.sfOrgId,
				orgType: req.sf.orgType || 'unknown',
				createPendingOnDeny: true,
				req,
				auditAction: 'preflight',
			});
			if (!orgGate.allowed) {
				return res.status(403).json({ error: orgGate.reason, approvalStatus: orgGate.approvalStatus });
			}
			const records = Array.isArray(req.body?.records) ? req.body.records : [];
			// Same slot-field filter every real upload path applies; the
			// dry-run must validate exactly what the actual upload will
			// send, or its pass/fail diverges on slot-restricted canvases.
			applySlotFieldFilter(records);
			const associations = Array.isArray(req.body?.associations) ? req.body.associations : [];
			if (records.length === 0) {
				return res.json({ ok: true, sampled: 0, total: 0, skipped: true });
			}

			const conn = req.sf.conn;
			const apiVersion = conn.version || '60.0';
			const apiBase = '/services/data/v' + apiVersion;
			const FAKE_REF_ID = '001000000000001';

			const recordsById = new Map();
			records.forEach((r) => {
 if (r && r.tempId != null) {
recordsById.set(r.tempId, r);
} 
});

			const deps = new Map();
			recordsById.forEach((_, id) => deps.set(id, new Set()));
			associations.forEach((a) => {
				if (!a) {
return;
}
				if (deps.has(a.fromId) && recordsById.has(a.toId)) {
deps.get(a.fromId).add(a.toId);
}
			});

			// Sample: first NEW record per object type; pull ancestors
			// so every in-sample FK either points inside the sample or
			// at a record with a real loadedFromId.
			const sampleIds = new Set();
			const seenObjs = new Set();
			for (const r of records) {
				if (!r || !r.objectName || r.loadedFromId) {
continue;
}
				if (seenObjs.has(r.objectName)) {
continue;
}
				seenObjs.add(r.objectName);
				sampleIds.add(r.tempId);
			}
			function pullAncestors(id) {
				for (const p of (deps.get(id) || new Set())) {
					const parentRec = recordsById.get(p);
					if (!parentRec || parentRec.loadedFromId || sampleIds.has(p)) {
continue;
}
					sampleIds.add(p);
					pullAncestors(p);
				}
			}
			Array.from(sampleIds).forEach(pullAncestors);
			if (sampleIds.size === 0) {
				return res.json({ ok: true, sampled: 0, total: records.length, skipped: true });
			}

			// Sample cap (60, with 15-node headroom against the 75-per-
			// component limit). Trim leaves first so deeper chains stay
			// representative.
			const SAMPLE_CAP = 60;
			let sampleArr = records.filter((r) => sampleIds.has(r.tempId));
			if (sampleArr.length > SAMPLE_CAP) {
				const reverseDeps = new Map();
				associations.forEach((a) => {
					if (!a || !sampleIds.has(a.toId) || !sampleIds.has(a.fromId)) {
return;
}
					let s = reverseDeps.get(a.toId);
					if (!s) {
 s = new Set(); reverseDeps.set(a.toId, s); 
}
					s.add(a.fromId);
				});
				const dropped = new Set();
				while (sampleArr.length - dropped.size > SAMPLE_CAP) {
					const leaf = sampleArr.find((r) => !dropped.has(r.tempId) && !(reverseDeps.get(r.tempId) || new Set()).size);
					if (!leaf) {
break;
}
					dropped.add(leaf.tempId);
					(deps.get(leaf.tempId) || new Set()).forEach((parentId) => {
						const s = reverseDeps.get(parentId);
						if (s) {
s.delete(leaf.tempId);
}
					});
				}
				sampleArr = sampleArr.filter((r) => !dropped.has(r.tempId));
			}

			const sampleSet = new Set(sampleArr.map((r) => r.tempId));
			const order = [];
			const visited = new Set();
			const stack = new Set();
			let cycleDetected = false;
			(function topo() {
				function visit(id) {
					if (visited.has(id)) {
return;
}
					if (stack.has(id)) {
 cycleDetected = true; return; 
}
					stack.add(id);
					(deps.get(id) || []).forEach((p) => {
 if (sampleSet.has(p)) {
visit(p);
} 
});
					stack.delete(id);
					visited.add(id);
					order.push(id);
				}
				sampleArr.forEach((r) => visit(r.tempId));
			})();
			if (cycleDetected) {
				return res.json({
					ok: false,
					errors: [{ message: 'Reference cycle detected in sample. Break the cycle and try again.' }],
					sampled: sampleArr.length,
				});
			}
			const orderedSample = order.map((id) => recordsById.get(id)).filter(Boolean);

			const refIdFor = (tempId) => 'r' + String(tempId).replace(/[^a-zA-Z0-9]/g, '_');
			const compositeRequest = orderedSample.map((rec) => {
				const values = Object.assign({}, rec.values || {});
				Object.keys(values).forEach((k) => {
 if (values[k] === FAKE_REF_ID) {
delete values[k];
} 
});
				Object.keys(values).forEach((k) => {
					if (typeof values[k] === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(values[k])) {
						values[k] = values[k] + ':00.000Z';
					}
				});
				Object.keys(values).forEach((k) => {
					if (!k.endsWith('Code')) {
return;
}
					if (values[k] == null || values[k] === '') {
return;
}
					const textField = k.slice(0, -'Code'.length);
					if (Object.prototype.hasOwnProperty.call(values, textField)) {
delete values[textField];
}
				});
				associations.forEach((a) => {
					if (a.fromId !== rec.tempId) {
return;
}
					if (sampleSet.has(a.toId)) {
						values[a.fieldName] = '@{' + refIdFor(a.toId) + '.id}';
					} else {
						const parent = recordsById.get(a.toId);
						if (parent && parent.loadedFromId) {
values[a.fieldName] = parent.loadedFromId;
}
					}
				});
				return {
					method: 'POST',
					url: apiBase + '/sobjects/' + rec.objectName,
					referenceId: refIdFor(rec.tempId),
					body: values,
				};
			});

			let graphResp;
			try {
				graphResp = await conn.request({
					method: 'POST',
					url: apiBase + '/composite/graph',
					body: JSON.stringify({ graphs: [{ graphId: 'preflight', compositeRequest }] }),
					headers: { 'Content-Type': 'application/json' },
				});
			} catch (err) {
				console.error('[preflight] graph failed:', err && (err.errorCode || err.message));
				return res.json({
					ok: false,
					errors: [{ message: (err && err.message) || 'Pre-flight check failed.' }],
					sampled: orderedSample.length,
				});
			}

			const graph = (graphResp && graphResp.graphs && graphResp.graphs[0]) || null;
			const responses = (graph && graph.graphResponse && graph.graphResponse.compositeResponse) || [];
			const isSuccessful = !!(graph && graph.isSuccessful);

			if (isSuccessful) {
				const createdIds = responses.map((r) => r && r.body && r.body.id).filter(Boolean);
				if (createdIds.length > 0) {
					try {
						const idsParam = encodeURIComponent(createdIds.join(','));
						await conn.request({
							method: 'DELETE',
							url: apiBase + '/composite/sobjects?ids=' + idsParam + '&allOrNone=false',
						});
					} catch (delErr) {
						console.warn('[preflight] cleanup delete failed (non-fatal):', delErr && delErr.message);
					}
				}
				try {
					await ext.auditWrite({
						req,
						action: 'preflight',
						targetSfOrgId: req.sf.sfOrgId,
						payload: { sampled: orderedSample.length, total: records.length },
					});
				} catch (e) {
 console.warn('[audit]:', e.message || e); 
}
				return res.json({ ok: true, sampled: orderedSample.length, total: records.length });
			}

			const tempIdByRefId = new Map();
			orderedSample.forEach((r) => tempIdByRefId.set(refIdFor(r.tempId), r.tempId));
			const errors = [];
			responses.forEach((r) => {
				if (!r || !r.referenceId) {
return;
}
				const tempId = tempIdByRefId.get(r.referenceId);
				const rec = tempId != null ? recordsById.get(tempId) : null;
				const status = r.httpStatusCode || 0;
				if (status < 400) {
return;
}
				const bodies = Array.isArray(r.body) ? r.body : (r.body ? [r.body] : []);
				bodies.forEach((b) => {
					errors.push({
						recordId: tempId != null ? tempId : null,
						objectName: rec ? rec.objectName : null,
						recordLabel: rec ? ((rec.label || rec.objectName) + ' #' + rec.tempId) : 'Unknown record',
						fields: Array.isArray(b && b.fields) ? b.fields : [],
						errorCode: b && b.errorCode,
						message: (b && b.message) || ('HTTP ' + status),
					});
				});
			});
			if (errors.length === 0) {
				errors.push({ message: 'Pre-flight failed but Salesforce returned no error detail.' });
			}
			try {
				await ext.auditWrite({
					req,
					action: 'preflight',
					targetSfOrgId: req.sf.sfOrgId,
					payload: {
							sampled: orderedSample.length,
							total: records.length,
							errorCount: errors.length,
						},
				});
			} catch (e) {
 console.warn('[audit]:', e.message || e); 
}
			res.json({ ok: false, errors, sampled: orderedSample.length });
		} catch (err) {
 next(err); 
}
	});

	// POST /api/upload/bulk: Bulk API v2 path for >2k records.
	// Streams progress via SSE; level-by-level execution so parents
	// land before children that reference them. One job per
	// (level, operation, objectName).
	app.post('/api/upload/bulk', requireAccount, requireSfConnection, async (req, res, next) => {
		try {
			if (rejectIfOverPayloadCap(req, res)) {
return;
}
			if (!await _gateCapability(req, res, 'upload-records', 'upload_bulk')) {
return;
}
			const orgGate = await ext.getCapability(req.account, 'connect-sf-org', {
				sfOrgId: req.sf.sfOrgId,
				orgType: req.sf.orgType || 'unknown',
				createPendingOnDeny: true,
				req,
				auditAction: 'upload_bulk',
			});
			if (!orgGate.allowed) {
				return res.status(403).json({ error: orgGate.reason, approvalStatus: orgGate.approvalStatus });
			}
			const records = Array.isArray(req.body?.records) ? req.body.records : [];
			applySlotFieldFilter(records);
			const associations = Array.isArray(req.body?.associations) ? req.body.associations : [];
			const skipTempIds = new Set(Array.isArray(req.body?.skipTempIds) ? req.body.skipTempIds : []);
			const directUpload = !!req.body?.directUpload;
			// Pending deletes ride the same payload shape as REST/graph,
			// ordered children-first server-side. The bulk route previously
			// ignored `deletes` entirely; the modal showed "Will delete N"
			// and nothing happened. Executed per-record after the insert/
			// update levels (delete volume is small; no Bulk-API job needed).
			const deletesIn = _orderDeletesChildrenFirst(
				Array.isArray(req.body?.deletes) ? req.body.deletes : [],
				associations,
			);
			// Delete-only submissions are legal (e.g. >150-record canvas
			// where the only pending changes are deletions).
			if (records.length === 0 && deletesIn.length === 0) {
				return res.status(400).json({ error: 'no-records' });
			}

			// Quick Upload may perform an app-generated WHERE lookup before an
			// External ID upsert so it can apply create-vs-update FLS correctly.
			// Validate every submitted key before creating the upload ledger or
			// switching the response to SSE. The browser picker is constrained,
			// but this server check also covers stale and forged payloads.
			const conn = req.sf.conn;
			const getDescribe = makeDescribeCache(conn);
			for (const rec of records) {
				if (!rec || rec._csvOperation !== 'upsert') {
					continue;
				}
				const objectName = String(rec.objectName || '').trim();
				const externalIdField = String(rec._csvExternalIdField || '').trim();
				if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(objectName)) {
					return res.status(400).json({ error: 'invalid-object-name' });
				}
				if (!externalIdField) {
					return res.status(400).json({
						error: 'upsert-external-id-required',
						message: 'Choose an External ID field for every upsert file.',
					});
				}
				const describe = await getDescribe(objectName);
				const fieldCheck = validateSoqlFilterField(describe, externalIdField, {
					requireExternalId: true,
				});
				if (!fieldCheck.ok || fieldCheck.field.createable !== true) {
					const reason = fieldCheck.ok ? 'field-not-createable' : fieldCheck.reason;
					return res.status(400).json({
						error: 'invalid-upsert-external-id-field',
						reason,
						field: externalIdField,
						objectName,
						message: fieldCheck.ok
							? (fieldCheck.field.label || externalIdField) + ' is not createable for this Salesforce user.'
							: fieldCheck.message,
					});
				}
				// Use the canonical describe name downstream rather than retaining
				// a caller-provided spelling.
				rec._csvExternalIdField = fieldCheck.field.name;
			}

			// Cap check BEFORE flipping headers to SSE: once we set
			// text/event-stream the client's fetch sees status 200 + a
			// body, not the 402 we want. Pre-flight in regular JSON.
			const view = await viewStateDb.get(req.account.id);
			const workspaceId = view && view.current_workspace_id;
			if (!workspaceId) {
return res.status(409).json({ error: 'no-active-workspace' });
}
			// Monthly upload cap via the quota registry: same source as the
			// REST + graph paths (see the graph route's note on why the old
			// direct plan+usageDb read was a divergent source of truth).
			if (!directUpload) {
				const uploadQuota = await ext.getQuota(req.account, 'uploads');
				if (uploadQuota.blocked) {
					return res.status(402).json({
						error: 'upload-cap-reached',
						message: "You've used " + uploadQuota.used + ' of your ' + uploadQuota.cap + ' monthly uploads on the ' + uploadQuota.planLabel + ' plan. Upgrade for unlimited uploads, or wait for the cap to reset.',
						uploadsUsed: uploadQuota.used,
						uploadCap: uploadQuota.cap,
						currentPlan: uploadQuota.planId,
					});
				}
			}

			// Two-phase ledger (phase 1: record intent before the Bulk job).
			// Bulk streams its result over SSE, so the cross-attempt idempotency
			// REPLAY is not done here (the client reconcile covers a dropped Bulk
			// stream). We guarantee durability: a committed Bulk batch is recorded
			// with its attemptId BEFORE the job runs, then finalized after.
			const _attemptId = _requireUploadAttemptId(req, res);
			if (!_attemptId) {
				return;
			}
			if (!_claimUploadAttempt(req, res, _attemptId)) {
				return res.status(409).json({
					error: 'upload-attempt-in-progress',
					message: 'This upload attempt is already running. Wait for it to finish, then reconcile before retrying.',
				});
			}
			let _twoPhaseStore = null;
			let _pendingBatchId = null;
			try {
				_twoPhaseStore = await uploadBatchesStoreFromSfConnection(req.sf.conn, req.sf.sfUserId, req.sf.sfOrgId, { sessionId: req.session && req.session.id });
			} catch (e) {
				return _rejectUploadLedgerUnavailable(res, e, 'bulk-prepare');
			}
			if (_twoPhaseStore) {
				// Duplicate-attempt guard (JSON, pre-SSE). Without this, a
				// retry with the same attemptId after a dropped stream (
				// while the FIRST job is still running or already committed
				// ) would launch a SECOND full Bulk job and duplicate every
				// record that landed the first time. We can't replay results
				// over SSE the way REST/graph do in JSON, so refuse instead;
				// the client's catch runs reconcileLostUpload, which matches
				// this attemptId's batch and recovers whatever committed.
				try {
					const prior = await _twoPhaseStore.findByAttemptId(_attemptId);
					if (prior && (prior.status === 'uploaded' || prior.status === 'pending')) {
						return res.status(409).json({
							error: 'upload-attempt-incomplete',
							batchId: prior.id,
							status: prior.status,
							message: prior.status === 'uploaded'
								? 'This upload attempt already completed. Refresh to reconcile the results.'
								: UPLOAD_ATTEMPT_UNCERTAIN_MESSAGE,
						});
					}
				} catch (e) {
					return _rejectUploadLedgerUnavailable(res, e, 'bulk-lookup');
				}
				try {
					const pendingB = await _twoPhaseStore.createPending({
						source: directUpload ? 'csv-bulk' : 'canvas-bulk',
						note: (req.body && typeof req.body.note === 'string') ? req.body.note : null,
						attemptId: _attemptId,
						intendedRecords: records.map((r) => ({ tempId: r.tempId, objectName: r.objectName })),
					});
					_pendingBatchId = pendingB.id;
				} catch (e) {
					return _rejectUploadLedgerUnavailable(res, e, 'bulk-intent');
				}
			}
						res.setHeader('Content-Type', 'text/event-stream');
			res.setHeader('Cache-Control', 'no-cache, no-transform');
			res.setHeader('Connection', 'keep-alive');
			res.setHeader('X-Accel-Buffering', 'no');
			res.flushHeaders();

			const send = (event, data) => {
				res.write('event: ' + event + '\n');
				res.write('data: ' + JSON.stringify(data) + '\n\n');
			};

			const apiVersion = conn.version || '60.0';
			const apiBase = '/services/data/v' + apiVersion;
			const FAKE_REF_ID = '001000000000001';

			const recordsById = new Map();
			records.forEach((r) => {
 if (r && r.tempId != null) {
recordsById.set(r.tempId, r);
} 
});

			const deps = new Map();
			recordsById.forEach((_, id) => deps.set(id, new Set()));
			associations.forEach((a) => {
				if (!a) {
return;
}
				if (deps.has(a.fromId) && recordsById.has(a.toId)) {
deps.get(a.fromId).add(a.toId);
}
			});

			// Compute level per tempId. A record's level is
			// max(parent level) + 1; loadedFromId parents don't count
			// (already in SF). Cycles → mark every member, not just
			// the back-edge.
			const levelByTempId = new Map();
			const cycleIds = new Set();
			function computeLevel(id, stackSet, stackArr) {
				if (levelByTempId.has(id)) {
return levelByTempId.get(id);
}
				if (stackSet.has(id)) {
					const entry = stackArr.indexOf(id);
					for (let i = entry; i < stackArr.length; i++) {
cycleIds.add(stackArr[i]);
}
					return 0;
				}
				stackSet.add(id);
				stackArr.push(id);
				let lvl = 0;
				for (const parentId of (deps.get(id) || [])) {
					const parent = recordsById.get(parentId);
					if (!parent || parent.loadedFromId) {
continue;
}
					const parentLvl = computeLevel(parentId, stackSet, stackArr);
					if (parentLvl + 1 > lvl) {
lvl = parentLvl + 1;
}
				}
				stackSet.delete(id);
				stackArr.pop();
				levelByTempId.set(id, lvl);
				return lvl;
			}
			recordsById.forEach((_, id) => computeLevel(id, new Set(), []));

			// Group by level → (operation + externalIdFieldName) →
			// objectName. Operation resolution priority:
			//   1. Record-level _csvOperation hint (set by Quick Upload
			//      from per-file operation picker). Honored for
			//      'insert' | 'update' | 'upsert'.
			//   2. Fallback: loadedFromId presence → 'update' (canvas-
			//      edited record going back to SF), otherwise 'insert'.
			// For upsert, _csvExternalIdField on the record names the
			// External Id field: records sharing the same (objectName,
			// upsert, externalIdField) go in one Bulk API job.
			const byLevel = new Map();
			recordsById.forEach((rec, tempId) => {
				if (cycleIds.has(tempId)) {
return;
}
				if (skipTempIds.has(tempId) && rec.loadedFromId) {
return;
}
				const level = levelByTempId.get(tempId) || 0;
				let operation;
				let externalIdFieldName = null;
				if (rec._csvOperation === 'upsert' && rec._csvExternalIdField) {
					operation = 'upsert';
					externalIdFieldName = rec._csvExternalIdField;
				} else if (rec._csvOperation === 'update' || rec._csvOperation === 'insert') {
					operation = rec._csvOperation;
				} else {
					operation = rec.loadedFromId ? 'update' : 'insert';
				}
				const key = operation + '|' + (externalIdFieldName || '') + '|' + rec.objectName;
				let levelMap = byLevel.get(level);
				if (!levelMap) {
 levelMap = new Map(); byLevel.set(level, levelMap); 
}
				let group = levelMap.get(key);
				if (!group) {
					group = { operation, objectName: rec.objectName, externalIdFieldName, records: [] };
					levelMap.set(key, group);
				}
				group.records.push(rec);
			});
			const orderedLevels = Array.from(byLevel.keys()).sort((a, b) => a - b);

			const sfIdByTempId = new Map();
			const failedTempIds = new Set();
			const allResults = [];

			const unchangedCount = Array.from(skipTempIds).filter((id) => {
				const r = recordsById.get(id);
				return r && r.loadedFromId;
			}).length;
			send('start', {
				totalRecords: records.length,
				unchangedCount,
				willUploadCount: records.length - unchangedCount - cycleIds.size,
				totalLevels: orderedLevels.length,
				levels: orderedLevels.map((lvl) => ({
					level: lvl,
					groups: Array.from(byLevel.get(lvl).values()).map((g) => ({
						objectName: g.objectName,
						operation: g.operation,
						count: g.records.length,
					})),
				})),
			});

			cycleIds.forEach((id) => {
				const rec = recordsById.get(id);
				if (!rec) {
return;
}
				failedTempIds.add(id);
				allResults.push({
					tempId: id,
					objectName: rec.objectName,
					success: false,
					error: 'Record is part of a reference cycle; break the cycle and re-upload.',
				});
			});
			skipTempIds.forEach((id) => {
				const rec = recordsById.get(id);
				if (!rec || !rec.loadedFromId) {
return;
}
				sfIdByTempId.set(id, rec.loadedFromId);
				allResults.push({
					tempId: id,
					objectName: rec.objectName,
					success: true,
					id: rec.loadedFromId,
					mode: 'unchanged',
				});
			});

			try {
				for (const level of orderedLevels) {
					const groups = Array.from(byLevel.get(level).values());
					send('level-start', {
						level,
						groups: groups.map((g) => ({ objectName: g.objectName, operation: g.operation, count: g.records.length })),
					});

					const jobPromises = groups.map(async (group) => {
						const runnable = [];
						const skippedDueToParent = [];
						for (const rec of group.records) {
							let parentFailed = false;
							for (const pid of (deps.get(rec.tempId) || [])) {
								if (failedTempIds.has(pid)) {
 parentFailed = true; break; 
}
							}
							if (parentFailed) {
skippedDueToParent.push(rec);
} else {
runnable.push(rec);
}
						}
						skippedDueToParent.forEach((rec) => {
							failedTempIds.add(rec.tempId);
							allResults.push({
								tempId: rec.tempId,
								objectName: rec.objectName,
								success: false,
								error: 'Skipped: a parent record did not upload.',
							});
						});

						const describe = await getDescribe(group.objectName);
						// Upsert rows need per-outcome FLS filtering. A field can be
						// createable but not updateable (for example a required lookup
						// whose reparenting is disabled). Resolve the submitted external
						// keys first so new rows keep createable fields while matches keep
						// only updateable fields.
						const existingUpsertKeys = new Set();
						if (group.operation === 'upsert') {
							const fieldCheck = validateSoqlFilterField(describe, group.externalIdFieldName, {
								requireExternalId: true,
							});
							if (!fieldCheck.ok) {
								throw new Error(fieldCheck.message);
							}
							const field = fieldCheck.field.name;
							group.externalIdFieldName = field;
							const keys = Array.from(new Set(runnable
								.map((rec) => rec.values && rec.values[field])
								.filter((value) => value !== undefined && value !== null && value !== '')
								.map(String)));
							for (let offset = 0; offset < keys.length; offset += 200) {
								const inList = keys.slice(offset, offset + 200)
									.map((value) => "'" + escapeSoqlLiteral(value) + "'")
									.join(',');
								const found = await conn.query(
									'SELECT ' + field + ' FROM ' + group.objectName +
									' WHERE ' + field + ' IN (' + inList + ')',
								);
								(found.records || []).forEach((record) => {
									if (record[field] !== undefined && record[field] !== null) {
										existingUpsertKeys.add(String(record[field]));
									}
								});
							}
						}
						const jobInputs = runnable.map((rec) => {
							let values = Object.assign({}, rec.values || {});
							Object.keys(values).forEach((k) => {
 if (values[k] === FAKE_REF_ID) {
delete values[k];
} 
});
							Object.keys(values).forEach((k) => {
								if (typeof values[k] === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(values[k])) {
									values[k] = values[k] + ':00.000Z';
								}
							});
							Object.keys(values).forEach((k) => {
								if (!k.endsWith('Code')) {
return;
}
								if (values[k] == null || values[k] === '') {
return;
}
								const textField = k.slice(0, -'Code'.length);
								if (Object.prototype.hasOwnProperty.call(values, textField)) {
delete values[textField];
}
							});
							// stripUnwritableFields uses updateable vs createable
							// based on the second arg. Upsert can hit either
							// branch per row (update if external id matches,
							// insert if not), but we can't know upfront: use
							// updateable since it's the more restrictive of
							// the two for almost every field (a field
							// createable-but-not-updateable is rare; the
							// reverse is the FLS shape). Result: an upsert
							// row that ends up inserting may include a
							// field that's createable-only and SF will
							// accept; an upsert row that updates will skip
							// non-updateable fields cleanly.
							const upsertMatchesExisting = group.operation === 'upsert' &&
								existingUpsertKeys.has(String(values[group.externalIdFieldName]));
							values = stripUnwritableFields(values, describe,
								group.operation === 'update' || upsertMatchesExisting);
							associations.forEach((a) => {
								if (a.fromId !== rec.tempId) {
return;
}
								const parent = recordsById.get(a.toId);
								if (!parent) {
return;
}
								if (parent.loadedFromId) {
values[a.fieldName] = parent.loadedFromId;
} else if (sfIdByTempId.has(a.toId)) {
values[a.fieldName] = sfIdByTempId.get(a.toId);
}
							});
							if (group.operation === 'update' && rec.loadedFromId) {
values.Id = rec.loadedFromId;
}
							return { tempId: rec.tempId, values };
						});
						if (jobInputs.length === 0) {
return;
}

						const cols = new Set();
						jobInputs.forEach((j) => Object.keys(j.values).forEach((k) => cols.add(k)));
						const columns = Array.from(cols);

						const result = await runBulkJob({
							conn,
							apiBase,
							objectName: group.objectName,
							operation: group.operation,
							records: jobInputs,
							columns,
							externalIdFieldName: group.externalIdFieldName || undefined,
							onEvent: (ev) => send('job-event', ev),
						});
						result.successes.forEach((s) => {
							sfIdByTempId.set(s.tempId, s.sfId);
							// Mode determination:
							//   update  → always 'update'
							//   insert  → always 'create'
							//   upsert  → 'create' if SF's sf__Created="true"
							//             (Bulk API per-row idempotency flag,
							//             surfaced by runBulkJob as s.created),
							//             'update' if it matched an existing
							//             record. Critical for recall safety:
							//             without this, every upsert is stored
							//             as mode='create' and an upsert that
							//             only updated a pre-existing record
							//             would be wrongly delete-recalled.
							let resolvedMode;
							if (group.operation === 'update') {
								resolvedMode = 'update';
							} else if (group.operation === 'upsert') {
								resolvedMode = s.created === true ? 'create' : 'update';
							} else {
								resolvedMode = 'create';
							}
							allResults.push({
								tempId: s.tempId,
								objectName: group.objectName,
								success: true,
								id: s.sfId,
								mode: resolvedMode,
							});
						});
						result.failures.forEach((f) => {
							if (f.tempId != null) {
failedTempIds.add(f.tempId);
}
							allResults.push({
								tempId: f.tempId,
								objectName: group.objectName,
								success: false,
								error: f.error,
							});
						});
					});
					await Promise.all(jobPromises);
					send('level-done', { level });
				}

				const byId = new Map();
				allResults.forEach((r) => {
 if (r.tempId != null) {
byId.set(r.tempId, r);
} 
});
				const orderedResults = records.map((r) => byId.get(r.tempId)).filter(Boolean);
				allResults.forEach((r) => {
 if (r.tempId == null) {
orderedResults.push(r);
} 
});

				// Deletes lane, same semantics as the REST path: per-record
				// DELETE after every insert/update level has finished,
				// children-first order (pre-sorted above), per-record error
				// capture so one bad id doesn't block the rest.
				const deleteResults = [];
				for (const d of deletesIn) {
					if (!d || !d.sfId || !d.objectName) {
						deleteResults.push({
							tempId: d && d.tempId,
							sfId: d && d.sfId,
							objectName: d && d.objectName,
							success: false,
							error: 'Missing sfId or objectName.',
						});
						continue;
					}
					try {
						const sf = await conn.sobject(d.objectName).delete(d.sfId);
						if (sf && sf.success) {
							deleteResults.push({
								tempId: d.tempId || null,
								sfId: d.sfId,
								objectName: d.objectName,
								success: true,
								mode: 'delete',
							});
						} else {
							const errMsg = sf && sf.errors && sf.errors.length
								? sf.errors.map((e) => e.message || e.errorCode).join('; ')
								: 'Salesforce refused the delete.';
							deleteResults.push({
								tempId: d.tempId || null,
								sfId: d.sfId,
								objectName: d.objectName,
								success: false,
								error: errMsg,
							});
						}
					} catch (err) {
						deleteResults.push({
							tempId: d.tempId || null,
							sfId: d.sfId,
							objectName: d.objectName,
							success: false,
							error: (err && err.message) || String(err),
						});
					}
				}
				const deleteSuccessCount = deleteResults.filter((r) => r.success).length;
				const deleteFailureCount = deleteResults.length - deleteSuccessCount;

				// Re-query post-trigger values BEFORE the complete event
				// so the client receives both halves in one shot. Same
				// pattern as /api/upload and /api/upload/graph; same
				// fallback on failure.
				let canonicalByTempId;
				try {
					canonicalByTempId = await _fetchCanonicalValuesForUpload({
						conn,
						results: orderedResults,
						recordsById,
					});
				} catch (e) {
					console.warn('[upload/bulk] canonical re-query failed:', e.message || e);
					canonicalByTempId = new Map();
				}
				const canonicalForResponse = {};
				for (const [tempId, info] of canonicalByTempId) {
					canonicalForResponse[tempId] = info.values;
				}

				send('complete', {
					results: orderedResults,
					deletes: deleteResults,
					instanceUrl: conn.instanceUrl,
					canonicalValues: canonicalForResponse,
				});

				const successCount = orderedResults.filter((r) => r && r.success).length;
				const mutationSuccessCount = _countCommittedMutations(orderedResults);
				if (!directUpload && mutationSuccessCount > 0) {
					try {
 await ext.chargeQuota(req.account, 'uploads', 1); 
} catch (e) {
 console.warn('[usage]:', e.message || e); 
}
				}
				try {
					// Per-record rows + summary sharing one request_id, so the
					// Activity tab folds a bulk upload into one collapsible
					// group (same treatment as the graph/simple paths). Runs
					// after send('complete'): the client already has results,
					// so the extra inserts don't delay the user.
					const uploadRequestId = auditDb.newRequestId();
					const objects = Array.from(new Set(records.map((r) => r && r.objectName).filter(Boolean)));
					for (const r of orderedResults) {
						if (!r) {
continue;
}
						await ext.auditWrite({
							req,
							workspaceId,
							action: 'record_upserted',
							targetObject: r.objectName || null,
							targetId: r.success ? (r.id || null) : null,
							targetSfOrgId: req.sf.sfOrgId,
							requestId: uploadRequestId,
							status: r.success ? 'ok' : 'failed',
							errorCode: r.success ? null : 'sf-write-failed',
							payload: {
								tempId: r.tempId != null ? r.tempId : null,
								mode: r.mode || (r.success ? 'create' : null),
							},
						});
					}
					// Per-delete audit rows under the same request_id,
					// mirrors the REST/graph paths so the Activity group
					// shows the full intent (writes + deletes) together.
					for (const d of deleteResults) {
						if (!d) {
							continue;
						}
						await ext.auditWrite({
							req,
							workspaceId,
							action: 'record_deleted',
							targetObject: d.objectName || null,
							targetId: d.sfId || null,
							targetSfOrgId: req.sf.sfOrgId,
							requestId: uploadRequestId,
							status: d.success ? 'ok' : 'failed',
							errorCode: d.success ? null : 'sf-delete-failed',
							payload: {
								tempId: d.tempId != null ? d.tempId : null,
							},
						});
					}
					// Per-object structural breakdown: counts only, never
					// the underlying field values. The aggregate object
					// names + create/update/failed counts are already
					// visible to SF admins running SOQL on the customer's
					// own records, so surfacing them in the audit row
					// adds no new disclosure while making the activity
					// log a useful operational artifact.
					const objectBreakdown = {};
					const errorCodeCounts = {};
					const associationCounts = {};
					for (const r of orderedResults) {
						if (!r) {
							continue;
						}
						const rec = recordsById && r.tempId != null ? recordsById.get(r.tempId) : null;
						const objName = (rec && rec.objectName) || r.objectName || 'unknown';
						const bucket = objectBreakdown[objName] || (objectBreakdown[objName] = { created: 0, updated: 0, unchanged: 0, failed: 0 });
						if (!r.success) {
							bucket.failed += 1;
							const code = (r.errorCode || 'sf-write-failed').toString();
							errorCodeCounts[code] = (errorCodeCounts[code] || 0) + 1;
							continue;
						}
						const mode = r.mode || 'create';
						if (mode === 'update') {
							bucket.updated += 1;
						} else if (mode === 'unchanged') {
							bucket.unchanged += 1;
						} else {
							bucket.created += 1;
						}
					}
					for (const a of associations || []) {
						if (!a || !a.fieldName) {
							continue;
						}
						associationCounts[a.fieldName] = (associationCounts[a.fieldName] || 0) + 1;
					}
					await ext.auditWrite({
						req,
						workspaceId,
						action: 'upload_bulk',
						targetObject: objects.length === 1 ? objects[0] : null,
						targetSfOrgId: req.sf.sfOrgId,
						requestId: uploadRequestId,
						payload: {
							objects,
							successCount,
							mutationSuccessCount,
							failureCount: orderedResults.length - successCount,
							deleteSuccessCount,
							deleteFailureCount,
							requested: records.length,
							requestedDeletes: deletesIn.length,
							directUpload,
							objectBreakdown,
							errorCodeCounts: Object.keys(errorCodeCounts).length ? errorCodeCounts : undefined,
							associations: Object.keys(associationCounts).length ? associationCounts : undefined,
						},
					});
				} catch (e) {
 console.warn('[audit]:', e.message || e); 
}

				const successfulDeletes = deleteResults.filter((d) => d && d.success);
				if (mutationSuccessCount > 0 || successfulDeletes.length > 0) {
					try {
						const insertedIds = orderedResults
							.filter((r) => r && r.success && r.id && r.mode !== 'unchanged')
							.map((r) => _buildBatchEntryFromResult(r, recordsById.get(r.tempId), canonicalByTempId.get(r.tempId)));
						const deletedIds = successfulDeletes.map((d) => ({
							tempId: d.tempId,
							sfId: d.sfId,
							objectName: d.objectName,
						}));
						if (insertedIds.length > 0 || deletedIds.length > 0) {
							const batchStore = _twoPhaseStore || await uploadBatchesStoreFromSfConnection(req.sf.conn, req.sf.sfUserId, req.sf.sfOrgId, { sessionId: req.session && req.session.id });
								const _assoc = associations.map((a) => ({ fromTempId: a.fromId, toTempId: a.toId, fieldName: a.fieldName }));
								if (_pendingBatchId) {
									await batchStore.finalize(_pendingBatchId, { insertedIds, deletedIds, recordCount: insertedIds.length + deletedIds.length, associations: _assoc });
								} else {
									await batchStore.create({
										source: directUpload ? 'csv-bulk' : 'canvas-bulk',
										recordCount: insertedIds.length + deletedIds.length,
										note: req.body && typeof req.body.note === 'string' ? req.body.note : null,
										attemptId: null,
										insertedIds,
										deletedIds,
										associations: _assoc,
									});
								}
						}
					} catch (e) {
 console.warn('[upload-batches]:', e.message || e);
}
				}
				// The Bulk job completed and reported zero committed mutations, so
				// this is a known no-commit result. Fatal/transport exceptions still
				// bypass this block and deliberately retain `pending` because their
				// outcome may be partial.
				if (_pendingBatchId && mutationSuccessCount === 0 && successfulDeletes.length === 0) {
					const firstFailure = orderedResults.find((r) => r && !r.success)
						|| deleteResults.find((r) => r && !r.success);
					await _settleKnownNoCommit(_twoPhaseStore, _pendingBatchId, {
						errorCode: firstFailure && (firstFailure.errorCode || 'bulk-write-failed'),
						message: firstFailure && firstFailure.error,
					});
				}
			} catch (err) {
				console.error('[upload/bulk] fatal:', err);
				send('error', { message: (err && err.message) || 'Bulk upload failed.' });
				try {
					await ext.auditWrite({
						req,
						workspaceId,
						action: 'upload_bulk',
						targetSfOrgId: req.sf.sfOrgId,
						status: 'failed',
						errorCode: 'bulk-upload-failed',
						payload: { requested: records.length },
					});
				} catch (e) {
 console.warn('[audit]:', e.message || e); 
}
			} finally {
				res.end();
			}
		} catch (err) {
 next(err); 
}
	});

	// POST /api/upload-batches/:id/recall-preflight
	// Dry-run that surfaces "this record was already deleted" /
	// "this record has new children that will block recall" before
	// the user commits to the recall. Returns the classification +
	// any cascade conflicts so the client can render a confirmation
	// UI with skip/keep checkboxes.
	app.post('/api/upload-batches/:id/recall-preflight', requireAccount, requireSfConnection, async (req, res, next) => {
		try {
			if (!await _gateCapability(req, res, 'recall-upload', 'recall_preflight', { auditPayload: { batchId: req.params.id } })) {
return;
}
			const batchStore = await uploadBatchesStoreFromSfConnection(req.sf.conn, req.sf.sfUserId, req.sf.sfOrgId, { sessionId: req.session && req.session.id });
			const batch = await batchStore.get(req.params.id);
			if (!batch) {
return res.status(404).json({ error: 'not-found' });
}
			if (batch.recalledAt) {
				return res.status(409).json({ error: 'already-recalled' });
			}
			const classification = await classifyBatchDrift({
				conn: req.sf.conn,
				batch: { insertedIds: batch.insertedIds, associations: batch.associations },
				uploaderSfUserId: req.sf.sfUserId,
				uploadTimeMs: batch.createdAt,
			});
			const cascade = await detectCascadeConflicts({
				conn: req.sf.conn,
				batch: { insertedIds: batch.insertedIds, associations: batch.associations },
				classification,
			});
			// Value-revert preview. Walks the UPDATE rows that carry
			// priorValues/uploadedValues (post-phase-B uploads) and
			// per-field classifies SF current state as clean, drifted,
			// or already-reverted. Empty result for batches whose
			// updates pre-date the per-field capture or were value-less
			// ; client renders the legacy "M updated records were
			// preserved" copy in that case.
			const valueDrift = await classifyValueDrift({
				conn: req.sf.conn,
				batch: { insertedIds: batch.insertedIds },
			});
			// Response shape is intentionally flat: the modal reads
			// preflight.clean / .drifted / .alreadyDeleted / .updates
			// / .cascadeConflicts directly, not via a nested
			// `classification` object. Kept this shape stable across
			// the recall-by-mode refactor so the client doesn't have
			// to learn about wrapper shapes; new `updates` bucket
			// slots in alongside the existing fields. `valueDrift`
			// adds an opt-in per-field surface for the value-revert
			// flow.
			res.json({
				clean: classification.clean || [],
				drifted: classification.drifted || [],
				alreadyDeleted: classification.alreadyDeleted || [],
				updates: classification.updates || [],
				unverified: classification.unverified || [],
				cascadeConflicts: cascade || [],
				valueDrift: valueDrift || { records: [], summary: {} },
				batch: {
					id: batch.id,
					createdAt: batch.createdAt,
					recordCount: batch.recordCount,
					sfOrgId: batch.sfOrgId,
				},
			});
		} catch (err) {
 next(err); 
}
	});

	// DELETE /api/upload-batches/:id: drop the batch record itself.
	// Doesn't delete the SF records (use /recall for that); this just
	// removes the recall-ledger row so it stops appearing in the
	// upload-history list.
	app.delete('/api/upload-batches/:id', requireAccount, requireSfConnection, async (req, res, next) => {
		try {
			if (!await _gateCapability(req, res, 'recall-upload', 'delete_upload_batch', { auditPayload: { batchId: req.params.id } })) {
return;
}
			const batchStore = await uploadBatchesStoreFromSfConnection(req.sf.conn, req.sf.sfUserId, req.sf.sfOrgId, { sessionId: req.session && req.session.id });
			try {
				await batchStore.remove(req.params.id);
			} catch (err) {
				if (err && err.statusCode === 404) {
return res.status(404).json({ error: 'not-found' });
}
				throw err;
			}
			res.json({ ok: true });
		} catch (err) {
 next(err); 
}
	});

	// ===== Schema describe + SOQL =====================================
	//
	// Read-side endpoints for the canvas's record-loading flows:
	//   - GET /api/objects                       list every SObject
	//   - GET /api/objects/:name/describe        full describe with
	//                                            dependent-picklist
	//                                            resolution
	//   - GET /api/objects/:name/records/:id     load one record by Id
	//   - GET /api/objects/:name/lookup          UI API typeahead
	//   - POST /api/query                        run SOQL with full-
	//                                            field rehydration
	//   - GET /api/limits                        daily API call usage
	//
	// Variants like /api/objects/:name/graph (relationship layer),
	// /api/objects/:name/search (SOSL), /api/objects/:name/by-ref*,
	// /api/objects/:name/related-count, /api/objects/:name/layout
	// (UI API page layout), /api/objects/:name/duplicates, and POST
	// /api/objects/:name/records port in 5f-follow.

	// Daily API call usage. Surfaced in the app header so users can
	// see their budget. Fails open to null to keep the chip rendering.
	//
	// Some Salesforce orgs return "limits resource is not enabled":
	// happens when the Connected App's OAuth scope omits `api`/`full`
	// or when the SF user/profile lacks "API Enabled". Scratch orgs
	// sometimes also strip the resource. The first occurrence is
	// logged so operators see the problem; subsequent occurrences for
	// the same org-id within the process lifetime are silent to avoid
	// flooding the log with the same warning every poll cycle.
	const _loggedLimitsFailFor = new Set();
	app.get('/api/limits', requireAccount, requireSfConnection, async (req, res) => {
		try {
			const conn = req.sf.conn;
			const apiVersion = conn.version || '60.0';
			const data = await conn.request({
				method: 'GET',
				url: '/services/data/v' + apiVersion + '/limits',
			});
			const daily = (data && data.DailyApiRequests) || {};
			res.json({
				daily: {
					max: typeof daily.Max === 'number' ? daily.Max : null,
					remaining: typeof daily.Remaining === 'number' ? daily.Remaining : null,
				},
			});
		} catch (err) {
			const msg = (err && err.message) || '';
			const orgId = (req.sf && req.sf.sfOrgId) || 'unknown';
			const isNotEnabled = /limits resource is not enabled|API_DISABLED_FOR_ORG|API Enabled/i.test(msg);
			const key = orgId + '|' + (isNotEnabled ? 'not-enabled' : 'other');
			if (!_loggedLimitsFailFor.has(key)) {
				_loggedLimitsFailFor.add(key);
				console.warn('[limits] fetch failed for org', orgId + ':', msg, isNotEnabled ? '(suppressing subsequent identical warnings this process)' : '');
			}
			res.json({ daily: null });
		}
	});

	app.get('/api/objects', requireAccount, requireSfConnection, async (req, res, next) => {
		try {
			const list = await listObjects(req.sf.conn, req.sf.sfOrgId);
			// Single, always-on noise filter: the one source of truth for
			// every object picker (canvas base picker, find-object popover,
			// record browser). Keep queryable business objects even when this
			// user cannot create them: Browse still needs them, and importers
			// must be able to disclose object CRUD restrictions before upload.
			// isNoiseSObject removes setup/system clutter independently of CRUD.
			// There's
			// no client-side smart-filter toggle anymore; noise is hidden
			// behind the scenes here so the pickers only see real business
			// objects. ?raw=1 escape hatch returns the unfiltered list for
			// any future tooling that needs the full catalog.
			const out = req.query.raw === '1'
				? list
				: list.filter((o) => o.queryable !== false && !isNoiseSObject(o.name));
			res.json(out);
		} catch (err) {
 next(err); 
}
	});

	app.get('/api/objects/:name/describe', requireAccount, requireSfConnection, async (req, res, next) => {
		try {
			const objectName = req.params.name;
			if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(objectName)) {
				return res.status(400).json({ error: 'invalid-object-name' });
			}
			const out = await loadDescribeForObject(req.sf.conn, objectName);
			res.json(out);
		} catch (err) {
 next(err); 
}
	});

	app.get('/api/objects/:name/records/:id', requireAccount, requireSfConnection, async (req, res, next) => {
		try {
			const name = req.params.name;
			const id = req.params.id;
			if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
				return res.status(400).json({ error: 'invalid-object-name' });
			}
			if (!/^[a-zA-Z0-9]{15,18}$/.test(id)) {
				return res.status(400).json({ error: 'invalid-record-id' });
			}
			// Full-record retrieve is a data-pull off Salesforce, same risk
			// shape as /api/browse and /api/query; gate it on browse-records
			// so "restrict who can pull data out of SF" actually holds (a
			// denied member could otherwise enumerate records one id at a
			// time through this + the lookup/search endpoints).
			if (!await _gateCapability(req, res, 'browse-records', 'record_retrieve')) {
				return;
			}
			const record = await req.sf.conn.sobject(name).retrieve(id);
			try {
				await ext.auditWrite({
					req,
					action: 'load_existing',
					targetObject: name,
					targetId: id,
					targetSfOrgId: req.sf.sfOrgId,
					payload: { sfRecordId: id },
				});
			} catch (e) { /* logging is best-effort */ }
			res.json(record);
		} catch (err) {
 next(err); 
}
	});

	// UI API typeahead. Returns up to ~25 matching records as { id,
	// title, subtitle } so the FK autocomplete can render rows.
	app.get('/api/objects/:name/lookup', requireAccount, requireSfConnection, async (req, res, next) => {
		try {
			const name = req.params.name;
			const fieldName = typeof req.query.fieldName === 'string' ? req.query.fieldName : null;
			const q = typeof req.query.q === 'string' ? req.query.q : '';
			const recordTypeId = typeof req.query.recordTypeId === 'string' ? req.query.recordTypeId : null;
			const sourceRecordId = typeof req.query.sourceRecordId === 'string' ? req.query.sourceRecordId : null;
			const targetApiNameParam = typeof req.query.targetApiName === 'string' ? req.query.targetApiName : null;
			const debug = req.query.debug === '1' || req.query.debug === 'true';
			if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) || !fieldName || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(fieldName)) {
				return res.status(400).json({ error: 'invalid-object-or-field-name' });
			}
			const conn = req.sf.conn;
			const apiVersion = conn.version || '60.0';
			const apiBase = '/services/data/v' + apiVersion;

			// Resolve the field's reference targets. Single-target refs
			// (Account.ParentId → Account) work fine without targetApiName;
			// polymorphic refs (Task.WhoId → Lead|Contact) REQUIRE it.
			// Passing targetApiName for a single-target ref is harmless,
			// but only set it for polymorphic so the single-target case
			// matches Lightning's request shape exactly.
			let referenceTargets = null;
			try {
				const sourceDescribe = await conn.sobject(name).describe();
				const fieldMeta = (sourceDescribe.fields || []).find((f) => f.name === fieldName);
				if (fieldMeta && Array.isArray(fieldMeta.referenceTo)) {
					referenceTargets = fieldMeta.referenceTo;
				}
			} catch (_e) { /* describe failures fall through */ }

			const params = new URLSearchParams();
			if (q) {
params.set('q', q);
}
			if (recordTypeId) {
params.set('recordTypeId', recordTypeId);
}
			// targetApiName: required for polymorphic, omit for single-target.
			// Caller-supplied override wins (the client can force a specific
			// target for polymorphic disambiguation).
			if (targetApiNameParam) {
				params.set('targetApiName', targetApiNameParam);
			} else if (referenceTargets && referenceTargets.length > 1) {
				// Polymorphic: default to the first target. The client
				// should explicitly pick when it knows which one it wants.
				params.set('targetApiName', referenceTargets[0]);
			}
			// sourceRecordId: when editing a loaded record, SF uses this
			// to (a) exclude the record from its own lookup, and (b)
			// resolve $Source.* references in lookup filters. Without it,
			// any filter that depends on the source record returns empty
			// because $Source is null. This is the #1 cause of "Lightning
			// finds records, our call doesn't": Lightning ALWAYS sends
			// recordId/sourceRecordId; we previously didn't. Optional.
			if (sourceRecordId && /^[a-zA-Z0-9]{15,18}$/.test(sourceRecordId)) {
				params.set('sourceRecordId', sourceRecordId);
			}
			// searchType: omit when q is empty (lets UI API default to
			// Recent). When q is present, send Search to match Lightning's
			// behavior after the user starts typing.
			if (q) {
params.set('searchType', 'Search');
}
			// pageSize default in UI API is 25; omit to match Lightning.

			const url = apiBase + '/ui-api/lookups/' + encodeURIComponent(name) + '/' + encodeURIComponent(fieldName) + (params.toString() ? '?' + params.toString() : '');
			try {
				const data = await conn.request(url);
				// Response shape changed between API versions:
				//   v50 and earlier: { records: [...] } flat at the top.
				//   v51+:            { lookupResults: { <targetApiName>: { records: [...] } }, metadata: {...} }
				// The grouped shape supports polymorphic refs (Task.WhoId
				// returning Lead AND Contact groups in one response).
				// Single-target refs still emit a single group keyed by
				// the target api name. Flatten across all groups so the
				// caller doesn't have to discriminate.
				let rawRecords = [];
				if (data && data.lookupResults && typeof data.lookupResults === 'object') {
					for (const groupKey of Object.keys(data.lookupResults)) {
						const group = data.lookupResults[groupKey];
						if (group && Array.isArray(group.records)) {
rawRecords = rawRecords.concat(group.records);
}
					}
				} else if (data && Array.isArray(data.records)) {
					rawRecords = data.records; // legacy v50 shape
				}
				const records = rawRecords.map((r) => {
					// Pull the displayable label. UI API may surface the
					// name under Name, Subject, Title, or a custom field
					// ; iterate the fields map and prefer the first
					// non-empty value matching the canonical names.
					let title = null;
					if (r.fields) {
						const nameCandidates = ['Name', 'Subject', 'Title', 'CaseNumber', 'FullName'];
						for (const k of nameCandidates) {
							if (r.fields[k] && r.fields[k].value != null && r.fields[k].value !== '') {
								title = String(r.fields[k].value);
								break;
							}
						}
						// Final fallback: first non-empty field value of
						// any kind, in case the org's name-field has a
						// non-standard API name.
						if (!title) {
							for (const k of Object.keys(r.fields)) {
								const v = r.fields[k] && r.fields[k].value;
								if (v != null && v !== '' && typeof v !== 'object') {
									title = String(v);
									break;
								}
							}
						}
					}
					if (!title) {
title = r.apiName || r.id;
}
					const subtitle = (r.fields && r.fields.RecordType && r.fields.RecordType.value
						&& r.fields.RecordType.value.fields && r.fields.RecordType.value.fields.Name
						&& r.fields.RecordType.value.fields.Name.value) || null;
					return {
						id: r.id,
						apiName: r.apiName,
						icon: r.iconUrl || null,
						title,
						subtitle,
					};
				});
				// Server-side self-exclusion: UI API accepts sourceRecordId
				// but doesn't actually filter the record out of results:
				// Lightning's UI does that step itself. Match that behavior
				// so callers get "Americas Division" filtered out when
				// they're editing Americas Division's own ParentId field.
				// Compare on 15-char id prefix because SF lookup responses
				// sometimes return the 18-char form and the client may
				// supply either.
				const filteredRecords = sourceRecordId
					? records.filter((r) => r.id && r.id.slice(0, 15) !== sourceRecordId.slice(0, 15))
					: records;
				// Console-log a one-line summary every call so server logs
				// show the trace. In debug mode also return the raw UI API
				// response in the JSON so the client can inspect it in
				// the Network tab without server access.
				console.log('[lookup] url=' + url + ' rawCount=' + rawRecords.length + ' mappedCount=' + records.length + (sourceRecordId ? ' afterSelfFilter=' + filteredRecords.length : ''));
				const out = { records: filteredRecords, available: true, source: 'ui-api' };
				if (debug) {
					out._debug = {
						requestUrl: url,
						rawRecordCount: rawRecords.length,
						rawFirstRecord: rawRecords[0] || null,
						rawResponse: data,
						referenceTargets,
						apiVersion,
					};
				}
				res.json(out);
			} catch (err) {
				console.warn('[lookup] failed url=' + url + ' err=' + (err && err.message));
				const out = { records: [], available: false, reason: (err && err.message) || 'Lookup unavailable' };
				if (debug) {
out._debug = { requestUrl: url, error: (err && err.message) || String(err), referenceTargets, apiVersion };
}
				res.json(out);
			}
		} catch (err) {
 next(err); 
}
	});

	// POST /api/query: generic SOQL runner used by the SOQL-import
	// modal in app.js. Caps row count + query length, rejects
	// aggregates / comments / multi-statement, parses subqueries to
	// build child-of-parent associations, and (by default) refetches
	// each result with all FLS-accessible fields so the canvas card
	// shows the full record state instead of just the SELECT-listed
	// fields.
	app.post('/api/query', requireAccount, _rateLimitSfReads, requireSfConnection, async (req, res, next) => {
		const SOQL_ROW_CAP = 500;
		const SOQL_LEN_CAP = 10_000;
		const FULL_FIELDS_RETRIEVE_BATCH = 200;
		const fullFields = req.body && req.body.fullFields === false ? false : true;
		try {
			if (!await _gateCapability(req, res, 'soql-import', 'soql_import')) {
return;
}
			const soqlRaw = String((req.body && req.body.soql) || '').trim();
			if (!soqlRaw) {
return res.status(400).json({ error: 'soql-required' });
}
			if (soqlRaw.length > SOQL_LEN_CAP) {
				return res.status(400).json({ error: 'soql-too-long', message: 'Query exceeds the ' + SOQL_LEN_CAP + '-character limit.' });
			}
			if (!/^SELECT\b/i.test(soqlRaw)) {
				return res.status(400).json({ error: 'select-only', message: 'Only SELECT queries are supported.' });
			}
			if (soqlRaw.indexOf(';') !== -1) {
				return res.status(400).json({ error: 'no-semicolons' });
			}
			if (/\/\*|\*\/|--/.test(soqlRaw)) {
				return res.status(400).json({ error: 'no-comments' });
			}

			// Structural skeleton: string literals + parenthesized subqueries
			// blanked (length-preserving) so FROM / aggregate / LIMIT regexes
			// only see the OUTER query and match indices map back to soqlRaw.
			const skeleton = _maskSoqlSkeleton(soqlRaw);
			const fromMatch = skeleton.match(/\bFROM\s+(\w+)/i);
			if (!fromMatch) {
				return res.status(400).json({ error: 'no-from-clause' });
			}
			let objectName = fromMatch[1];

			// Block code / metadata / security objects via the shared
			// SOQL_OBJECT_DENYLIST (single source of truth, same set used by
			// /api/browse + /api/migrate/match). Match is on the outer FROM
			// object; child subqueries are denylist-checked separately below.
			if (SOQL_OBJECT_DENYLIST.has(objectName.toLowerCase())) {
				return res.status(400).json({
					error: 'object-not-allowed',
					message: 'Querying ' + objectName + ' is not allowed here: SOQL import is for business records, not code, metadata, or security/setup objects.',
				});
			}

			const outerSelect = skeleton.match(/^SELECT\b\s+([\s\S]+?)\s+FROM\b/i);
			if (outerSelect && /\b(COUNT|SUM|AVG|MIN|MAX|COUNT_DISTINCT)\b/i.test(outerSelect[1])) {
				return res.status(400).json({
					error: 'aggregate-not-supported',
					message: 'Aggregate queries (COUNT, SUM, etc.) are not supported; return record rows instead.',
				});
			}

			// Cap LIMIT. Append if missing; lower if higher than cap.
			// Inner-LIMIT subqueries aren't touched; those bound child
			// rows per parent and can be useful as written. The match runs
			// against the skeleton (string + subquery content masked), so a
			// LIMIT inside a WHERE string literal or a child subquery can't be
			// mistaken for the outer LIMIT. Because the skeleton is
			// length-preserving, outerLimitMatch.index maps 1:1 into soqlRaw,
			// letting us rewrite the outer LIMIT in place.
			//
			// imposedCap records whether WE bounded the result (appended the
			// cap, or lowered a higher explicit LIMIT). It drives the
			// truncation signal below: a user-chosen LIMIT <= cap is respected
			// and is NOT reported as a silent cap.
			let cappedSoql = soqlRaw;
			let imposedCap = false;
			const outerLimitMatch = skeleton.match(/\bLIMIT\s+(\d+)\b/i);
			if (outerLimitMatch) {
				const requested = parseInt(outerLimitMatch[1], 10);
				if (requested > SOQL_ROW_CAP) {
					const start = outerLimitMatch.index;
					const end = start + outerLimitMatch[0].length;
					cappedSoql = soqlRaw.slice(0, start) + 'LIMIT ' + SOQL_ROW_CAP + soqlRaw.slice(end);
					imposedCap = true;
				}
			} else {
				cappedSoql = soqlRaw + ' LIMIT ' + SOQL_ROW_CAP;
				imposedCap = true;
			}

			const conn = req.sf.conn;
			const getDescribe = makeDescribeCache(conn);
			let parentDescribe;
			try {
 parentDescribe = await getDescribe(objectName); 
} catch (err) {
				return res.status(400).json({ error: 'describe-failed', message: 'Could not describe ' + objectName + ': ' + (err && err.message) });
			}
			// Normalize to the canonical API name from the describe. SOQL is
			// case-insensitive, so the FROM token preserves whatever case the
			// user typed (e.g. "account"). But the canvas keys describe caches
			// and compares relationship targets against field `referenceTo`
			// values, which Salesforce always returns canonically cased
			// ("Account"). Returning the lowercase token makes drag-to-connect
			// silently fail to find the relationship. (Child records already
			// use childSObject, which is canonical.)
			if (parentDescribe && parentDescribe.name) {
objectName = parentDescribe.name;
}
			const childRelByName = new Map();
			(parentDescribe.childRelationships || []).forEach((cr) => {
				if (cr && cr.relationshipName) {
childRelByName.set(cr.relationshipName.toLowerCase(), cr);
}
			});

			// Validate subquery relationships up-front before the SF
			// round-trip - clearer errors than waiting for empty results.
			const subqueryFromMatches = soqlRaw.match(/\(\s*SELECT\b[\s\S]+?\bFROM\s+(\w+)\s*[\s\S]*?\)/gi) || [];
			for (const subq of subqueryFromMatches) {
				if (/\b(COUNT|SUM|AVG|MIN|MAX|COUNT_DISTINCT)\s*\(/i.test(subq)) {
					return res.status(400).json({ error: 'aggregate-subquery-not-supported' });
				}
				const innerFromMatch = subq.match(/\bFROM\s+(\w+)/i);
				if (!innerFromMatch) {
continue;
}
				const relName = innerFromMatch[1];
				const childRel = childRelByName.get(relName.toLowerCase());
				if (!childRel) {
					return res.status(400).json({
						error: 'unknown-subquery-relationship',
						message: 'Subquery relationship "' + relName + '" is not a child relationship on ' + objectName + '. Use the relationship name (e.g., "Contacts" for Account → Contact).',
					});
				}
				// Denylist applies to the child object too - the outer-FROM
				// check can't see it, so a subquery could otherwise reach a
				// code / metadata / security object via a relationship name.
				if (childRel.childSObject && SOQL_OBJECT_DENYLIST.has(childRel.childSObject.toLowerCase())) {
					return res.status(400).json({
						error: 'object-not-allowed',
						message: 'Subquery on ' + childRel.childSObject + ' is not allowed here - SOQL import is for business records, not code, metadata, or security/setup objects.',
					});
				}
				// Polymorphic child FKs (Task.WhoId, Event.WhatId) ARE allowed.
				// Salesforce supports these subqueries, and in a subquery the
				// parent is unambiguous (it's the outer object), so the canvas
				// edge wires correctly via childRel.field. A child relationship
				// with no FK field at all simply loads without an edge (below).
			}
			const parentFieldNames = new Set((parentDescribe.fields || []).map((f) => f.name));

			// Structure is validated (outer object allowed, subquery
			// relationships resolved + denylist-checked). Only now hit SF for
			// the actual data - so a denied child object is rejected on the
			// describe alone and its rows are never fetched.
			let result;
			try {
				result = await conn.query(cappedSoql);
			} catch (err) {
				return res.status(400).json({ error: 'query-failed', message: (err && err.message) || 'Query failed.' });
			}
			if (!Array.isArray(result.records)) {
				return res.status(400).json({ error: 'aggregate-not-supported' });
			}
			for (const r of result.records) {
				if (!r || !r.Id) {
					return res.status(400).json({ error: 'must-include-id' });
				}
			}

			const records = [];
			const associations = [];
			let nextTempId = 1;
			const tempIdFor = () => 't' + (nextTempId++);

			for (const row of result.records) {
				const parentTempId = tempIdFor();
				const parentValues = {};
				const subqueryKeys = [];
				Object.keys(row).forEach((k) => {
					if (k === 'attributes') {
return;
}
					if (parentFieldNames.has(k)) {
						if (row[k] !== null) {
parentValues[k] = row[k];
}
					} else if (row[k] && typeof row[k] === 'object' && Array.isArray(row[k].records)) {
						subqueryKeys.push(k);
					}
				});
				records.push({ tempId: parentTempId, objectName, loadedFromId: row.Id, values: parentValues });

				for (const key of subqueryKeys) {
					const childRel = childRelByName.get(key.toLowerCase());
					if (!childRel) {
continue;
}
					const childObjectName = childRel.childSObject;
					if (!childObjectName) {
continue;
}
					let childDescribe;
					try {
 childDescribe = await getDescribe(childObjectName); 
} catch (err) {
						return res.status(400).json({ error: 'child-describe-failed', message: 'Could not describe ' + childObjectName + ': ' + (err && err.message) });
					}
					const childFieldNames = new Set((childDescribe.fields || []).map((f) => f.name));

					const subResult = row[key];
					if (!Array.isArray(subResult.records)) {
						return res.status(400).json({ error: 'aggregate-subquery-not-supported' });
					}
					for (const childRow of subResult.records) {
						if (!childRow || !childRow.Id) {
							return res.status(400).json({ error: 'subquery-must-include-id' });
						}
						const childTempId = tempIdFor();
						const childValues = {};
						Object.keys(childRow).forEach((ck) => {
							if (ck === 'attributes') {
return;
}
							if (childFieldNames.has(ck) && childRow[ck] !== null) {
childValues[ck] = childRow[ck];
}
						});
						records.push({ tempId: childTempId, objectName: childObjectName, loadedFromId: childRow.Id, values: childValues });
						// childRel.field is the (possibly polymorphic) FK back to
						// the parent - wire the edge when present; skip if the
						// relationship has no FK field to anchor on.
						if (childRel.field) {
							associations.push({ fromTempId: childTempId, toTempId: parentTempId, fieldName: childRel.field });
						}
					}
				}

				if (records.length > SOQL_ROW_CAP) {
					return res.status(400).json({
						error: 'result-exceeds-cap',
						message: 'Result would add ' + records.length + ' records (canvas cap is ' + SOQL_ROW_CAP + '). Add a LIMIT or narrow your subqueries.',
					});
				}
			}

			// Full-field rehydration - refetch each record with all
			// FLS-accessible fields so the canvas card shows full state
			// instead of just the SELECT projection.
			if (fullFields && records.length > 0) {
				const idsByObject = new Map();
				for (const r of records) {
					if (!idsByObject.has(r.objectName)) {
idsByObject.set(r.objectName, []);
}
					idsByObject.get(r.objectName).push(r.loadedFromId);
				}
				const fullByKey = new Map();
				for (const [objName, ids] of idsByObject) {
					for (let i = 0; i < ids.length; i += FULL_FIELDS_RETRIEVE_BATCH) {
						const chunk = ids.slice(i, i + FULL_FIELDS_RETRIEVE_BATCH);
						try {
							const got = await conn.sobject(objName).retrieve(chunk);
							const arr = Array.isArray(got) ? got : [got];
							for (const rec of arr) {
								if (rec && rec.Id) {
fullByKey.set(objName + '::' + rec.Id, rec);
}
							}
						} catch (err) {
							// Skip chunk; records keep partial values from the
							// SOQL projection.
							console.warn('[api/query full-fields] retrieve failed for', objName, '(' + chunk.length + ' ids):', err.message || err);
						}
					}
				}
				for (const r of records) {
					const full = fullByKey.get(r.objectName + '::' + r.loadedFromId);
					if (!full) {
continue;
}
					const v = {};
					Object.keys(full).forEach((k) => {
						if (k === 'attributes') {
return;
}
						if (full[k] !== null) {
v[k] = full[k];
}
					});
					r.values = v;
				}
			}

			try {
				await ext.auditWrite({
					req,
					action: 'soql_query',
					targetObject: objectName,
					targetSfOrgId: req.sf.sfOrgId,
					payload: {
						objectName,
						returnedRows: result.records.length,
						totalRecordsAdded: records.length,
						totalSize: result.totalSize || 0,
						fullFields,
					},
				});
			} catch (e) { /* swallow */ }

			// Truncation signal. When WE imposed the cap and the outer query
			// came back with a full page (>= cap rows), Salesforce reports
			// totalSize == returned for the LIMIT'd query, so it can't tell us
			// the true match count - there may be more rows we silently
			// dropped. Surface that explicitly via `capped` so the client can
			// warn ("showing the first 500 - narrow your query") instead of
			// pretending the result is complete.
			const hitCap = imposedCap && result.records.length >= SOQL_ROW_CAP;
			res.json({
				objectName,
				records,
				associations,
				totalSize: result.totalSize || result.records.length,
				returned: result.records.length,
				truncated: ((result.totalSize || 0) > result.records.length) || hitCap,
				capped: hitCap,
				cap: SOQL_ROW_CAP,
				fullFields,
			});
		} catch (err) {
			console.error('[api/query] failed:', err);
			// Audit the failure so the trail records "user attempted a
			// SOQL query but it errored" - useful for catching org
			// permission issues, malformed queries, and probes for
			// non-existent objects. Best-effort: don't mask the error
			// response if the audit insert itself fails.
			try {
				await ext.auditWrite({
					req,
					action: 'soql_query',
					targetSfOrgId: (req.sf && req.sf.sfOrgId) || null,
					status: 'failed',
					errorCode: (err && (err.errorCode || err.name)) || 'query-failed',
					payload: null,
				});
			} catch (_eAudit) { /* best-effort */ }
			res.status(500).json({ error: 'query-failed', message: (err && err.message) || 'Query failed.' });
		}
	});

	// ===== Schema graph + related-records endpoints (5f-follow) ========

	// Schema relationship layer for the schema explorer's spatial view.
	// Filters out system / audit / event / chatter / FSL / async-process
	// noise (~70 names + suffix patterns) so the picker shows real
	// business objects.
	app.get('/api/objects/:name/graph', requireAccount, requireSfConnection, async (req, res, next) => {
		try {
			const conn = req.sf.conn;
			const name = req.params.name;
			// Validate the object-name shape like every sibling
			// /api/objects/:name route - this was the lone gap. Keeps a
			// malformed name out of jsforce's describe URL builder
			// (path-injection defense-in-depth) and returns a clean 400
			// instead of a 500 from the SF round-trip.
			if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
				return res.status(400).json({ error: 'invalid-object-name' });
			}
			const describe = await conn.sobject(name).describe();
			const queryableSet = await getQueryableSObjects(conn, req.sf.sfOrgId);

			// Shared system/noise predicate (see sf-describe.isNoiseSObject).
			const isNoise = (n) => isNoiseSObject(n);

			const parents = [];
			const parentSeen = new Set();
			for (const f of describe.fields) {
				if (f.type !== 'reference' || !f.referenceTo || f.referenceTo.length === 0) {
continue;
}
				for (const target of f.referenceTo) {
					const key = target + '|' + f.name;
					if (parentSeen.has(key)) {
continue;
}
					parentSeen.add(key);
					if (queryableSet && !queryableSet.has(target)) {
continue;
}
					if (isNoise(target)) {
continue;
}
					parents.push({
						object: target,
						field: f.name,
						label: cleanLabel(f.label, f.name),
						required: !f.nillable && !f.defaultedOnCreate,
						// Writability flags so consumers (e.g. the drag-to-link
						// FK picker) can exclude system/audit/conversion FKs
						// (CreatedById, ConvertedAccountId, …) that can't be set
						// by users. The schema view still gets the full set.
						createable: !!f.createable,
						updateable: !!f.updateable,
					});
				}
			}
			const children = [];
			const childSeen = new Set();
			for (const cr of describe.childRelationships || []) {
				if (!cr.childSObject) {
continue;
}
				if (isNoise(cr.childSObject)) {
continue;
}
				if (queryableSet && !queryableSet.has(cr.childSObject)) {
continue;
}
				const key = cr.childSObject + '|' + (cr.field || '');
				if (childSeen.has(key)) {
continue;
}
				childSeen.add(key);
				children.push({
					object: cr.childSObject,
					field: cr.field,
					relationshipName: cr.relationshipName,
				});
			}
			res.json({
				name: describe.name,
				label: cleanLabel(describe.label, describe.name),
				parents,
				children,
			});
		} catch (err) {
 next(err); 
}
	});

	// Active validation rules for an object via the Tooling API.
	app.get('/api/objects/:name/validation-rules', requireAccount, requireSfConnection, async (req, res) => {
		const name = req.params.name;
		if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
			return res.status(400).json({ error: 'invalid-object-name' });
		}
		try {
			// `name` is already regex-validated to the [a-zA-Z_][a-zA-Z0-9_]*
			// SObject-name shape above, so interpolating it into the SOQL
			// here can't produce an injection; it cannot contain a quote
			// or backslash. Tooling-API doesn't accept bind variables on
			// the JS-side query() so this is the only way to filter.
			const soql = `SELECT Id, FullName, Metadata FROM ValidationRule WHERE EntityDefinition.QualifiedApiName = '${name}'`;
			const result = await req.sf.conn.tooling.query(soql);
			res.json(transformToolingRecords(result.records));
		} catch (err) {
			res.json({ unavailable: true, reason: err.message || 'Could not load validation rules.' });
		}
	});

	// POST /api/browse
	// Filter-builder query path used by the Browse panel. Takes
	// structured filter conditions instead of raw SOQL so the
	// front-end can compose queries without users learning SOQL.
	// Returns the matching record count + a single page of records,
	// plus the compiled SOQL string so a Load-to-canvas flow can
	// feed it through the existing SOQL import without re-deriving.
	//
	// Why structured input instead of raw SOQL: the existing
	// /api/query endpoint accepts any SELECT but blocks aggregates;
	// browse fundamentally needs COUNT(). Building structured input
	// also lets us validate field names against the describe and
	// pick the correct SOQL literal form per field type, eliminating
	// a whole class of injection / type-confusion bugs the raw-SOQL
	// path can't catch as cleanly.
	//
	// Filter shape:
	//   { field: 'Industry', op: 'equals', value: 'Technology' }
	// Operators per field type:
	//   string / textarea / phone / url / email - equals, notEquals,
	//     contains, startsWith, isNull, isNotNull
	//   picklist / combobox - equals, notEquals, in, isNull, isNotNull
	//   reference - equals, notEquals, isNull, isNotNull
	//   number / currency / percent / int - equals, notEquals, gt, gte,
	//     lt, lte, isNull, isNotNull
	//   date / datetime - equals, notEquals, before, after, between,
	//     isNull, isNotNull
	//   boolean - equals (true/false)
	// POST /api/records/refresh
	// Refetch current SF field values for a set of already-loaded
	// records. Body: { records: [{ objectName, sfId }] }. Returns one
	// result entry per input record so the client can mark partial
	// failures (deleted, no-access) per card without tanking the whole
	// batch.
	//
	// Gates: requireSfConnection + browse-records capability (a refresh
	// is a SF read, same shape as /api/browse - if the user can browse,
	// they can refresh).
	//
	// Cap: 200 records per request (matches /api/query's
	// FULL_FIELDS_RETRIEVE_BATCH). Client splits larger batches and
	// fires them sequentially to avoid SF rate-limit storms.
	//
	// Audit: writes a single records_refreshed event with per-object
	// counts. Per-record IDs intentionally NOT in the payload - a 200-
	// record refresh shouldn't write a 200-entry payload to audit_log.
	app.post('/api/records/refresh', requireAccount, requireSfConnection, async (req, res, next) => {
		const MAX_RECORDS = 200;
		try {
			if (!await _gateCapability(req, res, 'browse-records', 'records_refresh')) {
				return;
			}
			const input = Array.isArray(req.body && req.body.records) ? req.body.records : [];
			if (input.length === 0) {
				return res.status(400).json({ error: 'records-required' });
			}
			if (input.length > MAX_RECORDS) {
				return res.status(400).json({
					error: 'too-many-records',
					message: `Refresh accepts up to ${MAX_RECORDS} records per request. Split the batch on the client.`,
					max: MAX_RECORDS,
				});
			}
			// Group by object so each object gets a single retrieve call.
			// Stable name validation: only alnum + underscore (same as
			// /api/browse, /api/query).
			const byObject = new Map();
			const inputIndex = []; // preserves original input order for the response
			for (let i = 0; i < input.length; i++) {
				const r = input[i];
				const objectName = String((r && r.objectName) || '').trim();
				const sfId = String((r && r.sfId) || '').trim();
				if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(objectName)) {
					inputIndex.push({ objectName, sfId, error: 'invalid-object' });
					continue;
				}
				if (!/^[a-zA-Z0-9]{15,18}$/.test(sfId)) {
					inputIndex.push({ objectName, sfId, error: 'invalid-id' });
					continue;
				}
				if (!byObject.has(objectName)) {
					byObject.set(objectName, []);
				}
				byObject.get(objectName).push(sfId);
				inputIndex.push({ objectName, sfId });
			}
			const conn = req.sf.conn;
			// Run one retrieve per object. jsforce returns an array
			// aligned with the input chunk; nulls signify "no row" (the
			// record was deleted, the user lacks access, or the id was
			// wrong). Wrapping per-object so one bad object name doesn't
			// kill the others.
			const byKey = new Map(); // "Obj::Id" -> record values
			const objectErrors = new Map(); // objectName -> error code for whole-object failures
			for (const [objectName, ids] of byObject) {
				try {
					const got = await conn.sobject(objectName).retrieve(ids);
					const arr = Array.isArray(got) ? got : [got];
					arr.forEach((rec, idx) => {
						const id = ids[idx];
						if (!rec) {
							return;
						}
						// Strip jsforce metadata; keep only field values.
						const values = {};
						for (const k of Object.keys(rec)) {
							if (k === 'attributes') {
								continue;
							}
							values[k] = rec[k];
						}
						byKey.set(objectName + '::' + id, values);
					});
				} catch (err) {
					console.warn('[refresh] retrieve failed for', objectName, ':', err && err.message);
					const code = err && err.errorCode;
					objectErrors.set(objectName,
						code === 'INVALID_TYPE' ? 'invalid-object'
						: code === 'INSUFFICIENT_ACCESS' ? 'no-access'
						: 'retrieve-failed');
				}
			}
			// Assemble per-record results in input order.
			const objectCounts = {};
			let okCount = 0;
			let failCount = 0;
			const results = inputIndex.map((entry) => {
				if (entry.error) {
					failCount++;
					return { objectName: entry.objectName, sfId: entry.sfId, ok: false, error: entry.error };
				}
				const objErr = objectErrors.get(entry.objectName);
				if (objErr) {
					failCount++;
					return { objectName: entry.objectName, sfId: entry.sfId, ok: false, error: objErr };
				}
				const values = byKey.get(entry.objectName + '::' + entry.sfId);
				if (!values) {
					failCount++;
					return { objectName: entry.objectName, sfId: entry.sfId, ok: false, error: 'not-found' };
				}
				okCount++;
				objectCounts[entry.objectName] = (objectCounts[entry.objectName] || 0) + 1;
				return { objectName: entry.objectName, sfId: entry.sfId, ok: true, values };
			});
			// Single audit row per request - payload aggregates the
			// per-object counts so dashboards can pivot without scanning
			// a huge per-record list.
			try {
				await ext.auditWrite({
					req,
					action: 'records_refreshed',
					targetSfOrgId: req.sf.sfOrgId,
					payload: {
						requested: input.length,
						ok: okCount,
						failed: failCount,
						objectCounts,
					},
				});
			} catch (e) {
				console.warn('[refresh] audit write failed:', e && e.message);
			}
			res.json({ results });
		} catch (err) {
			next(err);
		}
	});

	app.post('/api/browse', requireAccount, _rateLimitSfReads, requireSfConnection, async (req, res, next) => {
		const PREVIEW_DEFAULT = 25;
		const PREVIEW_MAX = 200;
		const FILTER_MAX = 12;
		try {
			if (!await _gateCapability(req, res, 'browse-records', 'browse_records')) {
return;
}
			const body = req.body || {};
			const objectName = String(body.objectName || '').trim();
			if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(objectName)) {
				return res.status(400).json({ error: 'invalid-object-name' });
			}
			// Shared SOQL_OBJECT_DENYLIST (module scope) - same block as /api/query.
			if (SOQL_OBJECT_DENYLIST.has(objectName.toLowerCase())) {
				return res.status(400).json({
					error: 'object-not-allowed',
					message: 'Browsing ' + objectName + ' is not allowed.',
				});
			}
			const filters = Array.isArray(body.filters) ? body.filters.slice(0, FILTER_MAX) : [];
			const sortField = body.sort && typeof body.sort.field === 'string' ? body.sort.field : null;
			const sortDirection = body.sort && body.sort.direction === 'desc' ? 'DESC' : 'ASC';
			const limit = Math.min(PREVIEW_MAX, Math.max(1, parseInt(body.limit, 10) || PREVIEW_DEFAULT));
			const offset = Math.max(0, parseInt(body.offset, 10) || 0);

			// Resolve describe so we can validate field names and pick
			// the right SOQL literal for each value. Without this we'd
			// be back to the raw-string risks of /api/query.
			const describe = await req.sf.conn.sobject(objectName).describe();
			const fieldByName = new Map();
			for (const f of (describe.fields || [])) {
				if (f && f.name) {
fieldByName.set(f.name, f);
}
			}

			// SOQL-literal escape for a single-quoted string. Doubles
			// embedded single quotes and backslash-escapes backslashes.
			// (SOQL string literal escape rules: \\ \' \n \t \b \f \r - we
			// only need to defend against single-quote / backslash for
			// MVP; the rest are user-controlled values and SF tolerates
			// raw newlines inside LIKE filters.)
			function _soqlString(v) {
				return "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
			}
			// SF id literal - single-quoted 15/18-char alphanumeric.
			function _soqlId(v) {
				const s = String(v).trim();
				if (!/^[a-zA-Z0-9]{15,18}$/.test(s)) {
throw new Error('Invalid Salesforce id: ' + s);
}
				return "'" + s + "'";
			}
			// Date / datetime - SOQL accepts ISO-8601 unquoted for date
			// literals. Validate shape so a malformed value can't be
			// smuggled raw.
			function _soqlDate(v) {
				const s = String(v).trim();
				if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
throw new Error('Invalid date (YYYY-MM-DD): ' + s);
}
				return s;
			}
			function _soqlDateTime(v) {
				const s = String(v).trim();
				if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:?\d{2})?$/.test(s)) {
					throw new Error('Invalid datetime (ISO-8601): ' + s);
				}
				return s;
			}
			function _soqlNumber(v) {
				const n = Number(v);
				if (!isFinite(n)) {
throw new Error('Invalid number: ' + v);
}
				return String(n);
			}

			// Compile one filter condition to a SOQL fragment. The field
			// describe drives the literal form so the per-type rules
			// stay tight.
			function _compileFilter(filt) {
				if (!filt || typeof filt !== 'object') {
return null;
}
				const fieldName = String(filt.field || '').trim();
				const fieldCheck = validateSoqlFilterField(describe, fieldName);
				if (!fieldCheck.ok) {
					throw new Error(fieldCheck.message);
				}
				const field = fieldCheck.field;
				const op = String(filt.op || '').trim();
				const v = filt.value;
				// Null operators are type-agnostic.
				if (op === 'isNull') {
return `${fieldName} = null`;
}
				if (op === 'isNotNull') {
return `${fieldName} != null`;
}
				const t = field.type;
				const stringTypes = new Set(['string', 'textarea', 'phone', 'url', 'email', 'encryptedstring']);
				const numericTypes = new Set(['int', 'double', 'currency', 'percent']);
				const picklistTypes = new Set(['picklist', 'combobox']);
				if (stringTypes.has(t)) {
					if (op === 'equals') {
return `${fieldName} = ${_soqlString(v)}`;
}
					if (op === 'notEquals') {
return `${fieldName} != ${_soqlString(v)}`;
}
					if (op === 'contains') {
return `${fieldName} LIKE ${_soqlString('%' + String(v) + '%')}`;
}
					if (op === 'startsWith') {
return `${fieldName} LIKE ${_soqlString(String(v) + '%')}`;
}
				}
				if (numericTypes.has(t)) {
					if (op === 'equals') {
return `${fieldName} = ${_soqlNumber(v)}`;
}
					if (op === 'notEquals') {
return `${fieldName} != ${_soqlNumber(v)}`;
}
					if (op === 'gt') {
return `${fieldName} > ${_soqlNumber(v)}`;
}
					if (op === 'gte') {
return `${fieldName} >= ${_soqlNumber(v)}`;
}
					if (op === 'lt') {
return `${fieldName} < ${_soqlNumber(v)}`;
}
					if (op === 'lte') {
return `${fieldName} <= ${_soqlNumber(v)}`;
}
				}
				if (picklistTypes.has(t)) {
					if (op === 'equals') {
return `${fieldName} = ${_soqlString(v)}`;
}
					if (op === 'notEquals') {
return `${fieldName} != ${_soqlString(v)}`;
}
					if (op === 'in' && Array.isArray(v) && v.length > 0) {
						const parts = v.map((x) => _soqlString(x)).join(', ');
						return `${fieldName} IN (${parts})`;
					}
				}
				if (t === 'reference') {
					if (op === 'equals') {
return `${fieldName} = ${_soqlId(v)}`;
}
					if (op === 'notEquals') {
return `${fieldName} != ${_soqlId(v)}`;
}
				}
				if (t === 'date') {
					if (op === 'equals') {
return `${fieldName} = ${_soqlDate(v)}`;
}
					if (op === 'notEquals') {
return `${fieldName} != ${_soqlDate(v)}`;
}
					if (op === 'before') {
return `${fieldName} < ${_soqlDate(v)}`;
}
					if (op === 'after') {
return `${fieldName} > ${_soqlDate(v)}`;
}
					if (op === 'between' && Array.isArray(v) && v.length === 2) {
						return `(${fieldName} >= ${_soqlDate(v[0])} AND ${fieldName} <= ${_soqlDate(v[1])})`;
					}
				}
				if (t === 'datetime') {
					if (op === 'equals') {
return `${fieldName} = ${_soqlDateTime(v)}`;
}
					if (op === 'notEquals') {
return `${fieldName} != ${_soqlDateTime(v)}`;
}
					if (op === 'before') {
return `${fieldName} < ${_soqlDateTime(v)}`;
}
					if (op === 'after') {
return `${fieldName} > ${_soqlDateTime(v)}`;
}
				}
				if (t === 'boolean') {
					const bv = v === true || v === 'true' || v === 1 || v === '1';
					if (op === 'equals') {
return `${fieldName} = ${bv ? 'true' : 'false'}`;
}
				}
				throw new Error('Unsupported operator "' + op + '" for ' + t + ' field "' + fieldName + '"');
			}

			let whereFragments;
			try {
				whereFragments = filters.map(_compileFilter).filter(Boolean);
			} catch (e) {
				return res.status(400).json({ error: 'invalid-filter', message: e.message });
			}
			const whereClause = whereFragments.length > 0 ? ' WHERE ' + whereFragments.join(' AND ') : '';

			// Sort validation - must be a real filterable field on the
			// object. We allow sortable=false sorts because SOQL itself
			// will reject unsortable fields with a clearer error than
			// our describe inspection could.
			let orderClause = '';
			if (sortField) {
				if (!fieldByName.has(sortField)) {
					return res.status(400).json({ error: 'invalid-sort-field' });
				}
				orderClause = ` ORDER BY ${sortField} ${sortDirection} NULLS LAST`;
			}

			// Preview SELECT - name field + a handful of identifying
			// fields for the table preview. Don't pull every field; the
			// preview is informational and 200 fields would blow up
			// payload size + render time. Load-to-canvas pulls full
			// fields through the existing SOQL import path.
			const previewFields = ['Id'];
			const nameFieldDesc = (describe.fields || []).find((f) => f && f.nameField);
			if (nameFieldDesc) {
previewFields.push(nameFieldDesc.name);
}
			// Add up to 4 filtered fields so the preview table reflects
			// what the user is filtering on - without that, "Industry =
			// Tech" produces a preview where the user can't see the
			// Industry column.
			for (const f of filters) {
				if (f && f.field && fieldByName.has(f.field) && !previewFields.includes(f.field)) {
					previewFields.push(f.field);
					if (previewFields.length >= 6) {
break;
}
				}
			}
			const selectClause = previewFields.join(', ');

			const previewSoql = `SELECT ${selectClause} FROM ${objectName}${whereClause}${orderClause} LIMIT ${limit} OFFSET ${offset}`;
			const countSoql = `SELECT COUNT() FROM ${objectName}${whereClause}`;
			// "Full" SOQL used by Load to canvas - same WHERE, no
			// LIMIT/OFFSET, SELECT all writable fields so the canvas
			// gets fully-populated records (the soql-import pipeline
			// handles the field list further).
			const loadSoql = `SELECT Id FROM ${objectName}${whereClause}${orderClause}`;

			// Run count first (cheap) - if it's zero, skip the preview
			// query entirely. SOQL count() returns totalSize without
			// records; matched-records is in the totalSize field.
			let count;
			try {
				const countResult = await req.sf.conn.query(countSoql);
				count = countResult.totalSize || 0;
			} catch (e) {
				return res.status(400).json({
					error: 'count-failed',
					message: (e && e.message) || String(e),
					soql: countSoql,
				});
			}

			// Loadable count = matches MINUS the ones already on the canvas
			// (those dedup on load, so the "Load all N" number should reflect
			// net-new - not records the user already has). Computed as
			// count − |matches ∩ onCanvasIds| so it's exact even with a filter
			// (an on-canvas record outside the filter isn't subtracted).
			// Non-fatal: falls back to the gross count.
			let loadableCount = count;
			const onCanvasIds = Array.isArray(body.onCanvasIds)
				? body.onCanvasIds.filter((s) => typeof s === 'string' && /^[a-zA-Z0-9]{15,18}$/.test(s)).slice(0, 1000)
				: [];
			if (count > 0 && onCanvasIds.length > 0) {
				try {
					const inList = onCanvasIds.map((id) => `'${id}'`).join(', ');
					const overlapSoql = `SELECT COUNT() FROM ${objectName}${whereClause}${whereClause ? ' AND' : ' WHERE'} Id IN (${inList})`;
					const overlapResult = await req.sf.conn.query(overlapSoql);
					loadableCount = Math.max(0, count - (overlapResult.totalSize || 0));
				} catch (e) {
					loadableCount = count;
				}
			}

			let records = [];
			if (count > 0) {
				try {
					const result = await req.sf.conn.query(previewSoql);
					records = result.records || [];
				} catch (e) {
					return res.status(400).json({
						error: 'preview-failed',
						message: (e && e.message) || String(e),
						soql: previewSoql,
					});
				}
			}

			return res.json({
				count,
				loadableCount,
				records,
				hasMore: count > offset + records.length,
				previewFields,
				previewSoql,
				loadSoql,
			});
		} catch (err) {
 next(err); 
}
	});

	// Cross-org migrate matching. Given a key field and a set of values
	// present on the canvas, find which already exist in the (destination)
	// org so the migrate flow can UPDATE instead of INSERT - making a
	// re-run idempotent. Candidate identity is returned for ambiguous values
	// so the user can explicitly choose the intended row; the client never
	// silently picks one of several destination records.
	app.post('/api/migrate/match', requireAccount, _rateLimitSfReads, requireSfConnection, async (req, res, next) => {
		const VALUES_MAX = 2000;
		const CHUNK = 200;
		const RESULT_ROWS_MAX = 10000;
		try {
			// A read query against the target org - gate on the same
			// capability as browse.
			if (!await _gateCapability(req, res, 'browse-records', 'browse_records')) {
				return;
			}
			const body = req.body || {};
			const objectName = String(body.objectName || '').trim();
			const keyField = String(body.keyField || '').trim();
			if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(objectName)) {
				return res.status(400).json({ error: 'invalid-object-name' });
			}
			if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(keyField)) {
				return res.status(400).json({ error: 'invalid-key-field' });
			}
			// Shared SOQL_OBJECT_DENYLIST (module scope) - same block as /api/query.
			if (SOQL_OBJECT_DENYLIST.has(objectName.toLowerCase())) {
				return res.status(400).json({ error: 'object-not-allowed' });
			}
			const rawValues = Array.isArray(body.values) ? body.values : [];
			// Dedupe non-empty values as strings, preserving the first form.
			const seen = new Set();
			const values = [];
			for (const v of rawValues) {
				if (v === null || v === undefined) {
					continue;
				}
				const s = String(v);
				if (s === '' || seen.has(s)) {
					continue;
				}
				seen.add(s);
				values.push(s);
				if (values.length >= VALUES_MAX) {
					break;
				}
			}
			if (values.length === 0) {
				return res.json({ matchesByValue: {}, candidatesByValue: {}, ambiguous: [], matched: 0, total: 0 });
			}

			const conn = req.sf.conn;
			// Validate the key field is real + filterable on this object.
			const describe = await conn.sobject(objectName).describe();
			const fieldCheck = validateSoqlFilterField(describe, keyField);
			if (!fieldCheck.ok) {
				const error = fieldCheck.reason === 'field-not-filterable'
					? 'key-field-not-filterable'
					: 'unknown-key-field';
				return res.status(400).json({
					error,
					message: (fieldCheck.reason === 'field-not-filterable'
						? (fieldCheck.field.label || keyField) + ' cannot be used to find matching records.'
						: fieldCheck.message) + ' Choose a different field, preferably an external ID or unique field.',
					field: keyField,
				});
			}
			const fieldMeta = fieldCheck.field;

			const fieldType = String(fieldMeta.type || '').toLowerCase();
			const caseInsensitiveTypes = new Set(['string', 'email', 'phone', 'url', 'textarea']);
			const normalizeValue = (value) => {
				const s = normalizeSoqlFieldValue(value, fieldType);
				return caseInsensitiveTypes.has(fieldType)
					? s.toLowerCase()
					: s;
			};
			const requestedByNormalized = new Map();
			try {
				for (const value of values) {
					const normalized = normalizeValue(value);
					if (!requestedByNormalized.has(normalized)) {
						requestedByNormalized.set(normalized, []);
					}
					requestedByNormalized.get(normalized).push(value);
				}
			} catch (_err) {
				return res.status(400).json({
					error: 'invalid-key-value',
					message: 'One or more match values are not valid for the selected ' + fieldType + ' field.',
				});
			}
			const nameFieldMeta = (describe.fields || []).find((f) => f && f.nameField);
			const nameField = nameFieldMeta && nameFieldMeta.name;
			const hasLastModified = (describe.fields || []).some((f) => f && f.name === 'LastModifiedDate');
			const selectFields = Array.from(new Set(
				['Id', keyField, nameField, hasLastModified ? 'LastModifiedDate' : null].filter(Boolean),
			));
			const candidatesByNormalized = new Map();
			let resultRows = 0;
			for (let i = 0; i < values.length; i += CHUNK) {
				const slice = values.slice(i, i + CHUNK);
				const inList = slice.map((v) => formatSoqlFieldLiteral(v, fieldType)).join(',');
				const soql = 'SELECT ' + selectFields.join(', ') + ' FROM ' + objectName +
					' WHERE ' + keyField + ' IN (' + inList + ')';
				let page = await conn.query(soql);
				while (page) {
					for (const rec of (page.records || [])) {
						resultRows++;
						if (resultRows > RESULT_ROWS_MAX) {
							return res.status(422).json({
								error: 'too-many-match-results',
								message: 'This field returned too many possible matches. Choose a more specific field, such as an external ID or unique field.',
							});
						}
						const kv = rec[keyField];
						if (kv === null || kv === undefined) {
							continue;
						}
						const normalized = normalizeValue(kv);
						if (!requestedByNormalized.has(normalized)) {
							continue;
						}
						if (!candidatesByNormalized.has(normalized)) {
							candidatesByNormalized.set(normalized, new Map());
						}
						const byId = candidatesByNormalized.get(normalized);
						if (!byId.has(rec.Id)) {
							byId.set(rec.Id, {
								id: rec.Id,
								label: nameField && rec[nameField] != null ? String(rec[nameField]) : '',
								lastModifiedDate: hasLastModified && rec.LastModifiedDate ? rec.LastModifiedDate : null,
							});
						}
					}
					if (page.done !== false || !page.nextRecordsUrl) {
						break;
					}
					page = await conn.queryMore(page.nextRecordsUrl);
				}
			}
			const matchesByValue = Object.create(null);
			const candidatesByValue = Object.create(null);
			const ambiguous = [];
			for (const value of values) {
				const bucket = candidatesByNormalized.get(normalizeValue(value));
				const candidates = bucket ? Array.from(bucket.values()) : [];
				candidatesByValue[value] = candidates;
				if (candidates.length === 1) {
					matchesByValue[value] = candidates[0].id;
				} else if (candidates.length > 1) {
					ambiguous.push(value);
				}
			}
			return res.json({
				matchesByValue,
				candidatesByValue,
				ambiguous,
				matched: Object.keys(matchesByValue).length,
				total: values.length,
			});
		} catch (err) {
			next(err);
		}
	});

	// Name-field LIKE search for the "Load existing" picker.
	app.get('/api/objects/:name/search', requireAccount, requireSfConnection, async (req, res, next) => {
		const name = req.params.name;
		if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
			return res.status(400).json({ error: 'invalid-object-name' });
		}
		try {
			const conn = req.sf.conn;
			const describe = await conn.sobject(name).describe();
			const nameFieldMeta = describe.fields.find((f) => f.nameField);
			if (!nameFieldMeta) {
				return res.status(400).json({
					error: 'search-field-unavailable',
					message: 'Salesforce did not provide a name field for this object.',
				});
			}
			const q = String(req.query.q || '').trim();
			const nameFieldCheck = q
				? validateSoqlFilterField(describe, nameFieldMeta.name)
				: { ok: true, field: nameFieldMeta };
			if (!nameFieldCheck.ok) {
				return res.status(400).json({
					error: 'search-field-not-filterable',
					message: nameFieldCheck.message,
				});
			}
			const nameField = nameFieldCheck.field.name;
			const escaped = escapeSoqlLiteral(q);
			const where = q ? ` WHERE ${nameField} LIKE '%${escaped}%'` : '';
			const soql = `SELECT Id, ${nameField} FROM ${name}${where} ORDER BY ${nameField} LIMIT 20`;
			const result = await conn.query(soql);
			res.json({
				nameField,
				records: (result.records || []).map((r) => ({ id: r.Id, name: r[nameField] })),
			});
		} catch (err) {
 next(err); 
}
	});

	// Single COUNT() probe - schema-explorer "Children • X" badge.
	const _RELATED_FILTER_SHAPE_RE = /can not be filtered|cannot be filtered|INVALID_FIELD|MALFORMED_QUERY|UNSUPPORTED_API_VERSION|not supported on the/i;
	app.get('/api/objects/:name/related-count', requireAccount, requireSfConnection, async (req, res, next) => {
		const name = req.params.name;
		const field = String(req.query.field || '').trim();
		const id = String(req.query.id || '').trim();
		if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
return res.status(400).json({ error: 'invalid-object-name' });
}
		if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field)) {
return res.status(400).json({ error: 'invalid-field' });
}
		if (!/^[a-zA-Z0-9]{15,18}$/.test(id)) {
return res.status(400).json({ error: 'invalid-id' });
}
		try {
			const describe = await req.sf.conn.sobject(name).describe();
			const fieldCheck = validateSoqlFilterField(describe, field, { requireReference: true });
			if (!fieldCheck.ok) {
				return res.json({ count: 0, skipped: true, reason: fieldCheck.reason });
			}
			const escapedId = escapeSoqlLiteral(id);
			const soql = 'SELECT COUNT() FROM ' + name + ' WHERE ' + fieldCheck.field.name + " = '" + escapedId + "'";
			const result = await req.sf.conn.query(soql);
			res.json({ count: typeof result.totalSize === 'number' ? result.totalSize : 0 });
		} catch (err) {
			const msg = (err && (err.errorCode || err.message)) || '';
			if (_RELATED_FILTER_SHAPE_RE.test(String(msg))) {
				return res.json({ count: 0, skipped: true, reason: 'unsupported' });
			}
			next(err);
		}
	});

	// Batched COUNT() probes - replaces N HTTP round-trips with a single
	// request whose downstream fan-out is bounded by jsforce's pool to
	// SF. Capped at 8-way concurrent server-side to avoid tripping SF's
	// ~25 concurrent-API-request limit.
	app.post('/api/related-counts', requireAccount, requireSfConnection, async (req, res, next) => {
		const probes = Array.isArray(req.body?.probes) ? req.body.probes : [];
		if (probes.length === 0) {
return res.json({ counts: [] });
}
		if (probes.length > 200) {
return res.status(400).json({ error: 'too-many-probes' });
}
		try {
			const conn = req.sf.conn;
			const getDescribe = makeDescribeCache(conn);
			const SF_CONCURRENCY = 8;
			const results = new Array(probes.length);
			let nextProbeIdx = 0;
			async function worker() {
				while (true) {
					const idx = nextProbeIdx++;
					if (idx >= probes.length) {
return;
}
					const p = probes[idx];
					if (!p) {
 results[idx] = null; continue; 
}
					const name = String(p.name || '').trim();
					const field = String(p.field || '').trim();
					const id = String(p.id || '').trim();
					if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
 results[idx] = { name, field, id, count: 0, skipped: true, reason: 'invalid-name' }; continue; 
}
					if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field)) {
 results[idx] = { name, field, id, count: 0, skipped: true, reason: 'invalid-field' }; continue; 
}
					if (!/^[a-zA-Z0-9]{15,18}$/.test(id)) {
 results[idx] = { name, field, id, count: 0, skipped: true, reason: 'invalid-id' }; continue; 
}
					try {
						const describe = await getDescribe(name);
						const fieldCheck = validateSoqlFilterField(describe, field, { requireReference: true });
						if (!fieldCheck.ok) {
							results[idx] = { name, field, id, count: 0, skipped: true, reason: fieldCheck.reason };
							continue;
						}
						const escapedId = escapeSoqlLiteral(id);
						const soql = 'SELECT COUNT() FROM ' + name + ' WHERE ' + fieldCheck.field.name + " = '" + escapedId + "'";
						const result = await withSfRetry(() => conn.query(soql));
						results[idx] = { name, field, id, count: typeof result.totalSize === 'number' ? result.totalSize : 0 };
					} catch (err) {
						const msg = (err && (err.errorCode || err.message)) || '';
						const filterShape = _RELATED_FILTER_SHAPE_RE.test(String(msg));
						results[idx] = {
							name, field, id, count: 0, skipped: true,
							reason: filterShape ? 'unsupported' : 'error',
							error: filterShape ? undefined : String(msg).slice(0, 120),
						};
					}
				}
			}
			const workers = new Array(Math.min(SF_CONCURRENCY, probes.length)).fill(0).map(() => worker());
			await Promise.all(workers);
			res.json({ counts: results.filter(Boolean) });
		} catch (err) {
 next(err); 
}
	});

	// Records of `name` whose `field` references `id`. Used by
	// "Load related" + the schema-explorer's open-type-node action.
	app.get('/api/objects/:name/by-ref', requireAccount, requireSfConnection, async (req, res, next) => {
		const name = req.params.name;
		const field = String(req.query.field || '').trim();
		const id = String(req.query.id || '').trim();
		const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 200);
		if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
return res.status(400).json({ error: 'invalid-object-name' });
}
		if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field)) {
return res.status(400).json({ error: 'invalid-field' });
}
		if (!/^[a-zA-Z0-9]{15,18}$/.test(id)) {
return res.status(400).json({ error: 'invalid-id' });
}
		try {
			const conn = req.sf.conn;
			const describe = await conn.sobject(name).describe();
			const fieldCheck = validateSoqlFilterField(describe, field, { requireReference: true });
			if (!fieldCheck.ok) {
				return res.json({ records: [], skipped: true, reason: fieldCheck.reason });
			}
			// Auto-number name fields (CaseNumber etc.) aren't createable
			// but are needed for card titles, so include nameField
			// regardless of createable.
			const selectable = Array.from(new Set(['Id'].concat(
				describe.fields
					.filter((f) => (f.createable || f.nameField) && f.type !== 'address' && f.type !== 'location')
					.map((f) => f.name),
			)));
			const escapedId = escapeSoqlLiteral(id);
			const soql = 'SELECT ' + selectable.join(', ') + ' FROM ' + name + ' WHERE ' + fieldCheck.field.name + " = '" + escapedId + "' LIMIT " + limit;
			const result = await conn.query(soql);
			res.json({ records: result.records || [] });
		} catch (err) {
			const msg = (err && (err.errorCode || err.message)) || '';
			if (_RELATED_FILTER_SHAPE_RE.test(String(msg))) {
				return res.json({ records: [], skipped: true, reason: 'unsupported' });
			}
			next(err);
		}
	});

	// Filtered by-ref search: same FK constraint as /by-ref plus a
	// name-field LIKE so the user can pick specifics when the
	// unfiltered set is too large.
	app.get('/api/objects/:name/by-ref-search', requireAccount, requireSfConnection, async (req, res, next) => {
		const name = req.params.name;
		const field = String(req.query.field || '').trim();
		const id = String(req.query.id || '').trim();
		const q = String(req.query.q || '').trim();
		const limit = Math.min(parseInt(req.query.limit || '20', 10) || 20, 50);
		if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
return res.status(400).json({ error: 'invalid-object-name' });
}
		if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field)) {
return res.status(400).json({ error: 'invalid-field' });
}
		if (!/^[a-zA-Z0-9]{15,18}$/.test(id)) {
return res.status(400).json({ error: 'invalid-id' });
}
		try {
			const conn = req.sf.conn;
			const describe = await conn.sobject(name).describe();
			const fieldCheck = validateSoqlFilterField(describe, field, { requireReference: true });
			if (!fieldCheck.ok) {
				return res.json({ records: [], skipped: true, reason: fieldCheck.reason });
			}
			const nameFieldMeta = describe.fields.find((f) => f.nameField);
			if (!nameFieldMeta) {
				return res.json({ records: [], skipped: true, reason: 'name-field-unavailable' });
			}
			const nameFieldCheck = q
				? validateSoqlFilterField(describe, nameFieldMeta.name)
				: { ok: true, field: nameFieldMeta };
			if (!nameFieldCheck.ok) {
				return res.json({ records: [], skipped: true, reason: nameFieldCheck.reason });
			}
			const nameField = nameFieldCheck.field.name;
			const escapedId = escapeSoqlLiteral(id);
			const escapedQ = escapeSoqlLiteral(q);
			const filters = [fieldCheck.field.name + " = '" + escapedId + "'"];
			if (q) {
filters.push(nameField + " LIKE '%" + escapedQ + "%'");
}
			const soql = 'SELECT Id, ' + nameField + ' FROM ' + name +
				' WHERE ' + filters.join(' AND ') +
				' ORDER BY ' + nameField + ' LIMIT ' + limit;
			const result = await conn.query(soql);
			res.json({
				nameField,
				records: (result.records || []).map((r) => ({ id: r.Id, name: r[nameField] })),
			});
		} catch (err) {
			const msg = (err && (err.errorCode || err.message)) || '';
			if (_RELATED_FILTER_SHAPE_RE.test(String(msg))) {
				return res.json({ records: [], skipped: true, reason: 'unsupported' });
			}
			next(err);
		}
	});

	// UI API page-layout proxy. Two paths:
	//   ?recordId=001... → record-ui (existing record edit)
	//   else             → record-defaults/create (new record)
	// Falls back to { available: false } on 404/403 so the client can
	// switch to the flat-field renderer.
	app.get('/api/objects/:name/layout', requireAccount, requireSfConnection, async (req, res, next) => {
		try {
			const name = req.params.name;
			if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
				return res.status(400).json({ error: 'invalid-object-name' });
			}
			const conn = req.sf.conn;
			const apiVersion = conn.version || '60.0';
			const apiBase = '/services/data/v' + apiVersion;
			const recordId = typeof req.query.recordId === 'string' ? req.query.recordId : null;
			const recordTypeId = typeof req.query.recordTypeId === 'string' ? req.query.recordTypeId : null;
			let url;
			if (recordId && /^[a-zA-Z0-9]{15,18}$/.test(recordId)) {
				url = apiBase + '/ui-api/record-ui/' + encodeURIComponent(recordId) + '?layoutTypes=Full&modes=Edit';
			} else {
				url = apiBase + '/ui-api/record-defaults/create/' + encodeURIComponent(name);
				if (recordTypeId) {
url += '?recordTypeIds=' + encodeURIComponent(recordTypeId);
}
			}
			let data;
			try {
				data = await conn.request(url);
			} catch (err) {
				return res.json({ sections: [], available: false, reason: (err && err.message) || 'Layout not available' });
			}
			let layout = null;
			let resolvedRecordTypeId = recordTypeId;
			if (data && data.layouts) {
				const objKey = Object.keys(data.layouts)[0];
				const rtMap = (objKey && data.layouts[objKey]) || {};
				const rtKey = (resolvedRecordTypeId && rtMap[resolvedRecordTypeId]) ? resolvedRecordTypeId : Object.keys(rtMap)[0];
				resolvedRecordTypeId = rtKey || null;
				const layoutWrap = rtKey ? rtMap[rtKey] : null;
				layout = layoutWrap && layoutWrap.Full && layoutWrap.Full.Edit ? layoutWrap.Full.Edit : null;
			} else if (data && data.layout) {
				layout = data.layout;
			}
			if (!layout) {
				return res.json({ sections: [], available: false, reason: 'No editable layout returned' });
			}
			const sections = [];
			(layout.sections || []).forEach((section) => {
				const rows = (section.layoutRows || []).map((row) =>
					(row.layoutItems || []).map((item) => {
						const comp = (item.layoutComponents || []).find((c) => c && c.componentType === 'Field');
						if (!comp || !comp.apiName) {
return null;
}
						return {
							apiName: comp.apiName,
							label: item.label || comp.apiName,
							required: !!item.required,
							editableForNew: item.editableForNew !== false,
							editableForUpdate: item.editableForUpdate !== false,
						};
					}).filter(Boolean),
				).filter((r) => r.length > 0);
				if (rows.length > 0) {
					sections.push({
						heading: section.heading || '',
						columns: section.columns || 2,
						collapsible: !!section.collapsible,
						rows,
					});
				}
			});
			const defaults = {};
			const recordSource = data.record || (data.records && (data.records[recordId] || data.records[Object.keys(data.records)[0]]));
			if (recordSource && recordSource.fields) {
				Object.keys(recordSource.fields).forEach((fname) => {
					const v = recordSource.fields[fname];
					if (v && v.value != null) {
defaults[fname] = v.value;
}
				});
			}
			const fieldPerms = {};
			const objectInfoSrc = data.objectInfo || (data.objectInfos && data.objectInfos[name]) || null;
			if (objectInfoSrc && objectInfoSrc.fields) {
				Object.keys(objectInfoSrc.fields).forEach((fname) => {
					const f = objectInfoSrc.fields[fname];
					fieldPerms[fname] = {
						createable: f.createable !== false,
						updateable: f.updateable !== false,
					};
				});
			}
			const picklistValues = {};
			const plSrc = data.picklistFieldValues || data.picklistValues || null;
			if (plSrc && typeof plSrc === 'object') {
				Object.keys(plSrc).forEach((fname) => {
					const entry = plSrc[fname];
					if (!entry || !Array.isArray(entry.values)) {
return;
}
					picklistValues[fname] = {
						controllerValues: entry.controllerValues || null,
						defaultValue: entry.defaultValue ? entry.defaultValue.value : null,
						values: entry.values.map((v) => ({
							label: v.label,
							value: v.value,
							validFor: v.validFor || [],
						})),
					};
				});
			}
			res.json({
				sections,
				available: true,
				recordTypeId: resolvedRecordTypeId,
				columns: layout.columns || 2,
				defaults,
				fieldPerms,
				picklistValues,
			});
		} catch (err) {
 next(err); 
}
	});

	// UI API duplicate detection - runs the org's Duplicate Rules
	// against a candidate record's field values BEFORE upload.
	app.post('/api/objects/:name/duplicates', requireAccount, requireSfConnection, async (req, res, next) => {
		try {
			const name = req.params.name;
			if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
				return res.status(400).json({ error: 'invalid-object-name' });
			}
			const fields = req.body && req.body.fields && typeof req.body.fields === 'object' ? req.body.fields : null;
			if (!fields) {
return res.status(400).json({ error: 'fields-required' });
}
			const conn = req.sf.conn;
			const apiVersion = conn.version || '60.0';
			const apiBase = '/services/data/v' + apiVersion;
			try {
				const data = await conn.request({
					method: 'POST',
					url: apiBase + '/ui-api/predupes/' + encodeURIComponent(name),
					body: JSON.stringify({ record: { apiName: name, fields } }),
					headers: { 'Content-Type': 'application/json' },
				});
				const matches = [];
				((data && data.matchResults) || []).forEach((mr) => {
					((mr && mr.matchRecords) || []).forEach((m) => {
						if (!m || !m.record) {
return;
}
						matches.push({
							id: m.record.id,
							apiName: m.record.apiName,
							matchEngine: mr.matchEngine || null,
							matchConfidence: m.matchConfidence || null,
							title: (m.record.fields && m.record.fields.Name && m.record.fields.Name.value) || m.record.id,
						});
					});
				});
				res.json({ duplicates: matches, available: true });
			} catch (err) {
				res.json({ duplicates: [], available: false, reason: (err && err.message) || 'Duplicate check unavailable' });
			}
		} catch (err) {
 next(err); 
}
	});

	// Single-record insert - distinct from the bulk upload pipeline.
	app.post('/api/objects/:name/records', requireAccount, requireSfConnection, async (req, res) => {
		try {
			// Same gates as every other SF write path (/api/upload et al.):
			// this is a single-record create, but it's still a write to the
			// customer's org and must honor the upload capability + the
			// production-org approval policy. Without these a member denied
			// upload-records (or an unapproved user on a gated prod org)
			// could insert records one call at a time in a loop.
			if (!await _gateCapability(req, res, 'upload-records', 'record_insert')) {
				return;
			}
			const orgGate = await ext.getCapability(req.account, 'connect-sf-org', {
				sfOrgId: req.sf.sfOrgId,
				orgType: req.sf.orgType || 'unknown',
				createPendingOnDeny: true,
				req,
				auditAction: 'record_insert',
			});
			if (!orgGate.allowed) {
				return res.status(403).json({
					error: orgGate.reason,
					approvalStatus: orgGate.approvalStatus,
					message: orgGate.reason === 'approval-required'
						? 'Writes to this production org are pending admin approval.'
						: 'This action is blocked by workspace policy.',
				});
			}
			const result = await req.sf.conn.sobject(req.params.name).create(req.body);
			try {
				await ext.auditWrite({
					req,
					action: 'record_insert',
					targetObject: req.params.name,
					targetSfOrgId: req.sf.sfOrgId,
					payload: { sfRecordId: (result && result.id) || null, success: !!(result && result.success) },
				});
			} catch (e) { /* best effort */ }
			res.json(result);
		} catch (err) {
			try {
				await ext.auditWrite({
					req,
					action: 'record_insert',
					targetObject: req.params.name,
					targetSfOrgId: req.sf.sfOrgId,
					status: 'failed',
					errorCode: (err && err.errorCode) || 'record-insert-failed',
					payload: null,
				});
			} catch (e) { /* best effort */ }
			res.status(400).json({
				error: err.message || String(err),
				errorCode: err.errorCode,
				fields: err.fields,
			});
		}
	});

	// Active SF user search for the canvas-share modal + slot
	// assignee picker. Standard-license only, must have Email set
	// (we send the magic link via email).
	app.get('/api/sf/users/search', requireAccount, requireSfConnection, async (req, res, next) => {
		try {
			const conn = req.sf.conn;
			const q = String(req.query.q || '').trim();
			const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
			const escaped = escapeSoqlLiteral(q);
			let where = "WHERE IsActive = true AND UserType = 'Standard' AND Email != null";
			if (q) {
				where += ` AND (Name LIKE '%${escaped}%' OR Email LIKE '%${escaped}%' OR Username LIKE '%${escaped}%')`;
			}
			const soql = `SELECT Id, Name, Email, Username FROM User ${where} ORDER BY Name LIMIT ${limit}`;
			const result = await conn.query(soql);
			res.json({
				users: (result.records || []).map((r) => ({
					id: r.Id,
					name: r.Name,
					email: r.Email,
					username: r.Username,
				})),
			});
		} catch (err) {
 next(err); 
}
	});

	// Audit-log export. Streams CSV or JSON of every event matching
	// the filters - used by admins handing the activity log to a
	// security/compliance team. Distinct from the in-memory CSV the

	// Workspace audit-chain verification. Admin-only; recomputes the


	// ===== Connections =================================================

	// GET /api/connections
	// List the account's SF credentials. Drives the account modal's
	// "Salesforce connections" section.
	app.get('/api/connections', requireAccount, async (req, res, next) => {
		try {
			const list = await connectionsDb.listForAccount(req.account.id);
			const view = await viewStateDb.get(req.account.id);
			const activeId = (view && view.current_connection_id) || null;
			// Under the no-token-storage model, no connection has a
			// persisted credential. canResume is true only when the row
			// matches the currently-active session identity; anything
			// else requires re-OAuthing as that identity.
			const sfAuth = req.session && req.session.sfAuth;
			const activeSfUserId = (sfAuth && sfAuth.sfUserId) || null;
			const activeSfOrgId = (sfAuth && sfAuth.sfOrgId) || null;
			res.json({
				connections: list.map((c) => ({
					id: c.id,
					sfUserId: c.sf_user_id,
					sfOrgId: c.sf_org_id,
					instanceUrl: c.instance_url,
					displayUsername: c.display_username,
					displayName: c.display_name,
					email: c.email,
					lastUsedAt: c.last_used_at,
					isActive: c.id === activeId,
					canResume: activeSfUserId !== null
						&& activeSfOrgId !== null
						&& c.sf_user_id === activeSfUserId
						&& c.sf_org_id === activeSfOrgId,
				})),
			});
		} catch (err) {
 next(err); 
}
	});

	// POST /api/connections/:id/activate
	// Switch the active SF credential. Account-owned check enforces that
	// you can't activate someone else's connection.
	app.post('/api/connections/:id/activate', requireAccount, async (req, res, next) => {
		try {
			const c = await connectionsDb.findById(req.params.id);
			if (!c || c.account_id !== req.account.id) {
				if (c) {
await _auditCrossAccountConnAccess(req, req.params.id, c.account_id, 'activate');
}
				return res.status(404).json({ error: 'connection-not-found' });
			}
			if (c.disabled_at) {
				return res.status(409).json({ error: 'connection-disabled' });
			}
			// Under the no-token-storage model, "activate" only skips
			// re-OAuth when the target connection matches the currently-
			// active session identity on BOTH axes: sf_user_id AND
			// sf_org_id. Anything else requires a fresh OAuth - the
			// client redirects to the returned loginUrl when it sees
			// this error.
			//
			// Why both axes (not just sf_user_id):
			//   A single SF identity can belong to multiple orgs
			//   (federated users, external/community users, multi-org
			//   admins). If we matched on sf_user_id alone and the
			//   session held tokens for {user=A, org=X}, clicking
			//   Switch on {user=A, org=Y} would silently flip view_
			//   state to org Y while session.sfAuth.accessToken +
			//   instanceUrl still pointed at org X. Subsequent SF
			//   calls would hit org X using X's token, while the UI
			//   surfaced org Y's metadata - a wrong-org silent
			//   mismatch. Requiring sf_org_id to also match forces a
			//   re-OAuth whenever the org changes, guaranteeing the
			//   cached token + the activated connection row point at
			//   the same (user, org) tuple. The corresponding defense
			//   lives in getActiveSfConnection (sf-connection.js) for
			//   per-request validation.
			//
			// loginUrl carries two hints:
			//   * ?loginUrl=<target instance>  routes the OAuth to the
			//     right My Domain instead of falling back to
			//     session.sfLoginUrl (which is the LAST SF login URL -
			//     almost always the currently-active connection's, so
			//     OAuth would hit the wrong org).
			//   * &force=1                     adds prompt=login to the
			//     SF authorize URL so SF shows its login screen even
			//     when a session cookie is alive at the target host.
			//     Without prompt=login, SF silently auto-completes the
			//     OAuth as whichever identity the user has cached at
			//     that domain (often the active one, especially after a
			//     same-org user-switch), the callback re-stamps the
			//     same connection, and the user perceives "Switch did
			//     nothing." force=1 forces an explicit identity pick.
			// Mirror of _resolveSfLoginUrl's whitelist guards against
			// a corrupted instance_url ever reaching /auth/login as
			// an open-redirect vector.
			const sfAuth = req.session && req.session.sfAuth;
			const identityMatches = sfAuth
				&& sfAuth.sfUserId === c.sf_user_id
				&& sfAuth.sfOrgId === c.sf_org_id;
			if (!identityMatches) {
				// Multi-token switching: if this session already holds a live
				// access token for the target connection (from an OAuth earlier
				// this session), flip to it instantly - no re-OAuth redirect.
				// The stashed token must still match the row's (user, org) as
				// defense-in-depth against a mismatch. If the access token has
				// since expired, the first SF call surfaces INVALID_SESSION_ID
				// and either silently renews (in-memory refresh token, when
				// offline_access is granted) or the client re-auths - exactly
				// as it would for the active connection. Only when we hold no
				// token for the target do we fall back to a fresh OAuth.
				const byConn = (req.session && req.session.sfAuthByConnection) || {};
				const stored = byConn[c.id];
				if (stored && stored.accessToken
					&& stored.sfUserId === c.sf_user_id
					&& stored.sfOrgId === c.sf_org_id) {
					req.session.sfAuth = stored;
					req.session.currentConnectionId = c.id;
					await viewStateDb.setCurrentConnection(req.account.id, c.id);
					await connectionsDb.touchLastUsed(c.id);
					await _auditConnectionActivated(req, c, 'in-session');
					return res.json({ ok: true, connectionId: c.id, switched: 'in-session' });
				}
				let loginUrl = '/auth/login?force=1';
				if (typeof c.instance_url === 'string'
					&& /^https:\/\/[a-z0-9.-]+(?:\.salesforce\.com|\.lightning\.force\.com)(\/.*)?$/i.test(c.instance_url)) {
					loginUrl += '&loginUrl=' + encodeURIComponent(c.instance_url.replace(/\/+$/, ''));
				}
				return res.status(409).json({ error: 'reauth-required', loginUrl });
			}
			// Same identity, just renaming which connection row is
			// canonical. Update BOTH session.currentConnectionId and
			// view_state so getActiveSfConnection (which prefers
			// session-first) returns the new row immediately AND the
			// view persists across browser sessions. Without the
			// session update the activate is effectively a no-op for
			// the current session - getActiveSfConnection would keep
			// returning the previously-stamped row.
			req.session.currentConnectionId = c.id;
			await viewStateDb.setCurrentConnection(req.account.id, c.id);
			await connectionsDb.touchLastUsed(c.id);
			await _auditConnectionActivated(req, c, 'active-session');
			res.json({ ok: true, connectionId: c.id });
		} catch (err) {
 next(err);
}
	});

	// DELETE /api/connections/:id
	// Disconnect a Salesforce identity from this account. Sets
	// disabled_at on the connection row so it's hidden from the picker.
	// The row itself is retained so audit references (audit_log.actor_
	// connection_id) remain intact. Account-owned check enforces a user
	// can't disable someone else's connection.
	//
	// No credential material is stored, so there's nothing to revoke
	// here beyond the in-flight session token (cleared below when the
	// disconnected identity matches the active sfAuth). To revoke
	// Salesforce-side, users go to their org's Connected Apps page.
	app.delete('/api/connections/:id', requireAccount, async (req, res, next) => {
		try {
			const c = await connectionsDb.findById(req.params.id);
			if (!c || c.account_id !== req.account.id) {
				if (c) {
await _auditCrossAccountConnAccess(req, req.params.id, c.account_id, 'delete');
}
				return res.status(404).json({ error: 'connection-not-found' });
			}
			await connectionsDb.disable(c.id);

			// If the disabled connection was the active one, clear both
			// view-state pointer and the live session credential so the
			// canvas immediately surfaces the Connect-to-Salesforce gate.
			const view = await viewStateDb.get(req.account.id);
			const wasActive = view && view.current_connection_id === c.id;
			if (wasActive) {
				await viewStateDb.setCurrentConnection(req.account.id, null);
				if (req.session && req.session.sfAuth && req.session.sfAuth.sfUserId === c.sf_user_id) {
					delete req.session.sfAuth;
				}
			}
			// Drop any in-memory refresh token for the disabled connection
			// (it's already unreachable via the disabled guard, but don't
			// leave a live credential sitting in memory).
			dropRefreshToken(req.session && req.session.id, c.id);
			// Also drop its cached access token from the multi-token switch map.
			if (req.session && req.session.sfAuthByConnection) {
				delete req.session.sfAuthByConnection[c.id];
			}

			// No canvas_cache to purge - the table was retired in favor
			// of the live-browser MCP relay. Disconnecting the SF org
			// means the user's browser will lose its SF session next
			// time it tries to load a canvas; existing relay
			// registrations for that workspace stay valid only as long
			// as those browser tabs remain open.

			// Audit-log the disconnect. Workspace attribution is the
			// user's current workspace (best-effort) so retention math
			// has a tier to read; null is fine if no workspace is set.
			await ext.auditWrite({
				req,
				workspaceId: (view && view.current_workspace_id) || null,
				actorConnectionId: c.id,
				action: 'connection_disconnected',
				targetObject: 'connections',
				targetId: c.id,
				targetSfOrgId: c.sf_org_id,
				payload: {
					instanceUrl: c.instance_url,
					sfUserId: c.sf_user_id,
					displayUsername: c.display_username,
					wasActive,
				},
			});

			res.json({ ok: true, wasActive });
		} catch (err) {
			await auditDb.recordFailure(req, 'connection_disconnected', err, {
				targetObject: 'connections',
				targetId: req.params.id,
			});
			next(err);
		}
	});

	// ===== MCP tokens =================================================
	//
	// Bearer credentials authenticating MCP tool calls back to an

	// ===== MCP relay =================================================
	//
	// SSE-based relay for the "browser is the cache" model. The browser
	// opens a persistent SSE connection at /api/mcp/relay/listen, then
	// registers the canvas(es) it has loaded via POST
	// /api/mcp/relay/register. When the MCP server needs to serve an AI

	// /api/mcp/cache GET + DELETE were removed when the canvas_cache
	// table was retired. AI visibility is now exposed via
	// /api/mcp/relay/status (live browser state, not a cache); there
	// is no purge action because there's nothing on the server to
	// purge - closing the browser tab is the cleanup.

	// ===== AI proposals ===============================================
	//
	// Proposals are created by MCP tool calls (propose_record_changes)
	// and reviewed/applied/rejected through the web UI. The actual SF
	// write happens here on apply - the AI never writes to Salesforce
	// directly. This split is the trust differentiator.
	//
	// Member-only access: requireSfConnection ensures a usable SF
	// session exists, since apply needs to write back to SF via the
	// user's connection.

	// GET /api/canvas/:id/proposals
	// List pending proposals for a canvas. Member-only (canvas access
	// is governed by SF - if you can read the canvas, you can see its
	// proposals).
	app.get('/api/canvas/:id/proposals', requireAccount, async (req, res, next) => {
		try {
			const canvasId = req.params.id;
			// Accept both SF and draft id shapes - proposals can land
			// against unsaved canvases via the MCP relay path.
			const isDraft = /^draft-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(canvasId);
			const isSf = /^[a-zA-Z0-9]{15,18}$/.test(canvasId);
			if (!isDraft && !isSf) {
				return res.status(400).json({ error: 'invalid-id' });
			}
			const view = await viewStateDb.get(req.account.id);
			const workspaceId = view && view.current_workspace_id;
			if (!workspaceId) {
return res.status(409).json({ error: 'no-active-workspace' });
}
			const all = await proposalsDb.listPendingForCanvas(canvasId);
			// Workspace-scope filter: a proposal is only visible to
			// members of the workspace the proposal was filed in.
			const visible = all.filter((p) => p.workspaceId === workspaceId);
			res.json({ proposals: visible });
		} catch (err) {
 next(err); 
}
	});

	// POST /api/canvas/:id/proposals/:proposalId/apply
	// Apply a pending proposal - updates the canvas payload (the
	// loadedRecords[].values for record changes, drafts[].values for
	// draft changes). NEVER writes to Salesforce directly. The user
	// pushes to SF later through the existing canvas-upload flow,
	// which is a second human gate: review the diff in the canvas
	// itself before committing.
	//
	// Two human checkpoints:
	//   1. Review modal → Apply: AI's proposed changes land on the canvas.
	//   2. Canvas → Upload: changes propagate to Salesforce records.
	//
	// Owner-only via the canvas store's update() ownership check.
	// Audit-logged. Returns per-target results so the UI can surface
	// partial-success cases.
	app.post('/api/canvas/:id/proposals/:proposalId/apply', requireAccount, requireSfConnectionUnlessDraft, async (req, res, next) => {
		try {
			const canvasId = req.params.id;
			const proposalId = req.params.proposalId;
			// Two canvas-id shapes: SF ContentDocument (15/18 alnum) and
			// draft-<uuid> (unsaved canvases addressed via the relay).
			const isDraft = /^draft-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(canvasId);
			const isSf = /^[a-zA-Z0-9]{15,18}$/.test(canvasId);
			if (!isDraft && !isSf) {
				return res.status(400).json({ error: 'invalid-id' });
			}
			const proposal = await proposalsDb.findById(proposalId);
			if (!proposal) {
return res.status(404).json({ error: 'proposal-not-found' });
}
			if (proposal.canvasId !== canvasId) {
				return res.status(400).json({ error: 'canvas-mismatch' });
			}
			if (proposal.status !== 'pending') {
				return res.status(409).json({ error: 'proposal-not-pending', status: proposal.status });
			}
			// Workspace-scope check.
			const view = await viewStateDb.get(req.account.id);
			const workspaceId = view && view.current_workspace_id;
			if (workspaceId !== proposal.workspaceId) {
				return res.status(403).json({ error: 'workspace-mismatch' });
			}

			// Capability gate: applying an AI proposal is the consummation
			// of an AI write to the canvas (and, for a saved canvas, a
			// persist to SF). It must honor the same gate the proposal's
			// creation did: the ai_on_canvas_data_enabled kill switch and
			// the per-member grant, so a mid-flight revoke or workspace
			// toggle-off blocks apply, not just new proposals.
			if (!await _gateCapability(req, res, 'ai-edit-on-canvas', 'proposal_apply')) {
				return;
			}

			// Optional per-target overrides - the UI may let the user
			// edit individual field values before applying. Body shape:
			//   { overrides: { '<recordId|tempId>': { fields: {...} } } }
			const overrides = (req.body && req.body.overrides) || {};
			// Optional skip list - accepts either record ids or
			// stringified tempIds. Used by older clients that gate at
			// the record/draft level only.
			const skipIds = new Set(Array.isArray(req.body && req.body.skipRecordIds)
				? req.body.skipRecordIds.map(String) : []);
			// Optional per-change index skip - the UI now lets the user
			// uncheck individual changes (any kind) and apply the rest.
			// Indexes are 0-based positions in proposal.changes. The
			// bucketing loop below adds a 'skipped' result row for each
			// skipped index so the response still describes the full
			// shape of the proposal.
			const skipChangeIndexes = new Set();
			if (Array.isArray(req.body && req.body.skipChangeIndexes)) {
				for (const idx of req.body.skipChangeIndexes) {
					const n = Number(idx);
					if (Number.isInteger(n) && n >= 0) {
skipChangeIndexes.add(n);
}
				}
			}

			const results = [];

			// Always read live state via the relay - the browser is
			// the single source of truth for what the AI saw when it
			// proposed. Reading SF state would diverge from the AI's
			// view for in-session drafts (not yet saved) and for
			// runtime-tempId vs persisted-tempId mismatches on
			// reloaded canvases, both of which silently dropped
			// changes pre-rewrite. For saved canvases we still write
			// back via store.update below; drafts skip the write.
			let store = null;
			let payload;
			let liveRead;
			try {
				liveRead = await mcpRelay.dispatchRequest({
					workspaceId,
					canvasId,
					method: 'read_canvas',
					params: { canvasId },
					timeoutMs: 5000,
				});
			} catch (err) {
				const code = err && err.message;
				if (code === 'no-live-browser-for-canvas') {
					return res.status(404).json({ error: 'canvas-not-open', message: 'This proposal was made against a canvas that is no longer open in any browser. Re-open the canvas in Org Loom and retry.' });
				}
				if (code === 'relay-request-timeout') {
					return res.status(504).json({ error: 'canvas-read-timeout' });
				}
				throw err;
			}
			payload = (liveRead && liveRead.payload) || {};
			// For saved canvases we still need a canvas-store handle
			// so we can write the merged payload back to SF, AND we
			// need to verify ownership (the live snapshot only
			// reports the current user's SF id, not the canvas
			// owner, so it can't gate writes by itself). store.get
			// is the canonical source for ownership.
			if (!isDraft) {
				store = await canvasStoreFromSfConnection(req.sf.conn, req.sf.sfUserId, req.sf.sfOrgId, { sessionId: req.session && req.session.id });
				const item = await store.get(canvasId);
				if (!item) {
					return res.status(404).json({ error: 'canvas-not-found' });
				}
				if (!item.ownedByMe) {
					return res.status(403).json({ error: 'not-canvas-owner' });
				}
				if (typeof store.update !== 'function') {
					return res.status(501).json({ error: 'in-place-update-not-supported' });
				}
			}
			const oldDrafts = Array.isArray(payload.drafts) ? payload.drafts : [];
			const oldLoadedRecords = Array.isArray(payload.loadedRecords) ? payload.loadedRecords : [];

			// Index changes by their target id. Skip + override applied
			// at index time so the merge phase below is straightforward.
			// Seven kinds:
			//   * 'record' - edits an existing loaded SF record (by recordId)
			//   * 'draft' - edits an existing draft (by tempId)
			//   * 'new-draft' - appends a brand-new draft (no targetId; minted below)
			//   * 'new-association' - adds an FK edge between records (any combination of
			//                            loaded recordId / draft tempId / same-proposal tempRef)
			//   * 'delete-association' - removes an existing FK edge (matched by from+to+fieldName)
			//   * 'delete-draft' - removes a draft + cascades any associations touching it
			//   * 'delete-record' - removes a loaded record reference + cascades associations.
			//                            DOES NOT delete the underlying SF record.
			const draftChangeByTempId = new Map();
			const recordChangeById = new Map();
			const newDraftAdds = [];
			const newAssociationAdds = [];
			const deleteAssociationOps = [];
			const deleteDraftOps = [];
			const deleteRecordOps = [];
			const autofillOps = [];
			const loadRecordOps = [];
			const allChanges = Array.isArray(proposal.changes) ? proposal.changes : [];
			for (let idx = 0; idx < allChanges.length; idx++) {
				const c = allChanges[idx];
				if (skipChangeIndexes.has(idx)) {
					// Emit one skipped row that identifies which change
					// was skipped. We include kind + any natural id the
					// change carries so the UI can correlate the result
					// row back to the rendered change.
					results.push({
						changeIndex: idx,
						kind: c && c.kind || 'unknown',
						tempId: c && c.tempId,
						recordId: c && c.recordId,
						objectName: c && c.objectName,
						status: 'skipped',
					});
					continue;
				}
				if (c.kind === 'new-draft') {
					newDraftAdds.push(c);
					continue;
				}
				if (c.kind === 'new-association') {
					newAssociationAdds.push(c);
					continue;
				}
				if (c.kind === 'delete-association') {
					deleteAssociationOps.push(c);
					continue;
				}
				if (c.kind === 'delete-draft') {
					deleteDraftOps.push(c);
					continue;
				}
				if (c.kind === 'delete-record') {
					deleteRecordOps.push(c);
					continue;
				}
				if (c.kind === 'autofill-required') {
					autofillOps.push(c);
					continue;
				}
				if (c.kind === 'load-record') {
					loadRecordOps.push(c);
					continue;
				}
				const isDraft = c.kind === 'draft' || c.tempId != null;
				const targetId = isDraft ? c.tempId : c.recordId;
				const targetKey = String(targetId);
				if (skipIds.has(targetKey)) {
					results.push({ targetId, kind: isDraft ? 'draft' : 'record', status: 'skipped' });
					continue;
				}
				const overrideFields = (overrides[targetId] && overrides[targetId].fields)
					|| (overrides[targetKey] && overrides[targetKey].fields)
					|| {};
				const fields = Object.assign({}, c.fields, overrideFields);
				if (isDraft) {
					draftChangeByTempId.set(targetKey, { change: c, fields });
				} else {
					recordChangeById.set(targetKey, { change: c, fields });
				}
			}

			// Merge phase. Walk each canvas list once; entries with no
			// matching change pass through unchanged. New drafts get
			// appended after the existing-drafts walk so they share the
			// tempId sequence. Delete-draft ops filter the list FIRST so
			// the merge phase doesn't waste cycles on doomed entries.
			const deletedDraftTempIds = new Set();
			for (const op of deleteDraftOps) {
				if (op.tempId != null) {
deletedDraftTempIds.add(String(op.tempId));
}
			}
			const newDrafts = oldDrafts
				.filter((d) => d.tempId == null || !deletedDraftTempIds.has(String(d.tempId)))
				.map((d) => {
					const entry = d.tempId != null ? draftChangeByTempId.get(String(d.tempId)) : null;
					if (!entry) {
return d;
}
					return Object.assign({}, d, {
						values: Object.assign({}, d.values || {}, entry.fields),
					});
				});
			// Append any new-draft proposals. Mint tempIds above the
			// max existing one so we don't collide with drafts that
			// were locally minted by the browser between the proposal
			// submission and now. The canvas client treats tempId as
			// the unique-within-canvas identifier; appending drafts
			// with fresh tempIds is the same shape as the user adding
			// a record via the "+ Create blank" affordance.
			let nextTempId = 1;
			for (const d of newDrafts) {
				if (typeof d.tempId === 'number' && d.tempId >= nextTempId) {
nextTempId = d.tempId + 1;
}
			}
			const newDraftResults = [];
			// tempRef → mintedTempId map so association changes in the
			// same proposal can resolve their endpoints to the freshly
			// minted ids.
			const tempRefToMintedTempId = new Map();
			for (const c of newDraftAdds) {
				const mintedTempId = nextTempId++;
				newDrafts.push({
					tempId: mintedTempId,
					objectName: c.objectName,
					values: Object.assign({}, c.fields || {}),
				});
				if (c.tempRef) {
tempRefToMintedTempId.set(String(c.tempRef), mintedTempId);
}
				newDraftResults.push({
					tempId: mintedTempId,
					objectName: c.objectName,
					kind: 'new-draft',
					// Echo the proposed field values back so the client
					// can hydrate them into local draft state without
					// waiting for a canvas reload round-trip.
					fields: Object.assign({}, c.fields || {}),
					// Echo tempRef back so the client can map the runtime
					// bulkRecord id back to the AI's chosen handle when
					// it processes association results below.
					tempRef: c.tempRef || undefined,
				});
			}
			// Same filter-then-map shape as drafts: drop deleted
			// records first so the merge only sees survivors.
			const deletedRecordIds = new Set();
			for (const op of deleteRecordOps) {
				if (op.recordId) {
deletedRecordIds.add(String(op.recordId));
}
			}
			const newLoadedRecords = oldLoadedRecords
				.filter((r) => {
					const id = (r.values && r.values.Id) || r.loadedFromId;
					return !(id && deletedRecordIds.has(String(id)));
				})
				.map((r) => {
					const id = (r.values && r.values.Id) || r.loadedFromId;
					const entry = id ? recordChangeById.get(String(id)) : null;
					if (!entry) {
return r;
}
					return Object.assign({}, r, {
						values: Object.assign({}, r.values || {}, entry.fields),
					});
				});
			// Resolve an association endpoint to the canonical {kind, ref}
			// shape the canvas-payload uses. tempRef inputs collapse to
			// {kind:'draft', ref: mintedTempId} so the persisted edge
			// references a concrete tempId in the drafts array.
			function _resolveEndpointForPersist(ep) {
				if (!ep || typeof ep !== 'object') {
return null;
}
				if (ep.kind === 'loaded') {
return { kind: 'loaded', ref: String(ep.ref) };
}
				if (ep.kind === 'draft') {
return { kind: 'draft', ref: Number(ep.ref) };
}
				if (ep.kind === 'tempRef') {
					const mintedTempId = tempRefToMintedTempId.get(String(ep.ref));
					if (mintedTempId == null) {
return null;
}
					return { kind: 'draft', ref: mintedTempId };
				}
				return null;
			}
			// Apply association adds + deletes. Adds skip if an identical
			// triple already exists; deletes silently no-op if nothing
			// matches (the validation in propose_record_changes already
			// caught hallucinations - this guards against races where
			// the user removed the edge between propose + apply).
			// Cascade-clean any associations touching a deleted target.
			// Tracked per-delete so we can report how many edges fell
			// out alongside the record/draft removal in the results.
			const _assocTouchesDeletedDraft = (a) => {
				if (!a) {
return false;
}
				const checkSide = (e) => e && e.kind === 'draft' && e.ref != null && deletedDraftTempIds.has(String(e.ref));
				return checkSide(a.from) || checkSide(a.to);
			};
			const _assocTouchesDeletedRecord = (a) => {
				if (!a) {
return false;
}
				const checkSide = (e) => e && e.kind === 'loaded' && e.ref != null && deletedRecordIds.has(String(e.ref));
				return checkSide(a.from) || checkSide(a.to);
			};
			const cascadedAssocs = (Array.isArray(payload.associations) ? payload.associations : [])
				.filter((a) => _assocTouchesDeletedDraft(a) || _assocTouchesDeletedRecord(a));
			let newAssociations = (Array.isArray(payload.associations) ? payload.associations : [])
				.filter((a) => !_assocTouchesDeletedDraft(a) && !_assocTouchesDeletedRecord(a));
			const newAssociationResults = [];
			const deleteAssociationResults = [];
			for (const c of newAssociationAdds) {
				const from = _resolveEndpointForPersist(c.from);
				const to = _resolveEndpointForPersist(c.to);
				if (!from || !to) {
					newAssociationResults.push({
						kind: 'new-association',
						fieldName: c.fieldName,
						status: 'failed',
						error: 'endpoint-resolve-failed',
					});
					continue;
				}
				const dup = newAssociations.some((a) =>
					a && a.fieldName === c.fieldName &&
					a.from && a.to &&
					a.from.kind === from.kind && String(a.from.ref) === String(from.ref) &&
					a.to.kind === to.kind && String(a.to.ref) === String(to.ref)
				);
				if (!dup) {
newAssociations.push({ from, to, fieldName: c.fieldName });
}
				newAssociationResults.push({
					kind: 'new-association',
					fieldName: c.fieldName,
					from,
					to,
					status: 'applied',
				});
			}
			for (const c of deleteAssociationOps) {
				const from = _resolveEndpointForPersist(c.from);
				const to = _resolveEndpointForPersist(c.to);
				if (!from || !to) {
					deleteAssociationResults.push({
						kind: 'delete-association',
						fieldName: c.fieldName,
						status: 'failed',
						error: 'endpoint-resolve-failed',
					});
					continue;
				}
				const before = newAssociations.length;
				newAssociations = newAssociations.filter((a) => !(
					a && a.fieldName === c.fieldName &&
					a.from && a.to &&
					a.from.kind === from.kind && String(a.from.ref) === String(from.ref) &&
					a.to.kind === to.kind && String(a.to.ref) === String(to.ref)
				));
				deleteAssociationResults.push({
					kind: 'delete-association',
					fieldName: c.fieldName,
					from,
					to,
					status: before === newAssociations.length ? 'failed' : 'applied',
					error: before === newAssociations.length ? 'association-not-found' : undefined,
				});
			}
			const newPayload = Object.assign({}, payload, {
				drafts: newDrafts,
				loadedRecords: newLoadedRecords,
				associations: newAssociations,
			});

			let saveError = null;
			// Drafts have no SF file to update - the client patches
			// local in-memory state from the results array we return
			// below, which is identical to what a saved canvas does
			// after store.update writes back. The "save" only happens
			// when the user explicitly saves the draft to SF.
			if (!isDraft) {
				try {
					await store.update(canvasId, { payload: newPayload });
				} catch (err) {
					saveError = err.message || String(err);
				}
			}

			// Per-target result reporting. Confirms the target was
			// actually present in the canvas; if it wasn't, the change
			// silently no-op'd (older proposal targeting a since-deleted
			// record/draft, etc.) - flag as failed so the UI can show it.
			for (const [key, entry] of draftChangeByTempId.entries()) {
				const present = oldDrafts.some((d) => String(d.tempId) === key);
				results.push({
					targetId: entry.change.tempId,
					tempId: entry.change.tempId,
					kind: 'draft',
					status: saveError ? 'failed' : (present ? 'applied' : 'failed'),
					error: saveError || (present ? undefined : 'draft-not-found'),
					fields: Object.assign({}, entry.fields || {}),
				});
			}
			for (const [key, entry] of recordChangeById.entries()) {
				const present = oldLoadedRecords.some((r) => {
					const id = (r.values && r.values.Id) || r.loadedFromId;
					return id && String(id) === key;
				});
				results.push({
					targetId: entry.change.recordId,
					recordId: entry.change.recordId,
					kind: 'record',
					status: saveError ? 'failed' : (present ? 'applied' : 'failed'),
					error: saveError || (present ? undefined : 'record-not-found-on-canvas'),
					fields: Object.assign({}, entry.fields || {}),
				});
			}
			// New-draft adds always succeed when the underlying save
			// succeeded - there's no "target not found" failure mode
			// for an append. Each result carries the minted tempId so
			// the client can reference the new draft afterwards.
			for (const r of newDraftResults) {
				results.push(Object.assign({}, r, {
					status: saveError ? 'failed' : 'applied',
					error: saveError || undefined,
				}));
			}
			// Association adds + deletes inherit save-level failure (a
			// failed store.update means nothing landed). Otherwise their
			// per-op status from the loops above stands.
			for (const r of newAssociationResults) {
				results.push(Object.assign({}, r, {
					status: saveError ? 'failed' : r.status,
					error: saveError || r.error,
				}));
			}
			for (const r of deleteAssociationResults) {
				results.push(Object.assign({}, r, {
					status: saveError ? 'failed' : r.status,
					error: saveError || r.error,
				}));
			}
			// Delete-draft + delete-record results. We count cascaded
			// associations per-target so the client can surface "removed
			// 2 links" alongside the row removal without re-running the
			// scan locally. A delete fails only if the target wasn't in
			// the live payload at apply time (e.g., user manually
			// removed it between propose + apply) - caught by the
			// presence check below.
			for (const op of deleteDraftOps) {
				const present = oldDrafts.some((d) => String(d.tempId) === String(op.tempId));
				const cascadeCount = cascadedAssocs.filter((a) => {
					const checkSide = (e) => e && e.kind === 'draft' && String(e.ref) === String(op.tempId);
					return checkSide(a.from) || checkSide(a.to);
				}).length;
				results.push({
					kind: 'delete-draft',
					tempId: op.tempId,
					targetId: op.tempId,
					cascadedAssociations: cascadeCount,
					status: saveError ? 'failed' : (present ? 'applied' : 'failed'),
					error: saveError || (present ? undefined : 'draft-not-found'),
				});
			}
			for (const op of deleteRecordOps) {
				const present = oldLoadedRecords.some((r) => {
					const id = (r.values && r.values.Id) || r.loadedFromId;
					return id && String(id) === String(op.recordId);
				});
				const cascadeCount = cascadedAssocs.filter((a) => {
					const checkSide = (e) => e && e.kind === 'loaded' && String(e.ref) === String(op.recordId);
					return checkSide(a.from) || checkSide(a.to);
				}).length;
				results.push({
					kind: 'delete-record',
					recordId: op.recordId,
					targetId: op.recordId,
					cascadedAssociations: cascadeCount,
					status: saveError ? 'failed' : (present ? 'applied' : 'failed'),
					error: saveError || (present ? undefined : 'record-not-found-on-canvas'),
				});
			}
			// Autofill ops. The server can't actually fill fields (it
			// has no describes / smart-defaults / validation-rule
			// context - those all live in the browser). The result
			// here is just an instruction for the client's
			// _applyProposal to run its bulkAutoFill helper for the
			// listed tempIds (or every draft when tempIds is empty).
			for (const op of autofillOps) {
				results.push({
					kind: 'autofill-required',
					tempIds: Array.isArray(op.tempIds) ? op.tempIds.slice() : [],
					status: saveError ? 'failed' : 'applied',
					error: saveError || undefined,
				});
			}
			// load-record ops fetch from Salesforce via the user's
			// session. This is the only AI-proposed shape that hits
			// SF on apply; the user-mediated apply-time gate is what
			// keeps the no-AI-direct-SF-access invariant intact.
			// On draft canvases the SF-connection middleware was
			// skipped (drafts don't normally need SF), so we resolve
			// req.sf lazily here for the load-record path - if the
			// resolve fails, every load-record op on this proposal
			// fails with the same connection error. Duplicates
			// already on the canvas are surfaced as skipped (not
			// erroneous).
			if (loadRecordOps.length > 0 && (!req.sf || !req.sf.conn)) {
				try {
					const bundle = await getActiveSfConnection(req);
					if (bundle) {
req.sf = bundle;
}
				} catch (_) { /* leave req.sf unset; per-op error below */ }
			}
			for (const op of loadRecordOps) {
				if (saveError) {
					results.push({ kind: 'load-record', objectName: op.objectName, recordId: op.recordId, status: 'failed', error: saveError });
					continue;
				}
				if (!req.sf || !req.sf.conn) {
					results.push({
						kind: 'load-record',
						objectName: op.objectName,
						recordId: op.recordId,
						status: 'failed',
						error: 'no-active-sf-connection - connect Salesforce to load existing records',
					});
					continue;
				}
				const alreadyOnCanvas = oldLoadedRecords.some((r) => {
					const id = (r.values && r.values.Id) || r.loadedFromId;
					return id && String(id) === String(op.recordId);
				});
				if (alreadyOnCanvas) {
					results.push({
						kind: 'load-record',
						objectName: op.objectName,
						recordId: op.recordId,
						status: 'skipped',
						error: 'already-on-canvas',
					});
					continue;
				}
				try {
					const fields = Array.isArray(op.fields) && op.fields.length > 0 ? op.fields : null;
					const record = fields
						? await req.sf.conn.sobject(op.objectName).retrieve(op.recordId, fields)
						: await req.sf.conn.sobject(op.objectName).retrieve(op.recordId);
					// Strip jsforce's `attributes` envelope so the
					// client sees a flat field map matching what
					// loadRecordIntoFreeTypeNode handles.
					const values = {};
					if (record && typeof record === 'object') {
						for (const k of Object.keys(record)) {
							if (k === 'attributes') {
continue;
}
							if (record[k] != null) {
values[k] = record[k];
}
						}
					}
					if (!values.Id) {
values.Id = op.recordId;
}
					results.push({
						kind: 'load-record',
						objectName: op.objectName,
						recordId: op.recordId,
						values,
						status: 'applied',
					});
				} catch (err) {
					results.push({
						kind: 'load-record',
						objectName: op.objectName,
						recordId: op.recordId,
						status: 'failed',
						error: (err && err.message) || 'sf-retrieve-failed',
					});
				}
			}

			// Decision is done; the per-target results are captured in
			// the audit log payload. Action stays 'ai_proposal_applied'
			// for back-compat; payload.mode='canvas-only' makes the new
			// no-direct-SF behavior obvious in forensic review.
			//
			// Order matters: auditWrite BEFORE markApplied. The proposal
			// store is now in-memory and markApplied deletes the entry,
			// so the audit row is the durable record of the decision.
			// If auditWrite fails, the proposal stays pending in memory
			// and the user can retry; without this ordering, a failed
			// audit would leave us with a decided-but-untracked proposal.
			await ext.auditWrite({
				req,
				workspaceId: proposal.workspaceId,
				action: 'ai_proposal_applied',
				targetObject: 'ai_proposals',
				targetId: proposalId,
				// req.sf is undefined for draft canvases (the SF
				// connection check is skipped via
				// requireSfConnectionUnlessDraft), so guard against it.
				targetSfOrgId: (req.sf && req.sf.sfOrgId) || null,
				payload: {
					canvasId,
					mode: isDraft ? 'draft-canvas-only' : 'canvas-only',
					// Strip `fields` and `values` (proposed + SF-retrieved
					// record content) from each result so record contents
					// never land at rest in our DB. The client already
					// echoed values into local canvas state; the AI already
					// has what it proposed; the audit trail just needs the
					// shape.
					results: results.map((r) => {
						const out = Object.assign({}, r);
						delete out.fields;
						delete out.values;
						return out;
					}),
					proposingAccountId: proposal.proposingAccountId,
					proposingTokenId: proposal.proposingTokenId,
				},
			});
			await proposalsDb.markApplied({ id: proposalId, decidedByAccountId: req.account.id });

			res.json({ ok: true, results, mode: 'canvas-only' });
		} catch (err) {
			await auditDb.recordFailure(req, 'ai_proposal_applied', err, {
				targetObject: 'ai_proposals',
				targetId: req.params.proposalId,
				targetSfOrgId: (req.sf && req.sf.sfOrgId) || null,
				payload: { canvasId: req.params.id },
			});
			next(err);
		}
	});

	// POST /api/canvas/:id/proposals/:proposalId/reject
	// Mark a pending proposal rejected without writing to Salesforce.
	app.post('/api/canvas/:id/proposals/:proposalId/reject', requireAccount, async (req, res, next) => {
		try {
			const canvasId = req.params.id;
			const proposalId = req.params.proposalId;
			const proposal = await proposalsDb.findById(proposalId);
			if (!proposal) {
return res.status(404).json({ error: 'proposal-not-found' });
}
			if (proposal.canvasId !== canvasId) {
				return res.status(400).json({ error: 'canvas-mismatch' });
			}
			if (proposal.status !== 'pending') {
				return res.status(409).json({ error: 'proposal-not-pending', status: proposal.status });
			}
			const view = await viewStateDb.get(req.account.id);
			const workspaceId = view && view.current_workspace_id;
			if (workspaceId !== proposal.workspaceId) {
				return res.status(403).json({ error: 'workspace-mismatch' });
			}
			// Order matters: auditWrite BEFORE markRejected. Mirrors the
			// apply endpoint - the in-memory proposal store deletes the
			// entry on markRejected, so the audit row is the durable
			// decision record. proposingTokenId is captured in the
			// payload so read_proposal_outcome's ownership fence can
			// verify the lookup is by the same token that proposed.
			await ext.auditWrite({
				req,
				workspaceId: proposal.workspaceId,
				action: 'ai_proposal_rejected',
				targetObject: 'ai_proposals',
				targetId: proposalId,
				payload: {
					canvasId,
					proposingAccountId: proposal.proposingAccountId,
					proposingTokenId: proposal.proposingTokenId,
				},
			});
			await proposalsDb.markRejected({ id: proposalId, decidedByAccountId: req.account.id });
			res.json({ ok: true });
		} catch (err) {
			await auditDb.recordFailure(req, 'ai_proposal_rejected', err, {
				targetObject: 'ai_proposals',
				targetId: req.params.proposalId,
				payload: { canvasId: req.params.id },
			});
			next(err);
		}
	});

	// ===== AI clarifications ==========================================
	//
	// Sibling system to ai_proposals: instead of "AI suggests a change,
	// user reviews," AI asks a question and the user answers via a banner
	// on the canvas. Same canvas-id shape (SF ContentDocument id OR
	// draft-<uuid>), same workspace + token ownership fences.

	// GET /api/canvas/:id/clarifications
	// List pending clarifications for a canvas. Drives the client-side
	// banner poller - same cadence the proposals poller uses.
	app.get('/api/canvas/:id/clarifications', requireAccount, async (req, res, next) => {
		try {
			const canvasId = req.params.id;
			const isDraft = /^draft-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(canvasId);
			const isSf = /^[a-zA-Z0-9]{15,18}$/.test(canvasId);
			if (!isDraft && !isSf) {
				return res.status(400).json({ error: 'invalid-id' });
			}
			const view = await viewStateDb.get(req.account.id);
			const workspaceId = view && view.current_workspace_id;
			if (!workspaceId) {
return res.status(409).json({ error: 'no-active-workspace' });
}
			const all = await clarificationsDb.listPendingForCanvas(canvasId);
			// Workspace-scope filter mirrors the proposals route. Also
			// drop ones past expires_at so the banner doesn't show stale
			// questions the AI has long since forgotten about.
			const now = Date.now();
			const visible = all.filter((c) => c.workspaceId === workspaceId && (!c.expiresAt || c.expiresAt > now));
			res.json({ clarifications: visible });
		} catch (err) {
 next(err); 
}
	});

	// POST /api/canvas/:id/clarifications/:clarificationId/respond
	// User answers an AI question. Body: { responseText?, responseOption? }.
	// At least one must be present.
	app.post('/api/canvas/:id/clarifications/:clarificationId/respond', requireAccount, async (req, res, next) => {
		try {
			const canvasId = req.params.id;
			const clarificationId = req.params.clarificationId;
			const responseText = req.body && typeof req.body.responseText === 'string'
				? req.body.responseText.trim().slice(0, 2000)
				: null;
			const responseOption = req.body && typeof req.body.responseOption === 'string'
				? req.body.responseOption.slice(0, 120)
				: null;
			if (!responseText && !responseOption) {
				return res.status(400).json({ error: 'response-required', message: 'Provide responseText or responseOption (or both).' });
			}
			const row = await clarificationsDb.findById(clarificationId);
			if (!row) {
return res.status(404).json({ error: 'clarification-not-found' });
}
			if (row.canvasId !== canvasId) {
				return res.status(400).json({ error: 'canvas-mismatch' });
			}
			if (row.status !== 'pending') {
				return res.status(409).json({ error: 'clarification-not-pending', status: row.status });
			}
			const view = await viewStateDb.get(req.account.id);
			const workspaceId = view && view.current_workspace_id;
			if (workspaceId !== row.workspaceId) {
				return res.status(403).json({ error: 'workspace-mismatch' });
			}
			// Reject responseOption values that aren't in the offered set.
			// Prevents a user from injecting an answer the AI didn't allow
			// - keeps the AI's contract honest. responseText is free-form
			// so no validation there beyond length.
			if (responseOption && Array.isArray(row.options) && !row.options.includes(responseOption)) {
				return res.status(400).json({ error: 'invalid-option', message: 'responseOption must be one of the options offered.' });
			}
			const ok = await clarificationsDb.markAnswered({
				id: clarificationId,
				responseText,
				responseOption,
				respondedByAccountId: req.account.id,
			});
			if (!ok) {
				return res.status(409).json({ error: 'clarification-not-pending', message: 'Another action changed the clarification status between read and respond.' });
			}
			await ext.auditWrite({
				req,
				workspaceId: row.workspaceId,
				action: 'ai_clarification_answered',
				targetObject: 'ai_clarifications',
				targetId: clarificationId,
				payload: { canvasId, hasText: !!responseText, hasOption: !!responseOption },
			});
			res.json({ ok: true });
		} catch (err) {
			await auditDb.recordFailure(req, 'ai_clarification_answered', err, {
				targetObject: 'ai_clarifications',
				targetId: req.params.clarificationId,
				payload: { canvasId: req.params.id },
			});
			next(err);
		}
	});

	// ===== Canvas presence (Phase 1 collab - cursor + identity only) ===
	//
	// SSE channel scoped per (canvasId, workspaceId). Cursor + focus
	// updates are routed through canvas-presence.js, an in-memory
	// module that holds nothing at rest. Each tab subscribes via the
	// GET endpoint and pushes cursor coordinates via the POST endpoint;
	// peers receive 'presence' SSE events as join/leave/cursor/focus.
	//
	// Posture: this channel never carries Salesforce record values -
	// only canvas-local xy coordinates and identity (displayName,
	// accountId) of users who are already in the same workspace and
	// therefore already see each other in the members list.

	// GET /api/canvas/:id/presence/subscribe
	// Opens the SSE channel. Workspace gate: subscriber must be in the
	// canvas's workspace (resolved from their current view-state).
	app.get('/api/canvas/:id/presence/subscribe', requireAccount, async (req, res, next) => {
		try {
			const canvasId = req.params.id;
			const isDraft = /^draft-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(canvasId);
			const isSf = /^[a-zA-Z0-9]{15,18}$/.test(canvasId);
			if (!isDraft && !isSf) {
return res.status(400).json({ error: 'invalid-id' });
}
			const view = await viewStateDb.get(req.account.id);
			const workspaceId = view && view.current_workspace_id;
			if (!workspaceId) {
return res.status(409).json({ error: 'no-active-workspace' });
}
			// Access gate: since Phase 4 this channel carries draft field
			// VALUES, so a subscriber must be able to READ the canvas - not
			// merely know its id. For SF-backed canvases, verify read access
			// through the caller's own SF connection (store.get returns null
			// when SF File sharing denies access). This preserves cross-
			// workspace share-link collaboration (a granted guest passes)
			// while blocking a signed-in user who guessed/learned the id.
			// Draft canvases are unguessable random UUIDs with no server-side
			// record, so knowledge of the id is itself the capability.
			let canEditPresence = true;
			if (isSf) {
				const bundle = await getActiveSfConnection(req);
				if (!bundle || !bundle.conn) {
					return res.status(409).json({ error: 'no-active-connection', message: 'Connect or activate a Salesforce org to continue.' });
				}
				let item = null;
				try {
					const store = await canvasStoreFromSfConnection(bundle.conn, bundle.sfUserId, bundle.sfOrgId, { sessionId: req.session && req.session.id });
					item = await store.get(canvasId);
				} catch (e) {
					item = null;
				}
				if (!item) {
					return res.status(404).json({ error: 'not-found' });
				}
				if (!item.ownedByMe) {
					req.sf = bundle;
					const grant = await _findCanvasShareGrant(req, canvasId);
					if (recipientRequiresPlan(grant)) {
						const cap = await ext.getCapability(req.account, 'receive-canvas', {
							req,
							auditAction: 'canvas_presence_subscribe_denied',
							auditPayload: { canvasId, recipientRole: grant && grant.role },
						});
						if (!cap.allowed) {
							return res.status(403).json({
								error: cap.reason || 'permission-denied',
								capability: 'receive-canvas',
								message: 'Contributor and Editor collaboration requires an active Pro trial, Pro subscription, or Team seat.',
							});
						}
					}
					// Viewer and Contributor may observe presence, but only an
					// entitled Editor may relay canvas mutations.
					canEditPresence = !!grant && grant.role === 'editor';
				}
			}
			res.setHeader('Content-Type', 'text/event-stream');
			res.setHeader('Cache-Control', 'no-cache, no-transform');
			res.setHeader('Connection', 'keep-alive');
			res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
			res.flushHeaders && res.flushHeaders();
			const displayName = (req.account.display_name || req.account.email || 'Someone').toString();
			canvasPresence.subscribe({
				canvasId,
				workspaceId,
				accountId: req.account.id,
				displayName,
				canEdit: canEditPresence,
				sseRes: res,
			});
			// Hold the connection open - the SSE 'close' handler inside
			// canvas-presence.unsubscribe() does cleanup when the tab
			// drops.
		} catch (err) {
 next(err); 
}
	});

	// POST /api/canvas/:id/presence/cursor
	// Body: { connectionId, x, y, world?:boolean }. Throttling is the
	// client's job (mousemove fires too often otherwise); server stamps
	// and rebroadcasts. The `world` flag distinguishes cytoscape world
	// coords from viewport coords so the receiver applies the right
	// inverse transform - server itself is dumb to which.
	app.post('/api/canvas/:id/presence/cursor', requireAccount, async (req, res, next) => {
		try {
			const canvasId = req.params.id;
			const connectionId = req.body && req.body.connectionId;
			const x = req.body && typeof req.body.x === 'number' ? req.body.x : null;
			const y = req.body && typeof req.body.y === 'number' ? req.body.y : null;
			const world = !!(req.body && req.body.world);
			const sequence = req.body && req.body.sequence;
			if (!connectionId) {
return res.status(400).json({ error: 'missing-connectionId' });
}
			const accepted = canvasPresence.updateCursor({ canvasId, connectionId, x, y, world, sequence, requestingAccountId: req.account.id });
			if (!accepted) {
return res.status(409).json({ error: 'presence-event-rejected' });
}
			res.json({ ok: true });
		} catch (err) {
 next(err); 
}
	});

	// POST /api/canvas/:id/presence/focus
	// Body: { connectionId, focus: null | { kind, ref } }. Phase 1 just
	// stashes + broadcasts; Phase 2 (intent broadcast) will drive
	// per-user data fetching off this event.
	app.post('/api/canvas/:id/presence/focus', requireAccount, async (req, res, next) => {
		try {
			const canvasId = req.params.id;
			const connectionId = req.body && req.body.connectionId;
			const focus = req.body && req.body.focus ? req.body.focus : null;
			const sequence = req.body && req.body.sequence;
			if (!connectionId) {
return res.status(400).json({ error: 'missing-connectionId' });
}
			const accepted = canvasPresence.updateFocus({ canvasId, connectionId, focus, sequence, requestingAccountId: req.account.id });
			if (!accepted) {
return res.status(409).json({ error: 'presence-event-rejected' });
}
			res.json({ ok: true });
		} catch (err) {
 next(err); 
}
	});

	// POST /api/canvas/:id/presence/draft
	// Body: { connectionId, tempId, fields }. Phase 4 collab - relays
	// draft field-value updates to peers on the same canvas. Server
	// is a dumb relay; nothing persisted. tempId scopes the update
	// to a specific draft; fields is a sparse object of changed keys
	// only (sender's client diffed against its last-broadcast snap).
	// Same posture as cursor/focus: in-memory routing only, never at
	// rest.
	// POST /api/canvas/:id/presence/draft-link
	// Body: { connectionId, kind: 'add'|'remove', fromSyncId,
	// toSyncId, fieldName }. Phase 5 - relays a draft↔draft FK link
	// add/remove between connected browsers so the canvas's
	// association edges propagate in real-time alongside Phase 4
	// value + position sync.
	app.post('/api/canvas/:id/presence/draft-link', requireAccount, async (req, res, next) => {
		try {
			const canvasId = req.params.id;
			const body = req.body || {};
			const connectionId = body.connectionId;
			if (!connectionId) {
return res.status(400).json({ error: 'missing-connectionId' });
}
			const kind = body.kind;
			if (kind !== 'add' && kind !== 'remove') {
return res.status(400).json({ error: 'invalid-kind' });
}
			const fromSyncId = body.fromSyncId;
			const toSyncId = body.toSyncId;
			const fieldName = body.fieldName;
			if (!fromSyncId || !toSyncId || !fieldName) {
return res.status(400).json({ error: 'missing-endpoint-or-field' });
}
			const accepted = canvasPresence.updateDraftLink({ canvasId, connectionId, kind, fromSyncId, toSyncId, fieldName, sequence: body.sequence, requestingAccountId: req.account.id });
			if (!accepted) {
return res.status(409).json({ error: 'presence-event-rejected' });
}
			res.json({ ok: true });
		} catch (err) {
 next(err); 
}
	});

	// POST /api/canvas/:id/presence/record-remove
	// Body: { connectionId, sfId }. Phase 5 - broadcasts a "loaded
	// record removed" event to peers so their view (and no-access
	// placeholders) catch up the moment a teammate removes the
	// canvas reference, ahead of the canvas-save round-trip.
	app.post('/api/canvas/:id/presence/record-remove', requireAccount, async (req, res, next) => {
		try {
			const canvasId = req.params.id;
			const body = req.body || {};
			const connectionId = body.connectionId;
			const sfId = body.sfId;
			if (!connectionId) {
return res.status(400).json({ error: 'missing-connectionId' });
}
			if (!sfId) {
return res.status(400).json({ error: 'missing-sfId' });
}
			const accepted = canvasPresence.removeLoadedRecord({ canvasId, connectionId, sfId, sequence: body.sequence, requestingAccountId: req.account.id });
			if (!accepted) {
return res.status(409).json({ error: 'presence-event-rejected' });
}
			res.json({ ok: true });
		} catch (err) {
 next(err); 
}
	});

	app.post('/api/canvas/:id/presence/draft', requireAccount, async (req, res, next) => {
		try {
			const canvasId = req.params.id;
			const body = req.body || {};
			const connectionId = body.connectionId;
			const tempId = body.tempId;
			const fields = body.fields;
			if (!connectionId) {
return res.status(400).json({ error: 'missing-connectionId' });
}
			if (tempId == null) {
return res.status(400).json({ error: 'missing-tempId' });
}
			if (!fields || typeof fields !== 'object') {
return res.status(400).json({ error: 'missing-fields' });
}
			const kind = (body.kind === 'create' || body.kind === 'remove') ? body.kind : undefined;
			const position = (body.position
				&& typeof body.position === 'object'
				&& typeof body.position.x === 'number'
				&& typeof body.position.y === 'number')
				? body.position
				: undefined;
			const accepted = canvasPresence.updateDraft({
				canvasId, connectionId, tempId, fields, kind, position,
				sequence: body.sequence,
				objectName: typeof body.objectName === 'string' ? body.objectName : undefined,
				x: typeof body.x === 'number' ? body.x : undefined,
				y: typeof body.y === 'number' ? body.y : undefined,
				requestingAccountId: req.account.id,
			});
			if (!accepted) {
return res.status(409).json({ error: 'presence-event-rejected' });
}
			res.json({ ok: true });
		} catch (err) {
 next(err); 
}
	});

	// (Org-approvals routes moved to apps/saas/src/saas-routes.js.)
}
