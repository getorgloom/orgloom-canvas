import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/public/js/upload-modal.js', import.meta.url), 'utf8');
const globals = { window: { OrgLoom: {} } };
vm.runInNewContext(source, globals);
const api = globals.window.OrgLoom.uploadModal;
vm.runInNewContext(fs.readFileSync(new URL('../src/public/js/preflight.js', import.meta.url), 'utf8'), globals);

function setup(records, issues = []) {
	function element() {
		const classes = new Set();
		return {
			classes,
			innerHTML: '',
			textContent: '',
			style: {},
			hidden: false,
			classList: {
				add: (...names) => names.forEach((name) => classes.add(name)),
				remove: (...names) => names.forEach((name) => classes.delete(name)),
				toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
			},
			removeAttribute(name) {
				delete this[name];
			},
			querySelector: () => null,
			querySelectorAll: () => [],
		};
	}
	const content = element(),
		confirm = element(),
		cancel = element(),
		title = element(),
		summary = element();
	const modal = element();
	modal.querySelector = (selector) =>
		({
			'#upload-modal-content': content,
			'#upload-confirm': confirm,
			'#upload-cancel': cancel,
			'#upload-modal-title': title,
			'#upload-result-summary': summary,
		})[selector];
	const noop = () => {};
	const state = {
		...api,
		_fixTasks: null,
		window: {},
		document: { getElementById: () => null },
		uploadModal: modal,
		_uploadScopeSelected: false,
		_describeLoadFailures: [],
		_recordAccessLoadFailure: null,
		canvasState: {
			bulkRecords: records,
			bulkSelectedIds: new Set(),
			bulkAssociations: [],
			describeCache: {
				Account: { label: 'Account', fields: [] },
				Contact: { label: 'Contact', fields: [] },
				Case: { label: 'Case', fields: [] },
			},
		},
		deps: { openRecordForCurrentUser: noop },
		escapeHtml: (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
		recordOrdinal: (record) => records.indexOf(record) + 1,
		isRecordPendingDelete: (record) => !!(record.loadedFromId && record.pendingDelete),
		isRecordModified: (record) => !!record.modified,
		encryptedFields: { hasProposal: () => false, unresolvedIntentNames: () => [] },
		validateBulkRecords: () => ({
			issues,
			byRecordId: new Map(
				records
					.map((record) => [record.id, issues.filter((issue) => issue.recordId === record.id)])
					.filter(([, values]) => values.length),
			),
			missingDescribes: new Set(),
		}),
		computeUploadOrder: () => ({ cycleIds: new Set() }),
		_recordAccessExclusions: () => [],
		_scopedExcludedDraftParentLinks: () => [],
		_scopedRealRecords: () =>
			api.scopeUploadRecords(records, state.canvasState.bulkSelectedIds, state._uploadScopeSelected),
		confirmUpload: noop,
		openUploadModal: noop,
		closeUploadModal: noop,
	};
	const summaryStart = source.indexOf('function _renderUploadModalSummary(');
	vm.runInNewContext(source.slice(summaryStart, source.indexOf('function closeUploadModal(', summaryStart)), state);
	const helperStart = source.indexOf('function uploadResultIdentityHtml(');
	vm.runInNewContext(
		source.slice(helperStart, source.indexOf('function _clearCommittedMigrationMatch(', helperStart)),
		state,
	);
	return { state, content, confirm, cancel, title, summary, modal, render: () => state._renderUploadModalSummary() };
}

test('sidebar validation reuses local rules in a fixed scope without changing the upload dialog', () => {
	const issue = {
		recordId: 'a',
		objectName: 'Account',
		field: 'Name',
		severity: 'error',
		message: 'Required field is empty.',
	};
	const env = setup(
		[
			{ id: 'a', objectName: 'Account' },
			{ id: 'c', objectName: 'Contact' },
		],
		[issue],
	);
	env.content.innerHTML = 'Existing results';
	env.title.textContent = 'Upload results';
	env.state._uploadScopeSelected = true;
	const check = env.state._renderUploadModalSummary({ checkOnly: true, recordIds: new Set(['a']) });
	assert.equal(check.issues.length, 1);
	assert.equal(check.issues[0].field, 'Name');
	assert.equal(env.content.innerHTML, 'Existing results');
	assert.equal(env.title.textContent, 'Upload results');
	assert.equal(env.state._uploadScopeSelected, true);
	const otherCheck = env.state._renderUploadModalSummary({ checkOnly: true, recordIds: new Set(['c']) });
	assert.equal(otherCheck.issues.length, 0);
});

test('blocking review passes all actionable issues to Fix sidebar without activating it', () => {
	const issue = {
		recordId: 'a',
		objectName: 'Account',
		field: 'Name',
		severity: 'error',
		message: 'Required field is empty.',
	};
	const env = setup([{ id: 'a', objectName: 'Account' }], [issue]);
	const presented = [];
	env.state._fixTasks = { present: (...args) => presented.push(args) };
	env.render();
	assert.equal(presented[0][0][0], issue);
	assert.equal(presented[0][1], 'local');
	assert.deepEqual([...presented[0][2]], ['a']);
	assert.match(env.content.innerHTML, /data-upload-fix="true"/);
});

test('clean review summarizes writes separately from deletes and labels its destructive action', () => {
	const env = setup([
		{ id: 'a', objectName: 'Account', values: { Name: 'Acme' } },
		{ id: 'c', objectName: 'Contact', loadedFromId: '003existing', modified: true },
		{ id: 'd', objectName: 'Case', loadedFromId: '500delete', pendingDelete: true },
		{ id: 'u', objectName: 'Account', loadedFromId: '001unchanged' },
	]);
	assert.equal(env.render(), true);
	assert.equal(env.title.textContent, 'Upload to Salesforce');
	assert.match(env.content.innerHTML, /<strong>2<\/strong> records ready to write/);
	assert.match(env.content.innerHTML, /1 new/);
	assert.match(env.content.innerHTML, /1 update/);
	assert.match(env.content.innerHTML, /1 deletion runs last/);
	assert.match(env.content.innerHTML, /1 Case/);
	assert.doesNotMatch(env.content.innerHTML, /unchanged records? skipped|upload-skipped-note/);
	assert.doesNotMatch(env.content.innerHTML, /Must fix|Pre-flight passed|Records included/);
	assert.equal(env.confirm.textContent, 'Upload & delete 1');
	assert.equal(env.confirm.disabled, false);
	assert.equal(env.confirm.classes.has('confirm-danger'), true);
});

test('blocking issues group by category, hide counts and deletion actions, and disable upload', () => {
	const records = [
		{ id: 'a', objectName: 'Contact', values: { LastName: '<Test>' } },
		{ id: 'b', objectName: 'Contact' },
		{ id: 'd', objectName: 'Account', loadedFromId: '001delete', pendingDelete: true },
	];
	const issues = [
		{
			recordId: 'a',
			objectName: 'Contact',
			field: 'LastName',
			fieldLabel: 'Last Name',
			severity: 'error',
			message: 'Required field is empty.',
		},
		{
			recordId: 'b',
			objectName: 'Contact',
			field: 'LastName',
			fieldLabel: 'Last Name',
			severity: 'error',
			message: 'Required field is empty.',
		},
		{
			recordId: 'd',
			objectName: 'Account',
			field: '(cascade)',
			fieldLabel: 'Draft relationship',
			severity: 'error',
			message: '2 drafts depend on this record. Unmark this delete.',
		},
	];
	const env = setup(records, issues);
	assert.equal(env.render(), false);
	assert.equal(env.title.textContent, 'Fix before uploading');
	assert.match(env.content.innerHTML, /3 issues block this upload/);
	assert.equal((env.content.innerHTML.match(/class="upload-fix-group" open/g) || []).length, 2);
	assert.match(env.content.innerHTML, /2 records<\/span>/);
	assert.match(env.content.innerHTML, /data-upload-focus-field="LastName"/);
	assert.doesNotMatch(env.content.innerHTML, /<Test>|upload-ready-count|upload-delete-summary/);
	assert.equal(env.confirm.disabled, true);
	assert.equal(env.confirm.onclick, null);
	assert.equal(env.confirm.textContent, 'Fix 3 to continue');
	issues.length = 0;
	assert.equal(env.render(), true);
	assert.equal(env.modal.classes.has('upload-fix-state'), false);
	assert.equal(env.confirm.disabled, false);
});

test('selected-only review excludes errors and records outside the selected scope', () => {
	const env = setup(
		[
			{ id: 'a', objectName: 'Account' },
			{ id: 'b', objectName: 'Contact' },
		],
		[{ recordId: 'b', severity: 'error', message: 'Required field is empty.' }],
	);
	env.state.canvasState.bulkSelectedIds.add('a');
	env.state._uploadScopeSelected = true;
	assert.equal(env.render(), true);
	assert.match(env.content.innerHTML, /<strong>1<\/strong> record ready to write/);
	assert.doesNotMatch(env.content.innerHTML, /Required field is empty/);
});

test('blocking review hides scope controls and preserves the chosen upload scope', () => {
	for (const selectedOnly of [true, false]) {
		const env = setup(
			[
				{ id: 'a', objectName: 'Account' },
				{ id: 'b', objectName: 'Contact' },
			],
			[
				{ recordId: 'a', severity: 'error', message: 'Selected record error' },
				{ recordId: 'b', severity: 'error', message: 'Unselected record error' },
			],
		);
		env.state.canvasState.bulkSelectedIds.add('a');
		env.state._uploadScopeSelected = selectedOnly;
		assert.equal(env.render(), false);
		assert.doesNotMatch(env.content.innerHTML, /data-upload-scope/);
		assert.match(env.content.innerHTML, /Selected record error/);
		assert.equal(env.content.innerHTML.includes('Unselected record error'), !selectedOnly);
		assert.equal(env.state._uploadScopeSelected, selectedOnly);
	}
});

test('clean review hides scope controls and counts only the chosen upload scope', () => {
	for (const selectedOnly of [true, false]) {
		const env = setup([
			{ id: 'a', objectName: 'Account' },
			{ id: 'b', objectName: 'Contact' },
		]);
		env.state.canvasState.bulkSelectedIds.add('a');
		env.state._uploadScopeSelected = selectedOnly;
		assert.equal(env.render(), true);
		assert.doesNotMatch(env.content.innerHTML, /data-upload-scope|upload-scope-toggle/);
		assert.match(
			env.content.innerHTML,
			selectedOnly ? /<strong>1<\/strong> record ready/ : /<strong>2<\/strong> records ready/,
		);
		assert.equal(env.state._uploadScopeSelected, selectedOnly);
	}
});

test('delete-only review has no write table and failed access checks never show a ready count', () => {
	const env = setup([{ id: 'd', objectName: 'Account', loadedFromId: '001delete', pendingDelete: true }]);
	assert.equal(env.render(), true);
	assert.match(env.content.innerHTML, /record ready to delete/);
	assert.doesNotMatch(env.content.innerHTML, /upload-ready-objects/);
	assert.equal(env.confirm.textContent, 'Delete 1 record');
	env.state._recordAccessLoadFailure = new Error('Unavailable');
	assert.equal(env.render(), false);
	assert.doesNotMatch(env.content.innerHTML, /upload-ready-count|upload-delete-summary/);
	assert.equal(env.confirm.textContent, 'Retry access check');
});

test('upload confirmation revalidates local blockers before any network upload', () => {
	const start = source.indexOf('async function confirmUpload()');
	const end = source.indexOf('function uploadResultIdentityHtml(', start);
	const confirmSource = source.slice(start, end);
	assert.ok(confirmSource.indexOf('_renderUploadModalSummary() === false') < confirmSource.indexOf('csrfFetch('));
});

test('an empty upload shows no changes instead of a ready-to-delete count', () => {
	const env = setup([]);
	assert.equal(env.render(), false);
	assert.match(env.content.innerHTML, /No changes to upload/);
	assert.doesNotMatch(env.content.innerHTML, /records ready to delete/);
	assert.equal(env.confirm.style.display, 'none');
});

function linkedDraftReview() {
	const env = setup([
		{ id: 'case', objectName: 'Case', values: { Subject: 'Test' } },
		{ id: 'contact', objectName: 'Contact', values: { LastName: 'Test' } },
	]);
	const state = env.state.canvasState;
	state.bulkSelectedIds.add('case');
	state.bulkAssociations = [{ fromId: 'case', toId: 'contact', fieldName: 'ContactId' }];
	state.describeCache.Case.fields = [
		{ name: 'ContactId', label: 'Contact', type: 'reference', createable: true, required: false },
	];
	delete state.describeCache.Contact;
	env.state._uploadScopeSelected = true;
	env.state.validateBulkRecords = globals.window.OrgLoom.preflight.mount({
		canvasState: state,
		isRecordModified: () => false,
		recordOrdinal: () => 1,
	}).validateBulkRecords;
	env.state._scopedExcludedDraftParentLinks = () =>
		api.excludedDraftParentLinks(
			state.bulkRecords,
			state.bulkAssociations,
			new Set(env.state._scopedRealRecords().map((record) => record.id)),
			true,
		);
	return env;
}

test('selected Case ignores uncached metadata for an excluded draft Contact but retains the relationship warning', () => {
	const env = linkedDraftReview();
	assert.deepEqual([...env.state.validateBulkRecords().missingDescribes], ['Contact']);
	assert.equal(env.render(), true);
	assert.doesNotMatch(env.content.innerHTML, /Salesforce field information could not be loaded/);
	assert.match(env.content.innerHTML, /1<\/strong> record ready to write/);
	assert.match(env.content.innerHTML, /1 relationship points to an unselected draft/);
	assert.equal(env.state._uploadScopeSelected, true);
});

test('missing metadata still blocks when the draft Contact is included', () => {
	const env = linkedDraftReview();
	env.state._uploadScopeSelected = false;
	assert.equal(env.render(), false);
	assert.match(env.content.innerHTML, /could not pre-flight check Contact/);
	assert.equal(env.confirm.textContent, 'Retry pre-flight checks');
});

test('missing metadata for the selected Case still blocks upload', () => {
	const env = linkedDraftReview();
	delete env.state.canvasState.describeCache.Case;
	assert.equal(env.render(), false);
	assert.match(env.content.innerHTML, /could not pre-flight check Case\./);
	assert.doesNotMatch(env.content.innerHTML, /could not pre-flight check Contact/);
});
