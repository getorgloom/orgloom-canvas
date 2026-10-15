const SALESFORCE_ID = /^[a-zA-Z0-9]{15,18}$/;
const OBJECT_API_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export async function fetchToolingValidationRuleRecords(tooling, objectName, options = {}) {
	if (!tooling || typeof tooling.query !== 'function') {
		throw new TypeError('A Salesforce Tooling API client is required.');
	}
	if (!OBJECT_API_NAME.test(objectName || '')) {
		throw new TypeError('A valid Salesforce object API name is required.');
	}

	// Salesforce only permits Metadata and FullName when the query is guaranteed
	// to return one row. Discover IDs first, then qualify every metadata query by ID.
	const indexResult = await tooling.query(
		`SELECT Id FROM ValidationRule WHERE EntityDefinition.QualifiedApiName = '${objectName}'`,
	);
	const ids = Array.from(
		new Set(
			(Array.isArray(indexResult && indexResult.records) ? indexResult.records : [])
				.map((record) => String((record && record.Id) || ''))
				.filter((id) => SALESFORCE_ID.test(id)),
		),
	);
	if (ids.length === 0) {
		return [];
	}

	const requestedConcurrency = Number(options.concurrency);
	const concurrency = Number.isInteger(requestedConcurrency) ? Math.max(1, Math.min(requestedConcurrency, 10)) : 4;
	const records = new Array(ids.length);
	let nextIndex = 0;
	async function worker() {
		while (nextIndex < ids.length) {
			const index = nextIndex++;
			const id = ids[index];
			const detail = await tooling.query(
				`SELECT Id, FullName, Metadata FROM ValidationRule WHERE Id = '${id}' LIMIT 1`,
			);
			records[index] = Array.isArray(detail && detail.records) ? detail.records[0] || null : null;
		}
	}
	await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, () => worker()));
	return records.filter(Boolean);
}

export function transformToolingRecords(records) {
	if (!Array.isArray(records)) {
		return [];
	}
	return records
		.map((r) => {
			if (!r || typeof r !== 'object') {
				return null;
			}
			const m = r.Metadata || null;
			if (!m) {
				return null;
			}
			const fallbackName = r.FullName ? r.FullName.split('.').slice(1).join('.') || null : null;
			return {
				id: r.Id,
				name: m.name || fallbackName,
				active: m.active === true,
				description: m.description,
				errorMessage: m.errorMessage,
				errorDisplayField: m.errorDisplayField,
				formula: m.errorConditionFormula,
			};
		})
		.filter((r) => r && r.active)
		.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}
