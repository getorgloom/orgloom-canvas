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
	assert.match(e.host.innerHTML, /0 of 2 complete/);
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
	assert.match(e.host.innerHTML, /1 of 1 complete/);
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

test('fix state remains private to the sidebar and is never serialized into canvas storage', () => {
	assert.doesNotMatch(source, /localStorage|sessionStorage|csrfFetch|fetch\(|canvasState\.[\w]+\s*=/);
	const app = fs.readFileSync(new URL('../src/public/js/app.js', import.meta.url), 'utf8');
	const templates = fs.readFileSync(new URL('../src/public/js/templates.js', import.meta.url), 'utf8');
	const template = fs.readFileSync(new URL('../src/views/index.ejs', import.meta.url), 'utf8');
	assert.match(app, /async function startNewCanvas\(\)\s*{\s*_clearUploadFixes\(\)/);
	assert.match(app, /onCanvasReplace: \(\) => _clearUploadFixes\(\)/);
	assert.equal(templates.match(/deps\.onCanvasReplace\?\.\(\)/g).length, 2);
	assert.ok(template.indexOf('/js/upload-fixes-sidebar.js') < template.indexOf('/js/upload-modal.js'));
});
