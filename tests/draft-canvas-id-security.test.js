import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/public/js/app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('\tfunction _secureDraftUuid(cryptoApi) {');
const end = source.indexOf('\n\tfunction _ensureDraftCanvasId()', start);
assert.ok(start >= 0 && end > start, 'secure draft UUID helper must remain available');
const context = {};
vm.runInNewContext(source.slice(start, end) + '\nthis.secureDraftUuid = _secureDraftUuid;', context);
const secureDraftUuid = context.secureDraftUuid;

test('draft canvas identity prefers crypto.randomUUID', () => {
	const expected = '11111111-2222-4333-8444-555555555555';
	assert.equal(secureDraftUuid({ randomUUID: () => expected }), expected);
});

test('draft canvas identity uses getRandomValues as a secure UUID v4 fallback', () => {
	const uuid = secureDraftUuid({
		getRandomValues(bytes) {
			bytes.fill(0);
			return bytes;
		},
	});
	assert.equal(uuid, '00000000-0000-4000-8000-000000000000');
});

test('draft canvas identity fails closed when Web Crypto is unavailable', () => {
	assert.throws(() => secureDraftUuid(null), /Secure browser randomness is required/);
	assert.doesNotMatch(source, /Math\.random/);
});
