import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../src/public/js/bulk-ops-menu.js'), 'utf8');

test('keyboard shortcut describes operation-level undo', () => {
	assert.match(source, /Ctrl\/Cmd\+Z<\/strong> to undo the last canvas operation/);
	assert.doesNotMatch(source, /Ctrl\/Cmd\+Z<\/strong> to undo the last delete/);
});
