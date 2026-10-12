import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('production startup reports a short session secret without logging its value or length', () => {
	const secret = 'short-secret';
	const configUrl = new URL('../src/config.js', import.meta.url);
	const result = spawnSync(
		process.execPath,
		['--input-type=module', '--eval', `import(${JSON.stringify(configUrl.href)})`],
		{
			encoding: 'utf8',
			env: {
				...process.env,
				NODE_ENV: 'production',
				SESSION_SECRET: secret,
			},
		},
	);
	const output = String(result.stderr || '') + String(result.stdout || '');
	assert.equal(result.status, 1);
	assert.match(output, /SESSION_SECRET is too short/);
	assert.doesNotMatch(output, new RegExp(secret));
	assert.doesNotMatch(output, /\(\d+ chars\)/);
});
