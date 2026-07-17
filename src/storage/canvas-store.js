// Canvas storage. SF Files (ContentVersion) in the customer's org.
// Sharing is via ContentDocumentLink: the same primitive any SF
// user already uses to share files in their org.
//
// (A separate Canvas__c custom-object backend used to live alongside
// this one, gated on the Org Loom managed package. That backend was
// sunset because its only genuine differentiator (the SF-side
// Audit_Event__c mirror) wasn't aligned with the dev/admin buyer
// we target today, and the dual-backend dispatch was a recurring
// source of recipient-flow consistency bugs.)
//
// Interface:
//   list()                      → { items: [{ id, title, ownerId, ownedByMe, ... }] }
//   save({ name, payload })     → { id, versionId }
//   get(id)                     → { id, title, ownerId, ownedByMe, payload, ... }
//   remove(id)                  → ok
//   listShares(canvasId)        → [{ id, entityId, entityName, entityType, accessLevel }]
//   addShare(canvasId, opts)    → { id, entityId }
//   removeShare(canvasId, sid)  → ok
//
// `ownedByMe` flags whether the loading SF user owns the file; the
// /api/canvas endpoints use this to decide whether to strip drafts
// and slot loadedFromIds before returning the payload to non-owners.

import crypto from 'node:crypto';
import { config } from '../config.js';
import { getActiveSfConnection } from '../sf-connection.js';
import { escapeSoqlLiteral } from '../sf-soql.js';
import { stripDraftValuesForSave } from '../slot-helpers.js';
import {
	generateDataKey,
	encryptPayload,
	decryptPayload,
	isEncryptedEnvelope,
	makeSfApexKekProvider,
} from './canvas-encryption.js';
import * as canvasKeys from '../database/canvas-keys.js';

const CANVAS_PATH_EXT = '.orgloom-canvas.json';

// Per-canvas in-process serialization for in-place UPDATE. update() reads
// the latest ContentVersion to compare against the caller's
// expectedVersionId, then separately writes a new ContentVersion:
// Salesforce gives no cross-call transaction, so two concurrent PUTs that
// both loaded version V would each pass the check and each write, a silent
// lost update. Serializing per (org, canvas) makes the second update read
// the first's just-committed version and get a clean 409 instead.
//
// Scope: this closes the race WITHIN one Node process (the realistic case
// on a single-instance deployment). Across multiple server instances the
// guard degrades to Salesforce's own read-your-writes consistency on the
// ordered ContentVersion query; a true cross-instance lock would need an
// Apex `FOR UPDATE` version-claim in the managed package. Module-level so
// every per-request store instance shares one lock table.
const _updateLocks = new Map(); // "org|canvas" -> tail promise
async function _acquireUpdateLock(key) {
	const prev = _updateLocks.get(key) || Promise.resolve();
	let release;
	const gate = new Promise((res) => {
		release = res;
	});
	_updateLocks.set(key, prev.then(() => gate));
	await prev.catch(() => {});
	return release;
}

// API-name helpers for the hybrid-canvas custom object. Customer
// installs use the namespace prefix (`orgloom__Orgloom_Canvas__c`).
// The prefix is hardcoded to 'orgloom' in config.js: the package is
// mandatory and the namespace doesn't vary between deployments.
function _hybridApi(name) {
	const ns = (config.canvas && config.canvas.namespacePrefix) || '';
	return ns ? `${ns}__${name}` : name;
}

// Record count for the Canvas__c metadata row. The persisted payload
// stores records as `drafts` + `loadedRecords` (the client snapshot
// shape); `bulkRecords` is the in-memory shape and never appears in a
// saved payload; it's kept only as a defensive fallback. Counting the
// wrong key was why every canvas listed with size 0.
function _countCanvasRecords(p) {
	if (!p) {
		return 0;
	}
	if (Array.isArray(p.drafts) || Array.isArray(p.loadedRecords)) {
		return (p.drafts || []).length + (p.loadedRecords || []).length;
	}
	return Array.isArray(p.bulkRecords)
		? p.bulkRecords.filter((r) => r && !r.isTypeNode).length
		: 0;
}

// Dual-write: persists the same canvas metadata to the
// orgloom__Orgloom_Canvas__c custom object in addition to the legacy
// ContentDocument-only path. Best-effort: failures here MUST NOT fail
// the save (ContentDocument is still the source of truth during the
// dual-write phase). Idempotent on re-save: upsert by Canvas_Id__c
// external id + skip CDL insert when one already links the file to the
// record. See docs/canvas-hybrid.md (forthcoming) for the read-path
// contract this writes against.
async function _writeHybridCanvasRecord(conn, args) {
	const obj = _hybridApi('Orgloom_Canvas__c');
	const field = (n) => _hybridApi(n);
	const recordPayload = {
		[field('Canvas_Id__c')]: args.canvasId,
		[field('Body_Document_Id__c')]: args.contentDocumentId,
		[field('Last_Edited_At__c')]: new Date().toISOString(),
		[field('Record_Count__c')]: args.recordCount,
		[field('Body_Sha256__c')]: args.bodySha256,
		[field('Encryption_Key_Version__c')]: args.encryptionKeyVersion,
		[field('Schema_Version__c')]: 1,
	};
	if (args.sfUserId) {
		recordPayload[field('Owner_Sf_User_Id__c')] = args.sfUserId;
	}
	// jsforce supports upsert with an external-id field on the second arg.
	await conn.sobject(obj).upsert(recordPayload, field('Canvas_Id__c'));

	// Look up the record Id so we can attach the CDL. We can't grab it
	// from the upsert response when going via External Id without a
	// follow-up query. (jsforce returns { success, id } but the id is
	// the row id only for inserts; upserts that hit the conflict path
	// return success=true and no id.)
	const lookupSoql = `SELECT Id FROM ${obj} WHERE ${field('Canvas_Id__c')} = '${escapeSoqlLiteral(args.canvasId)}' LIMIT 1`;
	const lookup = await conn.query(lookupSoql);
	if (!lookup.records || lookup.records.length === 0) {
		throw new Error('Canvas record not found after upsert by Canvas_Id__c');
	}
	const canvasRecordId = lookup.records[0].Id;

	// Insert the inferred-share CDL only if one doesn't already exist
	// for this (record, file) pair. Re-saves keep the same
	// ContentDocumentId, so the link survives across versions.
	const cdlSoql = `SELECT Id FROM ContentDocumentLink WHERE LinkedEntityId = '${escapeSoqlLiteral(canvasRecordId)}' AND ContentDocumentId = '${escapeSoqlLiteral(args.contentDocumentId)}' LIMIT 1`;
	const cdlExisting = await conn.query(cdlSoql);
	if (!cdlExisting.records || cdlExisting.records.length === 0) {
		await conn.sobject('ContentDocumentLink').create({
			LinkedEntityId: canvasRecordId,
			ContentDocumentId: args.contentDocumentId,
			ShareType: 'I',
			Visibility: 'AllUsers',
		});
	}
	return { canvasRecordId };
}

function _sanitizeFileName(name) {
	const safe = String(name || 'canvas').replace(/[^a-zA-Z0-9_\-. ]+/g, '_').slice(0, 80);
	return (safe || 'canvas') + CANVAS_PATH_EXT;
}

// Inner store factory: accepts a pre-built jsforce Connection, the SF
// user id whose perspective governs `ownedByMe`, and the SF org id used
// to partition canvas data keys in our local canvas_keys table. Both
// canvasStoreFor(req) (regular sender) and canvasStoreForConnection
// (owner-keyed for share-recipient flows) funnel through here so they
// stay behaviorally identical except for whose connection is making
// the SF API calls.
//
// Encryption: ContentVersion.VersionData is an OLE2 envelope (see
// canvas-encryption.js). The per-canvas data key lives in canvas_keys
// keyed by (sfOrgId, canvasId). Legacy plaintext canvases (saved before
// migration 026) are detected on read by the missing envelope magic
// and parsed directly as JSON; they get re-encrypted on next save.
function makeContentVersionStoreFromConnection(conn, sfUserId, sfOrgId, opts) {
	// Bind a KEK provider to this store's connection. The provider
	// re-reads conn.accessToken on every call so token renewal in the
	// same store instance flows through naturally.
	const kekProvider = makeSfApexKekProvider(conn);
	// sessionId enables the per-session DEK cache. Optional: when unset
	// (canvas-standalone, background jobs, tests), each unwrap goes to
	// the provider (correct but slower). Callers that have a session
	// pass opts.sessionId from req.session.id.
	const sessionId = (opts && opts.sessionId) || null;

	// Closure helper. Resolves the Canvas__c record id for a given canvas
	// id (currently the ContentDocumentId). Throws when no record exists
	// because every callable canvas should have a record post-cutover.
	// Declared here (not as an object method) because the methods below
	// reference outer-scope variables via closure rather than `this`;
	// the helper follows the same pattern.
	const _getHybridCanvasRecordId = async (canvasId) => {
		const obj = _hybridApi('Orgloom_Canvas__c');
		const result = await conn.query(
			'SELECT Id FROM ' + obj + ' ' +
			"WHERE " + _hybridApi('Canvas_Id__c') + " = '" + escapeSoqlLiteral(canvasId) + "' LIMIT 1"
		);
		const row = result.records && result.records[0];
		if (!row) {
			const err = new Error('Canvas record not found for id ' + canvasId);
			err.statusCode = 404;
			err.code = 'canvas-record-missing';
			throw err;
		}
		return row.Id;
	};

	return {
		backend: 'content-version',

		// SF's standard ContentDocumentLink supports ShareType 'V'
		// (Viewer / Read) and 'C' (Collaborator / Edit). Both are
		// wired here. Concurrent SaveCanvas from owner + Collaborator
		// recipient is guarded by the optimistic-lock check in
		// update() below: client sends the versionId from its last
		// GET, store verifies it matches the current
		// LatestPublishedVersion before inserting a new
		// ContentVersion, returns 409 with the new versionId on
		// mismatch.

		async list() {
			// One row per canvas, keyed by Canvas_Id__c (= the
			// ContentDocumentId of the body). We carry the file's
			// LastEdited / RecordCount from the metadata record because
			// it's cheaper than a CDL join + reading from Canvas__c also
			// honors the customer's own sharing rules: admins see what
			// they have access to, members see only their own + shared.
			// Legacy ContentDocument-only canvases (no Canvas__c row)
			// don't appear here; they were retired in the hybrid cutover.
			const obj = _hybridApi('Orgloom_Canvas__c');
			const soql =
				'SELECT Id, Name, OwnerId, ' +
				_hybridApi('Canvas_Id__c') + ', ' +
				_hybridApi('Body_Document_Id__c') + ', ' +
				_hybridApi('Record_Count__c') + ', ' +
				_hybridApi('Last_Edited_At__c') + ', ' +
				'CreatedDate, LastModifiedDate ' +
				'FROM ' + obj + ' ' +
				'ORDER BY ' + _hybridApi('Last_Edited_At__c') + ' DESC NULLS LAST LIMIT 200';
			const result = await conn.query(soql);
			const items = (result.records || []).map((r) => ({
				id: r[_hybridApi('Canvas_Id__c')] || r[_hybridApi('Body_Document_Id__c')],
				versionId: null,
				title: r.Name,
				ownerId: r.OwnerId,
				ownedByMe: !!sfUserId && r.OwnerId === sfUserId,
				size: Number(r[_hybridApi('Record_Count__c')]) || 0,
				createdAt: new Date(r.CreatedDate).getTime(),
				updatedAt: new Date(r[_hybridApi('Last_Edited_At__c')] || r.LastModifiedDate).getTime(),
			}));
			// Canvas__c.Name is an auto-number ("ORGC-0000"): the human
			// name the user typed lives on ContentDocument.Title. Resolve
			// titles in one batch query; docs the caller can't read simply
			// don't come back and keep the auto-number as a fallback label.
			const docIds = items.map((i) => i.id).filter(Boolean);
			if (docIds.length) {
				const inList = docIds.map((d) => "'" + escapeSoqlLiteral(d) + "'").join(',');
				const titleResult = await conn.query(
					'SELECT Id, Title FROM ContentDocument WHERE Id IN (' + inList + ')'
				);
				const titleById = new Map((titleResult.records || []).map((d) => [d.Id, d.Title]));
				items.forEach((i) => {
					const t = titleById.get(i.id);
					if (t) {
						i.title = t;
					}
				});
			}
			return { items };
		},

		// Count of canvases owned by the caller's SF identity. Used by
		// the Free-plan saved_canvas_cap preflight in POST /api/canvas;
		// returns 0 when sfUserId is unknown so the gate can't
		// false-positive against a user we can't identify.
		async countOwned() {
			if (!sfUserId) {
return 0;
}
			const obj = _hybridApi('Orgloom_Canvas__c');
			const soql =
				'SELECT COUNT() FROM ' + obj + ' ' +
				"WHERE OwnerId = '" + escapeSoqlLiteral(sfUserId) + "'";
			const result = await conn.query(soql);
			return Number(result.totalSize) || 0;
		},

		async save({ name, payload }) {
			// Drafts persist with values in the canvas file now, so the
			// reload + share flow shows the user's WIP records. The
			// stripDraftValuesForSave hook is a pass-through under the
			// new model (kept as a call site in case future changes
			// want to gate persistence on role or settings). The file
			// is still scoped by ContentDocumentLink: only users the
			// owner explicitly shared with can read it.
			//
			// Encryption: generate a fresh per-canvas data key, encrypt
			// the payload, post the ciphertext to SF, then persist the
			// (wrapped) data key keyed by the returned ContentDocumentId.
			// We can't bind the key before the SF call because the
			// canvas id is whatever SF assigns to the new
			// ContentDocument; if the SF call fails the key is
			// discarded (never persisted) so we don't leak orphan rows.
			const safe = stripDraftValuesForSave(payload);
			const json = JSON.stringify(safe);
			const dataKey = generateDataKey();
			const envelope = encryptPayload(json, dataKey);
			let result;
			try {
				result = await conn.sobject('ContentVersion').create({
					Title: String(name).slice(0, 255),
					PathOnClient: _sanitizeFileName(name),
					// Description surfaces in SF Files list views and admin
					// reports so an admin scanning Files can recognize
					// Org Loom canvases without opening them. Helps the
					// "ContentDocuments aren't well-tracked by admins"
					// discoverability concern without changing the
					// storage shape.
					Description: 'Org Loom workspace canvas. Encrypted by Org Loom; ' +
						'opens through the Org Loom app. See orgloom.com for details.',
					VersionData: envelope.toString('base64'),
				});
			} catch (err) {
				// jsforce can throw (not just return success:false) for some
				// SF errors; normalize so the perm-detection path below
				// catches them too.
				throw _tagContentVersionPermError(err, 'create');
			}
			if (!result.success) {
				const errs = (result.errors || []).map((e) => e.message || e).join('; ');
				throw _tagContentVersionPermError(new Error('Save failed: ' + (errs || 'unknown error')), 'create');
			}
			// Fetch the resulting ContentDocumentId so the client can
			// refer to the file by document (stable across versions)
			// instead of by version id (changes on every save).
			const cv = await conn.sobject('ContentVersion').retrieve(result.id);
			const canvasId = cv.ContentDocumentId;
			// Persist the wrapped key. If this step somehow fails after
			// the SF write succeeded, the canvas will be unreadable
			// (ciphertext on SF, no key locally); bubble the error so
			// the caller sees it rather than silently swallowing the
			// inconsistency. In practice this is a local DB write right
			// after a successful network write; failure here implies a
			// broken DB and the app has bigger problems.
			try {
				await canvasKeys.persist({ sfOrgId, canvasId, dataKey, kekProvider, sessionId });

			// Persist canvas metadata to Orgloom_Canvas__c (shipped in the
			// managed package). Required path - failure here fails the
			// save. The ContentDocument we just wrote is unreadable
			// without a matching Canvas__c record because the read path
			// resolves the body through the record's metadata. A failure
			// at this step would silently produce an orphaned
			// ContentDocument; better to throw and let the caller retry.
			const recordCount = _countCanvasRecords(safe);
			const bodySha256 = crypto.createHash('sha256').update(envelope).digest('hex');
				await _writeHybridCanvasRecord(conn, {
				canvasId,
				contentDocumentId: canvasId,
				sfUserId,
				recordCount,
				bodySha256,
				encryptionKeyVersion: 'v1',
				});
			} catch (persistErr) {
				// The ContentVersion already exists, but without both its wrapped
				// key and Canvas__c metadata it cannot be opened. Compensate by
				// removing the new ContentDocument rather than leaving an
				// unreadable encrypted file in the customer's Salesforce Files.
				try {
					await conn.sobject('ContentDocument').destroy(canvasId);
				} catch (cleanupErr) {
					console.warn('canvas-store: failed to clean up partial canvas ' + canvasId + ':', cleanupErr && cleanupErr.message);
				}
				try {
					await canvasKeys.remove({ sfOrgId, canvasId });
				} catch (cleanupErr) {
					console.warn('canvas-store: failed to clean up partial canvas key ' + canvasId + ':', cleanupErr && cleanupErr.message);
				}
				throw persistErr;
			}

			return { id: canvasId, versionId: result.id };
		},

		// Overwrite an existing canvas in place. SF semantics: a new
		// ContentVersion is created against the existing ContentDocument,
		// so the previous version is kept as a SF-side revision (the
		// document's history) and the LatestPublishedVersion advances.
		//
		// Authorization: this used to be owner-only (Orgloom-side gate).
		// As of editor-role support for non-managed-package customers,
		// any caller with SF-side Edit on the ContentDocument can save
		// - that's the owner OR anyone with a ContentDocumentLink of
		// ShareType='C' (Collaborator). SF enforces the gate on the
		// underlying ContentVersion insert; if the caller lacks edit,
		// SF returns INSUFFICIENT_ACCESS which _tagContentVersionPermError
		// turns into a clean 403 with actionable wording. We no longer
		// pre-query OwnerId for the explicit owner check.
		//
		// Optimistic locking: caller passes expectedVersionId (the
		// versionId from their last GET). We compare against the
		// current latest-ContentVersion id; mismatch → 409 with the
		// new versionId so the client can offer reload-vs-overwrite.
		// Without this check, concurrent saves from owner + editor
		// recipients would silently overwrite each other.
		async update(id, { payload, expectedVersionId }) {
			// Serialize the version-check + write for this canvas so two
			// concurrent PUTs can't both pass the check and clobber each
			// other (see _acquireUpdateLock). The whole read→write→metadata
			// sequence runs under the lock; released in finally so an error
			// path can't deadlock a later save of the same canvas.
			const _lockKey = (sfOrgId || '') + '|' + id;
			const _release = await _acquireUpdateLock(_lockKey);
			try {
				const docResult = await conn.query(
					"SELECT Id, Title FROM ContentDocument WHERE Id = '" +
					escapeSoqlLiteral(id) + "' LIMIT 1"
				);
				const doc = (docResult.records || [])[0];
				if (!doc) {
					const e = new Error('Canvas not found');
					e.statusCode = 404;
					throw e;
				}
				// Read the actual latest ContentVersion (matches the read
				// pattern in get() - LatestPublishedVersion can lag right
				// after a write, so ORDER BY CreatedDate DESC is the
				// reliable signal). Under the lock, this read observes any
				// prior same-canvas write in this process, so a concurrent
				// save that landed first is caught here as a 409.
				if (expectedVersionId) {
					const latestResult = await conn.query(
						"SELECT Id FROM ContentVersion " +
						"WHERE ContentDocumentId = '" + escapeSoqlLiteral(id) + "' " +
						'ORDER BY CreatedDate DESC LIMIT 1'
					);
					const latest = (latestResult.records || [])[0];
					const currentVersionId = latest && latest.Id;
					if (currentVersionId && currentVersionId !== expectedVersionId) {
						const e = new Error('This canvas was edited elsewhere since you opened it. Reload, then re-apply your changes.');
						e.statusCode = 409;
						e.code = 'version-mismatch';
						e.currentVersionId = currentVersionId;
						throw e;
					}
				}
				// Same persistence shape as save(). See save() comment for
				// why stripDraftValuesForSave is a pass-through under the
				// drafts-with-values model.
				//
				// Key resolution: getOrMint reuses the existing data key
				// for this canvas, or mints + persists a fresh one if
				// none exists (legacy plaintext canvas being saved for
				// the first time post-migration). After this call the
				// canvas is encrypted-only - the prior plaintext
				// ContentVersion stays as part of SF's version history
				// but the latest version is ciphertext.
				const dataKey = await canvasKeys.getOrMint({ sfOrgId, canvasId: id, kekProvider, sessionId });
				const safe = stripDraftValuesForSave(payload);
				const json = JSON.stringify(safe);
				const envelope = encryptPayload(json, dataKey);
				let result;
				try {
					result = await conn.sobject('ContentVersion').create({
						ContentDocumentId: id,
						Title: doc.Title,
						PathOnClient: _sanitizeFileName(doc.Title || 'canvas'),
						Description: 'Org Loom workspace canvas. Encrypted by Org Loom; ' +
							'opens through the Org Loom app. See orgloom.com for details.',
						VersionData: envelope.toString('base64'),
					});
				} catch (err) {
					throw _tagContentVersionPermError(err, 'update');
				}
				if (!result.success) {
					const errs = (result.errors || []).map((e) => e.message || e).join('; ');
					throw _tagContentVersionPermError(new Error('Update failed: ' + (errs || 'unknown error')), 'update');
				}
				// Refresh the Canvas__c metadata row so it tracks the version
				// just written. Without this, Body_Sha256__c matches only the
				// FIRST version forever (the read-path integrity check warns on
				// every load of a re-saved canvas), Record_Count__c freezes at
				// creation, and Last_Edited_At__c never advances - which is the
				// list()'s sort key. Owner_Sf_User_Id__c is deliberately NOT
				// passed: on a collaborator (editor-role) save, sfUserId is the
				// editor, and writing it here would silently flip recorded
				// ownership of the canvas.
				await _writeHybridCanvasRecord(conn, {
					canvasId: id,
					contentDocumentId: id,
					sfUserId: null,
					recordCount: _countCanvasRecords(safe),
					bodySha256: crypto.createHash('sha256').update(envelope).digest('hex'),
					encryptionKeyVersion: 'v1',
				});
				return { id, versionId: result.id, title: doc.Title };
			} finally {
				_release();
			}
		},

		async get(id) {
			// Hybrid-canvas metadata probe. Every canvas Org Loom can
			// open has a matching Orgloom_Canvas__c row, written by save()
			// alongside the ContentDocument. Missing record = canvas
			// pre-dates the hybrid cutover (or was created out of band)
			// and is unreadable through this code path.
			const obj = _hybridApi('Orgloom_Canvas__c');
			const probeSoql =
				'SELECT Id, ' + _hybridApi('Canvas_Id__c') + ', ' +
				_hybridApi('Body_Document_Id__c') + ', ' +
				_hybridApi('Body_Sha256__c') + ', ' +
				_hybridApi('Schema_Version__c') + ', ' +
				_hybridApi('Encryption_Key_Version__c') + ' ' +
				'FROM ' + obj + ' ' +
				"WHERE " + _hybridApi('Canvas_Id__c') + " = '" + escapeSoqlLiteral(id) + "' LIMIT 1";
			const probe = await conn.query(probeSoql);
			const _hybridMeta = (probe.records || [])[0] || null;
			if (!_hybridMeta) {
				// No Canvas__c row visible from this connection. Two causes,
				// indistinguishable here: (a) the caller's record-level share
				// was revoked / never existed - by far the common case, since
				// Canvas__c queries honor SF sharing - or (b) a genuine
				// pre-hybrid-cutover file with no metadata record. Surface
				// the neutral not-found; a revoked recipient must not get a
				// scary storage-model error (this used to throw a 410
				// "pre-cutover" message that the error handler rendered as
				// 500 internal).
				const err = new Error('Canvas not found, or you no longer have access to it.');
				err.statusCode = 404;
				err.code = 'canvas-not-accessible';
				throw err;
			}

			const docResult = await conn.query(
				'SELECT Id, Title, OwnerId, CreatedDate, LastModifiedDate ' +
				"FROM ContentDocument WHERE Id = '" + escapeSoqlLiteral(id) + "' LIMIT 1"
			);
			const doc = (docResult.records || [])[0];
			if (!doc) {
return null;
}
			// Resolve the latest version by querying ContentVersion DIRECTLY,
			// not via ContentDocument.LatestPublishedVersionId. That denormalized
			// pointer is transiently null right after a version is appended
			// (SF publish lag), which both breaks payload reads AND makes the
			// optimistic-lock check skip - the PUT route guards on
			// `&& existing.versionId`, so a null version silently downgrades a
			// concurrent save to last-write-wins. Ordering by CreatedDate DESC
			// always returns the row just written, keeping versionId reliable
			// and consistent with save()/update() (which return the new
			// ContentVersion id).
			const versionResult = await conn.query(
				"SELECT Id, VersionData, PathOnClient FROM ContentVersion " +
				"WHERE ContentDocumentId = '" + escapeSoqlLiteral(id) + "' " +
				'ORDER BY CreatedDate DESC LIMIT 1'
			);
			const v = (versionResult.records || [])[0];
			if (!v) {
return null;
}
			const path = v.PathOnClient;
			if (typeof path !== 'string' || !path.endsWith(CANVAS_PATH_EXT)) {
				const e = new Error('Not an Orgloom canvas file');
				e.statusCode = 400;
				throw e;
			}
			if (!v.VersionData) {
return null;
}
			// jsforce returns VersionData either as a base64 string
			// (small files) or a relative URL to a binary download
			// endpoint (large files). Handle both, getting a Buffer
			// either way so the envelope-detection step below can
			// peek at the magic bytes uniformly.
			let buf;
			if (typeof v.VersionData === 'string' && v.VersionData.startsWith('/')) {
				// jsforce's conn.request({ encoding: null }) is supposed
				// to return a raw Buffer, but in current versions it
				// silently decodes the response body as UTF-8 instead -
				// any non-ASCII byte (most of an encrypted envelope) gets
				// mapped to the U+FFFD replacement char (EF BF BD), and
				// decryption fails the auth tag. Fall back to a direct
				// binary fetch with the connection's access token, which
				// preserves the bytes exactly. The path on VersionData is
				// already a fully-formed /services/data/... endpoint that
				// only needs the instance URL prefix.
				const url = conn.instanceUrl.replace(/\/+$/, '') + v.VersionData;
				const response = await fetch(url, {
					headers: { Authorization: 'Bearer ' + conn.accessToken },
				});
				if (!response.ok) {
					throw new Error('VersionData fetch failed: HTTP ' + response.status);
				}
				const ab = await response.arrayBuffer();
				buf = Buffer.from(ab);
			} else {
				buf = Buffer.from(v.VersionData, 'base64');
			}
			// Integrity check. The Canvas__c record carries a sha256 of
			// the encrypted envelope captured at save time. Mismatch
			// means either (a) the ContentDocument was modified out-of-
			// band outside our save path (e.g., someone replaced the file
			// in SF UI), or (b) we hit a race where the Canvas__c update
			// fell behind a ContentVersion write. We log + continue
			// rather than throw - the dataKey decrypt step below
			// surfaces tampered ciphertext via the AES-GCM auth tag,
			// and a transient race shouldn't black out a recoverable
			// read.
			{
				const expectedShaField = _hybridApi('Body_Sha256__c');
				const expectedSha = _hybridMeta[expectedShaField];
				if (expectedSha) {
					const actualSha = crypto.createHash('sha256').update(buf).digest('hex');
					if (actualSha !== expectedSha) {
						console.warn('[hybrid-canvas] body sha256 mismatch for', id,
							'expected', expectedSha, 'got', actualSha);
					}
				}
			}
			// Envelope vs legacy plaintext: pre-migration canvases
			// stored JSON directly; post-migration canvases store an
			// OLE2 envelope. The magic header distinguishes them in a
			// single Buffer.compare so no DB lookup is wasted on
			// legacy files.
			let json;
			if (isEncryptedEnvelope(buf)) {
				const dataKey = await canvasKeys.get({ sfOrgId, canvasId: id, kekProvider, sessionId });
				if (!dataKey) {
					// Ciphertext with no key locally - happens if the
					// canvas_keys row was deleted out from under us,
					// the org id on this connection doesn't match the
					// one that saved the canvas, or the canvas was
					// saved from a different Org Loom deployment. All
					// three are unrecoverable from the read path; fail
					// loudly rather than returning garbage.
					const err = new Error("This canvas was saved with a key Org Loom can't locate. " +
						"If you saved it under a different Salesforce org, switch back to that org.");
					err.statusCode = 500;
					err.code = 'canvas-key-missing';
					throw err;
				}
				try {
					json = decryptPayload(buf, dataKey);
				} catch (e) {
					const err = new Error('This canvas could not be decrypted. The stored data may be corrupted.');
					err.statusCode = 500;
					err.code = 'canvas-decrypt-failed';
					err.cause = e;
					throw err;
				}
			} else {
				json = buf.toString('utf8');
			}
			let payload;
			try {
 payload = JSON.parse(json); 
} catch (e) {
				const err = new Error('Stored payload is not valid JSON');
				err.statusCode = 500;
				throw err;
			}
			return {
				id: doc.Id,
				versionId: v.Id,
				title: doc.Title,
				ownerId: doc.OwnerId,
				ownedByMe: !!sfUserId && doc.OwnerId === sfUserId,
				createdAt: new Date(doc.CreatedDate).getTime(),
				updatedAt: new Date(doc.LastModifiedDate).getTime(),
				payload,
			};
		},

		async remove(id) {
			const result = await conn.sobject('ContentDocument').destroy(id);
			if (!result.success) {
				const errs = (result.errors || []).map((e) => e.message || e).join('; ');
				const err = new Error('Delete failed: ' + (errs || 'unknown error'));
				err.statusCode = 403;
				throw err;
			}
			// Drop the canvas_keys row so we don't keep wrapped data
			// keys for deleted canvases around. Idempotent on the
			// no-row case (legacy plaintext canvas that never had a
			// key persisted) so this is safe even when the canvas
			// pre-dates migration 026.
			try {
				await canvasKeys.remove({ sfOrgId, canvasId: id });
			} catch (e) {
				// SF deletion already succeeded; the canvas is gone from
				// the user's perspective. A stranded canvas_keys row is
				// harmless (orphaned wrapped key with nothing to decrypt)
				// - log but don't fail the delete.

				console.warn('canvas-store: failed to drop canvas_keys row for ' + id + ':', e && e.message);
			}
			// Cascade the Canvas__c record delete. The CDL is auto-removed
			// by SF when either side (ContentDocument or LinkedEntity) is
			// deleted - no explicit CDL cleanup needed. Failure here
			// leaves an orphan Canvas__c record (no body, no CDL); we
			// log + continue rather than rolling back the ContentDocument
			// delete, since the user's primary intent already succeeded.
			try {
				const obj = _hybridApi('Orgloom_Canvas__c');
				const lookup = await conn.query(
					'SELECT Id FROM ' + obj + ' ' +
					"WHERE " + _hybridApi('Canvas_Id__c') + " = '" + escapeSoqlLiteral(id) + "' LIMIT 1"
				);
				if (lookup.records && lookup.records.length > 0) {
					await conn.sobject(obj).destroy(lookup.records[0].Id);
				}
			} catch (e) {
				console.warn('[hybrid-canvas] Canvas__c cascade delete failed for', id, ':', (e && e.message) || e);
			}
			return true;
		},

		// Sharing - backed by Orgloom_Canvas__Share when the canvas has a
		// hybrid record, or by ContentDocumentLink when it doesn't. The
		// hybrid path skips the "you've been mentioned in a file" email
		// because custom-object record shares don't trigger one (verified
		// in scripts/apex/test-share-type-inferred.apex: 0 Email
		// Invocations). The CDL with ShareType='I' inserted at save time
		// inherits visibility from the record - sharing the record grants
		// file access automatically, no per-user CDL needed.
		//
		// Library/inferred CDL links (ShareType='I') are excluded from the
		// legacy listing because they aren't user-revokable; they come from
		// library membership or the inferred-share pattern.
		async listShares(canvasId) {
			// Hybrid path: query Orgloom_Canvas__Share rows for the
			// matching record. Filter to RowCause='Manual' so we exclude
			// implicit/inherited shares (admin owners, sharing rules,
			// role-hierarchy grants) that aren't user-revokable from the
			// Org Loom share UI. The owner is also implicit (Owner_Id has
			// full access) and doesn't appear in the share table at all.
			const hybridRecordId = await _getHybridCanvasRecordId(canvasId);
			const shareObj = _hybridApi('Orgloom_Canvas__Share');
			const hybridSoql =
				'SELECT Id, UserOrGroupId, AccessLevel, RowCause ' +
				'FROM ' + shareObj + ' ' +
				"WHERE ParentId = '" + escapeSoqlLiteral(hybridRecordId) + "' " +
				"AND RowCause = 'Manual' " +
				'ORDER BY LastModifiedDate DESC LIMIT 200';
			const result = await conn.query(hybridSoql);
			const rows = result.records || [];
			// Enrich with recipient names. UserOrGroupId is polymorphic
			// (User or Group); the cheapest path is two batched queries.
			const ids = rows.map((r) => r.UserOrGroupId);
			const userIds = ids.filter((x) => typeof x === 'string' && x.startsWith('005'));
			const groupIds = ids.filter((x) => typeof x === 'string' && (x.startsWith('00G') || x.startsWith('058')));
			const nameById = new Map();
			if (userIds.length > 0) {
				const users = await conn.query(
					"SELECT Id, Name FROM User WHERE Id IN ('" +
					userIds.map(escapeSoqlLiteral).join("','") + "') LIMIT 200"
				);
				for (const u of users.records || []) {
					nameById.set(u.Id, u.Name);
				}
			}
			if (groupIds.length > 0) {
				const groups = await conn.query(
					"SELECT Id, Name FROM Group WHERE Id IN ('" +
					groupIds.map(escapeSoqlLiteral).join("','") + "') LIMIT 200"
				);
				for (const g of groups.records || []) {
					nameById.set(g.Id, g.Name);
				}
			}
			return rows.map((s) => ({
				id: s.Id,
				entityId: s.UserOrGroupId,
				entityName: nameById.get(s.UserOrGroupId) || '(unknown)',
				entityType: typeof s.UserOrGroupId === 'string' && s.UserOrGroupId.startsWith('005') ? 'User' : 'Group',
				// Custom __Share rows use 'Read' / 'Edit' / 'All'. Map
				// back to the existing UI vocabulary ('Viewer' /
				// 'Collaborator') so the client doesn't have to know
				// which backend stores the row.
				accessLevel: s.AccessLevel === 'Edit' ? 'Collaborator' : 'Viewer',
			}));
		},

		async addShare(canvasId, { entityId, accessLevel }) {
			// Insert an Orgloom_Canvas__Share row granting the recipient
			// the requested access level on the Canvas__c record. The CDL
			// with ShareType='I' (inserted at save time) inherits
			// visibility from the record - no per-user CDL needed, and
			// no share-with-file email fires.
			//
			// Idempotent: SF rejects duplicates on the __Share table for
			// the same (ParentId, UserOrGroupId, AccessLevel). We catch
			// the DUPLICATE_VALUE and look up the existing row, upgrading
			// Read → Edit when the new level is higher.
			const hybridRecordId = await _getHybridCanvasRecordId(canvasId);
			const shareObj = _hybridApi('Orgloom_Canvas__Share');
			const targetLevel = accessLevel === 'Edit' ? 'Edit' : 'Read';
			let hResult;
			let hError = null;
			try {
				hResult = await conn.sobject(shareObj).create({
					ParentId: hybridRecordId,
					UserOrGroupId: entityId,
					AccessLevel: targetLevel,
					RowCause: 'Manual',
				});
			} catch (e) {
				hError = e;
			}
			const isDup = (() => {
				const probe = hError ? String(hError.message || hError) :
					hResult && !hResult.success ? (hResult.errors || []).map((e) => e.message || e).join('; ') : '';
				return /duplicate|already.*(shared|exists)/i.test(probe);
			})();
			if (isDup) {
				const existing = await conn.query(
					'SELECT Id, AccessLevel FROM ' + shareObj + ' ' +
					"WHERE ParentId = '" + escapeSoqlLiteral(hybridRecordId) + "' " +
					"AND UserOrGroupId = '" + escapeSoqlLiteral(entityId) + "' " +
					"AND RowCause = 'Manual' LIMIT 1"
				);
				const row = (existing.records || [])[0];
				if (row) {
					// Update on ANY level change - both directions. Only
					// upgrading here was an authorization bug: an owner
					// downgrading editor → viewer got a 'viewer' role row
					// while the SF share stayed at Edit, so the "viewer"
					// could still save over the canvas (the save path is
					// gated by SF-side edit access, not the role row).
					if (row.AccessLevel !== targetLevel) {
						await conn.sobject(shareObj).update({ Id: row.Id, AccessLevel: targetLevel });
						return { id: row.Id, entityId, updated: true };
					}
					return { id: row.Id, entityId, updated: false };
				}
			}
			if (hError) {
				throw hError;
			}
			if (!hResult.success) {
				const errs = (hResult.errors || []).map((e) => e.message || e).join('; ');
				const err = new Error('Share failed: ' + (errs || 'unknown error'));
				err.statusCode = /(insufficient|access|permission|share)/i.test(errs) ? 403 : 500;
				throw err;
			}
			return { id: hResult.id, entityId, updated: false };
		},

		// Update an existing share's ShareType. Maps accessLevel='Edit'
		// to ShareType='C' (Collaborator), anything else to 'V' (Viewer).
		// Both directions are supported now that ContentVersion-mode
		// editor sharing is wired. Read↔Read (or Edit↔Edit) no-ops with
		// updated:false; cross-level updates issue a single UPDATE on
		// the existing ContentDocumentLink.
		async updateShareLevel(canvasId, { entityId, accessLevel }) {
			// Locate the Orgloom_Canvas__Share row by (ParentId,
			// UserOrGroupId, RowCause='Manual') and update AccessLevel.
			// No-op when the target level matches.
			const hybridRecordId = await _getHybridCanvasRecordId(canvasId);
			const shareObj = _hybridApi('Orgloom_Canvas__Share');
			const targetLevel = accessLevel === 'Edit' ? 'Edit' : 'Read';
			const existing = await conn.query(
				'SELECT Id, AccessLevel FROM ' + shareObj + ' ' +
				"WHERE ParentId = '" + escapeSoqlLiteral(hybridRecordId) + "' " +
				"AND UserOrGroupId = '" + escapeSoqlLiteral(entityId) + "' " +
				"AND RowCause = 'Manual' LIMIT 1"
			);
			const row = (existing.records || [])[0];
			if (!row) {
				const err = new Error('No existing share for this recipient on this canvas.');
				err.statusCode = 404;
				throw err;
			}
			if (row.AccessLevel === targetLevel) {
				return { id: row.Id, entityId, updated: false };
			}
			await conn.sobject(shareObj).update({ Id: row.Id, AccessLevel: targetLevel });
			return { id: row.Id, entityId, updated: true };
		},

		async removeShare(canvasId, shareId) {
			// shareId is an Orgloom_Canvas__Share row id (listShares only
			// returns those). The Canvas__c record stays; only the share
			// row is removed, which revokes the recipient's access to
			// both the record and the inferred-share file.
			await _getHybridCanvasRecordId(canvasId); // throws 404 if canvas isn't readable from this conn
			const shareObj = _hybridApi('Orgloom_Canvas__Share');
			const result = await conn.sobject(shareObj).destroy(shareId);
			if (!result.success) {
				const errs = (result.errors || []).map((e) => e.message || e).join('; ');
				const err = new Error('Revoke failed: ' + (errs || 'unknown error'));
				err.statusCode = 403;
				throw err;
			}
			return true;
		},
	};
}

// Single store factory. Canvas state lives on SF Files (ContentVersion)
// in the customer's org; sharing is via ContentDocumentLink. The
// alternate managed-package custom-object backend was sunset in favor
// of one well-supported storage path.
export async function canvasStoreFor(req) {
	const bundle = await getActiveSfConnection(req);
	if (!bundle) {
throw new Error('Not authenticated');
}
	return makeContentVersionStoreFromConnection(bundle.conn, bundle.sfUserId, bundle.sfOrgId);
}

// Tag SF errors from ContentVersion create/update operations with a
// recognizable error code + actionable message when they look like
// permission denials. Routes use err.statusCode + err.code to send a
// structured 403 (instead of a generic 500) so the client can show
// real guidance instead of "Save failed: <SF error string>".
//
// SF errors that signal a perm issue here:
//   INSUFFICIENT_ACCESS_OR_READONLY - user lacks Create / Edit on
//                                      ContentVersion / ContentDocument
//   FIELD_INTEGRITY_EXCEPTION - sometimes thrown for FLS / sharing
//                                violations on ContentVersion
//   "insufficient access" / "insufficient privileges" - generic phrasing
function _tagContentVersionPermError(err, mode /* 'create' | 'update' */) {
	const msg = String((err && err.message) || err || '');
	const looksLikePerm = /INSUFFICIENT_ACCESS|insufficient.*(access|privileg)|permission|FIELD_INTEGRITY_EXCEPTION/i.test(msg);
	if (!looksLikePerm) {
return err;
} // leave non-perm errors as-is
	err.statusCode = 403;
	err.code = mode === 'update'
		? 'sf-content-document-edit-denied'
		: 'sf-content-version-create-denied';
	// Replace the raw SF jargon with actionable guidance. Original SF
	// error is preserved on err.sfError so routes can log it.
	err.sfError = msg;
	err.message = mode === 'update'
		? "Your Salesforce user can't edit this saved canvas (Salesforce ContentDocument). " +
		  "If you're not the canvas owner, ask the owner to make changes. If you are the owner, " +
		  "ask your SF admin to grant you edit access on Files / ContentDocument."
		: "Your Salesforce user can't save canvas files to this org. " +
		  "Ask your SF admin to grant your profile the \"Create Content\" / \"Add Files\" permission.";
	return err;
}

// Connection-first store factory. Same shape as canvasStoreFor(req)
// but takes a pre-built jsforce Connection + the SF user id whose
// perspective should govern `ownedByMe` + the SF org id that scopes
// the per-canvas data keys in canvas_keys. Used by route handlers
// in the post-rewrite world that resolve the active connection via
// account_view_state instead of req.session.sf.
export async function canvasStoreFromSfConnection(conn, sfUserId, sfOrgId, opts) {
	return makeContentVersionStoreFromConnection(conn, sfUserId, sfOrgId, opts);
}
