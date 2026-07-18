import { ext } from '../extensions.js';

// Workspace canvas-role grants; Salesforce file access remains a separate authorization layer.

const VALID_ROLES = new Set(['viewer', 'contributor', 'editor']);

function _normalizeRole(role) {
	const v = String(role || '')
		.trim()
		.toLowerCase();
	return VALID_ROLES.has(v) ? v : null;
}

export async function set({ sfOrgId, canvasId, recipientSfUserId, role, grantedByAccountId = null }) {
	if (!sfOrgId) {
		throw new Error('sfOrgId required');
	}
	if (!canvasId) {
		throw new Error('canvasId required');
	}
	if (!recipientSfUserId) {
		throw new Error('recipientSfUserId required');
	}
	const r = _normalizeRole(role);
	if (!r) {
		throw new Error('invalid role: ' + role);
	}
	const db = ext.getDb();
	const now = Date.now();
	await db
		.insertInto('canvas_role_grants')
		.values({
			sf_org_id: sfOrgId,
			canvas_id: canvasId,
			recipient_sf_user_id: recipientSfUserId,
			role: r,
			granted_by_account_id: grantedByAccountId,
			created_at: now,
			updated_at: now,
		})
		.onConflict((oc) =>
			oc.columns(['sf_org_id', 'canvas_id', 'recipient_sf_user_id']).doUpdateSet({
				role: r,
				granted_by_account_id: grantedByAccountId,
				updated_at: now,
			}),
		)
		.execute();
	return { role: r, updatedAt: now };
}

export async function get({ sfOrgId, canvasId, recipientSfUserId }) {
	if (!sfOrgId || !canvasId || !recipientSfUserId) {
		return null;
	}
	const db = ext.getDb();
	const row = await db
		.selectFrom('canvas_role_grants')
		.select(['role', 'granted_by_account_id', 'created_at', 'updated_at'])
		.where('sf_org_id', '=', sfOrgId)
		.where('canvas_id', '=', canvasId)
		.where('recipient_sf_user_id', '=', recipientSfUserId)
		.executeTakeFirst();
	if (!row) {
		return null;
	}
	return {
		role: row.role,
		grantedByAccountId: row.granted_by_account_id,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export async function remove({ sfOrgId, canvasId, recipientSfUserId }) {
	if (!sfOrgId || !canvasId || !recipientSfUserId) {
		return 0;
	}
	const db = ext.getDb();
	const result = await db
		.deleteFrom('canvas_role_grants')
		.where('sf_org_id', '=', sfOrgId)
		.where('canvas_id', '=', canvasId)
		.where('recipient_sf_user_id', '=', recipientSfUserId)
		.executeTakeFirst();
	return Number(result && result.numDeletedRows) || 0;
}

export async function listForCanvas({ sfOrgId, canvasId }) {
	if (!sfOrgId || !canvasId) {
		return {};
	}
	const db = ext.getDb();
	const rows = await db
		.selectFrom('canvas_role_grants')
		.select(['recipient_sf_user_id', 'role', 'updated_at'])
		.where('sf_org_id', '=', sfOrgId)
		.where('canvas_id', '=', canvasId)
		.execute();
	const out = {};
	for (const r of rows) {
		out[r.recipient_sf_user_id] = { role: r.role, updatedAt: r.updated_at };
	}
	return out;
}
