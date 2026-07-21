import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const presenceSource = readFileSync(new URL('../src/public/js/presence.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/public/js/app.js', import.meta.url), 'utf8');

test('owned canvases wait for an actual share before opening the presence stream', () => {
	assert.match(presenceSource, /current\.ownedByMe && !\(_shareCounts\.get\(current\.id\) > 0\)/);
	assert.match(presenceSource, /orgloom:canvas-share-count/);
	assert.match(appSource, /new CustomEvent\('orgloom:canvas-share-count'/);
});
