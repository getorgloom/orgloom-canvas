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
const ROOT = path.resolve(HERE, '../../..');

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

test('connections modal exposes distinct Disconnect and Remove actions', () => {
	const source = fs.readFileSync(path.join(ROOT, 'apps/saas/src/public/js/sf-connections-modal.js'), 'utf8');
	const routes = fs.readFileSync(path.join(ROOT, 'packages/canvas/src/canvas-routes.js'), 'utf8');
	const hostedServer = fs.readFileSync(path.join(ROOT, 'apps/saas/src/server.js'), 'utf8');
	const standaloneServer = fs.readFileSync(path.join(ROOT, 'packages/canvas/src/server.js'), 'utf8');

	assert.match(source, /acct-conn-disconnect[\s\S]*?>Disconnect<\/button>/);
	assert.match(source, /acct-conn-remove[\s\S]*?>Remove<\/button>/);
	assert.match(source, /\/api\/connections\/[^'\n]+\/disconnect/);
	assert.match(source, /const forceQuery = forceIdentity \? '&force=1' : ''/);
	assert.match(source, /name="force" value="1"/);
	assert.match(source, /That URL wasn\\'t recognized/);
	assert.match(source, /sfConnectError/);
	assert.match(routes, /app\.post\('\/api\/connections\/:id\/disconnect'/);
	assert.match(routes, /const wasActive = isConnectionActive/);
	for (const server of [hostedServer, standaloneServer]) {
		assert.match(server, /req\.session\.forceSfIdentityPrompt === true/);
		assert.match(server, /delete req\.session\.forceSfIdentityPrompt/);
		assert.match(server, /res\.redirect\('\/\?sfConnectError=invalid-domain'\)/);
	}
});
