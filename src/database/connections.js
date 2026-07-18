// Salesforce connection metadata only. OAuth tokens are intentionally absent from this table.
import crypto from 'node:crypto';
import { ext } from '../extensions.js';

export async function findById(id) {
	if (!id) {
		return null;
	}
	const db = ext.getDb();
	return db.selectFrom('connections').selectAll().where('id', '=', id).executeTakeFirst();
}

export async function upsertFromOauth({
	// Identity is unique per account and Salesforce user; reconnecting refreshes metadata in place.
	accountId,
	sfUserId,
	sfOrgId,
	instanceUrl,
	displayUsername,
	displayName,
	email,
}) {
	if (!accountId || !sfUserId || !sfOrgId || !instanceUrl) {
		throw new Error('accountId, sfUserId, sfOrgId, and instanceUrl are required');
	}
	const db = ext.getDb();
	const existing = await db
		.selectFrom('connections')
		.selectAll()
		.where('account_id', '=', accountId)
		.where('sf_user_id', '=', sfUserId)
		.executeTakeFirst();
	const now = Date.now();
	if (existing) {
		await db
			.updateTable('connections')
			.set({
				sf_org_id: sfOrgId,
				instance_url: instanceUrl,
				display_username: displayUsername ?? existing.display_username,
				display_name: displayName ?? existing.display_name,
				email: email ?? existing.email,
				last_used_at: now,
				disabled_at: null,
				updated_at: now,
			})
			.where('id', '=', existing.id)
			.execute();
		return { connection: await findById(existing.id), created: false };
	}
	const id = 'conn_' + crypto.randomUUID();
	await db
		.insertInto('connections')
		.values({
			id,
			account_id: accountId,
			sf_user_id: sfUserId,
			sf_org_id: sfOrgId,
			instance_url: instanceUrl,
			display_username: displayUsername || null,
			display_name: displayName || null,
			email: email || null,
			last_used_at: now,
			disabled_at: null,
			created_at: now,
			updated_at: now,
		})
		.execute();
	return { connection: await findById(id), created: true };
}

export async function findByAccountAndSfUserId(accountId, sfUserId) {
	if (!accountId || !sfUserId) {
		return null;
	}
	const db = ext.getDb();
	return db
		.selectFrom('connections')
		.selectAll()
		.where('account_id', '=', accountId)
		.where('sf_user_id', '=', sfUserId)
		.executeTakeFirst();
}

export async function listForAccount(accountId, { includeDisabled = false } = {}) {
	if (!accountId) {
		return [];
	}
	const db = ext.getDb();
	let q = db
		.selectFrom('connections')
		.selectAll()
		.where('account_id', '=', accountId)
		.orderBy('last_used_at', 'desc');
	if (!includeDisabled) {
		q = q.where('disabled_at', 'is', null);
	}
	return q.execute();
}

export async function touchLastUsed(connectionId) {
	if (!connectionId) {
		return;
	}
	const db = ext.getDb();
	const now = Date.now();
	await db
		.updateTable('connections')
		.set({ last_used_at: now, updated_at: now })
		.where('id', '=', connectionId)
		.execute();
}

export async function setOrgType(connectionId, orgType) {
	if (!connectionId) {
		throw new Error('connectionId required');
	}
	const db = ext.getDb();
	await db
		.updateTable('connections')
		.set({ org_type: orgType || null, updated_at: Date.now() })
		.where('id', '=', connectionId)
		.execute();
}

export async function disable(connectionId) {
	if (!connectionId) {
		throw new Error('connectionId required');
	}
	const db = ext.getDb();
	const now = Date.now();
	await db
		.updateTable('connections')
		.set({ disabled_at: now, updated_at: now })
		.where('id', '=', connectionId)
		.execute();
}
