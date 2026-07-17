// Bulk-script sandbox attack suite.
//
// The script-runner in src/public/js/bulk-script.js sells two
// promises: scripts can't reach Salesforce, and scripts can't escape
// the browser sandbox into real JavaScript. The sandbox enforces this
// through three layers:
//   1. Custom AST interpreter (no `eval`, no `new Function`).
//   2. Identifiers resolve only against an explicit `env` object:
//      `window`, `document`, `fetch`, etc. are not visible by name.
//   3. Member access goes through a checkProp() guard that blocks
//      prototype-chain escape hatches (`constructor`, `__proto__`,
//      `prototype`, `__defineGetter__`, etc.).
//
// This file proves those layers hold by running known attacks against
// the real interpreter and asserting every one of them throws. The
// suite doubles as a regression net: any future change to the parser
// or interpreter that re-opens an escape will fail here.
//
// LOADING STRATEGY
//
// bulk-script.js is a browser IIFE, wrapping its internals in a
// closure and only exposes `mount()` via window.OrgLoom.bulkScript.
// To test the internals (_bsTokenize, _bsParse, _bsInterpret) we
// need a way past the closure boundary without modifying the source.
//
// This test file reads the source, finds the line where the IIFE
// assigns its public API, and inserts a one-line export of the
// closure-internal functions immediately before it. Then it runs the
// modified source in a Node vm context with a minimal `window` stub
// and captures the internals via the injected global. Production
// bulk-script.js is never touched.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BULK_SCRIPT_PATH = join(__dirname, '..', 'src', 'public', 'js', 'bulk-script.js');

let _bsTokenize, _bsParse, _bsInterpret, _BS_FORBIDDEN_PROPS;

before(() => {
	const src = readFileSync(BULK_SCRIPT_PATH, 'utf8');
	// Anchor line: the very last `return {` inside the mount function
	// which is where the internals (_bsTokenize / _bsParse /
	// _bsInterpret) are STILL in lexical scope. We inject a global
	// leak right before mount's return so the closure exposes them
	// once. Running the IIFE doesn't call mount on its own, so to
	// trigger the leak we call mount() ourselves after evaluating
	// the source.
	const ANCHOR = 'return {\n\t\t\t\topenModal: openBulkScriptModal,';
	if (!src.includes(ANCHOR)) {
		throw new Error('Could not find injection anchor in bulk-script.js: refactor may have moved mount\'s return. Update ANCHOR.');
	}
	const INJECTED = 'globalThis.__bsTestInternals = { _bsTokenize, _bsParse, _bsInterpret, _BS_FORBIDDEN_PROPS };\n\t\t\t';
	const modifiedSrc = src.replace(ANCHOR, INJECTED + ANCHOR);

	// Minimal stubs so the IIFE + mount can run without a DOM:
	//   * document.createElement returns a chainable stub that absorbs
	//     every method call we make on it (modal setup creates elements
	//     and wires events). We don't care about the wiring, we just
	//     need it to not throw.
	//   * document.body, document.addEventListener: same.
	const makeStubEl = () => {
		const el = new Proxy(function () {}, {
			get(_, prop) {
				if (prop === 'classList') {
return { add: () => {}, remove: () => {}, contains: () => false };
}
				if (prop === 'querySelector' || prop === 'querySelectorAll') {
return () => makeStubEl();
}
				if (prop === 'forEach' || prop === 'map') {
return () => {};
}
				if (prop === 'appendChild' || prop === 'addEventListener' || prop === 'removeEventListener' || prop === 'remove' || prop === 'setAttribute' || prop === 'focus') {
return () => {};
}
				if (prop === 'innerHTML' || prop === 'className' || prop === 'value' || prop === 'textContent') {
return '';
}
				if (prop === 'length') {
return 0;
}
				return makeStubEl();
			},
			set() {
 return true; 
},
			apply() {
 return makeStubEl(); 
},
		});
		return el;
	};

	const sandbox = {
		window: { OrgLoom: undefined },
		document: {
			createElement: () => makeStubEl(),
			body: makeStubEl(),
			addEventListener: () => {},
			querySelector: () => makeStubEl(),
			querySelectorAll: () => [],
		},
		globalThis: undefined,
	};
	sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(modifiedSrc, sandbox);

	// Trigger the leak: call mount() with stub deps so it runs to its
	// return statement (where the injected export executes).
	const stubDeps = {
		canvasState: { bulkRecords: [] },
		showBulkToast: () => {},
		renderBulkView: () => {},
		showConfirmDialog: async () => true,
	};
	sandbox.window.OrgLoom.bulkScript.mount(stubDeps);

	const internals = sandbox.__bsTestInternals;
	if (!internals) {
throw new Error('Internals not captured: bulk-script.js may have changed shape.');
}
	_bsTokenize = internals._bsTokenize;
	_bsParse = internals._bsParse;
	_bsInterpret = internals._bsInterpret;
	_BS_FORBIDDEN_PROPS = internals._BS_FORBIDDEN_PROPS;
});

// ----- Test helpers -----

// Build the same env object the real bulk-script runtime passes to
// _bsInterpret. We re-implement the helpers locally because they're
// not exported; they only need to behave plausibly for these tests
// (sandbox safety is what we're proving, not helper correctness).
function makeEnv(records = []) {
	return {
		records,
		log: () => {},
		abort: (msg) => {
 throw new Error(msg || 'Script aborted'); 
},
		isBlank: (x) => x == null || x === '',
		isNotBlank: (x) => !(x == null || x === ''),
		isEmpty: (x) => x == null || x === '' || (Array.isArray(x) && x.length === 0),
		isNotEmpty: (x) => !(x == null || x === '' || (Array.isArray(x) && x.length === 0)),
		today: () => '2026-06-09',
		now: () => '2026-06-09T00:00:00.000Z',
		daysFromToday: (n) => '2026-06-09',
		toStr: (x) => String(x),
		toNum: (x) => Number(x),
		max: Math.max,
		min: Math.min,
		round: Math.round,
		floor: Math.floor,
		ceil: Math.ceil,
		abs: Math.abs,
	};
}

// Run a script against a fresh env. Returns { env, error }; error
// is null on success, the thrown Error on failure. Useful for tests
// that want to verify a specific message OR for tests that should
// succeed without throwing.
function runScript(source, records = []) {
	const env = makeEnv(records);
	try {
		const tokens = _bsTokenize(source);
		const ast = _bsParse(tokens);
		_bsInterpret(ast, env);
		return { env, error: null };
	} catch (e) {
		return { env, error: e };
	}
}

// Sugar for the common case: "this script should throw."
function assertRejects(source, matchMessage, records = []) {
	const { error } = runScript(source, records);
	assert.ok(error, 'Expected script to throw, but it succeeded:\n  ' + source);
	if (matchMessage) {
		assert.match(error.message, matchMessage, 'Error message did not match. Got: ' + error.message);
	}
}

// Sugar for "this script should run cleanly."
function assertAccepts(source, records = []) {
	const { error } = runScript(source, records);
	assert.equal(error, null, 'Expected script to succeed, but it threw:\n  ' + source + '\n  Error: ' + (error && error.message));
}

// ----- 1. Prototype-chain escape attempts -----
//
// The classic sandbox-escape vector: from any value, reach
// `.constructor.constructor` to get the Function constructor, which
// lets you build a function from a string, equivalent to eval().
// Variants reach the same goal through __proto__, prototype, or the
// __defineGetter__ family. checkProp() in the interpreter blocks
// every name in _BS_FORBIDDEN_PROPS, so every variant below MUST
// throw at member-access time.

describe('Sandbox: prototype-chain escape attempts must throw', () => {
	test('object literal .constructor blocked', () => {
		// Object literals aren't supported by the parser, so we reach
		// the same constructor via a helper function's prototype.
		// max is Math.max, a real JS function with .constructor.
		assertRejects('let f = max.constructor;', /Property "constructor" is not allowed/);
	});

	test('chained .constructor.constructor blocked at first hop', () => {
		assertRejects('let f = max.constructor.constructor;', /Property "constructor" is not allowed/);
	});

	test('__proto__ blocked', () => {
		assertRejects('let p = max.__proto__;', /Property "__proto__" is not allowed/);
	});

	test('prototype blocked', () => {
		assertRejects('let p = max.prototype;', /Property "prototype" is not allowed/);
	});

	test('__defineGetter__ blocked', () => {
		assertRejects('let g = max.__defineGetter__;', /Property "__defineGetter__" is not allowed/);
	});

	test('__defineSetter__ blocked', () => {
		assertRejects('let g = max.__defineSetter__;', /Property "__defineSetter__" is not allowed/);
	});

	test('__lookupGetter__ blocked', () => {
		assertRejects('let g = max.__lookupGetter__;', /Property "__lookupGetter__" is not allowed/);
	});

	test('__lookupSetter__ blocked', () => {
		assertRejects('let g = max.__lookupSetter__;', /Property "__lookupSetter__" is not allowed/);
	});

	test('bracket-notation .constructor blocked (computed access path)', () => {
		// A naive checkProp() that only inspects the AST property name
		// would miss r.values["constructor"]. Verify the runtime
		// check fires on the resolved string too.
		const records = [{ id: 1, values: {} }];
		assertRejects('records[0]["constructor"];', /Property "constructor" is not allowed/, records);
	});

	test('bracket-notation __proto__ blocked', () => {
		const records = [{ id: 1, values: { Name: 'Acme' } }];
		assertRejects('records[0].values["__proto__"];', /Property "__proto__" is not allowed/, records);
	});

	test('constructor reachable through string is blocked', () => {
		assertRejects('let s = "x"; let c = s.constructor;', /Property "constructor" is not allowed/);
	});

	test('constructor reachable through number is blocked', () => {
		assertRejects('let n = 1; let c = n.constructor;', /Property "constructor" is not allowed/);
	});

	test('writing to constructor is blocked', () => {
		const records = [{ id: 1, values: {} }];
		assertRejects('records[0].values.constructor = 1;', /Property "constructor" is not allowed/, records);
	});
});

// ----- 2. Browser globals must be unreachable by name -----
//
// The interpreter resolves identifiers against the env we hand it.
// Anything not in env should fail with "Undefined identifier".
// Verify every dangerous global is invisible.

describe('Sandbox: browser globals are not in scope', () => {
	const FORBIDDEN_GLOBALS = [
		'window', 'document', 'fetch', 'XMLHttpRequest', 'localStorage',
		'sessionStorage', 'setTimeout', 'setInterval', 'globalThis', 'self',
		'eval', 'Function', 'Object', 'Array', 'Math', 'JSON', 'Reflect',
		'Symbol', 'Proxy', 'Date', 'RegExp', 'console',
	];
	for (const name of FORBIDDEN_GLOBALS) {
		test(`${name} is not visible`, () => {
			assertRejects(`let x = ${name};`, new RegExp(`Undefined identifier: ${name}`));
		});
	}
});

// ----- 3. Record-identity guards -----
//
// r.id and r.loadedFromId are the canvas-side bookkeeping. A script
// that reassigns either silently aims an upload at the wrong SF row,
// or breaks delete/association lookups. Identity guard at writeMember
// must refuse.

describe('Sandbox: record identity is read-only', () => {
	test('reading r.id is allowed', () => {
		const records = [{ id: 1, values: {} }];
		assertAccepts('let x = records[0].id;', records);
	});

	test('reading r.loadedFromId is allowed', () => {
		const records = [{ id: 1, loadedFromId: '001abc', values: {} }];
		assertAccepts('let x = records[0].loadedFromId;', records);
	});

	test('reassigning r.id throws', () => {
		const records = [{ id: 1, values: {} }];
		assertRejects('records[0].id = 999;', /Record identity is read-only/, records);
	});

	test('reassigning r.loadedFromId throws', () => {
		const records = [{ id: 1, loadedFromId: '001abc', values: {} }];
		assertRejects("records[0].loadedFromId = '001xyz';", /Record identity is read-only/, records);
	});

	test('reassigning r.values fields is allowed (it\'s the whole point)', () => {
		const records = [{ id: 1, values: { Name: 'Old' } }];
		assertAccepts("records[0].values.Name = 'New';", records);
		assert.equal(records[0].values.Name, 'New');
	});

	test('reassigning a NON-identity field on r is allowed', () => {
		// label and objectName aren't in _IDENTITY_PROPS, so the guard
		// shouldn't fire. (Whether scripts SHOULD rewrite these is a
		// product decision; the security claim is just that the
		// sandbox doesn't pretend identity guard covers them.)
		const records = [{ id: 1, label: 'old', values: {} }];
		assertAccepts("records[0].label = 'new';", records);
	});
});

// ----- 4. Helper-function abuse -----
//
// Functions exposed via env are real JS functions (Math.max etc.):
// they have .call, .apply, .bind, .name. None of these grant escape
// (.call(x) just invokes the function with a different `this`), but
// the forbidden-props list IS what stops .constructor on them.
// Verify the helpers aren't a back door.

describe('Sandbox: exposed helpers can\'t be used to escape', () => {
	test('max.call.constructor still blocked', () => {
		assertRejects('let c = max.call.constructor;', /Property "constructor" is not allowed/);
	});

	test('today.toString.constructor still blocked', () => {
		assertRejects('let c = today.toString.constructor;', /Property "constructor" is not allowed/);
	});

	test('log.bind.prototype still blocked', () => {
		assertRejects('let p = log.bind.prototype;', /Property "prototype" is not allowed/);
	});

	test('calling abort propagates as a script error (intended)', () => {
		assertRejects("abort('stop');", /stop/);
	});
});

// ----- 5. Syntax restrictions -----
//
// The parser deliberately doesn't accept several syntaxes. Verify
// they're rejected at parse time, not silently accepted and run as
// something unexpected.

describe('Sandbox: parser rejects out-of-spec syntax', () => {
	test('arrow function rejected', () => {
		assertRejects('let f = x => x;');
	});

	test('function declaration rejected', () => {
		assertRejects('function f() { return 1; }');
	});

	test('new expression rejected', () => {
		assertRejects('let d = new Date();');
	});

	test('try/catch rejected', () => {
		assertRejects('try { let x = 1; } catch (e) { let y = 2; }');
	});

	test('while loop rejected', () => {
		assertRejects('while (true) { break; }');
	});

	test('classic for(;;) rejected', () => {
		assertRejects('for (let i = 0; i < 3; i = i + 1) { let x = i; }');
	});

	test('template literal rejected', () => {
		assertRejects('let s = `hello`;');
	});

	test('destructuring rejected', () => {
		assertRejects('let { a } = records[0];', null, [{ id: 1, values: {}, a: 1 }]);
	});

	test('spread rejected', () => {
		assertRejects('let arr = [...records];');
	});

	test('async/await rejected', () => {
		assertRejects('let x = await today();');
	});

	test('regex literal rejected', () => {
		assertRejects('let r = /foo/;');
	});
});

// ----- 6. DoS / step limit -----

describe('Sandbox: runaway loops abort via step cap', () => {
	test('1M-step counter trips before infinite loop completes', () => {
		// A tight loop that would run forever native-side. The step
		// counter should catch it. We use a for-of over records to
		// stay in supported syntax; pad the records array so we burn
		// steps without succeeding.
		const records = Array.from({ length: 100000 }, (_, i) => ({ id: i, values: {} }));
		// Each iteration does several operations (member access,
		// assignment, log call) so the counter ticks fast.
		const src = `
			for (const r of records) {
				r.values.X = 1;
				r.values.Y = 2;
				r.values.Z = 3;
				r.values.W = 4;
			}
		`;
		assertRejects(src, /Script exceeded/, records);
	});
});

// ----- 7. Positive smoke tests -----
//
// Verify the sandbox doesn't OVER-block. The features the cheat sheet
// documents must actually work.

describe('Sandbox: documented features actually work', () => {
	test('basic for-of mutation', () => {
		const records = [
			{ id: 1, objectName: 'Account', values: { Name: 'old' } },
			{ id: 2, objectName: 'Account', values: { Name: 'old' } },
		];
		assertAccepts("for (const r of records) { r.values.Name = 'new'; }", records);
		assert.equal(records[0].values.Name, 'new');
		assert.equal(records[1].values.Name, 'new');
	});

	test('if/else branching', () => {
		const records = [
			{ id: 1, values: { Amount: 100 } },
			{ id: 2, values: { Amount: 0 } },
		];
		const src = `
			for (const r of records) {
				if (r.values.Amount > 50) { r.values.Tier = 'high'; }
				else { r.values.Tier = 'low'; }
			}
		`;
		assertAccepts(src, records);
		assert.equal(records[0].values.Tier, 'high');
		assert.equal(records[1].values.Tier, 'low');
	});

	test('loadedFromId filtering pattern from the cheat sheet', () => {
		const records = [
			{ id: 1, loadedFromId: '001abc', values: {} },
			{ id: 2, values: {} },
		];
		const src = `
			for (const r of records) {
				if (r.loadedFromId) { r.values.LastReviewed = today(); }
			}
		`;
		assertAccepts(src, records);
		assert.ok(records[0].values.LastReviewed);
		assert.equal(records[1].values.LastReviewed, undefined);
	});

	test('helpers produce expected values', () => {
		const records = [{ id: 1, values: {} }];
		const src = `
			records[0].values.Today = today();
			records[0].values.Max = max(1, 2);
			records[0].values.IsBlank = isBlank('');
			records[0].values.IsNotBlank = isNotBlank('x');
		`;
		assertAccepts(src, records);
		assert.equal(records[0].values.Today, '2026-06-09');
		assert.equal(records[0].values.Max, 2);
		assert.equal(records[0].values.IsBlank, true);
		assert.equal(records[0].values.IsNotBlank, true);
	});

	test('break and continue work in for-of', () => {
		const records = [
			{ id: 1, values: {} }, { id: 2, values: {} }, { id: 3, values: {} },
		];
		assertAccepts(`
			for (const r of records) {
				if (r.id === 2) continue;
				if (r.id === 3) break;
				r.values.Touched = true;
			}
		`, records);
		assert.equal(records[0].values.Touched, true);
		assert.equal(records[1].values.Touched, undefined); // continued
		assert.equal(records[2].values.Touched, undefined); // broke before reaching
	});
});

// ----- 8. Forbidden-props list integrity -----
//
// Asserts the inventory itself, so anyone editing the list sees the
// test go red rather than silently widening the sandbox.

describe('Sandbox: forbidden-props list inventory', () => {
	test('forbidden set has not shrunk', () => {
		const required = [
			'constructor', '__proto__', 'prototype',
			'__defineGetter__', '__defineSetter__',
			'__lookupGetter__', '__lookupSetter__',
		];
		for (const name of required) {
			assert.ok(_BS_FORBIDDEN_PROPS.has(name), `Forbidden-props list is missing "${name}", a critical sandbox guarantee.`);
		}
	});
});
