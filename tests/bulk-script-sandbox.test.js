
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
	const RETURN_ANCHOR = /^([ \t]*)return\s*\{\r?\n[ \t]*openModal:\s*openBulkScriptModal,\s*$/m;
	if (!RETURN_ANCHOR.test(src)) {
		throw new Error('Could not find injection anchor in bulk-script.js: refactor may have moved mount\'s return. Update ANCHOR.');
	}
	const modifiedSrc = src.replace(RETURN_ANCHOR, (anchor, indent) =>
		indent + 'globalThis.__bsTestInternals = { _bsTokenize, _bsParse, _bsInterpret, _BS_FORBIDDEN_PROPS };\n' + anchor
	);

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

function assertRejects(source, matchMessage, records = []) {
	const { error } = runScript(source, records);
	assert.ok(error, 'Expected script to throw, but it succeeded:\n  ' + source);
	if (matchMessage) {
		assert.match(error.message, matchMessage, 'Error message did not match. Got: ' + error.message);
	}
}

function assertAccepts(source, records = []) {
	const { error } = runScript(source, records);
	assert.equal(error, null, 'Expected script to succeed, but it threw:\n  ' + source + '\n  Error: ' + (error && error.message));
}


describe('Sandbox: prototype-chain escape attempts must throw', () => {
	test('object literal .constructor blocked', () => {
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
		const records = [{ id: 1, label: 'old', values: {} }];
		assertAccepts("records[0].label = 'new';", records);
	});
});


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


describe('Sandbox: runaway loops abort via step cap', () => {
	test('1M-step counter trips before infinite loop completes', () => {
		const records = Array.from({ length: 100000 }, (_, i) => ({ id: i, values: {} }));
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
