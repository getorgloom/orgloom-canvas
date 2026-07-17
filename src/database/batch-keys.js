
import { ext } from "../extensions.js";
import {
	generateDataKey,
	getCachedDek,
	putCachedDek,
} from "../storage/canvas-encryption.js";

async function _insertOrReplaceWrappedKey(db, { sfOrgId, batchId, wrapped }) {
	const now = Date.now();
	await db
		.insertInto("batch_keys")
		.values({
			sf_org_id: sfOrgId,
			batch_id: batchId,
			wrapped_key: wrapped.wrappedKey,
			wrap_iv: wrapped.iv,
			wrap_auth_tag: wrapped.authTag,
			master_key_version: wrapped.masterKeyVersion,
			created_at: now,
			updated_at: now,
		})
		.onConflict((oc) => oc.columns(["sf_org_id", "batch_id"]).doNothing())
		.execute();
}

async function _readRow(db, sfOrgId, batchId) {
	return db
		.selectFrom("batch_keys")
		.select([
			"wrapped_key",
			"wrap_iv",
			"wrap_auth_tag",
			"master_key_version",
		])
		.where("sf_org_id", "=", sfOrgId)
		.where("batch_id", "=", batchId)
		.executeTakeFirst();
}

function _rowToWrapped(row) {
	return {
		wrappedKey: row.wrapped_key,
		iv: row.wrap_iv,
		authTag: row.wrap_auth_tag,
		masterKeyVersion: row.master_key_version,
	};
}

export async function get({ sfOrgId, batchId, kekProvider, sessionId }) {
	if (!sfOrgId || !batchId) {
		return null;
	}
	if (!kekProvider) {
		throw new Error("batch-keys.get: kekProvider required");
	}
	const cached = getCachedDek(sessionId, 'batch', batchId);
	if (cached) {
		return cached;
	}
	const db = ext.getDb();
	const row = await _readRow(db, sfOrgId, batchId);
	if (!row) {
		return null;
	}
	const dek = await kekProvider.unwrapDataKey(_rowToWrapped(row));
	putCachedDek(sessionId, 'batch', batchId, dek);
	return dek;
}

export async function getOrMint({ sfOrgId, batchId, kekProvider, sessionId }) {
	if (!sfOrgId) {
		throw new Error("sfOrgId required");
	}
	if (!batchId) {
		throw new Error("batchId required");
	}
	if (!kekProvider) {
		throw new Error("batch-keys.getOrMint: kekProvider required");
	}
	const existing = await get({ sfOrgId, batchId, kekProvider, sessionId });
	if (existing) {
		return existing;
	}
	const fresh = generateDataKey();
	const wrapped = await kekProvider.wrapDataKey(fresh);
	const db = ext.getDb();
	await _insertOrReplaceWrappedKey(db, { sfOrgId, batchId, wrapped });
	putCachedDek(sessionId, 'batch', batchId, fresh);
	return fresh;
}

export async function persist({ sfOrgId, batchId, dataKey, kekProvider, sessionId }) {
	if (!sfOrgId) {
		throw new Error("sfOrgId required");
	}
	if (!batchId) {
		throw new Error("batchId required");
	}
	if (!kekProvider) {
		throw new Error("batch-keys.persist: kekProvider required");
	}
	const wrapped = await kekProvider.wrapDataKey(dataKey);
	const db = ext.getDb();
	await _insertOrReplaceWrappedKey(db, { sfOrgId, batchId, wrapped });
	putCachedDek(sessionId, 'batch', batchId, dataKey);
}

export async function remove({ sfOrgId, batchId }) {
	if (!sfOrgId || !batchId) {
		return 0;
	}
	const db = ext.getDb();
	const result = await db
		.deleteFrom("batch_keys")
		.where("sf_org_id", "=", sfOrgId)
		.where("batch_id", "=", batchId)
		.executeTakeFirst();
	return Number(result && result.numDeletedRows) || 0;
}
