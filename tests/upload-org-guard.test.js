import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rejectIfUploadOrgChanged } from '../src/sf-upload.js';

function responseCapture() {
	return {
		statusCode: null,
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

test('upload org guard allows the org used to build the upload plan', () => {
	const res = responseCapture();
	const rejected = rejectIfUploadOrgChanged({ body: { expectedSfOrgId: '00D-A' }, sf: { sfOrgId: '00D-A' } }, res);

	assert.equal(rejected, false);
	assert.equal(res.statusCode, null);
});

test('upload org guard rejects a changed active org before Salesforce writes', () => {
	const res = responseCapture();
	const rejected = rejectIfUploadOrgChanged({ body: { expectedSfOrgId: '00D-A' }, sf: { sfOrgId: '00D-B' } }, res);

	assert.equal(rejected, true);
	assert.equal(res.statusCode, 409);
	assert.equal(res.body.error, 'active-org-changed');
	assert.match(res.body.message, /Nothing was uploaded/);
});
