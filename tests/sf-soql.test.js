import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { escapeSoqlLiteral } from '../src/sf-soql.js';

describe('escapeSoqlLiteral — single quote', () => {
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

describe('escapeSoqlLiteral — backslash', () => {
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

describe('escapeSoqlLiteral — combined', () => {
	test('escapes backslash before quote (order matters: \\ first, then \')', () => {

		assert.equal(escapeSoqlLiteral("a\\'b"), "a\\\\\\'b");
	});

	test('mix of quotes, backslashes, and plain text', () => {
		assert.equal(
			escapeSoqlLiteral("Path: C:\\Users\\O'Brien\\file"),
			"Path: C:\\\\Users\\\\O\\'Brien\\\\file",
		);
	});

	test('idempotent on already-escaped input doubles the escapes (NOT a no-op)', () => {

		const once = escapeSoqlLiteral("O'Brien");
		const twice = escapeSoqlLiteral(once);
		assert.notEqual(once, twice);
		assert.equal(twice, "O\\\\\\'Brien");
	});
});

describe('escapeSoqlLiteral — null / undefined / non-string inputs', () => {
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

describe('escapeSoqlLiteral — wildcards passed through (NOT escaped)', () => {
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

describe('escapeSoqlLiteral — defends against the classic injection attempts', () => {
	test('OR injection: quote-break + clause-append', () => {

		const malicious = "x' OR Id != null --";
		const out = escapeSoqlLiteral(malicious);
		assert.equal(out, "x\\' OR Id != null --");

		assert.equal(out.match(/(?<!\\)'/g), null);
	});

	test('UNION injection attempt with terminating backslash + quote', () => {

		const malicious = "a\\";
		const out = escapeSoqlLiteral(malicious);

		assert.equal(out, 'a\\\\');
		const literal = "'" + out + "'";

		assert.equal((literal.match(/'/g) || []).length, 2);
	});
});
