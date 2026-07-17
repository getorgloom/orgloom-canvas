// Upload-batches storage. ContentVersion in the customer's SF org:
// same backing-store pattern as canvases. The user is the custodian of
// the recall ledger; we hold nothing on our side.
//
// File shape on SF:
//   PathOnClient ends in BATCH_PATH_EXT (filter list queries)
//   Title       human-readable summary ("Upload 12 records · canvas · 2026-06-01")
//   VersionData JSON payload: { externalId, source, recordCount, note,
//                               createdAt, status, recalledAt, recallResult,
//                               sfOrgId, insertedIds, associations }
//
// Why ContentVersion:
//   - Already the chosen pattern for canvases: no second backing-store
//     surface, no new SF object dependency.
//   - Per-user ownership via OwnerId enforces tenant boundary at the SF
//     layer; we don't have to do app-side connection-id checks.
//   - Customers control retention (their SF Files retention policy,
//     their right to delete) so the "we never persist your data, even
//     metadata" claim is honest.
//
// Recall semantics:
//   - markFailed()     → re-save JSON with status='failed' after a known
//                        no-commit outcome (for example, atomic validation
//                        rollback). This makes retry safe even when deleting
//                        the temporary intent file is not permitted.
//   - markRecalling()  → re-save JSON with status='recalling'
//   - markRecallResult() → re-save JSON with status='recalled' / 'recall_partial'
//                          / 'recall_failed' + recallResult populated
//   - remove(): the "Forget" action deletes the file (no SF records touched)
//
// Tradeoffs from the table-backed predecessor:
//   - Workspace-admin cross-user visibility is gone: each batch is
//     owned by the SF user who created it. Audit_log still records
//     workspace-wide upload activity.
//   - external_id uniqueness is no longer DB-enforced; lives only as a
//     content field for cross-referencing. Acceptable: uploads are
//     user-initiated and not retried automatically.
//   - Every list / detail call hits SF (1 SOQL query). Mirrors the
//     canvas list cost. Acceptable for the recall UX volume.

import { escapeSoqlLiteral } from '../sf-soql.js';
import crypto from 'node:crypto';
import {
	generateDataKey,
	encryptPayload,
	decryptPayload,
	isEncryptedEnvelope,
	makeSfApexKekProvider,
} from './canvas-encryption.js';
import * as batchKeys from '../database/batch-keys.js';

const BATCH_PATH_EXT = '.orgloom-batch.json';

function _sanitizeBatchFileName(externalId, attemptId) {
	// Encode the attemptId into the filename so findByAttemptId can match it
	// with a single SOQL LIKE: no need to decrypt every recent batch just to
	// run the per-upload idempotency check. The attemptId is a random token,
	// not sensitive; the payload's own copy stays inside the encrypted blob.
	const tag = attemptId ? '__att-' + String(attemptId).replace(/[^a-zA-Z0-9-]/g, '') : '';
	return 'batch-' + externalId + tag + BATCH_PATH_EXT;
}

function _summaryTitle({ source, recordCount, createdAt }) {
	const dt = new Date(createdAt).toISOString().slice(0, 10);
	return 'Upload ' + recordCount + ' record' + (recordCount === 1 ? '' : 's') + ' · ' + (source || 'unknown') + ' · ' + dt;
}

function makeBatchStoreFromConnection(conn, sfUserId, sfOrgId, opts) {
	// Bind a KEK provider to this store's connection; see canvas-store
	// for comments.
	const kekProvider = makeSfApexKekProvider(conn);
	const sessionId = (opts && opts.sessionId) || null;

	// Encrypt + write a batch payload as a new ContentVersion, then persist
	// its wrapped data key. Shared by create() (single-phase) and
	// createPending() (phase 1 of the two-phase write).
	async function _writeBatchPayload(payload) {
		const json = JSON.stringify(payload);
		const dataKey = generateDataKey();
		const envelope = encryptPayload(json, dataKey);
		const result = await conn.sobject('ContentVersion').create({
			Title: _summaryTitle(payload),
			PathOnClient: _sanitizeBatchFileName(payload.externalId, payload.attemptId),
			Description: 'Org Loom recall ledger entry. Encrypted by Org Loom; ' +
				'opens through the Org Loom Upload History UI. See orgloom.com for details.',
			VersionData: envelope.toString('base64'),
		});
		if (!result.success) {
			const errs = (result.errors || []).map((e) => e.message || e).join('; ');
			throw new Error('Upload-batch persist failed: ' + (errs || 'unknown error'));
		}
		const cv = await conn.sobject('ContentVersion').retrieve(result.id);
		const batchId = cv.ContentDocumentId;
		// See create()'s original note: bubble a key-persist failure rather
		// than leave SF-side ciphertext with no local key.
		await batchKeys.persist({ sfOrgId, batchId, dataKey, kekProvider, sessionId });
		return { id: batchId, externalId: payload.externalId, createdAt: payload.createdAt };
	}

	return {
		backend: 'content-version-batch',

		async list({ limit = 50 } = {}) {
			const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
			// Query ContentVersion directly with IsLatest=TRUE so we get
			// one row per batch document with inline VersionData: single
			// roundtrip instead of N+1. VersionData on small JSON files
			// is returned as inline base64; large ones come back as a
			// relative URL which _decodeVersionData fetches separately.
			const soql =
				'SELECT Id, ContentDocumentId, VersionData, PathOnClient, ' +
				'OwnerId, CreatedDate ' +
				'FROM ContentVersion ' +
				'WHERE IsLatest = TRUE ' +
				"AND PathOnClient LIKE '%" + BATCH_PATH_EXT + "' " +
				(sfUserId ? "AND OwnerId = '" + escapeSoqlLiteral(sfUserId) + "' " : '') +
				'ORDER BY CreatedDate DESC LIMIT ' + lim;
			const result = await conn.query(soql);
			const versions = result.records || [];
			const items = [];
			for (const v of versions) {
				try {
					const payload = await _decodeVersionData(conn, v.VersionData, {
						sfOrgId,
						batchId: v.ContentDocumentId,
						kekProvider,
						sessionId,
					});
					if (!payload) {
continue;
}
					items.push({
						id: v.ContentDocumentId,
						externalId: payload.externalId || null,
						attemptId: payload.attemptId || null,
						createdAt: payload.createdAt || new Date(v.CreatedDate).getTime(),
						status: payload.status || 'uploaded',
						source: payload.source || 'unknown',
						recordCount: typeof payload.recordCount === 'number' ? payload.recordCount : (payload.insertedIds || []).length,
						note: payload.note || null,
						recalledAt: payload.recalledAt || null,
						failedAt: payload.failedAt || null,
						failureCode: payload.failureCode || null,
						sfOrgId: payload.sfOrgId || sfOrgId || null,
						// Surface counts so the list UI can render "5 synced
						// + 2 deleted" without fetching the full batch.
						insertedCount: Array.isArray(payload.insertedIds) ? payload.insertedIds.length : 0,
						deletedCount: Array.isArray(payload.deletedIds) ? payload.deletedIds.length : 0,
					});
				} catch (_e) { /* skip unreadable batch */ }
			}
			return items;
		},

		// Returns null when the file doesn't exist, isn't owned by the
		// caller's SF identity, or fails the PathOnClient ext check. The
		// SF API surfaces "doesn't exist" identically to "you can't see
		// it," since both come back as zero rows, which is the right
		// behavior for tenant isolation.
		async get(id) {
			// Salesforce Ids are 15 or 18 char alphanumerics. Anything else
			// would explode the SOQL query with a parse error and leak the
			// raw query text into the response body. Guard up-front and
			// surface as "doesn't exist": same as a real not-found.
			if (typeof id !== 'string' || !/^[a-zA-Z0-9]{15,18}$/.test(id)) {
				return null;
			}
			const docResult = await conn.query(
				'SELECT Id, Title, OwnerId FROM ContentDocument ' +
				"WHERE Id = '" + escapeSoqlLiteral(id) + "' LIMIT 1"
			);
			const doc = (docResult.records || [])[0];
			if (!doc) {
return null;
}
			if (sfUserId && doc.OwnerId !== sfUserId) {
return null;
}
			const versionResult = await conn.query(
				'SELECT Id, VersionData, PathOnClient FROM ContentVersion ' +
				"WHERE ContentDocumentId = '" + escapeSoqlLiteral(id) + "' " +
				'ORDER BY CreatedDate DESC LIMIT 1'
			);
			const v = (versionResult.records || [])[0];
			if (!v) {
return null;
}
			if (typeof v.PathOnClient !== 'string' || !v.PathOnClient.endsWith(BATCH_PATH_EXT)) {
				return null;
			}
			const payload = await _decodeVersionData(conn, v.VersionData, {
				sfOrgId,
				batchId: doc.Id,
				kekProvider,
				sessionId,
			});
			if (!payload) {
return null;
}
			return {
				id: doc.Id,
				versionId: v.Id,
				externalId: payload.externalId || null,
				attemptId: payload.attemptId || null,
				createdAt: payload.createdAt || null,
				status: payload.status || 'uploaded',
				source: payload.source || 'unknown',
				recordCount: typeof payload.recordCount === 'number' ? payload.recordCount : (payload.insertedIds || []).length,
				note: payload.note || null,
				recalledAt: payload.recalledAt || null,
				recallResult: payload.recallResult || null,
				failedAt: payload.failedAt || null,
				failureCode: payload.failureCode || null,
				failureMessage: payload.failureMessage || null,
				sfOrgId: payload.sfOrgId || sfOrgId || null,
				insertedIds: Array.isArray(payload.insertedIds) ? payload.insertedIds : [],
				// deletedIds: records SF-DELETE'd as part of this batch.
				// NOT recall-able from Org Loom (deletes are routed through
				// SF's recycle bin, which is the user's only recovery
				// path within 15 days). The History UI still surfaces
				// them so the audit trail is complete.
				deletedIds: Array.isArray(payload.deletedIds) ? payload.deletedIds : [],
				// intendedRecords: the tempId+objectName intent list a
				// createPending() stamped before the commit. Present on
				// 'pending' and retained terminal 'failed' batches; finalize
				// deletes it after a successful commit. Surfaced so
				// a recovery flow can correlate a crashed-mid-commit
				// attempt by intent, not just by attemptId; previously
				// this was written but never readable, making that
				// documented correlation path dead code.
				intendedRecords: Array.isArray(payload.intendedRecords) ? payload.intendedRecords : [],
				associations: Array.isArray(payload.associations) ? payload.associations : null,
			};
		},

		async create({ source, recordCount, note, insertedIds, deletedIds, associations, attemptId }) {
			if (!Array.isArray(insertedIds)) {
throw new Error('insertedIds must be an array');
}
			const _deletedIds = Array.isArray(deletedIds) ? deletedIds : [];
			const payload = {
				externalId: crypto.randomUUID(),
				source: source || 'unknown',
				recordCount: typeof recordCount === 'number' ? recordCount : insertedIds.length + _deletedIds.length,
				note: note ? String(note).slice(0, 200) : null,
				createdAt: Date.now(),
				status: 'uploaded',
				recalledAt: null,
				recallResult: null,
				sfOrgId: sfOrgId || null,
				// Per-upload-attempt token. Lets the client reconcile a
				// network-dropped upload EXACTLY against the batch it wrote,
				// so a retry can't duplicate (see upload-modal reconcileLostUpload),
				// and lets the server short-circuit an identical retry
				// (findByAttemptId → idempotent replay).
				attemptId: attemptId ? String(attemptId).slice(0, 64) : null,
				insertedIds,
				deletedIds: _deletedIds,
				associations: associations || null,
			};
			return _writeBatchPayload(payload);
		},

		// Phase 1 of the two-phase write: record the INTENT to upload before
		// the SF commit. Carries the attemptId + the records we're about to
		// create (tempId + objectName, no SF ids yet) and status='pending'.
		// If the process dies between commit and finalize(), this entry
		// survives so a retry can DETECT the in-flight attempt (status
		// 'pending') instead of silently re-inserting. Returns { id }.
		async createPending({ source, note, attemptId, intendedRecords }) {
			const payload = {
				externalId: crypto.randomUUID(),
				source: source || 'unknown',
				recordCount: Array.isArray(intendedRecords) ? intendedRecords.length : 0,
				note: note ? String(note).slice(0, 200) : null,
				createdAt: Date.now(),
				status: 'pending',
				recalledAt: null,
				recallResult: null,
				sfOrgId: sfOrgId || null,
				attemptId: attemptId ? String(attemptId).slice(0, 64) : null,
				// What we intend to create: lets a recovery flow correlate by
				// tempId+objectName even before SF ids exist.
				intendedRecords: Array.isArray(intendedRecords)
					? intendedRecords.map((r) => ({ tempId: r.tempId, objectName: r.objectName }))
					: [],
				insertedIds: [],
				deletedIds: [],
				associations: null,
			};
			return _writeBatchPayload(payload);
		},

		// Phase 2 of the two-phase write: flip a pending batch to 'uploaded'
		// and fill in the SF ids that the commit produced. Rewrites the same
		// ContentDocument (a new version) so the attemptId/externalId are
		// stable across both phases.
		async finalize(id, { insertedIds, deletedIds, associations, recordCount } = {}) {
			const existing = await this.get(id);
			if (!existing) {
throw new Error('finalize: batch not found');
}
			const _inserted = Array.isArray(insertedIds) ? insertedIds : [];
			const _deleted = Array.isArray(deletedIds) ? deletedIds : [];
			const next = Object.assign({}, existing, {
				status: 'uploaded',
				recordCount: typeof recordCount === 'number' ? recordCount : _inserted.length + _deleted.length,
				insertedIds: _inserted,
				deletedIds: _deleted,
				associations: associations || existing.associations || null,
			});
			delete next.intendedRecords;
			await _rewriteBatch(conn, id, next, { sfOrgId, kekProvider, sessionId });
			return { id, status: 'uploaded' };
		},

		// Settle an attempt whose Salesforce outcome is known and contains no
		// committed business-record writes. This is deliberately a rewrite of
		// the existing ContentDocument, rather than a delete: users who can
		// create/update their own Files do not necessarily have permission to
		// delete ContentDocument rows. A retained `failed` entry is terminal and
		// must never be mistaken for an ambiguous in-flight upload.
		async markFailed(id, { errorCode, message } = {}) {
			const existing = await this.get(id);
			if (!existing) {
				throw new Error('markFailed: batch not found');
			}
			const next = Object.assign({}, existing, {
				status: 'failed',
				failedAt: Date.now(),
				failureCode: errorCode ? String(errorCode).slice(0, 120) : null,
				failureMessage: message ? String(message).slice(0, 500) : null,
				insertedIds: [],
				deletedIds: [],
				associations: null,
			});
			await _rewriteBatch(conn, id, next, { sfOrgId, kekProvider, sessionId });
			return { id, status: 'failed' };
		},

		// Find the most recent batch carrying this attemptId. Used as the
		// server-side idempotency key: an identical retry (same attemptId)
		// that already committed returns the prior batch instead of
		// re-inserting. attemptId lives inside the encrypted payload, so we
		// decode the recent list and match in memory (volume is tiny).
		async findByAttemptId(attemptId) {
			if (!attemptId) {
return null;
}
			const tag = '__att-' + String(attemptId).replace(/[^a-zA-Z0-9-]/g, '');
			// One cheap SOQL on the filename tag (no decrypt); returns rows
			// only on an actual retry. Then decode just that one batch.
			const soql =
				'SELECT ContentDocumentId FROM ContentVersion ' +
				'WHERE IsLatest = TRUE ' +
				"AND PathOnClient LIKE '%" + tag + BATCH_PATH_EXT + "' " +
				(sfUserId ? "AND OwnerId = '" + escapeSoqlLiteral(sfUserId) + "' " : '') +
				'ORDER BY CreatedDate DESC LIMIT 1';
			const result = await conn.query(soql);
			const row = (result.records || [])[0];
			if (!row) {
return null;
}
			return this.get(row.ContentDocumentId);
		},

		// Re-save the batch ContentVersion with status='recalling'. A new
		// version replaces the prior content; SF keeps the old version
		// in document history if customers want forensic visibility.
		async markRecalling(id) {
			const existing = await this.get(id);
			if (!existing) {
throw new Error('batch not found');
}
			await _rewriteBatch(conn, id, Object.assign({}, existing, { status: 'recalling' }), { sfOrgId, kekProvider, sessionId });
			return { id, status: 'recalling' };
		},

		async markRecallResult(id, { status, recallResult }) {
			const existing = await this.get(id);
			if (!existing) {
throw new Error('batch not found');
}
			const next = Object.assign({}, existing, {
				status: status || 'recalled',
				recalledAt: Date.now(),
				recallResult: recallResult || null,
			});
			await _rewriteBatch(conn, id, next, { sfOrgId, kekProvider, sessionId });
			return next;
		},

		// "Forget": drop the batch file from SF Files. Doesn't touch the
		// records that were uploaded; this is purely removing the recall
		// ledger entry. The batch_keys row also goes; SF-side ciphertext
		// is gone, so the local wrapped key has nothing to decrypt and
		// keeping it around would just leak.
		async remove(id) {
			const existing = await this.get(id);
			if (!existing) {
				const err = new Error('batch not found');
				err.statusCode = 404;
				throw err;
			}
			const result = await conn.sobject('ContentDocument').destroy(id);
			if (!result.success) {
				const errs = (result.errors || []).map((e) => e.message || e).join('; ');
				const err = new Error('Forget failed: ' + (errs || 'unknown error'));
				err.statusCode = 403;
				throw err;
			}
			// Drop the wrapped data key. SF deletion already succeeded so
			// the batch is gone from the user's perspective; a stranded
			// batch_keys row is harmless (orphan wrapped key with nothing
			// to decrypt) but the cleanup runs anyway. Tolerate failures
			// so they don't bubble as 500s.
			try {
				await batchKeys.remove({ sfOrgId, batchId: id });
			} catch (e) {
				 
				console.warn('upload-batches-store: failed to drop batch_keys row for ' + id + ':', e && e.message);
			}
			return true;
		},
	};
}

// Decode VersionData into the batch payload object. Handles both
// the post-027 encrypted envelope shape and the pre-027 legacy
// plaintext shape transparently. Callers must pass sfOrgId and the
// batch's ContentDocumentId so we can look up the wrapping key when
// the blob is encrypted; legacy plaintext blobs don't consult the
// key store and work for any caller.
async function _decodeVersionData(conn, vData, { sfOrgId, batchId, kekProvider, sessionId } = {}) {
	if (vData == null) {
return null;
}
	let buf;
	if (typeof vData === 'string' && vData.startsWith('/')) {
		// jsforce returns VersionData as a relative URL for files past a
		// small-inline threshold. conn.request({ encoding: null }) is
		// SUPPOSED to hand back a raw Buffer, but current jsforce silently
		// UTF-8-decodes the binary body; every non-ASCII envelope byte
		// becomes U+FFFD (EF BF BD), so AES-GCM auth fails on decrypt. Do a
		// direct binary fetch with the connection token instead, which
		// preserves the bytes exactly. (Same fix already in canvas-store.)
		const url = conn.instanceUrl.replace(/\/+$/, '') + vData;
		const response = await fetch(url, {
			headers: { Authorization: 'Bearer ' + conn.accessToken },
		});
		if (!response.ok) {
			throw new Error('VersionData fetch failed: HTTP ' + response.status);
		}
		const ab = await response.arrayBuffer();
		buf = Buffer.from(ab);
	} else {
		buf = Buffer.from(vData, 'base64');
	}
	let json;
	if (isEncryptedEnvelope(buf)) {
		if (!sfOrgId || !batchId) {
			// Caller didn't pass enough to look up the key. Can't
			// decrypt: return null so the list/get path treats this
			// as an unreadable row rather than crashing.
			return null;
		}
		const dataKey = await batchKeys.get({ sfOrgId, batchId, kekProvider, sessionId });
		if (!dataKey) {
return null;
}
		try {
 json = decryptPayload(buf, dataKey);
} catch (_e) {
 return null;
}
	} else {
		// Legacy plaintext batch (created before migration 027 shipped).
		// Stays readable; the next rewrite re-encrypts via the create
		// path's get-or-mint key flow.
		json = buf.toString('utf8');
	}
	try {
 return JSON.parse(json); 
} catch (_e) {
 return null; 
}
}

async function _rewriteBatch(conn, contentDocumentId, payload, { sfOrgId, kekProvider, sessionId } = {}) {
	const json = JSON.stringify(payload);
	const title = _summaryTitle(payload);
	// Encrypt with the batch's data key. getOrMint covers two cases:
	//   * batch was created post-encryption: key exists, reuse it
	//     (keeps the SF-side version history decryptable with one key
	//     across all rewrites).
	//   * batch was created pre-027 plaintext: no key yet; mint one
	//     and re-encrypt. The next read decrypts with the new key
	//     because the envelope marker switches; older SF-side versions
	//     stay readable through the legacy-plaintext branch of
	//     _decodeVersionData.
	let envelope;
	if (sfOrgId) {
		const dataKey = await batchKeys.getOrMint({ sfOrgId, batchId: contentDocumentId, kekProvider, sessionId });
		envelope = encryptPayload(json, dataKey);
	} else {
		// No sfOrgId: fall back to plaintext. Shouldn't happen on any
		// in-tree caller; guards against external test harnesses.
		envelope = Buffer.from(json, 'utf8');
	}
	const result = await conn.sobject('ContentVersion').create({
		ContentDocumentId: contentDocumentId,
		Title: title,
		PathOnClient: _sanitizeBatchFileName(payload.externalId || 'batch', payload.attemptId),
		Description: 'Org Loom recall ledger entry. Encrypted by Org Loom; ' +
			'opens through the Org Loom Upload History UI. See orgloom.com for details.',
		VersionData: envelope.toString('base64'),
	});
	if (!result.success) {
		const errs = (result.errors || []).map((e) => e.message || e).join('; ');
		throw new Error('Batch rewrite failed: ' + (errs || 'unknown error'));
	}
	return result.id;
}

// Connection-first factory matching canvasStoreFromSfConnection. Routes
// call this with req.sf.conn / req.sf.sfUserId / req.sf.sfOrgId after
// the requireSfConnection middleware resolves the active connection.
export async function uploadBatchesStoreFromSfConnection(conn, sfUserId, sfOrgId, opts) {
	return makeBatchStoreFromConnection(conn, sfUserId, sfOrgId, opts);
}
