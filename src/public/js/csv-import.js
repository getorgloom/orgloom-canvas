
(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};


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

	function csvAutoMapHeaders(headers, fields) {
		const byName = {};
		const byLabel = {};
		byName[csvNormalizeKey('Id')] = 'Id';
		byLabel[csvNormalizeKey('Record Id')] = 'Id';
	fields.forEach(f => {
			const nameKey = csvNormalizeKey(f.name);
			byName[nameKey] = f.name;
			const labelKey = f.label ? csvNormalizeKey(f.label) : '';
			if (labelKey) {
byLabel[labelKey] = f.name;
}
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
				if (!deps || !deps.csrfFetch) {
					throw new Error('csv-import.mount: missing required dep csrfFetch');
				}
				const csrfFetch = deps.csrfFetch;

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
					parseCsv: parseCsv,
					csvNormalizeKey: csvNormalizeKey,
					csvGuessObjectFromFilename: csvGuessObjectFromFilename,
					csvAutoMapHeaders: csvAutoMapHeaders,
					pingAuditEvent: pingAuditEvent,
				};
		},
	};
})();
