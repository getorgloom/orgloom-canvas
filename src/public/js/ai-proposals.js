(function () {
	"use strict";

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.aiProposals = {
		mount: function mount(deps) {
			const _required = [
				"canvasState",
				"csrfFetch",
				"escapeHtml",
				"showBulkToast",
				"showConfirmDialog",
				"addToSelection",
				"bulkAutoFill",
				"ensureDescribe",
				"renderBulkView",
			];
			for (const k of _required) {
				if (deps == null || deps[k] == null) {
					throw new Error(
						"ai-proposals.mount: missing required dep: " + k,
					);
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

			const canvasCapCheck = typeof deps.canvasCapCheck === "function"
				? deps.canvasCapCheck
				: function () { return { ok: true, blocked: false, reason: null }; };
			let _proposalsPollTimer = null;
			let _proposalsLastCanvasId = null;
			const _proposalsBanner = document.createElement("div");
			_proposalsBanner.className = "proposals-banner";
			_proposalsBanner.hidden = true;
			const _proposalsBannerText = document.createElement("span");
			_proposalsBannerText.className = "proposals-banner-text";
			const _proposalsReviewBtn = document.createElement("button");
			_proposalsReviewBtn.type = "button";
			_proposalsReviewBtn.className = "button";
			_proposalsReviewBtn.id = "proposals-banner-review";
			_proposalsReviewBtn.textContent = "Review";
			const _proposalsCloseBtn = document.createElement("button");
			_proposalsCloseBtn.type = "button";
			_proposalsCloseBtn.className = "proposals-banner-close";
			_proposalsCloseBtn.id = "proposals-banner-close";
			_proposalsCloseBtn.setAttribute("aria-label", "Dismiss");
			_proposalsCloseBtn.textContent = "×";
			_proposalsBanner.innerHTML =
				'<span class="proposals-banner-icon" aria-hidden="true">✨</span>';
			_proposalsBanner.appendChild(_proposalsBannerText);
			_proposalsBanner.appendChild(_proposalsReviewBtn);
			_proposalsBanner.appendChild(_proposalsCloseBtn);
			document.body.appendChild(_proposalsBanner);
			_proposalsReviewBtn.addEventListener("click", () => {
				const cur = _proposalsPollCanvasId();
				if (cur) {
					_openProposalsReview(cur);
				}
			});
			_proposalsCloseBtn.addEventListener("click", () => {
				_proposalsBanner.hidden = true;
			});

			function _proposalsPollCanvasId() {
				if (canvasState.currentCanvas && canvasState.currentCanvas.id) {
					return canvasState.currentCanvas.id;
				}
				const cs = window.Orgloom && window.Orgloom.canvasState;
				if (cs && typeof cs.getCurrentCanvas === "function") {
					const c = cs.getCurrentCanvas();
					return (c && c.canvasId) || null;
				}
				return null;
			}
			async function _refreshProposals() {
				const id = _proposalsPollCanvasId();
				if (!id) {
					_proposalsBanner.hidden = true;
					return;
				}
				try {
					const r = await csrfFetch(
						"/api/canvas/" + encodeURIComponent(id) + "/proposals",
						{
							credentials: "same-origin",
						},
					);
					if (!r.ok) {
						_proposalsBanner.hidden = true;
						return;
					}
					const data = await r.json();
					const proposals =
						data && Array.isArray(data.proposals)
							? data.proposals
							: [];
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
							} catch (_) {

							}
						}
						return;
					}
					const totalChanges = proposals.reduce(
						(sum, p) =>
							sum +
							(Array.isArray(p.changes) ? p.changes.length : 0),
						0,
					);

					_proposalsBannerText.innerHTML =
						"<strong>" +
						proposals.length +
						"</strong> AI proposal" +
						(proposals.length === 1 ? "" : "s") +
						" pending (<strong>" +
						totalChanges +
						"</strong> change" +
						(totalChanges === 1 ? "" : "s") +
						")";
					if (
						_proposalsBanner.hidden &&
						window.posthog &&
						window.posthog.capture
					) {
						try {
							window.posthog.capture("ai_proposal_received", {
								proposal_count: proposals.length,
								change_count: totalChanges,
								canvas_id_kind:
									typeof id === "string" &&
									id.indexOf("draft-") === 0
										? "draft"
										: "saved",
							});
						} catch (_) {

						}
					}
					_proposalsBanner.hidden = false;
				} catch (e) {

				}
			}

			function _watchProposalsForCurrentCanvas() {
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

			document.addEventListener("visibilitychange", () => {
				if (document.visibilityState === "visible") {
					_refreshProposals();
				}
			});
			window.addEventListener("focus", () => {
				_refreshProposals();
			});

			function _autoApplyStorageKey(canvasId) {
				return "orgloom:aiAutoApply:" + canvasId;
			}
			function _isAutoApplyEnabled(canvasId) {
				if (!canvasId) {
					return false;
				}
				try {
					return (
						window.localStorage.getItem(
							_autoApplyStorageKey(canvasId),
						) === "1"
					);
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
						window.localStorage.setItem(
							_autoApplyStorageKey(canvasId),
							"1",
						);
					} else {
						window.localStorage.removeItem(
							_autoApplyStorageKey(canvasId),
						);
					}
				} catch (_) {

				}
			}

			async function _openProposalsReview(canvasId) {
				document
					.querySelectorAll(".proposals-review-modal")
					.forEach((el) => el.remove());
				const modal = document.createElement("div");
				modal.className = "modal proposals-review-modal";
				modal.setAttribute("data-canvas-id", canvasId);
				modal.innerHTML =
					'<div class="modal-overlay" data-pr-close></div>' +
					'<div class="modal-body" style="max-width:780px">' +
					'<div class="modal-header">' +
					"<h3>AI proposals</h3>" +
					'<button class="modal-close" data-pr-close>&times;</button>' +
					"</div>" +
					'<div class="proposals-autoapply-row">' +
					'<label class="proposals-autoapply-label">' +
					'<input type="checkbox" class="proposals-autoapply-toggle"' +
					(_isAutoApplyEnabled(canvasId) ? " checked" : "") +
					">" +
					"<span><strong>Auto-apply AI proposals to this canvas</strong> — future proposals land on the canvas without opening this review. Each change still echoes into the canvas state as if you clicked Apply; Salesforce uploads still require a separate Save + Upload. Per-canvas, browser-only.</span>" +
					"</label>" +
					"</div>" +
					'<div class="modal-content" id="proposals-review-content">' +
					'<p class="center tag">Loading…</p>' +
					"</div>" +
					"</div>";
				document.body.appendChild(modal);
				modal
					.querySelectorAll("[data-pr-close]")
					.forEach((el) =>
						el.addEventListener("click", () => modal.remove()),
					);
				document.addEventListener("keydown", function _onEsc(ev) {
					if (ev.key === "Escape") {
						modal.remove();
						document.removeEventListener("keydown", _onEsc);
					}
				});
				const autoToggle = modal.querySelector(
					".proposals-autoapply-toggle",
				);
				if (autoToggle) {
					autoToggle.addEventListener("change", async () => {
						_setAutoApplyEnabled(canvasId, autoToggle.checked);

						if (autoToggle.checked) {
							await _refreshProposals();
							modal.remove();
						}
					});
				}

				try {
					const r = await csrfFetch(
						"/api/canvas/" +
							encodeURIComponent(canvasId) +
							"/proposals",
						{
							credentials: "same-origin",
						},
					);
					if (!r.ok) {
						modal.querySelector(
							"#proposals-review-content",
						).innerHTML =
							'<div class="banner error">Could not load proposals (HTTP ' +
							r.status +
							").</div>";
						return;
					}
					const data = await r.json();
					const proposals =
						data && Array.isArray(data.proposals)
							? data.proposals
							: [];
					if (proposals.length === 0) {
						modal.querySelector(
							"#proposals-review-content",
						).innerHTML =
							'<p class="acct-empty">No pending proposals.</p>';
						return;
					}
					const html = proposals
						.map((p) => _renderProposalCard(p))
						.join("");
					modal.querySelector("#proposals-review-content").innerHTML =
						html;

					modal.querySelectorAll(".proposal-card").forEach((card) => {
						const checkboxes = card.querySelectorAll(
							".proposal-change-checkbox",
						);
						const countEl = card.querySelector(
							".proposal-selected-count",
						);
						const applyBtn = card.querySelector(
							".proposal-card-apply",
						);
						const total = checkboxes.length;
						const updateCount = () => {
							let selected = 0;
							checkboxes.forEach((cb) => {
								if (cb.checked) {
									selected++;
								}
							});
							if (countEl) {
								countEl.textContent =
									selected + " of " + total + " selected";
							}
							if (applyBtn) {
								applyBtn.disabled = selected === 0;
								applyBtn.textContent =
									selected === total
										? "Apply"
										: selected === 0
											? "Apply (none selected)"
											: "Apply selected (" +
												selected +
												")";
							}
						};
						checkboxes.forEach((cb) =>
							cb.addEventListener("change", updateCount),
						);
						const selAll = card.querySelector(
							".proposal-select-all",
						);
						if (selAll) {
							selAll.addEventListener("click", () => {
								checkboxes.forEach((cb) => {
									cb.checked = true;
								});
								updateCount();
							});
						}
						const selNone = card.querySelector(
							".proposal-select-none",
						);
						if (selNone) {
							selNone.addEventListener("click", () => {
								checkboxes.forEach((cb) => {
									cb.checked = false;
								});
								updateCount();
							});
						}
						updateCount();
					});
					modal
						.querySelectorAll(".proposal-card-apply")
						.forEach((btn) => {
							btn.addEventListener("click", async () => {
								const pid =
									btn.getAttribute("data-proposal-id");
								const card = btn.closest(".proposal-card");
								const skipChangeIndexes = [];
								if (card) {
									card.querySelectorAll(
										".proposal-change-checkbox",
									).forEach((cb) => {
										if (!cb.checked) {
											const i = Number(
												cb.getAttribute(
													"data-change-index",
												),
											);
											if (Number.isInteger(i)) {
												skipChangeIndexes.push(i);
											}
										}
									});
								}
								await _applyProposal(canvasId, pid, modal, {
									skipChangeIndexes,
								});
							});
						});
					modal
						.querySelectorAll(".proposal-card-reject")
						.forEach((btn) => {
							btn.addEventListener("click", async () => {
								const pid =
									btn.getAttribute("data-proposal-id");
								await _rejectProposal(canvasId, pid, modal);
							});
						});
				} catch (e) {
					modal.querySelector("#proposals-review-content").innerHTML =
						'<div class="banner error">' +
						escapeHtml(e.message || String(e)) +
						"</div>";
				}
			}

			function _renderProposalCard(p) {
				const summary = p.summary
					? '<p class="proposal-card-summary">' +
						escapeHtml(p.summary) +
						"</p>"
					: "";
				const ts = p.createdAt
					? new Date(p.createdAt).toLocaleString()
					: "";
				const changes = Array.isArray(p.changes) ? p.changes : [];
				const _fmt = (v) => {
					if (v == null) {
						return "";
					}
					if (typeof v === "object") {
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
					if (ch && ch.kind === "new-draft" && ch.tempRef) {
						_newDraftRefIndex.set(
							String(ch.tempRef),
							ch.objectName || "record",
						);
					}
				}
				const _epLabel = (ep) => {
					if (!ep) {
						return "?";
					}
					if (ep.kind === "loaded") {
						return (
							"<code>" + escapeHtml(String(ep.ref)) + "</code>"
						);
					}
					if (ep.kind === "draft") {
						return (
							"Draft #<code>" +
							escapeHtml(String(ep.ref)) +
							"</code>"
						);
					}
					if (ep.kind === "tempRef") {
						const objName = _newDraftRefIndex.get(String(ep.ref));
						return objName
							? "New <code>" +
									escapeHtml(objName) +
									"</code> (this proposal)"
							: "New record (this proposal)";
					}
					return escapeHtml(JSON.stringify(ep));
				};

				const _wrapChangeRow = (idx, innerHtml) =>
					'<label class="proposal-change-row">' +
					'<input type="checkbox" class="proposal-change-checkbox" ' +
					'data-change-index="' +
					idx +
					'" checked>' +
					'<div class="proposal-change-body">' +
					innerHtml +
					"</div>" +
					"</label>";
				const changeRows = changes
					.map((c, idx) => {
						if (
							c.kind === "new-association" ||
							c.kind === "delete-association"
						) {
							const isAdd = c.kind === "new-association";
							const chip = isAdd
								? '<span class="proposal-kind-chip proposal-kind-chip--new" title="Add an FK link between two records on the canvas">+ link</span>'
								: '<span class="proposal-kind-chip proposal-kind-chip--record" title="Remove an existing FK link between two records">− unlink</span>';
							return _wrapChangeRow(
								idx,
								'<div class="proposal-record">' +
									'<div class="proposal-record-head">' +
									"<code>" +
									escapeHtml(c.fieldName || "") +
									"</code> " +
									chip +
									"</div>" +
									'<table class="proposal-fields">' +
									"<thead><tr><th>From (child)</th><th>To (parent)</th></tr></thead>" +
									"<tbody><tr>" +
									"<td>" +
									_epLabel(c.from) +
									"</td>" +
									"<td>" +
									_epLabel(c.to) +
									"</td>" +
									"</tr></tbody>" +
									"</table>" +
									"</div>",
							);
						}
						if (
							c.kind === "delete-draft" ||
							c.kind === "delete-record"
						) {
							const isDraftDel = c.kind === "delete-draft";
							const chip =
								'<span class="proposal-kind-chip proposal-kind-chip--record" title="Remove from the canvas. Salesforce records are NOT deleted — this only removes the canvas reference.">− remove</span>';
							const target = isDraftDel
								? "Draft #<code>" +
									escapeHtml(String(c.tempId)) +
									"</code>"
								: "Record <code>" +
									escapeHtml(String(c.recordId)) +
									"</code>";
							const note = isDraftDel
								? "The draft is removed from the canvas; any associations touching it are dropped too."
								: "The reference is removed from the canvas + its associations are dropped. The Salesforce record itself is NOT deleted.";
							return _wrapChangeRow(
								idx,
								'<div class="proposal-record">' +
									'<div class="proposal-record-head">' +
									target +
									" " +
									chip +
									"</div>" +
									'<p class="tag" style="margin:0.2em 0 0">' +
									note +
									"</p>" +
									"</div>",
							);
						}
						if (c.kind === "autofill-required") {
							const ids = Array.isArray(c.tempIds)
								? c.tempIds
								: [];
							const scope =
								ids.length === 0
									? "every draft on the canvas"
									: ids.length +
										" draft" +
										(ids.length === 1 ? "" : "s") +
										" (tempIds: " +
										ids.join(", ") +
										")";
							const chip =
								'<span class="proposal-kind-chip proposal-kind-chip--new" title="Fill required fields with sample values on the listed drafts. Same logic as the Bulk Operations → Fill required fields button.">✨ autofill</span>';
							return _wrapChangeRow(
								idx,
								'<div class="proposal-record">' +
									'<div class="proposal-record-head">' +
									chip +
									"</div>" +
									'<p class="tag" style="margin:0.2em 0 0">Auto-fill required fields on ' +
									escapeHtml(scope) +
									". Picklists pick a real option; lookups use smart defaults where known. Fields already populated are left untouched.</p>" +
									"</div>",
							);
						}
						if (c.kind === "load-record") {
							const chip =
								'<span class="proposal-kind-chip proposal-kind-chip--new" title="Load an existing Salesforce record onto the canvas. Triggers a Salesforce read on apply via your active connection.">↓ load</span>';
							const fieldsNote =
								Array.isArray(c.fields) && c.fields.length > 0
									? " Loading just these fields: <code>" +
										escapeHtml(c.fields.join(", ")) +
										"</code>."
									: "";
							return _wrapChangeRow(
								idx,
								'<div class="proposal-record">' +
									'<div class="proposal-record-head">' +
									"<code>" +
									escapeHtml(c.objectName || "") +
									"</code> " +
									'<code class="tag">' +
									escapeHtml(String(c.recordId || "")) +
									"</code> " +
									chip +
									"</div>" +
									'<p class="tag" style="margin:0.2em 0 0">Fetch this record from Salesforce via your active connection and add it to the canvas.' +
									fieldsNote +
									"</p>" +
									"</div>",
							);
						}
						const fields =
							c.fields && typeof c.fields === "object"
								? c.fields
								: {};
						const oldValues =
							c.oldValues && typeof c.oldValues === "object"
								? c.oldValues
								: {};
						const fieldKeys = Object.keys(fields);
						const fieldRows = fieldKeys
							.map((k) => {
								const oldRaw = oldValues[k];
								const oldStr = _fmt(oldRaw);
								const newStr = _fmt(fields[k]);
								const same = oldStr === newStr;
								const oldCell =
									oldStr === ""
										? '<td class="proposal-old proposal-old--empty">—</td>'
										: '<td class="proposal-old">' +
											escapeHtml(oldStr) +
											"</td>";
								const newCell = same
									? '<td class="proposal-new proposal-new--unchanged">' +
										escapeHtml(newStr) +
										' <span class="tag">unchanged</span></td>'
									: '<td class="proposal-new">' +
										escapeHtml(newStr) +
										"</td>";
								return (
									"<tr>" +
									"<td><code>" +
									escapeHtml(k) +
									"</code></td>" +
									oldCell +
									newCell +
									"</tr>"
								);
							})
							.join("");

						const isNewDraft = c.kind === "new-draft";
						const kind = isNewDraft
							? "new-draft"
							: c.kind === "draft"
								? "draft"
								: "record";
						const targetId =
							kind === "draft"
								? c.tempId
								: kind === "record"
									? c.recordId
									: null;
						const kindChip = isNewDraft
							? '<span class="proposal-kind-chip proposal-kind-chip--new" title="Brand-new draft record. On Apply, a fresh draft appears on the canvas with these field values.">+ new draft</span>'
							: kind === "draft"
								? '<span class="proposal-kind-chip proposal-kind-chip--draft" title="Draft on the canvas — not yet uploaded to Salesforce">draft</span>'
								: '<span class="proposal-kind-chip proposal-kind-chip--record" title="Loaded Salesforce record on the canvas — Apply updates the canvas, not Salesforce">SF record</span>';

						const targetTag = isNewDraft
							? ""
							: '<code class="tag">' +
								(kind === "draft" ? "tempId " : "") +
								escapeHtml(
									String(targetId == null ? "" : targetId),
								) +
								"</code> ";
						const tableHeaders = isNewDraft
							? "<thead><tr><th>Field</th><th>Value</th></tr></thead>"
							: "<thead><tr><th>Field</th><th>Old value</th><th>New value</th></tr></thead>";
						const tableBody = isNewDraft
							? Object.keys(fields)
									.map(
										(k) =>
											"<tr>" +
											"<td><code>" +
											escapeHtml(k) +
											"</code></td>" +
											'<td class="proposal-new">' +
											escapeHtml(_fmt(fields[k])) +
											"</td>" +
											"</tr>",
									)
									.join("")
							: fieldRows;
						return _wrapChangeRow(
							idx,
							'<div class="proposal-record">' +
								'<div class="proposal-record-head">' +
								"<code>" +
								escapeHtml(c.objectName || "") +
								"</code> " +
								targetTag +
								kindChip +
								"</div>" +
								'<table class="proposal-fields">' +
								tableHeaders +
								"<tbody>" +
								tableBody +
								"</tbody>" +
								"</table>" +
								"</div>",
						);
					})
					.join("");
				return (
					'<div class="proposal-card" data-proposal-id="' +
					escapeHtml(p.id) +
					'">' +
					'<div class="proposal-card-head">' +
					"<div>" +
					"<strong>Proposal</strong> " +
					'<span class="tag">' +
					escapeHtml(ts) +
					"</span> " +
					'<span class="tag proposal-selected-count">' +
					changes.length +
					" of " +
					changes.length +
					" selected" +
					"</span>" +
					"</div>" +
					'<div class="proposal-card-actions">' +
					'<button type="button" class="link-button proposal-select-all">Select all</button>' +
					'<button type="button" class="link-button proposal-select-none">None</button>' +
					'<button type="button" class="button secondary proposal-card-reject" data-proposal-id="' +
					escapeHtml(p.id) +
					'">Reject</button>' +
					'<button type="button" class="button proposal-card-apply" data-proposal-id="' +
					escapeHtml(p.id) +
					'">Apply selected</button>' +
					"</div>" +
					"</div>" +
					summary +
					'<div class="proposal-card-changes">' +
					changeRows +
					"</div>" +
					"</div>"
				);
			}

			async function _applyProposal(canvasId, proposalId, modal, opts) {
				opts = opts || {};
				const skipChangeIndexes = Array.isArray(opts.skipChangeIndexes)
					? opts.skipChangeIndexes
					: [];
				const skipCount = skipChangeIndexes.length;

				if (!opts.skipConfirm) {
					const ok = await showConfirmDialog({
						title: "Apply this proposal to the canvas?",
						message:
							skipCount > 0
								? skipCount +
									" change" +
									(skipCount === 1 ? "" : "s") +
									" will be skipped. The rest will land on the canvas — nothing is written to Salesforce yet."
								: "The proposed values will land on the canvas — nothing is written to Salesforce yet. To push to Salesforce, save and upload the canvas as you would any other change.",
						confirmLabel:
							skipCount > 0
								? "Apply selected"
								: "Apply to canvas",
						cancelLabel: "Cancel",
						danger: false,
					});
					if (!ok) {
						return;
					}
				}
				try {
					const r = await csrfFetch(
						"/api/canvas/" +
							encodeURIComponent(canvasId) +
							"/proposals/" +
							encodeURIComponent(proposalId) +
							"/apply",
						{
							method: "POST",
							credentials: "same-origin",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify(
								skipChangeIndexes.length
									? { skipChangeIndexes }
									: {},
							),
						},
					);
					if (!r.ok) {
						const body = await r.json().catch(() => ({}));
						showBulkToast(
							(body && body.error) ||
								"Could not apply (HTTP " + r.status + ").",
							"error",
						);
						return;
					}
					const data = await r.json();
					const results =
						data && Array.isArray(data.results) ? data.results : [];
					const applied = results.filter(
						(x) => x.status === "applied",
					).length;
					const failed = results.filter((x) => x.status === "failed");
					const skipped = results.filter(
						(x) => x.status === "skipped",
					).length;
					let msg = applied + " applied";
					if (skipped) {
						msg += ", " + skipped + " skipped";
					}
					if (failed.length) {
						msg += ", " + failed.length + " failed";
					}

					if (failed.length || !opts.silentToast) {
						showBulkToast(msg, failed.length ? "error" : "success");
					}
					if (modal) {
						modal.remove();
					}
					_refreshProposals();

					const _localId =
						(canvasState.currentCanvas &&
							canvasState.currentCanvas.id) ||
						_proposalsPollCanvasId();
					if (canvasId && _localId === canvasId) {
						let touched = false;

						const STEP_X = 260;
						const STEP_Y = 170;
						const PER_ROW = 5;
						const _canvasEl = graph.querySelector("#bulk-canvas");
						const _cw = (_canvasEl && _canvasEl.clientWidth) || 0;
						const _ch = (_canvasEl && _canvasEl.clientHeight) || 0;
						const _baseX = 80;
						let _baseY = 80;
						for (const rr of canvasState.bulkRecords) {
							if (
								typeof rr.y === "number" &&
								rr.y + STEP_Y > _baseY
							) {
								_baseY = rr.y + STEP_Y;
							}
						}

						if (canvasState.bulkRecords.length === 0) {
							_baseY = _ch > 0 ? _ch / 2 : 400;
						}
						let _newDraftSlot = 0;
						function _placeNewDraft(objectName) {
							const siblings = canvasState.bulkRecords.filter(
								(r) => r.objectName === objectName,
							);
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
							const baseX =
								_cw > 0
									? Math.max(
											_baseX,
											_cw / 2 -
												((PER_ROW - 1) * STEP_X) / 2,
										)
									: _baseX;
							return {
								x: baseX + col * STEP_X,
								y: _baseY + row * STEP_Y,
							};
						}

						const tempIdToRuntimeId = new Map();

						const _addResultCount = results.filter(
							(r) =>
								r &&
								r.status === "applied" &&
								(r.kind === "new-draft" ||
									r.kind === "load-record"),
						).length;
						const _cap = canvasCapCheck(_addResultCount);
						if (_cap.blocked) {
							showBulkToast(_cap.reason, "error");
							return;
						}

						function _canonicalizeFields(objectName, fields) {
							if (!fields || typeof fields !== "object") {
								return {};
							}
							const describe =
								canvasState.describeCache[objectName];
							const fieldList =
								describe && Array.isArray(describe.fields)
									? describe.fields
									: null;
							if (!fieldList || fieldList.length === 0) {
								return Object.assign({}, fields);
							}
							const byLower = new Map();
							for (const f of fieldList) {
								if (f && typeof f.name === "string") {
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
							if (result.status !== "applied") {
								continue;
							}
							const rawFields =
								result.fields &&
								typeof result.fields === "object"
									? result.fields
									: {};
							if (result.kind === "new-draft") {
								try {
									let sel = canvasState.selectedObjects.find(
										(so) => so.name === result.objectName,
									);
									if (!sel) {
										sel = await addToSelection(
											result.objectName,
										);
									}
									if (!sel) {
										continue;
									}

									try {
										await ensureDescribe(sel.name);
									} catch (_) {

									}
									const fields = _canonicalizeFields(
										sel.name,
										rawFields,
									);
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
										tempIdToRuntimeId.set(
											result.tempId,
											runtimeId,
										);
									}
									touched = true;
								} catch (addErr) {
									console.warn(
										"[proposal-apply] could not add new-draft locally:",
										addErr,
									);
								}
							} else if (result.kind === "draft") {
								const tempId =
									result.tempId != null
										? result.tempId
										: result.targetId;
								const runtimeId = tempIdToRuntimeId.has(tempId)
									? tempIdToRuntimeId.get(tempId)
									: tempId;
								const rec = canvasState.bulkRecords.find(
									(r) =>
										r.id === runtimeId && !r.loadedFromId,
								);
								if (rec) {
									try {
										await ensureDescribe(rec.objectName);
									} catch (_) {

									}
									const fields = _canonicalizeFields(
										rec.objectName,
										rawFields,
									);
									rec.values = Object.assign(
										{},
										rec.values || {},
										fields,
									);
									touched = true;
								}
							} else if (result.kind === "record") {
								const recordId =
									result.recordId != null
										? result.recordId
										: result.targetId;
								const key =
									recordId == null ? null : String(recordId);
								if (key) {
									const rec = canvasState.bulkRecords.find(
										(r) => {
											const id =
												(r.values && r.values.Id) ||
												r.loadedFromId;
											return id && String(id) === key;
										},
									);
									if (rec) {
										try {
											await ensureDescribe(
												rec.objectName,
											);
										} catch (_) {

										}
										const fields = _canonicalizeFields(
											rec.objectName,
											rawFields,
										);
										rec.values = Object.assign(
											{},
											rec.values || {},
											fields,
										);
										touched = true;
									}
								}
							} else if (result.kind === "delete-draft") {
								const tempId =
									result.tempId != null
										? result.tempId
										: result.targetId;
								const before = canvasState.bulkRecords.length;
								canvasState.bulkRecords =
									canvasState.bulkRecords.filter(
										(r) =>
											!(
												r.id === tempId &&
												!r.loadedFromId
											),
									);

								canvasState.bulkAssociations =
									canvasState.bulkAssociations.filter(
										(a) =>
											a.fromId !== tempId &&
											a.toId !== tempId,
									);
								if (canvasState.bulkRecords.length !== before) {
									if (
										canvasState.bulkSelectedIds &&
										canvasState.bulkSelectedIds.delete
									) {
										canvasState.bulkSelectedIds.delete(
											tempId,
										);
									}
									touched = true;
								}
							} else if (result.kind === "delete-record") {
								const recordId =
									result.recordId != null
										? result.recordId
										: result.targetId;
								const key =
									recordId == null ? null : String(recordId);
								if (key) {
									const rec = canvasState.bulkRecords.find(
										(r) => {
											const id =
												(r.values && r.values.Id) ||
												r.loadedFromId;
											return id && String(id) === key;
										},
									);
									if (rec) {
										const runtimeId = rec.id;
										canvasState.bulkRecords =
											canvasState.bulkRecords.filter(
												(r) => r !== rec,
											);
										canvasState.bulkAssociations =
											canvasState.bulkAssociations.filter(
												(a) =>
													a.fromId !== runtimeId &&
													a.toId !== runtimeId,
											);
										if (
											canvasState.bulkSelectedIds &&
											canvasState.bulkSelectedIds.delete
										) {
											canvasState.bulkSelectedIds.delete(
												runtimeId,
											);
										}
										touched = true;
									}
								}
							} else if (result.kind === "autofill-required") {
								try {
									const requestedTempIds = Array.isArray(
										result.tempIds,
									)
										? result.tempIds
										: [];
									bulkAutoFill("required", "both", {
										tempIds: requestedTempIds,
										silent: true,
									});
									touched = true;
								} catch (autofillErr) {
									console.warn(
										"[proposal-apply] autofill failed:",
										autofillErr,
									);
								}
							} else if (result.kind === "load-record") {
								try {
									let sel = canvasState.selectedObjects.find(
										(so) => so.name === result.objectName,
									);
									if (!sel) {
										sel = await addToSelection(
											result.objectName,
										);
									}
									if (!sel) {
										continue;
									}
									const values =
										result.values &&
										typeof result.values === "object"
											? result.values
											: {};
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
									console.warn(
										"[proposal-apply] load-record failed:",
										loadErr,
									);
								}
							}
						}

						function _resolveAssocEndpoint(ep) {
							if (!ep || typeof ep !== "object") {
								return null;
							}
							if (ep.kind === "loaded") {
								const key = String(ep.ref);
								const rec = canvasState.bulkRecords.find(
									(r) => {
										const id =
											(r.values && r.values.Id) ||
											r.loadedFromId;
										return id && String(id) === key;
									},
								);
								return rec ? rec.id : null;
							}
							if (ep.kind === "draft") {
								if (tempIdToRuntimeId.has(ep.ref)) {
									return tempIdToRuntimeId.get(ep.ref);
								}
								const rec = canvasState.bulkRecords.find(
									(r) => r.id === ep.ref && !r.loadedFromId,
								);
								return rec ? rec.id : null;
							}
							return null;
						}
						for (const result of results) {
							if (result.status !== "applied") {
								continue;
							}
							if (result.kind === "new-association") {
								const fromId = _resolveAssocEndpoint(
									result.from,
								);
								const toId = _resolveAssocEndpoint(result.to);
								if (fromId == null || toId == null) {
									continue;
								}
								const fieldName = result.fieldName;
								const dup = canvasState.bulkAssociations.some(
									(a) =>
										a.fromId === fromId &&
										a.toId === toId &&
										a.fieldName === fieldName,
								);
								if (!dup) {
									canvasState.bulkAssociations.push({
										id: canvasState.bulkIdSeq++,
										fromId,
										toId,
										fieldName,
									});
									touched = true;
								}
							} else if (result.kind === "delete-association") {
								const fromId = _resolveAssocEndpoint(
									result.from,
								);
								const toId = _resolveAssocEndpoint(result.to);
								if (fromId == null || toId == null) {
									continue;
								}
								const fieldName = result.fieldName;
								const before =
									canvasState.bulkAssociations.length;
								canvasState.bulkAssociations =
									canvasState.bulkAssociations.filter(
										(a) =>
											!(
												a.fromId === fromId &&
												a.toId === toId &&
												a.fieldName === fieldName
											),
									);
								if (
									canvasState.bulkAssociations.length !==
									before
								) {
									touched = true;
								}
							}
						}
						if (touched) {
							try {
								renderBulkView();
							} catch (renderErr) {
								console.warn(
									"[proposal-apply] re-render failed:",
									renderErr,
								);
							}
						}
					}
				} catch (e) {
					showBulkToast(
						"Could not apply: " + (e.message || e),
						"error",
					);
				}
			}

			async function _rejectProposal(canvasId, proposalId, modal) {
				const ok = await showConfirmDialog({
					title: "Reject this proposal?",
					message:
						"The proposed changes will be discarded. Salesforce records will not be modified.",
					confirmLabel: "Reject",
					cancelLabel: "Cancel",
					danger: false,
				});
				if (!ok) {
					return;
				}
				try {
					const r = await csrfFetch(
						"/api/canvas/" +
							encodeURIComponent(canvasId) +
							"/proposals/" +
							encodeURIComponent(proposalId) +
							"/reject",
						{ method: "POST", credentials: "same-origin" },
					);
					if (!r.ok) {
						const body = await r.json().catch(() => ({}));
						showBulkToast(
							(body && body.error) ||
								"Could not reject (HTTP " + r.status + ").",
							"error",
						);
						return;
					}
					if (modal) {
						modal.remove();
					}
					_refreshProposals();
				} catch (e) {
					showBulkToast(
						"Could not reject: " + (e.message || e),
						"error",
					);
				}
			}

			return {
				getPollCanvasId: _proposalsPollCanvasId,
				openProposalsReview: _openProposalsReview,
				refreshProposals: _refreshProposals,
				watchProposalsForCurrentCanvas: _watchProposalsForCurrentCanvas,
			};
		},
	};
})();
