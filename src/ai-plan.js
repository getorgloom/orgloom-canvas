import { isCreateInputField, isRequiredOnCreate } from './sf-field-structure.js';

export const AI_MAX_RECORDS = 100;
export const AI_MAX_OBJECTS = 10;
export const AI_MAX_PROMPT_CHARS = 2000;

const AI_MAX_PICKLIST_VALUES_IN_SUMMARY = 80;

export function buildAiDescribeSummary(describes, fkFieldsByObject) {
	return describes.map(({ name, describe }) => {
		const allowFkSet = fkFieldsByObject && Array.isArray(fkFieldsByObject[name])
			? new Set(fkFieldsByObject[name])
			: null;
		const fields = (describe.fields || [])
			.filter(isCreateInputField)
			.filter((f) => {
				if (!allowFkSet) {
return true;
}
				if (f.type !== 'reference') {
return true;
}
				return allowFkSet.has(f.name);
			})
			.map((f) => {
				const req = isRequiredOnCreate(f) ? ' REQUIRED' : '';
				let extra = '';
				if (f.type === 'picklist' || f.type === 'multipicklist') {
					const values = (f.picklistValues || [])
						.filter((pv) => pv.active)
						.slice(0, AI_MAX_PICKLIST_VALUES_IN_SUMMARY)
						.map((pv) => pv.value);
					extra = ` values=[${values.join(', ')}${(f.picklistValues || []).length > AI_MAX_PICKLIST_VALUES_IN_SUMMARY ? ', ...' : ''}]`;
				} else if (f.type === 'reference' && Array.isArray(f.referenceTo) && f.referenceTo.length > 0) {
					extra = ` references=[${f.referenceTo.join(', ')}]`;
				}
				return `  - ${f.name}: ${f.type}${req}${extra}`;
			})
			.join('\n');
		return `Object ${name} (${describe.label || name}):\n${fields}`;
	}).join('\n\n');
}

export function buildAiSystemPrompt(summary) {
	return 'You are a Salesforce test-data planner. You produce structured plans of records to create and the foreign-key associations between them.\n\n' +
		'Available objects and createable fields:\n\n' +
		summary +
		'\n\nRules (you MUST follow all of them):\n' +
		'1. Generate ONLY records of the objects listed above. Never invent new object types.\n' +
		'2. Use ONLY field API names that are listed for that object. Do not hallucinate fields.\n' +
		'3. For picklist fields, pick ONLY from the listed values. For multipicklists, use semicolon-delimited values.\n' +
		'4. Fill every field marked REQUIRED with a plausible, realistic sample value.\n' +
		'5. Do NOT place a literal Salesforce ID into a `reference` field. Instead, create an entry in the associations array pointing from the record that owns the reference field to the record it should link to.\n' +
		'6. tempIds are integers starting at 1 and must be unique within your plan. Use them to reference records in associations.\n' +
		'7. Use fictional names, addresses, and data. Never include real personally-identifiable information.\n' +
		'8. Keep the plan tight. Generate at most ' + AI_MAX_RECORDS + ' records, and prefer fewer realistic records over larger counts.\n' +
		'9. Dates: YYYY-MM-DD. Datetimes: YYYY-MM-DDTHH:MM:SS.000Z. Times: HH:MM:SS. Booleans: true/false.\n' +
		'10. Emit your answer by calling the create_plan tool. Do not respond with free text.';
}

export const AI_PLAN_TOOL = {
	name: 'create_plan',
	description: 'Emit a structured plan of Salesforce records and foreign-key associations that will be created on the user\'s canvas.',
	input_schema: {
		type: 'object',
		required: ['records'],
		properties: {
			records: {
				type: 'array',
				maxItems: AI_MAX_RECORDS,
				description: 'Records to create. Each gets a unique tempId used by associations.',
				items: {
					type: 'object',
					required: ['tempId', 'objectName', 'values'],
					properties: {
						tempId: { type: 'integer', minimum: 1, description: 'Unique within this plan.' },
						objectName: { type: 'string', description: 'API name of one of the available objects.' },
						values: {
							type: 'object',
							description: 'Field API name → value. Only set fields from the object\'s listed schema. Do not set reference fields here; use associations.',
							additionalProperties: true,
						},
					},
				},
			},
			associations: {
				type: 'array',
				description: 'FK links. Each populates the named reference field on the `fromTempId` record with the real ID of the `toTempId` record at upload time.',
				items: {
					type: 'object',
					required: ['fromTempId', 'toTempId', 'fieldName'],
					properties: {
						fromTempId: { type: 'integer' },
						toTempId: { type: 'integer' },
						fieldName: { type: 'string' },
					},
				},
			},
		},
	},
};

export function validateAiPlan(plan, describes) {
	const warnings = [];
	const describeByName = new Map(describes.map(({ name, describe }) => [name, describe]));
	const records = [];
	const tempIdToRecord = new Map();
	const rawRecords = Array.isArray(plan.records) ? plan.records : [];
	if (rawRecords.length > AI_MAX_RECORDS) {
		warnings.push('Plan contained ' + rawRecords.length + ' records; only the first ' + AI_MAX_RECORDS + ' were kept.');
	}
	rawRecords.slice(0, AI_MAX_RECORDS).forEach((r, idx) => {
		if (!r || typeof r !== 'object') {
			warnings.push('Record #' + idx + ' was malformed and was dropped.');
			return;
		}
		if (!Number.isInteger(r.tempId) || r.tempId < 1) {
			warnings.push('Record #' + idx + ' has an invalid tempId and was dropped.');
			return;
		}
		if (tempIdToRecord.has(r.tempId)) {
			warnings.push('Record tempId=' + r.tempId + ' is duplicated; the later record was dropped.');
			return;
		}
		const describe = describeByName.get(r.objectName);
		if (!describe) {
			warnings.push('Record tempId=' + r.tempId + ' targets unknown object "' + r.objectName + '" and was dropped.');
			return;
		}
		const fieldByName = new Map((describe.fields || []).map((f) => [f.name, f]));
		const cleanValues = {};
		Object.entries(r.values || {}).forEach(([fname, fval]) => {
			const f = fieldByName.get(fname);
			if (!f) {
 warnings.push('tempId=' + r.tempId + ' (' + r.objectName + '): unknown field "' + fname + '" was dropped.'); return;
}
			if (!f.createable) {
 warnings.push('tempId=' + r.tempId + ' (' + r.objectName + '): non-createable field "' + fname + '" was dropped.'); return;
}
			if (f.type === 'reference') {
				warnings.push('tempId=' + r.tempId + ' (' + r.objectName + '): reference field "' + fname + '" must come from an association, so it was dropped.');
				return;
			}
			if (f.type === 'picklist') {
				const allowed = new Set((f.picklistValues || []).filter((v) => v.active).map((v) => v.value));
				if (!allowed.has(fval)) {
					warnings.push('tempId=' + r.tempId + ' (' + r.objectName + '): picklist "' + fname + '" value "' + fval + '" is not allowed and was dropped.');
					return;
				}
			}
			if (f.type === 'multipicklist') {
				const allowed = new Set((f.picklistValues || []).filter((v) => v.active).map((v) => v.value));
				const parts = String(fval || '').split(';').map((p) => p.trim()).filter(Boolean);
				const valid = parts.filter((p) => allowed.has(p));
				if (valid.length === 0) {
					warnings.push('tempId=' + r.tempId + ' (' + r.objectName + '): no valid multipicklist values in "' + fname + '", so the field was dropped.');
					return;
				}
				cleanValues[fname] = valid.join(';');
				return;
			}
			cleanValues[fname] = fval;
		});
		const normalized = {
			tempId: r.tempId,
			objectName: r.objectName,
			values: cleanValues,
		};
		records.push(normalized);
		tempIdToRecord.set(r.tempId, normalized);
	});
	const associations = [];
	(plan.associations || []).forEach((a) => {
		if (!a || typeof a !== 'object') {
return;
}
		const from = tempIdToRecord.get(a.fromTempId);
		const to = tempIdToRecord.get(a.toTempId);
		if (!from || !to) {
			warnings.push('Association references missing record (' + a.fromTempId + ' → ' + a.toTempId + '); dropped.');
			return;
		}
		const describe = describeByName.get(from.objectName);
		const field = (describe.fields || []).find((f) => f.name === a.fieldName);
		if (!field) {
 warnings.push('Association field "' + a.fieldName + '" not on ' + from.objectName + '; dropped.'); return;
}
		if (field.type !== 'reference') {
 warnings.push('Association field "' + a.fieldName + '" on ' + from.objectName + ' is not a reference; dropped.'); return;
}
		if (Array.isArray(field.referenceTo) && !field.referenceTo.includes(to.objectName)) {
			warnings.push('Association target type mismatch on ' + from.objectName + '.' + a.fieldName + ' (expected ' + field.referenceTo.join('|') + ', got ' + to.objectName + '); dropped.');
			return;
		}
		if (!field.createable) {
			warnings.push('Association field "' + a.fieldName + '" on ' + from.objectName + ' is not createable; dropped.');
			return;
		}
		associations.push({ fromTempId: a.fromTempId, toTempId: a.toTempId, fieldName: a.fieldName });
	});
	return { records, associations, warnings };
}
