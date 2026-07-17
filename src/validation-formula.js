// Salesforce validation-rule formula engine.
//
// Used by the canvas record modal to evaluate an active validation
// rule's `errorConditionFormula` against the in-progress draft values
// for a record. When the formula returns TRUE the rule fires (i.e.,
// the record would FAIL validation if uploaded to Salesforce in this
// state). The modal renders a status badge per rule (pass / fail /
// unknown) so the user can fix issues before clicking upload.
//
// Scope of the implementation: a deliberate subset of SF's formula
// grammar: enough to evaluate the vast majority of real-world
// validation rules without implementing the entire SOQL-flavored
// formula language. Anything we don't understand throws inside
// evalNode and the calling code treats the rule as "unknown."
//
// Supported:
//   functions: AND, OR, NOT, ISBLANK, ISNULL, LEN, ISPICKVAL, TEXT,
//              TRIM, UPPER, LOWER, LEFT, RIGHT, MID, CONTAINS,
//              BEGINS, IF
//   operators: =, ==, <>, !=, <, >, <=, >=, +, -, *, /, &
//   literals:  string ("…" or '…'), number, TRUE / FALSE / NULL
//   refs:      bare field names; dotted paths (e.g. Account.Name)
//   parens, unary minus
//
// Not supported (will throw in evalNode and surface as "unknown" to
// callers): VLOOKUP, REGEX, PRIORVALUE, INCLUDES, ROUND, MOD, FLOOR,
// CEILING, DATE math, TIMEVALUE, custom-label refs, NOW/TODAY, etc.
// The eight or so functions covered here cover roughly 80% of the
// validation rules customers ship; the remainder are best handled by
// SF's own server-side check during upload (we already pre-flight
// via the dry-run insert path).
//
// Purity: every export here is a pure function. State comes in via
// the `vals` map and `opts` object; there's no module-level
// mutation. This is what makes the engine cleanly testable in
// Node + reusable in the browser without a DOM dependency.

// A valid relationship path whose related record/describe is not loaded is
// not the same thing as a loaded field whose value is genuinely blank.
// Preserve that distinction so the modal cannot report a false-green pass.
export const UNRESOLVED_FIELD = Symbol('validation-rule-unresolved-field');

// ----- Tokenizer ----------------------------------------------------

export function tokenize(s) {
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
		if (/\d/.test(c) || (c === '.' && /\d/.test(s[i + 1]))) {
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

// ----- Parser -------------------------------------------------------

export function parseFormula(src) {
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

// ----- Coercion helpers ---------------------------------------------

// SF's loose equality coerces numeric / string operands the way the
// engine compares them at runtime. We mirror: numbers are compared
// numerically, strings textually, and a null on either side equals
// only another null. Both nulls are equal, which matters for rules like
// `ISPICKVAL(Status__c, "")` which compiles to a string comparison
// after TEXT() unwrap.
export function looseEq(a, b) {
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

// Coerce to number. Empty/null → 0 (matches SF's blank-as-zero
// behavior inside arithmetic). NaN-on-parse also → 0.
export function num(v) {
	if (typeof v === 'number') {
return v;
}
	if (v == null || v === '') {
return 0;
}
	const n = parseFloat(v);
	return isNaN(n) ? 0 : n;
}

// ----- Field resolution ---------------------------------------------

// Resolve a (possibly dotted) field path against the current object's
// values, chaining through saved drafts of related objects when the
// path traverses a reference field. Returns null when the chain
// can't be resolved (related object not drafted, describe not
// cached, etc.) so downstream evaluation treats the field as blank.
//
// opts shape:
//   currentFields:    array of {name, relationshipName, referenceTo[]}
//                     for the object whose values are in `vals`.
//   savedRecords:     { [objectName]: valuesMap }; most-recently-saved
//                     draft for each related object, keyed by SF API
//                     name. Used for cross-object refs after a sibling
//                     record has been saved.
//   describeCache:    { [objectName]: { fields: [...] } }; describe
//                     metadata so cross-object resolution knows which
//                     fields the target object has.
//   currentRecord:    optional pointer to the current bulk-edit record
//                     so association-based lookups can target the
//                     right sibling.
//   bulkRecords:      optional array of all bulk-edit records in scope.
//   bulkAssociations: optional [{fromId, fieldName, toId}]; explicit
//                     same-canvas links between bulk records. Used to
//                     resolve `Account.Name` from a Contact record by
//                     following its AccountId association even before
//                     either has been uploaded.
export function resolveFieldValue(path, vals, opts) {
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
	// Match on relationshipName first (e.g. "Account" for AccountId), then
	// fall back to exact field name and a case-insensitive match.
	const refField = fields.find((f) => f.relationshipName === head)
		|| fields.find((f) => f.name === head)
		|| fields.find((f) => (f.relationshipName || '').toLowerCase() === head.toLowerCase())
		|| fields.find((f) => f.name.toLowerCase() === head.toLowerCase());
	if (!refField || !refField.referenceTo || refField.referenceTo.length === 0) {
return UNRESOLVED_FIELD;
}
	const targetObjectName = refField.referenceTo[0];
	// Bulk-edit context: follow an association from the current record
	// to a sibling bulk record and resolve against that record's values.
	// This lets cross-object rules (e.g., LEN(Account.Name) > 5 on a
	// Contact) keep evaluating correctly even after related records
	// have been uploaded.
	if (opts && opts.currentRecord && Array.isArray(opts.bulkAssociations) && Array.isArray(opts.bulkRecords)) {
		const assoc = opts.bulkAssociations.find(
			(a) => a.fromId === opts.currentRecord.id && a.fieldName === refField.name,
		);
		if (assoc) {
			const target = opts.bulkRecords.find((r) => r.id === assoc.toId);
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

// ----- Evaluator ----------------------------------------------------

// Walk a parsed formula tree against a values map. Throws on
// unsupported nodes (caller treats throws as "rule status unknown").
// Truthy result means the rule fires: the record would fail
// validation if uploaded as-is.
export function evalNode(n, vals, opts) {
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
			const l = evalNode(n.left, vals, opts);
			const r = evalNode(n.right, vals, opts);
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
			const l = evalNode(n.left, vals, opts);
			const r = evalNode(n.right, vals, opts);
			if (n.op === '&') {
return (l == null ? '' : String(l)) + (r == null ? '' : String(r));
}
			const ln = num(l);
			const rn = num(r);
			switch (n.op) {
				case '+': return ln + rn;
				case '-': return ln - rn;
				case '*': return ln * rn;
				case '/': return rn === 0 ? null : ln / rn;
			}
			throw new Error('bad binop');
		}
		case 'call': {
			const args = n.args.map((a) => evalNode(a, vals, opts));
			switch (n.name) {
				case 'AND': return args.every((v) => !!v);
				case 'OR': return args.some((v) => !!v);
				case 'NOT': return !args[0];
				case 'ISBLANK':
				case 'ISNULL':
					return args[0] == null || (typeof args[0] === 'string' && args[0].trim() === '');
				case 'LEN': return (args[0] == null ? '' : String(args[0])).length;
				case 'TEXT': return args[0] == null ? '' : String(args[0]);
				case 'TRIM': return (args[0] == null ? '' : String(args[0])).trim();
				case 'UPPER': return (args[0] == null ? '' : String(args[0])).toUpperCase();
				case 'LOWER': return (args[0] == null ? '' : String(args[0])).toLowerCase();
				case 'LEFT': return (args[0] == null ? '' : String(args[0])).slice(0, num(args[1]));
				case 'RIGHT': {
					const s = args[0] == null ? '' : String(args[0]);
					return s.slice(Math.max(0, s.length - num(args[1])));
				}
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

// ----- High-level helper --------------------------------------------

// Wraps parse + eval into the single check the modal performs per
// rule. Returns one of:
//   'pass': formula evaluated to falsy (rule does NOT fire)
//   'fail': formula evaluated to truthy (rule FIRES; upload would
//               be rejected by SF in this state)
//   'unknown': formula references something this engine doesn't
//               support (an unsupported function, an unresolved
//               cross-object ref where describeCache is empty, etc.).
//               UX shows "we can't tell, ship and let SF decide."
//
// `rule` is the normalized shape returned by /api/objects/:name/validation-rules:
//   { id, name, active, errorMessage, formula, ... }
export function evaluateRule(rule, values, opts) {
	if (!rule || !rule.formula) {
return 'unknown';
}
	let tree;
	try {
		tree = parseFormula(rule.formula);
	} catch (_parseErr) {
		return 'unknown';
	}
	let fires;
	try {
		fires = evalNode(tree, values || {}, opts || {});
	} catch (_evalErr) {
		return 'unknown';
	}
	return fires ? 'fail' : 'pass';
}
