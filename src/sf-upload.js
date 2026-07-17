// Salesforce upload helpers. Pure-ish functions used by /api/upload
// and its variants: no DB, no auth, no Express. The route handler
// owns the policy gates (cap, writable-org, slot filter), audit
// logging, and usage accounting; this module owns the SF-side
// mechanics.

import { isWritableForOperation } from './sf-field-structure.js';

// Placeholder value emitted by the client's pre-fill for reference
// fields. Strip at upload time so Salesforce doesn't reject the insert
// - real values come from associations when present, otherwise the
// field is left blank for SF defaults.
export const FAKE_REF_ID = '001000000000001';

// Server-side mirror of the client-side BYTE_CAP (5 MB) in app.js.
// The express body parser caps at 10 MB, but we want to reject upload
// payloads above the documented 5 MB limit regardless of how the
// client constructed the request - direct API callers, malformed
// clients, or future tooling shouldn't be able to bypass the cap.
export const UPLOAD_PAYLOAD_BYTE_CAP = 5 * 1024 * 1024;

export function rejectIfOverPayloadCap(req, res) {
	const len = parseInt(req.headers['content-length'] || '0', 10);
	if (len > UPLOAD_PAYLOAD_BYTE_CAP) {
		const mb = (len / 1024 / 1024).toFixed(1);
		const capMb = (UPLOAD_PAYLOAD_BYTE_CAP / 1024 / 1024).toFixed(0);
		res.status(413).json({
			error: 'payload-too-large',
			message: 'Payload is ' + mb + ' MB (cap is ' + capMb + ' MB). Split into smaller batches.',
		});
		return true;
	}
	return false;
}

// Retry wrapper for SF API calls that can hit rate limits.
// Exponential backoff: 500ms, 1s, 2s, 4s. Throws on non-rate-limit
// errors or after maxAttempts.
export async function withSfRetry(fn, { maxAttempts = 4, baseDelay = 500 } = {}) {
	let lastErr;
	for (let i = 0; i < maxAttempts; i++) {
		try {
			return await fn();
		} catch (err) {
			lastErr = err;
			const msg = String((err && (err.errorCode || err.message)) || '');
			const isRateLimited = /TotalRequests Limit/i.test(msg) || /REQUEST_LIMIT_EXCEEDED/i.test(msg);
			if (!isRateLimited || i === maxAttempts - 1) {
throw err;
}
			const delay = baseDelay * Math.pow(2, i);
			console.warn('[sf retry] limit hit, waiting', delay, 'ms before retry', i + 1);
			await new Promise((r) => setTimeout(r, delay));
		}
	}
	throw lastErr;
}

// Caches conn.sobject(name).describe() per upload request so a 50-record
// batch hitting 3 object types only describes 3 times.
export function makeDescribeCache(conn) {
	const cache = new Map();
	return async function getDescribe(objectName) {
		if (!cache.has(objectName)) {
			const pending = withSfRetry(() => conn.sobject(objectName).describe())
				.catch((err) => {
					// A transient failure must not poison this request's cache; a
					// later caller may retry and succeed.
					cache.delete(objectName);
					throw err;
				});
			cache.set(objectName, pending);
		}
		return await cache.get(objectName);
	};
}

// Strip fields SF will reject from an upload payload: those flagged
// !updateable (for updates) or !createable (for inserts), plus
// compound types (`address`, `location`) which are never writable as
// a unit. Without this, "load existing → tweak one field → upload"
// fails with INVALID_FIELD_FOR_INSERT_UPDATE because the load step
// pulls every queryable field including system-managed ones (Name on
// Contact, MailingAddress, IsEmailBounced, PhotoUrl, etc.) into
// rec.values.
export function stripUnwritableFields(values, describe, isUpdate) {
	if (!values || !describe || !Array.isArray(describe.fields)) {
return Object.assign({}, values || {});
}
	const writable = new Set();
	describe.fields.forEach((f) => {
		if (!f || !f.name) {
return;
}
		// An external-ID upsert can resolve to either insert or update per
		// row. Keep fields writable in either outcome and let Salesforce
		// enforce the permission for the operation it actually performs.
		// Fields writable in neither outcome remain excluded.
		const operation = isUpdate === 'upsert' ? 'upsert' : (isUpdate ? 'update' : 'create');
		const writableForOperation = isWritableForOperation(f, operation);
		if (writableForOperation) {
writable.add(f.name);
}
	});
	const out = {};
	Object.keys(values).forEach((k) => {
		// Id stays for updates - SF needs it to identify the row even
		// though Id reports updateable=false in describe.
		if (k === 'Id' || writable.has(k)) {
out[k] = values[k];
}
	});
	return out;
}

// Format an SF API error / sub-error array into a single human-readable
// string. Handles three shapes: flat error, `err.data` array, and
// `err.errors` array (SF returns these in different paths).
export function formatUploadError(err) {
	if (!err) {
return 'Unknown error';
}
	const fmtOne = (e) => {
		if (!e) {
return '';
}
		const code = e.statusCode || e.errorCode;
		const msg = e.message || (typeof e === 'string' ? e : JSON.stringify(e));
		const fields = Array.isArray(e.fields) && e.fields.length > 0 ? ' [' + e.fields.join(', ') + ']' : '';
		return (code ? code + ': ' : '') + msg + fields;
	};
	if (Array.isArray(err.data) && err.data.length > 0) {
		return err.data.map(fmtOne).join(' | ');
	}
	if (Array.isArray(err.errors) && err.errors.length > 0) {
		return err.errors.map(fmtOne).join(' | ');
	}
	return fmtOne(err) || 'Unknown error';
}

// Extract the machine-readable SF error code (e.g. DUPLICATES_DETECTED,
// REQUIRED_FIELD_MISSING, FIELD_CUSTOM_VALIDATION_EXCEPTION) from the
// same three error shapes formatUploadError handles. The REST upload
// path folds the code into the human string via formatUploadError, but
// the CLIENT needs the bare code to branch behavior - e.g. offer the
// duplicate-rule override only on DUPLICATES_DETECTED. Returns the first
// code found, or null. Kept separate from formatUploadError so the
// human string and the branch key don't drift.
export function extractUploadErrorCode(err) {
	if (!err) {
		return null;
	}
	const codeOf = (e) => (e && (e.statusCode || e.errorCode)) || null;
	if (Array.isArray(err.errors) && err.errors.length > 0) {
		for (const e of err.errors) {
			const c = codeOf(e);
			if (c) {
				return c;
			}
		}
	}
	if (Array.isArray(err.data) && err.data.length > 0) {
		for (const e of err.data) {
			const c = codeOf(e);
			if (c) {
				return c;
			}
		}
	}
	return codeOf(err);
}

// Topological sort of records by their parent dependencies. Returns
// `{ order, cycleIds }`: order is a list of tempIds in
// child-before-parent ordering (dependent records first), cycleIds is
// the set of nodes participating in any reference cycle (those should
// be flagged as upload failures rather than partial-committed with
// dangling FKs).
export function topoSortRecords(records, associations) {
	const recordsById = new Map();
	records.forEach((r) => {
 if (r && r.tempId != null) {
recordsById.set(r.tempId, r);
} 
});
	const deps = new Map();
	recordsById.forEach((_, id) => deps.set(id, new Set()));
	(associations || []).forEach((a) => {
		if (!a) {
return;
}
		if (!deps.has(a.fromId)) {
return;
}
		if (!recordsById.has(a.toId)) {
return;
}
		deps.get(a.fromId).add(a.toId);
	});
	const order = [];
	const visited = new Set();
	const stackSet = new Set();
	const stackArr = [];
	const cycleIds = new Set();
	function visit(id) {
		if (visited.has(id)) {
return;
}
		if (stackSet.has(id)) {
			const entry = stackArr.indexOf(id);
			for (let i = entry; i < stackArr.length; i++) {
cycleIds.add(stackArr[i]);
}
			return;
		}
		stackSet.add(id);
		stackArr.push(id);
		(deps.get(id) || []).forEach(visit);
		stackSet.delete(id);
		stackArr.pop();
		visited.add(id);
		order.push(id);
	}
	recordsById.forEach((_, id) => visit(id));
	return { order, cycleIds, deps };
}

// Read-only system fields that the loaded-record fetch returns but
// Salesforce rejects in PATCH/POST bodies. Id in particular trips a
// "Cannot specify Id in update" error on per-record graph PATCH;
// audit fields are not writable on standard objects. The graph
// upload strips these up-front so the same loaded values can flow
// through untouched everywhere else.
export const SYSTEM_RO_FIELDS = new Set([
	'Id', 'IsDeleted', 'CreatedDate', 'CreatedById',
	'LastModifiedDate', 'LastModifiedById', 'SystemModstamp',
	'LastActivityDate', 'LastViewedDate', 'LastReferencedDate',
]);

// Composite Graph caps. Per-graph (= per-connected-component) and
// total. Going over either is a 400 from SF; we surface a clearer
// error and route the user to REST/Bulk instead.
export const GRAPH_PER_GRAPH_CAP = 75;
export const GRAPH_TOTAL_NODES_CAP = 500;

// Find connected components in the submission subgraph. Each component
// becomes its own atomic graph in the request - failure in one rolls
// back only that component, not its siblings. Lifts the cap from
// "75 total nodes" to "75 per component / 500 total."
//
// Returns an array of components. Each component is an array of
// tempIds in the order given by `submittedOrder` (so topo order is
// preserved within each component).
export function groupConnectedComponents(submittedIds, submittedOrder, associations) {
	const adj = new Map();
	submittedIds.forEach((id) => adj.set(id, new Set()));
	(associations || []).forEach((a) => {
		if (!a) {
return;
}
		if (!submittedIds.has(a.fromId) || !submittedIds.has(a.toId)) {
return;
}
		adj.get(a.fromId).add(a.toId);
		adj.get(a.toId).add(a.fromId);
	});
	const componentByTempId = new Map();
	let componentCount = 0;
	for (const seed of submittedIds) {
		if (componentByTempId.has(seed)) {
continue;
}
		const idx = componentCount++;
		const queue = [seed];
		while (queue.length) {
			const cur = queue.shift();
			if (componentByTempId.has(cur)) {
continue;
}
			componentByTempId.set(cur, idx);
			for (const neighbor of (adj.get(cur) || [])) {
				if (!componentByTempId.has(neighbor)) {
queue.push(neighbor);
}
			}
		}
	}
	const components = Array.from({ length: componentCount }, () => []);
	for (const tempId of submittedOrder) {
		if (!submittedIds.has(tempId)) {
continue;
}
		components[componentByTempId.get(tempId)].push(tempId);
	}
	return components;
}

// refId for graph composite sub-requests. Stable per tempId so the
// response handler can map back. Strict character set so the SF
// validation pattern doesn't reject it.
export function graphRefIdFor(tempId) {
	return 'r' + String(tempId).replace(/[^a-zA-Z0-9]/g, '_');
}

// Build a single Composite Graph sub-request for one record. Returns
// the SF-formatted { method, url, referenceId, body } shape.
//
// `submittedIds` is the set of tempIds that ARE in the submission
// (so cross-component FK substitution uses the @{ref.id} syntax for
// in-component parents and the literal loadedFromId for out-of-
// component / loaded-only parents).
export function buildGraphSubRequest({
	rec,
	tempId,
	apiBase,
	associations,
	submittedIds,
	recordsById,
	describesByObject,
}) {
	let values = Object.assign({}, rec.values || {});
	const describe = describesByObject.get(rec.objectName);
	if (describe) {
values = stripUnwritableFields(values, describe, !!rec.loadedFromId);
}
	Object.keys(values).forEach((k) => {
 if (SYSTEM_RO_FIELDS.has(k)) {
delete values[k];
} 
});
	Object.keys(values).forEach((k) => {
 if (values[k] === FAKE_REF_ID) {
delete values[k];
} 
});
	Object.keys(values).forEach((k) => {
		if (typeof values[k] === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(values[k])) {
			values[k] = values[k] + ':00.000Z';
		}
	});
	Object.keys(values).forEach((k) => {
		if (!k.endsWith('Code')) {
return;
}
		if (values[k] == null || values[k] === '') {
return;
}
		const textField = k.slice(0, -'Code'.length);
		if (Object.prototype.hasOwnProperty.call(values, textField)) {
delete values[textField];
}
	});
	(associations || []).forEach((a) => {
		if (a.fromId !== tempId) {
return;
}
		const parent = recordsById.get(a.toId);
		if (!parent) {
return;
}
		// Reference resolution order - loadedFromId wins when present,
		// even if the parent is also in the submission. Rationale:
		// Composite Graph's @{ref.id} substitution only works for POST
		// sub-requests because they return a body with an `id` field.
		// PATCH sub-requests (updates) return 204 No Content; the
		// reference can't resolve and SF errors with "No value for
		// r2.id found in r2." Since loadedFromId IS the parent's real
		// SF id (we got it from the canvas-side record we're updating),
		// using it directly is both correct and avoids the PATCH-
		// reference dead end. Only fall through to the @{ref.id}
		// syntax when the parent is a genuine INSERT with no
		// pre-existing id we could substitute.
		if (parent.loadedFromId) {
			values[a.fieldName] = parent.loadedFromId;
		} else if (submittedIds.has(a.toId)) {
			values[a.fieldName] = '@{' + graphRefIdFor(a.toId) + '.id}';
		}
	});
	if (rec.loadedFromId) {
		return {
			method: 'PATCH',
			url: apiBase + '/sobjects/' + rec.objectName + '/' + rec.loadedFromId,
			referenceId: graphRefIdFor(tempId),
			body: values,
		};
	}
	return {
		method: 'POST',
		url: apiBase + '/sobjects/' + rec.objectName,
		referenceId: graphRefIdFor(tempId),
		body: values,
	};
}

// Apply value-level normalization needed for the SF REST API:
//   - Strip FAKE_REF_ID placeholders from reference fields.
//   - Upgrade datetime-local strings ("YYYY-MM-DDTHH:MM") to full
//     ISO 8601 - the REST JSON parser rejects the bare form.
//   - State/Country picklists: when both Code and text fields are
//     present, drop the text field; SF auto-populates it from the
//     code, and a mismatch is rejected.
//   - Substitute real SF IDs for every reference field this record
//     owns (looked up via the realIdByTempId map populated as parents
//     are uploaded).
export function normalizeValuesForUpload(rec, tempId, associations, realIdByTempId) {
	const values = Object.assign({}, rec.values || {});
	Object.keys(values).forEach((k) => {
		if (values[k] === FAKE_REF_ID) {
delete values[k];
}
	});
	Object.keys(values).forEach((k) => {
		if (typeof values[k] === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(values[k])) {
			values[k] = values[k] + ':00.000Z';
		}
	});
	Object.keys(values).forEach((k) => {
		if (!k.endsWith('Code')) {
return;
}
		if (values[k] == null || values[k] === '') {
return;
}
		const textField = k.slice(0, -'Code'.length);
		if (Object.prototype.hasOwnProperty.call(values, textField)) {
			delete values[textField];
		}
	});
	// A reference (lookup) field is single-value, so a record holds at most
	// one association per fieldName. The canvas UI blocks duplicates
	// interactively; if a crafted / hand-edited payload carries them anyway,
	// take the first that resolves rather than last-wins (non-deterministic).
	const _fkSetByAssoc = new Set();
	(associations || []).forEach((a) => {
		if (a.fromId !== tempId) {
return;
}
		if (_fkSetByAssoc.has(a.fieldName)) {
return;
}
		const parentId = realIdByTempId.get(a.toId);
		if (parentId) {
			values[a.fieldName] = parentId;
			_fkSetByAssoc.add(a.fieldName);
		}
	});
	return values;
}
