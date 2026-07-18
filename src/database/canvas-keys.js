// Wrapped per-canvas DEKs. Unwrapped keys exist only in the bounded server-session cache.
import { ext } from '../extensions.js';
import { generateDataKey, getCachedDek, putCachedDek } from '../storage/canvas-encryption.js';

async function _insertOrReplaceWrappedKey(db, { sfOrgId, canvasId, wrapped }) {
	const now = Date.now();
	await db
		.insertInto('canvas_keys')
		.values({
			sf_org_id: sfOrgId,
			canvas_id: canvasId,
			wrapped_key: wrapped.wrappedKey,
			wrap_iv: wrapped.iv,
			wrap_auth_tag: wrapped.authTag,
			master_key_version: wrapped.masterKeyVersion,
			created_at: now,
			updated_at: now,
		})
		.onConflict((oc) => oc.columns(['sf_org_id', 'canvas_id']).doNothing())
		.execute();
}

async function _readRow(db, sfOrgId, canvasId) {
	return db
		.selectFrom('canvas_keys')
		.select(['wrapped_key', 'wrap_iv', 'wrap_auth_tag', 'master_key_version'])
		.where('sf_org_id', '=', sfOrgId)
		.where('canvas_id', '=', canvasId)
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

export async function get({ sfOrgId, canvasId, kekProvider, sessionId }) {
	if (!sfOrgId || !canvasId) {
		return null;
	}
	if (!kekProvider) {
		throw new Error('canvas-keys.get: kekProvider required');
	}
	const cached = getCachedDek(sessionId, 'canvas', canvasId);
	if (cached) {
		return cached;
	}
	const db = ext.getDb();
	const row = await _readRow(db, sfOrgId, canvasId);
	if (!row) {
		return null;
	}
	const dek = await kekProvider.unwrapDataKey(_rowToWrapped(row));
	putCachedDek(sessionId, 'canvas', canvasId, dek);
	return dek;
}

export async function getOrMint({ sfOrgId, canvasId, kekProvider, sessionId }) {
	// Conflict-safe insert ensures concurrent first saves converge on the persisted key.
	if (!sfOrgId) {
		throw new Error('sfOrgId required');
	}
	if (!canvasId) {
		throw new Error('canvasId required');
	}
	if (!kekProvider) {
		throw new Error('canvas-keys.getOrMint: kekProvider required');
	}
	const existing = await get({ sfOrgId, canvasId, kekProvider, sessionId });
	if (existing) {
		return existing;
	}
	const fresh = generateDataKey();
	const wrapped = await kekProvider.wrapDataKey(fresh);
	const db = ext.getDb();
	await _insertOrReplaceWrappedKey(db, { sfOrgId, canvasId, wrapped });
	const row = await _readRow(db, sfOrgId, canvasId);
	if (row && row.wrapped_key === wrapped.wrappedKey) {
		putCachedDek(sessionId, 'canvas', canvasId, fresh);
		return fresh;
	}
	if (row) {
		const stored = await kekProvider.unwrapDataKey(_rowToWrapped(row));
		putCachedDek(sessionId, 'canvas', canvasId, stored);
		return stored;
	}
	putCachedDek(sessionId, 'canvas', canvasId, fresh);
	return fresh;
}

export async function persist({ sfOrgId, canvasId, dataKey, kekProvider, sessionId }) {
	if (!sfOrgId) {
		throw new Error('sfOrgId required');
	}
	if (!canvasId) {
		throw new Error('canvasId required');
	}
	if (!kekProvider) {
		throw new Error('canvas-keys.persist: kekProvider required');
	}
	const wrapped = await kekProvider.wrapDataKey(dataKey);
	const db = ext.getDb();
	await _insertOrReplaceWrappedKey(db, { sfOrgId, canvasId, wrapped });
	putCachedDek(sessionId, 'canvas', canvasId, dataKey);
}

export async function remove({ sfOrgId, canvasId }) {
	if (!sfOrgId || !canvasId) {
		return 0;
	}
	const db = ext.getDb();
	const result = await db
		.deleteFrom('canvas_keys')
		.where('sf_org_id', '=', sfOrgId)
		.where('canvas_id', '=', canvasId)
		.executeTakeFirst();
	return Number(result && result.numDeletedRows) || 0;
}
