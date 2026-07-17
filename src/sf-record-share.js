// SF record-level sharing helpers. Used by the magic-link share flow
// to grant a recipient SF user direct read/edit access to the
// underlying records a canvas references; without it, the recipient's
// connection can't see the records and their slot-fills fail with
// "no record to update."
//
// Share-table schema conventions (different for custom vs standard):
//
//   Custom objects: <ObjectName>__c → <ObjectName>__Share
//     - parent-id field: ParentId
//     - access-level field: AccessLevel
//     - e.g., Project__c → Project__Share with
//       { ParentId, UserOrGroupId, AccessLevel, RowCause }
//     - Namespaced custom objects (ns__Foo__c) follow the same rule:
//       ns__Foo__c → ns__Foo__Share.
//
//   Standard objects: <ObjectName> → <ObjectName>Share
//     - parent-id field: <ObjectName>Id
//     - access-level field: <ObjectName>AccessLevel
//     - e.g., Account → AccountShare with
//       { AccountId, UserOrGroupId, AccountAccessLevel, RowCause }
//     - Account additionally has OpportunityAccessLevel /
//       CaseAccessLevel / ContactAccessLevel fields; when omitted SF
//       defaults them to 'None' which works for our recipient-fill
//       use case (we just need access to the Account itself).
//
//   Some standard objects (User, Profile, ContentDocument, etc.) and
//   some org configurations (OWD = Public Read/Write) reject share
//   inserts entirely. Failures bubble up per-record so the owner can
//   see which records need a manual sharing rule from their admin.

// Map an SObject API name to the schema of its sharing table. Pure,
// extracted so tests pin the standard-vs-custom split explicitly.
// Returns { shareTable, parentField, accessLevelField, extraFields }.
//
// `extraFields` covers SF's quirk where AccountShare requires extra
// AccessLevel axes (OpportunityAccessLevel + CaseAccessLevel) even
// when the caller only cares about Account access. SF errors with
// "missing required field: [OpportunityAccessLevel]" if these are
// omitted. We default them to 'None': share grants Account access
// only, child records are governed by their own sharing.
//
// Other standard-object shares (Opportunity / Lead / Case / Contact /
// Campaign) are single-axis and need no extras. Custom-object shares
// are uniform: ParentId + AccessLevel + RowCause.
export function shareSchemaFor(objectName) {
	if (typeof objectName !== 'string' || !objectName) {
		throw new Error('shareSchemaFor: objectName is required');
	}
	if (objectName.endsWith('__c')) {
		// Custom objects: <X>__c → <X>__Share with ParentId / AccessLevel.
		// Namespaced custom objects (ns__Foo__c) follow the same rule
		// (ns__Foo__c → ns__Foo__Share).
		return {
			shareTable: objectName.slice(0, -3) + '__Share',
			parentField: 'ParentId',
			accessLevelField: 'AccessLevel',
			extraFields: {},
		};
	}
	// AccountShare's multi-axis quirk. Required extras default to 'None'
	// so the grant scopes to Account only; child Opportunity/Case
	// access is whatever the recipient already had via their own
	// profile/sharing. Setting them to anything other than 'None'
	// would silently grant cascading access we didn't ask about.
	if (objectName === 'Account') {
		return {
			shareTable: 'AccountShare',
			parentField: 'AccountId',
			accessLevelField: 'AccountAccessLevel',
			extraFields: {
				OpportunityAccessLevel: 'None',
				CaseAccessLevel: 'None',
			},
		};
	}
	// Standard objects: <X> → <X>Share with <X>Id / <X>AccessLevel.
	return {
		shareTable: objectName + 'Share',
		parentField: objectName + 'Id',
		accessLevelField: objectName + 'AccessLevel',
		extraFields: {},
	};
}

// Back-compat alias for callers that just want the table name.
export function shareTableFor(objectName) {
	return shareSchemaFor(objectName).shareTable;
}

// Classify a SF share-insert error string into one of:
//   'duplicate': DUPLICATE_VALUE; row already exists. Recipient has access.
//   'covered-by-owd': "below organization levels"; OWD already grants the
//                       recipient at least what we asked for. Manual share is
//                       redundant; recipient has access.
//   'fatal': anything else; surface to the caller as a real failure.
//
// Exported so tests can pin the classification matrix and the route
// layer (or future callers) can reuse the same buckets without re-
// implementing the regex.
export function _classifyShareError(msg) {
	if (!msg) {
return 'fatal';
}
	const s = String(msg);
	if (/duplicate|already.*shared|DUPLICATE_VALUE/i.test(s)) {
return 'duplicate';
}
	if (/below organization level/i.test(s)) {
return 'covered-by-owd';
}
	return 'fatal';
}

// Grant a SF user manual share access to a list of records. Each item
// is { objectName, recordId }. Inserts a manual share row per record
// using the recipient's SF user id as UserOrGroupId, AccessLevel =
// 'Edit' (covers both read and write; slot-fill needs both).
//
// Returns { granted, failed }. Each entry carries the (objectName,
// recordId) pair so the caller can correlate. Failures include the
// SF error message so the UI can surface "ask your admin to share
// X" (usually fired by insufficient-owner-perms cases).
//
// Two no-op-but-recipient-has-access conditions are normalized to
// `granted` (with a flag on the entry):
//   * DUPLICATE_VALUE: the share already exists. `alreadyShared: true`.
//   * "below organization levels": the org's sharing defaults already
//     grant the recipient at least the access we asked for, so the
//     manual share row is redundant. SF rejects with that string when
//     OWD on the object (or its child Opp/Case for AccountShare) is
//     looser than what we passed in. `coveredByOWD: true`. The
//     recipient HAS access either way; we just can't record it as
//     a manual share row.
export async function grantRecordAccess(conn, items, recipientSfUserId) {
	const granted = [];
	const failed = [];
	if (!Array.isArray(items) || items.length === 0) {
return { granted, failed };
}
	if (typeof recipientSfUserId !== 'string' || !recipientSfUserId) {
		throw new Error('grantRecordAccess: recipientSfUserId is required');
	}

	// Sequential per-record insert. Could batch via composite REST for
	// many records, but the typical canvas has <20 records and the
	// failure-isolation per-record matches the UX (we want to know
	// exactly which records bounced, not "the whole batch failed").
	for (const item of items) {
		const objectName = item && item.objectName;
		const recordId = item && item.recordId;
		if (!objectName || !recordId) {
			failed.push({
				objectName: objectName || null,
				recordId: recordId || null,
				error: 'Missing objectName or recordId',
			});
			continue;
		}
		let schema;
		try {
			schema = shareSchemaFor(objectName);
		} catch (e) {
			failed.push({ objectName, recordId, error: e.message || String(e) });
			continue;
		}
		// Build the share row using the per-object field names. Custom
		// objects get { ParentId, AccessLevel }; standard objects get
		// { <Object>Id, <Object>AccessLevel }. AccountShare additionally
		// requires { OpportunityAccessLevel, CaseAccessLevel } per the
		// schema's `extraFields` map (defaulted to 'None'; see
		// shareSchemaFor for the rationale).
		const row = Object.assign(
			{
				[schema.parentField]: recordId,
				UserOrGroupId: recipientSfUserId,
				[schema.accessLevelField]: 'Edit',
			},
			schema.extraFields || {},
			{ RowCause: 'Manual' },
		);
		try {
			const result = await conn.sobject(schema.shareTable).create(row);
			if (result && result.success) {
				granted.push({ objectName, recordId, shareId: result.id });
			} else {
				const errs = ((result && result.errors) || []).map((e) => e.message || String(e)).join('; ');
				const cls = _classifyShareError(errs);
				if (cls === 'duplicate') {
					granted.push({ objectName, recordId, alreadyShared: true });
				} else if (cls === 'covered-by-owd') {
					granted.push({ objectName, recordId, coveredByOWD: true });
				} else {
					failed.push({ objectName, recordId, error: errs || 'unknown error' });
				}
			}
		} catch (e) {
			const msg = String(e && (e.message || e));
			const cls = _classifyShareError(msg);
			if (cls === 'duplicate') {
				granted.push({ objectName, recordId, alreadyShared: true });
			} else if (cls === 'covered-by-owd') {
				granted.push({ objectName, recordId, coveredByOWD: true });
			} else {
				failed.push({ objectName, recordId, error: msg });
			}
		}
	}

	return { granted, failed };
}

// Build the list of unique (objectName, recordId) pairs to share for a
// given canvas manifest. Drafts (no loadedFromId) and non-record
// entries (type-nodes, pending) are excluded: they have nothing to
// share. De-duplicates by recordId so a canvas with two slots on the
// same record only triggers one share.
//
// Handles both payload shapes: the client serializes records into
// `loadedRecords` + `drafts` arrays, while internal/test code may use
// a unified `records` array. We walk whichever is present (or both)
// so the helper works against any caller.
export function recordsToShareFromManifest(payload) {
	const out = [];
	const seen = new Set();
	const sources = [];
	if (payload && Array.isArray(payload.loadedRecords)) {
sources.push(payload.loadedRecords);
}
	if (payload && Array.isArray(payload.drafts)) {
sources.push(payload.drafts);
}
	if (payload && Array.isArray(payload.records)) {
sources.push(payload.records);
}
	for (const list of sources) {
		for (const rec of list) {
			if (!rec || rec.isTypeNode || rec.isPending) {
continue;
}
			if (!rec.loadedFromId || !rec.objectName) {
continue;
}
			if (seen.has(rec.loadedFromId)) {
continue;
}
			seen.add(rec.loadedFromId);
			out.push({ objectName: rec.objectName, recordId: rec.loadedFromId });
		}
	}
	return out;
}
