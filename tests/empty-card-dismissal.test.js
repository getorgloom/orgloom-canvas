import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appSource = fs.readFileSync(path.resolve(here, '../src/public/js/app.js'), 'utf8');
const uploadSource = fs.readFileSync(path.resolve(here, '../src/public/js/upload-modal.js'), 'utf8');
const saveLoadSource = fs.readFileSync(path.resolve(here, '../src/public/js/canvas-save-load.js'), 'utf8');

test('empty-canvas onboarding dismissal is scoped to the signed-in account', () => {
	assert.match(appSource, /window\.ORGLOOM_ACCOUNT_ID_HASH/);
	assert.match(appSource, /['"]orgloom:emptyCardDismissed:['"] \+ _canvasGuideScope/);
	assert.doesNotMatch(appSource, /const DISMISS_KEY = ['"]orgloom:emptyCardDismissed['"];/);
});

test('first-run guidance continues after adding records and retires after upload', () => {
	assert.match(appSource, /id="canvas-onboarding-progress"/);
	assert.match(appSource, /const showProgress = realCount > 0/);
	assert.match(appSource, /['"]orgloom:canvasGuideCompleted:['"] \+ _canvasGuideScope/);
	assert.match(appSource, /markCanvasGuideUploadComplete: _completeCanvasGuide/);
	assert.match(uploadSource, /if \(synced\.length > 0\) \{\s*markCanvasGuideUploadComplete\(\);/);
	assert.match(
		saveLoadSource,
		/canvasState\.currentCanvas\s*=\s*\{[\s\S]*?id:\s*data\.id,[\s\S]*?\};[\s\S]*?renderBulkView\(\);/,
	);
});
