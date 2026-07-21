import { migrationColumnExists } from '../migration-introspection.js';

function normalizeEmailForCollisionCheck(email) {
	const lower = String(email || '')
		.trim()
		.toLowerCase();
	const atIndex = lower.lastIndexOf('@');
	if (atIndex < 1) {
		return lower;
	}
	let local = lower.slice(0, atIndex);
	const domain = lower.slice(atIndex + 1);
	const plusIndex = local.indexOf('+');
	if (plusIndex >= 0) {
		local = local.slice(0, plusIndex);
	}
	const canonicalDomain = domain === 'googlemail.com' ? 'gmail.com' : domain;
	if (canonicalDomain === 'gmail.com') {
		local = local.replace(/\./g, '');
	}
	return `${local}@${canonicalDomain}`;
}

export async function up(db) {
	// SQLite can retain an ADD COLUMN even when a later migration step fails.
	// Recover that partial state instead of retrying the DDL and failing startup.
	if (!(await migrationColumnExists(db, 'accounts', 'email_collision_key'))) {
		await db.schema.alterTable('accounts').addColumn('email_collision_key', 'text').execute();
	}
	const rows = await db.selectFrom('accounts').select(['id', 'email', 'deleted_at', 'created_at']).execute();
	// Preserve every historical account. Prefer an active account as the
	// canonical owner, then the oldest account for deterministic recovery.
	rows.sort((a, b) => {
		const deletedOrder = Number(!!a.deleted_at) - Number(!!b.deleted_at);
		if (deletedOrder !== 0) {
			return deletedOrder;
		}
		const createdOrder = Number(a.created_at || 0) - Number(b.created_at || 0);
		return createdOrder || String(a.id).localeCompare(String(b.id));
	});
	const claimed = new Map();
	const backfill = [];
	for (const row of rows) {
		const key = normalizeEmailForCollisionCheck(row.email);
		const isHistoricalCollision = claimed.has(key);
		if (!isHistoricalCollision) {
			claimed.set(key, row.id);
		}
		// SQLite and PostgreSQL unique indexes both allow multiple nulls. An
		// exact legacy email still resolves through accounts.email, while new
		// signups must claim the canonical key and therefore cannot add another
		// alias of this address.
		backfill.push({ id: row.id, key: isHistoricalCollision ? null : key });
	}
	for (const row of backfill) {
		await db.updateTable('accounts').set({ email_collision_key: row.key }).where('id', '=', row.id).execute();
	}
	await db.schema
		.createIndex('accounts_email_collision_key_unique')
		.ifNotExists()
		.on('accounts')
		.column('email_collision_key')
		.unique()
		.execute();
}

export async function down(db) {
	await db.schema.dropIndex('accounts_email_collision_key_unique').ifExists().execute();
	if (await migrationColumnExists(db, 'accounts', 'email_collision_key')) {
		await db.schema.alterTable('accounts').dropColumn('email_collision_key').execute();
	}
}
