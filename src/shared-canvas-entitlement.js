const CANVAS_ID_RE = /^[a-zA-Z0-9]{15,18}$/;

export const SHARED_CANVAS_ENTRY = Object.freeze({
	INVALID: 'invalid',
	INACCESSIBLE: 'inaccessible',
	OWNER: 'owner',
	FREE_VIEWER: 'free-viewer',
	FREE_CONTRIBUTOR: 'free-contributor',
	PAID_RECIPIENT: 'paid-recipient',
	UNCLASSIFIED_RECIPIENT: 'unclassified-recipient',
});

export function isFreeViewerGrant(grant) {
	return !!grant && grant.role === 'viewer';
}

export function isFreeSharedRecipientGrant(grant) {
	return !!grant && (grant.role === 'viewer' || grant.role === 'contributor');
}

export function recipientRequiresPlan(grant) {
	return !isFreeSharedRecipientGrant(grant);
}

export function canvasEntryStartsTrial(kind) {
	return kind === SHARED_CANVAS_ENTRY.OWNER || kind === SHARED_CANVAS_ENTRY.PAID_RECIPIENT;
}

export async function classifySharedCanvasEntry({ canvasId, sfOrgId, sfUserId, getCanvas, getGrant }) {
	if (
		!CANVAS_ID_RE.test(String(canvasId || '')) ||
		!sfOrgId ||
		!sfUserId ||
		typeof getCanvas !== 'function' ||
		typeof getGrant !== 'function'
	) {
		return { kind: SHARED_CANVAS_ENTRY.INVALID, item: null, grant: null };
	}

	const item = await getCanvas(canvasId);
	if (!item) {
		return { kind: SHARED_CANVAS_ENTRY.INACCESSIBLE, item: null, grant: null };
	}
	if (item.ownedByMe) {
		return { kind: SHARED_CANVAS_ENTRY.OWNER, item, grant: null };
	}

	const grant = await getGrant({ sfOrgId, canvasId, recipientSfUserId: sfUserId });
	if (isFreeViewerGrant(grant)) {
		return { kind: SHARED_CANVAS_ENTRY.FREE_VIEWER, item, grant };
	}
	if (grant && grant.role === 'contributor') {
		return { kind: SHARED_CANVAS_ENTRY.FREE_CONTRIBUTOR, item, grant };
	}
	if (grant && grant.role === 'editor') {
		return { kind: SHARED_CANVAS_ENTRY.PAID_RECIPIENT, item, grant };
	}
	return { kind: SHARED_CANVAS_ENTRY.UNCLASSIFIED_RECIPIENT, item, grant: grant || null };
}
