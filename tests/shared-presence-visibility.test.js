import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSharedPresenceVisibility } from '../src/canvas-routes.js';

test('shared presence visibility is fail-closed for inaccessible objects and records', async () => {
	const conn = {
		version: '60.0',
		sobject(objectName) {
			return {
				async describe() {
					if (objectName === 'Account') {
						throw Object.assign(new Error('not available'), { errorCode: 'NOT_FOUND' });
					}
					return {
						name: objectName,
						label: objectName,
						queryable: true,
						fields: [
							{ name: 'Id', type: 'id', createable: false, updateable: false },
							{ name: 'Name', type: 'string', createable: true, updateable: true },
							{ name: 'Secret__c', type: 'encryptedstring', createable: true, updateable: true },
							{ name: 'AccountId', type: 'reference', createable: true, updateable: true },
						],
						recordTypeInfos: [],
					};
				},
			};
		},
		async request(request) {
			if (typeof request === 'string') {
				throw new Error('UI API unavailable in test');
			}
			return { records: [{ Id: '003000000000001AAA' }] };
		},
	};
	const visibility = await buildSharedPresenceVisibility(conn, {
		loadedRecords: [
			{
				objectName: 'Contact',
				loadedFromId: '003000000000001AAA',
				slot: { slotId: 'contact-slot' },
			},
			{
				objectName: 'Account',
				loadedFromId: '001000000000001AAA',
				slot: { slotId: 'account-slot' },
			},
		],
		drafts: [{ objectName: 'Opportunity', tempId: 'draft-1', slot: { slotId: 'draft-slot' } }],
	});

	assert.deepEqual(Object.keys(visibility.loadedRecords), ['003000000000001']);
	assert.equal(visibility.slots['contact-slot'].visible, true);
	assert.equal(visibility.slots['account-slot'].visible, false);
	assert.equal(visibility.slots['draft-slot'].visible, true);
	assert.equal(visibility.drafts['draft-1'].visible, true);
	assert.deepEqual(visibility.loadedRecords['003000000000001'].encryptedFields, ['Secret__c']);
	assert.deepEqual(visibility.drafts['draft-1'].encryptedFields, ['Secret__c']);
	assert.equal(visibility.objects.Account.visible, false);
	assert.equal(visibility.objects.Opportunity.visible, true);
});
