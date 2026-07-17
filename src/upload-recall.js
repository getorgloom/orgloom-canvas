// Upload recall: phase 1.
//
// Given a saved upload_batches row, deletes the records it created from
// Salesforce in reverse-FK order. Uses Composite Sobjects DELETE
// (max 200 ids per call), allOrNone=false so a single failure doesn't
// take down the whole chunk.
//
// Soft delete only: records go to the org's Recycle Bin (15-day
// retention by default), recoverable via standard Salesforce UI. Hard
// delete (Bulk API operation=hardDelete) is a phase-2+ feature; not
// worth the extra complexity until customers ask for it.
import { escapeSoqlLiteral } from './sf-soql.js';

// SF SObject name shape (matches the rest of the codebase). Names that
// fail this regex get skipped to keep them out of interpolated SOQL.
const _SF_OBJECT_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;
// SObject field name shape (same lexical rule SF enforces). Used by
// classifyValueDrift to defend the SOQL SELECT list against any
// field name that snuck through batch creation (defense in depth;
// the batch path validates writes against describe).
const _SF_FIELD_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_.]*$/;

// jsforce-version-agnostic SOQL probe with includeDeleted=true.
// Some jsforce builds expose conn.queryAll(soql) as a top-level
// method; others don't (the connection wrapper used here doesn't).
// Hitting /services/data/vXX.X/queryAll/?q= directly via conn.request
// works in every build; it's the same REST endpoint the helper
// would call anyway. Returns the standard {records, totalSize, done}
// shape. Use this whenever the probe needs to see soft-deleted rows
// (recall classification, pre-delete IsDeleted=TRUE check).
async function _queryAll(conn, soql) {
	const apiVersion = conn.version || '60.0';
	const url = '/services/data/v' + apiVersion +
		'/queryAll/?q=' + encodeURIComponent(soql);
	return conn.request({ method: 'GET', url });
}

// Build a per-level delete plan. Leaves (records nothing else FK-points
// at) go first; roots (parents the others reference) go last. Salesforce
// rejects deletes when child rows still reference the parent, so this
// ordering is required.
//
// Algorithm:
//   1. Build dependents map: parent tempId -> Set of child tempIds.
//      An association "fromTempId references toTempId" means toTempId is
//      the parent and fromTempId is the child.
//   2. For each record, level = max(level of dependents) + 1. Records
//      with no dependents are level 0 (delete first).
//   3. Group by level; return as array of arrays.
export function planDeleteOrder(insertedIds, associations) {
	if (!Array.isArray(insertedIds) || insertedIds.length === 0) {
return [];
}
	const valid = insertedIds.filter((r) => r && r.tempId != null && r.sfId);
	if (valid.length === 0) {
return [];
}

	const dependents = new Map(); // parent tempId -> Set of child tempIds
	valid.forEach((r) => dependents.set(r.tempId, new Set()));
	(associations || []).forEach((a) => {
		if (!a || a.fromTempId == null || a.toTempId == null) {
return;
}
		// fromTempId references toTempId: child references parent.
		// To delete safely, child must die first.
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
} // cycle: bail
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

// Drift classification for a recall. Looks up the current SF state
// of every CREATED record (mode='create') and buckets them by safety.
// Updated rows (mode='update') are routed to the `updates` bucket
// without classification because they aren't recallable: recall is
// "undo what we created," not "delete every record this batch
// touched." Pre-edit values aren't captured anywhere on the Org Loom
// side, so deleting an updated record would destroy data that
// existed before this batch ran.
//
// Buckets:
//   clean: created record, exists, last modified by the
//                    original uploader within a small grace window
//                    of the upload time. Safe to recall.
//   drifted: created record, exists, but was modified by
//                    someone else (or far enough after upload that
//                    automation probably ran). Recalling will
//                    soft-delete those edits; user should opt-in.
//   alreadyDeleted: created record, gone from the org. Nothing to recall.
//   updates: record was UPDATED by this batch, not created.
//                    Surfaced separately so the modal can render
//                    "M updated records will be left alone" instead
//                    of silently dropping them from the count. No
//                    drift analysis is done on this bucket; it's
//                    pure "won't be touched" signal.
//
// Returns shape: { clean: [...], drifted: [...], alreadyDeleted: [...], updates: [...] }
// where each entry is the original `insertedIds` row enriched with
// `lastModifiedById`, `lastModifiedDate`, and `driftReason` (for drifted).
//
// Inputs:
//   conn: jsforce Connection
//   batch: the upload_batches row, with insertedIds[]
//   uploaderSfUserId: the SF user_id of the original uploader (15 or 18 char)
//   uploadTimeMs: when the upload completed (batch.created_at)
//   gracePeriodMs: optional, default 1 hour. LastModifiedDate within
//                        upload_time + grace AND by uploader is still "clean".
//                        Catches automation (workflows, formula triggers,
//                        custom-init logic) that runs as the uploader's
//                        identity shortly after insert.
export async function classifyBatchDrift({ conn, batch, uploaderSfUserId, uploadTimeMs, gracePeriodMs = 60 * 60 * 1000 }) {
	const insertedIds = (batch && batch.insertedIds) || [];
	if (insertedIds.length === 0) {
		return { clean: [], drifted: [], alreadyDeleted: [], updates: [], unverified: [] };
	}

	// Split creates from updates up-front. Only creates are eligible
	// for the drift classification + SOQL probe. Updated rows go
	// straight to the `updates` bucket: we know we touched them, we
	// know we shouldn't delete them, that's all the modal needs.
	// Rows without a mode (legacy batches pre-dating the mode field)
	// default to 'create' for backward compatibility, matching
	// the pre-fix behavior so we don't suddenly start "losing"
	// recallable records on old batches.
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
} // 'create', missing, or anything else
	}
	if (createRows.length === 0) {
		// Nothing to classify; return updates so the caller can still
		// render the "M updated records, nothing to recall" message.
		return { clean: [], drifted: [], alreadyDeleted: [], updates: updateRows, unverified: [] };
	}

	// Group by object name so we can SOQL them in one query per type.
	const byObject = new Map(); // objectName -> array of insertedId rows
	for (const r of createRows) {
		if (!r || !r.sfId || !r.objectName) {
continue;
}
		if (!byObject.has(r.objectName)) {
byObject.set(r.objectName, []);
}
		byObject.get(r.objectName).push(r);
	}

	// Query current state. queryAll so soft-deleted records still
	// surface (with IsDeleted=true); that's the alreadyDeleted bucket.
	//
	// Id format note: SF will accept either 15-char or 18-char ids in
	// SOQL WHERE clauses and treat them as equivalent, but the
	// response always echoes the 18-char form. The batch may have
	// stored either form depending on the upload path (Composite
	// Graph returns 18-char; older Bulk responses sometimes 15-char;
	// stored ids are whatever the upload route captured). To make the
	// state lookup work regardless of which form lives where, key the
	// state map by the 15-char prefix and probe by that prefix too.
	// Without this normalization, batches whose stored id format
	// differed from SF's response form would all miss their lookup
	// and get bucketed as alreadyDeleted, looking exactly like the
	// "1 record was already removed" symptom on a record that's
	// actually live.
	const idKey = (id) => (id ? String(id).slice(0, 15) : '');
	const sfStateById = new Map(); // 15-char id -> { LastModifiedById, LastModifiedDate, IsDeleted }
	const queryErrorByObject = new Map(); // objectName -> error message (the first one we saw)
	for (const [objName, recs] of byObject) {
		// objName flows in from saved upload_batches rows (user-controllable
		// at create-time). Even though batch creation validates against
		// real SObject names, defense-in-depth: reject anything outside
		// the SObject-name shape before interpolating it raw into SOQL.
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
				// Per-object query failure (perm error, network, malformed
				// object name). Capture the message so the response can
				// tell the user WHY we couldn't verify state, instead of
				// burying it in a generic "drifted" warning. First error
				// per object wins; multiple chunks usually fail for the
				// same underlying reason.
				const msg = (e && (e.errorCode ? e.errorCode + ': ' : '') + (e.message || String(e))) || 'queryAll failed';
				if (!queryErrorByObject.has(objName)) {
queryErrorByObject.set(objName, msg);
}
				console.warn('[recall/classify] queryAll failed for', objName + ':', msg);
			}
		}
	}

	// Normalize the uploader's SF user id to 15-char prefix for comparison.
	// SF returns LastModifiedById as 18-char; the stored uploader id may be
	// 15 or 18. Compare on the 15-char prefix to side-step the case.
	const norm = (id) => (id ? String(id).slice(0, 15) : '');
	const uploaderShort = norm(uploaderSfUserId);
	const cutoffTime = (uploadTimeMs || 0) + (gracePeriodMs || 0);

	const clean = [];
	const drifted = [];
	const alreadyDeleted = [];
	const unverified = []; // SOQL probe failed; state genuinely unknown

	for (const r of createRows) {
		if (!r || !r.sfId) {
continue;
}
		const state = sfStateById.get(idKey(r.sfId));
		// If the SOQL probe for this object failed (perm error, etc.),
		// surface as a separate `unverified` bucket so the modal
		// renders a clear "we couldn't check this record's state"
		// warning instead of misleadingly tagging it as drifted.
		// Carries the underlying SOQL error message so the user knows
		// WHY: usually a FLS / object perm gap that needs an admin
		// fix, not a recall decision.
		if (!state && queryErrorByObject.has(r.objectName)) {
			unverified.push(Object.assign({}, r, {
				probeError: queryErrorByObject.get(r.objectName),
			}));
			continue;
		}
		// State missing entirely OR IsDeleted=true → record is gone.
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
		// Different user touched it → drifted, no matter when.
		if (uploaderShort && modifierShort && modifierShort !== uploaderShort) {
			enriched.driftReason = 'modified_by_other_user';
			drifted.push(enriched);
			continue;
		}
		// Same user but well after the upload window, likely a manual
		// edit later. Better to flag.
		if (cutoffTime > 0 && modifiedAt > cutoffTime) {
			enriched.driftReason = 'modified_after_upload_window';
			drifted.push(enriched);
			continue;
		}
		// Same user within the grace window (or we couldn't determine
		// either side cleanly). Treat as clean.
		clean.push(enriched);
	}

	return { clean, drifted, alreadyDeleted, updates: updateRows, unverified };
}

// Master-detail cascade conflicts: when a clean record being recalled
// is the master-detail parent of a drifted record being skipped,
// recalling the parent will cascade-delete the skipped child anyway.
// The skip is illusory in that case: the child's edits will end up
// in the Recycle Bin regardless of the user's intent. This helper
// surfaces those conflicts so the modal can warn before the user
// confirms.
//
// Inputs:
//   conn: jsforce Connection
//   batch: the upload-batches row, with insertedIds + associations
//   classification: output of classifyBatchDrift: { clean, drifted, ... }
//
// Returns an array of conflict descriptors. Empty if no master-detail
// relationships span the clean/drifted split.
//
// How "master-detail" is detected: jsforce describe returns each
// reference field's `cascadeDelete: true` flag iff the relationship is
// master-detail (or junction). Lookup fields without cascade-delete
// don't trigger this; deleting a lookup parent leaves the child in
// place with a nulled FK.
//
// Falls back gracefully on describe failures: if a describe call fails
// (perm error, network), the affected fields are skipped, better to
// miss a conflict warning than to surface a false one.
// Classify per-field value drift on UPDATE rows for the value-revert
// recall path. For each row in `batch.insertedIds` with mode='update'
// AND a priorValues/uploadedValues map, fetch the SF record's current
// state and compare each uploaded field three ways:
//
//   * "clean": SF current matches uploadedValues exactly. Safe to
//                  PATCH back to priorValues without further consent;
//                  the value we wrote is still there.
//   * "drifted": SF current differs from BOTH uploadedValues and
//                  priorValues. Somebody (us, a SF user, an integration)
//                  changed the field after our upload. We can't tell
//                  whose change it is, so we surface to the user and
//                  default the revert checkbox OFF.
//   * "reverted": SF current matches priorValues. Field was already
//                  rolled back (maybe by a previous partial recall, maybe
//                  by hand). Skip: nothing to revert.
//
// Output shape: { records: [{ tempId, sfId, objectName, label, clean,
// drifted, reverted, notFound }], summary: { eligibleRecords,
// driftedRecords, cleanFieldCount, driftedFieldCount } }
// Each of clean/drifted/reverted is an array of { fieldName, prior,
// uploaded, current }. notFound is a boolean flag for rows whose SF id
// didn't return; the record was deleted out of band, so reverting
// values isn't an option.
//
// Performance: one SOQL per object name, with the field list union'd
// across all records of that object. Batched at 200 ids per query, same
// as classifyBatchDrift.
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

	// Group by object name. Per-object query needs the union of all
	// uploaded field names across rows of that object so we can ask SF
	// for every field in one SOQL.
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

	// idKey normalization mirrors classifyBatchDrift: SF returns
	// 18-char ids but the batch may store either form.
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
				// Per-object query failure; leave those rows
				// without a SF state map; they end up in `notFound`
				// downstream so the modal can surface the failure
				// instead of silently classifying everything as clean.
			}
		}
	}

	// Classify each row's fields.
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
			// Loose equality covers JSON round-trip coercions (5 vs "5",
			// true vs "true"). SF field values are scalars so this is
			// safe; deep-equal isn't needed.
			 
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

	// Three sets of preserved children to check against parents being
	// recalled: drifted (someone else's edits), updates (this batch
	// only updated a pre-existing record), and the (clean parent → MD
	// child) case for each. SF's master-detail cascade kicks in
	// regardless of which preservation bucket the child is in, so
	// flagging all three keeps the warning honest. Conflict
	// descriptors carry `childBucket` so the modal can pick the right
	// wording ("your update to record X will be wiped" vs "another
	// user's edits to record X will be wiped").
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

	// Collect (childObject, fieldName) pairs to describe; we only need
	// to check fields actually used in this batch's associations.
	const fieldsToCheck = new Map(); // objectName -> Set<fieldName>
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

	// Describe each child object once; flag its master-detail fields.
	const masterDetailByObj = new Map(); // objectName -> Set<fieldName>
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
			// Conservative: no entry for this object → no cascade flagged.
		}
	}

	// Walk associations. A conflict exists when:
	//   - The association field is master-detail on the child's object.
	//   - The parent is in the clean bucket (will be recalled).
	//   - The child is in either drifted (skipped) or updates (preserved
	//     because we shouldn't delete records we only modified), both
	//     buckets represent records the user expected to keep, both
	//     get cascade-wiped when the parent dies.
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
} // not master-detail
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

// Issues a Composite Sobjects DELETE for up to 200 ids at a time.
// Returns the per-id result array as Salesforce returns it.
async function deleteChunk(conn, apiBase, ids) {
	if (ids.length === 0) {
return [];
}
	const url = apiBase + '/composite/sobjects?ids=' + encodeURIComponent(ids.join(',')) + '&allOrNone=false';
	const resp = await conn.request({ method: 'DELETE', url });
	return Array.isArray(resp) ? resp : [];
}

// Execute the full recall against Salesforce. Returns:
//   { results, succeeded, alreadyDeleted, failed, status }
// where status is one of: recalled | recall_partial | recall_failed.
// `alreadyDeleted` counts records the org no longer had, either because
// they were soft-deleted (sitting in the Recycle Bin) or hard-deleted.
// Soft-deleted is the tricky case: Salesforce's DELETE silently succeeds
// without an error code, so the only reliable signal is a queryAll for
// IsDeleted=TRUE BEFORE the delete runs. Hard-deleted ones surface as an
// ENTITY_IS_DELETED error from the delete call, which we still honor.
//
// `skipSfIds` is an optional Set / array of sfIds to exclude from the
// recall; used by the drift-aware flow so users can opt to leave
// drifted records alone. Filtered records aren't reported in the
// results; they simply don't get touched.
export async function executeRecall({ conn, batch, skipSfIds, revertSelections }) {
	if (!conn) {
throw new Error('executeRecall requires a jsforce Connection');
}
	const apiVersion = conn.version || '60.0';
	const apiBase = '/services/data/v' + apiVersion;
	const skipSet = skipSfIds instanceof Set
		? skipSfIds
		: new Set(Array.isArray(skipSfIds) ? skipSfIds : []);
	// revertSelections: client-supplied { sfId, fields: [...] } entries
	// telling us which UPDATE rows to revert and which fields to roll
	// back per row. Empty / missing → no value reverts attempted, same
	// behavior as pre-value-revert recall. Each row in the source batch
	// must carry priorValues so we can look up what to write back.
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
	// SAFETY FILTER: only mode='create' rows are recallable. Updates
	// reference pre-existing records the user didn't ask us to own;
	// deleting them would destroy data that lived before this batch
	// ran. Updates pass through to the response as preservedUpdates so
	// the caller can render "M updated records left in place." Rows
	// without an explicit mode default to 'create' to preserve backward
	// compat with batches written before the mode field existed (those
	// batches were create-only by definition; update support landed
	// after the field).
	const rawRows = batch.insertedIds || [];
	const preservedUpdates = rawRows.filter((r) => r && r.mode === 'update');
	const recallableRows = rawRows.filter((r) => r && r.mode !== 'update');

	// Value-revert pass. Runs BEFORE the delete pass: UPDATE and CREATE
	// rows don't overlap, so order doesn't matter for safety, but doing
	// reverts first means a failure mid-recall leaves the user in a
	// state where their values are at least partially rolled back even
	// if the deletes don't all land. Each revert is one PATCH per
	// record (jsforce sobject(...).update({Id, ...priorValues})),
	// chunking is per-object, capped at 200 per Composite-API batch.
	let revertedCount = 0;
	let revertFailedCount = 0;
	let revertDriftSkippedCount = 0;
	const revertResults = [];
	if (revertMap.size > 0) {
		// Re-read at execution time. The review modal's classification is
		// advisory and may already be stale; only fields that STILL equal
		// this batch's uploaded value are safe to patch back. This closes
		// the Review -> Confirm TOCTOU window without trusting client input.
		const executionDrift = await classifyValueDrift({ conn, batch });
		const cleanFieldsById = new Map();
		for (const rec of executionDrift.records || []) {
			cleanFieldsById.set(String(rec.sfId), new Set((rec.clean || []).map((f) => f.fieldName)));
		}
		// Group revertable rows by object so we can chunk-PATCH per type.
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
				const executionClean = cleanFieldsById.get(String(row.sfId)) || new Set();
				const safeFields = new Set(Array.from(fields).filter((f) => executionClean.has(f)));
				const skippedFields = Array.from(fields).filter((f) => !executionClean.has(f));
				if (skippedFields.length > 0) {
					revertDriftSkippedCount += skippedFields.length;
				}
				if (safeFields.size === 0) {
					revertResults.push({
						sfId: row.sfId,
						objectName: objName,
						success: true,
						skipped: true,
						reason: 'drifted-at-execution',
						fieldsSkipped: skippedFields,
					});
					continue;
				}
				const patch = { Id: row.sfId };
				for (const fieldName of safeFields) {
					if (!fieldName || fieldName.startsWith('_')) {
continue;
}
					// priorValues null entries mean "the field was empty
					// at upload time"; SF accepts null for nullable
					// fields and 4xx's for not-nullable ones; let SF
					// return the failure so the user sees the real
					// reason rather than us silently dropping the field.
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
							fieldsReverted: Array.from(safeFields),
							fieldsSkipped: skippedFields,
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

	// Drop only the records explicitly opted out by sfId. Rows without
	// sfId aren't deletable anyway and get filtered further downstream;
	// passing them through here keeps the array structure simple.
	const insertedToRecall = recallableRows.filter(
		(r) => !(r && r.sfId && skipSet.has(r.sfId)),
	);
	const filteredBatch = Object.assign({}, batch, { insertedIds: insertedToRecall });
	const levels = planDeleteOrder(filteredBatch.insertedIds, filteredBatch.associations || []);

	// Pre-query IsDeleted=TRUE per object type. Records returned here
	// will silently "succeed" on the upcoming DELETE; without this
	// pass, they'd be indistinguishable from records this recall
	// actually removed.
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
	// Normalize ids to 15-char prefix for the same reason as
	// classifyBatchDrift: SF echoes 18-char Ids in responses but the
	// batch may have stored either form. Keying the preDeleted set by
	// 15-char and looking up the same way avoids missing matches
	// purely on case-suffix differences.
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
			} catch (e) { /* skip: handled by per-record fallback */ }
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
				// The whole chunk failed (network, 4xx, etc.). Mark each as failed.
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
					// Soft-deleted records succeed silently on DELETE.
					// Pre-query results identify them. Compare via the
					// same 15-char key the pre-query stored under.
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
				// ENTITY_IS_DELETED: record was already gone (manual delete or
				// prior recall). Tally separately from succeeded so the
				// confirmation can distinguish "deleted by this recall" from
				// "was already missing." User's intent ("not in the org") is
				// satisfied either way, so we don't bump `failed`.
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

	// succeeded + alreadyDeleted both satisfy the user's "remove from the
	// org" intent, so they count together for the partial-vs-failed call.
	const intentSatisfied = succeeded + alreadyDeleted;
	let status;
	if (failed === 0) {
status = 'recalled';
} else if (intentSatisfied === 0) {
status = 'recall_failed';
} else {
status = 'recall_partial';
}
	// preservedUpdatesCount reports records the recall intentionally
	// left in place because mode='update'. Distinct from `failed`
	// (which means "tried to delete but couldn't") and from
	// `alreadyDeleted` (which means "wasn't there to delete"). UI uses
	// this to render "M updated records were preserved" alongside the
	// success/failure counts.
	return {
		results,
		succeeded,
		alreadyDeleted,
		failed,
		preservedUpdatesCount: preservedUpdates.length,
		// Value-revert tally. revertedCount and revertFailedCount are
		// per-record (a record either has all its selected fields
		// reverted in one PATCH or not). revertResults carries the
		// per-record breakdown for the History UI's success/failure
		// surface. Empty arrays / zero counts when revertSelections
		// was not supplied; preserves backwards-compat with callers
		// that ignore the new fields.
		revertedCount,
		revertFailedCount,
		revertDriftSkippedCount,
		revertResults,
		status,
	};
}
