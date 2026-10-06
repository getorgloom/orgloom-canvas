import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildCsv } from '../src/sf-bulk.js';

test('bulk CSV distinguishes explicit clears from an omitted field', () => {
	const csv = buildCsv(
		[
			{ Id: '001EXPLICITNULL', TestCurr__c: null },
			{ Id: '001EXPLICITBLANK', TestCurr__c: '' },
			{ Id: '001OMITTED' },
		],
		['Id', 'TestCurr__c'],
	);

	assert.equal(csv, 'Id,TestCurr__c\n001EXPLICITNULL,#N/A\n001EXPLICITBLANK,#N/A\n001OMITTED,');
});
