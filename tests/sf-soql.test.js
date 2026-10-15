import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
	escapeSoqlLiteral,
	formatSoqlFieldLiteral,
	normalizeSoqlFieldValue,
	validateSoqlFilterField,
} from '../src/sf-soql.js';

describe('validateSoqlFilterField: app-generated WHERE fields', () => {
	const describeFixture = {
		fields: [
			{ name: 'Name', label: 'Account Name', type: 'string', filterable: true },
			{ name: 'Description', label: 'Description', type: 'textarea', filterable: false },
			{ name: 'Parent__c', label: 'Parent', type: 'reference', filterable: true },
			{ name: 'External_Key__c', label: 'External Key', type: 'string', filterable: true, externalId: true },
		],
	};

	test('returns the canonical field only when Salesforce marks it filterable', () => {
		const result = validateSoqlFilterField(describeFixture, 'Name');
		assert.equal(result.ok, true);
		assert.equal(result.field.name, 'Name');
	});

	test('rejects non-filterable, unknown, and syntactically invalid fields', () => {
		assert.equal(validateSoqlFilterField(describeFixture, 'Description').reason, 'field-not-filterable');
		assert.equal(validateSoqlFilterField(describeFixture, 'Missing__c').reason, 'unknown-field');
		assert.equal(validateSoqlFilterField(describeFixture, 'Name FROM Contact').reason, 'invalid-field-name');
	});

	test('can additionally require a lookup or External ID field', () => {
		assert.equal(validateSoqlFilterField(describeFixture, 'Parent__c', { requireReference: true }).ok, true);
		assert.equal(
			validateSoqlFilterField(describeFixture, 'Name', { requireReference: true }).reason,
			'field-not-reference',
		);
		assert.equal(validateSoqlFilterField(describeFixture, 'External_Key__c', { requireExternalId: true }).ok, true);
		assert.equal(
			validateSoqlFilterField(describeFixture, 'Name', { requireExternalId: true }).reason,
			'field-not-external-id',
		);
	});
});

describe('escapeSoqlLiteral: single quote', () => {
	test('escapes a single quote', () => {
		assert.equal(escapeSoqlLiteral("O'Brien"), "O\\'Brien");
	});

	test('escapes multiple quotes', () => {
		assert.equal(escapeSoqlLiteral("'a'b'c'"), "\\'a\\'b\\'c\\'");
	});

	test('leaves a string with no quotes alone', () => {
		assert.equal(escapeSoqlLiteral('plain'), 'plain');
	});
});

describe('escapeSoqlLiteral: backslash', () => {
	test('escapes a backslash', () => {
		assert.equal(escapeSoqlLiteral('a\\b'), 'a\\\\b');
	});

	test('escapes multiple backslashes', () => {
		assert.equal(escapeSoqlLiteral('\\\\'), '\\\\\\\\');
	});

	test('escapes a trailing backslash (would otherwise escape the closing quote)', () => {
		assert.equal(escapeSoqlLiteral('foo\\'), 'foo\\\\');
	});
});

describe('escapeSoqlLiteral: combined', () => {
	test("escapes backslash before quote (order matters: \\ first, then ')", () => {
		assert.equal(escapeSoqlLiteral("a\\'b"), "a\\\\\\'b");
	});

	test('mix of quotes, backslashes, and plain text', () => {
		assert.equal(escapeSoqlLiteral("Path: C:\\Users\\O'Brien\\file"), "Path: C:\\\\Users\\\\O\\'Brien\\\\file");
	});

	test('idempotent on already-escaped input doubles the escapes (NOT a no-op)', () => {
		const once = escapeSoqlLiteral("O'Brien");
		const twice = escapeSoqlLiteral(once);
		assert.notEqual(once, twice);
		assert.equal(twice, "O\\\\\\'Brien");
	});
});

describe('escapeSoqlLiteral: null / undefined / non-string inputs', () => {
	test('null → empty string', () => {
		assert.equal(escapeSoqlLiteral(null), '');
	});

	test('undefined → empty string', () => {
		assert.equal(escapeSoqlLiteral(undefined), '');
	});

	test('empty string → empty string', () => {
		assert.equal(escapeSoqlLiteral(''), '');
	});

	test('number is coerced to string and passes through', () => {
		assert.equal(escapeSoqlLiteral(42), '42');
	});

	test('boolean is coerced to string', () => {
		assert.equal(escapeSoqlLiteral(true), 'true');
	});

	test('object with toString is coerced', () => {
		const obj = { toString: () => "it's" };
		assert.equal(escapeSoqlLiteral(obj), "it\\'s");
	});
});

describe('escapeSoqlLiteral: wildcards passed through (NOT escaped)', () => {
	test('% is preserved (used as LIKE wildcard by callers)', () => {
		assert.equal(escapeSoqlLiteral('100%'), '100%');
	});

	test('_ is preserved', () => {
		assert.equal(escapeSoqlLiteral('a_b'), 'a_b');
	});

	test('% combined with a quote: only the quote is escaped', () => {
		assert.equal(escapeSoqlLiteral("100%'"), "100%\\'");
	});
});

describe('escapeSoqlLiteral: defends against the classic injection attempts', () => {
	test('OR injection: quote-break + clause-append', () => {
		const malicious = "x' OR Id != null --";
		const out = escapeSoqlLiteral(malicious);
		assert.equal(out, "x\\' OR Id != null --");
		assert.equal(out.match(/(?<!\\)'/g), null);
	});

	test('UNION injection attempt with terminating backslash + quote', () => {
		const malicious = 'a\\';
		const out = escapeSoqlLiteral(malicious);
		assert.equal(out, 'a\\\\');
		const literal = "'" + out + "'";
		assert.equal((literal.match(/'/g) || []).length, 2);
	});
});

describe('formatSoqlFieldLiteral: destination field types', () => {
	test('quotes and escapes string-like match values', () => {
		assert.equal(formatSoqlFieldLiteral("O'Brien", 'string'), "'O\\'Brien'");
	});

	test('emits double, currency, percent, and integer values without quotes', () => {
		assert.equal(formatSoqlFieldLiteral('100', 'double'), '100');
		assert.equal(formatSoqlFieldLiteral('00100.5000', 'currency'), '100.5');
		assert.equal(formatSoqlFieldLiteral('-.50', 'percent'), '-0.5');
		assert.equal(formatSoqlFieldLiteral('1e-7', 'percent'), '0.0000001');
		assert.equal(formatSoqlFieldLiteral(42, 'int'), '42');
	});

	test('rejects nonnumeric input rather than interpolating it into a numeric predicate', () => {
		assert.throws(() => formatSoqlFieldLiteral("100) OR Name != ''", 'double'), /invalid numeric SOQL value/);
		assert.throws(() => formatSoqlFieldLiteral('1.5', 'int'), /invalid integer SOQL value/);
	});
});

describe('normalizeSoqlFieldValue: numeric match identity', () => {
	test('equivalent numeric spellings join to the same response bucket', () => {
		assert.equal(normalizeSoqlFieldValue('100.00', 'double'), '100');
		assert.equal(normalizeSoqlFieldValue(100, 'double'), '100');
		assert.equal(normalizeSoqlFieldValue('-0.00', 'currency'), '0');
	});

	test('removes a long trailing-zero suffix without a regular expression', () => {
		assert.equal(normalizeSoqlFieldValue('12.34' + '0'.repeat(10_000), 'double'), '12.34');
	});

	test('string values retain their original spelling', () => {
		assert.equal(normalizeSoqlFieldValue('00100.00', 'string'), '00100.00');
	});
});
