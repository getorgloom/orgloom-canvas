// Bulk API v2 CSV serialization, result parsing, polling, and normalized row outcomes.
function csvEscape(value) {
	if (value === undefined) {
		return '';
	}
	if (value === null || value === '') {
		return '#N/A';
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
	return out.join('\n');
}

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
						cell += '"';
						i += 2;
						continue;
					}
					inQuotes = false;
					i++;
					continue;
				}
				cell += c;
				i++;
				continue;
			}
			if (c === '"') {
				inQuotes = true;
				i++;
				continue;
			}
			if (c === ',') {
				cells.push(cell);
				cell = '';
				i++;
				continue;
			}
			if (c === '\r') {
				i++;
				continue;
			}
			if (c === '\n') {
				i++;
				cells.push(cell);
				return cells;
			}
			cell += c;
			i++;
		}
		if (cell.length > 0 || cells.length > 0) {
			cells.push(cell);
			return cells;
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

export async function runBulkJob({
	// Job creation may accept the request before later processing fails; always inspect final job state.
	conn,
	apiBase,
	objectName,
	operation,
	records,
	columns,
	onEvent,
	externalIdFieldName,
}) {
	if (records.length === 0) {
		return { successes: [], failures: [] };
	}
	if (operation === 'upsert' && !externalIdFieldName) {
		throw new Error('runBulkJob upsert requires externalIdFieldName');
	}

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

	const csv = buildCsv(
		records.map((r) => r.values),
		columns,
	);
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
		throw new Error(
			'Bulk job ' + jobId + ' (' + objectName + ') did not complete in time. State=' + (status && status.state),
		);
	}

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
		console.warn('[bulk] success CSV fetch error:', e && e.message);
		return '';
	});
	const failedCsv = await fetchCsv('/failedResults/').catch((e) => {
		console.warn('[bulk] failed CSV fetch error:', e && e.message);
		return '';
	});
	const successRows = parseResultsCsv(successCsv);
	const failedRows = parseResultsCsv(failedCsv);

	function looseEq(a, b) {
		const aN = a == null || a === '' ? '' : String(a).trim();
		const bN = b == null || b === '' ? '' : String(b).trim();
		if (aN === bN) {
			return true;
		}
		const aNum = Number(aN),
			bNum = Number(bN);
		if (!isNaN(aNum) && !isNaN(bNum) && aNum === bNum) {
			return true;
		}
		const aDate = Date.parse(aN),
			bDate = Date.parse(bN);
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
		let sIdx = 0,
			fIdx = 0;
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
