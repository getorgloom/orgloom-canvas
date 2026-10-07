import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import * as canvasKeys from '../src/database/canvas-keys.js';
import { makeSfApexKekProvider } from '../src/storage/canvas-encryption.js';
import { canvasContributionStoreFromSfConnection } from '../src/storage/canvas-contribution-store.js';
import { clearTestDb, initTestDb } from './helpers/db.js';
import { installSfFetchStub } from './helpers/sf-kek-stub.js';

const ORG_ID = '00D000000000001AAA';
const CANVAS_ID = '069000000000001AAA';
const CONTRIBUTOR_ID = '005000000000002AAA';
const OWNER_ID = '005000000000001AAA';
const F = (name) => `orgloom__${name}`;

let fetchStub;

before(initTestDb);
before(() => {
	fetchStub = installSfFetchStub();
});
after(() => fetchStub.restore());
beforeEach(clearTestDb);

function contributionConn() {
	const rows = [];
	const updates = [];
	const shares = [];
	return {
		instanceUrl: 'https://test.my.salesforce.com',
		accessToken: 'TEST_TOKEN',
		rows,
		updates,
		shares,
		async query(soql) {
			if (soql.includes('FROM orgloom__Orgloom_Canvas__c')) {
				return { records: [{ Id: 'a00000000000001AAA', OwnerId: OWNER_ID }] };
			}
			if (soql.includes("orgloom__Status__c = 'Submitted'") && soql.includes('orgloom__Payload__c')) {
				return { records: rows.filter((row) => row[F('Status__c')] === 'Submitted') };
			}
			if (soql.includes("orgloom__Status__c = 'Submitted'")) {
				return { records: [] };
			}
			throw new Error(`Unexpected query: ${soql}`);
		},
		sobject(name) {
			return {
				async create(payload) {
					if (name === 'orgloom__Canvas_Contribution__c') {
						const id = 'a01000000000001AAA';
						rows.push(Object.assign({ Id: id }, payload));
						return { success: true, id };
					}
					if (name === 'orgloom__Canvas_Contribution__Share') {
						shares.push(payload);
						return { success: true, id: '00V000000000001AAA' };
					}
					throw new Error(`Unexpected create on ${name}`);
				},
				async update(payload) {
					const batch = Array.isArray(payload) ? payload : [payload];
					updates.push(...batch);
					return batch.map(() => ({ success: true }));
				},
				async destroy() {
					return { success: true };
				},
			};
		},
	};
}

test('stores an encrypted contribution in Salesforce, shares it to the owner, and decrypts it for merge', async () => {
	const conn = contributionConn();
	const kekProvider = makeSfApexKekProvider(conn);
	await canvasKeys.persist({
		sfOrgId: ORG_ID,
		canvasId: CANVAS_ID,
		dataKey: Buffer.alloc(32, 7),
		kekProvider,
		sessionId: 'contribution-test',
	});
	const store = canvasContributionStoreFromSfConnection(conn, CONTRIBUTOR_ID, ORG_ID, {
		sessionId: 'contribution-test',
	});

	const result = await store.submit({
		canvasId: CANVAS_ID,
		canvasVersionId: '068000000000001AAA',
		fill: { slotId: 'request-1', values: { LastName: 'Submitted value' } },
	});

	assert.equal(result.id, 'a01000000000001AAA');
	assert.equal(conn.rows.length, 1);
	assert.doesNotMatch(conn.rows[0][F('Payload__c')], /Submitted value/);
	assert.equal(conn.rows[0][F('Status__c')], 'Submitted');
	assert.deepEqual(conn.shares, [
		{
			ParentId: 'a01000000000001AAA',
			UserOrGroupId: OWNER_ID,
			AccessLevel: 'Edit',
			RowCause: 'Manual',
		},
	]);

	const pending = await store.listPending(CANVAS_ID);
	assert.deepEqual(pending.contributions[0].fill, {
		slotId: 'request-1',
		values: { LastName: 'Submitted value' },
	});
	assert.equal(pending.contributions[0].contributorSfUserId, CONTRIBUTOR_ID);
	assert.deepEqual(pending.rejectedIds, []);

	conn.rows[0][F('Payload_Sha256__c')] = '0'.repeat(64);
	const tampered = await store.listPending(CANVAS_ID);
	assert.deepEqual(tampered.contributions, []);
	assert.deepEqual(tampered.rejectedIds, [result.id]);

	assert.equal(await store.markMerged([result.id]), 1);
	assert.equal(conn.updates[0][F('Status__c')], 'Merged');
});
