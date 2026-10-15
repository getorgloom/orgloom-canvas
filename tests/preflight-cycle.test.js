import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../src/public/js/preflight.js'), 'utf8');

function api(records, associations) {
	const window = {};
	vm.runInNewContext(source, { window, Set, Map, Date, isFinite });
	return window.OrgLoom.preflight.mount({
		canvasState: { bulkRecords: records, bulkAssociations: associations, describeCache: {}, selectedObjects: [] },
		isRecordModified: () => true,
		recordOrdinal: () => 1,
	});
}

test('upload preview identifies every member of a two-record reference cycle', () => {
	const pf = api(
		[
			{ id: 1, objectName: 'Account' },
			{ id: 2, objectName: 'Account' },
		],
		[
			{ fromId: 1, toId: 2, fieldName: 'ParentId' },
			{ fromId: 2, toId: 1, fieldName: 'ParentId' },
		],
	);
	const result = pf.computeUploadOrder(new Set(), new Set([1, 2]), new Set());
	assert.deepEqual([...result.cycleIds].sort(), [1, 2]);
});

test('an acyclic parent-child chain reports no cycle', () => {
	const pf = api(
		[
			{ id: 1, objectName: 'Account' },
			{ id: 2, objectName: 'Contact' },
		],
		[{ fromId: 2, toId: 1, fieldName: 'AccountId' }],
	);
	const result = pf.computeUploadOrder(new Set(), new Set([1, 2]), new Set());
	assert.equal(result.cycleIds.size, 0);
});
