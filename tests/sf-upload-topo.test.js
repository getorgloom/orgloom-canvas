import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
	topoSortRecords,
	existingRecordIdsByTempId,
	isSafeGraphFallbackFailure,
	groupConnectedComponents,
	graphRefIdFor,
	buildGraphSubRequest,
	normalizeValuesForUpload,
	normalizeTimeFieldsForSalesforce,
	normalizeGeolocationFieldsForSalesforce,
	normalizeRichTextFieldsForSalesforce,
	changedValuesForUpdate,
	summarizeGraphPayloadForDiagnostics,
	GRAPH_PER_GRAPH_CAP,
	GRAPH_TOTAL_NODES_CAP,
} from '../src/sf-upload.js';

function rec(tempId, objectName = 'X') {
	return { tempId, objectName, values: {} };
}
function fk(fromId, toId, fieldName = 'ParentId') {
	return { fromId, toId, fieldName };
}

describe('topoSortRecords', () => {
	test('linear chain child→parent appears parent-first', () => {
		const records = [rec(1), rec(2), rec(3)];
		const associations = [fk(3, 2), fk(2, 1)];
		const { order, cycleIds } = topoSortRecords(records, associations);
		assert.equal(cycleIds.size, 0);
		const pos = new Map(order.map((id, i) => [id, i]));
		for (const a of associations) {
			assert.ok(pos.get(a.toId) < pos.get(a.fromId), `parent ${a.toId} must appear before child ${a.fromId}`);
		}
		assert.equal(order.length, 3);
	});

	test('two parents one child: both parents come first', () => {
		const records = [rec(1), rec(2), rec(3)];
		const associations = [fk(3, 1), fk(3, 2)];
		const { order } = topoSortRecords(records, associations);
		const pos = new Map(order.map((id, i) => [id, i]));
		assert.ok(pos.get(1) < pos.get(3));
		assert.ok(pos.get(2) < pos.get(3));
	});

	test('records with no associations are emitted in some order, all present', () => {
		const records = [rec(1), rec(2), rec(3)];
		const { order, cycleIds } = topoSortRecords(records, []);
		assert.equal(cycleIds.size, 0);
		assert.deepEqual([...order].sort(), [1, 2, 3]);
	});

	test('circular FK reference is detected via cycleIds', () => {
		const records = [rec(1), rec(2), rec(3)];
		const associations = [fk(1, 2), fk(2, 3), fk(3, 1)];
		const { order, cycleIds } = topoSortRecords(records, associations);
		assert.equal(cycleIds.size, 3);
		assert.ok(cycleIds.has(1));
		assert.ok(cycleIds.has(2));
		assert.ok(cycleIds.has(3));
		assert.equal(order.length, 3);
	});

	test('existing-record IDs break an otherwise circular draft relationship', () => {
		const existingAccount = {
			...rec(1, 'Account'),
			loadedFromId: '001000000000001AAA',
		};
		const newContact = rec(2, 'Contact');
		const { order, cycleIds, deps } = topoSortRecords(
			[existingAccount, newContact],
			[fk(1, 2, 'PrimaryContact__c'), fk(2, 1, 'AccountId')],
		);

		assert.equal(cycleIds.size, 0);
		assert.deepEqual(order, [2, 1]);
		assert.deepEqual([...deps.get(2)], []);
		assert.deepEqual([...deps.get(1)], [2]);
	});

	test('associations pointing at missing ids are ignored (no crash, no error)', () => {
		const records = [rec(1), rec(2)];
		const associations = [fk(2, 1), fk(2, 99), fk(99, 1)];
		const { order, cycleIds } = topoSortRecords(records, associations);
		assert.equal(cycleIds.size, 0);
		assert.equal(order.length, 2);
		const pos = new Map(order.map((id, i) => [id, i]));
		assert.ok(pos.get(1) < pos.get(2));
	});

	test('null/undefined association entries are ignored', () => {
		const records = [rec(1), rec(2)];
		const associations = [null, undefined, fk(2, 1)];
		const { order } = topoSortRecords(records, associations);
		const pos = new Map(order.map((id, i) => [id, i]));
		assert.ok(pos.get(1) < pos.get(2));
	});
});

describe('existing Salesforce relationship targets', () => {
	test('pre-seeds every loaded record ID for REST relationship normalization', () => {
		assert.deepEqual(
			[
				...existingRecordIdsByTempId([
					{ tempId: 1, loadedFromId: '001000000000001AAA' },
					{ tempId: 2 },
					{ tempId: 3, loadedFromId: '003000000000003AAA' },
				]),
			],
			[
				[1, '001000000000001AAA'],
				[3, '003000000000003AAA'],
			],
		);
	});
});

describe('Composite Graph fallback classification', () => {
	test('retries parser and Graph operation-type limits through a non-Graph uploader', () => {
		assert.equal(isSafeGraphFallbackFailure({ success: false, errorCode: 'JSON_PARSER_ERROR' }), true);
		assert.equal(
			isSafeGraphFallbackFailure({
				success: false,
				errorCode: 'PROCESSING_HALTED',
				error: 'Limit of number of types of operations in a Graph call reached.',
			}),
			true,
		);
	});

	test('does not retry ordinary validation or generic rollback failures', () => {
		assert.equal(
			isSafeGraphFallbackFailure({
				success: false,
				errorCode: 'REQUIRED_FIELD_MISSING',
				error: 'Required fields are missing',
			}),
			false,
		);
		assert.equal(
			isSafeGraphFallbackFailure({
				success: false,
				errorCode: 'PROCESSING_HALTED',
				error: 'The transaction was rolled back since another operation failed.',
			}),
			false,
		);
	});
});

describe('groupConnectedComponents', () => {
	test('two FK-related records form one component', () => {
		const submittedIds = new Set([1, 2]);
		const order = [1, 2];
		const components = groupConnectedComponents(submittedIds, order, [fk(2, 1)]);
		assert.equal(components.length, 1);
		assert.deepEqual(components[0], [1, 2]);
	});

	test('two FK-unrelated records form two components', () => {
		const submittedIds = new Set([1, 2]);
		const components = groupConnectedComponents(submittedIds, [1, 2], []);
		assert.equal(components.length, 2);
		assert.deepEqual(
			components.map((c) => c.length),
			[1, 1],
		);
	});

	test('three records, two linked + one alone → two components', () => {
		const submittedIds = new Set([1, 2, 3]);
		const components = groupConnectedComponents(submittedIds, [1, 2, 3], [fk(2, 1)]);
		const sizes = components.map((c) => c.length).sort();
		assert.deepEqual(sizes, [1, 2]);
		const big = components.find((c) => c.length === 2);
		const small = components.find((c) => c.length === 1);
		assert.deepEqual(big, [1, 2]);
		assert.deepEqual(small, [3]);
	});

	test('chain spanning multiple FKs forms one component', () => {
		const submittedIds = new Set([1, 2, 3, 4]);
		const order = [1, 2, 3, 4];
		const components = groupConnectedComponents(submittedIds, order, [fk(2, 1), fk(3, 2), fk(4, 3)]);
		assert.equal(components.length, 1);
		assert.deepEqual(components[0], [1, 2, 3, 4]);
	});

	test('records preserved in submittedOrder within each component', () => {
		const submittedIds = new Set([10, 20, 30]);
		const order = [10, 20, 30]; // topo order
		const components = groupConnectedComponents(submittedIds, order, [fk(20, 10), fk(30, 10)]);
		assert.equal(components.length, 1);
		assert.deepEqual(components[0], [10, 20, 30]);
	});

	test('associations referencing ids not in submittedIds are ignored', () => {
		const submittedIds = new Set([1, 2]);
		const components = groupConnectedComponents(
			submittedIds,
			[1, 2],
			[
				fk(2, 1),
				fk(1, 99), // 99 not submitted; must NOT pull 1 into a cross-graph component
			],
		);
		assert.equal(components.length, 1);
		assert.deepEqual(components[0], [1, 2]);
	});
});

describe('graph caps (contract values)', () => {
	test('per-graph cap is 75', () => {
		assert.equal(GRAPH_PER_GRAPH_CAP, 75, 'caller relies on this exact value');
	});

	test('total nodes cap is 500', () => {
		assert.equal(GRAPH_TOTAL_NODES_CAP, 500);
	});
});

describe('graphRefIdFor', () => {
	test('prefixes with r and strips non-alphanumeric chars', () => {
		assert.equal(graphRefIdFor(42), 'r42');
		assert.equal(graphRefIdFor('foo-bar'), 'rfoo_bar');
		assert.equal(graphRefIdFor('a.b/c d'), 'ra_b_c_d');
	});
});

describe('buildGraphSubRequest', () => {
	test('requires Salesforce field metadata instead of uploading raw canvas values', () => {
		assert.throws(
			() =>
				buildGraphSubRequest({
					rec: { tempId: 1, objectName: 'Account', values: { Name: 'Acme' } },
					tempId: 1,
					apiBase: '/services/data/v60.0',
					associations: [],
					submittedIds: new Set([1]),
					recordsById: new Map(),
					describesByObject: new Map(),
				}),
			(error) => error && error.code === 'salesforce-field-metadata-unavailable',
		);
	});

	test('sends only fields Salesforce marks writable', () => {
		const record = {
			tempId: 1,
			objectName: 'Account',
			values: {
				Name: 'Acme',
				BillingAddress: { city: 'Phoenix' },
				_internalCollaborationState: { assigned: true },
			},
		};
		const request = buildGraphSubRequest({
			rec: record,
			tempId: 1,
			apiBase: '/services/data/v60.0',
			associations: [],
			submittedIds: new Set([1]),
			recordsById: new Map([[1, record]]),
			describesByObject: new Map([
				[
					'Account',
					{
						fields: [
							{ name: 'Name', createable: true, updateable: true },
							{ name: 'BillingAddress', createable: false, updateable: false },
						],
					},
				],
			]),
		});

		assert.deepEqual(request.body, { Name: 'Acme' });
	});

	test('PATCH sends only fields changed on the canvas', () => {
		const record = {
			tempId: 1,
			objectName: 'Account',
			loadedFromId: '001000000000001AAA',
			values: { Name: 'Acme', Phone: '555-2222', Industry: 'Technology' },
			loadedValues: { Name: 'Acme', Phone: '555-1111', Industry: 'Technology' },
		};
		const request = buildGraphSubRequest({
			rec: record,
			tempId: 1,
			apiBase: '/services/data/v60.0',
			associations: [],
			submittedIds: new Set([1]),
			recordsById: new Map([[1, record]]),
			describesByObject: new Map([
				[
					'Account',
					{
						fields: [
							{ name: 'Name', updateable: true },
							{ name: 'Phone', updateable: true },
							{ name: 'Industry', updateable: true },
						],
					},
				],
			]),
		});

		assert.equal(request.method, 'PATCH');
		assert.deepEqual(request.body, { Phone: '555-2222' });
	});

	test('PATCH sends a changed RecordTypeId', () => {
		const record = {
			tempId: 1,
			objectName: 'Account',
			loadedFromId: '001000000000001AAA',
			values: { Name: 'Acme', RecordTypeId: '012000000000002AAA' },
			loadedValues: { Name: 'Acme', RecordTypeId: '012000000000001AAA' },
		};
		const request = buildGraphSubRequest({
			rec: record,
			tempId: 1,
			apiBase: '/services/data/v60.0',
			associations: [],
			submittedIds: new Set([1]),
			recordsById: new Map([[1, record]]),
			describesByObject: new Map([
				[
					'Account',
					{
						fields: [
							{ name: 'Name', updateable: true },
							{ name: 'RecordTypeId', updateable: true },
						],
					},
				],
			]),
		});

		assert.deepEqual(request.body, { RecordTypeId: '012000000000002AAA' });
	});

	test('serializes Time fields without applying a timezone offset', () => {
		const record = {
			tempId: 1,
			objectName: 'Account',
			values: { Name: 'Acme', Test_Time__c: '13:45' },
		};
		const describe = {
			fields: [
				{ name: 'Name', type: 'string', createable: true },
				{ name: 'Test_Time__c', type: 'time', createable: true },
			],
		};
		const request = buildGraphSubRequest({
			rec: record,
			tempId: 1,
			apiBase: '/services/data/v60.0',
			associations: [],
			submittedIds: new Set([1]),
			recordsById: new Map([[1, record]]),
			describesByObject: new Map([['Account', describe]]),
		});

		assert.equal(request.body.Test_Time__c, '13:45:00.000Z');
		assert.deepEqual(normalizeTimeFieldsForSalesforce({ Test_Time__c: '01:30:45.5Z' }, describe), {
			Test_Time__c: '01:30:45.500Z',
		});
	});

	test('serializes plain rich text literally as safe Salesforce HTML', () => {
		const describe = {
			fields: [
				{ name: 'Rich_Text__c', type: 'textarea', htmlFormatted: true, createable: true },
				{ name: 'Long_Text__c', type: 'textarea', htmlFormatted: false, createable: true },
			],
		};
		const values = normalizeRichTextFieldsForSalesforce(
			{
				Rich_Text__c: 'First &nbsp; & second line\r\n2 < 3\n<b>not bold</b>',
				Long_Text__c: 'First line\nSecond line',
			},
			describe,
		);

		assert.equal(
			values.Rich_Text__c,
			'First &amp;nbsp; &amp; second line<br>2 &lt; 3<br>&lt;b&gt;not bold&lt;/b&gt;',
		);
		assert.equal(values.Long_Text__c, 'First line\nSecond line');
		assert.equal(
			normalizeRichTextFieldsForSalesforce({ Rich_Text__c: '&amp;nbsp;' }, describe).Rich_Text__c,
			'&amp;amp;nbsp;',
		);
	});

	test('truncates geolocation components to Salesforce decimal scale', () => {
		const describe = {
			fields: [
				{ name: 'Site__c', type: 'location' },
				{
					name: 'Site__Latitude__s',
					type: 'double',
					compoundFieldName: 'Site__c',
					scale: 6,
				},
				{
					name: 'Site__Longitude__s',
					type: 'double',
					compoundFieldName: 'Site__c',
					scale: 6,
				},
				{ name: 'Unrelated__c', type: 'double', scale: 2 },
			],
		};
		assert.deepEqual(
			normalizeGeolocationFieldsForSalesforce(
				{
					Site__Latitude__s: '33.448376987',
					Site__Longitude__s: '-112.074037999',
					Unrelated__c: '12.999',
				},
				describe,
			),
			{
				Site__Latitude__s: '33.448376',
				Site__Longitude__s: '-112.074037',
				Unrelated__c: '12.999',
			},
		);
	});
});

describe('existing-record upload patches', () => {
	test('includes a changed external lookup key and omits an unchanged one', () => {
		assert.deepEqual(
			changedValuesForUpdate({
				values: { Name: 'Updated', Order__c: 'ORDER-2048', Stable_Order__c: 'ORDER-1025' },
				loadedValues: { Name: 'Original', Order__c: 'ORDER-1025', Stable_Order__c: 'ORDER-1025' },
			}),
			{ Name: 'Updated', Order__c: 'ORDER-2048' },
		);
	});

	test('preserves explicit clears but omits untouched values', () => {
		assert.deepEqual(
			changedValuesForUpdate({
				values: { Name: 'Acme', Phone: '', TestCurr__c: null, Employees: 25 },
				loadedValues: { Name: 'Acme', Phone: '555-1111', TestCurr__c: 125, Employees: '25' },
			}),
			{ Phone: '', TestCurr__c: null },
		);
	});

	test('preserves an explicit encrypted-field clear when its baseline is intentionally absent', () => {
		assert.deepEqual(
			changedValuesForUpdate({
				values: { Secret__c: null },
				loadedValues: {},
				explicitFields: ['Secret__c'],
			}),
			{ Secret__c: null },
		);
	});

	test('falls back to the supplied fields when no baseline exists', () => {
		assert.deepEqual(changedValuesForUpdate({ values: { Name: 'Acme', Phone: '555-1111' } }), {
			Name: 'Acme',
			Phone: '555-1111',
		});
	});

	test('REST normalization sends only the changed field and an intentionally changed relationship', () => {
		const rec = {
			loadedFromId: '001000000000001AAA',
			values: { Name: 'Acme', Phone: '555-2222', OwnerId: '005000000000001AAA' },
			loadedValues: { Name: 'Acme', Phone: '555-1111', OwnerId: '005000000000001AAA' },
		};
		const values = normalizeValuesForUpload(
			rec,
			1,
			[
				{ fromId: 1, toId: 2, fieldName: 'OwnerId' },
				{ fromId: 1, toId: 3, fieldName: 'ParentId' },
			],
			new Map([
				[2, '005000000000001AAA'],
				[3, '001000000000999AAA'],
			]),
		);
		assert.deepEqual(values, { Phone: '555-2222', ParentId: '001000000000999AAA' });
	});
});

describe('summarizeGraphPayloadForDiagnostics', () => {
	test('records request shape without retaining Salesforce values', () => {
		const payload = [
			{
				graphId: 'g0',
				compositeRequest: [
					{
						method: 'POST',
						url: '/services/data/v67.0/sobjects/Account',
						referenceId: 'r1',
						body: {
							Name: 'Private customer name',
							Description: 'line one\n{"sample":true}',
							Notes__c: '{"broken":}',
							BillingAddress: { city: 'Phoenix', state: 'AZ' },
							Active__c: true,
						},
					},
				],
			},
		];

		const summary = summarizeGraphPayloadForDiagnostics(payload);
		assert.equal(summary[0].graphId, 'g0');
		assert.equal(summary[0].requests[0].objectName, 'Account');
		assert.deepEqual(summary[0].requests[0].fieldNames, [
			'Name',
			'Description',
			'Notes__c',
			'BillingAddress',
			'Active__c',
		]);
		assert.deepEqual(summary[0].requests[0].nonNullFields[0], {
			name: 'Name',
			type: 'string',
			length: 21,
			hasControl: undefined,
			hasNewline: undefined,
			hasQuote: undefined,
			hasBackslash: undefined,
			looksStructured: undefined,
			structuredJsonValid: undefined,
		});
		assert.equal(summary[0].requests[0].nonNullFields[1].hasNewline, true);
		assert.equal(summary[0].requests[0].nonNullFields[2].structuredJsonValid, false);
		assert.equal(summary[0].requests[0].nonNullFields[3].type, 'object');
		assert.deepEqual(summary[0].requests[0].nonNullFields[3].keys, ['city', 'state']);
		assert.equal(JSON.stringify(summary).includes('Private customer name'), false);
		assert.equal(JSON.stringify(summary).includes('Phoenix'), false);
	});
});
