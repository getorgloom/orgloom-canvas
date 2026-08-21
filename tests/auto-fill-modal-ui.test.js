import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/public/js/bulk-ops-menu.js', import.meta.url), 'utf8');

test('fill or clear modal presents two compact choices and a specific action button', () => {
	assert.match(source, /<h3>Fill or clear fields<\/h3>/);
	assert.match(source, /<div class="af-label">Records<\/div>/);
	assert.match(source, /<div class="af-label">Action<\/div>/);
	assert.match(source, />Fill required<\/button>/);
	assert.match(source, />Fill empty fields<\/button>/);
	assert.match(source, />Clear fields<\/button>/);
	assert.match(source, /'Clear field values'/);
	assert.doesNotMatch(source, /af-action-card/);
	assert.doesNotMatch(source, /<h3>Fill or clear records<\/h3>/);
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

test('the preview uses one concise action-focused sentence', () => {
	assert.match(
		source,
		/All empty '[\s\S]*?'fields across '[\s\S]*?affectedRecords[\s\S]*?' will be populated with generated data\.'/,
	);
	assert.match(source, /All field values across ' \+ affectedRecords \+ ' will be cleared\./);
	assert.match(source, /records\.length === 1 \? 'record' : 'records'/);
	assert.doesNotMatch(source, /Open one of these records once/);
	assert.doesNotMatch(source, /next upload pushes/);
});
