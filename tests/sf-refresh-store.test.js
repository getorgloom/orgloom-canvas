import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	putRefreshToken,
	getRefreshToken,
	dropRefreshToken,
	dropSessionRefreshTokens,
	_refreshStoreSize,
} from '../src/sf-refresh-store.js';

test('put + get round-trips a token for a (session, connection)', () => {
	putRefreshToken('sidA', 'conn1', 'rt-A1');
	assert.equal(getRefreshToken('sidA', 'conn1'), 'rt-A1');
	dropSessionRefreshTokens('sidA');
});

test('get returns null when nothing is stored', () => {
	assert.equal(getRefreshToken('nope', 'conn1'), null);
});

test('put no-ops on any missing part (no token persisted for the app to leak)', () => {
	const before = _refreshStoreSize();
	putRefreshToken('', 'conn1', 'rt');
	putRefreshToken('sid', '', 'rt');
	putRefreshToken('sid', 'conn1', '');
	putRefreshToken('sid', 'conn1', null);
	assert.equal(_refreshStoreSize(), before);
});

test('tokens are isolated per (session, connection)', () => {
	putRefreshToken('s1', 'c1', 'rt-11');
	putRefreshToken('s1', 'c2', 'rt-12');
	putRefreshToken('s2', 'c1', 'rt-21');
	assert.equal(getRefreshToken('s1', 'c1'), 'rt-11');
	assert.equal(getRefreshToken('s1', 'c2'), 'rt-12');
	assert.equal(getRefreshToken('s2', 'c1'), 'rt-21');
	dropSessionRefreshTokens('s1');
	dropSessionRefreshTokens('s2');
});

test('dropRefreshToken removes only the one connection', () => {
	putRefreshToken('sx', 'ca', 'rt-a');
	putRefreshToken('sx', 'cb', 'rt-b');
	dropRefreshToken('sx', 'ca');
	assert.equal(getRefreshToken('sx', 'ca'), null);
	assert.equal(getRefreshToken('sx', 'cb'), 'rt-b');
	dropSessionRefreshTokens('sx');
});

test('dropSessionRefreshTokens clears all of one session, leaves others', () => {
	putRefreshToken('keep', 'c1', 'rt-keep');
	putRefreshToken('gone', 'c1', 'rt-gone1');
	putRefreshToken('gone', 'c2', 'rt-gone2');
	dropSessionRefreshTokens('gone');
	assert.equal(getRefreshToken('gone', 'c1'), null);
	assert.equal(getRefreshToken('gone', 'c2'), null);
	assert.equal(getRefreshToken('keep', 'c1'), 'rt-keep');
	dropSessionRefreshTokens('keep');
});
