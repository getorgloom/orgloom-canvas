import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const appSource = readFileSync(new URL('../src/public/js/app.js', import.meta.url), 'utf8');
const linkedCsvSource = readFileSync(new URL('../src/public/js/linked-csv.js', import.meta.url), 'utf8');
const uploadModalSource = readFileSync(new URL('../src/public/js/upload-modal.js', import.meta.url), 'utf8');
const routeSource = readFileSync(new URL('../src/canvas-routes.js', import.meta.url), 'utf8');
const topStripSource = readFileSync(new URL('../src/views/partials/top-strip.ejs', import.meta.url), 'utf8');

test('CSV import only stages records on the canvas', () => {
	assert.doesNotMatch(appSource, /data-quick-upload|__orgloomQuickUpload/);
	assert.doesNotMatch(linkedCsvSource, /skipCanvas|linked-csv-upload|quick-upload/i);
	assert.match(linkedCsvSource, /id="linked-csv-replace"/);
	assert.match(linkedCsvSource, /id="linked-csv-confirm"/);
	assert.doesNotMatch(uploadModalSource, /directUpload|isLinkedCsvQuickUploadMode/);
	assert.doesNotMatch(topStripSource, /data-quick-upload|Quick Upload/);
});

test('upload APIs cannot bypass canvas accounting through a request flag', () => {
	assert.doesNotMatch(routeSource, /directUpload|csv-direct|csv-bulk/);
	assert.equal((routeSource.match(/getQuota\(req\.account, 'uploads'/g) || []).length, 3);
	assert.equal((routeSource.match(/chargeQuota\(req\.account, 'uploads', 1/g) || []).length, 3);
});
