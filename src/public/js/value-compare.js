(function () {
	'use strict';
	// Normalizes Salesforce value shapes for dirty checks, migration, diffing, and undo guards.

	window.OrgLoom = window.OrgLoom || {};

	function valuesEquivalent(a, b) {
		if (a === b) {
			return true;
		}
		const sa = a == null ? '' : String(a).trim();
		const sb = b == null ? '' : String(b).trim();
		if (sa === sb) {
			return true;
		}
		if (sa === '' || sb === '') {
			return false;
		}
		const na = Number(sa);
		const nb = Number(sb);
		if (!isNaN(na) && !isNaN(nb) && na === nb) {
			return true;
		}
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
		if (rec._migrateMatchedId) {
			return true;
		}
		if (rec._inaccessible) {
			return false;
		}
		if (!rec.loadedValues) {
			return false;
		}
		return valuesDiffer(rec.values || {}, rec.loadedValues || {});
	}

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

	function isRecordPendingCreate(rec) {
		if (!rec) {
			return false;
		}
		if (rec.isTypeNode) {
			return false;
		}
		return !rec.loadedFromId;
	}

	function hasPendingChange(rec) {
		return isRecordPendingCreate(rec) || isRecordModified(rec) || isRecordPendingDelete(rec);
	}

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
				aOnly.push(k);
				continue;
			}
			if (!aHas && bHas) {
				bOnly.push(k);
				continue;
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
