// Related-records flow.
//
// Three intertwined pieces that surface a loaded record's
// relationships on the records canvas:
//
//   showRelatedPopover: the chip popover that lists this
//                            record's child + parent FK relationships
//                            with counts. Each row navigates to a
//                            type-node placeholder on the canvas.
//   loadRelatedFromChip: fired when the user picks a row;
//                            seeds a type-node and (eventually)
//                            loads its records via the related-counts
//                            cache + the records cy renderer.
//   seedEditModeTypeNodes: fans out a host record's children +
//                            parents as on-canvas type-nodes when
//                            the user opens it in edit mode.
//
// Plus a handful of small predicates that share the same closure:
//   _isSystemChildRelationship / _isSystemParentField: filter
//     SF bookkeeping objects (History, Share, Feed, ChangeEvent,
//     and a curated list of platform-managed junctions) out of the
//     chip + popover.
//   _ensureChipProbed: kicks off a single child-count probe per
//                        loaded record so the chip can show a real
//                        count instead of "?".
//   _sfIdValue / _sfIdMatch: 15-vs-18-char SF id normalisation.
//   _relInfoForRec: assembles the popover's row list from the
//                        record's describe + cached counts.
//
// Dependencies passed to mount():
//   canvasState: shared canvas state.
//   escapeHtml: HTML-escape helper for popover rows.
//   showBulkToast: error/info toast.
//   renderBulkView: re-paint after a relationship load
//                              spawns new type-nodes.
//   openTypeNode: open a type-node; the popover row's
//                              click handler dispatches through this.
//                              Lives in app.js (its own extraction
//                              is the next planned target).
//   fetchRelatedCountsBatch: batched count probe (related-counts).
//   _countCacheKey: same key shape (related-counts).
//   _relatedCountCache: same Map (related-counts).
//
// Public API (returned from mount):
//   showRelatedPopover, loadRelatedFromChip, seedEditModeTypeNodes,
//   _ensureChipProbed, _relInfoForRec, _isSystemChildRelationship,
//   _isSystemParentField, _sfIdValue, _sfIdMatch.
//
// Exposed as window.OrgLoom.relatedRecords. Load order: before app.js.

(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.relatedRecords = {
		mount: function mount(deps) {
			const required = [
				'canvasState', 'escapeHtml', 'showBulkToast',
				'renderBulkView', 'openTypeNode',
				'fetchRelatedCountsBatch', '_countCacheKey', '_relatedCountCache',
			];
			if (!deps) {
throw new Error('related-records.mount: missing deps object');
}
			for (const k of required) {
				if (deps[k] === undefined || deps[k] === null) {
					throw new Error('related-records.mount: missing dep ' + k);
				}
			}
			const canvasState = deps.canvasState;
			const escapeHtml = deps.escapeHtml;
			const showBulkToast = deps.showBulkToast;
			const renderBulkView = deps.renderBulkView;
			const openTypeNode = deps.openTypeNode;
			const fetchRelatedCountsBatch = deps.fetchRelatedCountsBatch;
			const _countCacheKey = deps._countCacheKey;
			const _relatedCountCache = deps._relatedCountCache;

			// Per-record probe state: tracks whether we've kicked off a
			// child-count probe for a loaded record so the chip and
			// popover can show only relationships that actually have
			// records to load. Set entry = 'probing' or 'done'.
			const _chipProbeState = new Map();
			
			// Filter out child relationships representing SF
			// bookkeeping (audit history, sharing rows, Chatter feed,
			// CDC events, file-attachment junctions, topic
			// assignments, approval-process steps, etc.); none of
			// these are records a user would meaningfully load onto
			// the canvas to view/edit/upload, so probing them
			// inflates the chip count without surfacing useful
			// traversal targets.
			//
			// Custom objects (`__c` suffix) always pass through,
			// even if their API name happens to end with `History`
			// / `Share` / `Feed` etc., they're user-defined and
			// presumably user-meaningful. Standard objects have to
			// match the curated lists below to be filtered.
			const _RELCHIP_SYSTEM_CHILD_NAMES = new Set([
				// Files / attachments: junction tables managed via SF's
				// Files UI; loading them as cards is a category
				// mismatch.
				'ContentDocumentLink', 'AttachedContentDocument',
				'AttachedContentNote', 'CombinedAttachment',
				// Chatter follow / topic / quick-action bookkeeping.
				'EntitySubscription', 'TopicAssignment',
				'CollaborationGroupRecord', 'RecordAction',
				// Email / activity junctions.
				'EmailMessageRelation',
				// Approval-process state, read mostly via SF's
				// Approve/Reject UI elsewhere.
				'ProcessInstance', 'ProcessInstanceHistory',
				'ProcessInstanceStep', 'ProcessInstanceWorkitem',
				// SF-auto records that exist per parent (Data.com
				// Clean, duplicate-management junctions).
				'AccountCleanInfo', 'LeadCleanInfo',
				'DuplicateRecordItem', 'DuplicateRecordSet',
				// Einstein-generated insights (read-only per-record).
				'AIInsightValue', 'AIRecordInsight', 'AIInsightAction',
				'AIInsightReason', 'AIInsightFeedback',
				// Customer-360 / CDP contact-point junctions:
				// auto-populated, fields aren't user-edited via canvas.
				'ContactPointAddress', 'ContactPointEmail',
				'ContactPointPhone', 'ContactPointTypeConsent',
				// Privacy / consent management.
				'AuthorizationFormConsent', 'AuthorizationFormDataUse',
				'CommSubscriptionConsent', 'PartyConsent',
				'IndividualHistory',
				// Field Service junctions.
				'AssociatedLocation', 'ServiceAppointment',
				// Messaging channels.
				'MessagingEndUser', 'MessagingSession',
				// Cart / consent / loyalty / referrals: also
				// auto-populated per Industries Cloud rollouts.
				'CartCoupon', 'CartValidationOutput', 'CartTax',
			]);
			const _RELCHIP_SYSTEM_CHILD_SUFFIXES = [
				'History',     // <Object>History: read-only audit trail
				'Feed',        // <Object>Feed: Chatter posts
				'Share',       // <Object>Share: sharing rows
				'ChangeEvent', // <Object>ChangeEvent: CDC stream events
				'Tag',         // <Object>Tag: folksonomy tags (legacy)
			];
			function _isSystemChildRelationship(objName) {
				if (!objName) {
return false;
}
				if (objName.endsWith('__c')) {
return false;
}
				if (_RELCHIP_SYSTEM_CHILD_NAMES.has(objName)) {
return true;
}
				return _RELCHIP_SYSTEM_CHILD_SUFFIXES.some((suf) => objName.endsWith(suf));
			}
			
			// Parent FKs SF auto-populates per record. Traversing them
			// from the chip would dump audit / system-access User
			// records onto the canvas, not the user's intent. Custom
			// parent FKs (`__c` suffix) always pass through.
			const _RELCHIP_SYSTEM_PARENT_FIELDS = new Set([
				'CreatedById',
				'LastModifiedById',
				'MasterRecordId',
				'RecordTypeId',
				// OwnerId points to a User on every record by default,
				// which would mean every loaded record perpetually
				// shows "1 related" pointing at its owner. That's
				// noise more than signal; users who want owner
				// traversal can SOQL-import or load the User
				// directly. Filter for now; revisit if a workflow
				// genuinely needs chip-driven owner traversal.
				'OwnerId',
			]);
			function _isSystemParentField(fieldName) {
				if (!fieldName) {
return false;
}
				if (fieldName.endsWith('__c')) {
return false;
}
				return _RELCHIP_SYSTEM_PARENT_FIELDS.has(fieldName);
			}
			
			// Kick off a batched COUNT() probe for every child
			// relationship of `rec`. Cheap-ish (one /related-counts
			// round-trip per host) and runs at most once per record;
			// repeat calls early-return via _chipProbeState. On
			// completion, triggers a re-render so the chip / popover
			// reflect the new cache values.
			function _ensureChipProbed(rec) {
				if (!rec || !rec.loadedFromId || !rec.fromSelectionId) {
return;
}
				if (_chipProbeState.has(rec.id)) {
return;
}
				const sel = canvasState.selectedObjects.find((s) => s.id === rec.fromSelectionId);
				if (!sel || !sel.data) {
return;
}
				const children = (sel.data.children || [])
					.filter((c) => c && c.field && c.object)
					.filter((c) => !_isSystemChildRelationship(c.object));
				if (children.length === 0) {
					_chipProbeState.set(rec.id, 'done');
					return;
				}
				_chipProbeState.set(rec.id, 'probing');
				const probes = children.map((c) => ({
					objectName: c.object,
					field: c.field,
					id: rec.loadedFromId,
				}));
				fetchRelatedCountsBatch(probes).finally(() => {
					_chipProbeState.set(rec.id, 'done');
					renderBulkView();
				});
			}
			
			// Salesforce ID equality. SF IDs come in two flavors:
			// 15-char (case-sensitive) and 18-char (a 3-char
			// case-encoding checksum suffix). For equality the
			// first 15 chars are the canonical identity; the
			// suffix is purely a checksum derivable from those 15.
			// Comparing only the first 15 ensures a record loaded
			// via one path (which may be 18-char) matches a record
			// referenced via an FK value that came back 15-char
			// from a different path. Without this, "the related
			// Account is already on the canvas" dedup checks
			// silently fail for reasonable ID-format mismatches
			// and spawn duplicate cards.
			//
			// Tolerates object-shaped FK values like { Id: '...' }
			// that SF subquery responses produce in some shapes.
			function _sfIdValue(x) {
				if (typeof x === 'string') {
return x;
}
				if (x && typeof x === 'object' && typeof x.Id === 'string') {
return x.Id;
}
				return null;
			}
			function _sfIdMatch(a, b) {
				const aId = _sfIdValue(a);
				const bId = _sfIdValue(b);
				if (!aId || !bId) {
return false;
}
				if (aId === bId) {
return true;
}
				return aId.slice(0, 15) === bId.slice(0, 15);
			}
			
			// Compute the loadable parent/child relationships for a
			// loaded record. Filters out:
			//   - Parents whose FK field is null on the host (nothing
			//     to load)
			//   - Parents whose target record is already on the canvas
			//     (clicking would just add an edge, no new record)
			//   - Children whose probed COUNT() came back 0
			//   - Children where every record is already on the canvas
			//     (sfCount - onCanvasCount === 0 → click adds no new
			//     records, so hide the entry entirely)
			// Children whose count hasn't probed yet are tracked via
			// `unprobed` so the chip can hint with "+" while the probe
			// is in flight.
			function _relInfoForRec(rec) {
				if (!rec || !rec.fromSelectionId) {
return null;
}
				const sel = canvasState.selectedObjects.find((s) => s.id === rec.fromSelectionId);
				if (!sel || !sel.data) {
return null;
}
				const allParents = (sel.data.parents || [])
					.filter((p) => p && p.field && p.object)
					.filter((p) => !_isSystemParentField(p.field));
				const allChildren = (sel.data.children || [])
					.filter((c) => c && c.field && c.object)
					.filter((c) => !_isSystemChildRelationship(c.object));
				const parents = [];
				allParents.forEach((p) => {
					const v = rec.values && rec.values[p.field];
					if (!_sfIdValue(v)) {
return;
}
					const onCanvas = canvasState.bulkRecords.some((r) =>
						!r.isTypeNode && r.objectName === p.object && _sfIdMatch(r.loadedFromId, v));
					if (onCanvas) {
return;
}
					parents.push(p);
				});
				const children = [];
				let unprobed = 0;
				if (rec.loadedFromId) {
					allChildren.forEach((c) => {
						const k = _countCacheKey(c.object, c.field, rec.loadedFromId);
						if (!_relatedCountCache.has(k)) {
							unprobed++;
							return;
						}
						const sfCount = _relatedCountCache.get(k);
						if (sfCount <= 0) {
return;
}
						const onCanvasCount = canvasState.bulkRecords.filter((r) =>
							!r.isTypeNode && r.objectName === c.object &&
							r.values && _sfIdMatch(r.values[c.field], rec.loadedFromId)).length;
						const remaining = sfCount - onCanvasCount;
						if (remaining <= 0) {
return;
}
						children.push(Object.assign({}, c, {
							count: remaining,
							sfCount,
							onCanvasCount,
						}));
					});
				}
				return {
					parents,
					children,
					total: parents.length + children.length,
					unprobed,
					probing: _chipProbeState.get(rec.id) === 'probing',
				};
			}
			
			// Open the Related popover anchored to a card's chip. Lists
			// the host record's parent + child relationship slots; on
			// pick, drops a transient type-node and routes through
			// openTypeNode (the same path the legacy spokes used) so
			// the load logic, count gates, and search-for-more flow
			// all keep working unchanged.
			function showRelatedPopover(triggerEl, hostRec) {
				// Enumerate candidate relationships directly from the
				// host's describe: NO count probe. Parents are
				// filtered to those where the host has a non-null FK
				// value AND the parent isn't already on canvas;
				// children are listed for every non-system child
				// relationship the describe knows about. The user
				// picks one type \u2192 we run a single SELECT for just
				// that type when they click. Previous behavior eagerly
				// fired COUNT() for every child relationship before
				// the picker even rendered (50 cards \u00d7 ~25 children =
				// ~1250 SF API calls). New cost: 0 SF calls until a
				// row is clicked; 1 SELECT per row the user picks.
				const sel = hostRec.fromSelectionId
					? canvasState.selectedObjects.find((s) => s.id === hostRec.fromSelectionId)
					: null;
				if (!sel || !sel.data) {
return;
}
				const parents = [];
				(sel.data.parents || [])
					.filter((p) => p && p.field && p.object)
					.filter((p) => !_isSystemParentField(p.field))
					.forEach((p) => {
						const v = hostRec.values && hostRec.values[p.field];
						if (!_sfIdValue(v)) {
return;
}
						const onCanvas = canvasState.bulkRecords.some((r) =>
							!r.isTypeNode && r.objectName === p.object && _sfIdMatch(r.loadedFromId, v));
						if (onCanvas) {
return;
}
						parents.push(p);
					});
				const children = (sel.data.children || [])
					.filter((c) => c && c.field && c.object)
					.filter((c) => !_isSystemChildRelationship(c.object));
				if (parents.length === 0 && children.length === 0) {
return;
}
				document.querySelectorAll('.related-pop').forEach((el) => el.remove());
				const pop = document.createElement('div');
				pop.className = 'find-object-popup related-pop';
				pop.style.width = '320px';
				const rect = triggerEl.getBoundingClientRect();
				pop.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 328)) + 'px';
				pop.style.top = (rect.bottom + 6) + 'px';
				const labelFor = (n) => {
					const fromAll = Array.isArray(canvasState.allObjects) && canvasState.allObjects.find((o) => o.name === n);
					return (fromAll && fromAll.label) || n;
				};
				const rowFor = (entry, direction) => {
					const objLabel = labelFor(entry.object);
					return '<button type="button" class="fop-item" ' +
						'data-rel-direction="' + direction + '" ' +
						'data-rel-object="' + escapeHtml(entry.object) + '" ' +
						'data-rel-field="' + escapeHtml(entry.field) + '" ' +
						(entry.relationshipName ? 'data-rel-rship="' + escapeHtml(entry.relationshipName) + '" ' : '') +
						'>' +
						'<span class="fop-label">' + escapeHtml(objLabel) + '</span>' +
						'<span class="fop-name">' + (direction === 'parent' ? '\u2191 parent via ' : '\u2193 child via ') + escapeHtml(entry.field) + '</span>' +
					'</button>';
				};
				const parentRows = parents.map((p) => rowFor(p, 'parent')).join('');
				const childRows = children.map((c) => rowFor(c, 'child')).join('');
				const subText = 'For ' + (hostRec.label || hostRec.objectName) + '. Pick a relationship to load; we\'ll fetch the records when you click.';
				pop.innerHTML =
					'<div class="fop-header">Load related records</div>' +
					'<div class="fop-sub">' + escapeHtml(subText) + '</div>' +
					'<div class="fop-list">' +
						(parentRows || '') +
						(childRows || '') +
					'</div>';
				document.body.appendChild(pop);
				const cleanup = () => {
					if (pop.parentNode) {
pop.remove();
}
					document.removeEventListener('mousedown', outside, true);
					document.removeEventListener('keydown', onEsc, true);
				};
				const outside = (ev) => {
 if (!pop.contains(ev.target)) {
cleanup();
} 
};
				const onEsc = (ev) => {
 if (ev.key === 'Escape') {
cleanup();
} 
};
				setTimeout(() => {
					document.addEventListener('mousedown', outside, true);
					document.addEventListener('keydown', onEsc, true);
				}, 0);
				pop.addEventListener('click', (ev) => {
					const btn = ev.target.closest('[data-rel-direction]');
					if (!btn) {
return;
}
					const direction = btn.dataset.relDirection;
					const objectName = btn.dataset.relObject;
					const fieldName = btn.dataset.relField;
					const relationshipName = btn.dataset.relRship || fieldName;
					cleanup();
					loadRelatedFromChip(hostRec, { direction, objectName, fieldName, relationshipName });
				});
			}
			
			// Build a transient type-node and hand it to openTypeNode.
			// The type-node renders a brief loading state near the host
			// and is then replaced with the actual related records by
			// openTypeNode's existing logic.
			async function loadRelatedFromChip(hostRec, rel) {
				if (!hostRec || !rel) {
return;
}
				const labelFor = (n) => {
					const fromAll = Array.isArray(canvasState.allObjects) && canvasState.allObjects.find((o) => o.name === n);
					return (fromAll && fromAll.label) || n;
				};
				const tn = {
					id: canvasState.bulkIdSeq++,
					isTypeNode: true,
					hostRecordId: hostRec.id,
					objectName: rel.objectName,
					label: labelFor(rel.objectName),
					direction: rel.direction,
					x: hostRec.x + (rel.direction === 'child' ? 0 : -160),
					y: hostRec.y + (rel.direction === 'child' ? 160 : -160),
					// Skip rendering and filter-panel counting: this
					// type-node only exists to feed openTypeNode the
					// shape it expects. The user shouldn't see a circle
					// or trigger the type-node filter panel for the
					// brief moment between "click related" and
					// "records appear".
					_chipLoader: true,
				};
				if (rel.direction === 'child') {
					tn.fieldOnOther = rel.fieldName;
				} else {
					tn.fieldOnThis = rel.fieldName;
					// For parent direction, openTypeNode reads parentId
					// off the type-node. Prefill from the host record's
					// FK value so the lookup-by-id path works.
					const fkValue = hostRec.values && hostRec.values[rel.fieldName];
					if (!fkValue) {
						showBulkToast('No ' + rel.fieldName + ' on this record: nothing to load.', 'error');
						return;
					}
					tn.parentId = fkValue;
				}
				canvasState.bulkRecords.push(tn);
				try {
 await openTypeNode(tn); 
} catch (e) {
					// On failure, clean up the transient type-node so
					// we don't leave a dead spoke on the canvas.
					const i = canvasState.bulkRecords.findIndex((b) => b.id === tn.id);
					if (i !== -1) {
canvasState.bulkRecords.splice(i, 1);
}
					renderBulkView();
					showBulkToast('Load failed: ' + (e.message || e), 'error');
				}
			}
			
			// Render a type-node ring around any loaded record showing
			// every related parent/child object type from its schema
			// *that actually has at least one related record*. Parents
			// skip when the FK is null OR the target is already on the
			// canvas (no point offering to load a duplicate). Children
			// probe a parallel COUNT() query and skip when zero, and
			// also skip when on-canvas count meets or exceeds SF count
			// (everything that the type-node would load is already
			// here, so the type-node is redundant; instead, the auto-
			// link helper has already wired the relationships).
			// Self-references stay: the host record may have peers of
			// its own type. Layout: the base record (no incoming spoke)
			// gets a full ring; for descendant records, the ring fans
			// in the OUTWARD half-circle (away from whichever record
			// they were loaded from) so the type-nodes don't overlap
			// with the network already on the canvas.
			async function seedEditModeTypeNodes(hostRec, hostSel, opts) {
				if (!hostSel || !hostSel.data || !hostRec.loadedFromId) {
return;
}
				opts = opts || {};
				// Per-card "Related" chip replaces the auto-fan of type-
				// nodes around loaded records. Same load-related plumbing
				// (openTypeNode) is still used; entry is now a popover
				// off the chip instead of N visible spokes per card. The
				// function stays callable so existing call sites don't
				// need to be reworked; they just become no-ops.
				return;
				const labelFor = (n) => {
					const fromAll = Array.isArray(canvasState.allObjects) && canvasState.allObjects.find(o => o.name === n);
					return (fromAll && fromAll.label) || n;
				};
				// Skip type-nodes for object/field combos that already
				// hang off this same host (re-entry guard for the case
				// where the user closes a type-node then re-runs seeding
				// via some future code path).
				const existingTypeKeys = new Set(
					canvasState.bulkRecords.filter(r => r.isTypeNode && r.hostRecordId === hostRec.id)
						.map(r => r.objectName + '|' + r.direction + '|' + (r.fieldOnOther || r.fieldOnThis || ''))
				);
				// `auditOnly: true` flips the audit-field filter: include
				// only audit FKs and skip everything else. Used when the
				// user enables the audit toggle on a canvas that was
				// already seeded without them.
				const auditOnly = !!opts.auditOnly;
				const includeAudit = !!auditOnly;
				// Defensive queryable check: even if the server's graph
				// endpoint missed a non-queryable virtual entity (cache
				// miss, race), the count-probe call would fail with
				// "entity type X does not support query". Skip anything
				// whose target isn't in the queryable canvasState.allObjects list.
				const queryableNames = new Set((canvasState.allObjects || []).filter((o) => o && o.queryable).map((o) => o.name));
				const isQueryable = (name) => queryableNames.size === 0 || queryableNames.has(name);
				const childCandidates = [];
				(hostSel.data.children || []).forEach((c) => {
					if (!c.field || !c.object) {
return;
}
					if (!isQueryable(c.object)) {
return;
}
					const isAudit = AUDIT_FK_FIELDS.has(c.field);
					if (auditOnly && !isAudit) {
return;
}
					if (!includeAudit && isAudit) {
return;
}
					const key = c.object + '|child|' + c.field;
					if (existingTypeKeys.has(key)) {
return;
}
					childCandidates.push({
						direction: 'child',
						objectName: c.object,
						label: labelFor(c.object),
						fieldOnOther: c.field,
						relationshipName: c.relationshipName || c.field,
					});
				});
				// Helper to record an FK association without dups.
				const _ensureAssoc = (fromId, toId, fieldName) => {
					const exists = canvasState.bulkAssociations.some((a) => a.fromId === fromId && a.toId === toId && a.fieldName === fieldName);
					if (!exists) {
canvasState.bulkAssociations.push({ id: canvasState.bulkIdSeq++, fromId, toId, fieldName });
}
				};
				const parentNodes = [];
				(hostSel.data.parents || []).forEach((p) => {
					if (!p.field || !p.object) {
return;
}
					if (!isQueryable(p.object)) {
return;
}
					const isAudit = AUDIT_FK_FIELDS.has(p.field);
					if (auditOnly && !isAudit) {
return;
}
					if (!includeAudit && isAudit) {
return;
}
					const parentId = hostRec.values && hostRec.values[p.field];
					if (!parentId || typeof parentId !== 'string') {
return;
}
					const key = p.object + '|parent|' + p.field;
					if (existingTypeKeys.has(key)) {
return;
}
					// If the target parent record is already on canvas,
					// skip the type-node AND auto-create the FK
					// association so the relationship still shows up
					// as an edge between the two cards. Was: skip
					// silently; the records were on canvas but
					// disconnected.
					const onCanvas = canvasState.bulkRecords.find(r =>
						!r.isTypeNode && r.objectName === p.object && r.loadedFromId === parentId);
					if (onCanvas) {
						_ensureAssoc(hostRec.id, onCanvas.id, p.field);
						return;
					}
					parentNodes.push({
						direction: 'parent',
						objectName: p.object,
						label: labelFor(p.object),
						fieldOnThis: p.field,
						parentId,
					});
				});
				// One batched request instead of N parallel singletons:
				// the browser sees a single fetch, the server fans out
				// the SOQL queries in parallel via Promise.all.
				const probes = childCandidates.map((n) => ({
					objectName: n.objectName,
					field: n.fieldOnOther,
					id: hostRec.loadedFromId,
				}));
				const counts = await fetchRelatedCountsBatch(probes);
				const childChecks = childCandidates.filter((n) => {
					const key = _countCacheKey(n.objectName, n.fieldOnOther, hostRec.loadedFromId);
					const sfCount = counts.get(key) || 0;
					if (sfCount === 0) {
return false;
}
					// If every record that an Open would load is already
					// on canvas, the type-node would be redundant, so
					// suppress it and auto-create the FK associations
					// for each on-canvas match instead. Compares
					// canvas-side count of records linked by this
					// exact (object, FK field, host loadedFromId)
					// against the SF count.
					const canvasMatches = canvasState.bulkRecords.filter((r) =>
						!r.isTypeNode && r.objectName === n.objectName &&
						r.values && r.values[n.fieldOnOther] === hostRec.loadedFromId);
					if (canvasMatches.length >= sfCount) {
						canvasMatches.forEach((m) => _ensureAssoc(m.id, hostRec.id, n.fieldOnOther));
						return false;
					}
					return true;
				});
				const nodes = parentNodes.concat(childChecks);
				if (nodes.length === 0) {
					renderBulkView();
					return;
				}
				// Layout. For the base record (no outwardFrom hint and
				// no remembered fan direction) use a full circle; for
				// descendant records, fan outward in a half-circle so
				// type-nodes don't crowd the network behind them. When
				// this host already has type-nodes (e.g. seeding audit
				// or smart-filter-off re-seed on top of an existing
				// ring), push the new nodes onto an outer ring so they
				// don't pile on top of the existing ones. The cached
				// `_fanAngle` lets re-seed callers (smart-filter and
				// audit toggles) skip the outwardFrom argument and
				// still hit the descendant path; without it, a
				// descendant host would be misclassified as base and
				// half its new type-nodes would fan backward into the
				// parent network, then get launched far out by the
				// collision-push.
				const isBase = !opts.outwardFrom && typeof hostRec._fanAngle !== 'number';
				const hasExisting = existingTypeKeys.size > 0;
				// Ring radius for type-nodes around the host record.
				// Sized so a 200×100 card and an 80×80 type-node sit
				// with ~50px of horizontal breathing room (host card
				// edge to nearest type-node edge). Earlier values
				// (160 base) had ~20px which read as too close to the
				// record. The chord-based intraRingMin below still
				// expands the ring when many candidates would crowd
				// at this base distance.
				const fallbackRing = opts.ring || (isBase ? 220 : 180);
				const baseRing = hasExisting ? fallbackRing + 120 : fallbackRing;
				let baseAngle, span;
				if (isBase) {
					baseAngle = -Math.PI / 2;
					span = Math.PI * 2;
				} else {
					// Half-circle facing outward: narrow enough to fit
					// a few nodes without overlapping, wide enough that
					// many nodes still spread cleanly.
					span = Math.PI * 0.95;
					if (typeof hostRec._fanAngle === 'number') {
						// Reuse the previously-chosen fan direction
						// (schema-builder pattern: pick once, lock it).
						// Stops the existing ring from swinging when we
						// re-seed onto the same host, e.g. when the
						// audit toggle adds an outer ring of audit FKs
						// on top of a host that already has a ring.
						baseAngle = hostRec._fanAngle;
					} else {
						const odx = hostRec.x - opts.outwardFrom.x;
						const ody = hostRec.y - opts.outwardFrom.y;
						const parentBased = Math.atan2(ody, odx);
						// Direction selection. The naive choice (fan
						// outward from whichever record we were loaded
						// from) fails when the user navigated outward
						// and then drilled back: that vector points
						// into the densest part of the canvas, not
						// into open space. Instead, sample candidate
						// fan directions around the host and pick the
						// one with the most clearance from existing
						// records. Score each candidate by the average
						// minimum-distance to existing nodes at five
						// probe points spanning the half-circle (the
						// two flanks, two quarter-points, and the
						// centerline) so a great centerline with a
						// cramped flank doesn't win.
						const SAMPLES = 24;
						const probeR = Math.max(baseRing, 320);
						const offsets = [-span / 2, -span / 4, 0, span / 4, span / 2];
						let bestAngle = parentBased;
						let bestScore = -Infinity;
						for (let s = 0; s < SAMPLES; s++) {
							const cand = (s / SAMPLES) * Math.PI * 2;
							let sumMin = 0;
							for (let oi = 0; oi < offsets.length; oi++) {
								const ang = cand + offsets[oi];
								const px = hostRec.x + probeR * Math.cos(ang);
								const py = hostRec.y + probeR * Math.sin(ang);
								let minDist = Infinity;
								for (let k = 0; k < canvasState.bulkRecords.length; k++) {
									const other = canvasState.bulkRecords[k];
									if (other.id === hostRec.id) {
continue;
}
									const dx = px - other.x;
									const dy = py - other.y;
									const d = Math.hypot(dx, dy);
									if (d < minDist) {
minDist = d;
}
								}
								if (minDist === Infinity) {
minDist = probeR;
}
								sumMin += minDist;
							}
							// Tiny tiebreaker toward parent-outward so
							// a nearly-empty canvas still defaults
							// sensibly.
							const align = Math.cos(cand - parentBased);
							const score = (sumMin / offsets.length) + align * 30;
							if (score > bestScore) {
								bestScore = score;
								bestAngle = cand;
							}
						}
						baseAngle = bestAngle;
						hostRec._fanAngle = baseAngle;
					}
				}
				const n = nodes.length;
				// Grow the ring radius so adjacent siblings on the same
				// ring stay at least _MIN_SEP apart by chord length.
				// chord = 2·r·sin(Δθ/2); solve for r given _MIN_SEP. For a
				// full circle the angular step is span/n; for the
				// descendant fan (endpoints inclusive at t=0 and t=1) it
				// is span/(n−1). With one node the floor wins.
				// Min chord (center-to-center) between adjacent type-
				// nodes on the ring. Type-nodes in cy mode are 80px
				// diameter; 120 leaves a 40px edge-to-edge gap so
				// neighbors don't read as crowded.
				const _MIN_SEP = 120;
				// Full-circle with n=1 has no "adjacent" chord, and
				// span/n = 2π gives sin(π)=0, which would balloon
				// intraRingMin to Infinity and put the lone type-node
				// at NaN coords. Skip the chord constraint for n<=1.
				const angularStep = isBase
					? (n > 1 ? span / n : 0)
					: (n > 1 ? span / (n - 1) : 0);
				const intraRingMin = angularStep > 0
					? _MIN_SEP / (2 * Math.sin(angularStep / 2))
					: 0;
				const ring = Math.max(baseRing, intraRingMin);
				// Collision-aware placement. Compute the radial seed for
				// each new node, then push it outward along its own
				// host→node vector until its bounding box clears every
				// existing record on the canvas AND every sibling placed
				// earlier in this same pass. This keeps the radial look
				// but stops new fan-outs from landing on top of records
				// loaded from other branches. Half-extents are
				// conservative: type-nodes are 110 circles; record cards
				// are up to ~220 wide, ~180 tall.
				const _halfExtents = (rec) => rec.isTypeNode
					? { hw: 65, hh: 65 }
					: { hw: 120, hh: 90 };
				const _bbox = (rec) => {
					const { hw, hh } = _halfExtents(rec);
					return { l: rec.x - hw, r: rec.x + hw, t: rec.y - hh, b: rec.y + hh };
				};
				const _hits = (a, b) => !(a.r <= b.l || a.l >= b.r || a.b <= b.t || a.t >= b.b);
				// Variable-radius cycle (lifted from the schema builder
				// at renderCanvas). Adjacent siblings sit at slightly
				// different distances so they don't visually overlap
				// even when angular spacing is tight, without bumping
				// the ring radius up globally for every sibling.
				const radiusForIndex = (i) => {
					const cycle = i % 3;
					if (cycle === 1) {
return ring * 1.32;
}
					if (cycle === 2) {
return ring * 1.14;
}
					return ring;
				};
				// Smaller step than before (matches schema builder):
				// finer-grained pushes mean a node that just barely
				// collides doesn't get launched 60px outward when 30
				// would have cleared it.
				const PUSH_STEP = 30;
				const PUSH_MAX = 20;
				const placedThisPass = [];
				nodes.forEach((node, i) => {
					const t = n === 1 ? 0.5 : i / (n - 1);
					const angle = isBase
						? baseAngle + span * (i / n)
						: baseAngle - span / 2 + span * t;
					const ux = Math.cos(angle);
					const uy = Math.sin(angle);
					const probe = { isTypeNode: true, x: 0, y: 0 };
					let radius = radiusForIndex(i);
					for (let step = 0; step < PUSH_MAX; step++) {
						probe.x = hostRec.x + radius * ux;
						probe.y = hostRec.y + radius * uy;
						const bb = _bbox(probe);
						let collides = false;
						for (let k = 0; k < canvasState.bulkRecords.length; k++) {
							const other = canvasState.bulkRecords[k];
							if (other.id === hostRec.id) {
continue;
}
							if (_hits(bb, _bbox(other))) {
 collides = true; break; 
}
						}
						if (!collides) {
							for (let k = 0; k < placedThisPass.length; k++) {
								if (_hits(bb, _bbox(placedThisPass[k]))) {
 collides = true; break; 
}
							}
						}
						if (!collides) {
break;
}
						radius += PUSH_STEP;
					}
					const placed = {
						id: canvasState.bulkIdSeq++,
						isTypeNode: true,
						direction: node.direction,
						objectName: node.objectName,
						label: node.label,
						fieldOnOther: node.fieldOnOther || null,
						fieldOnThis: node.fieldOnThis || null,
						parentId: node.parentId || null,
						relationshipName: node.relationshipName || null,
						hostRecordId: hostRec.id,
						x: hostRec.x + radius * ux,
						y: hostRec.y + radius * uy,
					};
					canvasState.bulkRecords.push(placed);
					placedThisPass.push(placed);
				});
				renderBulkView();
			}

			return {
				showRelatedPopover: showRelatedPopover,
				loadRelatedFromChip: loadRelatedFromChip,
				seedEditModeTypeNodes: seedEditModeTypeNodes,
				_ensureChipProbed: _ensureChipProbed,
				_relInfoForRec: _relInfoForRec,
				_isSystemChildRelationship: _isSystemChildRelationship,
				_isSystemParentField: _isSystemParentField,
				_sfIdValue: _sfIdValue,
				_sfIdMatch: _sfIdMatch,
			};
		},
	};
})();
