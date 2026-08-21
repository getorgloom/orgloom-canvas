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
const insertModalSource = fs.readFileSync(path.resolve(here, '../src/public/js/insert-modal.js'), 'utf8');

test('record and field requests have distinct owner actions', () => {
	assert.match(menuSource, /data-card-action="configure-slot"/);
	assert.match(menuSource, /Configure .*field request.*record request/s);
	assert.match(menuSource, /const canConfigureSlot = canEditCanvasStructure\(\) && _canAuthorSlots\(\)/);
	assert.doesNotMatch(menuSource, /data-card-action="to-slot"/);
	assert.match(menuSource, /Request fields on this /);
	assert.match(bulkMenuSource, /data-add-menu="request"/);
	assert.match(bulkMenuSource, /Request a record/);
	assert.match(toolbarSource, />\+ Add records<\/button>/);
	assert.match(menuSource, /Only the canvas owner or an editor can change this request/);
	assert.match(menuSource, /Convert to draft/);
	assert.match(menuSource, /Convert this record request to a draft/);
});

test('whole-record requests are standalone while drafts and existing records use field requests', () => {
	assert.match(appSource, /async function createStandaloneRecordRequest/);
	assert.match(appSource, /origin: 'standalone'/);
	assert.match(appSource, /const permissionName = rec && rec\.loadedFromId \? 'updateable' : 'createable'/);
	assert.match(appSource, /field\.name !== 'Id'/);
	assert.match(appSource, /String\(field\.type \|\| ''\)\.toLowerCase\(\) !== 'encryptedstring'/);
	assert.match(appSource, /!encryptedNames\.has\(name\)/);
	assert.match(menuSource, /String\(field\.type \|\| ''\)\.toLowerCase\(\) !== 'encryptedstring'/);
	assert.match(appSource, /!byName\.has\(name\)/);
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
	assert.match(menuSource, /name="slot-assignment-mode" value="specific"/);
	assert.match(menuSource, /name="slot-assignment-mode" value="any"/);
	assert.match(menuSource, /Choose who should complete this request/);
	assert.match(menuSource, /Choose a teammate for this request/);
	assert.match(menuSource, /hasSavedAssignmentChoice/);
	assert.match(menuSource, /changeLabel: 'Change teammate'/);
	assert.match(shareSource, /escapeHtml\(changeLabel\)/);
	assert.match(shareSource, /_picked = null;[\s\S]*input\.hidden = false;[\s\S]*runSearch\(''\)/);
	assert.match(appSource, /assigneeSfUserId: config\.assigneeSfUserId \|\| null/);
	assert.match(cssSource, /\.slot-assignment-option:has\(input:checked\)/);
	assert.doesNotMatch(menuSource, /id="slot-config-label"/);
	assert.doesNotMatch(menuSource, />Request details</);
	assert.doesNotMatch(menuSource, />Request name/);
	assert.doesNotMatch(menuSource, /slot-config-kind/);
	assert.doesNotMatch(menuSource, /slot-config-intro/);
	assert.match(menuSource, /Save ' \+\s*\(fieldMode \? 'field request' : 'record request'\)/s);
	assert.match(appSource, /Request fields on ' \+ _slotRecordDisplayName\(rec\)/);
	assert.match(appSource, /Request a new ' \+ \(rec\.label \|\| rec\.objectName\)/);
	assert.match(shareSource, /setPicked\(user\)/);
	assert.equal((menuSource.match(/excludeCurrentUser: true/g) || []).length, 2);
	assert.match(
		shareSource,
		/const users = \(\(data && data\.users\) \|\| \[\]\)\.filter\([\s\S]*!excludeCurrentUser[\s\S]*currentUserKey/,
	);
});

test('playground record requests can be assigned only to any contributor', () => {
	assert.match(menuSource, /const playgroundRecordRequest = !!window\.ORGLOOM_MOCK && !fieldMode/);
	assert.match(menuSource, /const initialAssignmentMode = playgroundRecordRequest\s*\? 'any'/);
	assert.match(menuSource, /const specificAssignmentOption = playgroundRecordRequest\s*\? ''/);
	assert.match(menuSource, /Demo record requests are available to any contributor\./);
});

test('opening an owner record request shows its response with configuration available separately', () => {
	assert.match(appSource, /function openRecordForCurrentUser\(rec, options\)/);
	assert.doesNotMatch(appSource, /if \(!shareRole\) \{[\s\S]*configureExistingSlot\(rec\)/);
	assert.match(appSource, /openInsertModal\(rec\.objectName, Object\.assign\(\{ record: rec \}/);
	assert.match(insertModalSource, /id="modal-configure-request"/);
	assert.match(
		insertModalSource,
		/const configurableRecordRequest = !!\(\s*canEditCanvasStructure\(\)[\s\S]*\(record\.slot\.kind \|\| 'whole-record'\)/,
	);
	assert.match(insertModalSource, /configureBtn\.hidden = !configurableRecordRequest \|\| !configureRequest/);
	assert.match(insertModalSource, /closeModal\(\);\s*void configureRequest\(record\);/);
	assert.match(appSource, /configureRequest: function \(record\) \{\s*return configureExistingSlot\(record\);/);
	assert.match(recordsSource, /const openRecord = deps\.openRecord/);
	assert.equal((recordsSource.match(/openRecord\(rec\);/g) || []).length, 2);
	assert.doesNotMatch(recordsSource, /openRecord\(rec\.objectName/);
	assert.match(appSource, /window\.OrgLoom\.recordsCanvas\.mount\(\{[\s\S]*openRecord: function \(\)/);
	assert.match(menuSource, /picker\.setPicked\(\{[\s\S]*id: initial\.assigneeSfUserId/);
	assert.match(menuSource, /changeLabel: 'Change teammate'/);
	assert.match(appSource, /renderBulkView\(\);\s*_publishPresenceChanges\(\);/);
});

test('canvas editors can update existing record and field requests', () => {
	const configureStart = appSource.indexOf('async function configureExistingSlot');
	const configureEnd = appSource.indexOf('function convertSlotBackToRecord', configureStart);
	const configureSource = appSource.slice(configureStart, configureEnd);

	assert.ok(configureStart >= 0 && configureEnd > configureStart);
	assert.match(configureSource, /if \(!_canEditCanvasStructure\(\)\)/);
	assert.match(configureSource, /Only the canvas owner or an editor can change contributor requests/);
	assert.doesNotMatch(configureSource, /!canvasState\.currentCanvas\.ownedByMe/);
	assert.match(configureSource, /_publishPresenceChanges\(\)/);
});

test('slot assignment flags teammates who cannot complete the request', () => {
	assert.match(menuSource, /data-slot-assignee-access/);
	assert.match(menuSource, /currently has Viewer access\. Contributor access is required/);
	assert.match(menuSource, /does not have access to this canvas\. Contributor access is required/);
	assert.doesNotMatch(menuSource, /Change to Contributor/);
	assert.doesNotMatch(menuSource, /Share as Contributor/);
	assert.doesNotMatch(menuSource, /slot-assignee-access-action/);
	assert.match(menuSource, /title: 'Contributor access required'/);
	assert.match(menuSource, /confirmLabel: 'Grant access and assign'/);
	assert.match(menuSource, /cancelLabel: 'Back'/);
	assert.match(menuSource, /saveButton\.textContent = 'Checking access\.\.\.'/);
	assert.match(menuSource, /saveButton\.textContent = 'Granting access\.\.\.'/);
	assert.doesNotMatch(menuSource, /â€¦|â€™/);
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
	assert.match(recordsSource, /const showRequestContext = shareRole !== 'viewer'/);
	assert.match(recordsSource, /slotKind && showRequestContext \? _slotRequestBadgeHtml\(rec\) : ''/);
	assert.equal(
		(recordsSource.match(/const requestBadge = shareRole === 'viewer' \? '' : _slotRequestBadgeHtml\(rec\)/g) || [])
			.length,
		1,
	);
	assert.match(recordsSource, />RECORD REQUEST/);
	assert.doesNotMatch(recordsSource, /record-slot-badge/);
	assert.match(recordsSource, />Fill request<\/button>/);
	assert.doesNotMatch(recordsSource, /\\u2197 Use existing<\/button>/);
	assert.doesNotMatch(recordsSource, /record-card--action-required/);
	assert.doesNotMatch(recordsSource, /slotProgressBadge/);
	assert.match(taskSidebarSource, /unavailableFieldCount > 0.*: ' fields complete'/s);
	assert.match(toolbarSource, /sp\.total === 0 \|\| sp\.recipientMode/);
});

test('viewer record requests are concise and non-actionable', () => {
	assert.match(
		recordsSource,
		/const canCompleteRequest = !shareRole \|\| shareRole === 'editor' \|\| contributorTask/,
	);
	assert.match(recordsSource, /const ctas =\s*!canCompleteRequest\s*\? ''/);
	assert.match(recordsSource, /canEditStructure\s*\? '<button class="record-delete"/);
	assert.doesNotMatch(recordsSource, /record-slot-desc/);
	assert.match(recordsSource, /const requestTitle = 'Create ' \+ article \+ ' ' \+ objectNoun/);
	assert.match(recordsSource, /escapeHtml\(requestTitle\)/);
	assert.doesNotMatch(recordsSource, /<div class="record-slot-type">/);
	assert.match(
		appSource,
		/_canvasShareRole = data\.recipientRole[^;]*;\s*renderShareRecipientBanner\(\);\s*renderBulkView\(\)/s,
	);
});

test('canvas owners and editors can fill a record request as an override', () => {
	const fillStart = appSource.indexOf('function fillSlotWithBlank');
	const fillEnd = appSource.indexOf('async function runWithConcurrency', fillStart);
	const fillSource = appSource.slice(fillStart, fillEnd);

	assert.ok(fillStart >= 0 && fillEnd > fillStart);
	assert.match(fillSource, /!shareRole \|\|\s*shareRole === 'editor'/);
	assert.match(
		fillSource,
		/shareRole === 'contributor' && rec\._recipientSlot && !_isSlotLockedForCurrentUser\(rec\)/,
	);
	assert.match(fillSource, /openInsertModal\(rec\.objectName, \{ record: rec \}\)/);
});

test('shared request opens and fills recheck current Salesforce permissions', () => {
	assert.match(appSource, /async function _refreshSlotPermission\(rec\)/);
	assert.match(
		appSource,
		/async function openRecordForCurrentUser[\s\S]*await _refreshSlotPermission\(rec\)[\s\S]*_slotInaccessibleObjects\.has\(rec\.objectName\)[\s\S]*openInsertModal/,
	);
	assert.match(
		appSource,
		/async function fillSlotWithBlank[\s\S]*await _refreshSlotPermission\(rec\)[\s\S]*openInsertModal/,
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
	assert.match(taskSidebarSource, /task\.complete[\s\S]*'&#10003;'/);
	assert.match(taskSidebarSource, /shared-task-instructions/);
	assert.match(taskSidebarSource, /data-shared-task-toggle/);
	assert.match(taskSidebarSource, /All ' \+ tasks\.length \+ ' complete/);
	assert.doesNotMatch(taskSidebarSource, /Next task/);
	assert.doesNotMatch(cssSource, /\.shared-task-next/);
	assert.match(recordsSource, /Cannot complete/);
	assert.match(recordsSource, /This record may have been deleted, or your Salesforce access may have changed\./);
	assert.doesNotMatch(recordsSource, /Referenced record not returned by Salesforce/);
	assert.match(recordsSource, /canvas owner to reassign it/);
	assert.match(recordsSource, /record-slot-cta" disabled>Cannot complete/);
	assert.doesNotMatch(recordsSource, />Waiting<\/span>/);
	assert.doesNotMatch(recordsSource, /record-slot-warn/);
	assert.match(cssSource, /\.shared-task-sidebar\s*\{/);
	assert.match(cssSource, /\.shared-task--complete \.shared-task-status\s*\{[^}]*var\(--success/s);
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
