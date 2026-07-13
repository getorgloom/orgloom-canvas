import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
	tokenize,
	parseFormula,
	evalNode,
	num,
	looseEq,
	resolveFieldValue,
	evaluateRule,
	UNRESOLVED_FIELD,
} from '../src/validation-formula.js';

describe('tokenize', () => {
	test('skips whitespace', () => {
		const toks = tokenize('  AND  (  TRUE  ,  FALSE  )  ');
		assert.deepEqual(toks.map((t) => t.t), ['ID', '(', 'ID', ',', 'ID', ')']);
	});

	test('parses integer + decimal literals', () => {
		const toks = tokenize('5 + 3.14 + .5');
		assert.deepEqual(toks, [
			{ t: 'NUM', v: 5 }, { t: 'OP', v: '+' },
			{ t: 'NUM', v: 3.14 }, { t: 'OP', v: '+' },
			{ t: 'NUM', v: 0.5 },
		]);
	});

	test('parses double- and single-quoted string literals', () => {
		assert.deepEqual(tokenize('"hello"'), [{ t: 'STR', v: 'hello' }]);
		assert.deepEqual(tokenize("'world'"), [{ t: 'STR', v: 'world' }]);
	});

	test('two-character operators are read as a unit', () => {
		const tk = tokenize('a >= b <> c <= d != e == f');
		assert.deepEqual(
			tk.filter((t) => t.t === 'OP').map((t) => t.v),
			['>=', '<>', '<=', '!=', '=='],
		);
	});

	test('arithmetic operators tokenize singly', () => {
		const tk = tokenize('a + b - c * d / e & f');
		assert.deepEqual(
			tk.filter((t) => t.t === 'OP').map((t) => t.v),
			['+', '-', '*', '/', '&'],
		);
	});

	test('dotted identifiers stay as a single ID token', () => {
		assert.deepEqual(tokenize('Account.Name'), [{ t: 'ID', v: 'Account.Name' }]);
	});

	test('throws on an unexpected character', () => {
		assert.throws(() => tokenize('@'), /unexpected char/);
	});
});

describe('parseFormula', () => {
	test('literal number', () => {
		assert.deepEqual(parseFormula('42'), { k: 'lit', v: 42 });
	});

	test('literal string', () => {
		assert.deepEqual(parseFormula('"hi"'), { k: 'lit', v: 'hi' });
	});

	test('TRUE / FALSE / NULL identifiers resolve to literals', () => {
		assert.deepEqual(parseFormula('TRUE'), { k: 'lit', v: true });
		assert.deepEqual(parseFormula('FALSE'), { k: 'lit', v: false });
		assert.deepEqual(parseFormula('NULL'), { k: 'lit', v: null });
	});

	test('bare identifier becomes a field reference', () => {
		assert.deepEqual(parseFormula('Industry'), { k: 'field', name: 'Industry' });
	});

	test('arithmetic respects precedence', () => {

		const tree = parseFormula('2 + 3 * 4');
		assert.equal(tree.k, 'binop');
		assert.equal(tree.op, '+');
		assert.equal(tree.left.v, 2);
		assert.equal(tree.right.op, '*');
	});

	test('unary minus negates the following primary', () => {
		const tree = parseFormula('-Amount');
		assert.equal(tree.k, 'neg');
		assert.deepEqual(tree.x, { k: 'field', name: 'Amount' });
	});

	test('function call with multiple arguments', () => {
		const tree = parseFormula('AND(TRUE, FALSE, ISBLANK(Name))');
		assert.equal(tree.k, 'call');
		assert.equal(tree.name, 'AND');
		assert.equal(tree.args.length, 3);
		assert.equal(tree.args[2].name, 'ISBLANK');
	});

	test('function names are uppercased', () => {
		assert.equal(parseFormula('isblank(Name)').name, 'ISBLANK');
		assert.equal(parseFormula('IsBlank(Name)').name, 'ISBLANK');
	});

	test('parens override precedence', () => {
		const tree = parseFormula('(2 + 3) * 4');
		assert.equal(tree.op, '*');
		assert.equal(tree.left.op, '+');
	});

	test('throws on trailing tokens', () => {
		assert.throws(() => parseFormula('1 + 2 garbage'));
	});

	test('throws on unexpected end of input', () => {
		assert.throws(() => parseFormula('1 +'));
	});
});

describe('num', () => {
	test('passes numbers through', () => {
		assert.equal(num(3.14), 3.14);
		assert.equal(num(0), 0);
		assert.equal(num(-5), -5);
	});

	test('coerces numeric strings', () => {
		assert.equal(num('42'), 42);
		assert.equal(num('3.14'), 3.14);
	});

	test('null / undefined / empty string → 0', () => {
		assert.equal(num(null), 0);
		assert.equal(num(undefined), 0);
		assert.equal(num(''), 0);
	});

	test('non-numeric strings → 0 (matches SF blank-as-zero)', () => {
		assert.equal(num('abc'), 0);
	});
});

describe('looseEq', () => {
	test('null equals null', () => {
		assert.equal(looseEq(null, null), true);
	});

	test('null does not equal anything else', () => {
		assert.equal(looseEq(null, 0), false);
		assert.equal(looseEq(null, ''), false);
		assert.equal(looseEq(0, null), false);
	});

	test('numeric coercion when either side is a number', () => {
		assert.equal(looseEq(5, '5'), true);
		assert.equal(looseEq('5', 5), true);
		assert.equal(looseEq(5, '5.0'), true);
	});

	test('string equality is exact when neither side is a number', () => {
		assert.equal(looseEq('foo', 'foo'), true);
		assert.equal(looseEq('foo', 'Foo'), false);
	});
});

function ev(formula, vals = {}, opts = {}) {
	return evalNode(parseFormula(formula), vals, opts);
}

describe('evalNode: literals and fields', () => {
	test('literal number', () => assert.equal(ev('42'), 42));
	test('literal string', () => assert.equal(ev('"hi"'), 'hi'));
	test('TRUE literal', () => assert.equal(ev('TRUE'), true));
	test('FALSE literal', () => assert.equal(ev('FALSE'), false));

	test('field lookup hits the values map', () => {
		assert.equal(ev('Name', { Name: 'Acme' }), 'Acme');
	});

	test('missing field resolves to null', () => {
		assert.equal(ev('Missing', { Name: 'Acme' }), null);
	});

	test('empty-string value resolves to null (matches SF blank semantics)', () => {
		assert.equal(ev('Name', { Name: '' }), null);
	});
});

describe('evalNode: comparisons', () => {
	test('= and == are aliases', () => {
		assert.equal(ev('5 = 5'), true);
		assert.equal(ev('5 == 5'), true);
		assert.equal(ev('5 = 6'), false);
	});

	test('<> and != are aliases', () => {
		assert.equal(ev('5 <> 6'), true);
		assert.equal(ev('5 != 6'), true);
		assert.equal(ev('5 <> 5'), false);
	});

	test('ordering comparisons coerce to number', () => {
		assert.equal(ev('"3" < 5'), true);
		assert.equal(ev('"10" > 5'), true);
		assert.equal(ev('5 >= 5'), true);
		assert.equal(ev('5 <= 5'), true);
	});

	test('mixed numeric / string equality coerces to number', () => {
		assert.equal(ev('Amount = 100', { Amount: '100' }), true);
		assert.equal(ev('Amount = 100', { Amount: 100 }), true);
	});
});

describe('evalNode: arithmetic + concatenation', () => {
	test('+ adds', () => assert.equal(ev('2 + 3'), 5));
	test('- subtracts', () => assert.equal(ev('5 - 2'), 3));
	test('* multiplies', () => assert.equal(ev('3 * 4'), 12));
	test('/ divides', () => assert.equal(ev('10 / 4'), 2.5));
	test('/ by 0 → null', () => assert.equal(ev('5 / 0'), null));
	test('& concatenates strings', () => assert.equal(ev('"a" & "b"'), 'ab'));
	test('& on null operands treats them as empty string', () => {
		assert.equal(ev('Name & "-x"', { Name: null }), '-x');
	});
});

describe('evalNode: boolean functions', () => {
	test('AND requires every arg truthy', () => {
		assert.equal(ev('AND(TRUE, TRUE)'), true);
		assert.equal(ev('AND(TRUE, FALSE)'), false);
		assert.equal(ev('AND(TRUE, TRUE, TRUE)'), true);
	});

	test('OR fires when any arg is truthy', () => {
		assert.equal(ev('OR(FALSE, TRUE)'), true);
		assert.equal(ev('OR(FALSE, FALSE)'), false);
	});

	test('NOT inverts', () => {
		assert.equal(ev('NOT(TRUE)'), false);
		assert.equal(ev('NOT(FALSE)'), true);
	});

	test('IF picks the right branch', () => {
		assert.equal(ev('IF(TRUE, "yes", "no")'), 'yes');
		assert.equal(ev('IF(FALSE, "yes", "no")'), 'no');
	});
});

describe('evalNode: string functions', () => {
	test('ISBLANK true for null / undefined / empty / whitespace', () => {
		assert.equal(ev('ISBLANK(Name)', { Name: null }), true);
		assert.equal(ev('ISBLANK(Name)', { Name: '' }), true);
		assert.equal(ev('ISBLANK(Name)', { Name: '   ' }), true);
		assert.equal(ev('ISBLANK(Name)', {}), true);
	});

	test('ISBLANK false for non-empty string', () => {
		assert.equal(ev('ISBLANK(Name)', { Name: 'Acme' }), false);
	});

	test('ISNULL is an alias for ISBLANK', () => {
		assert.equal(ev('ISNULL(Name)', { Name: null }), true);
		assert.equal(ev('ISNULL(Name)', { Name: 'Acme' }), false);
	});

	test('LEN measures string length', () => {
		assert.equal(ev('LEN("hello")'), 5);
		assert.equal(ev('LEN(Name)', { Name: 'Acme Corp' }), 9);
	});

	test('LEN of null is 0', () => {
		assert.equal(ev('LEN(Name)', { Name: null }), 0);
	});

	test('TEXT coerces a value to its string form', () => {
		assert.equal(ev('TEXT(42)'), '42');
		assert.equal(ev('TEXT(Name)', { Name: 'Acme' }), 'Acme');
	});

	test('TRIM removes leading + trailing whitespace', () => {
		assert.equal(ev('TRIM("  hi  ")'), 'hi');
	});

	test('UPPER / LOWER', () => {
		assert.equal(ev('UPPER("hi")'), 'HI');
		assert.equal(ev('LOWER("HI")'), 'hi');
	});

	test('LEFT / RIGHT / MID', () => {
		assert.equal(ev('LEFT("hello", 3)'), 'hel');
		assert.equal(ev('RIGHT("hello", 2)'), 'lo');
		assert.equal(ev('MID("hello", 2, 3)'), 'ell');
	});

	test('CONTAINS / BEGINS', () => {
		assert.equal(ev('CONTAINS("hello world", "lo wor")'), true);
		assert.equal(ev('CONTAINS("hello", "x")'), false);
		assert.equal(ev('BEGINS("hello", "he")'), true);
		assert.equal(ev('BEGINS("hello", "lo")'), false);
	});

	test('ISPICKVAL matches a picklist value', () => {
		assert.equal(ev('ISPICKVAL(Status, "Open")', { Status: 'Open' }), true);
		assert.equal(ev('ISPICKVAL(Status, "Open")', { Status: 'Closed' }), false);
	});
});

describe('evalNode: unsupported function throws', () => {
	test('VLOOKUP is not in the supported set', () => {
		assert.throws(() => ev('VLOOKUP(x, y, z)'), /unsupported function VLOOKUP/);
	});
});

describe('resolveFieldValue: cross-object via savedRecords', () => {
	const fields = [
		{ name: 'Name' },
		{ name: 'AccountId', relationshipName: 'Account', referenceTo: ['Account'] },
	];
	const opts = {
		currentFields: fields,
		savedRecords: { Account: { Name: 'Acme Corp', Industry: 'Tech' } },
		describeCache: {
			Account: { fields: [{ name: 'Name' }, { name: 'Industry' }] },
		},
	};

	test('resolves a simple cross-object ref against the saved related record', () => {
		assert.equal(resolveFieldValue('Account.Name', {}, opts), 'Acme Corp');
		assert.equal(resolveFieldValue('Account.Industry', {}, opts), 'Tech');
	});

	test('matches relationshipName case-insensitively as a fallback', () => {
		assert.equal(resolveFieldValue('account.Name', {}, opts), 'Acme Corp');
	});

	test('returns the unresolved sentinel when the relationship field is unknown', () => {
		assert.equal(resolveFieldValue('Bogus.Name', {}, opts), UNRESOLVED_FIELD);
	});

	test('returns the unresolved sentinel when the related object has no saved draft', () => {
		const opts2 = Object.assign({}, opts, { savedRecords: {} });
		assert.equal(resolveFieldValue('Account.Name', {}, opts2), UNRESOLVED_FIELD);
	});

	test('a direct field on the current record wins over chasing the dot', () => {

		assert.equal(
			resolveFieldValue('Account.Name', { 'Account.Name': 'Direct value' }, opts),
			'Direct value',
		);
	});
});

describe('resolveFieldValue: cross-object via bulk associations', () => {
	const fields = [
		{ name: 'AccountId', relationshipName: 'Account', referenceTo: ['Account'] },
	];
	const opts = {
		currentFields: fields,
		currentRecord: { id: 'rec-1', objectName: 'Contact' },
		bulkRecords: [
			{ id: 'rec-acct', objectName: 'Account', values: { Name: 'BulkAcc Co' } },
		],
		bulkAssociations: [{ fromId: 'rec-1', fieldName: 'AccountId', toId: 'rec-acct' }],
		describeCache: { Account: { fields: [{ name: 'Name' }] } },

		savedRecords: {},
	};

	test('follows a bulk association to the sibling record', () => {
		assert.equal(resolveFieldValue('Account.Name', {}, opts), 'BulkAcc Co');
	});

	test('falls back to savedRecords when no association points at a bulk record', () => {
		const opts2 = Object.assign({}, opts, {
			bulkAssociations: [],
			savedRecords: { Account: { Name: 'Saved Co' } },
		});
		assert.equal(resolveFieldValue('Account.Name', {}, opts2), 'Saved Co');
	});
});

describe('real-world rule patterns', () => {
	const rules = {

		ssnLength: {
			name: 'ssn_must_be_9',
			formula: 'LEN(SSN__c) <> 9',
			errorMessage: 'SSN must be exactly 9 digits.',
		},

		descRequiredForImportant: {
			name: 'desc_required',
			formula: 'AND(ISBLANK(Description), Type = "Important")',
			errorMessage: 'Important accounts must have a Description.',
		},

		amountCap: {
			name: 'amount_cap',
			formula: 'Amount > 1000000',
			errorMessage: 'Amount cannot exceed $1,000,000.',
		},

		oneContactMethod: {
			name: 'contact_method',
			formula: 'AND(ISBLANK(Email), ISBLANK(Phone))',
			errorMessage: 'Provide either email or phone.',
		},

		closeDateOnWon: {
			name: 'close_date_on_won',
			formula: 'AND(ISPICKVAL(StageName, "Closed Won"), ISBLANK(CloseDate))',
			errorMessage: 'Closed Won deals must have a close date.',
		},

		titleAtImportantAccount: {
			name: 'title_at_important',
			formula: 'AND(Account.Type = "Important", ISBLANK(Title))',
			errorMessage: 'Contacts at Important accounts must have a Title.',
		},
	};

	test('SSN-length rule fires when SSN is the wrong length', () => {
		assert.equal(evaluateRule(rules.ssnLength, { SSN__c: '12345' }), 'fail');
		assert.equal(evaluateRule(rules.ssnLength, { SSN__c: '123456789' }), 'pass');
	});

	test('SSN-length rule fires when SSN is missing entirely', () => {

		assert.equal(evaluateRule(rules.ssnLength, {}), 'fail');
	});

	test('description-required-for-important fires only when both conditions hold', () => {
		assert.equal(evaluateRule(rules.descRequiredForImportant,
			{ Type: 'Important', Description: null }), 'fail');
		assert.equal(evaluateRule(rules.descRequiredForImportant,
			{ Type: 'Important', Description: 'present' }), 'pass');
		assert.equal(evaluateRule(rules.descRequiredForImportant,
			{ Type: 'Casual', Description: null }), 'pass');
	});

	test('amount cap fires above the threshold', () => {
		assert.equal(evaluateRule(rules.amountCap, { Amount: 1_000_001 }), 'fail');
		assert.equal(evaluateRule(rules.amountCap, { Amount: 1_000_000 }), 'pass');
		assert.equal(evaluateRule(rules.amountCap, { Amount: '999999' }), 'pass');
	});

	test('at-least-one-contact-method requires either email or phone', () => {
		assert.equal(evaluateRule(rules.oneContactMethod,
			{ Email: null, Phone: null }), 'fail');
		assert.equal(evaluateRule(rules.oneContactMethod,
			{ Email: 'a@b.com', Phone: null }), 'pass');
		assert.equal(evaluateRule(rules.oneContactMethod,
			{ Email: null, Phone: '555-1234' }), 'pass');
	});

	test('Closed-Won close-date rule fires for won-stage records with no date', () => {
		assert.equal(evaluateRule(rules.closeDateOnWon,
			{ StageName: 'Closed Won', CloseDate: null }), 'fail');
		assert.equal(evaluateRule(rules.closeDateOnWon,
			{ StageName: 'Closed Won', CloseDate: '2026-01-01' }), 'pass');
		assert.equal(evaluateRule(rules.closeDateOnWon,
			{ StageName: 'Prospecting', CloseDate: null }), 'pass');
	});

	test('cross-object Account.Type rule fires when title missing on important-account contact', () => {
		const opts = {
			currentFields: [
				{ name: 'Title' },
				{ name: 'AccountId', relationshipName: 'Account', referenceTo: ['Account'] },
			],
			savedRecords: { Account: { Type: 'Important' } },
			describeCache: { Account: { fields: [{ name: 'Type' }] } },
		};

		assert.equal(evaluateRule(rules.titleAtImportantAccount, { Title: null }, opts), 'fail');

		assert.equal(evaluateRule(rules.titleAtImportantAccount, { Title: 'VP' }, opts), 'pass');

		const opts2 = Object.assign({}, opts, { savedRecords: { Account: { Type: 'Casual' } } });
		assert.equal(evaluateRule(rules.titleAtImportantAccount, { Title: null }, opts2), 'pass');
	});

	test('cross-object rule returns unknown when related data is not loaded', () => {

		const opts = {
			currentFields: [
				{ name: 'Title' },
				{ name: 'AccountId', relationshipName: 'Account', referenceTo: ['Account'] },
			],
			savedRecords: {},
			describeCache: {},
		};
		assert.equal(evaluateRule(rules.titleAtImportantAccount, { Title: null }, opts), 'unknown');
	});
});

describe('evaluateRule', () => {
	test('returns "unknown" for a rule with no formula', () => {
		assert.equal(evaluateRule({ name: 'r', formula: null }), 'unknown');
		assert.equal(evaluateRule({}), 'unknown');
		assert.equal(evaluateRule(null), 'unknown');
	});

	test('returns "unknown" when the formula fails to parse', () => {
		assert.equal(evaluateRule({ name: 'r', formula: '1 + ' }), 'unknown');
	});

	test('returns "unknown" when the formula references an unsupported function', () => {
		assert.equal(evaluateRule({ name: 'r', formula: 'VLOOKUP(x, y, z)' }), 'unknown');
	});

	test('returns "pass" when the formula is falsy', () => {
		assert.equal(evaluateRule({ name: 'r', formula: 'FALSE' }), 'pass');
		assert.equal(evaluateRule({ name: 'r', formula: '1 = 2' }), 'pass');
	});

	test('returns "fail" when the formula is truthy', () => {
		assert.equal(evaluateRule({ name: 'r', formula: 'TRUE' }), 'fail');
		assert.equal(evaluateRule({ name: 'r', formula: '1 = 1' }), 'fail');
	});
});
