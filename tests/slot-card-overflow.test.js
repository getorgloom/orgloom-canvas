import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/public/css/app.css', import.meta.url), 'utf8');
const recordsCanvas = readFileSync(new URL('../src/public/js/records-canvas.js', import.meta.url), 'utf8');

test('long slot assignee badges stay within record request cards', () => {
	assert.match(recordsCanvas, /class="slot-assignee-wrap"/);
	assert.match(css, /\.record-card-slot \.record-slot-tag\s*\{[^}]*width:\s*100%[^}]*flex-wrap:\s*wrap/s);
	assert.match(css, /\.record-card-slot \.slot-assignee-wrap\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%/s);
	assert.match(
		css,
		/\.slot-assignee-badge\s*\{[^}]*max-width:\s*100%[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis/s,
	);
});
