// Global fetch interceptor for Salesforce session-expiry handling.
//
// Orgloom doesn't request refresh tokens, so the active access token
// expires after ~2 hours of Orgloom session activity. When it expires
// (or the SF session is lost server-side), /api/* routes return 401
// { error: 'sf-session-expired' } or 409 { error: 'no-active-connection' }.
// This wrapper catches those and surfaces the interactive reauth UI:
// a modal offering sign-in / switch-org / keep-working-offline. It never
// auto-redirects: the user always chooses what happens next. (During a
// cold page load that's still parsing, the modal is deferred to
// DOMContentLoaded rather than redirected.)
//
// There is intentionally no silent (hidden-iframe, prompt=none) renewal:
// the page CSP doesn't allow framing the Salesforce origin (see the
// helmet frame-src config in server.js), and Salesforce sets
// X-Frame-Options on its OAuth pages, so an iframe renewal can never
// complete in this deployment. It only added a multi-second dead-weight
// wait before the reauth UI appeared. The interceptor now goes straight
// to reauth.

(function () {
	'use strict';

	if (typeof window === 'undefined' || !window.fetch) {
return;
}
	if (window.__sfFetchInstalled) {
return;
}
	window.__sfFetchInstalled = true;

	const REAUTH_URL = '/auth/login';

	const _originalFetch = window.fetch.bind(window);

	// "Keep working offline" is a per-tab decision, but some flows reload
	// the page (e.g. removing a Salesforce connection ends with a
	// location.reload()). A plain window flag is lost on reload, so the
	// next boot's eager /api/* calls would 401/409 and re-pop the reauth
	// modal, re-asking a question the user already answered. Persist the
	// choice in sessionStorage (tab-scoped, cleared when the tab closes:
	// exactly the lifetime offline mode is meant to have) and restore it on
	// install. Cleared the moment the user chooses to reconnect.
	const _OFFLINE_KEY = 'orgloom:sfOfflineMode';
	function _persistOffline() {
		try {
			window.sessionStorage.setItem(_OFFLINE_KEY, '1');
		} catch (_) {}
	}
	function _clearOfflinePersistence() {
		try {
			window.sessionStorage.removeItem(_OFFLINE_KEY);
		} catch (_) {}
	}
	try {
		if (window.sessionStorage.getItem(_OFFLINE_KEY) === '1') {
			window.__sfOfflineMode = true;
		}
	} catch (_) {}

	// Read the CSRF token once at install: it stays valid for the
	// lifetime of the cookie pair, so caching it here is fine. If a
	// future page-load mints a new pair, that page's fresh meta tag
	// supersedes the old value.
	const _csrfMeta = document.querySelector('meta[name="csrf-token"]');
	const _csrfToken = _csrfMeta ? _csrfMeta.getAttribute('content') || '' : '';

	// Decide if a request is same-origin and unsafe (POST/PUT/PATCH/DELETE).
	// Cross-origin fetches (e.g. to Salesforce APIs directly) MUST NOT
	// receive our token: it leaks our secret to a third party.
	function _shouldStampCsrf(input, init) {
		if (!_csrfToken) {
return false;
}
		const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
		if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
return false;
}
		let url;
		try {
			const raw = typeof input === 'string' ? input : (input && input.url) || '';
			url = new URL(raw, window.location.origin);
		} catch (_) {
 return false; 
}
		return url.origin === window.location.origin;
	}

	// Always surface the interactive modal: never auto-redirect. We only
	// reach here when the user HAD an SF connection that died (the
	// never-connected case short-circuits earlier on
	// ORGLOOM_SF_CONNECTED===false), so the modal (which offers
	// sign-in / switch-org / keep-working-offline) is the right surface:
	// the user decides what happens next instead of being yanked to the
	// Salesforce sign-in page mid-task. (Navigation to /auth/login still
	// happens, but only when the user explicitly clicks "Sign in again" /
	// "Sign in to a different org" in the modal below.)
	//
	// On a genuine cold boot the page may still be parsing (readyState
	// 'loading'), where popping a modal over a half-rendered page (or
	// before document.body exists) looks broken. So in that case we defer
	// the modal to DOMContentLoaded rather than redirecting. By the time
	// app.js fires its first /api/* call, readyState is almost always
	// 'interactive' or 'complete', so the modal shows immediately.
	function _handleReauthNeeded() {
		if (window.__sfReauthPromptOpen) {
return;
}
		if (window.__sfOfflineMode) {
return;
}
		// Claim the prompt slot up front so concurrent boot 401s/409s can't
		// stack multiple modals through the deferred path below.
		try {
 window.__sfReauthPromptOpen = true;
} catch (_) {}
		if (document.readyState === 'loading') {
			document.addEventListener('DOMContentLoaded', _showReauthPromptModal, { once: true });
			return;
		}
		_showReauthPromptModal();
	}

	function _showReauthPromptModal() {
		try {
 window.__sfReauthPromptOpen = true; 
} catch (_) {}
		const ret = encodeURIComponent(window.location.pathname + window.location.search);
		const signInUrl = REAUTH_URL + '?return=' + ret;
		const overlay = document.createElement('div');
		overlay.className = 'modal sf-reauth-prompt';
		overlay.innerHTML =
			'<div class="modal-overlay"></div>' +
			'<div class="modal-body" style="max-width:520px">' +
				'<div class="modal-header">' +
					'<h3>Your Salesforce session ended</h3>' +
				'</div>' +
				'<div class="modal-content">' +
					'<p>Your access token expired. Pick how to continue: the canvas itself stays usable in every option.</p>' +
					'<div class="sf-reauth-options">' +
						'<button type="button" class="sf-reauth-card sf-reauth-card--primary" data-rap-action="signin">' +
							'<span class="sf-reauth-card-title">Sign in again</span>' +
							'<span class="sf-reauth-card-desc">Reconnect to your current Salesforce org and resume what you were doing.</span>' +
						'</button>' +
						'<button type="button" class="sf-reauth-card" data-rap-action="switch">' +
							'<span class="sf-reauth-card-title">Sign in to a different org</span>' +
							'<span class="sf-reauth-card-desc">Switch to a different Salesforce connection.</span>' +
						'</button>' +
						'<button type="button" class="sf-reauth-card" data-rap-action="offline">' +
							'<span class="sf-reauth-card-title">Keep working offline</span>' +
							'<span class="sf-reauth-card-desc">Keep editing the canvas without reconnecting. Salesforce-touching actions (Browse, Upload, etc.) will prompt you when you try them.</span>' +
						'</button>' +
					'</div>' +
				'</div>' +
			'</div>';
		document.body.appendChild(overlay);
		const cleanup = () => {
			try {
 overlay.remove(); 
} catch (_) {}
			try {
 window.__sfReauthPromptOpen = false; 
} catch (_) {}
		};
		overlay.querySelector('[data-rap-action="signin"]').addEventListener('click', () => {
			cleanup();
			// Reconnecting: drop any persisted offline choice so the
			// post-OAuth return load doesn't come back in offline mode.
			_clearOfflinePersistence();
			try {
 window.__sfRedirectingToReauth = true; 
} catch (_) {}
			window.location.assign(signInUrl);
		});
		overlay.querySelector('[data-rap-action="switch"]').addEventListener('click', () => {
			cleanup();
			// Reconnecting to a different org: drop the persisted offline
			// choice so we don't return in offline mode after OAuth.
			_clearOfflinePersistence();
			// Prefer the in-app connections modal so the user picks
			// from their saved org list without leaving the canvas.
			// Falls back to /auth/login (which routes to whatever org
			// is in session.sfLoginUrl, then surfaces the SF picker
			// for cross-identity flows) if the modal hasn't mounted.
			if (window.Orgloom && window.Orgloom.sfConnectionsModal && typeof window.Orgloom.sfConnectionsModal.open === 'function') {
				try {
 window.Orgloom.sfConnectionsModal.open(); return; 
} catch (_) {}
			}
			try {
 window.__sfRedirectingToReauth = true; 
} catch (_) {}
			window.location.assign(REAUTH_URL);
		});
		overlay.querySelector('[data-rap-action="offline"]').addEventListener('click', () => {
			cleanup();
			// Persist offline choice for the rest of this page session.
			// Future /api/* 401s + 409s will return-as-is to callers
			// rather than re-prompting (the offline-check at the top
			// of patchedFetch + the early returns in
			// _handleReauthNeeded both honor this flag).
			try {
 window.__sfOfflineMode = true; 
} catch (_) {}
			// Persist to sessionStorage so a page reload (e.g. removing a
			// Salesforce connection ends in location.reload()) keeps the
			// offline choice instead of re-popping this modal on the next
			// SF-touching request.
			_persistOffline();
			// Let other components (SF chip, etc.) react so the UI
			// reflects the disconnected state.
			try {
 document.dispatchEvent(new CustomEvent('orgloom:sf-offline'));
} catch (_) {}
			// Reflect offline on the SF chip and turn it into the reconnect
			// affordance (see _markChipOffline + the chip click handler below).
			_markChipOffline();
		});
	}

	async function _isExpiredSfResponse(res) {
		if (!res || res.status !== 401) {
return false;
}
		// Only read the body if we have a JSON content-type: avoids
		// consuming the body of non-JSON 401s and breaking callers.
		const ct = res.headers && res.headers.get && res.headers.get('content-type');
		if (!ct || ct.indexOf('application/json') === -1) {
return false;
}
		try {
			const clone = res.clone();
			const data = await clone.json();
			return data && data.error === 'sf-session-expired';
		} catch (_) {
			return false;
		}
	}

	// 409 no-active-connection means the request reached requireSfConnection
	// but the session lost its sfAuth entirely (server restart with in-memory
	// session store, session regeneration that didn't carry sfAuth forward,
	// etc.). Silent renewal can't recover this: there's no token to refresh
	// from. Bounce straight to the interactive re-auth flow so the user gets
	// a working session back, instead of staring at empty pickers because
	// the chip is still showing "active" based on DB state alone.
	async function _isMissingConnectionResponse(res) {
		if (!res || res.status !== 409) {
return false;
}
		const ct = res.headers && res.headers.get && res.headers.get('content-type');
		if (!ct || ct.indexOf('application/json') === -1) {
return false;
}
		try {
			const clone = res.clone();
			const data = await clone.json();
			return data && data.error === 'no-active-connection';
		} catch (_) {
			return false;
		}
	}

	async function _isMissingOrgloomPermissionSetResponse(res) {
		if (!res || res.status !== 403) {
			return false;
		}
		const ct = res.headers && res.headers.get && res.headers.get('content-type');
		if (!ct || ct.indexOf('application/json') === -1) {
			return false;
		}
		try {
			const data = await res.clone().json();
			return data && data.error === 'orgloom-permission-set-required';
		} catch (_) {
			return false;
		}
	}

	// Merge X-CSRF-Token into a fetch init object without mutating the
	// caller's input. Returns a new init object: the caller may pass
	// either nothing, a plain object, or a Headers instance.
	function _stampCsrfHeader(init) {
		const next = { ...(init || {}) };
		const h = new Headers(next.headers || {});
		if (!h.has('x-csrf-token')) {
h.set('x-csrf-token', _csrfToken);
}
		next.headers = h;
		return next;
	}

	// --- Offline-mode reconnect affordance ------------------------------
	// "Keep working offline" suppresses the reauth modal for the rest of the
	// tab, and the SF chip in the top strip stays server-rendered as
	// "connected", leaving no surface to get back online. Reflect offline on
	// the chip and make clicking it the reconnect path: drop the offline
	// choice and re-open the reauth modal, whose "Sign in again" reconnects to
	// the previously active org.
	function _markChipOffline() {
		try {
			const chip = document.getElementById('app-sf-chip');
			if (!chip) {
				return;
			}
			chip.classList.add('app-sf-chip--disconnected');
			chip.classList.add('app-sf-chip--offline');
			const label = chip.querySelector('.app-sf-chip-label');
			if (label) {
				label.textContent = 'Reconnect';
			}
			chip.setAttribute('title', 'Working offline: click to reconnect to Salesforce');
		} catch (_) {}
	}

	// Capture phase so we intercept before any SaaS-side chip handler (the
	// connections modal) and fully own the offline → reconnect transition.
	document.addEventListener('click', function (e) {
		if (!window.__sfOfflineMode) {
			return;
		}
		const chip = (e.target && e.target.closest) ? e.target.closest('#app-sf-chip') : null;
		if (!chip) {
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		if (e.stopImmediatePropagation) {
			e.stopImmediatePropagation();
		}
		// Leaving offline mode so the reauth modal isn't short-circuited and a
		// successful reconnect doesn't return offline after OAuth.
		try {
			window.__sfOfflineMode = false;
		} catch (_) {}
		_clearOfflinePersistence();
		_handleReauthNeeded();
	}, true);

	// Boot restore: __sfOfflineMode may have been rehydrated from
	// sessionStorage after a reload while the chip was server-rendered as
	// connected; reflect offline on the chip so the reconnect path is visible.
	if (window.__sfOfflineMode) {
		if (document.readyState === 'loading') {
			document.addEventListener('DOMContentLoaded', _markChipOffline, { once: true });
		} else {
			_markChipOffline();
		}
	}

	window.fetch = async function patchedFetch(input, init) {
		const initWithCsrf = _shouldStampCsrf(input, init) ? _stampCsrfHeader(init) : init;
		const res = await _originalFetch(input, initWithCsrf);
		// A Salesforce admin can revoke the packaged permission set while this
		// tab remains open. Mutating API routes recheck immediately and return
		// this discriminated 403. Route to the same assignment guidance used by
		// OAuth instead of leaving Upload/Save to surface an unrelated error.
		if (await _isMissingOrgloomPermissionSetResponse(res)) {
			if (!window.__orgloomPermsetRedirecting) {
				window.__orgloomPermsetRedirecting = true;
				window.location.assign('/permset-required');
			}
			return res;
		}
		// Offline-mode short-circuit. If the user picked "Keep working
		// offline" on a prior 401/409, every subsequent SF-touching
		// request returns the error response to its caller without
		// re-prompting. The caller surfaces its own per-action prompt
		// (Upload, Browse, etc.) when the user attempts the action.
		if (window.__sfOfflineMode) {
return res;
}
		// 409 no-active-connection: the session lost its access token
		// entirely. Bounce straight to the interactive sign-in flow.
		// Exception: a fresh-signup user who never had an SF connection
		// (ORGLOOM_SF_CONNECTED=false at page render time) should land
		// on the canvas / canvas-gate, NOT get yanked into SF OAuth
		// before they see anything. Eager /api/* calls from app.js
		// (e.g. /api/objects, /api/me/capabilities) 409 for these users
		// ; that's expected, not a session-lost condition.
		if (await _isMissingConnectionResponse(res)) {
			if (window.ORGLOOM_SF_CONNECTED === false) {
return res;
}
			_handleReauthNeeded();
			return res;
		}
		if (!(await _isExpiredSfResponse(res))) {
return res;
}

		// Fresh-signup / no-SF-yet visitor: let the caller's catch
		// handler surface its own "connect Salesforce" affordance rather
		// than popping the reauth UI before they've seen anything.
		if (window.ORGLOOM_SF_CONNECTED === false) {
return res;
}

		// Expired SF session for a connected user: surface the reauth UI
		// immediately. There is no silent renewal (see file header):
		// the access token can't be refreshed without re-authenticating.
		_handleReauthNeeded();
		// Return the original response so any awaiting caller gets a
		// concrete value rather than a hang while the navigation happens.
		return res;
	};
})();
