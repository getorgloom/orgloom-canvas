// CSV-parsing utilities + a generic audit-ping, shared across the app.
//
// NOTE: the standalone single-CSV import MODAL that used to live here was
// retired. The Linked CSV importer (linked-csv.js) handles every CSV entry
// point now: Tools → Import CSV, the "+ Import records" CSV action, and
// Quick Upload, including single-file imports, Id→update, and the
// canvas-collision merge-via-diff. What remains here is reused by that
// importer and a few other call sites.
//
// Pure utilities (module scope below): parseCsv, csvNormalizeKey,
// csvGuessObjectFromFilename, csvAutoMapHeaders. Column → field mapping is
// auto-guessed from field API name or label (normalized, case-
// insensitive, non-alphanumerics stripped).
//
// Dependencies passed to mount():
//   csrfFetch: fetch wrapper; the only dep (used by pingAuditEvent).
//
// Public API (returned from mount):
//   parseCsv, csvNormalizeKey, csvGuessObjectFromFilename,
//   csvAutoMapHeaders: pure utilities; used by linked-csv.js,
//                       upload-modal.js, templates.js, canvas-save-load.js.
//   pingAuditEvent(action, fields): fire-and-forget POST to
//                       /api/audit-event. Used by client-only flows
//                       (CSV import, canvas export, canvas save/load
//                       locally) so the activity log has a complete
//                       picture even when the server didn't see the
//                       action directly.
//
// Exposed as window.OrgLoom.csvImport. Load order: before app.js.

(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	// ----- Pure utilities (no closure deps) -----

	// RFC 4180-ish parser. Handles quoted fields with embedded commas,
	// escaped quotes ("" → "), and CRLF / LF / bare CR line endings.
	function parseCsv(text) {
		const rows = [];
		let row = [];
		let cur = '';
		let inQuotes = false;
		let malformedQuotes = false;
		const n = text.length;
		let i = 0;
		while (i < n) {
			const c = text[i];
			if (inQuotes) {
				if (c === '"') {
					if (text[i + 1] === '"') {
 cur += '"'; i += 2; continue; 
}
					inQuotes = false; i++; continue;
				}
				cur += c; i++; continue;
			}
			if (c === '"') {
				if (cur === '') {
 inQuotes = true; i++; continue; 
}
				// A quote in the middle of an unquoted value is malformed CSV.
				// Preserve it for diagnostics/value fidelity, but mark the file
				// unsafe so the importer can refuse it before mapping.
				malformedQuotes = true; cur += c; i++; continue;
}
			if (c === ',') {
 row.push(cur); cur = ''; i++; continue; 
}
			if (c === '\r' || c === '\n') {
				row.push(cur); cur = '';
				rows.push(row); row = [];
				if (c === '\r' && text[i + 1] === '\n') {
i += 2;
} else {
i++;
}
				continue;
			}
			cur += c; i++;
		}
		if (inQuotes) {
malformedQuotes = true;
}
		if (cur !== '' || row.length > 0) {
 row.push(cur); rows.push(row); 
}
		while (rows.length > 0 && rows[rows.length - 1].every(v => v === '')) {
rows.pop();
}
		if (rows.length === 0) {
return { headers: [], rows: [], errors: [] };
}
		const headers = rows[0].map(h => h.trim());
		if (headers.length > 0) {
headers[0] = headers[0].replace(/^\uFEFF/, '');
}
		const errors = [];
		if (malformedQuotes) {
errors.push('Malformed or unclosed quoted field.');
}
		const seenHeaders = new Set();
		headers.forEach((header) => {
			const key = String(header || '').trim().toLowerCase();
			if (!key) {
return;
}
			if (seenHeaders.has(key)) {
errors.push('Duplicate header: "' + header + '".');
}
			seenHeaders.add(key);
		});
		return { headers, rows: rows.slice(1), errors };
	}

	function csvNormalizeKey(s) {
		return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
	}

	// Try to identify the target object from a CSV file's name,
	// e.g. "accounts.csv" → Account, "Order_Items_2024.csv" →
	// OrderItem. Strategy:
	//   1. Exact-normalized match against an object's API name.
	//   2. Exact-normalized match against the object's label.
	//   3. Same two checks against singular variants of the
	//      basename (drop trailing s / es, ies→y): accounts /
	//      Cases / Opportunities all resolve.
	//   4. Token-by-token check: split on non-alphanumerics so
	//      filenames like "sf-export_contacts_2024" still match
	//      the "contacts" → Contact piece.
	// Returns the candidate's API name, or null when nothing
	// matches. Caller falls back to its existing default.
	function csvGuessObjectFromFilename(filename, candidates) {
		if (!filename || !Array.isArray(candidates) || candidates.length === 0) {
return null;
}
		const base = String(filename).split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
		if (!base) {
return null;
}
		const tryMatch = (key) => {
			if (!key) {
return null;
}
			for (const obj of candidates) {
				if (obj && obj.name && csvNormalizeKey(obj.name) === key) {
return obj.name;
}
			}
			for (const obj of candidates) {
				if (obj && obj.label && csvNormalizeKey(obj.label) === key) {
return obj.name;
}
			}
			return null;
		};
		const variantsOf = (s) => {
			const out = new Set();
			if (!s) {
return out;
}
			out.add(s);
			if (s.endsWith('ies') && s.length > 3) {
out.add(s.slice(0, -3) + 'y');
}
			if (s.endsWith('es') && s.length > 2) {
out.add(s.slice(0, -2));
}
			if (s.endsWith('s') && s.length > 1) {
out.add(s.slice(0, -1));
}
			return out;
		};
		const fullKey = csvNormalizeKey(base);
		for (const v of variantsOf(fullKey)) {
			const hit = tryMatch(v);
			if (hit) {
return hit;
}
		}
		// Token fallback: prefer later tokens (typical "<prefix>_<object>_<date>")
		const tokens = base.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
		for (let i = tokens.length - 1; i >= 0; i--) {
			const tk = csvNormalizeKey(tokens[i]);
			for (const v of variantsOf(tk)) {
				const hit = tryMatch(v);
				if (hit) {
return hit;
}
			}
		}
		return null;
	}

	// headerIndex -> field API name | null. Exact-normalized match on
	// field.name wins over match on field.label. Keep readable-but-
	// unwritable fields mapped: linked-csv.js names them in its explicit
	// drop-and-continue confirmation. Filtering them here made that safety
	// gate unreachable and silently presented the column as merely skipped.
	function csvAutoMapHeaders(headers, fields) {
		const byName = {};
		const byLabel = {};
		// Id isn't createable (Salesforce auto-assigns on insert),
		// but a CSV column named "Id" is the trigger for our
		// UPDATE-existing-record flow. Seed it explicitly so a
		// CSV that came out of Salesforce (always includes Id)
		// auto-maps without the user touching the dropdown.
		byName[csvNormalizeKey('Id')] = 'Id';
		byLabel[csvNormalizeKey('Record Id')] = 'Id';
	fields.forEach(f => {
			const nameKey = csvNormalizeKey(f.name);
			byName[nameKey] = f.name;
			const labelKey = f.label ? csvNormalizeKey(f.label) : '';
			if (labelKey) {
byLabel[labelKey] = f.name;
}
			// Lookup (reference) fields also accept the bare
			// object name as an alias, e.g. Contact.AccountId
			// (name="AccountId", label="Account ID") matches a
			// CSV header of just "Account" in addition to its
			// full forms. Common SF convention is to type the
			// relationship name, not the trailing "Id".
			//
			// Only fills the slot if it isn't already taken,
			// so a real text field literally named "Account"
			// (rare but possible) wins over the lookup alias.
			if (f.type === 'reference') {
				if (nameKey.endsWith('id') && nameKey.length > 2) {
					const stripped = nameKey.slice(0, -2);
					if (!byName[stripped]) {
byName[stripped] = f.name;
}
				}
				if (labelKey.endsWith('id') && labelKey.length > 2) {
					const stripped = labelKey.slice(0, -2);
					if (!byLabel[stripped]) {
byLabel[stripped] = f.name;
}
				}
			}
		});
		const mapping = {};
		headers.forEach((h, i) => {
			const k = csvNormalizeKey(h);
			mapping[i] = byName[k] || byLabel[k] || null;
		});
		return mapping;
	}

	window.OrgLoom.csvImport = {
		mount: function mount(deps) {
				// The single-CSV import modal was retired; linked-csv.js now handles
				// every CSV entry point, so the modal markup, opener, confirm flow,
				// and their deps are gone. What remains: the pure parse/map utilities
				// (module scope above) and pingAuditEvent (needs csrfFetch).
				if (!deps || !deps.csrfFetch) {
					throw new Error('csv-import.mount: missing required dep csrfFetch');
				}
				const csrfFetch = deps.csrfFetch;

			// Fire-and-forget POST to the server's client-driven audit
			// endpoint. Used by client-only flows (CSV import done, canvas
			// exported, canvas saved/loaded locally) so the activity log
			// has a complete picture even when the server didn't see the
			// action directly. Failures are swallowed; never block the UI
			// path on logging.
			function pingAuditEvent(action, fields) {
				try {
					csrfFetch('/api/audit-event', {
						method: 'POST',
						credentials: 'same-origin',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify(Object.assign({ action }, fields || {})),
					}).catch(() => {});
				} catch (e) { /* ignore */ }
			}

				return {
					// Pure CSV utilities, used by linked-csv.js, upload-modal,
					// templates, and canvas-save-load.
					parseCsv: parseCsv,
					csvNormalizeKey: csvNormalizeKey,
					csvGuessObjectFromFilename: csvGuessObjectFromFilename,
					csvAutoMapHeaders: csvAutoMapHeaders,
					// Audit ping (needs csrfFetch), exposed here because many call
					// sites already get it via this module's bundle.
					pingAuditEvent: pingAuditEvent,
				};
		},
	};
})();
