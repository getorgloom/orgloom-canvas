// Salesforce upload mechanics. Routes own policy, authorization, audit, and usage accounting.
import { isWritableForOperation } from './sf-field-structure.js';
import { specializedObjectError, specializedObjectNamesFromPayload } from './sf-object-support.js';

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

export function rejectIfUploadOrgChanged(req, res) {
	const expectedSfOrgId = String(req.body?.expectedSfOrgId || '').trim();
	if (!expectedSfOrgId || expectedSfOrgId === req.sf?.sfOrgId) {
		return false;
	}
	res.status(409).json({
		error: 'active-org-changed',
		message:
			'Your active Salesforce org changed while this upload was being prepared. Nothing was uploaded. Reconnect to the intended org, then reopen this upload.',
	});
	return true;
}

export function rejectSpecializedUploadObjects(req, res) {
	const objects = specializedObjectNamesFromPayload(req.body);
	if (objects.length === 0) {
		return false;
	}
	res.status(400).json(specializedObjectError(objects));
	return true;
}

export function rejectCanvasUploadArtifacts(req, res) {
	const records = []
		.concat(Array.isArray(req.body?.records) ? req.body.records : [])
		.concat(Array.isArray(req.body?.deletes) ? req.body.deletes : []);
	const hasUploadableValue = (record) =>
		Object.entries((record && record.values) || {}).some(
			([fieldName, value]) =>
				fieldName !== 'Id' &&
				fieldName !== 'attributes' &&
				!fieldName.startsWith('_') &&
				value != null &&
				value !== '',
		);
	const invalid = records.find(
		(record) =>
			record &&
			(record.isTypeNode ||
				record.isPending ||
				record._inaccessible ||
				record.canvasArtifact === true ||
				(record.slot &&
					(record.slot.kind || 'whole-record') === 'whole-record' &&
					!record.loadedFromId &&
					!hasUploadableValue(record))),
	);
	if (!invalid) {
		return false;
	}
	res.status(400).json({
		error: 'canvas-item-not-uploadable',
		message:
			'An unfinished request or other canvas-only item reached the upload endpoint. Nothing was written. Reopen Upload and try again.',
	});
	return true;
}

export async function withSfRetry(fn, { maxAttempts = 4, baseDelay = 500 } = {}) {
	// Retry only Salesforce rate limits; validation and permission failures are deterministic.
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
			const pending = withSfRetry(() => conn.sobject(objectName).describe()).catch((err) => {
				cache.delete(objectName);
				throw err;
			});
			cache.set(objectName, pending);
		}
		return await cache.get(objectName);
	};
}

export function stripUnwritableFields(values, describe, isUpdate) {
	// Compound fields are read projections; uploads use their writable component fields.
	if (!values || !describe || !Array.isArray(describe.fields)) {
		return Object.assign({}, values || {});
	}
	const writable = new Set();
	describe.fields.forEach((f) => {
		if (!f || !f.name) {
			return;
		}
		const operation = isUpdate === 'upsert' ? 'upsert' : isUpdate ? 'update' : 'create';
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

export function normalizeTimeFieldsForSalesforce(values, describe) {
	const out = Object.assign({}, values || {});
	if (!describe || !Array.isArray(describe.fields)) {
		return out;
	}
	for (const field of describe.fields) {
		if (!field || field.type !== 'time' || !Object.prototype.hasOwnProperty.call(out, field.name)) {
			continue;
		}
		const value = out[field.name];
		if (value == null || value === '') {
			continue;
		}
		const match = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z)?$/.exec(String(value).trim());
		if (!match) {
			continue;
		}
		const parts = match[0].replace(/Z$/, '').split(':');
		const seconds = parts[2] || '00';
		const secondParts = seconds.split('.');
		const milliseconds = (secondParts[1] || '').padEnd(3, '0').slice(0, 3);
		out[field.name] = parts[0] + ':' + parts[1] + ':' + secondParts[0] + '.' + milliseconds + 'Z';
	}
	return out;
}

export function normalizeGeolocationFieldsForSalesforce(values, describe) {
	const out = Object.assign({}, values || {});
	if (!describe || !Array.isArray(describe.fields)) {
		return out;
	}
	const locationNames = new Set(
		describe.fields.filter((field) => field && field.name && field.type === 'location').map((field) => field.name),
	);
	for (const field of describe.fields) {
		if (
			!field ||
			!field.name ||
			!locationNames.has(field.compoundFieldName) ||
			!/(?:Latitude|Longitude)(?:__s)?$/i.test(field.name) ||
			!Object.prototype.hasOwnProperty.call(out, field.name) ||
			!Number.isInteger(field.scale) ||
			field.scale < 0
		) {
			continue;
		}
		const value = out[field.name];
		if (value === null || value === undefined || value === '') {
			continue;
		}
		const text = String(value).trim();
		const match = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(text);
		if (!match) {
			continue;
		}
		const fraction = match[3] || '';
		if (fraction.length <= field.scale) {
			continue;
		}
		out[field.name] =
			field.scale === 0 ? match[1] + match[2] : match[1] + match[2] + '.' + fraction.slice(0, field.scale);
	}
	return out;
}

export function normalizeRichTextFieldsForSalesforce(values, describe) {
	const out = Object.assign({}, values || {});
	if (!describe || !Array.isArray(describe.fields)) {
		return out;
	}
	for (const field of describe.fields) {
		if (
			!field ||
			field.type !== 'textarea' ||
			field.htmlFormatted !== true ||
			!Object.prototype.hasOwnProperty.call(out, field.name)
		) {
			continue;
		}
		const value = out[field.name];
		if (typeof value !== 'string' || value === '') {
			continue;
		}
		// The Org Loom record editor is plain text. Encode every value before sending it
		// to Salesforce so entity syntax and HTML-looking input remain literal.
		out[field.name] = value
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/\r\n?|\n/g, '<br>');
	}
	return out;
}

export function normalizeFieldsForSalesforce(values, describe) {
	return normalizeRichTextFieldsForSalesforce(
		normalizeGeolocationFieldsForSalesforce(normalizeTimeFieldsForSalesforce(values, describe), describe),
		describe,
	);
}

export function uploadValuesEquivalent(a, b) {
	if (a === b) {
		return true;
	}
	const sa = a == null ? '' : String(a).trim();
	const sb = b == null ? '' : String(b).trim();
	if (sa === sb) {
		return true;
	}
	if (sa === '' || sb === '') {
		return false;
	}
	const na = Number(sa);
	const nb = Number(sb);
	if (!Number.isNaN(na) && !Number.isNaN(nb) && na === nb) {
		return true;
	}
	const lowA = sa.toLowerCase();
	const lowB = sb.toLowerCase();
	if ((lowA === 'true' || lowA === 'false') && (lowB === 'true' || lowB === 'false')) {
		return lowA === lowB;
	}
	if (/\d{4}-\d{2}-\d{2}/.test(sa) && /\d{4}-\d{2}-\d{2}/.test(sb)) {
		const ta = Date.parse(sa);
		const tb = Date.parse(sb);
		if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta === tb) {
			return true;
		}
	}
	return false;
}

export function changedValuesForUpdate(rec) {
	const current = (rec && rec.values) || {};
	const baseline = rec && rec.loadedValues;
	const explicitFields = new Set(Array.isArray(rec?.explicitFields) ? rec.explicitFields : []);
	if (!baseline || typeof baseline !== 'object') {
		return Object.assign({}, current);
	}
	const changed = {};
	for (const fieldName of Object.keys(current)) {
		if (explicitFields.has(fieldName) || !uploadValuesEquivalent(current[fieldName], baseline[fieldName])) {
			changed[fieldName] = current[fieldName];
		}
	}
	return changed;
}

export function salesforceIdsEquivalent(a, b) {
	if (a == null || a === '' || b == null || b === '') {
		return a == null || a === '' ? b == null || b === '' : false;
	}
	return String(a).slice(0, 15) === String(b).slice(0, 15);
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
	// Parent drafts must be inserted before children whose lookups need the parents' new IDs.
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
		const parent = recordsById.get(a.toId);
		if (!parent) {
			return;
		}
		// Existing Salesforce records already have stable IDs. They do not need to be
		// uploaded before a child can reference them, and counting that edge can turn
		// a resolvable existing-record/draft pair into a false reference cycle.
		if (parent.loadedFromId) {
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

export function existingRecordIdsByTempId(records) {
	const ids = new Map();
	(records || []).forEach((record) => {
		if (record && record.tempId != null && record.loadedFromId) {
			ids.set(record.tempId, record.loadedFromId);
		}
	});
	return ids;
}

export function isSafeGraphFallbackFailure(result) {
	if (!result || result.success) {
		return false;
	}
	if (result.errorCode === 'JSON_PARSER_ERROR') {
		return true;
	}
	return (
		result.errorCode === 'PROCESSING_HALTED' &&
		/limit of number of types of operations in a graph call reached/i.test(String(result.error || ''))
	);
}

export const SYSTEM_RO_FIELDS = new Set([
	'Id',
	'IsDeleted',
	'CreatedDate',
	'CreatedById',
	'LastModifiedDate',
	'LastModifiedById',
	'SystemModstamp',
	'LastActivityDate',
	'LastViewedDate',
	'LastReferencedDate',
]);

export const GRAPH_PER_GRAPH_CAP = 75;
export const GRAPH_TOTAL_NODES_CAP = 500;

export function groupConnectedComponents(submittedIds, submittedOrder, associations) {
	// Each component is atomic independently, limiting rollback to related records.
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
			for (const neighbor of adj.get(cur) || []) {
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

function graphDiagnosticValue(value) {
	if (value == null) {
		return { type: 'null' };
	}
	if (typeof value === 'string') {
		const looksStructured = /^\s*[\[{]/.test(value);
		let structuredJsonValid;
		if (looksStructured) {
			try {
				JSON.parse(value);
				structuredJsonValid = true;
			} catch (_) {
				structuredJsonValid = false;
			}
		}
		return {
			type: 'string',
			length: value.length,
			hasControl: /[\u0000-\u001f\u007f]/.test(value) || undefined,
			hasNewline: /[\r\n]/.test(value) || undefined,
			hasQuote: value.includes('"') || undefined,
			hasBackslash: value.includes('\\') || undefined,
			looksStructured: looksStructured || undefined,
			structuredJsonValid,
		};
	}
	if (Array.isArray(value)) {
		return { type: 'array', length: value.length };
	}
	if (typeof value === 'object') {
		return { type: 'object', keys: Object.keys(value).slice(0, 12) };
	}
	if (typeof value === 'number') {
		return { type: 'number', finite: Number.isFinite(value) };
	}
	return { type: typeof value };
}

export function summarizeGraphPayloadForDiagnostics(graphsPayload, referenceIds) {
	const wanted = referenceIds ? new Set(referenceIds) : null;
	let remaining = 12;
	return (graphsPayload || [])
		.map((graph) => {
			const requests = ((graph && graph.compositeRequest) || [])
				.filter((request) => !wanted || wanted.has(request && request.referenceId))
				.slice(0, remaining)
				.map((request) => {
					const body = (request && request.body) || {};
					return {
						referenceId: request && request.referenceId,
						method: request && request.method,
						objectName:
							request && typeof request.url === 'string'
								? decodeURIComponent((/\/sobjects\/([^/]+)/.exec(request.url) || [])[1] || '') ||
									undefined
								: undefined,
						bodyBytes: Buffer.byteLength(JSON.stringify(body), 'utf8'),
						fieldNames: Object.keys(body).slice(0, 80),
						nonNullFields: Object.entries(body)
							.filter(([, value]) => value != null)
							.slice(0, 40)
							.map(([name, value]) => ({ name, ...graphDiagnosticValue(value) })),
					};
				});
			remaining -= requests.length;
			return { graphId: graph && graph.graphId, requests };
		})
		.filter((graph) => graph.requests.length > 0 && remaining >= 0);
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
	let values = rec.loadedFromId ? changedValuesForUpdate(rec) : Object.assign({}, rec.values || {});
	const describe = describesByObject.get(rec.objectName);
	if (!describe) {
		const error = new Error('Salesforce field information is required before building an upload request.');
		error.code = 'salesforce-field-metadata-unavailable';
		throw error;
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
			if (
				!rec.loadedFromId ||
				!salesforceIdsEquivalent((rec.loadedValues || {})[a.fieldName], parent.loadedFromId)
			) {
				values[a.fieldName] = parent.loadedFromId;
			}
		} else if (submittedIds.has(a.toId)) {
			values[a.fieldName] = '@{' + graphRefIdFor(a.toId) + '.id}';
		}
	});
	values = normalizeFieldsForSalesforce(stripUnwritableFields(values, describe, !!rec.loadedFromId), describe);
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
	const values = rec.loadedFromId ? changedValuesForUpdate(rec) : Object.assign({}, rec.values || {});
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
			if (!rec.loadedFromId || !salesforceIdsEquivalent((rec.loadedValues || {})[a.fieldName], parentId)) {
				values[a.fieldName] = parentId;
			}
			_fkSetByAssoc.add(a.fieldName);
		}
	});
	return values;
}
