// Server-side validation-rule helpers. The route at
// /api/objects/:name/validation-rules in canvas-routes.js is a thin
// wrapper around `transformToolingRecords`; the route handles auth,
// argument validation, and the actual SF Tooling-API query; the
// transformation that turns the raw records into the shape the modal
// expects lives here so it's unit-testable without spinning up
// express or mocking jsforce.
//
// The Tooling-API `ValidationRule` row shape we expect:
//
//   {
//     Id: '03dxx00000000xx',
//     FullName: 'Account.SSN_Length',
//     Metadata: {
//       name: 'SSN_Length',                       // friendly name
//       active: true,                              // we filter on this
//       description: 'SSN must be 9 digits',
//       errorMessage: 'SSN must be exactly 9 digits.',
//       errorDisplayField: 'SSN__c',               // null = page-level
//       errorConditionFormula: 'LEN(SSN__c) <> 9',
//     },
//   }
//
// SF's API can also return rules whose Metadata field is null (this
// happens for inactive rules in some API versions) or whose name
// field is missing (rare). Both cases are tolerated below by
// defensive defaults.

// Pure transformation. Takes the raw `result.records` array from
// `conn.tooling.query(...)` and returns the modal-ready shape:
//   - active rules only
//   - sorted by name (case-sensitive locale compare for stable order)
//   - normalized to {id, name, active, description, errorMessage,
//     errorDisplayField, formula}
//
// Inputs we tolerate:
//   - records being null / undefined / missing → returns []
//   - individual record's Metadata being null → row dropped (no
//     formula to evaluate; nothing the modal could do with it)
//   - rule name missing from Metadata → fall back to the last
//     dot-separated segment of FullName (SF's `Object.RuleName`
//     convention)
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
