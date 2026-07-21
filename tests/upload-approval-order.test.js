import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../src/canvas-routes.js'), 'utf8');

test('upload routes evaluate local org approval before Salesforce permission-set verification', () => {
	assert.match(source, /const uploadRouteGuards = \[requireAccount, requireUploadOrgApproval, requireSfConnection\]/);
	assert.match(source, /app\.post\('\/api\/upload\/access-check', requireAccount, requireUploadOrgApproval/);
	for (const route of ['/api/upload', '/api/upload/graph', '/api/upload/preflight', '/api/upload/bulk']) {
		const routeIndex = source.indexOf("'" + route + "'");
		assert.notEqual(routeIndex, -1, route);
		assert.match(source.slice(routeIndex, routeIndex + 90), /\.\.\.uploadRouteGuards/);
	}
});

test('Graph upload loads object write metadata concurrently', () => {
	assert.match(source, /await Promise\.all\(\s*Array\.from\(objNamesToDescribe, async \(name\)/);
});
