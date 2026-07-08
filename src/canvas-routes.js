


















import { ext } from './extensions.js';
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
import { canvasStoreFromSfConnection } from './storage/canvas-store.js';
import { uploadBatchesStoreFromSfConnection } from './storage/upload-batches-store.js';
import { stripDraftsForNonOwner, planSlotFills } from './slot-helpers.js';
import { recordsToShareFromManifest } from './sf-record-share.js';











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
import { escapeSoqlLiteral } from './sf-soql.js';
import { transformToolingRecords } from './validation-rules.js';
import { makeLimiter } from './rate-limit.js';

import { withSfRetry } from './sf-upload.js';







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





async function requireSfConnection(req, res, next) {
	try {




		if (req.sf && req.sf.conn) {
			return next();
		}
		const bundle = await getActiveSfConnection(req);
		if (!bundle) {



			return res.status(409).json({
				error: 'no-active-connection',
				message: 'Connect or activate a Salesforce org to continue.',
			});
		}
		req.sf = bundle;
		next();
	} catch (err) {
 next(err); 
}
}






async function requireSfConnectionUnlessDraft(req, res, next) {
	const id = req.params && req.params.id;
	if (id && /^draft-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
		return next();
	}
	return requireSfConnection(req, res, next);
}









async function _writeEnvUpdates(updates) {




	for (const [key, value] of Object.entries(updates)) {
		if (/[\r\n]/.test(String(value))) {
			throw new Error('invalid value for ' + key + ': contains a newline');
		}
	}
	const fs = await import('node:fs/promises');
	const path = await import('node:path');


	const envPath = path.resolve(process.cwd(), '.env');
	let existing = '';
	try {
 existing = await fs.readFile(envPath, 'utf8'); 
} catch (_) {                              }
	const lines = existing.split(/\r?\n/);
	const seen = new Set();
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
		return key + '=' + String(updates[key]);
	});

	for (const key of Object.keys(updates)) {
		if (seen.has(key)) {
continue;
}
		updated.push(key + '=' + String(updates[key]));
	}
	const out = updated.join('\n').replace(/\n+$/, '') + '\n';
	await fs.writeFile(envPath, out, 'utf8');
}


















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



		if (!/^[A-Za-z0-9._-]{20,200}$/.test(sfClientId)) {
			return res.status(400).render('setup', {
				appUrl,
				submitError: 'Consumer Key doesn\'t look right (got ' + sfClientId.length + ' chars; expected ~85). Double-check you copied the Consumer Key and not the Secret.',
				submitted: false,
			});
		}
		try {
			await _writeEnvUpdates({
				SF_CLIENT_ID: sfClientId,
				SF_CLIENT_SECRET: sfClientSecret,
				SF_CALLBACK_URL: appUrl + '/auth/callback',
				...(anthropicKey ? { ANTHROPIC_API_KEY: anthropicKey } : {}),
			});
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













export async function requireAccount(req, res, next) {
	try {
		const account = await ext.getCurrentAccount(req);
		if (!account) {





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





export function requireWorkspaceAdmin(extractWorkspaceId = (req) => req.params.id) {
	return async (req, res, next) => {
		try {
			const workspaceId = extractWorkspaceId(req);
			if (!workspaceId) {
				return res.status(400).json({ error: 'workspace-id-required' });
			}
			const role = await workspacesDb.findMemberRole(workspaceId, req.account.id);
			if (!role) {
return res.status(403).json({ error: 'not-a-member' });
}
			if (role !== 'admin') {
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




export function requireWorkspaceMember(extractWorkspaceId = (req) => req.params.id) {
	return async (req, res, next) => {
		try {
			const workspaceId = extractWorkspaceId(req);
			if (!workspaceId) {
				return res.status(400).json({ error: 'workspace-id-required' });
			}
			const role = await workspacesDb.findMemberRole(workspaceId, req.account.id);
			if (!role) {
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
			message: opts.message
				|| `You don't have permission to ${auditAction.replace(/_/g, ' ')}. Ask a workspace admin to grant the '${capability}' permission.`,
		});
		return false;
	}
	return true;
}





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


















const _SF_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_.]*$/;










function _maskSoqlSkeleton(soql) {
	const out = String(soql).split('');
	const n = out.length;

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












const SOQL_OBJECT_DENYLIST = new Set([

	'apexclass', 'apextrigger', 'apexcomponent', 'apexpage',
	'apexlog', 'apextestresult', 'apexcodecoverage', 'apexcodecoverageaggregate',
	'apextestqueueitem', 'apexemailnotification', 'apexpageinfo',
	'staticresource', 'entitydefinition', 'fielddefinition', 'flowdefinitionview',

	'userlogin', 'profile', 'permissionset', 'permissionsetassignment',
	'permissionsetgroup', 'permissionsetlicense', 'permissionsetlicenseassign',
	'objectpermissions', 'fieldpermissions', 'setupentityaccess',
	'organization', 'authsession', 'authconfig', 'authconfigproviders',
	'authprovider', 'oauthtoken', 'connectedapplication', 'samlssoconfig',
	'loginhistory', 'loginip', 'logingeo', 'sessionpermsetactivation',
	'setupaudittrail', 'apianomalyeventstore', 'credentialstuffingeventstore',
]);









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


export function _resetSfReadRateLimitForTests() {
	_sfReadLimiter.reset();
}



























export async function _fetchCanonicalValuesForUpload({ conn, results, recordsById }) {
	const out = new Map();
	if (!conn || !Array.isArray(results) || results.length === 0) {
return out;
}





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



			}
		}
	}
	return out;
}













export function _orderDeletesChildrenFirst(deletesIn, associations) {
	if (!Array.isArray(deletesIn) || deletesIn.length <= 1) {
		return Array.isArray(deletesIn) ? deletesIn : [];
	}
	const plannable = deletesIn.filter((d) => d && d.tempId != null && d.sfId);
	const unplannable = deletesIn.filter((d) => !(d && d.tempId != null && d.sfId));



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





			 
			if (cur == prior) {
continue;
}
			priorValues[k] = prior == null ? null : prior;







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

export function mountCanvasRoutes(app) {

























	app.get('/api/canvas', requireAccount, requireSfConnection, async (req, res, next) => {
		try {
			const store = await canvasStoreFromSfConnection(req.sf.conn, req.sf.sfUserId, req.sf.sfOrgId, { sessionId: req.session && req.session.id });
			const result = await store.list();
			res.json(result);
		} catch (err) {
 next(err); 
}
	});




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



			if (item.ownedByMe) {
				if (!await _gateCapability(req, res, 'open-saved-canvas', 'open_saved_canvas', { auditPayload: { canvasId: id } })) {
return;
}
			}















			let grant = null;
			if (!item.ownedByMe) {
				grant = await _findCanvasShareGrant(req, id);
				if (!grant) {
					const cap = await ext.getCapability(req.account, 'receive-canvas', {
						req,
						auditAction: 'canvas_receive_denied',
						auditPayload: { canvasId: id, ownerSfUserId: item.ownerId },
					});
					if (!cap.allowed) {
						return res.status(402).json({
							error: cap.reason || 'upgrade-required',
							message: 'Opening shared canvases from Saved Canvases requires Pro or higher. If the sender emailed you a share link, open that link instead — magic-link recipients can engage with the canvas on any plan.',
							required: cap.required,
							currentPlan: cap.plan,
						});
					}
				}
			}

			const payload = item.ownedByMe ? item.payload : stripDraftsForNonOwner(item.payload);













			let recipientRole = null;
			let recipientHasAccount = false;
			if (!item.ownedByMe) {
				if (grant) {
					recipientRole = grant.role || 'contributor';
				} else {
					try {
						const dbGrant = await canvasRoleGrantsDb.get({
							sfOrgId: req.sf.sfOrgId,
							canvasId: id,
							recipientSfUserId: req.sf.sfUserId,
						});
						if (dbGrant) {
recipientRole = dbGrant.role;
}
					} catch (e) {
						console.warn('[canvas-load] role-grant lookup failed:', e.message || e);
					}
					if (!recipientRole) {
recipientRole = 'viewer';
}
				}



				recipientHasAccount = !!req.session.accountId;
			}



















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



						if (!_STALE_OBJ_NAME_RE.test(objName)) {
continue;
}
						const ids = Array.from(idSet);
						const liveIds = new Set();
						const idKey = (i) => (i ? String(i).slice(0, 15) : '');
						for (let i = 0; i < ids.length; i += 200) {
							const slice = ids.slice(i, i + 200);
							const inList = slice.map((id) => "'" + escapeSoqlLiteral(id) + "'").join(',');






							const soql = 'SELECT Id FROM ' + objName + ' WHERE Id IN (' + inList + ')';
							try {
								const url = '/services/data/v' + apiVersion + '/query/?q=' + encodeURIComponent(soql);
								const r = await req.sf.conn.request({ method: 'GET', url });
								(r.records || []).forEach((rec) => liveIds.add(idKey(rec.Id)));
							} catch (e) {




								console.warn('[canvas-load] stale-ref probe failed for', objName + ':', (e && e.message) || String(e));
								slice.forEach((id) => liveIds.add(idKey(id)));
							}
						}
						for (const id of ids) {
							if (!liveIds.has(idKey(id))) {
								staleRefs.push({ sfId: id, objectName: objName });
							}
						}
					}
				}





















				if (staleRefs.length > 0) {
					const apiVersion = req.sf.conn.version || '60.0';











					const _ownerCanDistinguishDeletion = !!item.ownedByMe;
					const _classify = async (ref) => {
						try {
							const url = '/services/data/v' + apiVersion
								+ '/sobjects/' + encodeURIComponent(ref.objectName)
								+ '/' + encodeURIComponent(ref.sfId);
							await req.sf.conn.request({ method: 'GET', url });





							return null;
						} catch (e) {





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
}
							refined.push(Object.assign({}, slice[j], { reason }));
						}
					}
					staleRefs = refined;
				}
			} catch (_eProbe) {                   }







			res.json({
				id: item.id,






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
			const store = await canvasStoreFromSfConnection(req.sf.conn, req.sf.sfUserId, req.sf.sfOrgId, { sessionId: req.session && req.session.id });







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
				} catch (_e) {                                             }
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
				payload: { attemptedName: String((req.body && req.body.name) || '').trim(), sfError: err && err.sfError },
			});





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
			const store = await canvasStoreFromSfConnection(req.sf.conn, req.sf.sfUserId, req.sf.sfOrgId, { sessionId: req.session && req.session.id });
			if (typeof store.update !== 'function') {
				return res.status(501).json({ error: 'in-place-update-not-supported' });
			}
			const existing = await store.get(id);
			if (!existing) {
return res.status(404).json({ error: 'not-found' });
}
			if (!existing.ownedByMe) {



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










			const result = await store.update(id, { payload: safePayload, expectedVersionId });
			await ext.auditWrite({
				req,
				action: 'canvas_updated',
				targetObject: 'canvas',
				targetId: id,
				targetSfOrgId: req.sf.sfOrgId,
				payload: _summarizeCanvasPayload(safePayload),
			});








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
			} catch (_eBroadcast) {                               }

			res.json(Object.assign({ ok: true, backend: store.backend }, result));
		} catch (err) {
			await auditDb.recordFailure(req, 'canvas_updated', err, {
				targetObject: 'canvas',
				targetId: req.params.id,
				targetSfOrgId: (req.sf && req.sf.sfOrgId) || null,
				payload: { sfError: err && err.sfError },
			});




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














			const role = rawRole === 'editor' ? 'editor'
				: rawRole === 'contributor' ? 'contributor'
				: 'viewer';


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






			try {
				await canvasRoleGrantsDb.set({
					sfOrgId: req.sf.sfOrgId,
					canvasId: id,
					recipientSfUserId,
					role,
					grantedByAccountId: req.account.id,
				});
			} catch (e) {




				console.warn('[canvas-direct-share] role-grant persist failed:', e.message || e);
			}












			let recipientHasAccount = false;
			let recipientHasConnection = false;
			try {
				const acct = await accountsDb.findByEmail(recipientSfEmail);
				if (acct) {
					recipientHasAccount = true;
					const conns = await connectionsDb.listForAccount(acct.id);
					recipientHasConnection = (conns || []).some((c) => c.sf_org_id === req.sf.sfOrgId);
				}
			} catch (_eLookup) {                                                  }





			let sfOrgLabel = null;
			try {
				const u = new URL(req.sf.instanceUrl || (req.sf.connectionRow && req.sf.connectionRow.instance_url) || '');
				sfOrgLabel = u.hostname;
			} catch (_eUrl) {
 sfOrgLabel = null; 
}



			const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
			const host = req.get('host');
			const appUrl = process.env.APP_URL ? process.env.APP_URL.replace(/\/$/, '') : `${proto}://${host}`;

			try {
				await sendDirectCanvasShareNotification({
					to: recipientSfEmail,
					appUrl,






					canvasId: id,
					senderName: req.account.display_name || req.account.email,
					senderEmail: req.account.email,
					canvasName: item.title,
					sfOrgLabel,
					recipientHasAccount,
					recipientHasConnection,
				});
			} catch (e) {
				console.error('[canvas-direct-share] email send failed:', e.message || e);





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
				} catch (_eAudit) {                   }
				return res.status(200).json({
					ok: true,
					mechanism: 'direct',
					emailDeliverFailed: true,
					message: 'Salesforce access granted, but the notification email failed to send. The recipient can still find the canvas in their Saved Canvases.',
				});
			}

			await ext.auditWrite({
				req,
				action: 'canvas_shared',
				targetObject: 'canvas',
				targetId: id,
				targetSfOrgId: req.sf.sfOrgId,
				payload: {




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


			if (!item.ownedByMe) {
return res.json({ shares: [], directShares: [] });
}










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



			res.json({ shares: [], directShares });
		} catch (err) {
 next(err); 
}
	});








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



























	app.post('/api/canvas/:id/slot-fill', async (req, res, next) => {
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







			if (grant.role === 'viewer') {
				return res.status(403).json({
					error: 'role-read-only',
					message: 'This canvas was shared with you as view-only. Ask the owner for contributor access to fill slots.',
				});
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






			try {
				let ownerEmail = null;
				if (item.ownerId && /^[a-zA-Z0-9]{15,18}$/.test(item.ownerId)) {
					try {
						const owner = await req.sf.conn.sobject('User').retrieve(item.ownerId);
						if (owner && owner.Email) {
ownerEmail = String(owner.Email).trim();
}
					} catch (_eOwner) {                                               }
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


			console.warn('[ai/status] usage lookup failed:', e.message || e);
		}
		res.json(base);
	});












	app.post('/api/ai/plan', requireAccount, requireSfConnection, async (req, res, next) => {
		try {
			if (!anthropicEnabled()) {
				return res.status(501).json({
					error: 'ai-disabled',
					message: 'AI generation is not enabled on this server. Set ANTHROPIC_API_KEY and restart to enable.',
				});
			}
			if (!await _gateCapability(req, res, 'ai-edit-on-canvas', 'ai_plan')) {
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





			const view = await viewStateDb.get(req.account.id);
			const workspaceId = view && view.current_workspace_id;
			if (!workspaceId) {
				return res.status(409).json({ error: 'no-active-workspace' });
			}









			const quota = await ext.getQuota(req.account, 'ai_tokens');
			const inCreditMode = quota.cap != null && quota.used >= quota.cap && !quota.blocked;
			if (quota.blocked) {





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
				} catch (_eAudit) {                   }
				return res.status(402).json({
					error: 'cap-reached',
					message: "You've reached your " + quota.cap.toLocaleString() + ' tokens monthly AI quota on the ' + quota.planLabel + ' plan. Wait for the cap to reset, ask your admin to top up workspace AI credits, or upgrade for unlimited generations.',
					tokensUsed: quota.used,
					tokenCap: quota.cap,
					creditsRemaining: 0,
					currentPlan: quota.planId,
				});
			}














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
							payload: { sfError: msg.slice(0, 200), objectNames },
						});
					} catch (_eAudit) {                   }





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




				system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
				tools: [AI_PLAN_TOOL],
				tool_choice: { type: 'tool', name: 'create_plan' },
				messages: [{ role: 'user', content: text.trim() }],
			});
			const toolUse = (response.content || []).find((b) => b.type === 'tool_use' && b.name === 'create_plan');
			if (!toolUse) {




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
				} catch (_eAudit) {                   }
				return res.status(502).json({ error: 'no-plan', message: 'Model returned no plan. Try rephrasing.' });
			}
			const validated = validateAiPlan(toolUse.input || {}, describes);
			if (validated.records.length === 0) {


				console.warn('[ai/plan] empty plan after validation', {
					promptLength: typeof text === 'string' ? text.length : 0,
					objectNames,
					rawRecordCount: Array.isArray(toolUse.input && toolUse.input.records) ? toolUse.input.records.length : 0,
					warnings: validated.warnings,
				});
			}








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






			try {
				let _wsId = null;
				try {
					const _view = await viewStateDb.get(req.account.id);
					_wsId = (_view && _view.current_workspace_id) || null;
				} catch (_eVs) {                        }
				await ext.auditWrite({
					req,
					workspaceId: _wsId,
					action: 'ai_generate',
					targetObject: 'ai',
					targetSfOrgId: (req.sf && req.sf.sfOrgId) || null,
					status: 'failed',
					errorCode: (err && (err.errorCode || err.name)) || 'ai-error',
					payload: { error: (err && err.message) || String(err) },
				});
			} catch (_eAudit) {                   }
			next(err);
		}
	});

























	app.post('/api/upload', requireAccount, requireSfConnection, async (req, res, next) => {
		try {
			if (rejectIfOverPayloadCap(req, res)) {
return;
}
			if (!await _gateCapability(req, res, 'upload-records', 'upload')) {
return;
}




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





			const allowDuplicates = !!req.body?.allowDuplicates;
			const _writeOpts = allowDuplicates
				? { headers: { 'Sforce-Duplicate-Rule-Header': 'allowSave=true' } }
				: undefined;









			const deletesIn = _orderDeletesChildrenFirst(
				Array.isArray(req.body?.deletes) ? req.body.deletes : [],
				associations,
			);
			if (records.length === 0 && deletesIn.length === 0) {
				return res.status(400).json({ error: 'no-records' });
			}






			const _attemptId = (req.body && typeof req.body.attemptId === 'string') ? req.body.attemptId : null;
			let _twoPhaseStore = null;
			let _pendingBatchId = null;
			if (_attemptId) {
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
						message: 'A previous upload with this attempt id did not finish. Refresh to reconcile, or verify in Salesforce before retrying.',
					});
				}
			}


			const view = await viewStateDb.get(req.account.id);
			const workspaceId = view && view.current_workspace_id;
			if (!workspaceId) {
return res.status(409).json({ error: 'no-active-workspace' });
}





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








			if (_twoPhaseStore) {
				try {
					const pendingB = await _twoPhaseStore.createPending({
						source: directUpload ? 'csv-direct' : 'canvas',
						note: (req.body && typeof req.body.note === 'string') ? req.body.note : null,
						attemptId: _attemptId,
						intendedRecords: records.map((r) => ({ tempId: r.tempId, objectName: r.objectName })),
					});
					_pendingBatchId = pendingB.id;
				} catch (e) { console.warn('[two-phase pending/rest]:', e.message || e); }
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
					results.push({ tempId, objectName: rec.objectName, success: false, error: 'Record is part of a reference cycle — upload it manually or break the cycle.' });
					continue;
				}





				if (skipTempIds.has(tempId) && rec.loadedFromId) {
					realIdByTempId.set(tempId, rec.loadedFromId);
					results.push({ tempId, objectName: rec.objectName, success: true, id: rec.loadedFromId, mode: 'unchanged' });
					continue;
				}


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



			const byId = new Map(results.map((r) => [r.tempId, r]));
			const orderedResults = records.map((r) => byId.get(r.tempId)).filter(Boolean);

			const successCount = orderedResults.filter((r) => r && r.success).length;
			const failureCount = orderedResults.length - successCount;










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



			if (!directUpload && successCount > 0) {
				try {
					await ext.chargeQuota(req.account, 'uploads', 1);
				} catch (e) {
 console.warn('[usage] upload increment failed:', e.message || e); 
}
			}









			try {
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
							error: r.success ? undefined : (r.error || null),
						},
					});
				}





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
							error: d.success ? undefined : (d.error || null),
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
						failureCount,
						deleteSuccessCount,
						deleteFailureCount,
						requested: records.length,
						requestedDeletes: deletesIn.length,
						directUpload,


						allowDuplicates: allowDuplicates || undefined,
						objectBreakdown: uploadObjectBreakdown,
						errorCodeCounts: Object.keys(uploadErrorCodes).length ? uploadErrorCodes : undefined,
						associations: Object.keys(uploadAssocCounts).length ? uploadAssocCounts : undefined,
					},
				});





				if (successCount > 0) {
					auditDb.recordFirstTime(req, {
						actorAccountId: req.account.id,
						action: 'records_first_upload',
						workspaceId,
						targetSfOrgId: req.sf.sfOrgId,
						payload: { successCount, objects },
					}).catch(() => {});
				}
			} catch (e) {
 console.warn('[audit] upload log failed:', e.message || e); 
}






			let batchId = null;







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
			if (successCount > 0 || successfulDeletes.length > 0) {
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


			if (_pendingBatchId && successCount === 0 && successfulDeletes.length === 0) {
				try { await _twoPhaseStore.remove(_pendingBatchId); } catch (e) {                   }
			}







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
			} catch (e) {                         }
			res.json(created);
		} catch (err) {
 next(err); 
}
	});




	app.get('/api/upload-batches', requireAccount, requireSfConnection, async (req, res, next) => {
		try {
			const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
			const batchStore = await uploadBatchesStoreFromSfConnection(req.sf.conn, req.sf.sfUserId, req.sf.sfOrgId, { sessionId: req.session && req.session.id });
			const batches = await batchStore.list({ limit });



			res.json({ batches });
		} catch (err) {
 next(err); 
}
	});



	app.get('/api/upload-batches/:id', requireAccount, requireSfConnection, async (req, res, next) => {
		try {
			const batchStore = await uploadBatchesStoreFromSfConnection(req.sf.conn, req.sf.sfUserId, req.sf.sfOrgId, { sessionId: req.session && req.session.id });




			const batch = await batchStore.get(req.params.id);
			if (!batch) {
return res.status(404).json({ error: 'not-found' });
}
			res.json({ batch });
		} catch (err) {
 next(err); 
}
	});





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






			const skipSfIds = Array.isArray(req.body && req.body.skipSfIds) ? req.body.skipSfIds : [];








			const revertSelections = Array.isArray(req.body && req.body.revertSelections)
				? req.body.revertSelections
				: [];


			try {
 await batchStore.markRecalling(batch.id); 
} catch (_e) {                   }
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






			const succeeded = recallResult.succeeded || 0;
			const alreadyDeleted = recallResult.alreadyDeleted || 0;
			const failed = recallResult.failed || 0;
			const preservedUpdatesCount = recallResult.preservedUpdatesCount || 0;
			const status = recallResult.status || 'recalled';
			try {
 await batchStore.markRecallResult(batch.id, { status, recallResult }); 
} catch (_e) {                   }





			let _recallWorkspaceId = null;
			try {
				const _view = await viewStateDb.get(req.account.id);
				_recallWorkspaceId = (_view && _view.current_workspace_id) || null;
			} catch (_eVs) {                  }



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
				revertResults: recallResult.revertResults || [],
				results: recallResult.results,
			});
		} catch (err) {
 next(err); 
}
	});








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






			const allowDuplicates = !!req.body?.allowDuplicates;






			const deletesIn = _orderDeletesChildrenFirst(
				Array.isArray(req.body?.deletes) ? req.body.deletes : [],
				associations,
			);
			if (records.length === 0 && deletesIn.length === 0) {
				return res.status(400).json({ error: 'no-records' });
			}










			const _attemptId = (req.body && typeof req.body.attemptId === 'string') ? req.body.attemptId : null;
			let _twoPhaseStore = null;
			let _pendingBatchId = null;
			if (_attemptId) {
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
						message: 'A previous upload with this attempt id did not finish. Refresh to reconcile, or verify in Salesforce before retrying.',
					});
				}
			}

			const view = await viewStateDb.get(req.account.id);
			const workspaceId = view && view.current_workspace_id;
			if (!workspaceId) {
return res.status(409).json({ error: 'no-active-workspace' });
}






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
					message: 'A connected record component exceeds ' + GRAPH_PER_GRAPH_CAP + ' nodes — fall back to REST or Bulk.',
				});
			}
			const totalSubmitted = components.reduce((n, c) => n + c.length, 0);
			if (totalSubmitted > GRAPH_TOTAL_NODES_CAP) {
				return res.status(400).json({
					error: 'graph-total-too-large',
					message: 'Total nodes exceed ' + GRAPH_TOTAL_NODES_CAP + ' — fall back to REST or Bulk.',
				});
			}







			if (_twoPhaseStore) {
				try {
					const pendingB = await _twoPhaseStore.createPending({
						source: directUpload ? 'csv-direct' : 'canvas-graph',
						note: (req.body && typeof req.body.note === 'string') ? req.body.note : null,
						attemptId: _attemptId,
						intendedRecords: records.map((r) => ({ tempId: r.tempId, objectName: r.objectName })),
					});
					_pendingBatchId = pendingB.id;
				} catch (e) { console.warn('[two-phase pending/graph]:', e.message || e); }
			}



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






					try {
						ext.captureException(err, {
							where: 'canvas-routes/upload/buildDescribesMap',
							objectName: name,
						});
					} catch (_) {                                                          }
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
						payload: { mode: 'graph', requested: records.length, error: (err && err.message || 'graph upload failed').slice(0, 200) },
					});
				} catch (e) {
 console.warn('[audit] graph error log failed:', e.message || e); 
}
				return res.status(502).json({
					results: [],
					error: (err && err.message) || 'Composite Graph upload failed.',
				});
			}

			const respGraphs = (graphResp && graphResp.graphs) || [];
			const results = [];


			cycleIds.forEach((id) => {
				const rec = recordsById.get(id);
				if (rec) {
					results.push({
						tempId: id,
						objectName: rec.objectName,
						success: false,
						error: 'Record is part of a reference cycle — break the cycle and re-upload.',
					});
				}
			});

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

			if (!directUpload && successCount > 0) {
				try {
 await ext.chargeQuota(req.account, 'uploads', 1); 
} catch (e) {
 console.warn('[usage]:', e.message || e); 
}
			}









			const deleteResults = [];
			const someGraphCommitted = successCount > 0;
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
							error: r.success ? undefined : (r.error || null),
						},
					});
				}



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
							error: d.success ? undefined : (d.error || null),
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
						failureCount: orderedResults.length - successCount,
						deleteSuccessCount,
						deleteFailureCount,
						requested: records.length,
						requestedDeletes: deletesIn.length,
						directUpload,
						atomicSuccess: allAtomicSuccess,


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
			if (successCount > 0 || successfulDeletes.length > 0) {
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





			if (_pendingBatchId && successCount === 0 && successfulDeletes.length === 0) {
				try { await _twoPhaseStore.remove(_pendingBatchId); } catch (e) {                   }
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
						firstError: errors[0] && errors[0].message ? errors[0].message.slice(0, 200) : null,
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





			const deletesIn = _orderDeletesChildrenFirst(
				Array.isArray(req.body?.deletes) ? req.body.deletes : [],
				associations,
			);


			if (records.length === 0 && deletesIn.length === 0) {
				return res.status(400).json({ error: 'no-records' });
			}




			const view = await viewStateDb.get(req.account.id);
			const workspaceId = view && view.current_workspace_id;
			if (!workspaceId) {
return res.status(409).json({ error: 'no-active-workspace' });
}



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






			const _attemptId = (req.body && typeof req.body.attemptId === 'string') ? req.body.attemptId : null;
			let _twoPhaseStore = null;
			let _pendingBatchId = null;
			if (_attemptId) {
				try {
					_twoPhaseStore = await uploadBatchesStoreFromSfConnection(req.sf.conn, req.sf.sfUserId, req.sf.sfOrgId, { sessionId: req.session && req.session.id });
				} catch (e) { console.warn('[two-phase store/bulk]:', e.message || e); }
			}
			if (_twoPhaseStore) {








				try {
					const prior = await _twoPhaseStore.findByAttemptId(_attemptId);
					if (prior && (prior.status === 'uploaded' || prior.status === 'pending')) {
						return res.status(409).json({
							error: 'upload-attempt-incomplete',
							batchId: prior.id,
							status: prior.status,
							message: prior.status === 'uploaded'
								? 'This upload attempt already completed. Refresh to reconcile the results.'
								: 'A previous upload with this attempt id did not finish. Refresh to reconcile, or verify in Salesforce before retrying.',
						});
					}
				} catch (e) { console.warn('[two-phase lookup/bulk]:', e.message || e); }
				try {
					const pendingB = await _twoPhaseStore.createPending({
						source: directUpload ? 'csv-bulk' : 'canvas-bulk',
						note: (req.body && typeof req.body.note === 'string') ? req.body.note : null,
						attemptId: _attemptId,
						intendedRecords: records.map((r) => ({ tempId: r.tempId, objectName: r.objectName })),
					});
					_pendingBatchId = pendingB.id;
				} catch (e) { console.warn('[two-phase pending/bulk]:', e.message || e); }
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

			const conn = req.sf.conn;
			const apiVersion = conn.version || '60.0';
			const apiBase = '/services/data/v' + apiVersion;
			const FAKE_REF_ID = '001000000000001';
			const getDescribe = makeDescribeCache(conn);

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
					error: 'Record is part of a reference cycle — break the cycle and re-upload.',
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












							values = stripUnwritableFields(values, describe, group.operation === 'update' || group.operation === 'upsert');
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
				if (!directUpload && successCount > 0) {
					try {
 await ext.chargeQuota(req.account, 'uploads', 1); 
} catch (e) {
 console.warn('[usage]:', e.message || e); 
}
				}
				try {





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
								error: r.success ? undefined : (r.error || null),
							},
						});
					}



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
								error: d.success ? undefined : (d.error || null),
							},
						});
					}







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
				if (successCount > 0 || successfulDeletes.length > 0) {
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




				if (_pendingBatchId && successCount === 0 && successfulDeletes.length === 0) {
					try { await _twoPhaseStore.remove(_pendingBatchId); } catch (e) {                   }
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
						payload: { requested: records.length, error: ((err && err.message) || 'failed').slice(0, 200) },
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







			const valueDrift = await classifyValueDrift({
				conn: req.sf.conn,
				batch: { insertedIds: batch.insertedIds },
			});









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










			const out = req.query.raw === '1'
				? list
				: list.filter((o) => o.queryable !== false && o.createable && !isNoiseSObject(o.name));
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
			} catch (e) {                              }
			res.json(record);
		} catch (err) {
 next(err); 
}
	});



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







			let referenceTargets = null;
			try {
				const sourceDescribe = await conn.sobject(name).describe();
				const fieldMeta = (sourceDescribe.fields || []).find((f) => f.name === fieldName);
				if (fieldMeta && Array.isArray(fieldMeta.referenceTo)) {
					referenceTargets = fieldMeta.referenceTo;
				}
			} catch (_e) {                                      }

			const params = new URLSearchParams();
			if (q) {
params.set('q', q);
}
			if (recordTypeId) {
params.set('recordTypeId', recordTypeId);
}



			if (targetApiNameParam) {
				params.set('targetApiName', targetApiNameParam);
			} else if (referenceTargets && referenceTargets.length > 1) {


				params.set('targetApiName', referenceTargets[0]);
			}







			if (sourceRecordId && /^[a-zA-Z0-9]{15,18}$/.test(sourceRecordId)) {
				params.set('sourceRecordId', sourceRecordId);
			}



			if (q) {
params.set('searchType', 'Search');
}


			const url = apiBase + '/ui-api/lookups/' + encodeURIComponent(name) + '/' + encodeURIComponent(fieldName) + (params.toString() ? '?' + params.toString() : '');
			try {
				const data = await conn.request(url);








				let rawRecords = [];
				if (data && data.lookupResults && typeof data.lookupResults === 'object') {
					for (const groupKey of Object.keys(data.lookupResults)) {
						const group = data.lookupResults[groupKey];
						if (group && Array.isArray(group.records)) {
rawRecords = rawRecords.concat(group.records);
}
					}
				} else if (data && Array.isArray(data.records)) {
					rawRecords = data.records;
				}
				const records = rawRecords.map((r) => {




					let title = null;
					if (r.fields) {
						const nameCandidates = ['Name', 'Subject', 'Title', 'CaseNumber', 'FullName'];
						for (const k of nameCandidates) {
							if (r.fields[k] && r.fields[k].value != null && r.fields[k].value !== '') {
								title = String(r.fields[k].value);
								break;
							}
						}



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








				const filteredRecords = sourceRecordId
					? records.filter((r) => r.id && r.id.slice(0, 15) !== sourceRecordId.slice(0, 15))
					: records;




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




			const skeleton = _maskSoqlSkeleton(soqlRaw);
			const fromMatch = skeleton.match(/\bFROM\s+(\w+)/i);
			if (!fromMatch) {
				return res.status(400).json({ error: 'no-from-clause' });
			}
			let objectName = fromMatch[1];





			if (SOQL_OBJECT_DENYLIST.has(objectName.toLowerCase())) {
				return res.status(400).json({
					error: 'object-not-allowed',
					message: 'Querying ' + objectName + ' is not allowed here — SOQL import is for business records, not code, metadata, or security/setup objects.',
				});
			}

			const outerSelect = skeleton.match(/^SELECT\b\s+([\s\S]+?)\s+FROM\b/i);
			if (outerSelect && /\b(COUNT|SUM|AVG|MIN|MAX|COUNT_DISTINCT)\b/i.test(outerSelect[1])) {
				return res.status(400).json({
					error: 'aggregate-not-supported',
					message: 'Aggregate queries (COUNT, SUM, etc.) are not supported — return record rows instead.',
				});
			}














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








			if (parentDescribe && parentDescribe.name) {
objectName = parentDescribe.name;
}
			const childRelByName = new Map();
			(parentDescribe.childRelationships || []).forEach((cr) => {
				if (cr && cr.relationshipName) {
childRelByName.set(cr.relationshipName.toLowerCase(), cr);
}
			});



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



				if (childRel.childSObject && SOQL_OBJECT_DENYLIST.has(childRel.childSObject.toLowerCase())) {
					return res.status(400).json({
						error: 'object-not-allowed',
						message: 'Subquery on ' + childRel.childSObject + ' is not allowed here — SOQL import is for business records, not code, metadata, or security/setup objects.',
					});
				}





			}
			const parentFieldNames = new Set((parentDescribe.fields || []).map((f) => f.name));





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
						soql: soqlRaw.slice(0, 500),
						objectName,
						returnedRows: result.records.length,
						totalRecordsAdded: records.length,
						totalSize: result.totalSize || 0,
						fullFields,
					},
				});
			} catch (e) {               }








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





			try {
				const soqlRaw = String((req.body && req.body.soql) || '').trim();
				await ext.auditWrite({
					req,
					action: 'soql_query',
					targetSfOrgId: (req.sf && req.sf.sfOrgId) || null,
					status: 'failed',
					errorCode: (err && (err.errorCode || err.name)) || 'query-failed',
					payload: { soql: soqlRaw.slice(0, 500), error: (err && err.message) || String(err) },
				});
			} catch (_eAudit) {                   }
			res.status(500).json({ error: 'query-failed', message: (err && err.message) || 'Query failed.' });
		}
	});







	app.get('/api/objects/:name/graph', requireAccount, requireSfConnection, async (req, res, next) => {
		try {
			const conn = req.sf.conn;
			const name = req.params.name;





			if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
				return res.status(400).json({ error: 'invalid-object-name' });
			}
			const describe = await conn.sobject(name).describe();
			const queryableSet = await getQueryableSObjects(conn, req.sf.sfOrgId);


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


	app.get('/api/objects/:name/validation-rules', requireAccount, requireSfConnection, async (req, res) => {
		const name = req.params.name;
		if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
			return res.status(400).json({ error: 'invalid-object-name' });
		}
		try {





			const soql = `SELECT Id, FullName, Metadata FROM ValidationRule WHERE EntityDefinition.QualifiedApiName = '${name}'`;
			const result = await req.sf.conn.tooling.query(soql);
			res.json(transformToolingRecords(result.records));
		} catch (err) {
			res.json({ unavailable: true, reason: err.message || 'Could not load validation rules.' });
		}
	});















































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



			const byObject = new Map();
			const inputIndex = [];
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





			const byKey = new Map();
			const objectErrors = new Map();
			for (const [objectName, ids] of byObject) {
				try {
					const got = await conn.sobject(objectName).retrieve(ids);
					const arr = Array.isArray(got) ? got : [got];
					arr.forEach((rec, idx) => {
						const id = ids[idx];
						if (!rec) {
							return;
						}

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




			const describe = await req.sf.conn.sobject(objectName).describe();
			const fieldByName = new Map();
			for (const f of (describe.fields || [])) {
				if (f && f.name) {
fieldByName.set(f.name, f);
}
			}







			function _soqlString(v) {
				return "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
			}

			function _soqlId(v) {
				const s = String(v).trim();
				if (!/^[a-zA-Z0-9]{15,18}$/.test(s)) {
throw new Error('Invalid Salesforce id: ' + s);
}
				return "'" + s + "'";
			}



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




			function _compileFilter(filt) {
				if (!filt || typeof filt !== 'object') {
return null;
}
				const fieldName = String(filt.field || '').trim();
				if (!fieldName || !fieldByName.has(fieldName)) {
					throw new Error('Unknown field: ' + fieldName);
				}
				const field = fieldByName.get(fieldName);
				if (!field.filterable) {
					throw new Error('Field is not filterable: ' + fieldName);
				}
				const op = String(filt.op || '').trim();
				const v = filt.value;

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





			let orderClause = '';
			if (sortField) {
				if (!fieldByName.has(sortField)) {
					return res.status(400).json({ error: 'invalid-sort-field' });
				}
				orderClause = ` ORDER BY ${sortField} ${sortDirection} NULLS LAST`;
			}






			const previewFields = ['Id'];
			const nameFieldDesc = (describe.fields || []).find((f) => f && f.nameField);
			if (nameFieldDesc) {
previewFields.push(nameFieldDesc.name);
}




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




			const loadSoql = `SELECT Id FROM ${objectName}${whereClause}${orderClause}`;




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







	app.post('/api/migrate/match', requireAccount, _rateLimitSfReads, requireSfConnection, async (req, res, next) => {
		const VALUES_MAX = 2000;
		const CHUNK = 200;
		try {


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

			if (SOQL_OBJECT_DENYLIST.has(objectName.toLowerCase())) {
				return res.status(400).json({ error: 'object-not-allowed' });
			}
			const rawValues = Array.isArray(body.values) ? body.values : [];

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
				return res.json({ matchesByValue: {}, ambiguous: [], matched: 0, total: 0 });
			}

			const conn = req.sf.conn;

			const describe = await conn.sobject(objectName).describe();
			const fieldMeta = (describe.fields || []).find((f) => f && f.name === keyField);
			if (!fieldMeta) {
				return res.status(400).json({ error: 'unknown-key-field' });
			}
			if (fieldMeta.filterable === false) {
				return res.status(400).json({ error: 'key-field-not-filterable' });
			}

			const matchesByValue = {};
			const ambiguousSet = new Set();
			for (let i = 0; i < values.length; i += CHUNK) {
				const slice = values.slice(i, i + CHUNK);
				const inList = slice.map((v) => "'" + escapeSoqlLiteral(v) + "'").join(',');
				const soql = 'SELECT Id, ' + keyField + ' FROM ' + objectName +
					' WHERE ' + keyField + ' IN (' + inList + ')';
				const result = await conn.query(soql);
				for (const rec of (result.records || [])) {
					const kv = rec[keyField];
					if (kv === null || kv === undefined) {
						continue;
					}
					const ks = String(kv);
					if (ambiguousSet.has(ks)) {
						continue;
					}
					if (Object.prototype.hasOwnProperty.call(matchesByValue, ks)) {

						delete matchesByValue[ks];
						ambiguousSet.add(ks);
						continue;
					}
					matchesByValue[ks] = rec.Id;
				}
			}
			return res.json({
				matchesByValue,
				ambiguous: Array.from(ambiguousSet),
				matched: Object.keys(matchesByValue).length,
				total: values.length,
			});
		} catch (err) {
			next(err);
		}
	});


	app.get('/api/objects/:name/search', requireAccount, requireSfConnection, async (req, res, next) => {
		const name = req.params.name;
		if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
			return res.status(400).json({ error: 'invalid-object-name' });
		}
		try {
			const conn = req.sf.conn;
			const describe = await conn.sobject(name).describe();
			const nameField = (describe.fields.find((f) => f.nameField) || { name: 'Name' }).name;
			const q = String(req.query.q || '').trim();
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
			const escapedId = escapeSoqlLiteral(id);
			const soql = 'SELECT COUNT() FROM ' + name + ' WHERE ' + field + " = '" + escapedId + "'";
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
						const escapedId = escapeSoqlLiteral(id);
						const soql = 'SELECT COUNT() FROM ' + name + ' WHERE ' + field + " = '" + escapedId + "'";
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



			const selectable = Array.from(new Set(['Id'].concat(
				describe.fields
					.filter((f) => (f.createable || f.nameField) && f.type !== 'address' && f.type !== 'location')
					.map((f) => f.name),
			)));
			const escapedId = escapeSoqlLiteral(id);
			const soql = 'SELECT ' + selectable.join(', ') + ' FROM ' + name + ' WHERE ' + field + " = '" + escapedId + "' LIMIT " + limit;
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
			const nameField = (describe.fields.find((f) => f.nameField) || { name: 'Name' }).name;
			const escapedId = escapeSoqlLiteral(id);
			const escapedQ = escapeSoqlLiteral(q);
			const filters = [field + " = '" + escapedId + "'"];
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


	app.post('/api/objects/:name/records', requireAccount, requireSfConnection, async (req, res) => {
		try {






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
			} catch (e) {                   }
			res.json(result);
		} catch (err) {
			try {
				await ext.auditWrite({
					req,
					action: 'record_insert',
					targetObject: req.params.name,
					targetSfOrgId: req.sf.sfOrgId,
					payload: { error: (err && err.message) || String(err), errorCode: err && err.errorCode || null },
				});
			} catch (e) {                   }
			res.status(400).json({
				error: err.message || String(err),
				errorCode: err.errorCode,
				fields: err.fields,
			});
		}
	});




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













	app.get('/api/connections', requireAccount, async (req, res, next) => {
		try {
			const list = await connectionsDb.listForAccount(req.account.id);
			const view = await viewStateDb.get(req.account.id);
			const activeId = (view && view.current_connection_id) || null;




			const sfAuth = req.session && req.session.sfAuth;
			const activeSfUserId = (sfAuth && sfAuth.sfUserId) || null;
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
					canResume: activeSfUserId !== null && c.sf_user_id === activeSfUserId,
				})),
			});
		} catch (err) {
 next(err); 
}
	});




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










































			const sfAuth = req.session && req.session.sfAuth;
			const identityMatches = sfAuth
				&& sfAuth.sfUserId === c.sf_user_id
				&& sfAuth.sfOrgId === c.sf_org_id;
			if (!identityMatches) {










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
					&& /^https:\/\/[a-z0-9.-]+\.(salesforce|force)\.com(\/.*)?$/i.test(c.instance_url)) {
					loginUrl += '&loginUrl=' + encodeURIComponent(c.instance_url.replace(/\/+$/, ''));
				}
				return res.status(409).json({ error: 'reauth-required', loginUrl });
			}








			req.session.currentConnectionId = c.id;
			await viewStateDb.setCurrentConnection(req.account.id, c.id);
			await connectionsDb.touchLastUsed(c.id);
			await _auditConnectionActivated(req, c, 'active-session');
			res.json({ ok: true, connectionId: c.id });
		} catch (err) {
 next(err);
}
	});












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




			const view = await viewStateDb.get(req.account.id);
			const wasActive = view && view.current_connection_id === c.id;
			if (wasActive) {
				await viewStateDb.setCurrentConnection(req.account.id, null);
				if (req.session && req.session.sfAuth && req.session.sfAuth.sfUserId === c.sf_user_id) {
					delete req.session.sfAuth;
				}
			}



			dropRefreshToken(req.session && req.session.id, c.id);

			if (req.session && req.session.sfAuthByConnection) {
				delete req.session.sfAuthByConnection[c.id];
			}











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

































	app.get('/api/canvas/:id/proposals', requireAccount, async (req, res, next) => {
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
			const all = await proposalsDb.listPendingForCanvas(canvasId);


			const visible = all.filter((p) => p.workspaceId === workspaceId);
			res.json({ proposals: visible });
		} catch (err) {
 next(err); 
}
	});
















	app.post('/api/canvas/:id/proposals/:proposalId/apply', requireAccount, requireSfConnectionUnlessDraft, async (req, res, next) => {
		try {
			const canvasId = req.params.id;
			const proposalId = req.params.proposalId;


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

			const view = await viewStateDb.get(req.account.id);
			const workspaceId = view && view.current_workspace_id;
			if (workspaceId !== proposal.workspaceId) {
				return res.status(403).json({ error: 'workspace-mismatch' });
			}







			if (!await _gateCapability(req, res, 'ai-edit-on-canvas', 'proposal_apply')) {
				return;
			}




			const overrides = (req.body && req.body.overrides) || {};



			const skipIds = new Set(Array.isArray(req.body && req.body.skipRecordIds)
				? req.body.skipRecordIds.map(String) : []);






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







			let nextTempId = 1;
			for (const d of newDrafts) {
				if (typeof d.tempId === 'number' && d.tempId >= nextTempId) {
nextTempId = d.tempId + 1;
}
			}
			const newDraftResults = [];



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



					fields: Object.assign({}, c.fields || {}),



					tempRef: c.tempRef || undefined,
				});
			}


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





			if (!isDraft) {
				try {
					await store.update(canvasId, { payload: newPayload });
				} catch (err) {
					saveError = err.message || String(err);
				}
			}





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




			for (const r of newDraftResults) {
				results.push(Object.assign({}, r, {
					status: saveError ? 'failed' : 'applied',
					error: saveError || undefined,
				}));
			}



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






			for (const op of autofillOps) {
				results.push({
					kind: 'autofill-required',
					tempIds: Array.isArray(op.tempIds) ? op.tempIds.slice() : [],
					status: saveError ? 'failed' : 'applied',
					error: saveError || undefined,
				});
			}











			if (loadRecordOps.length > 0 && (!req.sf || !req.sf.conn)) {
				try {
					const bundle = await getActiveSfConnection(req);
					if (bundle) {
req.sf = bundle;
}
				} catch (_) {                                              }
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
						error: 'no-active-sf-connection — connect Salesforce to load existing records',
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












			await ext.auditWrite({
				req,
				workspaceId: proposal.workspaceId,
				action: 'ai_proposal_applied',
				targetObject: 'ai_proposals',
				targetId: proposalId,



				targetSfOrgId: (req.sf && req.sf.sfOrgId) || null,
				payload: {
					canvasId,
					mode: isDraft ? 'draft-canvas-only' : 'canvas-only',






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



			const now = Date.now();
			const visible = all.filter((c) => c.workspaceId === workspaceId && (!c.expiresAt || c.expiresAt > now));
			res.json({ clarifications: visible });
		} catch (err) {
 next(err); 
}
	});




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









			if (isSf) {
				const bundle = await getActiveSfConnection(req);
				if (!bundle || !bundle.conn) {
					return res.status(409).json({ error: 'no-active-connection', message: 'Connect or activate a Salesforce org to continue.' });
				}
				let accessible = false;
				try {
					const store = await canvasStoreFromSfConnection(bundle.conn, bundle.sfUserId, bundle.sfOrgId, { sessionId: req.session && req.session.id });
					accessible = !!(await store.get(canvasId));
				} catch (e) {
					accessible = false;
				}
				if (!accessible) {
					return res.status(404).json({ error: 'not-found' });
				}
			}
			res.setHeader('Content-Type', 'text/event-stream');
			res.setHeader('Cache-Control', 'no-cache, no-transform');
			res.setHeader('Connection', 'keep-alive');
			res.setHeader('X-Accel-Buffering', 'no');
			res.flushHeaders && res.flushHeaders();
			const displayName = (req.account.display_name || req.account.email || 'Someone').toString();
			canvasPresence.subscribe({
				canvasId,
				workspaceId,
				accountId: req.account.id,
				displayName,
				sseRes: res,
			});



		} catch (err) {
 next(err); 
}
	});







	app.post('/api/canvas/:id/presence/cursor', requireAccount, async (req, res, next) => {
		try {
			const canvasId = req.params.id;
			const connectionId = req.body && req.body.connectionId;
			const x = req.body && typeof req.body.x === 'number' ? req.body.x : null;
			const y = req.body && typeof req.body.y === 'number' ? req.body.y : null;
			const world = !!(req.body && req.body.world);
			if (!connectionId) {
return res.status(400).json({ error: 'missing-connectionId' });
}
			canvasPresence.updateCursor({ canvasId, connectionId, x, y, world, requestingAccountId: req.account.id });
			res.json({ ok: true });
		} catch (err) {
 next(err); 
}
	});





	app.post('/api/canvas/:id/presence/focus', requireAccount, async (req, res, next) => {
		try {
			const canvasId = req.params.id;
			const connectionId = req.body && req.body.connectionId;
			const focus = req.body && req.body.focus ? req.body.focus : null;
			if (!connectionId) {
return res.status(400).json({ error: 'missing-connectionId' });
}
			canvasPresence.updateFocus({ canvasId, connectionId, focus, requestingAccountId: req.account.id });
			res.json({ ok: true });
		} catch (err) {
 next(err); 
}
	});















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
			canvasPresence.updateDraftLink({ canvasId, connectionId, kind, fromSyncId, toSyncId, fieldName, requestingAccountId: req.account.id });
			res.json({ ok: true });
		} catch (err) {
 next(err); 
}
	});






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
			canvasPresence.removeLoadedRecord({ canvasId, connectionId, sfId, requestingAccountId: req.account.id });
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
			canvasPresence.updateDraft({
				canvasId, connectionId, tempId, fields, kind, position,
				objectName: typeof body.objectName === 'string' ? body.objectName : undefined,
				x: typeof body.x === 'number' ? body.x : undefined,
				y: typeof body.y === 'number' ? body.y : undefined,
				requestingAccountId: req.account.id,
			});
			res.json({ ok: true });
		} catch (err) {
 next(err); 
}
	});


}
