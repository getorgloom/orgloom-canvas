import { before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { initTestDb, clearTestDb } from './helpers/db.js';

before(initTestDb);
beforeEach(clearTestDb);

describe('Activity History fixed-column privacy', () => {
	for (const action of ['record_upserted', 'record_deleted', 'load_existing', 'record_insert']) {
		test(`${action} cannot retain targets or a free-form payload`, async () => {
			const { audit } = await import('../src/database/index.js');
			const { ext } = await import('../src/extensions.js');
			await audit.record({
				action,
				targetObject: 'Account',
				targetId: '001000000000001AAA',
				targetSfOrgId: '00D000000000001AAA',
				payload: {
					sfRecordId: '001000000000001AAA',
					recordId: '001000000000001AAA',
					sfId: '001000000000001AAA',
					result: 'ok',
				},
			});

			const columns = await ext.getDb().introspection.getMetadata();
			const auditTable = columns.tables.find((table) => table.name === 'audit_log');
			const names = auditTable.columns.map((column) => column.name);
			assert.ok(!names.includes('target_object'));
			assert.ok(!names.includes('target_id'));
			assert.ok(!names.includes('payload_json'));

			const row = await ext
				.getDb()
				.selectFrom('audit_log')
				.select(['action', 'target_sf_org_id'])
				.executeTakeFirstOrThrow();
			assert.equal(row.action, action);
			assert.equal(row.target_sf_org_id, '00D000000000001AAA');
		});
	}
});
