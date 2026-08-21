(function () {
	'use strict';
	// Compares source canvas values with destination describe metadata to identify migration gaps.

	var SYSTEM_KEYS = {
		attributes: 1,
		id: 1,
		createddate: 1,
		createdbyid: 1,
		lastmodifieddate: 1,
		lastmodifiedbyid: 1,
		systemmodstamp: 1,
		isdeleted: 1,
		ownerid: 1,
		recordtypeid: 1,
		masterrecordid: 1,
		lastreferenceddate: 1,
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

	function picklistValuesForRecordType(field, recordTypeId) {
		var byRecordType = field && field.picklistValuesByRecordType;
		if (recordTypeId && byRecordType && Object.prototype.hasOwnProperty.call(byRecordType, recordTypeId)) {
			return Array.isArray(byRecordType[recordTypeId]) ? byRecordType[recordTypeId] : [];
		}
		if (recordTypeId && byRecordType && Object.keys(byRecordType).length > 0) {
			return [];
		}
		return field && Array.isArray(field.picklistValues) ? field.picklistValues : [];
	}

	function hasAuthoritativePicklistValues(field, recordTypeId) {
		var byRecordType = field && field.picklistValuesByRecordType;
		if (recordTypeId && byRecordType && Object.prototype.hasOwnProperty.call(byRecordType, recordTypeId)) {
			return true;
		}
		if (recordTypeId && byRecordType && Object.keys(byRecordType).length > 0) {
			return false;
		}
		return !!(field && Array.isArray(field.picklistValues) && field.picklistValues.length);
	}

	function picklistValuesForContext(field, recordTypeId, values) {
		var options = picklistValuesForRecordType(field, recordTypeId);
		if (!field || !field.controllerName) {
			return options;
		}
		var mapsByRecordType = field.controllerValuesByRecordType;
		var controllerMap =
			mapsByRecordType && recordTypeId && Object.prototype.hasOwnProperty.call(mapsByRecordType, recordTypeId)
				? mapsByRecordType[recordTypeId]
				: field.controllerValues;
		if (!controllerMap || typeof controllerMap !== 'object') {
			return options;
		}
		var rawController = _lookupValue(values, field.controllerName);
		var controllerKey = rawController == null ? '' : String(rawController);
		if (!controllerKey || !Object.prototype.hasOwnProperty.call(controllerMap, controllerKey)) {
			return [];
		}
		var controllerIndex = controllerMap[controllerKey];
		return options.filter(function (option) {
			return Array.isArray(option && option.validFor) && option.validFor.indexOf(controllerIndex) !== -1;
		});
	}

	function supportsCustomPicklistValue(field) {
		return !!(
			field &&
			(field.type === 'combobox' ||
				((field.type === 'picklist' || field.type === 'multipicklist') && field.restrictedPicklist === false))
		);
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
		// Treat missing fields as ambiguous: they may not exist or may be hidden by destination FLS.
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
				continue; // nothing to migrate for this field
			}
			if (!fieldByName[String(key).toLowerCase()]) {
				issues.push({
					kind: 'missing-field',
					severity: 'warning',
					field: key,
					message:
						'“' +
						key +
						'” is unavailable through the destination connection and will be skipped. It may not exist in the destination org, or Salesforce permissions may hide it.',
				});
			}
		}

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

		var sourceRecordTypeDeveloperName =
			record &&
			(record._sourceRecordTypeDeveloperName || (record.values && record.values._sourceRecordTypeDeveloperName));
		var picklistRecordTypeId =
			(record && record._migrateRecordTypeId) ||
			resolveTargetRecordTypeId(sourceRecordTypeDeveloperName, targetDescribe) ||
			(targetDescribe && targetDescribe.defaultRecordTypeId) ||
			null;
		var picklistRecordTypeAvailable =
			!picklistRecordTypeId ||
			!targetDescribe ||
			!Array.isArray(targetDescribe.recordTypes) ||
			targetDescribe.recordTypes.some(function (recordType) {
				return recordType && recordType.id === picklistRecordTypeId;
			});
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
			if (
				(pf.type === 'picklist' || pf.type === 'multipicklist') &&
				!supportsCustomPicklistValue(pf) &&
				picklistRecordTypeAvailable &&
				hasAuthoritativePicklistValues(pf, picklistRecordTypeId)
			) {
				var picklistValues = picklistValuesForContext(pf, picklistRecordTypeId, values);
				var active = {};
				for (var a = 0; a < picklistValues.length; a++) {
					var opt = picklistValues[a];
					if (opt && opt.active !== false) {
						active[String(opt.value)] = 1;
					}
				}
				var parts = pf.type === 'multipicklist' ? String(pv).split(';') : [String(pv)];
				var fieldRemap = _picklistRemapFor(record, pkey);
				var bad = [];
				for (var b = 0; b < parts.length; b++) {
					var part = parts[b];
					if (part === '' || active[part] === 1) {
						continue; // empty or already valid
					}
					if (fieldRemap && Object.prototype.hasOwnProperty.call(fieldRemap, part)) {
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
						message:
							'“' + pkey + '”: ' + bad.join(', ') + ' not a valid picklist value in the destination org.',
					});
				}
			}
		}

		var srcRtDevName =
			record &&
			(record._sourceRecordTypeDeveloperName || (record.values && record.values._sourceRecordTypeDeveloperName));
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
					message:
						'Record type “' +
						srcRtDevName +
						'” doesn’t exist in the destination org. Pick a record type or clear it.',
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
		var status = hasBlocked ? 'blocked' : hasWarning ? 'warning' : 'ready';

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
				title:
					'This record cannot be migrated yet. Open it to resolve ' +
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
				title:
					'The current Salesforce connection cannot provide ' +
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
				title:
					'Open this record to map or leave out ' +
					(valueCount === 1
						? '1 destination-incompatible picklist value.'
						: valueCount + ' destination-incompatible picklist values.'),
			};
		}

		return {
			status: 'warning',
			label: issueCount === 1 ? '1 migration issue' : issueCount + ' migration issues',
			title:
				'Open this record to review ' +
				(issueCount === 1 ? '1 migration issue.' : issueCount + ' migration issues.'),
		};
	}

	function prepareMigrationValues(record, annotation) {
		// Apply reviewed omissions and remaps to an upload copy, leaving source canvas values intact.
		var out = Object.assign({}, (record && record.values) || {});
		// Updating a destination match is merge-like: a blank source field means there is
		// no value to migrate, not an instruction to erase the destination value.
		if (record && record._migrateMatchedId) {
			Object.keys(out).forEach(function (key) {
				var value = out[key];
				if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
					delete out[key];
				}
			});
		}
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
				var parts = String(out[key])
					.split(';')
					.filter(function (v) {
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
				var parts = String(out[key])
					.split(';')
					.map(function (part) {
						return Object.prototype.hasOwnProperty.call(map, part) ? map[part] : part;
					})
					.filter(function (part) {
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

	var MIGRATION_RECORD_KEYS = [
		'_migrateMatchedId',
		'_migrateMatchKey',
		'_migrateMatchValue',
		'_migrateMatchAmbiguous',
		'_migrateMatchResolution',
		'_migrateMatchIntent',
		'_migrateMatchCandidates',
		'_migrateMatchSearched',
		'_migrateMatchSearchError',
		'_migrateRecordTypeId',
		'_migrateClearRecordType',
		'_migratePicklistRemap',
		'_migrateFieldResolutions',
		'_sourceRecordTypeDeveloperName',
		'_wasLoadedFromOrgId',
		'_wasLoadedFromId',
	];

	function _recordKey(objectName, sfId) {
		return String(objectName || '') + '::' + String(sfId || '');
	}

	function _valueKey(values, fieldName) {
		if (!values || !fieldName) {
			return null;
		}
		var wanted = String(fieldName).toLowerCase();
		var keys = Object.keys(values);
		for (var i = 0; i < keys.length; i++) {
			if (keys[i].toLowerCase() === wanted) {
				return keys[i];
			}
		}
		return null;
	}

	function applyMigrationPlan(records, associations, annotationsById, baselinesByKey) {
		// Compile the entire plan before touching live records. A failed destination
		// refresh therefore leaves the reviewable migration state intact.
		var source = Array.isArray(records) ? records : [];
		var annotations = annotationsById || {};
		var baselines = baselinesByKey || {};
		var plannedById = {};
		var planned = [];
		var updates = 0;
		var creates = 0;

		for (var i = 0; i < source.length; i++) {
			var record = source[i];
			if (!record || record.isTypeNode) {
				continue;
			}
			var matchedId = record._migrateMatchedId || null;
			var patch = prepareMigrationValues(record, annotations[record.id] || null);
			delete patch.attributes;
			delete patch.Id;
			var next;
			if (matchedId) {
				var baseline = baselines[_recordKey(record.objectName, matchedId)];
				if (!baseline || typeof baseline !== 'object') {
					throw new Error(
						'Could not load the selected destination record for ' + (record.objectName || 'record') + '.',
					);
				}
				var loadedValues = Object.assign({}, baseline);
				if (!_valueKey(loadedValues, 'Id')) {
					loadedValues.Id = matchedId;
				}
				next = {
					record: record,
					loadedFromId: matchedId,
					loadedValues: loadedValues,
					values: Object.assign({}, loadedValues, patch),
				};
				updates++;
			} else {
				next = {
					record: record,
					loadedFromId: null,
					loadedValues: null,
					values: Object.assign({}, patch),
				};
				creates++;
			}
			planned.push(next);
			plannedById[String(record.id)] = next;
		}

		(Array.isArray(associations) ? associations : []).forEach(function (association) {
			if (!association || !association.fieldName) {
				return;
			}
			var child = plannedById[String(association.fromId)];
			var parent = plannedById[String(association.toId)];
			if (!child || !parent) {
				return;
			}
			var existingKey = _valueKey(child.values, association.fieldName);
			if (parent.loadedFromId) {
				child.values[existingKey || association.fieldName] = parent.loadedFromId;
			} else if (existingKey) {
				delete child.values[existingKey];
			}
		});

		planned.forEach(function (next) {
			var record = next.record;
			record.values = next.values;
			if (next.loadedFromId) {
				record.loadedFromId = next.loadedFromId;
				record.loadedValues = next.loadedValues;
				record._deletedInSf = false;
				record._inaccessible = false;
			} else {
				delete record.loadedFromId;
				delete record.loadedValues;
			}
			MIGRATION_RECORD_KEYS.forEach(function (key) {
				delete record[key];
			});
		});

		return { updates: updates, creates: creates, total: updates + creates };
	}

	var api = {
		computeMigrationStatus: computeMigrationStatus,
		resolveTargetRecordTypeId: resolveTargetRecordTypeId,
		picklistValuesForRecordType: picklistValuesForRecordType,
		supportsCustomPicklistValue: supportsCustomPicklistValue,
		annotateRecords: annotateRecords,
		summarize: summarize,
		badgeSummary: badgeSummary,
		prepareMigrationValues: prepareMigrationValues,
		applyMigrationPlan: applyMigrationPlan,
	};

	if (typeof window !== 'undefined') {
		window.Orgloom = window.Orgloom || {};
		window.Orgloom.migrateAnnotate = api;
	}
	if (typeof module !== 'undefined' && module.exports) {
		module.exports = api;
	}
})();
