import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
	putRefreshToken,
	getRefreshToken,
	dropRefreshToken,
	dropSessionRefreshTokens,
	_refreshStoreSize,
} from '../src/sf-refresh-store.js';

describe('in-memory Salesforce refresh-token lifecycle', () => {
	test('keeps tokens isolated by session and connection and overwrites only that key', () => {
		const sidA = `sid-a-${Date.now()}`;
		const sidB = `sid-b-${Date.now()}`;
		putRefreshToken(sidA, 'conn-1', 'refresh-a1');
		putRefreshToken(sidA, 'conn-2', 'refresh-a2');
		putRefreshToken(sidB, 'conn-1', 'refresh-b1');
		assert.equal(getRefreshToken(sidA, 'conn-1'), 'refresh-a1');
		assert.equal(getRefreshToken(sidA, 'conn-2'), 'refresh-a2');
		assert.equal(getRefreshToken(sidB, 'conn-1'), 'refresh-b1');
		putRefreshToken(sidA, 'conn-1', 'refresh-reauthed');
		assert.equal(getRefreshToken(sidA, 'conn-1'), 'refresh-reauthed');
		dropSessionRefreshTokens(sidA);
		dropSessionRefreshTokens(sidB);
	});

	test('drops one connection without affecting siblings', () => {
		const sid = `sid-one-${Date.now()}`;
		putRefreshToken(sid, 'conn-1', 'one');
		putRefreshToken(sid, 'conn-2', 'two');
		dropRefreshToken(sid, 'conn-1');
		assert.equal(getRefreshToken(sid, 'conn-1'), null);
		assert.equal(getRefreshToken(sid, 'conn-2'), 'two');
		dropSessionRefreshTokens(sid);
	});

	test('drops every credential for a signed-out session', () => {
		const baseline = _refreshStoreSize();
		const sid = `sid-all-${Date.now()}`;
		putRefreshToken(sid, 'conn-1', 'one');
		putRefreshToken(sid, 'conn-2', 'two');
		assert.equal(_refreshStoreSize(), baseline + 2);
		dropSessionRefreshTokens(sid);
		assert.equal(getRefreshToken(sid, 'conn-1'), null);
		assert.equal(getRefreshToken(sid, 'conn-2'), null);
		assert.equal(_refreshStoreSize(), baseline);
	});

	test('never stores incomplete token tuples', () => {
		const baseline = _refreshStoreSize();
		putRefreshToken('', 'conn', 'secret');
		putRefreshToken('sid', '', 'secret');
		putRefreshToken('sid', 'conn', '');
		assert.equal(_refreshStoreSize(), baseline);
	});
});
