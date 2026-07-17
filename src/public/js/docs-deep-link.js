// Open the <details> element targeted by the URL hash on page load, so
// a deep link like /docs/walkthroughs#getting-started lands on the
// section AND expands it (instead of scrolling to a collapsed header).
// Used by docs/walkthroughs/index.ejs.
(function () {
	function openTarget() {
		var hash = location.hash ? location.hash.slice(1) : '';
		if (!hash) {
return;
}
		var el = document.getElementById(hash);
		if (!el || el.tagName !== 'DETAILS') {
return;
}
		el.open = true;
		// Re-scroll after the layout shift caused by opening the details
		// so the section title sits at the top of the viewport rather
		// than partway up.
		setTimeout(function () {
			try {
 el.scrollIntoView({ block: 'start' }); 
} catch (_) {}
		}, 0);
	}
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', openTarget);
	} else {
		openTarget();
	}
	window.addEventListener('hashchange', openTarget);
})();
