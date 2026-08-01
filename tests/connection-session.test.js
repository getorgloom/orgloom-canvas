import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
	clearActiveSalesforceSession,
	isConnectionActive,
	removeSavedConnectionFromSession,
} from '../src/connection-session.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..');

function savedSession(overrides = {}) {
	return {
		id: 'session-1',
		saveCalls: 0,
		save(callback) {
			this.saveCalls += 1;
			callback();
		},
		...overrides,
	};
}

test('active connection detection includes the authenticated Salesforce identity', () => {
	const connection = {
		id: 'conn-1',
		sf_user_id: '005-user',
		sf_org_id: '00D-org',
	};
	const session = {
		sfAuth: { sfUserId: '005-user', sfOrgId: '00D-org' },
		currentConnectionId: null,
	};

	assert.equal(isConnectionActive({ connection, session, view: null }), true);
	assert.equal(
		isConnectionActive({
			connection,
			session: { sfAuth: { sfUserId: '005-other', sfOrgId: '00D-org' } },
			view: { current_connection_id: 'conn-1' },
		}),
		false,
	);
});

test('disconnect clears all Salesforce credentials and persists the session', async () => {
	const session = savedSession({
		sfAuth: { sfUserId: '005-user', sfOrgId: '00D-org' },
		sfAuthByConnection: { 'conn-1': { accessToken: 'secret' } },
		currentConnectionId: 'conn-1',
	});

	await clearActiveSalesforceSession({ session, accountId: null });

	assert.equal(session.sfAuth, undefined);
	assert.equal(session.sfAuthByConnection, undefined);
	assert.equal(session.currentConnectionId, null);
	assert.equal(session.forceSfIdentityPrompt, true);
	assert.equal(session.saveCalls, 1);
});

test('removing an inactive saved connection leaves the active Salesforce identity intact', async () => {
	const session = savedSession({
		sfAuth: { sfUserId: '005-active', sfOrgId: '00D-active' },
		sfAuthByConnection: {
			'conn-active': { accessToken: 'active-secret' },
			'conn-remove': { accessToken: 'removed-secret' },
		},
		currentConnectionId: 'conn-active',
	});

	await removeSavedConnectionFromSession({
		session,
		accountId: null,
		connectionId: 'conn-remove',
	});

	assert.equal(session.sfAuth.sfUserId, '005-active');
	assert.deepEqual(Object.keys(session.sfAuthByConnection), ['conn-active']);
	assert.equal(session.currentConnectionId, 'conn-active');
	assert.equal(session.saveCalls, 1);
});

test('connection routes support disconnect and a forced identity prompt', () => {
	const routes = fs.readFileSync(path.join(PACKAGE_ROOT, 'src/canvas-routes.js'), 'utf8');
	const standaloneServer = fs.readFileSync(path.join(PACKAGE_ROOT, 'src/server.js'), 'utf8');

	assert.match(routes, /app\.post\('\/api\/connections\/:id\/disconnect'/);
	assert.match(routes, /const wasActive = isConnectionActive/);
	assert.match(standaloneServer, /req\.session\.forceSfIdentityPrompt === true/);
	assert.match(standaloneServer, /delete req\.session\.forceSfIdentityPrompt/);
	assert.match(standaloneServer, /res\.redirect\('\/\?sfConnectError=invalid-domain'\)/);
});
