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
			const fallbackName = r.FullName
				? r.FullName.split('.').slice(1).join('.') || null
				: null;
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
