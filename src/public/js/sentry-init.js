// Browser-side Sentry init. Loaded BEFORE app.js (see index.ejs) so
// boot-time errors in the canvas IIFE get captured. Skips silently
// when ORGLOOM_SENTRY_DSN isn't stamped on window (dev / self-host /
// dormant deploy).
//
// Privacy posture mirrors the server-side init in apps/saas/src/lib/
// sentry.js; the regex scrubbers must stay in lockstep with that file
// so events from either tier scrub the same shapes. Don't add new
// regex shapes here without adding them server-side too.
(function () {
	'use strict';
	if (typeof window.Sentry === 'undefined') {
		// SDK bundle didn't load (CDN unreachable, blocked, etc.).
		// Don't throw; the app should still boot.
		return;
	}
	if (!window.ORGLOOM_SENTRY_DSN) {
return;
}

	function scrubEvent(event) {
		// Drop the query string from event.request.url, same reasoning
		// as the server: workspaceId, openCanvas=<id>, etc. live there.
		if (event.request && typeof event.request.url === 'string') {
			var i = event.request.url.indexOf('?');
			if (i >= 0) {
event.request.url = event.request.url.slice(0, i);
}
		}
		// Arbitrary Salesforce/browser errors may contain business values.
		// Keep exception type + stack frames, but remove free-form text.
		if (event.message) {
event.message = '<redacted-error-message>';
}
		if (event.extra) {
event.extra = {};
}
		if (event.breadcrumbs) {
			event.breadcrumbs.forEach(function (b) {
				if (b && typeof b.message === 'string') {
b.message = '<redacted-breadcrumb>';
}
				// As on the server, drop the breadcrumb data bag wholesale.
				if (b && b.data) {
b.data = {};
}
			});
		}
		if (event.exception && event.exception.values) {
			event.exception.values.forEach(function (ex) {
				if (ex && typeof ex.value === 'string') {
ex.value = '<redacted-error-message>';
}
			});
		}
		return event;
	}

	window.Sentry.init({
		dsn: window.ORGLOOM_SENTRY_DSN,
		environment: window.ORGLOOM_ENV || 'production',
		release: window.ORGLOOM_RELEASE || undefined,
		tracesSampleRate: 0.1,
		// Session Replay records the DOM. For an app that displays
		// Salesforce record values, every replay would contain customer
		// data. Off, hard.
		replaysSessionSampleRate: 0,
		replaysOnErrorSampleRate: 0,
		beforeSend: scrubEvent,
		beforeBreadcrumb: function (b) {
			// fetch/xhr crumbs carry URL paths with record ids. The
			// resulting error reports already capture the request shape
			// via the SDK's http integration; crumbs are noise.
			if (b && (b.category === 'fetch' || b.category === 'xhr')) {
return null;
}
			// UI click crumbs include element text, including record titles.
			// Drop them because regex cannot identify arbitrary business data.
			if (b && b.category === 'ui.click') {
return null;
}
			return b;
		},
	});

	// Server stamps ORGLOOM_ACCOUNT_ID_HASH on window for signed-in
	// requests (see index.ejs). Anonymous pages stay anonymous in
	// Sentry; no synthetic id assigned.
	if (window.ORGLOOM_ACCOUNT_ID_HASH) {
		window.Sentry.setUser({ id: 'acct:' + window.ORGLOOM_ACCOUNT_ID_HASH });
	}
})();
