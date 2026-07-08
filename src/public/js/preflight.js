


































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
















			function validateBulkRecords() {
				const issues = [];
				const byRecordId = new Map();
				const missingDescribes = new Set();
			


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



					if (rec.isTypeNode) {
return;
}





					if (rec.pendingDelete && rec.loadedFromId) {
return;
}







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








					const partialFieldSet = (Array.isArray(rec._loadedFieldNames) && rec.loadedFromId)
						? new Set(rec._loadedFieldNames)
						: null;
			
					describe.fields.forEach((f) => {
						if (!f || !f.name) {
return;
}


						if (!f.createable) {
return;
}
			
						const raw = values[f.name];
						const hasValue = raw !== undefined && raw !== null && !(typeof raw === 'string' && raw === '');
						const hasFkLink = f.type === 'reference' && linkedFields.has(f.name);
			

						if (f.required && !hasValue && !hasFkLink && !f.defaultedOnCreate) {




							if (partialFieldSet && !partialFieldSet.has(f.name)) {
return;
}
							addIssue(rec, f, 'error', 'Required field is empty.');
							return;
						}
						if (!hasValue) {
return;
}
			

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
			

						if (typeof raw === 'string' && f.length && f.length > 0) {
							const stringTypes = new Set(['string', 'textarea', 'phone', 'url', 'email', 'encryptedstring']);
							if (stringTypes.has(f.type) && raw.length > f.length) {
								addIssue(rec, f, 'error', 'Value is ' + raw.length + ' chars, max is ' + f.length + '.');
							}
						}
			

						const numericTypes = new Set(['int', 'double', 'currency', 'percent']);
						if (numericTypes.has(f.type)) {
							const n = Number(raw);
							if (!isFinite(n)) {
								addIssue(rec, f, 'error', 'Value isn\u2019t a valid number.');
							} else if (f.type === 'int' && !Number.isInteger(n)) {
								addIssue(rec, f, 'error', 'Value must be an integer.');
							}
						}
			

						if (f.type === 'date' && typeof raw === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
							addIssue(rec, f, 'error', 'Date must be YYYY-MM-DD.');
						}
						if (f.type === 'datetime' && typeof raw === 'string') {


							const looksOk = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw) || !isNaN(Date.parse(raw));
							if (!looksOk) {
addIssue(rec, f, 'error', 'Datetime is unparseable.');
}
						}
			

						if (f.type === 'email' && typeof raw === 'string' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
							addIssue(rec, f, 'error', 'Doesn\u2019t look like a valid email address.');
						}
						if (f.type === 'url' && typeof raw === 'string' && raw.length > 0 && !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
							addIssue(rec, f, 'warning', 'URL is missing a scheme (e.g. https://).');
						}
			

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
























				const recordById = new Map();
				canvasState.bulkRecords.forEach((r) => {
 if (r && r.id != null) {
recordById.set(r.id, r);
} 
});
				const childrenOf = new Map();
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
			























			function computeUploadOrder(unchangedSet, inScopeSet, deleteSet) {
				const skip = unchangedSet || new Set();
				const deletes = deleteSet || new Set();
				const recordsById = new Map();





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
}
					deps.get(a.fromId).add(a.toId);
				});

				const levelById = new Map();
				function lvl(id, stack) {
					if (levelById.has(id)) {
return levelById.get(id);
}
					if (stack.has(id)) {
return 0;
}
					stack.add(id);
					let m = 0;
					for (const p of (deps.get(id) || [])) {
						const v = lvl(p, stack) + 1;
						if (v > m) {
m = v;
}
					}
					stack.delete(id);
					levelById.set(id, m);
					return m;
				}
				recordsById.forEach((_, id) => lvl(id, new Set()));



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




				const deletesLane = Array.from(deleteBuckets.values()).sort((a, b) => {
					if (a.level !== b.level) {
return b.level - a.level;
}
					return a.label.localeCompare(b.label);
				});
				return { creates, deletes: deletesLane };
			}

			return {
				validateBulkRecords: validateBulkRecords,
				computeUploadOrder: computeUploadOrder,
			};
		},
	};
})();
