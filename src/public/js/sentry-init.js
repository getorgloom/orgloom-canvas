








(function () {
	'use strict';
	if (typeof window.Sentry === 'undefined') {


		return;
	}
	if (!window.ORGLOOM_SENTRY_DSN) {
return;
}

	var SF_ID_RE = /\b0[0-9A-Za-z]{14}(?:[0-9A-Za-z]{3})?\b/g;
	var EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

	function scrubString(s) {
		if (typeof s !== 'string') {
return s;
}
		return s.replace(EMAIL_RE, '<email>').replace(SF_ID_RE, '<sfId>');
	}

	function scrubEvent(event) {


		if (event.request && typeof event.request.url === 'string') {
			var i = event.request.url.indexOf('?');
			if (i >= 0) {
event.request.url = event.request.url.slice(0, i);
}
		}
		if (event.message) {
event.message = scrubString(event.message);
}
		if (event.breadcrumbs) {
			event.breadcrumbs.forEach(function (b) {
				if (b && typeof b.message === 'string') {
b.message = scrubString(b.message);
}

				if (b && b.data) {
b.data = {};
}
			});
		}
		if (event.exception && event.exception.values) {
			event.exception.values.forEach(function (ex) {
				if (ex && typeof ex.value === 'string') {
ex.value = scrubString(ex.value);
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


			if (b && b.category === 'ui.click' && b.message) {
				b.message = scrubString(b.message);
			}
			return b;
		},
	});




	if (window.ORGLOOM_ACCOUNT_ID_HASH) {
		window.Sentry.setUser({ id: 'acct:' + window.ORGLOOM_ACCOUNT_ID_HASH });
	}
})();
