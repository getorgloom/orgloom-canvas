// Composite Graph limits apply to graphs as well as the number of records.
// Keep connected components intact so their rollback boundaries do not change.
export const GRAPH_REQUEST_CAP = 75;

export async function requestGraphBatches({ conn, apiBase, graphs, allowDuplicates }) {
	const responses = [];
	for (let offset = 0; offset < graphs.length; offset += GRAPH_REQUEST_CAP) {
		const batch = graphs.slice(offset, offset + GRAPH_REQUEST_CAP);
		const response = await conn.request({
			method: 'POST',
			url: apiBase + '/composite/graph',
			body: JSON.stringify({ graphs: batch }),
			headers: {
				'Content-Type': 'application/json',
				...(allowDuplicates ? { 'Sforce-Duplicate-Rule-Header': 'allowSave=true' } : {}),
			},
		});
		const returned = Array.isArray(response?.graphs) ? response.graphs : [];
		responses.push(...returned);
		// Do not submit more work after an incomplete response. The caller keeps
		// the attempt pending because a missing result does not prove rollback.
		const ids = new Set(returned.map((graph) => graph?.graphId));
		if (returned.length !== batch.length || !batch.every((graph) => ids.has(graph.graphId))) {
			break;
		}
	}
	return { graphs: responses };
}

function graphErrors(response) {
	const body = response?.graphResponse;
	const errors = Array.isArray(body) ? body : body?.errors || response?.errors || (body?.errorCode ? [body] : []);
	return Array.isArray(errors) ? errors : [];
}

export function parseGraphResults({ graphs, response, recordsByRefId }) {
	const returned = Array.isArray(response?.graphs) ? response.graphs : [];
	const results = [];
	let hasUnknownOutcome = returned.some((item) => !graphs.some((graph) => graph.graphId === item?.graphId));
	let allAtomicSuccess = graphs.length > 0;
	for (const graph of graphs) {
		const matches = returned.filter((item) => item?.graphId === graph.graphId);
		const reply = matches.length === 1 ? matches[0] : null;
		const successful = reply?.isSuccessful === true;
		const rolledBack = reply?.isSuccessful === false;
		const responses = Array.isArray(reply?.graphResponse?.compositeResponse)
			? reply.graphResponse.compositeResponse
			: [];
		const errors = graphErrors(reply);
		if (!successful) {
			allAtomicSuccess = false;
		}
		for (const request of graph.compositeRequest) {
			const record = recordsByRefId.get(request.referenceId);
			const base = { tempId: record.tempId, objectName: record.objectName };
			const subMatches = responses.filter((item) => item?.referenceId === request.referenceId);
			const sub = subMatches.length === 1 ? subMatches[0] : null;
			const status = sub?.httpStatusCode || 0;
			const id = record.loadedFromId || sub?.body?.id;
			if (successful && status >= 200 && status < 300 && id) {
				results.push({ ...base, success: true, id, mode: record.loadedFromId ? 'update' : 'create' });
				continue;
			}
			allAtomicSuccess = false;
			if (rolledBack) {
				const bodies =
					status >= 400 ? (Array.isArray(sub.body) ? sub.body : sub.body ? [sub.body] : []) : errors;
				const error = bodies[0];
				results.push({
					...base,
					success: false,
					error:
						bodies
							.map((item) => item?.message)
							.filter(Boolean)
							.join('; ') || 'Rolled back: Salesforce did not complete this graph.',
					errorCode: error?.errorCode || 'GRAPH_ROLLED_BACK',
					fields: [...new Set(bodies.flatMap((item) => (Array.isArray(item?.fields) ? item.fields : [])))],
				});
				continue;
			}
			hasUnknownOutcome = true;
			results.push({
				...base,
				success: false,
				errorCode: 'GRAPH_RESPONSE_INCOMPLETE',
				error: 'Salesforce did not return a complete result for this record. Its upload outcome is unknown.',
			});
		}
	}
	return { results, allAtomicSuccess: allAtomicSuccess && !hasUnknownOutcome, hasUnknownOutcome };
}
