








import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
	shareSchemaFor,
	shareTableFor,
	recordsToShareFromManifest,
	grantRecordAccess,
	_classifyShareError,
} from '../src/sf-record-share.js';

describe('shareSchemaFor — standard objects use <Object>Id / <Object>AccessLevel', () => {
	test('Account → AccountShare with multi-axis access fields (AccountShare special-case)', () => {






		assert.deepEqual(shareSchemaFor('Account'), {
			shareTable: 'AccountShare',
			parentField: 'AccountId',
			accessLevelField: 'AccountAccessLevel',
			extraFields: {
				OpportunityAccessLevel: 'None',
				CaseAccessLevel: 'None',
			},
		});
	});
	test('Opportunity → OpportunityShare with OpportunityId + OpportunityAccessLevel', () => {
		assert.deepEqual(shareSchemaFor('Opportunity'), {
			shareTable: 'OpportunityShare',
			parentField: 'OpportunityId',
			accessLevelField: 'OpportunityAccessLevel',
			extraFields: {},
		});
	});
	test('Contact → ContactShare with ContactId + ContactAccessLevel', () => {
		assert.deepEqual(shareSchemaFor('Contact'), {
			shareTable: 'ContactShare',
			parentField: 'ContactId',
			accessLevelField: 'ContactAccessLevel',
			extraFields: {},
		});
	});
	test('Lead → LeadShare with LeadId + LeadAccessLevel', () => {
		assert.deepEqual(shareSchemaFor('Lead'), {
			shareTable: 'LeadShare',
			parentField: 'LeadId',
			accessLevelField: 'LeadAccessLevel',
			extraFields: {},
		});
	});
	test('Case → CaseShare with CaseId + CaseAccessLevel', () => {
		assert.deepEqual(shareSchemaFor('Case'), {
			shareTable: 'CaseShare',
			parentField: 'CaseId',
			accessLevelField: 'CaseAccessLevel',
			extraFields: {},
		});
	});
});

describe('shareSchemaFor — custom objects use ParentId / AccessLevel', () => {
	test('MyCustom__c → MyCustom__Share with ParentId + AccessLevel', () => {
		assert.deepEqual(shareSchemaFor('MyCustom__c'), {
			shareTable: 'MyCustom__Share',
			parentField: 'ParentId',
			accessLevelField: 'AccessLevel',
			extraFields: {},
		});
	});
	test('namespaced custom: orgloom__Canvas__c uses ParentId + AccessLevel', () => {
		assert.deepEqual(shareSchemaFor('orgloom__Canvas__c'), {
			shareTable: 'orgloom__Canvas__Share',
			parentField: 'ParentId',
			accessLevelField: 'AccessLevel',
			extraFields: {},
		});
	});
});

describe('shareSchemaFor — defensive', () => {
	test('throws on empty / null / undefined / non-string', () => {
		assert.throws(() => shareSchemaFor(''), /objectName is required/);
		assert.throws(() => shareSchemaFor(null), /objectName is required/);
		assert.throws(() => shareSchemaFor(undefined), /objectName is required/);
		assert.throws(() => shareSchemaFor(42), /objectName is required/);
	});
});

describe('shareTableFor — standard objects', () => {
	test('Account → AccountShare', () => {
		assert.equal(shareTableFor('Account'), 'AccountShare');
	});
	test('Contact → ContactShare', () => {
		assert.equal(shareTableFor('Contact'), 'ContactShare');
	});
	test('Opportunity → OpportunityShare', () => {
		assert.equal(shareTableFor('Opportunity'), 'OpportunityShare');
	});
	test('Lead → LeadShare', () => {
		assert.equal(shareTableFor('Lead'), 'LeadShare');
	});
	test('Case → CaseShare', () => {
		assert.equal(shareTableFor('Case'), 'CaseShare');
	});
});

describe('shareTableFor — custom objects', () => {
	test('MyCustom__c → MyCustom__Share', () => {
		assert.equal(shareTableFor('MyCustom__c'), 'MyCustom__Share');
	});
	test('namespaced custom: orgloom__Canvas__c → orgloom__Canvas__Share', () => {
		assert.equal(shareTableFor('orgloom__Canvas__c'), 'orgloom__Canvas__Share');
	});
	test('multi-underscore name: My_Cool_Object__c → My_Cool_Object__Share', () => {
		assert.equal(shareTableFor('My_Cool_Object__c'), 'My_Cool_Object__Share');
	});
});

describe('shareTableFor — defensive', () => {
	test('throws on empty string', () => {
		assert.throws(() => shareTableFor(''), /objectName is required/);
	});
	test('throws on null / undefined', () => {
		assert.throws(() => shareTableFor(null), /objectName is required/);
		assert.throws(() => shareTableFor(undefined), /objectName is required/);
	});
	test('throws on non-string', () => {
		assert.throws(() => shareTableFor(42), /objectName is required/);
	});
});

describe('recordsToShareFromManifest', () => {
	test('extracts loaded records as (objectName, recordId) pairs', () => {
		const out = recordsToShareFromManifest({
			records: [
				{ objectName: 'Account', loadedFromId: '001A' },
				{ objectName: 'Contact', loadedFromId: '003B' },
			],
		});
		assert.deepEqual(out, [
			{ objectName: 'Account', recordId: '001A' },
			{ objectName: 'Contact', recordId: '003B' },
		]);
	});

	test('de-dupes by recordId — multi-slot on same record yields one share', () => {
		const out = recordsToShareFromManifest({
			records: [
				{ objectName: 'Account', loadedFromId: '001A', slot: { slotId: 1, kind: 'fields', fields: ['Industry'] } },
				{ objectName: 'Account', loadedFromId: '001A', slot: { slotId: 2, kind: 'fields', fields: ['Phone'] } },
			],
		});
		assert.equal(out.length, 1);
		assert.deepEqual(out[0], { objectName: 'Account', recordId: '001A' });
	});

	test('drafts (no loadedFromId) excluded', () => {
		const out = recordsToShareFromManifest({
			records: [
				{ objectName: 'Account', loadedFromId: '001A' },
				{ objectName: 'Account' },
				{ objectName: 'Contact', loadedFromId: null },
			],
		});
		assert.equal(out.length, 1);
		assert.equal(out[0].recordId, '001A');
	});

	test('type-nodes + pending records excluded', () => {
		const out = recordsToShareFromManifest({
			records: [
				{ objectName: 'Account', loadedFromId: '001A' },
				{ objectName: 'Contact', loadedFromId: '003B', isTypeNode: true },
				{ objectName: 'Lead', loadedFromId: '00QC', isPending: true },
			],
		});
		assert.equal(out.length, 1);
		assert.equal(out[0].objectName, 'Account');
	});

	test('records missing objectName excluded', () => {
		const out = recordsToShareFromManifest({
			records: [
				{ loadedFromId: '001A' },
				{ objectName: 'Account', loadedFromId: '001B' },
			],
		});
		assert.equal(out.length, 1);
		assert.equal(out[0].recordId, '001B');
	});

	test('empty / missing payload returns empty array', () => {
		assert.deepEqual(recordsToShareFromManifest(null), []);
		assert.deepEqual(recordsToShareFromManifest({}), []);
		assert.deepEqual(recordsToShareFromManifest({ records: [] }), []);
		assert.deepEqual(recordsToShareFromManifest({ records: 'not-an-array' }), []);
	});

	test('preserves order of first occurrence (de-dupe keeps the first)', () => {
		const out = recordsToShareFromManifest({
			records: [
				{ objectName: 'Account', loadedFromId: '001A' },
				{ objectName: 'Contact', loadedFromId: '003B' },
				{ objectName: 'Account', loadedFromId: '001A' },
				{ objectName: 'Lead', loadedFromId: '00QC' },
			],
		});
		assert.deepEqual(out.map((r) => r.recordId), ['001A', '003B', '00QC']);
	});
});

describe('grantRecordAccess — connection interaction (mocked)', () => {
	function makeMockConn(behavior) {






		const calls = [];
		return {
			calls,
			sobject(shareTable) {
				return {
					create: async (row) => {
						calls.push({ shareTable, row });
						const recordId = row.ParentId
							|| Object.entries(row).find(([k]) => k.endsWith('Id') && k !== 'UserOrGroupId')?.[1]
							|| null;
						const key = shareTable + ':' + recordId;
						const outcome = behavior[key] || 'success';
						if (outcome === 'success') {
							return { success: true, id: 'fakeShare_' + calls.length };
						}
						if (outcome === 'duplicate') {
							return {
								success: false,
								errors: [{ message: 'DUPLICATE_VALUE: duplicate value found' }],
							};
						}
						if (outcome.startsWith('throw:')) {
							throw new Error(outcome.slice('throw:'.length));
						}
						if (outcome.startsWith('fail:')) {
							return {
								success: false,
								errors: [{ message: outcome.slice('fail:'.length) }],
							};
						}
						return { success: false, errors: [{ message: 'unknown' }] };
					},
				};
			},
		};
	}

	test('grants successful shares using object-specific share-row shape', async () => {
		const conn = makeMockConn({});
		const out = await grantRecordAccess(conn, [
			{ objectName: 'Account', recordId: '001A' },
			{ objectName: 'Contact', recordId: '003B' },
		], '005me');
		assert.equal(out.granted.length, 2);
		assert.equal(out.failed.length, 0);

		assert.equal(conn.calls[0].shareTable, 'AccountShare');
		assert.equal(conn.calls[1].shareTable, 'ContactShare');



		assert.equal(conn.calls[0].row.AccountId, '001A');
		assert.equal(conn.calls[0].row.AccountAccessLevel, 'Edit');
		assert.equal(conn.calls[0].row.UserOrGroupId, '005me');
		assert.equal(conn.calls[0].row.RowCause, 'Manual');
		assert.equal(conn.calls[0].row.ParentId, undefined,
			'AccountShare must NOT have ParentId — that field does not exist on it');
		assert.equal(conn.calls[0].row.AccessLevel, undefined,
			'AccountShare must NOT have AccessLevel — uses AccountAccessLevel instead');
		assert.equal(conn.calls[1].row.ContactId, '003B');
		assert.equal(conn.calls[1].row.ContactAccessLevel, 'Edit');
	});

	test('AccountShare row carries the multi-axis required AccessLevel extras', async () => {



		const conn = makeMockConn({});
		await grantRecordAccess(conn, [
			{ objectName: 'Account', recordId: '001A' },
		], '005me');
		const row = conn.calls[0].row;
		assert.equal(row.AccountAccessLevel, 'Edit', 'primary access = Edit');
		assert.equal(row.OpportunityAccessLevel, 'None', 'extras default to None — no cascade');
		assert.equal(row.CaseAccessLevel, 'None');
	});

	test('non-AccountShare rows do NOT include the AccountShare extras', async () => {



		const conn = makeMockConn({});
		await grantRecordAccess(conn, [
			{ objectName: 'Contact', recordId: '003B' },
			{ objectName: 'Lead', recordId: '00QC' },
			{ objectName: 'orgloom__Canvas__c', recordId: 'a01D' },
		], '005me');
		for (const call of conn.calls) {
			assert.equal(call.row.OpportunityAccessLevel, undefined);
			assert.equal(call.row.CaseAccessLevel, undefined);
		}
	});

	test('custom-object shares still use ParentId + AccessLevel', () => {


		return (async () => {
			const conn = makeMockConn({});
			await grantRecordAccess(conn, [
				{ objectName: 'orgloom__Canvas__c', recordId: 'a01ABC' },
				{ objectName: 'My_Cool_Object__c', recordId: 'a02DEF' },
			], '005me');
			assert.equal(conn.calls[0].shareTable, 'orgloom__Canvas__Share');
			assert.equal(conn.calls[0].row.ParentId, 'a01ABC');
			assert.equal(conn.calls[0].row.AccessLevel, 'Edit');
			assert.equal(conn.calls[1].shareTable, 'My_Cool_Object__Share');
			assert.equal(conn.calls[1].row.ParentId, 'a02DEF');
			assert.equal(conn.calls[1].row.AccessLevel, 'Edit');
		})();
	});

	test('treats DUPLICATE_VALUE as already-granted (still reports as granted)', async () => {
		const conn = makeMockConn({
			'AccountShare:001A': 'duplicate',
		});
		const out = await grantRecordAccess(conn, [
			{ objectName: 'Account', recordId: '001A' },
		], '005me');
		assert.equal(out.granted.length, 1);
		assert.equal(out.granted[0].alreadyShared, true);
		assert.equal(out.failed.length, 0);
	});

	test('failures are isolated per-record', async () => {
		const conn = makeMockConn({
			'ContactShare:003B': 'fail:INSUFFICIENT_ACCESS_OR_READONLY',
		});
		const out = await grantRecordAccess(conn, [
			{ objectName: 'Account', recordId: '001A' },
			{ objectName: 'Contact', recordId: '003B' },
			{ objectName: 'Account', recordId: '001C' },
		], '005me');
		assert.equal(out.granted.length, 2);
		assert.equal(out.failed.length, 1);
		assert.equal(out.failed[0].objectName, 'Contact');
		assert.equal(out.failed[0].recordId, '003B');
		assert.match(out.failed[0].error, /INSUFFICIENT_ACCESS/);
	});

	test('thrown errors are caught + reported as failures', async () => {
		const conn = makeMockConn({
			'AccountShare:001A': 'throw:Network error',
		});
		const out = await grantRecordAccess(conn, [
			{ objectName: 'Account', recordId: '001A' },
		], '005me');
		assert.equal(out.granted.length, 0);
		assert.equal(out.failed.length, 1);
		assert.match(out.failed[0].error, /Network error/);
	});

	test('thrown DUPLICATE_VALUE error is normalized to granted', async () => {
		const conn = makeMockConn({
			'AccountShare:001A': 'throw:DUPLICATE_VALUE: duplicate row',
		});
		const out = await grantRecordAccess(conn, [
			{ objectName: 'Account', recordId: '001A' },
		], '005me');
		assert.equal(out.granted.length, 1);
		assert.equal(out.granted[0].alreadyShared, true);
		assert.equal(out.failed.length, 0);
	});

	test('"below organization levels" is normalized to granted with coveredByOWD', async () => {




		const conn = makeMockConn({
			'AccountShare:001A':
				'fail:(Account, Opportunity, Case Levels, Con Levels (Edit, None, None, Edit) ' +
				'are below organization levels (Edit, Edit, ReadEditTransfer, ControlledByParent))',
		});
		const out = await grantRecordAccess(conn, [
			{ objectName: 'Account', recordId: '001A' },
		], '005me');
		assert.equal(out.granted.length, 1);
		assert.equal(out.granted[0].coveredByOWD, true,
			'OWD-coverage rejections should report as granted (recipient HAS access)');
		assert.equal(out.granted[0].alreadyShared, undefined,
			'OWD-coverage is distinct from already-shared — different flag');
		assert.equal(out.failed.length, 0);
	});

	test('thrown "below organization level" error is also normalized to coveredByOWD', async () => {
		const conn = makeMockConn({
			'AccountShare:001A': 'throw:Account, Opportunity Levels are below organization levels',
		});
		const out = await grantRecordAccess(conn, [
			{ objectName: 'Account', recordId: '001A' },
		], '005me');
		assert.equal(out.granted.length, 1);
		assert.equal(out.granted[0].coveredByOWD, true);
		assert.equal(out.failed.length, 0);
	});

	test('items missing objectName/recordId go straight to failed', async () => {
		const conn = makeMockConn({});
		const out = await grantRecordAccess(conn, [
			{ recordId: '001A' },
			{ objectName: 'Account' },
			{ objectName: 'Account', recordId: '001B' },
		], '005me');
		assert.equal(out.granted.length, 1);
		assert.equal(out.failed.length, 2);

		assert.equal(conn.calls.length, 1);
	});

	test('empty array → no calls, empty result', async () => {
		const conn = makeMockConn({});
		const out = await grantRecordAccess(conn, [], '005me');
		assert.deepEqual(out, { granted: [], failed: [] });
		assert.equal(conn.calls.length, 0);
	});

	test('throws when recipient SF user id missing', async () => {
		const conn = makeMockConn({});
		await assert.rejects(
			grantRecordAccess(conn, [{ objectName: 'Account', recordId: '001A' }], ''),
			/recipientSfUserId is required/,
		);
	});

	test('routes custom-object inserts to the namespaced share table', async () => {
		const conn = makeMockConn({});
		await grantRecordAccess(conn, [
			{ objectName: 'orgloom__Canvas__c', recordId: 'a01ABC' },
			{ objectName: 'My_Custom__c', recordId: 'a02DEF' },
		], '005me');
		assert.equal(conn.calls[0].shareTable, 'orgloom__Canvas__Share');
		assert.equal(conn.calls[1].shareTable, 'My_Custom__Share');
	});
});

describe('_classifyShareError — error-string buckets', () => {
	test('DUPLICATE_VALUE classifies as duplicate', () => {
		assert.equal(_classifyShareError('DUPLICATE_VALUE: duplicate row'), 'duplicate');
		assert.equal(_classifyShareError('User already shared on this record'), 'duplicate');
	});
	test('"below organization levels" classifies as covered-by-owd', () => {
		assert.equal(
			_classifyShareError('Levels (Edit, None, None) are below organization levels (Edit, Edit, ReadEditTransfer)'),
			'covered-by-owd',
		);

		assert.equal(
			_classifyShareError('AccessLevel below organization level'),
			'covered-by-owd',
		);
	});
	test('INSUFFICIENT_ACCESS_OR_READONLY classifies as fatal', () => {
		assert.equal(
			_classifyShareError('INSUFFICIENT_ACCESS_OR_READONLY: insufficient access rights on cross-reference id'),
			'fatal',
		);
	});
	test('empty / null inputs classify as fatal', () => {
		assert.equal(_classifyShareError(''), 'fatal');
		assert.equal(_classifyShareError(null), 'fatal');
		assert.equal(_classifyShareError(undefined), 'fatal');
	});
	test('unknown messages classify as fatal', () => {
		assert.equal(_classifyShareError('something else entirely'), 'fatal');
	});
});
