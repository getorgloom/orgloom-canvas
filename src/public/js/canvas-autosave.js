
(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.canvasAutosave = {
		mount: function mount(deps) {
			const required = ['canvasState'];
			if (!deps) {
				throw new Error('canvas-autosave.mount: missing deps object');
			}
			for (const k of required) {
				if (deps[k] === undefined || deps[k] === null) {
					throw new Error('canvas-autosave.mount: missing dep ' + k);
				}
			}
			const canvasState = deps.canvasState;

			const _CANVAS_DRAFT_KEY = 'orgloom:canvas-draft:v1';
			const _ORGSWITCH_STASH_KEY = 'orgloom:org-switch-stash:v1';
			const _MIGRATION_KEY = 'orgloom:migration:v1';
			try {
				window.localStorage.removeItem(_ORGSWITCH_STASH_KEY);
				window.localStorage.removeItem(_MIGRATION_KEY);
			} catch (_e) {}

			const SYSTEM_FIELDS_TO_STRIP = [
				'attributes',
				'Id',
				'CreatedDate',
				'CreatedById',
				'LastModifiedDate',
				'LastModifiedById',
				'SystemModstamp',
				'LastReferencedDate',
				'LastViewedDate',
				'IsDeleted',
				'OwnerId',
				'RecordTypeId',
				'MasterRecordId',
			];

			function _applyRestoredState(s, sourceOrg, targetOrg) {
				const isCrossOrg =
					!!sourceOrg && !!targetOrg && sourceOrg !== targetOrg;
				let convertedCount = 0;
				const converted = (s.bulkRecords || []).map((rec) => {
					if (!rec || typeof rec !== 'object') {
						return rec;
					}
					if (isCrossOrg && rec.loadedFromId && !rec._migrateMatchedId) {
						convertedCount++;
						const out = Object.assign({}, rec);
						out._wasLoadedFromOrgId = sourceOrg;
						out._wasLoadedFromId = rec.loadedFromId;
						delete out.loadedFromId;
						delete out.hasExisting;
						delete out.hasModified;
						if (out.values && typeof out.values === 'object') {
							const cleanedValues = Object.assign({}, out.values);
							for (const k of SYSTEM_FIELDS_TO_STRIP) {
								delete cleanedValues[k];
							}
							out.values = cleanedValues;
						}
						return out;
					}
					return rec;
				});
				if (isCrossOrg && Array.isArray(s.bulkAssociations)) {
					const byId = new Map(converted.filter(Boolean).map((r) => [r.id, r]));
					s.bulkAssociations.forEach((a) => {
						const child = a && byId.get(a.fromId);
						if (!child || !child.values || !a.fieldName) {
							return;
						}
						const key = Object.keys(child.values).find((k) => k.toLowerCase() === String(a.fieldName).toLowerCase());
						if (key) {
							delete child.values[key];
						}
					});
				}
				if (Array.isArray(s.selectedObjects)) {
					canvasState.selectedObjects = isCrossOrg
						? s.selectedObjects.map((sel) => {
							if (!sel || typeof sel !== 'object' || !('data' in sel)) {
								return sel;
							}
							const out = Object.assign({}, sel);
							delete out.data;
							return out;
						})
						: s.selectedObjects;
				}
				if (typeof s.selectedIdSeq === 'number') {
					canvasState.selectedIdSeq = s.selectedIdSeq;
				}
				if (typeof s.activeIndex === 'number') {
					canvasState.activeIndex = s.activeIndex;
				}
				canvasState.bulkRecords = converted;
				if (Array.isArray(s.bulkAssociations)) {
					canvasState.bulkAssociations = s.bulkAssociations;
				}
				if (typeof s.bulkIdSeq === 'number') {
					canvasState.bulkIdSeq = s.bulkIdSeq;
				}
				if (Array.isArray(s.hiddenObjects)) {
					canvasState.hiddenObjects = new Set(s.hiddenObjects);
				}
				if (s.graphView) {
					canvasState.graphView = s.graphView;
				}
				if (typeof s.bulkZoom === 'number') {
					canvasState.bulkZoom = s.bulkZoom;
				}
				canvasState._autoSpawnedPending = true;
				return { convertedCount: convertedCount, isCrossOrg: isCrossOrg };
			}

			function _orgSwitchStash() {
				try {
					const payload = {
						v: 1,
						ts: Date.now(),
						sourceSfOrgId: window.SF_ORG_ID || null,
						sourceAccountId: window.ORGLOOM_ACCOUNT_ID || null,
						sourceCanvasId:
							(canvasState.currentCanvas &&
								canvasState.currentCanvas.id) ||
							null,
						state: {
							selectedObjects: canvasState.selectedObjects,
							selectedIdSeq: canvasState.selectedIdSeq,
							activeIndex: canvasState.activeIndex,
							bulkRecords: canvasState.bulkRecords,
							bulkAssociations: canvasState.bulkAssociations,
							bulkIdSeq: canvasState.bulkIdSeq,
							hiddenObjects: Array.from(canvasState.hiddenObjects || []),
							graphView: canvasState.graphView,
							bulkZoom: canvasState.bulkZoom,
						},
					};
					sessionStorage.setItem(_ORGSWITCH_STASH_KEY, JSON.stringify(payload));
				} catch (_e) {
				}
			}

			function _orgSwitchRestore() {
				let raw;
				try {
					raw = sessionStorage.getItem(_ORGSWITCH_STASH_KEY);
				} catch (_e) {
					return false;
				}
				if (!raw) {
					return false;
				}
				try {
					sessionStorage.removeItem(_ORGSWITCH_STASH_KEY);
				} catch (_e) {}
				let payload;
				try {
					payload = JSON.parse(raw);
				} catch (_e) {
					return false;
				}
				if (!payload || payload.v !== 1) {
					return false;
				}
				if (
					typeof payload.ts === 'number' &&
					Date.now() - payload.ts > 10 * 60 * 1000
				) {
					return false;
				}
				const currentAccountId = window.ORGLOOM_ACCOUNT_ID || null;
				if (payload.sourceAccountId !== currentAccountId) {
					return false;
				}
				const s = payload.state || {};
				if (!s || !Array.isArray(s.bulkRecords) || s.bulkRecords.length === 0) {
					return false;
				}
				const targetOrg = window.SF_ORG_ID || null;
				const sourceOrg = payload.sourceSfOrgId || null;
				const applied = _applyRestoredState(s, sourceOrg, targetOrg);
				setTimeout(() => {
					try {
						if (applied.isCrossOrg) {
							window.olToast(
								applied.convertedCount > 0
									? 'Canvas restored. ' +
											applied.convertedCount +
											' loaded record' +
											(applied.convertedCount === 1 ? '' : 's') +
											' converted to draft' +
											(applied.convertedCount === 1 ? '' : 's') +
											" (target org doesn't share the source org's record Ids)."
									: 'Canvas restored from the previous org.',
								'info',
							);
						} else {
							window.olToast('Canvas restored.', 'info');
						}
					} catch (_e) {
					}
				}, 0);
				return true;
			}


			function _stampSourceRecordTypeDevNames() {
				const cache = canvasState.describeCache || {};
				(canvasState.bulkRecords || []).forEach((rec) => {
					if (!rec || rec.isTypeNode ||
						rec._sourceRecordTypeDeveloperName) {
						return;
					}
					const v = rec.values || {};
					const rtId = v.RecordTypeId || v.recordTypeId;
					if (!rtId) {
						return;
					}
					const d = cache[rec.objectName];
					const rts = (d && d.recordTypes) || [];
					for (let i = 0; i < rts.length; i++) {
						if (rts[i] && String(rts[i].id) === String(rtId)) {
							if (rts[i].developerName) {
								rec._sourceRecordTypeDeveloperName =
									rts[i].developerName;
							}
							break;
						}
					}
				});
			}

			function _migrationStash(opts) {
				opts = opts || {};
				_stampSourceRecordTypeDevNames();
				try {
					const payload = {
						v: 1,
						ts: Date.now(),
						status: opts.status || 'in-progress',
						sourceSfOrgId: window.SF_ORG_ID || null,
						sourceAccountId: window.ORGLOOM_ACCOUNT_ID || null,
						sourceCanvasId:
							(canvasState.currentCanvas &&
								canvasState.currentCanvas.id) ||
							null,
						targetSfOrgId: opts.targetSfOrgId || null,
						state: {
							selectedObjects: canvasState.selectedObjects,
							selectedIdSeq: canvasState.selectedIdSeq,
							activeIndex: canvasState.activeIndex,
							bulkRecords: canvasState.bulkRecords,
							bulkAssociations: canvasState.bulkAssociations,
							bulkIdSeq: canvasState.bulkIdSeq,
							hiddenObjects: Array.from(canvasState.hiddenObjects || []),
							graphView: canvasState.graphView,
							bulkZoom: canvasState.bulkZoom,
						},
					};
					sessionStorage.setItem(_MIGRATION_KEY, JSON.stringify(payload));
					return true;
				} catch (_e) {
					return false;
				}
			}

			function _migrationSyncIfActive() {
				const existing = _peekMigration();
				if (!existing || existing.status !== 'in-progress') {
					return;
				}
				if (!canvasState.migrateMode || !canvasState.migrateMode.active) {
					return;
				}
				const currentOrg = window.SF_ORG_ID || null;
				if (existing.targetSfOrgId && currentOrg !== existing.targetSfOrgId) {
					return;
				}
				try {
					existing.ts = Date.now();
					existing.state = {
						selectedObjects: canvasState.selectedObjects,
						selectedIdSeq: canvasState.selectedIdSeq,
						activeIndex: canvasState.activeIndex,
						bulkRecords: canvasState.bulkRecords,
						bulkAssociations: canvasState.bulkAssociations,
						bulkIdSeq: canvasState.bulkIdSeq,
						hiddenObjects: Array.from(canvasState.hiddenObjects || []),
						graphView: canvasState.graphView,
						bulkZoom: canvasState.bulkZoom,
					};
					sessionStorage.setItem(_MIGRATION_KEY, JSON.stringify(existing));
				} catch (_e) {}
			}

			function _peekMigration() {
				let raw;
				try {
					raw = sessionStorage.getItem(_MIGRATION_KEY);
				} catch (_e) {
					return null;
				}
				if (!raw) {
					return null;
				}
				let payload;
				try {
					payload = JSON.parse(raw);
				} catch (_e) {
					return null;
				}
				if (!payload || payload.v !== 1) {
					return null;
				}
				const currentAccountId = window.ORGLOOM_ACCOUNT_ID || null;
				if (payload.sourceAccountId !== currentAccountId) {
					return null;
				}
				return payload;
			}

			function _migrationRestore() {
				const payload = _peekMigration();
				if (!payload) {
					return false;
				}
				const s = payload.state || {};
				if (!Array.isArray(s.bulkRecords) || s.bulkRecords.length === 0) {
					return false;
				}
				const targetOrg = window.SF_ORG_ID || null;
				const sourceOrg = payload.sourceSfOrgId || null;
				const applied = _applyRestoredState(s, sourceOrg, targetOrg);
				return {
					restored: true,
					convertedCount: applied.convertedCount,
					isCrossOrg: applied.isCrossOrg,
					sourceSfOrgId: sourceOrg,
					targetSfOrgId: payload.targetSfOrgId || null,
				};
			}

			function _migrationClear() {
				try {
					sessionStorage.removeItem(_MIGRATION_KEY);
				} catch (_e) {}
			}

			function _hasPendingMigration() {
				return !!_peekMigration();
			}

			function _migrationResume() {
				const payload = _peekMigration();
				if (!payload) {
					return false;
				}
				const currentOrg = window.SF_ORG_ID || null;
				const sourceOrg = payload.sourceSfOrgId || null;
				const status = payload.status || 'in-progress';

				const isArrival =
					status === 'awaiting-target' &&
					!!currentOrg &&
					currentOrg !== sourceOrg;
				const isRecovery =
					status === 'in-progress' &&
					!!currentOrg &&
					currentOrg === (payload.targetSfOrgId || currentOrg);

				if (!isArrival && !isRecovery) {
					return false;
				}
				const result = _migrationRestore();
				if (!result) {
					return false;
				}
				if (isArrival) {
					try {
						payload.status = 'in-progress';
						payload.targetSfOrgId = currentOrg;
						sessionStorage.setItem(_MIGRATION_KEY, JSON.stringify(payload));
					} catch (_e) {}
				}
				result.justArrived = isArrival;
				return result;
			}

			function _autosaveScopeKey() {
				return [
					window.ORGLOOM_ACCOUNT_ID || 'anon',
					window.SF_ORG_ID || 'no-org',
					window.SF_USER_ID || 'no-user',
					(canvasState.currentCanvas && canvasState.currentCanvas.id) ||
						'new',
				].join(':');
			}

			function _scopedDraftKey() {
				return _CANVAS_DRAFT_KEY + '|' + _autosaveScopeKey();
			}

			function _autosaveSnapshot() {
				try {
					const payload = {
						v: 1,
						scope: _autosaveScopeKey(),
						ts: Date.now(),
						state: {
							selectedObjects: canvasState.selectedObjects,
							selectedIdSeq: canvasState.selectedIdSeq,
							activeIndex: canvasState.activeIndex,
							bulkRecords: canvasState.bulkRecords,
							bulkAssociations: canvasState.bulkAssociations,
							bulkIdSeq: canvasState.bulkIdSeq,
							hiddenObjects: Array.from(canvasState.hiddenObjects || []),
							graphView: canvasState.graphView,
							currentCanvas: canvasState.currentCanvas,
							_draftCanvasId: canvasState._draftCanvasId,
							bulkZoom: canvasState.bulkZoom,
							diffSuppressions: canvasState.diffSuppressions || {},
						},
					};
					sessionStorage.setItem(_scopedDraftKey(), JSON.stringify(payload));
				} catch (_e) {
				}
				_migrationSyncIfActive();
			}

			let _autosaveTimer = null;
			function _autosaveSchedule() {
				if (_autosaveTimer) {
					clearTimeout(_autosaveTimer);
				}
				_autosaveTimer = setTimeout(_autosaveSnapshot, 500);
			}

			function _autosaveClear() {
				if (_autosaveTimer) {
					clearTimeout(_autosaveTimer);
					_autosaveTimer = null;
				}
				try {
					sessionStorage.removeItem(_scopedDraftKey());
				} catch (_e) {}
			}

			function _autosaveRestore() {
				try {
					const raw = sessionStorage.getItem(_scopedDraftKey());
					if (!raw) {
						return false;
					}
					const payload = JSON.parse(raw);
					if (!payload || payload.v !== 1) {
						return false;
					}
					if (payload.scope !== _autosaveScopeKey()) {
						_autosaveClear();
						return false;
					}
					const s = payload.state || {};
					const hasContent =
						(Array.isArray(s.bulkRecords) && s.bulkRecords.length > 0) ||
						(Array.isArray(s.selectedObjects) &&
							s.selectedObjects.length > 0);
					if (!hasContent) {
						return false;
					}
					if (Array.isArray(s.selectedObjects)) {
						canvasState.selectedObjects = s.selectedObjects;
					}
					if (typeof s.selectedIdSeq === 'number') {
						canvasState.selectedIdSeq = s.selectedIdSeq;
					}
					if (typeof s.activeIndex === 'number') {
						canvasState.activeIndex = s.activeIndex;
					}
					if (Array.isArray(s.bulkRecords)) {
						canvasState.bulkRecords = s.bulkRecords;
					}
					if (Array.isArray(s.bulkAssociations)) {
						canvasState.bulkAssociations = s.bulkAssociations;
					}
					if (typeof s.bulkIdSeq === 'number') {
						canvasState.bulkIdSeq = s.bulkIdSeq;
					}
					if (Array.isArray(s.hiddenObjects)) {
						canvasState.hiddenObjects = new Set(s.hiddenObjects);
					}
					if (s.graphView) {
						canvasState.graphView = s.graphView;
					}
					if (s.currentCanvas) {
						canvasState.currentCanvas = s.currentCanvas;
					}
					if (s._draftCanvasId) {
						canvasState._draftCanvasId = s._draftCanvasId;
					}
					if (typeof s.bulkZoom === 'number') {
						canvasState.bulkZoom = s.bulkZoom;
					}
					if (s.diffSuppressions && typeof s.diffSuppressions === 'object') {
						canvasState.diffSuppressions = s.diffSuppressions;
					}
					return true;
				} catch (_e) {
					return false;
				}
			}

			window.Orgloom = window.Orgloom || {};
			window.Orgloom.canvasOrgSwitch = {
				stash: _orgSwitchStash,
				restore: _orgSwitchRestore,
				migrationStash: _migrationStash,
				migrationResume: _migrationResume,
				migrationRestore: _migrationRestore,
				migrationClear: _migrationClear,
				hasPendingMigration: _hasPendingMigration,
				migrationSyncIfActive: _migrationSyncIfActive,
			};

			return {
				orgSwitchStash: _orgSwitchStash,
				orgSwitchRestore: _orgSwitchRestore,
				autosaveSchedule: _autosaveSchedule,
				autosaveClear: _autosaveClear,
				autosaveRestore: _autosaveRestore,
				migrationStash: _migrationStash,
				migrationResume: _migrationResume,
				migrationRestore: _migrationRestore,
				migrationClear: _migrationClear,
				hasPendingMigration: _hasPendingMigration,
				migrationSyncIfActive: _migrationSyncIfActive,
			};
		},
	};
})();
