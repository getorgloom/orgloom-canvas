import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('hosted canvas routes use the canonical extension registry singleton', () => {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const source = fs.readFileSync(path.resolve(here, '../src/canvas-routes.js'), 'utf8');
	assert.match(source, /from ['"]orgloom-canvas\/extensions['"]/);
	assert.doesNotMatch(source, /from ['"]\.\/extensions\.js['"]/);
	assert.match(source, /if \(options\.ext\)\s*\{\s*ext = options\.ext;?\s*\}/);
});

test('hosted SaaS registration accepts the entry-point registry', () => {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const source = fs.readFileSync(path.resolve(here, '../../../apps/saas/src/saas-extensions.js'), 'utf8');
	assert.match(source, /registerSaasProviders\(options = \{\}\)/);
	assert.match(source, /if \(options\.ext\)\s*\{\s*ext = options\.ext;?\s*\}/);
});
