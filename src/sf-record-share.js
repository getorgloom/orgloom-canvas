export function shareSchemaFor(objectName) {
	if (typeof objectName !== 'string' || !objectName) {
		throw new Error('shareSchemaFor: objectName is required');
	}
	if (objectName.endsWith('__c')) {

		return {
			shareTable: objectName.slice(0, -3) + '__Share',
			parentField: 'ParentId',
			accessLevelField: 'AccessLevel',
			extraFields: {},
		};
	}

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

	return {
		shareTable: objectName + 'Share',
		parentField: objectName + 'Id',
		accessLevelField: objectName + 'AccessLevel',
		extraFields: {},
	};
}

export function shareTableFor(objectName) {
	return shareSchemaFor(objectName).shareTable;
}

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

export async function grantRecordAccess(conn, items, recipientSfUserId) {
	const granted = [];
	const failed = [];
	if (!Array.isArray(items) || items.length === 0) {
return { granted, failed };
}
	if (typeof recipientSfUserId !== 'string' || !recipientSfUserId) {
		throw new Error('grantRecordAccess: recipientSfUserId is required');
	}

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
