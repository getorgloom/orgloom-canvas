import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../src/public/js/upload-modal.js'), 'utf8');

test('upload preflight summary uses one user-facing total', () => {
	assert.match(source, /<span>Total records<\/span>/);
	assert.doesNotMatch(source, /Records will upload in the order below/);
	assert.doesNotMatch(source, /<span>Will sync<\/span>/);
	assert.doesNotMatch(source, /Associations \(FK links\)/);
});
