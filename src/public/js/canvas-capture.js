// Browser-side error-reporting helper. Mirrors the server-side
// `ext.captureException(err, context)` shape so canvas browser code has
// one canonical call for "best-effort operation failed, swallow it but
// tell ops". Loaded AFTER sentry-init.js so window.Sentry (when present)
// is already initialized.
//
// Usage from any canvas browser script:
//
//   try {
//       riskyThing();
//   } catch (err) {
//       window.ORGLOOM_capture(err, { where: 'app.js/handleClick', recId });
//       // ...safe fallback...
//   }
//
// Behavior:
//   - When @sentry/browser is loaded and initialized → Sentry.captureException
//     with `source: 'canvas'` tag and the supplied context as `extra`.
//   - When Sentry is absent (CDN blocked, DSN unset, dev mode) → console.warn
//     so the failure still lands in the browser console.
//   - Never throws. The whole point is to be safe to call from inside
//     a catch block without nesting another try/catch around it.
(function () {
	'use strict';

	function safeWarn(err, context) {
		try {
			var msg = (err && (err.stack || err.message)) || String(err);
			console.warn('[canvas] ' + msg, context || '');
		} catch (_) { /* console itself failed; nothing more to do */ }
	}

	window.ORGLOOM_capture = function (err, context) {
		// Always warn: even when Sentry is wired, the console line is
		// useful for dev / Render-log debugging and Sentry treats it as
		// a breadcrumb anyway.
		safeWarn(err, context);
		if (window.Sentry && typeof window.Sentry.captureException === 'function') {
			try {
				window.Sentry.captureException(err, {
					tags: { source: 'canvas' },
					extra: context || {},
				});
			} catch (_) { /* Sentry call failed; console.warn above is the fallback */ }
		}
	};
})();
