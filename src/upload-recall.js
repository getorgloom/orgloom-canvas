import { escapeSoqlLiteral } from './sf-soql.js';

const _SF_OBJECT_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;

const _SF_FIELD_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_.]*$/;

async function _queryAll(conn, soql) {
	const apiVersion = conn.version || '60.0';
	const url = '/services/data/v' + apiVersion +
		'/queryAll/?q=' + encodeURIComponent(soql);
	return conn.request({ method: 'GET', url });
}

export function planDeleteOrder(insertedIds, associations) {
	if (!Array.isArray(insertedIds) || insertedIds.length === 0) {
return [];
}
	const valid = insertedIds.filter((r) => r && r.tempId != null && r.sfId);
	if (valid.length === 0) {
return [];
}

	const dependents = new Map();
	valid.forEach((r) => dependents.set(r.tempId, new Set()));
	(associations || []).forEach((a) => {
		if (!a || a.fromTempId == null || a.toTempId == null) {
return;
}

		if (dependents.has(a.toTempId)) {
dependents.get(a.toTempId).add(a.fromTempId);
}
	});

	const level = new Map();
	function compute(tempId, stack) {
		if (level.has(tempId)) {
return level.get(tempId);
}
		if (stack.has(tempId)) {
 level.set(tempId, 0); return 0; 
}
		stack.add(tempId);
		let max = -1;
		for (const child of (dependents.get(tempId) || [])) {
			const cl = compute(child, stack);
			if (cl > max) {
max = cl;
}
		}
		stack.delete(tempId);
		const l = max + 1;
		level.set(tempId, l);
		return l;
	}
	valid.forEach((r) => compute(r.tempId, new Set()));

	const byLevel = new Map();
	valid.forEach((r) => {
		const lvl = level.get(r.tempId) || 0;
		if (!byLevel.has(lvl)) {
byLevel.set(lvl, []);
}
		byLevel.get(lvl).push(r);
	});
	return Array.from(byLevel.keys()).sort((a, b) => a - b).map((l) => byLevel.get(l));
}

export async function classifyBatchDrift({ conn, batch, uploaderSfUserId, uploadTimeMs, gracePeriodMs = 60 * 60 * 1000 }) {
	const insertedIds = (batch && batch.insertedIds) || [];
	if (insertedIds.length === 0) {
		return { clean: [], drifted: [], alreadyDeleted: [], updates: [], unverified: [] };
	}

	const createRows = [];
	const updateRows = [];
	for (const r of insertedIds) {
		if (!r) {
continue;
}
		if (r.mode === 'update') {
updateRows.push(r);
} else {
createRows.push(r);
}
	}
	if (createRows.length === 0) {

		return { clean: [], drifted: [], alreadyDeleted: [], updates: updateRows, unverified: [] };
	}

	const byObject = new Map();
	for (const r of createRows) {
		if (!r || !r.sfId || !r.objectName) {
continue;
}
		if (!byObject.has(r.objectName)) {
byObject.set(r.objectName, []);
}
		byObject.get(r.objectName).push(r);
	}

	const idKey = (id) => (id ? String(id).slice(0, 15) : '');
	const sfStateById = new Map();
	const queryErrorByObject = new Map();
	for (const [objName, recs] of byObject) {

		if (!_SF_OBJECT_NAME_RE.test(objName)) {
continue;
}
		const ids = recs.map((r) => r.sfId);
		for (let i = 0; i < ids.length; i += 200) {
			const slice = ids.slice(i, i + 200);
			const inList = slice.map((id) => "'" + escapeSoqlLiteral(id) + "'").join(',');
			const soql =
				'SELECT Id, LastModifiedById, LastModifiedDate, IsDeleted ' +
				'FROM ' + objName + ' WHERE Id IN (' + inList + ')';
			try {
				const r = await _queryAll(conn, soql);
				(r.records || []).forEach((rec) => {
					sfStateById.set(idKey(rec.Id), {
						LastModifiedById: rec.LastModifiedById,
						LastModifiedDate: rec.LastModifiedDate,
						IsDeleted: !!rec.IsDeleted,
					});
				});
			} catch (e) {

				const msg = (e && (e.errorCode ? e.errorCode + ': ' : '') + (e.message || String(e))) || 'queryAll failed';
				if (!queryErrorByObject.has(objName)) {
queryErrorByObject.set(objName, msg);
}
				console.warn('[recall/classify] queryAll failed for', objName + ':', msg);
			}
		}
	}

	const norm = (id) => (id ? String(id).slice(0, 15) : '');
	const uploaderShort = norm(uploaderSfUserId);
	const cutoffTime = (uploadTimeMs || 0) + (gracePeriodMs || 0);

	const clean = [];
	const drifted = [];
	const alreadyDeleted = [];
	const unverified = [];

	for (const r of createRows) {
		if (!r || !r.sfId) {
continue;
}
		const state = sfStateById.get(idKey(r.sfId));

		if (!state && queryErrorByObject.has(r.objectName)) {
			unverified.push(Object.assign({}, r, {
				probeError: queryErrorByObject.get(r.objectName),
			}));
			continue;
		}

		if (!state || state.IsDeleted) {
			alreadyDeleted.push(Object.assign({}, r));
			continue;
		}
		const modifierShort = norm(state.LastModifiedById);
		const modifiedAt = state.LastModifiedDate ? new Date(state.LastModifiedDate).getTime() : 0;
		const enriched = Object.assign({}, r, {
			lastModifiedById: state.LastModifiedById,
			lastModifiedDate: state.LastModifiedDate,
		});

		if (uploaderShort && modifierShort && modifierShort !== uploaderShort) {
			enriched.driftReason = 'modified_by_other_user';
			drifted.push(enriched);
			continue;
		}

		if (cutoffTime > 0 && modifiedAt > cutoffTime) {
			enriched.driftReason = 'modified_after_upload_window';
			drifted.push(enriched);
			continue;
		}

		clean.push(enriched);
	}

	return { clean, drifted, alreadyDeleted, updates: updateRows, unverified };
}

export async function classifyValueDrift({ conn, batch }) {
	const insertedIds = (batch && batch.insertedIds) || [];
	const updateRows = insertedIds.filter((r) =>
		r && r.mode === 'update'
		&& r.sfId
		&& r.objectName
		&& r.priorValues
		&& r.uploadedValues
		&& Object.keys(r.uploadedValues).length > 0
	);
	if (updateRows.length === 0) {
		return {
			records: [],
			summary: {
				eligibleRecords: 0,
				driftedRecords: 0,
				cleanFieldCount: 0,
				driftedFieldCount: 0,
			},
		};
	}

	const byObject = new Map();
	for (const r of updateRows) {
		if (!byObject.has(r.objectName)) {
			byObject.set(r.objectName, { rows: [], fieldSet: new Set(['Id']) });
		}
		const entry = byObject.get(r.objectName);
		entry.rows.push(r);
		for (const f of Object.keys(r.uploadedValues)) {
			if (f && !f.startsWith('_')) {
entry.fieldSet.add(f);
}
		}
	}

	const idKey = (id) => (id ? String(id).slice(0, 15) : '');
	const sfCurrentById = new Map();
	for (const [objName, entry] of byObject) {
		if (!_SF_OBJECT_NAME_RE.test(objName)) {
continue;
}
		const fieldList = Array.from(entry.fieldSet)
			.filter((f) => _SF_FIELD_NAME_RE.test(f))
			.join(', ');
		if (!fieldList) {
continue;
}
		const ids = entry.rows.map((r) => r.sfId);
		for (let i = 0; i < ids.length; i += 200) {
			const slice = ids.slice(i, i + 200);
			const inList = slice.map((id) => "'" + escapeSoqlLiteral(id) + "'").join(',');
			const soql =
				'SELECT ' + fieldList + ' FROM ' + objName +
				' WHERE Id IN (' + inList + ')';
			try {
				const r = await _queryAll(conn, soql);
				(r.records || []).forEach((rec) => {
					sfCurrentById.set(idKey(rec.Id), rec);
				});
			} catch (e) {

			}
		}
	}

	const recordsOut = [];
	let totalClean = 0;
	let totalDrifted = 0;
	let driftedRecordCount = 0;
	for (const row of updateRows) {
		const sfRec = sfCurrentById.get(idKey(row.sfId));
		if (!sfRec) {
			recordsOut.push({
				tempId: row.tempId,
				sfId: row.sfId,
				objectName: row.objectName,
				label: row.label || null,
				clean: [],
				drifted: [],
				reverted: [],
				notFound: true,
			});
			continue;
		}
		const clean = [];
		const drifted = [];
		const reverted = [];
		for (const fieldName of Object.keys(row.uploadedValues)) {
			if (!fieldName || fieldName.startsWith('_')) {
continue;
}
			const uploaded = row.uploadedValues[fieldName];
			const prior = row.priorValues ? row.priorValues[fieldName] : null;
			const current = sfRec[fieldName];

			const matchesUploaded = uploaded == current;

			const matchesPrior = prior == current;
			const cell = { fieldName, prior, uploaded, current };
			if (matchesPrior) {
				reverted.push(cell);
			} else if (matchesUploaded) {
				clean.push(cell);
			} else {
				drifted.push(cell);
			}
		}
		recordsOut.push({
			tempId: row.tempId,
			sfId: row.sfId,
			objectName: row.objectName,
			label: row.label || null,
			clean,
			drifted,
			reverted,
			notFound: false,
		});
		totalClean += clean.length;
		totalDrifted += drifted.length;
		if (drifted.length > 0) {
driftedRecordCount++;
}
	}

	return {
		records: recordsOut,
		summary: {
			eligibleRecords: updateRows.length,
			driftedRecords: driftedRecordCount,
			cleanFieldCount: totalClean,
			driftedFieldCount: totalDrifted,
		},
	};
}

export async function detectCascadeConflicts({ conn, batch, classification }) {
	const associations = (batch && batch.associations) || [];
	const insertedIds = (batch && batch.insertedIds) || [];
	if (associations.length === 0 || insertedIds.length === 0) {
return [];
}

	const cleanSfIds = new Set((classification.clean || []).map((r) => r.sfId));
	const driftedSfIds = new Set((classification.drifted || []).map((r) => r.sfId));
	const updatesSfIds = new Set((classification.updates || []).map((r) => r.sfId));
	if (cleanSfIds.size === 0 || (driftedSfIds.size === 0 && updatesSfIds.size === 0)) {
return [];
}

	const insertedByTempId = new Map();
	for (const r of insertedIds) {
		if (r && r.tempId != null) {
insertedByTempId.set(r.tempId, r);
}
	}

	const fieldsToCheck = new Map();
	for (const a of associations) {
		if (!a) {
continue;
}
		const child = insertedByTempId.get(a.fromTempId);
		if (!child || !child.objectName || !a.fieldName) {
continue;
}
		if (!fieldsToCheck.has(child.objectName)) {
fieldsToCheck.set(child.objectName, new Set());
}
		fieldsToCheck.get(child.objectName).add(a.fieldName);
	}

	const masterDetailByObj = new Map();
	for (const [objName, fieldSet] of fieldsToCheck) {
		try {
			const desc = await conn.sobject(objName).describe();
			const md = new Set();
			for (const f of (desc.fields || [])) {
				if (f.cascadeDelete === true && fieldSet.has(f.name)) {
md.add(f.name);
}
			}
			masterDetailByObj.set(objName, md);
		} catch (e) {

		}
	}

	const conflicts = [];
	for (const a of associations) {
		if (!a) {
continue;
}
		const child = insertedByTempId.get(a.fromTempId);
		const parent = insertedByTempId.get(a.toTempId);
		if (!child || !parent || !child.sfId || !parent.sfId) {
continue;
}
		const md = masterDetailByObj.get(child.objectName);
		if (!md || !md.has(a.fieldName)) {
continue;
}
		if (!cleanSfIds.has(parent.sfId)) {
continue;
}
		let childBucket = null;
		if (driftedSfIds.has(child.sfId)) {
childBucket = 'drifted';
} else if (updatesSfIds.has(child.sfId)) {
childBucket = 'updates';
}
		if (!childBucket) {
continue;
}
		conflicts.push({
			parentSfId: parent.sfId,
			parentObjectName: parent.objectName,
			childSfId: child.sfId,
			childObjectName: child.objectName,
			fieldName: a.fieldName,
			childBucket,
		});
	}
	return conflicts;
}

async function deleteChunk(conn, apiBase, ids) {
	if (ids.length === 0) {
return [];
}
	const url = apiBase + '/composite/sobjects?ids=' + encodeURIComponent(ids.join(',')) + '&allOrNone=false';
	const resp = await conn.request({ method: 'DELETE', url });
	return Array.isArray(resp) ? resp : [];
}

export async function executeRecall({ conn, batch, skipSfIds, revertSelections }) {
	if (!conn) {
throw new Error('executeRecall requires a jsforce Connection');
}
	const apiVersion = conn.version || '60.0';
	const apiBase = '/services/data/v' + apiVersion;
	const skipSet = skipSfIds instanceof Set
		? skipSfIds
		: new Set(Array.isArray(skipSfIds) ? skipSfIds : []);

	const revertMap = new Map();
	if (Array.isArray(revertSelections)) {
		for (const entry of revertSelections) {
			if (!entry || !entry.sfId || !Array.isArray(entry.fields)) {
continue;
}
			const fields = entry.fields.filter((f) => f && !f.startsWith('_'));
			if (fields.length === 0) {
continue;
}
			revertMap.set(String(entry.sfId), new Set(fields));
		}
	}

	const rawRows = batch.insertedIds || [];
	const preservedUpdates = rawRows.filter((r) => r && r.mode === 'update');
	const recallableRows = rawRows.filter((r) => r && r.mode !== 'update');

	let revertedCount = 0;
	let revertFailedCount = 0;
	const revertResults = [];
	if (revertMap.size > 0) {

		const revertByObject = new Map();
		for (const row of preservedUpdates) {
			if (!row || !row.sfId) {
continue;
}
			const fields = revertMap.get(String(row.sfId));
			if (!fields || fields.size === 0) {
continue;
}
			if (!row.priorValues) {
continue;
}
			if (!revertByObject.has(row.objectName)) {
revertByObject.set(row.objectName, []);
}
			revertByObject.get(row.objectName).push({ row, fields });
		}
		for (const [objName, entries] of revertByObject) {
			for (const { row, fields } of entries) {
				const patch = { Id: row.sfId };
				for (const fieldName of fields) {
					if (!fieldName || fieldName.startsWith('_')) {
continue;
}

					patch[fieldName] = row.priorValues[fieldName] == null
						? null
						: row.priorValues[fieldName];
				}
				try {
					const r = await conn.sobject(objName).update(patch);
					if (r && r.success) {
						revertedCount++;
						revertResults.push({
							sfId: row.sfId,
							objectName: objName,
							success: true,
							fieldsReverted: Array.from(fields),
						});
					} else {
						revertFailedCount++;
						const errs = (r && r.errors) || [];
						revertResults.push({
							sfId: row.sfId,
							objectName: objName,
							success: false,
							error: errs.map((e) => e.message || e).join('; ') || 'unknown',
						});
					}
				} catch (e) {
					revertFailedCount++;
					revertResults.push({
						sfId: row.sfId,
						objectName: objName,
						success: false,
						error: (e && e.message) || 'PATCH failed',
					});
				}
			}
		}
	}

	const insertedToRecall = recallableRows.filter(
		(r) => !(r && r.sfId && skipSet.has(r.sfId)),
	);
	const filteredBatch = Object.assign({}, batch, { insertedIds: insertedToRecall });
	const levels = planDeleteOrder(filteredBatch.insertedIds, filteredBatch.associations || []);

	const idsByObject = new Map();
	insertedToRecall.forEach((r) => {
		if (!r || !r.sfId || !r.objectName) {
return;
}
		if (!idsByObject.has(r.objectName)) {
idsByObject.set(r.objectName, []);
}
		idsByObject.get(r.objectName).push(r.sfId);
	});

	const preDeletedKey = (id) => (id ? String(id).slice(0, 15) : '');
	const preDeletedSfIds = new Set();
	for (const [objName, ids] of idsByObject) {
		if (!_SF_OBJECT_NAME_RE.test(objName)) {
continue;
}
		for (let i = 0; i < ids.length; i += 200) {
			const slice = ids.slice(i, i + 200);
			const inList = slice.map((id) => "'" + escapeSoqlLiteral(id) + "'").join(',');
			const soql = 'SELECT Id FROM ' + objName + ' WHERE Id IN (' + inList + ') AND IsDeleted = TRUE';
			try {
				const r = await _queryAll(conn, soql);
				(r.records || []).forEach((rec) => preDeletedSfIds.add(preDeletedKey(rec.Id)));
			} catch (e) {                                             }
		}
	}

	const results = [];
	let succeeded = 0;
	let alreadyDeleted = 0;
	let failed = 0;

	for (const levelRecs of levels) {
		const CHUNK = 200;
		for (let i = 0; i < levelRecs.length; i += CHUNK) {
			const chunk = levelRecs.slice(i, i + CHUNK);
			let perIdResults;
			try {
				perIdResults = await deleteChunk(conn, apiBase, chunk.map((r) => r.sfId));
			} catch (err) {

				const msg = (err && err.message) || 'Recall request failed';
				chunk.forEach((rec) => {
					results.push({
						tempId: rec.tempId, sfId: rec.sfId, objectName: rec.objectName,
						label: rec.label || null, success: false, error: msg,
					});
					failed++;
				});
				continue;
			}
			perIdResults.forEach((r, idx) => {
				const rec = chunk[idx];
				if (r && r.success) {

					if (preDeletedSfIds.has(preDeletedKey(rec.sfId))) {
						results.push({
							tempId: rec.tempId, sfId: rec.sfId, objectName: rec.objectName,
							label: rec.label || null, success: true, note: 'Already deleted',
						});
						alreadyDeleted++;
						return;
					}
					results.push({
						tempId: rec.tempId, sfId: rec.sfId, objectName: rec.objectName,
						label: rec.label || null, success: true,
					});
					succeeded++;
					return;
				}
				const errs = (r && r.errors) || [];
				const errCode = (errs[0] && errs[0].statusCode) || null;
				const errMsg = errs.map((e) => e.message || e.statusCode || 'Unknown error').join('; ') || 'Delete failed';

				if (errCode === 'ENTITY_IS_DELETED') {
					results.push({
						tempId: rec.tempId, sfId: rec.sfId, objectName: rec.objectName,
						label: rec.label || null, success: true, note: 'Already deleted',
					});
					alreadyDeleted++;
					return;
				}
				results.push({
					tempId: rec.tempId, sfId: rec.sfId, objectName: rec.objectName,
					label: rec.label || null, success: false,
					error: errMsg, errorCode: errCode,
				});
				failed++;
			});
		}
	}

	const intentSatisfied = succeeded + alreadyDeleted;
	let status;
	if (failed === 0) {
status = 'recalled';
} else if (intentSatisfied === 0) {
status = 'recall_failed';
} else {
status = 'recall_partial';
}

	return {
		results,
		succeeded,
		alreadyDeleted,
		failed,
		preservedUpdatesCount: preservedUpdates.length,

		revertedCount,
		revertFailedCount,
		revertResults,
		status,
	};
}
