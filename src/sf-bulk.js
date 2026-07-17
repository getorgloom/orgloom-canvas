// Bulk API v2 helpers: CSV building, result parsing, and the
// runBulkJob orchestrator (create job → upload CSV → close →
// poll → fetch results → match back to inputs). Pure-ish; no
// auth or DB. The route handler (/api/upload/bulk) owns the
// SSE wire and the audit/usage accounting.

function csvEscape(value) {
	// RFC4180-ish: double-quote fields with comma/quote/newline,
	// escape internal quotes by doubling.
	if (value === null || value === undefined) {
return '';
}
	const s = String(value);
	if (/[",\r\n]/.test(s)) {
return '"' + s.replace(/"/g, '""') + '"';
}
	return s;
}

export function buildCsv(rows, columns) {
	const out = [columns.join(',')];
	for (const row of rows) {
		out.push(columns.map((c) => csvEscape(row[c])).join(','));
	}
	// Bulk API requires LF line endings (we set lineEnding=LF on
	// the job).
	return out.join('\n');
}

// Parse a Bulk API result CSV. Tolerates quoted fields with embedded
// commas / newlines / doubled quotes. Returns an array of plain
// objects keyed by header column.
export function parseResultsCsv(text) {
	if (!text) {
return [];
}
	const rows = [];
	let i = 0;
	const len = text.length;
	function nextRow() {
		const cells = [];
		let cell = '';
		let inQuotes = false;
		while (i < len) {
			const c = text[i];
			if (inQuotes) {
				if (c === '"') {
					if (text[i + 1] === '"') {
 cell += '"'; i += 2; continue; 
}
					inQuotes = false; i++; continue;
				}
				cell += c; i++; continue;
			}
			if (c === '"') {
 inQuotes = true; i++; continue; 
}
			if (c === ',') {
 cells.push(cell); cell = ''; i++; continue; 
}
			if (c === '\r') {
 i++; continue; 
}
			if (c === '\n') {
 i++; cells.push(cell); return cells; 
}
			cell += c; i++;
		}
		if (cell.length > 0 || cells.length > 0) {
 cells.push(cell); return cells; 
}
		return null;
	}
	const header = nextRow();
	if (!header) {
return [];
}
	while (i < len) {
		const r = nextRow();
		if (!r) {
break;
}
		const obj = {};
		header.forEach((h, idx) => {
 obj[h] = r[idx] !== undefined ? r[idx] : ''; 
});
		rows.push(obj);
	}
	return rows;
}

// Run one Bulk API v2 ingest job to completion. Returns:
//   { successes: [{ tempId, sfId }], failures: [{ tempId, error }] }
// `records` is { tempId, values }; `columns` is the union of fields.
// `onEvent` (optional) receives progress events for SSE forwarding.
//
// Operations:
//   'insert': POST new records, sf__Id back in successfulResults.
//   'update': PATCH by Id; input row must have Id; sf__Id in result
//                matches the input Id.
//   'upsert': PATCH by an External Id custom field. Caller passes
//                `externalIdFieldName` (e.g. 'Customer_Number__c'); SF
//                looks up records by that field and inserts new ones if
//                no match, updates existing ones if match found.
//                Idempotent: re-running the same upsert input doesn't
//                duplicate. Input row carries the external id value in
//                the column matching externalIdFieldName.
export async function runBulkJob({ conn, apiBase, objectName, operation, records, columns, onEvent, externalIdFieldName }) {
	if (records.length === 0) {
return { successes: [], failures: [] };
}
	if (operation === 'upsert' && !externalIdFieldName) {
		throw new Error('runBulkJob upsert requires externalIdFieldName');
	}

	// Build job spec. Upsert adds externalIdFieldName per SF's Bulk API
	// v2 contract; the field must be a custom External Id (or the
	// standard Id field, but then it's effectively an upsert-or-insert).
	const jobSpec = {
		object: objectName,
		operation,
		contentType: 'CSV',
		lineEnding: 'LF',
	};
	if (operation === 'upsert') {
		jobSpec.externalIdFieldName = externalIdFieldName;
	}
	const job = await conn.request({
		method: 'POST',
		url: apiBase + '/jobs/ingest',
		body: JSON.stringify(jobSpec),
		headers: { 'Content-Type': 'application/json' },
	});
	const jobId = job && job.id;
	if (!jobId) {
throw new Error('Bulk job creation returned no id for ' + objectName);
}
	if (onEvent) {
onEvent({ phase: 'created', jobId, objectName, operation, count: records.length });
}

	const csv = buildCsv(records.map((r) => r.values), columns);
	await conn.request({
		method: 'PUT',
		url: apiBase + '/jobs/ingest/' + jobId + '/batches',
		body: csv,
		headers: { 'Content-Type': 'text/csv' },
	});
	await conn.request({
		method: 'PATCH',
		url: apiBase + '/jobs/ingest/' + jobId,
		body: JSON.stringify({ state: 'UploadComplete' }),
		headers: { 'Content-Type': 'application/json' },
	});

	// Poll until terminal state. Cap at 5 min (matches legacy).
	const deadline = Date.now() + 5 * 60 * 1000;
	let status;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 2000));
		status = await conn.request({ method: 'GET', url: apiBase + '/jobs/ingest/' + jobId });
		if (onEvent) {
			onEvent({
				phase: 'progress',
				jobId,
				objectName,
				operation,
				state: status.state,
				processed: status.numberRecordsProcessed || 0,
				failed: status.numberRecordsFailed || 0,
				total: records.length,
			});
		}
		if (status.state === 'JobComplete' || status.state === 'Failed' || status.state === 'Aborted') {
break;
}
	}
	if (!status || (status.state !== 'JobComplete' && status.state !== 'Failed')) {
		throw new Error('Bulk job ' + jobId + ' (' + objectName + ') did not complete in time. State=' + (status && status.state));
	}

	// Fetch result CSVs. jsforce's conn.request mishandles text/csv on
	// some versions, so go direct via fetch with the access token.
	async function fetchCsv(path) {
		const url = (conn.instanceUrl || '').replace(/\/+$/, '') + apiBase + '/jobs/ingest/' + jobId + path;
		const resp = await fetch(url, {
			method: 'GET',
			headers: {
				Authorization: 'Bearer ' + conn.accessToken,
				Accept: 'text/csv',
			},
		});
		if (!resp.ok) {
			console.warn('[bulk] result CSV fetch failed', objectName, path, resp.status);
			return '';
		}
		return await resp.text();
	}
	const successCsv = await fetchCsv('/successfulResults/').catch((e) => {
 console.warn('[bulk] success CSV fetch error:', e && e.message); return ''; 
});
	const failedCsv = await fetchCsv('/failedResults/').catch((e) => {
 console.warn('[bulk] failed CSV fetch error:', e && e.message); return ''; 
});
	const successRows = parseResultsCsv(successCsv);
	const failedRows = parseResultsCsv(failedCsv);

	// Match result rows back to inputs.
	//   UPDATE: by sf__Id == input.Id (Bulk echoes the Id verbatim).
	//   INSERT: walk in order, popping the head of whichever result
	//           file the next input belongs to (lenient field
	//           comparison decides).
	function looseEq(a, b) {
		const aN = (a == null || a === '') ? '' : String(a).trim();
		const bN = (b == null || b === '') ? '' : String(b).trim();
		if (aN === bN) {
return true;
}
		const aNum = Number(aN), bNum = Number(bN);
		if (!isNaN(aNum) && !isNaN(bNum) && aNum === bNum) {
return true;
}
		const aDate = Date.parse(aN), bDate = Date.parse(bN);
		if (!isNaN(aDate) && !isNaN(bDate) && aDate === bDate) {
return true;
}
		return false;
	}
	function rowsLooksLike(input, result) {
		let hits = 0;
		for (const c of columns) {
if (looseEq(input[c], result[c])) {
hits++;
}
}
		return hits;
	}

	const inputs = records.map((r) => r.values);
	const successes = [];
	const failures = [];

	if (operation === 'update') {
		const successById = new Map();
		successRows.forEach((r) => {
			const id = r['sf__Id'] || r.Id;
			if (id) {
successById.set(id, r);
}
		});
		const failedById = new Map();
		failedRows.forEach((r) => {
			const id = r['sf__Id'] || r.Id;
			if (id) {
failedById.set(id, r);
}
		});
		records.forEach((rec, i) => {
			const inputId = inputs[i].Id;
			if (!inputId) {
				failures.push({ tempId: rec.tempId, error: 'Update row had no Id field.' });
				return;
			}
			if (successById.has(inputId)) {
				successes.push({ tempId: rec.tempId, sfId: inputId });
				return;
			}
			if (failedById.has(inputId)) {
				failures.push({ tempId: rec.tempId, error: failedById.get(inputId)['sf__Error'] || 'Update failed' });
				return;
			}
			failures.push({ tempId: rec.tempId, error: 'No result row returned by Salesforce.' });
		});
	} else if (operation === 'upsert') {
		// Match by the external id field value. SF echoes the external
		// id column back in both success + failed result CSVs, so we
		// can key off it. The successful result row also contains
		// sf__Id (the resolved record id, existing if matched, new if
		// inserted) and sf__Created (true/false), which we surface to
		// the caller so they can distinguish updates from inserts.
		const successByExtId = new Map();
		successRows.forEach((r) => {
			const k = r[externalIdFieldName];
			if (k) {
successByExtId.set(k, r);
}
		});
		const failedByExtId = new Map();
		failedRows.forEach((r) => {
			const k = r[externalIdFieldName];
			if (k) {
failedByExtId.set(k, r);
}
		});
		records.forEach((rec, i) => {
			const extKey = inputs[i][externalIdFieldName];
			if (!extKey) {
				failures.push({ tempId: rec.tempId, error: 'Upsert row had no ' + externalIdFieldName + ' value.' });
				return;
			}
			if (successByExtId.has(extKey)) {
				const r = successByExtId.get(extKey);
				successes.push({
					tempId: rec.tempId,
					sfId: r['sf__Id'] || r.Id,
					// sf__Created is the SF Bulk API's idempotency flag:
					// "true" string when the row resulted in an insert,
					// "false" when it matched and updated an existing
					// record. Surface so callers can show "3 created,
					// 7 updated" in the post-upload toast.
					created: r['sf__Created'] === 'true',
				});
				return;
			}
			if (failedByExtId.has(extKey)) {
				failures.push({ tempId: rec.tempId, error: failedByExtId.get(extKey)['sf__Error'] || 'Upsert failed' });
				return;
			}
			failures.push({ tempId: rec.tempId, error: 'No result row returned by Salesforce for upsert.' });
		});
	} else {
		let sIdx = 0, fIdx = 0;
		for (let i = 0; i < inputs.length; i++) {
			const input = inputs[i];
			const successHead = sIdx < successRows.length ? successRows[sIdx] : null;
			const failedHead = fIdx < failedRows.length ? failedRows[fIdx] : null;
			const sScore = successHead ? rowsLooksLike(input, successHead) : -1;
			const fScore = failedHead ? rowsLooksLike(input, failedHead) : -1;
			if (sScore < 0 && fScore < 0) {
				failures.push({ tempId: records[i].tempId, error: 'No result row returned by Salesforce.' });
				continue;
			}
			// Tie-break toward success: most rows succeed; mistakenly
			// classifying a real failure as success surfaces as a
			// missing real-id later. The opposite (success → failure)
			// is the worse outcome: spooks the user with errors that
			// don't match SF reality.
			if (sScore >= fScore && successHead) {
				successes.push({ tempId: records[i].tempId, sfId: successHead['sf__Id'] || successHead.Id });
				sIdx++;
			} else if (failedHead) {
				failures.push({ tempId: records[i].tempId, error: failedHead['sf__Error'] || 'Insert failed' });
				fIdx++;
			} else if (successHead) {
				successes.push({ tempId: records[i].tempId, sfId: successHead['sf__Id'] || successHead.Id });
				sIdx++;
			}
		}
		while (fIdx < failedRows.length) {
			failures.push({ tempId: null, error: failedRows[fIdx]['sf__Error'] || 'Unknown error' });
			fIdx++;
		}
	}

	return { successes, failures };
}
