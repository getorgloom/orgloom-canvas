import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const readPublicSource = (name) => fs.readFileSync(path.resolve(here, '../src/public/js/', name), 'utf8');

test('customer-facing relationship copy uses plain relationship language', () => {
	const source = [
		'preflight.js',
		'linked-csv.js',
		'bulk-ops-menu.js',
		'ai-proposals.js',
		'app.js',
		'find-object-popover.js',
	]
		.map(readPublicSource)
		.join('\n');

	assert.doesNotMatch(
		source,
		/no FK links|FK columns|FK linking|Draft FK|reference this record via FK|audit FK spokes|FK-driven selections/i,
	);
	assert.match(source, /relationship to another canvas record/);
	assert.match(source, /matching values build canvas relationships/);
});
