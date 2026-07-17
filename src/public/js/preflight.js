// Pre-flight validation (Layer 1) + upload-order preview.
//
// Two cheap-and-fast pure helpers that run BEFORE we ship a long
// upload to Salesforce.
//
//   validateBulkRecords()
//     Walks every bulk record against its describe + associations
//     and flags obvious problems: required fields, picklist
//     membership, string lengths, numeric parseability, date format,
//     reference resolution. Does NOT evaluate validation rules or
//     hit the SF API: that's Layer 3 (Composite Graph dry-run).
//
//   computeUploadOrder(unchangedSet, inScopeSet)
//     Builds the (level, objectName) groups the server's dependency
//     walk will use, so the upload modal's preview matches what
//     actually happens during /api/upload. Topological levels are
//     derived from bulkAssociations; loaded parents resolve up-front
//     and don't push child level.
//
// Dependencies passed to mount():
//   canvasState: shared canvas state. Both helpers read
//                        bulkRecords, bulkAssociations, describeCache,
//                        and selectedObjects.
//   isRecordModified: value-compare predicate; skips unchanged
//                        loaded records so they don't trip Layer 1.
//   recordOrdinal: function from app.js; builds the "#1" suffix
//                        used in the issue's recordLabel.
//
// Public API (returned from mount):
//   validateBulkRecords(): returns { issues, byRecordId, missingDescribes }
//   computeUploadOrder(unchangedSet, inScopeSet): returns ordered
//                                                  bucket array
//
// Exposed as window.OrgLoom.preflight. Load order: before app.js.

(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.preflight = {
		mount: function mount(deps) {
			if (!deps || !deps.canvasState || !deps.isRecordModified || !deps.recordOrdinal) {
				throw new Error('preflight.mount: missing required deps');
			}
			const canvasState = deps.canvasState;
			const isRecordModified = deps.isRecordModified;
			const recordOrdinal = deps.recordOrdinal;

			// ----- Pre-flight validation (Layer 1) -----
			// Walk every bulk record against its describe + associations and
			// flag obvious problems BEFORE we ship a long upload to Salesforce.
			// This is the cheap-and-fast layer: required fields, picklist
			// membership, string lengths, numeric parseability, date format,
			// reference resolution. It deliberately does NOT evaluate validation
			// rules or hit the SF API: that's Layer 3 (Composite Graph dry-run).
			//
			// Returns { issues, byRecordId, missingDescribes } where:
			//   issues: flat list of { recordId, objectName, recordLabel,
			//             field, fieldLabel, severity, message }
			//   byRecordId: Map<recordId, issues[]>
			//   missingDescribes: Set of object names whose describe wasn't
			//             cached (validation skipped; we trust the upload to
			//             surface SF-side errors instead).
			function validateBulkRecords() {
				const issues = [];
				const byRecordId = new Map();
				const missingDescribes = new Set();
			
				// Index associations by (fromId, fieldName) so a required
				// reference field can ask "do I have an FK link?" in O(1).
				const assocByFrom = new Map();
				(canvasState.bulkAssociations || []).forEach((a) => {
					if (!a || a.fromId == null || !a.fieldName) {
return;
}
					let s = assocByFrom.get(a.fromId);
					if (!s) {
 s = new Set(); assocByFrom.set(a.fromId, s); 
}
					s.add(a.fieldName);
				});
			
				(canvasState.bulkRecords || []).forEach((rec) => {
					if (!rec || !rec.objectName) {
return;
}
					// Type-nodes are edit-mode placeholders, not records;
					// they're never uploaded and don't have field values
					// to validate. Skip them entirely.
					if (rec.isTypeNode) {
return;
}
					// Pending-delete records skip the field validation pass
					// entirely; SF DELETE doesn't care about field values,
					// required-fields, picklists, or lengths. The cascade
					// pass below handles delete-specific concerns instead
					// (orphaned loaded children, draft-child references).
					if (rec.pendingDelete && rec.loadedFromId) {
return;
}
					// Unchanged loaded records (loadedFromId set, no
					// local edits) are skipped server-side via
					// skipTempIds, so flagging validation issues on them
					// is just noise: the user didn't touch them and
					// nothing is going to Salesforce. If the org has a
					// stale picklist/required value, they can fix it by
					// editing the record explicitly.
					if (rec.loadedFromId && !isRecordModified(rec)) {
return;
}
					const describe = canvasState.describeCache[rec.objectName];
					if (!describe || !Array.isArray(describe.fields)) {
						missingDescribes.add(rec.objectName);
						return;
					}
					const recordLabel = (rec.label || rec.objectName) + ' #' + recordOrdinal(rec);
					const values = rec.values || {};
					const linkedFields = assocByFrom.get(rec.id) || new Set();
					// Compact-mode SOQL imports: only the SELECT-listed
					// fields landed in `values`. Required fields outside
					// that set still hold their existing values in
					// Salesforce; UPDATE preserves anything not in the
					// payload, so flagging them as required-and-missing
					// would be a false positive. Only enforce required
					// for fields actually in the loaded set when the
					// record is partial.
					const partialFieldSet = (Array.isArray(rec._loadedFieldNames) && rec.loadedFromId)
						? new Set(rec._loadedFieldNames)
						: null;
			
					describe.fields.forEach((f) => {
						if (!f || !f.name) {
return;
}
						// Skip non-writable fields entirely; they can't fail
						// pre-flight because we never send them.
						if (!f.createable) {
return;
}
			
						const raw = values[f.name];
						const hasValue = raw !== undefined && raw !== null && !(typeof raw === 'string' && raw === '');
						const hasFkLink = f.type === 'reference' && linkedFields.has(f.name);
			
						// 1. Required + missing
						if (f.required && !hasValue && !hasFkLink && !f.defaultedOnCreate) {
							// Partial-loaded record: skip the required-
							// missing flag for fields that weren't in the
							// loaded set. SF preserves the real value
							// across the UPDATE.
							if (partialFieldSet && !partialFieldSet.has(f.name)) {
return;
}
							addIssue(rec, f, 'error', 'Required field is empty.');
							return; // no point checking further on an empty field
						}
						if (!hasValue) {
return;
}
			
						// 2. Picklist membership (single + multi)
						if ((f.type === 'picklist' || f.type === 'combobox') && Array.isArray(f.picklistValues) && f.picklistValues.length > 0) {
							const ok = f.picklistValues.some((p) => p && p.active !== false && p.value === raw);
							if (!ok) {
addIssue(rec, f, 'error', 'Value "' + raw + '" is not an active picklist option.');
}
						} else if (f.type === 'multipicklist' && Array.isArray(f.picklistValues)) {
							const parts = String(raw).split(';').map((s) => s.trim()).filter(Boolean);
							const allowed = new Set(f.picklistValues.filter((p) => p && p.active !== false).map((p) => p.value));
							parts.forEach((p) => {
								if (!allowed.has(p)) {
addIssue(rec, f, 'error', 'Value "' + p + '" is not an active picklist option.');
}
							});
						}
			
						// 3. String length
						if (typeof raw === 'string' && f.length && f.length > 0) {
							const stringTypes = new Set(['string', 'textarea', 'phone', 'url', 'email', 'encryptedstring']);
							if (stringTypes.has(f.type) && raw.length > f.length) {
								addIssue(rec, f, 'error', 'Value is ' + raw.length + ' chars, max is ' + f.length + '.');
							}
						}
			
						// 4. Numeric parseability
						const numericTypes = new Set(['int', 'double', 'currency', 'percent']);
						if (numericTypes.has(f.type)) {
							const n = Number(raw);
							if (!isFinite(n)) {
								addIssue(rec, f, 'error', 'Value isn\u2019t a valid number.');
							} else if (f.type === 'int' && !Number.isInteger(n)) {
								addIssue(rec, f, 'error', 'Value must be an integer.');
							}
						}
			
						// 5. Date / datetime format
						if (f.type === 'date' && typeof raw === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
							addIssue(rec, f, 'error', 'Date must be YYYY-MM-DD.');
						}
						if (f.type === 'datetime' && typeof raw === 'string') {
							// Server upgrades datetime-local to ISO 8601 automatically;
							// only flag truly unparseable strings.
							const looksOk = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw) || !isNaN(Date.parse(raw));
							if (!looksOk) {
addIssue(rec, f, 'error', 'Datetime is unparseable.');
}
						}
			
						// 6. Email & URL format (lenient: SF will be the final word)
						if (f.type === 'email' && typeof raw === 'string' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
							addIssue(rec, f, 'error', 'Doesn\u2019t look like a valid email address.');
						}
						if (f.type === 'url' && typeof raw === 'string' && raw.length > 0 && !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
							addIssue(rec, f, 'warning', 'URL is missing a scheme (e.g. https://).');
						}
			
						// 7. Reference field: literal value should look like an SF ID.
						if (f.type === 'reference' && typeof raw === 'string' && raw.length > 0 && !/^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(raw)) {
							addIssue(rec, f, 'error', 'Lookup value isn\u2019t a Salesforce ID and no FK link is set.');
						}
					});
				});
			
				function addIssue(rec, field, severity, message) {
					const issue = {
						recordId: rec.id,
						objectName: rec.objectName,
						recordLabel: (rec.label || rec.objectName) + ' #' + recordOrdinal(rec),
						field: field.name,
						fieldLabel: field.label || field.name,
						severity,
						message,
					};
					issues.push(issue);
					let bucket = byRecordId.get(rec.id);
					if (!bucket) {
 bucket = []; byRecordId.set(rec.id, bucket); 
}
					bucket.push(issue);
				}

				// ----- Cascade pass for pending-delete records -----
				// Two delete-specific concerns the field-validation pass
				// above can't catch:
				//
				//   (a) Orphaned LOADED children: a loaded record on the
				//       canvas FKs to a record being deleted, and the
				//       child isn't ALSO being deleted. Salesforce will
				//       cascade-delete the child (for master-detail) or
				//       refuse the parent delete (for lookups), depending
				//       on the relationship. Either way the user should
				//       know up front. Warn, don't block; the user might
				//       genuinely want the cascade.
				//
				//   (b) DRAFT children: a draft on the canvas FKs to a
				//       record being deleted. The draft's FK won't
				//       resolve once the parent is gone. Block (error)
				// because there's no execution order that makes this
				//       payload coherent.
				//
				// Edges in canvasState.bulkAssociations point FROM child
				// (holding the FK) TO parent (the FK target). So for a
				// pending-delete parent, its children are the records
				// whose `fromId` is some child and `toId` is this parent.
				const recordById = new Map();
				canvasState.bulkRecords.forEach((r) => {
 if (r && r.id != null) {
recordById.set(r.id, r);
} 
});
				const childrenOf = new Map(); // parentId -> [{ child, fieldName }]
				(canvasState.bulkAssociations || []).forEach((a) => {
					if (!a || a.fromId == null || a.toId == null) {
return;
}
					const child = recordById.get(a.fromId);
					if (!child || child.isTypeNode) {
return;
}
					if (!childrenOf.has(a.toId)) {
childrenOf.set(a.toId, []);
}
					childrenOf.get(a.toId).push({ child, fieldName: a.fieldName });
				});
				function pushCascadeIssue(parentRec, severity, fieldLabel, message) {
					const issue = {
						recordId: parentRec.id,
						objectName: parentRec.objectName,
						recordLabel: (parentRec.label || parentRec.objectName) + ' #' + recordOrdinal(parentRec),
						field: '(cascade)',
						fieldLabel,
						severity,
						message,
					};
					issues.push(issue);
					let bucket = byRecordId.get(parentRec.id);
					if (!bucket) {
 bucket = []; byRecordId.set(parentRec.id, bucket); 
}
					bucket.push(issue);
				}
				canvasState.bulkRecords.forEach((rec) => {
					if (!rec || rec.isTypeNode) {
return;
}
					if (!rec.loadedFromId || !rec.pendingDelete) {
return;
}
					const kids = childrenOf.get(rec.id) || [];
					if (kids.length === 0) {
return;
}
					const orphanedLoaded = kids.filter((k) => k.child.loadedFromId && !k.child.pendingDelete);
					const draftChildren = kids.filter((k) => !k.child.loadedFromId);
					if (orphanedLoaded.length > 0) {
						pushCascadeIssue(
							rec,
							'warning',
							'Cascade',
							'Deleting this record may cascade-delete ' + orphanedLoaded.length + ' loaded child record' + (orphanedLoaded.length === 1 ? '' : 's') + ' in Salesforce, or be refused if the relationship is a lookup. Mark them for delete too if cascade is the intent, or unmark this delete.'
						);
					}
					if (draftChildren.length > 0) {
						pushCascadeIssue(
							rec,
							'error',
							'Draft FK',
							draftChildren.length + ' draft record' + (draftChildren.length === 1 ? '' : 's') + ' on this canvas reference this record via FK. Deleting it would leave those FKs unresolvable at upload time. Remove the drafts or unmark this delete.'
						);
					}
				});

				return { issues, byRecordId, missingDescribes };
			}
			
			// Compute the upload order the server will use: topo levels of
			// (level, objectName) groups. Mirrors the server's dependency
			// walk in /api/upload and /api/upload/bulk so the modal preview
			// matches what actually happens.
			//
			// Returns { creates, deletes } where:
			//   creates: array of { level, objectName, label, upload, unchanged }
			//     entries ordered parents-first by level then by label. `upload`
			//     excludes records in `unchangedSet`. Records flagged for
			//     SF DELETE (pendingDelete) are excluded from this lane;
			//     they get their own lane below.
			//   deletes: array of { level, objectName, label, count } entries
			//     for the pending-delete records, ordered children-first
			//     (reverse topological; SF refuses to delete a parent while
			//     a child record still references it on this canvas, unless
			//     master-detail cascades).
			//
			// Args:
			//   unchangedSet: Set<tempId> for change-detection (skip
			//     loaded records whose values match loadedValues)
			//   inScopeSet: Set<tempId> for the "selected-only" mode
			//   deleteSet: Set<tempId> of records marked pendingDelete
			//     (when omitted/empty, deletes lane is [])
			function computeUploadOrder(unchangedSet, inScopeSet, deleteSet) {
				const skip = unchangedSet || new Set();
				const deletes = deleteSet || new Set();
				const recordsById = new Map();
				// Type-nodes never upload; exclude them from the order
				// preview so empty placeholder circles don't get counted
				// as records on their own line. inScopeSet (when given)
				// further restricts to a subset, used by the modal's
				// "upload selected only" mode.
				canvasState.bulkRecords.forEach((r) => {
					if (!r || r.id == null) {
return;
}
					if (r.isTypeNode) {
return;
}
					if (inScopeSet && !inScopeSet.has(r.id)) {
return;
}
					recordsById.set(r.id, r);
				});
				// Build deps: fromId -> Set<toId>. Skip parents that are
				// already-loaded (they don't push child level since their
				// id is known up front).
				const deps = new Map();
				recordsById.forEach((_, id) => deps.set(id, new Set()));
				canvasState.bulkAssociations.forEach((a) => {
					if (!a || !deps.has(a.fromId)) {
return;
}
					const parent = recordsById.get(a.toId);
					if (!parent) {
return;
}
					if (parent.loadedFromId) {
return;
} // resolved up-front, no level cost
					deps.get(a.fromId).add(a.toId);
				});
				// Level per record: max(parent level) + 1, 0 if no deps.
				const levelById = new Map();
				const cycleIds = new Set();
				function lvl(id, stack, stackArr) {
					if (levelById.has(id)) {
return levelById.get(id);
}
					if (stack.has(id)) {
						const start = stackArr.indexOf(id);
						for (let i = Math.max(0, start); i < stackArr.length; i++) {
cycleIds.add(stackArr[i]);
}
						return 0;
} // cycle short-circuit
					stack.add(id);
					stackArr.push(id);
					let m = 0;
					for (const p of (deps.get(id) || [])) {
						const v = lvl(p, stack, stackArr) + 1;
						if (v > m) {
m = v;
}
					}
					stack.delete(id);
					stackArr.pop();
					levelById.set(id, m);
					return m;
				}
				recordsById.forEach((_, id) => lvl(id, new Set(), []));
				// Bucket by (level, objectName). Pending-delete records
				// are excluded from the creates lane (a record can't be
				// both created/updated AND deleted in the same upload).
				const buckets = new Map();
				const deleteBuckets = new Map();
				recordsById.forEach((rec, id) => {
					const level = levelById.get(id) || 0;
					const sel = canvasState.selectedObjects.find(s => s.name === rec.objectName);
					const label = (sel && sel.label) || rec.label || rec.objectName;
					if (deletes.has(id)) {
						const dkey = level + '|' + rec.objectName;
						let d = deleteBuckets.get(dkey);
						if (!d) {
							d = { level, objectName: rec.objectName, label, count: 0 };
							deleteBuckets.set(dkey, d);
						}
						d.count++;
						return;
					}
					const key = level + '|' + rec.objectName;
					let b = buckets.get(key);
					if (!b) {
						b = {
							level,
							objectName: rec.objectName,
							label,
							upload: 0,
							unchanged: 0,
						};
						buckets.set(key, b);
					}
					if (skip.has(id)) {
b.unchanged++;
} else {
b.upload++;
}
				});
				const creates = Array.from(buckets.values()).sort((a, b) => {
					if (a.level !== b.level) {
return a.level - b.level;
}
					return a.label.localeCompare(b.label);
				});
				// Deletes run in REVERSE topo order: deepest children first
				// so that by the time we DELETE a parent, no record on this
				// canvas still references it. Within a level, alphabetical
				// for stable ordering (visual + log diff parity).
				const deletesLane = Array.from(deleteBuckets.values()).sort((a, b) => {
					if (a.level !== b.level) {
return b.level - a.level;
}
					return a.label.localeCompare(b.label);
				});
				return { creates, deletes: deletesLane, cycleIds };
			}

			return {
				validateBulkRecords: validateBulkRecords,
				computeUploadOrder: computeUploadOrder,
			};
		},
	};
})();
