// accounts represent humans/identity
import crypto from "node:crypto";
import { ext } from "../extensions.js";

export function normalizeEmail(email) {
	if (!email) {
		return null;
	}
	return String(email).trim().toLowerCase();
}

// Promo codes are attribution / cohort tags entered at signup. Trim,
// uppercase (we want RAMPUP26 and rampup26 to land in the same bucket
// for analytics), cap length so a malicious paste can't blow up the
// row. Returns null for blank input so we don't store empty strings
// that complicate "WHERE promo_code IS NOT NULL" queries.
export function normalizePromoCode(code) {
	if (code == null) {
		return null;
	}
	const cleaned = String(code).trim().toUpperCase().slice(0, 64);
	return cleaned.length > 0 ? cleaned : null;
}

// collisions:
//   gmail.com / googlemail.com
//   any other domain: for the local-part, drop "+suffix"
export function normalizeEmailForCollisionCheck(email) {
	const lower = normalizeEmail(email);
	if (!lower) {
		return null;
	}
	const atIdx = lower.lastIndexOf("@");
	if (atIdx < 1) {
		return lower;
	}
	let local = lower.slice(0, atIdx);
	const domain = lower.slice(atIdx + 1);
	// drop +suffix on every provider.
	const plusIdx = local.indexOf("+");
	if (plusIdx >= 0) {
		local = local.slice(0, plusIdx);
	}

	let canonicalDomain = domain;
	if (domain === "gmail.com" || domain === "googlemail.com") {
		local = local.replace(/\./g, "");
		canonicalDomain = "gmail.com";
	}
	return local + "@" + canonicalDomain;
}

// detect whether a new signup would collide with any existing account.
export async function findByCanonicalEmail(email) {
	const canonical = normalizeEmailForCollisionCheck(email);
	if (!canonical) {
		return null;
	}
	const db = ext.getDb();

	const direct = await db
		.selectFrom("accounts")
		.selectAll()
		.where("email", "=", canonical)
		.executeTakeFirst();
	if (direct) {
		return direct;
	}
	// fallback: scan and normalize. Soft-deleted accounts excluded
	// so a deleted alias can be re-claimed by a new signup.
	const all = await db
		.selectFrom("accounts")
		.selectAll()
		.where("deleted_at", "is", null)
		.execute();
	return (
		all.find(
			(acc) => normalizeEmailForCollisionCheck(acc.email) === canonical,
		) || null
	);
}

export async function findById(id) {
	if (!id) {
		return null;
	}
	const db = ext.getDb();
	return db
		.selectFrom("accounts")
		.selectAll()
		.where("id", "=", id)
		.executeTakeFirst();
}

export async function findByEmail(email) {
	const normalized = normalizeEmail(email);
	if (!normalized) {
		return null;
	}
	const db = ext.getDb();
	return db
		.selectFrom("accounts")
		.selectAll()
		.where("email", "=", normalized)
		.executeTakeFirst();
}

// find-or-create by email. Returns { account, created } so the caller
// knows whether to fire onboarding flows or just continue.
//
// promoCode is attribution-only: captured on first signup so we can
// segment cohorts later. Returning users keep their original code;
// re-entering a promo on a later signup attempt does NOT overwrite,
// since the first-touch attribution is what we want.
export async function upsertByEmail({ email, displayName, promoCode }) {
	const normalized = normalizeEmail(email);
	if (!normalized) {
		throw new Error("email is required");
	}
	const db = ext.getDb();
	const existing = await findByEmail(normalized);
	if (existing) {
		if (displayName && !existing.display_name) {
			const now = Date.now();
			await db
				.updateTable("accounts")
				.set({ display_name: displayName, updated_at: now })
				.where("id", "=", existing.id)
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
	// no exact match. Before creating, check for alias collision against
	// existing accounts (plus-addressing).
	const aliasMatch = await findByCanonicalEmail(normalized);
	if (aliasMatch) {
		return { account: null, created: false, collision: aliasMatch };
	}
	const now = Date.now();
	const account = {
		id: "acc_" + crypto.randomUUID(),
		email: normalized,
		display_name: displayName || null,
		promo_code: normalizePromoCode(promoCode),
		deleted_at: null,
		created_at: now,
		updated_at: now,
	};
	await db.insertInto("accounts").values(account).execute();
	return { account, created: true };
}

export async function updateDisplayName(id, displayName) {
	if (!id) {
		throw new Error("id is required");
	}
	const db = ext.getDb();
	const now = Date.now();
	await db
		.updateTable("accounts")
		.set({ display_name: displayName || null, updated_at: now })
		.where("id", "=", id)
		.execute();
	return findById(id);
}

export async function updateEmail(id, email) {
	const normalized = normalizeEmail(email);
	if (!id || !normalized) {
		throw new Error("id and email are required");
	}
	const db = ext.getDb();
	const collision = await findByEmail(normalized);
	if (collision && collision.id !== id) {
		const err = new Error("Email already in use by another account.");
		err.code = "email_in_use";
		throw err;
	}
	const now = Date.now();
	await db
		.updateTable("accounts")
		.set({ email: normalized, updated_at: now })
		.where("id", "=", id)
		.execute();
	return findById(id);
}

export async function softDelete(id) {
	if (!id) {
		throw new Error("id is required");
	}
	const db = ext.getDb();
	const now = Date.now();
	await db
		.updateTable("accounts")
		.set({ deleted_at: now, updated_at: now })
		.where("id", "=", id)
		.execute();
	return findById(id);
}

// GDPR Article 17 "right to erasure".
export async function pseudonymize(id, pseudoEmail) {
	if (!id) {
		throw new Error("id is required");
	}
	if (!pseudoEmail || typeof pseudoEmail !== "string") {
		throw new Error("pseudoEmail is required");
	}
	const db = ext.getDb();
	const now = Date.now();
	await db
		.updateTable("accounts")
		.set({
			email: pseudoEmail,
			display_name: null,
			deleted_at: now,
			updated_at: now,
		})
		.where("id", "=", id)
		.execute();
	return findById(id);
}

export async function restore(id) {
	if (!id) {
		throw new Error("id is required");
	}
	const db = ext.getDb();
	const now = Date.now();
	await db
		.updateTable("accounts")
		.set({ deleted_at: null, updated_at: now })
		.where("id", "=", id)
		.execute();
	return findById(id);
}

// admin-panel
export async function listForAdminView({
	limit = 100,
	offset = 0,
	includeDeleted = false,
} = {}) {
	const db = ext.getDb();
	let q = db.selectFrom("accounts").selectAll().orderBy("created_at", "desc");
	if (!includeDeleted) {
		q = q.where("deleted_at", "is", null);
	}
	return q
		.limit(Math.min(500, Math.max(1, limit)))
		.offset(Math.max(0, offset))
		.execute();
}
