
import { isWritableForOperation } from './sf-field-structure.js';

export const FAKE_REF_ID = '001000000000001';

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

export function makeDescribeCache(conn) {
	const cache = new Map();
	return async function getDescribe(objectName) {
		if (!cache.has(objectName)) {
			const pending = withSfRetry(() => conn.sobject(objectName).describe())
				.catch((err) => {
					cache.delete(objectName);
					throw err;
				});
			cache.set(objectName, pending);
		}
		return await cache.get(objectName);
	};
}

export function stripUnwritableFields(values, describe, isUpdate) {
	if (!values || !describe || !Array.isArray(describe.fields)) {
return Object.assign({}, values || {});
}
	const writable = new Set();
	describe.fields.forEach((f) => {
		if (!f || !f.name) {
return;
}
		const operation = isUpdate === 'upsert' ? 'upsert' : (isUpdate ? 'update' : 'create');
		const writableForOperation = isWritableForOperation(f, operation);
		if (writableForOperation) {
writable.add(f.name);
}
	});
	const out = {};
	Object.keys(values).forEach((k) => {
		if (k === 'Id' || writable.has(k)) {
out[k] = values[k];
}
	});
	return out;
}

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

export const SYSTEM_RO_FIELDS = new Set([
	'Id', 'IsDeleted', 'CreatedDate', 'CreatedById',
	'LastModifiedDate', 'LastModifiedById', 'SystemModstamp',
	'LastActivityDate', 'LastViewedDate', 'LastReferencedDate',
]);

export const GRAPH_PER_GRAPH_CAP = 75;
export const GRAPH_TOTAL_NODES_CAP = 500;

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

export function graphRefIdFor(tempId) {
	return 'r' + String(tempId).replace(/[^a-zA-Z0-9]/g, '_');
}

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
