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
				input.addEventListener('focus', () => {
					if (!_picked && results.innerHTML === '') {
runSearch('');
}
				});
				document.addEventListener('click', (ev) => {
					if (!hostEl.contains(ev.target)) {
results.hidden = true;
}
				});

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

			function _shareDisclosureRecords() {
				const seen = new Set();
				const out = [];
				for (const rec of canvasState.bulkRecords) {
					if (!rec || rec.isTypeNode || rec.isPending) {
continue;
}
					if (!rec.loadedFromId || !rec.objectName) {
continue;
}
					if (seen.has(rec.loadedFromId)) {
continue;
}
					seen.add(rec.loadedFromId);
					const v = rec.values || {};
					const composedPerson = ((v.FirstName || '') + ' ' + (v.LastName || '')).trim();
					const objectLabel = rec.label || rec.objectName;

					const namedDisplay =
						v.Name
						|| (composedPerson || null)
						|| v.Subject
						|| v.CaseNumber
						|| v.Title
						|| null;
					const displayName = namedDisplay
						|| (objectLabel + ' record ' + String(rec.loadedFromId).slice(0, 6) + '…');
					out.push({
						recordId: rec.loadedFromId,
						objectLabel,
						displayName: String(displayName),
					});
				}
				return out;
			}

			function openCanvasEmailLinkModal(canvasId, canvasTitle) {
				document.querySelectorAll('.canvas-share-modal').forEach((el) => el.remove());

				const _disclosureRecords = _shareDisclosureRecords();
				const _disclosureItemsHtml = _disclosureRecords.length === 0
					? '<li class="cs-disclosure-empty">No underlying records on this canvas — only the canvas itself will be shared.</li>'
					: _disclosureRecords.map((r) =>
						'<li>' +
							'<span class="cs-disclosure-name">' + escapeHtml(r.displayName) + '</span> ' +
							'<span class="tag">' + escapeHtml(r.objectLabel) + '</span>' +
						'</li>'
					).join('');
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
							'<p class="tag" id="cs-intro">Pick a teammate from your Salesforce org. They’ll get an email notification, and the canvas appears in their Saved Canvases the next time they sign in to Org Loom with this Salesforce org connected.</p>' +
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
									'<input type="radio" name="cs-role" value="editor" checked>' +
									'<span class="cs-role-name">Editor</span>' +
									'<span class="cs-role-desc">Co-authors the canvas. Can add records, mark slots, and re-share.</span>' +
								'</label>' +
							'</div>' +
							'<div id="cs-link-picker" style="margin-top:0.8em"></div>' +
							'<div class="cs-disclosure" id="cs-disclosure">' +
								'<div class="cs-disclosure-head">' +
									'<strong>The recipient will get Read/Edit access to:</strong>' +
								'</div>' +
								'<ul class="cs-disclosure-list">' +
									'<li class="cs-disclosure-canvas">' +
										'<span class="cs-disclosure-name">' + escapeHtml(canvasTitle || 'this canvas') + '</span> ' +
										'<span class="tag">Canvas</span>' +
									'</li>' +
									_disclosureItemsHtml +
								'</ul>' +
								'<p class="cs-disclosure-foot">' +
									'You can revoke access at any time from the Active shares list below. The recipient views the canvas from the perspective of ' +
									'their Salesforce user. Any Salesforce data that they do not have access to will not appear on their shared view of the canvas.' +
								'</p>' +
							'</div>' +
							'<div style="display:flex;gap:0.5em;align-items:center;margin-top:0.8em">' +
								'<button type="button" class="button" id="cs-link-send" disabled>Share with teammate</button>' +
								'<span class="tag" id="cs-link-msg" aria-live="polite"></span>' +
							'</div>' +

							'<div id="cs-share-result" style="display:none;margin-top:0.9em;padding:0.7em 0.85em;border:1px solid var(--border);border-radius:4px;background:var(--bg-elev)"></div>' +
							'<h4 style="margin:1.2em 0 0.4em;font-size:0.92rem">Active shares</h4>' +
							'<div id="cs-link-list"><div class="tag">Loading…</div></div>' +
						'</div>' +
						'<div class="modal-footer">' +
							'<button class="button secondary" data-cs-close>Close</button>' +
						'</div>' +
					'</div>';
				document.body.appendChild(modal);

				const cleanup = () => {
					modal.remove();
					document.removeEventListener('keydown', onKey);

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
				const picker = attachSfUserPicker(modal.querySelector('#cs-link-picker'), {
					placeholder: 'Pick a teammate by name, email, or username…',
					onPick(user) {
						sendBtnEl.disabled = !user;
					},
				});

				if (window.ORGLOOM_MOCK) {
					const demoBanner = document.createElement('div');
					demoBanner.className = 'banner warn';
					demoBanner.style.cssText = 'margin:0 0 0.8em';
					demoBanner.innerHTML =
						'<strong>Demo mode.</strong> Sharing is disabled here — you can see what the share surface looks like, but no canvases or teammates are reachable. ' +
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

				async function refreshList() {
					const listEl = modal.querySelector('#cs-link-list');
					listEl.innerHTML = '<div class="tag">Loading…</div>';
					try {
						const r = await csrfFetch('/api/canvas/' + encodeURIComponent(canvasId) + '/share-links', { credentials: 'same-origin' });
						const data = await r.json().catch(() => null);
						if (!r.ok) {
throw new Error(data && data.error || 'HTTP ' + r.status);
}
						const shares = (data && data.shares) || [];
						const directShares = (data && data.directShares) || [];
						if (shares.length === 0 && directShares.length === 0) {
							listEl.innerHTML = '<div class="tag">No active shares. Pick a teammate above to share this canvas with them. <a href="/docs/walkthroughs/share-canvas" target="_blank" rel="noopener" class="empty-doclink">How sharing &amp; co-editing work &rarr;</a></div>';
							return;
						}

						const directHtml = directShares.map((d) => {

							const role = d.role || (d.accessLevel === 'Collaborator' ? 'editor' : 'viewer');
							const roleLabel = role.toUpperCase();
							const roleTagClass = role === 'editor' ? 'tpl-scope-tag--editor' : 'tpl-scope-tag--template';
							return '<div class="cs-link-row" style="display:flex;align-items:center;gap:0.4em;padding:0.4em 0.5em;border:1px solid var(--border-soft);border-radius:4px;margin-bottom:0.3em;flex-wrap:wrap">' +
								'<div style="flex:1;min-width:200px">' +
									'<div style="display:flex;align-items:center;gap:0.4em">' +
										'<span style="font-family:var(--font-mono);font-size:0.82rem">' + escapeHtml(d.name) + '</span>' +
										'<span class="tpl-scope-tag ' + roleTagClass + '" style="margin-left:0">' + roleLabel + '</span>' +
										'<span class="tag" style="font-size:0.7rem">direct</span>' +
									'</div>' +
									'<div class="tag" style="font-size:0.72rem">Salesforce share &mdash; no expiry. Visible in their Saved Canvases.</div>' +
								'</div>' +
								'<button type="button" class="button secondary cs-direct-revoke" data-sf-user-id="' + escapeHtml(d.sfUserId) + '" style="font-size:0.78rem;padding:0.25em 0.6em">Revoke</button>' +
							'</div>';
						}).join('');

						listEl.innerHTML = directHtml;
						listEl.querySelectorAll('.cs-direct-revoke').forEach((btn) => {
							btn.addEventListener('click', async () => {
								const sfUserId = btn.dataset.sfUserId;
								if (!(await showConfirmDialog({
									title: 'Revoke direct share?',
									message: 'The recipient will lose access to this canvas in their Saved Canvases immediately. To restore access later, you\'ll need to re-share.',
									confirmLabel: 'Revoke',
									cancelLabel: 'Keep share',
									danger: true,
								}))) {
return;
}
								btn.disabled = true;
								try {
									const dr = await csrfFetch('/api/canvas/' + encodeURIComponent(canvasId) + '/direct-shares/' + encodeURIComponent(sfUserId), {
										method: 'DELETE',
										credentials: 'same-origin',
									});
									const dd = await dr.json().catch(() => ({}));
									if (!dr.ok) {
throw new Error(dd && dd.error || 'HTTP ' + dr.status);
}
									refreshList();
								} catch (err) {
									btn.disabled = false;
									showBulkToast('Revoke failed: ' + (err.message || err), 'error');
								}
							});
						});
					} catch (err) {
						listEl.innerHTML = '<div class="tag">Couldn’t load active links: ' + escapeHtml(err.message || String(err)) + '</div>';
					}
				}

				const msgEl = modal.querySelector('#cs-link-msg');
				async function sendLink() {

					if (window.ORGLOOM_MOCK) {
return;
}
					const picked = picker.getPicked();
					if (!picked) {
						msgEl.textContent = 'Pick a teammate first.';
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
								role: (modal.querySelector('input[name="cs-role"]:checked') || {}).value || 'editor',
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

						const r2 = data.recipient || {};
						const who = r2.name || r2.email || picked.email || picked.name || 'the recipient';
						let nextStep;
						if (data.emailDeliverFailed) {
							nextStep = 'Salesforce access granted, but the notification email failed to send. ' + who + ' can find the canvas in their Saved Canvases — or copy the link below.';
						} else if (data.updated) {
							nextStep = who + '\'s access updated to ' + (data.role || 'the new role') + '. Emailed them about the change.';
						} else if (r2.hasAccount && r2.hasConnection) {
							nextStep = who + ' has Org Loom + this Salesforce org connected — they\'ll see the canvas immediately.';
						} else if (r2.hasAccount) {
							nextStep = who + ' has Org Loom but hasn\'t connected this Salesforce org yet. Emailed them with the next step.';
						} else {
							nextStep = who + ' isn\'t on Org Loom yet. Emailed them with sign-up + connect instructions.';
						}
						msgEl.textContent = nextStep;
						msgEl.style.color = 'var(--success)';

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

						if (data.recordAccess) {
							const note = document.createElement('div');
							note.style.cssText = 'margin-top:0.5em;font-size:0.82rem';
							if (data.recordAccess.failed && data.recordAccess.failed.length > 0) {
								const lines = data.recordAccess.failed.map((f) =>
									'<li><code>' + escapeHtml(f.objectName) + '</code> ' +
									'<code>' + escapeHtml(f.recordId) + '</code>: ' +
									escapeHtml(f.error) + '</li>'
								).join('');
								note.style.color = 'var(--warn)';
								note.innerHTML =
									'<div><strong>Manual sharing needed:</strong> ' +
										'Auto-shared ' + data.recordAccess.grantedCount + ' record' +
										(data.recordAccess.grantedCount === 1 ? '' : 's') +
										', but ' + data.recordAccess.failed.length + " couldn't be shared. " +
										'Ask your admin to share these with the recipient:</div>' +
									'<ul style="margin:0.4em 0 0 1.2em;font-family:var(--font-mono);font-size:0.78rem">' +
										lines +
									'</ul>';
							} else if (data.recordAccess.grantedCount > 0) {
								note.style.color = 'var(--ink-soft)';
								note.textContent = 'Also granted Salesforce access to ' +
									data.recordAccess.grantedCount + ' underlying record' +
									(data.recordAccess.grantedCount === 1 ? '' : 's') + '.';
							}
							if (note.innerHTML || note.textContent) {
msgEl.appendChild(note);
}
						}
						picker.clear();
						refreshList();
					} catch (err) {
						msgEl.textContent = err.message || String(err);
						msgEl.style.color = 'var(--danger)';
					} finally {
						sendBtnEl.disabled = !picker.getPicked();
					}
				}
				sendBtnEl.addEventListener('click', sendLink);

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

					const lockTargets = [
						modal.querySelector('.cs-role-picker'),
						modal.querySelector('#cs-link-picker'),
						modal.querySelector('#cs-disclosure'),
					].filter(Boolean);
					lockTargets.forEach((el) => {
						el.style.pointerEvents = 'none';
						el.style.opacity = '0.5';
						el.querySelectorAll('input, button, textarea, select').forEach((c) => {
 c.disabled = true; 
});
					});

					const upgradeBtn = document.createElement('a');
					upgradeBtn.className = 'button';
					upgradeBtn.href = '/workspace/upgrade';
					upgradeBtn.textContent = 'Upgrade to Pro to share';
					sendBtnEl.replaceWith(upgradeBtn);

					const msgEl = modal.querySelector('#cs-link-msg');
					if (msgEl) {
msgEl.textContent = '';
}
				}

				refreshList();
				setTimeout(() => picker.focus(), 0);
			}

			return {
				attachSfUserPicker: attachSfUserPicker,
				_shareDisclosureRecords: _shareDisclosureRecords,
				openCanvasEmailLinkModal: openCanvasEmailLinkModal,
			};
		},
	};
})();
