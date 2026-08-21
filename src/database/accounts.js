// Account persistence and canonical email matching for hosted identity flows.
import crypto from 'node:crypto';
import { ext } from '../extensions.js';

export function normalizeEmail(email) {
	if (!email) {
		return null;
	}
	return String(email).trim().toLowerCase();
}

export function normalizePromoCode(code) {
	if (code == null) {
		return null;
	}
	const cleaned = String(code).trim().toUpperCase().slice(0, 64);
	return cleaned.length > 0 ? cleaned : null;
}

export function normalizeEmailForCollisionCheck(email) {
	// Gmail aliases collapse only for collision detection; the user's actual address remains unchanged.
	const lower = normalizeEmail(email);
	if (!lower) {
		return null;
	}
	const atIdx = lower.lastIndexOf('@');
	if (atIdx < 1) {
		return lower;
	}
	let local = lower.slice(0, atIdx);
	const domain = lower.slice(atIdx + 1);
	const plusIdx = local.indexOf('+');
	if (plusIdx >= 0) {
		local = local.slice(0, plusIdx);
	}

	let canonicalDomain = domain;
	if (domain === 'gmail.com' || domain === 'googlemail.com') {
		local = local.replace(/\./g, '');
		canonicalDomain = 'gmail.com';
	}
	return local + '@' + canonicalDomain;
}

export async function findByCanonicalEmail(email) {
	const canonical = normalizeEmailForCollisionCheck(email);
	if (!canonical) {
		return null;
	}
	const db = ext.getDb();
	return db.selectFrom('accounts').selectAll().where('email_collision_key', '=', canonical).executeTakeFirst();
}

export async function findById(id) {
	if (!id) {
		return null;
	}
	const db = ext.getDb();
	return db.selectFrom('accounts').selectAll().where('id', '=', id).executeTakeFirst();
}

export async function findByEmail(email) {
	const normalized = normalizeEmail(email);
	if (!normalized) {
		return null;
	}
	const db = ext.getDb();
	return db.selectFrom('accounts').selectAll().where('email', '=', normalized).executeTakeFirst();
}

export async function upsertByEmail({ email, displayName, promoCode }) {
	const normalized = normalizeEmail(email);
	if (!normalized) {
		throw new Error('email is required');
	}
	const db = ext.getDb();
	const existing = await findByEmail(normalized);
	if (existing) {
		if (displayName && !existing.display_name) {
			const now = Date.now();
			await db
				.updateTable('accounts')
				.set({ display_name: displayName, updated_at: now })
				.where('id', '=', existing.id)
				.execute();
			return {
				account: {
					...existing,
					display_name: displayName,
					updated_at: now,
				},
				created: false,
			};
		}
		return { account: existing, created: false };
	}
	const aliasMatch = await findByCanonicalEmail(normalized);
	if (aliasMatch) {
		return { account: null, created: false, collision: aliasMatch };
	}
	const now = Date.now();
	const account = {
		id: 'acc_' + crypto.randomUUID(),
		email: normalized,
		email_collision_key: normalizeEmailForCollisionCheck(normalized),
		display_name: displayName || null,
		promo_code: normalizePromoCode(promoCode),
		deleted_at: null,
		created_at: now,
		updated_at: now,
	};
	try {
		await db.insertInto('accounts').values(account).execute();
	} catch (error) {
		// The unique key closes the race between two simultaneous signups.
		const collision = await findByCanonicalEmail(normalized);
		if (collision) {
			if (collision.email === normalized) {
				return { account: collision, created: false };
			}
			return { account: null, created: false, collision };
		}
		throw error;
	}
	return { account, created: true };
}

export async function updateDisplayName(id, displayName) {
	if (!id) {
		throw new Error('id is required');
	}
	const db = ext.getDb();
	const now = Date.now();
	await db
		.updateTable('accounts')
		.set({ display_name: displayName || null, updated_at: now })
		.where('id', '=', id)
		.execute();
	return findById(id);
}

export async function updateEmail(id, email) {
	const normalized = normalizeEmail(email);
	if (!id || !normalized) {
		throw new Error('id and email are required');
	}
	const db = ext.getDb();
	const current = await findById(id);
	if (current && current.email === normalized) {
		return current;
	}
	const collision = await findByCanonicalEmail(normalized);
	if (collision && collision.id !== id) {
		const err = new Error('Email already in use by another account.');
		err.code = 'email_in_use';
		throw err;
	}
	const now = Date.now();
	try {
		await db
			.updateTable('accounts')
			.set({
				email: normalized,
				email_collision_key: normalizeEmailForCollisionCheck(normalized),
				updated_at: now,
			})
			.where('id', '=', id)
			.execute();
	} catch (error) {
		const raced = await findByCanonicalEmail(normalized);
		if (raced && raced.id !== id) {
			const collisionError = new Error('Email already in use by another account.');
			collisionError.code = 'email_in_use';
			throw collisionError;
		}
		throw error;
	}
	return findById(id);
}

export async function softDelete(id) {
	if (!id) {
		throw new Error('id is required');
	}
	const db = ext.getDb();
	const now = Date.now();
	await db.updateTable('accounts').set({ deleted_at: now, updated_at: now }).where('id', '=', id).execute();
	return findById(id);
}

export async function pseudonymize(id, pseudoEmail) {
	if (!id) {
		throw new Error('id is required');
	}
	if (!pseudoEmail || typeof pseudoEmail !== 'string') {
		throw new Error('pseudoEmail is required');
	}
	const db = ext.getDb();
	const now = Date.now();
	await db
		.updateTable('accounts')
		.set({
			email: pseudoEmail,
			email_collision_key: normalizeEmailForCollisionCheck(pseudoEmail),
			display_name: null,
			deleted_at: now,
			updated_at: now,
		})
		.where('id', '=', id)
		.execute();
	return findById(id);
}

export async function restore(id) {
	if (!id) {
		throw new Error('id is required');
	}
	const db = ext.getDb();
	const now = Date.now();
	await db.updateTable('accounts').set({ deleted_at: null, updated_at: now }).where('id', '=', id).execute();
	return findById(id);
}

export async function listForAdminView({ limit = 100, offset = 0, includeDeleted = false, emailQuery = null } = {}) {
	const db = ext.getDb();
	let q = db.selectFrom('accounts').selectAll().orderBy('created_at', 'desc');
	if (!includeDeleted) {
		q = q.where('deleted_at', 'is', null);
	}
	const normalizedQuery = normalizeEmail(emailQuery);
	if (normalizedQuery) {
		q = q.where('email', 'like', `%${normalizedQuery}%`);
	}
	return q
		.limit(Math.min(500, Math.max(1, limit)))
		.offset(Math.max(0, offset))
		.execute();
}
