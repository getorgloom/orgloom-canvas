// Canvas serialization: portable template files + server-saved canvases.
//
// Two adjacent file-format concerns share this module:
//
//   1. Templates (file download + import). Portable JSON that the user
//      saves to their own machine. Guardrails:
//        - Records loaded from Salesforce (have loadedFromId) are
//          excluded by default so a template can't accidentally
//          bundle real org data.
//        - Hard cap of 500 records per template: prevents the feature
//          being repurposed as a bulk extractor.
//        - _meta block stamps provenance: org id, user id, timestamp.
//        - Values live on the user's machine. Server is never
//          involved for templates.
//
//   2. Canvas payload (server-saved canvases). The shape that ships
//      to the customer's SF org as a ContentVersion file. Full
//      fidelity: drafts with values + loaded references + schema +
//      associations. Owner-vs-non-owner draft visibility is enforced
//      at LOAD time, server-side. One save action, one mental model.
//
// All canvas state mutations go through `canvasState.X` (the
// expanded state object). External helpers (addToSelection,
// renderAll, etc.) are passed via mount() deps.
//
// Dependencies passed to mount():
//   canvasState: shared canvas state.
//   showBulkToast: toast notification.
//   escapeHtml: HTML escape utility.
//   csrfFetch: fetch wrapper.
//   ensureDescribe: async function(name) → describe.
//   addToSelection: async; register an object on canvas.
//   setGraphView: view switch ('schema' / 'bulk').
//   renderAll: re-render after load.
//   showReplaceOrMergeDialog: 3-way dialog.
//   pingAuditEvent: fire-and-forget audit POST.
//   getCanvasRecordCap: () => Number. The canvas-side
//                               _CANVAS_RECORD_CAP_get() constant lives in
//                               app.js; the module reads it through
//                               this getter (constant value, lazy
//                               capture).
//   realRecordCount: () => Number. Counts canvas records
//                               for the cap-check. Defined in app.js;
//                               passed as a callback because the
//                               module needs the result at apply
//                               time.
//   resolveEndpoint: (kind, ref) => bulkRecId. Used by
//                               applyCanvasPayload to wire
//                               associations from kind+ref shapes to
//                               the freshly-minted record ids.
//   resolveRefKey: payload-shape helper.
//   serializeObjects, recordCommonParts, loadedEditDelta are
//   shared per-record (de)serialization
//                               helpers used by BOTH buildTemplate
//                               (export) and buildCanvasPayload (save)
//                               so per-record fields can't drift.
//   inSet: (set, val) => boolean.
//   pushInaccessiblePlaceholder: placeholder helper for stripped
//                                 drafts (non-owner load path).
//   runSlotPreflight: async; slot canvas preflight.
//   clearDraft: drops the local draft for an id.
//
// Public API (returned from mount):
//   buildTemplate, sanitizeFilename, buildCanvasPayload,
//   downloadTemplate, saveTemplateRemote, validateTemplate,
//   applyTemplate, applyCanvasPayload: all re-exported under their
//   original names so app.js's existing call sites work unchanged.
//
// Exposed as window.OrgLoom.templates. Load order: before app.js.

(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.templates = {
		mount: function mount(deps) {
			const _required = ['canvasState', 'showBulkToast', 'escapeHtml',
				'csrfFetch', 'ensureDescribe', 'addToSelection', 'setGraphView',
				'renderAll', 'showReplaceOrMergeDialog', 'pingAuditEvent',
				'getCanvasRecordCap', 'realRecordCount', 'runSlotPreflight',
				'clearEmptyStarterCard'];
			for (const k of _required) {
				if (deps == null || deps[k] == null) {
					throw new Error('templates.mount: missing required dep: ' + k);
				}
			}
			const canvasState = deps.canvasState;
			const showBulkToast = deps.showBulkToast;
			const escapeHtml = deps.escapeHtml;
			const csrfFetch = deps.csrfFetch;
			const ensureDescribe = deps.ensureDescribe;
			const addToSelection = deps.addToSelection;
			const setGraphView = deps.setGraphView;
			const renderAll = deps.renderAll;
			const showReplaceOrMergeDialog = deps.showReplaceOrMergeDialog;
			const pingAuditEvent = deps.pingAuditEvent;
			const _getCanvasRecordCap = deps.getCanvasRecordCap;
			const _realRecordCount = deps.realRecordCount;
			const _runSlotPreflight = deps.runSlotPreflight;
			const clearEmptyStarterCard = deps.clearEmptyStarterCard;
			// Count-aware canvas record-cap gate (single source of truth).
			// Optional dep so older mounts don't throw; defaults to "always
			// allowed". Used by applyCanvasPayload's import/merge gate.
			const canvasCapCheck = typeof deps.canvasCapCheck === 'function'
				? deps.canvasCapCheck
				: function () {
 return { ok: true, blocked: false, reason: null }; 
};
			// Optional: action-toast for the post-import Undo. Falls back to
			// the plain toast when the dep (or an undo callback) is absent.
			const showBulkToastWithAction = typeof deps.showBulkToastWithAction === 'function'
				? deps.showBulkToastWithAction
				: null;

			// _CANVAS_RECORD_CAP_get() reads through a getter so the value is
			// fetched at apply time rather than at mount time.
			const _CANVAS_RECORD_CAP_get = () => _getCanvasRecordCap();

				const TEMPLATE_VERSION = 1;
				const TEMPLATE_RECORD_CAP = 500;
				// Best-effort cleanup of the old browser-stored templates
				// localStorage key. The "Save to this browser" feature was
				// removed when canvas storage moved to ContentVersion in
				// SF Files; users with leftover entries can't reach them
				// through any UI, so we just remove the key on next load.
				try {
 localStorage.removeItem('sf-loader-templates-v1'); 
} catch (_) {}

				// --- Shared per-record (de)serialization helpers ----------------
				// Both serializers (buildTemplate = JSON export, buildCanvasPayload
				// = org save) and the file re-import (applyTemplate) compose from
				// these, so a new per-record field is added in ONE place instead of
				// drifting between paths (how slots + pendingDelete were originally
				// dropped from export).

				// Schema/object list. Export relies on array order; save also stores
				// an explicit idx. Otherwise identical.
				function serializeObjects(includeIdx) {
					const idxById = new Map();
					canvasState.selectedObjects.forEach((s, i) => idxById.set(s.id, i));
					return canvasState.selectedObjects.map((s, idx) => {
						const o = {
							name: s.name,
							label: s.label || s.name,
							addedFromIdx: s.addedFrom != null ? idxById.get(s.addedFrom) : null,
							addedVia: s.addedVia || null,
							worldPos: s.worldPos || null,
						};
						if (includeIdx) {
							o.idx = idx;
						}
						return o;
					});
				}

				// Extra attributes every serialized record carries regardless of
				// format: slot metadata + the pending-delete mark. Add future
				// per-record fields here so export and save both pick them up.
				function recordCommonParts(r) {
					const out = {};
					if (r.slot) {
						out.slot = r.slot;
					}
					if (r.pendingDelete) {
						out.pendingDelete = true;
					}
					return out;
				}

				// The fields a loaded record's user has edited (differ from the SF
				// baseline) as a { field: value } map, or null if unchanged.
				function loadedEditDelta(r) {
					if (!r.loadedValues) {
						return null;
					}
					const vc = (window.OrgLoom && window.OrgLoom.valueCompare) || null;
					if (!vc || typeof vc.changedFieldNames !== 'function') {
						return null;
					}
					const changed = vc.changedFieldNames(r.values || {}, r.loadedValues || {});
					if (!changed.length) {
						return null;
					}
					const changes = {};
					changed.forEach((f) => {
 changes[f] = (r.values || {})[f]; 
});
					return changes;
				}

				function buildTemplate(opts) {
					opts = opts || {};
					const schemaOnly = !!opts.schemaOnly;
					// When set, loaded-existing records keep their
					// loadedFromId on export so a same-org re-import
					// reconnects them to the live SF rows instead of
					// landing as fresh drafts. Off by default: the
					// stripped form is the portable one (works across
					// orgs).
					const preserveLoadedLinks = !!opts.preserveLoadedLinks;
					const objects = serializeObjects(false);
					// Schema-only export: emit the object structure but no records
					// or associations. The importer's existing schemaOnly path on
					// applyTemplate already handles a payload with empty records.
					// Records mode: include ALL canvas records, drafts AND
					// existing (loaded). Existing records export with their field
					// values and re-import as new draft records, so re-importing
					// into the same org can create duplicates; that's the user's
					// call (same outcome as unlinking an existing record first).
					let records;
					let associations;
					let includesLoadedData = false;
					if (schemaOnly) {
						records = [];
						associations = [];
					} else {
						const base = canvasState.bulkRecords.filter((r) => !r.isTypeNode);
						includesLoadedData = base.some((r) => !!r.loadedFromId);
						records = base.map(r => {
							// recordCommonParts carries slot + pendingDelete for every
							// record, in lockstep with Save.
							const rec = Object.assign({
								id: r.id,
								objectName: r.objectName,
								label: r.label,
								x: r.x,
								y: r.y,
								values: r.values || {},
							}, recordCommonParts(r));
							// Loaded records keep their live-SF link + baseline only
							// when the user opted into same-org round-trip; otherwise
							// they re-import as fresh drafts. The baseline (loadedValues)
							// is stored in-file so the export stays self-contained; the
							// `values` vs `loadedValues` diff reproduces the edits with
							// no live refetch needed.
							if (preserveLoadedLinks && r.loadedFromId) {
								rec.loadedFromId = r.loadedFromId;
								if (r.loadedValues) {
									rec.loadedValues = r.loadedValues;
								}
							}
							return rec;
						});
						if (records.length > TEMPLATE_RECORD_CAP) {
							throw new Error('Template exceeds the ' + TEMPLATE_RECORD_CAP + '-record cap (found ' + records.length + ').');
						}
						const keptIds = new Set(records.map(r => r.id));
						associations = canvasState.bulkAssociations
							.filter(a => keptIds.has(a.fromId) && keptIds.has(a.toId))
							.map(a => ({ fromId: a.fromId, toId: a.toId, fieldName: a.fieldName }));
					}
					return {
						_meta: {
							app: 'Org Loom',
							version: TEMPLATE_VERSION,
							exportedFrom: window.SF_ORG_ID || null,
							exportedBy: window.SF_USER_ID || null,
							exportedByName: window.SF_USER_NAME || null,
							exportedAt: new Date().toISOString(),
							schemaOnly,
							includesLoadedData,
							// Self-describing flag: applyTemplate uses it
							// to decide whether to surface a cross-org warning
							// when r.loadedFromId values are present.
							preservesLoadedLinks: preserveLoadedLinks && includesLoadedData,
							includedLoadedObjects: includesLoadedData
								? Array.from(new Set(canvasState.bulkRecords.filter((r) => !r.isTypeNode && r.loadedFromId).map((r) => r.objectName)))
								: [],
							recordCount: records.length,
						},
						schema: { objects },
						records,
						associations,
					};
				}

				function sanitizeFilename(s) {
					return String(s || 'orgloom-template').replace(/[^a-zA-Z0-9_\-. ]+/g, '_').slice(0, 80) || 'orgloom-template';
				}

				// Build the payload that ships to the customer's SF org as a
				// ContentVersion. Single shape: full fidelity, drafts with
				// values + loaded references + schema + associations.
				//
				// Owner-vs-non-owner draft visibility is enforced at LOAD
				// time, server-side: the file always contains everything,
				// but `GET /api/canvas/:id` strips drafts when the loader
				// isn't the owner. Owners get resume-where-they-left-off;
				// recipients get structure only, like the old "template"
				// path. One save action, one mental model.
				function buildCanvasPayload() {
					const objects = serializeObjects(true);
					const real = canvasState.bulkRecords.filter((r) => !r.isTypeNode && !r.isPending);
					// Loaded records: pointer + position (values are re-fetched live
					// on load) plus, for edited records, a `changes` delta so those
					// edits survive save→reopen on top of fresh SF values. Slot +
					// pendingDelete ride along via recordCommonParts (shared with
					// export so the two can't drift).
					const loadedRecords = real
						.filter((r) => !!r.loadedFromId)
						.map((r) => {
							const base = Object.assign({
								loadedFromId: r.loadedFromId,
								objectName: r.objectName,
								x: r.x,
								y: r.y,
							}, recordCommonParts(r));
							const changes = loadedEditDelta(r);
							if (changes) {
								base.changes = changes;
							}
							return base;
						});
					// Drafts: full values. Server may strip them on response
					// to non-owners; client always sends what it has. Every
					// draft on the canvas is persisted (including blank ones)
					// so a deliberately-created record (e.g. an empty Account
					// placeholder from "Create blank") survives the save→load
					// round-trip. (Empty drafts used to be dropped to avoid
					// auto-spawn "ghost" cards, but that silently lost records
					// the user had intentionally added: what you see on the
					// canvas when you save is what loads back.)
					const drafts = real
						.filter((r) => !r.loadedFromId)
						.map((r) => Object.assign({
							tempId: r.id,
							objectName: r.objectName,
							x: r.x,
							y: r.y,
							values: r.values || {},
						}, recordCommonParts(r)));
					// Resolve a record into the {kind, ref} pair used in the
					// serialized association list. Slot records take
					// precedence: even when the owner has a concrete
					// loadedFromId on a slot-flagged record, we serialize as
					// kind=slot so recipient loads still resolve via slotId
					// after the server strips the loadedFromId.
					const resolveRefKey = (rec) => {
						if (!rec) {
return null;
}
						if (rec.slot && rec.slot.slotId != null) {
							return { kind: 'slot', ref: rec.slot.slotId };
						}
						if (rec.loadedFromId) {
return { kind: 'loaded', ref: rec.loadedFromId };
}
						return { kind: 'draft', ref: rec.id };
					};
					const draftIds = new Set(drafts.filter((d) => !d.slot).map((d) => d.tempId));
					const loadedSet = new Set(loadedRecords.filter((l) => !l.slot).map((l) => l.loadedFromId));
					const slotIds = new Set(real.filter((r) => r.slot).map((r) => r.slot.slotId));
					const associations = canvasState.bulkAssociations
						.map((a) => {
							const fromRec = real.find((r) => r.id === a.fromId);
							const toRec = real.find((r) => r.id === a.toId);
							if (!fromRec || !toRec) {
return null;
}
							const fromKey = resolveRefKey(fromRec);
							const toKey = resolveRefKey(toRec);
							if (!fromKey || !toKey) {
return null;
}
							const inSet = (k) => k.kind === 'loaded'
								? loadedSet.has(k.ref)
								: k.kind === 'draft'
									? draftIds.has(k.ref)
									: slotIds.has(k.ref);
							if (!inSet(fromKey) || !inSet(toKey)) {
return null;
}
							return { from: fromKey, to: toKey, fieldName: a.fieldName };
						})
						.filter(Boolean);
					return {
						_meta: {
							app: 'Org Loom',
							version: TEMPLATE_VERSION,
							savedFrom: window.SF_ORG_ID || null,
							savedBy: window.SF_USER_ID || null,
							savedByName: window.SF_USER_NAME || null,
						},
						schema: { objects },
						loadedRecords,
						drafts,
						associations,
					};
				}

				function downloadTemplate(name, schemaOnly, opts) {
					opts = opts || {};
					let payload;
					try {
						payload = buildTemplate({
							schemaOnly,
							preserveLoadedLinks: !!opts.preserveLoadedLinks,
						});
					} catch (e) {
 showBulkToast(e.message, 'error'); return; 
}
					const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
					const url = URL.createObjectURL(blob);
					const a = document.createElement('a');
					a.href = url;
					a.download = sanitizeFilename(name) + '.orgloom.json';
					document.body.appendChild(a);
					a.click();
					setTimeout(() => {
 URL.revokeObjectURL(url); a.remove(); 
}, 0);
					const msg = schemaOnly
						? 'Downloaded schema (' + payload.schema.objects.length + ' object' + (payload.schema.objects.length === 1 ? '' : 's') + ').'
						: 'Downloaded ' + payload.records.length + '-record template.';
					showBulkToast(msg);
					pingAuditEvent('canvas_export_file', {
						recordCount: payload.records.length,
						payload: {
							name,
							schemaOnly: !!schemaOnly,
							objectCount: payload.schema.objects.length,
							includesLoadedData: !!(payload._meta && payload._meta.includesLoadedData),
						},
					});
				}

				// Server-stored save. `scope` = 'personal' (NULL team_id, only owner
				// sees) or 'team' (visible to all current-team members). Server
				// strips records on BOTH paths: only the schema (objects + FK
				// structure) is persisted. Records ride along to file exports;
				// for server saves, we always send schemaOnly:true.
				async function saveTemplateRemote(name, scope) {
					let payload;
					try {
 payload = buildTemplate({ schemaOnly: true }); 
} catch (e) {
 showBulkToast(e.message, 'error'); return; 
}
					try {
						const r = await csrfFetch('/api/templates', {
							method: 'POST',
							credentials: 'same-origin',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ name, scope: scope === 'team' ? 'team' : 'personal', payload }),
						});
						const data = await r.json().catch(() => ({}));
						if (!r.ok) {
throw new Error(data && data.error || 'HTTP ' + r.status);
}
						const where = scope === 'team' ? 'team workspace' : 'your personal workspace';
						showBulkToast('Saved schema \u201c' + name + '\u201d to ' + where + '.');
					} catch (e) {
						showBulkToast('Save failed: ' + (e.message || e), 'error');
					}
				}

				// Accept current ('Orgloom') plus historical brand tags
				// ('Org Loom', 'Orgloom', 'Seedsmith') so files exported
				// under any past brand still load. Error messages use
				// the current brand.
				const ACCEPTED_APP_TAGS = ['Orgloom', 'Org Loom', 'Seedsmith'];

				// A file stamped with a newer format version than this build
				// understands would misparse silently; refuse it instead.
				// Older versions (and files with no version) still load.
				function _checkFileVersion(meta) {
					const v = meta && meta.version;
					if (v != null && Number(v) > TEMPLATE_VERSION) {
						throw new Error('This file was exported by a newer version of Org Loom (file format v' + v + ', this app reads v' + TEMPLATE_VERSION + '). Refresh the app and try again.');
					}
				}

				// ---- Shared loader internals ----------------------------------
				// applyTemplate and applyCanvasPayload are parallel loaders for
				// the two file shapes. Guard logic lives here, ONCE, so a fix in
				// one shape can't silently miss the other (which is exactly how
				// the fieldless-edge and skip-count bugs happened).

				// Structurally-usable record/draft/loadedRecord entry.
				function _isRecordEntry(r) {
					return !!(r && typeof r === 'object' && typeof r.objectName === 'string' && r.objectName);
				}

				// values must be a plain field map; a crafted file with a
				// string/array here would render a broken card.
				function _cleanValues(v) {
					return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
				}

				// Association admission + honest-summary suffix live in
				// import-shared.js: one implementation across the JSON and
				// CSV importers so the rules can't drift between flows.
				const _admitAssociation = window.OrgLoom.importShared.admitAssociation;
				const _skipSuffix = window.OrgLoom.importShared.skipSuffix;

				// Final import-summary toast. When the dispatcher provided an
				// undo callback (file imports), render it as an action toast.
				function _summaryToast(msg, variant, opts) {
					if (opts && typeof opts.undo === 'function' && showBulkToastWithAction) {
						if (typeof opts.undo.arm === 'function') {
							opts.undo.arm();
						}
						showBulkToastWithAction(msg, 'Undo', opts.undo, variant);
					} else {
						showBulkToast(msg, variant);
					}
				}

				// Merge-mode placement: the file's records keep their own
				// coordinates, which routinely stack on top of existing cards
				// and read as "merge dropped my records". Shift the incoming
				// set as a group below the existing canvas bounding box,
				// preserving the file's internal layout. Replace mode (and an
				// empty canvas) imports at the file's coordinates untouched.
				function _mergeOffsetY(merge, incomingYs) {
					if (!merge || !incomingYs.length) {
						return 0;
					}
					const existing = canvasState.bulkRecords.filter((r) => !r.isTypeNode);
					if (!existing.length) {
						return 0;
					}
					const maxY = Math.max.apply(null, existing.map((r) => Number(r.y) || 0));
					const minIncoming = Math.min.apply(null, incomingYs);
					return (maxY + 260) - minIncoming;
				}
				// ---------------------------------------------------------------

				function validateTemplate(t) {
					if (!t || typeof t !== 'object') {
throw new Error('Invalid template: not an object.');
}
					if (!t._meta || !ACCEPTED_APP_TAGS.includes(t._meta.app)) {
						throw new Error('Not an Orgloom template file.');
					}
					_checkFileVersion(t._meta);
					if (!t.schema || !Array.isArray(t.schema.objects)) {
throw new Error('Invalid template: missing schema.objects.');
}
					if (!Array.isArray(t.records)) {
throw new Error('Invalid template: missing records.');
}
					if (!Array.isArray(t.associations)) {
throw new Error('Invalid template: missing associations.');
}
					if (t.records.length > TEMPLATE_RECORD_CAP) {
throw new Error('Template exceeds the ' + TEMPLATE_RECORD_CAP + '-record cap.');
}
				}

				// Structural gate for the saved-canvas payload shape
				// (buildCanvasPayload output: loadedRecords/drafts). Only the
				// FILE import path calls this: org-store loads pass server
				// payloads that were validated at save time and may predate
				// _meta. Without this gate a hand-crafted {"drafts": []}
				// bypasses the brand check entirely and (on Replace) wipes
				// the canvas while reporting success.
				function validateCanvasPayload(p) {
					if (!p || typeof p !== 'object') {
throw new Error('Invalid canvas file: not an object.');
}
					if (!p._meta || !ACCEPTED_APP_TAGS.includes(p._meta.app)) {
						throw new Error('Not an Orgloom canvas file.');
					}
					_checkFileVersion(p._meta);
					if (!p.schema || !Array.isArray(p.schema.objects)) {
throw new Error('Invalid canvas file: missing schema.objects.');
}
					if (!Array.isArray(p.associations)) {
throw new Error('Invalid canvas file: missing associations.');
}
				}

				async function applyTemplate(t, opts) {
					opts = opts || {};
					const schemaOnly = !!opts.schemaOnly;
					// `merge: true` skips the reset block below; the
					// new template is appended to whatever's already on
					// the canvas. Schema entries get new ids (canvasState.selectedObjects
					// always appends), records get fresh ids via the
					// existing idMap remap, associations follow the
					// remapped record ids. Default behavior remains
					// "replace canvas" so direct callers (legacy paths)
					// don't need to opt in.
					const merge = !!opts.merge;
					validateTemplate(t);
					// Canvas cap check. Replace mode wipes the canvas first
					// so only the template's records count; merge mode adds
					// to whatever's already there.
					{
						const incoming = (Array.isArray(t.records) ? t.records.length : 0);
						const existingCount = merge ? _realRecordCount() : 0;
						if (existingCount + incoming > _CANVAS_RECORD_CAP_get()) {
							throw new Error('Loading this template would put the canvas over the ' + _CANVAS_RECORD_CAP_get() + '-record cap (' + (existingCount + incoming) + '). Remove some records or reset the canvas first.');
						}
					}
					// Cross-org: warn (non-blocking). FK values pointing at specific
					// record ids won't resolve if they were from another org, but
					// user-entered text values work fine cross-org. Folded into the
					// final summary toast: an early separate toast is removed by
					// the summary toast before anyone can read it.
					const _crossOrg = !!(t._meta.exportedFrom && window.SF_ORG_ID && t._meta.exportedFrom !== window.SF_ORG_ID);
					// Drop the lone empty starter card before the template
					// applies. Replace mode wipes everything below anyway,
					// so the helper is a no-op there; merge mode benefits
					// directly.
					clearEmptyStarterCard();
					if (!merge) {
						// Full canvas-state reset before replaying the template's
						// objects: clear selection + bulk state so the next
						// renderBulkView re-seeds cleanly from scratch.
						canvasState.selectedObjects = [];
						canvasState.selectedIdSeq = 1;
						canvasState.activeIndex = 0;
						canvasState.hiddenObjects.clear();
						canvasState.bulkRecords = [];
						canvasState.bulkAssociations = [];
						canvasState.bulkIdSeq = 1;
						canvasState.bulkSelectedIds = new Set();
						canvasState.bulkSelectedEdgeId = null;
						canvasState.bulkInitialized = false;
						canvasState._bulkUserDeleted = false;
						canvasState._lastBulkZoomSig = null;
						canvasState._bulkSeenIds = null;
						canvasState._prefetchedTypeNodeKeys.clear();
						canvasState._renderedRecIds.clear();
					}
					// Rehydrate schema tree (fetches describe data per object; the
					// top-bar progress stripe covers the wait).
					const idByIdx = [];
					for (let i = 0; i < t.schema.objects.length; i++) {
						const obj = t.schema.objects[i];
						const parentId = obj.addedFromIdx != null ? idByIdx[obj.addedFromIdx] : null;
						try {
							const entry = await addToSelection(obj.name, parentId, obj.addedVia || null, obj.worldPos || null);
							idByIdx.push(entry.id);
						} catch (e) {
							console.warn('Template apply: failed to re-add', obj.name, e);
							idByIdx.push(null);
						}
					}
					// Remap the template's record ids to fresh ids from canvasState.bulkIdSeq,
					// then rewire associations to the new ids. Schema-only imports
					// skip this entirely; the canvas structure was rebuilt above
					// from t.schema.objects, but no records or FK links are added.
					// Track what the import drops so the summary is honest rather
					// than reporting the raw file count (silent data loss).
					let skippedRecords = 0;
					let skippedAssoc = 0;
					let demotedToDrafts = 0;
					if (!schemaOnly) {
						const idMap = new Map();
						// Cross-org guard for loadedFromId: a preserved link
						// is only meaningful in the same SF org. If the
						// importer's org doesn't match the exporter's, drop
						// the link so the records land as fresh drafts
						// instead of pointing at unrelated records by id.
						const sameOrg = !!(t._meta && t._meta.exportedFrom)
							&& t._meta.exportedFrom === window.SF_ORG_ID;
						const honorLoadedLinks = !!(t._meta && t._meta.preservesLoadedLinks) && sameOrg;
						const _offY = _mergeOffsetY(merge,
							t.records.filter(_isRecordEntry).map((r) => Number(r.y) || 200));
						t.records.forEach(r => {
							// Skip structurally-invalid records (not an object, or no
							// usable objectName) instead of pushing a broken card.
							if (!_isRecordEntry(r)) {
								skippedRecords += 1;
								return;
							}
							const newId = canvasState.bulkIdSeq++;
							idMap.set(r.id, newId);
							const matchingSel = canvasState.selectedObjects.find(s => s.name === r.objectName);
							const rec = {
								id: newId,
								objectName: r.objectName,
								label: (matchingSel && matchingSel.label) || r.label || r.objectName,
								x: Number(r.x) || 200,
								y: (Number(r.y) || 200) + _offY,
								values: _cleanValues(r.values),
							};
							if (r.loadedFromId) {
								if (honorLoadedLinks) {
									rec.loadedFromId = r.loadedFromId;
									// Restore the SF baseline so `values` vs
									// `loadedValues` re-marks exactly the fields the
									// user had edited at export time; the
									// modified-state (and thus the pending update)
									// survives the round-trip instead of being lost.
									if (r.loadedValues && typeof r.loadedValues === 'object') {
										rec.loadedValues = Object.assign({}, r.loadedValues);
									}
									// Restore a marked-for-delete existing record so the
									// "delete on upload" mark survives the round-trip.
									if (r.pendingDelete) {
										rec.pendingDelete = true;
									}
								} else {
									demotedToDrafts += 1;
								}
							}
							// Restore slot (fill-in) metadata and keep the slot-id
							// counter ahead of any restored ids so new slots don't
							// collide. Slots are independent of the loaded-link gate.
							if (r.slot && r.slot.slotId != null) {
								rec.slot = r.slot;
								slotIdSeq = Math.max(slotIdSeq, r.slot.slotId + 1);
							}
							canvasState.bulkRecords.push(rec);
						});
						// Drop edges whose endpoints didn't survive the import,
						// that name no lookup field, or that would double a
						// single-value lookup; _admitAssociation owns the rules
						// (shared with applyCanvasPayload).
						const usedFk = new Set();
						t.associations.forEach(a => {
							const from = idMap.get(a && a.fromId);
							const to = idMap.get(a && a.toId);
							if (!_admitAssociation(usedFk, from, to, a && a.fieldName)) {
								skippedAssoc += 1;
								return;
							}
							canvasState.bulkAssociations.push({ id: canvasState.bulkIdSeq++, fromId: from, toId: to, fieldName: a.fieldName });
						});
					}
					canvasState.bulkInitialized = true;
					canvasState.activeIndex = 0;
					// Schema-only loads land you on the schema canvas (you'll add
					// records there); fixture loads jump to the records view since
					// the records are what you came for.
					if (typeof setGraphView === 'function') {
setGraphView(schemaOnly ? 'schema' : 'bulk');
}
					renderAll();
					const _objectCount = (t.schema.objects || []).length;
					if (schemaOnly) {
						_summaryToast('Imported schema: ' + _objectCount + ' object' + (_objectCount === 1 ? '' : 's') + '. Records were not included.', undefined, opts);
						if (opts.importFileName) {
pingAuditEvent('canvas_load_file', {
							recordCount: 0,
							payload: {
								name: opts.importFileName || null,
								mode: merge ? 'merge' : 'replace',
								schemaOnly: true,
								objectCount: _objectCount,
							},
						});
}
					} else {
						const totalRecords = t.records.length;
						const importedCount = totalRecords - skippedRecords;
						// Always show "N of M" so the count is explicit and the
						// import is visibly verifiable even on a clean file. Every
						// caveat (skips, cross-org demotions) lives in this ONE
						// toast; showBulkToast removes prior toasts, so anything
						// surfaced separately before this line would be unreadable.
						let msg = 'Imported ' + importedCount + ' of ' + totalRecords + ' record' + (totalRecords === 1 ? '' : 's') + '.';
						msg += _skipSuffix(skippedRecords, skippedAssoc);
						if (demotedToDrafts > 0) {
							msg += ' ' + demotedToDrafts + ' loaded record' + (demotedToDrafts === 1 ? '' : 's') +
								' re-imported as draft' + (demotedToDrafts === 1 ? '' : 's') + ' (exported from a different org).';
						} else if (_crossOrg) {
							msg += ' Exported from a different org; Salesforce id references may not match here.';
						}
						const _caveats = skippedRecords > 0 || skippedAssoc > 0 || demotedToDrafts > 0 || _crossOrg;
						_summaryToast(msg, _caveats ? 'error' : undefined, opts);
						if (opts.importFileName) {
pingAuditEvent('canvas_load_file', {
							recordCount: importedCount,
							payload: {
								name: opts.importFileName || null,
								mode: merge ? 'merge' : 'replace',
								schemaOnly: false,
								objectCount: _objectCount,
								skippedRecords,
								skippedAssoc,
							},
						});
}
					}
				}

				// Apply a payload coming from the ContentVersion-backed
				// /api/canvas store.
				//   - loadedRecords carry only loadedFromId; values are
				//     re-fetched live from SF using the loading user's
				//     session, so FLS / sharing rules / record-deletes
				//     apply naturally
				//   - drafts arrive with values when the loader is the
				//     file owner; with values stripped (structure only)
				//     when the loader isn't the owner. Server enforces
				//     this; client just renders what it gets.
				//   - associations use {kind, ref} endpoints (loaded via
				//     loadedFromId, draft via tempId)
				async function applyCanvasPayload(payload, opts) {
					opts = opts || {};
					const merge = !!opts.merge;
					if (!payload || typeof payload !== 'object') {
						showBulkToast('Empty payload: nothing to load.', 'error');
						return;
					}
					const schemaObjects = (payload.schema && payload.schema.objects) || [];
					const loadedRefs = Array.isArray(payload.loadedRecords) ? payload.loadedRecords : [];
					const drafts = Array.isArray(payload.drafts) ? payload.drafts : [];
					const associations = Array.isArray(payload.associations) ? payload.associations : [];

					const incomingCount = loadedRefs.length + drafts.length;
					// Canvas record-cap enforcement, routed through the shared
					// count-aware gate. NUANCE: this function also backs normal
					// load-saved-canvas, org-switch, and migration-restore, all
					// REPLACE flows (merge === false) that swap in an existing
					// (already ≤cap) canvas. We must not break those.
					//   merge mode: the canvas isn't wiped, so the live count
					//     canvasCapCheck reads IS the existing canvas; checking
					//     incomingCount on top of it is exactly right.
					//   replace mode: the canvas is wiped below (line ~597), so
					//     the effective baseline is 0; only the payload's own
					//     size matters. A normal saved canvas is always ≤cap so
					//     it passes naturally; only a genuinely oversized
					//     external/fixture import (incomingCount > cap) is
					//     refused. We model that without reading the live
					//     (about-to-be-wiped) count.
					let _cap;
					if (merge) {
						_cap = canvasCapCheck(incomingCount);
					} else {
						const _probe = canvasCapCheck(incomingCount);
						_cap = incomingCount > _probe.cap
							? { blocked: true, reason: _probe.reason }
							: { blocked: false, reason: null };
					}
					if (_cap.blocked) {
						showBulkToast(_cap.reason, 'error');
						return;
					}
					// Drop the lone empty starter card before the canvas
					// payload applies. Replace mode wipes everything below
					// anyway; merge mode benefits directly.
					clearEmptyStarterCard();
					if (!merge) {
						canvasState.selectedObjects = [];
						canvasState.selectedIdSeq = 1;
						canvasState.activeIndex = 0;
						canvasState.hiddenObjects.clear();
						// Replace mode wipes "the canvas you have open" too.
						// Whoever called us (load handler, file import, etc.)
						// is responsible for setting canvasState.currentCanvas if the
						// new state corresponds to a saved canvas.
						canvasState.currentCanvas = null;
						// Also drop any in-memory draft id so the next
						// blank canvas gets a fresh draft id rather than
						// reusing the previous one (which would mislead
						// AI clients into thinking it's the same canvas).
						if (window.Orgloom && window.Orgloom.canvasState && window.Orgloom.canvasState.clearDraft) {
							window.Orgloom.canvasState.clearDraft();
						}
						canvasState.bulkRecords = [];
						canvasState.bulkAssociations = [];
						canvasState.bulkIdSeq = 1;
						canvasState.bulkSelectedIds = new Set();
						canvasState.bulkSelectedEdgeId = null;
						canvasState.bulkInitialized = false;
						canvasState._bulkUserDeleted = false;
						canvasState._lastBulkZoomSig = null;
						canvasState._bulkSeenIds = null;
						canvasState._prefetchedTypeNodeKeys.clear();
						canvasState._renderedRecIds.clear();
						canvasState._autoSpawnedPending = true; // suppress auto-spawn after load
					}

					// Rehydrate schema entries. Same idx-mapped FK rebuild as
					// applyTemplate so addedFromIdx wires back correctly.
					const idByIdx = [];
					for (let i = 0; i < schemaObjects.length; i++) {
						const obj = schemaObjects[i];
						const parentId = obj.addedFromIdx != null ? idByIdx[obj.addedFromIdx] : null;
						try {
							const entry = await addToSelection(obj.name, parentId, obj.addedVia || null, obj.worldPos || null);
							idByIdx.push(entry.id);
						} catch (e) {
							console.warn('Canvas apply: failed to re-add', obj.name, e);
							idByIdx.push(null);
						}
					}

					// Re-fetch loaded records live. Each fetch goes through
					// the loading user's session; FLS, sharing, and record
					// deletes all surface naturally as 404s or filtered
					// fields. Records the user can no longer access are
					// dropped with a warning toast at the end.
					//
					// Slots: a slot-flagged loaded record arrives without
					// loadedFromId (server stripped it for non-owners). We
					// don't fetch; we render it as a slot card instead.
					// Owner reads keep the loadedFromId, so the fetch path
					// runs and they see their working canvas.
					const loadedById = new Map(); // loadedFromId → bulkId
					const slotById = new Map();   // slotId → bulkId
					let droppedFromAccess = 0;
					// Structurally-invalid entries (not an object / no usable
					// objectName) are skipped and counted so the summary toast
					// stays honest; same contract as applyTemplate.
					let skippedRecords = 0;
					// Merge placement: shift the incoming set below the existing
					// canvas (shared helper; 0 in replace mode / empty canvas).
					const _offY = _mergeOffsetY(merge,
						loadedRefs.filter(_isRecordEntry).map((r) => Number(r.y) || 200)
							.concat(drafts.filter(_isRecordEntry).map((d) => Number(d.y) || 200)));
					// Build a "no access" placeholder card for a loadedRecord
					// the live-fetch couldn't return (404 / 403 / network).
					// Dropping the record outright also silently drops every
					// association into it, so the recipient can't even tell a
					// node is missing or what it connected to. Instead we keep
					// a locked card at the record's saved x/y and register it in
					// loadedById, so (a) edges into it still render and (b) a
					// re-save preserves the loadedRecord ref for users who *can*
					// see it. Still bumps droppedFromAccess so the summary
					// banner reports a count.
					const pushInaccessiblePlaceholder = (ref, isSlot) => {
						droppedFromAccess++;
						const matchingSel = canvasState.selectedObjects.find((s) => s.name === ref.objectName);
						const newId = canvasState.bulkIdSeq++;
						if (ref.loadedFromId) {
loadedById.set(ref.loadedFromId, newId);
}
						const recObj = {
							id: newId,
							objectName: ref.objectName,
							label: (matchingSel && matchingSel.label) || ref.objectName,
							fromSelectionId: matchingSel ? matchingSel.id : null,
							loadedFromId: ref.loadedFromId || null,
							x: Number(ref.x) || 200,
							y: (Number(ref.y) || 200) + _offY,
							values: {},
							_inaccessible: true,
						};
						// Keep slot metadata if present so a re-save round-trips
						// the slot structure; rendering checks _inaccessible
						// first, so the card shows as locked, not fillable.
						if (isSlot && ref.slot && ref.slot.slotId != null) {
							recObj.slot = {
								label: ref.slot.label,
								slotId: ref.slot.slotId,
								description: ref.slot.description || null,
								kind: ref.slot.kind || 'whole-record',
							};
							slotById.set(ref.slot.slotId, newId);
							slotIdSeq = Math.max(slotIdSeq, ref.slot.slotId + 1);
						}
						canvasState.bulkRecords.push(recObj);
					};
					// Merge-mode dedup: index existing canvas loaded records
					// by `objectName::sfId` so refs that already have a card
					// don't get re-fetched + re-pushed (would produce visual
					// duplicates on the canvas). Replace mode wiped canvasState.bulkRecords
					// up at line 5249, so the index is empty there; same code
					// path, no special-casing needed.
					const mergeExistingByKey = new Map();
					if (merge) {
						canvasState.bulkRecords.forEach((br) => {
							if (br.isTypeNode || !br.loadedFromId) {
return;
}
							mergeExistingByKey.set(br.objectName + '::' + br.loadedFromId, br.id);
						});
					}
					let skippedExistingMerge = 0;
					// Pass 1: classify refs synchronously (merge dedup, empty
					// slots handle inline) and queue the live fetches.
					const _fetchJobs = [];
					for (const ref of loadedRefs) {
						if (!_isRecordEntry(ref)) {
							skippedRecords += 1;
							continue;
						}
						const isSlot = ref.slot && ref.slot.slotId != null;
						const hasLoadedId = !!ref.loadedFromId;
						// In merge mode, if this ref's record is already on
						// the canvas, point loadedById at the existing card
						// (so associations rewire correctly) and skip the fetch.
						if (merge && hasLoadedId) {
							const existingId = mergeExistingByKey.get(ref.objectName + '::' + ref.loadedFromId);
							if (existingId != null) {
								loadedById.set(ref.loadedFromId, existingId);
								skippedExistingMerge++;
								continue;
							}
						}
						if (isSlot && !hasLoadedId) {
							// Empty slot: recipient view of a slot-marked loaded record.
							// Server stripped loadedFromId for non-owner reads, so this
							// branch fires for recipients. _recipientSlot flag tags the
							// card so renderers show the fill CTAs (Load existing /
							// Create blank). Owners who marked the slot locally don't
							// get the flag and see the regular authoring view + slot
							// badge.
							const matchingSel = canvasState.selectedObjects.find((s) => s.name === ref.objectName);
							const newId = canvasState.bulkIdSeq++;
							slotById.set(ref.slot.slotId, newId);
							slotIdSeq = Math.max(slotIdSeq, ref.slot.slotId + 1);
							canvasState.bulkRecords.push({
								id: newId,
								objectName: ref.objectName,
								label: (matchingSel && matchingSel.label) || ref.objectName,
								fromSelectionId: matchingSel ? matchingSel.id : null,
								x: Number(ref.x) || 200,
								y: (Number(ref.y) || 200) + _offY,
								values: {},
								slot: {
									label: ref.slot.label,
									slotId: ref.slot.slotId,
									description: ref.slot.description || null,
									// Whole-record slots end up here (loadedFromId
									// stripped by the server). Field-level slots
									// keep their loadedFromId and follow the live-
									// fetch path below.
									kind: ref.slot.kind || 'whole-record',
								},
								_recipientSlot: true,
							});
							continue;
						}
						_fetchJobs.push({ ref: ref, isSlot: isSlot });
					}
					// Run the queued fetches through a small concurrency pool;
					// one-await-per-record made a 200-record canvas 200 serial
					// round-trips. Results stay index-aligned so pass 2 hydrates
					// cards in file order (stable ids and layout).
					const _fetchResults = new Array(_fetchJobs.length);
					{
						let _next = 0;
						const _fetchWorker = async () => {
							for (;;) {
								const idx = _next++;
								if (idx >= _fetchJobs.length) {
									return;
								}
								const job = _fetchJobs[idx];
								try {
									const r = await csrfFetch(
										'/api/objects/' + encodeURIComponent(job.ref.objectName) +
										'/records/' + encodeURIComponent(job.ref.loadedFromId),
										{ credentials: 'same-origin' },
									);
									// 404/403 (deleted / no access) and any other
									// non-OK both fall to the placeholder in pass 2.
									_fetchResults[idx] = r.ok ? { ok: true, sf: await r.json() } : { ok: false };
								} catch (e) {
									_fetchResults[idx] = { ok: false };
								}
							}
						};
						await Promise.all(Array.from({ length: Math.min(6, _fetchJobs.length) }, _fetchWorker));
					}
					// Pass 2: build cards in file order from the fetched values.
					_fetchJobs.forEach((job, jobIdx) => {
						const ref = job.ref;
						const isSlot = job.isSlot;
						const _result = _fetchResults[jobIdx];
						if (!_result || !_result.ok) {
							pushInaccessiblePlaceholder(ref, isSlot);
							return;
						}
						const matchingSel = canvasState.selectedObjects.find((s) => s.name === ref.objectName);
						const newId = canvasState.bulkIdSeq++;
						loadedById.set(ref.loadedFromId, newId);
						// Baseline = fresh SF values; overlay the saved edit
						// delta (ref.changes) on top so the user's un-uploaded
						// edits to this existing record survive save→load. Only
						// the changed fields are overlaid; everything else
						// stays live, and the card re-renders as modified on
						// exactly those fields.
						const _fresh = _result.sf || {};
						const recObj = {
							id: newId,
							objectName: ref.objectName,
							label: (matchingSel && matchingSel.label) || ref.objectName,
							fromSelectionId: matchingSel ? matchingSel.id : null,
							loadedFromId: ref.loadedFromId,
							x: Number(ref.x) || 200,
							y: (Number(ref.y) || 200) + _offY,
							loadedValues: Object.assign({}, _fresh),
							values: (ref.changes && typeof ref.changes === 'object')
								? Object.assign({}, _fresh, ref.changes)
								: _fresh,
						};
						if (ref.pendingDelete) {
							recObj.pendingDelete = true;
						}
						if (isSlot) {
							recObj.slot = {
								label: ref.slot.label,
								slotId: ref.slot.slotId,
								description: ref.slot.description || null,
								kind: ref.slot.kind || 'whole-record',
							};
							if (ref.slot.kind === 'fields' && Array.isArray(ref.slot.fields)) {
								recObj.slot.fields = ref.slot.fields.slice();
								// Field-level slots are recipient-fillable on
								// the loaded record itself; mark so the modal
								// renders the slot-mode banner.
								if (!opts.ownedByMe) {
recObj._recipientSlot = true;
}
							}
							slotById.set(ref.slot.slotId, newId);
							slotIdSeq = Math.max(slotIdSeq, ref.slot.slotId + 1);
						}
						canvasState.bulkRecords.push(recObj);
					});

					// Hydrate drafts. Owner gets full values from the file;
					// non-owners get drafts with no values (server stripped
					// them); those spawn as empty drafts the user can
					// fill in. Draft slots: same, rendered as a slot card,
					// but only for non-owners (recipients). Owners
					// reopening their own canvas see the authoring view +
					// slot badge.
					const draftById = new Map(); // payload tempId → bulkId
					drafts.forEach((d) => {
						if (!_isRecordEntry(d)) {
							skippedRecords += 1;
							return;
						}
						const newId = canvasState.bulkIdSeq++;
						draftById.set(d.tempId, newId);
						const matchingSel = canvasState.selectedObjects.find((s) => s.name === d.objectName);
						const recObj = {
							id: newId,
							objectName: d.objectName,
							label: (matchingSel && matchingSel.label) || d.objectName,
							fromSelectionId: matchingSel ? matchingSel.id : null,
							x: Number(d.x) || 200,
							y: (Number(d.y) || 200) + _offY,
							values: _cleanValues(d.values),
							// _persistedTempId remembers the tempId we read
							// from the payload so AI-proposal apply can map
							// server-side endpoint refs (which use persisted
							// tempIds, not runtime ids) back to the matching
							// runtime bulkRecord. Cleared on the next save;
							// at save time `tempId: r.id` rewrites the
							// persisted tempId to whatever the runtime id is.
							_persistedTempId: d.tempId,
						};
						if (d.slot && d.slot.slotId != null) {
							recObj.slot = {
								label: d.slot.label,
								slotId: d.slot.slotId,
								description: d.slot.description || null,
								kind: d.slot.kind || 'whole-record',
							};
							// Field-level slots only make sense on loaded records
							// (no sense filling fields on a record that doesn't
							// exist yet). If a draft somehow carries kind:fields,
							// drop it back to whole-record to fail safe.
							if (recObj.slot.kind === 'fields') {
recObj.slot.kind = 'whole-record';
}
							slotById.set(d.slot.slotId, newId);
							slotIdSeq = Math.max(slotIdSeq, d.slot.slotId + 1);
							if (!opts.ownedByMe) {
recObj._recipientSlot = true;
}
						}
						canvasState.bulkRecords.push(recObj);
					});

					// Wire associations. Endpoint resolves via loadedById,
					// draftById, or slotById depending on kind. Drop
					// associations whose endpoints didn't survive the load
					// (e.g., a loaded record the user no longer has access to).
					const resolveEndpoint = (e) => {
						if (!e) {
return null;
}
						if (e.kind === 'loaded') {
return loadedById.get(e.ref);
}
						if (e.kind === 'draft') {
return draftById.get(e.ref);
}
						if (e.kind === 'slot') {
return slotById.get(e.ref);
}
						return null;
					};
					// In merge mode, skip association triples that already
					// exist on the canvas; common when the merged file
					// references the same parent + same FK as a card already
					// loaded.
					const existingAssocKey = new Set();
					// A reference (lookup) field is single-value: at most one association
					// per (holder, fieldName). Track used FK slots so a crafted / hand-edited
					// file can't import duplicates (the canvas UI blocks this interactively).
					const usedFk = new Set();
					canvasState.bulkAssociations.forEach((a) => {
						if (merge) {
existingAssocKey.add(a.fromId + '->' + a.toId + '::' + a.fieldName);
}
						usedFk.add(a.fromId + '::' + a.fieldName);
					});
					// Dropped edges are counted, not silent: dangling endpoints,
					// fieldless entries, and single-value-lookup conflicts all
					// surface in the summary toast via _admitAssociation (shared
					// with applyTemplate). A merge-mode skip of an edge that
					// already exists identically is dedup, not loss; checked
					// BEFORE the FK gate so it is deliberately NOT counted.
					let skippedAssoc = 0;
					associations.forEach((a) => {
						if (!a || typeof a !== 'object') {
							skippedAssoc += 1;
							return;
						}
						const fromId = resolveEndpoint(a.from);
						const toId = resolveEndpoint(a.to);
						const key = fromId + '->' + toId + '::' + a.fieldName;
						if (merge && existingAssocKey.has(key)) {
							return;
						}
						if (!_admitAssociation(usedFk, fromId, toId, a.fieldName)) {
							skippedAssoc += 1;
							return;
						}
						canvasState.bulkAssociations.push({ id: canvasState.bulkIdSeq++, fromId, toId, fieldName: a.fieldName });
						if (merge) {
existingAssocKey.add(key);
}
					});

					// Mark initialized BEFORE setGraphView fires the first
					// renderBulkView. Without this, renderBulkView's
					// `if (!canvasState.bulkInitialized)` branch runs seedBulkRecords,
					// which spawns a draft per canvasState.selectedObjects entry; every
					// loaded record we just hydrated would get a duplicate
					// blank draft alongside it.
					canvasState.bulkInitialized = true;
					if (typeof setGraphView === 'function') {
setGraphView('bulk');
}
					renderAll();
					// Preflight slot accessibility (background, doesn't
					// block initial render). Adds ⚠ badges to slot cards
					// whose object the loader can't describe and surfaces
					// a summary toast.
					_runSlotPreflight().catch((e) => console.warn('slot preflight failed:', e));
					let msg = 'Loaded canvas: ' + loadedById.size + ' existing record' +
						(loadedById.size === 1 ? '' : 's') + ', ' + draftById.size + ' draft' +
						(draftById.size === 1 ? '' : 's') + '.';
					if (droppedFromAccess > 0) {
						msg += ' (' + droppedFromAccess + ' record' + (droppedFromAccess === 1 ? '' : 's') +
							' shown as \u201cno access\u201d, since Salesforce didn\u2019t return ' +
							(droppedFromAccess === 1 ? 'it' : 'them') + '.)';
					}
					if (skippedExistingMerge > 0) {
						msg += ' Skipped ' + skippedExistingMerge + ' record' + (skippedExistingMerge === 1 ? '' : 's') +
							' already on the canvas.';
					}
					if (opts.ownedByMe === false) {
						msg += ' Draft values from the original author are hidden.';
					}
					const _skips = _skipSuffix(skippedRecords, skippedAssoc);
					msg += _skips;
					_summaryToast(msg, _skips ? 'error' : undefined, opts);
					if (opts.importFileName) {
pingAuditEvent('canvas_load_file', {
						recordCount: loadedById.size + draftById.size,
						payload: {
							name: opts.importFileName || null,
							mode: merge ? 'merge' : 'replace',
							shape: 'saved-canvas',
							loadedCount: loadedById.size,
							draftCount: draftById.size,
							droppedFromAccess,
							skippedExistingMerge,
							skippedRecords,
							skippedAssoc,
						},
					});
}
				}

			return {
				buildTemplate: buildTemplate,
				sanitizeFilename: sanitizeFilename,
				buildCanvasPayload: buildCanvasPayload,
				downloadTemplate: downloadTemplate,
				saveTemplateRemote: saveTemplateRemote,
				validateTemplate: validateTemplate,
				validateCanvasPayload: validateCanvasPayload,
				applyTemplate: applyTemplate,
				applyCanvasPayload: applyCanvasPayload,
			};
		},
	};
})();
