import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/public/js/soql-import.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/public/css/app.css', import.meta.url), 'utf8');

test('SOQL import hides the internal member grant error code', () => {
	assert.match(source, /code !== 'query-failed' && code !== 'member-grant-required'/);
});

test('SOQL results and errors are separated from the field-loading option', () => {
	assert.match(styles, /\.soql-import-modal \.soql-preview:not\(:empty\)\s*{\s*margin-top: 0\.75em;/);
});
