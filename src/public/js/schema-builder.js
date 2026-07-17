// Schema builder: cytoscape-backed schema canvas renderer.
//
// Mirrors the focused record's records-canvas component as a schema
// graph: one node per distinct object type in the component, one edge
// per FK relationship between those types. Renders only when exactly
// one record is selected; otherwise the canvas is blank.
//
// This module owns the cytoscape schema instance and ~600 lines of
// renderCanvas + supporting helpers + node/edge styling constants.
// It does NOT own the records canvas (renderBulkCanvasCy lives in
// app.js, since it shares the records-side cy lifecycle with marquee
// and clipboard handlers).
//
// Dependencies passed to mount():
//   canvasState: shared canvas state. renderCanvas
//                              reads selectedObjects, bulkRecords,
//                              bulkSelectedIds, hiddenObjects, plus
//                              the 6 schema-builder lets that
//                              migrated here in the Phase-4 prep.
//   escapeHtml: HTML-escape helper.
//   showBulkToast: error/info toast.
//   addToSelection: async; called by _spawnRecordFromSchemaObject
//                              and the schema-peer click path.
//   renderBulkView: repaint records canvas; triggered when
//                              spawning a record from a schema peer.
//   fetchGraphData: async; describe-graph fetch (lives in
//                              schema-graph module).
//   _canvasCapBlockReason: returns truthy message when canvas is
//                              at the record cap; spawn refuses.
//   cloneRecord: clone-record helper from app.js.
//   attachCyEdgeMarkers: SVG-overlay edge markers (crow-foot etc.).
//   attachCyMiddleClickPan: middle-button pan attach.
//   attachCyWheelZoom: wheel-zoom attach with the bulk
//                              user-zoom-override gate.
//   redrawCyEdgeMarkers: re-paint edge markers after layout.
//   SCHEMA_SYSTEM_FK_FIELDS: Set of audit FK field names (used by
//                              the system-fields filter on rings).
//   getGraph: returns .graph-overlay DOM element.
//   getCySchemaInstance: returns the current cy schema instance
//                              (or null). Wrapped because the let
//                              still lives in app.js; renderBulkCanvas
//                              also touches it via destroy() on view
//                              changes.
//   setCySchemaInstance: setter for the same let. renderCanvas
//                              assigns a fresh instance after rebuild.
//
// Public API (returned from mount):
//   renderCanvas(): full schema-canvas paint, called from ~19 places
//                    across app.js (every state-change repaint).
//   makeNode(...): schema-node DOM builder shared with the legacy
//                    SVG renderer that still lives in app.js.
//
// Exposed as window.OrgLoom.schemaBuilder. Load order: before app.js.

(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.schemaBuilder = {
		mount: function mount(deps) {
			if (!deps || !deps.canvasState || !deps.escapeHtml || !deps.showBulkToast
				|| !deps.addToSelection || !deps.renderBulkView || !deps.fetchGraphData
				|| !deps.ensureDescribe
				|| !deps._canvasCapBlockReason
				|| !deps.attachCyEdgeMarkers
				|| !deps.attachCyMiddleClickPan || !deps.attachCyWheelZoom
				|| !deps.redrawCyEdgeMarkers || !deps.SCHEMA_SYSTEM_FK_FIELDS
				|| !deps.getGraph || !deps.getCySchemaInstance || !deps.setCySchemaInstance) {
				throw new Error('schema-builder.mount: missing required deps');
			}
			const canvasState = deps.canvasState;
			const escapeHtml = deps.escapeHtml;
			const showBulkToast = deps.showBulkToast;
			const addToSelection = deps.addToSelection;
			const renderBulkView = deps.renderBulkView;
			const fetchGraphData = deps.fetchGraphData;
			const ensureDescribe = deps.ensureDescribe;
			// World-space scale factor for translating schema layout
			// distances into records-canvas coordinates when spawning.
			// Lives in app.js (records-canvas layout owns the value);
			// fall back to a sane default if the dep wasn't wired.
			const RECORDS_WORLD_SCALE = typeof deps.RECORDS_WORLD_SCALE === 'number' ? deps.RECORDS_WORLD_SCALE : 1.4;
			const _canvasCapBlockReason = deps._canvasCapBlockReason;
			// pushUndo (optional): schema-"+" spawns register a Ctrl+Z undo that
			// removes the spawned card + its links. Degrades gracefully if unwired.
			const pushUndo = deps.pushUndo;
			const attachCyEdgeMarkers = deps.attachCyEdgeMarkers;
			const attachCyMiddleClickPan = deps.attachCyMiddleClickPan;
			const attachCyWheelZoom = deps.attachCyWheelZoom;
			const redrawCyEdgeMarkers = deps.redrawCyEdgeMarkers;
			const SCHEMA_SYSTEM_FK_FIELDS = deps.SCHEMA_SYSTEM_FK_FIELDS;
			const getGraph = deps.getGraph;
			const getCySchemaInstance = deps.getCySchemaInstance;
			const setCySchemaInstance = deps.setCySchemaInstance;

			// ----- Schema builder (rebuilt) -----
			// Mirrors the focused record's records-canvas component as a
			// schema graph: one node per distinct object type in the
			// component, one edge per FK relationship between those
			// types. Renders only when exactly one record is selected;
			// otherwise the canvas is blank. The selected record's
			// object becomes the centered active node.
			
			const SCHEMA_NODE_W = 160;
			const SCHEMA_NODE_H = 68;
			// Expanded size: the cy node grows to this when a card is
			// expanded, so FK edges + the HTML overlay both terminate
			// on the larger bbox instead of the cy node sliding out
			// from under the overlay.
			const SCHEMA_NODE_W_EXPANDED = 280;
			const SCHEMA_NODE_H_EXPANDED = 360;
			const SCHEMA_SPAWN_BTN_SIZE = 22;
			// In-corner satellite placement: spawn at top-LEFT, expand at
			// top-RIGHT, both sitting FULLY INSIDE the card (inset a few px
			// from the top corners) rather than protruding over the edge. The
			// card is sized with enough headroom (SCHEMA_NODE_H) that the
			// top-corner buttons clear the centered title. The buttons are
			// always visible (no hover gate) and render as bare glyphs with
			// no circle/chrome, so the actions read immediately.
			const SCHEMA_SATELLITE_INSET = 4;
			const SCHEMA_SPAWN_OFFSET_X = -(SCHEMA_NODE_W / 2 - SCHEMA_SPAWN_BTN_SIZE / 2 - SCHEMA_SATELLITE_INSET);
			const SCHEMA_SPAWN_OFFSET_Y = -(SCHEMA_NODE_H / 2 - SCHEMA_SPAWN_BTN_SIZE / 2 - SCHEMA_SATELLITE_INSET);
			const SCHEMA_EXPAND_BTN_SIZE = 22;
			const SCHEMA_EXPAND_OFFSET_X = SCHEMA_NODE_W / 2 - SCHEMA_EXPAND_BTN_SIZE / 2 - SCHEMA_SATELLITE_INSET;
			const SCHEMA_EXPAND_OFFSET_Y = -(SCHEMA_NODE_H / 2 - SCHEMA_EXPAND_BTN_SIZE / 2 - SCHEMA_SATELLITE_INSET);
			// In expanded mode the satellite sits FULLY OUTSIDE the
			// grown card: the original 6 px corner-overlap covers a
			// chunk of the accent border (small-card readers don't
			// notice; the expanded card's border is much more visible
			// so the cut reads as a bug). 4 px gap from the corner.
			const SCHEMA_SPAWN_OFFSET_X_EXPANDED = SCHEMA_NODE_W_EXPANDED / 2 + SCHEMA_SPAWN_BTN_SIZE / 2 + 4;
			const SCHEMA_SPAWN_OFFSET_Y_EXPANDED = -(SCHEMA_NODE_H_EXPANDED / 2 + SCHEMA_SPAWN_BTN_SIZE / 2 + 4);
			const SCHEMA_EXPAND_OFFSET_X_EXPANDED = SCHEMA_NODE_W_EXPANDED / 2 + SCHEMA_EXPAND_BTN_SIZE / 2 + 4;
			const SCHEMA_EXPAND_OFFSET_Y_EXPANDED = -(SCHEMA_NODE_H_EXPANDED / 2 + SCHEMA_EXPAND_BTN_SIZE / 2 + 4);
			// In-card expansion. The cy node itself grows (via the
			// node[expanded = "1"] stylesheet rule) and an HTML overlay
			// sits exactly on its rendered bbox, becoming the visible
			// card. FK edges + the spawn-btn satellite both follow the
			// new bbox naturally. Re-double-clicking, hitting the ×, or
			// clicking the canvas background collapses it. Only one
			// card can be expanded at a time.
			let _expandedObjectName = null;
			let _expandedPanelEl = null;
			let _expandedRenderHandler = null;
			let _expandedCyNode = null;
			// Map<nodeId, { x, y }>: pre-expansion positions of every
			// neighbor node, so collapse can put them back exactly.
			let _expandedNeighborPositions = null;
			function _hideSchemaFieldsPanel() {
				if (_expandedPanelEl && _expandedPanelEl.parentNode) {
					_expandedPanelEl.parentNode.removeChild(_expandedPanelEl);
				}
				if (_expandedRenderHandler && getCySchemaInstance()) {
					try {
 getCySchemaInstance().off('render position', _expandedRenderHandler); 
} catch (_) {}
				}
				if (_expandedCyNode && _expandedCyNode.length) {
					_expandedCyNode.removeData('expanded');
					// Force a style recompute. cy's [expanded = "1"]
					// selector stops matching once the data is gone,
					// but the cached computed style on the node only
					// refreshes when something explicitly invalidates
					// it: without this kick the bbox stays at the
					// expanded size and the collapse appears not to
					// take effect.
					const cy = getCySchemaInstance();
					if (cy) {
						try {
 cy.style().update(); 
} catch (_) {}
						// Re-park the spawn-btn satellite at the
						// original offset; the position listener
						// only fires on parent position changes,
						// not on data flips, so we have to nudge it
						// manually.
						const objName = _expandedCyNode.data('objectName');
						const spawn = objName ? cy.getElementById('spawn_' + objName) : null;
						if (spawn && spawn.length) {
spawn.removeData('expandedHidden');
}
						const expand = objName ? cy.getElementById('expand_' + objName) : null;
						if (expand && expand.length) {
expand.removeData('expandedHidden');
}
						// Slide the surrounding rings back into the
						// positions they held before the expansion.
						if (_expandedNeighborPositions) {
							_expandedNeighborPositions.forEach((pos, id) => {
								const n = cy.getElementById(id);
								if (n && n.length) {
n.position(pos);
}
							});
						}
					}
				}
				_expandedNeighborPositions = null;
				_expandedPanelEl = null;
				_expandedRenderHandler = null;
				_expandedCyNode = null;
				_expandedObjectName = null;
			}
			function _pinSchemaFieldsPanel() {
				if (!_expandedPanelEl || !_expandedCyNode || !getCySchemaInstance()) {
return;
}
				const cy = getCySchemaInstance();
				const container = cy.container();
				if (!container) {
return;
}
				const cRect = container.getBoundingClientRect();
				const bb = _expandedCyNode.renderedBoundingBox();
				// The overlay sits exactly on the cy node's screen
				// bbox: the cy node is the surface, the overlay is
				// the content. The inset has to cover the cy border
				// width PLUS the sub-pixel anti-alias fade cytoscape
				// paints on the inner edge; without the AA buffer,
				// the filter row's darker bg (var(--bg-elev)) cuts
				// into that fading-orange band and reads as the
				// border being chewed on at that row's height. Use
				// ceil for left/top and floor for right/bottom so
				// the panel rounds STRICTLY INWARD from the border
				// region (plain Math.round can land sub-pixel inside
				// the AA fade and reintroduce the bleed).
				const BORDER = 2;
				const AA_BUFFER = 2;
				const INSET = BORDER + AA_BUFFER;
				const left = Math.ceil(cRect.left + bb.x1 + INSET);
				const top = Math.ceil(cRect.top + bb.y1 + INSET);
				const right = Math.floor(cRect.left + bb.x2 - INSET);
				const bottom = Math.floor(cRect.top + bb.y2 - INSET);
				_expandedPanelEl.style.left = left + 'px';
				_expandedPanelEl.style.top = top + 'px';
				_expandedPanelEl.style.width = (right - left) + 'px';
				_expandedPanelEl.style.height = (bottom - top) + 'px';
			}
			function _renderSchemaFieldsPanelBody(objectName) {
				const data = canvasState.describeCache && canvasState.describeCache[objectName];
				if (!data || !Array.isArray(data.fields)) {
					return '<div class="schema-expand-empty">Loading fields…</div>';
				}
				const fields = data.fields.slice().sort((a, b) => {
					const al = (a.label || a.name || '').toLowerCase();
					const bl = (b.label || b.name || '').toLowerCase();
					return al < bl ? -1 : al > bl ? 1 : 0;
				});
				const rows = fields.map((f) => {
					const labelRaw = f.label || f.name || '';
					const nameRaw = f.name || '';
					const typeRaw = f.type || '';
					const label = escapeHtml(labelRaw);
					const apiName = escapeHtml(nameRaw);
					const type = escapeHtml(typeRaw);
					const isPicklist = (typeRaw === 'picklist' || typeRaw === 'multipicklist')
						&& Array.isArray(f.picklistValues) && f.picklistValues.length > 0;
					// data-search powers the filter input: single
					// lowercase blob of label + API name + type so a
					// substring match catches any of them. For
					// picklists we also fold every value's label +
					// API value into the haystack so filtering by
					// "Customer" surfaces the Type field.
					let searchRaw = (labelRaw + ' ' + nameRaw + ' ' + typeRaw).toLowerCase();
					if (isPicklist) {
						searchRaw += ' ' + f.picklistValues
							.map((pv) => ((pv.label || '') + ' ' + (pv.value || '')))
							.join(' ')
							.toLowerCase();
					}
					const search = escapeHtml(searchRaw);
					const classes = 'schema-expand-field' + (isPicklist ? ' is-picklist' : '');
					let valuesHtml = '';
					if (isPicklist) {
						const items = f.picklistValues.map((pv) => {
							const pvLabel = escapeHtml(pv.label || pv.value || '');
							const pvValue = escapeHtml(pv.value || '');
							// Show the API value next to the label
							// only when it differs (so a value like
							// "Customer" doesn't read as
							// "Customer Customer").
							const showValue = (pv.label || '') !== (pv.value || '');
							return (
								'<li class="sxf-picklist-value">' +
									'<span class="sxf-pv-label">' + pvLabel + '</span>' +
									(showValue ? '<span class="sxf-pv-value">' + pvValue + '</span>' : '') +
									(pv.defaultValue ? '<span class="sxf-pv-default">default</span>' : '') +
								'</li>'
							);
						}).join('');
						valuesHtml = '<ul class="sxf-picklist-values" hidden>' + items + '</ul>';
					}
					return (
						'<li class="' + classes + '" data-search="' + search + '"' + (isPicklist ? ' data-picklist="1"' : '') + '>' +
							'<div class="sxf-row">' +
								(isPicklist ? '<button type="button" class="sxf-disclose" aria-label="Show picklist values" aria-expanded="false">▸</button>' : '<span class="sxf-disclose-spacer"></span>') +
								'<div class="sxf-row-text">' +
									'<div class="sxf-label">' + label + '</div>' +
									'<div class="sxf-meta">' +
										'<span class="sxf-api">' + apiName + '</span>' +
										'<span class="sxf-type">' + type + '</span>' +
										(isPicklist ? '<span class="sxf-count">(' + f.picklistValues.length + ')</span>' : '') +
									'</div>' +
								'</div>' +
							'</div>' +
							valuesHtml +
						'</li>'
					);
				}).join('');
				return (
					'<div class="schema-expand-filter-row">' +
						'<input type="search" class="schema-expand-filter" placeholder="Filter fields…" autocomplete="off">' +
						'<span class="schema-expand-count" data-total="' + fields.length + '">' + fields.length + ' fields</span>' +
					'</div>' +
					'<ul class="schema-expand-fields">' + rows + '</ul>'
				);
			}
			// Wire the filter input on a freshly-rendered panel body.
			// Called both at initial open and after the describe fetch
			// repopulates the body asynchronously. Toggles a `hidden`
			// attribute on non-matching rows so the filter is purely
			// presentational (no list re-rendering) and the count
			// reflects how many rows match the query.
			function _wireSchemaFieldsFilter(panel) {
				if (!panel) {
return;
}
				const input = panel.querySelector('.schema-expand-filter');
				const countEl = panel.querySelector('.schema-expand-count');
				if (!input || !countEl) {
return;
}
				const rows = panel.querySelectorAll('.schema-expand-field');
				const total = Number(countEl.getAttribute('data-total')) || rows.length;
				const apply = () => {
					const q = input.value.trim().toLowerCase();
					let shown = 0;
					rows.forEach((row) => {
						const s = row.getAttribute('data-search') || '';
						const match = !q || s.indexOf(q) !== -1;
						if (match) {
							row.removeAttribute('hidden');
							shown++;
						} else {
							row.setAttribute('hidden', '');
						}
					});
					countEl.textContent = q
						? shown + ' of ' + total + ' fields'
						: total + ' fields';
				};
				input.addEventListener('input', apply);
				input.addEventListener('keydown', (e) => e.stopPropagation());
				input.addEventListener('keyup', (e) => e.stopPropagation());
				// Picklist row disclosure: toggling the chevron
				// expands/collapses the nested values list. Delegated
				// off the panel so a single listener covers every
				// picklist row (and any rows added by a future
				// re-render).
				panel.addEventListener('click', (e) => {
					const row = e.target && e.target.closest && e.target.closest('.schema-expand-field.is-picklist');
					if (!row) {
return;
}
					// Inner controls (none right now, but future-
					// proof) shouldn't toggle the disclosure.
					if (e.target.closest('a, input, select, textarea')) {
return;
}
					const values = row.querySelector('.sxf-picklist-values');
					const disclose = row.querySelector('.sxf-disclose');
					if (!values) {
return;
}
					const isOpen = !values.hasAttribute('hidden');
					if (isOpen) {
						values.setAttribute('hidden', '');
						if (disclose) {
							disclose.setAttribute('aria-expanded', 'false');
							disclose.textContent = '▸';
						}
					} else {
						values.removeAttribute('hidden');
						if (disclose) {
							disclose.setAttribute('aria-expanded', 'true');
							disclose.textContent = '▾';
						}
					}
				});
			}
			function _showSchemaFieldsPanel(objectName, cyNode) {
				_hideSchemaFieldsPanel();
				_expandedObjectName = objectName;
				_expandedCyNode = cyNode;
				// Flip the cy node into expanded mode: the stylesheet
				// rule resizes the bbox and clears the cy text label.
				// Re-park the spawn-btn at the corner of the new bbox
				// so the "+" stays visible and doesn't get buried.
				cyNode.data('expanded', '1');
				const cy = getCySchemaInstance();
				// Hide both corner satellites: the modal header
				// carries "+ Add" + "⤡ Collapse" inline so nothing
				// hangs off the grown card.
				const spawn = cy ? cy.getElementById('spawn_' + objectName) : null;
				if (spawn && spawn.length) {
spawn.data('expandedHidden', '1');
}
				const expand = cy ? cy.getElementById('expand_' + objectName) : null;
				if (expand && expand.length) {
expand.data('expandedHidden', '1');
}
				// Push every surrounding node outward along the
				// radial direction from the active center so the
				// rings don't get buried under the grown card. The
				// shift is the difference between the expanded and
				// collapsed cards' radial extent at each ring node's
				// angle, which keeps the visual gap between the card
				// edge and the ring node identical to the collapsed
				// state. Original positions are stashed so collapse
				// can restore them exactly (no drift on repeated
				// expand/collapse cycles).
				_expandedNeighborPositions = new Map();
				if (cy) {
					const center = cyNode.position();
					const halfWC = SCHEMA_NODE_W / 2;
					const halfHC = SCHEMA_NODE_H / 2;
					const halfWE = SCHEMA_NODE_W_EXPANDED / 2;
					const halfHE = SCHEMA_NODE_H_EXPANDED / 2;
					cy.nodes().forEach((n) => {
						if (n.id() === cyNode.id()) {
return;
}
						const kind = n.data('kind');
						// The +/expand satellites follow their parent card
						// via the cy.on('position') listener (and the park-all
						// pass), so they must NEVER be shifted independently
						// here: doing so strands a card's + or expand icon off
						// the card. (Both satellite kinds, not just spawn-btn:
						// missing expand-btn here moved other cards' expand
						// icons off them when one card was expanded.)
						if (kind === 'spawn-btn' || kind === 'expand-btn') {
return;
}
						const p = n.position();
						_expandedNeighborPositions.set(n.id(), { x: p.x, y: p.y });
						const dx = p.x - center.x;
						const dy = p.y - center.y;
						const dist = Math.hypot(dx, dy);
						if (dist < 0.5) {
return;
} // overlapping the active, leave it
						const ux = dx / dist;
						const uy = dy / dist;
						// Card radial extent in this direction:
						// distance from center to where a ray at
						// this angle exits the rectangle.
						const collapsedExt = Math.min(
							halfWC / Math.max(0.001, Math.abs(ux)),
							halfHC / Math.max(0.001, Math.abs(uy))
						);
						const expandedExt = Math.min(
							halfWE / Math.max(0.001, Math.abs(ux)),
							halfHE / Math.max(0.001, Math.abs(uy))
						);
						const shift = Math.max(0, expandedExt - collapsedExt);
						if (shift <= 0) {
return;
}
						n.position({ x: p.x + ux * shift, y: p.y + uy * shift });
					});
				}
				const objLabel = (canvasState.describeCache
					&& canvasState.describeCache[objectName]
					&& canvasState.describeCache[objectName].label) || objectName;
				const panel = document.createElement('div');
				panel.className = 'schema-expand-panel';
				panel.innerHTML =
					'<div class="schema-expand-header">' +
						'<span class="schema-expand-title">' + escapeHtml(objLabel) + '</span>' +
						'<span class="schema-expand-api">' + escapeHtml(objectName) + '</span>' +
						'<button type="button" class="schema-expand-add" aria-label="Add record" title="Add a record of this type to the canvas">+ Add</button>' +
						'<button type="button" class="schema-expand-close" aria-label="Collapse" title="Collapse">⤡</button>' +
					'</div>' +
					'<div class="schema-expand-body">' + _renderSchemaFieldsPanelBody(objectName) + '</div>';
				panel.addEventListener('mousedown', (e) => e.stopPropagation());
				// Re-double-clicking the expanded card collapses it,
				// matching the dbltap-to-expand entry point.
				panel.addEventListener('dblclick', (e) => {
 e.stopPropagation(); _hideSchemaFieldsPanel(); 
});
				panel.querySelector('.schema-expand-close').addEventListener('click', _hideSchemaFieldsPanel);
				// "+ Add" in the modal header replaces the corner spawn-btn
				// for the duration of the expanded view, so users still
				// have a one-click path to add a record of this type
				// without dismissing the panel.
				panel.querySelector('.schema-expand-add').addEventListener('click', () => {
					_spawnRecordFromSchemaObject(objectName);
				});
				document.body.appendChild(panel);
				_expandedPanelEl = panel;
				_wireSchemaFieldsFilter(panel);
				_pinSchemaFieldsPanel();
				_expandedRenderHandler = _pinSchemaFieldsPanel;
				cy.on('render position', _expandedRenderHandler);
				// Fetch on demand if we don't have field data yet.
				if (!canvasState.describeCache[objectName] || !Array.isArray(canvasState.describeCache[objectName].fields)) {
					ensureDescribe(objectName)
						.then(() => {
							if (_expandedObjectName !== objectName || !_expandedPanelEl) {
return;
}
							const body = _expandedPanelEl.querySelector('.schema-expand-body');
							if (body) {
body.innerHTML = _renderSchemaFieldsPanelBody(objectName);
}
							_wireSchemaFieldsFilter(_expandedPanelEl);
							_pinSchemaFieldsPanel();
						})
						.catch((err) => {
							if (_expandedObjectName !== objectName || !_expandedPanelEl) {
return;
}
							const body = _expandedPanelEl.querySelector('.schema-expand-body');
							if (body) {
body.innerHTML = '<div class="schema-expand-empty">Couldn’t load fields: ' + escapeHtml(err.message || 'unknown error') + '</div>';
}
						});
				}
			}
			const SCHEMA_STYLE = [
				// Suppress cytoscape's tap-hold "active background"
				// indicator: by default cy renders a 0.7-opacity dark
				// blob at the tap point whenever the user clicks the
				// canvas background, which reads as a flicker / dark
				// halo against the schema canvas's already-dark surface.
				{ selector: 'core', style: {
					'active-bg-opacity': 0,
					'active-bg-size': 0,
				}},
				{ selector: 'node', style: {
					label: 'data(label)',
					'text-valign': 'center', 'text-halign': 'center',
					'text-wrap': 'wrap',
					'text-max-width': SCHEMA_NODE_W - 16,
					color: '#e8e6e1',
					'font-family': 'system-ui, sans-serif',
					'font-size': 11,
					shape: 'round-rectangle',
					width: SCHEMA_NODE_W,
					height: SCHEMA_NODE_H,
					'background-color': '#1e2025',
					'border-width': 1,
					'border-color': '#3a3f47',
					'overlay-opacity': 0,
				}},
				{ selector: 'node[kind = "sel-active"]', style: {
					'border-color': '#d68b3c',
					'border-width': 2,
				}},
				// Expanded mode: the cy node grows so the HTML overlay
				// can sit exactly on top of it (the overlay IS the
				// expanded card visually). The text label gets cleared
				// because the overlay renders the title; the background
				// matches the surrounding chrome and the overlay's
				// children are transparent so the cy node fill is the
				// sole surface: no two-tone bleed that would make the
				// accent border read as thicker on one side.
				{ selector: 'node[expanded = "1"]', style: {
					width: SCHEMA_NODE_W_EXPANDED,
					height: SCHEMA_NODE_H_EXPANDED,
					label: '',
					'background-color': '#262a31',
					'border-color': '#d68b3c',
					'border-width': 2,
				}},
				{ selector: 'node[kind = "ring"]', style: {
					'background-color': '#16191d',
					'border-style': 'dashed',
					'border-color': '#4a5058',
					color: '#9aa0a8',
					width: SCHEMA_NODE_W - 20,
					height: SCHEMA_NODE_H - 10,
				}},
				// Spawn-button satellite: small "+" disc anchored at
				// each sel/sel-active node's top-right. Tap fires
				// _spawnRecordFromSchemaObject. cy's tap event dispatches
				// reliably (no HTML-overlay click bubbling involved).
				{ selector: 'node[kind = "spawn-btn"]', style: {
					shape: 'ellipse',
					width: SCHEMA_SPAWN_BTN_SIZE,
					height: SCHEMA_SPAWN_BTN_SIZE,
					// Bare glyph: always visible (no hover gate) and no
					// circle around it: transparent fill, no border.
					'background-opacity': 0,
					'border-width': 0,
					label: '+',
					color: '#e8e6e1',
					'font-size': 16,
					'text-valign': 'center',
					'text-halign': 'center',
					opacity: 1,
					'overlay-opacity': 0,
				}},
				{ selector: 'node[kind = "spawn-btn"]:active', style: {
					color: '#d68b3c',
				}},
				// Expand-btn satellite: mirrors spawn-btn so the two
				// read as a matched pair on opposite corners.
				{ selector: 'node[kind = "expand-btn"]', style: {
					shape: 'ellipse',
					width: SCHEMA_EXPAND_BTN_SIZE,
					height: SCHEMA_EXPAND_BTN_SIZE,
					// Bare glyph: always visible, no circle (matches spawn-btn).
					'background-opacity': 0,
					'border-width': 0,
					label: 'data(label)',
					color: '#e8e6e1',
					'font-size': 14,
					'text-valign': 'center',
					'text-halign': 'center',
					opacity: 1,
					'overlay-opacity': 0,
				}},
				{ selector: 'node[kind = "expand-btn"]:active', style: {
					color: '#d68b3c',
				}},
				// When the parent card is expanded, hide both
				// satellites: the modal header carries the spawn +
				// collapse buttons inline so nothing hangs off the
				// grown bbox.
				{ selector: 'node[?expandedHidden]', style: {
					display: 'none',
				}},
				// Edges to spawn-btn satellites are invisible: the
				// satellite needs to be a cy element so taps register,
				// but it should look like a free-floating chip, not a
				// connected node.
				{ selector: 'edge[kind = "spawn-link"]', style: {
					'line-color': 'transparent',
					'target-arrow-shape': 'none',
					'source-arrow-shape': 'none',
					label: '',
					width: 0,
				}},
				{ selector: 'node:selected', style: {
					'border-color': '#d68b3c',
					'border-width': 3,
				}},
				{ selector: 'edge', style: {
					width: 1.5,
					'line-color': '#5a6068',
					'curve-style': 'bezier',
					'target-arrow-shape': 'none',
					'font-size': 10,
					color: '#9aa0a8',
					'text-background-color': '#1c2226',
					'text-background-opacity': 0.9,
					'text-background-padding': 2,
					'text-rotation': 'autorotate',
				}},
				// Label mapping scoped to edges that actually carry a
				// label data field. Spawn/expand satellites are edges
				// without a label property; applying `data(label)` to
				// them triggers cytoscape's "no mapping for property"
				// console warning on every render. The `[label]`
				// selector limits the mapping to edges where the data
				// field is defined, per cytoscape's own suggestion.
				{ selector: 'edge[label]', style: { label: 'data(label)' } },
				// FK + ring edges get crow-foot/bar markers via the SVG
				// overlay (attachCyEdgeMarkers). Cy's own arrowheads stay
				// suppressed so we don't double up notation at the ends.
				{ selector: 'edge[kind = "fk"]', style: {
					'target-arrow-shape': 'none',
				}},
				{ selector: 'edge[kind = "ring"]', style: {
					'line-style': 'dashed',
					'line-color': '#3a3f47',
					'target-arrow-shape': 'none',
					color: '#6a7078',
				}},
			];
			
			// Build the schema view derived from the records-canvas
			// selection. Returns null when the schema should be blank
			// (zero or multiple records selected, or selection points
			// at a type-node placeholder).
			// Look up describe data for an object name from any source
			// we already have: a sel entry, the canvasState.graphCache, or null.
			// Used by _schemaViewFromSelection to find the active's
			// parents/children when ring navigation moves the active
			// outside canvasState.selectedObjects.
			function _resolveDescribeData(name) {
				const sel = canvasState.selectedObjects.find((s) => s.name === name);
				if (sel && sel.data) {
return sel.data;
}
				if (canvasState.graphCache && canvasState.graphCache[name]) {
return canvasState.graphCache[name];
}
				return null;
			}
			
			// Resolve spawn-link targets from the schema view's edges,
			// restricted to records inside the focused record's
			// records-canvas component. Path edges (most recent step
			// wins) take priority over component FK edges. Returns
			// an array of { fromId, toId, field, otherRec }, one per
			// FK association the spawn should create. The list is
			// usually one element, but when the FK lives on the
			// OTHER side (not the new record) and multiple matching
			// records exist (e.g., two Accounts pointing at the new
			// User via OwnerId), every matching record gets its own
			// link. Empty array when no schema edge connects the
			// spawning object to a record inside the focused
			// component: the new card stays on its own island.
			function _findSpawnLinkTargets(spawningName, newId) {
				const focusedRecId = canvasState.bulkSelectedIds.size === 1
					? canvasState.bulkSelectedIds.values().next().value
					: null;
				const focusedRec = focusedRecId != null
					? canvasState.bulkRecords.find((r) => r.id === focusedRecId)
					: null;
				if (!focusedRec) {
return [];
}
				// Component reachable from the focused record. Records
				// outside this set belong to other graphs and must
				// never be the target of an auto-link.
				const componentRecIds = new Set();
				const queue = [focusedRec.id];
				while (queue.length) {
					const id = queue.shift();
					if (componentRecIds.has(id)) {
continue;
}
					componentRecIds.add(id);
					canvasState.bulkAssociations.forEach((a) => {
						if (a.fromId === id && !componentRecIds.has(a.toId)) {
queue.push(a.toId);
}
						if (a.toId === id && !componentRecIds.has(a.fromId)) {
queue.push(a.fromId);
}
					});
				}
				const findComponentRecs = (name) => canvasState.bulkRecords.filter((r) => (
					!r.isTypeNode &&
					r.objectName === name &&
					r.id !== newId &&
					componentRecIds.has(r.id)
				));
				// Helper: turn a path-edge style match into one or many
				// links. When the FK lives on the new record (it's the
				// `from` side of the FK), only one link can exist;
				// pick the first matching other. Otherwise (FK lives
				// on existing records), every matching other gets its
				// own link to the new card.
				const expandMatch = (otherRecs, fromSide, toSide, field) => {
					if (otherRecs.length === 0) {
return [];
}
					const newIsFrom = fromSide === spawningName;
					if (newIsFrom) {
						const otherRec = otherRecs[0];
						return [{ fromId: newId, toId: otherRec.id, field, otherRec }];
					}
					return otherRecs.map((otherRec) => ({
						fromId: otherRec.id,
						toId: newId,
						field,
						otherRec,
					}));
				};
				// Path edges: newest first so the most recent
				// navigation step claims the link before older ones.
				for (let i = canvasState._schemaViewPathEdges.length - 1; i >= 0; i--) {
					const step = canvasState._schemaViewPathEdges[i];
					let otherName = null;
					if (step.to === spawningName) {
otherName = step.from;
} else if (step.from === spawningName) {
otherName = step.to;
}
					if (!otherName || !step.field) {
continue;
}
					const otherRecs = findComponentRecs(otherName);
					if (otherRecs.length === 0) {
continue;
}
					// step.direction describes step.to's role relative to
					// step.from. Translate into FK orientation:
					//   parent → FK on step.from  → step.from → step.to
					//   child  → FK on step.to    → step.to   → step.from
					const fromSide = step.direction === 'parent' ? step.from : step.to;
					const toSide = step.direction === 'parent' ? step.to : step.from;
					return expandMatch(otherRecs, fromSide, toSide, step.field);
				}
				// Component FK edges: already known to be inside
				// the focused component by construction. Skip the
				// focused object's own type so we don't attach the
				// new card to its same-type sibling. Group by
				// (otherObject, field) so multiple existing
				// associations contribute to the same expansion.
				if (focusedRec.objectName !== spawningName) {
					const byKey = new Map();
					for (const a of canvasState.bulkAssociations) {
						if (!componentRecIds.has(a.fromId) || !componentRecIds.has(a.toId)) {
continue;
}
						const fromRec = canvasState.bulkRecords.find((r) => r.id === a.fromId);
						const toRec = canvasState.bulkRecords.find((r) => r.id === a.toId);
						if (!fromRec || !toRec) {
continue;
}
						let fromSide, toSide, otherRec;
						if (fromRec.objectName === spawningName && toRec.objectName !== spawningName) {
							fromSide = spawningName;
							toSide = toRec.objectName;
							otherRec = toRec;
						} else if (toRec.objectName === spawningName && fromRec.objectName !== spawningName) {
							fromSide = fromRec.objectName;
							toSide = spawningName;
							otherRec = fromRec;
						} else {
							continue;
						}
						const key = otherRec.objectName + '|' + a.fieldName;
						if (!byKey.has(key)) {
byKey.set(key, { fromSide, toSide, field: a.fieldName, others: [] });
}
						byKey.get(key).others.push(otherRec);
					}
					for (const entry of byKey.values()) {
						const links = expandMatch(entry.others, entry.fromSide, entry.toSide, entry.field);
						if (links.length > 0) {
return links;
}
					}
				}
				return [];
			}
			
			// Spawn a record of `objectName` on the records canvas at a
			// position that mirrors the schema node's offset from the
			// focused record's object. Stamps fromSelectionId so the
			// records-driven schema view continues to map records →
			// selections cleanly. Auto-links via _findSpawnLinkTarget
			// when the schema view shows a direct edge to a node with
			// a spawned record; otherwise the new card is an island.
			// Closest open (non-overlapping) spot to the center of the VISIBLE
			// edit canvas, spiralling outward. Used so repeated schema-"+" spawns
			// fan out from the middle of the view instead of stacking on one
			// spot. Scroll-world center (scrollLeft + clientWidth/2) matches how
			// records are positioned elsewhere; card half-extents mirror the
			// spawn overlap check below.
			function _nearestFreeSpotToViewportCenter() {
				const canvasEl = getGraph().querySelector('#bulk-canvas');
				const cw = (canvasEl && canvasEl.clientWidth) || 800;
				const ch = (canvasEl && canvasEl.clientHeight) || 600;
				const cx0 = ((canvasEl && canvasEl.scrollLeft) || 0) + cw / 2;
				const cy0 = ((canvasEl && canvasEl.scrollTop) || 0) + ch / 2;
				const CARD_W = 230;
				const CARD_H = 90;
				const overlaps = (x, y) => canvasState.bulkRecords.some((r) => (
					r && !r.isTypeNode && !r._chipLoader
					&& typeof r.x === 'number' && typeof r.y === 'number'
					&& Math.abs(r.x - x) < CARD_W && Math.abs(r.y - y) < CARD_H
				));
				if (!overlaps(cx0, cy0)) {
					return { x: cx0, y: cy0 };
				}
				for (let ring = 1; ring <= 40; ring++) {
					const rad = ring * 40;
					const pts = ring * 8;
					for (let i = 0; i < pts; i++) {
						const ang = (2 * Math.PI * i) / pts;
						const x = cx0 + rad * Math.cos(ang);
						const y = cy0 + rad * Math.sin(ang);
						if (!overlaps(x, y)) {
							return { x, y };
						}
					}
				}
				return { x: cx0, y: cy0 };
			}
			function _spawnRecordFromSchemaObject(objectName) {
				if (!objectName) {
return;
}
				const blocked = _canvasCapBlockReason(1);
				if (blocked) {
 showBulkToast(blocked); return; 
}
				const doSpawn = (selEntry) => {
					const focusedRecId = canvasState.bulkSelectedIds.size === 1
						? canvasState.bulkSelectedIds.values().next().value
						: null;
					const focusedRec = focusedRecId != null
						? canvasState.bulkRecords.find((r) => r.id === focusedRecId)
						: null;
					let x, y;
					if (focusedRec && !focusedRec.isTypeNode) {
						// A record is focused: place the new card at the schema-
						// derived offset from it, so a spawned relative lands next
						// to its parent in records-world space.
						const baseSchemaNode = getCySchemaInstance()
							? getCySchemaInstance().getElementById('o_' + focusedRec.objectName)
							: null;
						const objSchemaNode = getCySchemaInstance()
							? getCySchemaInstance().getElementById('o_' + selEntry.name)
							: null;
						const baseSchemaPos = baseSchemaNode && baseSchemaNode.length
							? baseSchemaNode.position()
							: { x: 0, y: 0 };
						const objSchemaPos = objSchemaNode && objSchemaNode.length
							? objSchemaNode.position()
							: baseSchemaPos;
						x = focusedRec.x + (objSchemaPos.x - baseSchemaPos.x) * RECORDS_WORLD_SCALE;
						y = focusedRec.y + (objSchemaPos.y - baseSchemaPos.y) * RECORDS_WORLD_SCALE;
					} else {
						// No focused record: land at the closest open space to the
						// CENTER OF THE VISIBLE edit canvas, so repeated spawns of
						// any object type fan out from the middle of the view
						// instead of stacking on one spot.
						const spot = _nearestFreeSpotToViewportCenter();
						x = spot.x;
						y = spot.y;
					}
					// Step the new card away from any existing card it
					// would land on top of. Replaces the previous
					// fixed sibling-only stagger, which only avoided
					// same-type collisions and never solved the case
					// where the schema-derived offset put the new card
					// on top of a different-type record. The check uses
					// a bbox slightly larger than the visible card so
					// the new node lands with breathing room, and walks
					// diagonally down-right until clear (or it gives up
					// after a sane cap so a pathological canvas can't
					// loop forever).
					const SPAWN_CARD_W = 230;
					const SPAWN_CARD_H = 90;
					const SPAWN_STEP = 32;
					const SPAWN_MAX_STEPS = 80;
					const _overlaps = (cx, cy) => canvasState.bulkRecords.some((r) => {
						if (!r || r.isTypeNode || r._chipLoader) {
return false;
}
						if (typeof r.x !== 'number' || typeof r.y !== 'number') {
return false;
}
						return Math.abs(r.x - cx) < SPAWN_CARD_W && Math.abs(r.y - cy) < SPAWN_CARD_H;
					});
					let steps = 0;
					while (_overlaps(x, y) && steps < SPAWN_MAX_STEPS) {
						x += SPAWN_STEP;
						y += SPAWN_STEP;
						steps++;
					}
					const newRec = {
						id: canvasState.bulkIdSeq++,
						objectName: selEntry.name,
						label: selEntry.label,
						x, y,
						values: {},
						fromSelectionId: selEntry.id,
					};
					canvasState.bulkRecords.push(newRec);
					// Auto-link based on edges visible in the current
					// schema view, NOT the focused record's full
					// describe. Two edge sources count as "links back":
					//   - Path edges (the navigation chain, most recent
					//     step has priority).
					//   - Component FK edges (records-canvas FK between
					//     two sel peers in the focused component).
					// Ring spokes don't count: their other end is a
					// ring node with no spawned record. If no edge
					// connects the spawning object to a node with a
					// spawned record, the new card is an island.
					const links = _findSpawnLinkTargets(selEntry.name, newRec.id);
					links.forEach((link) => {
						canvasState.bulkAssociations.push({
							id: canvasState.bulkIdSeq++,
							fromId: link.fromId,
							toId: link.toId,
							fieldName: link.field,
						});
					});
					// Ctrl+Z: remove the spawned card and any links created with it.
					if (typeof pushUndo === 'function') {
						const _spawnedId = newRec.id;
						const _spawnedFingerprint = JSON.stringify(newRec);
						const _linkFingerprint = JSON.stringify(
							canvasState.bulkAssociations.filter((a) => a && (a.fromId === _spawnedId || a.toId === _spawnedId)),
						);
						pushUndo('Add record', function () {
							const current = canvasState.bulkRecords.find((r) => r && r.id === _spawnedId);
							const currentLinks = canvasState.bulkAssociations.filter(
								(a) => a && (a.fromId === _spawnedId || a.toId === _spawnedId),
							);
							if (!current || JSON.stringify(current) !== _spawnedFingerprint || JSON.stringify(currentLinks) !== _linkFingerprint) {
								showBulkToast('Can’t undo the schema add because that record or its relationships were edited afterward.', 'info');
								return false;
							}
							canvasState.bulkRecords = canvasState.bulkRecords.filter(
								(r) => !r || r.id !== _spawnedId,
							);
							canvasState.bulkAssociations = canvasState.bulkAssociations.filter(
								(a) => a && a.fromId !== _spawnedId && a.toId !== _spawnedId,
							);
							renderBulkView();
						});
					}
					renderBulkView();
					const label = selEntry.label || selEntry.name;
					let toastMsg = 'Added ' + label + ' record.';
					if (links.length === 1) {
						const other = links[0].otherRec;
						toastMsg = 'Added ' + label + ' record (linked to ' + (other.label || other.objectName) + ').';
					} else if (links.length > 1) {
						toastMsg = 'Added ' + label + ' record (linked to ' + links.length + ' ' + (links[0].otherRec.label || links[0].otherRec.objectName) + ' record' + (links.length === 1 ? '' : 's') + ').';
					}
					showBulkToast(toastMsg);
				};
				const existing = canvasState.selectedObjects.find((s) => s.name === objectName);
				if (existing) {
					doSpawn(existing);
				} else if (typeof addToSelection === 'function') {
					addToSelection(objectName).then(doSpawn).catch((err) => {
						console.warn('spawn from schema: addToSelection failed for', objectName, err);
						showBulkToast('Failed to load ' + objectName + ': ' + (err.message || err), 'error');
					});
				}
			}
			
			function _schemaViewFromSelection() {
				// Records-canvas focus: only valid when exactly one
				// non-type-node record is selected. The schema can still
				// render when no record is focused IF the user has
				// explicitly chosen an object via the Find object picker
				// (override mode).
				let focusedRec = null;
				if (canvasState.bulkSelectedIds.size === 1) {
					const onlyId = canvasState.bulkSelectedIds.values().next().value;
					const r = canvasState.bulkRecords.find((rr) => rr.id === onlyId);
					if (r && !r.isTypeNode) {
focusedRec = r;
}
				}
				const overrideName = canvasState._schemaViewObject;
				if (!focusedRec && !overrideName) {
return null;
}

				// The schema explorer is a pure navigation view: it renders the
				// object the user navigated to (canvasState._schemaViewObject -
				// set by clicking a spoke / Find object / the + spawn) plus its
				// describe rings, NEVER the records-canvas component. When the
				// user hasn't navigated yet, seed the center from the selected
				// edit-canvas record's object and PERSIST it - so from then on,
				// deleting or reselecting records on the edit canvas leaves the
				// schema untouched (no re-scope, no re-layout, +/expand stay).
				const activeName = overrideName || focusedRec.objectName;
				if (!overrideName) {
					canvasState._schemaViewObject = activeName;
				}
				const isOverride = true;
			
				let componentRecIds;
				let objectNames;
				const seenNames = new Set();
				if (isOverride) {
					componentRecIds = new Set();
					objectNames = [activeName];
					seenNames.add(activeName);
					// Pin every object the user has previously navigated
					// through so the original center (and any breadcrumbs
					// in between) stay in the schema regardless of any
					// active filter (smart, text, parents/children).
					canvasState._schemaViewPath.forEach((name) => {
						if (seenNames.has(name)) {
return;
}
						seenNames.add(name);
						objectNames.push(name);
					});
				} else {
					// BFS the records-canvas connected component containing
					// the focused record. Type-node placeholders are ignored.
					componentRecIds = new Set();
					const queue = [focusedRec.id];
					while (queue.length) {
						const id = queue.shift();
						if (componentRecIds.has(id)) {
continue;
}
						componentRecIds.add(id);
						canvasState.bulkAssociations.forEach((a) => {
							if (a.fromId === id && !componentRecIds.has(a.toId)) {
queue.push(a.toId);
}
							if (a.toId === id && !componentRecIds.has(a.fromId)) {
queue.push(a.fromId);
}
						});
					}
					objectNames = [];
					componentRecIds.forEach((id) => {
						const r = canvasState.bulkRecords.find((x) => x.id === id);
						if (!r || r.isTypeNode) {
return;
}
						if (seenNames.has(r.objectName)) {
return;
}
						seenNames.add(r.objectName);
						objectNames.push(r.objectName);
					});
				}
			
				const labelFor = (name) => {
					const sel = canvasState.selectedObjects.find((s) => s.name === name);
					return (sel && sel.label) || name;
				};
				const elements = [];
				const nodeKindById = new Map();
			
				objectNames.forEach((name) => {
					const id = 'o_' + name;
					const kind = name === activeName ? 'sel-active' : 'sel';
					nodeKindById.set(id, kind);
					elements.push({
						group: 'nodes',
						data: { id, kind, label: labelFor(name), objectName: name },
					});
					// Spawn-button satellite - top-LEFT corner of the
					// card. Taps fire the records-canvas spawn. The
					// link edge keeps the two visually associated
					// through any cy diff/relayout. grabbable +
					// selectable are off so a wiggle can't be
					// reinterpreted as a drag.
					const spawnId = 'spawn_' + name;
					nodeKindById.set(spawnId, 'spawn-btn');
					elements.push({
						group: 'nodes',
						data: { id: spawnId, kind: 'spawn-btn', label: '+', spawnFor: name },
						grabbable: false,
						selectable: false,
					});
					elements.push({
						group: 'edges',
						data: { id: 'spawnedge_' + name, source: id, target: spawnId, kind: 'spawn-link' },
					});
					// Expand-button satellite - top-RIGHT corner of the
					// card. Tap toggles the expanded fields panel. When
					// the card expands, both satellites are hidden via
					// node[expandedHidden = "1"] so the "+" doesn't
					// hang off the grown bbox.
					const expandId = 'expand_' + name;
					nodeKindById.set(expandId, 'expand-btn');
					elements.push({
						group: 'nodes',
						data: { id: expandId, kind: 'expand-btn', label: '⤢', expandFor: name },
						grabbable: false,
						selectable: false,
					});
					elements.push({
						group: 'edges',
						data: { id: 'expandedge_' + name, source: id, target: expandId, kind: 'spawn-link' },
					});
				});
			
				// Dedup edges by (fromObj, toObj, fieldName) so multiple
				// records sharing the same FK between the same two
				// object types collapse to one schema edge.
				//
				// Non-override mode: scope to the focused record's
				// connected component - only edges whose endpoints are
				// both in componentRecIds emit. Override mode (user
				// navigated the schema): componentRecIds is empty, so
				// fall back to checking whether both object types are
				// in the visible objectNames. Without this fallback,
				// clicking a sel-node peer (one already on the records
				// canvas) drops the FK edge between it and the previous
				// active, because the click handler only pushes a
				// canvasState._schemaViewPathEdges step for RING nodes (which carry
				// ringField/ringDirection), not for sel nodes.
				const edgeKeys = [];
				const seenEdges = new Set();
				// Record-derived FK edges belong to the (now-disabled) records-
				// component mode only. In navigation-driven override mode the
				// schema's edges come from the describe rings + the navigation
				// path below - never from edit-canvas record links - so deleting
				// or adding records never changes the schema's edges.
				if (!isOverride) {
				canvasState.bulkAssociations.forEach((a) => {
					const fromRec = canvasState.bulkRecords.find((r) => r.id === a.fromId);
					const toRec = canvasState.bulkRecords.find((r) => r.id === a.toId);
					if (!fromRec || !toRec || fromRec.isTypeNode || toRec.isTypeNode) {
return;
}
					if (isOverride) {
						if (!seenNames.has(fromRec.objectName) || !seenNames.has(toRec.objectName)) {
return;
}
					} else {
						if (!componentRecIds.has(a.fromId) || !componentRecIds.has(a.toId)) {
return;
}
					}
					const fromObj = fromRec.objectName;
					const toObj = toRec.objectName;
					const field = a.fieldName || '';
					const key = fromObj + '|' + toObj + '|' + field;
					if (seenEdges.has(key)) {
return;
}
					seenEdges.add(key);
					edgeKeys.push(key);
					elements.push({
						group: 'edges',
						data: {
							id: 'e_' + key,
							source: 'o_' + fromObj,
							target: 'o_' + toObj,
							label: field,
							kind: 'fk',
						},
					});
				});
				}

				// Path edges - solid FK connections between objects the
				// user navigated through in this schema-side exploration.
				// Each step records the original FK direction; we render
				// it source=many, target=one to match crow-foot semantics.
				if (isOverride && canvasState._schemaViewPathEdges.length) {
					canvasState._schemaViewPathEdges.forEach((step) => {
						if (!seenNames.has(step.from) || !seenNames.has(step.to)) {
return;
}
						let source, target;
						if (step.direction === 'parent') {
							// step.to is the parent of step.from - FK on
							// step.from points at step.to.
							source = 'o_' + step.from;
							target = 'o_' + step.to;
						} else {
							// step.to is the child of step.from - FK on
							// step.to points at step.from.
							source = 'o_' + step.to;
							target = 'o_' + step.from;
						}
						// If a sel-to-sel association (FK) edge above already
						// represents this exact relationship (same holder →
						// referenced object + field), don't ALSO draw the
						// navigation path edge - both used the same
						// source/target/label, so the pair rendered with two
						// identical connections after spawning a record from
						// the schema builder. The association edge wins.
						if (seenEdges.has(source.slice(2) + '|' + target.slice(2) + '|' + step.field)) {
return;
}
						const key = step.from + '|' + step.to + '|' + step.field + '|' + step.direction;
						if (seenEdges.has('pe_' + key)) {
return;
}
						seenEdges.add('pe_' + key);
						edgeKeys.push('pe_' + key);
						// Suppress matching ring spokes when the active is
						// on either end of this path edge - the solid path
						// edge already represents that FK.
						if (step.from === activeName || step.to === activeName) {
							seenEdges.add(step.from + '|' + step.to + '|' + step.field);
							seenEdges.add(step.to + '|' + step.from + '|' + step.field);
						}
						elements.push({
							group: 'edges',
							data: {
								id: 'pe_' + key,
								source,
								target,
								label: step.field,
								kind: 'fk',
							},
						});
					});
				}
			
				// Ring entries - every FK relationship the active object's
				// describe knows about, even ones not yet present in the
				// records graph. Skipped when the same (peer object, FK
				// field, direction) is already represented by a sel-to-sel
				// edge above. Each entry becomes a dashed ring node hanging
				// off the active. The parents/children/both segmented
				// control narrows ring entries by direction. Sel nodes
				// (objects already represented by records in the focused
				// component) are always kept regardless.
				const allObjsByName = new Map((Array.isArray(canvasState.allObjects) ? canvasState.allObjects : []).map((o) => [o.name, o]));
				const relFilter = canvasState.graphRelFilter || 'both';
				const filterText = (canvasState.graphFilterText || '').trim().toLowerCase();
				const matchesFilterText = (name) => {
					if (!filterText) {
return true;
}
					const lower = (name || '').toLowerCase();
					if (lower.includes(filterText)) {
return true;
}
					const meta = allObjsByName.get(name);
					if (meta && meta.label && meta.label.toLowerCase().includes(filterText)) {
return true;
}
					return false;
				};
				const ringKeys = [];
				const activeData = _resolveDescribeData(activeName);
				if (activeData) {
					const ringSeen = new Set();
					const pushRing = (peerObj, fieldName, direction) => {
						if (!peerObj || !fieldName) {
return;
}
						if (peerObj === activeName) {
return;
} // self-refs collapse to a single node - skip
						const peerIsSel = seenNames.has(peerObj);
						// Direction filter - only applies to ring entries
						// whose peer isn't already a sel node.
						if (!peerIsSel) {
							if (relFilter === 'parent' && direction !== 'parent') {
return;
}
							if (relFilter === 'child' && direction !== 'child') {
return;
}
						}
						// System-fields filter drops audit FKs (CreatedById,
						// LastModifiedById, …) when on. Sel peers (objects
						// already represented in the focused graph or path)
						// stay regardless.
						if (canvasState._systemFieldsFilter && SCHEMA_SYSTEM_FK_FIELDS.has(fieldName) && !peerIsSel) {
return;
}
						// Filter-text drops ring peers whose name/label
						// doesn't match the search box. Sel peers are
						// always kept regardless of the search.
						if (!peerIsSel && !matchesFilterText(peerObj)) {
return;
}
						// In override (navigation) mode, skip ring spokes
						// for peers that already render as sel nodes -
						// the path edge between them is drawn above.
						if (isOverride && peerIsSel) {
return;
}
						const ringKey = direction + '|' + peerObj + '|' + fieldName;
						if (ringSeen.has(ringKey)) {
return;
}
						ringSeen.add(ringKey);
						// Already drawn as a sel-to-sel FK edge? Skip the ring spoke.
						const fkA = (direction === 'parent')
							? activeName + '|' + peerObj + '|' + fieldName  // FK on active points at peer
							: peerObj + '|' + activeName + '|' + fieldName; // FK on peer points at active
						if (seenEdges.has(fkA)) {
return;
}
						ringKeys.push(ringKey);
						// Namespace ring + redge ids by the active. Without
						// this, two consecutive views that share peer rings
						// (e.g., Contact and Account both having User via
						// OwnerId) collide on id and the diff treats the
						// stale Contact ring as still wanted, leaving it
						// pinned at Contact's old position around the
						// vacated center.
						const nodeId = 'ring_' + activeName + '_' + ringKey;
						nodeKindById.set(nodeId, 'ring');
						elements.push({
							group: 'nodes',
							data: { id: nodeId, kind: 'ring', label: peerObj, ringObject: peerObj, ringField: fieldName, ringDirection: direction },
						});
						const edgeId = 'redge_' + activeName + '_' + ringKey;
						const source = direction === 'parent' ? 'o_' + activeName : nodeId;
						const target = direction === 'parent' ? nodeId : 'o_' + activeName;
						elements.push({
							group: 'edges',
							data: { id: edgeId, source, target, label: fieldName, kind: 'ring' },
						});
					};
					(activeData.parents || []).forEach((p) => pushRing(p.object, p.field, 'parent'));
					(activeData.children || []).forEach((c) => pushRing(c.object, c.field, 'child'));
				}
			
				// Sorted signature so the same component+rings always produce
				// the same string regardless of insertion order. Path edges
				// (schema navigation history) and the system-fields chip
				// state factor in too - toggling either should force a
				// re-layout, not just a kind update.
				const sig = [
					[].concat(objectNames).sort().join(','),
					[].concat(edgeKeys).sort().join(','),
					[].concat(ringKeys).sort().join(','),
					activeName,
					canvasState._schemaViewPathEdges.map((e) => e.key).sort().join(','),
					canvasState._systemFieldsFilter ? 'sys:on' : 'sys:off',
				].join('||');
				return { activeName, elements, nodeKindById, sig };
			}
			
			function renderCanvas() {
				const subbar = getGraph().querySelector('#graph-subbar');
				if (subbar) {
subbar.classList.remove('hidden');
}
				const picker = getGraph().querySelector('#base-picker');
				if (picker) {
picker.classList.add('hidden');
}
				const container = getGraph().querySelector('#graph-canvas-cy');
				if (!container || typeof cytoscape !== 'function') {
return;
}
			
				// Reset any schema-side navigation state (override center,
				// breadcrumb path, traversed FK edges) whenever the focused
				// record changes. Catches every selection-mutating path
				// - record click, marquee, empty-canvas tap, programmatic
				// resets - so unselecting and re-selecting always rebuilds
				// the schema from the records-derived view rather than
				// inheriting the prior navigation history.
				const currentFocusId = canvasState.bulkSelectedIds.size === 1
					? canvasState.bulkSelectedIds.values().next().value
					: null;
				if (currentFocusId !== canvasState._lastSchemaFocusRecId) {
					// An explicit Find-object override outlives changes
					// to the records-canvas focus - the user picked it
					// to be the schema's center, so deselecting the
					// records-canvas record shouldn't yank the schema
					// out from under them. Always reset the per-
					// navigation history (path / pathEdges); only clear
					// the centered object when no Find-object override
					// is active.
					canvasState._schemaViewPath = [];
					canvasState._schemaViewPathEdges = [];
				}
				canvasState._lastSchemaFocusRecId = currentFocusId;
			
				const view = _schemaViewFromSelection();
				if (!view) {
					// Tear down the expanded fields panel BEFORE destroying
					// the cy instance. The panel is a position-fixed element
					// appended to document.body, re-pinned by a cy 'render
					// position' listener; destroying cy without hiding it
					// leaves a frozen overlay floating on screen (and its
					// listener dangling on the dead instance), with
					// _expandedObjectName/_expandedCyNode still set so a
					// later expand mis-targets. Hide first so the .off()
					// runs against the live instance.
					_hideSchemaFieldsPanel();
					if (getCySchemaInstance()) {
						getCySchemaInstance().destroy();
						setCySchemaInstance(null);
					}
					canvasState._cySchemaSig = null;
					return;
				}
				// Defensive refetch - if the active object's describe
				// hasn't landed yet (e.g., navigation arrived before
				// fetchGraphData resolved), kick off a fetch and
				// re-render so the rings populate. Without this the
				// view paints with empty rings until something else
				// triggers another render.
				if (typeof fetchGraphData === 'function' && !_resolveDescribeData(view.activeName)) {
					const targetName = view.activeName;
					fetchGraphData(targetName).then(() => {
						if (canvasState.graphCache && canvasState.graphCache[targetName]) {
renderCanvas();
}
					}).catch((err) => console.warn('schema render: fetchGraphData failed for', targetName, err));
				}
			
				const sigChanged = view.sig !== canvasState._cySchemaSig;
				canvasState._cySchemaSig = view.sig;
				const SPOKE_RADIUS = 1.67 * SCHEMA_NODE_W;
			
				// Deterministic positions: sels arranged on a circle in
				// alphabetical order of object name. Same component →
				// same world layout no matter which record is focused
				// or whether cy was just rebuilt from scratch. Active
				// sits at its sorted slot; the camera animates to it
				// on every render so navigating reads as "same schema,
				// different center."
				const startAngle = -Math.PI / 2;
				const sortedSelNames = view.elements
					.filter((el) => el.group === 'nodes' && (el.data.kind === 'sel' || el.data.kind === 'sel-active'))
					.map((el) => el.data.objectName)
					.sort();
				const selN = sortedSelNames.length;
				const selPositionByName = new Map();
				sortedSelNames.forEach((name, i) => {
					if (selN === 1) {
						selPositionByName.set(name, { x: 0, y: 0 });
						return;
					}
					const angle = startAngle + (i / selN) * 2 * Math.PI;
					selPositionByName.set(name, {
						x: SPOKE_RADIUS * Math.cos(angle),
						y: SPOKE_RADIUS * Math.sin(angle),
					});
				});
				// When the user clicked a peer/ring node to navigate, the
				// tap handler stashed the clicked node's world position
				// in canvasState._pendingNavOriginPos. Use that as the new active's
				// position (and as the center for ring placement) so the
				// new active materializes EXACTLY where the user clicked
				// - no jump, no need for a follow-up camera pan. Falls
				// back to the alphabetical sel slot when there's no
				// stashed origin (initial render, programmatic nav).
				//
				// Snapshot into a local because the sigChanged branch
				// nulls out canvasState._pendingNavOriginPos partway through; we need
				// the value to survive through to the camera-animation
				// gate at the bottom.
				const navOrigin = canvasState._pendingNavOriginPos
					? { x: canvasState._pendingNavOriginPos.x, y: canvasState._pendingNavOriginPos.y }
					: null;
				// activePos resolution priority:
				//   1. navOrigin (fresh user-tap on a peer/ring)
				//   2. active's ACTUAL position in cy if it exists
				//      (preserved from prior renders)
				//   3. computed alphabetical slot (initial render only)
				//
				// Without (2), filter-change re-renders (no nav, no
				// navOrigin) would use the alphabetical slot - which is
				// usually NOT where the active visually sits - and new
				// ring nodes get placed around a phantom position. That
				// produces the "far away" placement the user sees.
				let activePos;
				if (navOrigin) {
					activePos = navOrigin;
				} else if (getCySchemaInstance()) {
					const cyActive = getCySchemaInstance().getElementById('o_' + view.activeName);
					if (cyActive && cyActive.length) {
						activePos = cyActive.position();
					}
				}
				if (!activePos) {
					activePos = selPositionByName.get(view.activeName) || { x: 0, y: 0 };
				}
				const ringNodes = view.elements.filter((el) => el.group === 'nodes' && el.data.kind === 'ring');
				const ringN = ringNodes.length;
				// Apply positions: sels by name, rings around active,
				// spawn-btns relative to their parent sel. The new
				// sel-active overrides its alphabetical slot with the
				// click-origin so it lands exactly where the user
				// tapped (matches the activePos above).
				view.elements.forEach((el) => {
					if (el.group !== 'nodes') {
return;
}
					if (el.data.kind === 'sel-active' && navOrigin) {
						el.position = { x: navOrigin.x, y: navOrigin.y };
						return;
					}
					if (el.data.kind === 'sel' || el.data.kind === 'sel-active') {
						const pos = selPositionByName.get(el.data.objectName);
						if (pos) {
el.position = { x: pos.x, y: pos.y };
}
					}
				});
				// Rotate the ring's start angle to maximize angular
				// distance from already-positioned nodes (other sels +
				// any ring nodes that survived the diff). Without this,
				// rings always start at -π/2 (top) and new nodes can
				// land directly on top of an existing peer that
				// happens to sit there - making the schema feel
				// "crowded on one side, empty on another" even when
				// there's plenty of room. We pick the rotation that
				// puts the closest ring slot as far as possible from
				// the closest existing node.
				//
				// Algorithm: for each candidate rotation (sampled at
				// 7.5° increments), compute the minimum angular
				// distance between any ring slot and any existing
				// node's angular position relative to the active.
				// Pick the rotation that maximizes that minimum.
				// Cheap (24 samples × small N) and robust enough.
				function _bestRingRotation(activePos, ringN, otherNodes) {
					if (ringN === 0) {
return startAngle;
}
					const blockedAngles = [];
					otherNodes.forEach((n) => {
						if (!n.position) {
return;
}
						const dx = n.position.x - activePos.x;
						const dy = n.position.y - activePos.y;
						if (dx === 0 && dy === 0) {
return;
}
						blockedAngles.push(Math.atan2(dy, dx));
					});
					if (blockedAngles.length === 0) {
return startAngle;
}
					let bestRotation = startAngle;
					let bestMinDist = -1;
					const TWO_PI = 2 * Math.PI;
					const angularDist = (a, b) => {
						const d = Math.abs(((a - b) % TWO_PI + TWO_PI) % TWO_PI);
						return Math.min(d, TWO_PI - d);
					};
					const samples = 48;
					for (let s = 0; s < samples; s++) {
						const rot = startAngle + (s / samples) * TWO_PI;
						let minDist = Infinity;
						for (let i = 0; i < ringN; i++) {
							const slot = rot + (i / ringN) * TWO_PI;
							for (const blocked of blockedAngles) {
								const d = angularDist(slot, blocked);
								if (d < minDist) {
minDist = d;
}
							}
						}
						if (minDist > bestMinDist) {
							bestMinDist = minDist;
							bestRotation = rot;
						}
					}
					return bestRotation;
				}
				// Existing nodes that block angular slots. CRITICAL:
				// these positions must match what the user actually
				// SEES, not what view.elements computed for this
				// render. With the spatial-frame fix in place,
				// existing nodes stay at their preserved cy positions
				// - view.elements has them at the freshly-computed
				// alphabetical slots, but those slots are never
				// applied to cy for existing nodes. If we used
				// view.elements' positions here, the algorithm would
				// avoid ghost positions and still overlap real ones.
				//
				// So: prefer cy's actual position for existing nodes;
				// fall back to view.elements' position only for nodes
				// that are new in this render (no cy record yet).
				const otherPositionedNodes = [];
				view.elements.forEach((el) => {
					if (el.group !== 'nodes') {
return;
}
					if (el.data.kind === 'spawn-btn' || el.data.kind === 'ring') {
return;
}
					if (el.data.id === 'o_' + view.activeName) {
return;
}
					let position = null;
					if (getCySchemaInstance()) {
						const cyEl = getCySchemaInstance().getElementById(el.data.id);
						if (cyEl && cyEl.length) {
							position = cyEl.position();
						}
					}
					if (!position) {
position = el.position;
}
					if (position) {
otherPositionedNodes.push({ position });
}
				});
				const ringStartAngle = _bestRingRotation(activePos, ringN, otherPositionedNodes);
				ringNodes.forEach((node, i) => {
					const angle = ringN === 0 ? 0 : ringStartAngle + (i / ringN) * 2 * Math.PI;
					node.position = {
						x: activePos.x + SPOKE_RADIUS * Math.cos(angle),
						y: activePos.y + SPOKE_RADIUS * Math.sin(angle),
					};
				});
				view.elements.forEach((el) => {
					if (el.group !== 'nodes' || el.data.kind !== 'spawn-btn') {
return;
}
					const parentEl = view.elements.find((p) => (
						p.group === 'nodes' && p.data.id === 'o_' + el.data.spawnFor
					));
					const parentPos = parentEl && parentEl.position
						? parentEl.position
						: activePos;
					el.position = {
						x: parentPos.x + SCHEMA_SPAWN_OFFSET_X,
						y: parentPos.y + SCHEMA_SPAWN_OFFSET_Y,
					};
				});
				view.elements.forEach((el) => {
					if (el.group !== 'nodes' || el.data.kind !== 'expand-btn') {
return;
}
					const parentEl = view.elements.find((p) => (
						p.group === 'nodes' && p.data.id === 'o_' + el.data.expandFor
					));
					const parentPos = parentEl && parentEl.position
						? parentEl.position
						: activePos;
					el.position = {
						x: parentPos.x + SCHEMA_EXPAND_OFFSET_X,
						y: parentPos.y + SCHEMA_EXPAND_OFFSET_Y,
					};
				});
			
				// Tracks whether the new active is freshly added in this
				// render. True when:
				//   * cy was just created (every node is new); OR
				//   * the diff branch added 'o_<activeName>' for the
				//     first time (e.g., user navigated to an object via
				//     a ring node that hadn't been a sel before).
				// False when the active was already visible before the
				// click. The camera animation at the bottom only runs
				// when this is true - keeps the user's spatial frame
				// untouched on peer-to-peer navigation.
				let activeNodeIsNewlyAdded = false;
				// Tracks fresh creation so the post-render rAF can pick a
				// sane initial zoom. Cy's preset layout auto-fits on
				// creation, which for a single-node view (active object
				// with no ring children yet, e.g. describe still in
				// flight) blows the node up to fill the entire viewport.
				// We override that with an explicit zoom below.
				let cyJustCreated = false;
			
				if (!getCySchemaInstance()) {
					activeNodeIsNewlyAdded = true;
					cyJustCreated = true;
					setCySchemaInstance(cytoscape({
						container,
						elements: view.elements,
						style: SCHEMA_STYLE,
						// fit: false disables the preset layout's initial
						// zoom-to-fit step. Without this, a single-node
						// view (Find object → Account, before ring
						// describes arrive) blows the node up to fill
						// the entire viewport for one frame before the
						// rAF zoom override below shrinks it back -
						// visible as a "huge then snaps to normal" flash.
						// The rAF callback still sets the final zoom;
						// this just prevents the bad intermediate frame.
						layout: { name: 'preset', fit: false },
						boxSelectionEnabled: false,
						userPanningEnabled: false,
						// Match the single-node zoom the rAF callback
						// will apply, so cy's first paint matches the
						// final state.
						zoom: 0.7,
					}));
					// Defensive: ensure every spawn-btn satellite is
					// ungrabbable and unselectable. The element-level
					// grabbable: false is the primary fix, but this
					// covers any nodes that might have been hydrated
					// from a stale element shape (e.g., older saved
					// state) so a small wiggle on click never gets
					// reinterpreted as a drag.
					getCySchemaInstance().nodes('[kind = "spawn-btn"], [kind = "expand-btn"]').ungrabify().unselectify();
					// Crow-foot/bar markers via the SVG overlay.
					attachCyEdgeMarkers(getCySchemaInstance(), container);
					// Middle-click drag pans the schema canvas - same
					// gesture as the records canvas. Cy's built-in
					// left-drag pan stays disabled; left-click reserved
					// for navigation taps.
					attachCyMiddleClickPan(getCySchemaInstance(), container);
					// Plain mouse-wheel zoom - without this, the schema
					// explorer popout's only zoom path is the toolbar
					// +/- buttons, which is jarring vs the records
					// canvas where wheel-zoom is built in.
					attachCyWheelZoom(getCySchemaInstance(), container);
					// Suppress the browser context menu over the schema
					// canvas. Right-click here doesn't have a useful
					// in-app meaning (no per-node menu wired up), and
					// the default browser menu obscures the canvas
					// while letting the user accidentally Inspect
					// Element / Save Image. Cleaner to just disable.
					container.addEventListener('contextmenu', (e) => e.preventDefault());
			
					// Spawn-btn + expand-btn satellites follow their
					// parent sel as it's dragged or repositioned.
					getCySchemaInstance().on('position', 'node', (evt) => {
						const target = evt.target;
						const dd = target.data();
						if (dd.kind !== 'sel' && dd.kind !== 'sel-active') {
return;
}
						const objName = dd.objectName;
						if (!objName) {
return;
}
						const cyInst = getCySchemaInstance();
						const p = target.position();
						const spawn = cyInst.getElementById('spawn_' + objName);
						if (spawn && spawn.length) {
							spawn.position({
								x: p.x + SCHEMA_SPAWN_OFFSET_X,
								y: p.y + SCHEMA_SPAWN_OFFSET_Y,
							});
						}
						const expand = cyInst.getElementById('expand_' + objName);
						if (expand && expand.length) {
							expand.position({
								x: p.x + SCHEMA_EXPAND_OFFSET_X,
								y: p.y + SCHEMA_EXPAND_OFFSET_Y,
							});
						}
					});
			
					// Double-tap an object card → toggle the expanded
					// fields panel. The panel renders next to the cy
					// node and lists every field with name/label/type,
					// fetched via ensureDescribe.
					getCySchemaInstance().on('dbltap', 'node', (evt) => {
						const d = evt.target.data();
						if (!d || (d.kind !== 'sel' && d.kind !== 'sel-active')) {
return;
}
						const objectName = d.objectName;
						if (!objectName) {
return;
}
						if (_expandedObjectName === objectName) {
							_hideSchemaFieldsPanel();
							return;
						}
						_showSchemaFieldsPanel(objectName, evt.target);
					});
					// Background tap collapses the expanded panel. Cy
					// fires 'tap' with target === cy when the user
					// clicks empty canvas.
					getCySchemaInstance().on('tap', (evt) => {
						if (evt.target === getCySchemaInstance()) {
_hideSchemaFieldsPanel();
}
					});

					// Tap on a peer node navigates the active. Wired
					// once at creation; reads current state from cy on
					// each click instead of closing over a stale view.
					getCySchemaInstance().on('tap', 'node', (evt) => {
						const d = evt.target.data();
						// Spawn-btn satellite - fires the records-canvas
						// spawn for its parent sel.
						if (d && d.kind === 'spawn-btn') {
							if (d.spawnFor) {
_spawnRecordFromSchemaObject(d.spawnFor);
}
							return;
						}
						// Expand-btn satellite - toggles the expanded
						// fields panel for its parent sel. The dbltap
						// entry point on the card itself still works
						// as a redundant affordance.
						if (d && d.kind === 'expand-btn') {
							const objectName = d.expandFor;
							if (!objectName) {
return;
}
							const parent = getCySchemaInstance().getElementById('o_' + objectName);
							if (!parent || parent.length === 0) {
return;
}
							if (_expandedObjectName === objectName) {
								_hideSchemaFieldsPanel();
							} else {
								_showSchemaFieldsPanel(objectName, parent);
							}
							return;
						}
						const targetName = d && (d.objectName || d.ringObject);
						if (!targetName) {
return;
}
						const cyActive = getCySchemaInstance().nodes().filter((n) => n.data('kind') === 'sel-active').first();
						const previousActive = cyActive && cyActive.length
							? (cyActive.data('objectName') || null)
							: null;
						if (!previousActive || previousActive === targetName) {
return;
}
						const ringField = d.ringField || null;
						const ringDirection = d.ringDirection || null;
						// Stash the exact world position of the clicked
						// node so the next render parks the new active
						// there, even when multiple peers share an
						// object name (e.g., User via OwnerId / CreatedById
						// / LastModifiedById). Without this the camera
						// glides to whichever peer was iterated first
						// in the position cache, which often disagrees
						// with where the user clicked.
						const tappedPos = evt.target.position();
						canvasState._pendingNavOriginPos = { x: tappedPos.x, y: tappedPos.y };
						// Navigating to a different object - collapse
						// any open fields panel so it doesn't end up
						// pointing at a node that's about to disappear.
						_hideSchemaFieldsPanel();
						const cached = _resolveDescribeData(targetName);
						const apply = () => {
							if (!canvasState._schemaViewPath.includes(previousActive)) {
								canvasState._schemaViewPath.push(previousActive);
							}
							if (ringField && ringDirection) {
								const stepKey = previousActive + '|' + targetName + '|' + ringField + '|' + ringDirection;
								if (!canvasState._schemaViewPathEdges.some((e) => e.key === stepKey)) {
									canvasState._schemaViewPathEdges.push({
										key: stepKey,
										from: previousActive,
										to: targetName,
										field: ringField,
										direction: ringDirection,
									});
								}
							}
							canvasState._schemaViewObject = targetName;
							renderCanvas();
						};
						if (cached) {
							apply();
						} else if (typeof fetchGraphData === 'function') {
							fetchGraphData(targetName).then(apply).catch((err) => {
								console.warn('schema nav: fetchGraphData failed for', targetName, err);
							});
						}
					});
				} else if (sigChanged) {
					// See comment block above the camera-animation code
					// at the bottom of renderCanvas for the spatial-frame
					// design. Short version: existing nodes keep their
					// positions so navigation never reflows the layout;
					// new nodes appear at freshly-computed ring positions.
					canvasState._pendingNavOriginPos = null;
					const wantedIds = new Set(view.elements.map((e) => e.data.id));
					const obsolete = getCySchemaInstance().elements().filter((el) => !wantedIds.has(el.id()));
					if (obsolete.length) {
obsolete.remove();
}
					const activeId = 'o_' + view.activeName;
					view.elements.forEach((el) => {
						const cyEl = getCySchemaInstance().getElementById(el.data.id);
						if (!cyEl || !cyEl.length) {
							// New node - add with the computed position.
							// If this is the new active, flag it so the
							// camera animation below pans us to it.
							if (el.data.id === activeId) {
activeNodeIsNewlyAdded = true;
}
							getCySchemaInstance().add(el);
						}
						// Existing node - leave its position alone.
					});
					view.nodeKindById.forEach((kind, id) => {
						const el = getCySchemaInstance().getElementById(id);
						if (el && el.length && el.data('kind') !== kind) {
el.data('kind', kind);
}
					});
					// Re-apply the spawn-btn grabbable/selectable=false
					// to any nodes added in this diff pass (cy.add
					// honours element-level grabbable, but covers
					// stragglers from older saved cy states).
					getCySchemaInstance().nodes('[kind = "spawn-btn"], [kind = "expand-btn"]').ungrabify().unselectify();
					if (typeof redrawCyEdgeMarkers === 'function') {
						redrawCyEdgeMarkers(getCySchemaInstance(), container);
					}
				} else {
					// No topology change - only sel-active marker may have
					// shifted. Update kinds in place.
					view.nodeKindById.forEach((kind, id) => {
						const el = getCySchemaInstance().getElementById(id);
						if (el && el.length && el.data('kind') !== kind) {
el.data('kind', kind);
}
					});
				}
			
				// Belt: re-park every card's +/expand satellites at its corners
				// from the card's ACTUAL position. The incremental 'position'
				// handler only fires on drags, so a navigation re-layout (which
				// repositions cards without per-node 'position' events) could
				// otherwise strand a card's satellites in the wrong spot until
				// the card is clicked. Running this each render guarantees they
				// never drift. Skips satellites hidden while their card is
				// expanded (the collapse path re-parks those).
				(function _parkAllSatellites() {
					const cyI = getCySchemaInstance();
					if (!cyI) {
						return;
					}
					cyI.nodes('[kind = "sel"], [kind = "sel-active"]').forEach((node) => {
						const objName = node.data('objectName');
						if (!objName) {
							return;
						}
						const p = node.position();
						const sp = cyI.getElementById('spawn_' + objName);
						if (sp && sp.length && !sp.data('expandedHidden')) {
							sp.position({ x: p.x + SCHEMA_SPAWN_OFFSET_X, y: p.y + SCHEMA_SPAWN_OFFSET_Y });
						}
						const ex = cyI.getElementById('expand_' + objName);
						if (ex && ex.length && !ex.data('expandedHidden')) {
							ex.position({ x: p.x + SCHEMA_EXPAND_OFFSET_X, y: p.y + SCHEMA_EXPAND_OFFSET_Y });
						}
					});
				})();

				requestAnimationFrame(() => {
					if (!getCySchemaInstance()) {
return;
}
					getCySchemaInstance().resize();
					const activeNode = getCySchemaInstance().getElementById('o_' + view.activeName);
					if (!activeNode || !activeNode.length) {
						getCySchemaInstance().fit(undefined, 60);
						return;
					}
					// On fresh creation, cy's preset-layout auto-fit
					// produces a giant node when only the active is in
					// the view (no ring children yet). Pick zoom
					// explicitly: single node → fixed 0.7 with breathing
					// room, multi-node → fit but cap at 1 so smaller
					// rings don't balloon either. Only do this on
					// creation; the diff branch must preserve the
					// existing spatial frame.
					if (cyJustCreated) {
						const allNodes = getCySchemaInstance().nodes();
						if (allNodes.length <= 1) {
							getCySchemaInstance().zoom(0.7);
						} else {
							getCySchemaInstance().fit(undefined, 80);
							if (getCySchemaInstance().zoom() > 1) {
getCySchemaInstance().zoom(1);
}
						}
						getCySchemaInstance().center(activeNode);
					}
					getCySchemaInstance().elements().unselect();
					activeNode.select();
					// Spatial-frame preservation. When the user clicks a
					// peer that was already on screen, we want NOTHING
					// to visually move except the active-marker badge.
					// World positions don't change (the diff branch
					// keeps existing nodes in place), and the camera
					// stays put. From the user's perspective: the node
					// they clicked just got the active style, the rest
					// of the layout is exactly where it was.
					//
					// We only animate the camera when the new active is
					// NEWLY added (cy first creation, or navigation to
					// an object that wasn't visible before). Otherwise
					// the user has been spatially oriented around the
					// existing layout and a camera move would feel like
					// the world reflowing - the original bug.
					//
					// Cy's animate() takes (animation, options). Putting
					// duration/easing inside the first arg silently
					// causes an instant transition (the bug that made
					// the previous fix "snap" instead of "pan").
					//
					// Smooth pan to the new active when it's freshly
					// added. With the navOrigin fix in place, the
					// active starts at the user's click position; the
					// camera then glides to center on it. Result reads
					// as "follow the click" - Account smoothly slides
					// off to the side as the camera tracks Case to
					// center, no teleport or layout reflow.
					//
					// setTimeout(0) defers the animate to the next
					// event-loop tick. Without it, the FIRST animate
					// after cy creation runs abruptly - cy's animation
					// pipeline appears to need one tick to stabilize
					// after layout settles. Subsequent animates work
					// fine inline; deferring all of them is the
					// uniform fix that costs nothing observable.
					if (activeNodeIsNewlyAdded) {
						const targetActiveId = 'o_' + view.activeName;
						setTimeout(() => {
							if (!getCySchemaInstance()) {
return;
}
							const node = getCySchemaInstance().getElementById(targetActiveId);
							if (!node || !node.length) {
return;
}
							getCySchemaInstance().animate(
								{ center: { eles: node } },
								{ duration: 800, easing: 'ease-out' },
							);
						}, 0);
					}
				});
			}
			
			// `onRemove` is a function; passing one makes the node removable (shows ×).
			// `cloneOpts` is { count, onClone }; passing it adds a "+ record (N)"
			// button on the card that calls onClone() when clicked. Used on
			// selected-object cards (center + others) so the affordance to
			// spawn a record sits on the schema object itself instead of in
			// the toolbar - spatially correct and frees toolbar space.
			// Callers are responsible for the removal semantics (remove from
			// selection vs hide from ring) so the × behavior is unambiguous even
			// when the same object type has multiple selection entries.
			function makeNode(label, name, relation, x, y, variant, onRemove, cloneOpts, loading) {
				const div = document.createElement('div');
				div.className = 'graph-node ' + (variant || '') + (loading ? ' loading' : '');
				div.style.left = x + 'px';
				div.style.top = y + 'px';
				const removable = typeof onRemove === 'function';
				const clonable = !!(cloneOpts && typeof cloneOpts.onClone === 'function');
				let html = '';
				if (removable) {
					const title = variant === 'unselected' ? 'Hide from view' : 'Remove from selection';
					html += '<button class="node-remove" data-node-remove title="' + title + '">\u00D7</button>';
				}
				// Show label (always) + API name (when distinct). The relationship
				// caption used to live as a third line here; it's now drawn on
				// the spoke line instead so the node body stays compact. The
				// full relation string is kept in the title attr for hover.
				html += '<div class="obj-label">' + escapeHtml(label) + '</div>';
				if (name && name !== label) {
html += '<div class="obj-name">' + escapeHtml(name) + '</div>';
}
				// Spinner appears while the describe/relationship fetch is in
				// flight so users have visible feedback that a node is still
				// loading rather than mysteriously empty.
				if (loading) {
					html += '<div class="graph-node-loading" aria-label="Loading related objects">' +
						'<span class="graph-node-spinner"></span>' +
					'</div>';
				}
				if (clonable) {
					const count = Number(cloneOpts.count || 0);
					html += '<button class="node-clone" data-node-clone title="Add a record of ' + escapeHtml(label) + ' to the canvas">' +
						'+ record <span class="node-clone-count">' + count + '</span>' +
					'</button>';
				}
				div.innerHTML = html;
				if (relation) {
div.title = (div.title ? div.title + ' -' : '') + relation;
}
				if (loading) {
div.title = (div.title ? div.title + ' -' : '') + 'Loading related objects\u2026';
}
				if (removable) {
					const btn = div.querySelector('[data-node-remove]');
					btn.addEventListener('click', (e) => {
 e.stopPropagation(); onRemove(); 
});
				}
				if (clonable) {
					const cb = div.querySelector('[data-node-clone]');
					if (cb) {
cb.addEventListener('click', (e) => {
 e.stopPropagation(); cloneOpts.onClone(); 
});
}
				}
				return div;
			}
			
			

			return {
				renderCanvas: renderCanvas,
				makeNode: makeNode,
			};
		},
	};
})();
