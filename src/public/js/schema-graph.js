// Schema graph view: open/close/fetch + view transition glue.
//
// The schema canvas (left panel) and bulk canvas (right panel) share
// the same .graph-overlay DOM. This module owns the entry points that
// flip between the two and load the data backing the schema side:
//
//   openGraph(name): wipes canvas state, sets schema view,
//                          loads the named object's describe-style
//                          graph, kicks off the first render.
//   closeGraph(): hides the overlay and clears selection.
//   fetchGraphData(name): cached describe-graph fetch; translates
//                          SF-side access errors into a `code:
//                          'object-no-access'` flagged Error so
//                          callers can render a clean message.
//   setGraphView(view): flips between 'bulk' and 'schema' renders.
//   _runAfterSchemaTransition(cb)
//     defers `cb` until the schema panel's
//                          flex-basis slide-in/out transition ends;
//                          used by collapse/expand to defer cy.resize
//                          and cy.fit so the schema doesn't land
//                          off-centre.
//
// The chip updaters (_updateSchemaSystemChip + …FieldsChip) stay in
// app.js because they're tied to parse-time addEventListener wiring
// against the chip buttons; lifting them out would invert the load
// order.
//
// Dependencies passed to mount():
//   canvasState: shared canvas state. openGraph wipes 15+ pieces
//                     of bulk/schema state; closeGraph clears the
//                     selection arrays. fetchGraphData stores into
//                     graphCache. All ten schema-graph view lets have
//                     already migrated here via the Phase 3 prep.
//   csrfFetch: fetch wrapper.
//   escapeHtml: for the load-error banner.
//   addToSelection: async; loads the initial schema selection on
//                     openGraph.
//   renderAll: full-canvas paint after openGraph succeeds.
//   renderBulkView: paint helper; setGraphView routes here when
//                     view='bulk' and selection is non-empty.
//   renderCanvas: schema-canvas paint helper; setGraphView routes
//                     here in schema view (or as bulk's fallback when
//                     selection is empty).
//   getGraph: returns the .graph-overlay DOM element. Wrapped
//                     because the element is built lazily inside the
//                     IIFE in app.js, after this module mounts.
//
// Public API (returned from mount):
//   openGraph, closeGraph, fetchGraphData, setGraphView,
//   _runAfterSchemaTransition.
//
// Exposed as window.OrgLoom.schemaGraph. Load order: before app.js.

(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.schemaGraph = {
		mount: function mount(deps) {
			if (!deps || !deps.canvasState || !deps.csrfFetch || !deps.escapeHtml
				|| !deps.addToSelection || !deps.renderAll
				|| !deps.renderBulkView || !deps.renderCanvas
				|| !deps.getGraph) {
				throw new Error('schema-graph.mount: missing required deps');
			}
			const canvasState = deps.canvasState;
			const csrfFetch = deps.csrfFetch;
			const escapeHtml = deps.escapeHtml;
			const addToSelection = deps.addToSelection;
			const renderAll = deps.renderAll;
			const renderBulkView = deps.renderBulkView;
			const renderCanvas = deps.renderCanvas;
			const getGraph = deps.getGraph;
			// Cache successful responses in graphCache, and share a pending
			// request while navigation/render paths ask for the same object.
			// This keeps rapid ring taps from consuming duplicate Salesforce
			// describe calls without making failures sticky.
			const graphRequests = new Map();

			function _runAfterSchemaTransition(cb) {
				const target = getGraph().querySelector('.graph-canvas-cy') || getGraph().querySelector('.graph-canvas');
				if (!target) {
 cb(); return; 
}
				let fired = false;
				const fire = () => {
					if (fired) {
return;
}
					fired = true;
					target.removeEventListener('transitionend', handler);
					cb();
				};
				const handler = (ev) => {
					if (ev.target !== target) {
return;
}
					if (ev.propertyName !== 'flex-basis') {
return;
}
					fire();
				};
				target.addEventListener('transitionend', handler);
				setTimeout(fire, 280);
			}
			
			async function openGraph(objectName) {
				// Suppress the first view transition on open: there's no
				// previous canvas state to morph from, and letting the
				// browser animate the whole overlay flying in looks worse
				// than a plain cut.
				canvasState._suppressNextViewTransition = true;
				getGraph().classList.remove('hidden');
				canvasState.selectedObjects = [];
				canvasState.selectedIdSeq = 1;
				canvasState.activeIndex = 0;
				canvasState.hiddenObjects.clear();
				canvasState.graphFilterText = '';
				canvasState.graphRelFilter = 'parent';
				canvasState.graphZoom = 1;
				canvasState.bulkRecords = [];
				canvasState.bulkAssociations = [];
				canvasState.bulkIdSeq = 1;
				canvasState.bulkSelectedIds = new Set();
				canvasState.bulkSelectedEdgeId = null;
				canvasState.bulkClipboard = null;
				canvasState.bulkInitialized = false;
				canvasState._bulkUserDeleted = false;
				canvasState._lastBulkZoomSig = null;
				canvasState._bulkSeenIds = null;
				canvasState._prefetchedTypeNodeKeys.clear();
				canvasState._renderedRecIds.clear();
				canvasState.bulkZoom = 1;
				setGraphView('schema');
				const fi = getGraph().querySelector('#graph-filter-input');
				if (fi) {
fi.value = '';
}
				const fc = getGraph().querySelector('[data-graph-filter-clear]');
				if (fc) {
fc.style.display = 'none';
}
				getGraph().querySelector('#graph-nodes').innerHTML = '<div class="graph-empty">Loading…</div>';
				getGraph().querySelector('#graph-edges').innerHTML = '';
				try {
					await addToSelection(objectName);
					renderAll();
				} catch (err) {
					getGraph().querySelector('#graph-nodes').innerHTML =
						'<div class="graph-empty load-error">Failed to load: ' + escapeHtml(err.message) + '</div>';
				}
			}
			
			function closeGraph() {
				getGraph().classList.add('hidden');
				canvasState.selectedObjects = [];
				canvasState.selectedIdSeq = 1;
				canvasState.activeIndex = 0;
				canvasState.hiddenObjects.clear();
			}
			
			async function fetchGraphData(name) {
				if (canvasState.graphCache[name]) {
return canvasState.graphCache[name];
}
				if (graphRequests.has(name)) {
					return graphRequests.get(name);
				}
				const request = (async () => {
				const resp = await csrfFetch('/api/objects/' + encodeURIComponent(name) + '/graph');
				if (!resp.ok) {
					// Salesforce reports "you can't see this object" as a
					// describe failure, surfaced here as a 500 with a
					// "does not exist" / invalid-type body. Translate that
					// into a clear, flagged access error so callers can show
					// something better than the raw "Internal Server Error"
					// status text. Non-access failures keep the server's
					// message (still better than statusText alone).
					let serverMsg = '';
					try {
 const body = await resp.json(); serverMsg = (body && body.message) || ''; 
} catch (_) {}
					const noAccess = resp.status === 403 || resp.status === 404
						|| /does not exist|invalid_type|insufficient access|not accessible|no such sobject|is not supported/i.test(serverMsg);
					const err = new Error(noAccess
						? 'your Salesforce user doesn’t have access to this object'
						: (serverMsg || resp.statusText));
					if (noAccess) {
err.code = 'object-no-access';
}
					throw err;
				}
				const data = await resp.json();
				canvasState.graphCache[name] = data;
				return data;
				})();
				graphRequests.set(name, request);
				try {
					return await request;
				} finally {
					graphRequests.delete(name);
				}
			}
			
			function setGraphView(view) {
				if (view === 'bulk' && canvasState.selectedObjects.length > 0) {
renderBulkView();
} else {
renderCanvas();
}
			}

			return {
				openGraph: openGraph,
				closeGraph: closeGraph,
				fetchGraphData: fetchGraphData,
				setGraphView: setGraphView,
				_runAfterSchemaTransition: _runAfterSchemaTransition,
			};
		},
	};
})();
