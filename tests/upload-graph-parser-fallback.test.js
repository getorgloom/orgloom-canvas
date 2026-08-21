import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const uploadSource = fs.readFileSync(path.resolve(here, '../src/public/js/upload-modal.js'), 'utf8');
const routesSource = fs.readFileSync(path.resolve(here, '../src/canvas-routes.js'), 'utf8');

test('a rolled-back graph parser failure retries through the standard upload path', () => {
	assert.match(routesSource, /orderedResults\.some\(isSafeGraphFallbackFailure\)/);
	assert.match(routesSource, /retryWithoutGraph:/);
	assert.match(uploadSource, /body\.retryWithoutGraph === true/);
	assert.match(uploadSource, /!retryWithoutGraph && !hasUpsert/);
});

test('a rolled-back Graph operation-type limit uses the same safe fallback', () => {
	assert.match(routesSource, /isSafeGraphFallbackFailure/);
	assert.match(routesSource, /mutationSuccessCount === 0/);
	assert.match(routesSource, /successfulDeletes\.length === 0/);
});

test('graph upload stops before writing when Salesforce field metadata is unavailable', () => {
	assert.match(routesSource, /describeFailures\.push\(name\)/);
	assert.match(routesSource, /error: 'salesforce-field-metadata-unavailable'/);
	assert.match(routesSource, /No records were written\. Retry the upload/);
});
