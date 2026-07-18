(function () {
	'use strict';
	if (typeof window.Sentry === 'undefined') {
		return;
	}
	if (!window.ORGLOOM_SENTRY_DSN) {
		return;
	}

	function scrubEvent(event) {
		if (event.request && typeof event.request.url === 'string') {
			var i = event.request.url.indexOf('?');
			if (i >= 0) {
				event.request.url = event.request.url.slice(0, i);
			}
		}
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
		replaysSessionSampleRate: 0,
		replaysOnErrorSampleRate: 0,
		beforeSend: scrubEvent,
		beforeBreadcrumb: function (b) {
			if (b && (b.category === 'fetch' || b.category === 'xhr')) {
				return null;
			}
			if (b && b.category === 'ui.click') {
				return null;
			}
			return b;
		},
	});

	if (window.ORGLOOM_ACCOUNT_ID_HASH) {
		window.Sentry.setUser({ id: 'acct:' + window.ORGLOOM_ACCOUNT_ID_HASH });
	}
})();
