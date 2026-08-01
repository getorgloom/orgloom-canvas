import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { initTestDb } from './helpers/db.js';
import { ext } from '../src/extensions.js';

let server;
let baseUrl;
let previousAccountResolver;
const requestedUrls = [];

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
				request: async (url) => {
					requestedUrls.push(url);
					if (url.includes('/ui-api/record-ui/') && url.includes('modes=Edit')) {
						throw new Error('Edit layout unavailable');
					}
					if (url.includes('/ui-api/record-ui/') && url.includes('modes=View')) {
						return {
							layouts: {
								Account: {
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
		requestedUrls.at(-1),
		'/services/data/v60.0/ui-api/layout/Account/Full/View?recordTypeId=012000000000001AAA',
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
		picklistValues: {},
	});
});

test('read-only shared drafts fall back to the recipient create layout when View is unavailable', async () => {
	const response = await fetch(baseUrl + '/api/objects/Fallback__c/layout?mode=View&recordTypeId=012000000000001AAA');
	assert.equal(response.status, 200);
	assert.deepEqual(requestedUrls.slice(-2), [
		'/services/data/v60.0/ui-api/layout/Fallback__c/Full/View?recordTypeId=012000000000001AAA',
		'/services/data/v60.0/ui-api/record-defaults/create/Fallback__c?recordTypeIds=012000000000001AAA',
	]);
	const body = await response.json();
	assert.equal(body.available, true);
	assert.equal(body.sections[0].heading, 'Account Information');
});

test('existing records fall back from Edit to View layout for read-only Salesforce users', async () => {
	const recordId = '001000000000001AAA';
	const response = await fetch(baseUrl + '/api/objects/Account/layout?recordId=' + recordId);
	assert.equal(response.status, 200);
	assert.deepEqual(requestedUrls.slice(-2), [
		'/services/data/v60.0/ui-api/record-ui/' + recordId + '?layoutTypes=Full&modes=Edit',
		'/services/data/v60.0/ui-api/record-ui/' + recordId + '?layoutTypes=Full&modes=View',
	]);
	const body = await response.json();
	assert.equal(body.available, true);
	assert.equal(body.sections[0].heading, 'Account Information');
});
