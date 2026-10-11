// Shared Salesforce read path for manual refresh and post-upload reconciliation.
// Salesforce's retrieve API uses the connected user's described fields and access.
export async function retrieveRecordValues(conn, records) {
	const byObject = new Map();
	const results = new Map();
	const keyFor = (objectName, sfId) => objectName + '::' + String(sfId).slice(0, 15);
	for (const record of records) {
		const { objectName, sfId } = record;
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(objectName || '') || !/^[A-Za-z0-9]+$/.test(sfId || '')) {
			results.set(keyFor(objectName, sfId), { ok: false, error: 'invalid-record' });
			continue;
		}
		if (!byObject.has(objectName)) byObject.set(objectName, new Set());
		byObject.get(objectName).add(sfId);
	}
	for (const [objectName, idSet] of byObject) {
		const ids = Array.from(idSet);
		for (let offset = 0; offset < ids.length; offset += 200) {
			const chunk = ids.slice(offset, offset + 200);
			for (const id of chunk) results.set(keyFor(objectName, id), { ok: false, error: 'not-found' });
			try {
				const response = await conn.sobject(objectName).retrieve(chunk);
				const requested = new Set(chunk.map((id) => keyFor(objectName, id)));
				for (const row of Array.isArray(response) ? response : [response]) {
					if (!row || !row.Id || !requested.has(keyFor(objectName, row.Id))) continue;
					const values = Object.fromEntries(Object.entries(row).filter(([name]) => name !== 'attributes'));
					results.set(keyFor(objectName, row.Id), { ok: true, values });
				}
			} catch (error) {
				const code = error && error.errorCode;
				const reason =
					code === 'INVALID_TYPE'
						? 'invalid-object'
						: code === 'INSUFFICIENT_ACCESS'
							? 'no-access'
							: 'retrieve-failed';
				for (const id of chunk) results.set(keyFor(objectName, id), { ok: false, error: reason });
			}
		}
	}
	return records.map(({ objectName, sfId }) => ({ objectName, sfId, ...results.get(keyFor(objectName, sfId)) }));
}
