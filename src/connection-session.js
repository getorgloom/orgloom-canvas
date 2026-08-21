import * as viewStateDb from './database/view-state.js';
import { dropRefreshToken, dropSessionRefreshTokens } from './sf-refresh-store.js';
import { clearKekCacheForSession } from './storage/canvas-encryption.js';

export function isConnectionActive({ connection, session, view }) {
	if (!connection) {
		return false;
	}
	const sfAuth = session && session.sfAuth;
	if (sfAuth && sfAuth.sfUserId && sfAuth.sfOrgId) {
		return sfAuth.sfUserId === connection.sf_user_id && sfAuth.sfOrgId === connection.sf_org_id;
	}
	return !!(
		(session && session.currentConnectionId === connection.id) ||
		(view && view.current_connection_id === connection.id)
	);
}

export function saveSession(session) {
	if (!session || typeof session.save !== 'function') {
		return Promise.resolve();
	}
	return new Promise((resolve, reject) => {
		session.save((error) => (error ? reject(error) : resolve()));
	});
}

export async function clearActiveSalesforceSession({ session, accountId }) {
	if (accountId) {
		await viewStateDb.setCurrentConnection(accountId, null);
	}
	if (!session) {
		return;
	}
	dropSessionRefreshTokens(session.id);
	clearKekCacheForSession(session.id);
	delete session.sfAuth;
	delete session.sfAuthByConnection;
	session.currentConnectionId = null;
	session.forceSfIdentityPrompt = true;
	await saveSession(session);
}

export async function removeSavedConnectionFromSession({ session, accountId, connectionId }) {
	if (accountId) {
		const view = await viewStateDb.get(accountId);
		if (view && view.current_connection_id === connectionId) {
			await viewStateDb.setCurrentConnection(accountId, null);
		}
	}
	if (!session) {
		return;
	}
	dropRefreshToken(session.id, connectionId);
	if (session.sfAuthByConnection) {
		delete session.sfAuthByConnection[connectionId];
	}
	if (session.currentConnectionId === connectionId) {
		session.currentConnectionId = null;
	}
	await saveSession(session);
}
