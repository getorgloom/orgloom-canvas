// Find-object popover.
//
// Small floating panel used in 4+ places to let the user pick an
// SObject from the org's catalog. The records-canvas + schema views
// pass their own onPick + isAdded so the same popover can drop a
// free type-node on the records canvas OR mutate the schema's
// selectedObjects list. Defaults preserve the original schema-mode
// behaviour.
//
// Dependencies passed to mount():
//   canvasState: shared canvas state. The popover reads
//                           allObjects + _allObjectsError for the list
//                           and selectedObjects for the "added" badge.
//   escapeHtml: HTML-escape helper.
//   showBulkToast: error toast when onPick rejects.
//   addToSelection: async; default onPick when the caller
//                           doesn't override.
//   renderAll: repaint helper called after the default
//                           onPick mutates selectedObjects.
//
// Public API (returned from mount):
//   showFindObjectPopover(triggerEl, opts): opens the popover.
//
// Exposed as window.OrgLoom.findObjectPopover. Load order: before app.js.

(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.findObjectPopover = {
		mount: function mount(deps) {
			if (!deps || !deps.canvasState || !deps.escapeHtml || !deps.showBulkToast
				|| !deps.addToSelection || !deps.renderAll) {
				throw new Error('find-object-popover.mount: missing required deps');
			}
			const canvasState = deps.canvasState;
			const escapeHtml = deps.escapeHtml;
			const showBulkToast = deps.showBulkToast;
			const addToSelection = deps.addToSelection;
			const renderAll = deps.renderAll;

			// Cleanup fn for the currently-open popover. Re-opening (from a
			// different trigger, or via type-node's own element removal) must
			// run this so the previous instance's 200ms refresh interval and
			// capture-phase document listeners are torn down; otherwise they
			// leak against a detached node until the next stray mousedown.
			let _activeCleanup = null;

			function showFindObjectPopover(triggerEl, opts) {
				opts = opts || {};
				// Pluggable behavior. Defaults preserve the original
				// schema-mode use; the records canvas passes its own
				// onPick + isAdded so the same popover can drop a free
				// type-node on the records canvas instead of mutating
				// canvasState.selectedObjects.
				const onPick = opts.onPick || (async (name) => {
					await addToSelection(name);
					renderAll();
				});
				const isAdded = opts.isAdded || ((name) => canvasState.selectedObjects.some((s) => s.name === name));
				const headerText = opts.header || 'Find an object';
				const subText = opts.sub || 'Adds any object to the schema, related or not. Use this to pick standalone objects alongside your FK-driven selections.';
				// Fully tear down any prior instance (interval + listeners),
				// not just its DOM node, before opening a new one.
				if (_activeCleanup) {
					try {
 _activeCleanup(); 
} catch (_) { /* already gone */ }
				}
				document.querySelectorAll('.find-object-popup').forEach(el => el.remove());
				const pop = document.createElement('div');
				pop.className = 'find-object-popup';
				const rect = triggerEl.getBoundingClientRect();
				const viewportW = window.innerWidth;
				const viewportH = window.innerHeight;
				// Width clamped to viewport so the popup doesn't overflow
				// horizontally on narrow phones (iPhone SE is 320px).
				// Desktop keeps the original 360px target.
				const width = Math.min(360, viewportW - 16);
				const left = Math.min(rect.left, viewportW - width - 8);
				pop.style.left = Math.max(8, left) + 'px';
				pop.style.width = width + 'px';
				// Tentatively place below the trigger; we measure after
				// content mounts (below) and flip above if there isn't
				// enough room. Set `top: 0` first so getBoundingClientRect
				// returns the popover's own rendered height accurately.
				pop.style.top = '0px';
				pop.innerHTML =
					'<div class="fop-header">' + escapeHtml(headerText) + '</div>' +
					'<div class="fop-sub">' + escapeHtml(subText) + '</div>' +
					'<input type="search" class="fop-search" id="fop-search" placeholder="Filter by label or API name\u2026" autocomplete="off">' +
					'<div class="fop-filter-row">' +
						'<div class="segmented fop-types" id="fop-types">' +
							'<button type="button" data-fop-type="all" class="active">All</button>' +
							'<button type="button" data-fop-type="standard">Standard</button>' +
							'<button type="button" data-fop-type="custom">Custom</button>' +
						'</div>' +
					'</div>' +
					// Seed the list with a "Loading…" sentinel so the user
					// never sees an empty box if renderList's first call
					// fails (a defensive guard against future regressions:
					// the box was observed empty when allObjects was still
					// null and the initial render path didn't paint). The
					// poll below will replace this once the boot fetch
					// finishes and renderList writes the real list.
					'<div class="fop-list" id="fop-list"><div class="fop-empty">Loading objects…</div></div>';
				// The list intentionally renders at most 60 rows for browser
				// responsiveness. Disclose that cap so users in large orgs know
				// to search rather than assuming later objects are absent.
				pop.insertAdjacentHTML('beforeend', '<div class="fop-sub" id="fop-summary" role="status" aria-live="polite"></div>');
				document.body.appendChild(pop);
				// Vertical placement: prefer below the trigger, but flip
				// above if the popover would clip the viewport bottom.
				// Use the CSS-declared max-height (min(70vh, 540px)) as
				// the expected size - measuring `pop` directly here
				// underestimates because the object list hasn't rendered
				// yet (renderList runs after this), and re-measuring
				// after renderList would create a visible flicker.
				{
					// Estimate total rendered height = max-height (content
					// box) + ~22px for vertical padding and border.
					// Underestimating here causes the popover to overlap
					// the trigger when placed above. Must match the CSS
					// `max-height: min(70vh, 480px)` declaration.
					const popH = Math.min(480, viewportH * 0.7) + 22;
					const gap = 12;
					// Above placements get extra breathing room (the
					// trigger's button styling has shadow/hover state
					// that visually crowds a tight gap) and a horizontal
					// nudge so the popover doesn't sit directly over the
					// trigger column - easier to scan when the user has
					// to look up to find it.
					const aboveExtraGap = 12;
					const aboveExtraLeft = 100;
					const below = rect.bottom + gap;
					const fitsBelow = below + popH <= viewportH - 8;
					const above = rect.top - gap - aboveExtraGap - popH;
					const fitsAbove = above >= 8;
					let top;
					if (fitsBelow) {
top = below;
} else if (fitsAbove) {
top = above;
} else {
top = Math.max(8, viewportH - popH - 8);
}
					pop.style.top = top + 'px';
					if (!fitsBelow && fitsAbove) {
						const shifted = Math.min(rect.left + aboveExtraLeft, viewportW - width - 8);
						pop.style.left = Math.max(8, shifted) + 'px';
					}
				}
			
				let typeFilter = 'all';
				const search = pop.querySelector('#fop-search');
				const list = pop.querySelector('#fop-list');
				const summary = pop.querySelector('#fop-summary');

				const renderList = () => {
					const q = (search.value || '').toLowerCase().trim();
					const all = Array.isArray(canvasState.allObjects) ? canvasState.allObjects : [];
					const matchesType = (o) => {
						if (typeFilter === 'standard' && o.custom) {
return false;
}
						if (typeFilter === 'custom' && !o.custom) {
return false;
}
						return true;
					};
					const matchesQuery = (o) => {
						if (!q) {
return true;
}
						return (o.name && o.name.toLowerCase().includes(q)) ||
							(o.label && o.label.toLowerCase().includes(q));
					};
					const filtered = all.filter((o) => matchesType(o) && matchesQuery(o));
					const capped = filtered.slice(0, 60);
					if (canvasState.allObjects === null) {
						list.innerHTML = '<div class="fop-empty">Loading objects\u2026</div>';
						if (summary) {
summary.textContent = '';
}
						return;
					}
					// `canvasState.allObjects === []` is ambiguous - it could be a
					// genuine empty catalog OR a load failure that the
					// boot fetch swallowed. `canvasState._allObjectsError` is the
					// disambiguator. Render an error+retry instead of
					// the misleading "No matching objects" empty state.
					if (canvasState.allObjects.length === 0 && canvasState._allObjectsError) {
						var errMsg = (canvasState._allObjectsError.status === 409 || canvasState._allObjectsError.bodyError === 'no-active-connection')
							? 'Salesforce session lost - reconnect from the SF chip above.'
							: 'Couldn\u2019t load the Salesforce schema. Refresh to try again.';
						list.innerHTML = '<div class="fop-empty">' + errMsg + '</div>';
						return;
					}
					if (capped.length === 0) {
						list.innerHTML = '<div class="fop-empty">No matching objects.</div>';
					} else {
						list.innerHTML = capped.map((o) => {
							// `already` (caller-controlled isAdded) drives the
							// DISABLED state - used by the add-to-schema flow
							// where re-adding is a no-op. `onCanvas` is an
							// independent INFORMATIONAL marker so flows that
							// allow re-picking (Create blank / Load existing,
							// which pass isAdded:()=>false to stay clickable
							// for the multi-instance pattern, SB-006) still
							// show an "\u00b7 added" badge for objects already on
							// the canvas. Marked-but-clickable items are NOT
							// disabled.
							const already = isAdded(o.name);
							const onCanvas = canvasState.selectedObjects.some((s) => s.name === o.name);
							const marked = already || onCanvas;
							const tag = (o.custom ? 'Custom' : 'Standard') + (o.queryable ? '' : ' \u00b7 not queryable');
							return '<button type="button" class="fop-item' + (already ? ' is-already' : '') + '" data-fop-pick="' + escapeHtml(o.name) + '"' + (already ? ' disabled title="Already on the canvas"' : (onCanvas ? ' title="Already on the canvas - pick again to add another"' : '')) + '>' +
								'<span class="fop-label">' + escapeHtml(o.label) + '</span>' +
								'<span class="fop-name">' + escapeHtml(o.name) + '</span>' +
								'<span class="fop-tag">' + tag + (marked ? ' \u00b7 added' : '') + '</span>' +
							'</button>';
						}).join('');
					}
					if (summary) {
						summary.textContent = filtered.length > capped.length
							? 'Showing ' + capped.length + ' of ' + filtered.length + ' matching objects. Search to find the rest.'
							: 'Showing ' + capped.length + ' of ' + all.length + ' objects.';
					}
				};
			
				renderList();
				setTimeout(() => search.focus(), 0);

				// Re-render on canvasState.allObjects changes. The boot
				// fetch (csrfFetch('/api/objects')) populates allObjects
				// asynchronously; if the user clicks Create blank /
				// Load existing BEFORE that fetch resolves, the popover
				// would otherwise stay frozen on its first render. Poll
				// every 200ms - cheap, no event hooks needed, naturally
				// recovers if the boot fetch fires after popup-open.
				let _lastSnap = canvasState.allObjects;
				const _refreshTimer = setInterval(() => {
					if (canvasState.allObjects !== _lastSnap) {
						_lastSnap = canvasState.allObjects;
						renderList();
					}
				}, 200);

				search.addEventListener('input', renderList);
				pop.querySelectorAll('[data-fop-type]').forEach((btn) => {
					btn.addEventListener('click', () => {
						typeFilter = btn.dataset.fopType;
						pop.querySelectorAll('[data-fop-type]').forEach((b) => b.classList.toggle('active', b.dataset.fopType === typeFilter));
						renderList();
					});
				});
				list.addEventListener('click', async (ev) => {
					const btn = ev.target.closest('[data-fop-pick]');
					if (!btn || btn.disabled) {
return;
}
					const name = btn.dataset.fopPick;
					cleanup();
					try {
						await onPick(name);
					} catch (err) {
						showBulkToast('Failed to add ' + name + ': ' + (err.message || err), 'error');
					}
				});
			
				const cleanup = () => {
					if (pop.parentNode) {
pop.remove();
}
					document.removeEventListener('mousedown', outside, true);
					document.removeEventListener('keydown', onEsc, true);
					clearInterval(_refreshTimer);
					if (_activeCleanup === cleanup) {
						_activeCleanup = null;
					}
				};
				_activeCleanup = cleanup;
				const outside = (ev) => {
 if (!pop.contains(ev.target) && ev.target !== triggerEl) {
cleanup();
} 
};
				const onEsc = (ev) => {
 if (ev.key === 'Escape') {
cleanup();
} 
};
				setTimeout(() => {
					document.addEventListener('mousedown', outside, true);
					document.addEventListener('keydown', onEsc, true);
				}, 0);
			}

			return {
				showFindObjectPopover: showFindObjectPopover,
			};
		},
	};
})();
