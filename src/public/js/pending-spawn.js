// Pending-record spawn family.
//
// Four entry points for the empty-card → real-record pipeline on
// the records canvas. A "pending" record is a placeholder card with
// "+ Create blank" / "↗ Load existing" buttons; the spawn flow drops
// one onto the canvas and the resolve flow upgrades it once the
// user picks an object + (optionally) a SF record.
//
//   spawnDraftRecord(name): orphan helper kept for
//                                       symmetry; no current callers.
//   spawnPendingRecord(worldX, worldY): drops a pending placeholder
//                                       at canvas world-coords (or
//                                       canvas centroid if no coords).
//   resolvePendingRecord(recId, name): upgrades a pending into a
//                                       blank draft of the picked
//                                       object type.
//   resolvePendingRecordToLoad(recId, name)
// : upgrades a pending into a
//                                       free type-node primed for the
//                                       Load-existing search flow.
//
// Dependencies passed to mount(): see code below for the full list.
// pickRecordForFreeTypeNode is wrapped lazily because the typeNode
// mount runs after this one.
//
// Exposed as window.OrgLoom.pendingSpawn. Load order: before app.js.

(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.pendingSpawn = {
		mount: function mount(deps) {
			const required = [
				'canvasState', 'showBulkToast',
				'_canvasCapBlockReason',
				'addToSelection', 'cloneRecord',
				'pickRecordForFreeTypeNode', 'renderBulkView',
				'getGraph',
			];
			if (!deps) {
throw new Error('pending-spawn.mount: missing deps object');
}
			for (const k of required) {
				if (deps[k] === undefined || deps[k] === null) {
					throw new Error('pending-spawn.mount: missing dep ' + k);
				}
			}
			const canvasState = deps.canvasState;
			const showBulkToast = deps.showBulkToast;
			const pushUndo = deps.pushUndo;
			const _canvasCapBlockReason = deps._canvasCapBlockReason;
			const addToSelection = deps.addToSelection;
			const cloneRecord = deps.cloneRecord;
			const pickRecordForFreeTypeNode = deps.pickRecordForFreeTypeNode;
			const renderBulkView = deps.renderBulkView;
			const getGraph = deps.getGraph;

			async function spawnDraftRecord(objectName) {
				const blocked = _canvasCapBlockReason(1);
				if (blocked) {
 showBulkToast(blocked); return; 
}
				let s = canvasState.selectedObjects.find((so) => so.name === objectName);
				if (!s) {
					try {
 s = await addToSelection(objectName); 
} catch (e) {
						showBulkToast('Failed to add ' + objectName + ': ' + (e.message || e), 'error');
						return;
					}
				}
				cloneRecord(objectName);
			}
			
			// Drops an empty placeholder card on the canvas with no object
			// type chosen yet. Marked isTypeNode + isPending so every
			// downstream filter that already excludes type-nodes (save,
			// insert, CSV, AI gen) skips it for free until
			// the user picks a type via resolvePendingRecord.
			// Spawn a pending placeholder. With no args, drops near the
			// canvas centroid (toolbar-button path). When called with
			// world coords, drops at that point: used by the canvas
			// floating-+ affordance so users can position the new record
			// directly under their cursor.
			function spawnPendingRecord(worldX, worldY) {
				let x, y;
				if (typeof worldX === 'number' && typeof worldY === 'number') {
					x = worldX;
					y = worldY;
				} else {
					const canvas = getGraph().querySelector('#bulk-canvas');
					const cw = (canvas && canvas.clientWidth) || 800;
					const ch = (canvas && canvas.clientHeight) || 600;
					const sl = (canvas && canvas.scrollLeft) || 0;
					const st = (canvas && canvas.scrollTop) || 0;
					const baseX = sl + cw / 2;
					const baseY = st + ch / 2;
					// Grid-snap successive pending placeholders so
					// repeated clicks don't pile them onto the same
					// spot. Previous +30px stair-step put every new
					// card mostly on top of the last (~220px-wide
					// cards). Now: anchor on the first pending
					// sibling and place each new clone in the next
					// grid cell, wrapping every PER_ROW columns.
					const STEP_X = 260;
					const STEP_Y = 170;
					const PER_ROW = 5;
					const pendingSiblings = canvasState.bulkRecords.filter((r) => r && r.isPending);
					if (pendingSiblings.length === 0) {
						x = baseX;
						y = baseY;
					} else {
						const anchor = pendingSiblings[0];
						const idx = pendingSiblings.length;
						const col = idx % PER_ROW;
						const r = Math.floor(idx / PER_ROW);
						x = anchor.x + col * STEP_X;
						y = anchor.y + r * STEP_Y;
					}
				}
				const _newId = canvasState.bulkIdSeq++;
				canvasState.bulkRecords.push({
					id: _newId,
					isTypeNode: true,
					isPending: true,
					x,
					y,
				});
				renderBulkView();
				// Ctrl+Z: remove the just-added card. The id is stable across
				// resolvePendingRecord, so this reverts the add whether the card
				// is still a pending placeholder or has since been resolved into
				// a real record; also drops any edges referencing it.
				if (typeof pushUndo === 'function') {
					pushUndo('Add record', function () {
						const i = canvasState.bulkRecords.findIndex((r) => r && r.id === _newId);
						if (i !== -1) {
							canvasState.bulkRecords.splice(i, 1);
						}
						canvasState.bulkAssociations = canvasState.bulkAssociations.filter(
							(a) => a && a.fromId !== _newId && a.toId !== _newId,
						);
						renderBulkView();
					});
				}
			}
			
			async function resolvePendingRecord(recId, objectName) {
				const rec = canvasState.bulkRecords.find((r) => r.id === recId);
				if (!rec || !rec.isPending) {
return;
}
				const blocked = _canvasCapBlockReason(1);
				if (blocked) {
 showBulkToast(blocked); return; 
}
				let s = canvasState.selectedObjects.find((so) => so.name === objectName);
				if (!s) {
					try {
 s = await addToSelection(objectName); 
} catch (e) {
						showBulkToast('Failed to add ' + objectName + ': ' + (e.message || e), 'error');
						return;
					}
				}
				rec.isPending = false;
				rec.isTypeNode = false;
				rec.objectName = s.name;
				rec.label = s.label;
				rec.fromSelectionId = s.id;
				rec.values = {};
				renderBulkView();
			}
			
			// Load-existing companion to resolvePendingRecord. Opens the
			// per-type record search at the placeholder's position
			// without mutating the placeholder itself; visually the
			// pending card stays put while the picker is up. On pick,
			// loadRecordIntoFreeTypeNode finds the pending by id and
			// replaces it with a real loaded card. On cancel, the
			// placeholder stays as-is so the user can choose a
			// different action.
			async function resolvePendingRecordToLoad(recId, objectName) {
				const rec = canvasState.bulkRecords.find((r) => r.id === recId);
				if (!rec || !rec.isPending) {
return;
}
				const blocked = _canvasCapBlockReason(1);
				if (blocked) {
 showBulkToast(blocked); return; 
}
				let s = canvasState.selectedObjects.find((so) => so.name === objectName);
				if (!s) {
					try {
 s = await addToSelection(objectName); 
} catch (e) {
						showBulkToast('Failed to add ' + objectName + ': ' + (e.message || e), 'error');
						return;
					}
				}
				// Stub mirrors the shape pickRecordForFreeTypeNode +
				// loadRecordIntoFreeTypeNode read from the rec: id (for
				// the in-place replace on success), x/y (fallback for
				// popover position), objectName + label (for query +
				// header). `id` matches the pending rec so the eventual
				// splice-replace lands on the right slot.
				//
				// Anchor the record-search popover to the placeholder's
				// "Load existing" button so it spawns where the object
				// picker just was: feels like a continuation rather
				// than a fresh popup somewhere unrelated.
				const cardEl = getGraph().querySelector('[data-rec-id="' + rec.id + '"]');
				const loadBtn = cardEl && cardEl.querySelector('[data-pending-pick-load]');
				pickRecordForFreeTypeNode({
					id: rec.id,
					x: rec.x,
					y: rec.y,
					objectName: s.name,
					label: s.label,
				}, loadBtn || cardEl || null);
			}
			
			// Companion to spawnDraftRecord: drops a free type-node on
			// the canvas at the world coord of the current viewport
			// center. Free type-nodes have no host or FK direction;
			// clicking Open routes to pickRecordForFreeTypeNode (a
			// search popover) which loads an existing record by id or
			// name and seeds its parents/children type-nodes around
			// the new card. Lets users start a new subtree from any
			// object even when it has no FK path from what's already
			// loaded.

			return {
				spawnDraftRecord: spawnDraftRecord,
				spawnPendingRecord: spawnPendingRecord,
				resolvePendingRecord: resolvePendingRecord,
				resolvePendingRecordToLoad: resolvePendingRecordToLoad,
			};
		},
	};
})();
