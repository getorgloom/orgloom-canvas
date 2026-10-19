// Only metadata and confirmed Salesforce IDs are exposed during recovery.
// Absence of a response is never treated as a failed write.
export function uploadAttemptRecovery(batch) {
	const progress = batch.graphProgress;
	const results = (batch.insertedIds || []).map((r) => ({
		tempId: r.tempId,
		objectName: r.objectName,
		id: r.sfId,
		success: true,
		mode: r.mode || 'create',
	}));
	const confirmed = new Set(results.map((r) => r.tempId));
	const started = new Set(progress?.startedTempIds || []);
	const failed = new Set(
		(progress?.results || [])
			.filter((r) => !r.success && r.errorCode !== 'GRAPH_RESPONSE_INCOMPLETE')
			.map((r) => r.tempId),
	);
	const stopped = progress?.stopped === true || batch.status === 'uploaded' || batch.status === 'failed';
	const retryableTempIds = stopped
		? (progress?.intendedTempIds || []).filter((id) => !confirmed.has(id) && (!started.has(id) || failed.has(id)))
		: [];
	return { batchId: batch.id, attemptId: batch.attemptId, results, retryableTempIds };
}
