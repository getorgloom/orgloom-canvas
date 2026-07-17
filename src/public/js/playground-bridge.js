// Bridges the /playground demo to the real signup flow.
//
// Conversion is intent-only: clicking a sign-up CTA in the playground
// redirects the visitor to /signup, but their demo canvas state does
// NOT carry over into the real account. (Earlier versions transported
// state across via localStorage; that was removed because seeing the
// demo's mock records appear on a fresh real account is more
// surprising than helpful: fictional Acme accounts on day one.)
//
//   SEND (when window.ORGLOOM_MOCK === true), visitor is in the demo:
//     • Fires PostHog 'playground_started' on page load
//     • Fires 'playground_first_action' once canvasState has any records
//       (engagement signal, separating browsers from users)
//     • Intercepts the Save / Upload buttons with a "sign up to make
//       this real?" prompt (once per session per surface)
//     • Wires the sign-up CTAs to redirect to /signup?from=playground
//       (no state carried across)
//
//   RECEIVE (when window.ORGLOOM_MOCK is false), visitor just signed
//   up after using the demo:
//     • Clears any stale handoff payload left over from a previous
//       build's state-transport path so it can't be silently
//       restored on a future load. The toast + auto-restore are
//       gone; the receive side now exists only to evict that
//       legacy storage entry.
//
// Loaded on every canvas page render. The mode gates branch internally.

(function () {
	'use strict';

	const HANDOFF_KEY = 'orgloom.playground.handoff';
	// Canvas autosave writes under a scope-namespaced key
	// (`orgloom:canvas-draft:v1|<scope>`); this is just the prefix, used by
	// the record-count fallback to find whichever scoped entry exists.
	const AUTOSAVE_KEY_PREFIX = 'orgloom:canvas-draft:v1';
	const FIRST_ACTION_KEY = 'orgloom.playground.firstActionFired';
	// Per-surface "already nagged" flags. Each Save / Upload button gets
	// ONE conversion prompt per session; re-clicks go through silently
	// so the demo doesn't nag the same visitor on every save. AI gen is
	// different: it has no demo-mode equivalent (mock generation is
	// deliberately not wired), so EVERY submit click gets the prompt;
	// the user can't get past it inside the playground.
	const NAGGED_SAVE_KEY = 'orgloom.playground.naggedSave';
	const NAGGED_UPLOAD_KEY = 'orgloom.playground.naggedUpload';

	// ---- shared helpers -------------------------------------------------

	function capture(eventName, props) {
		// PostHog is loaded by top-strip.ejs. Guard the call so it
		// silently no-ops when analytics is disabled.
		try {
			if (window.posthog && window.posthog.capture) {
				window.posthog.capture(eventName, props || {});
			}
		} catch (_) {}
	}
	function referrerOrigin() {
		try {
			return document.referrer ? new URL(document.referrer).origin : '';
		} catch (_) {
			return '';
		}
	}

	function safeReadLocalStorage(key) {
		try {
 return window.localStorage.getItem(key); 
} catch (_) {
 return null; 
}
	}
	function safeWriteLocalStorage(key, value) {
		try {
 window.localStorage.setItem(key, value); 
} catch (_) {}
	}
	function safeRemoveLocalStorage(key) {
		try {
 window.localStorage.removeItem(key); 
} catch (_) {}
	}

	// ---- SEND side: playground → signup --------------------------------

	function installSendSide() {
		// Fire 'playground_started' immediately. This is the top of the
		// funnel: every /playground page load counts.
		capture('playground_started', {
			referrer_origin: referrerOrigin(),
			source: 'mock',
		});

		// Strong conversion gate. Fires once per surface (Save canvas
		// AND/OR Upload to Salesforce) on the visitor's FIRST click.
		// On dismiss, the action proceeds normally (mock save / mock
		// upload). On accept, we stash canvas state + redirect to
		// /signup so the visitor lands signed-in with their work
		// pre-loaded on the real canvas.
		//
		// The banner already explains "no data leaves your browser",
		// so this prompt is the second touch, not a surprise, just a
		// well-timed "you've built something, want to keep it?".
		document.addEventListener('click', (ev) => {
			const target = ev.target;
			if (!target || !target.closest) {
return;
}
			// AI generation: Generate button in the AI modal. There's
			// no demo equivalent: we deliberately do NOT route to the
			// programmatic mock generator (handleAiPlan in mock-sf.js)
			// because the value of AI here is real Claude planning, and
			// faking it would set the wrong expectation. Every click
			// gets the prompt; "Stay in demo" closes the AI modal too
			// so the visitor isn't left staring at a textarea that
			// can't do anything.
			const aiSubmitBtn = target.closest('#ai-gen-submit');
			if (aiSubmitBtn) {
				ev.preventDefault();
				ev.stopPropagation();
				showAiGenConversionPrompt();
				return;
			}
			// Save canvas: first click triggers prompt.
			const saveBtn = target.closest('[data-bulk-save]');
			if (saveBtn && !sessionFlag(NAGGED_SAVE_KEY)) {
				ev.preventDefault();
				ev.stopPropagation();
				setSessionFlag(NAGGED_SAVE_KEY);
				showConversionPrompt({
					kind: 'save',
					title: 'Save this canvas for real?',
					body: 'You’re in demo mode, so saved canvases only stick to this browser. Start a free trial to save them to your account and pick up where you left off on any device.',
					primary: 'Start free trial →',
					secondary: 'Save in demo only',
					captureEvent: 'playground_save_attempted',
					onProceed: () => clickThroughOriginal(saveBtn),
				});
				return;
			}
			// Upload to Salesforce: first click triggers prompt.
			const uploadBtn = target.closest('[data-bulk-upload]');
			if (uploadBtn && !sessionFlag(NAGGED_UPLOAD_KEY)) {
				ev.preventDefault();
				ev.stopPropagation();
				setSessionFlag(NAGGED_UPLOAD_KEY);
				showConversionPrompt({
					kind: 'upload',
					title: 'Push to a real Salesforce org?',
					body: 'You’re in demo mode, so uploads don’t reach a real org. Start a free trial to connect your Salesforce and ship these records for real.',
					primary: 'Sign up & connect SF →',
					secondary: 'Run demo upload',
					captureEvent: 'playground_upload_attempted',
					onProceed: () => clickThroughOriginal(uploadBtn),
				});
				return;
			}
			// Top-right Sign up CTA: always-visible conversion ask.
		// Current behavior is intent-only: no canvas state crosses into
		// the real account. The helper removes any legacy handoff first.
			const signupCta = target.closest('.app-playground-signup-cta');
			if (signupCta) {
				ev.preventDefault();
				capture('playground_signup_clicked', {
					source: 'top-strip',
					record_count: countCurrentRecords(),
				});
				stashHandoffAndRedirect();
				return;
			}
			// Legacy banner CTA (kept for the brief window where the
			// strong-CTA banner is still in use; new banner ships a
			// quieter "Sign in" link instead).
			const cta = target.closest('.app-playground-banner-cta');
			if (cta) {
				ev.preventDefault();
				capture('playground_save_attempted', { record_count: countCurrentRecords() });
				stashHandoffAndRedirect();
			}
		}, true);

		// Helpers scoped to this installer.
		function sessionFlag(key) {
			try {
 return !!window.sessionStorage.getItem(key); 
} catch (_) {
 return false; 
}
		}
		function setSessionFlag(key) {
			try {
 window.sessionStorage.setItem(key, '1'); 
} catch (_) {}
		}
		function clickThroughOriginal(el) {
			// Re-fire the same click without our handler intercepting
			// (the session flag is set so the closest() guard skips us).
			// MouseEvent is the universal trigger, works for buttons,
			// links, and div role=button targets.
			el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		}
		function stashHandoffAndRedirect() {
			// Intentionally no state transport. The demo canvas stays in
			// the demo browser; the visitor lands on a clean real
			// canvas after sign-up. Evict any stale handoff entry a
			// previous build wrote so it can't surprise a future
			// receive-side run.
			safeRemoveLocalStorage(HANDOFF_KEY);
			window.location.href = '/signup?from=playground';
		}
		function showConversionPrompt(opts) {
			capture(opts.captureEvent, { record_count: countCurrentRecords() });
			document.querySelectorAll('.playground-convert-modal').forEach((el) => el.remove());
			const modal = document.createElement('div');
			modal.className = 'modal playground-convert-modal';
			modal.innerHTML =
				'<div class="modal-overlay" data-pg-convert-close></div>' +
				'<div class="modal-body" style="max-width:520px">' +
					'<div class="modal-header">' +
						'<h3>' + escapeText(opts.title) + '</h3>' +
						'<button class="modal-close" data-pg-convert-close>&times;</button>' +
					'</div>' +
					'<div class="modal-content">' +
						'<p>' + escapeText(opts.body) + '</p>' +
					'</div>' +
					'<div class="modal-footer">' +
						'<button class="button secondary" data-pg-convert-cancel>' + escapeText(opts.secondary) + '</button>' +
						'<button class="button" data-pg-convert-go>' + escapeText(opts.primary) + '</button>' +
					'</div>' +
				'</div>';
			document.body.appendChild(modal);
			const close = () => {
				modal.remove();
				document.removeEventListener('keydown', onEsc);
			};
			const onEsc = (e) => {
 if (e.key === 'Escape') {
 close(); opts.onProceed(); 
} 
};
			document.addEventListener('keydown', onEsc);
			modal.querySelectorAll('[data-pg-convert-close], [data-pg-convert-cancel]').forEach((el) => {
				el.addEventListener('click', () => {
					close();
					opts.onProceed();
				});
			});
			modal.querySelector('[data-pg-convert-go]').addEventListener('click', () => {
				close();
				stashHandoffAndRedirect();
			});
		}
		function escapeText(s) {
			return String(s == null ? '' : s)
				.replace(/&/g, '&amp;')
				.replace(/</g, '&lt;')
				.replace(/>/g, '&gt;')
				.replace(/"/g, '&quot;');
		}

		// Dedicated conversion prompt for the AI Generate submit. Two
		// buttons: Sign up (redirect) and Close (closes both this
		// prompt AND the AI modal so the visitor isn't left at a
		// dead-end textarea). Records the scope size + prompt length
		// in the funnel event: strong signals of intent.
		function showAiGenConversionPrompt() {
			let scopeCount = 0;
			let promptLen = 0;
			try {
				const cbs = document.querySelectorAll('[data-ai-obj]:checked');
				scopeCount = cbs ? cbs.length : 0;
				const ta = document.getElementById('ai-gen-prompt');
				promptLen = ta ? (ta.value || '').length : 0;
			} catch (_) {}
			capture('playground_ai_gen_attempted', {
				scope_object_count: scopeCount,
				prompt_length: promptLen,
				record_count: countCurrentRecords(),
			});
			document.querySelectorAll('.playground-convert-modal').forEach((el) => el.remove());
			const modal = document.createElement('div');
			modal.className = 'modal playground-convert-modal';
			modal.innerHTML =
				'<div class="modal-overlay" data-pg-ai-close></div>' +
				'<div class="modal-body" style="max-width:520px">' +
					'<div class="modal-header">' +
						'<h3>Sign up to generate with Claude</h3>' +
						'<button class="modal-close" data-pg-ai-close>&times;</button>' +
					'</div>' +
					'<div class="modal-content">' +
						'<p>AI generation calls Claude with your selected schema, drafts records, and applies them to your canvas. The demo doesn’t include this feature. Start a free trial to run real generations against your own Salesforce org.</p>' +
					'</div>' +
					'<div class="modal-footer">' +
						'<button class="button secondary" data-pg-ai-close>Close</button>' +
						'<button class="button" data-pg-ai-go>Sign up free →</button>' +
					'</div>' +
				'</div>';
			document.body.appendChild(modal);
			const closeAiGenModalIfOpen = () => {
				// Mirror the close behavior of ai-generate.js's
				// closeAiGenModal (it adds .hidden to the modal). Find
				// it by structure rather than reaching across module
				// boundaries; keeps playground-bridge.js standalone.
				try {
					document.querySelectorAll('.modal').forEach((m) => {
						if (m === modal) {
return;
}
						if (m.querySelector('#ai-gen-content')) {
m.classList.add('hidden');
}
					});
				} catch (_) {}
			};
			const close = () => {
				modal.remove();
				document.removeEventListener('keydown', onEsc);
			};
			const onEsc = (e) => {
 if (e.key === 'Escape') {
 close(); closeAiGenModalIfOpen(); 
} 
};
			document.addEventListener('keydown', onEsc);
			modal.querySelectorAll('[data-pg-ai-close]').forEach((el) => {
				el.addEventListener('click', () => {
					close();
					closeAiGenModalIfOpen();
				});
			});
			modal.querySelector('[data-pg-ai-go]').addEventListener('click', () => {
				close();
				stashHandoffAndRedirect();
			});
		}

		// First-action poller. Watches canvasState for the first sign of
		// user engagement (any record added or loaded). Fires once per
		// session. The flag lives in sessionStorage so a reload of
		// /playground doesn't re-fire it, but a fresh tab does.
		const alreadyFired = (function () {
			try {
 return window.sessionStorage.getItem(FIRST_ACTION_KEY); 
} catch (_) {
 return null; 
}
		})();
		if (!alreadyFired) {
			const interval = setInterval(() => {
				if (countCurrentRecords() > 0) {
					capture('playground_first_action', {
						record_count: countCurrentRecords(),
					});
					try {
 window.sessionStorage.setItem(FIRST_ACTION_KEY, '1'); 
} catch (_) {}
					clearInterval(interval);
				}
			}, 1500);
			// Stop polling after 5 minutes regardless: visitors who
			// idle that long aren't going to convert from this signal.
			setTimeout(() => clearInterval(interval), 5 * 60 * 1000);
		}
	}


	function countCurrentRecords() {
		// canvasState exposes a snapshot helper on window.Orgloom.
		// Fall back to reading the autosave layer if the snapshot hook
		// isn't ready yet (early page-load window).
		try {
			if (window.Orgloom && window.Orgloom.canvasState && typeof window.Orgloom.canvasState.snapshot === 'function') {
				const s = window.Orgloom.canvasState.snapshot();
				const drafts = (s && s.payload && s.payload.drafts) || [];
				const loaded = (s && s.payload && s.payload.loadedRecords) || [];
				return drafts.length + loaded.length;
			}
		} catch (_) {}
		try {
			// The autosave key is scope-namespaced now, so scan for the
			// first matching entry rather than reading one fixed key.
			const ss = window.sessionStorage;
			let raw = null;
			for (let i = 0; i < ss.length; i++) {
				const k = ss.key(i);
				if (k && k.indexOf(AUTOSAVE_KEY_PREFIX) === 0) {
					raw = ss.getItem(k);
					break;
				}
			}
			if (!raw) {
return 0;
}
			const parsed = JSON.parse(raw);
			const list = (parsed && parsed.state && parsed.state.bulkRecords) || [];
			return list.length;
		} catch (_) {}
		return 0;
	}

	// ---- RECEIVE side: signup → real canvas ----------------------------

	// State transport removed. The receive side now exists only to evict
	// stale HANDOFF_KEY entries from a previous build's transport path,
	// so visitors whose browsers still hold one don't get any future
	// surprise behavior. No toast, no sessionStorage write, no PostHog
	// 'playground_signup_converted' event (the funnel ends at sign-up
	// click; see playground_signup_clicked).
	function installReceiveSide() {
		safeRemoveLocalStorage(HANDOFF_KEY);
	}

	// ---- entry point ----------------------------------------------------

	if (window.ORGLOOM_MOCK) {
		installSendSide();
	} else if (window.ORGLOOM_ACCOUNT_ID) {
		// Only signed-in users get the receive path. Anonymous visitors
		// hitting / shouldn't have stale handoff state cleared
		// out from under them (defense in depth: the SEND side
		// already stopped writing it).
		installReceiveSide();
	}
})();
