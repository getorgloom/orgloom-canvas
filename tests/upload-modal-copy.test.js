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
const context = { window: { OrgLoom: {} } };
vm.runInNewContext(source, context);
const uploadModal = context.window.OrgLoom.uploadModal;

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

test('successful upload immediately publishes its reconciled canvas state', () => {
	assert.match(
		source,
		/reconcileSyncedRecords\(canvasState\.bulkRecords, synced, canonicalValues\);[\s\S]*?publishPresenceChanges\(\);[\s\S]*?flushAutosave\(\);/,
	);
	assert.match(appSource, /publishPresenceChanges: function \(\) \{[\s\S]*?_publishPresenceChanges\(\)/);
	assert.match(appSource, /flushAutosave: function \(\) \{[\s\S]*?_autosaveFlush\(\)/);
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

test('upload summary distinguishes excluded canvas items from uploadable records', () => {
	assert.match(source, /<strong>Not included:<\/strong>/);
	assert.match(source, /Finish or remove these canvas items before uploading them/);
	assert.match(source, /Requested fields are still incomplete/);
});

test('upload preflight summary uses one user-facing total', () => {
	assert.match(source, /<span>Total records<\/span>/);
	assert.match(source, /const totalRecords = willUploadCount \+ willDeleteCount/);
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
	assert.match(summary.message, /another tab does not restore the connection/);
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

test('upload modal backdrop cannot accidentally dismiss upload review', () => {
	assert.match(source, /'<div class="modal-overlay"><\/div>'/);
	assert.doesNotMatch(source, /'<div class="modal-overlay" data-upload-close><\/div>'/);
});

test('org approval copy prefers the server explanation', () => {
	const serverMessage = 'Org Loom automatically created an access request for this non-production Salesforce org.';
	assert.equal(uploadModal.approvalRequiredMessage({ message: serverMessage }), serverMessage);
});

test('an org switch stops the upload with recovery guidance', () => {
	assert.match(source, /Salesforce org changed/);
	assert.match(source, /active-org-changed/);
	assert.match(source, /reopen Quick Upload to remap/i);
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

test('client preflight distinguishes the field label from its API name', () => {
	assert.match(
		source,
		/escapeHtml\(iss\.fieldLabel\)\s*\+\s*' \(<code>'\s*\+\s*escapeHtml\(iss\.field\)\s*\+\s*'<\/code>\)/,
	);
});

test('cross-org ambiguity is a hard upload gate', () => {
	assert.match(source, /r\._migrateMatchAmbiguous && !r\._migrateMatchResolution/);
	assert.match(source, /Decide the destination action for every record before uploading/);
	assert.match(source, /Two canvas records cannot update the same destination record/);
});

test('deterministic validation failure retires the rolled-back attempt token', () => {
	assert.match(source, /function renderPreflightFailure\(pf\) \{[\s\S]*?_uploadAttemptId = null;/);
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
	assert.match(historySource, /_executeRecall\(batchId, overlay, skipSfIds, revertSelections, restoreHistoryList\)/);
	assert.match(
		historySource,
		/async function _executeRecall\(batchId, overlay, skipSfIds, revertSelections, restoreHistoryList\)/,
	);
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
