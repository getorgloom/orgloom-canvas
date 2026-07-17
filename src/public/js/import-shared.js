// Shared import-guard helpers used by every "get data onto the canvas"
// flow (JSON file import, CSV import, future importers). These lived as
// per-flow copies inside templates.js and app.js, which is exactly how
// guard fixes drifted between the flows (fieldless-edge and skip-count
// bugs landed in one loader and missed the other). One module, one set
// of rules.
//
// Everything here is dependency-free (pure functions + window.posthog),
// EXCEPT makeUndoCapture, which is a factory: app.js calls it once with
// {canvasState, renderAll, showBulkToast} and shares the resulting
// capture function with the import flows.
//
// Exposed as window.OrgLoom.importShared. Load order: before app.js
// (mount-time consumers read it when app.js wires the modules).

(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	// Filename + size gate, run BEFORE any read/parse. The size cap exists
	// because FileReader (+ JSON.parse / parseCsv) pulls the whole file
	// into memory; a mispicked multi-hundred-MB file would freeze the
	// tab. opts: { extRe, extLabel, maxBytes, flowLabel }.
	function gateImportFile(file, opts) {
		const extRe = opts.extRe;
		if (!extRe.test(String(file.name || ''))) {
			return '"' + file.name + '" isn\'t a ' + opts.extLabel + ' file: ' +
				opts.flowLabel + ' only accepts ' + opts.extLabel + ' files.';
		}
		if (file.size > opts.maxBytes) {
			return '"' + file.name + '" is ' + (file.size / (1024 * 1024)).toFixed(1) +
				' MB, over the ' + Math.round(opts.maxBytes / (1024 * 1024)) +
				' MB limit for ' + opts.flowLabel + '. Was this the right file?';
		}
		return null;
	}

	// Import-failure telemetry. Reasons only (type / size / invalid /
	// unreadable / notcsv / norows / cap) plus our own validation message
	// but never file contents. Files that fail to import are silent churn;
	// this makes them visible in the funnel.
	function captureImportFailure(flow, reason, message) {
		try {
			if (window.posthog && window.posthog.capture) {
				window.posthog.capture('canvas_import_failed', {
					flow: flow,
					reason: reason,
					message: message || null,
				});
			}
		} catch (_e) {}
	}

	// Admit an association onto the canvas: both endpoints resolved, a
	// real lookup field named, and the single-value (holder, fieldName)
	// slot not already taken. Consumes the slot on admit. Callers seed
	// `usedFk` with the canvas's existing associations when imported
	// edges may attach to existing cards.
	function admitAssociation(usedFk, fromId, toId, fieldName) {
		if (fromId == null || toId == null) {
			return false;
		}
		if (typeof fieldName !== 'string' || !fieldName) {
			return false;
		}
		const fkKey = fromId + '::' + fieldName;
		if (usedFk.has(fkKey)) {
			return false;
		}
		usedFk.add(fkKey);
		return true;
	}

	// Honest-summary suffix shared by import toasts.
	function skipSuffix(skippedRecords, skippedAssoc) {
		const dropped = [];
		if (skippedRecords > 0) {
			dropped.push(skippedRecords + ' record' + (skippedRecords === 1 ? '' : 's'));
		}
		if (skippedAssoc > 0) {
			dropped.push(skippedAssoc + ' association' + (skippedAssoc === 1 ? '' : 's'));
		}
		return dropped.length
			? ' Skipped ' + dropped.join(' and ') + " that couldn't be read or resolved."
			: '';
	}

	// Factory for the pre-import undo snapshot. Returns capture(), which
	// snapshots the canvas and returns a restore() closure suitable for a
	// toast's Undo action. Arrays are copied, entries kept by reference;
	// the import flows replace/append arrays but never mutate surviving
	// entries, so restoring the arrays restores the canvas.
	function makeUndoCapture(deps) {
		const canvasState = deps.canvasState;
		const renderAll = deps.renderAll;
		const showBulkToast = deps.showBulkToast;
		return function captureUndoSnapshot() {
			const snap = {
				selectedObjects: canvasState.selectedObjects.slice(),
				selectedIdSeq: canvasState.selectedIdSeq,
				activeIndex: canvasState.activeIndex,
				hiddenObjects: new Set(canvasState.hiddenObjects),
				bulkRecords: canvasState.bulkRecords.slice(),
				bulkAssociations: canvasState.bulkAssociations.slice(),
				bulkInitialized: canvasState.bulkInitialized,
				currentCanvas: canvasState.currentCanvas,
			};
			let armed = null;
			function fingerprint() {
				try {
					return JSON.stringify({
						records: (canvasState.bulkRecords || []).map((r) => ({
							id: r.id,
							objectName: r.objectName,
							loadedFromId: r.loadedFromId || null,
							pendingDelete: !!r.pendingDelete,
							values: r.values || {},
						})),
						associations: (canvasState.bulkAssociations || []).map((a) => ({
							fromId: a.fromId,
							toId: a.toId,
							fieldName: a.fieldName,
						})),
						selected: (canvasState.selectedObjects || []).map((s) => s && s.name),
						hidden: Array.from(canvasState.hiddenObjects || []),
						currentCanvasId: canvasState.currentCanvas && canvasState.currentCanvas.id,
					});
				} catch (_e) {
					return null;
				}
			}
			function restore() {
				if (armed && (canvasState.bulkRecords !== armed.records ||
					canvasState.bulkAssociations !== armed.associations ||
					fingerprint() !== armed.fingerprint)) {
					showBulkToast('Can’t undo the import because the canvas was edited afterward.', 'info');
					return;
				}
				canvasState.selectedObjects = snap.selectedObjects;
				canvasState.selectedIdSeq = snap.selectedIdSeq;
				canvasState.activeIndex = snap.activeIndex;
				// hiddenObjects is cleared in place by the loaders (other
				// modules hold the Set by reference); restore in place too.
				canvasState.hiddenObjects.clear();
				snap.hiddenObjects.forEach(function (v) {
					canvasState.hiddenObjects.add(v);
				});
				canvasState.bulkRecords = snap.bulkRecords;
				canvasState.bulkAssociations = snap.bulkAssociations;
				canvasState.bulkInitialized = snap.bulkInitialized;
				canvasState.currentCanvas = snap.currentCanvas;
				canvasState.bulkSelectedIds = new Set();
				canvasState.bulkSelectedEdgeId = null;
				canvasState._renderedRecIds.clear();
				renderAll();
				showBulkToast('Import undone.');
			}
			restore.arm = function () {
				armed = {
					records: canvasState.bulkRecords,
					associations: canvasState.bulkAssociations,
					fingerprint: fingerprint(),
				};
				return restore;
			};
			return restore;
		};
	}

	window.OrgLoom.importShared = {
		gateImportFile: gateImportFile,
		captureImportFailure: captureImportFailure,
		admitAssociation: admitAssociation,
		skipSuffix: skipSuffix,
		makeUndoCapture: makeUndoCapture,
	};
})();
