
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
				if (rootCyNodes.length === 0 && newCyNodes.length > 0) {
					const sorted = newCyNodes.toArray().sort((a, b) => b.degree() - a.degree());
					rootCyNodes = sorted.length > 0 ? _cyInstance.collection([sorted[0]]) : newCyNodes;
				}
				const useTreeLayout = newCyNodes.length >= 5 && hasEdges && rootCyNodes.length > 0;
				if (useTreeLayout) {
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
							directed: false,
							roots: compRoots.map((n) => n.id()),
							spacingFactor: 1.15,
							avoidOverlap: true,
							grid: true,
							maximalAdjustments: 5,
						});
						compLayout.run();
						compLaidOut.push({ comp, bb: comp.boundingBox() });
					}
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
				const cardSel = '[kind ^= "card"]';
				const allCards = _cyInstance.nodes(cardSel);
				const newCards = newCyNodes.filter(cardSel);
				const fitTarget = allCards.length > 0 ? allCards : _cyInstance.elements();
				_cyInstance.fit(fitTarget, 60);
				const z = _cyInstance.zoom();
				if (z < 0.4) {
					_cyInstance.zoom(0.4);
					_cyInstance.center(newCards.length > 0 ? newCards : fitTarget);
				} else if (z > 1) {
					_cyInstance.zoom(1);
					_cyInstance.center(fitTarget);
				}
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
