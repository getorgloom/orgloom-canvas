import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

test('opening the draft presence endpoint returns 405 with the supported method', () => {
	const source = readFileSync(new URL('../src/canvas-routes.js', import.meta.url), 'utf8');
	const route = source.match(/app\.all\('\/api\/canvas\/:id\/presence\/draft',[\s\S]*?\n\t\}\);/);
	assert.ok(route);
	assert.ok(source.indexOf(route[0]) > source.indexOf("app.post('/api/canvas/:id/presence/draft'"));
	let handler;
	vm.runInNewContext(route[0], {
		app: {
			all(_path, fn) {
				handler = fn;
			},
		},
	});
	const headers = {};
	let status;
	let body;
	const res = {
		set(key, value) {
			headers[key] = value;
			return this;
		},
		status(value) {
			status = value;
			return this;
		},
		json(value) {
			body = value;
			return this;
		},
	};
	for (const method of ['GET', 'HEAD', 'PUT', 'DELETE']) {
		handler({ method }, res);
		assert.equal(status, 405);
		assert.equal(headers.Allow, 'POST');
		assert.equal(body.error, 'method-not-allowed');
		assert.match(body.message, /require POST/);
	}
});
