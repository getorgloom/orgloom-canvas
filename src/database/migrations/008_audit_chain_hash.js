import crypto from 'node:crypto';
import { sql } from 'kysely';

function _canonical(row) {
	return JSON.stringify([
		row.id,
		row.workspace_id || null,
		row.actor_account_id || null,
		row.actor_connection_id || null,
		row.actor_kind || 'web',
		row.mcp_token_id || null,
		row.action,
		row.target_object || null,
		row.target_id || null,
		row.target_sf_org_id || null,
		row.payload_json || null,
		row.status || 'ok',
		row.error_code || null,
		row.request_id || null,
		row.created_at,
	]);
}

function _hash(prev, row) {
	const h = crypto.createHash('sha256');
	h.update(prev || '');
	h.update('|');
	h.update(_canonical(row));
	return h.digest('hex');
}

export async function up(db) {
	await db.schema.alterTable('audit_log').addColumn('chain_hash', 'text').execute();

	const rows = await db
		.selectFrom('audit_log')
		.selectAll()
		.orderBy('workspace_id', 'asc')
		.orderBy('created_at', 'asc')
		.orderBy('id', 'asc')
		.execute();

	let prevHashByWs = new Map();
	for (const row of rows) {
		const key = row.workspace_id || '';
		const prev = prevHashByWs.get(key) || '';
		const hash = _hash(prev, row);
		await db.updateTable('audit_log').set({ chain_hash: hash }).where('id', '=', row.id).execute();
		prevHashByWs.set(key, hash);
	}

	await db.schema
		.createIndex('audit_log_chain_walk_idx')
		.on('audit_log')
		.columns(['workspace_id', 'created_at'])
		.execute();
}

export async function down(db) {
	await db.schema.dropIndex('audit_log_chain_walk_idx').execute();
	await db.schema.alterTable('audit_log').dropColumn('chain_hash').execute();
}
