import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = fs.readFileSync(path.resolve(here, '../src/public/js/find-duplicates-modal.js'), 'utf8');
const css = fs.readFileSync(path.resolve(here, '../src/public/css/app.css'), 'utf8');

test('Find Duplicates uses one modal scroll surface', () => {
	assert.match(css, /\.fdm-overlay \.fdm-body\s*\{[^}]*overflow:\s*visible/s);
	assert.doesNotMatch(css, /\.fdm-overlay \.fdm-fields\s*\{[^}]*(?:overflow-y|max-height):/s);
});

test('Match when choices use the constrained mode layout', () => {
	assert.match(script, /fdm-config-row--mode/);
	assert.match(css, /\.fdm-overlay \.fdm-config-row--mode \.fdm-mode\s*\{[^}]*width:\s*min\(100%, 520px\)/s);
});
