import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/public/js/bulk-ops-menu.js', import.meta.url), 'utf8');

test('fill or clear modal uses matching action and scope dropdowns', () => {
	assert.match(source, /<h3 id="af-title">Fill or clear fields<\/h3>/);
	assert.match(source, /<label class="af-label" for="af-scope">Apply to<\/label>/);
	assert.match(source, /<select id="af-scope"/);
	assert.match(source, /<select id="af-action" class="af-select">/);
	assert.match(source, /value="required">Fill empty required fields/);
	assert.match(source, /value="all" selected>Fill all empty fields/);
	assert.match(source, /value="clear">Clear fields/);
	assert.match(source, /'Clear field values'/);
	assert.doesNotMatch(source, /af-scope-opt|data-af-mode/);
});

test('reviewed fills skip a duplicate confirmation but destructive loaded-record clears do not', () => {
	assert.match(source, /bulkAutoFill\('required', 'both', \{ \.\.\.scopeOpts, skipConfirm: true \}\)/);
	assert.match(source, /bulkAutoFill\('all', 'both', \{ \.\.\.scopeOpts, skipConfirm: true \}\)/);
	assert.match(source, /bulkClearAllFields\(\{ \.\.\.scopeOpts, skipConfirm: !includeLoaded \}\)/);
	assert.match(source, /recordsForScope\(scope\)\.some\(\(record\) => !!record\.loadedFromId\)/);
});

test('the modal defaults to a non-empty record scope', () => {
	assert.match(
		source,
		/scopeSelCount > 0[\s\S]*?'selected'[\s\S]*?scopeDraftCount > 0[\s\S]*?'drafts'[\s\S]*?scopeExistingCount > 0[\s\S]*?'existing'[\s\S]*?: null/,
	);
});
