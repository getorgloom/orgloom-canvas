import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const menuSource = fs.readFileSync(path.resolve(here, '../src/public/js/canvas-card-menu.js'), 'utf8');
const appSource = fs.readFileSync(path.resolve(here, '../src/public/js/app.js'), 'utf8');
const recordsSource = fs.readFileSync(path.resolve(here, '../src/public/js/records-canvas.js'), 'utf8');
const toolbarSource = fs.readFileSync(path.resolve(here, '../src/public/js/bulk-toolbar.js'), 'utf8');
const bulkMenuSource = fs.readFileSync(path.resolve(here, '../src/public/js/bulk-ops-menu.js'), 'utf8');
const shareSource = fs.readFileSync(path.resolve(here, '../src/public/js/canvas-share.js'), 'utf8');
const routeSource = fs.readFileSync(path.resolve(here, '../src/canvas-routes.js'), 'utf8');
const cssSource = fs.readFileSync(path.resolve(here, '../src/public/css/app.css'), 'utf8');
const templatesSource = fs.readFileSync(path.resolve(here, '../src/public/js/templates.js'), 'utf8');
const saveLoadSource = fs.readFileSync(path.resolve(here, '../src/public/js/canvas-save-load.js'), 'utf8');
const taskSidebarSource = fs.readFileSync(path.resolve(here, '../src/public/js/shared-task-sidebar.js'), 'utf8');

test('record and field requests have distinct owner actions', () => {
	assert.match(menuSource, /data-card-action="configure-slot"/);
	assert.match(menuSource, /Configure .*field request.*record request/s);
	assert.doesNotMatch(menuSource, /data-card-action="to-slot"/);
	assert.match(menuSource, /Request fields on this /);
	assert.match(bulkMenuSource, /data-add-menu="request"/);
	assert.match(bulkMenuSource, /Request a record/);
	assert.match(toolbarSource, />\+ Add records<\/button>/);
	assert.match(menuSource, /Only the canvas owner can change this request/);
	assert.match(menuSource, /Convert to draft/);
	assert.match(menuSource, /Convert this record request to a draft/);
});

test('whole-record requests are standalone while drafts and existing records use field requests', () => {
	assert.match(appSource, /async function createStandaloneRecordRequest/);
	assert.match(appSource, /origin: 'standalone'/);
	assert.match(appSource, /const permissionName = rec && rec\.loadedFromId \? 'updateable' : 'createable'/);
	assert.doesNotMatch(appSource, /Field requests only apply to records loaded from Salesforce/);
	assert.doesNotMatch(templatesSource, /recObj\.slot\.kind = 'whole-record'/);
});

test('slot configuration preserves identity and supports fields, copy, and reassignment', () => {
	assert.match(appSource, /const slotId = rec\.slot\.slotId;/);
	assert.match(appSource, /rec\.slot = \{\s*slotId,/s);
	assert.match(appSource, /rec\.slot\.fields = config\.fields\.slice\(\)/);
	assert.match(menuSource, /data-slot-field-search/);
	assert.match(menuSource, /selectedFields\.has\(field\.name\)/);
	assert.match(menuSource, /picker\.setPicked\(\{/);
	assert.doesNotMatch(menuSource, /Save the canvas after this change to publish/);
	assert.match(menuSource, /Fields to complete/);
	assert.match(menuSource, /The teammate can update only the fields selected here/);
	assert.match(menuSource, /Instructions for the contributor/);
	assert.match(menuSource, /label: automaticLabel/);
	assert.match(menuSource, /slot-config-title-icon--/);
	assert.match(menuSource, /fieldMode \? '&#9998;' : '&#43;'/);
	assert.doesNotMatch(menuSource, /id="slot-config-label"/);
	assert.doesNotMatch(menuSource, />Request details</);
	assert.doesNotMatch(menuSource, />Request name/);
	assert.doesNotMatch(menuSource, /slot-config-kind/);
	assert.doesNotMatch(menuSource, /slot-config-intro/);
	assert.match(menuSource, /Save ' \+\s*\(fieldMode \? 'field request' : 'record request'\)/s);
	assert.match(appSource, /Request fields on ' \+ _slotRecordDisplayName\(rec\)/);
	assert.match(appSource, /Request a new ' \+ \(rec\.label \|\| rec\.objectName\)/);
	assert.match(shareSource, /setPicked\(user\)/);
});

test('slot assignment flags teammates who cannot complete the request', () => {
	assert.match(menuSource, /data-slot-assignee-access/);
	assert.match(menuSource, /currently has Viewer access and cannot complete this request/);
	assert.match(menuSource, /Assigning the request does not share the canvas/);
	assert.match(menuSource, /Change to Contributor/);
	assert.match(menuSource, /Share as Contributor/);
	assert.match(menuSource, /role: 'contributor'/);
	assert.match(menuSource, /\/share-links/);
	assert.match(menuSource, /\/direct-share/);
	assert.match(menuSource, /can complete this request with/);
	assert.match(menuSource, /A record request must be completed by another canvas recipient/);
	assert.match(menuSource, /Choose another teammate for this record request/);
	assert.match(cssSource, /\.slot-assignee-access--warning/);
	assert.match(cssSource, /\.slot-assignee-access--success/);
});

test('canvas cards distinguish record requests from field requests', () => {
	assert.match(recordsSource, /record-card--record-request/);
	assert.match(recordsSource, /record-card--field-request/);
	assert.match(recordsSource, />RECORD REQUEST/);
	assert.match(recordsSource, />record request<\/span>/);
	assert.match(recordsSource, /' field' \+.*' requested<\/span>'/s);
	assert.match(recordsSource, />Fill request<\/button>/);
	assert.doesNotMatch(recordsSource, /\\u2197 Use existing<\/button>/);
	assert.doesNotMatch(recordsSource, /record-card--action-required/);
	assert.doesNotMatch(recordsSource, /slotProgressBadge/);
	assert.match(taskSidebarSource, /' of ' \+\s*progress\.total \+\s*' fields complete'/s);
	assert.match(toolbarSource, /sp\.total === 0 \|\| sp\.recipientMode/);
});

test('viewer record requests are concise and non-actionable', () => {
	assert.match(recordsSource, /const canCompleteRequest = contributorTask/);
	assert.match(recordsSource, /const ctas =\s*!canCompleteRequest\s*\? ''/);
	assert.match(recordsSource, /canEditStructure\s*\? '<button class="record-delete"/);
	assert.doesNotMatch(recordsSource, /record-slot-desc/);
	assert.match(recordsSource, /'Create ' \+\s*article \+\s*' ' \+\s*escapeHtml\(objectNoun\)/s);
	assert.match(
		appSource,
		/_canvasShareRole = data\.recipientRole[^;]*;\s*renderShareRecipientBanner\(\);\s*renderBulkView\(\)/s,
	);
});

test('shared canvas loads fail closed before the first card render', () => {
	assert.match(
		templatesSource,
		/const loadingCanvasShareRole =\s*opts\.ownedByMe === false \? opts\.recipientRole \|\| 'viewer' : null/,
	);
	assert.match(templatesSource, /canvasState\._renderCanvasShareRole = loadingCanvasShareRole;/);
	assert.match(
		appSource,
		/function _getCanvasShareRole\(\)[\s\S]*current && current\.id && !current\.ownedByMe[\s\S]*current\.recipientRole \|\| 'viewer'/,
	);
	assert.match(appSource, /_canvasShareRole = role;\s*canvasState\._renderCanvasShareRole = role;/s);
	assert.match(appSource, /ownedByMe: !!data\.ownedByMe,\s*recipientRole: data\.recipientRole \|\| null,/s);
	assert.match(saveLoadSource, /ownedByMe: !!td\.ownedByMe,\s*recipientRole: td\.recipientRole \|\| null,/s);
});

test('session-restored viewer access is applied before the startup render', () => {
	assert.match(
		appSource,
		/const _restored =[\s\S]*if \(\s*_restored &&[\s\S]*!canvasState\.currentCanvas\.ownedByMe[\s\S]*_canvasShareRole = canvasState\.currentCanvas\.recipientRole \|\| 'viewer';[\s\S]*renderShareRecipientBanner\(\);[\s\S]*renderAll\(\);/,
	);
});

test('shared tasks replace persistent contributor card status styling', () => {
	assert.doesNotMatch(recordsSource, /record-card--action-required/);
	assert.doesNotMatch(recordsSource, /record-card--request-complete/);
	assert.doesNotMatch(recordsSource, /record-card--request-blocked/);
	assert.match(taskSidebarSource, /isOwner \? 'Requests' : 'Your tasks'/);
	assert.match(taskSidebarSource, /Contributor access required/);
	assert.match(taskSidebarSource, /Blocked by Salesforce permissions/);
	assert.match(taskSidebarSource, /kind === 'fields' \? 'Fill in fields' : 'Add a record'/);
	assert.match(taskSidebarSource, /shared-task--fields/);
	assert.match(taskSidebarSource, /shared-task--record/);
	assert.match(taskSidebarSource, /shared-task-instructions/);
	assert.doesNotMatch(taskSidebarSource, /Next task/);
	assert.doesNotMatch(cssSource, /\.shared-task-next/);
	assert.match(recordsSource, /Salesforce access required/);
	assert.doesNotMatch(recordsSource, />Waiting<\/span>/);
	assert.doesNotMatch(recordsSource, /record-slot-warn/);
	assert.match(cssSource, /\.shared-task-sidebar\s*\{/);
	assert.match(cssSource, /\.slot-config-title-icon--fields\s*\{/);
	assert.match(cssSource, /\.slot-config-title-icon--record\s*\{/);
	assert.match(cssSource, /\.field\.field--task-focus\s*\{/);
	assert.match(appSource, /id="shared-task-sidebar"/);
	assert.match(appSource, /window\.OrgLoom\.sharedTaskSidebar\.mount/);
	assert.match(appSource, /const showingSharedTasks = _renderSharedTaskSidebar\(\)/);
});

test('stale recipients receive actionable configuration-change guidance', () => {
	assert.match(routeSource, /error: 'slot-configuration-changed'/);
	assert.match(routeSource, /Reload the canvas before entering the values again/);
	assert.match(appSource, /data && \(data\.message \|\| data\.error\)/);
});
