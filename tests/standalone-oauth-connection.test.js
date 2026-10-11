import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('standalone Salesforce OAuth stores the unwrapped connection in the session', () => {
	assert.match(source, /const \{ connection \} = await connectionsDb\.upsertSalesforceConnectionMetadata\(\{/);
	assert.match(source, /req\.session\.currentConnectionId = connection\.id;/);
	assert.match(source, /req\.session\.sfAuthByConnection\[connection\.id\] = _sfAuth;/);
});
