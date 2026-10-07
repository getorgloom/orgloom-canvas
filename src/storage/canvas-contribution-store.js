import crypto from 'node:crypto';
import { config } from '../config.js';
import { escapeSoqlLiteral } from '../sf-soql.js';
import * as canvasKeys from '../database/canvas-keys.js';
import { encryptPayload, decryptPayload, makeSfApexKekProvider } from './canvas-encryption.js';

const MAX_CONTRIBUTION_JSON_BYTES = 96 * 1024;

function api(name) {
	const ns = (config.canvas && config.canvas.namespacePrefix) || '';
	return ns ? `${ns}__${name}` : name;
}

function assertSalesforceId(value, label) {
	if (!/^[a-zA-Z0-9]{15,18}$/.test(String(value || ''))) {
		throw new Error(`${label} must be a Salesforce id`);
	}
}

function successful(result, action) {
	if (result && result.success) {
		return result;
	}
	const errors = (result && result.errors ? result.errors : []).map((entry) => entry.message || entry).join('; ');
	throw new Error(`${action} failed: ${errors || 'unknown Salesforce error'}`);
}

export function canvasContributionStoreFromSfConnection(conn, sfUserId, sfOrgId, opts = {}) {
	const objectName = api('Canvas_Contribution__c');
	const field = (name) => api(name);
	const sessionId = opts.sessionId || null;
	const kekProvider = makeSfApexKekProvider(conn);

	async function canvasRecord(canvasId) {
		assertSalesforceId(canvasId, 'canvasId');
		const canvasObject = api('Orgloom_Canvas__c');
		const result = await conn.query(
			`SELECT Id, OwnerId FROM ${canvasObject} WHERE ${field('Canvas_Id__c')} = '${escapeSoqlLiteral(canvasId)}' LIMIT 1`,
		);
		const record = result.records && result.records[0];
		if (!record) {
			const error = new Error('Canvas not found, or you no longer have access to it.');
			error.statusCode = 404;
			error.code = 'canvas-not-accessible';
			throw error;
		}
		return record;
	}

	async function dataKey(canvasId) {
		const key = await canvasKeys.get({ sfOrgId, canvasId, kekProvider, sessionId });
		if (!key) {
			const error = new Error(
				'The encryption key for this canvas is unavailable. Reload the canvas and try again.',
			);
			error.statusCode = 503;
			error.code = 'canvas-key-missing';
			throw error;
		}
		return key;
	}

	return {
		async submit({ canvasId, canvasVersionId, fill }) {
			if (!fill || fill.slotId == null || !fill.values || typeof fill.values !== 'object') {
				throw new Error('A slot id and field values are required');
			}
			const parent = await canvasRecord(canvasId);
			const json = JSON.stringify({ fill });
			if (Buffer.byteLength(json, 'utf8') > MAX_CONTRIBUTION_JSON_BYTES) {
				const error = new Error('This contribution is too large to submit. Split it into smaller requests.');
				error.statusCode = 413;
				error.code = 'contribution-too-large';
				throw error;
			}
			const envelope = encryptPayload(json, await dataKey(canvasId));
			const slotId = String(fill.slotId);

			const previous = await conn.query(
				`SELECT Id FROM ${objectName} WHERE ${field('Canvas_Id__c')} = '${escapeSoqlLiteral(canvasId)}' ` +
					`AND ${field('Slot_Id__c')} = '${escapeSoqlLiteral(slotId)}' ` +
					`AND ${field('Contributor_Sf_User_Id__c')} = '${escapeSoqlLiteral(sfUserId)}' ` +
					`AND ${field('Status__c')} = 'Submitted' LIMIT 200`,
			);
			if (previous.records && previous.records.length > 0) {
				await conn
					.sobject(objectName)
					.update(previous.records.map((record) => ({ Id: record.Id, [field('Status__c')]: 'Superseded' })));
			}

			const result = successful(
				await conn.sobject(objectName).create({
					[field('Canvas__c')]: parent.Id,
					[field('Canvas_Id__c')]: canvasId,
					[field('Canvas_Version_Id__c')]: canvasVersionId || null,
					[field('Slot_Id__c')]: slotId,
					[field('Contributor_Sf_User_Id__c')]: sfUserId,
					[field('Payload__c')]: envelope.toString('base64'),
					[field('Payload_Sha256__c')]: crypto.createHash('sha256').update(envelope).digest('hex'),
					[field('Status__c')]: 'Submitted',
					[field('Submitted_At__c')]: new Date().toISOString(),
				}),
				'Contribution create',
			);

			if (parent.OwnerId && parent.OwnerId !== sfUserId) {
				try {
					successful(
						await conn.sobject(api('Canvas_Contribution__Share')).create({
							ParentId: result.id,
							UserOrGroupId: parent.OwnerId,
							AccessLevel: 'Edit',
							RowCause: 'Manual',
						}),
						'Contribution share',
					);
				} catch (error) {
					await conn
						.sobject(objectName)
						.destroy(result.id)
						.catch(() => {});
					throw error;
				}
			}
			return { id: result.id, slotId };
		},

		async listPending(canvasId) {
			assertSalesforceId(canvasId, 'canvasId');
			const result = await conn.query(
				`SELECT Id, ${field('Contributor_Sf_User_Id__c')}, ${field('Payload__c')}, ` +
					`${field('Payload_Sha256__c')}, ${field('Submitted_At__c')} FROM ${objectName} ` +
					`WHERE ${field('Canvas_Id__c')} = '${escapeSoqlLiteral(canvasId)}' ` +
					`AND ${field('Status__c')} = 'Submitted' ORDER BY ${field('Submitted_At__c')} ASC LIMIT 500`,
			);
			const key = await dataKey(canvasId);
			const contributions = [];
			const rejectedIds = [];
			for (const record of result.records || []) {
				try {
					const encoded = record[field('Payload__c')];
					if (!encoded) {
						throw new Error('Contribution payload is missing');
					}
					const envelope = Buffer.from(encoded, 'base64');
					const expected = record[field('Payload_Sha256__c')];
					if (expected && crypto.createHash('sha256').update(envelope).digest('hex') !== expected) {
						throw new Error('Contribution failed its integrity check');
					}
					const decoded = JSON.parse(decryptPayload(envelope, key));
					if (!decoded.fill || typeof decoded.fill !== 'object') {
						throw new Error('Contribution payload is invalid');
					}
					contributions.push({
						id: record.Id,
						contributorSfUserId: record[field('Contributor_Sf_User_Id__c')],
						submittedAt: record[field('Submitted_At__c')],
						fill: decoded.fill,
					});
				} catch (error) {
					console.warn('[canvas-contributions] rejected contribution:', record.Id, error.message || error);
					rejectedIds.push(record.Id);
				}
			}
			return { contributions, rejectedIds };
		},

		async markStatus(ids, status) {
			if (!['Merged', 'Superseded'].includes(status)) {
				throw new Error('Unsupported contribution status');
			}
			const safeIds = (Array.isArray(ids) ? ids : []).filter((id) => /^[a-zA-Z0-9]{15,18}$/.test(String(id)));
			if (safeIds.length === 0) {
				return 0;
			}
			const results = await conn
				.sobject(objectName)
				.update(safeIds.map((id) => ({ Id: id, [field('Status__c')]: status })));
			return (Array.isArray(results) ? results : [results]).filter((result) => result && result.success).length;
		},

		async markMerged(ids) {
			return this.markStatus(ids, 'Merged');
		},

		async markSuperseded(ids) {
			return this.markStatus(ids, 'Superseded');
		},
	};
}
