import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appSource = fs.readFileSync(path.resolve(here, '../src/public/js/app.js'), 'utf8');
const editorSource = fs.readFileSync(path.resolve(here, '../src/public/js/insert-modal.js'), 'utf8');

test('record editor has an explicit visible-state hook for global shortcuts', () => {
	assert.match(editorSource, /modal record-editor-modal hidden/);
});

test('canvas Ctrl+F does not intercept browser find while the record editor is open', () => {
	assert.match(appSource, /recordEditorOpen = Boolean\([\s\S]*\.record-editor-modal:not\(\.hidden\)/);
	assert.match(
		appSource,
		/!isInputTarget\s*&&\s*!recordEditorOpen\s*&&[\s\S]*\(e\.key === ['"]f['"] \|\| e\.key === ['"]F['"]\)[\s\S]*e\.preventDefault\(\)[\s\S]*openCanvasSearchModal\(\)/,
	);
});
