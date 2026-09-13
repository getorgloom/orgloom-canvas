import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const css = readFileSync(new URL('../src/public/css/app.css', import.meta.url), 'utf8');
const recordsCanvas = readFileSync(new URL('../src/public/js/records-canvas.js', import.meta.url), 'utf8');

test('record names truncate visually while retaining the full escaped text for hover', () => {
	assert.match(
		css,
		/\.record-card \.record-title\s*\{[^}]*max-width:\s*100%[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/s,
	);
	assert.match(recordsCanvas, /'<div class="record-title" title="'\s*\+\s*escapeHtml\(titleText\)/);
	assert.match(recordsCanvas, /escapeHtml\(titleText \+ ' — Open in Salesforce/);
});

test('draft title hover uses the canvas surface without intercepting drag or exposing inaccessible names', () => {
	const handlers = new Map();
	const fullName = 'A'.repeat(300);
	const record = { id: 1 };
	const container = {
		title: '',
		querySelector: () => ({ getAttribute: () => fullName }),
		removeAttribute: () => {
			container.title = '';
		},
	};
	const start = recordsCanvas.indexOf("getCyInstance().on('mouseover', 'node'");
	const end = recordsCanvas.indexOf("getCyInstance().on('tap', 'node'", start);
	vm.runInNewContext(recordsCanvas.slice(start, end), {
		getCyInstance: () => ({ on: (events, selector, callback) => handlers.set(events, callback || selector) }),
		canvasState: { bulkRecords: [record] },
		container,
	});
	const hover = () => handlers.get('mouseover')({ target: { data: () => 1 } });
	hover();
	assert.equal(container.title, fullName);
	handlers.get('mouseout grab')();
	assert.equal(container.title, '');
	hover();
	handlers.get('pan zoom')();
	assert.equal(container.title, '');
	record._inaccessible = true;
	hover();
	assert.equal(container.title, '');
});

test('long request summary badges stay within record request cards', () => {
	assert.match(recordsCanvas, /class="slot-assignee-wrap"/);
	assert.match(css, /\.record-card-slot \.record-slot-tag\s*\{[^}]*width:\s*100%[^}]*flex-wrap:\s*wrap/s);
	assert.match(css, /\.record-card-slot \.slot-assignee-wrap\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%/s);
	assert.match(
		css,
		/\.record-request-summary-badge\s*\{[^}]*max-width:\s*100%[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis/s,
	);
});

test('field-request summary badges wrap without overlapping', () => {
	assert.match(recordsCanvas, /class="record-request-badges"/);
	assert.match(css, /\.record-card \.record-request-badges\s*\{[^}]*width:\s*100%[^}]*flex-wrap:\s*wrap/s);
	assert.match(
		css,
		/\.record-card \.record-request-badges \.record-request-summary-badge\s*\{[^}]*max-width:\s*100%/s,
	);
});
