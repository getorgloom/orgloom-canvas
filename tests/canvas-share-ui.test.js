import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const shareSource = fs.readFileSync(path.resolve(here, '../src/public/js/canvas-share.js'), 'utf8');
const toolbarSource = fs.readFileSync(path.resolve(here, '../src/public/js/bulk-toolbar.js'), 'utf8');
const routeSource = fs.readFileSync(path.resolve(here, '../src/canvas-routes.js'), 'utf8').replace(/\r\n/g, '\n');
const appSource = fs.readFileSync(path.resolve(here, '../src/public/js/app.js'), 'utf8');
const insertModalSource = fs.readFileSync(path.resolve(here, '../src/public/js/insert-modal.js'), 'utf8');
const slotHelpersSource = fs.readFileSync(path.resolve(here, '../src/slot-helpers.js'), 'utf8');
const presenceSource = fs.readFileSync(path.resolve(here, '../src/public/js/presence.js'), 'utf8');
const templatesSource = fs.readFileSync(path.resolve(here, '../src/public/js/templates.js'), 'utf8');
const saveSource = fs.readFileSync(path.resolve(here, '../src/public/js/canvas-save-load.js'), 'utf8');
const uploadSource = fs.readFileSync(path.resolve(here, '../src/public/js/upload-modal.js'), 'utf8');
const cssSource = fs.readFileSync(path.resolve(here, '../src/public/css/app.css'), 'utf8');

test('share modal progressively reveals review only after recipient and role are selected', () => {
	assert.match(shareSource, /id="cs-share-review" hidden/);
	assert.match(shareSource, /const ready = !!\(picked && role\)/);
	assert.match(shareSource, /reviewEl\.hidden = !ready/);
	assert.doesNotMatch(shareSource, /name="cs-role" value="(?:viewer|contributor|editor)" checked/);
});

test('share recipients exclude the current Salesforce user and self-sharing fails closed', () => {
	assert.match(shareSource, /excludeCurrentUser = false/);
	assert.match(shareSource, /excludeCurrentUser \? '&excludeCurrent=1'/);
	assert.match(
		shareSource,
		/attachSfUserPicker\(modal\.querySelector\('#cs-link-picker'\), \{[\s\S]*excludeCurrentUser: true/,
	);
	const directRouteStart = routeSource.indexOf("app.post('/api/canvas/:id/direct-share'");
	const nextRouteStart = routeSource.indexOf("app.get('/api/canvas/:id/share-links'", directRouteStart);
	const directRoute = routeSource.slice(directRouteStart, nextRouteStart);
	assert.match(directRoute, /_salesforceIdKey\(recipientSfUserId\) === _salesforceIdKey\(req\.sf\.sfUserId\)/);
	assert.match(directRoute, /error: 'cannot-share-with-self'/);
	assert.match(routeSource, /req\.query\.excludeCurrent === '1'[\s\S]*AND Id !=/);
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
	assert.match(shareSource, /nextStep = 'Shared with ' \+ who \+ '\.';/);
	assert.match(shareSource, /We emailed connection instructions/);
	assert.match(shareSource, /We emailed setup instructions/);
	assert.doesNotMatch(shareSource, /has Org Loom \+ this Salesforce org connected/);
});

test('one Share modal handles invitations and existing access', () => {
	assert.doesNotMatch(shareSource, /openCanvasShareManagementModal/);
	assert.match(shareSource, /class="cs-access-section"/);
	assert.match(shareSource, /<h4>People with access<\/h4>/);
	assert.match(shareSource, /id="cs-manage-list"/);
	assert.doesNotMatch(shareSource, /data-cs-manage/);
	assert.doesNotMatch(toolbarSource, /data-bulk-manage-access/);
	assert.doesNotMatch(toolbarSource, />Access </);
	assert.match(toolbarSource, /Share[\s\S]*canvas-share-btn-count/);
	assert.match(shareSource, /class="cs-access-role"/);
	assert.match(shareSource, /\? 'No access'/);
	assert.doesNotMatch(shareSource, /cs-direct-revoke/);
	assert.doesNotMatch(shareSource, /cs-access-cancel/);
	assert.match(shareSource, /method: 'PATCH'/);
	assert.match(shareSource, /revokeAccess[\s\S]*method: 'DELETE'/);
	assert.doesNotMatch(shareSource, /id="cs-link-list"/);
});

test('access-level changes use a dedicated owner-only route and notify live recipients', () => {
	const updateStart = routeSource.indexOf("app.patch(\n\t\t'/api/canvas/:id/direct-shares/:sfUserId'");
	const updateEnd = routeSource.indexOf("app.delete(\n\t\t'/api/canvas/:id/direct-shares/:sfUserId'", updateStart);
	assert.ok(updateStart >= 0 && updateEnd > updateStart, 'direct-share role update route should be present');
	const updateRoute = routeSource.slice(updateStart, updateEnd);
	assert.match(updateRoute, /if \(!item\.ownedByMe\)/);
	assert.match(updateRoute, /canvasRoleGrantsDb\.set/);
	assert.match(updateRoute, /store\.updateShareLevel/);
	assert.match(updateRoute, /canvasPresence\.updateCanvasAccess/);
	assert.doesNotMatch(updateRoute, /sendDirectCanvasShareNotification/);
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

test('saved-canvas listings separate owned access from shared access', () => {
	const listStart = routeSource.indexOf("app.get('/api/canvas'");
	const getStart = routeSource.indexOf("app.get('/api/canvas/:id'", listStart);
	const listRoute = routeSource.slice(listStart, getStart);
	assert.match(listRoute, /ext\.getCapability\(req\.account, 'open-saved-canvas'/);
	assert.match(listRoute, /return ownedCanvasAccess\.allowed \? item : null/);
	assert.match(listRoute, /canOpenOwnedCanvases: !!ownedCanvasAccess\.allowed/);

	assert.match(saveSource, /header\.textContent = 'Canvases shared with you'/);
	assert.match(
		saveSource,
		/Your own saved canvases are hidden because your current plan does not include opening saved canvases\./,
	);
	assert.match(saveSource, /No canvases are currently shared with you\./);
});

test('failed picker loads explain that the current canvas was preserved', () => {
	const getStart = routeSource.indexOf("app.get('/api/canvas/:id'");
	const getEnd = routeSource.indexOf("app.post('/api/canvas'", getStart);
	const getRoute = routeSource.slice(getStart, getEnd);
	assert.match(
		getRoute,
		/error\.code === 'canvas-key-missing'[\s\S]*status\(409\)\.json\(\{[\s\S]*error: 'canvas-key-missing'/,
	);
	assert.match(saveSource, /loadError\.code = td && td\.error/);
	assert.match(saveSource, /const keyMissing = e && e\.code === 'canvas-key-missing'/);
	assert.match(saveSource, /title = 'Canvas could not be opened'/);
	assert.match(saveSource, /e\.message[^;]+The canvas you already had open has not changed\./);
	assert.match(saveSource, /\{ title, showConfirm: false \}/);
	assert.match(saveSource, /This canvas is unavailable or is no longer shared with you\.[^']*has not changed\./);
	assert.ok(
		saveSource.indexOf('finishCanvasLoadOnce();', saveSource.indexOf('} catch (e) {')) <
			saveSource.indexOf('await window.olAlert(', saveSource.indexOf('} catch (e) {')),
		'loading mask should be removed before the error dialog opens',
	);
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

test('shared-canvas banner relies on the standard navigation instead of adding a workspace link', () => {
	assert.doesNotMatch(appSource, /share-recipient-back/);
	assert.doesNotMatch(appSource, /data-share-back/);
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

test('staged share roles keep toolbar and edit access stable while a canvas loads', () => {
	assert.match(appSource, /function _canEditCanvasStructure\(\) \{\s*const shareRole = _getCanvasShareRole\(\)/);
	assert.match(toolbarSource, /toolbarCanvasAccess\(cc, getCanvasShareRole\(\)\)/);
	assert.match(toolbarSource, /const isRecipient = canvasAccess\.isRecipient/);
	assert.match(toolbarSource, /const canPersistCanvas = canvasAccess\.canPersistCanvas/);
});

test('canvas replacement keeps its name and task identity while records are rebuilt', () => {
	assert.match(templatesSource, /const loadingCanvasIdentity =[\s\S]*opts\.canvasIdentity/);
	assert.match(templatesSource, /canvasState\.currentCanvas = loadingCanvasIdentity/);
	assert.match(appSource, /applyLiveSnapshot: async function \(payload\)[\s\S]*canvasIdentity: current/);
	assert.match(saveSource, /await applyCanvasPayload\(td\.payload \|\| \{}, \{[\s\S]*canvasIdentity: \{/);
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

test('an editor save merges the Salesforce-visible view without replacing hidden owner content', () => {
	assert.match(routeSource, /mergeEditorCanvasPayload/);
	assert.match(routeSource, /baseline: projectedForRecipient/);
	assert.match(routeSource, /submitted: submittedForRecipient/);
	assert.doesNotMatch(routeSource, /shared-canvas-content-hidden/);
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
	assert.match(appSource, /Open a task, add the requested information, then choose <strong>Save changes<\/strong>/);
	assert.match(appSource, /Your changes are shared with the canvas owner and are not uploaded to Salesforce/);
	assert.doesNotMatch(appSource, /id="share-recipient-submit"/);
	assert.match(insertModalSource, /await commitRecordFields/);
	assert.match(insertModalSource, /data-field-takeover/);
	assert.match(insertModalSource, /Take over this field\?/);
	assert.match(insertModalSource, /is editing this field now/);
	assert.match(insertModalSource, /because they have unsaved changes/);
	assert.match(insertModalSource, /function _fieldHasUnsavedChange\(fieldName\)/);
	assert.match(insertModalSource, /releaseFieldLock\(blurredRecord, blurredFieldName\)/);
	assert.match(insertModalSource, /releaseFieldLock\(record, fieldName\)/);
	assert.match(presenceSource, /function releaseFieldLock\(record, fieldName\)/);
	assert.match(insertModalSource, /is-peer-active/);
	assert.match(insertModalSource, /is-peer-reserved/);
	assert.doesNotMatch(insertModalSource, /meta-field-lock/);
	assert.match(insertModalSource, /peerLock \? ' is-peer-locked' : ''/);
	assert.match(cssSource, /\.field\.is-peer-locked\s*\{/);
	assert.match(cssSource, /\.field\.is-peer-locked input\[disabled\]/);
	assert.match(cssSource, /\.field\.is-peer-locked\.is-peer-reserved\s*\{/);
	assert.match(
		cssSource,
		/\.field\.is-slot-field:not\(\.field-invalid-ref\):not\(\.is-peer-locked\)[\s\S]*border-color: color-mix\(in srgb, var\(--accent\) 68%/,
	);
	assert.match(cssSource, /box-shadow: 0 0 0 3px color-mix\(in srgb, var\(--accent\) 16%/);
	assert.match(insertModalSource, /delete localValues\[fieldName\]/);
	assert.match(insertModalSource, /if \(currentLock && currentLock\.owned\) \{\s*return;/);
	assert.match(insertModalSource, /const activeControlId = activeControl && activeControl\.id/);
	assert.match(insertModalSource, /nextControl\.focus\(\{ preventScroll: true \}\)/);
	assert.match(
		insertModalSource,
		/currentLock && !currentLock\.owned \? \[fieldName\] : \[\][\s\S]*rerenderFormPreservingValues\(displacedFields\)/,
	);
	assert.match(appSource, /refreshCurrentFieldLocks\(reference, fieldName\)/);
	assert.match(insertModalSource, /Save changes/);
	assert.match(insertModalSource, /shared the update with the owner/);
	assert.match(insertModalSource, /firstInvalidEditorControl\(form, editorTouchedFields, existingRecord\)/);
	assert.match(insertModalSource, /Review .*before saving\./s);
	assert.match(
		insertModalSource,
		/showModalToast\(\s*\(error && error\.message\)[\s\S]*Another user changed or is editing/,
	);
	assert.match(insertModalSource, /You can no longer complete this request/);
	assert.match(presenceSource, /presence\/field-lock/);
	assert.match(presenceSource, /baseVersion: acquired\.lock\.baseVersion/);
	assert.match(presenceSource, /liveCommit: \{ connectionId: _myConnectionId, targetRef, leases \}/);
	assert.match(presenceSource, /_acknowledgedContributionIds\.add/);
	assert.match(saveSource, /acknowledgedContributionIds: acknowledgedContributionIds/);
	assert.match(saveSource, /markContributionIdsSaved\(data && data\.mergedContributionIds\)/);
	assert.match(routeSource, /acknowledgedContributionIds\.has\(String\(contributionId\)\)/);
	assert.match(routeSource, /mergedCount === pendingContributionIds\.length/);
	assert.match(presenceSource, /liveCommit: \{ connectionId: _myConnectionId, targetRef, leases \}/);
	const responseIndex = slotRoute.indexOf('res.json({');
	const notificationIndex = slotRoute.indexOf('sendCanvasFillNotification({');
	assert.ok(
		responseIndex >= 0 && notificationIndex > responseIndex,
		'email must not delay submission acknowledgement',
	);
});

test('external lookup fields can be requested and edited as ordinary shared values', () => {
	assert.match(appSource, /function _slotConfigurationFields/);
	assert.doesNotMatch(appSource, /function _slotConfigurationFields[\s\S]*!isExternalKeyReference\(field\)/);
	assert.doesNotMatch(routeSource, /!isExternalKeyReference\(field\)/);
	assert.doesNotMatch(slotHelpersSource, /!isExternalKeyReference\(field\)/);
	assert.match(insertModalSource, /const salesforceFieldWritable = \(field\) =>[\s\S]*!!field\.updateable/);
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
	assert.match(
		templatesSource,
		/const shouldPreflight = !recipientUsesSavedMetadata \|\| loadingCanvasShareRole === 'contributor'/,
	);
	assert.match(templatesSource, /if \(shouldPreflight && loadingCanvasShareRole\) \{[\s\S]*await _runSlotPreflight/);
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
	assert.match(insertModalSource, /function editableContributorAssociation\(fieldName\)/);
	assert.match(insertModalSource, /function reconcileContributorRelationships\(payload\)/);
	assert.match(appSource, /_slotChangedRelationshipFields instanceof Set/);
	assert.match(routeSource, /fieldByName\.get\(name\)\.type === 'reference'/);
	assert.match(routeSource, /relationshipFields/);
	assert.match(routeSource, /relationshipFields: accepted\[0\]\.relationshipFields \|\| \[\]/);
});

test('records without an object type fail before describe loading', () => {
	assert.match(insertModalSource, /objectName = objectName \|\| \(opts\.record && opts\.record\.objectName\)/);
	assert.match(insertModalSource, /This record is missing its Salesforce object type/);
});

test('live request changes refresh an already-open recipient editor', () => {
	assert.match(appSource, /onSlotUpdated: function \(record\)[\s\S]*refreshCurrentRecordAccess\(record\)/);
	assert.match(
		insertModalSource,
		/function refreshCurrentRecordAccess\(record\)[\s\S]*sharedDraftLayoutMode\([\s\S]*fetchEditLayout\([\s\S]*rerenderFormPreservingValues\(\)/,
	);
});

test('field-request progress lives in the task sidebar instead of modal banners', () => {
	assert.doesNotMatch(insertModalSource, /_bannerProgressChip/);
	assert.doesNotMatch(insertModalSource, /Update the highlighted field/);
	assert.doesNotMatch(insertModalSource, /requested field.*currently (?:has a value|have values)/s);
	assert.doesNotMatch(insertModalSource, /slot-lastmod|Last modified/);
	assert.match(insertModalSource, /focusTaskField\(opts\.focusField\)/);
});

test('assigned contributors and editors are guided to the next requested field after committing a valid value', () => {
	assert.match(insertModalSource, /const guidedTouchedFields = new Set\(\)/);
	assert.match(insertModalSource, /function _nextIncompleteGuidedField\(fieldName\)/);
	assert.match(insertModalSource, /shareRole !== 'contributor' && shareRole !== 'editor'/);
	assert.match(
		insertModalSource,
		/form\.addEventListener\('change',[\s\S]*if \(guidedComplete\) \{[\s\S]*_scheduleGuidedAdvance/,
	);
	assert.match(insertModalSource, /active\.closest\('\.field\.is-slot-field'\)/);
	assert.match(insertModalSource, /activeRequestedField\.dataset\.field !== fieldName/);
	assert.match(insertModalSource, /section\.classList\.remove\('collapsed'\)/);
	assert.match(insertModalSource, /window\.requestAnimationFrame\(revealField\)/);
	assert.match(insertModalSource, /prefers-reduced-motion: reduce/);
	assert.match(insertModalSource, /hidden\.dispatchEvent\(new Event\('change', \{ bubbles: true \}\)\)/);
});
