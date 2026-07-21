import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../src/public/js/linked-csv.js'), 'utf8');

test('Quick Upload paints and announces a busy state before preparing the upload', () => {
	assert.match(source, /setQuickUploadPreparing\(state, true\)/);
	assert.match(source, /requestAnimationFrame\(resolve\)/);
	assert.match(source, /Preparing upload&hellip;/);
	assert.match(source, /setAttribute\('aria-busy', 'true'\)/);
});

test('Quick Upload prevents duplicate confirmation and restores controls after preparation', () => {
	assert.match(source, /state\.preparingUpload/);
	assert.match(source, /finally\s*{\s*setQuickUploadPreparing\(state, false\)/);
	assert.match(source, /allowWhilePreparing: true/);
});

test('Quick Upload preparation does not wait on the account endpoint', () => {
	assert.doesNotMatch(source, /planConnectionPromise/);
	assert.doesNotMatch(source, /csrfFetch\('\/api\/me'/);
});

test('Quick Upload reuses mapped describes instead of loading schema graphs serially', () => {
	assert.match(source, /if \(skipCanvas\)\s*{[\s\S]*?label: \(file\.describe && file\.describe\.label\)/);
	assert.match(source, /addedVia: 'quick-upload'/);
	assert.match(source, /canvasState\.selectedIdSeq = _preImportSelectedIdSeq/);
});
