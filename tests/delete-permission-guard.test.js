import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const preflightSource = readFileSync(new URL('../src/public/js/preflight.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/public/js/app.js', import.meta.url), 'utf8');
const cardMenuSource = readFileSync(new URL('../src/public/js/canvas-card-menu.js', import.meta.url), 'utf8');
const insertModalSource = readFileSync(new URL('../src/public/js/insert-modal.js', import.meta.url), 'utf8');
const routesSource = readFileSync(new URL('../src/canvas-routes.js', import.meta.url), 'utf8');

function validatePendingDelete(deletable) {
	const context = { window: { OrgLoom: {} } };
	vm.runInNewContext(preflightSource, context);
	const api = context.window.OrgLoom.preflight.mount({
		canvasState: {
			bulkRecords: [
				{
					id: 1,
					objectName: 'Account',
					label: 'Account',
					loadedFromId: '001000000000001AAA',
					pendingDelete: true,
				},
			],
			bulkAssociations: [],
			describeCache: { Account: { deletable, fields: [] } },
		},
		isRecordModified: () => false,
		recordOrdinal: () => 1,
	});
	return api.validateBulkRecords();
}

test('preflight blocks a staged delete when Salesforce marks the object non-deletable', () => {
	const blocked = validatePendingDelete(false);
	assert.equal(blocked.issues.length, 1);
	assert.equal(blocked.issues[0].field, '(delete)');
	assert.match(blocked.issues[0].message, /does not have permission to delete/);
	assert.equal(validatePendingDelete(true).issues.length, 0);
});

test('both delete controls and the central mutation guard require object delete permission', () => {
	assert.match(appSource, /describe\.deletable !== true/);
	assert.match(cardMenuSource, /else if \(canDeleteRecord\(rec\)\)/);
	assert.match(insertModalSource, /!pending && !canDeleteRecord\(rec\)/);
	assert.match(routesSource, /body\.pendingDelete === true/);
	assert.match(routesSource, /describe\.deletable !== true/);
	assert.match(routesSource, /delete-not-permitted/);
});
