


import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ext } from '../src/extensions.js';

beforeEach(() => ext._resetForTests());

describe('getCapability default', () => {
	test('known capability returns allowed', async () => {
		const r = await ext.getCapability({ id: 'a1' }, 'share-canvas');
		assert.equal(r.allowed, true);
		assert.equal(r.plan, 'self-host');
		assert.equal(r.role, 'admin');
	});

	test('unknown capability returns unknown-capability reason', async () => {
		const r = await ext.getCapability({ id: 'a1' }, 'made-up-cap');
		assert.equal(r.allowed, false);
		assert.equal(r.reason, 'unknown-capability');
		assert.equal(r.capability, 'made-up-cap');
	});

	test('every name in CAPABILITIES is permitted by default', async () => {
		const { CAPABILITIES } = await import('../src/capabilities.js');
		for (const name of Object.keys(CAPABILITIES)) {
			const r = await ext.getCapability({ id: 'a1' }, name);
			assert.equal(r.allowed, true, `default should permit ${name}`);
		}
	});
});

describe('getQuota / chargeQuota defaults', () => {
	test('getQuota returns no cap', async () => {
		const r = await ext.getQuota({ id: 'a1' }, 'ai_tokens');
		assert.equal(r.cap, null);
		assert.equal(r.used, 0);
		assert.equal(r.remaining, Infinity);
	});

	test('chargeQuota always allows', async () => {
		const r = await ext.chargeQuota({ id: 'a1' }, 'uploads', 1);
		assert.equal(r.allowed, true);
		assert.equal(r.remaining, Infinity);
	});

	test('chargeQuota with large amount still allows', async () => {
		const r = await ext.chargeQuota({ id: 'a1' }, 'ai_tokens', 10_000_000);
		assert.equal(r.allowed, true);
	});
});

describe('getCurrentAccount default', () => {
	test('returns null when no session', async () => {
		const r = await ext.getCurrentAccount({});
		assert.equal(r, null);
	});

	test('returns account-shaped object when session present', async () => {
		const r = await ext.getCurrentAccount({ session: { accountId: 'acc_123' } });
		assert.deepEqual(r, { id: 'acc_123' });
	});

	test('returns null when session lacks accountId', async () => {
		const r = await ext.getCurrentAccount({ session: {} });
		assert.equal(r, null);
	});
});

describe('getActiveWorkspace default', () => {
	test('returns null', async () => {
		const r = await ext.getActiveWorkspace({});
		assert.equal(r, null);
	});
});

describe('getPlanInfo default', () => {
	test('returns self-host tier', async () => {
		const r = await ext.getPlanInfo({ id: 'a1' });
		assert.equal(r.tier, 'self-host');
		assert.equal(r.label, 'Self-host');
	});
});

describe('auditRetentionDays default', () => {
	test('returns null (no expiry)', async () => {
		const r = await ext.auditRetentionDays('ws_1');
		assert.equal(r, null);
	});
});

describe('saasMounted flag', () => {
	test('defaults to false', () => {
		assert.equal(ext.saasMounted, false);
	});

	test('is reset by _resetForTests', () => {
		ext.saasMounted = true;
		ext._resetForTests();
		assert.equal(ext.saasMounted, false);
	});
});

describe('partial / nav defaults', () => {
	test('getPartialPath returns null for unregistered name', () => {
		assert.equal(ext.getPartialPath('top-strip'), null);
	});

	test('getNavLinks returns empty array initially', () => {
		assert.deepEqual(ext.getNavLinks(), []);
	});

	test('getMigrationsDirs returns empty array initially', () => {
		assert.deepEqual(ext.getMigrationsDirs(), []);
	});
});
