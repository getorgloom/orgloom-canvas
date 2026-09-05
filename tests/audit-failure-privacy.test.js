import { before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { initTestDb, clearTestDb } from './helpers/db.js';

before(initTestDb);
beforeEach(clearTestDb);

describe('Activity History failure privacy', () => {
	test('recordFailure omits free-form exception text and bounds the error code', async () => {
		const { audit } = await import('../src/database/index.js');
		const { ext } = await import('../src/extensions.js');
		await audit.recordFailure(
			null,
			'soql_query',
			new Error("SELECT Id FROM Contact WHERE Email='[email protected]'"),
			{
				errorCode: 'QUERY_FAILED',
				payload: { objectName: 'Contact', returnedRows: 0 },
			},
		);
		const row = await ext
			.getDb()
			.selectFrom('audit_log')
			.select(['status', 'error_code'])
			.executeTakeFirstOrThrow();
		assert.equal(row.status, 'failed');
		assert.equal(row.error_code, 'QUERY_FAILED');
	});

	test('recordFailure replaces an unsafe provider error code', async () => {
		const { audit } = await import('../src/database/index.js');
		const { ext } = await import('../src/extensions.js');
		const err = new Error('sensitive response');
		err.errorCode = 'bad code containing customer value';
		await audit.recordFailure(null, 'upload', err);
		const row = await ext.getDb().selectFrom('audit_log').select(['error_code']).executeTakeFirstOrThrow();
		assert.equal(row.error_code, 'error');
	});
});
