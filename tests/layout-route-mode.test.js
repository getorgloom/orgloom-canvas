import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { initTestDb } from './helpers/db.js';
import { ext } from '../src/extensions.js';

let server;
let baseUrl;
let previousAccountResolver;
const requestedUrls = [];
const requestedSoql = [];

before(async () => {
	await initTestDb();
	previousAccountResolver = ext.getCurrentAccount;
	ext.registerAuthProvider(async () => ({ id: 'acc_layout', email: 'layout@example.com' }));

	const app = express();
	app.use(express.json());
	app.use((req, _res, next) => {
		req.session = {};
		req.sf = {
			conn: {
				version: '60.0',
				query: async (soql) => {
					requestedSoql.push(soql);
					return {
						records: [
							{
								RecordId: '001000000000001AAA',
								HasReadAccess: true,
								HasEditAccess: false,
								HasDeleteAccess: false,
							},
						],
					};
				},
				request: async (url) => {
					requestedUrls.push(url);
					if (url.includes('/ui-api/object-info/') && url.includes('/picklist-values/')) {
						return {
							picklistFieldValues: {
								Status__c: {
									values: [{ label: 'Target option', value: 'Target' }],
									defaultValue: null,
								},
							},
						};
					}
					if (url.includes('/ui-api/record-defaults/create/Contact')) {
						return {
							layout: {
								columns: 2,
								sections: [
									{
										heading: 'Contact Information',
										layoutRows: [
											{
												layoutItems: [
													{
														label: 'Name',
														layoutComponents: [
															{ componentType: 'Field', apiName: 'Salutation' },
															{ componentType: 'Field', apiName: 'FirstName' },
															{ componentType: 'Field', apiName: 'LastName' },
														],
													},
												],
											},
										],
									},
								],
							},
						};
					}
					if (url.includes('/ui-api/record-ui/') && url.includes('modes=Edit')) {
						throw new Error('Edit layout unavailable');
					}
					if (url.includes('/ui-api/record-ui/') && url.includes('modes=View')) {
						const recordId = '001000000000001AAA';
						return {
							layouts: {
								Account: {
									'012000000000000AAA': {
										Full: {
											View: {
												columns: 2,
												sections: [
													{
														heading: 'Wrong default layout',
														layoutRows: [],
													},
												],
											},
										},
									},
									'012000000000001AAA': {
										Full: {
											View: {
												columns: 2,
												sections: [
													{
														heading: 'Account Information',
														layoutRows: [
															{
																layoutItems: [
																	{
																		label: 'Account Name',
																		layoutComponents: [
																			{ componentType: 'Field', apiName: 'Name' },
																		],
																	},
																],
															},
														],
													},
												],
											},
										},
									},
								},
							},
							records: {
								[recordId]: {
									recordTypeId: '012000000000001AAA',
									fields: {
										RecordTypeId: { value: '012000000000001AAA' },
									},
								},
							},
						};
					}
					if (url.includes('/ui-api/layout/Fallback__c/Full/View')) {
						throw new Error('View layout unavailable');
					}
					return {
						columns: 2,
						sections: [
							{
								heading: 'Account Information',
								columns: 2,
								layoutRows: [
									{
										layoutItems: [
											{
												label: 'Account Name',
												layoutComponents: [{ componentType: 'Field', apiName: 'Name' }],
											},
										],
									},
								],
							},
						],
					};
				},
			},
			sfOrgId: '00D000000000001AAA',
			sfUserId: '005000000000001AAA',
		};
		next();
	});

	const { mountCanvasRoutes } = await import('../src/canvas-routes.js');
	mountCanvasRoutes(app);
	ext.flush(app);

	server = await new Promise((resolve) => {
		const listening = app.listen(0, () => resolve(listening));
	});
	baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
	ext.registerAuthProvider(previousAccountResolver);
	if (server) {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('read-only shared drafts request the recipient Salesforce view layout', async () => {
	const response = await fetch(baseUrl + '/api/objects/Account/layout?mode=View&recordTypeId=012000000000001AAA');
	assert.equal(response.status, 200);
	assert.equal(
		requestedUrls.at(-2),
		'/services/data/v60.0/ui-api/layout/Account/Full/View?recordTypeId=012000000000001AAA',
	);
	assert.equal(
		requestedUrls.at(-1),
		'/services/data/v60.0/ui-api/object-info/Account/picklist-values/012000000000001AAA',
	);
	assert.deepEqual(await response.json(), {
		sections: [
			{
				heading: 'Account Information',
				columns: 2,
				collapsible: false,
				rows: [
					[
						{
							apiName: 'Name',
							label: 'Account Name',
							required: false,
							editableForNew: true,
							editableForUpdate: true,
						},
					],
				],
			},
		],
		available: true,
		recordTypeId: '012000000000001AAA',
		columns: 2,
		defaults: {},
		fieldPerms: {},
		picklistValues: {
			Status__c: {
				controllerValues: null,
				defaultValue: null,
				values: [{ label: 'Target option', value: 'Target', validFor: [] }],
			},
		},
		picklistValuesRecordTypeId: '012000000000001AAA',
	});
});

test('compound layout items retain every Salesforce field component', async () => {
	const response = await fetch(baseUrl + '/api/objects/Contact/layout');
	assert.equal(response.status, 200);
	const body = await response.json();
	assert.deepEqual(body.sections[0].rows[0][0], {
		apiName: 'Salutation',
		apiNames: ['Salutation', 'FirstName', 'LastName'],
		label: 'Name',
		required: false,
		editableForNew: true,
		editableForUpdate: true,
	});
});

test('read-only shared drafts fall back to the recipient create layout when View is unavailable', async () => {
	const response = await fetch(baseUrl + '/api/objects/Fallback__c/layout?mode=View&recordTypeId=012000000000001AAA');
	assert.equal(response.status, 200);
	assert.deepEqual(requestedUrls.slice(-3), [
		'/services/data/v60.0/ui-api/layout/Fallback__c/Full/View?recordTypeId=012000000000001AAA',
		'/services/data/v60.0/ui-api/record-defaults/create/Fallback__c?recordTypeIds=012000000000001AAA',
		'/services/data/v60.0/ui-api/object-info/Fallback__c/picklist-values/012000000000001AAA',
	]);
	const body = await response.json();
	assert.equal(body.available, true);
	assert.equal(body.sections[0].heading, 'Account Information');
});

test('existing records fall back from Edit to View layout for read-only Salesforce users', async () => {
	const recordId = '001000000000001AAA';
	const response = await fetch(
		baseUrl + '/api/objects/Account/layout?recordId=' + recordId + '&recordTypeId=012000000000000AAA',
	);
	assert.equal(response.status, 200);
	assert.deepEqual(requestedUrls.slice(-3), [
		'/services/data/v60.0/ui-api/record-ui/' + recordId + '?layoutTypes=Full&modes=Edit',
		'/services/data/v60.0/ui-api/record-ui/' + recordId + '?layoutTypes=Full&modes=View',
		'/services/data/v60.0/ui-api/object-info/Account/picklist-values/012000000000000AAA',
	]);
	const body = await response.json();
	assert.equal(body.available, true);
	assert.equal(body.sections[0].heading, 'Account Information');
	assert.equal(body.recordTypeId, '012000000000001AAA');
	assert.deepEqual(body.recordAccess, {
		checked: true,
		hasReadAccess: true,
		hasEditAccess: false,
		hasDeleteAccess: false,
	});
	assert.deepEqual(body.picklistValues.Status__c.values, [{ label: 'Target option', value: 'Target', validFor: [] }]);
	assert.equal(body.picklistValuesRecordTypeId, '012000000000000AAA');
});

test('record access endpoint returns current-user sharing access without exposing other records', async () => {
	const response = await fetch(baseUrl + '/api/records/access', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ records: [{ tempId: 7, sfId: '001000000000001AAA' }] }),
	});
	assert.equal(response.status, 200);
	const body = await response.json();
	assert.deepEqual(body.results, [
		{
			tempId: 7,
			sfId: '001000000000001AAA',
			access: {
				checked: true,
				hasReadAccess: true,
				hasEditAccess: false,
				hasDeleteAccess: false,
			},
		},
	]);
	assert.match(requestedSoql.at(-1), /FROM UserRecordAccess/);
	assert.match(requestedSoql.at(-1), /UserId = '005000000000001AAA'/);
});
