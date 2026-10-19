// Use only fields exposed by this connection's Describe. Keep candidate previews
// compact and exclude encrypted values, including encrypted external IDs.
export function migrationCandidateFields(describe, objectName) {
	const preferred =
		{
			Account: ['AccountNumber', 'BillingCity', 'BillingState', 'Website', 'Phone'],
			Contact: ['Email', 'Department', 'Title', 'Phone'],
			Lead: ['Email', 'Company', 'Title', 'Phone'],
			Case: ['Subject', 'Status', 'Origin'],
			Opportunity: ['StageName', 'CloseDate', 'Amount'],
			User: ['Username', 'Email'],
		}[objectName] || [];
	const fields = (describe.fields || []).filter(
		(field) =>
			field &&
			!field.nameField &&
			field.name !== 'Id' &&
			field.accessible !== false &&
			!field.encrypted &&
			field.type !== 'encryptedstring' &&
			['string', 'email', 'phone', 'url', 'picklist', 'date', 'currency', 'double', 'int'].includes(field.type),
	);
	const names = [...preferred, ...fields.filter((f) => f.externalId || f.unique).map((f) => f.name)];
	return [...new Set(names)]
		.map((name) => fields.find((f) => f.name === name))
		.filter(Boolean)
		.slice(0, 6);
}

export function migrationCandidateDetails(record, fields) {
	return fields
		.filter((field) => record[field.name] != null && record[field.name] !== '')
		.map((field) => ({
			name: field.name,
			label: field.label || field.name,
			value: String(record[field.name]),
		}));
}
