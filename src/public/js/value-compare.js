// Lenient value-equality + record-diff utilities.
//
// Strict !== falsely flags differences that come from form-input
// normalization (booleans, numerics, ISO datetime stripping) rather
// than user intent. These helpers treat:
//   - null / undefined / "" as equivalent
//   - "5" === 5, "5.0" === 5
//   - "true" === true, "false" === false
//   - same Date.parse() ms as equal (handles SF's ISO-Z vs +0000
//     normalization and datetime-local stripping)
//
// Used by:
//   - Save Draft / Save Canvas flows: detect whether a loaded record
//     has REALLY been edited (vs. round-trip whitespace / coercion)
//   - "Saved N fields" toast: report fields that ACTUALLY changed
//     this cycle, not total field count
//   - beforeunload guard: count modified loaded records before
//     letting the user navigate away with unsaved edits
//
// All functions in this module are PURE: no DOM, no fetch, no
// canvas state. Unit-testable in isolation.
//
// Exposed as window.OrgLoom.valueCompare. Load order: before app.js
// (any deferred-script order works).

(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	function valuesEquivalent(a, b) {
		if (a === b) {
return true;
}
		// Trim so leading/trailing whitespace (and whitespace-only
		// vs empty) don't register as edits (CSV round-trips and SF
		// both introduce stray spaces). null/undefined collapse to ''.
		const sa = (a == null) ? '' : String(a).trim();
		const sb = (b == null) ? '' : String(b).trim();
		if (sa === sb) {
return true;
}
		if (sa === '' || sb === '') {
return false;
}
		// Numeric compare
		const na = Number(sa);
		const nb = Number(sb);
		if (!isNaN(na) && !isNaN(nb) && na === nb) {
return true;
}
		// Boolean compare
		const lowA = sa.toLowerCase();
		const lowB = sb.toLowerCase();
		if ((lowA === 'true' || lowA === 'false') && (lowB === 'true' || lowB === 'false') && lowA === lowB) {
return true;
}
		if ((a === true || a === false) && (lowB === 'true' || lowB === 'false') && lowB === String(a)) {
return true;
}
		if ((b === true || b === false) && (lowA === 'true' || lowA === 'false') && lowA === String(b)) {
return true;
}
		// Datetime compare via Date.parse
		if (/\d{4}-\d{2}-\d{2}/.test(sa) && /\d{4}-\d{2}-\d{2}/.test(sb)) {
			const ta = Date.parse(sa);
			const tb = Date.parse(sb);
			if (!isNaN(ta) && !isNaN(tb) && ta === tb) {
return true;
}
		}
		return false;
	}

	function valuesDiffer(a, b) {
		const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
		for (const k of keys) {
			if (!valuesEquivalent((a || {})[k], (b || {})[k])) {
return true;
}
		}
		return false;
	}

	// Returns the field names whose value differs between a and b
	// (using the same equivalence rules as valuesDiffer). Used by
	// Save Draft so the "saved N fields" toast reports the number
	// of fields that ACTUALLY changed in this save cycle, not the
	// total field count of the payload.
	function changedFieldNames(a, b) {
		const out = [];
		const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
		for (const k of keys) {
			if (!valuesEquivalent((a || {})[k], (b || {})[k])) {
out.push(k);
}
		}
		return out;
	}

	function isRecordModified(rec) {
		if (!rec || !rec.loadedFromId) {
return false;
}
		// A cross-org match points this source canvas record at an existing
		// destination row. Even when the source record had no local edits, its
		// source values still need to be applied to that destination row once.
		if (rec._migrateMatchedId) {
			return true;
		}
		// No-access placeholders carry a loadedFromId for the ref +
		// FK resolution, but have no fetched values to diff against
		// and can't be edited. They're never "modified".
		if (rec._inaccessible) {
return false;
}
		if (!rec.loadedValues) {
return false;
}
		return valuesDiffer(rec.values || {}, rec.loadedValues || {});
	}

	// Loaded record the user has staged for SF-side DELETE on next
	// upload. Distinct from isRecordModified: a pending-delete record
	// is NOT a value-edit; the upload pipeline routes it through a
	// separate DELETE batch instead of POST/PATCH. Drafts can't be
	// pending-delete (there's nothing in SF to delete; they just
	// get "Remove from canvas" instead). Type-nodes and inaccessible
	// placeholders are likewise ineligible.
	function isRecordPendingDelete(rec) {
		if (!rec) {
return false;
}
		if (!rec.loadedFromId) {
return false;
}
		if (rec._inaccessible) {
return false;
}
		if (rec.isTypeNode) {
return false;
}
		return !!rec.pendingDelete;
	}

	// Pending create: draft that hasn't been uploaded yet. Mostly a
	// readability helper; equivalent to "not loaded and not a type-
	// node placeholder." Kept here so hasPendingChange below is
	// symmetric across the three change kinds the upload modal
	// surfaces (creates, updates, deletes).
	function isRecordPendingCreate(rec) {
		if (!rec) {
return false;
}
		if (rec.isTypeNode) {
return false;
}
		return !rec.loadedFromId;
	}

	// "Does this record contribute work to the next upload?" is used by
	// every site that previously asked isRecordModified to decide
	// upload-counts / button-enabled / has-unsaved-changes. The
	// pure value-diff sites (per-field edit indicators, beforeunload
	// guard for unsaved value edits) stay on isRecordModified.
	function hasPendingChange(rec) {
		return isRecordPendingCreate(rec) || isRecordModified(rec) || isRecordPendingDelete(rec);
	}

	// Field-level diff between two records' values. Pure: operates on
	// the in-memory `values` objects, no DOM/fetch, no notion of where
	// the records came from (org, draft, loaded; it's irrelevant here).
	//
	// Returns four buckets indexed by field name. The three-way split
	// between "differing / aOnly / bOnly" is deliberate: collapsing
	// "set on A, empty on B" into "differing" produces noise; users
	// reading a diff want to distinguish "the values disagree" from
	// "this field is absent on one side." Fields empty on both sides
	// are dropped entirely (the "differ in nothingness" category is
	// always noise).
	//
	// Equality uses valuesEquivalent: same lenient rules the rest of
	// the codebase uses for "is this record modified?", so the diff
	// modal and the modified-badge agree on what counts as a change.
	//
	// recA / recB shapes:
	//   { values: {fieldName: value, ...}, objectName: 'Account', ... }
	// Either may have a missing/null `values` (treated as {}).
	//
	// Result shape:
	//   {
	//     sameObject: boolean,           // a.objectName === b.objectName
	//     objectA: string|null,          // for the modal header
	//     objectB: string|null,
	//     shared: string[],              // both set, equivalent values
	//     differing: string[],           // both set, values differ
	//     aOnly: string[],               // set on A, empty/absent on B
	//     bOnly: string[],               // set on B, empty/absent on A
	//   }
	//
	// All four field arrays are sorted alphabetically: the modal can
	// render straight from them without re-sorting.
	function _hasMeaningfulValue(v) {
		if (v == null) {
return false;
}
		if (typeof v === 'string' && v.trim() === '') {
return false;
}
		return true;
	}
	function computeRecordDiff(recA, recB) {
		const a = (recA && recA.values) || {};
		const b = (recB && recB.values) || {};
		const objectA = (recA && recA.objectName) || null;
		const objectB = (recB && recB.objectName) || null;
		const sameObject = !!(objectA && objectB && objectA === objectB);
		const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
		const shared = [];
		const differing = [];
		const aOnly = [];
		const bOnly = [];
		for (const k of keys) {
			const aHas = _hasMeaningfulValue(a[k]);
			const bHas = _hasMeaningfulValue(b[k]);
			if (!aHas && !bHas) {
continue;
} // ignore "both empty"
			if (aHas && !bHas) {
 aOnly.push(k); continue; 
}
			if (!aHas && bHas) {
 bOnly.push(k); continue; 
}
			if (valuesEquivalent(a[k], b[k])) {
shared.push(k);
} else {
differing.push(k);
}
		}
		const sort = (arr) => arr.sort((x, y) => x.localeCompare(y));
		return {
			sameObject,
			objectA,
			objectB,
			shared: sort(shared),
			differing: sort(differing),
			aOnly: sort(aOnly),
			bOnly: sort(bOnly),
		};
	}

	window.OrgLoom.valueCompare = {
		valuesEquivalent: valuesEquivalent,
		valuesDiffer: valuesDiffer,
		changedFieldNames: changedFieldNames,
		isRecordModified: isRecordModified,
		isRecordPendingDelete: isRecordPendingDelete,
		isRecordPendingCreate: isRecordPendingCreate,
		hasPendingChange: hasPendingChange,
		computeRecordDiff: computeRecordDiff,
	};
})();
