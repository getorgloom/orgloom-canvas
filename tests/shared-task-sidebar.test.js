import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../src/public/js/shared-task-sidebar.js'), 'utf8');

function mount(records, { ownedByMe = false, role = 'contributor' } = {}) {
	const window = { OrgLoom: {}, SF_USER_ID: '005-me' };
	vm.runInNewContext(source, { window, setTimeout });
	const canvasState = {
		currentCanvas: { id: 'canvas-1', ownedByMe },
		bulkRecords: records,
	};
	return window.OrgLoom.sharedTaskSidebar.mount({
		canvasState,
		escapeHtml: String,
		getCanvasShareRole: () => (ownedByMe ? null : role),
		getCyInstance: () => null,
		openInsertModal: () => {},
		slotAssignmentState: (record) => {
			const assignee = record.slot.assigneeSfUserId;
			return !assignee ? 'generic' : assignee === window.SF_USER_ID ? 'mine' : 'other';
		},
		slotProgress: (record) => {
			if ((record.slot.kind || 'whole-record') === 'fields') {
				const fields = record.slot.fields || [];
				return {
					filled: fields.filter((field) => record.values[field] != null && record.values[field] !== '')
						.length,
					total: fields.length,
				};
			}
			return {
				filled: record.loadedFromId || Object.values(record.values || {}).some(Boolean) ? 1 : 0,
				total: 1,
			};
		},
	});
}

test('contributors see only their own and unassigned requests, grouped by record', () => {
	const api = mount([
		{
			id: 1,
			objectName: 'Account',
			label: 'Account',
			values: { Name: 'Acme', Phone: '', Website: 'https://example.com' },
			slot: {
				slotId: 'field-1',
				kind: 'fields',
				fields: ['Phone', 'Website'],
				description: 'Add the current customer phone number.',
				assigneeSfUserId: '005-me',
			},
			_recipientSlot: true,
		},
		{
			id: 2,
			objectName: 'Opportunity',
			label: 'Opportunity',
			values: {},
			slot: { slotId: 'record-1', kind: 'whole-record' },
			_recipientSlot: true,
		},
		{
			id: 3,
			objectName: 'Contact',
			label: 'Contact',
			values: {},
			slot: { slotId: 'record-2', assigneeSfUserId: '005-other' },
			_recipientSlot: true,
		},
	]);

	const tasks = api.buildTasks();
	assert.equal(tasks.length, 2);
	assert.equal(tasks[0].kindLabel, 'Fill in fields');
	assert.equal(tasks[0].title, 'Acme');
	assert.equal(tasks[0].instructions, 'Add the current customer phone number.');
	assert.equal(tasks[0].status, '1 of 2 fields complete');
	assert.equal(tasks[0].firstIncompleteField, 'Phone');
	assert.equal(tasks[1].kindLabel, 'Add a record');
	assert.equal(tasks[1].title, 'Opportunity');
});

test('viewers see assigned work but are told contributor access is required', () => {
	const api = mount(
		[
			{
				id: 1,
				objectName: 'Account',
				label: 'Account',
				values: { Name: 'Acme', Phone: '' },
				slot: {
					slotId: 'field-1',
					kind: 'fields',
					fields: ['Phone'],
					assigneeSfUserId: '005-me',
				},
				_recipientSlot: true,
			},
		],
		{ role: 'viewer' },
	);

	const [task] = api.buildTasks();
	assert.equal(task.status, 'Contributor access required');
	assert.equal(task.blocked, true);
});

test('a projected field request with no visible fields does not expose hidden field details', () => {
	const api = mount([
		{
			id: 1,
			objectName: 'Account',
			label: 'Account',
			values: { Name: 'Acme' },
			slot: {
				slotId: 'field-1',
				kind: 'fields',
				fields: [],
				assigneeSfUserId: '005-me',
			},
			_recipientSlot: true,
		},
	]);

	const [task] = api.buildTasks();
	assert.equal(task.title, 'Acme');
	assert.equal(task.status, 'No requested fields are available');
	assert.equal(task.firstIncompleteField, null);
	assert.equal(task.blocked, true);
});

test('an inaccessible request does not expose its configured title or object metadata', () => {
	const api = mount([
		{
			id: 1,
			objectName: 'Hidden_Object__c',
			label: 'Hidden Object',
			values: {},
			slot: {
				slotId: 'record-1',
				kind: 'whole-record',
				label: 'Create a Hidden Object',
				assigneeSfUserId: '005-me',
			},
			_recipientSlot: true,
			_inaccessible: true,
		},
	]);

	const [task] = api.buildTasks();
	assert.equal(task.kindLabel, 'Request');
	assert.equal(task.title, 'Unavailable');
	assert.equal(task.instructions, '');
	assert.equal(task.status, 'Blocked by Salesforce permissions');
	assert.equal(task.inaccessible, true);
});

test('owners see every request and completed tasks sort last', () => {
	const api = mount(
		[
			{
				id: 1,
				objectName: 'Contact',
				label: 'Contact',
				values: { LastName: 'Done' },
				slot: { slotId: 'done', kind: 'whole-record', assigneeSfUserId: '005-other' },
			},
			{
				id: 2,
				objectName: 'Opportunity',
				label: 'Opportunity',
				values: {},
				slot: { slotId: 'todo', kind: 'whole-record', assigneeSfUserId: '005-other' },
			},
		],
		{ ownedByMe: true },
	);

	const tasks = api.buildTasks();
	assert.equal(tasks.length, 2);
	assert.equal(tasks[0].recordId, 2);
	assert.equal(tasks[1].complete, true);
	assert.equal(tasks[1].assignee, 'Assigned teammate');
});
