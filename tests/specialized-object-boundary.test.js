import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	isSpecializedSObject,
	specializedObjectError,
	specializedObjectNamesFromPayload,
} from '../src/sf-object-support.js';
import { rejectSpecializedUploadObjects } from '../src/sf-upload.js';

function responseRecorder() {
	return {
		statusCode: 200,
		body: null,
		status(code) {
			this.statusCode = code;
			return this;
		},
		json(body) {
			this.body = body;
			return this;
		},
	};
}

test('specialized object families are recognized without blocking ordinary records', () => {
	for (const name of [
		'Notice__e',
		'Config__mdt',
		'Archive__b',
		'Ledger__x',
		'Article__kav',
		'BatchApexErrorEvent',
		'LogoutEventStream',
	]) {
		assert.equal(isSpecializedSObject(name), true, name);
	}
	for (const name of ['Account', 'Event', 'event', 'Project__c']) {
		assert.equal(isSpecializedSObject(name), false, name);
	}
});

test('upload payload inspection covers records and deletes, with unique stable names', () => {
	assert.deepEqual(
		specializedObjectNamesFromPayload({
			records: [{ objectName: 'Account' }, { objectName: 'Notice__e' }, { objectName: 'Archive__b' }],
			deletes: [{ objectName: 'Notice__e' }, { objectName: 'Project__c' }],
		}),
		['Archive__b', 'Notice__e'],
	);
});

test('upload guard rejects specialized objects before Salesforce writes', () => {
	const res = responseRecorder();
	const rejected = rejectSpecializedUploadObjects(
		{ body: { records: [{ objectName: 'Account' }, { objectName: 'Config__mdt' }] } },
		res,
	);
	assert.equal(rejected, true);
	assert.equal(res.statusCode, 400);
	assert.deepEqual(res.body, specializedObjectError(['Config__mdt']));
});

test('upload guard permits standard and ordinary custom objects', () => {
	const res = responseRecorder();
	const rejected = rejectSpecializedUploadObjects(
		{ body: { records: [{ objectName: 'Account' }, { objectName: 'Project__c' }] } },
		res,
	);
	assert.equal(rejected, false);
	assert.equal(res.statusCode, 200);
	assert.equal(res.body, null);
});
