import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const shareSource = fs.readFileSync(path.resolve(here, '../src/public/js/canvas-share.js'), 'utf8');
const toolbarSource = fs.readFileSync(path.resolve(here, '../src/public/js/bulk-toolbar.js'), 'utf8');
const routeSource = fs.readFileSync(path.resolve(here, '../src/canvas-routes.js'), 'utf8');
const appSource = fs.readFileSync(path.resolve(here, '../src/public/js/app.js'), 'utf8');
const insertModalSource = fs.readFileSync(path.resolve(here, '../src/public/js/insert-modal.js'), 'utf8');
const templatesSource = fs.readFileSync(path.resolve(here, '../src/public/js/templates.js'), 'utf8');
const saveSource = fs.readFileSync(path.resolve(here, '../src/public/js/canvas-save-load.js'), 'utf8');
const uploadSource = fs.readFileSync(path.resolve(here, '../src/public/js/upload-modal.js'), 'utf8');

test('share modal progressively reveals review only after recipient and role are selected', () => {
	assert.match(shareSource, /id="cs-share-review" hidden/);
	assert.match(shareSource, /const ready = !!\(picked && role\)/);
	assert.match(shareSource, /reviewEl\.hidden = !ready/);
	assert.doesNotMatch(shareSource, /name="cs-role" value="(?:viewer|contributor|editor)" checked/);
});

test('clearing a selected teammate keeps the default suggestions available', () => {
	assert.match(shareSource, /input\.focus\(\);\s*runSearch\('\'\);/);
	assert.match(shareSource, /results\.innerHTML !== ''[\s\S]*results\.hidden = false/);
	assert.match(shareSource, /ev\.composedPath[\s\S]*eventPath\.includes\(hostEl\)/);
});

test('share modal is role-specific and says Salesforce record permissions do not change', () => {
	assert.match(shareSource, /viewer: 'can open and explore the canvas, but cannot change it\.'/);
	assert.match(shareSource, /This shares the canvas only\. Salesforce record access stays unchanged\./);
	assert.doesNotMatch(shareSource, /recipient will get Read\/Edit access/);
	assert.doesNotMatch(shareSource, /data\.recordAccess/);
});

test('active shares live in a separate management modal', () => {
	assert.match(shareSource, /function openCanvasShareManagementModal/);
	assert.match(shareSource, /canvas-share-management-modal/);
	assert.match(shareSource, /id="cs-manage-list"/);
	assert.doesNotMatch(shareSource, /data-cs-manage/);
	assert.match(toolbarSource, /data-bulk-manage-access/);
	assert.match(toolbarSource, /openCanvasShareManagementModal\(current\.id/);
	assert.doesNotMatch(shareSource, /id="cs-link-list"/);
});

test('direct canvas sharing does not grant Salesforce business-record access', () => {
	const directRouteStart = routeSource.indexOf("app.post('/api/canvas/:id/direct-share'");
	const nextRouteStart = routeSource.indexOf("app.get('/api/canvas/:id/share-links'", directRouteStart);
	assert.ok(directRouteStart >= 0 && nextRouteStart > directRouteStart, 'direct-share route should be present');
	const directRoute = routeSource.slice(directRouteStart, nextRouteStart);
	assert.doesNotMatch(directRoute, /grantRecordAccess|recordAccess|__Share\b/);
	assert.match(directRoute, /store\.addShare\(id, \{ entityId: recipientSfUserId, accessLevel \}\)/);
	assert.match(directRoute, /recipientSfUsername = String\(recipientRecord\.Username/);
	assert.match(directRoute, /sendDirectCanvasShareNotification\([\s\S]*recipientSfUsername/);
});

test('share role changes update active recipient connections after the grant is persisted', () => {
	const directRouteStart = routeSource.indexOf("app.post('/api/canvas/:id/direct-share'");
	const directRouteEnd = routeSource.indexOf("app.get('/api/canvas/:id/share-links'", directRouteStart);
	const directRoute = routeSource.slice(directRouteStart, directRouteEnd);
	const persistIndex = directRoute.indexOf('await canvasRoleGrantsDb.set');
	const notifyIndex = directRoute.indexOf('canvasPresence.updateCanvasAccess');
	assert.ok(persistIndex >= 0 && notifyIndex > persistIndex);
	assert.match(directRoute, /sfUserId: recipientSfUserId,[\s\S]*role,/);

	const revokeStart = routeSource.indexOf("'/api/canvas/:id/direct-shares/:sfUserId'");
	const revokeEnd = routeSource.indexOf("app.post('/api/canvas/:id/slot-fill'", revokeStart);
	const revokeRoute = routeSource.slice(revokeStart, revokeEnd);
	assert.match(revokeRoute, /canvasPresence\.updateCanvasAccess\([\s\S]*revoked: true/);
	assert.ok(
		revokeRoute.indexOf('await canvasRoleGrantsDb.remove') <
			revokeRoute.indexOf('await _removeSfShareForRecipient'),
		'revoke should remove the app grant before Salesforce sharing cleanup',
	);
	assert.match(routeSource, /role: presenceRole,[\s\S]*sfOrgId: presenceSfOrgId,[\s\S]*sfUserId: presenceSfUserId/);
	assert.match(appSource, /onAccessChanged: function \(detail\)[\s\S]*current\.recipientRole = role/);
});

test('revoked recipients disappear from listings and cannot reopen through a stale Salesforce share', () => {
	const listStart = routeSource.indexOf("app.get('/api/canvas'");
	const getStart = routeSource.indexOf("app.get('/api/canvas/:id'", listStart);
	const listRoute = routeSource.slice(listStart, getStart);
	assert.match(listRoute, /canvasRoleGrantsDb\.listForRecipient/);
	assert.match(listRoute, /return grant \? \{ \.\.\.item, role: grant\.role \} : null/);
	assert.match(listRoute, /\.filter\(Boolean\)/);

	const getEnd = routeSource.indexOf("app.post('/api/canvas'", getStart);
	const getRoute = routeSource.slice(getStart, getEnd);
	const missingGrant = getRoute.indexOf("error: 'canvas-not-accessible'");
	const entitlementGate = getRoute.indexOf('recipientRequiresPlan(grant)');
	assert.ok(missingGrant >= 0 && entitlementGate > missingGrant);
	assert.doesNotMatch(getRoute, /recipientRole = 'viewer'/);

	const presenceStart = routeSource.indexOf("app.get('/api/canvas/:id/presence/subscribe'");
	const presenceRoute = routeSource.slice(presenceStart);
	assert.match(presenceRoute, /if \(!grant\) \{[\s\S]*error: 'canvas-not-accessible'/);
	assert.doesNotMatch(presenceRoute, /presenceRole = \(grant && grant\.role\) \|\| 'viewer'/);
});

test('shared canvas loads and same-canvas reloads prefer the current live snapshot', () => {
	const getStart = routeSource.indexOf("app.get('/api/canvas/:id'");
	const getEnd = routeSource.indexOf("app.post('/api/canvas'", getStart);
	const getRoute = routeSource.slice(getStart, getEnd);
	const liveIndex = getRoute.indexOf('canvasPresence.unsavedLiveSnapshot');
	const projectionIndex = getRoute.indexOf('projectSharedCanvasPayload');
	assert.ok(liveIndex >= 0, 'canvas load should consult the current unsaved live snapshot');
	assert.ok(projectionIndex > liveIndex, 'live state must pass through recipient permission projection');
	assert.match(getRoute, /let payload = live \? live\.payload : item\.payload/);
});

test('live revocation clears the canvas identity and its session restore snapshot', () => {
	const accessStart = appSource.indexOf('onAccessChanged: function (detail)');
	const accessEnd = appSource.indexOf('\n\t});', accessStart);
	const accessHandler = appSource.slice(accessStart, accessEnd);
	assert.match(accessHandler, /if \(detail && detail\.revoked\) \{[\s\S]*_autosaveClear\(\)/);
	assert.match(accessHandler, /canvasState\.currentCanvas = null/);
	assert.match(accessHandler, /_canvasShareCanvasId = null/);
	assert.match(accessHandler, /_presence\.unsubscribe\(\)/);
});

test('saved-canvas role badges distinguish Viewer from Contributor', () => {
	assert.match(saveSource, /else if \(t\.role === 'contributor'\)[\s\S]*>CONTRIBUTOR</);
	assert.match(saveSource, /else \{[\s\S]*>VIEWER</);
});

test('save conflict uses a concise reload action', () => {
	assert.match(saveSource, /data-vc-reload>Reload<\/button>/);
	assert.doesNotMatch(saveSource, /data-vc-reload>Reload from Salesforce/);
	assert.match(saveSource, /Another user updated this canvas after you opened it\./);
});

test('shared-canvas recipients cannot publish the canvas to Salesforce', () => {
	assert.match(toolbarSource, /const uploadBtn = isRecipient\s*\? ''/);
	assert.match(uploadSource, /Only the canvas owner can upload this shared canvas to Salesforce\./);
	assert.match(uploadSource, /body: JSON\.stringify\(\{ canvasId: publishCanvasId \}\)/);
	assert.match(routeSource, /canvas-owner-required-for-upload/);
	assert.match(routeSource, /if \(!item\) \{[\s\S]*error: 'canvas-not-accessible'/);
	assert.match(routeSource, /const uploadRouteGuards = \[[^\]]*requireCanvasPublishOwner[^\]]*\]/);
});

test('shared-canvas save checks the recipient role before suggesting a plan upgrade', () => {
	const putStart = routeSource.indexOf("app.put('/api/canvas/:id'");
	const putEnd = routeSource.indexOf("app.delete('/api/canvas/:id'", putStart);
	assert.ok(putStart >= 0 && putEnd > putStart, 'canvas update route should be present');
	const putRoute = routeSource.slice(putStart, putEnd);
	const roleCheck = putRoute.indexOf("grant.role !== 'editor'");
	const planCheck = putRoute.indexOf("_gateCapability(req, res, 'save-canvas'");
	assert.ok(roleCheck >= 0, 'canvas update should enforce the recipient role');
	assert.ok(planCheck > roleCheck, 'recipient role denial should precede the workspace plan gate');
});

test('an editor cannot replace the owner canvas from a Salesforce-redacted partial view', () => {
	assert.match(routeSource, /_sharedProjectionRemovedContent/);
	assert.match(routeSource, /shared-canvas-content-hidden/);
	assert.match(routeSource, /cannot safely replace the owner’s complete canvas with your partial view/);
});

test('contributors submit canvas changes without direct Salesforce DML', () => {
	const slotRouteStart = routeSource.indexOf("app.post('/api/canvas/:id/slot-fill'");
	const slotRouteEnd = routeSource.indexOf("app.get('/api/ai/status'", slotRouteStart);
	assert.ok(slotRouteStart >= 0 && slotRouteEnd > slotRouteStart, 'slot-fill route should be present');
	const slotRoute = routeSource.slice(slotRouteStart, slotRouteEnd);
	assert.match(slotRoute, /contributionStore\.submit/);
	assert.match(slotRoute, /recipientRequiresPlan\(grant\)\s*&&[\s\S]*_gateCapability/);
	assert.match(slotRoute, /record\.loadedFromId \? field\.updateable === true : field\.createable === true/);
	assert.match(slotRoute, /contributor-salesforce-permission-required/);
	assert.doesNotMatch(slotRoute, /Contributor and Editor access requires/);
	assert.doesNotMatch(slotRoute, /\.create\(|\.update\(|\.destroy\(|composite\/sobjects/);
	assert.match(appSource, /const requestedFields =[\s\S]*new Set\(r\.slot\.fields\)/);
	assert.match(appSource, /requestedFields\.has\(fieldName\)/);
	assert.match(appSource, /values: submittedValues/);
	assert.match(appSource, /Nothing was uploaded to Salesforce\./);
	assert.match(appSource, /const submitted = Number\(data && data\.submitted\)/);
	assert.match(appSource, /Submittingâ€¦/);
	assert.match(appSource, /Changes submitted/);
	assert.match(appSource, /_shareRecipientSubmitState === 'pending'/);
	const responseIndex = slotRoute.indexOf('res.json({');
	const notificationIndex = slotRoute.indexOf('sendCanvasFillNotification({');
	assert.ok(
		responseIndex >= 0 && notificationIndex > responseIndex,
		'email must not delay submission acknowledgement',
	);
});

test('shared drafts carry a minimal describe snapshot and can open without a live describe', () => {
	assert.match(templatesSource, /function draftFieldMetadata/);
	assert.match(templatesSource, /async function ensureDraftSlotMetadata/);
	assert.match(templatesSource, /draftFields: fields/);
	assert.match(templatesSource, /canvasState\.draftDescribeCache/);
	assert.match(insertModalSource, /canvasState\.draftDescribeCache\[objectName\]/);
	assert.match(insertModalSource, /resolveSharedDraftDescribe\(ensureDescribe, objectName, sharedSnapshot\)/);
	assert.match(insertModalSource, /const rulesPromise = sharedDraft\s*\?\s*Promise\.resolve\(\[\]\)/);
	assert.match(templatesSource, /const recipientUsesSavedMetadata =/);
	assert.match(templatesSource, /if \(!recipientUsesSavedMetadata\) \{\s*_runSlotPreflight/);
	assert.match(
		appSource,
		/if \(shareRole !== 'viewer' && shareRole !== 'contributor'\) \{\s*canvasState\.selectedObjects\.forEach/,
	);
	assert.doesNotMatch(insertModalSource, /Shared draft/);
	assert.equal((saveSource.match(/await ensureDraftSlotMetadata\(\)/g) || []).length, 2);
	const wholeRecordStart = appSource.indexOf('async function createStandaloneRecordRequest');
	const nextFunction = appSource.indexOf('function _slotRecordDisplayName', wholeRecordStart);
	assert.ok(wholeRecordStart >= 0 && nextFunction > wholeRecordStart);
	assert.match(appSource.slice(wholeRecordStart, nextFunction), /await ensureDescribe\(objectName\)/);
	assert.match(appSource.slice(wholeRecordStart, nextFunction), /origin: 'standalone'/);
});

test('viewer permissions are explained once at canvas level', () => {
	assert.match(appSource, /You can explore this shared canvas, but you can’t make changes/);
	assert.match(insertModalSource, /if \(!viewerReadOnly\) \{\s*if \(slotAssignedToOther\)/);
	assert.doesNotMatch(insertModalSource, /These fields were requested from a contributor/);
});

test('opening any canvas record publishes a stable presence identity', () => {
	assert.match(insertModalSource, /refKind: 'loaded'/);
	assert.match(insertModalSource, /refKind: 'draft'/);
	assert.match(insertModalSource, /refKind: 'slot'/);
	assert.match(insertModalSource, /pushPresenceFocus\(presenceFocus\)/);
});

test('contributors may fill only requested fields Salesforce permits them to create or update', () => {
	assert.match(insertModalSource, /const contributorCanPropose = \(field\) => \{[\s\S]*shareRole !== 'contributor'/);
	assert.match(insertModalSource, /contributorCanPropose\(field\)/);
	assert.match(insertModalSource, /const salesforceFieldWritable = \(field\) =>/);
	assert.match(routeSource, /_sharedObjectAccessForPayload/);
});

test('field-request progress lives in the task sidebar instead of modal banners', () => {
	assert.doesNotMatch(insertModalSource, /_bannerProgressChip/);
	assert.doesNotMatch(insertModalSource, /Update the highlighted field/);
	assert.doesNotMatch(insertModalSource, /requested field.*currently (?:has a value|have values)/s);
	assert.doesNotMatch(insertModalSource, /slot-lastmod|Last modified/);
	assert.match(insertModalSource, /focusTaskField\(opts\.focusField\)/);
});

test('contributors are guided to the next requested field after committing a valid value', () => {
	assert.match(insertModalSource, /const guidedTouchedFields = new Set\(\)/);
	assert.match(insertModalSource, /function _nextIncompleteGuidedField\(fieldName\)/);
	assert.match(insertModalSource, /form\.addEventListener\('focusout'/);
	assert.match(insertModalSource, /e\.target\.tagName === 'SELECT'/);
	assert.match(insertModalSource, /guidedField\.dataset\.type === 'boolean'/);
	assert.match(insertModalSource, /guidedField\.dataset\.type === 'reference'/);
	assert.match(insertModalSource, /active !== document\.body/);
	assert.match(insertModalSource, /prefers-reduced-motion: reduce/);
	assert.match(insertModalSource, /hidden\.dispatchEvent\(new Event\('change', \{ bubbles: true \}\)\)/);
});
