// Build a jsforce Connection from the active session's access token.
// Replaces the legacy getConnection(req) helper in auth.js.
//
// Access token lives in req.session.sfAuth for the duration of the user's
// Orgloom session and is wiped on sign-out.
//
// Refresh tokens are NEVER persisted. If the Connected App grants
// offline_access, /auth/callback keeps the issued refresh token ONLY in
// process memory (sf-refresh-store.js), keyed by (session, connection), not
// in the DB, not in the session store. When present, the Connection below is
// built with it so jsforce silently renews the access token on
// INVALID_SESSION_ID and retries: a long canvas session isn't bounced to
// re-auth. A server restart drops the in-memory token (re-auth next time).
//
// When no refresh token is held (offline_access not granted, or a fresh
// process), mid-session access-token expiry still surfaces as a Salesforce
// 401 / INVALID_SESSION_ID → { error: 'sf-session-expired' }; the client
// fetch interceptor (public/js/sf-fetch.js) then shows the interactive reauth
// UI. That is the graceful fallback, never a broken state.
//
// Connection lookup chain:
//   req.session.accountId      who's signed in
//   req.session.sfAuth         active SF identity + access token
//   account_view_state         which connection row to surface (display info)
//   connections                org_type, display_name, etc. (no tokens)
//
// Returns null when:
//   - account isn't signed in
//   - no active SF auth on the session (user hasn't connected SF yet,
//     or signed out of SF without signing out of Orgloom)
//   - the connection row is missing, disabled, or owned by a different
//     account (defensive: the join shouldn't allow this but the check
//     is cheap)

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

	// Connection row provides display + org-type metadata. Prefer the
	// session-stamped currentConnectionId (set on /auth/callback +
	// /api/connections/:id/activate); fall back to account_view_state
	// for older sessions that pre-date the session-stamping path. This
	// fallback also makes view-state's presence optional: canvas-
	// standalone doesn't have a workspace concept and doesn't need
	// view_state at all; it stamps the session directly.
	let connectionId = req.session && req.session.currentConnectionId;
	if (!connectionId) {
		try {
			const view = await viewStateDb.get(accountId);
			connectionId = view && view.current_connection_id;
		} catch (_) {
			// view_state table absent or other error: canvas-standalone
			// without saas. Treat as no active connection.
		}
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

	// Defense-in-depth: the live access token (sfAuth) and the active
	// connection row can point at DIFFERENT Salesforce identities if
	// the account changed without sfAuth being reset, OR if the same
	// SF user belongs to multiple orgs and the active row got flipped
	// to a different org while the token still belongs to the previous
	// one. Pairing one identity/org's token with another's connection
	// row would run every SF call against the wrong target: wrong-
	// user OR wrong-org silent mismatch, and misfire owner-only
	// checks, audit attribution, etc. The activate endpoint enforces
	// the same (user, org) match before skipping re-OAuth; this guard
	// re-validates on every request. Mismatch ⇒ treat as no active
	// connection, routing the user to reconnect (which re-establishes
	// an aligned sfAuth + connection row pair).
	const userMismatch = sfAuth.sfUserId && conn.sf_user_id
		&& sfAuth.sfUserId !== conn.sf_user_id;
	const orgMismatch = sfAuth.sfOrgId && conn.sf_org_id
		&& sfAuth.sfOrgId !== conn.sf_org_id;
	if (userMismatch || orgMismatch) {
		return null;
	}

	// version: jsforce's library default is '50.0' (Spring '21), which
	// predates UI API features like /ui-api/lookups?searchType=Search.
	// Pinned to config.salesforce.apiVersion (env var SF_API_VERSION)
	// so the URL builders (`conn.version || fallback`) read a modern
	// value and our API surface matches what Salesforce's own
	// Lightning UI does. See config.js for the default + override
	// mechanism.
	// Silent access-token renewal. When the Connected App granted
	// offline_access, /auth/callback stashed a refresh token in the
	// process-memory sf-refresh-store (never persisted, see that module).
	// If one exists for this (session, connection), build the Connection
	// with it so jsforce transparently renews the access token on
	// INVALID_SESSION_ID and retries, instead of surfacing a re-auth
	// mid-canvas. On renewal we write back ONLY the new access token onto
	// the session; the refresh token stays in memory. With no refresh token
	// (offline_access not granted, or a fresh process after restart) this
	// falls back to the original access-token-only Connection and today's
	// re-auth-on-expiry behavior.
	const sid = req.session && req.session.id;
	const refreshToken = sid ? getRefreshToken(sid, connectionId) : null;
	let sfConn;
	if (refreshToken) {
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
					// Keep the multi-token switch cache fresh too, so a later
					// switch back to this connection reuses the renewed token
					// (session round-trips through JSON, so sfAuth and the
					// per-connection entry are distinct objects: update both).
					if (req.session.sfAuthByConnection
						&& req.session.sfAuthByConnection[connectionId]) {
						req.session.sfAuthByConnection[connectionId].accessToken = newAccessToken;
					}
					if (typeof req.session.save === 'function') {
						req.session.save(() => {});
					}
				}
			} catch (_) {
				// Best-effort: the renewed token on sfConn is still valid
				// for this request even if the session write hiccups.
			}
		});
	} else {
		sfConn = new Connection({
			instanceUrl: sfAuth.instanceUrl,
			accessToken: sfAuth.accessToken,
			version: config.salesforce.apiVersion,
		});
	}

	// Touch last_used_at lazily: this is best-effort book-keeping for
	// the admin panel's "when did this connection last work" column.
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
