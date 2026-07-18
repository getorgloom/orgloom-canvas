import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyBatchDrift, detectCascadeConflicts } from '../src/upload-recall.js';

function makeFakeConn(stateById) {
	return {
		version: '60.0',
		request: async ({ method, url }) => {
			if (method !== 'GET') {
				return { records: [] };
			}
			const qIdx = url.indexOf('?q=');
			if (qIdx < 0) {
				return { records: [] };
			}
			const soql = decodeURIComponent(url.slice(qIdx + 3));
			const m = soql.match(/Id IN \(([^)]+)\)/);
			if (!m) {
				return { records: [] };
			}
			const ids = m[1].split(',').map((s) => s.replace(/^'|'$/g, '').trim());
			const records = ids
				.map((id) => stateById[id])
				.filter(Boolean)
				.map((s) => Object.assign({ Id: s.id }, s));
			return { records };
		},
	};
}

const UPLOADER_SF_ID = '005AAA00000Uploader';
const OTHER_SF_ID = '005BBB00000OtherXX';
const UPLOAD_TIME = Date.parse('2026-05-01T10:00:00Z');
const HOUR_MS = 60 * 60 * 1000;

function makeBatchRow(insertedIds) {
	return { id: 'batch1', insertedIds };
}

describe('classifyBatchDrift', () => {
	test('empty batch returns empty buckets', async () => {
		const conn = makeFakeConn({});
		const result = await classifyBatchDrift({
			conn,
			batch: makeBatchRow([]),
			uploaderSfUserId: UPLOADER_SF_ID,
			uploadTimeMs: UPLOAD_TIME,
		});
		assert.deepEqual(result, {
			clean: [],
			drifted: [],
			alreadyDeleted: [],
			unverified: [],
			updates: [],
		});
	});

	test('record modified only by uploader within grace window → clean', async () => {
		const inserted = [{ tempId: 't1', sfId: '001abc', objectName: 'Account' }];
		const conn = makeFakeConn({
			'001abc': {
				id: '001abc',
				LastModifiedById: UPLOADER_SF_ID,
				LastModifiedDate: new Date(UPLOAD_TIME + 30 * 1000).toISOString(),
				IsDeleted: false,
			},
		});
		const r = await classifyBatchDrift({
			conn,
			batch: makeBatchRow(inserted),
			uploaderSfUserId: UPLOADER_SF_ID,
			uploadTimeMs: UPLOAD_TIME,
		});
		assert.equal(r.clean.length, 1);
		assert.equal(r.drifted.length, 0);
		assert.equal(r.alreadyDeleted.length, 0);
		assert.equal(r.clean[0].sfId, '001abc');
	});

	test('record modified by another user → drifted', async () => {
		const inserted = [{ tempId: 't1', sfId: '001abc', objectName: 'Account' }];
		const conn = makeFakeConn({
			'001abc': {
				id: '001abc',
				LastModifiedById: OTHER_SF_ID,
				LastModifiedDate: new Date(UPLOAD_TIME + 5 * 60 * 1000).toISOString(),
				IsDeleted: false,
			},
		});
		const r = await classifyBatchDrift({
			conn,
			batch: makeBatchRow(inserted),
			uploaderSfUserId: UPLOADER_SF_ID,
			uploadTimeMs: UPLOAD_TIME,
		});
		assert.equal(r.clean.length, 0);
		assert.equal(r.drifted.length, 1);
		assert.equal(r.drifted[0].driftReason, 'modified_by_other_user');
		assert.equal(r.drifted[0].lastModifiedById, OTHER_SF_ID);
	});

	test('record modified by uploader well after the grace window → drifted', async () => {
		const inserted = [{ tempId: 't1', sfId: '001abc', objectName: 'Account' }];
		const conn = makeFakeConn({
			'001abc': {
				id: '001abc',
				LastModifiedById: UPLOADER_SF_ID,
				LastModifiedDate: new Date(UPLOAD_TIME + 5 * HOUR_MS).toISOString(), // 5 hours after, outside default 1h grace
				IsDeleted: false,
			},
		});
		const r = await classifyBatchDrift({
			conn,
			batch: makeBatchRow(inserted),
			uploaderSfUserId: UPLOADER_SF_ID,
			uploadTimeMs: UPLOAD_TIME,
		});
		assert.equal(r.clean.length, 0);
		assert.equal(r.drifted.length, 1);
		assert.equal(r.drifted[0].driftReason, 'modified_after_upload_window');
	});

	test('record IsDeleted=true → alreadyDeleted', async () => {
		const inserted = [{ tempId: 't1', sfId: '001abc', objectName: 'Account' }];
		const conn = makeFakeConn({
			'001abc': {
				id: '001abc',
				LastModifiedById: UPLOADER_SF_ID,
				LastModifiedDate: new Date(UPLOAD_TIME).toISOString(),
				IsDeleted: true,
			},
		});
		const r = await classifyBatchDrift({
			conn,
			batch: makeBatchRow(inserted),
			uploaderSfUserId: UPLOADER_SF_ID,
			uploadTimeMs: UPLOAD_TIME,
		});
		assert.equal(r.clean.length, 0);
		assert.equal(r.drifted.length, 0);
		assert.equal(r.alreadyDeleted.length, 1);
		assert.equal(r.alreadyDeleted[0].sfId, '001abc');
	});

	test('record missing from SF entirely → alreadyDeleted', async () => {
		const inserted = [{ tempId: 't1', sfId: '001missing', objectName: 'Account' }];
		const conn = makeFakeConn({}); // empty; record doesn't exist
		const r = await classifyBatchDrift({
			conn,
			batch: makeBatchRow(inserted),
			uploaderSfUserId: UPLOADER_SF_ID,
			uploadTimeMs: UPLOAD_TIME,
		});
		assert.equal(r.alreadyDeleted.length, 1);
		assert.equal(r.alreadyDeleted[0].sfId, '001missing');
	});

	test('mixed batch buckets each record correctly', async () => {
		const inserted = [
			{ tempId: 't1', sfId: '001clean', objectName: 'Account' },
			{ tempId: 't2', sfId: '001drift', objectName: 'Account' },
			{ tempId: 't3', sfId: '001gone', objectName: 'Account' },
			{ tempId: 't4', sfId: '003contact', objectName: 'Contact' },
		];
		const conn = makeFakeConn({
			'001clean': {
				id: '001clean',
				LastModifiedById: UPLOADER_SF_ID,
				LastModifiedDate: new Date(UPLOAD_TIME + 10 * 1000).toISOString(),
				IsDeleted: false,
			},
			'001drift': {
				id: '001drift',
				LastModifiedById: OTHER_SF_ID,
				LastModifiedDate: new Date(UPLOAD_TIME + 60 * 1000).toISOString(),
				IsDeleted: false,
			},
			'003contact': {
				id: '003contact',
				LastModifiedById: UPLOADER_SF_ID,
				LastModifiedDate: new Date(UPLOAD_TIME + 20 * 1000).toISOString(),
				IsDeleted: false,
			},
		});
		const r = await classifyBatchDrift({
			conn,
			batch: makeBatchRow(inserted),
			uploaderSfUserId: UPLOADER_SF_ID,
			uploadTimeMs: UPLOAD_TIME,
		});
		assert.equal(r.clean.length, 2);
		assert.equal(r.drifted.length, 1);
		assert.equal(r.alreadyDeleted.length, 1);
		assert.deepEqual(r.clean.map((x) => x.sfId).sort(), ['001clean', '003contact']);
		assert.equal(r.drifted[0].sfId, '001drift');
		assert.equal(r.alreadyDeleted[0].sfId, '001gone');
	});

	test('15-char vs 18-char SF id comparison is case-tolerant', async () => {
		const uploader15 = '005AAA00000Uploa';
		const uploader18 = uploader15 + 'XYZ';
		const inserted = [{ tempId: 't1', sfId: '001abc', objectName: 'Account' }];
		const conn = makeFakeConn({
			'001abc': {
				id: '001abc',
				LastModifiedById: uploader18,
				LastModifiedDate: new Date(UPLOAD_TIME + 1000).toISOString(),
				IsDeleted: false,
			},
		});
		const r = await classifyBatchDrift({
			conn,
			batch: makeBatchRow(inserted),
			uploaderSfUserId: uploader15,
			uploadTimeMs: UPLOAD_TIME,
		});
		assert.equal(r.clean.length, 1);
	});

	test('custom gracePeriodMs is honored', async () => {
		const inserted = [{ tempId: 't1', sfId: '001abc', objectName: 'Account' }];
		const conn = makeFakeConn({
			'001abc': {
				id: '001abc',
				LastModifiedById: UPLOADER_SF_ID,
				LastModifiedDate: new Date(UPLOAD_TIME + 10 * 60 * 1000).toISOString(),
				IsDeleted: false,
			},
		});
		const def = await classifyBatchDrift({
			conn,
			batch: makeBatchRow(inserted),
			uploaderSfUserId: UPLOADER_SF_ID,
			uploadTimeMs: UPLOAD_TIME,
		});
		assert.equal(def.clean.length, 1);

		const tight = await classifyBatchDrift({
			conn,
			batch: makeBatchRow(inserted),
			uploaderSfUserId: UPLOADER_SF_ID,
			uploadTimeMs: UPLOAD_TIME,
			gracePeriodMs: 5 * 60 * 1000, // 5 min
		});
		assert.equal(tight.clean.length, 0);
		assert.equal(tight.drifted.length, 1);
		assert.equal(tight.drifted[0].driftReason, 'modified_after_upload_window');
	});

	test('records without sfId are silently skipped', async () => {
		const inserted = [
			{ tempId: 't1', sfId: null, objectName: 'Account' },
			{ tempId: 't2', objectName: 'Account' }, // missing sfId
			{ tempId: 't3', sfId: '001valid', objectName: 'Account' },
		];
		const conn = makeFakeConn({
			'001valid': {
				id: '001valid',
				LastModifiedById: UPLOADER_SF_ID,
				LastModifiedDate: new Date(UPLOAD_TIME).toISOString(),
				IsDeleted: false,
			},
		});
		const r = await classifyBatchDrift({
			conn,
			batch: makeBatchRow(inserted),
			uploaderSfUserId: UPLOADER_SF_ID,
			uploadTimeMs: UPLOAD_TIME,
		});
		assert.equal(r.clean.length, 1);
		assert.equal(r.clean[0].sfId, '001valid');
	});
});

function makeFakeConnWithDescribe(describesByObject) {
	return {
		sobject: (name) => ({
			describe: async () => {
				const fields = describesByObject[name] || [];
				return { fields };
			},
		}),
	};
}

function makeBatchWithAssoc(insertedIds, associations) {
	return { id: 'b1', insertedIds, associations };
}

describe('detectCascadeConflicts', () => {
	test('no associations → no conflicts', async () => {
		const conn = makeFakeConnWithDescribe({});
		const conflicts = await detectCascadeConflicts({
			conn,
			batch: makeBatchWithAssoc([{ tempId: 1, sfId: '001A', objectName: 'Account' }], []),
			classification: {
				clean: [{ sfId: '001A' }],
				drifted: [],
				alreadyDeleted: [],
			},
		});
		assert.deepEqual(conflicts, []);
	});

	test('lookup field (cascadeDelete=false): no conflict even with parent clean + child drifted', async () => {
		const conn = makeFakeConnWithDescribe({
			Contact: [{ name: 'AccountId', cascadeDelete: false }],
		});
		const inserted = [
			{ tempId: 1, sfId: '001PARENT', objectName: 'Account' },
			{ tempId: 2, sfId: '003CHILD', objectName: 'Contact' },
		];
		const associations = [{ fromTempId: 2, toTempId: 1, fieldName: 'AccountId' }];
		const conflicts = await detectCascadeConflicts({
			conn,
			batch: makeBatchWithAssoc(inserted, associations),
			classification: {
				clean: [{ sfId: '001PARENT' }],
				drifted: [{ sfId: '003CHILD' }],
				alreadyDeleted: [],
			},
		});
		assert.deepEqual(conflicts, []);
	});

	test('master-detail field (cascadeDelete=true) + parent clean + child drifted → conflict', async () => {
		const conn = makeFakeConnWithDescribe({
			Order_Line__c: [{ name: 'Order__c', cascadeDelete: true }],
		});
		const inserted = [
			{ tempId: 1, sfId: '801ORDER', objectName: 'Order' },
			{ tempId: 2, sfId: 'a01LINE', objectName: 'Order_Line__c' },
		];
		const associations = [{ fromTempId: 2, toTempId: 1, fieldName: 'Order__c' }];
		const conflicts = await detectCascadeConflicts({
			conn,
			batch: makeBatchWithAssoc(inserted, associations),
			classification: {
				clean: [{ sfId: '801ORDER' }],
				drifted: [{ sfId: 'a01LINE' }],
				alreadyDeleted: [],
			},
		});
		assert.equal(conflicts.length, 1);
		assert.equal(conflicts[0].parentSfId, '801ORDER');
		assert.equal(conflicts[0].parentObjectName, 'Order');
		assert.equal(conflicts[0].childSfId, 'a01LINE');
		assert.equal(conflicts[0].childObjectName, 'Order_Line__c');
		assert.equal(conflicts[0].fieldName, 'Order__c');
	});

	test('master-detail field but parent in drifted (not clean) → no conflict (skip is meaningful)', async () => {
		const conn = makeFakeConnWithDescribe({
			Order_Line__c: [{ name: 'Order__c', cascadeDelete: true }],
		});
		const inserted = [
			{ tempId: 1, sfId: '801ORDER', objectName: 'Order' },
			{ tempId: 2, sfId: 'a01LINE', objectName: 'Order_Line__c' },
		];
		const associations = [{ fromTempId: 2, toTempId: 1, fieldName: 'Order__c' }];
		const conflicts = await detectCascadeConflicts({
			conn,
			batch: makeBatchWithAssoc(inserted, associations),
			classification: {
				clean: [],
				drifted: [{ sfId: '801ORDER' }, { sfId: 'a01LINE' }],
				alreadyDeleted: [],
			},
		});
		assert.deepEqual(conflicts, []);
	});

	test('master-detail field + child clean (will be recalled) → no conflict (no skip to invalidate)', async () => {
		const conn = makeFakeConnWithDescribe({
			Order_Line__c: [{ name: 'Order__c', cascadeDelete: true }],
		});
		const inserted = [
			{ tempId: 1, sfId: '801ORDER', objectName: 'Order' },
			{ tempId: 2, sfId: 'a01LINE', objectName: 'Order_Line__c' },
		];
		const associations = [{ fromTempId: 2, toTempId: 1, fieldName: 'Order__c' }];
		const conflicts = await detectCascadeConflicts({
			conn,
			batch: makeBatchWithAssoc(inserted, associations),
			classification: {
				clean: [{ sfId: '801ORDER' }, { sfId: 'a01LINE' }],
				drifted: [],
				alreadyDeleted: [],
			},
		});
		assert.deepEqual(conflicts, []);
	});

	test('multiple master-detail children of one clean parent → multiple conflicts', async () => {
		const conn = makeFakeConnWithDescribe({
			Order_Line__c: [{ name: 'Order__c', cascadeDelete: true }],
		});
		const inserted = [
			{ tempId: 1, sfId: '801ORDER', objectName: 'Order' },
			{ tempId: 2, sfId: 'a01L1', objectName: 'Order_Line__c' },
			{ tempId: 3, sfId: 'a01L2', objectName: 'Order_Line__c' },
		];
		const associations = [
			{ fromTempId: 2, toTempId: 1, fieldName: 'Order__c' },
			{ fromTempId: 3, toTempId: 1, fieldName: 'Order__c' },
		];
		const conflicts = await detectCascadeConflicts({
			conn,
			batch: makeBatchWithAssoc(inserted, associations),
			classification: {
				clean: [{ sfId: '801ORDER' }],
				drifted: [{ sfId: 'a01L1' }, { sfId: 'a01L2' }],
				alreadyDeleted: [],
			},
		});
		assert.equal(conflicts.length, 2);
		const childIds = conflicts.map((c) => c.childSfId).sort();
		assert.deepEqual(childIds, ['a01L1', 'a01L2']);
	});

	test('describe failure on a child object → no conflict reported (conservative)', async () => {
		const conn = {
			sobject: (name) => ({
				describe: async () => {
					if (name === 'Order_Line__c') {
						throw new Error('No describe access');
					}
					return { fields: [] };
				},
			}),
		};
		const inserted = [
			{ tempId: 1, sfId: '801ORDER', objectName: 'Order' },
			{ tempId: 2, sfId: 'a01LINE', objectName: 'Order_Line__c' },
		];
		const associations = [{ fromTempId: 2, toTempId: 1, fieldName: 'Order__c' }];
		const conflicts = await detectCascadeConflicts({
			conn,
			batch: makeBatchWithAssoc(inserted, associations),
			classification: {
				clean: [{ sfId: '801ORDER' }],
				drifted: [{ sfId: 'a01LINE' }],
				alreadyDeleted: [],
			},
		});
		assert.deepEqual(conflicts, []);
	});

	test('only master-detail fields with cascadeDelete=true count', async () => {
		const conn = makeFakeConnWithDescribe({
			Order_Line__c: [
				{ name: 'Order__c', cascadeDelete: true }, // master-detail
				{ name: 'Approver__c', cascadeDelete: false }, // lookup
			],
		});
		const inserted = [
			{ tempId: 1, sfId: '801ORDER', objectName: 'Order' },
			{ tempId: 2, sfId: '005APPROVER', objectName: 'User' },
			{ tempId: 3, sfId: 'a01LINE', objectName: 'Order_Line__c' },
		];
		const associations = [
			{ fromTempId: 3, toTempId: 1, fieldName: 'Order__c' },
			{ fromTempId: 3, toTempId: 2, fieldName: 'Approver__c' },
		];
		const conflicts = await detectCascadeConflicts({
			conn,
			batch: makeBatchWithAssoc(inserted, associations),
			classification: {
				clean: [{ sfId: '801ORDER' }, { sfId: '005APPROVER' }],
				drifted: [{ sfId: 'a01LINE' }],
				alreadyDeleted: [],
			},
		});
		assert.equal(conflicts.length, 1);
		assert.equal(conflicts[0].fieldName, 'Order__c');
	});
});
