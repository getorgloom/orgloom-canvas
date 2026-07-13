(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.supportModals = {
		mount: function mount(deps) {
			if (!deps || !deps.escapeHtml || !deps.csrfFetch
				|| typeof deps.relatedHardThreshold !== 'number'
				|| typeof deps.relatedBulkLoadCap !== 'number') {
				throw new Error('support-modals.mount: missing required deps');
			}
			const escapeHtml = deps.escapeHtml;
			const csrfFetch = deps.csrfFetch;
			const _RELATED_HARD_THRESHOLD = deps.relatedHardThreshold;
			const _RELATED_BULK_LOAD_CAP = deps.relatedBulkLoadCap;

			const promptModal = document.createElement('div');
			promptModal.className = 'modal hidden';
			promptModal.innerHTML =
				'<div class="modal-overlay" data-prompt-close></div>' +
				'<div class="modal-body" style="max-width:460px">' +
					'<div class="modal-header">' +
						'<h3 id="prompt-modal-title">Name this schema</h3>' +
						'<button class="modal-close" data-prompt-close>&times;</button>' +
					'</div>' +
					'<div class="modal-content">' +
						'<div class="field">' +
							'<label for="prompt-modal-input" id="prompt-modal-label">Schema name</label>' +
							'<input type="text" id="prompt-modal-input" autocomplete="off">' +
							'<div class="help" id="prompt-modal-help" style="display:none"></div>' +
						'</div>' +
					'</div>' +
					'<div class="modal-footer">' +
						'<button class="button secondary" data-prompt-close>Cancel</button>' +
						'<button class="button" id="prompt-modal-submit">Save</button>' +
					'</div>' +
				'</div>';
			document.body.appendChild(promptModal);
			let promptResolver = null;
			function closePromptModal(value) {
				if (promptModal.classList.contains('hidden')) {
return;
}
				promptModal.classList.add('hidden');
				if (promptResolver) {
					const r = promptResolver;
					promptResolver = null;
					r(value == null ? null : value);
				}
			}
			promptModal.querySelectorAll('[data-prompt-close]').forEach(el => el.addEventListener('click', () => closePromptModal(null)));
			promptModal.querySelector('#prompt-modal-submit').addEventListener('click', () => {
				const v = promptModal.querySelector('#prompt-modal-input').value.trim();
				if (!v) {
return;
}
				closePromptModal(v);
			});
			promptModal.querySelector('#prompt-modal-input').addEventListener('keydown', (e) => {
				if (e.key === 'Enter') {
					e.preventDefault();
					promptModal.querySelector('#prompt-modal-submit').click();
				} else if (e.key === 'Escape') {
					closePromptModal(null);
				}
			});

			function showPromptModal({ title, label, placeholder, defaultValue, submitText, helpText } = {}) {
				promptModal.querySelector('#prompt-modal-title').textContent = title || 'Enter a value';
				promptModal.querySelector('#prompt-modal-label').textContent = label || 'Value';
				promptModal.querySelector('#prompt-modal-submit').textContent = submitText || 'Save';
				const help = promptModal.querySelector('#prompt-modal-help');
				if (helpText) {
 help.textContent = helpText; help.style.display = ''; 
} else {
 help.textContent = ''; help.style.display = 'none'; 
}
				const input = promptModal.querySelector('#prompt-modal-input');
				input.value = defaultValue || '';
				input.placeholder = placeholder || '';
				promptModal.classList.remove('hidden');
				setTimeout(() => {
 input.focus(); input.select(); 
}, 0);
				return new Promise((resolve) => {
 promptResolver = resolve; 
});
			}

			function showReplaceOrMergeDialog(info) {
				return new Promise((resolve) => {
					const overlay = document.createElement('div');
					overlay.className = 'modal';
					const summaryLines = (info && Array.isArray(info.summaryLines)) ? info.summaryLines : [];
					const summaryHtml = summaryLines.length
						? '<div class="rom-file-summary" style="margin:0 0 0.8em; padding:0.6em 0.8em; border:1px solid var(--line, #444); border-radius:6px; font-size:0.86rem; line-height:1.5; color: var(--ink-soft);">' +
							summaryLines.map((l) => '<div>' + escapeHtml(l) + '</div>').join('') +
						'</div>'
						: '';
					overlay.innerHTML =
						'<div class="modal-overlay" data-rom="cancel"></div>' +
						'<div class="modal-body" style="max-width:480px">' +
							'<div class="modal-header">' +
								'<h3>Replace or merge?</h3>' +
								'<button class="modal-close" data-rom="cancel">&times;</button>' +
							'</div>' +
							'<div class="modal-content">' +
								summaryHtml +
								'<p>You already have records on the canvas. Loading this file can either start fresh or add to what’s here.</p>' +
								'<ul style="margin:0.5em 0 0 1.2em; color: var(--ink-soft); font-size: 0.88rem; line-height: 1.5;">' +
									'<li><strong>Replace canvas</strong>: drop everything currently on the canvas, then load the file.</li>' +
									'<li><strong>Merge</strong>: keep existing records and add the file’s records alongside.</li>' +
								'</ul>' +
							'</div>' +
							'<div class="modal-footer">' +
								'<button class="button secondary" data-rom="cancel">Cancel</button>' +
								'<button class="button secondary" data-rom="merge">Merge</button>' +
								'<button class="button" data-rom="replace">Replace canvas</button>' +
							'</div>' +
						'</div>';
					document.body.appendChild(overlay);
					const cleanup = () => {
 if (overlay.parentNode) {
overlay.remove();
} 
};
					overlay.querySelectorAll('[data-rom]').forEach((el) => {
						el.addEventListener('click', () => {
							const mode = el.dataset.rom;
							cleanup();
							resolve(mode);
						});
					});
					const onEsc = (e) => {
						if (e.key === 'Escape') {
							document.removeEventListener('keydown', onEsc, true);
							cleanup();
							resolve('cancel');
						}
					};
					document.addEventListener('keydown', onEsc, true);
				});
			}

			function showLargeRelatedConfirm({ targetLabel, count, hostLabel }) {
				return new Promise((resolve) => {
					const overlay = document.createElement('div');
					overlay.className = 'modal';
					const aboveHard = count > _RELATED_HARD_THRESHOLD;
					const willLoad = Math.min(count, _RELATED_BULK_LOAD_CAP);
					const truncates = willLoad < count;
					const fmtCount = count.toLocaleString();
					const fmtWill = willLoad.toLocaleString();
					const loadBtnLabel = truncates
						? 'Load first ' + fmtWill
						: 'Load all ' + fmtWill;
					overlay.innerHTML =
						'<div class="modal-overlay" data-lr="cancel"></div>' +
						'<div class="modal-body" style="max-width:520px">' +
							'<div class="modal-header">' +
								'<h3>That’s a lot of records</h3>' +
								'<button class="modal-close" data-lr="cancel">&times;</button>' +
							'</div>' +
							'<div class="modal-content">' +
								'<p>' + escapeHtml(hostLabel || 'This record') +
									' has <strong>' + fmtCount + '</strong> related <strong>' + escapeHtml(targetLabel) + '</strong> record' +
									(count === 1 ? '' : 's') + '.</p>' +
								(aboveHard
									? '<p>That’s too many to load onto the canvas at once: the renderer would slow to a crawl. Use search to pull specific records instead.</p>'
									: '<p>Loading them all at once will slow the canvas and make bulk edits hard to review. You can:</p>' +
									  '<ul style="margin:0.4em 0 0 1.2em; color: var(--ink-soft); font-size: 0.88rem; line-height: 1.55;">' +
										'<li><strong>' + escapeHtml(loadBtnLabel) + '</strong>: ' +
											(truncates
												? 'pulls the first ' + fmtWill + ' (server caps each load at ' + _RELATED_BULK_LOAD_CAP.toLocaleString() + ').'
												: 'pulls every record at once.') +
										'</li>' +
										'<li><strong>Search</strong>: pick specific records by name and add them one at a time.</li>' +
									  '</ul>') +
							'</div>' +
							'<div class="modal-footer">' +
								'<button class="button secondary" data-lr="cancel">Cancel</button>' +
								'<button class="button secondary" data-lr="search">Search</button>' +
								(aboveHard
									? ''
									: '<button class="button" data-lr="load">' + escapeHtml(loadBtnLabel) + '</button>') +
							'</div>' +
						'</div>';
					document.body.appendChild(overlay);
					const cleanup = () => {
						document.removeEventListener('keydown', onEsc, true);
						if (overlay.parentNode) {
overlay.remove();
}
					};
					overlay.querySelectorAll('[data-lr]').forEach((el) => {
						el.addEventListener('click', () => {
 cleanup(); resolve(el.dataset.lr); 
});
					});
					const onEsc = (e) => {
 if (e.key === 'Escape') {
 cleanup(); resolve('cancel'); 
} 
};
					document.addEventListener('keydown', onEsc, true);
				});
			}

			function showRelatedSearchModal({ targetType, targetLabel, fkField, hostId, hostLabel, onPick }) {
				const overlay = document.createElement('div');
				overlay.className = 'modal';
				overlay.innerHTML =
					'<div class="modal-overlay" data-rs="close"></div>' +
					'<div class="modal-body" style="max-width:540px">' +
						'<div class="modal-header">' +
							'<h3>Search ' + escapeHtml(targetLabel) + ' under ' + escapeHtml(hostLabel || 'this record') + '</h3>' +
							'<button class="modal-close" data-rs="close">&times;</button>' +
						'</div>' +
						'<div class="modal-content">' +
							'<input type="search" id="rs-input" placeholder="Type to search by name…" autocomplete="off" autofocus>' +
							'<div class="rs-status" id="rs-status">Type at least 1 character.</div>' +
							'<div class="rs-results" id="rs-results"></div>' +
						'</div>' +
					'</div>';
				document.body.appendChild(overlay);
				const cleanup = () => {
					document.removeEventListener('keydown', onEsc, true);
					if (overlay.parentNode) {
overlay.remove();
}
				};
				const onEsc = (e) => {
 if (e.key === 'Escape') {
cleanup();
} 
};
				document.addEventListener('keydown', onEsc, true);
				overlay.querySelectorAll('[data-rs="close"]').forEach((el) => el.addEventListener('click', cleanup));
				const input = overlay.querySelector('#rs-input');
				const status = overlay.querySelector('#rs-status');
				const results = overlay.querySelector('#rs-results');
				let token = 0;
				let timer = null;
				const runSearch = async (q) => {
					const my = ++token;
					status.textContent = 'Searching…';
					results.innerHTML = '';
					try {
						const url = '/api/objects/' + encodeURIComponent(targetType)
							+ '/by-ref-search?field=' + encodeURIComponent(fkField)
							+ '&id=' + encodeURIComponent(hostId)
							+ '&q=' + encodeURIComponent(q);
						const r = await csrfFetch(url, { credentials: 'same-origin' });
						if (my !== token) {
return;
}
						const body = await r.json().catch(() => ({}));
						const rows = (body && body.records) || [];
						if (!r.ok) {
							status.textContent = body.error || 'Search failed.';
							return;
						}
						if (rows.length === 0) {
							status.textContent = 'No matches.';
							return;
						}
						status.textContent = rows.length + ' match' + (rows.length === 1 ? '' : 'es');
						results.innerHTML = rows.map((row) => (
							'<div class="rs-row">' +
								'<span class="rs-name">' + escapeHtml(row.name || '(no name)') + '</span>' +
								'<code class="rs-id">' + escapeHtml(row.id) + '</code>' +
								'<button class="button secondary rs-add" data-rs-add-id="' + escapeHtml(row.id) + '" data-rs-add-name="' + escapeHtml(row.name || '') + '">Add to canvas</button>' +
							'</div>'
						)).join('');
						results.querySelectorAll('[data-rs-add-id]').forEach((btn) => {
							btn.addEventListener('click', () => {
								const id = btn.dataset.rsAddId;
								const name = btn.dataset.rsAddName;
								btn.disabled = true;
								btn.textContent = 'Adding…';
								Promise.resolve(onPick({ id, name }))
									.then(() => {
 btn.textContent = 'Added'; 
})
									.catch(() => {
 btn.disabled = false; btn.textContent = 'Add to canvas'; 
});
							});
						});
					} catch (e) {
						if (my === token) {
status.textContent = 'Search failed: ' + (e.message || e);
}
					}
				};
				input.addEventListener('input', () => {
					clearTimeout(timer);
					const q = input.value.trim();
					if (!q) {
						token++;
						status.textContent = 'Type at least 1 character.';
						results.innerHTML = '';
						return;
					}
					timer = setTimeout(() => runSearch(q), 220);
				});
			}

			function showBulkSwitchWarning({ recordCount, reasons }) {
				return new Promise((resolve) => {
					const reasonsHtml = (reasons && reasons.length > 0)
						? '<ul class="bulk-switch-reasons">' +
							reasons.map((r) => '<li>' + escapeHtml(r) + '</li>').join('') +
						'</ul>'
						: '';
					const overlay = document.createElement('div');
					overlay.className = 'modal';
					overlay.innerHTML =
						'<div class="modal-overlay" data-bsw="cancel"></div>' +
						'<div class="modal-body" style="max-width:540px">' +
							'<div class="modal-header">' +
								'<h3>Switch to Bulk API?</h3>' +
								'<button class="modal-close" data-bsw="cancel">&times;</button>' +
							'</div>' +
							'<div class="modal-content">' +
								'<p>This upload of <strong>' + recordCount + ' record' + (recordCount === 1 ? '' : 's') + '</strong> is too large for the atomic Composite Graph API:</p>' +
								reasonsHtml +
								'<p style="margin-top:0.8em">Falling back to <strong>Bulk API v2</strong> means:</p>' +
								'<ul style="margin:0.4em 0 0 1.2em; color: var(--ink-soft); font-size: 0.88rem; line-height: 1.55;">' +
									'<li><strong>Not atomic</strong>: records commit independently. Some may succeed while others fail; there is no all-or-nothing rollback.</li>' +
									'<li><strong>Per-record errors</strong>: failures are reported individually so you can fix and retry just the failed rows.</li>' +
									'<li><strong>Separate API quota</strong>: Bulk requests are tracked against your org’s Bulk API limit, not the standard REST limit.</li>' +
									'<li><strong>Faster at scale</strong>: throughput climbs to ~1000 records/sec once jobs are running.</li>' +
								'</ul>' +
							'</div>' +
							'<div class="modal-footer">' +
								'<button class="button secondary" data-bsw="cancel">Cancel</button>' +
								'<button class="button" data-bsw="proceed">Continue with Bulk</button>' +
							'</div>' +
						'</div>';
					document.body.appendChild(overlay);
					const cleanup = () => {
						document.removeEventListener('keydown', onEsc, true);
						if (overlay.parentNode) {
overlay.remove();
}
					};
					overlay.querySelectorAll('[data-bsw]').forEach((el) => {
						el.addEventListener('click', () => {
							const mode = el.dataset.bsw;
							cleanup();
							resolve(mode === 'proceed');
						});
					});
					const onEsc = (e) => {
						if (e.key === 'Escape') {
 cleanup(); resolve(false); 
}
					};
					document.addEventListener('keydown', onEsc, true);
				});
			}

			return {
				showPromptModal: showPromptModal,
				showReplaceOrMergeDialog: showReplaceOrMergeDialog,
				showLargeRelatedConfirm: showLargeRelatedConfirm,
				showRelatedSearchModal: showRelatedSearchModal,
				showBulkSwitchWarning: showBulkSwitchWarning,
			};
		},
	};
})();
