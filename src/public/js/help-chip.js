
// Top-strip Help chip: unified "I need help" entry point. Replaces
// the standalone Docs nav link and the in-canvas "?" button.
//
// Dropdown items (rendered conditionally):
//   • Canvas shortcuts: only when window.Orgloom.canvasHelp is
//                           defined (set by app.js on the canvas page).
//   • Contact support: calls window.Orgloom.support.openSupportEmail
//                           when support.js is loaded (saas only); falls
//                           back to a plain mailto otherwise.
//   • Report a bug: same pattern with openBugReport / GitHub
//                           issues URL fallback.
//
// Lives in packages/canvas/src/public/js (not apps/saas) so it ships
// in both saas + canvas-standalone modes; the canvas-shortcuts row
// is the chip's most valuable affordance and only the canvas package
// owns it.

(function () {
	'use strict';

	const chip = document.getElementById('app-help-chip');
	if (!chip) {
return;
}

	function escHtml(s) {
		return String(s == null ? '' : s)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}

	let _menu = null;
	function _close() {
		if (_menu && _menu.parentNode) {
_menu.parentNode.removeChild(_menu);
}
		_menu = null;
		document.removeEventListener('mousedown', _outside, true);
		document.removeEventListener('keydown', _onKey, true);
	}
	function _outside(ev) {
		if (_menu && (_menu.contains(ev.target) || chip.contains(ev.target))) {
return;
}
		_close();
	}
	function _onKey(ev) {
		if (ev.key === 'Escape') {
_close();
}
	}

	function _open() {
		if (_menu) {
 _close(); return; 
}
		const onCanvas = location.pathname === '/' || location.pathname === '';
		const ctx = onCanvas ? 'canvas' : ('page ' + location.pathname);

		// Canvas shortcuts moved out of this dropdown; they now have a
		// dedicated `?`-key opener + a discreet bottom-right hint on the
		// canvas. See app.js (keydown handler) and the
		// .canvas-shortcut-hint pill.
		const items = [];
		// Primary: the in-app documentation hub (walkthroughs, how-do-I,
		// troubleshooting, security & architecture). This is the ONLY
		// top-strip path to /docs; the old standalone Docs nav link was
		// folded into this menu.
		items.push('<a class="app-help-item" href="/docs">' +
			'<span class="app-help-item-name">Guides &amp; docs</span>' +
		'</a>');
		items.push('<button type="button" class="app-help-item" data-help-support>' +
			'<span class="app-help-item-name">Contact support</span>' +
		'</button>');
		items.push('<button type="button" class="app-help-item" data-help-bug>' +
			'<span class="app-help-item-name">Report a bug</span>' +
		'</button>');

		_menu = document.createElement('div');
		_menu.className = 'app-help-menu';
		_menu.setAttribute('role', 'menu');
		_menu.innerHTML = items.join('');
		// Anchor to the chip; top-strip is position:fixed so absolute
		// positioning relative to viewport works. Right-align so the
		// menu doesn't spill off-screen.
		const rect = chip.getBoundingClientRect();
		_menu.style.position = 'fixed';
		_menu.style.top = (rect.bottom + 6) + 'px';
		_menu.style.right = (window.innerWidth - rect.right) + 'px';
		document.body.appendChild(_menu);

		const supportBtn = _menu.querySelector('[data-help-support]');
		if (supportBtn) {
			supportBtn.addEventListener('click', (ev) => {
				ev.stopPropagation();
				_close();
				if (window.Orgloom && window.Orgloom.support && window.Orgloom.support.openSupportEmail) {
					window.Orgloom.support.openSupportEmail({ topic: 'Support request from ' + ctx });
				} else {
					// canvas-standalone fallback: plain mailto with topic.
					const subj = encodeURIComponent('Org Loom support request from ' + ctx);
					window.open('mailto:support@orgloom.com?subject=' + subj, '_blank');
				}
			});
		}
		const bugBtn = _menu.querySelector('[data-help-bug]');
		if (bugBtn) {
			bugBtn.addEventListener('click', (ev) => {
				ev.stopPropagation();
				_close();
				if (window.Orgloom && window.Orgloom.support && window.Orgloom.support.openBugReport) {
					window.Orgloom.support.openBugReport({ topic: 'Bug report from ' + ctx });
				} else {
					window.open('https://github.com/getorgloom/orgloom-canvas/issues/new', '_blank');
				}
			});
		}

		// Defer listener install so the chip's own click that opened
		// the menu doesn't immediately fire the outside-click close.
		setTimeout(() => {
			document.addEventListener('mousedown', _outside, true);
			document.addEventListener('keydown', _onKey, true);
		}, 0);
	}

	chip.addEventListener('click', (ev) => {
		ev.preventDefault();
		_open();
	});
})();
