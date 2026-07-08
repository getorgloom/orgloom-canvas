



































(function () {
	'use strict';




	var SYSTEM_KEYS = {
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


		return lk.charAt(0) === '_' || SYSTEM_KEYS[lk] === 1;
	}



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








	function computeMigrationStatus(record, targetDescribe) {
		var issues = [];
		var resolvedRecordTypeId = null;
		var values = (record && record.values) || {};
		var fields = (targetDescribe && targetDescribe.fields) || [];


		var fieldByName = {};
		for (var i = 0; i < fields.length; i++) {
			var f = fields[i];
			if (f && f.name) {
				fieldByName[String(f.name).toLowerCase()] = f;
			}
		}


		var valueKeys = Object.keys(values);
		for (var k = 0; k < valueKeys.length; k++) {
			var key = valueKeys[k];
			if (_isIgnoredKey(key)) {
				continue;
			}
			if (_isEmpty(values[key])) {
				continue;
			}
			if (!fieldByName[String(key).toLowerCase()]) {
				issues.push({
					kind: 'missing-field',
					severity: 'warning',
					field: key,
					message: '“' + key + '” doesn’t exist in the destination org and will be skipped.',
				});
			}
		}









		var _isUpdate = !!(record && record.loadedFromId);
		for (var r = 0; !_isUpdate && r < fields.length; r++) {
			var tf = fields[r];
			if (!tf || tf.required !== true) {
				continue;
			}
			if (_isIgnoredKey(tf.name)) {
				continue;
			}
			if (tf.type === 'reference') {
				continue;
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


		for (var p = 0; p < valueKeys.length; p++) {
			var pkey = valueKeys[p];
			if (_isIgnoredKey(pkey)) {
				continue;
			}
			var pf = fieldByName[String(pkey).toLowerCase()];
			if (!pf) {
				continue;
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
						continue;
					}

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




		var srcRtDevName = record &&
			(record._sourceRecordTypeDeveloperName ||
				(record.values && record.values._sourceRecordTypeDeveloperName));
		if (record && record._migrateClearRecordType) {
			resolvedRecordTypeId = null;
		} else if (record && record._migrateRecordTypeId) {
			resolvedRecordTypeId = record._migrateRecordTypeId;
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

	var api = {
		computeMigrationStatus: computeMigrationStatus,
		resolveTargetRecordTypeId: resolveTargetRecordTypeId,
		annotateRecords: annotateRecords,
		summarize: summarize,
	};


	if (typeof window !== 'undefined') {
		window.Orgloom = window.Orgloom || {};
		window.Orgloom.migrateAnnotate = api;
	}
	if (typeof module !== 'undefined' && module.exports) {
		module.exports = api;
	}
})();
