// Rebuild the active jsforce client only when session identity matches the owned connection row.
import jsforce from 'jsforce';
import { connections as connectionsDb } from './database/index.js';
import * as viewStateDb from 'orgloom-canvas/database/view-state';
import { config } from './config.js';
import { createOAuth2 } from './auth.js';
import { getRefreshToken } from './sf-refresh-store.js';

const { Connection } = jsforce;

export async function getActiveSfConnection(req) {
	const accountId = req && req.session && req.session.accountId;
	if (!accountId) {
		return null;
	}

	const sfAuth = req.session && req.session.sfAuth;
	if (!sfAuth || !sfAuth.accessToken || !sfAuth.instanceUrl) {
		return null;
	}

	let connectionId = req.session && req.session.currentConnectionId;
	if (!connectionId) {
		try {
			const view = await viewStateDb.get(accountId);
			connectionId = view && view.current_connection_id;
		} catch (_) {}
	}
	if (!connectionId) {
		return null;
	}

	const conn = await connectionsDb.findById(connectionId);
	if (!conn) {
		return null;
	}
	if (conn.account_id !== accountId) {
		return null;
	}
	if (conn.disabled_at) {
		return null;
	}

	const userMismatch = sfAuth.sfUserId && conn.sf_user_id && sfAuth.sfUserId !== conn.sf_user_id;
	const orgMismatch = sfAuth.sfOrgId && conn.sf_org_id && sfAuth.sfOrgId !== conn.sf_org_id;
	if (userMismatch || orgMismatch) {
		// A stale token must never ride a newly selected connection into another user or org.
		return null;
	}

	const sid = req.session && req.session.id;
	const refreshToken = sid ? getRefreshToken(sid, connectionId) : null;
	let sfConn;
	if (refreshToken) {
		// Refresh tokens are process-memory only; refreshed access tokens return to the server session.
		sfConn = new Connection({
			oauth2: createOAuth2(sfAuth.instanceUrl),
			instanceUrl: sfAuth.instanceUrl,
			accessToken: sfAuth.accessToken,
			refreshToken,
			version: config.salesforce.apiVersion,
		});
		sfConn.on('refresh', (newAccessToken) => {
			try {
				if (newAccessToken && req.session) {
					if (req.session.sfAuth) {
						req.session.sfAuth.accessToken = newAccessToken;
					}
					if (req.session.sfAuthByConnection && req.session.sfAuthByConnection[connectionId]) {
						req.session.sfAuthByConnection[connectionId].accessToken = newAccessToken;
					}
					if (typeof req.session.save === 'function') {
						req.session.save(() => {});
					}
				}
			} catch (_) {}
		});
	} else {
		sfConn = new Connection({
			instanceUrl: sfAuth.instanceUrl,
			accessToken: sfAuth.accessToken,
			version: config.salesforce.apiVersion,
		});
	}

	connectionsDb.touchLastUsed(connectionId).catch(() => {});

	return {
		conn: sfConn,
		connectionRow: conn,
		sfUserId: sfAuth.sfUserId || conn.sf_user_id,
		sfOrgId: sfAuth.sfOrgId || conn.sf_org_id,
		instanceUrl: sfAuth.instanceUrl,
		orgType: conn.org_type,
	};
}
