// Salesforce-formula parser + evaluator (client-side, partial).
//
// Supports: AND, OR, NOT, ISBLANK, ISNULL, LEN, ISPICKVAL, TEXT, TRIM,
// UPPER, LOWER, LEFT, RIGHT, MID, CONTAINS, BEGINS, IF; operators =, <>,
// !=, <, >, <=, >=, +, -, *, /, &; string/number/TRUE/FALSE literals;
// bare field references (including dotted paths through reference fields).
// Unsupported constructs throw, making the formula "unevaluable" (the
// caller renders this as status=unknown).
//
// All functions in this module are PURE: they read only from their
// arguments and return values. State that callers need to supply (saved
// records, describe cache, current record context, bulk associations)
// is passed via the `opts` parameter to `resolveFieldValue` and `evalNode`.
// That's by design: this module knows nothing about the canvas state
// model and can be unit-tested without any DOM or fetch mocks.
//
// Exposed as `window.OrgLoom.formula.{tokenize, parseFormula,
// resolveFieldValue, evalNode, num, looseEq}` for the legacy app.js
// global-namespace consumer. Load order: this file must be loaded
// BEFORE app.js (both deferred is fine; defer preserves order).

(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};
	const UNRESOLVED_FIELD = Symbol('validation-rule-unresolved-field');

	function tokenize(s) {
		const toks = [];
		let i = 0;
		while (i < s.length) {
			const c = s[i];
			if (/\s/.test(c)) {
 i++; continue; 
}
			if (c === '(' || c === ')' || c === ',') {
 toks.push({ t: c }); i++; continue; 
}
			if (c === '"') {
				let j = i + 1;
				while (j < s.length && s[j] !== '"') {
j++;
}
				toks.push({ t: 'STR', v: s.slice(i + 1, j) });
				i = j + 1; continue;
			}
			if (c === "'") {
				let j = i + 1;
				while (j < s.length && s[j] !== "'") {
j++;
}
				toks.push({ t: 'STR', v: s.slice(i + 1, j) });
				i = j + 1; continue;
			}
			if (/\d/.test(c) || (c === '.' && /\d/.test(s[i+1]))) {
				let j = i; while (j < s.length && /[\d.]/.test(s[j])) {
j++;
}
				toks.push({ t: 'NUM', v: parseFloat(s.slice(i, j)) });
				i = j; continue;
			}
			if (c === '<' || c === '>' || c === '!' || c === '=') {
				let j = i + 1;
				if (j < s.length && (s[j] === '=' || (c === '<' && s[j] === '>'))) {
j++;
}
				toks.push({ t: 'OP', v: s.slice(i, j) });
				i = j; continue;
			}
			if (c === '+' || c === '-' || c === '*' || c === '/' || c === '&') {
				toks.push({ t: 'OP', v: c }); i++; continue;
			}
			if (/[A-Za-z_]/.test(c)) {
				let j = i; while (j < s.length && /[A-Za-z0-9_.]/.test(s[j])) {
j++;
}
				toks.push({ t: 'ID', v: s.slice(i, j) });
				i = j; continue;
			}
			throw new Error('unexpected char ' + JSON.stringify(c));
		}
		return toks;
	}

	function parseFormula(src) {
		const toks = tokenize(src);
		let p = 0;
		function peek() {
 return toks[p]; 
}
		function eat() {
 return toks[p++]; 
}
		function expect(t, v) {
			const tk = eat();
			if (!tk || tk.t !== t || (v != null && tk.v !== v)) {
throw new Error('expected ' + t);
}
			return tk;
		}
		function expr() {
 return cmp(); 
}
		function cmp() {
			let left = add();
			while (peek() && peek().t === 'OP' && /^(=|==|<>|!=|<|>|<=|>=)$/.test(peek().v)) {
				const op = eat().v; const right = add();
				left = { k: 'cmp', op, left, right };
			}
			return left;
		}
		function add() {
			let left = mul();
			while (peek() && peek().t === 'OP' && /^[+\-&]$/.test(peek().v)) {
				const op = eat().v; const right = mul();
				left = { k: 'binop', op, left, right };
			}
			return left;
		}
		function mul() {
			let left = unary();
			while (peek() && peek().t === 'OP' && /^[*/]$/.test(peek().v)) {
				const op = eat().v; const right = unary();
				left = { k: 'binop', op, left, right };
			}
			return left;
		}
		function unary() {
			if (peek() && peek().t === 'OP' && peek().v === '-') {
				eat(); return { k: 'neg', x: unary() };
			}
			return primary();
		}
		function primary() {
			const tk = peek();
			if (!tk) {
throw new Error('unexpected end');
}
			if (tk.t === '(') {
 eat(); const e = expr(); expect(')'); return e; 
}
			if (tk.t === 'STR') {
 eat(); return { k: 'lit', v: tk.v }; 
}
			if (tk.t === 'NUM') {
 eat(); return { k: 'lit', v: tk.v }; 
}
			if (tk.t === 'ID') {
				eat();
				if (peek() && peek().t === '(') {
					eat();
					const args = [];
					if (peek() && peek().t !== ')') {
						args.push(expr());
						while (peek() && peek().t === ',') {
 eat(); args.push(expr()); 
}
					}
					expect(')');
					return { k: 'call', name: tk.v.toUpperCase(), args };
				}
				const up = tk.v.toUpperCase();
				if (up === 'TRUE') {
return { k: 'lit', v: true };
}
				if (up === 'FALSE') {
return { k: 'lit', v: false };
}
				if (up === 'NULL') {
return { k: 'lit', v: null };
}
				return { k: 'field', name: tk.v };
			}
			throw new Error('unexpected token ' + tk.t);
		}
		const tree = expr();
		if (p < toks.length) {
throw new Error('trailing tokens');
}
		return tree;
	}

	// Resolve a (possibly dotted) field path against the current object's
	// values, chaining through saved drafts of related objects when the
	// path traverses a reference field. Returns null if the chain can't
	// be resolved (related object not drafted, describe not cached, etc).
	function resolveFieldValue(path, vals, opts) {
		if (vals && Object.prototype.hasOwnProperty.call(vals, path)) {
			const raw = vals[path];
			return raw == null || raw === '' ? null : raw;
		}
		if (!path.includes('.')) {
			const raw = vals ? vals[path] : undefined;
			return raw == null || raw === '' ? null : raw;
		}
		const dotIdx = path.indexOf('.');
		const head = path.substring(0, dotIdx);
		const tail = path.substring(dotIdx + 1);
		const fields = (opts && opts.currentFields) || [];
		// Match on relationshipName first (e.g. "Account" for AccountId),
		// then fall back to exact field name and a case-insensitive match.
		const refField = fields.find(f => f.relationshipName === head)
			|| fields.find(f => f.name === head)
			|| fields.find(f => (f.relationshipName || '').toLowerCase() === head.toLowerCase())
			|| fields.find(f => f.name.toLowerCase() === head.toLowerCase());
		if (!refField || !refField.referenceTo || refField.referenceTo.length === 0) {
return UNRESOLVED_FIELD;
}
		const targetObjectName = refField.referenceTo[0];
		// Bulk-edit context: follow an association from the current record
		// to a sibling bulk record and resolve against that record's
		// values. This lets cross-object rules (e.g., LEN(Account.Name) > 5
		// on a Contact) keep evaluating correctly even after related
		// records have been uploaded.
		if (opts && opts.currentRecord && Array.isArray(opts.bulkAssociations) && Array.isArray(opts.bulkRecords)) {
			const assoc = opts.bulkAssociations.find(a => a.fromId === opts.currentRecord.id && a.fieldName === refField.name);
			if (assoc) {
				const target = opts.bulkRecords.find(r => r.id === assoc.toId);
				if (target) {
					const targetDesc = opts.describeCache && opts.describeCache[target.objectName];
					if (!targetDesc) {
return UNRESOLVED_FIELD;
}
					const nestedOpts = Object.assign({}, opts, {
						currentFields: (targetDesc && targetDesc.fields) || [],
						currentRecord: target,
					});
					return resolveFieldValue(tail, target.values || {}, nestedOpts);
				}
				return UNRESOLVED_FIELD;
			}
		}
		const hasSavedTarget = !!(opts && opts.savedRecords
			&& Object.prototype.hasOwnProperty.call(opts.savedRecords, targetObjectName));
		if (!hasSavedTarget) {
return UNRESOLVED_FIELD;
}
		const targetVals = opts.savedRecords[targetObjectName] || {};
		const targetDescribe = opts && opts.describeCache && opts.describeCache[targetObjectName];
		if (!targetDescribe) {
return UNRESOLVED_FIELD;
}
		const targetFields = (targetDescribe && targetDescribe.fields) || [];
		const nestedOpts = Object.assign({}, opts, { currentFields: targetFields, currentRecord: null });
		return resolveFieldValue(tail, targetVals, nestedOpts);
	}

	function evalNode(n, vals, opts) {
		switch (n.k) {
			case 'lit': return n.v;
			case 'field': {
				const value = resolveFieldValue(n.name, vals, opts);
				if (value === UNRESOLVED_FIELD) {
throw new Error('unresolved relationship field ' + n.name);
}
				return value;
			}
			case 'neg': return -evalNode(n.x, vals, opts);
			case 'cmp': {
				const l = evalNode(n.left, vals, opts), r = evalNode(n.right, vals, opts);
				switch (n.op) {
					case '=': case '==': return looseEq(l, r);
					case '<>': case '!=': return !looseEq(l, r);
					case '<': return num(l) < num(r);
					case '>': return num(l) > num(r);
					case '<=': return num(l) <= num(r);
					case '>=': return num(l) >= num(r);
				}
				throw new Error('bad cmp');
			}
			case 'binop': {
				const l = evalNode(n.left, vals, opts), r = evalNode(n.right, vals, opts);
				if (n.op === '&') {
return (l == null ? '' : String(l)) + (r == null ? '' : String(r));
}
				const ln = num(l), rn = num(r);
				switch (n.op) {
					case '+': return ln + rn;
					case '-': return ln - rn;
					case '*': return ln * rn;
					case '/': return rn === 0 ? null : ln / rn;
				}
				throw new Error('bad binop');
			}
			case 'call': {
				const args = n.args.map(a => evalNode(a, vals, opts));
				switch (n.name) {
					case 'AND': return args.every(v => !!v);
					case 'OR': return args.some(v => !!v);
					case 'NOT': return !args[0];
					case 'ISBLANK': case 'ISNULL':
						return args[0] == null || (typeof args[0] === 'string' && args[0].trim() === '');
					case 'LEN': return (args[0] == null ? '' : String(args[0])).length;
					case 'TEXT': return args[0] == null ? '' : String(args[0]);
					case 'TRIM': return (args[0] == null ? '' : String(args[0])).trim();
					case 'UPPER': return (args[0] == null ? '' : String(args[0])).toUpperCase();
					case 'LOWER': return (args[0] == null ? '' : String(args[0])).toLowerCase();
					case 'LEFT': return (args[0] == null ? '' : String(args[0])).slice(0, num(args[1]));
					case 'RIGHT': { const s = args[0] == null ? '' : String(args[0]); return s.slice(Math.max(0, s.length - num(args[1]))); }
					case 'MID': return (args[0] == null ? '' : String(args[0])).substr(num(args[1]) - 1, num(args[2]));
					case 'CONTAINS': return String(args[0] == null ? '' : args[0]).indexOf(String(args[1] == null ? '' : args[1])) !== -1;
					case 'BEGINS': return String(args[0] == null ? '' : args[0]).indexOf(String(args[1] == null ? '' : args[1])) === 0;
					case 'ISPICKVAL': return looseEq(args[0], args[1]);
					case 'IF': return args[0] ? args[1] : args[2];
					default: throw new Error('unsupported function ' + n.name);
				}
			}
		}
		throw new Error('bad node');
	}

	function num(v) {
		if (typeof v === 'number') {
return v;
}
		if (v == null || v === '') {
return 0;
}
		const n = parseFloat(v);
		return isNaN(n) ? 0 : n;
	}

	function looseEq(a, b) {
		if (a == null && b == null) {
return true;
}
		if (a == null || b == null) {
return false;
}
		if (typeof a === 'number' || typeof b === 'number') {
return num(a) === num(b);
}
		return String(a) === String(b);
	}

	window.OrgLoom.formula = {
		tokenize: tokenize,
		parseFormula: parseFormula,
		resolveFieldValue: resolveFieldValue,
		evalNode: evalNode,
		num: num,
		looseEq: looseEq,
		UNRESOLVED_FIELD: UNRESOLVED_FIELD,
	};
})();
