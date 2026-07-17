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

test('upload preflight summary uses one user-facing total', () => {
	assert.match(source, /<span>Total records<\/span>/);
	assert.doesNotMatch(source, /Records will upload in the order below/);
	assert.doesNotMatch(source, /<span>Will sync<\/span>/);
	assert.doesNotMatch(source, /Associations \(FK links\)/);
});

test('upload progress uses a plain object-aware record summary', () => {
	const describes = {
		Contact: { label: 'Contact', labelPlural: 'Contacts' },
		Account: { label: 'Account', labelPlural: 'Accounts' },
	};
	assert.equal(
		uploadModal.formatUploadProgress(
			[{ objectName: 'Contact' }, { objectName: 'Contact' }],
			describes,
		),
		'Uploading 2 Contacts…',
	);
	assert.equal(
		uploadModal.formatUploadProgress([{ objectName: 'Account' }], describes),
		'Uploading 1 Account…',
	);
	assert.equal(
		uploadModal.formatUploadProgress(
			[{ objectName: 'Account' }, { objectName: 'Contact' }],
			describes,
		),
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
	assert.match(source, /escapeHtml\(iss\.fieldLabel\) \+ ' \(<code>' \+ escapeHtml\(iss\.field\) \+ '<\/code>\)/);
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
	assert.match(appSource, /async function refreshCanvasAfterRecall\(\)[\s\S]*const loaded = canvasState\.bulkRecords\.filter/);
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
	assert.match(historySource, /data-uh-list[^\n]+restoreHistoryList\(body\.status\)/);
	assert.match(historySource, /updatedStatus === 'recalled'[\s\S]*?recallButton\.remove\(\)/);
	assert.doesNotMatch(historySource, /data-uh-list[^\n]+_renderUploadHistoryList/);
	assert.match(historySource, /const recallAction = hasPotentialRecallWork/);
	assert.match(historySource, /Nothing from this upload is available to recall/);
	assert.doesNotMatch(historySource, /Recall <span data-uh-recall-count>/);
});
