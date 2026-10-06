import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/public/js/upload-fixes-sidebar.js', import.meta.url), 'utf8');
function setup() {
	const host = {
		hidden: true,
		innerHTML: '',
		dataset: {},
		querySelector: () => null,
		addEventListener: (name, handler) => {
			host[name] = handler;
		},
	};
	const globals = { window: {}, document: { getElementById: () => host } };
	vm.runInNewContext(source, globals);
	const record = { id: 'a', objectName: 'Account', values: { Name: '' } };
	const other = { id: 'c', objectName: 'Contact', values: { LastName: '' } };
	const issue = { recordId: 'a', objectName: 'Account', field: 'Name', message: 'Required field is empty.' };
	const otherIssue = { recordId: 'c', objectName: 'Contact', field: 'LastName', message: 'Required field is empty.' };
	const env = {
		host,
		record,
		other,
		issue,
		otherIssue,
		opened: [],
		dismissed: [],
		scopes: [],
		changes: 0,
		context: { canvas: null, connection: 'org1/user1' },
		state: { bulkRecords: [record, other], bulkAssociations: [] },
		check: { issues: [issue, otherIssue], missingDescribes: new Set() },
	};
	env.api = globals.window.OrgLoom.uploadFixesSidebar.mount({
		canvasState: env.state,
		escapeHtml: (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
		getContext: () => ({ ...env.context }),
		validateLocal: (ids) => {
			env.scopes.push([...ids]);
			return env.check;
		},
		hasUnsubmittedChanges: (record) => !!record.modified,
		openRecord: (record, options) => {
			env.opened.push({ record, options });
			return true;
		},
		recordTitle: (record) =>
			record.objectName + ' · ' + (record.values.Name || record.values.LastName || 'Unnamed'),
		onChange: () => {
			env.changes++;
		},
		onDismiss: (recordId, fields) => env.dismissed.push({ recordId, fields: Array.from(fields) }),
	});
	return env;
}

test('Fix opens the clicked field and lists every issue from the attempted scope', () => {
	const e = setup();
	e.api.present([e.issue, e.otherIssue], 'local', ['a', 'c']);
	assert.equal(e.api.render(), false, 'displaying validation alone does not open the sidebar');
	e.api.start('c', 'LastName');
	assert.equal(e.host.hidden, false);
	assert.equal(e.opened[0].record, e.other);
	assert.equal(e.opened[0].options.focusField, 'LastName');
	assert.equal(e.api.refresh().length, 2);
	assert.deepEqual(e.scopes.at(-1), ['a', 'c']);
	assert.match(e.host.innerHTML, /2 issues remaining/);
});

test('local completion uses validation, updates checkmarks, and reopens when invalid again', () => {
	const e = setup();
	e.api.present([e.issue], 'local', ['a']);
	e.api.start('a');
	e.record.values.Name = 'Fixed';
	assert.equal(e.api.refresh()[0].complete, false, 'editing alone is not validation');
	e.check.issues = [e.otherIssue];
	e.api.render();
	assert.equal(e.api.refresh()[0].complete, true);
	assert.match(e.host.innerHTML, /0 issues remaining/);
	assert.match(e.host.innerHTML, /Check passed/);
	assert.equal(e.api.refresh()[0].status, 'Check passed');
	assert.match(e.host.innerHTML, /✓/);
	e.check.issues = [{ ...e.issue, message: 'A different error in the same field' }];
	assert.equal(e.api.refresh()[0].complete, false);
});

test('editor guidance includes unresolved fields only from the clicked record', () => {
	const e = setup();
	e.check.issues = [e.issue, { ...e.issue, field: 'Phone' }, e.otherIssue];
	e.api.present(e.check.issues, 'local', ['a', 'c']);
	e.api.start('a', 'Name');
	assert.deepEqual(Array.from(e.opened[0].options.uploadFixFields), ['Name', 'Phone']);
	e.api.openTask('3');
	assert.deepEqual(Array.from(e.opened[1].options.uploadFixFields), ['LastName']);
});

test('local validation failures, missing metadata, and access exclusions never falsely complete tasks', () => {
	const e = setup();
	e.api.present([e.issue], 'local', ['a']);
	e.api.start('a');
	e.check.issues = [];
	e.check.missingDescribes.add('Account');
	assert.equal(e.api.refresh()[0].complete, false);
	e.check.missingDescribes.clear();
	e.check.blocked = true;
	assert.equal(e.api.refresh()[0].status, 'Unable to verify yet');
	e.check.blocked = false;
	e.check.accessExcludedIds = new Set(['a']);
	assert.equal(e.api.refresh()[0].status, 'Blocked by Salesforce permissions');
	assert.equal(e.api.openTask('1'), false);
	e.check = null;
	assert.equal(e.api.refresh()[0].complete, false);
});

test('Salesforce tasks require a successful retry; unrelated edits and skipped rows do not verify', () => {
	const e = setup();
	e.api.present([{ ...e.issue, fields: ['Name'] }], 'salesforce', ['a']);
	e.api.start('a');
	e.record.values.Phone = '123';
	assert.equal(e.api.refresh()[0].status, 'Needs attention');
	e.record.values.Name = 'Fixed';
	assert.equal(e.api.refresh()[0].status, 'Changed');
	e.api.recordResults([{ tempId: 'a', success: true, mode: 'unchanged' }]);
	assert.equal(e.api.refresh()[0].complete, false);
	e.api.recordResults([{ tempId: 'a', success: false }]);
	assert.equal(e.api.refresh()[0].complete, false);
	e.api.recordResults([{ tempId: 'a', success: true, mode: 'insert' }]);
	assert.equal(e.api.refresh()[0].complete, true);
	e.record.values.Name = 'Another edit';
	assert.equal(e.api.refresh()[0].status, 'Changed');
});

test('unverified edits use a neutral pencil without a visible status line', () => {
	const e = setup();
	e.api.present([e.issue], 'salesforce', ['a']);
	e.api.start('a');
	e.record.values.Name = 'Edited';
	e.api.render();
	assert.match(e.host.innerHTML, /upload-fix--changed/);
	assert.match(e.host.innerHTML, /aria-label="Edited, not yet verified"/);
	assert.match(e.host.innerHTML, /<svg/);
	assert.doesNotMatch(e.host.innerHTML, /shared-task-status|Changed—retry to verify|✓/);
	assert.equal(e.api.refresh()[0].complete, false);
	e.record.values.Name = '';
	e.api.render();
	assert.doesNotMatch(e.host.innerHTML, /upload-fix--changed|<svg/);
	assert.match(e.host.innerHTML, />!<\/span>/);
	e.record.values.Name = 'Fixed';
	e.api.recordResults([{ tempId: 'a', success: true, mode: 'insert' }]);
	e.api.render();
	assert.match(e.host.innerHTML, /✓/);
	assert.doesNotMatch(e.host.innerHTML, /upload-fix--changed|<svg/);
});

test('edits made during an upload remain unverified after the response', () => {
	const e = setup();
	e.api.present([e.issue], 'salesforce', ['a']);
	e.api.start('a');
	e.record.values.Name = 'Newer value';
	e.record.modified = true;
	e.api.recordResults([{ tempId: 'a', success: true, mode: 'update' }]);
	assert.equal(e.api.refresh()[0].complete, false);
	assert.equal(e.api.refresh()[0].status, 'Changed');
});

test('Salesforce record-level errors open without invented field focus and detect relationship edits', () => {
	const e = setup();
	e.api.present([{ recordId: 'a', message: 'Salesforce validation rule failed.' }], 'salesforce', ['a']);
	e.api.start('a');
	assert.equal(e.opened[0].options.focusField, undefined);
	e.state.bulkAssociations.push({ fromId: 'a', toId: 'c', fieldName: 'ParentId' });
	assert.equal(e.api.refresh()[0].status, 'Changed');
});

test('successful deletion completes a task; merely removing its card does not', () => {
	for (const source of ['local', 'salesforce']) {
		const e = setup();
		e.api.present([e.issue], source, ['a']);
		e.api.start('a');
		e.state.bulkRecords = [e.other];
		assert.equal(e.api.refresh()[0].complete, false);
		e.api.recordResults([], [{ tempId: 'a', success: true }]);
		assert.equal(e.api.refresh()[0].complete, true);
	}
});

test('repeated errors are deduplicated and a later Salesforce failure resets confirmation', () => {
	const e = setup();
	e.api.present([e.issue], 'salesforce', ['a']);
	e.api.start('a');
	e.api.recordResults([{ tempId: 'a', success: true }]);
	assert.equal(e.api.refresh()[0].complete, true);
	e.api.present([e.issue], 'salesforce', ['a']);
	assert.equal(e.api.refresh().length, 1);
	assert.equal(e.api.refresh()[0].complete, false);
});

test('a failed parent delete is not completed by an update or a child delete attempt', () => {
	const e = setup();
	const issue = { recordId: 'a', operation: 'delete', message: 'Cannot delete while child records exist.' };
	e.api.present([issue], 'salesforce', ['a']);
	e.api.start('a');
	e.other.pendingDelete = true;
	e.api.recordResults([{ tempId: 'a', success: true, mode: 'update' }], [{ tempId: 'c', success: false }]);
	assert.equal(e.api.refresh()[0].complete, false, 'an update of the parent is not a successful delete');
	e.api.recordResults([], [{ tempId: 'c', success: true }]);
	assert.equal(e.api.refresh()[0].complete, false, 'even deleting the child does not verify the parent delete');
	e.api.recordResults([], [{ tempId: 'a', success: false }]);
	assert.equal(e.api.refresh()[0].complete, false);
	e.state.bulkRecords = [e.other];
	e.api.recordResults([], [{ tempId: 'a', success: true }]);
	assert.equal(e.api.refresh()[0].complete, true);
});

test('write and delete errors for the same record remain separate tasks', () => {
	const e = setup();
	e.api.present(
		[
			{ ...e.issue, operation: 'write' },
			{ ...e.issue, operation: 'delete' },
		],
		'salesforce',
		['a'],
	);
	e.api.start('a');
	e.api.recordResults([{ tempId: 'a', success: true, mode: 'update' }]);
	assert.equal(e.api.refresh().length, 2);
	assert.equal(e.api.refresh().find((task) => task.operation === 'write').complete, true);
	assert.equal(e.api.refresh().find((task) => task.operation === 'delete').complete, false);
});

test('upload results preserve failed operations and pass failures to the fix tracker', () => {
	const uploadSource = fs.readFileSync(new URL('../src/public/js/upload-modal.js', import.meta.url), 'utf8');
	assert.match(uploadSource, /operation: deleteFailed\.includes\(result\) \? 'delete' : 'write'/);
	assert.match(uploadSource, /recordResults\(\[\.\.\.synced, \.\.\.failed\], deletesArr\)/);
});

test('failed delete responses and new errors invalidate earlier deletion confirmation', () => {
	for (const viaPresent of [false, true]) {
		const e = setup();
		const issue = { ...e.issue, operation: 'delete' };
		e.api.present([issue], 'salesforce', ['a']);
		e.api.start('a');
		e.state.bulkRecords = [e.other];
		e.api.recordResults([], [{ tempId: 'a', success: true }]);
		assert.equal(e.api.refresh()[0].complete, true);
		if (viaPresent) e.api.present([issue], 'salesforce', ['a']);
		else e.api.recordResults([], [{ tempId: 'a', success: false }]);
		assert.equal(e.api.refresh()[0].complete, false);
	}
});

test('changing canvas or connection clears tasks; first save preserves them', () => {
	const e = setup();
	e.api.present([e.issue], 'local', ['a']);
	e.api.start('a');
	e.context.canvas = 'saved1';
	assert.equal(e.api.render(), true);
	e.context.canvas = 'saved2';
	assert.equal(e.api.render(), false);
	e.api.present([e.issue], 'local', ['a']);
	e.api.start('a');
	e.context.connection = 'org2/user2';
	assert.equal(e.api.render(), false);
	assert.equal(e.api.start('a'), false);
});

test('sidebar supports collapse and dismissal and escapes untrusted error text', () => {
	const e = setup();
	e.api.present([{ ...e.issue, message: '<img src=x onerror=alert(1)>' }], 'local', ['a']);
	e.api.start('a');
	assert.doesNotMatch(e.host.innerHTML, /<img/);
	assert.match(e.host.innerHTML, /&lt;img/);
	const click = (selector) => e.host.click({ target: { closest: (value) => (value === selector ? {} : null) } });
	click('[data-upload-fixes-toggle]');
	assert.match(e.host.innerHTML, /aria-expanded="false"/);
	click('[data-upload-fixes-dismiss]');
	assert.equal(e.host.hidden, true);
	assert.equal(e.api.start('a'), false);
	assert.ok(e.changes >= 2);
});

test('inaccessible records conceal details and cannot be opened', () => {
	const e = setup();
	e.api.present([e.issue], 'local', ['a']);
	e.api.start('a');
	e.record._inaccessible = true;
	e.api.render();
	assert.doesNotMatch(e.host.innerHTML, /Required field is empty/);
	assert.equal(e.api.openTask('1'), false);
});

test('individual dismissal removes only that task without changing records or validation', () => {
	for (const source of ['local', 'salesforce']) {
		const e = setup();
		const phoneIssue = { ...e.issue, field: 'Phone', message: 'Phone is required.' };
		e.check.issues = [e.issue, phoneIssue, e.otherIssue];
		e.api.present(e.check.issues, source, ['a', 'c']);
		e.api.start('a');
		const before = JSON.stringify(e.state);
		e.host.click({
			target: {
				closest: (selector) =>
					selector === '[data-upload-fix-dismiss]' ? { dataset: { uploadFixDismiss: '1' } } : null,
			},
		});
		assert.equal(e.opened.length, 1, 'dismissing does not open or focus a record');
		assert.equal(e.api.refresh().length, 2);
		assert.equal(e.api.openTask('1'), false);
		assert.equal(JSON.stringify(e.state), before);
		assert.equal(e.check.issues.length, 3, 'validation still reports dismissed problems');
		assert.match(e.host.innerHTML, /2 issues remaining/);
		assert.deepEqual(e.dismissed[0], { recordId: 'a', fields: ['Phone'] });
		e.api.start('a', 'Phone');
		assert.equal(e.api.refresh().length, 2, 'reopening the current list does not restore dismissed tasks');
		e.api.present([e.issue], source, ['a']);
		assert.equal(e.api.refresh().length, 3, 'a later validation attempt can report the problem again');
	}
});

test('dismissing the last fix hides the sidebar and clears stale pending issues', () => {
	const e = setup();
	e.api.present([e.issue], 'local', ['a']);
	e.api.start('a');
	assert.equal(e.api.dismissTask('missing'), false);
	assert.equal(e.api.dismissTask('1'), true);
	assert.equal(e.host.hidden, true);
	assert.equal(e.host.innerHTML, '');
	assert.equal(e.api.start('a'), false);
	assert.deepEqual(e.dismissed[0], { recordId: 'a', fields: [] });
	e.api.present([e.issue], 'local', ['a']);
	assert.equal(e.api.start('a'), true);
});

test('completed and inaccessible fixes remain individually dismissible', () => {
	const e = setup();
	e.api.present([e.issue, e.otherIssue], 'local', ['a', 'c']);
	e.api.start('a');
	e.check.issues = [e.otherIssue];
	e.other._inaccessible = true;
	e.api.render();
	assert.match(e.host.innerHTML, /aria-label="Dismiss fix for Account/);
	assert.match(e.host.innerHTML, /aria-label="Dismiss fix for Unavailable record"/);
	assert.equal(e.api.dismissTask('1'), true);
	assert.match(e.host.innerHTML, /1 issue remaining/);
	assert.equal(e.api.dismissTask('2'), true);
	assert.equal(e.host.hidden, true);
});

test('fix state remains private to the sidebar and is never serialized into canvas storage', () => {
	assert.doesNotMatch(source, /localStorage|sessionStorage|csrfFetch|fetch\(|canvasState\.[\w]+\s*=/);
	const app = fs.readFileSync(new URL('../src/public/js/app.js', import.meta.url), 'utf8');
	const templates = fs.readFileSync(new URL('../src/public/js/templates.js', import.meta.url), 'utf8');
	const template = fs.readFileSync(new URL('../src/views/index.ejs', import.meta.url), 'utf8');
	assert.match(app, /async function startNewCanvas\(\)\s*{\s*_clearUploadFixes\(\)/);
	assert.match(app, /onCanvasReplace: \(\) =>\s*{\s*_clearUploadFixes\(\);\s*closeRecordEditors\(\);/);
	assert.equal(templates.match(/deps\.onCanvasReplace\?\.\(\)/g).length, 2);
	assert.ok(template.indexOf('/js/upload-fixes-sidebar.js') < template.indexOf('/js/upload-modal.js'));
});
