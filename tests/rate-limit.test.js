
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeLimiter } from '../src/rate-limit.js';

describe('makeLimiter', () => {
	test('rejects invalid construction', () => {
		assert.throws(() => makeLimiter({ windowMs: 0, max: 5 }), /windowMs/);
		assert.throws(() => makeLimiter({ windowMs: -1, max: 5 }), /windowMs/);
		assert.throws(() => makeLimiter({ windowMs: 1000, max: 0 }), /max/);
		assert.throws(() => makeLimiter({ windowMs: 1000, max: -1 }), /max/);
		assert.throws(() => makeLimiter({ windowMs: NaN, max: 5 }), /windowMs/);
	});

	test('first max attempts succeed, max+1 fails', () => {
		const lim = makeLimiter({ windowMs: 60_000, max: 3 });
		assert.equal(lim.take('a'), true);
		assert.equal(lim.take('a'), true);
		assert.equal(lim.take('a'), true);
		assert.equal(lim.take('a'), false);
		assert.equal(lim.take('a'), false, 'continues to reject');
	});

	test('per-key isolation: bucket A doesn\'t affect bucket B', () => {
		const lim = makeLimiter({ windowMs: 60_000, max: 2 });
		assert.equal(lim.take('a'), true);
		assert.equal(lim.take('a'), true);
		assert.equal(lim.take('a'), false, 'A exhausted');
		assert.equal(lim.take('b'), true, 'B has full budget');
		assert.equal(lim.take('b'), true);
		assert.equal(lim.take('b'), false);
	});

	test('window reset releases budget', async () => {
		const lim = makeLimiter({ windowMs: 50, max: 2 });
		assert.equal(lim.take('a'), true);
		assert.equal(lim.take('a'), true);
		assert.equal(lim.take('a'), false);
		await new Promise((r) => setTimeout(r, 70));
		assert.equal(lim.take('a'), true, 'budget restored after window');
	});

	test('coerces key to string (number key works like string key)', () => {
		const lim = makeLimiter({ windowMs: 60_000, max: 1 });
		assert.equal(lim.take(42), true);
		assert.equal(lim.take('42'), false, 'shares bucket with stringified form');
	});

	test('reset() clears all state', () => {
		const lim = makeLimiter({ windowMs: 60_000, max: 1 });
		assert.equal(lim.take('a'), true);
		assert.equal(lim.take('a'), false);
		lim.reset();
		assert.equal(lim.take('a'), true, 'budget restored after reset');
	});
});
