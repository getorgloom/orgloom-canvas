import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = fs.readFileSync(path.resolve(here, '../src/public/js/find-duplicates-modal.js'), 'utf8');
const css = fs.readFileSync(path.resolve(here, '../src/public/css/app.css'), 'utf8');

test('Find Duplicates confines long match-field lists to their own scroll area', () => {
	assert.match(css, /\.fdm-overlay \.fdm-fields\s*\{[^}]*max-height:/s);
	assert.match(css, /\.fdm-overlay \.fdm-fields\s*\{[^}]*overflow-y:\s*auto/s);
	assert.match(css, /\.fdm-overlay \.fdm-field-row\s*\{[^}]*flex-shrink:\s*0/s);
});

test('Match when uses a select without explanations or option cards', () => {
	assert.match(script, /<select id="fdm-op"/);
	assert.match(script, /All selected fields match/);
	assert.match(script, /Any selected field matches/);
	assert.doesNotMatch(script, /fdm-mode-opt|AND &middot; strict|OR &middot; transitive/);
	assert.doesNotMatch(script, /fdm-mode-note|Matches can connect through different fields/);
	assert.match(css, /\.fdm-overlay #fdm-object,\s*\.fdm-overlay #fdm-op\s*\{/);
});
