import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/public/js/app.js', import.meta.url), 'utf8');

test('session describe cache is scoped to both Salesforce org and user', () => {
	assert.match(source, /const DESCRIBE_STORAGE_PREFIX = 'orgloom-describe-v5'/);
	assert.match(source, /const DESCRIBE_STORAGE_ORG = window\.SF_ORG_ID \|\| 'unknown'/);
	assert.match(source, /const DESCRIBE_STORAGE_USER = window\.SF_USER_ID \|\| 'unknown'/);
	assert.match(
		source,
		/return DESCRIBE_STORAGE_PREFIX \+ '\|' \+ DESCRIBE_STORAGE_ORG \+ '\|' \+ DESCRIBE_STORAGE_USER \+ '\|' \+ name/,
	);
});
