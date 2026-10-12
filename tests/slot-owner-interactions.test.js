import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const slotUserSource = readFileSync(new URL('../src/public/js/slot-user.js', import.meta.url), 'utf8');
const recordsCanvasSource = readFileSync(new URL('../src/public/js/records-canvas.js', import.meta.url), 'utf8');

function mountSlotUser(currentCanvas, sfUserId = '005OWNER', shareRole = null) {
	const window = { OrgLoom: {}, SF_USER_ID: sfUserId };
	vm.runInNewContext(slotUserSource, { window, console, Map, Date, isFinite });
	return window.OrgLoom.slotUser.mount({
		canvasState: { currentCanvas, bulkRecords: [] },
		csrfFetch: async () => ({ ok: false }),
		escapeHtml: String,
		getCanvasShareRole: () => shareRole,
	});
}

const wholeRecordRequest = {
	slot: {
		slotId: 'record-request',
		kind: 'whole-record',
		origin: 'standalone',
		assigneeSfUserId: '005ASSIGNEE',
	},
};
const fieldRequest = {
	slot: { slotId: 'field-request', kind: 'fields', assigneeSfUserId: '005ASSIGNEE', fields: ['Name'] },
};

test('canvas owners ignore recipient assignment locks while standalone requests remain placeholders', () => {
	const api = mountSlotUser({ id: '069CANVAS', ownedByMe: true });
	for (const record of [wholeRecordRequest, fieldRequest]) {
		assert.equal(api._slotAssignmentState(record), 'other');
		assert.equal(api._isSlotLockedForCurrentUser(record), false);
		assert.equal(api._slotAssignmentCardClass(record), '');
	}
	assert.equal(api._isEmptySlot(wholeRecordRequest), true);
	assert.equal(api._isEmptySlot(fieldRequest), false);
});

test('recipient assignment locks still apply to the wrong teammate', () => {
	const api = mountSlotUser({ id: '069CANVAS', ownedByMe: false }, '005OWNER', 'contributor');
	assert.equal(api._isSlotLockedForCurrentUser(wholeRecordRequest), true);
	assert.equal(api._isSlotLockedForCurrentUser(fieldRequest), true);
	assert.equal(api._slotAssignmentCardClass(fieldRequest), ' record-card--slot-locked');

	const assignedApi = mountSlotUser({ id: '069CANVAS', ownedByMe: false }, '005ASSIGNEE', 'contributor');
	assert.equal(assignedApi._isSlotLockedForCurrentUser(fieldRequest), false);
});

test('editor access is not narrowed by a request assigned to another recipient', () => {
	const api = mountSlotUser({ id: '069CANVAS', ownedByMe: false }, '005EDITOR', 'editor');

	assert.equal(api._slotAssignmentState(fieldRequest), 'other');
	assert.equal(api._isSlotLockedForCurrentUser(wholeRecordRequest), false);
	assert.equal(api._isSlotLockedForCurrentUser(fieldRequest), false);
	assert.equal(api._slotAssignmentCardClass(fieldRequest), '');
});

test('request badges combine request size, assignee, and completion in one label', () => {
	const api = mountSlotUser({ id: '069CANVAS', ownedByMe: false }, '005ASSIGNEE', 'contributor');
	const mine = {
		values: {},
		slot: {
			slotId: 'field-request',
			kind: 'fields',
			fields: ['Name', 'Phone'],
			assigneeSfUserId: '005ASSIGNEE',
		},
	};
	assert.match(api._slotRequestBadgeHtml(mine), />2 fields for you<\/span>/);

	const other = {
		values: {},
		slot: {
			slotId: 'record-request',
			kind: 'whole-record',
			assigneeSfUserId: '005OTHER',
			assigneeName: 'Casey',
		},
	};
	assert.match(api._slotRequestBadgeHtml(other), />Record for Casey<\/span>/);

	const open = {
		values: {},
		slot: { slotId: 'open-request', kind: 'fields', fields: ['Name'] },
	};
	assert.match(api._slotRequestBadgeHtml(open), />1 field for any contributor<\/span>/);

	mine.values = { Name: 'Acme', Phone: '555-0100' };
	assert.match(api._slotRequestBadgeHtml(mine), />2 fields complete<\/span>/);
});

test('record-request controls and both double-click paths use the owner-aware lock', () => {
	assert.doesNotMatch(recordsCanvasSource, /_slotAssignmentState\(rec\) === 'other'/);
	assert.ok((recordsCanvasSource.match(/_isSlotLockedForCurrentUser\(rec\)/g) || []).length >= 3);
});

test('request permission checks distinguish readable objects from writable requests', () => {
	const api = mountSlotUser({ id: '069CANVAS', ownedByMe: false }, '005ASSIGNEE', 'editor');
	const accountRequest = {
		objectName: 'Account',
		values: {},
		slot: { slotId: 'record-request', kind: 'whole-record' },
		_recipientSlot: true,
	};
	api._slotDescribeAccessByObject.set('Account', {
		createable: false,
		updateable: false,
		fields: [{ name: 'CreatedById', createable: false, updateable: false }],
	});

	assert.match(api._slotPermissionBlockReason(accountRequest), /current Salesforce permissions/);
	assert.equal(api._slotPreflightWarn(accountRequest), true);

	api._slotDescribeAccessByObject.set('Account', {
		createable: true,
		updateable: true,
		fields: [{ name: 'Name', createable: true, updateable: true }],
	});
	assert.equal(api._slotPermissionBlockReason(accountRequest), null);
	assert.equal(api._slotPreflightWarn(accountRequest), false);
});

test('field requests need at least one requested field writable for the requested operation', () => {
	const api = mountSlotUser({ id: '069CANVAS', ownedByMe: false }, '005ASSIGNEE', 'contributor');
	const request = {
		objectName: 'Contact',
		loadedFromId: '003000000000001AAA',
		values: {},
		slot: { slotId: 'field-request', kind: 'fields', fields: ['Email', 'Phone'] },
		_recipientSlot: true,
	};
	api._slotDescribeAccessByObject.set('Contact', {
		createable: false,
		updateable: true,
		fields: [
			{ name: 'Email', updateable: false },
			{ name: 'Phone', updateable: false },
		],
	});
	assert.match(api._slotPermissionBlockReason(request), /current Salesforce permissions/);

	api._slotDescribeAccessByObject.get('Contact').fields[1].updateable = true;
	assert.equal(api._slotPermissionBlockReason(request), null);
});
