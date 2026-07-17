// Direct-share modal for saved canvases.
//
// Owns the "Share canvas" modal and its supporting pieces:
//
//   attachSfUserPicker(hostEl, {onPick, placeholder})
//     Generic SF user search popover. Used as the recipient field in
//     the share modal and as the "slot assignee" picker on bulk cards
//     (one external caller still in app.js).
//   openCanvasEmailLinkModal(canvasId, canvasTitle)
//     Renders the progressive share modal: recipient picker + role
//     select, followed by a concise access review and Share button that triggers
//     /api/canvas/:id/direct-share. Post-success view surfaces the
//     /?openCanvas=<id> URL so the sender can forward the link via
//     Slack / IM / whatever channel they prefer.
//   openCanvasShareManagementModal(canvasId, canvasTitle)
//     Lists current recipients and allows the owner to revoke access.
//
// Dependencies passed to mount():
//   canvasState: shared canvas state.
//   csrfFetch: fetch wrapper.
//   escapeHtml: for the modal body.
//   showBulkToast: error / success toast.
//   showConfirmDialog: confirm prompts inside the modal.
//   _hasCap: plan-cap check used to gate sharing.
//   _invalidateShareCountForCanvas: refreshes the toolbar's separate
//                                    Access shortcut after share changes.
//
// Public API (returned from mount):
//   openCanvasEmailLinkModal, openCanvasShareManagementModal,
//   attachSfUserPicker.
//
// Exposed as window.OrgLoom.canvasShare. Load order: before app.js.

(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.canvasShare = {
		mount: function mount(deps) {
			const required = [
				'canvasState', 'csrfFetch', 'escapeHtml',
				'showBulkToast', 'showConfirmDialog',
				'_hasCap', '_invalidateShareCountForCanvas',
			];
			if (!deps) {
throw new Error('canvas-share.mount: missing deps object');
}
			for (const k of required) {
				if (deps[k] === undefined || deps[k] === null) {
					throw new Error('canvas-share.mount: missing dep ' + k);
				}
			}
			const canvasState = deps.canvasState;
			const csrfFetch = deps.csrfFetch;
			const escapeHtml = deps.escapeHtml;
			const showBulkToast = deps.showBulkToast;
			const showConfirmDialog = deps.showConfirmDialog;
			const _hasCap = deps._hasCap;
			const _invalidateShareCountForCanvas = deps._invalidateShareCountForCanvas;

			function attachSfUserPicker(hostEl, { onPick, placeholder = 'Search by name, email, or username…' } = {}) {
				hostEl.classList.add('sf-user-picker');
				// type="search" + a non-credential name + the
				// password-manager opt-out attributes below tell
				// Bitwarden / 1Password / LastPass that this is a
				// search field, not a username/email login field, so
				// they leave the autofill UI off it. `autocomplete`
				// uses the named "off-like" value `search` (Chrome
				// ignores plain `off` on visible text inputs) plus
				// `webauthn` as a no-op signal to discourage passkey
				// prompts.
				hostEl.innerHTML =
					'<input type="search" name="sf-user-search" class="sf-user-picker-input" ' +
						'placeholder="' + escapeHtml(placeholder) + '" ' +
						'autocomplete="off" spellcheck="false" ' +
						'data-bwignore="true" data-1p-ignore data-lpignore="true" data-form-type="other">' +
					'<div class="sf-user-picker-results" hidden></div>' +
					'<div class="sf-user-picker-selected" hidden></div>';
				const input = hostEl.querySelector('.sf-user-picker-input');
				const results = hostEl.querySelector('.sf-user-picker-results');
				const selected = hostEl.querySelector('.sf-user-picker-selected');
			
				let _seq = 0;
				let _picked = null;
			
				async function runSearch(q) {
					const mySeq = ++_seq;
					results.hidden = false;
					results.innerHTML = '<div class="sf-user-picker-empty">Searching…</div>';
					try {
						const url = '/api/sf/users/search?limit=20' + (q ? '&q=' + encodeURIComponent(q) : '');
						const r = await csrfFetch(url, { credentials: 'same-origin' });
						if (mySeq !== _seq) {
return;
}
						const data = await r.json().catch(() => null);
						if (!r.ok) {
							results.innerHTML = '<div class="sf-user-picker-empty">' +
								escapeHtml((data && data.error) || ('HTTP ' + r.status)) +
							'</div>';
							return;
						}
						const users = (data && data.users) || [];
						if (users.length === 0) {
							results.innerHTML = '<div class="sf-user-picker-empty">No matching users in this Salesforce org. The recipient must be an active standard-license SF user with an Email on file.</div>';
							return;
						}
						results.innerHTML = users.map((u) => (
							'<button type="button" class="sf-user-picker-row" data-user-id="' + escapeHtml(u.id) + '">' +
								'<span class="sf-user-picker-name">' + escapeHtml(u.name || '(no name)') + '</span>' +
								'<span class="sf-user-picker-email">' + escapeHtml(u.email || '') + '</span>' +
								'<span class="sf-user-picker-username">' + escapeHtml(u.username || '') + '</span>' +
							'</button>'
						)).join('');
						results.querySelectorAll('.sf-user-picker-row').forEach((btn) => {
							btn.addEventListener('click', () => {
								const userId = btn.dataset.userId;
								const u = users.find((x) => x.id === userId);
								if (!u) {
return;
}
								pick(u);
							});
						});
					} catch (err) {
						if (mySeq !== _seq) {
return;
}
						results.innerHTML = '<div class="sf-user-picker-empty">Search failed: ' + escapeHtml(err.message || String(err)) + '</div>';
					}
				}
			
				function pick(u) {
					_picked = u;
					input.value = '';
					input.hidden = true;
					results.hidden = true;
					selected.hidden = false;
					selected.innerHTML =
						'<span class="sf-user-picker-selected-name">' + escapeHtml(u.name) + '</span>' +
						'<span class="sf-user-picker-selected-email">' + escapeHtml(u.email || '') + '</span>' +
						'<button type="button" class="sf-user-picker-clear" title="Pick a different user">×</button>';
					selected.querySelector('.sf-user-picker-clear').addEventListener('click', clear);
					if (typeof onPick === 'function') {
onPick(u);
}
				}
			
				function clear() {
					_picked = null;
					selected.hidden = true;
					selected.innerHTML = '';
					input.hidden = false;
					input.value = '';
					input.focus();
					runSearch('');
					if (typeof onPick === 'function') {
onPick(null);
}
				}
			
				let _debounce;
				input.addEventListener('input', () => {
					clearTimeout(_debounce);
					const q = input.value.trim();
					_debounce = setTimeout(() => runSearch(q), 220);
				});
				input.addEventListener('focus', (event) => {
					// The share modal focuses this field for keyboard users. Do not
					// immediately cover the role choices with an empty-query result
					// menu; open that menu only when the user actually focuses it.
					if (event.isTrusted && !_picked && results.innerHTML === '') {
runSearch('');
}
				});
				document.addEventListener('click', (ev) => {
					if (!hostEl.contains(ev.target)) {
results.hidden = true;
}
				});
			
				// Public API: get current selection, force clear externally.
				return {
					getPicked() {
 return _picked; 
},
					clear,
					focus() {
 if (input.hidden === false) {
input.focus();
} 
},
				};
			}
			
			// Direct-share modal. Sender picks a SF user from their
			// connected org via the typeahead picker, server resolves
			// the user's Email, grants access to the saved canvas, stores
			// the Org Loom role, and sends a notification. Sharing never
			// creates access grants for Salesforce business records; the
			// recipient continues to see and update those records only as
			// allowed by their existing Salesforce permissions.
			function openCanvasEmailLinkModal(canvasId, canvasTitle) {
				document.querySelectorAll('.canvas-share-modal').forEach((el) => el.remove());
				const modal = document.createElement('div');
				modal.className = 'modal canvas-share-modal';
				modal.innerHTML =
					'<div class="modal-overlay" data-cs-close></div>' +
					'<div class="modal-body" style="max-width:560px">' +
						'<div class="modal-header">' +
							'<h3>Share canvas - ' + escapeHtml(canvasTitle || 'this canvas') + '</h3>' +
							'<button class="modal-close" data-cs-close>&times;</button>' +
						'</div>' +
						'<div class="modal-content">' +
							'<p class="tag" id="cs-intro">This shares the canvas only. Salesforce record access stays unchanged.</p>' +
							'<div class="cs-field-label">Pick a teammate</div>' +
							'<div id="cs-link-picker"></div>' +
							'<div class="cs-field-label">Choose their canvas role</div>' +
							'<div class="cs-role-picker" role="radiogroup" aria-label="Recipient role">' +
								'<label class="cs-role-option">' +
									'<input type="radio" name="cs-role" value="viewer">' +
									'<span class="cs-role-name">Viewer</span>' +
									'<span class="cs-role-desc">Can open and explore the canvas, but cannot change anything.</span>' +
								'</label>' +
								'<label class="cs-role-option" id="cs-role-contributor-opt">' +
									'<input type="radio" name="cs-role" value="contributor">' +
									'<span class="cs-role-name">Contributor</span>' +
									'<span class="cs-role-desc">Fills assigned slots and submits changes back. Cannot edit the canvas itself.</span>' +
								'</label>' +
								'<label class="cs-role-option">' +
									'<input type="radio" name="cs-role" value="editor">' +
									'<span class="cs-role-name">Editor</span>' +
									'<span class="cs-role-desc">Co-authors the canvas. Can add records, mark slots, and save changes. Only the owner manages sharing.</span>' +
								'</label>' +
							'</div>' +
							'<section class="cs-share-review" id="cs-share-review" hidden>' +
								'<h4>Review access</h4>' +
								'<p class="cs-share-review-summary" id="cs-share-review-summary"></p>' +
								'<div class="cs-share-actions">' +
									'<button type="button" class="button" id="cs-link-send" disabled>Share with teammate</button>' +
									'<span class="tag" id="cs-link-msg" aria-live="polite"></span>' +
								'</div>' +
							'</section>' +
							// Share-result slot: after a successful share,
							// surfaces the canvas URL with a Copy button so
							// the sender can forward it via Slack/IM/email.
							'<div id="cs-share-result" style="display:none;margin-top:0.9em;padding:0.7em 0.85em;border:1px solid var(--border);border-radius:4px;background:var(--bg-elev)"></div>' +
							'</div>' +
						'<div class="modal-footer">' +
							'<button class="button secondary" data-cs-close>Close</button>' +
						'</div>' +
					'</div>';
				document.body.appendChild(modal);
			
				const cleanup = () => {
					modal.remove();
					document.removeEventListener('keydown', onKey);
					// After the modal closes, the active-share count
					// for this canvas may have changed (send / revoke).
					// Invalidate the cached count so the toolbar badge
					// re-fetches and reflects reality.
					_invalidateShareCountForCanvas(canvasId);
				};
				const onKey = (e) => {
 if (e.key === 'Escape') {
cleanup();
} 
};
				document.addEventListener('keydown', onKey);
				modal.querySelectorAll('[data-cs-close]').forEach((el) => el.addEventListener('click', cleanup));
			
				const sendBtnEl = modal.querySelector('#cs-link-send');
				const shareResultEl = modal.querySelector('#cs-share-result');
				const reviewEl = modal.querySelector('#cs-share-review');
				const reviewSummaryEl = modal.querySelector('#cs-share-review-summary');
				const roleInputs = Array.from(modal.querySelectorAll('input[name="cs-role"]'));
				let shareComplete = false;
				const selectedRole = () => {
					const checked = modal.querySelector('input[name="cs-role"]:checked');
					return checked ? checked.value : null;
				};
				const roleSummary = {
					viewer: 'can open and explore the canvas, but cannot change it.',
					contributor: 'can fill assigned fields and submit those values, but cannot otherwise edit the canvas.',
					editor: 'can add, edit, and remove canvas records and relationships, then save canvas changes.',
				};
				function updateShareReview() {
					const picked = picker.getPicked();
					const role = selectedRole();
					const ready = !!(picked && role);
					reviewEl.hidden = !ready;
					if (ready) {
						const who = picked.name || picked.email || 'This teammate';
						reviewSummaryEl.textContent = who + ' will be a ' + role + ' and ' + roleSummary[role];
					}
					sendBtnEl.disabled = !ready || shareComplete || !!window.ORGLOOM_MOCK;
				}
				const picker = attachSfUserPicker(modal.querySelector('#cs-link-picker'), {
					placeholder: 'Pick a teammate by name, email, or username…',
					onPick() {
						shareComplete = false;
						sendBtnEl.textContent = 'Share with teammate';
						shareResultEl.style.display = 'none';
						shareResultEl.innerHTML = '';
						updateShareReview();
					},
				});
				roleInputs.forEach((input) => input.addEventListener('change', () => {
					shareComplete = false;
					sendBtnEl.textContent = 'Share with teammate';
					shareResultEl.style.display = 'none';
					shareResultEl.innerHTML = '';
					updateShareReview();
				}));
				// Playground lock-down. The visitor can see the recipient and
				// role controls but can't
				// actually share. Demo banner above the role picker
				// frames the limitation up front; teammate input is
				// disabled; Share button is force-disabled and the
				// onPick callback is replaced with a no-op so it can't
				// be re-enabled. Mock handlers in mock-sf.js feed the
				// list+picker fetches so nothing surfaces as a
				// 'mock-not-implemented' error.
				if (window.ORGLOOM_MOCK) {
					const demoBanner = document.createElement('div');
					demoBanner.className = 'banner warn';
					demoBanner.style.cssText = 'margin:0 0 0.8em';
					demoBanner.innerHTML =
						'<strong>Demo mode.</strong> Sharing is disabled here: you can see what the share surface looks like, but no canvases or teammates are reachable. ' +
						'<a href="/signup?from=playground">Start a free trial</a> to share canvases with your real Salesforce teammates.';
					const intro = modal.querySelector('#cs-intro');
					if (intro && intro.parentNode) {
intro.parentNode.insertBefore(demoBanner, intro);
}
					const pickerInput = modal.querySelector('#cs-link-picker .sf-user-picker-input');
					if (pickerInput) {
						pickerInput.disabled = true;
						pickerInput.placeholder = 'Sign up to share with teammates';
						pickerInput.title = 'Disabled in demo mode';
					}
					sendBtnEl.disabled = true;
					sendBtnEl.title = 'Sharing is disabled in demo mode. Sign up to share canvases with your teammates.';
				}
			
			
				const msgEl = modal.querySelector('#cs-link-msg');
				async function sendLink() {
					// Playground hard stop. The button is disabled in
					// mock mode and the picker is locked, so this
					// shouldn't fire, but as defense-in-depth: no fetch
					// can reach /api/canvas/:id/direct-share from the
					// demo, regardless of how the click was triggered.
					if (window.ORGLOOM_MOCK) {
return;
}
					const picked = picker.getPicked();
					const role = selectedRole();
					if (!picked || !role) {
						msgEl.textContent = 'Pick a teammate and choose a role first.';
						msgEl.style.color = 'var(--danger)';
						return;
					}
					sendBtnEl.disabled = true;
					msgEl.textContent = 'Sending…';
					msgEl.style.color = '';
					try {
						const r = await csrfFetch('/api/canvas/' + encodeURIComponent(canvasId) + '/direct-share', {
							method: 'POST',
							credentials: 'same-origin',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({
								recipientSfUserId: picked.id,
								role,
							}),
						});
						const data = await r.json().catch(() => ({}));
						if (!r.ok) {
							if (r.status === 402) {
								msgEl.textContent = '';
								msgEl.style.color = 'var(--danger)';
								const msg = document.createElement('span');
								msg.textContent = (data && (data.message || data.error)) || 'Upgrade required.';
								const cta = document.createElement('a');
								cta.href = '/workspace/upgrade';
								cta.textContent = 'Upgrade to Pro →';
								cta.style.cssText = 'display:inline-block;margin-left:0.4em;font-weight:600';
								msgEl.appendChild(msg);
								msgEl.appendChild(cta);
								sendBtnEl.disabled = true;
								return;
							}
							throw new Error((data && (data.message || data.error)) || 'HTTP ' + r.status);
						}
						// Direct-share success: set the inline status
						// message, then populate the share-result slot
						// with the canvas URL for manual delivery.
						const r2 = data.recipient || {};
						const who = r2.name || r2.email || picked.email || picked.name || 'the recipient';
						let nextStep;
						if (data.emailDeliverFailed) {
							nextStep = 'Canvas access was granted, but the notification email failed to send. ' + who + ' can find the canvas in their Saved Canvases, or copy the link below.';
						} else if (data.updated) {
							nextStep = who + '\'s access updated to ' + (data.role || 'the new role') + '. Emailed them about the change.';
						} else if (r2.hasAccount && r2.hasConnection) {
							nextStep = who + ' has Org Loom + this Salesforce org connected, so they\'ll see the canvas immediately.';
						} else if (r2.hasAccount) {
							nextStep = who + ' has Org Loom but hasn\'t connected this Salesforce org yet. Emailed them with the next step.';
						} else {
							nextStep = who + ' isn\'t on Org Loom yet. Emailed them with sign-up + connect instructions.';
						}
						msgEl.textContent = nextStep;
						msgEl.style.color = 'var(--success)';
						shareComplete = true;
						sendBtnEl.textContent = 'Shared';
						// Surface the canvas URL with a Copy button so
						// the sender can forward via Slack/IM/wherever
						// in addition to the auto-email. The URL is
						// recipient-locked at the SF-side share level:
						// only the picked user can use it.
						if (shareResultEl) {
							const canvasUrl = window.location.origin + '/?openCanvas=' + encodeURIComponent(canvasId);
							shareResultEl.style.display = '';
							shareResultEl.innerHTML =
								'<div style="font-size:0.85rem;color:var(--ink);margin-bottom:0.35em">' +
									'<strong>Or send the link yourself</strong>' +
								'</div>' +
								'<div style="font-size:0.78rem;color:var(--ink-soft);margin-bottom:0.45em">' +
									escapeHtml(who) + ' will sign in with their Salesforce user to open it.' +
								'</div>' +
								'<div style="display:flex;gap:0.4em;align-items:center">' +
									'<input type="text" readonly value="' + escapeHtml(canvasUrl) + '" id="cs-share-url-input" style="flex:1;padding:0.4em;font-family:var(--font-mono);font-size:0.78rem;border:1px solid var(--border);border-radius:3px;background:var(--bg-inset);color:var(--ink)">' +
									'<button type="button" class="button" id="cs-share-url-copy">Copy</button>' +
								'</div>';
							const urlInput = shareResultEl.querySelector('#cs-share-url-input');
							const copyBtn = shareResultEl.querySelector('#cs-share-url-copy');
							urlInput.addEventListener('focus', () => urlInput.select());
							copyBtn.addEventListener('click', async () => {
								try {
									if (navigator.clipboard && navigator.clipboard.writeText) {
										await navigator.clipboard.writeText(canvasUrl);
									} else {
										urlInput.select();
										document.execCommand('copy');
									}
									copyBtn.textContent = 'Copied ✓';
									setTimeout(() => {
 copyBtn.textContent = 'Copy'; 
}, 1500);
								} catch (e) {
									copyBtn.textContent = 'Copy failed';
									console.warn('[canvas-share] clipboard write failed:', e);
								}
							});
						}
					} catch (err) {
						shareComplete = false;
						msgEl.textContent = err.message || String(err);
						msgEl.style.color = 'var(--danger)';
					} finally {
						updateShareReview();
					}
				}
				sendBtnEl.addEventListener('click', sendLink);

			
				// Free-tier read-only treatment. share-canvas is Pro+.
				// If the active workspace lacks the capability, render
				// the modal in a visibly locked state with an upfront
				// upgrade CTA, so the user learns the constraint
				// BEFORE filling out the form and hitting a 402 on
				// Send. Access management remains available in its separate
				// owner-only modal so existing grants can still be revoked. Server-
				// side POST /api/canvas/:id/direct-share is the source
				// of truth: this UI lock is defense-in-depth + UX
				// clarity, not a security boundary.
				if (!_hasCap('share-canvas')) {
					const contentEl = modal.querySelector('.modal-content');
					const upgradeBanner = document.createElement('div');
					upgradeBanner.className = 'banner error';
					upgradeBanner.style.cssText = 'margin-bottom:0.8em';
					upgradeBanner.innerHTML =
						'<strong>Sharing canvases is a Pro feature.</strong> ' +
						'Your current workspace is on the Free plan, so this form is read-only. ' +
						'Upgrade to share canvases with teammates. ' +
						'<a href="/workspace/upgrade" style="display:inline-block;margin-top:0.4em;font-weight:600">Upgrade to Pro &rarr;</a>' +
						' &middot; ' +
						'<a href="/pricing" target="_blank" rel="noopener">Compare plans</a>';
					contentEl.insertBefore(upgradeBanner, contentEl.firstChild);
					// Lock the editable invite surface.
					const lockTargets = [
						modal.querySelector('.cs-role-picker'),
						modal.querySelector('#cs-link-picker'),
					].filter(Boolean);
					lockTargets.forEach((el) => {
						el.style.pointerEvents = 'none';
						el.style.opacity = '0.5';
						el.querySelectorAll('input, button, textarea, select').forEach((c) => {
 c.disabled = true; 
});
					});
					// Replace the Send button with an Upgrade CTA in
					// the same slot. Remove the original (with its
					// sendLink listener) so the click can't fire
					// through and hit the 402 path anyway.
					const upgradeBtn = document.createElement('a');
					upgradeBtn.className = 'button';
					upgradeBtn.href = '/workspace/upgrade';
					upgradeBtn.textContent = 'Upgrade to Pro to share';
					sendBtnEl.replaceWith(upgradeBtn);
					// Suppress the live-region "Pick a teammate first."
					// message: it makes no sense in locked mode.
					const msgEl = modal.querySelector('#cs-link-msg');
					if (msgEl) {
msgEl.textContent = '';
}
				}
			
			}

			function openCanvasShareManagementModal(canvasId, canvasTitle) {
				document.querySelectorAll('.canvas-share-modal, .canvas-share-management-modal')
					.forEach((el) => el.remove());
				const modal = document.createElement('div');
				modal.className = 'modal canvas-share-management-modal';
				modal.innerHTML =
					'<div class="modal-overlay" data-csm-close></div>' +
					'<div class="modal-body" style="max-width:560px">' +
						'<div class="modal-header">' +
							'<h3>Manage canvas access</h3>' +
							'<button class="modal-close" data-csm-close>&times;</button>' +
						'</div>' +
						'<div class="modal-content">' +
							'<p class="tag">People who can open <strong>' + escapeHtml(canvasTitle || 'this canvas') + '</strong>.</p>' +
							'<div id="cs-manage-list"><div class="tag">Loading…</div></div>' +
						'</div>' +
						'<div class="modal-footer">' +
							'<button class="button" type="button" data-csm-share>Share with teammate</button>' +
							'<button class="button secondary" data-csm-close>Close</button>' +
						'</div>' +
					'</div>';
				document.body.appendChild(modal);

				const cleanup = () => {
					document.removeEventListener('keydown', onKey);
					if (modal.parentNode) {
						modal.remove();
					}
					_invalidateShareCountForCanvas(canvasId);
				};
				const onKey = (event) => {
					if (event.key === 'Escape') {
						cleanup();
					}
				};
				document.addEventListener('keydown', onKey);
				modal.querySelectorAll('[data-csm-close]').forEach((el) => el.addEventListener('click', cleanup));
				modal.querySelector('[data-csm-share]').addEventListener('click', () => {
					cleanup();
					openCanvasEmailLinkModal(canvasId, canvasTitle);
				});

				async function refreshList() {
					const listEl = modal.querySelector('#cs-manage-list');
					listEl.innerHTML = '<div class="tag">Loading…</div>';
					try {
						const response = await csrfFetch('/api/canvas/' + encodeURIComponent(canvasId) + '/share-links', { credentials: 'same-origin' });
						const data = await response.json().catch(() => null);
						if (!response.ok) {
							throw new Error(data && data.error || 'HTTP ' + response.status);
						}
						const directShares = (data && data.directShares) || [];
						if (directShares.length === 0) {
							listEl.innerHTML = '<div class="tag cs-manage-empty">No active shares. Only you can open this canvas.</div>';
							return;
						}
						listEl.innerHTML = directShares.map((share) => {
							const role = share.role || (share.accessLevel === 'Collaborator' ? 'editor' : 'viewer');
							const roleTagClass = role === 'editor' ? 'tpl-scope-tag--editor' : 'tpl-scope-tag--template';
							return '<div class="cs-link-row">' +
								'<div class="cs-link-person">' +
									'<div class="cs-link-person-line">' +
										'<span class="cs-link-person-name">' + escapeHtml(share.name || 'Salesforce user') + '</span>' +
										'<span class="tpl-scope-tag ' + roleTagClass + '">' + escapeHtml(role.toUpperCase()) + '</span>' +
									'</div>' +
									'<div class="tag cs-link-note">Can open this canvas. No expiration.</div>' +
								'</div>' +
								'<button type="button" class="button secondary cs-direct-revoke" data-sf-user-id="' + escapeHtml(share.sfUserId) + '">Revoke</button>' +
							'</div>';
						}).join('');
						listEl.querySelectorAll('.cs-direct-revoke').forEach((button) => {
							button.addEventListener('click', async () => {
								const sfUserId = button.dataset.sfUserId;
								if (!(await showConfirmDialog({
									title: 'Revoke canvas access?',
									message: 'This teammate will immediately lose access to the canvas. Their Salesforce record permissions will not change.',
									confirmLabel: 'Revoke',
									cancelLabel: 'Keep access',
									danger: true,
								}))) {
									return;
								}
								button.disabled = true;
								try {
									const response = await csrfFetch('/api/canvas/' + encodeURIComponent(canvasId) + '/direct-shares/' + encodeURIComponent(sfUserId), {
										method: 'DELETE',
										credentials: 'same-origin',
									});
									const body = await response.json().catch(() => ({}));
									if (!response.ok) {
										throw new Error(body && body.error || 'HTTP ' + response.status);
									}
									_invalidateShareCountForCanvas(canvasId);
									await refreshList();
								} catch (error) {
									button.disabled = false;
									showBulkToast('Revoke failed: ' + (error.message || error), 'error');
								}
							});
						});
					} catch (error) {
						listEl.innerHTML = '<div class="tag">Couldn’t load active shares: ' + escapeHtml(error.message || String(error)) + '</div>';
					}
				}

				refreshList();
			}
			

			return {
				attachSfUserPicker: attachSfUserPicker,
				openCanvasEmailLinkModal: openCanvasEmailLinkModal,
				openCanvasShareManagementModal: openCanvasShareManagementModal,
			};
		},
	};
})();
