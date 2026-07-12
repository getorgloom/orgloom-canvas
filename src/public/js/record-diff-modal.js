(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.recordDiffModal = {
		mount: function mount(deps) {
			const required = [
				'canvasState', 'escapeHtml', 'computeRecordDiff', 'recordOrdinal',
				'renderBulkView', 'isRecordPendingDelete',
			];
			if (!deps) {
throw new Error('record-diff-modal.mount: missing deps object');
}
			for (const k of required) {
				if (deps[k] === undefined || deps[k] === null) {
					throw new Error('record-diff-modal.mount: missing dep ' + k);
				}
			}
			const canvasState = deps.canvasState;
			const escapeHtml = deps.escapeHtml;
			const computeRecordDiff = deps.computeRecordDiff;
			const recordOrdinal = deps.recordOrdinal;
			const renderBulkView = deps.renderBulkView;
			const isRecordPendingDelete = deps.isRecordPendingDelete;

			const pushUndo = typeof deps.pushUndo === 'function' ? deps.pushUndo : null;
			const showBulkToast = typeof deps.showBulkToast === 'function'
				? deps.showBulkToast : function () {};

			function _snapField(rec, fieldName) {
				const had = !!(rec.values && Object.prototype.hasOwnProperty.call(rec.values, fieldName));
				return { had: had, prev: had ? rec.values[fieldName] : undefined };
			}
			function _restoreField(rec, fieldName, snap) {
				if (!rec.values) {
					rec.values = {};
				}
				if (snap.had) {
					rec.values[fieldName] = snap.prev;
				} else {
					delete rec.values[fieldName];
				}
				rec._valuesRevision = (Number(rec._valuesRevision) || 0) + 1;
			}
			function _writeField(rec, fieldName, value) {
				rec.values[fieldName] = value;
				rec._valuesRevision = (Number(rec._valuesRevision) || 0) + 1;
			}
			function _fieldUndoIsCurrent(rec, revision, fieldName, expected) {
				return (Number(rec._valuesRevision) || 0) === revision &&
					rec.values && rec.values[fieldName] === expected;
			}

			function _pairKey(idA, idB) {
				const a = Number(idA), b = Number(idB);
				return (a < b ? a + '|' + b : b + '|' + a);
			}
			function _readSuppressedSet(idA, idB) {
				const store = canvasState.diffSuppressions || {};
				const arr = store[_pairKey(idA, idB)];
				return new Set(Array.isArray(arr) ? arr : []);
			}
			function _writeSuppressedSet(idA, idB, set) {
				if (!canvasState.diffSuppressions) {
canvasState.diffSuppressions = {};
}
				const key = _pairKey(idA, idB);
				if (set.size === 0) {
delete canvasState.diffSuppressions[key];
} else {
canvasState.diffSuppressions[key] = Array.from(set);
}
			}
			function _suppressField(idA, idB, fieldName) {
				const set = _readSuppressedSet(idA, idB);
				set.add(fieldName);
				_writeSuppressedSet(idA, idB, set);
			}
			function _unsuppressField(idA, idB, fieldName) {
				const set = _readSuppressedSet(idA, idB);
				set.delete(fieldName);
				_writeSuppressedSet(idA, idB, set);
			}

			function _titleFor(rec) {
				if (!rec) {
return '(missing record)';
}
				if (rec._inaccessible) {
return 'No access';
}
				if (rec.values) {
					const fn = rec.values.FirstName, ln = rec.values.LastName;
					if (fn != null || ln != null) {
						const composed = ((fn || '') + ' ' + (ln || '')).trim();
						if (composed) {
return composed;
}
					}
					const desc = canvasState.describeCache[rec.objectName];
					if (desc && Array.isArray(desc.fields)) {
						const nf = desc.fields.find((f) => f.nameField);
						if (nf && rec.values[nf.name]) {
return String(rec.values[nf.name]);
}
					}
					const generic = rec.values.Name || rec.values.CaseNumber
						|| rec.values.Subject || rec.values.Title;
					if (generic) {
return String(generic);
}
				}
				return rec.loadedFromId ? '(no title)' : '(no name yet)';
			}

			function _fieldLabel(objectName, fieldName) {
				const desc = objectName && canvasState.describeCache[objectName];
				if (desc && Array.isArray(desc.fields)) {
					const f = desc.fields.find((x) => x && x.name === fieldName);
					if (f && f.label) {
return f.label;
}
				}
				return fieldName;
			}

			function _fieldDef(objectName, fieldName) {
				const desc = objectName && canvasState.describeCache[objectName];
				if (!desc || !Array.isArray(desc.fields)) {
return null;
}
				return desc.fields.find((x) => x && x.name === fieldName) || null;
			}

			function _isFieldWritable(field, targetRec) {
				if (!field) {
return true;
}
				if (field.calculated || field.autoNumber) {
return false;
}
				if (targetRec && targetRec.loadedFromId) {
return field.updateable !== false;
}
				return field.createable !== false;
			}

			function _buildFkResolver() {
				const m = new Map();
				for (const r of canvasState.bulkRecords) {
					if (!r || !r.loadedFromId) {
continue;
}
					const key = String(r.loadedFromId).slice(0, 15);
					m.set(key, _titleFor(r));
				}
				return m;
			}

			function _renderTypedValue(v, fieldDef, fkResolver) {
				if (v == null || v === '') {
return '<span class="rdm-empty">—</span>';
}
				const type = fieldDef && fieldDef.type;

				if ((type === 'picklist' || type === 'combobox') && Array.isArray(fieldDef.picklistValues)) {
					const p = fieldDef.picklistValues.find((x) => x && x.value === v);
					if (p && p.label && p.label !== p.value) {
						return escapeHtml(p.label) + ' <code class="rdm-val-suffix">' + escapeHtml(String(v)) + '</code>';
					}
				}

				if (type === 'multipicklist' && Array.isArray(fieldDef.picklistValues)) {
					const parts = String(v).split(';').map((s) => s.trim()).filter(Boolean);
					const labels = parts.map((part) => {
						const p = fieldDef.picklistValues.find((x) => x && x.value === part);
						return (p && p.label) ? p.label : part;
					});
					return escapeHtml(labels.join(' · '));
				}

				if (type === 'reference' && fkResolver) {
					const key = String(v).slice(0, 15);
					const title = fkResolver.get(key);
					if (title) {
						return escapeHtml(title) + ' <code class="rdm-val-suffix">' + escapeHtml(String(v)) + '</code>';
					}
					return '<code>' + escapeHtml(String(v)) + '</code>';
				}

				if (type === 'boolean' || typeof v === 'boolean') {
					const b = v === true || v === 'true' || v === 1 || v === '1';
					return b ? '<span class="rdm-val-bool">Yes</span>' : '<span class="rdm-val-bool">No</span>';
				}

				if (type === 'date' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
					const t = Date.parse(v);
					if (!isNaN(t)) {
						const d = new Date(t);
						return escapeHtml(d.toLocaleDateString());
					}
				}
				if (type === 'datetime' && typeof v === 'string') {
					const t = Date.parse(v);
					if (!isNaN(t)) {
						const d = new Date(t);
						return escapeHtml(d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
					}
				}

				if (typeof v === 'string') {
return escapeHtml(v);
}
				if (typeof v === 'number') {
return escapeHtml(String(v));
}
				try {
 return '<code>' + escapeHtml(JSON.stringify(v)) + '</code>'; 
} catch (_) {
 return '<code>(unserializable)</code>'; 
}
			}

			function _renderRow(fieldName, recA, recB, variant, ctx) {
				const objectName = recA.objectName || recB.objectName;
				const label = _fieldLabel(objectName, fieldName);
				const a = (recA && recA.values) ? recA.values[fieldName] : undefined;
				const b = (recB && recB.values) ? recB.values[fieldName] : undefined;
				const isResolvable = variant === 'diff' || variant === 'a-only' || variant === 'b-only';
				const isSuppressed = variant === 'suppressed';

				const fieldDefForA = ctx.fieldDefForA(fieldName);
				const fieldDefForB = ctx.fieldDefForB(fieldName);
				const aIsWritable = _isFieldWritable(fieldDefForA, recA);
				const bIsWritable = _isFieldWritable(fieldDefForB, recB);
				const readOnlyReason = (def) => {
					if (!def) {
return '';
}
					if (def.calculated) {
return 'formula';
}
					if (def.autoNumber) {
return 'auto-number';
}
					return 'read-only';
				};

				let leftBtn = '';
				if (variant === 'diff' || variant === 'b-only') {
					if (!ctx.aIsTargetable) {
						leftBtn = '<button type="button" class="rdm-copy-btn rdm-copy-btn-left" disabled aria-disabled="true" title="A is marked for delete, so copy is disabled">◀</button>';
					} else if (!aIsWritable) {
						leftBtn = '<button type="button" class="rdm-copy-btn rdm-copy-btn-left" disabled aria-disabled="true" title="Field is ' + readOnlyReason(fieldDefForA) + ' on A, so Salesforce won’t accept the write">◀</button>';
					} else {
						leftBtn = '<button type="button" class="rdm-copy-btn rdm-copy-btn-left" data-rdm-copy="b-to-a" data-rdm-field="' + escapeHtml(fieldName) + '" title="Copy B’s value to A">◀</button>';
					}
				}
				let rightBtn = '';

				if (!ctx.incoming && (variant === 'diff' || variant === 'a-only')) {
					if (!ctx.bIsTargetable) {
						rightBtn = '<button type="button" class="rdm-copy-btn rdm-copy-btn-right" disabled aria-disabled="true" title="B is marked for delete, so copy is disabled">▶</button>';
					} else if (!bIsWritable) {
						rightBtn = '<button type="button" class="rdm-copy-btn rdm-copy-btn-right" disabled aria-disabled="true" title="Field is ' + readOnlyReason(fieldDefForB) + ' on B, so Salesforce won’t accept the write">▶</button>';
					} else {
						rightBtn = '<button type="button" class="rdm-copy-btn rdm-copy-btn-right" data-rdm-copy="a-to-b" data-rdm-field="' + escapeHtml(fieldName) + '" title="Copy A’s value to B">▶</button>';
					}
				}
				const midActionsContent = (leftBtn || rightBtn)
					? '<div class="rdm-mid-actions">' + leftBtn + rightBtn + '</div>'
					: '<div class="rdm-mid-actions rdm-mid-actions-empty"></div>';

				const rowAction = ctx.incoming
					? ''
					: (isResolvable
						? '<button type="button" class="rdm-ignore-btn" data-rdm-ignore data-rdm-field="' + escapeHtml(fieldName) + '" title="Ignore this field: stop flagging it as a difference for this pair">⊘</button>'
						: (isSuppressed
							? '<button type="button" class="rdm-restore-btn" data-rdm-restore data-rdm-field="' + escapeHtml(fieldName) + '" title="Restore: flag this field as a difference again">↶</button>'
							: ''));
				const rowActionsContent = rowAction
					? '<div class="rdm-row-actions">' + rowAction + '</div>'
					: '<div class="rdm-row-actions rdm-row-actions-empty"></div>';

				let readOnlyBadge = '';
				if (isResolvable && (!aIsWritable || !bIsWritable)) {
					const tag = (!aIsWritable && !bIsWritable)
						? 'read-only'
						: (!aIsWritable ? 'read-only on A' : 'read-only on B');
					readOnlyBadge = '<span class="rdm-readonly-badge" title="Salesforce won’t accept writes to this field on the marked side(s)">' + escapeHtml(tag) + '</span>';
				}

				const searchKey = (label + ' ' + fieldName).toLowerCase();

				return (
					'<div class="rdm-row rdm-row-' + variant + '" data-rdm-row-field="' + escapeHtml(fieldName) + '" data-rdm-search-key="' + escapeHtml(searchKey) + '">' +
						'<div class="rdm-field">' +
							'<div class="rdm-field-text">' +
								'<div class="rdm-field-label">' + escapeHtml(label) + readOnlyBadge + '</div>' +
								'<div class="rdm-field-name"><code>' + escapeHtml(fieldName) + '</code></div>' +
							'</div>' +
						'</div>' +
						'<div class="rdm-value rdm-value-a">' +
							'<div class="rdm-value-inner">' + _renderTypedValue(a, fieldDefForA, ctx.fkResolver) + '</div>' +
						'</div>' +
						midActionsContent +
						'<div class="rdm-value rdm-value-b">' +
							'<div class="rdm-value-inner">' + _renderTypedValue(b, fieldDefForB, ctx.fkResolver) + '</div>' +
						'</div>' +
						rowActionsContent +
					'</div>'
				);
			}

			function _renderBody(content, recA, recB) {
				const scroll = content ? content.scrollTop : 0;

				const overlay = content && content.closest('.record-diff-modal');
				const incoming = !!(overlay && overlay.dataset.rdmIncoming === '1');
				const labelB = (overlay && overlay.dataset.rdmLabelB) || 'Imported';
				const existingSearch = overlay && overlay.querySelector('.rdm-search');
				const searchQuery = existingSearch ? existingSearch.value : '';
				const diff = computeRecordDiff(recA, recB);
				const titleA = _titleFor(recA);
				const titleB = _titleFor(recB);
				const subtitleA = (recA.label || recA.objectName) + ' #' + recordOrdinal(recA);

				const subtitleB = incoming
					? labelB
					: (recB.label || recB.objectName) + ' #' + recordOrdinal(recB);

				const fkResolver = _buildFkResolver();
				const fieldDefForA = (name) => _fieldDef(recA.objectName, name);
				const fieldDefForB = (name) => _fieldDef(recB.objectName, name);

				const suppressedSet = _readSuppressedSet(recA.id, recB.id);
				function _partitionBySuppressed(arr) {
					const kept = [];
					const suppressed = [];
					for (const f of arr) {
						if (suppressedSet.has(f)) {
suppressed.push(f);
} else {
kept.push(f);
}
					}
					return { kept, suppressed };
				}
				const _pDiff = _partitionBySuppressed(diff.differing);
				const _pAOnly = _partitionBySuppressed(diff.aOnly);
				const _pBOnly = _partitionBySuppressed(diff.bOnly);
				const differing = _pDiff.kept;

				const aOnly = incoming ? [] : _pAOnly.kept;
				const bOnly = _pBOnly.kept;

				const suppressed = _pDiff.suppressed
					.concat(_pAOnly.suppressed)
					.concat(_pBOnly.suppressed);
				const diffCount = differing.length;
				const aOnlyCount = aOnly.length;
				const bOnlyCount = bOnly.length;
				const sharedCount = diff.shared.length;
				const suppressedCount = suppressed.length;

				const aIsTargetable = !isRecordPendingDelete(recA) && !recA._inaccessible;
				const bIsTargetable = !isRecordPendingDelete(recB) && !recB._inaccessible;

				const rowCtx = {
					fieldDefForA,
					fieldDefForB,
					fkResolver,
					aIsTargetable,
					bIsTargetable,
					incoming,
				};

				const crossObjectBanner = !diff.sameObject
					? '<div class="rdm-banner">' +
							'<strong>Different object types.</strong> ' +
							'Field-level diff assumes the same object. ' +
							escapeHtml(diff.objectA || '?') + ' vs ' +
							escapeHtml(diff.objectB || '?') +
							'; comparison shows shared field names but values may not be semantically comparable.' +
						'</div>'
					: '';

				const pendingDeleteBanner = (!aIsTargetable || !bIsTargetable)
					? '<div class="rdm-banner rdm-banner-warn">' +
							'<strong>' +
							(!aIsTargetable && !bIsTargetable ? 'Both records are' : (!aIsTargetable ? 'Record A is' : 'Record B is')) +
							' marked for delete.</strong> ' +
							'Copy actions are disabled, since value edits would be discarded when the upload commits the DELETE.' +
						'</div>'
					: '';

				const filterChips =
					'<div class="rdm-filter-chips">' +
						'<button type="button" class="rdm-filter-chip" data-rdm-filter="diffs">' +
							'Only differences ' +
							'<span class="rdm-chip-count">' + (diffCount + aOnlyCount + bOnlyCount) + '</span>' +
						'</button>' +
						'<button type="button" class="rdm-filter-chip" data-rdm-filter="all">' +
							'All ' +
							'<span class="rdm-chip-count">' + (diffCount + aOnlyCount + bOnlyCount + sharedCount + suppressedCount) + '</span>' +
						'</button>' +
						(aOnlyCount + bOnlyCount > 0
							? '<button type="button" class="rdm-filter-chip" data-rdm-filter="gaps">' +
								'Gaps only ' +
								'<span class="rdm-chip-count">' + (aOnlyCount + bOnlyCount) + '</span>' +
								'</button>'
							: '') +
						(suppressedCount > 0
							? '<button type="button" class="rdm-filter-chip" data-rdm-filter="suppressed">' +
								'Ignored ' +
								'<span class="rdm-chip-count">' + suppressedCount + '</span>' +
								'</button>'
							: '') +
					'</div>';

				const _isWritableTo = (fieldName, targetRec, getFieldDef) =>
					_isFieldWritable(getFieldDef(fieldName), targetRec);
				const aToBCount =
					differing.filter((f) => _isWritableTo(f, recB, fieldDefForB)).length +
					aOnly.filter((f) => _isWritableTo(f, recB, fieldDefForB)).length;
				const bToACount =
					differing.filter((f) => _isWritableTo(f, recA, fieldDefForA)).length +
					bOnly.filter((f) => _isWritableTo(f, recA, fieldDefForA)).length;

				const hasAnyBulk = incoming ? (bToACount > 0) : (aToBCount > 0 || bToACount > 0);
				const aToBDisabled = aToBCount === 0 || !bIsTargetable;
				const bToADisabled = bToACount === 0 || !aIsTargetable;
				const aToBTitle = !bIsTargetable
					? 'B is marked for delete, so bulk copy is disabled'
					: (aToBCount === 0
						? 'No fields to copy from A → B'
						: 'Push A’s values into B for ' + aToBCount + ' field' + (aToBCount === 1 ? '' : 's') + ' (overwrites where they differ, fills where B is empty)');
				const bToATitle = !aIsTargetable
					? 'A is marked for delete, so bulk copy is disabled'
					: (bToACount === 0
						? 'No fields to copy from B → A'
						: 'Push B’s values into A for ' + bToACount + ' field' + (bToACount === 1 ? '' : 's') + ' (overwrites where they differ, fills where A is empty)');
				const bulkActions = hasAnyBulk
					? '<div class="rdm-bulk-actions">' +
							'<span class="rdm-bulk-label">' + (incoming ? 'Apply all imported:' : 'Apply all:') + '</span>' +
							(incoming ? '' :
								'<button type="button" class="rdm-bulk-btn" data-rdm-bulk="a-to-b"' + (aToBDisabled ? ' disabled aria-disabled="true"' : '') + ' title="' + escapeHtml(aToBTitle) + '">' +
									'A → B ' +
									'<span class="rdm-bulk-count">' + aToBCount + '</span>' +
								'</button>') +
							'<button type="button" class="rdm-bulk-btn" data-rdm-bulk="b-to-a"' + (bToADisabled ? ' disabled aria-disabled="true"' : '') + ' title="' + escapeHtml(bToATitle) + '">' +
								(incoming ? 'Apply ' : 'B → A ') +
								'<span class="rdm-bulk-count">' + bToACount + '</span>' +
							'</button>' +
						'</div>'
					: '';

				const rowsHtml =
					differing.map((f) => _renderRow(f, recA, recB, 'diff', rowCtx)).join('') +
					aOnly.map((f) => _renderRow(f, recA, recB, 'a-only', rowCtx)).join('') +
					bOnly.map((f) => _renderRow(f, recA, recB, 'b-only', rowCtx)).join('') +
					suppressed.map((f) => _renderRow(f, recA, recB, 'suppressed', rowCtx)).join('') +
					diff.shared.map((f) => _renderRow(f, recA, recB, 'shared', rowCtx)).join('');

				const totalRows = diffCount + aOnlyCount + bOnlyCount + suppressedCount + sharedCount;
				const emptyState = totalRows === 0
					? '<p class="rdm-empty-state">No fields with values on either record. There’s nothing to diff yet.</p>'
					: (diffCount + aOnlyCount + bOnlyCount === 0
						? (suppressedCount > 0
							? '<p class="rdm-empty-state">These records agree on every field that isn’t ignored. ' + suppressedCount + ' field' + (suppressedCount === 1 ? '' : 's') + ' marked as intentionally different.</p>'
							: '<p class="rdm-empty-state">These records are identical on every field they share.</p>')
						: '');

				const countsBreakdownParts = [];
				countsBreakdownParts.push('<span class="rdm-count rdm-count-diff">' + diffCount + '</span> differ');
				if (aOnlyCount > 0) {
countsBreakdownParts.push('<span class="rdm-count rdm-count-a-only">' + aOnlyCount + '</span> A-only');
}
				if (bOnlyCount > 0) {
countsBreakdownParts.push('<span class="rdm-count rdm-count-b-only">' + bOnlyCount + '</span> B-only');
}
				if (suppressedCount > 0) {
countsBreakdownParts.push('<span class="rdm-count rdm-count-suppressed">' + suppressedCount + '</span> ignored');
}
				const countsBreakdown = countsBreakdownParts.join(' · ');

				const tableHead =
					'<div class="rdm-table-head">' +
						'<div class="rdm-th rdm-th-field">' +
							'<div class="rdm-th-title">Field</div>' +
							'<div class="rdm-th-counts">' + countsBreakdown + '</div>' +
						'</div>' +
						'<div class="rdm-th rdm-th-a">' +
							'<div class="rdm-th-title"><span class="rdm-th-prefix">A:</span> ' + escapeHtml(titleA) + '</div>' +
							'<div class="rdm-th-sub">' + escapeHtml(subtitleA) + '</div>' +
						'</div>' +
						'<div class="rdm-th rdm-th-mid"></div>' +
						'<div class="rdm-th rdm-th-b">' +
							'<div class="rdm-th-title"><span class="rdm-th-prefix">B:</span> ' + escapeHtml(titleB) + '</div>' +
							'<div class="rdm-th-sub">' + escapeHtml(subtitleB) + '</div>' +
						'</div>' +
						'<div class="rdm-th rdm-th-row-actions"></div>' +
					'</div>';

				const incomingBanner = incoming
					? '<div class="rdm-banner">' +
							'<strong>This imported row matches a record already on the canvas.</strong> ' +
							'The B column is the imported CSV values; the A column is the record on the canvas. ' +
							'Use ◀ (or &ldquo;Apply all imported&rdquo;) to copy values onto the canvas record, then close. ' +
							'Closing without copying keeps the canvas record unchanged.' +
						'</div>'
					: '';
				content.innerHTML =
					incomingBanner +
					crossObjectBanner +
					pendingDeleteBanner +
					'<div class="rdm-toolbar">' +
						filterChips +
						'<input type="search" class="rdm-search" placeholder="Search fields…" autocomplete="off" spellcheck="false" value="' + escapeHtml(searchQuery || '') + '">' +
					'</div>' +
					bulkActions +
					(emptyState
						? emptyState
						: tableHead + '<div class="rdm-rows">' + rowsHtml + '</div>') +
					'<p class="rdm-search-empty" style="display:none">No fields match your search.</p>';

				if (content) {
content.scrollTop = scroll;
}
			}

			function _applyCopy(side, fieldName, recA, recB, content) {
				const source = side === 'a-to-b' ? recA : recB;
				const target = side === 'a-to-b' ? recB : recA;
				if (!source || !target) {
return;
}
				if (isRecordPendingDelete(target) || target._inaccessible) {
return;
}
				if (!target.values) {
target.values = {};
}

				const _snap = pushUndo ? _snapField(target, fieldName) : null;

				const newValue = source.values ? source.values[fieldName] : undefined;
				_writeField(target, fieldName, newValue == null ? '' : newValue);
				if (pushUndo && _snap) {
					const _tgt = target, _fn = fieldName, _s = _snap;
					const _expectedRevision = Number(target._valuesRevision) || 0;
					const _expectedValue = target.values[fieldName];
					pushUndo('Undo diff copy', () => {
						if (!_fieldUndoIsCurrent(_tgt, _expectedRevision, _fn, _expectedValue)) {
							showBulkToast('Can’t undo the diff copy because the target record was edited afterward.', 'info');
							return;
						}
						_restoreField(_tgt, _fn, _s);
						renderBulkView();
						showBulkToast('Reverted the copied field.');
					});
				}
				try {
 renderBulkView();
} catch (e) {
 console.warn('[diff] renderBulkView after copy failed:', e);
}
				_renderBody(content, recA, recB);
				_wireBodyHandlers(content, recA, recB);
			}

			function _applyBulkCopy(direction, recA, recB, content) {
				const source = direction === 'a-to-b' ? recA : recB;
				const target = direction === 'a-to-b' ? recB : recA;
				if (!source || !target) {
return;
}
				if (isRecordPendingDelete(target) || target._inaccessible) {
return;
}
				const diff = computeRecordDiff(recA, recB);
				const suppressedSet = _readSuppressedSet(recA.id, recB.id);

				const eligible = [];
				const getTargetFieldDef = (name) => _fieldDef(target.objectName, name);
				for (const f of diff.differing) {
					if (suppressedSet.has(f)) {
continue;
}
					if (!_isFieldWritable(getTargetFieldDef(f), target)) {
continue;
}
					eligible.push(f);
				}
				for (const f of (direction === 'a-to-b' ? diff.aOnly : diff.bOnly)) {
					if (suppressedSet.has(f)) {
continue;
}
					if (!_isFieldWritable(getTargetFieldDef(f), target)) {
continue;
}
					eligible.push(f);
				}
				if (eligible.length === 0) {
return;
}
				if (!target.values) {
target.values = {};
}

				const _snaps = pushUndo ? eligible.map((f) => ({ f: f, snap: _snapField(target, f) })) : null;
				for (const f of eligible) {
					const v = source.values ? source.values[f] : undefined;
					_writeField(target, f, v == null ? '' : v);
				}
				if (pushUndo && _snaps) {
					const _tgt = target, _all = _snaps, _n = eligible.length;
					const _expectedRevision = Number(target._valuesRevision) || 0;
					const _expectedValues = new Map(eligible.map((f) => [f, target.values[f]]));
					pushUndo('Undo diff apply-all', () => {
						const stale = (Number(_tgt._valuesRevision) || 0) !== _expectedRevision ||
							eligible.some((f) => !_tgt.values || _tgt.values[f] !== _expectedValues.get(f));
						if (stale) {
							showBulkToast('Can’t undo the diff copy because the target record was edited afterward.', 'info');
							return;
						}
						_all.forEach((e) => _restoreField(_tgt, e.f, e.snap));
						renderBulkView();
						showBulkToast('Reverted ' + _n + ' copied field' + (_n === 1 ? '' : 's') + '.');
					});
				}
				try {
 renderBulkView();
} catch (e) {
 console.warn('[diff] renderBulkView after bulk copy failed:', e);
}
				_renderBody(content, recA, recB);
				_wireBodyHandlers(content, recA, recB);
			}

			function _applyIgnore(fieldName, recA, recB, content) {
				_suppressField(recA.id, recB.id, fieldName);
				_renderBody(content, recA, recB);
				_wireBodyHandlers(content, recA, recB);
			}
			function _applyRestore(fieldName, recA, recB, content) {
				_unsuppressField(recA.id, recB.id, fieldName);
				_renderBody(content, recA, recB);
				_wireBodyHandlers(content, recA, recB);
			}

			function _applySearchFilter(content, query) {
				const q = String(query || '').trim().toLowerCase();
				const rowsContainer = content.querySelector('.rdm-rows');
				const emptyMsg = content.querySelector('.rdm-search-empty');
				let anyVisible = false;
				content.querySelectorAll('.rdm-row').forEach((row) => {
					if (!q) {
						row.classList.remove('rdm-row-hidden-by-search');
						anyVisible = true;
						return;
					}
					const key = row.dataset.rdmSearchKey || '';
					if (key.indexOf(q) !== -1) {
						row.classList.remove('rdm-row-hidden-by-search');
						anyVisible = true;
					} else {
						row.classList.add('rdm-row-hidden-by-search');
					}
				});

				if (emptyMsg && rowsContainer) {
					if (!q || anyVisible) {
						emptyMsg.style.display = 'none';
						rowsContainer.style.display = '';
					} else {
						emptyMsg.style.display = '';
						rowsContainer.style.display = 'none';
					}
				}
			}

			function _wireBodyHandlers(content, recA, recB) {
				const overlay = content.closest('.record-diff-modal');
				if (!overlay) {
return;
}
				const activeFilter = overlay.dataset.rdmFilter || 'diffs';
				content.querySelectorAll('[data-rdm-filter]').forEach((btn) => {
					btn.classList.toggle('is-active', btn.dataset.rdmFilter === activeFilter);
					btn.addEventListener('click', () => {
						overlay.dataset.rdmFilter = btn.dataset.rdmFilter;
						content.querySelectorAll('.rdm-filter-chip').forEach((c) => {
							c.classList.toggle('is-active', c.dataset.rdmFilter === btn.dataset.rdmFilter);
						});
					});
				});
				content.querySelectorAll('[data-rdm-copy]').forEach((btn) => {
					if (btn.disabled) {
return;
}
					btn.addEventListener('click', () => {
						const side = btn.dataset.rdmCopy;
						const fieldName = btn.dataset.rdmField;
						if (!side || !fieldName) {
return;
}
						_applyCopy(side, fieldName, recA, recB, content);
					});
				});
				content.querySelectorAll('[data-rdm-ignore]').forEach((btn) => {
					btn.addEventListener('click', () => {
						const fieldName = btn.dataset.rdmField;
						if (!fieldName) {
return;
}
						_applyIgnore(fieldName, recA, recB, content);
					});
				});
				content.querySelectorAll('[data-rdm-restore]').forEach((btn) => {
					btn.addEventListener('click', () => {
						const fieldName = btn.dataset.rdmField;
						if (!fieldName) {
return;
}
						_applyRestore(fieldName, recA, recB, content);
					});
				});
				content.querySelectorAll('[data-rdm-bulk]').forEach((btn) => {
					if (btn.disabled) {
return;
}
					btn.addEventListener('click', () => {
						const direction = btn.dataset.rdmBulk;
						if (!direction) {
return;
}
						_applyBulkCopy(direction, recA, recB, content);
					});
				});

				const searchInput = content.querySelector('.rdm-search');
				if (searchInput) {
					searchInput.addEventListener('input', () => {
						_applySearchFilter(content, searchInput.value);
					});
					_applySearchFilter(content, searchInput.value);
				}
			}

			function openRecordDiffModal(recA, recB, opts) {
				if (!recA || !recB) {
return;
}
				opts = opts || {};
				const incoming = !!opts.incoming;
				document.querySelectorAll('.record-diff-modal').forEach((el) => el.remove());
				const overlay = document.createElement('div');
				overlay.className = 'modal record-diff-modal';
				overlay.dataset.rdmFilter = 'diffs';

				if (incoming) {
					overlay.dataset.rdmIncoming = '1';
					overlay.dataset.rdmLabelB = opts.labelB || 'Imported';
				}
				const heading = incoming ? 'Review imported changes' : 'Diff records';
				overlay.innerHTML =
					'<div class="modal-overlay" data-rdm-close></div>' +
					'<div class="modal-body" style="max-width:960px">' +
						'<div class="modal-header">' +
							'<h3>' + escapeHtml(heading) + '</h3>' +
							'<button class="modal-close" data-rdm-close>&times;</button>' +
						'</div>' +
						'<div class="modal-content rdm-content"></div>' +
					'</div>';
				document.body.appendChild(overlay);
				const content = overlay.querySelector('.rdm-content');

				let closed = false;
				const onEsc = (e) => {
 if (e.key === 'Escape') {
cleanup();
}
};
				const cleanup = () => {
					if (closed) {
return;
}
					closed = true;
					document.removeEventListener('keydown', onEsc, true);
					if (overlay.parentNode) {
overlay.remove();
}
					if (typeof opts.onClose === 'function') {
						try {
 opts.onClose();
} catch (e) {
 console.warn('[diff] onClose failed:', e);
}
					}
				};
				document.addEventListener('keydown', onEsc, true);
				overlay.querySelectorAll('[data-rdm-close]').forEach((el) =>
					el.addEventListener('click', cleanup),
				);

				_renderBody(content, recA, recB);
				_wireBodyHandlers(content, recA, recB);
			}

			return {
				openRecordDiffModal: openRecordDiffModal,
			};
		},
	};
})();
