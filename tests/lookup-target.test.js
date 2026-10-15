import assert from 'node:assert/strict';
import { test } from 'node:test';

import { _resolveLookupTargetForTests } from '../src/canvas-routes.js';

test('a polymorphic lookup requires an explicit allowed target', () => {
	assert.deepEqual(_resolveLookupTargetForTests(['Contact', 'Lead'], null), {
		ok: false,
		error: 'lookup-target-required',
	});
	assert.deepEqual(_resolveLookupTargetForTests(['Contact', 'Lead'], 'Lead'), {
		ok: true,
		targetApiName: 'Lead',
	});
});

test('a lookup cannot be redirected to an unrelated object', () => {
	assert.deepEqual(_resolveLookupTargetForTests(['Contact', 'Lead'], 'Account'), {
		ok: false,
		error: 'invalid-lookup-target',
	});
	assert.deepEqual(_resolveLookupTargetForTests(['Contact'], null), {
		ok: true,
		targetApiName: 'Contact',
	});
});
