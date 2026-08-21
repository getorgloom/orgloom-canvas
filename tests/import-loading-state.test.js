import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const appSource = readFileSync(new URL('../src/public/js/app.js', import.meta.url), 'utf8');
const linkedCsvSource = readFileSync(new URL('../src/public/js/linked-csv.js', import.meta.url), 'utf8');
const supportModalSource = readFileSync(new URL('../src/public/js/support-modals.js', import.meta.url), 'utf8');

test('CSV drop zone announces file processing and prevents duplicate import actions', () => {
	assert.match(linkedCsvSource, /state\.processingFiles[\s\S]*Reading CSV files…/);
	assert.match(linkedCsvSource, /aria-busy="true" aria-live="polite"/);
	assert.match(linkedCsvSource, /if \(!state \|\| state\.importing\)/);
	assert.match(linkedCsvSource, /querySelectorAll\('#linked-csv-replace, #linked-csv-confirm'\)/);
	assert.match(linkedCsvSource, /mode === 'replace' \? 'Replacing…' : 'Adding…'/);
});

test('saved-canvas JSON drop zone shows a guarded reading state', () => {
	assert.match(appSource, /if \(!file \|\| readingFile\)/);
	assert.match(appSource, /dz\.setAttribute\('aria-busy', 'true'\)/);
	assert.match(appSource, /Reading saved canvas…/);
	assert.match(appSource, /onReady: function \(\) \{[\s\S]*readingFile = false;[\s\S]*close\(\)/);
});

test('JSON replace and add actions remain busy until canvas application finishes', () => {
	assert.match(appSource, /onChoose: applyImport/);
	assert.match(supportModalSource, /await info\.onChoose\(mode\)/);
	assert.match(supportModalSource, /el\.setAttribute\('aria-busy', 'true'\)/);
	assert.match(supportModalSource, /mode === 'replace' \? 'Replacing…' : 'Adding…'/);
	assert.match(supportModalSource, /overlay\.querySelectorAll\('\[data-rom\]'\)/);
});
