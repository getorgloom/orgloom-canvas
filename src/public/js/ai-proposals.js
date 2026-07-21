(function () {
	'use strict';
	// Previews AI-suggested draft changes and applies only choices explicitly accepted by the user.

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.aiProposals = {
		mount: function mount(deps) {
			const _required = [
				'canvasState',
				'csrfFetch',
				'escapeHtml',
				'showBulkToast',
				'showConfirmDialog',
				'addToSelection',
				'bulkAutoFill',
				'ensureDescribe',
				'renderBulkView',
			];
			for (const k of _required) {
				if (deps == null || deps[k] == null) {
					throw new Error('ai-proposals.mount: missing required dep: ' + k);
				}
			}
			const canvasState = deps.canvasState;
			const csrfFetch = deps.csrfFetch;
			const escapeHtml = deps.escapeHtml;
			const showBulkToast = deps.showBulkToast;
			const showConfirmDialog = deps.showConfirmDialog;
			const addToSelection = deps.addToSelection;
			const bulkAutoFill = deps.bulkAutoFill;
			const ensureDescribe = deps.ensureDescribe;
			const renderBulkView = deps.renderBulkView;
			const pushUndo = typeof deps.pushUndo === 'function' ? deps.pushUndo : null;
			const canvasCapCheck =
				typeof deps.canvasCapCheck === 'function'
					? deps.canvasCapCheck
					: function () {
							return { ok: true, blocked: false, reason: null };
						};
			let _proposalsPollTimer = null;
			let _proposalsLastCanvasId = null;
			function _upsertSingleLookupAssociation(associations, nextAssociation) {
				const current = Array.isArray(associations) ? associations : [];
				const sameLookup = current.filter(
					(association) =>
						association.fromId === nextAssociation.fromId &&
						association.fieldName === nextAssociation.fieldName,
				);
				const exact = sameLookup.find((association) => association.toId === nextAssociation.toId);
				if (sameLookup.length === 1 && exact) {
					return { associations: current, changed: false, inserted: false };
				}
				const withoutLookup = current.filter(
					(association) =>
						association.fromId !== nextAssociation.fromId ||
						association.fieldName !== nextAssociation.fieldName,
				);
				withoutLookup.push(exact || nextAssociation);
				return { associations: withoutLookup, changed: true, inserted: !exact };
			}
			function _syncLookupFieldValue(records, fromId, toId, fieldName) {
				const holder = records.find((record) => record && record.id === fromId);
				const target = records.find((record) => record && record.id === toId);
				if (!holder || !target || !fieldName) {
					return false;
				}
				holder.values = holder.values || {};
				const targetSalesforceId = target.loadedFromId || (target.values && target.values.Id) || null;
				if (targetSalesforceId) {
					if (String(holder.values[fieldName] || '') === String(targetSalesforceId)) {
						return false;
					}
					holder.values[fieldName] = targetSalesforceId;
					return true;
				}
				if (Object.prototype.hasOwnProperty.call(holder.values, fieldName)) {
					delete holder.values[fieldName];
					return true;
				}
				return false;
			}
			const _proposalsBanner = document.createElement('div');
			_proposalsBanner.className = 'proposals-banner';
			_proposalsBanner.hidden = true;
			const _proposalsBannerText = document.createElement('span');
			_proposalsBannerText.className = 'proposals-banner-text';
			const _proposalsReviewBtn = document.createElement('button');
			_proposalsReviewBtn.type = 'button';
			_proposalsReviewBtn.className = 'button';
			_proposalsReviewBtn.id = 'proposals-banner-review';
			_proposalsReviewBtn.textContent = 'Review';
			const _proposalsCloseBtn = document.createElement('button');
			_proposalsCloseBtn.type = 'button';
			_proposalsCloseBtn.className = 'proposals-banner-close';
			_proposalsCloseBtn.id = 'proposals-banner-close';
			_proposalsCloseBtn.setAttribute('aria-label', 'Dismiss');
			_proposalsCloseBtn.textContent = '×';
			_proposalsBanner.innerHTML = '<span class="proposals-banner-icon" aria-hidden="true">✨</span>';
			_proposalsBanner.appendChild(_proposalsBannerText);
			_proposalsBanner.appendChild(_proposalsReviewBtn);
			_proposalsBanner.appendChild(_proposalsCloseBtn);
			document.body.appendChild(_proposalsBanner);
			_proposalsReviewBtn.addEventListener('click', () => {
				const cur = _proposalsPollCanvasId();
				if (cur) {
					_openProposalsReview(cur);
				}
			});
			_proposalsCloseBtn.addEventListener('click', () => {
				_proposalsBanner.hidden = true;
			});

			function _proposalsPollCanvasId() {
				if (canvasState.currentCanvas && canvasState.currentCanvas.id) {
					return canvasState.currentCanvas.id;
				}
				const cs = window.Orgloom && window.Orgloom.canvasState;
				if (cs && typeof cs.getCurrentCanvas === 'function') {
					const c = cs.getCurrentCanvas();
					return (c && c.canvasId) || null;
				}
				return null;
			}
			async function _refreshProposals() {
				if (window.ORGLOOM_MCP_ACTIVE !== true) {
					_proposalsBanner.hidden = true;
					_proposalsLastCanvasId = null;
					return;
				}
				const id = _proposalsPollCanvasId();
				if (!id) {
					_proposalsBanner.hidden = true;
					return;
				}
				try {
					const r = await csrfFetch('/api/canvas/' + encodeURIComponent(id) + '/proposals', {
						credentials: 'same-origin',
					});
					if (!r.ok) {
						_proposalsBanner.hidden = true;
						return;
					}
					const data = await r.json();
					const proposals = data && Array.isArray(data.proposals) ? data.proposals : [];
					if (proposals.length === 0) {
						_proposalsBanner.hidden = true;
						return;
					}

					if (_isAutoApplyEnabled(id)) {
						_proposalsBanner.hidden = true;

						for (const p of proposals) {
							try {
								await _applyProposal(id, p.id, null, {
									skipConfirm: true,
									silentToast: true,
								});
							} catch (_) {}
						}
						return;
					}
					const totalChanges = proposals.reduce(
						(sum, p) => sum + (Array.isArray(p.changes) ? p.changes.length : 0),
						0,
					);

					_proposalsBannerText.innerHTML =
						'<strong>' +
						proposals.length +
						'</strong> AI proposal' +
						(proposals.length === 1 ? '' : 's') +
						' pending (<strong>' +
						totalChanges +
						'</strong> change' +
						(totalChanges === 1 ? '' : 's') +
						')';
					if (_proposalsBanner.hidden && window.posthog && window.posthog.capture) {
						try {
							window.posthog.capture('ai_proposal_received', {
								proposal_count: proposals.length,
								change_count: totalChanges,
								canvas_id_kind:
									typeof id === 'string' && id.indexOf('draft-') === 0 ? 'draft' : 'saved',
							});
						} catch (_) {}
					}
					_proposalsBanner.hidden = false;
				} catch (e) {}
			}

			function _watchProposalsForCurrentCanvas() {
				if (window.ORGLOOM_MCP_ACTIVE !== true) {
					_proposalsBanner.hidden = true;
					_proposalsLastCanvasId = null;
					if (_proposalsPollTimer) {
						clearInterval(_proposalsPollTimer);
						_proposalsPollTimer = null;
					}
					return;
				}
				const id = _proposalsPollCanvasId();
				if (id !== _proposalsLastCanvasId) {
					_proposalsLastCanvasId = id;
					_refreshProposals();
				}

				if (_proposalsPollTimer) {
					clearInterval(_proposalsPollTimer);
				}
				_proposalsPollTimer = setInterval(_refreshProposals, 5000);
			}

			_watchProposalsForCurrentCanvas();

			document.addEventListener('visibilitychange', () => {
				if (document.visibilityState === 'visible') {
					_refreshProposals();
				}
			});
			window.addEventListener('focus', () => {
				_refreshProposals();
			});
			window.addEventListener('orgloom:mcp-availability', () => {
				_watchProposalsForCurrentCanvas();
			});

			function _autoApplyStorageKey(canvasId) {
				return 'orgloom:aiAutoApply:' + canvasId;
			}
			function _isAutoApplyEnabled(canvasId) {
				if (!canvasId) {
					return false;
				}
				try {
					return window.localStorage.getItem(_autoApplyStorageKey(canvasId)) === '1';
				} catch (_) {
					return false;
				}
			}
			function _setAutoApplyEnabled(canvasId, on) {
				if (!canvasId) {
					return;
				}
				try {
					if (on) {
						window.localStorage.setItem(_autoApplyStorageKey(canvasId), '1');
					} else {
						window.localStorage.removeItem(_autoApplyStorageKey(canvasId));
					}
				} catch (_) {}
			}

			async function _openProposalsReview(canvasId) {
				document.querySelectorAll('.proposals-review-modal').forEach((el) => el.remove());
				const modal = document.createElement('div');
				modal.className = 'modal proposals-review-modal';
				modal.setAttribute('data-canvas-id', canvasId);
				modal.innerHTML =
					'<div class="modal-overlay" data-pr-close></div>' +
					'<div class="modal-body" style="max-width:780px">' +
					'<div class="modal-header">' +
					'<h3>AI proposals</h3>' +
					'<button class="modal-close" data-pr-close>&times;</button>' +
					'</div>' +
					'<div class="proposals-autoapply-row">' +
					'<label class="proposals-autoapply-label">' +
					'<input type="checkbox" class="proposals-autoapply-toggle"' +
					(_isAutoApplyEnabled(canvasId) ? ' checked' : '') +
					'>' +
					'<span><strong>Auto-apply AI proposals to this canvas</strong>: future proposals land on the canvas without opening this review. Each change still echoes into the canvas state as if you clicked Apply; Salesforce uploads still require a separate Save + Upload. Per-canvas, browser-only.</span>' +
					'</label>' +
					'</div>' +
					'<div class="modal-content" id="proposals-review-content">' +
					'<p class="center tag">Loading…</p>' +
					'</div>' +
					'</div>';
				document.body.appendChild(modal);
				modal
					.querySelectorAll('[data-pr-close]')
					.forEach((el) => el.addEventListener('click', () => modal.remove()));
				document.addEventListener('keydown', function _onEsc(ev) {
					if (ev.key === 'Escape') {
						modal.remove();
						document.removeEventListener('keydown', _onEsc);
					}
				});
				const autoToggle = modal.querySelector('.proposals-autoapply-toggle');
				if (autoToggle) {
					autoToggle.addEventListener('change', async () => {
						_setAutoApplyEnabled(canvasId, autoToggle.checked);

						if (autoToggle.checked) {
							await _refreshProposals();
							modal.remove();
						}
					});
				}

				try {
					const r = await csrfFetch('/api/canvas/' + encodeURIComponent(canvasId) + '/proposals', {
						credentials: 'same-origin',
					});
					if (!r.ok) {
						modal.querySelector('#proposals-review-content').innerHTML =
							'<div class="banner error">Could not load proposals (HTTP ' + r.status + ').</div>';
						return;
					}
					const data = await r.json();
					const proposals = data && Array.isArray(data.proposals) ? data.proposals : [];
					if (proposals.length === 0) {
						modal.querySelector('#proposals-review-content').innerHTML =
							'<p class="acct-empty">No pending proposals.</p>';
						return;
					}
					const html = proposals.map((p) => _renderProposalCard(p)).join('');
					modal.querySelector('#proposals-review-content').innerHTML = html;

					modal.querySelectorAll('.proposal-card').forEach((card) => {
						const checkboxes = card.querySelectorAll('.proposal-change-checkbox');
						const countEl = card.querySelector('.proposal-selected-count');
						const applyBtn = card.querySelector('.proposal-card-apply');
						const total = checkboxes.length;
						const updateCount = () => {
							let selected = 0;
							checkboxes.forEach((cb) => {
								if (cb.checked) {
									selected++;
								}
							});
							if (countEl) {
								countEl.textContent = selected + ' of ' + total + ' selected';
							}
							if (applyBtn) {
								applyBtn.disabled = selected === 0;
								applyBtn.textContent =
									selected === total
										? 'Apply'
										: selected === 0
											? 'Apply (none selected)'
											: 'Apply selected (' + selected + ')';
							}
						};
						checkboxes.forEach((cb) => cb.addEventListener('change', updateCount));
						const selAll = card.querySelector('.proposal-select-all');
						if (selAll) {
							selAll.addEventListener('click', () => {
								checkboxes.forEach((cb) => {
									cb.checked = true;
								});
								updateCount();
							});
						}
						const selNone = card.querySelector('.proposal-select-none');
						if (selNone) {
							selNone.addEventListener('click', () => {
								checkboxes.forEach((cb) => {
									cb.checked = false;
								});
								updateCount();
							});
						}
						updateCount();
					});
					modal.querySelectorAll('.proposal-card-apply').forEach((btn) => {
						btn.addEventListener('click', async () => {
							const pid = btn.getAttribute('data-proposal-id');
							const card = btn.closest('.proposal-card');
							const skipChangeIndexes = [];
							let skipItemCount = 0;
							if (card) {
								card.querySelectorAll('.proposal-change-checkbox').forEach((cb) => {
									if (!cb.checked) {
										skipItemCount += 1;
										String(cb.getAttribute('data-change-indexes') || '')
											.split(',')
											.map((value) => Number(value))
											.filter((value) => Number.isInteger(value))
											.forEach((value) => skipChangeIndexes.push(value));
									}
								});
							}
							await _applyProposal(canvasId, pid, modal, {
								skipChangeIndexes,
								skipItemCount,
							});
						});
					});
					modal.querySelectorAll('.proposal-card-reject').forEach((btn) => {
						btn.addEventListener('click', async () => {
							const pid = btn.getAttribute('data-proposal-id');
							await _rejectProposal(canvasId, pid, modal);
						});
					});
				} catch (e) {
					modal.querySelector('#proposals-review-content').innerHTML =
						'<div class="banner error">' + escapeHtml(e.message || String(e)) + '</div>';
				}
			}

			function _renderProposalCard(p) {
				const summary = p.summary ? '<p class="proposal-card-summary">' + escapeHtml(p.summary) + '</p>' : '';
				const ts = p.createdAt ? new Date(p.createdAt).toLocaleString() : '';
				const changes = Array.isArray(p.changes) ? p.changes : [];
				const _fmt = (v) => {
					if (v == null) {
						return '';
					}
					if (typeof v === 'object') {
						try {
							return JSON.stringify(v);
						} catch (_) {
							return String(v);
						}
					}
					return String(v);
				};

				const _newDraftRefIndex = new Map();
				for (const ch of changes) {
					if (ch && ch.kind === 'new-draft' && ch.tempRef) {
						_newDraftRefIndex.set(String(ch.tempRef), ch);
					}
				}
				const _canvasRecords = Array.isArray(canvasState.bulkRecords) ? canvasState.bulkRecords : [];
				const _salesforceIdsMatch = (left, right) => {
					if (left == null || right == null) {
						return false;
					}
					const a = String(left);
					const b = String(right);
					return a === b || (a.length >= 15 && b.length >= 15 && a.slice(0, 15) === b.slice(0, 15));
				};
				const _recordValues = (record) =>
					Object.assign({}, (record && record.loadedValues) || {}, (record && record.values) || {});
				const _canvasRecordForEndpoint = (ep) => {
					if (!ep || ep.ref == null) {
						return null;
					}
					if (ep.kind === 'loaded') {
						return (
							_canvasRecords.find(
								(record) =>
									record &&
									(_salesforceIdsMatch(record.loadedFromId, ep.ref) ||
										_salesforceIdsMatch(_recordValues(record).Id, ep.ref)),
							) || null
						);
					}
					if (ep.kind === 'draft') {
						return (
							_canvasRecords.find(
								(record) => record && !record.loadedFromId && String(record.id) === String(ep.ref),
							) || null
						);
					}
					return null;
				};
				const _recordDisplayName = (values, objectName) => {
					values = values && typeof values === 'object' ? values : {};
					const personName = [values.FirstName, values.LastName]
						.filter((value) => value != null && String(value).trim())
						.map((value) => String(value).trim())
						.join(' ');
					if (personName) {
						return personName;
					}
					const describe = canvasState.describeCache && canvasState.describeCache[objectName];
					const nameField =
						describe && Array.isArray(describe.fields)
							? describe.fields.find((field) => field && field.nameField)
							: null;
					if (nameField && values[nameField.name] != null && String(values[nameField.name]).trim()) {
						return String(values[nameField.name]).trim();
					}
					for (const field of ['Name', 'CaseNumber', 'OrderNumber', 'WorkOrderNumber', 'Subject', 'Title']) {
						if (values[field] != null && String(values[field]).trim()) {
							return String(values[field]).trim();
						}
					}
					return '';
				};
				const _recordIdentity = ({ objectName, values, id, idPrefix }) => {
					const name = _recordDisplayName(values, objectName);
					return (
						(objectName ? '<code class="proposal-object-type">' + escapeHtml(objectName) + '</code>' : '') +
						(name ? ' <strong class="proposal-record-name">' + escapeHtml(name) + '</strong>' : '') +
						(id != null && String(id)
							? ' <code class="tag">' + escapeHtml((idPrefix || '') + String(id)) + '</code>'
							: '')
					);
				};
				const _recordHeadingForEndpoint = (ep) => {
					const record = _canvasRecordForEndpoint(ep);
					if (record) {
						return _recordIdentity({
							objectName: record.objectName,
							values: _recordValues(record),
							id: ep.ref,
							idPrefix: ep.kind === 'draft' ? 'Draft #' : '',
						});
					}
					if (ep && ep.kind === 'tempRef') {
						const draft = _newDraftRefIndex.get(String(ep.ref));
						if (draft) {
							return _recordIdentity({
								objectName: draft.objectName,
								values: draft.fields,
								id: 'New record',
							});
						}
					}
					return '';
				};
				const _recordHeadingForChange = (change) => {
					if (!change) {
						return '';
					}
					if (change.kind === 'new-draft') {
						return _recordIdentity({ objectName: change.objectName, values: change.fields });
					}
					const isDraft = change.kind === 'draft' || change.kind === 'delete-draft';
					const id = isDraft ? change.tempId : change.recordId;
					const endpoint = id == null ? null : { kind: isDraft ? 'draft' : 'loaded', ref: id };
					const record = _canvasRecordForEndpoint(endpoint);
					return _recordIdentity({
						objectName: change.objectName || (record && record.objectName),
						values: record && _recordValues(record),
						id,
						idPrefix: isDraft ? 'Draft #' : '',
					});
				};
				const _epLabel = (ep) => {
					if (!ep) {
						return '?';
					}
					const identity = _recordHeadingForEndpoint(ep);
					if (identity) {
						return identity;
					}
					if (ep.kind === 'loaded') {
						return '<code>' + escapeHtml(String(ep.ref)) + '</code>';
					}
					if (ep.kind === 'draft') {
						return 'Draft #<code>' + escapeHtml(String(ep.ref)) + '</code>';
					}
					if (ep.kind === 'tempRef') {
						const draft = _newDraftRefIndex.get(String(ep.ref));
						return draft
							? 'New <code>' + escapeHtml(draft.objectName || 'record') + '</code> (this proposal)'
							: 'New record (this proposal)';
					}
					return escapeHtml(JSON.stringify(ep));
				};
				const _endpointKey = (ep) => {
					if (!ep || ep.ref == null) {
						return null;
					}
					if (ep.kind === 'loaded') {
						return 'record:' + String(ep.ref);
					}
					if (ep.kind === 'draft') {
						return 'draft:' + String(ep.ref);
					}
					if (ep.kind === 'tempRef') {
						return 'tempRef:' + String(ep.ref);
					}
					return null;
				};
				const _changeTargetKey = (change) => {
					if (!change) {
						return null;
					}
					if (change.kind === 'new-draft' && change.tempRef != null) {
						return 'tempRef:' + String(change.tempRef);
					}
					if (change.kind === 'draft' && change.tempId != null) {
						return 'draft:' + String(change.tempId);
					}
					if ((change.kind === 'record' || change.kind === 'load-record') && change.recordId != null) {
						return 'record:' + String(change.recordId);
					}
					return null;
				};

				const _wrapChangeRow = (indexes, innerHtml) =>
					'<label class="proposal-change-row">' +
					'<input type="checkbox" class="proposal-change-checkbox" ' +
					'data-change-indexes="' +
					indexes.join(',') +
					'" checked>' +
					'<div class="proposal-change-body">' +
					innerHtml +
					'</div>' +
					'</label>';
				const basePlanByTarget = new Map();
				const rowPlans = [];
				changes.forEach((change, index) => {
					if (change.kind === 'new-association' || change.kind === 'delete-association') {
						return;
					}
					const plan = { baseIndex: index, relationshipIndexes: [] };
					rowPlans.push(plan);
					const targetKey = _changeTargetKey(change);
					if (targetKey && !basePlanByTarget.has(targetKey)) {
						basePlanByTarget.set(targetKey, plan);
					}
				});

				const relationshipOnlyPlans = new Map();
				changes.forEach((change, index) => {
					if (change.kind !== 'new-association' && change.kind !== 'delete-association') {
						return;
					}
					const childKey = _endpointKey(change.from);
					const basePlan = childKey ? basePlanByTarget.get(childKey) : null;
					if (basePlan) {
						basePlan.relationshipIndexes.push(index);
						return;
					}
					const groupKey = childKey || 'association:' + index;
					let plan = relationshipOnlyPlans.get(groupKey);
					if (!plan) {
						plan = { baseIndex: null, relationshipIndexes: [], child: change.from };
						relationshipOnlyPlans.set(groupKey, plan);
						rowPlans.push(plan);
					}
					plan.relationshipIndexes.push(index);
				});
				const _currentRelationshipParentLabel = (relationship) => {
					const child = _canvasRecordForEndpoint(relationship && relationship.from);
					if (!child || !Array.isArray(canvasState.bulkAssociations)) {
						return '';
					}
					const association = canvasState.bulkAssociations.find(
						(candidate) =>
							candidate &&
							candidate.fromId === child.id &&
							candidate.fieldName === relationship.fieldName,
					);
					if (!association) {
						return '';
					}
					const parent = _canvasRecords.find((record) => record && record.id === association.toId);
					if (!parent) {
						return '<code>' + escapeHtml(String(association.toId)) + '</code>';
					}
					return _recordIdentity({
						objectName: parent.objectName,
						values: _recordValues(parent),
						id: parent.loadedFromId || (parent.values && parent.values.Id) || parent.id,
						idPrefix: parent.loadedFromId || (parent.values && parent.values.Id) ? '' : 'Draft #',
					});
				};

				const _relationshipFieldRows = (relationshipIndexes, isNewDraft) =>
					relationshipIndexes
						.map((index) => {
							const relationship = changes[index];
							const isAdd = relationship.kind === 'new-association';
							const fieldCell =
								'<td><code>' +
								escapeHtml(relationship.fieldName || '') +
								'</code> <span class="tag">relationship</span></td>';
							const parentCell = _epLabel(relationship.to);
							if (isNewDraft) {
								return '<tr>' + fieldCell + '<td class="proposal-new">' + parentCell + '</td></tr>';
							}
							const currentParentCell = isAdd
								? _currentRelationshipParentLabel(relationship)
								: parentCell;
							return (
								'<tr>' +
								fieldCell +
								(isAdd
									? (currentParentCell
											? '<td class="proposal-old">' + currentParentCell + '</td>'
											: '<td class="proposal-old proposal-old--empty">—</td>') +
										'<td class="proposal-new">' +
										parentCell +
										'</td>'
									: '<td class="proposal-old">' +
										parentCell +
										'</td><td class="proposal-new proposal-old--empty">Not linked</td>') +
								'</tr>'
							);
						})
						.join('');

				const changeRows = rowPlans
					.map((plan) => {
						const idx = plan.baseIndex;
						const c = idx == null ? null : changes[idx];
						const changeIndexes =
							idx == null ? [...plan.relationshipIndexes] : [idx, ...plan.relationshipIndexes];
						if (!c) {
							return _wrapChangeRow(
								changeIndexes,
								'<div class="proposal-record">' +
									'<div class="proposal-record-head">' +
									_epLabel(plan.child) +
									'</div>' +
									'<table class="proposal-fields">' +
									'<thead><tr><th>Field</th><th>Old value</th><th>New value</th></tr></thead>' +
									'<tbody>' +
									_relationshipFieldRows(plan.relationshipIndexes, false) +
									'</tbody></table></div>',
							);
						}
						if (c.kind === 'delete-draft' || c.kind === 'delete-record') {
							const isDraftDel = c.kind === 'delete-draft';
							const chip =
								'<span class="proposal-kind-chip proposal-kind-chip--record" title="Remove from the canvas. Salesforce records are NOT deleted; this only removes the canvas reference.">− remove</span>';
							const target = _recordHeadingForChange(c);
							const note = isDraftDel
								? 'The draft is removed from the canvas; any associations touching it are dropped too.'
								: 'The reference is removed from the canvas + its associations are dropped. The Salesforce record itself is NOT deleted.';
							return _wrapChangeRow(
								changeIndexes,
								'<div class="proposal-record">' +
									'<div class="proposal-record-head">' +
									target +
									' ' +
									chip +
									'</div>' +
									'<p class="tag" style="margin:0.2em 0 0">' +
									note +
									'</p>' +
									'</div>',
							);
						}
						if (c.kind === 'autofill-required') {
							const ids = Array.isArray(c.tempIds) ? c.tempIds : [];
							const scope =
								ids.length === 0
									? 'every draft on the canvas'
									: ids.length +
										' draft' +
										(ids.length === 1 ? '' : 's') +
										' (tempIds: ' +
										ids.join(', ') +
										')';
							const chip =
								'<span class="proposal-kind-chip proposal-kind-chip--new" title="Fill required fields with sample values on the listed drafts. Same logic as the Bulk Operations → Fill required fields button.">✨ autofill</span>';
							return _wrapChangeRow(
								changeIndexes,
								'<div class="proposal-record">' +
									'<div class="proposal-record-head">' +
									chip +
									'</div>' +
									'<p class="tag" style="margin:0.2em 0 0">Auto-fill required fields on ' +
									escapeHtml(scope) +
									'. Picklists pick a real option; lookups use smart defaults where known. Fields already populated are left untouched.</p>' +
									'</div>',
							);
						}
						if (c.kind === 'load-record') {
							const chip =
								'<span class="proposal-kind-chip proposal-kind-chip--new" title="Load an existing Salesforce record onto the canvas. Triggers a Salesforce read on apply via your active connection.">↓ load</span>';
							const fieldsNote =
								Array.isArray(c.fields) && c.fields.length > 0
									? ' Loading just these fields: <code>' +
										escapeHtml(c.fields.join(', ')) +
										'</code>.'
									: '';
							return _wrapChangeRow(
								changeIndexes,
								'<div class="proposal-record">' +
									'<div class="proposal-record-head">' +
									_recordHeadingForChange(c) +
									' ' +
									chip +
									'</div>' +
									'<p class="tag" style="margin:0.2em 0 0">Fetch this record from Salesforce via your active connection and add it to the canvas.' +
									fieldsNote +
									'</p>' +
									(plan.relationshipIndexes.length
										? '<table class="proposal-fields"><thead><tr><th>Field</th><th>Old value</th><th>New value</th></tr></thead><tbody>' +
											_relationshipFieldRows(plan.relationshipIndexes, false) +
											'</tbody></table>'
										: '') +
									'</div>',
							);
						}
						const fields = c.fields && typeof c.fields === 'object' ? c.fields : {};
						const oldValues = c.oldValues && typeof c.oldValues === 'object' ? c.oldValues : {};
						const fieldKeys = Object.keys(fields).filter((k) => _fmt(oldValues[k]) !== _fmt(fields[k]));
						const fieldRows = fieldKeys
							.map((k) => {
								const oldRaw = oldValues[k];
								const oldStr = _fmt(oldRaw);
								const newStr = _fmt(fields[k]);
								const oldCell =
									oldStr === ''
										? '<td class="proposal-old proposal-old--empty">—</td>'
										: '<td class="proposal-old">' + escapeHtml(oldStr) + '</td>';
								const newCell = '<td class="proposal-new">' + escapeHtml(newStr) + '</td>';
								return (
									'<tr>' + '<td><code>' + escapeHtml(k) + '</code></td>' + oldCell + newCell + '</tr>'
								);
							})
							.join('');

						const isNewDraft = c.kind === 'new-draft';
						const kind = isNewDraft ? 'new-draft' : c.kind === 'draft' ? 'draft' : 'record';
						const kindChip = isNewDraft
							? '<span class="proposal-kind-chip proposal-kind-chip--new" title="Brand-new draft record. On Apply, a fresh draft appears on the canvas with these field values.">+ new draft</span>'
							: kind === 'draft'
								? '<span class="proposal-kind-chip proposal-kind-chip--draft" title="Draft on the canvas, not yet uploaded to Salesforce">draft</span>'
								: '<span class="proposal-kind-chip proposal-kind-chip--record" title="Loaded Salesforce record on the canvas; Apply updates the canvas, not Salesforce">SF record</span>';

						const tableHeaders = isNewDraft
							? '<thead><tr><th>Field</th><th>Value</th></tr></thead>'
							: '<thead><tr><th>Field</th><th>Old value</th><th>New value</th></tr></thead>';
						const tableBody = isNewDraft
							? Object.keys(fields)
									.map(
										(k) =>
											'<tr>' +
											'<td><code>' +
											escapeHtml(k) +
											'</code></td>' +
											'<td class="proposal-new">' +
											escapeHtml(_fmt(fields[k])) +
											'</td>' +
											'</tr>',
									)
									.join('') + _relationshipFieldRows(plan.relationshipIndexes, true)
							: fieldRows + _relationshipFieldRows(plan.relationshipIndexes, false);
						return _wrapChangeRow(
							changeIndexes,
							'<div class="proposal-record">' +
								'<div class="proposal-record-head">' +
								_recordHeadingForChange(c) +
								' ' +
								kindChip +
								'</div>' +
								'<table class="proposal-fields">' +
								tableHeaders +
								'<tbody>' +
								tableBody +
								'</tbody>' +
								'</table>' +
								'</div>',
						);
					})
					.join('');
				return (
					'<div class="proposal-card" data-proposal-id="' +
					escapeHtml(p.id) +
					'">' +
					'<div class="proposal-card-head">' +
					'<div>' +
					'<strong>Proposal</strong> ' +
					'<span class="tag">' +
					escapeHtml(ts) +
					'</span> ' +
					'<span class="tag proposal-selected-count">' +
					rowPlans.length +
					' of ' +
					rowPlans.length +
					' selected' +
					'</span>' +
					'</div>' +
					'<div class="proposal-card-actions">' +
					'<button type="button" class="link-button proposal-select-all">Select all</button>' +
					'<button type="button" class="link-button proposal-select-none">None</button>' +
					'<button type="button" class="button secondary proposal-card-reject" data-proposal-id="' +
					escapeHtml(p.id) +
					'">Reject</button>' +
					'<button type="button" class="button proposal-card-apply" data-proposal-id="' +
					escapeHtml(p.id) +
					'">Apply selected</button>' +
					'</div>' +
					'</div>' +
					summary +
					'<div class="proposal-card-changes">' +
					changeRows +
					'</div>' +
					'</div>'
				);
			}

			async function _applyProposal(canvasId, proposalId, modal, opts) {
				opts = opts || {};
				const skipChangeIndexes = Array.isArray(opts.skipChangeIndexes) ? opts.skipChangeIndexes : [];
				const skipCount = Number.isInteger(opts.skipItemCount) ? opts.skipItemCount : skipChangeIndexes.length;

				if (!opts.skipConfirm) {
					const ok = await showConfirmDialog({
						title: 'Apply this proposal to the canvas?',
						message:
							skipCount > 0
								? skipCount +
									' change' +
									(skipCount === 1 ? '' : 's') +
									' will be skipped. The rest will land on the canvas; nothing is written to Salesforce yet.'
								: 'The proposed values will land on the canvas; nothing is written to Salesforce yet. To push to Salesforce, save and upload the canvas as you would any other change.',
						confirmLabel: skipCount > 0 ? 'Apply selected' : 'Apply to canvas',
						cancelLabel: 'Cancel',
						danger: false,
					});
					if (!ok) {
						return;
					}
				}
				// Snapshot before the server apply so the entire accepted proposal is one undo action.
				const undoSnapshot = pushUndo
					? {
							selectedObjects: structuredClone(canvasState.selectedObjects || []),
							selectedIdSeq: canvasState.selectedIdSeq,
							activeIndex: canvasState.activeIndex,
							hiddenObjects: new Set(canvasState.hiddenObjects || []),
							bulkRecords: structuredClone(canvasState.bulkRecords || []),
							bulkAssociations: structuredClone(canvasState.bulkAssociations || []),
							bulkIdSeq: canvasState.bulkIdSeq,
							bulkInitialized: canvasState.bulkInitialized,
						}
					: null;
				try {
					const r = await csrfFetch(
						'/api/canvas/' +
							encodeURIComponent(canvasId) +
							'/proposals/' +
							encodeURIComponent(proposalId) +
							'/apply',
						{
							method: 'POST',
							credentials: 'same-origin',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify(skipChangeIndexes.length ? { skipChangeIndexes } : {}),
						},
					);
					if (!r.ok) {
						const body = await r.json().catch(() => ({}));
						showBulkToast((body && body.error) || 'Could not apply (HTTP ' + r.status + ').', 'error');
						return;
					}
					const data = await r.json();
					const results = data && Array.isArray(data.results) ? data.results : [];
					const applied = results.filter((x) => x.status === 'applied').length;
					const failed = results.filter((x) => x.status === 'failed');
					const skipped = results.filter((x) => x.status === 'skipped').length;
					let msg = applied + ' applied';
					if (skipped) {
						msg += ', ' + skipped + ' skipped';
					}
					if (failed.length) {
						msg += ', ' + failed.length + ' failed';
					}

					if (failed.length || !opts.silentToast) {
						showBulkToast(msg, failed.length ? 'error' : 'success');
					}
					if (modal) {
						modal.remove();
					}
					_refreshProposals();

					const _localId =
						(canvasState.currentCanvas && canvasState.currentCanvas.id) || _proposalsPollCanvasId();
					// Apply results only when the proposal still belongs to the open canvas.
					if (canvasId && _localId === canvasId) {
						let touched = false;

						const STEP_X = 260;
						const STEP_Y = 170;
						const PER_ROW = 5;
						const _canvasEl = document.querySelector('#bulk-canvas');
						const _cw = (_canvasEl && _canvasEl.clientWidth) || 0;
						const _ch = (_canvasEl && _canvasEl.clientHeight) || 0;
						const _baseX = 80;
						let _baseY = 80;
						for (const rr of canvasState.bulkRecords) {
							if (typeof rr.y === 'number' && rr.y + STEP_Y > _baseY) {
								_baseY = rr.y + STEP_Y;
							}
						}

						if (canvasState.bulkRecords.length === 0) {
							_baseY = _ch > 0 ? _ch / 2 : 400;
						}
						let _newDraftSlot = 0;
						function _placeNewDraft(objectName) {
							const siblings = canvasState.bulkRecords.filter((r) => r.objectName === objectName);
							if (siblings.length > 0) {
								const anchor = siblings[0];
								const idx = siblings.length;
								const col = idx % PER_ROW;
								const r = Math.floor(idx / PER_ROW);
								return {
									x: anchor.x + col * STEP_X,
									y: anchor.y + r * STEP_Y,
								};
							}
							const slot = _newDraftSlot++;
							const col = slot % PER_ROW;
							const row = Math.floor(slot / PER_ROW);
							const baseX = _cw > 0 ? Math.max(_baseX, _cw / 2 - ((PER_ROW - 1) * STEP_X) / 2) : _baseX;
							return {
								x: baseX + col * STEP_X,
								y: _baseY + row * STEP_Y,
							};
						}

						const tempIdToRuntimeId = new Map();

						const _addResultCount = results.filter(
							(r) => r && r.status === 'applied' && (r.kind === 'new-draft' || r.kind === 'load-record'),
						).length;
						const _cap = canvasCapCheck(_addResultCount);
						if (_cap.blocked) {
							showBulkToast(_cap.reason, 'error');
							return;
						}

						function _canonicalizeFields(objectName, fields) {
							// Normalize model-supplied field casing against the current Salesforce describe.
							if (!fields || typeof fields !== 'object') {
								return {};
							}
							const describe = canvasState.describeCache[objectName];
							const fieldList = describe && Array.isArray(describe.fields) ? describe.fields : null;
							if (!fieldList || fieldList.length === 0) {
								return Object.assign({}, fields);
							}
							const byLower = new Map();
							for (const f of fieldList) {
								if (f && typeof f.name === 'string') {
									byLower.set(f.name.toLowerCase(), f.name);
								}
							}
							const out = {};
							for (const k of Object.keys(fields)) {
								const canon = byLower.get(k.toLowerCase()) || k;
								out[canon] = fields[k];
							}
							return out;
						}

						for (const result of results) {
							if (result.status !== 'applied') {
								continue;
							}
							const rawFields = result.fields && typeof result.fields === 'object' ? result.fields : {};
							if (result.kind === 'new-draft') {
								try {
									let sel = canvasState.selectedObjects.find((so) => so.name === result.objectName);
									if (!sel) {
										sel = await addToSelection(result.objectName);
									}
									if (!sel) {
										continue;
									}

									try {
										await ensureDescribe(sel.name);
									} catch (_) {}
									const fields = _canonicalizeFields(sel.name, rawFields);
									const pos = _placeNewDraft(sel.name);
									const runtimeId = canvasState.bulkIdSeq++;
									canvasState.bulkRecords.push({
										id: runtimeId,
										objectName: sel.name,
										label: sel.label || result.objectName,
										x: pos.x,
										y: pos.y,
										values: Object.assign({}, fields),
										fromSelectionId: sel.id,
									});
									if (result.tempId != null) {
										tempIdToRuntimeId.set(result.tempId, runtimeId);
									}
									touched = true;
								} catch (addErr) {
									console.warn('[proposal-apply] could not add new-draft locally:', addErr);
								}
							} else if (result.kind === 'draft') {
								const tempId = result.tempId != null ? result.tempId : result.targetId;
								const runtimeId = tempIdToRuntimeId.has(tempId)
									? tempIdToRuntimeId.get(tempId)
									: tempId;
								const rec = canvasState.bulkRecords.find(
									(r) => String(r.id) === String(runtimeId) && !r.loadedFromId,
								);
								if (rec) {
									try {
										await ensureDescribe(rec.objectName);
									} catch (_) {}
									const fields = _canonicalizeFields(rec.objectName, rawFields);
									rec.values = Object.assign({}, rec.values || {}, fields);
									touched = true;
								}
							} else if (result.kind === 'record') {
								const recordId = result.recordId != null ? result.recordId : result.targetId;
								const key = recordId == null ? null : String(recordId);
								if (key) {
									const rec = canvasState.bulkRecords.find((r) => {
										const id = (r.values && r.values.Id) || r.loadedFromId;
										return id && String(id) === key;
									});
									if (rec) {
										try {
											await ensureDescribe(rec.objectName);
										} catch (_) {}
										const fields = _canonicalizeFields(rec.objectName, rawFields);
										rec.values = Object.assign({}, rec.values || {}, fields);
										touched = true;
									}
								}
							} else if (result.kind === 'delete-draft') {
								const tempId = result.tempId != null ? result.tempId : result.targetId;
								const before = canvasState.bulkRecords.length;
								canvasState.bulkRecords = canvasState.bulkRecords.filter(
									(r) => !(r.id === tempId && !r.loadedFromId),
								);

								canvasState.bulkAssociations = canvasState.bulkAssociations.filter(
									(a) => a.fromId !== tempId && a.toId !== tempId,
								);
								if (canvasState.bulkRecords.length !== before) {
									if (canvasState.bulkSelectedIds && canvasState.bulkSelectedIds.delete) {
										canvasState.bulkSelectedIds.delete(tempId);
									}
									touched = true;
								}
							} else if (result.kind === 'delete-record') {
								const recordId = result.recordId != null ? result.recordId : result.targetId;
								const key = recordId == null ? null : String(recordId);
								if (key) {
									const rec = canvasState.bulkRecords.find((r) => {
										const id = (r.values && r.values.Id) || r.loadedFromId;
										return id && String(id) === key;
									});
									if (rec) {
										const runtimeId = rec.id;
										canvasState.bulkRecords = canvasState.bulkRecords.filter((r) => r !== rec);
										canvasState.bulkAssociations = canvasState.bulkAssociations.filter(
											(a) => a.fromId !== runtimeId && a.toId !== runtimeId,
										);
										if (canvasState.bulkSelectedIds && canvasState.bulkSelectedIds.delete) {
											canvasState.bulkSelectedIds.delete(runtimeId);
										}
										touched = true;
									}
								}
							} else if (result.kind === 'autofill-required') {
								try {
									const requestedTempIds = Array.isArray(result.tempIds) ? result.tempIds : [];
									bulkAutoFill('required', 'both', {
										tempIds: requestedTempIds,
										silent: true,
									});
									touched = true;
								} catch (autofillErr) {
									console.warn('[proposal-apply] autofill failed:', autofillErr);
								}
							} else if (result.kind === 'load-record') {
								try {
									let sel = canvasState.selectedObjects.find((so) => so.name === result.objectName);
									if (!sel) {
										sel = await addToSelection(result.objectName);
									}
									if (!sel) {
										continue;
									}
									const values =
										result.values && typeof result.values === 'object' ? result.values : {};
									const pos = _placeNewDraft(sel.name);
									canvasState.bulkRecords.push({
										id: canvasState.bulkIdSeq++,
										objectName: sel.name,
										label: sel.label || result.objectName,
										x: pos.x,
										y: pos.y,
										values: Object.assign({}, values),
										loadedFromId: result.recordId,
										loadedValues: Object.assign({}, values),
										fromSelectionId: sel.id,
									});
									touched = true;
								} catch (loadErr) {
									console.warn('[proposal-apply] load-record failed:', loadErr);
								}
							}
						}

						function _resolveAssocEndpoint(ep) {
							if (!ep || typeof ep !== 'object') {
								return null;
							}
							if (ep.kind === 'loaded') {
								const key = String(ep.ref);
								const rec = canvasState.bulkRecords.find((r) => {
									const id = (r.values && r.values.Id) || r.loadedFromId;
									return id && String(id) === key;
								});
								return rec ? rec.id : null;
							}
							if (ep.kind === 'draft') {
								if (tempIdToRuntimeId.has(ep.ref)) {
									return tempIdToRuntimeId.get(ep.ref);
								}
								const rec = canvasState.bulkRecords.find((r) => r.id === ep.ref && !r.loadedFromId);
								return rec ? rec.id : null;
							}
							return null;
						}
						for (const result of results) {
							if (result.status !== 'applied') {
								continue;
							}
							if (result.kind === 'new-association') {
								const fromId = _resolveAssocEndpoint(result.from);
								const toId = _resolveAssocEndpoint(result.to);
								if (fromId == null || toId == null) {
									continue;
								}
								const fieldName = result.fieldName;
								const upsert = _upsertSingleLookupAssociation(canvasState.bulkAssociations, {
									id: canvasState.bulkIdSeq,
									fromId,
									toId,
									fieldName,
								});
								if (upsert.changed) {
									canvasState.bulkAssociations = upsert.associations;
									if (upsert.inserted) {
										canvasState.bulkIdSeq++;
									}
									touched = true;
								}
								if (_syncLookupFieldValue(canvasState.bulkRecords, fromId, toId, fieldName)) {
									touched = true;
								}
							} else if (result.kind === 'delete-association') {
								const fromId = _resolveAssocEndpoint(result.from);
								const toId = _resolveAssocEndpoint(result.to);
								if (fromId == null || toId == null) {
									continue;
								}
								const fieldName = result.fieldName;
								const before = canvasState.bulkAssociations.length;
								canvasState.bulkAssociations = canvasState.bulkAssociations.filter(
									(a) => !(a.fromId === fromId && a.toId === toId && a.fieldName === fieldName),
								);
								if (canvasState.bulkAssociations.length !== before) {
									touched = true;
								}
							}
						}
						if (touched) {
							if (undoSnapshot && pushUndo) {
								const appliedFingerprint = JSON.stringify({
									selectedObjects: canvasState.selectedObjects || [],
									hiddenObjects: Array.from(canvasState.hiddenObjects || []).sort(),
									bulkRecords: canvasState.bulkRecords || [],
									bulkAssociations: canvasState.bulkAssociations || [],
								});
								pushUndo('AI proposal apply', function () {
									const currentFingerprint = JSON.stringify({
										selectedObjects: canvasState.selectedObjects || [],
										hiddenObjects: Array.from(canvasState.hiddenObjects || []).sort(),
										bulkRecords: canvasState.bulkRecords || [],
										bulkAssociations: canvasState.bulkAssociations || [],
									});
									if (currentFingerprint !== appliedFingerprint) {
										showBulkToast(
											'Can’t undo the AI proposal because the canvas was edited afterward.',
											'info',
										);
										return false;
									}
									canvasState.selectedObjects = undoSnapshot.selectedObjects;
									canvasState.selectedIdSeq = undoSnapshot.selectedIdSeq;
									canvasState.activeIndex = undoSnapshot.activeIndex;
									canvasState.hiddenObjects.clear();
									undoSnapshot.hiddenObjects.forEach((value) => canvasState.hiddenObjects.add(value));
									canvasState.bulkRecords = undoSnapshot.bulkRecords;
									canvasState.bulkAssociations = undoSnapshot.bulkAssociations;
									canvasState.bulkIdSeq = undoSnapshot.bulkIdSeq;
									canvasState.bulkInitialized = undoSnapshot.bulkInitialized;
									canvasState.bulkSelectedIds = new Set();
									canvasState.bulkSelectedEdgeId = null;
									renderBulkView();
									showBulkToast('AI proposal apply undone.');
								});
							}
							try {
								renderBulkView();
							} catch (renderErr) {
								console.warn('[proposal-apply] re-render failed:', renderErr);
							}
						}
					}
				} catch (e) {
					showBulkToast('Could not apply: ' + (e.message || e), 'error');
				}
			}

			async function _rejectProposal(canvasId, proposalId, modal) {
				const ok = await showConfirmDialog({
					title: 'Reject this proposal?',
					message: 'The proposed changes will be discarded. Salesforce records will not be modified.',
					confirmLabel: 'Reject',
					cancelLabel: 'Cancel',
					danger: false,
				});
				if (!ok) {
					return;
				}
				try {
					const r = await csrfFetch(
						'/api/canvas/' +
							encodeURIComponent(canvasId) +
							'/proposals/' +
							encodeURIComponent(proposalId) +
							'/reject',
						{ method: 'POST', credentials: 'same-origin' },
					);
					if (!r.ok) {
						const body = await r.json().catch(() => ({}));
						showBulkToast((body && body.error) || 'Could not reject (HTTP ' + r.status + ').', 'error');
						return;
					}
					if (modal) {
						modal.remove();
					}
					_refreshProposals();
				} catch (e) {
					showBulkToast('Could not reject: ' + (e.message || e), 'error');
				}
			}

			return {
				getPollCanvasId: _proposalsPollCanvasId,
				openProposalsReview: _openProposalsReview,
				renderProposalCard: _renderProposalCard,
				syncLookupFieldValue: _syncLookupFieldValue,
				upsertSingleLookupAssociation: _upsertSingleLookupAssociation,
				refreshProposals: _refreshProposals,
				watchProposalsForCurrentCanvas: _watchProposalsForCurrentCanvas,
			};
		},
	};
})();
