import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseFormula, evalNode, evaluateRule } from '../src/validation-formula.js';

const source = readFileSync(new URL('../src/public/js/formula.js', import.meta.url), 'utf8');
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const browser = sandbox.window.OrgLoom.formula;

function browserEvaluate(formula, values, opts = {}) {
	try {
		const result = browser.evalNode(browser.parseFormula(formula), values, opts);
		return result === true ? 'fail' : result === false ? 'pass' : 'unknown';
	} catch {
		return 'unknown';
	}
}

describe('browser and server validation-formula implementations stay in parity', () => {
	const cases = [
		['AND(ISBLANK(Description), Type = "Important")', { Description: '', Type: 'Important' }],
		['OR(Amount > 1000, Amount < 0)', { Amount: 500 }],
		['LEN(TRIM(Name)) < 3', { Name: ' AB ' }],
		['ISPICKVAL(Status__c, "Closed")', { Status__c: 'Closed' }],
		['IF(Score__c > 80, Cost__c < 100, FALSE)', { Score__c: 90, Cost__c: 50 }],
		['REGEX(Name, "[A-Z]+")', { Name: 'ABC' }],
	];

	for (const [formula, values] of cases) {
		test(formula, () => {
			assert.equal(browserEvaluate(formula, values), evaluateRule({ formula }, values));
			assert.deepEqual(
				JSON.parse(JSON.stringify(browser.parseFormula(formula))),
				JSON.parse(JSON.stringify(parseFormula(formula))),
			);
		});
	}

	test('both implementations return unknown for unresolved cross-object data', () => {
		const formula = 'AND(Account.Type = "Important", ISBLANK(Title))';
		const opts = {
			currentFields: [
				{ name: 'Title' },
				{ name: 'AccountId', relationshipName: 'Account', referenceTo: ['Account'] },
			],
			savedRecords: {},
			describeCache: {},
		};
		assert.equal(browserEvaluate(formula, { Title: '' }, opts), 'unknown');
		assert.equal(evaluateRule({ formula }, { Title: '' }, opts), 'unknown');
	});

	test('both implementations resolve a loaded blank parent field as blank, not unknown', () => {
		const formula = 'ISBLANK(Account.Type)';
		const opts = {
			currentFields: [{ name: 'AccountId', relationshipName: 'Account', referenceTo: ['Account'] }],
			savedRecords: { Account: { Type: '' } },
			describeCache: { Account: { fields: [{ name: 'Type' }] } },
		};
		assert.equal(browserEvaluate(formula, {}, opts), 'fail');
		assert.equal(evaluateRule({ formula }, {}, opts), 'fail');
	});

	test('direct eval outputs match for supported formulas', () => {
		const formula = 'LEFT(UPPER(Name), 2) = "AC"';
		assert.equal(
			browser.evalNode(browser.parseFormula(formula), { Name: 'Acme' }, {}),
			evalNode(parseFormula(formula), { Name: 'Acme' }, {}),
		);
	});
});
