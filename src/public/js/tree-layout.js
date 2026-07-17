// Hierarchy-aware layout for newly-added records on the records canvas.
// Originally lived inline in linked-csv.js; extracted here so SOQL import,
// AI generation, and any other bulk-add path can get the same treatment
// without duplicating the algorithm.
//
// Pipeline:
//   1. Inspect the FK edges between just-added records to pick the layout
//      branch:
//        a. Tree (>=5 nodes with FK edges) → breadthfirst per connected
//           component, with the "no outgoing FK" record(s) as roots.
//           Components are 2D-packed side-by-side and wrapped into rows
//           so a single 60-Contact tree doesn't form a 33000px-wide
//           strip.
//        b. Sparse (no edges, or fewer than 5 nodes) → cose force-
//           directed fallback.
//   2. Fit the viewport with a [0.4, 1.0] zoom clamp so small/huge
//      imports stay legible.
//   3. Sync the laid-out cy positions back to canvasState.bulkRecords so
//      autosave + future renders agree with what was just drawn.
//
// Edge orientation note: edges go child→parent (Contact.AccountId points
// at the Account). A "root" in the tree sense is therefore a node with
// no OUTGOING edges (referenced by children but doesn't reference
// anything itself). `directed: false` in the breadthfirst params lets
// us nominate roots explicitly without cytoscape flipping them.
//
// Exposed as window.OrgLoom.treeLayout. Load order: before app.js.

(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.treeLayout = {
		mount: function mount(deps) {
			if (!deps || !deps.canvasState || !deps.getCyInstance) {
				throw new Error('tree-layout.mount: missing required deps (canvasState, getCyInstance)');
			}
			const canvasState = deps.canvasState;
			const getCyInstance = deps.getCyInstance;

			// Re-layout the cy nodes whose recId is in newRecIds. Caller
			// must have rendered the new records into cy already (typical
			// flow: push into canvasState, call renderBulkView, then call
			// this).
			//
			// newRecIds: Set<number> of canvasState.bulkRecords[].id
			//            values that were just added.
			function relayoutNewRecords(newRecIds) {
				const _cyInstance = getCyInstance();
				if (!_cyInstance || !newRecIds || newRecIds.size === 0) {
return;
}

				_cyInstance.stop(true, true);
				_cyInstance.elements().stop(true, true);
				_cyInstance.resize();

				const newCyNodes = _cyInstance.nodes().filter((n) => newRecIds.has(n.data('recId')));
				const newCyEdges = _cyInstance.edges().filter((e) =>
					newRecIds.has(e.source().data('recId'))
					&& newRecIds.has(e.target().data('recId'))
				);
				const newEles = newCyNodes.union(newCyEdges);
				// Compute the bounding box of existing records (those NOT
				// in newRecIds and not type-node / satellite nodes) so
				// imports can be placed adjacent to them. Right-then-
				// below preference: imports start to the RIGHT of
				// existing (aligned with their top edge), and only wrap
				// down to a new row when the right column overflows.
				// Earlier behavior started imports at world (0, 0)
				// regardless, which dropped them down-and-left of
				// existing, overlapping in the worst case, and
				// always visually disconnected from the work the
				// visitor was looking at.
				const EXISTING_GUTTER = 80;
				const existingCyNodes = _cyInstance.nodes().filter((n) => {
					const recId = n.data('recId');
					if (recId == null) {
return false;
}
					return !newRecIds.has(recId);
				});
				let existingMinX = Infinity, existingMaxX = -Infinity;
				let existingMinY = Infinity, existingMaxY = -Infinity;
				existingCyNodes.forEach((n) => {
					const bb = n.boundingBox();
					if (bb.x1 < existingMinX) {
existingMinX = bb.x1;
}
					if (bb.x2 > existingMaxX) {
existingMaxX = bb.x2;
}
					if (bb.y1 < existingMinY) {
existingMinY = bb.y1;
}
					if (bb.y2 > existingMaxY) {
existingMaxY = bb.y2;
}
				});
				const hasExisting = existingCyNodes.length > 0 && existingMaxX > -Infinity;
				const xStart = hasExisting ? existingMaxX + EXISTING_GUTTER : 0;
				const yStart = hasExisting ? existingMinY : 0;
				const hasEdges = newCyEdges.length > 0;
				let rootCyNodes = newCyNodes.filter((n) => n.outgoers('edge').length === 0);
				// Cycle fallback: every node has at least one outgoing
				// edge (rare: User.OwnerId loops, custom cross-references).
				// Pick the highest-degree node as a synthetic root so
				// breadthfirst has somewhere to anchor.
				if (rootCyNodes.length === 0 && newCyNodes.length > 0) {
					const sorted = newCyNodes.toArray().sort((a, b) => b.degree() - a.degree());
					rootCyNodes = sorted.length > 0 ? _cyInstance.collection([sorted[0]]) : newCyNodes;
				}
				const useTreeLayout = newCyNodes.length >= 5 && hasEdges && rootCyNodes.length > 0;
				if (useTreeLayout) {
					// One breadthfirst run per connected component so each
					// tree keeps its own top→bottom hierarchy. The trees
					// are then 2D-packed below.
					const components = newEles.components();
					const compLaidOut = [];
					for (const comp of components) {
						const compNodes = comp.nodes();
						let compRoots = compNodes.filter((n) => n.outgoers('edge').length === 0);
						if (compRoots.length === 0 && compNodes.length > 0) {
							const sorted = compNodes.toArray().sort((a, b) => b.degree() - a.degree());
							compRoots = _cyInstance.collection([sorted[0]]);
						}
						const compLayout = comp.layout({
							name: 'breadthfirst',
							animate: false,
							fit: false,
							padding: 0,
							// directed:false flattens our child→parent
							// arrows so explicit roots can be placed at
							// the top of the tree.
							directed: false,
							roots: compRoots.map((n) => n.id()),
							// 1.15 keeps levels close together:
							// previously 1.4, which left obvious gaps
							// between parents and children that read
							// as "these aren't really connected."
							spacingFactor: 1.15,
							avoidOverlap: true,
							// Wide levels (e.g. 60 Contacts under one
							// Account) wrap into a multi-row grid.
							grid: true,
							maximalAdjustments: 5,
						});
						compLayout.run();
						compLaidOut.push({ comp, bb: comp.boundingBox() });
					}
					// 2D-pack the laid-out trees with a right-then-below
					// bias relative to existing content. Anchor: xStart
					// = right of existing + gutter, yStart = top of
					// existing. Trees fill rightward first; when a row
					// overflows the target width they wrap to a new
					// row at the same xStart (staying in the "right
					// column" of the canvas rather than jumping back
					// to x=0 below existing). This keeps imports
					// visually adjacent to whatever the visitor was
					// already looking at.
					const TREE_GUTTER = 60;
					const totalArea = compLaidOut.reduce((s, r) => s + r.bb.w * r.bb.h, 0);
					const targetRowWidth = Math.max(900, Math.sqrt(totalArea) * 1.4);
					let xCursor = xStart;
					let yCursor = yStart;
					let rowMaxH = 0;
					for (const { comp, bb } of compLaidOut) {
						if (xCursor > xStart && (xCursor - xStart) + bb.w > targetRowWidth) {
							xCursor = xStart;
							yCursor += rowMaxH + TREE_GUTTER;
							rowMaxH = 0;
						}
						const dx = xCursor - bb.x1;
						const dy = yCursor - bb.y1;
						comp.nodes().forEach((n) => {
							const p = n.position();
							n.position({ x: p.x + dx, y: p.y + dy });
						});
						xCursor += bb.w + TREE_GUTTER;
						if (bb.h > rowMaxH) {
rowMaxH = bb.h;
}
					}
				} else {
					// Cose fallback for sparse / edgeless cases. Run on
					// newEles ONLY (was: entire cy instance, which
					// silently re-positioned existing records every
					// time a sparse import landed). randomize:false
					// uses the new nodes' current positions as the
					// starting state.
					const layout = newEles.layout({
						name: 'cose',
						animate: false,
						fit: false,
						padding: 60,
						nodeRepulsion: 400000,
						idealEdgeLength: 200,
						nodeOverlap: 30,
						randomize: false,
						numIter: 2500,
					});
					layout.run();
					// Shift the laid-out cluster to the right of
					// existing records (aligned with their top edge),
					// same right-then-below preference as the tree
					// branch. Earlier behavior shifted only on the
					// Y axis, leaving the import overlapping or
					// directly below existing instead of beside it.
					if (hasExisting && newCyNodes.length > 0) {
						const bb = newCyNodes.boundingBox();
						const dx = xStart - bb.x1;
						const dy = yStart - bb.y1;
						newCyNodes.forEach((n) => {
							const p = n.position();
							n.position({ x: p.x + dx, y: p.y + dy });
						});
					}
				}
				// Fit + clamp. Two refinements over the naive
				// fit(undefined): scope to actual record cards (not
				// type-node placeholders or spawn-btn satellites,
				// which sit at extreme positions and skew the
				// bounding box); and when the all-cards bbox is too
				// big to fit at the min zoom, focus the camera on
				// the new records specifically: they're the
				// visitor's just-taken action, and pushing them to
				// one edge of the viewport (because the bbox center
				// is elsewhere) buries the thing they just did.
				const cardSel = '[kind ^= "card"]';
				const allCards = _cyInstance.nodes(cardSel);
				const newCards = newCyNodes.filter(cardSel);
				const fitTarget = allCards.length > 0 ? allCards : _cyInstance.elements();
				_cyInstance.fit(fitTarget, 60);
				const z = _cyInstance.zoom();
				if (z < 0.4) {
					_cyInstance.zoom(0.4);
					// At clamped min zoom, the all-cards bbox doesn't
					// fit anyway; bias toward the new records so the
					// import is centered and existing partially
					// scrolls off-screen as context.
					_cyInstance.center(newCards.length > 0 ? newCards : fitTarget);
				} else if (z > 1) {
					_cyInstance.zoom(1);
					_cyInstance.center(fitTarget);
				}
				// Sync cy positions back to canvasState so autosave +
				// future renders use what was just drawn.
				_cyInstance.nodes().forEach((n) => {
					const recId = n.data('recId');
					if (recId == null) {
return;
}
					const rec = canvasState.bulkRecords.find((r) => r.id === recId);
					if (!rec) {
return;
}
					const p = n.position();
					rec.x = p.x;
					rec.y = p.y;
				});
			}

			return {
				relayoutNewRecords: relayoutNewRecords,
			};
		},
	};
})();
