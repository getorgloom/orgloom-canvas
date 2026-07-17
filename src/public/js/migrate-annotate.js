// Migrate-mode annotation engine.
//
// Pure logic: given one canvas record and the TARGET org's describe for
// that record's object, decide what (if anything) needs fixing before the
// record can be recreated in the target org. No DOM, no network; the UI
// (guided migration review, readiness summary) and the upload gate consume the
// result.
//
// Issue kinds + severity:
//   missing-field        warning: a populated field on the record is not
//                                   available through the target user's
//                                   createable-field describe; it will be
//                                   skipped on upload. The field may be
//                                   absent or hidden by permissions.
//   required-unfilled    blocked: a required-on-create field in the
//                                   target isn't populated. (Reference /
//                                   master-detail required fields are NOT
//                                   flagged here; the upload's association
//                                   graph or a manual link may satisfy
//                                   them; flagging would false-positive on
//                                   master-detail children.)
//   picklist-mismatch    warning: a value isn't in the target's active
//                                   picklist values. v1 flags only; it
//                                   would otherwise error on upload.
//   recordtype-unresolved blocked: the source record's RecordType
//                                   DeveloperName has no matching available
//                                   RecordType in the target org.
//
// Status rollup: 'blocked' if any blocked issue, else 'warning' if any
// warning, else 'ready'. The upload gate blocks on 'blocked'.
//
// RecordType resolution is by DeveloperName, NOT by Id: RecordType Ids
// are not portable across orgs (a sandbox spawned from prod often happens
// to share them, but unrelated orgs never do). When the source record
// carries `_sourceRecordTypeDeveloperName`, we look up the matching
// available RecordType in the target and return its Id as
// `resolvedRecordTypeId` so the upload can fill it.

(function () {
	'use strict';

	// SF system / meta keys that are never migrated or validated. The
	// cross-org transform already strips most from values; this is
	// belt-and-suspenders + covers anything that slips through.
	var SYSTEM_KEYS = {
		attributes: 1,
		id: 1, createddate: 1, createdbyid: 1, lastmodifieddate: 1,
		lastmodifiedbyid: 1, systemmodstamp: 1, isdeleted: 1, ownerid: 1,
		recordtypeid: 1, masterrecordid: 1, lastreferenceddate: 1,
		lastvieweddate: 1,
	};

	function _isEmpty(v) {
		return v === null || v === undefined || v === '';
	}

	function _isIgnoredKey(key) {
		if (!key) {
			return true;
		}
		var lk = String(key).toLowerCase();
		// Skip Org Loom internal markers (_wasLoadedFromId, etc.) and SF
		// system fields.
		return lk.charAt(0) === '_' || SYSTEM_KEYS[lk] === 1;
	}

	// Case-insensitive value lookup: stored keys and SF field API names
	// can differ in casing.
	function _lookupValue(values, fieldName) {
		if (!values || !fieldName) {
			return undefined;
		}
		if (Object.prototype.hasOwnProperty.call(values, fieldName)) {
			return values[fieldName];
		}
		var lk = String(fieldName).toLowerCase();
		var keys = Object.keys(values);
		for (var i = 0; i < keys.length; i++) {
			if (keys[i].toLowerCase() === lk) {
				return values[keys[i]];
			}
		}
		return undefined;
	}

	// Resolve a source RecordType DeveloperName to the target org's
	// RecordType Id by DeveloperName (case-insensitive). Consumes the Org
	// Loom describe shape: `recordTypes[] = { id, developerName, ... }`,
	// already filtered to available record types server-side. Returns the
	// Id or null.
	function resolveTargetRecordTypeId(developerName, targetDescribe) {
		if (!developerName || !targetDescribe) {
			return null;
		}
		var rts = targetDescribe.recordTypes || [];
		var want = String(developerName).toLowerCase();
		for (var i = 0; i < rts.length; i++) {
			var rt = rts[i];
			if (!rt) {
				continue;
			}
			if (String(rt.developerName || '').toLowerCase() === want) {
				return rt.id || null;
			}
		}
		return null;
	}

	// Per-field picklist remap lookup (case-insensitive on field name).
	// Returns the { sourceValue: targetValueOrEmpty } map for a field, or
	// null. An empty-string target means "drop this value on upload".
	function _picklistRemapFor(record, fieldName) {
		var remap = record && record._migratePicklistRemap;
		if (!remap || !fieldName) {
			return null;
		}
		if (Object.prototype.hasOwnProperty.call(remap, fieldName)) {
			return remap[fieldName];
		}
		var lk = String(fieldName).toLowerCase();
		var keys = Object.keys(remap);
		for (var i = 0; i < keys.length; i++) {
			if (keys[i].toLowerCase() === lk) {
				return remap[keys[i]];
			}
		}
		return null;
	}

	// Core: status + issues for one record against the target describe.
	// Per-record overrides (set by the Phase 2 remap UI, carried on the
	// record so they ride the migration snapshot):
	//   _migrateRecordTypeId: explicit target RecordType Id to use.
	//   _migrateClearRecordType: true to drop the record type entirely.
	//   _migratePicklistRemap: { field: { sourceValue: targetOrEmpty } };
	//                            remapped values count as resolved.
	function computeMigrationStatus(record, targetDescribe) {
		var issues = [];
		var resolvedRecordTypeId = null;
		var values = (record && record.values) || {};
		var fields = (targetDescribe && targetDescribe.fields) || [];

		// Index target fields by lowercased name.
		var fieldByName = {};
		for (var i = 0; i < fields.length; i++) {
			var f = fields[i];
			if (f && f.name) {
				fieldByName[String(f.name).toLowerCase()] = f;
			}
		}

		// 1. Populated record fields that don't exist on the target.
		var valueKeys = Object.keys(values);
		for (var k = 0; k < valueKeys.length; k++) {
			var key = valueKeys[k];
			if (_isIgnoredKey(key)) {
				continue;
			}
			if (_isEmpty(values[key])) {
				continue; // nothing to migrate for this field
			}
			if (!fieldByName[String(key).toLowerCase()]) {
				issues.push({
					kind: 'missing-field',
					severity: 'warning',
					field: key,
					message: '“' + key + '” is unavailable through the destination connection and will be skipped. It may not exist in the destination org, or Salesforce permissions may hide it.',
				});
			}
		}

		// 2. Required-on-create fields in the target not populated. Skip
		//    reference/master-detail fields (often satisfied by the upload
		//    association graph or a manual link). The Org Loom describe
		//    payload already folds nillable + defaultedOnCreate into a single
		//    `required` flag and only lists createable fields.
		//    Skipped entirely for matched records (loadedFromId set); those
		//    UPDATE an existing target record, which already carries its
		//    required fields, so an unfilled required field isn't a blocker.
		var _isUpdate = !!(record && record.loadedFromId);
		for (var r = 0; !_isUpdate && r < fields.length; r++) {
			var tf = fields[r];
			if (!tf || tf.required !== true || tf.createable === false) {
				continue; // not required-on-create
			}
			if (_isIgnoredKey(tf.name)) {
				continue;
			}
			if (tf.type === 'reference') {
				continue; // lookups/master-detail handled elsewhere
			}
			if (_isEmpty(_lookupValue(values, tf.name))) {
				issues.push({
					kind: 'required-unfilled',
					severity: 'blocked',
					field: tf.name,
					message: '“' + (tf.label || tf.name) + '” is required in the destination org and isn’t set.',
				});
			}
		}

		// 3. Picklist value mismatches (v1: flag only).
		for (var p = 0; p < valueKeys.length; p++) {
			var pkey = valueKeys[p];
			if (_isIgnoredKey(pkey)) {
				continue;
			}
			var pf = fieldByName[String(pkey).toLowerCase()];
			if (!pf) {
				continue; // missing-field already handled above
			}
			var pv = values[pkey];
			if (_isEmpty(pv)) {
				continue;
			}
			if ((pf.type === 'picklist' || pf.type === 'multipicklist') &&
				Array.isArray(pf.picklistValues) && pf.picklistValues.length) {
				var active = {};
				for (var a = 0; a < pf.picklistValues.length; a++) {
					var opt = pf.picklistValues[a];
					if (opt && opt.active !== false) {
						active[String(opt.value)] = 1;
					}
				}
				var parts = pf.type === 'multipicklist'
					? String(pv).split(';')
					: [String(pv)];
				var fieldRemap = _picklistRemapFor(record, pkey);
				var bad = [];
				for (var b = 0; b < parts.length; b++) {
					var part = parts[b];
					if (part === '' || active[part] === 1) {
						continue; // empty or already valid
					}
					// A remap entry (even to drop) means the user resolved it.
					if (fieldRemap &&
						Object.prototype.hasOwnProperty.call(fieldRemap, part)) {
						continue;
					}
					bad.push(part);
				}
				if (bad.length) {
					issues.push({
						kind: 'picklist-mismatch',
						severity: 'warning',
						field: pkey,
						invalidValues: bad,
						message: '“' + pkey + '”: ' + bad.join(', ') + ' not a valid picklist value in the destination org.',
					});
				}
			}
		}

		// 4. RecordType resolution by DeveloperName. User overrides win:
		//    an explicit clear drops it, an explicit Id uses it, otherwise
		//    auto-resolve by DeveloperName and block if unresolved.
		var srcRtDevName = record &&
			(record._sourceRecordTypeDeveloperName ||
				(record.values && record.values._sourceRecordTypeDeveloperName));
		if (record && record._migrateClearRecordType) {
			resolvedRecordTypeId = null; // user chose to drop it
		} else if (record && record._migrateRecordTypeId) {
			resolvedRecordTypeId = record._migrateRecordTypeId; // user override
		} else if (srcRtDevName) {
			resolvedRecordTypeId = resolveTargetRecordTypeId(srcRtDevName, targetDescribe);
			if (!resolvedRecordTypeId) {
				issues.push({
					kind: 'recordtype-unresolved',
					severity: 'blocked',
					field: 'RecordTypeId',
					developerName: srcRtDevName,
					message: 'Record type “' + srcRtDevName + '” doesn’t exist in the destination org. Pick a record type or clear it.',
				});
			}
		}

		var hasBlocked = false;
		var hasWarning = false;
		for (var z = 0; z < issues.length; z++) {
			if (issues[z].severity === 'blocked') {
				hasBlocked = true;
			} else if (issues[z].severity === 'warning') {
				hasWarning = true;
			}
		}
		var status = hasBlocked ? 'blocked' : (hasWarning ? 'warning' : 'ready');

		return {
			status: status,
			issues: issues,
			resolvedRecordTypeId: resolvedRecordTypeId,
		};
	}

	// Annotate a list of records. describeByObject maps objectName ->
	// target describe. Records whose object has no describe yet get
	// status 'pending' (the caller should fetch + re-run). Returns an
	// array aligned with the input.
	function annotateRecords(records, describeByObject) {
		records = records || [];
		describeByObject = describeByObject || {};
		var out = [];
		for (var i = 0; i < records.length; i++) {
			var rec = records[i];
			if (!rec || rec.isTypeNode) {
				out.push(null);
				continue;
			}
			var describe = describeByObject[rec.objectName];
			if (!describe) {
				out.push({ status: 'pending', issues: [], resolvedRecordTypeId: null });
				continue;
			}
			out.push(computeMigrationStatus(rec, describe));
		}
		return out;
	}

	// Roll an annotation list up into counts for the readiness summary.
	function summarize(annotations) {
		var counts = { ready: 0, warning: 0, blocked: 0, pending: 0, total: 0 };
		annotations = annotations || [];
		for (var i = 0; i < annotations.length; i++) {
			var a = annotations[i];
			if (!a) {
				continue;
			}
			counts.total++;
			if (counts[a.status] !== undefined) {
				counts[a.status]++;
			}
		}
		return counts;
	}

	// Convert a migration annotation into the single concise badge shown on
	// a canvas card. The detailed field/value remediation stays in the record
	// editor. In particular, call fields "unavailable" rather than "missing":
	// Salesforce's running-user describe intentionally cannot tell us whether
	// an omitted field is absent from the org or hidden by field permissions.
	function badgeSummary(annotation) {
		if (!annotation || !annotation.status || annotation.status === 'ready') {
			return null;
		}
		if (annotation.status === 'pending') {
			return {
				status: 'pending',
				label: 'checking...',
				title: 'Checking this record against the destination org.',
			};
		}

		var issues = Array.isArray(annotation.issues) ? annotation.issues : [];
		var issueCount = issues.length;
		if (annotation.status === 'blocked') {
			return {
				status: 'blocked',
				label: 'fix required',
				title: 'This record cannot be migrated yet. Open it to resolve ' +
					(issueCount === 1 ? '1 migration issue.' : issueCount + ' migration issues.'),
			};
		}

		var missing = issues.filter(function (issue) {
			return issue && issue.kind === 'missing-field';
		});
		if (missing.length === issueCount && issueCount > 0) {
			return {
				status: 'warning',
				label: issueCount === 1 ? '1 field unavailable' : issueCount + ' fields unavailable',
				title: 'The current Salesforce connection cannot provide ' +
					(issueCount === 1 ? 'this field' : 'these fields') +
					(issueCount === 1
						? '. The field may not exist in the destination org, or Salesforce permissions may hide it. Open the record to map the value or leave it out of the migration.'
						: '. The fields may not exist in the destination org, or Salesforce permissions may hide them. Open the record to map the values or leave them out of the migration.'),
			};
		}

		var picklists = issues.filter(function (issue) {
			return issue && issue.kind === 'picklist-mismatch';
		});
		if (picklists.length === issueCount && issueCount > 0) {
			var valueCount = 0;
			for (var i = 0; i < picklists.length; i++) {
				var values = picklists[i].invalidValues;
				valueCount += Array.isArray(values) && values.length ? values.length : 1;
			}
			return {
				status: 'warning',
				label: valueCount === 1 ? '1 value needs mapping' : valueCount + ' values need mapping',
				title: 'Open this record to map or leave out ' +
					(valueCount === 1 ? '1 destination-incompatible picklist value.' : valueCount + ' destination-incompatible picklist values.'),
			};
		}

		return {
			status: 'warning',
			label: issueCount === 1 ? '1 migration issue' : issueCount + ' migration issues',
			title: 'Open this record to review ' +
				(issueCount === 1 ? '1 migration issue.' : issueCount + ' migration issues.'),
		};
	}

	// Build the destination-safe values promised by the annotations UI.
	// Missing fields and unresolved invalid picklist members are warnings,
	// not blockers, because they are explicitly omitted here. User remaps
	// (including "drop") and the resolved target RecordTypeId are applied.
	function prepareMigrationValues(record, annotation) {
		var out = Object.assign({}, (record && record.values) || {});
		var issues = (annotation && annotation.issues) || [];
		for (var i = 0; i < issues.length; i++) {
			var issue = issues[i];
			if (!issue || !issue.field) {
				continue;
			}
			var key = Object.keys(out).find(function (k) {
				return k.toLowerCase() === String(issue.field).toLowerCase();
			});
			if (!key) {
				continue;
			}
			if (issue.kind === 'missing-field') {
				delete out[key];
			} else if (issue.kind === 'picklist-mismatch') {
				var invalid = {};
				(issue.invalidValues || []).forEach(function (v) {
					invalid[String(v)] = true;
				});
				var parts = String(out[key]).split(';').filter(function (v) {
					return !invalid[v];
				});
				if (parts.length) {
					out[key] = parts.join(';');
				} else {
					delete out[key];
				}
			}
		}
		if (annotation && annotation.resolvedRecordTypeId) {
			out.RecordTypeId = annotation.resolvedRecordTypeId;
		}
		var remap = record && record._migratePicklistRemap;
		if (remap) {
			Object.keys(remap).forEach(function (field) {
				var key = Object.keys(out).find(function (k) {
					return k.toLowerCase() === field.toLowerCase();
				});
				if (!key) {
					return;
				}
				var map = remap[field] || {};
				var parts = String(out[key]).split(';').map(function (part) {
					return Object.prototype.hasOwnProperty.call(map, part) ? map[part] : part;
				}).filter(function (part) {
					return part !== '';
				});
				if (parts.length) {
					out[key] = parts.join(';');
				} else {
					delete out[key];
				}
			});
		}
		return out;
	}

	var api = {
		computeMigrationStatus: computeMigrationStatus,
		resolveTargetRecordTypeId: resolveTargetRecordTypeId,
		annotateRecords: annotateRecords,
		summarize: summarize,
		badgeSummary: badgeSummary,
		prepareMigrationValues: prepareMigrationValues,
	};

	// Dual export: browser global for the canvas, CommonJS for unit tests.
	if (typeof window !== 'undefined') {
		window.Orgloom = window.Orgloom || {};
		window.Orgloom.migrateAnnotate = api;
	}
	if (typeof module !== 'undefined' && module.exports) {
		module.exports = api;
	}
})();
