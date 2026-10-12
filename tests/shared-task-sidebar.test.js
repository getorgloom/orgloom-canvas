import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../src/public/js/shared-task-sidebar.js'), 'utf8');

function mount(records, { ownedByMe = false, role = 'contributor', slotPreflightWarn = () => false } = {}) {
	const window = { OrgLoom: {}, SF_USER_ID: '005-me' };
	const openCalls = [];
	let hostHtml = '';
	let sections = null;
	const host = {
		hidden: true,
		dataset: {},
		classList: { toggle() {} },
		get innerHTML() {
			return hostHtml;
		},
		set innerHTML(value) {
			hostHtml = value;
			sections = value.includes('shared-task-sections') ? { scrollTop: 0 } : null;
		},
		querySelector(selector) {
			return selector === '.shared-task-sections' ? sections : null;
		},
		addEventListener() {},
	};
	const document = {
		getElementById: (id) => (id === 'shared-task-sidebar' ? host : null),
	};
	vm.runInNewContext(source, { window, document, setTimeout });
	const canvasState = {
		currentCanvas: { id: 'canvas-1', ownedByMe },
		bulkRecords: records,
	};
	const api = window.OrgLoom.sharedTaskSidebar.mount({
		canvasState,
		escapeHtml: String,
		getCanvasShareRole: () => (ownedByMe ? null : role),
		getCyInstance: () => null,
		openInsertModal: (...args) => openCalls.push(args),
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
		slotPreflightWarn,
	});
	api.host = host;
	api.openCalls = openCalls;
	return api;
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
	assert.equal(tasks[0].kindLabel, 'Add a record');
	assert.equal(tasks[0].title, 'Opportunity');
	assert.equal(tasks[1].kindLabel, 'Fill in fields');
	assert.equal(tasks[1].title, 'Acme');
	assert.equal(tasks[1].instructions, 'Add the current customer phone number.');
	assert.equal(tasks[1].status, '1 of 2 fields complete');
	assert.equal(tasks[1].firstIncompleteField, 'Phone');
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

test('permission-blocked requests retain safe context and open the read-only explanation', () => {
	const api = mount(
		[
			{
				id: 1,
				objectName: 'Account',
				label: 'Account',
				values: {},
				slot: { slotId: 'field-1', kind: 'fields', fields: ['Name'], assigneeSfUserId: '005-me' },
				_recipientSlot: true,
			},
		],
		{ role: 'editor', slotPreflightWarn: () => true },
	);
	const [task] = api.buildTasks();
	assert.equal(task.title, 'Account');
	assert.equal(task.status, 'Cannot complete with current Salesforce permissions');
	assert.equal(task.permissionBlocked, true);
	assert.equal(task.blocked, true);
	api.openTask(task);
	assert.equal(api.openCalls.length, 1);
	assert.equal(api.openCalls[0][0], 'Account');
	assert.equal(api.openCalls[0][1].record.id, 1);
});

test('owners see every request and completion does not change chronological order', () => {
	const api = mount(
		[
			{
				id: 1,
				objectName: 'Contact',
				label: 'Contact',
				values: { LastName: 'Done' },
				slot: {
					slotId: 'done',
					kind: 'whole-record',
					createdAt: 200,
					assigneeSfUserId: '005-other',
				},
			},
			{
				id: 2,
				objectName: 'Opportunity',
				label: 'Opportunity',
				values: {},
				slot: {
					slotId: 'todo',
					kind: 'whole-record',
					createdAt: 100,
					assigneeSfUserId: '005-other',
				},
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

test('tasks group record requests first and sort each group by creation, title, then request id', () => {
	const api = mount([
		{
			id: 1,
			objectName: 'Opportunity',
			label: 'Opportunity',
			values: {},
			slot: { slotId: 'record-b', kind: 'whole-record', createdAt: 200 },
			_recipientSlot: true,
		},
		{
			id: 2,
			objectName: 'Account',
			label: 'Account',
			values: {},
			slot: { slotId: 'record-a', kind: 'whole-record', createdAt: 100 },
			_recipientSlot: true,
		},
		{
			id: 3,
			objectName: 'Contact',
			label: 'Contact',
			values: { LastName: 'Zebra', Email: '' },
			slot: { slotId: 'field-z', kind: 'fields', fields: ['Email'], createdAt: 300 },
			_recipientSlot: true,
		},
		{
			id: 4,
			objectName: 'Contact',
			label: 'Contact',
			values: { LastName: 'Alpha', Email: '' },
			slot: { slotId: 'field-b', kind: 'fields', fields: ['Email'], createdAt: 300 },
			_recipientSlot: true,
		},
		{
			id: 5,
			objectName: 'Contact',
			label: 'Contact',
			values: { LastName: 'Alpha', Email: '' },
			slot: { slotId: 'field-a', kind: 'fields', fields: ['Email'], createdAt: 300 },
			_recipientSlot: true,
		},
	]);

	const tasks = api.buildTasks();
	assert.deepEqual(
		tasks.map((task) => task.slotId),
		['record-a', 'record-b', 'field-a', 'field-b', 'field-z'],
	);
});

test('renders separate record and field sections with remaining counts', () => {
	const api = mount([
		{
			id: 1,
			objectName: 'Opportunity',
			label: 'Opportunity',
			values: {},
			slot: { slotId: 'record-open', kind: 'whole-record', createdAt: 100 },
			_recipientSlot: true,
		},
		{
			id: 2,
			objectName: 'Account',
			label: 'Account',
			values: { Name: 'Complete' },
			slot: { slotId: 'record-complete', kind: 'whole-record', createdAt: 200 },
			_recipientSlot: true,
		},
		{
			id: 3,
			objectName: 'Contact',
			label: 'Contact',
			values: { LastName: 'Person', Email: '' },
			slot: { slotId: 'field-open', kind: 'fields', fields: ['Email'], createdAt: 300 },
			_recipientSlot: true,
		},
	]);

	assert.equal(api.render(), true);
	assert.match(api.host.innerHTML, /shared-task-section--records/);
	assert.match(api.host.innerHTML, /<h4>Add records<\/h4><span>1 remaining<\/span>/);
	assert.match(api.host.innerHTML, /shared-task-section--fields/);
	assert.match(api.host.innerHTML, /<h4>Fill in fields<\/h4><span>1 remaining<\/span>/);
	assert.match(api.host.innerHTML, /shared-task--complete shared-task--record[\s\S]*&#10003;/);
	assert.match(api.host.innerHTML, /shared-task--record[\s\S]*&#43;/);
});

test('keeps completed tasks available in a collapsed disclosure', () => {
	const api = mount([
		{
			id: 1,
			objectName: 'Contact',
			label: 'Contact',
			values: { LastName: 'Complete' },
			slot: { slotId: 'record-complete', kind: 'whole-record' },
			_recipientSlot: true,
		},
		{
			id: 2,
			objectName: 'Account',
			label: 'Account',
			values: { Name: 'Acme', Phone: '555-0100' },
			slot: { slotId: 'fields-complete', kind: 'fields', fields: ['Phone'] },
			_recipientSlot: true,
		},
	]);

	assert.equal(api.buildTasks().length, 2);
	assert.equal(api.render(), true);
	assert.equal(api.host.hidden, false);
	assert.match(api.host.innerHTML, /All 2 complete/);
	assert.match(api.host.innerHTML, /data-shared-task-toggle/);
	assert.match(api.host.innerHTML, /aria-expanded="false"/);
	assert.match(api.host.innerHTML, /shared-task-sections" id="shared-task-sections" hidden/);
	assert.match(api.host.innerHTML, /shared-task--complete/);
});

test('preserves task-list scroll position when the sidebar rerenders', () => {
	const api = mount([
		{
			id: 1,
			objectName: 'Contact',
			label: 'Contact',
			values: { LastName: 'Person', Email: '' },
			slot: { slotId: 'field-open', kind: 'fields', fields: ['Email'] },
			_recipientSlot: true,
		},
	]);

	assert.equal(api.render(), true);
	api.host.querySelector('.shared-task-sections').scrollTop = 180;
	assert.equal(api.render(), true);
	assert.equal(api.host.querySelector('.shared-task-sections').scrollTop, 180);
});
