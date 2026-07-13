import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { initTestDb } from './helpers/db.js';
import { ext } from '../src/extensions.js';

let app;
let server;
let baseUrl;

let injectFakeSf = false;
let activeMock = null;

let resetRateLimit = null;
let RATE_LIMIT = null;

let currentAccountId = 'acc_test';

function makeRows(n, type = 'Account', startAt = 1) {
	const out = [];
	for (let i = 0; i < n; i++) {
		out.push({
			Id: '001' + String(startAt + i).padStart(15, '0'),
			Name: type + ' ' + (startAt + i),
			attributes: { type },
		});
	}
	return out;
}

function makeChildRows(n, type = 'Contact') {
	const out = [];
	for (let i = 0; i < n; i++) {
		out.push({
			Id: '003' + String(i + 1).padStart(15, '0'),
			FirstName: 'C' + i,
			AccountId: '001000000000001',
			attributes: { type },
		});
	}
	return out;
}

function makeMockConn() {
	const captured = { queries: [], retrieves: [] };
	let nextQueryResult = { records: [], totalSize: 0, done: true };
	const describes = {
		Account: {
			name: 'Account',
			fields: [
				{ name: 'Id' }, { name: 'Name' }, { name: 'Industry' },
				{ name: 'Phone' }, { name: 'Type' },
			],
			childRelationships: [
				{ relationshipName: 'Contacts', childSObject: 'Contact', field: 'AccountId' },

				{ relationshipName: 'Tasks', childSObject: 'Task', field: 'WhatId' },

				{ relationshipName: 'SetupAuditTrails', childSObject: 'SetupAuditTrail', field: 'CreatedById' },
			],
		},
		Contact: {
			name: 'Contact',
			fields: [{ name: 'Id' }, { name: 'FirstName' }, { name: 'LastName' }, { name: 'AccountId' }],
			childRelationships: [],
		},
		Task: {
			name: 'Task',
			fields: [{ name: 'Id' }, { name: 'Subject' }, { name: 'WhatId' }, { name: 'WhoId' }],
			childRelationships: [],
		},

		User: {
			name: 'User',
			fields: [{ name: 'Id' }, { name: 'Name' }, { name: 'Email' }, { name: 'ProfileId' }],
			childRelationships: [],
		},
	};
	const conn = {
		query: async (soql) => {
			captured.queries.push(soql);
			return nextQueryResult;
		},
		sobject: (name) => ({
			describe: async () => {
				if (!describes[name]) {
					throw new Error('NOT_FOUND: sObject type ' + name + ' is not supported.');
				}
				return describes[name];
			},
			retrieve: async (ids) => {
				captured.retrieves.push({ name, ids: Array.isArray(ids) ? ids.slice() : [ids] });
				const arr = Array.isArray(ids) ? ids : [ids];

				return arr.map((id) => ({ Id: id, Name: 'Full ' + id, Industry: 'Tech', attributes: { type: name } }));
			},
		}),
	};
	return {
		conn,
		captured,
		describes,
		setNextQueryResult: (r) => {
 nextQueryResult = r; 
},
	};
}

const post = (body) =>
	fetch(baseUrl + '/api/query', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});

before(async () => {
	await initTestDb();
	const dbProvider = ext.getDb;
	const rawProvider = ext.getRawClient;
	ext._resetForTests();
	ext.registerDbProvider(() => dbProvider());
	ext.registerRawClientProvider(() => rawProvider());

	ext.registerAuthProvider(async () => ({ id: currentAccountId, email: 'test@x.com' }));
	ext.registerCapabilityResolver(async () => ({ allowed: true, role: 'admin', plan: 'team' }));

	app = express();
	app.use(express.json());
	app.use((req, _res, next) => {
 req.session = {}; next(); 
});

	app.use('/api/query', (req, _res, next) => {
		if (injectFakeSf && activeMock) {
			req.sf = {
				conn: activeMock.conn,
				sfOrgId: '00DTEST',
				sfUserId: '005TEST',
				instanceUrl: 'https://test.my.salesforce.com',
			};
		}
		next();
	});

	const routes = await import('../src/canvas-routes.js');
	const { mountCanvasRoutes } = routes;
	resetRateLimit = routes._resetSfReadRateLimitForTests;
	RATE_LIMIT = routes.SF_READ_RATE_LIMIT;
	mountCanvasRoutes(app);
	ext.flush(app);

	server = await new Promise((resolve) => {
		const s = app.listen(0, () => resolve(s));
	});
	baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
	if (server) {
		await new Promise((r) => server.close(r));
	}
});

beforeEach(() => {
	injectFakeSf = true;
	activeMock = makeMockConn();
	currentAccountId = 'acc_test';

	if (resetRateLimit) {
		resetRateLimit();
	}
});

describe('Finding #1: safety LIMIT append is robust to string/subquery LIMITs', () => {
	test('control: a query with no LIMIT gets " LIMIT 500" appended', async () => {
		activeMock.setNextQueryResult({ records: makeRows(2), totalSize: 2, done: true });
		const soql = 'SELECT Id, Name FROM Account';
		const r = await post({ soql, fullFields: false });
		assert.equal(r.status, 200);
		assert.equal(activeMock.captured.queries.length, 1);
		assert.equal(activeMock.captured.queries[0], soql + ' LIMIT 500');
	});

	test('FIXED: a LIMIT in a WHERE string literal still gets the cap appended', async () => {
		activeMock.setNextQueryResult({ records: makeRows(2), totalSize: 2, done: true });
		const soql = "SELECT Id, Name FROM Account WHERE Name LIKE '%LIMIT 5%'";
		const r = await post({ soql, fullFields: false });
		assert.equal(r.status, 200);
		const sent = activeMock.captured.queries[0];

		assert.equal(sent, soql + ' LIMIT 500', 'safety LIMIT 500 appended despite the in-string LIMIT');
	});

	test('an explicit LIMIT above the cap is lowered to 500 in place', async () => {
		activeMock.setNextQueryResult({ records: makeRows(2), totalSize: 2, done: true });
		const r = await post({ soql: 'SELECT Id FROM Account LIMIT 1000', fullFields: false });
		assert.equal(r.status, 200);
		const sent = activeMock.captured.queries[0];
		assert.equal(sent, 'SELECT Id FROM Account LIMIT 500');
		assert.ok(!/LIMIT\s+1000/i.test(sent), 'the over-cap LIMIT was rewritten');
	});

	test('an explicit LIMIT at/under the cap is respected verbatim', async () => {
		activeMock.setNextQueryResult({ records: makeRows(2), totalSize: 2, done: true });
		const soql = 'SELECT Id FROM Account LIMIT 100';
		const r = await post({ soql, fullFields: false });
		assert.equal(r.status, 200);
		assert.equal(activeMock.captured.queries[0], soql, 'a user LIMIT <= cap is untouched');
	});

	test('an inner-subquery LIMIT is preserved while the outer cap is appended', async () => {
		const parent = makeRows(1)[0];
		parent.Contacts = { records: makeChildRows(3), totalSize: 3, done: true };
		activeMock.setNextQueryResult({ records: [parent], totalSize: 1, done: true });
		const soql = 'SELECT Id, (SELECT Id FROM Contacts LIMIT 5) FROM Account';
		const r = await post({ soql, fullFields: false });
		assert.equal(r.status, 200);
		const sent = activeMock.captured.queries[0];
		assert.ok(/FROM Contacts LIMIT 5/i.test(sent), 'inner subquery LIMIT preserved');
		assert.ok(/\)\s+FROM Account LIMIT 500$/i.test(sent), 'outer safety LIMIT appended');
	});
});

describe('Finding #2: silent truncation is now surfaced via `capped`', () => {
	test('a capped 500-row result reports capped:true + truncated:true', async () => {
		activeMock.setNextQueryResult({ records: makeRows(500), totalSize: 500, done: true });
		const r = await post({ soql: 'SELECT Id FROM Account', fullFields: false });
		assert.equal(r.status, 200);
		const body = await r.json();
		assert.equal(body.returned, 500);
		assert.equal(body.capped, true, 'the imposed cap + full page is flagged');
		assert.equal(body.truncated, true);
		assert.equal(body.cap, 500);
	});

	test('a user-chosen LIMIT <= cap that fills is NOT reported as capped', async () => {
		activeMock.setNextQueryResult({ records: makeRows(100), totalSize: 100, done: true });
		const r = await post({ soql: 'SELECT Id FROM Account LIMIT 100', fullFields: false });
		assert.equal(r.status, 200);
		const body = await r.json();
		assert.equal(body.capped, false, 'a deliberate user LIMIT is not a silent cap');
		assert.equal(body.truncated, false);
	});

	test('a partial result (fewer than cap) is not capped', async () => {
		activeMock.setNextQueryResult({ records: makeRows(37), totalSize: 37, done: true });
		const r = await post({ soql: 'SELECT Id FROM Account', fullFields: false });
		const body = await r.json();
		assert.equal(body.capped, false);
		assert.equal(body.truncated, false);
	});
});

describe('500-row cap boundary', () => {
	test('exactly 500 records is accepted', async () => {
		activeMock.setNextQueryResult({ records: makeRows(500), totalSize: 500, done: true });
		const r = await post({ soql: 'SELECT Id FROM Account', fullFields: false });
		assert.equal(r.status, 200);
		const body = await r.json();
		assert.equal(body.records.length, 500);
	});

	test('501 flat records is rejected with result-exceeds-cap', async () => {
		activeMock.setNextQueryResult({ records: makeRows(501), totalSize: 501, done: true });
		const r = await post({ soql: 'SELECT Id FROM Account', fullFields: false });
		assert.equal(r.status, 400);
		const body = await r.json();
		assert.equal(body.error, 'result-exceeds-cap');
	});

	test('subquery children pushing the total over 500 are rejected', async () => {
		const parent = makeRows(1)[0];
		parent.Contacts = { records: makeChildRows(501), totalSize: 501, done: true };
		activeMock.setNextQueryResult({ records: [parent], totalSize: 1, done: true });
		const r = await post({
			soql: 'SELECT Id, Name, (SELECT Id, FirstName FROM Contacts) FROM Account',
			fullFields: false,
		});
		assert.equal(r.status, 400);
		const body = await r.json();
		assert.equal(body.error, 'result-exceeds-cap');
	});
});

describe('Finding #3: denylist scope', () => {
	test('control: ApexClass is blocked before any query runs', async () => {
		const r = await post({ soql: 'SELECT Id, Name FROM ApexClass', fullFields: false });
		assert.equal(r.status, 400);
		const body = await r.json();
		assert.equal(body.error, 'object-not-allowed');
		assert.equal(activeMock.captured.queries.length, 0, 'denied object must not reach SF');
	});

	test('User is queryable (removed from the denylist)', async () => {
		activeMock.setNextQueryResult({ records: makeRows(2, 'User'), totalSize: 2, done: true });
		const r = await post({ soql: 'SELECT Id, Name FROM User', fullFields: false });
		assert.equal(r.status, 200, 'User passes the denylist and executes');
		assert.equal(activeMock.captured.queries.length, 1);
	});

	test('Profile stays blocked', async () => {
		const r = await post({ soql: 'SELECT Id FROM Profile', fullFields: false });
		assert.equal(r.status, 400);
		assert.equal((await r.json()).error, 'object-not-allowed');
		assert.equal(activeMock.captured.queries.length, 0, 'Profile must not reach SF');
	});

	test('AuthSession / SetupAuditTrail are blocked', async () => {
		for (const obj of ['AuthSession', 'SetupAuditTrail', 'OAuthToken', 'LoginHistory']) {
			const r = await post({ soql: 'SELECT Id FROM ' + obj, fullFields: false });
			assert.equal(r.status, 400, obj + ' should be denied');
			assert.equal((await r.json()).error, 'object-not-allowed');
		}
		assert.equal(activeMock.captured.queries.length, 0);
	});

	test('FIXED: a subquery onto a denylisted child object is blocked', async () => {
		const r = await post({
			soql: 'SELECT Id, (SELECT Id FROM SetupAuditTrails) FROM Account',
			fullFields: false,
		});
		assert.equal(r.status, 400);
		assert.equal((await r.json()).error, 'object-not-allowed');
		assert.equal(activeMock.captured.queries.length, 0, 'denied child must not reach SF');
	});
});

describe('Finding #5: full-fields rehydration amplifies the fetch', () => {
	test('default fullFields=true triggers a retrieve() beyond the projection', async () => {
		activeMock.setNextQueryResult({ records: makeRows(3), totalSize: 3, done: true });
		const r = await post({ soql: 'SELECT Id FROM Account' });
		assert.equal(r.status, 200);
		const body = await r.json();
		assert.ok(activeMock.captured.retrieves.length >= 1, 'a retrieve() was issued');

		assert.ok('Industry' in body.records[0].values, 'rehydrated record gained a non-projected field');
	});
});

describe('Finding #4: sliding-window rate limit', () => {
	test('requests up to the limit pass, then 429 with Retry-After', async () => {
		const max = (RATE_LIMIT && RATE_LIMIT.max) || 60;
		let ok = 0;
		for (let i = 0; i < max; i++) {
			activeMock.setNextQueryResult({ records: makeRows(1), totalSize: 1, done: true });
			const r = await post({ soql: 'SELECT Id FROM Account', fullFields: false });
			if (r.status === 200) {
				ok++;
			}
		}
		assert.equal(ok, max, 'every request up to the cap succeeds');

		const queriesBefore = activeMock.captured.queries.length;
		const over = await post({ soql: 'SELECT Id FROM Account', fullFields: false });
		assert.equal(over.status, 429);
		const body = await over.json();
		assert.equal(body.error, 'rate-limited');
		assert.ok(over.headers.get('retry-after'), 'Retry-After header is set');
		assert.equal(activeMock.captured.queries.length, queriesBefore, 'throttled request never hit SF');
	});

	test('the limiter is per-account: a different account is unaffected', async () => {

		const max = (RATE_LIMIT && RATE_LIMIT.max) || 60;
		for (let i = 0; i < max; i++) {
			activeMock.setNextQueryResult({ records: makeRows(1), totalSize: 1, done: true });
			await post({ soql: 'SELECT Id FROM Account', fullFields: false });
		}
		const overSame = await post({ soql: 'SELECT Id FROM Account', fullFields: false });
		assert.equal(overSame.status, 429, 'same account is now limited');

		currentAccountId = 'acc_other';
		activeMock.setNextQueryResult({ records: makeRows(1), totalSize: 1, done: true });
		const otherAcc = await post({ soql: 'SELECT Id FROM Account', fullFields: false });
		assert.equal(otherAcc.status, 200, 'a separate account has its own window');
	});
});

describe('regex guards behave as intended', () => {
	test('non-SELECT verb is rejected', async () => {
		const r = await post({ soql: 'UPDATE Account SET Name = 1', fullFields: false });
		assert.equal(r.status, 400);
		assert.equal((await r.json()).error, 'select-only');
	});

	test('semicolon (multi-statement) is rejected', async () => {
		const r = await post({ soql: 'SELECT Id FROM Account; DELETE Account', fullFields: false });
		assert.equal(r.status, 400);
		assert.equal((await r.json()).error, 'no-semicolons');
	});

	test('block comment is rejected', async () => {
		const r = await post({ soql: 'SELECT Id FROM Account /* x */', fullFields: false });
		assert.equal(r.status, 400);
		assert.equal((await r.json()).error, 'no-comments');
	});

	test('aggregate (COUNT) is rejected', async () => {
		const r = await post({ soql: 'SELECT COUNT(Id) FROM Account', fullFields: false });
		assert.equal(r.status, 400);
		assert.equal((await r.json()).error, 'aggregate-not-supported');
	});

	test('result row missing Id is rejected', async () => {
		activeMock.setNextQueryResult({ records: [{ Name: 'x', attributes: { type: 'Account' } }], totalSize: 1, done: true });
		const r = await post({ soql: 'SELECT Name FROM Account', fullFields: false });
		assert.equal(r.status, 400);
		assert.equal((await r.json()).error, 'must-include-id');
	});

	test('polymorphic subquery (Task via WhatId) is allowed and wires the edge', async () => {

		const parent = makeRows(1)[0];
		parent.Tasks = {
			records: [{ Id: '00T000000000001AAA', Subject: 'Call', attributes: { type: 'Task' } }],
			totalSize: 1,
			done: true,
		};
		activeMock.setNextQueryResult({ records: [parent], totalSize: 1, done: true });
		const r = await post({ soql: 'SELECT Id, (SELECT Id, Subject FROM Tasks) FROM Account', fullFields: false });
		assert.equal(r.status, 200);
		const body = await r.json();
		assert.equal(body.records.length, 2, 'parent + 1 task loaded');
		const assoc = body.associations.find((a) => a.fieldName === 'WhatId');
		assert.ok(assoc, 'edge wired via the polymorphic WhatId FK');
	});

	test('soql over the length cap is rejected', async () => {
		const soql = 'SELECT Id FROM Account WHERE Name = ' + "'" + 'x'.repeat(10001) + "'";
		const r = await post({ soql, fullFields: false });
		assert.equal(r.status, 400);
		assert.equal((await r.json()).error, 'soql-too-long');
	});
});

describe('authz: no SF connection means no execution', () => {
	test('POST with no active connection returns 409 and runs nothing', async () => {
		injectFakeSf = false;
		const r = await post({ soql: 'SELECT Id FROM Account', fullFields: false });
		assert.equal(r.status, 409);
		assert.equal((await r.json()).error, 'no-active-connection');
	});
});
