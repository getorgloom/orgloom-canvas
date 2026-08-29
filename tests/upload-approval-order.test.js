import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../src/canvas-routes.js'), 'utf8');

test('upload routes evaluate local org approval before Salesforce permission-set verification', () => {
	assert.match(
		source,
		/const uploadRouteGuards = \[\s*requireAccount,\s*requireUploadOrgApproval,\s*requireSfConnection,\s*requireCanvasPublishOwner,\s*\]/,
	);
	assert.match(source, /app\.post\('\/api\/upload\/access-check', \.\.\.uploadRouteGuards/);
	assert.match(
		source,
		/app\.post\('\/api\/upload\/access-check',[\s\S]*?_gateUploadRecords\(req, res, 'check upload access'\)/,
	);
	for (const route of ['/api/upload', '/api/upload/graph', '/api/upload/preflight', '/api/upload/bulk']) {
		const routeIndex = source.indexOf("'" + route + "'");
		assert.notEqual(routeIndex, -1, route);
		assert.match(source.slice(routeIndex, routeIndex + 90), /\.\.\.uploadRouteGuards/);
	}
});

test('all Salesforce middleware checks org approval before obtaining a Salesforce client', () => {
	const middlewareStart = source.indexOf('async function requireSfConnection');
	const middlewareEnd = source.indexOf('async function _currentSfOrgApproval', middlewareStart);
	const middleware = source.slice(middlewareStart, middlewareEnd);
	assert.ok(middleware.indexOf('_currentSfOrgApproval(req)') < middleware.indexOf('getActiveSfConnection(req)'));
	assert.match(middleware, /_clearUnapprovedSfConnection/);
});

test('saved-canvas collaboration and slot submission require an approved org', () => {
	assert.match(source, /app\.post\('\/api\/canvas\/:id\/slot-fill',\s*requireAccount,\s*requireSfOrgApproval/);
	for (const route of [
		'subscribe',
		'cursor',
		'focus',
		'field-lock',
		'field-lock/renew',
		'field-lock/release',
		'fields',
		'layout',
		'slot',
		'draft-link',
		'record-remove',
		'loaded-record',
		'draft',
	]) {
		const routeStart = source.indexOf("'/api/canvas/:id/presence/" + route + "'");
		assert.notEqual(routeStart, -1, route);
		assert.match(source.slice(routeStart, routeStart + 160), /requireSfOrgApproval/);
	}
});

test('draft proposal record loads require approval before obtaining a Salesforce client', () => {
	const routeStart = source.indexOf("'/api/canvas/:id/proposals/:proposalId/apply'");
	const loadGuardStart = source.indexOf('const willLoadSalesforceRecord', routeStart);
	const proposalLoopStart = source.indexOf('for (let idx = 0; idx < allChanges.length; idx++)', loadGuardStart);
	const loadGuard = source.slice(loadGuardStart, proposalLoopStart);
	assert.notEqual(routeStart, -1);
	assert.notEqual(loadGuardStart, -1);
	assert.match(loadGuard, /_currentSfOrgApproval\(req\)/);
	assert.ok(loadGuard.indexOf('_currentSfOrgApproval(req)') < loadGuard.indexOf('getActiveSfConnection(req)'));
	assert.match(loadGuard, /Connect an approved Salesforce org to load records onto this canvas/);
});

test('Graph upload loads object write metadata concurrently', () => {
	assert.match(source, /await Promise\.all\(\s*Array\.from\(objNamesToDescribe, async \(name\)/);
});

test('every record upload path rejects specialized object types before capability checks', () => {
	const routes = [
		['/api/upload', '/api/upload-batches'],
		['/api/upload/graph', '/api/upload/preflight'],
		['/api/upload/preflight', '/api/upload/bulk'],
		['/api/upload/bulk', '/api/objects'],
	];
	for (const [route, nextRoute] of routes) {
		const start = source.indexOf("app.post('" + route + "'");
		const end = source.indexOf(nextRoute, start + route.length);
		assert.notEqual(start, -1, route);
		assert.notEqual(end, -1, nextRoute);
		const block = source.slice(start, end);
		const guardIndex = block.indexOf('rejectSpecializedUploadObjects(req, res)');
		const capabilityIndex = block.indexOf('_gateUploadRecords(');
		assert.ok(guardIndex >= 0, route + ' must enforce the specialized-object boundary');
		assert.ok(guardIndex < capabilityIndex, route + ' must reject before capability checks or Salesforce writes');
	}
});
