import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../src/public/js/upload-modal.js'), 'utf8');
const historySource = fs.readFileSync(path.resolve(here, '../src/public/js/upload-history.js'), 'utf8');
const appSource = fs.readFileSync(path.resolve(here, '../src/public/js/app.js'), 'utf8');
const routesSource = fs.readFileSync(path.resolve(here, '../src/canvas-routes.js'), 'utf8');
const batchStoreSource = fs.readFileSync(path.resolve(here, '../src/storage/upload-batches-store.js'), 'utf8');
const context = { window: { OrgLoom: {} } };
vm.runInNewContext(source, context);
const uploadModal = context.window.OrgLoom.uploadModal;

test('post-upload record opening pans to the card without changing zoom or blocking the editor', () => {
	const mountStart = appSource.indexOf('window.OrgLoom.uploadModal.mount({');
	const start = appSource.indexOf('openRecordForCurrentUser: function (record, options)', mountStart);
	const end = appSource.indexOf('canvasState: canvasState', start);
	assert.ok(mountStart >= 0 && start > mountStart && end > start);
	const record = { id: 'draft-contact' };
	const node = { length: 1 };
	const animations = [];
	const opened = [];
	const state = {
		_cyInstance: {
			getElementById: (id) => {
				assert.equal(id, 'rdraft-contact');
				return node;
			},
			animate: (options) => animations.push(options),
		},
		openRecordForCurrentUser: (value) => {
			opened.push(value);
			return true;
		},
	};
	const deps = vm.runInNewContext('({' + appSource.slice(start, end) + '})', state);
	assert.equal(deps.openRecordForCurrentUser(record), true);
	assert.equal(animations[0].center.eles, node);
	assert.equal(animations[0].duration, 380);
	assert.equal(animations[0].zoom, undefined);
	node.length = 0;
	deps.openRecordForCurrentUser(record);
	assert.equal(animations.length, 1);
	node.length = 1;
	state._cyInstance.animate = () => {
		throw new Error('Animation unavailable');
	};
	deps.openRecordForCurrentUser(record);
	state._cyInstance = null;
	deps.openRecordForCurrentUser(record);
	assert.deepEqual(opened, [record, record, record, record]);
});

function renderResults(results, deletes = []) {
	const content = { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] };
	const confirm = {};
	const cancel = { style: {} };
	const summary = { hidden: true, textContent: '' };
	const title = { textContent: '' };
	const noop = () => {};
	const state = {
		window: {},
		_fixTasks: null,
		deps: { openRecordForCurrentUser: noop },
		_uploadAttemptId: 'attempt',
		_allowDuplicates: false,
		_baselineConfirmations: [],
		_accessExcludedTempIds: new Set(),
		canvasState: {
			bulkRecords: [...results, ...deletes].map((result) => ({
				id: result.tempId,
				objectName: result.objectName,
			})),
			bulkAssociations: [],
			bulkSelectedIds: new Set(),
			describeCache: {},
		},
		uploadModal: {
			classList: { toggle: noop },
			querySelector: (selector) =>
				({
					'#upload-modal-content': content,
					'#upload-confirm': confirm,
					'#upload-cancel': cancel,
					'#upload-result-summary': summary,
					'#upload-modal-title': title,
				})[selector],
		},
		isRolledBackUploadResult: uploadModal.isRolledBackUploadResult,
		uploadResultIdentity: uploadModal.uploadResultIdentity,
		recordOrdinal: () => 1,
		uploadResultIdentityHtml: (result) => result.objectName + ' ' + result.tempId,
		escapeHtml: (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
		markCanvasGuideUploadComplete: noop,
		bindUploadResultCards: noop,
		reconcileSyncedRecords: noop,
		_clearSubmittedEncryptedValues: noop,
		_clearCommittedMigrationMatch: noop,
		renderBulkView: noop,
		publishPresenceChanges: noop,
		flushAutosave: noop,
		closeUploadModal: noop,
		confirmUpload: noop,
	};
	const start = source.indexOf('function displayUploadResults(');
	const end = source.indexOf('\n\t\t\treturn {', start);
	const groupsStart = source.indexOf('function uploadIssueGroupsHtml(');
	const groupsEnd = source.indexOf('function renderBlockingUploadIssues(', groupsStart);
	const attrsStart = source.indexOf('function uploadResultEditAttributes(');
	const attrsEnd = source.indexOf('function bindUploadResultCards(', attrsStart);
	vm.runInNewContext(source.slice(attrsStart, attrsEnd), state);
	vm.runInNewContext(source.slice(groupsStart, groupsEnd), state);
	vm.runInNewContext(source.slice(start, end), state);
	state.displayUploadResults(results, 'https://example.my.salesforce.com', deletes);
	return { html: content.innerHTML, confirm, cancel, summary, state };
}

test('graph attempts use results for zero, partial, and complete success while preserving safe fallback', () => {
	const start = source.indexOf('const allResults = (body && body.results) || [];');
	const end = source.indexOf('\n\t\t\t\t\t} catch (err)', start);
	assert.ok(start >= 0 && end > start);
	const failed = { tempId: 'contact', objectName: 'Contact', success: false, error: 'Required value missing' };
	const succeeded = { tempId: 'account', objectName: 'Account', success: true, mode: 'insert' };
	for (const body of [
		{ results: [failed] },
		{ results: [failed, succeeded] },
		{ results: [succeeded], atomicSuccess: true },
		{ results: [failed], retryWithoutGraph: true },
		{ results: [failed, succeeded], retryWithoutGraph: true },
	]) {
		const calls = [];
		const state = {
			body,
			window: {},
			payload: {},
			submittedSnapshots: new Map(),
			displayUploadResults: (...args) => calls.push(args),
		};
		vm.runInNewContext('(function () {' + source.slice(start, end) + '})()', state);
		const fallback = body.retryWithoutGraph === true && !body.results.some((result) => result.success);
		assert.equal(typeof state.payload.attemptId === 'string', fallback);
		assert.equal(calls.length, fallback ? 0 : 1);
		if (!fallback) {
			assert.equal(calls[0][0], body.results);
			assert.equal(calls[0][4], state.submittedSnapshots);
		}
	}
	const rendered = renderResults([failed]);
	assert.equal(rendered.summary.hidden, true);
	assert.equal(rendered.summary.textContent, '');
	assert.match(rendered.html, /<details class="upload-result-details" open><summary>Failed \(1\)<\/summary>/);
	assert.equal(rendered.confirm.textContent, 'Retry failed');
	assert.match(rendered.html, /Required value missing/);
	assert.equal(rendered.state._uploadAttemptId, null);
});

test('rollback grouping does not hide unrelated transaction errors', () => {
	assert.equal(uploadModal.isRolledBackUploadResult({ errorCode: 'ALL_OR_NONE_OPERATION_ROLLED_BACK' }), true);
	assert.equal(
		uploadModal.isRolledBackUploadResult({
			error: 'The transaction was rolled back since another operation in the same transaction failed.',
		}),
		true,
	);
	assert.equal(
		uploadModal.isRolledBackUploadResult({ errorCode: 'PROCESSING_HALTED', error: 'Invalid reference specified' }),
		false,
	);
	assert.equal(uploadModal.isRolledBackUploadResult({ error: 'AssistantPhone cannot be null' }), false);
});

test('failed-record links use the access-aware editor and reject unavailable canvas records', () => {
	const record = { id: 'draft-contact', objectName: 'Contact', values: { LastName: '<Test>' } };
	const button = {
		dataset: { uploadEditRecord: record.id },
		contains: () => true,
		addEventListener: (event, handler) => {
			button[event] = handler;
		},
	};
	const opened = [];
	const closed = [];
	const warnings = [];
	const state = {
		window: {},
		_fixTasks: null,
		canvasState: { bulkRecords: [record], describeCache: {} },
		deps: { openRecordForCurrentUser: (value) => opened.push(value) },
		content: { querySelectorAll: () => [button] },
		closeUploadModal: () => closed.push(true),
		showBulkToast: (message) => warnings.push(message),
		uploadResultIdentity: uploadModal.uploadResultIdentity,
		recordOrdinal: () => 1,
		escapeHtml: (value) => String(value).replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
	};
	const identityStart = source.indexOf('function uploadResultIdentityHtml(');
	const identityEnd = source.indexOf('function _clearCommittedMigrationMatch(', identityStart);
	vm.runInNewContext(source.slice(identityStart, identityEnd), state);
	const result = { tempId: record.id, objectName: 'Contact' };
	const html = state.uploadResultIdentityHtml(result, null, null, null, true);
	assert.match(
		state.uploadResultEditAttributes(result),
		/role="button" tabindex="0" data-upload-edit-record="draft-contact"/,
	);
	assert.doesNotMatch(html, /<Test>/);
	assert.doesNotMatch(html, /Canvas card/);
	assert.doesNotMatch(state.uploadResultIdentityHtml(result), /data-upload-edit-record/);
	const bindingStart = source.indexOf('function bindUploadResultCards(');
	const bindingEnd = source.indexOf('function resetSampleFailureActions(', bindingStart);
	vm.runInNewContext(source.slice(bindingStart, bindingEnd), state);
	state.bindUploadResultCards(state.content);
	button.click();
	assert.deepEqual(opened, [record]);
	assert.equal(closed.length, 1);
	const tasksStarted = [];
	state._fixTasks = { start: (...args) => tasksStarted.push(args) };
	button.dataset.uploadFix = 'true';
	button.dataset.uploadFocusField = 'LastName';
	button.click();
	assert.deepEqual(tasksStarted, [[record.id, 'LastName']]);
	assert.equal(opened.length, 1, 'Fix delegates opening to the sidebar');
	delete button.dataset.uploadFix;
	state.window.getSelection = () => ({ isCollapsed: false, anchorNode: {} });
	button.click();
	assert.equal(opened.length, 1, 'selecting error text must not open the editor');
	let prevented = 0;
	for (const key of ['Enter', ' ']) {
		button.keydown({
			key,
			target: button,
			preventDefault: () => {
				prevented++;
			},
		});
	}
	assert.equal(opened.length, 3);
	assert.equal(prevented, 2);
	state.window.getSelection = () => null;
	record._inaccessible = true;
	assert.equal(state.uploadResultEditAttributes(result), '');
	button.click();
	state.canvasState.bulkRecords = [];
	button.click();
	assert.equal(opened.length, 3);
	assert.equal(warnings.length, 2);
});

test('partial results show the root error first and explain rollbacks once', () => {
	const { html, confirm, cancel, summary } = renderResults([
		{ tempId: 'saved', objectName: 'Account', success: true, id: '001saved' },
		{ tempId: 'unchanged', objectName: 'Account', success: true, mode: 'unchanged', id: '001existing' },
		{ tempId: 'bad', objectName: 'Contact', success: false, error: 'AssistantPhone cannot be null' },
		{ tempId: 'rollback1', objectName: 'Account', success: false, errorCode: 'ALL_OR_NONE_OPERATION_ROLLED_BACK' },
		{
			tempId: 'rollback2',
			objectName: 'Case',
			success: false,
			error: 'The transaction was rolled back since another operation in the same transaction failed.',
		},
	]);
	assert.equal(summary.textContent, '');
	assert.equal(summary.hidden, true);
	assert.doesNotMatch(html, /1 uploaded · 3 not uploaded/);
	assert.match(html, /Rolled back \(2\)/);
	assert.equal((html.match(/another operation in the same transaction failed/g) || []).length, 1);
	assert.ok(html.indexOf('AssistantPhone cannot be null') < html.indexOf('Rolled back (2)'));
	assert.ok(html.indexOf('Rolled back (2)') < html.indexOf('<summary>Uploaded'));
	assert.match(html, /<summary>Skipped \(1\)<\/summary>/);
	assert.match(html, /https:\/\/example.my.salesforce.com\/lightning\/r\/Account\/001saved\/view/);
	assert.match(html, /<details class="upload-result-details"><summary>Uploaded/);
	assert.match(html, /<details class="upload-fix-group" open>/);
	assert.match(html, /1 issue needs attention/);
	assert.match(html, /<details class="upload-result-details"><summary>Rolled back \(2\)/);
	assert.match(html, /<details class="upload-result-details" open><summary>Failed \(1\)/);
	assert.doesNotMatch(html, /Must fix/);
	assert.match(html, /<details class="upload-result-details"><summary>Skipped/);
	assert.equal(confirm.textContent, 'Retry failed');
	assert.equal(cancel.textContent, 'Close');
});

test('delete-only failures retain a retry action and successful results offer Close', () => {
	const failure = renderResults(
		[],
		[{ tempId: 'delete', objectName: 'Account', success: false, error: 'Deletion denied' }],
	);
	assert.equal(failure.summary.hidden, true);
	assert.match(failure.html, /<summary>Failed \(1\)/);
	assert.match(failure.html, /Deletion denied/);
	assert.equal(failure.confirm.textContent, 'Retry failed');
	assert.equal(failure.cancel.style.display, '');
	const success = renderResults([{ tempId: 'saved', objectName: 'Account', success: true, id: '001saved' }]);
	assert.equal(success.confirm.textContent, 'Close');
	assert.equal(success.cancel.style.display, 'none');
	assert.equal(success.summary.hidden, true);
	assert.doesNotMatch(success.html, /Fix the errors/);
});

test('post-upload issues share grouped Fix controls and preserve Salesforce field details', () => {
	const { html } = renderResults(
		['a', 'b'].map((tempId) => ({
			tempId,
			objectName: 'Contact',
			success: false,
			error: 'AssistantPhone cannot be null <test>',
			errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
			fields: ['AssistantPhone'],
		})),
	);
	assert.equal((html.match(/class="upload-fix-group" open/g) || []).length, 1);
	assert.match(html, /Salesforce validation rule failed/);
	assert.match(html, /2 issues need attention/);
	assert.match(html, /2 records<\/span>/);
	assert.match(html, /data-upload-edit-record="a"/);
	assert.match(html, /data-upload-edit-record="b"/);
	assert.equal((html.match(/data-upload-focus-field="AssistantPhone"/g) || []).length, 2);
	assert.match(html, /FIELD_CUSTOM_VALIDATION_EXCEPTION/);
	assert.match(html, /&lt;test>/);
	assert.doesNotMatch(html, /<test>|upload-failure-block/);
});

test('upload summary combines repeated objects and distinguishes write operations without reordering records', () => {
	const records = [
		{ id: 'a1', objectName: 'Account' },
		{ id: 'c1', objectName: 'Contact' },
		{ id: 'a2', objectName: 'Account' },
		{ id: 'a3', objectName: 'Account', loadedFromId: '001existing' },
		{ id: 'a4', objectName: 'Account', loadedFromId: '001deleted', pendingDelete: true },
		{ id: 'c2', objectName: 'Contact', _csvOperation: 'upsert' },
	];
	const before = JSON.stringify(records);
	const groups = uploadModal.summarizeUploadRecords(records, new Set(), new Set(['a4']), {
		Account: { label: 'Customer' },
	});
	assert.deepEqual(JSON.parse(JSON.stringify(groups)), [
		{ objectName: 'Account', label: 'Customer', creates: 2, updates: 1, upserts: 0, deletes: 1 },
		{ objectName: 'Contact', label: 'Contact', creates: 1, updates: 0, upserts: 1, deletes: 0 },
	]);
	assert.equal(JSON.stringify(records), before);
});

test('upload summary excludes skipped, inaccessible and non-record items; supports deletions only', () => {
	const records = [
		{ id: 'unchanged', objectName: 'Account', loadedFromId: '001unchanged' },
		{ id: 'denied', objectName: 'Account', pendingDelete: true },
		{ id: 'type', objectName: 'Account', isTypeNode: true },
		{ id: 'hidden', objectName: 'Account', _inaccessible: true },
		{ id: 'request', objectName: 'Contact', slot: { kind: 'whole-record' }, values: {} },
		{ id: 'delete', objectName: 'Contact', loadedFromId: '003deleted', pendingDelete: true },
	];
	const groups = uploadModal.summarizeUploadRecords(
		records,
		new Set(['unchanged', 'denied']),
		new Set(['delete']),
		{},
	);
	assert.deepEqual(JSON.parse(JSON.stringify(groups)), [
		{ objectName: 'Contact', label: 'Contact', creates: 0, updates: 0, upserts: 0, deletes: 1 },
	]);
	assert.equal(uploadModal.summarizeUploadRecords([], new Set(), new Set(), {}).length, 0);
});

test('upload summary escapes labels and omits execution-order details while retaining validation', () => {
	assert.match(source, /upload-ready-count/);
	assert.match(source, /escapeHtml\(group.label\)/);
	assert.doesNotMatch(source, /View upload order|upload-order-details|upload-summary--ordered/);
	assert.match(source, /computeUploadOrder\(unchangedSet, scopedIds, deleteIdSet\)/);
	assert.match(source, /if \(cycleIds.size > 0\)/);
	assert.match(source, /const deletesBlock =\s*willDeleteCount > 0/);
});

test('selected-only upload keeps the literal selection and reports an excluded draft-parent link', () => {
	const records = [
		{ id: 'account-draft', objectName: 'Account', values: { Name: 'Acme' } },
		{ id: 'contact-draft', objectName: 'Contact', values: { LastName: 'User' } },
		{ id: 'type-node', objectName: 'Contact', isTypeNode: true },
	];
	const selectedIds = new Set(['contact-draft']);
	const scoped = uploadModal.scopeUploadRecords(records, selectedIds, true);

	assert.equal(scoped.length, 1);
	assert.equal(scoped[0].id, 'contact-draft');

	const excluded = uploadModal.excludedDraftParentLinks(
		records,
		[{ fromId: 'contact-draft', toId: 'account-draft', fieldName: 'AccountId' }],
		new Set(scoped.map((r) => r.id)),
		true,
	);
	assert.equal(excluded.length, 1);
	assert.equal(excluded[0].fieldName, 'AccountId');
});

test('selected-only upload does not warn for an unselected parent already in Salesforce', () => {
	const records = [
		{ id: 'account-existing', objectName: 'Account', loadedFromId: '001xx' },
		{ id: 'contact-draft', objectName: 'Contact' },
	];
	const scoped = uploadModal.scopeUploadRecords(records, new Set(['contact-draft']), true);
	const excluded = uploadModal.excludedDraftParentLinks(
		records,
		[{ fromId: 'contact-draft', toId: 'account-existing', fieldName: 'AccountId' }],
		new Set(scoped.map((r) => r.id)),
		true,
	);

	assert.equal(scoped.length, 1);
	assert.equal(excluded.length, 0);
});

test('all-record upload retains linked drafts without an exclusion warning', () => {
	const records = [
		{ id: 'account-draft', objectName: 'Account' },
		{ id: 'contact-draft', objectName: 'Contact' },
	];
	const scoped = uploadModal.scopeUploadRecords(records, new Set(['contact-draft']), false);
	const excluded = uploadModal.excludedDraftParentLinks(
		records,
		[{ fromId: 'contact-draft', toId: 'account-draft', fieldName: 'AccountId' }],
		new Set(scoped.map((r) => r.id)),
		false,
	);

	assert.equal(scoped.length, 2);
	assert.equal(excluded.length, 0);
});

test('upload eligibility excludes unfinished requests and canvas-only placeholders', () => {
	const records = [
		{ id: 'draft', objectName: 'Account', values: { Name: 'Ready' } },
		{
			id: 'request',
			objectName: 'Account',
			values: {},
			slot: { slotId: 'slot-1', kind: 'whole-record' },
		},
		{ id: 'pending', objectName: 'Contact', isPending: true },
		{ id: 'hidden', objectName: 'Opportunity', _inaccessible: true },
		{ id: 'type', objectName: 'Account', isTypeNode: true },
	];

	assert.deepEqual(
		Array.from(uploadModal.scopeUploadRecords(records, new Set(), false), (record) => record.id),
		['draft'],
	);
	assert.deepEqual(
		Array.from(uploadModal.scopeUploadExclusions(records, new Set(), false), (entry) => entry.reason),
		['unfinished-record-request', 'loading-placeholder', 'inaccessible-placeholder'],
	);
	assert.deepEqual(
		Array.from(uploadModal.uploadExclusionSummary(uploadModal.scopeUploadExclusions(records, new Set(), false))),
		['1 unfinished record request', '1 record still loading', '1 unavailable record placeholder'],
	);
});

test('completed record requests upload after becoming normal drafts', () => {
	const completed = { id: 'completed', objectName: 'Opportunity', values: { Name: 'Renewal' } };
	const completedWithRequestMetadata = {
		id: 'completed-slot',
		objectName: 'Opportunity',
		values: { Name: 'Expansion' },
		slot: { slotId: 'slot-complete', kind: 'whole-record' },
	};
	assert.equal(uploadModal.isUploadEligibleRecord(completed), true);
	assert.equal(uploadModal.uploadIneligibilityReason(completed), null);
	assert.equal(uploadModal.isUploadEligibleRecord(completedWithRequestMetadata), true);
});

test('successful upload promotes a completed request and retires its request metadata', () => {
	const record = {
		id: 'draft-opportunity',
		objectName: 'Opportunity',
		_persistedTempId: 'saved-draft-opportunity',
		_canvasRecordId: 'opportunity-card',
		values: { Name: 'Expansion' },
		slot: { slotId: 'opportunity-request', kind: 'whole-record' },
		_recipientSlot: true,
	};
	uploadModal.reconcileSyncedRecords([record], [{ tempId: 'draft-opportunity', id: '006000000000001AAA' }], {
		'draft-opportunity': { Name: 'Expansion opportunity' },
	});

	assert.equal(record.loadedFromId, '006000000000001AAA');
	assert.equal(record.values.Name, 'Expansion opportunity');
	assert.equal(record.slot, undefined);
	assert.equal(record._recipientSlot, undefined);
	assert.equal(record._presencePromotedFrom.refKind, 'slot');
	assert.equal(record._presencePromotedFrom.ref, 'opportunity-request');
	assert.equal(record._presencePromotedFrom.sourceRef, 'saved-draft-opportunity');
});

test('successful upload refreshes untouched fields from Salesforce', () => {
	const record = {
		id: 'account-1',
		objectName: 'Account',
		loadedFromId: '001000000000001AAA',
		values: { Name: 'Loaded name', Phone: '555-2222', Industry: 'Technology' },
		loadedValues: { Name: 'Loaded name', Phone: '555-1111', Industry: 'Technology' },
	};
	const snapshots = uploadModal.snapshotUploadRecords([
		{
			tempId: record.id,
			loadedFromId: record.loadedFromId,
			values: record.values,
			loadedValues: record.loadedValues,
		},
	]);
	uploadModal.reconcileSyncedRecords(
		[record],
		[{ tempId: record.id, id: record.loadedFromId, mode: 'update' }],
		{
			[record.id]: { Name: 'Changed in Salesforce', Phone: '555-2222', Industry: 'Finance' },
		},
		snapshots,
	);

	assert.equal(record.values.Name, 'Changed in Salesforce');
	assert.equal(record.values.Industry, 'Finance');
	assert.equal(record.loadedValues.Name, 'Changed in Salesforce');
	assert.equal(record.loadedValues.Industry, 'Finance');
});

test('successful upload refreshes audit fields omitted from the request snapshot', () => {
	const record = {
		id: 'account-1',
		objectName: 'Account',
		loadedFromId: '001000000000001AAA',
		values: {
			Name: 'Submitted name',
			LastModifiedById: '005000000000001AAA',
			SystemModstamp: '2026-08-09T15:00:00.000Z',
		},
		loadedValues: {
			Name: 'Loaded name',
			LastModifiedById: '005000000000001AAA',
			SystemModstamp: '2026-08-09T15:00:00.000Z',
		},
	};
	const snapshots = uploadModal.snapshotUploadRecords(
		[
			{
				tempId: record.id,
				loadedFromId: record.loadedFromId,
				values: { Name: record.values.Name },
				loadedValues: record.loadedValues,
			},
		],
		[record],
	);
	uploadModal.reconcileSyncedRecords(
		[record],
		[{ tempId: record.id, id: record.loadedFromId, mode: 'update' }],
		{
			[record.id]: {
				Name: 'Submitted name',
				LastModifiedById: '005000000000002AAA',
				SystemModstamp: '2026-08-09T16:00:00.000Z',
			},
		},
		snapshots,
	);

	assert.equal(record.values.LastModifiedById, '005000000000002AAA');
	assert.equal(record.values.SystemModstamp, '2026-08-09T16:00:00.000Z');
	assert.equal(record.loadedValues.LastModifiedById, record.values.LastModifiedById);
	assert.equal(record.loadedValues.SystemModstamp, record.values.SystemModstamp);
	assert.equal(JSON.stringify(record.loadedValues), JSON.stringify(record.values));
});

test('post-upload refresh preserves edits made after the immutable upload snapshot', () => {
	const record = {
		id: 'account-1',
		objectName: 'Account',
		loadedFromId: '001000000000001AAA',
		values: { Name: 'Submitted name', Phone: '555-2222', Industry: 'Technology' },
		loadedValues: { Name: 'Loaded name', Phone: '555-1111', Industry: 'Technology' },
	};
	const snapshots = uploadModal.snapshotUploadRecords([
		{
			tempId: record.id,
			loadedFromId: record.loadedFromId,
			values: record.values,
			loadedValues: record.loadedValues,
		},
	]);
	record.values.Industry = 'New canvas edit while uploading';
	uploadModal.reconcileSyncedRecords(
		[record],
		[{ tempId: record.id, id: record.loadedFromId, mode: 'update' }],
		{
			[record.id]: { Name: 'Submitted name', Phone: '555-2222', Industry: 'Finance' },
		},
		snapshots,
	);

	assert.equal(record.values.Industry, 'New canvas edit while uploading');
	assert.equal(record.loadedValues.Industry, 'Finance');
	assert.equal(record.values.Name, 'Submitted name');
});

test('successful upload immediately publishes its reconciled canvas state', () => {
	assert.match(
		source,
		/reconcileSyncedRecords\([\s\S]*?canvasState\.bulkRecords,[\s\S]*?synced,[\s\S]*?canonicalValues,[\s\S]*?submittedSnapshots,[\s\S]*?canvasState\.bulkAssociations,[\s\S]*?\);[\s\S]*?publishPresenceChanges\(\);[\s\S]*?flushAutosave\(\);/,
	);
	assert.match(appSource, /publishPresenceChanges: function \(\) \{[\s\S]*?_publishPresenceChanges\(\)/);
	assert.match(appSource, /flushAutosave: function \(\) \{[\s\S]*?_autosaveFlush\(\)/);
});

test('successful encrypted upload cleanup uses the submitted snapshot available to the results renderer', () => {
	assert.match(source, /_clearSubmittedEncryptedValues\(synced, submittedSnapshots, canonicalValues\)/);
	assert.doesNotMatch(source, /_clearSubmittedEncryptedValues\(synced, payload\.records, canonicalValues\)/);
});

test('upload review does not add a separate encrypted-field summary', () => {
	assert.doesNotMatch(source, /encryptedActionBlock/);
	assert.doesNotMatch(source, /Values are never shown in upload review\./);
	assert.doesNotMatch(source, /Replacement required/);
	assert.doesNotMatch(source, /Re-enter or dismiss the pending encrypted field changes before uploading\./);
});

test('missing encrypted replacements warn and default to leave unchanged', () => {
	assert.deepEqual(
		{ ...uploadModal.unresolvedEncryptedUploadIssue({ loadedFromId: '001000000000001AAA' }, { required: true }) },
		{
			severity: 'warning',
			message:
				'No replacement is available in this tab. Org Loom will leave this Salesforce field unchanged if you continue.',
		},
	);
	assert.equal(uploadModal.unresolvedEncryptedUploadIssue({}, { required: false }).severity, 'warning');
	assert.equal(uploadModal.unresolvedEncryptedUploadIssue({}, { required: true }).severity, 'error');
	assert.match(source, /encryptedFields\.dismissIntent\(record, fieldName\)/);
	assert.match(source, /encrypted field'[\s\S]*' left unchanged for this upload\.'/);
	assert.doesNotMatch(source, /Re-enter the encrypted replacement in the record editor/);
});

test('field requests remain uploadable and incomplete requests are warnings', () => {
	const incomplete = {
		id: 'contact',
		objectName: 'Contact',
		values: { FirstName: 'Ada', LastName: '' },
		slot: { slotId: 'slot-2', kind: 'fields', fields: ['FirstName', 'LastName'] },
	};
	const complete = {
		id: 'account',
		objectName: 'Account',
		values: { Name: 'Acme' },
		slot: { slotId: 'slot-3', kind: 'fields', fields: ['Name'] },
	};

	assert.deepEqual(
		Array.from(uploadModal.scopeUploadRecords([incomplete, complete], new Set(), false), (record) => record.id),
		['contact', 'account'],
	);
	assert.deepEqual(
		Array.from(uploadModal.incompleteFieldRequests([incomplete, complete]), (record) => record.id),
		['contact'],
	);
});

test('relationships to excluded record requests are omitted even for all-record upload', () => {
	const records = [
		{ id: 'contact', objectName: 'Contact', values: { LastName: 'User', AccountId: 'draft-request' } },
		{
			id: 'draft-request',
			objectName: 'Account',
			values: {},
			slot: { slotId: 'slot-4', kind: 'whole-record' },
		},
	];
	const scoped = uploadModal.scopeUploadRecords(records, new Set(), false);
	const links = uploadModal.excludedDraftParentLinks(
		records,
		[{ fromId: 'contact', toId: 'draft-request', fieldName: 'AccountId' }],
		new Set(scoped.map((record) => record.id)),
		false,
	);

	assert.equal(links.length, 1);
	assert.deepEqual({ ...uploadModal.scopeUploadValues(records[0], records[0].values, links) }, { LastName: 'User' });
});

test('successful draft uploads refresh visible fields omitted from the write payload', () => {
	const record = {
		id: 'draft-contact',
		objectName: 'Contact',
		values: {
			FirstName: 'Ada',
			LastName: 'Lovelace',
			OwnerId: '005-before-upload',
		},
	};
	const describeCache = {
		Contact: {
			fields: [{ name: 'FirstName' }, { name: 'LastName' }, { name: 'OwnerId', createable: false }],
		},
	};
	assert.deepEqual(Array.from(uploadModal.canonicalFieldNamesForRecord(record, describeCache)), [
		'FirstName',
		'LastName',
		'OwnerId',
	]);

	const snapshots = uploadModal.snapshotUploadRecords(
		[
			{
				tempId: record.id,
				objectName: record.objectName,
				values: { FirstName: 'Ada', LastName: 'Lovelace' },
			},
		],
		[record],
	);
	uploadModal.reconcileSyncedRecords(
		[record],
		[{ tempId: record.id, id: '003000000000001AAA', objectName: 'Contact', mode: 'create' }],
		{
			[record.id]: {
				FirstName: 'Ada',
				LastName: 'Lovelace',
				OwnerId: '005-after-upload',
			},
		},
		snapshots,
	);

	assert.equal(record.loadedFromId, '003000000000001AAA');
	assert.equal(record.values.OwnerId, '005-after-upload');
	assert.deepEqual({ ...record.loadedValues }, { ...record.values });
});

test('successful draft uploads refresh a Salesforce-generated record name', () => {
	const record = {
		id: 'draft-project',
		objectName: 'OLQA_Project__c',
		values: { Status__c: 'New' },
	};
	const describeCache = {
		OLQA_Project__c: {
			fields: [
				{ name: 'Name', nameField: true, createable: false, accessible: true },
				{ name: 'Status__c', accessible: true },
			],
		},
	};

	assert.deepEqual(Array.from(uploadModal.canonicalFieldNamesForRecord(record, describeCache)), [
		'Status__c',
		'Name',
	]);

	const snapshots = uploadModal.snapshotUploadRecords(
		[{ tempId: record.id, objectName: record.objectName, values: { Status__c: 'New' } }],
		[record],
	);
	uploadModal.reconcileSyncedRecords(
		[record],
		[{ tempId: record.id, id: 'a00000000000001AAA', objectName: record.objectName, mode: 'create' }],
		{
			[record.id]: {
				Name: 'PROJECT-0001',
				Status__c: 'New',
			},
		},
		snapshots,
	);

	assert.equal(record.loadedFromId, 'a00000000000001AAA');
	assert.equal(record.values.Name, 'PROJECT-0001');
	assert.equal(record.loadedValues.Name, 'PROJECT-0001');
});

test('successful upload promotes canvas relationship references into the Salesforce baseline', () => {
	const account = {
		id: 'draft-account',
		objectName: 'Account',
		values: { Name: 'Acme' },
	};
	const contact = {
		id: 'draft-contact',
		objectName: 'Contact',
		values: { LastName: 'User', AccountId: account.id },
	};
	const snapshots = uploadModal.snapshotUploadRecords(
		[
			{ tempId: account.id, objectName: account.objectName, values: account.values },
			{ tempId: contact.id, objectName: contact.objectName, values: contact.values },
		],
		[account, contact],
	);
	const synced = [
		{ tempId: account.id, id: '001000000000001AAA', objectName: 'Account', mode: 'create' },
		{ tempId: contact.id, id: '003000000000001AAA', objectName: 'Contact', mode: 'create' },
	];

	// The upload-result path resolves canvas associations before reconciling baselines.
	contact.values.AccountId = '001000000000001AAA';
	uploadModal.reconcileSyncedRecords([account, contact], synced, {}, snapshots, [
		{ fromId: contact.id, toId: account.id, fieldName: 'AccountId' },
	]);

	assert.equal(contact.loadedFromId, '003000000000001AAA');
	assert.equal(contact.loadedValues.AccountId, '001000000000001AAA');
	assert.deepEqual({ ...contact.loadedValues }, { ...contact.values });
});

test('relationship baseline promotion also handles an existing parent that was not uploaded', () => {
	const account = {
		id: 'canvas-account',
		objectName: 'Account',
		loadedFromId: '001000000000001AAA',
		values: { Id: '001000000000001AAA', Name: 'Acme' },
		loadedValues: { Id: '001000000000001AAA', Name: 'Acme' },
	};
	const contact = {
		id: 'draft-contact',
		objectName: 'Contact',
		values: { LastName: 'User', AccountId: account.id },
	};
	const snapshots = uploadModal.snapshotUploadRecords(
		[{ tempId: contact.id, objectName: contact.objectName, values: contact.values }],
		[contact],
	);
	contact.values.AccountId = account.loadedFromId;
	uploadModal.reconcileSyncedRecords(
		[account, contact],
		[{ tempId: contact.id, id: '003000000000001AAA', objectName: 'Contact', mode: 'create' }],
		{},
		snapshots,
		[{ fromId: contact.id, toId: account.id, fieldName: 'AccountId' }],
	);

	assert.equal(contact.loadedValues.AccountId, account.loadedFromId);
	assert.deepEqual({ ...contact.loadedValues }, { ...contact.values });
});

test('relationship-only associations become part of a successful draft baseline', () => {
	const account = {
		id: 'draft-account',
		objectName: 'Account',
		values: { Name: 'Acme' },
	};
	const contact = {
		id: 'draft-contact',
		objectName: 'Contact',
		values: { LastName: 'User' },
	};
	const snapshots = uploadModal.snapshotUploadRecords(
		[
			{ tempId: account.id, objectName: account.objectName, values: account.values },
			{ tempId: contact.id, objectName: contact.objectName, values: contact.values },
		],
		[account, contact],
	);
	const synced = [
		{ tempId: account.id, id: '001000000000001AAA', objectName: 'Account', mode: 'create' },
		{ tempId: contact.id, id: '003000000000001AAA', objectName: 'Contact', mode: 'create' },
	];
	contact.values.AccountId = '001000000000001AAA';
	uploadModal.reconcileSyncedRecords([account, contact], synced, {}, snapshots, [
		{ fromId: contact.id, toId: account.id, fieldName: 'AccountId' },
	]);

	assert.equal(contact.loadedValues.AccountId, '001000000000001AAA');
	assert.deepEqual({ ...contact.loadedValues }, { ...contact.values });
});

test('upload summary distinguishes excluded canvas items from uploadable records', () => {
	assert.match(source, /<strong>Not included:<\/strong>/);
	assert.match(source, /Finish or remove these canvas items before uploading them/);
	assert.match(source, /Requested fields are still incomplete/);
});

test('post-upload results identify records by name without positional hash numbers', () => {
	const account = { id: 'draft-account', objectName: 'Account', values: { Name: 'Acme Corporation' } };
	const contact = { id: 'draft-contact', objectName: 'Contact', values: { FirstName: 'Ada', LastName: 'Lovelace' } };
	const describes = {
		Account: { label: 'Account', fields: [{ name: 'Name', nameField: true }] },
		Contact: { label: 'Contact', fields: [{ name: 'Name', nameField: true }] },
	};

	assert.deepEqual(
		{ ...uploadModal.uploadResultIdentity({ tempId: account.id, objectName: 'Account' }, [account], describes) },
		{ name: 'Acme Corporation', objectLabel: 'Account', cardNumber: null },
	);
	assert.deepEqual(
		{ ...uploadModal.uploadResultIdentity({ tempId: contact.id, objectName: 'Contact' }, [contact], describes) },
		{ name: 'Ada Lovelace', objectLabel: 'Contact', cardNumber: null },
	);
	assert.match(source, /Uploaded \('/);
	assert.match(source, /uploadIssueGroupsHtml\(fixIssues\)/);
	assert.doesNotMatch(source, /Fix the errors below, then retry/);
	assert.match(source, /identity\.objectLabel \+ ' - ' \+ identity\.name/);
	assert.doesNotMatch(source, /'<div>#' \+/);
});

test('issue groups default open while uploaded and skipped default closed', () => {
	assert.match(source, /<details class="upload-fix-group" open>/);
	assert.match(source, /<details class="upload-result-details"><summary>Uploaded/);
	assert.match(source, /<details class="upload-result-details"><summary>Skipped/);
	assert.doesNotMatch(source, /upload-result-details--muted/);
	assert.match(source, /summaryHtml \+ failuresHtml \+ html \+ deletedHtml \+ secondaryHtml/);
	assert.match(source, /failed\.length > 0 \|\|[\s\S]*?deleteFailed\.length > 0/);
	assert.doesNotMatch(source, /unchanged records? needed/);
	assert.doesNotMatch(source, /had no local edits, so we didn/);
});

test('sample upload is absent from the client, server, and playground', () => {
	const mockSource = fs.readFileSync(path.resolve(here, '../src/public/js/mock-sf.js'), 'utf8');
	for (const code of [source, routesSource, mockSource]) {
		assert.doesNotMatch(
			code,
			/\/api\/upload\/preflight|handleUploadPreflight|renderPreflightFailure|_preflightOverride/,
		);
	}
	assert.doesNotMatch(source, /Sending a sample to Salesforce|Pre-flight passed/);
	assert.match(source, /_renderUploadModalSummary\(\) === false/);
	assert.match(source, /csrfFetch\('\/api\/upload\/graph'/);
	assert.match(source, /csrfFetch\('\/api\/upload'/);
	assert.match(source, /csrfFetch\('\/api\/upload\/bulk'/);
});

test('unnamed upload results use the real canvas card number only as a fallback', () => {
	const record = { id: 'draft-account', objectName: 'Account', values: {} };
	const identity = uploadModal.uploadResultIdentity(
		{ tempId: record.id, objectName: 'Account' },
		[record],
		{ Account: { label: 'Account', fields: [{ name: 'Name', nameField: true }] } },
		null,
		null,
		() => 7,
	);

	assert.deepEqual({ ...identity }, { name: 'Unnamed Account', objectLabel: 'Account', cardNumber: '7' });
});

test('upload preflight clearly separates included records from disclosed exclusions', () => {
	assert.match(source, /upload-ready-count/);
	assert.doesNotMatch(source, /upload-skipped-note/);
	assert.match(source, /These changes are excluded/);
	assert.match(source, /const totalRecords = willUploadCount \+ willDeleteCount/);
	assert.match(source, /Upload & delete/);
	assert.doesNotMatch(source, /Eligible operations|eligible operation/);
	assert.doesNotMatch(source, /loaded records? ha(?:s|ve) no local changes and will be skipped/);
	assert.doesNotMatch(source, /Records will upload in the order below/);
	assert.doesNotMatch(source, /<span>Will sync<\/span>/);
	assert.doesNotMatch(source, /Associations \(FK links\)/);
});

test('upload preflight identifies an inactive Salesforce connection and offers reconnection', () => {
	const summary = uploadModal.describeLoadFailureSummary(
		[{ name: 'Account', code: 'no-active-connection', status: 409 }],
		new Set(['Account']),
	);

	assert.equal(summary.kind, 'connection');
	assert.match(summary.heading, /reconnected/);
	assert.match(summary.message, /Reconnect Salesforce, then reopen Upload/);
	assert.doesNotMatch(summary.message, /another tab/);
	assert.equal(summary.action, 'Reconnect Salesforce');
	assert.match(source, /describeFailure\.action/);
});

test('upload preflight stops for another describe failure and lets the user retry', () => {
	const summary = uploadModal.describeLoadFailureSummary(
		[{ name: 'Contact', code: 'service-unavailable', status: 503 }],
		new Set(['Contact']),
	);

	assert.equal(summary.kind, 'retry');
	assert.match(summary.message, /Contact/);
	assert.equal(summary.action, 'Retry pre-flight checks');
});

test('pending org approval explains the automatic request and the admin action', () => {
	const message = uploadModal.approvalRequiredMessage({ approvalStatus: 'pending' });
	assert.match(message, /automatically created an access request/i);
	assert.match(message, /any workspace admin/i);
	assert.match(message, /Workspace settings/i);
	assert.match(source, /No Salesforce records were written/);
	assert.match(source, /body\.message \|\| body\.error/);
});

test('upload checks local org approval before claiming that Salesforce upload has started', () => {
	const accessIndex = source.indexOf("csrfFetch('/api/upload/access-check'");
	const graphIndex = source.indexOf("csrfFetch('/api/upload/graph'");
	assert.notEqual(accessIndex, -1);
	assert.notEqual(graphIndex, -1);
	assert.ok(accessIndex < graphIndex);
	assert.match(source, /Checking Salesforce access&hellip;/);
	assert.match(source, /accessController\.abort\(\), 5000/);
	assert.match(source, /No records were written\. Retry/);
});

test('upload permission denials retain their dedicated recovery message', () => {
	assert.match(source, /function isUploadPermissionDenied\(body\)/);
	assert.match(source, /body\.capability === 'upload-records'/);
	assert.match(source, /<strong>Upload permission required\.<\/strong>/);
	assert.match(source, /Ask a workspace admin to grant you the Upload to Salesforce permission/);
	assert.match(source, /class="upload-confirm-tip" id="upload-confirm-tip"/);
	assert.match(source, /<span aria-hidden="true">\uD83D\uDD12<\/span> Upload unavailable/);
	assert.match(source, /confirmBtn\.onclick = null/);
	assert.match(source, /tip\.setAttribute\('title', title\)/);
	assert.match(
		source,
		/if \(!r\.ok && isUploadPermissionDenied\(body\)\) \{\s*renderUploadPermissionRequired\(content, confirmBtn, body\);\s*return;/,
	);
});

test('upload modal backdrop cannot accidentally dismiss upload review', () => {
	assert.match(source, /'<div class="modal-overlay"><\/div>'/);
	assert.doesNotMatch(source, /'<div class="modal-overlay" data-upload-close><\/div>'/);
});

test('org allowlist copy prefers the server explanation', () => {
	const serverMessage = 'This Salesforce org is not on the workspace allowlist.';
	assert.equal(uploadModal.approvalRequiredMessage({ message: serverMessage }), serverMessage);
	assert.match(source, /<strong>Salesforce org is not allowed\.<\/strong>/);
});

test('an org switch stops the upload with recovery guidance', () => {
	assert.match(source, /Salesforce org changed/);
	assert.match(source, /active-org-changed/);
	assert.match(source, /Reconnect to the intended Salesforce org, then reopen this upload/i);
});

test('describe requests preserve their HTTP reason for upload recovery', () => {
	assert.match(appSource, /error\.status = r\.status/);
	assert.match(appSource, /error\.code = body && body\.error/);
	assert.match(appSource, /body && body\.message/);
});

test('upload progress uses a plain object-aware record summary', () => {
	const describes = {
		Contact: { label: 'Contact', labelPlural: 'Contacts' },
		Account: { label: 'Account', labelPlural: 'Accounts' },
	};
	assert.equal(
		uploadModal.formatUploadProgress([{ objectName: 'Contact' }, { objectName: 'Contact' }], describes),
		'Uploading 2 Contacts…',
	);
	assert.equal(uploadModal.formatUploadProgress([{ objectName: 'Account' }], describes), 'Uploading 1 Account…');
	assert.equal(
		uploadModal.formatUploadProgress([{ objectName: 'Account' }, { objectName: 'Contact' }], describes),
		'Uploading 2 records…',
	);
	assert.doesNotMatch(source, /atomically|Validation and commit happen in one step/);
});

test('selected-only warning explains that unselected draft relationships are omitted', () => {
	assert.match(source, /Some relationships won’t be included/);
	assert.match(source, /Only the selected/);
	assert.match(source, /Select the related draft/);
	assert.doesNotMatch(source, /Also uploading/);
});

test('required omitted draft relationships become record-level preflight errors', () => {
	assert.match(source, /requiredExcludedDraftLinks\.forEach/);
	assert.match(source, /This required relationship points to an unselected draft and won’t be included/);
	assert.match(source, /severity: 'error'/);
});

test('client preflight errors must be fixed before upload', () => {
	assert.match(source, /Fix these errors on the canvas before uploading/);
	assert.match(
		source,
		/if \(errorCount > 0\) \{[\s\S]*?confirmBtn\.disabled = false;[\s\S]*?confirmBtn\.textContent = 'Fix errors before upload';[\s\S]*?confirmBtn\.onclick = closeUploadModal/,
	);
});

test('client preflight distinguishes the field label from its API name', () => {
	assert.match(
		source,
		/escapeHtml\(iss\.fieldLabel\)\s*\+\s*' \(<code>'\s*\+\s*escapeHtml\(iss\.field\)\s*\+\s*'<\/code>\)/,
	);
});

test('an unapplied migration plan is a hard upload gate', () => {
	assert.match(source, /Apply the migration first/);
	assert.match(source, /Apply the migration plan to the canvas before uploading/);
	assert.match(source, /confirmBtn\.textContent = 'Apply migration first'/);
	assert.match(source, /encryptedFields\.uploadValues\(r, canvasState, r\.values\)/);
	assert.match(source, /explicitFields: encryptedFields\.intentNames\(r, canvasState\)/);
	assert.doesNotMatch(source, /function _migrateUploadValues/);
});

test('completed upload results retire the attempt token, including all-failed uploads', () => {
	assert.match(source, /function displayUploadResults\([\s\S]*?_uploadAttemptId = null;/);
});

test('uncertain upload guard explains the duplicate risk and concrete recovery steps', () => {
	assert.match(source, /Upload paused to prevent duplicate records/);
	assert.match(source, /find the entry marked <strong>Outcome unknown<\/strong>/);
	assert.match(source, /Check Salesforce to see whether the affected records were saved/);
	assert.match(source, /refresh or replace the matching drafts on the canvas/);
	assert.match(source, /confirmBtn\.textContent = 'Close'/);
});

test('Upload History distinguishes unknown outcomes from completed uploads', () => {
	assert.match(historySource, /b\.status === 'pending'[\s\S]*Outcome unknown/);
	assert.match(historySource, /Salesforce may have saved some or all of these records/);
	assert.match(historySource, /b\.status === 'failed'[\s\S]*Not uploaded/);
});

test('successful recall reconciles the live canvas without converting refresh failures into recall failures', () => {
	assert.match(historySource, /await refreshCanvasAfterRecall\(body\)/);
	assert.match(historySource, /Recall completed, but the canvas could not be refreshed/);
	assert.match(historySource, /orgloom:records-deleted[\s\S]*await refreshCanvasAfterRecall\(body\)/);
});

test('post-recall reconciliation refreshes every clean loaded record and preserves newer canvas edits', () => {
	assert.match(
		appSource,
		/async function refreshCanvasAfterRecall\(\)[\s\S]*const loaded = canvasState\.bulkRecords\.filter/,
	);
	assert.match(appSource, /const dirty = loaded\.filter\(\(r\) => isRecordModified\(r\)\)/);
	assert.match(appSource, /const clean = loaded\.filter\(\(r\) => !isRecordModified\(r\)\)/);
	assert.match(appSource, /await refreshLoadedCanvasRecords\(clean\)/);
	assert.match(appSource, /with unsaved edits[\s\S]*left unchanged/);
});

test('recall review omits recovery promises and legacy pre-value-revert messaging', () => {
	assert.doesNotMatch(historySource, /Soft delete only|Recycle Bin|recycle bin|recoverable via Salesforce/);
	assert.doesNotMatch(historySource, /uploaded before the value-revert feature shipped/);
});

test('recall review restores the cached history list and never renders a zero-record action', () => {
	assert.match(historySource, /const historyListHtml = content\.innerHTML/);
	assert.match(historySource, /data-uh-back[^\n]+restoreHistoryList/);
	assert.match(historySource, /_executeRecall\([\s\S]*?forceDeleteSfIds[\s\S]*?revertSelections/);
	assert.match(historySource, /async function _executeRecall\([\s\S]*?forceDeleteSfIds[\s\S]*?restoreHistoryList/);
	assert.match(
		historySource,
		/querySelector\(\s*'\[data-uh-list\]'\s*\)\s*\.addEventListener\(\s*'click',\s*\(\) => restoreHistoryList\(body\.status\)\s*\)/,
	);
	assert.match(historySource, /updatedStatus === 'recalled'[\s\S]*?recallButton\.remove\(\)/);
	assert.doesNotMatch(
		historySource,
		/querySelector\(\s*'\[data-uh-list\]'\s*\)\s*\.addEventListener\(\s*'click',\s*(?:\(\) =>\s*)?_renderUploadHistoryList/,
	);
	assert.match(historySource, /const recallAction = hasPotentialRecallWork/);
	assert.match(historySource, /Nothing from this upload is available to recall/);
	assert.doesNotMatch(historySource, /Recall <span data-uh-recall-count>/);
});

test('recall preserves later field edits and reports retryable field outcomes', () => {
	assert.doesNotMatch(historySource, /data-uh-revert-field="[\s\S]{0,200}?uh-revert-drift-tag">drifted/);
	assert.match(historySource, /revertedFieldCount/);
	assert.match(historySource, /revertFailedFieldCount/);
	assert.match(historySource, /Remaining changes can be retried from upload history/);
	assert.match(historySource, /data-uh-force-revert-field/);
	assert.doesNotMatch(historySource, /data-uh-force-revert-field="[^"]+" checked/);
	assert.match(historySource, />Changed since upload</);
	assert.doesNotMatch(historySource, /data-uh-restore-changed-fields/);
	assert.match(historySource, /forceRevertSelections/);
	assert.match(historySource, /expectedCurrent: field\.current/);
	assert.match(routesSource, /forceDeleteSfIds/);
	assert.match(routesSource, /forceRevertSelections/);
	assert.match(batchStoreSource, /recalledAt: status === 'recalled' \? Date\.now\(\) : null/);
});

test('recall review identifies linked records and previews each field after recall', () => {
	assert.match(historySource, /objectLabel \+ ' - ' \+ recordName/);
	assert.match(historySource, /View in Salesforce/);
	assert.match(historySource, /Original value/);
	assert.match(historySource, /Value uploaded by Org Loom/);
	assert.match(historySource, /Current Salesforce value/);
	assert.match(historySource, /After recall/);
	assert.match(historySource, /data-uh-after-original/);
	assert.match(historySource, /data-uh-after-current/);
	assert.match(historySource, /updateAfterRecallValues/);
	assert.doesNotMatch(historySource, /Choose which uploaded field changes to undo/);
	assert.match(historySource, /class="uh-info-tooltip-trigger"/);
	assert.match(historySource, /role="tooltip"/);
	assert.equal((historySource.match(/class="uh-info-tooltip-trigger"/g) || []).length, 1);
	assert.match(historySource, /How does field recall work/);
	assert.doesNotMatch(historySource, /updated record(?:s)? (?:has|have) field changes from this upload/);
	assert.doesNotMatch(historySource, /data-uh-after-status/);
	assert.doesNotMatch(historySource, /cannot be overwritten by recall|\bPrior:\b|We wrote:|SF now:/);
});

test('recall presents record deletion and field restoration as equal operations', () => {
	assert.match(historySource, /uh-operation-section uh-operation-section--delete/);
	assert.match(historySource, /<h5 class="uh-operation-title">Delete from Salesforce<\/h5>/);
	assert.match(historySource, /uh-operation-section uh-operation-section--revert/);
	assert.match(historySource, /<h5 class="uh-operation-title">Revert field values<\/h5>/);
});

test('recall is visibly locked without permission and rechecked before Salesforce changes', () => {
	assert.match(historySource, /Ask a workspace admin to grant you the Recall uploads permission/);
	assert.match(historySource, /data-uh-recall-locked/);
	assert.match(historySource, /await refreshCapabilities\(\)/);
	assert.match(historySource, /if \(!hasCapability\('recall-upload'\)\)[\s\S]*No Salesforce records were changed/);
	assert.match(historySource, /body\.message \|\| body\.error \|\| 'Recall failed'/);
	assert.match(routesSource, /'member-grant-required':[\s\S]*Recall uploads is not enabled for your account/);
	assert.match(routesSource, /app\.post\('\/api\/upload-batches\/:id\/recall'[\s\S]*_gateRecallUpload/);
});

test('upload conflicts require exact current-value review before any write', () => {
	assert.match(source, /Salesforce changed since this canvas was loaded/);
	assert.equal((source.match(/Salesforce changed since this canvas was loaded/g) || []).length, 1);
	assert.match(source, /Original value[\s\S]*Current Salesforce value[\s\S]*Value after upload/);
	assert.match(source, /uploadResultIdentityHtml\([\s\S]*record\.sfId[\s\S]*record\.objectName/);
	assert.match(source, /View in Salesforce/);
	assert.doesNotMatch(source, /If you continue, Recall will restore/);
	assert.doesNotMatch(source, /Review the current Salesforce values before replacing them/);
	assert.match(source, /baselineConfirmations: _baselineConfirmations/);
	assert.match(source, /expectedCurrent: field\.current/);
	assert.match(source, /confirmBtn\.textContent = 'Upload anyway'/);
	assert.equal((routesSource.match(/await _capturePreUploadState\(/g) || []).length, 3);
	assert.match(routesSource, /error: 'salesforce-records-changed'/);
});

test('recall explains the authoritative pre-upload Salesforce baseline', () => {
	assert.match(
		historySource,
		/Updated fields return to the Salesforce values captured immediately before this upload on/,
	);
	assert.match(historySource, /older upload restores updated fields/);
	assert.match(historySource, /uh-field-recall-tooltip/);
});

test('recall history uses paginated ledgers and a consolidated parallel preflight', () => {
	assert.match(historySource, /const uploadHistoryPageSize = 15/);
	assert.match(historySource, /data-uh-load-more/);
	assert.match(historySource, /batch = preflight\.batch \|\| \{\}/);
	assert.doesNotMatch(historySource, /const \[batchResp, preflightResp\]/);
	assert.match(routesSource, /const classificationPromise = classifyBatchDrift/);
	assert.match(routesSource, /const valueDriftPromise = classifyValueDrift/);
	assert.match(routesSource, /Promise\.all\(\[cascadePromise, valueDriftPromise\]\)/);
	assert.match(routesSource, /preUploadCapturedAt:/);
	assert.match(routesSource, /deletedCount:/);
});
