import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rejectCanvasUploadArtifacts } from '../src/sf-upload.js';

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

test('server rejects unfinished record requests before Salesforce DML', () => {
	const res = responseCapture();
	const rejected = rejectCanvasUploadArtifacts(
		{
			body: {
				records: [
					{
						tempId: 'request',
						objectName: 'Account',
						slot: { slotId: 'slot-1', kind: 'whole-record' },
					},
				],
			},
		},
		res,
	);

	assert.equal(rejected, true);
	assert.equal(res.statusCode, 400);
	assert.equal(res.body.error, 'canvas-item-not-uploadable');
	assert.match(res.body.message, /Nothing was written/);
});

test('server allows normal records and field requests', () => {
	const res = responseCapture();
	const rejected = rejectCanvasUploadArtifacts(
		{
			body: {
				records: [
					{ tempId: 'draft', objectName: 'Account', values: { Name: 'Acme' } },
					{
						tempId: 'completed-request',
						objectName: 'Opportunity',
						values: { Name: 'Expansion' },
						slot: { slotId: 'slot-complete', kind: 'whole-record' },
					},
					{
						tempId: 'field-request',
						objectName: 'Contact',
						values: { LastName: 'User' },
						slot: { slotId: 'slot-2', kind: 'fields', fields: ['LastName'] },
					},
				],
			},
		},
		res,
	);

	assert.equal(rejected, false);
	assert.equal(res.statusCode, null);
});

test('every upload path applies the canvas-artifact guard', () => {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const source = fs.readFileSync(path.resolve(here, '../src/canvas-routes.js'), 'utf8');
	for (const route of ['/api/upload', '/api/upload/graph', '/api/upload/preflight', '/api/upload/bulk']) {
		const start = source.indexOf("app.post('" + route + "'");
		assert.notEqual(start, -1, route + ' route should exist');
		const nextRoute = source.indexOf("\n\tapp.post('", start + 1);
		const block = source.slice(start, nextRoute === -1 ? source.length : nextRoute);
		assert.match(block, /rejectCanvasUploadArtifacts\(req, res\)/, route + ' should reject artifacts');
	}
});
