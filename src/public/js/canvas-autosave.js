// Canvas autosave + org-switch stash.
//
// Two related responsibilities pulled out of app.js for size:
//
//   • Autosave: every render of the bulk canvas snapshots a slim
//     payload (selectedObjects, bulkRecords, associations, hidden
//     objects, current canvas id, view mode, zoom, diff suppressions)
//     into sessionStorage so a browser refresh restores the same
//     working state. Snapshot is debounced 500ms so rapid renders
//     coalesce into one write. Cleared by canvas-save-load when the
//     canvas is persisted to SF (the saved canvas is now the source
//     of truth; the autosave layer would only ever shadow it).
//
//   • Org-switch stash: when the active SF org changes mid-session,
//     app.js stashes the current canvas into sessionStorage BEFORE the
//     re-auth round-trip, then restores it when the new org boots.
//     Cross-org records (loaded against the old org's id namespace)
//     are converted to drafts on restore: SF ids don't carry across
//     orgs, so trying to round-trip them would silently miswrite.
//
// Mount signature mirrors the rest of the modules under window.OrgLoom
// (mount(deps) returns the public surface, single shared closure).

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
			// In-flight migration snapshot. Stored in sessionStorage so it
			// survives the same-tab OAuth round-trip to the target org (the
			// tab persists across the redirect, so the origin's sessionStorage
			// persists), but is auto-purged when the tab closes: no record
			// values are left at rest on disk. A full browser close
			// mid-migration is NOT recoverable; the user re-initiates and no
			// durable data is lost (source records are still in SF, saved
			// canvas structure is still in SF). Still cleared explicitly on
			// migration complete (upload) or discard.
			const _MIGRATION_KEY = 'orgloom:migration:v1';
			// One-time purge of legacy localStorage copies of both stashes:
			// they moved to sessionStorage; this clears any durable on-disk
			// residue left by an older build in an existing/dev browser.
			try {
				window.localStorage.removeItem(_ORGSWITCH_STASH_KEY);
				window.localStorage.removeItem(_MIGRATION_KEY);
			} catch (_e) {}

			// Salesforce system fields that must be stripped when a
			// loaded record crosses orgs: its Id / audit / ownership /
			// record-type Ids belong to the source org's namespace and
			// don't carry to the target. Shared by org-switch restore and
			// migration restore. RecordTypeId is stripped here for the
			// raw upload payload; migrate mode re-resolves the target
			// RecordTypeId by RecordType.DeveloperName separately.
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

			// Apply a restored canvas state to canvasState, converting
			// loaded-from-source records to drafts when crossing orgs
			// (source Ids don't exist in the target). Returns
			// { convertedCount, isCrossOrg } so the caller can tailor its
			// toast. Shared by org-switch restore + migration restore.
			function _applyRestoredState(s, sourceOrg, targetOrg) {
				const isCrossOrg =
					!!sourceOrg && !!targetOrg && sourceOrg !== targetOrg;
				let convertedCount = 0;
				const converted = (s.bulkRecords || []).map((rec) => {
					if (!rec || typeof rec !== 'object') {
						return rec;
					}
					// A migrate-matched record's loadedFromId is a TARGET-org
					// id (it points at the existing record we'll update), not
					// a stale source id; leave it intact so recovery reloads
					// don't undo the match.
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
				// Explicit canvas associations are the portable relationship source
				// of truth. Remove the source-org FK value from the child copy; the
				// upload graph will substitute the matched/new destination parent Id.
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
					// Each selection entry caches `.data`: the SOURCE org's
					// /graph result (parents + children). On a cross-org
					// restore those relationships may not exist (or differ) in
					// the target org, so strip the cached data to force a
					// fresh /graph fetch against the current org. Same-org
					// restores keep it (a re-fetch would just re-hit SF).
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
						/* uiFeedback not ready; silent */
					}
				}, 0);
				return true;
			}

			// ---- Durable migration snapshot --------------------------------
			//
			// Persist the in-flight migration canvas to sessionStorage so it
			// survives reload + the same-tab OAuth round-trip without leaving
			// Salesforce record values durably on the device. Account-scoped;
			// (cleared explicitly on migration complete / discard).

			// Snapshot the current canvas for the tab-session migration. opts:
			//   { status }: 'awaiting-target' when the user has just
			//                       begun a migration and is about to switch
			//                       to the destination org; 'in-progress'
			//                       once we've arrived and are reconciling.
			//                       Default 'in-progress'.
			//   { targetSfOrgId }: the destination org id, if known.
			// Returns true on success, false if persistence failed (e.g.
			// sessionStorage quota exceeded on a very large canvas) so the
			// caller can warn rather than give false assurance.
			// Before stashing a migration, capture each loaded record's
			// RecordType DeveloperName from the SOURCE org's describe (still
			// cached now; the describe cache is org-scoped and will hold the
			// TARGET's describes after the switch). RecordTypeIds aren't
			// portable across orgs, so we resolve them to the portable
			// DeveloperName here and stamp it on the record; migrate mode
			// re-resolves the target RecordTypeId from it after arrival.
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

			// Keep the tab-session migration current as the user edits in
			// migrate mode, so reload/OAuth return recovers the latest state.
			// where they were, not the initial post-pull snapshot. No-op
			// unless an in-progress migration exists. Called from the
			// autosave debounce so it rides the same coalesced writes.
			function _migrationSyncIfActive() {
				const existing = _peekMigration();
				if (!existing || existing.status !== 'in-progress') {
					return;
				}
				// The session entry can remain in-progress while the user visits
				// another org in the same tab. Only the page that actually resumed
				// migrate mode in the recorded destination may update its state;
				// otherwise an ordinary autosave on the wrong org replaces the
				// migration snapshot and loses matches/remaps.
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

			// Read the migration meta without applying it: lets boot code
			// decide whether to resume. Returns the parsed payload (with
			// state) or null. Account-mismatched or malformed entries
			// return null.
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

			// Restore the tab-session migration canvas. Does NOT delete the
			// entry (the migration is still in progress until completed or
			// discarded). Returns { restored, convertedCount, isCrossOrg }
			// or false when there's nothing usable to restore.
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

			// Boot-time decision: should this page load resume a migration,
			// and if so, do it. Encapsulates the status/org logic so app.js
			// just calls it. Returns a result object on restore, else false.
			//
			//   • status 'awaiting-target' + we're now on a DIFFERENT org
			//     than the source  → this is the post-switch arrival. Restore
			//     and flip to 'in-progress' (record the target org).
			//   • status 'in-progress' + we're on the recorded target org
			//     → recovery after a reload/close mid-migration. Restore.
			//   • otherwise (still on source, or no migration) → false, so we
			//     don't hijack an unrelated canvas load.
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
					// Promote to in-progress + record the org we landed on
					// as the target, so a later close/reopen recovers.
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

			// The draft lives under a scope-NAMESPACED key, not one fixed key
			// with the scope stored inside. Overloading a single key meant a
			// scope mismatch on restore (e.g. a signed-in user opening
			// /playground in the same tab: a different account/org scope)
			// cleared the entry, silently destroying the real canvas's
			// unsaved draft. Per-scope keys let the demo and the real canvas
			// keep independent drafts that never clobber each other; a stale
			// entry under another scope simply isn't read (and dies with the
			// tab, since it's sessionStorage).
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
				// Keep the session migration current through migrate-mode edits
				// so reload/OAuth return recovers where the user was, not the
				// initial pull. No-op unless a migration is in progress.
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

			// Compatibility: app.js used to expose the org-switch surface
			// as window.Orgloom.canvasOrgSwitch for any external caller
			// that hot-loaded a different page during a switch. Preserve
			// the surface here so external callers don't break.
			window.Orgloom = window.Orgloom || {};
			window.Orgloom.canvasOrgSwitch = {
				stash: _orgSwitchStash,
				restore: _orgSwitchRestore,
				// Durable migration surface, reachable cross-module (the
				// save menu triggers it; the connections modal can read
				// it; boot resumes it).
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
				// Durable migration snapshot (Phase 0).
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
