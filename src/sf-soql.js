// Safe SOQL value formatting and field eligibility checks for every generated WHERE clause.
export function escapeSoqlLiteral(value) {
	if (value == null) {
		return '';
	}
	return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function validateSoqlFilterField(describe, fieldName, options = {}) {
	// Identifier syntax is necessary but not sufficient; Salesforce must also mark the field filterable.
	const name = String(fieldName == null ? '' : fieldName).trim();
	if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
		return {
			ok: false,
			reason: 'invalid-field-name',
			message: 'Invalid Salesforce field name.',
		};
	}
	const field =
		describe && Array.isArray(describe.fields)
			? describe.fields.find((candidate) => candidate && candidate.name === name)
			: null;
	if (!field) {
		return {
			ok: false,
			reason: 'unknown-field',
			message: name + ' is not a field on this Salesforce object.',
		};
	}
	if (field.filterable !== true) {
		return {
			ok: false,
			reason: 'field-not-filterable',
			field,
			message: (field.label || name) + ' cannot be used in a Salesforce filter.',
		};
	}
	if (options.requireExternalId && field.externalId !== true) {
		return {
			ok: false,
			reason: 'field-not-external-id',
			field,
			message: (field.label || name) + ' is not a Salesforce External ID field.',
		};
	}
	if (options.requireReference && field.type !== 'reference') {
		return {
			ok: false,
			reason: 'field-not-reference',
			field,
			message: (field.label || name) + ' is not a Salesforce lookup field.',
		};
	}
	return { ok: true, field };
}

const SOQL_NUMERIC_FIELD_TYPES = new Set(['int', 'long', 'double', 'currency', 'percent']);

function canonicalDecimal(value, integerOnly) {
	const raw = String(value == null ? '' : value).trim();
	const match = raw.match(/^(-?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/);
	if (!match) {
		throw new TypeError('invalid numeric SOQL value');
	}
	const exponent = match[5] ? Number(match[5]) : 0;
	if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) {
		throw new TypeError('invalid numeric SOQL exponent');
	}
	const inputWhole = match[2] || '';
	const inputFraction = match[3] || match[4] || '';
	const digits = inputWhole + inputFraction;
	const decimalAt = inputWhole.length + exponent;
	let whole;
	let fraction;
	if (decimalAt <= 0) {
		whole = '0';
		fraction = '0'.repeat(-decimalAt) + digits;
	} else if (decimalAt >= digits.length) {
		whole = digits + '0'.repeat(decimalAt - digits.length);
		fraction = '';
	} else {
		whole = digits.slice(0, decimalAt);
		fraction = digits.slice(decimalAt);
	}
	whole = whole.replace(/^0+(?=\d)/, '');
	if (integerOnly && fraction && /[^0]/.test(fraction)) {
		throw new TypeError('invalid integer SOQL value');
	}
	let fractionEnd = fraction.length;
	while (fractionEnd > 0 && fraction.charCodeAt(fractionEnd - 1) === 0x30) {
		fractionEnd -= 1;
	}
	fraction = fraction.slice(0, fractionEnd);
	if (!whole) {
		whole = '0';
	}
	const isZero = whole === '0' && !fraction;
	return (match[1] && !isZero ? '-' : '') + whole + (fraction ? '.' + fraction : '');
}

export function formatSoqlFieldLiteral(value, fieldType) {
	// Numeric and boolean literals must remain unquoted or Salesforce rejects otherwise-valid filters.
	const type = String(fieldType || '').toLowerCase();
	if (SOQL_NUMERIC_FIELD_TYPES.has(type)) {
		return canonicalDecimal(value, type === 'int' || type === 'long');
	}
	return "'" + escapeSoqlLiteral(value) + "'";
}

export function normalizeSoqlFieldValue(value, fieldType) {
	const type = String(fieldType || '').toLowerCase();
	if (SOQL_NUMERIC_FIELD_TYPES.has(type)) {
		return canonicalDecimal(value, type === 'int' || type === 'long');
	}
	return String(value);
}
