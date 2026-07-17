import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const shareSource = fs.readFileSync(path.resolve(here, '../src/public/js/canvas-share.js'), 'utf8');
const toolbarSource = fs.readFileSync(path.resolve(here, '../src/public/js/bulk-toolbar.js'), 'utf8');
const routeSource = fs.readFileSync(path.resolve(here, '../src/canvas-routes.js'), 'utf8');

test('share modal progressively reveals review only after recipient and role are selected', () => {
	assert.match(shareSource, /id="cs-share-review" hidden/);
	assert.match(shareSource, /const ready = !!\(picked && role\)/);
	assert.match(shareSource, /reviewEl\.hidden = !ready/);
	assert.doesNotMatch(shareSource, /name="cs-role" value="(?:viewer|contributor|editor)" checked/);
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
});
