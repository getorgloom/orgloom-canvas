// Encrypted canvas persistence in Salesforce Files, with package metadata as the searchable index.
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
const CANVAS_BODY_RETENTION = 3;
const SALESFORCE_DELETE_BATCH_SIZE = 200;
const CANVAS_FILE_DESCRIPTION_PREFIX = 'Org Loom workspace canvas.';

const _updateLocks = new Map(); // "org|canvas" -> tail promise
// Salesforce has no ContentVersion compare-and-swap; serialize local version checks and writes.
async function _acquireUpdateLock(key) {
	const prev = _updateLocks.get(key) || Promise.resolve();
	let release;
	const gate = new Promise((res) => {
		release = res;
	});
	_updateLocks.set(
		key,
		prev.then(() => gate),
	);
	await prev.catch(() => {});
	return release;
}

async function _queryAll(conn, soql) {
	let result = await conn.query(soql);
	const records = [...((result && result.records) || [])];
	while (result && result.done === false && result.nextRecordsUrl && typeof conn.queryMore === 'function') {
		result = await conn.queryMore(result.nextRecordsUrl);
		records.push(...((result && result.records) || []));
	}
	return records;
}

function _assertDestroySucceeded(result) {
	const results = Array.isArray(result) ? result : [result];
	const failures = results.filter((item) => item && item.success === false);
	if (failures.length === 0) {
		return;
	}
	const details = failures
		.flatMap((item) => item.errors || [])
		.map((error) => error.message || error)
		.filter(Boolean)
		.join('; ');
	throw new Error('Canvas body cleanup failed' + (details ? ': ' + details : ''));
}

async function _canvasBodyDocuments(conn, hybridRecordId) {
	const links = await _queryAll(
		conn,
		"SELECT ContentDocumentId FROM ContentDocumentLink WHERE LinkedEntityId = '" +
			escapeSoqlLiteral(hybridRecordId) +
			"'",
	);
	const documentIds = [...new Set(links.map((link) => link && link.ContentDocumentId).filter(Boolean))];
	const bodies = [];
	for (let offset = 0; offset < documentIds.length; offset += SALESFORCE_DELETE_BATCH_SIZE) {
		const batch = documentIds.slice(offset, offset + SALESFORCE_DELETE_BATCH_SIZE);
		const inList = batch.map((id) => "'" + escapeSoqlLiteral(id) + "'").join(',');
		const versions = await _queryAll(
			conn,
			'SELECT Id, ContentDocumentId, CreatedDate, Description, PathOnClient ' +
				'FROM ContentVersion WHERE IsLatest = true AND ContentDocumentId IN (' +
				inList +
				')',
		);
		for (const version of versions) {
			if (
				version &&
				typeof version.PathOnClient === 'string' &&
				version.PathOnClient.endsWith(CANVAS_PATH_EXT) &&
				typeof version.Description === 'string' &&
				version.Description.startsWith(CANVAS_FILE_DESCRIPTION_PREFIX)
			) {
				bodies.push({
					contentDocumentId: version.ContentDocumentId,
					versionId: version.Id,
					createdAt: new Date(version.CreatedDate).getTime() || 0,
				});
			}
		}
	}
	bodies.sort((left, right) => right.createdAt - left.createdAt);
	return bodies;
}

async function _destroyContentDocuments(conn, documentIds) {
	let deleted = 0;
	for (let offset = 0; offset < documentIds.length; offset += SALESFORCE_DELETE_BATCH_SIZE) {
		const batch = documentIds.slice(offset, offset + SALESFORCE_DELETE_BATCH_SIZE);
		const result = await conn.sobject('ContentDocument').destroy(batch);
		_assertDestroySucceeded(result);
		deleted += batch.length;
	}
	return deleted;
}

async function _pruneOldCanvasBodies(conn, hybridRecordId, latestBodyDocumentId) {
	const bodies = await _canvasBodyDocuments(conn, hybridRecordId);
	if (bodies.length <= CANVAS_BODY_RETENTION) {
		return 0;
	}

	// A stale post-write query must never cause the current body document to be pruned.
	const latestBody = bodies.find((body) => body.contentDocumentId === latestBodyDocumentId);
	if (!latestBody) {
		throw new Error('Canvas body cleanup skipped because the new document was not returned as latest');
	}

	const retentionOrder = [latestBody, ...bodies.filter((body) => body !== latestBody)];
	return _destroyContentDocuments(
		conn,
		retentionOrder.slice(CANVAS_BODY_RETENTION).map((body) => body.contentDocumentId),
	);
}

function _hybridApi(name) {
	const ns = (config.canvas && config.canvas.namespacePrefix) || '';
	return ns ? `${ns}__${name}` : name;
}

function _countCanvasRecords(p) {
	if (!p) {
		return 0;
	}
	if (Array.isArray(p.drafts) || Array.isArray(p.loadedRecords)) {
		return (p.drafts || []).length + (p.loadedRecords || []).length;
	}
	return Array.isArray(p.bulkRecords) ? p.bulkRecords.filter((r) => r && !r.isTypeNode).length : 0;
}

async function _writeHybridCanvasRecord(conn, args) {
	// The custom object stores metadata only; encrypted canvas content remains in ContentVersion.
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

	let canvasRecordId = args.canvasRecordId || null;
	const ensureBodyLink = async () => {
		const cdlSoql = `SELECT Id FROM ContentDocumentLink WHERE LinkedEntityId = '${escapeSoqlLiteral(canvasRecordId)}' AND ContentDocumentId = '${escapeSoqlLiteral(args.contentDocumentId)}' LIMIT 1`;
		const cdlExisting = await conn.query(cdlSoql);
		if (!cdlExisting.records || cdlExisting.records.length === 0) {
			const linkResult = await conn.sobject('ContentDocumentLink').create({
				LinkedEntityId: canvasRecordId,
				ContentDocumentId: args.contentDocumentId,
				ShareType: 'I',
				Visibility: 'AllUsers',
			});
			if (!linkResult || linkResult.success === false) {
				const details = ((linkResult && linkResult.errors) || [])
					.map((error) => error.message || error)
					.filter(Boolean)
					.join('; ');
				throw new Error('Canvas body link failed' + (details ? ': ' + details : ''));
			}
		}
	};

	// During rotation, link the replacement first so a failed link cannot strand the pointer.
	if (canvasRecordId && args.linkBeforeMetadata) {
		await ensureBodyLink();
	}

	await conn.sobject(obj).upsert(recordPayload, field('Canvas_Id__c'));

	if (!canvasRecordId) {
		const lookupSoql = `SELECT Id FROM ${obj} WHERE ${field('Canvas_Id__c')} = '${escapeSoqlLiteral(args.canvasId)}' LIMIT 1`;
		const lookup = await conn.query(lookupSoql);
		if (!lookup.records || lookup.records.length === 0) {
			throw new Error('Canvas record not found after upsert by Canvas_Id__c');
		}
		canvasRecordId = lookup.records[0].Id;
	}

	if (!args.linkBeforeMetadata) {
		await ensureBodyLink();
	}
	return { canvasRecordId };
}

function _sanitizeFileName(name) {
	const safe = String(name || 'canvas')
		.replace(/[^a-zA-Z0-9_\-. ]+/g, '_')
		.slice(0, 80);
	return (safe || 'canvas') + CANVAS_PATH_EXT;
}

function makeContentVersionStoreFromConnection(conn, sfUserId, sfOrgId, opts) {
	// Reuse one DEK across body rotations so retained checkpoints remain decryptable.
	const kekProvider = makeSfApexKekProvider(conn);
	const sessionId = (opts && opts.sessionId) || null;

	const _getHybridCanvasRecord = async (canvasId) => {
		const obj = _hybridApi('Orgloom_Canvas__c');
		const result = await conn.query(
			'SELECT Id, Name, OwnerId, CreatedDate, LastModifiedDate, ' +
				_hybridApi('Canvas_Id__c') +
				', ' +
				_hybridApi('Body_Document_Id__c') +
				', ' +
				_hybridApi('Last_Edited_At__c') +
				' FROM ' +
				obj +
				' ' +
				'WHERE ' +
				_hybridApi('Canvas_Id__c') +
				" = '" +
				escapeSoqlLiteral(canvasId) +
				"' LIMIT 1",
		);
		const row = result.records && result.records[0];
		if (!row) {
			const err = new Error('Canvas record not found for id ' + canvasId);
			err.statusCode = 404;
			err.code = 'canvas-record-missing';
			throw err;
		}
		return row;
	};

	const _getHybridCanvasRecordId = async (canvasId) => (await _getHybridCanvasRecord(canvasId)).Id;

	return {
		backend: 'content-version',

		async list() {
			const obj = _hybridApi('Orgloom_Canvas__c');
			const soql =
				'SELECT Id, Name, OwnerId, ' +
				_hybridApi('Canvas_Id__c') +
				', ' +
				_hybridApi('Body_Document_Id__c') +
				', ' +
				_hybridApi('Record_Count__c') +
				', ' +
				_hybridApi('Last_Edited_At__c') +
				', ' +
				'CreatedDate, LastModifiedDate ' +
				'FROM ' +
				obj +
				' ' +
				'ORDER BY ' +
				_hybridApi('Last_Edited_At__c') +
				' DESC NULLS LAST LIMIT 200';
			const result = await conn.query(soql);
			const items = (result.records || []).map((r) => ({
				id: r[_hybridApi('Canvas_Id__c')] || r[_hybridApi('Body_Document_Id__c')],
				bodyDocumentId: r[_hybridApi('Body_Document_Id__c')] || r[_hybridApi('Canvas_Id__c')],
				versionId: null,
				title: r.Name,
				ownerId: r.OwnerId,
				ownedByMe: !!sfUserId && r.OwnerId === sfUserId,
				size: Number(r[_hybridApi('Record_Count__c')]) || 0,
				createdAt: new Date(r.CreatedDate).getTime(),
				updatedAt: new Date(r[_hybridApi('Last_Edited_At__c')] || r.LastModifiedDate).getTime(),
			}));
			const docIds = items.map((i) => i.bodyDocumentId).filter(Boolean);
			if (docIds.length) {
				const inList = docIds.map((d) => "'" + escapeSoqlLiteral(d) + "'").join(',');
				const titleResult = await conn.query(
					'SELECT Id, Title FROM ContentDocument WHERE Id IN (' + inList + ')',
				);
				const titleById = new Map((titleResult.records || []).map((d) => [d.Id, d.Title]));
				items.forEach((i) => {
					const t = titleById.get(i.bodyDocumentId);
					if (t) {
						i.title = t;
					}
				});
			}
			items.forEach((item) => delete item.bodyDocumentId);
			return { items };
		},

		async countOwned() {
			if (!sfUserId) {
				return 0;
			}
			const obj = _hybridApi('Orgloom_Canvas__c');
			const soql = 'SELECT COUNT() FROM ' + obj + ' ' + "WHERE OwnerId = '" + escapeSoqlLiteral(sfUserId) + "'";
			const result = await conn.query(soql);
			return Number(result.totalSize) || 0;
		},

		async save({ name, payload }) {
			const safe = stripDraftValuesForSave(payload);
			const json = JSON.stringify(safe);
			const dataKey = generateDataKey();
			const envelope = encryptPayload(json, dataKey);
			let result;
			try {
				result = await conn.sobject('ContentVersion').create({
					Title: String(name).slice(0, 255),
					PathOnClient: _sanitizeFileName(name),
					Description:
						CANVAS_FILE_DESCRIPTION_PREFIX +
						' Encrypted by Org Loom; ' +
						'opens through the Org Loom app. See orgloom.com for details.',
					VersionData: envelope.toString('base64'),
				});
			} catch (err) {
				throw _tagContentVersionPermError(err, 'create');
			}
			if (!result.success) {
				const errs = (result.errors || []).map((e) => e.message || e).join('; ');
				throw _tagContentVersionPermError(new Error('Save failed: ' + (errs || 'unknown error')), 'create');
			}
			const cv = await conn.sobject('ContentVersion').retrieve(result.id);
			const canvasId = cv.ContentDocumentId;
			try {
				await canvasKeys.persist({ sfOrgId, canvasId, dataKey, kekProvider, sessionId });

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
				try {
					await conn.sobject('ContentDocument').destroy(canvasId);
				} catch (cleanupErr) {
					console.warn(
						'canvas-store: failed to clean up partial canvas ' + canvasId + ':',
						cleanupErr && cleanupErr.message,
					);
				}
				try {
					await canvasKeys.remove({ sfOrgId, canvasId });
				} catch (cleanupErr) {
					console.warn(
						'canvas-store: failed to clean up partial canvas key ' + canvasId + ':',
						cleanupErr && cleanupErr.message,
					);
				}
				throw persistErr;
			}

			return { id: canvasId, versionId: result.id };
		},

		async update(id, { payload, expectedVersionId }) {
			const _lockKey = (sfOrgId || '') + '|' + id;
			const _release = await _acquireUpdateLock(_lockKey);
			try {
				const hybrid = await _getHybridCanvasRecord(id);
				const currentBodyDocumentId = hybrid[_hybridApi('Body_Document_Id__c')] || id;
				const docResult = await conn.query(
					"SELECT Id, Title FROM ContentDocument WHERE Id = '" +
						escapeSoqlLiteral(currentBodyDocumentId) +
						"' LIMIT 1",
				);
				const doc = (docResult.records || [])[0];
				if (!doc) {
					const e = new Error('Canvas body not found');
					e.statusCode = 404;
					throw e;
				}
				if (expectedVersionId) {
					const latestResult = await conn.query(
						'SELECT Id FROM ContentVersion ' +
							"WHERE ContentDocumentId = '" +
							escapeSoqlLiteral(currentBodyDocumentId) +
							"' " +
							'ORDER BY CreatedDate DESC LIMIT 1',
					);
					const latest = (latestResult.records || [])[0];
					const currentVersionId = latest && latest.Id;
					if (currentVersionId && currentVersionId !== expectedVersionId) {
						const e = new Error(
							'This canvas was edited elsewhere since you opened it. Reload, then re-apply your changes.',
						);
						e.statusCode = 409;
						e.code = 'version-mismatch';
						e.currentVersionId = currentVersionId;
						throw e;
					}
				}
				const dataKey = await canvasKeys.getOrMint({ sfOrgId, canvasId: id, kekProvider, sessionId });
				const safe = stripDraftValuesForSave(payload);
				const json = JSON.stringify(safe);
				const envelope = encryptPayload(json, dataKey);
				let result;
				try {
					result = await conn.sobject('ContentVersion').create({
						Title: doc.Title,
						PathOnClient: _sanitizeFileName(doc.Title || 'canvas'),
						Description:
							CANVAS_FILE_DESCRIPTION_PREFIX +
							' Encrypted by Org Loom; ' +
							'opens through the Org Loom app. See orgloom.com for details.',
						VersionData: envelope.toString('base64'),
					});
				} catch (err) {
					throw _tagContentVersionPermError(err, 'update');
				}
				if (!result.success) {
					const errs = (result.errors || []).map((e) => e.message || e).join('; ');
					throw _tagContentVersionPermError(
						new Error('Update failed: ' + (errs || 'unknown error')),
						'update',
					);
				}
				const createdVersion = await conn.sobject('ContentVersion').retrieve(result.id);
				const newBodyDocumentId = createdVersion && createdVersion.ContentDocumentId;
				if (!newBodyDocumentId) {
					const err = new Error('Salesforce did not return the new canvas body document id');
					err.statusCode = 502;
					throw err;
				}
				try {
					await _writeHybridCanvasRecord(conn, {
						canvasId: id,
						contentDocumentId: newBodyDocumentId,
						canvasRecordId: hybrid.Id,
						linkBeforeMetadata: true,
						sfUserId: null,
						recordCount: _countCanvasRecords(safe),
						bodySha256: crypto.createHash('sha256').update(envelope).digest('hex'),
						encryptionKeyVersion: 'v1',
					});
				} catch (persistErr) {
					try {
						await conn.sobject('ContentDocument').destroy(newBodyDocumentId);
					} catch (cleanupErr) {
						console.warn(
							'canvas-store: failed to clean up unindexed canvas body ' + newBodyDocumentId + ':',
							cleanupErr && cleanupErr.message,
						);
					}
					throw persistErr;
				}
				let prunedBodyCount = 0;
				try {
					prunedBodyCount = await _pruneOldCanvasBodies(conn, hybrid.Id, newBodyDocumentId);
				} catch (cleanupErr) {
					// The indexed new body remains authoritative when retention cleanup is unavailable.
					console.warn(
						'canvas-store: failed to prune old canvas bodies for ' + id + ':',
						cleanupErr && cleanupErr.message,
					);
				}
				return { id, versionId: result.id, title: doc.Title, prunedBodyCount };
			} finally {
				_release();
			}
		},

		async get(id) {
			const obj = _hybridApi('Orgloom_Canvas__c');
			const probeSoql =
				'SELECT Id, Name, OwnerId, CreatedDate, LastModifiedDate, ' +
				_hybridApi('Canvas_Id__c') +
				', ' +
				_hybridApi('Body_Document_Id__c') +
				', ' +
				_hybridApi('Last_Edited_At__c') +
				', ' +
				_hybridApi('Body_Sha256__c') +
				', ' +
				_hybridApi('Schema_Version__c') +
				', ' +
				_hybridApi('Encryption_Key_Version__c') +
				' ' +
				'FROM ' +
				obj +
				' ' +
				'WHERE ' +
				_hybridApi('Canvas_Id__c') +
				" = '" +
				escapeSoqlLiteral(id) +
				"' LIMIT 1";
			const probe = await conn.query(probeSoql);
			const _hybridMeta = (probe.records || [])[0] || null;
			if (!_hybridMeta) {
				const err = new Error('Canvas not found, or you no longer have access to it.');
				err.statusCode = 404;
				err.code = 'canvas-not-accessible';
				throw err;
			}

			const bodyDocumentId = _hybridMeta[_hybridApi('Body_Document_Id__c')] || id;
			const docResult = await conn.query(
				'SELECT Id, Title, CreatedDate, LastModifiedDate ' +
					"FROM ContentDocument WHERE Id = '" +
					escapeSoqlLiteral(bodyDocumentId) +
					"' LIMIT 1",
			);
			const doc = (docResult.records || [])[0];
			if (!doc) {
				return null;
			}
			const versionResult = await conn.query(
				'SELECT Id, VersionData, PathOnClient FROM ContentVersion ' +
					"WHERE ContentDocumentId = '" +
					escapeSoqlLiteral(bodyDocumentId) +
					"' " +
					'ORDER BY CreatedDate DESC LIMIT 1',
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
			let buf;
			if (typeof v.VersionData === 'string' && v.VersionData.startsWith('/')) {
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
			{
				const expectedShaField = _hybridApi('Body_Sha256__c');
				const expectedSha = _hybridMeta[expectedShaField];
				if (expectedSha) {
					const actualSha = crypto.createHash('sha256').update(buf).digest('hex');
					if (actualSha !== expectedSha) {
						console.warn(
							'[hybrid-canvas] body sha256 mismatch for',
							id,
							'expected',
							expectedSha,
							'got',
							actualSha,
						);
					}
				}
			}
			let json;
			if (isEncryptedEnvelope(buf)) {
				const dataKey = await canvasKeys.get({ sfOrgId, canvasId: id, kekProvider, sessionId });
				if (!dataKey) {
					const err = new Error(
						"This canvas was saved with a key Org Loom can't locate. " +
							'If you saved it under a different Salesforce org, switch back to that org.',
					);
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
				id,
				versionId: v.Id,
				title: doc.Title,
				ownerId: _hybridMeta.OwnerId,
				ownedByMe: !!sfUserId && _hybridMeta.OwnerId === sfUserId,
				createdAt: new Date(_hybridMeta.CreatedDate || doc.CreatedDate).getTime(),
				updatedAt: new Date(
					_hybridMeta[_hybridApi('Last_Edited_At__c')] ||
						_hybridMeta.LastModifiedDate ||
						doc.LastModifiedDate,
				).getTime(),
				payload,
			};
		},

		async remove(id) {
			const hybrid = await _getHybridCanvasRecord(id);
			const bodies = await _canvasBodyDocuments(conn, hybrid.Id);
			const bodyDocumentIds = [...new Set(bodies.map((body) => body.contentDocumentId))];
			const currentBodyDocumentId = hybrid[_hybridApi('Body_Document_Id__c')] || id;
			if (!bodyDocumentIds.includes(currentBodyDocumentId)) {
				bodyDocumentIds.push(currentBodyDocumentId);
			}
			try {
				await _destroyContentDocuments(conn, bodyDocumentIds);
			} catch (e) {
				const err = new Error('Delete failed: ' + ((e && e.message) || 'unknown error'));
				err.statusCode = 403;
				throw err;
			}
			try {
				await canvasKeys.remove({ sfOrgId, canvasId: id });
			} catch (e) {
				console.warn('canvas-store: failed to drop canvas_keys row for ' + id + ':', e && e.message);
			}
			try {
				await conn.sobject(_hybridApi('Orgloom_Canvas__c')).destroy(hybrid.Id);
			} catch (e) {
				console.warn('[hybrid-canvas] Canvas__c cascade delete failed for', id, ':', (e && e.message) || e);
			}
			return true;
		},

		async listShares(canvasId) {
			const hybridRecordId = await _getHybridCanvasRecordId(canvasId);
			const shareObj = _hybridApi('Orgloom_Canvas__Share');
			const hybridSoql =
				'SELECT Id, UserOrGroupId, AccessLevel, RowCause ' +
				'FROM ' +
				shareObj +
				' ' +
				"WHERE ParentId = '" +
				escapeSoqlLiteral(hybridRecordId) +
				"' " +
				"AND RowCause = 'Manual' " +
				'ORDER BY LastModifiedDate DESC LIMIT 200';
			const result = await conn.query(hybridSoql);
			const rows = result.records || [];
			const ids = rows.map((r) => r.UserOrGroupId);
			const userIds = ids.filter((x) => typeof x === 'string' && x.startsWith('005'));
			const groupIds = ids.filter((x) => typeof x === 'string' && (x.startsWith('00G') || x.startsWith('058')));
			const nameById = new Map();
			if (userIds.length > 0) {
				const users = await conn.query(
					"SELECT Id, Name FROM User WHERE Id IN ('" +
						userIds.map(escapeSoqlLiteral).join("','") +
						"') LIMIT 200",
				);
				for (const u of users.records || []) {
					nameById.set(u.Id, u.Name);
				}
			}
			if (groupIds.length > 0) {
				const groups = await conn.query(
					"SELECT Id, Name FROM Group WHERE Id IN ('" +
						groupIds.map(escapeSoqlLiteral).join("','") +
						"') LIMIT 200",
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
				accessLevel: s.AccessLevel === 'Edit' ? 'Collaborator' : 'Viewer',
			}));
		},

		async addShare(canvasId, { entityId, accessLevel }) {
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
				const probe = hError
					? String(hError.message || hError)
					: hResult && !hResult.success
						? (hResult.errors || []).map((e) => e.message || e).join('; ')
						: '';
				return /duplicate|already.*(shared|exists)/i.test(probe);
			})();
			if (isDup) {
				const existing = await conn.query(
					'SELECT Id, AccessLevel FROM ' +
						shareObj +
						' ' +
						"WHERE ParentId = '" +
						escapeSoqlLiteral(hybridRecordId) +
						"' " +
						"AND UserOrGroupId = '" +
						escapeSoqlLiteral(entityId) +
						"' " +
						"AND RowCause = 'Manual' LIMIT 1",
				);
				const row = (existing.records || [])[0];
				if (row) {
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

		async updateShareLevel(canvasId, { entityId, accessLevel }) {
			const hybridRecordId = await _getHybridCanvasRecordId(canvasId);
			const shareObj = _hybridApi('Orgloom_Canvas__Share');
			const targetLevel = accessLevel === 'Edit' ? 'Edit' : 'Read';
			const existing = await conn.query(
				'SELECT Id, AccessLevel FROM ' +
					shareObj +
					' ' +
					"WHERE ParentId = '" +
					escapeSoqlLiteral(hybridRecordId) +
					"' " +
					"AND UserOrGroupId = '" +
					escapeSoqlLiteral(entityId) +
					"' " +
					"AND RowCause = 'Manual' LIMIT 1",
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

export async function canvasStoreFor(req) {
	const bundle = await getActiveSfConnection(req);
	if (!bundle) {
		throw new Error('Not authenticated');
	}
	return makeContentVersionStoreFromConnection(bundle.conn, bundle.sfUserId, bundle.sfOrgId);
}

function _tagContentVersionPermError(err, mode /* 'create' | 'update' */) {
	const msg = String((err && err.message) || err || '');
	const looksLikePerm =
		/INSUFFICIENT_ACCESS|insufficient.*(access|privileg)|permission|FIELD_INTEGRITY_EXCEPTION/i.test(msg);
	if (!looksLikePerm) {
		return err;
	} // leave non-perm errors as-is
	err.statusCode = 403;
	err.code = mode === 'update' ? 'sf-content-document-edit-denied' : 'sf-content-version-create-denied';
	err.sfError = msg;
	err.message =
		mode === 'update'
			? "Your Salesforce user can't edit this saved canvas (Salesforce ContentDocument). " +
				"If you're not the canvas owner, ask the owner to make changes. If you are the owner, " +
				'ask your SF admin to grant you edit access on Files / ContentDocument.'
			: "Your Salesforce user can't save canvas files to this org. " +
				'Ask your SF admin to grant your profile the "Create Content" / "Add Files" permission.';
	return err;
}

export async function canvasStoreFromSfConnection(conn, sfUserId, sfOrgId, opts) {
	return makeContentVersionStoreFromConnection(conn, sfUserId, sfOrgId, opts);
}
