// SOQL escape helpers. Centralizes the replace pattern that's been
// inlined across server.js so every endpoint that interpolates user
// input into a single-quoted SOQL literal does it the same way.
//
// Why a function instead of prepared statements: jsforce's connection
// API takes a SOQL string. There is no parameterized query path to fall
// back on, so untrusted input must be escaped before it lands in the
// query.
//
// Escape contract (single-quoted literals only, `'…'`):
//   * `\` → `\\`
//   * `'` → `\'`
// Wildcards (`%`, `_`) are intentionally NOT escaped. They are
// treated as literals inside `=` comparisons but as wildcards inside
// `LIKE`: current callers want LIKE wildcards to keep working when
// typed by the user, so leaving them alone is the right default. If a
// future caller needs LIKE-safe escaping, add a separate
// `escapeSoqlLikeLiteral` helper rather than overloading this one.

export function escapeSoqlLiteral(value) {
	if (value == null) {
return '';
}
	return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// Validate a field before app-generated SOQL places it in a WHERE clause.
// SELECT-list fields have different rules and intentionally do not use this
// helper. Raw SOQL Import is also intentionally excluded because the user is
// authoring that query and Salesforce is its parser/validator.
export function validateSoqlFilterField(describe, fieldName, options = {}) {
	const name = String(fieldName == null ? '' : fieldName).trim();
	if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
		return {
			ok: false,
			reason: 'invalid-field-name',
			message: 'Invalid Salesforce field name.',
		};
	}
	const field = describe && Array.isArray(describe.fields)
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

const SOQL_NUMERIC_FIELD_TYPES = new Set([
	'int', 'long', 'double', 'currency', 'percent',
]);

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
	fraction = fraction.replace(/0+$/, '');
	if (!whole) {
		whole = '0';
	}
	const isZero = whole === '0' && !fraction;
	return (match[1] && !isZero ? '-' : '') + whole + (fraction ? '.' + fraction : '');
}

// Format a value for a SOQL comparison using the destination field's
// describe type. String-like values remain escaped and quoted; numeric
// fields must be emitted as validated, unquoted decimal literals.
export function formatSoqlFieldLiteral(value, fieldType) {
	const type = String(fieldType || '').toLowerCase();
	if (SOQL_NUMERIC_FIELD_TYPES.has(type)) {
		return canonicalDecimal(value, type === 'int' || type === 'long');
	}
	return "'" + escapeSoqlLiteral(value) + "'";
}

// Canonical comparison key used to join requested values back to records
// returned by Salesforce. This makes 100, 100.0, and 0100 equivalent for a
// numeric field without weakening string matching.
export function normalizeSoqlFieldValue(value, fieldType) {
	const type = String(fieldType || '').toLowerCase();
	if (SOQL_NUMERIC_FIELD_TYPES.has(type)) {
		return canonicalDecimal(value, type === 'int' || type === 'long');
	}
	return String(value);
}
