// Encrypted two-phase upload ledger stored in the connected Salesforce org.
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
const BATCH_DECODE_CONCURRENCY = 4;

async function _mapWithConcurrency(items, concurrency, mapper) {
	const results = new Array(items.length);
	let nextIndex = 0;
	const workerCount = Math.min(Math.max(1, concurrency), items.length);
	const workers = Array.from({ length: workerCount }, async () => {
		while (nextIndex < items.length) {
			const index = nextIndex++;
			results[index] = await mapper(items[index], index);
		}
	});
	await Promise.all(workers);
	return results;
}

function _sanitizeBatchFileName(externalId, attemptId) {
	const tag = attemptId ? '__att-' + String(attemptId).replace(/[^a-zA-Z0-9-]/g, '') : '';
	return 'batch-' + externalId + tag + BATCH_PATH_EXT;
}

function _summaryTitle({ source, recordCount, createdAt }) {
	const dt = new Date(createdAt).toISOString().slice(0, 10);
	return (
		'Upload ' +
		recordCount +
		' record' +
		(recordCount === 1 ? '' : 's') +
		' · ' +
		(source || 'unknown') +
		' · ' +
		dt
	);
}

function makeBatchStoreFromConnection(conn, sfUserId, sfOrgId, opts) {
	const kekProvider = makeSfApexKekProvider(conn);
	const sessionId = (opts && opts.sessionId) || null;

	async function _writeBatchPayload(payload) {
		// Persist intent before business-record DML so an interrupted attempt can be reconciled safely.
		const json = JSON.stringify(payload);
		const dataKey = generateDataKey();
		const envelope = encryptPayload(json, dataKey);
		const result = await conn.sobject('ContentVersion').create({
			Title: _summaryTitle(payload),
			PathOnClient: _sanitizeBatchFileName(payload.externalId, payload.attemptId),
			Description:
				'Org Loom recall ledger entry. Encrypted by Org Loom; ' +
				'opens through the Org Loom Upload History UI. See orgloom.com for details.',
			VersionData: envelope.toString('base64'),
		});
		if (!result.success) {
			const errs = (result.errors || []).map((e) => e.message || e).join('; ');
			throw new Error('Upload-batch persist failed: ' + (errs || 'unknown error'));
		}
		const cv = await conn.sobject('ContentVersion').retrieve(result.id);
		const batchId = cv.ContentDocumentId;
		try {
			await batchKeys.persist({ sfOrgId, batchId, dataKey, kekProvider, sessionId });
		} catch (error) {
			// If wrapped-DEK persistence fails, remove the unusable encrypted Salesforce
			// file so a failed upload intent does not leave an orphan ContentDocument.
			try {
				await batchKeys.remove({ sfOrgId, batchId });
			} catch (cleanupError) {
				console.warn('[upload-batches] Could not remove a partial wrapped key:', cleanupError);
			}
			try {
				const cleanup = await conn.sobject('ContentDocument').destroy(batchId);
				if (cleanup && cleanup.success === false) {
					console.warn('[upload-batches] Could not remove an orphan upload-intent file.');
				}
			} catch (cleanupError) {
				console.warn('[upload-batches] Could not remove an orphan upload-intent file:', cleanupError);
			}
			throw error;
		}
		return { id: batchId, externalId: payload.externalId, createdAt: payload.createdAt };
	}

	return {
		backend: 'content-version-batch',

		async list({ limit = 50, offset = 0 } = {}) {
			const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
			const off = Math.min(Math.max(parseInt(offset, 10) || 0, 0), 2000);
			const soql =
				'SELECT Id, ContentDocumentId, VersionData, PathOnClient, ' +
				'OwnerId, CreatedDate ' +
				'FROM ContentVersion ' +
				'WHERE IsLatest = TRUE ' +
				"AND PathOnClient LIKE '%" +
				BATCH_PATH_EXT +
				"' " +
				(sfUserId ? "AND OwnerId = '" + escapeSoqlLiteral(sfUserId) + "' " : '') +
				'ORDER BY CreatedDate DESC LIMIT ' +
				lim +
				(off > 0 ? ' OFFSET ' + off : '');
			const result = await conn.query(soql);
			const versions = result.records || [];
			const items = await _mapWithConcurrency(versions, BATCH_DECODE_CONCURRENCY, async (v) => {
				try {
					const payload = await _decodeVersionData(conn, v.VersionData, {
						sfOrgId,
						batchId: v.ContentDocumentId,
						kekProvider,
						sessionId,
					});
					if (!payload) {
						return null;
					}
					return {
						id: v.ContentDocumentId,
						externalId: payload.externalId || null,
						attemptId: payload.attemptId || null,
						createdAt: payload.createdAt || new Date(v.CreatedDate).getTime(),
						status: payload.status || 'uploaded',
						source: payload.source || 'unknown',
						recordCount:
							typeof payload.recordCount === 'number'
								? payload.recordCount
								: (payload.insertedIds || []).length,
						note: payload.note || null,
						recalledAt: payload.recalledAt || null,
						failedAt: payload.failedAt || null,
						failureCode: payload.failureCode || null,
						sfOrgId: payload.sfOrgId || sfOrgId || null,
						insertedCount: Array.isArray(payload.insertedIds) ? payload.insertedIds.length : 0,
						deletedCount: Array.isArray(payload.deletedIds) ? payload.deletedIds.length : 0,
					};
				} catch (_e) {
					return null;
				}
			});
			return items.filter(Boolean);
		},

		async get(id) {
			if (typeof id !== 'string' || !/^[a-zA-Z0-9]{15,18}$/.test(id)) {
				return null;
			}
			const docResult = await conn.query(
				'SELECT Id, Title, OwnerId FROM ContentDocument ' +
					"WHERE Id = '" +
					escapeSoqlLiteral(id) +
					"' LIMIT 1",
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
					"WHERE ContentDocumentId = '" +
					escapeSoqlLiteral(id) +
					"' " +
					'ORDER BY CreatedDate DESC LIMIT 1',
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
				recordCount:
					typeof payload.recordCount === 'number' ? payload.recordCount : (payload.insertedIds || []).length,
				note: payload.note || null,
				recalledAt: payload.recalledAt || null,
				recallResult: payload.recallResult || null,
				failedAt: payload.failedAt || null,
				failureCode: payload.failureCode || null,
				failureMessage: payload.failureMessage || null,
				sfOrgId: payload.sfOrgId || sfOrgId || null,
				insertedIds: Array.isArray(payload.insertedIds) ? payload.insertedIds : [],
				deletedIds: Array.isArray(payload.deletedIds) ? payload.deletedIds : [],
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
				attemptId: attemptId ? String(attemptId).slice(0, 64) : null,
				insertedIds,
				deletedIds: _deletedIds,
				associations: associations || null,
			};
			return _writeBatchPayload(payload);
		},

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
				intendedRecords: Array.isArray(intendedRecords)
					? intendedRecords.map((r) => ({ tempId: r.tempId, objectName: r.objectName }))
					: [],
				insertedIds: [],
				deletedIds: [],
				associations: null,
			};
			return _writeBatchPayload(payload);
		},

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

		async findByAttemptId(attemptId) {
			if (!attemptId) {
				return null;
			}
			const tag = '__att-' + String(attemptId).replace(/[^a-zA-Z0-9-]/g, '');
			const soql =
				'SELECT ContentDocumentId FROM ContentVersion ' +
				'WHERE IsLatest = TRUE ' +
				"AND PathOnClient LIKE '%" +
				tag +
				BATCH_PATH_EXT +
				"' " +
				(sfUserId ? "AND OwnerId = '" + escapeSoqlLiteral(sfUserId) + "' " : '') +
				'ORDER BY CreatedDate DESC LIMIT 1';
			const result = await conn.query(soql);
			const row = (result.records || [])[0];
			if (!row) {
				return null;
			}
			return this.get(row.ContentDocumentId);
		},

		async markRecalling(id) {
			const existing = await this.get(id);
			if (!existing) {
				throw new Error('batch not found');
			}
			await _rewriteBatch(conn, id, Object.assign({}, existing, { status: 'recalling' }), {
				sfOrgId,
				kekProvider,
				sessionId,
			});
			return { id, status: 'recalling' };
		},

		async markRecallResult(id, { status, recallResult }) {
			const existing = await this.get(id);
			if (!existing) {
				throw new Error('batch not found');
			}
			const next = Object.assign({}, existing, {
				status: status || 'recalled',
				recalledAt: status === 'recalled' ? Date.now() : null,
				recallResult: recallResult || null,
			});
			await _rewriteBatch(conn, id, next, { sfOrgId, kekProvider, sessionId });
			return next;
		},

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
			try {
				await batchKeys.remove({ sfOrgId, batchId: id });
			} catch (e) {
				console.warn('upload-batches-store: failed to drop batch_keys row for ' + id + ':', e && e.message);
			}
			return true;
		},
	};
}

async function _decodeVersionData(conn, vData, { sfOrgId, batchId, kekProvider, sessionId } = {}) {
	// Legacy plaintext ledgers remain readable; every subsequent rewrite uses encryption.
	if (vData == null) {
		return null;
	}
	let buf;
	if (typeof vData === 'string' && vData.startsWith('/')) {
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
		json = buf.toString('utf8');
	}
	try {
		return JSON.parse(json);
	} catch (_e) {
		return null;
	}
}

async function _rewriteBatch(conn, contentDocumentId, payload, { sfOrgId, kekProvider, sessionId } = {}) {
	// Rewrites append a ContentVersion and retain the batch's existing DEK.
	const json = JSON.stringify(payload);
	const title = _summaryTitle(payload);
	let envelope;
	if (sfOrgId) {
		const dataKey = await batchKeys.getOrMint({ sfOrgId, batchId: contentDocumentId, kekProvider, sessionId });
		envelope = encryptPayload(json, dataKey);
	} else {
		envelope = Buffer.from(json, 'utf8');
	}
	const result = await conn.sobject('ContentVersion').create({
		ContentDocumentId: contentDocumentId,
		Title: title,
		PathOnClient: _sanitizeBatchFileName(payload.externalId || 'batch', payload.attemptId),
		Description:
			'Org Loom recall ledger entry. Encrypted by Org Loom; ' +
			'opens through the Org Loom Upload History UI. See orgloom.com for details.',
		VersionData: envelope.toString('base64'),
	});
	if (!result.success) {
		const errs = (result.errors || []).map((e) => e.message || e).join('; ');
		throw new Error('Batch rewrite failed: ' + (errs || 'unknown error'));
	}
	return result.id;
}

export async function uploadBatchesStoreFromSfConnection(conn, sfUserId, sfOrgId, opts) {
	return makeBatchStoreFromConnection(conn, sfUserId, sfOrgId, opts);
}
