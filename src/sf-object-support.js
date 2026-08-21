const SPECIALIZED_SUFFIX_RE = /__(?:e|mdt|b|x|kav)$/i;
const KNOWLEDGE_VERSION_RE = /^KnowledgeArticleVersion/i;
const STANDARD_PLATFORM_EVENT_RE = /Event(?:Stream)?$/i;

export function isSpecializedSObject(name) {
	if (typeof name !== 'string' || !name) {
		return false;
	}
	return (
		SPECIALIZED_SUFFIX_RE.test(name) ||
		KNOWLEDGE_VERSION_RE.test(name) ||
		(name.toLowerCase() !== 'event' && STANDARD_PLATFORM_EVENT_RE.test(name))
	);
}

export function specializedObjectNamesFromPayload(payload) {
	const items = [
		...(Array.isArray(payload?.records) ? payload.records : []),
		...(Array.isArray(payload?.deletes) ? payload.deletes : []),
	];
	return [...new Set(items.map((item) => item?.objectName).filter(isSpecializedSObject))].sort();
}

export function specializedObjectError(objects, action = 'upload') {
	const names = [...new Set(objects || [])].sort();
	const actionCopy = action === 'import' ? 'importing' : 'uploading';
	return {
		error: 'specialized-object-unsupported',
		objects: names,
		message:
			'Org Loom does not support ' +
			actionCopy +
			' these specialized Salesforce object types: ' +
			names.join(', ') +
			'. Remove them and try again.',
	};
}
