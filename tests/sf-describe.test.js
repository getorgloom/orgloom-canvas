import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
	decodeValidForBitmap,
	inferScpController,
	cleanLabel,
	isNoiseSObject,
	getQueryableSObjects,
	listObjects,
} from '../src/sf-describe.js';

test('AF-040: describe-global preserves create permission for object gating', async () => {
	const conn = {
		async describeGlobal() {
			return {
				sobjects: [
					{ name: 'Allowed__c', label: 'Allowed', labelPlural: 'Allowed', queryable: true, createable: true },
					{ name: 'Denied__c', label: 'Denied', labelPlural: 'Denied', queryable: true, createable: false },
				],
			};
		},
	};
	const objects = await listObjects(conn, 'af-040');
	assert.equal(objects.find((object) => object.name === 'Allowed__c').createable, true);
	assert.equal(objects.find((object) => object.name === 'Denied__c').createable, false);
});

function fakeConn(objectNames) {
	let calls = 0;
	return {
		get describeGlobalCalls() {
			return calls;
		},
		async describeGlobal() {
			calls++;
			return { sobjects: objectNames.map((name) => ({ name, queryable: true })) };
		},
	};
}

describe('decodeValidForBitmap', () => {
	const b64 = (...bytes) => Buffer.from(bytes).toString('base64');

	test('MSB of first byte is controller index 0', () => {
		assert.deepEqual(decodeValidForBitmap(b64(0x80)), [0]);
	});

	test('two high bits → indices 0 and 1', () => {
		assert.deepEqual(decodeValidForBitmap(b64(0xc0)), [0, 1]);
	});

	test('LSB of first byte is index 7', () => {
		assert.deepEqual(decodeValidForBitmap(b64(0x01)), [7]);
	});

	test('second byte starts at index 8', () => {
		assert.deepEqual(decodeValidForBitmap(b64(0x00, 0x80)), [8]);
		assert.deepEqual(decodeValidForBitmap(b64(0x00, 0x01)), [15]);
	});

	test('mixed multi-byte bitmap decodes every set bit in order', () => {
		assert.deepEqual(decodeValidForBitmap(b64(0xa0, 0x05)), [0, 2, 13, 15]);
	});

	test('all-zero bitmap → no valid controller values', () => {
		assert.deepEqual(decodeValidForBitmap(b64(0x00, 0x00)), []);
	});

	test('null / undefined / non-string → empty array', () => {
		assert.deepEqual(decodeValidForBitmap(null), []);
		assert.deepEqual(decodeValidForBitmap(undefined), []);
		assert.deepEqual(decodeValidForBitmap(42), []);
		assert.deepEqual(decodeValidForBitmap(''), []);
	});
});

describe('inferScpController', () => {
	const fields = [
		{ name: 'BillingStateCode' },
		{ name: 'BillingCountryCode' },
		{ name: 'ShippingState' },
		{ name: 'Status' },
	];

	test('StateCode field maps to the matching CountryCode field', () => {
		assert.equal(inferScpController('BillingStateCode', fields), 'BillingCountryCode');
	});

	test('no matching Country field → null', () => {
		assert.equal(inferScpController('ShippingState', fields), null);
	});

	test('non-State fields → null', () => {
		assert.equal(inferScpController('Status', fields), null);
		assert.equal(inferScpController('Industry', fields), null);
	});
});

describe('cleanLabel', () => {
	test('passes normal labels through', () => {
		assert.equal(cleanLabel('Account', 'Fallback'), 'Account');
	});

	test('__MISSING LABEL__ placeholder falls back', () => {
		assert.equal(cleanLabel('__MISSING LABEL__ PropertyFile x', 'MyObj__c'), 'MyObj__c');
	});

	test('non-string label falls back', () => {
		assert.equal(cleanLabel(null, 'X'), 'X');
		assert.equal(cleanLabel(undefined, 'X'), 'X');
	});
});

describe('isNoiseSObject', () => {
	test('business objects are kept', () => {
		for (const n of ['Account', 'Contact', 'Opportunity', 'Case', 'Lead', 'Order', 'Product2']) {
			assert.equal(isNoiseSObject(n), false, n + ' should be kept');
		}
	});

	test('custom objects are ALWAYS kept, even noise-shaped names', () => {
		assert.equal(isNoiseSObject('My_Custom__c'), false);
		assert.equal(isNoiseSObject('AccountHistory__c'), false, '__c beats the History suffix rule');
		assert.equal(isNoiseSObject('FlowThing__c'), false, '__c beats the Flow prefix rule');
	});

	test('system suffixes are filtered', () => {
		for (const n of ['AccountHistory', 'AccountFeed', 'AccountShare', 'AccountChangeEvent']) {
			assert.equal(isNoiseSObject(n), true, n + ' should be noise');
		}
	});

	test('system prefixes and exact names are filtered', () => {
		for (const n of [
			'ApexClass',
			'AuthProvider',
			'ContentDocument',
			'PermissionSet',
			'RecentlyViewed',
			'AsyncApexJob',
		]) {
			assert.equal(isNoiseSObject(n), true, n + ' should be noise');
		}
	});

	test('empty / null names are noise (defensive)', () => {
		assert.equal(isNoiseSObject(''), true);
		assert.equal(isNoiseSObject(null), true);
	});
});

describe('getQueryableSObjects cache isolation', () => {
	test('caches per truthy orgId (second call skips describeGlobal)', async () => {
		const conn = fakeConn(['Account', 'Contact']);
		const set1 = await getQueryableSObjects(conn, 'org-cache-A');
		const set2 = await getQueryableSObjects(conn, 'org-cache-A');
		assert.ok(set1.has('Account') && set1.has('Contact'));
		assert.equal(conn.describeGlobalCalls, 1, 'second call served from cache');
		assert.equal(set1, set2, 'same cached Set instance');
	});

	test('falsy orgId is NEVER cached: two orgs never cross-contaminate', async () => {
		const orgA = fakeConn(['Account', 'CustomA__c']);
		const orgB = fakeConn(['Account', 'CustomB__c']);
		const setA = await getQueryableSObjects(orgA, null);
		const setB = await getQueryableSObjects(orgB, null);
		assert.ok(setA.has('CustomA__c') && !setA.has('CustomB__c'), 'org A gets only its own objects');
		assert.ok(setB.has('CustomB__c') && !setB.has('CustomA__c'), 'org B not contaminated by org A');
		assert.equal(orgA.describeGlobalCalls, 1);
		assert.equal(orgB.describeGlobalCalls, 1);
		const setA2 = await getQueryableSObjects(orgA, null);
		assert.equal(orgA.describeGlobalCalls, 2, 'falsy org re-fetches every call');
		assert.ok(setA2.has('CustomA__c'));
	});
});
