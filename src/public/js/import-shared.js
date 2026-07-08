














(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};





	function gateImportFile(file, opts) {
		const extRe = opts.extRe;
		if (!extRe.test(String(file.name || ''))) {
			return '"' + file.name + '" isn\'t a ' + opts.extLabel + ' file — ' +
				opts.flowLabel + ' only accepts ' + opts.extLabel + ' files.';
		}
		if (file.size > opts.maxBytes) {
			return '"' + file.name + '" is ' + (file.size / (1024 * 1024)).toFixed(1) +
				' MB — over the ' + Math.round(opts.maxBytes / (1024 * 1024)) +
				' MB limit for ' + opts.flowLabel + '. Was this the right file?';
		}
		return null;
	}





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
			return function restore() {
				canvasState.selectedObjects = snap.selectedObjects;
				canvasState.selectedIdSeq = snap.selectedIdSeq;
				canvasState.activeIndex = snap.activeIndex;


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
			};
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
