import crypto from 'node:crypto';

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

function _contentHash(row) {
	return crypto.createHash('sha256').update(_canonical(row)).digest('hex');
}

function _chainHash(prev, contentHash) {
	const h = crypto.createHash('sha256');
	h.update(prev || '');
	h.update('|');
	h.update(contentHash);
	return h.digest('hex');
}

export async function up(db) {
	await db.schema.alterTable('audit_log').addColumn('content_hash', 'text').execute();
	await db.schema.alterTable('audit_log').addColumn('redacted_at', 'integer').execute();

	const rows = await db
		.selectFrom('audit_log')
		.selectAll()
		.orderBy('workspace_id', 'asc')
		.orderBy('created_at', 'asc')
		.orderBy('id', 'asc')
		.execute();

	const prevByWs = new Map();
	for (const row of rows) {
		const key = row.workspace_id || '';
		const contentHash = _contentHash(row);
		const prev = prevByWs.get(key) || '';
		const chainHash = _chainHash(prev, contentHash);
		await db
			.updateTable('audit_log')
			.set({ content_hash: contentHash, chain_hash: chainHash })
			.where('id', '=', row.id)
			.execute();
		prevByWs.set(key, chainHash);
	}
}

export async function down(db) {
	await db.schema.alterTable('audit_log').dropColumn('redacted_at').execute();
	await db.schema.alterTable('audit_log').dropColumn('content_hash').execute();
}
