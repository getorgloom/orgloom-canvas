// Mock Salesforce layer for the /playground demo. Installs a fetch
// interceptor that short-circuits SF-bound /api/* calls and returns
// canned responses sourced from window.OrgLoomMock (defined in
// mock-data.js).
//
// Why this works:
//   The canvas talks to its own server's /api/* routes. In production
//   those routes proxy to Salesforce. In playground mode there's no
//   server-side auth and no Salesforce connection, so we intercept
//   the fetch at the browser, answer from the mock dataset, and the
//   canvas code stays unchanged.
//
// What's covered in Phase 1 (read-only):
//   GET  /api/me: fake demo user identity
//   GET  /api/objects: list of mock sObjects
//   GET  /api/objects/:name/describe: describe metadata
//   GET  /api/objects/:name/search: name LIKE search
//   GET  /api/objects/:name/lookup: FK lookup typeahead
//   GET  /api/objects/:name/records/:id: single record by id
//   GET  /api/objects/:name/related/:fk: child-records by FK
//   GET  /api/related-counts: bulk count probes
//   POST /api/related-counts: bulk count probes (POST shape)
//   GET  /api/canvas: list saved canvases (localStorage)
//   GET  /api/limits: fake SF limits
//   GET  /api/ai/status: disabled in mock
//
// Stubbed-as-blocked in Phase 1 (returns a clear "Sign up to enable"):
//   POST /api/upload*: fake success could come in Phase 2
//   POST /api/canvas: save to localStorage (basic)
//   POST /api/ai/plan: disabled in mock (Phase 2 covers)
//
// Interception policy (the actual behavior; see mockFetch at the
// bottom): same-origin /api/* calls are DEFAULT-BLOCKED. Matched routes
// answer from the mock dataset; anything unmatched returns a clean 501
// mock-not-implemented WITHOUT ever reaching the real server, because a demo
// page must never fire authenticated app calls (a signed-in visitor's
// stale session cookie would ride along). Only non-/api and cross-origin
// requests (page assets, PostHog) pass through to the real fetch.

(function () {
	'use strict';

	if (!window.ORGLOOM_MOCK || !window.OrgLoomMock) {
		// Not in playground mode, or the data file didn't load. Bail
		// without installing the interceptor so production stays
		// uncontaminated.
		return;
	}

	const MOCK = window.OrgLoomMock;
	const _realFetch = window.fetch.bind(window);

	console.log('[mock-sf] Installed for /playground demo. ' +
		MOCK.records.Account.length + ' Accounts, ' +
		MOCK.records.Contact.length + ' Contacts, ' +
		MOCK.records.Opportunity.length + ' Opportunities loaded.');

	// ---- response helpers -----------------------------------------------

	function jsonResponse(body, init) {
		const status = (init && init.status) || 200;
		return new Response(JSON.stringify(body), {
			status,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	function notImplemented(method, path) {
		console.warn('[mock-sf] Unhandled ' + method + ' ' + path + ': returning 501. Add a handler if the canvas needs this surface.');
		return jsonResponse({
			error: 'mock-not-implemented',
			message: 'This action is disabled in the demo. Sign up to use it on your real Salesforce org.',
			method,
			path,
		}, { status: 501 });
	}

	function blocked(reason) {
		return jsonResponse({
			error: 'playground-blocked',
			message: reason || 'Sign up to use this on your real Salesforce org.',
		}, { status: 403 });
	}

	// ---- record helpers -------------------------------------------------

	// SF normalizes 18-char Ids to 15-char (case-sensitive) for equality
	// in many client paths. The mock data uses 18-char throughout; this
	// matches either form by 15-prefix.
	function idMatches(a, b) {
		if (!a || !b) {
return false;
}
		return String(a).slice(0, 15) === String(b).slice(0, 15);
	}

	// ---- storage helpers ------------------------------------------------
	//
	// Phase 2: writes persist to localStorage so the demo behaves like a
	// real SF org across reloads. Three buckets:
	//   canvases: saved canvas payloads
	//   uploads: upload-batch ledger entries
	//   records: user-added records overlaid on the canned dataset
	//
	// The records overlay is what makes uploads feel real: after the
	// visitor "uploads" 10 new Contacts, searching for them in a later
	// session returns them alongside the canned 200 Contacts. Without
	// this, the demo silently swallows uploads.

	const STORAGE_KEY = {
		canvases: 'orgloom.playground.canvases',
		uploads: 'orgloom.playground.uploads',
		records: 'orgloom.playground.records',
		// Set when the visitor deletes the pre-seeded sample canvas so
		// the next list call doesn't re-add it. Without this, deleting
		// the sample would just bring it back on the next page load.
		preseedDeleted: 'orgloom.playground.preseedDeleted',
		// Tombstone set for SF DELETE simulation. Canned demo records
		// live in MOCK.records (frozen) so they can't be filtered out
		// of the source array; instead each "deleted" Salesforce id
		// lands here, and recordsFor/findRecord/related-* paths skip
		// the matching records on subsequent reads. Demo-only: never
		// shipped to a real backend.
		deletedSfIds: 'orgloom.playground.deletedSfIds',
	};

	// ---- pre-seeded sample canvas ---------------------------------------
	//
	// Surfaced under Saved canvases so visitors can open a finished
	// canvas without having to build one from scratch. Shows off the
	// relationship-visualization payoff: one Account at the center with
	// its Contacts, a live Opportunity, and an open Case fanned around
	// it: all linked via real FK associations.
	//
	// Id starts with 069 (ContentDocument prefix) so the canvas client
	// treats it the same as a saved canvas would have. The id is a
	// fixed sentinel ('PRESEED') instead of a generated suffix so list
	// + get + delete handlers can recognize it without a lookup.
	const PRESEED_CANVAS_ID = '069PRESEED000000AAA';
	const PRESEED_CANVAS_VERSION = '068PRESEED000000AAA';
	const PRESEED_CANVAS = {
		id: PRESEED_CANVAS_ID,
		versionId: PRESEED_CANVAS_VERSION,
		title: 'Acme Corporation: sample canvas',
		ownerId: '005DEMO000000000AAA',
		ownedByMe: true,
		createdAt: Date.UTC(2025, 0, 15),
		updatedAt: Date.UTC(2025, 1, 3),
		payload: {
			_meta: {
				app: 'Org Loom',
				version: 1,
				savedFrom: '00DDEMO000000000AAA',
				savedBy: '005DEMO000000000AAA',
				savedByName: 'Demo User',
				preseed: true,
			},
			// Three-level tree: Account at the top, two Contacts under
			// it via AccountId, one Task under each Contact via WhoId.
			// Depth-2 hierarchy makes the FK visualization more
			// obvious than a flat fan-out: visitor sees both
			// "Account groups its Contacts" and "Contacts own
			// activities" in one glance.
			//
			//                  Acme Corporation
			//                  /              \
			//          Jordan Chen        Casey Patel
			//              |                   |
			//          Task #001            Task #002
			schema: {
				objects: [
					{ idx: 0, name: 'Account', label: 'Account', addedFromIdx: null, addedVia: null, worldPos: { x: 0, y: 0 } },
					{ idx: 1, name: 'Contact', label: 'Contact', addedFromIdx: 0, addedVia: 'children:Contacts', worldPos: { x: 0, y: 260 } },
					{ idx: 2, name: 'Task', label: 'Task', addedFromIdx: 1, addedVia: 'children:Tasks', worldPos: { x: 0, y: 520 } },
				],
			},
			loadedRecords: [
				{ loadedFromId: '001000000000001AAA', objectName: 'Account', x: 400, y: 100 },
				{ loadedFromId: '003000000000001AAA', objectName: 'Contact', x: 200, y: 300 },
				{ loadedFromId: '003000000000002AAA', objectName: 'Contact', x: 600, y: 300 },
				{ loadedFromId: '00T000000000001AAA', objectName: 'Task', x: 200, y: 500 },
				{ loadedFromId: '00T000000000002AAA', objectName: 'Task', x: 600, y: 500 },
			],
			drafts: [],
			associations: [
				// Contacts → Acme via AccountId
				{ from: { kind: 'loaded', ref: '003000000000001AAA' }, to: { kind: 'loaded', ref: '001000000000001AAA' }, fieldName: 'AccountId' },
				{ from: { kind: 'loaded', ref: '003000000000002AAA' }, to: { kind: 'loaded', ref: '001000000000001AAA' }, fieldName: 'AccountId' },
				// Tasks → Contacts via WhoId (polymorphic name field
				// pointing at Contact or Lead; here it's the Contact
				// each task belongs to).
				{ from: { kind: 'loaded', ref: '00T000000000001AAA' }, to: { kind: 'loaded', ref: '003000000000001AAA' }, fieldName: 'WhoId' },
				{ from: { kind: 'loaded', ref: '00T000000000002AAA' }, to: { kind: 'loaded', ref: '003000000000002AAA' }, fieldName: 'WhoId' },
			],
		},
	};

	function preseedSummary() {
		return {
			id: PRESEED_CANVAS.id,
			versionId: PRESEED_CANVAS.versionId,
			title: PRESEED_CANVAS.title,
			ownerId: PRESEED_CANVAS.ownerId,
			ownedByMe: true,
			size: 0,
			createdAt: PRESEED_CANVAS.createdAt,
			updatedAt: PRESEED_CANVAS.updatedAt,
		};
	}

	function preseedIsDeleted() {
		try {
 return window.localStorage.getItem(STORAGE_KEY.preseedDeleted) === '1'; 
} catch (_) {
 return false; 
}
	}
	function markPreseedDeleted() {
		try {
 window.localStorage.setItem(STORAGE_KEY.preseedDeleted, '1'); 
} catch (_) {}
	}

	function readStore(key) {
		try {
			const raw = window.localStorage.getItem(key);
			return raw ? JSON.parse(raw) : {};
		} catch (_) {
 return {}; 
}
	}
	function writeStore(key, value) {
		try {
 window.localStorage.setItem(key, JSON.stringify(value)); 
} catch (_) {}
	}

	// Returns canned records + any user-added records for the object,
	// flattened into a single array, with overlay records WINNING on Id
	// collision. This is what makes upload-then-requery work: when a
	// user updates a canned Account (mode='update', preserving
	// loadedFromId) the overlay version is the source of truth, not the
	// frozen canned one. Without this dedup, recordsFor would return
	// two records with the same Id and downstream readers would
	// silently pick whichever they hit first, usually the stale
	// canned one. Same logic catches new-record inserts (no canned Id
	// to collide with; they're appended).
	// Tombstone helpers: track Salesforce ids the demo has "deleted"
	// via the upload flow. Canned records are frozen, so a delete can't
	// remove them from MOCK.records; instead we record the id here and
	// filter at read time. Keyed by 15-char id so 15/18 forms unify.
	function _readTombstones() {
		try {
			const raw = window.localStorage.getItem(STORAGE_KEY.deletedSfIds);
			if (!raw) {
return new Set();
}
			const arr = JSON.parse(raw);
			return new Set(Array.isArray(arr) ? arr : []);
		} catch (_) {
 return new Set(); 
}
	}
	function _writeTombstones(set) {
		try {
			window.localStorage.setItem(STORAGE_KEY.deletedSfIds, JSON.stringify(Array.from(set)));
		} catch (_) { /* storage full / disabled */ }
	}
	function _idKey15(id) {
 return id ? String(id).slice(0, 15) : ''; 
}
	function isTombstoned(id) {
		if (!id) {
return false;
}
		return _readTombstones().has(_idKey15(id));
	}
	function tombstone(id) {
		if (!id) {
return;
}
		const set = _readTombstones();
		set.add(_idKey15(id));
		_writeTombstones(set);
	}

	function recordsFor(objectName) {
		const canned = MOCK.records[objectName] || [];
		const overlay = readStore(STORAGE_KEY.records)[objectName] || [];
		const tombstones = _readTombstones();
		// Drop tombstoned ids from BOTH sources. The user's mental
		// model after a successful delete is "the record is gone"
		// since listing it on the next describe / related fetch would
		// undermine the demo of the upload-then-delete flow.
		const notDeleted = (rec) => !(rec && rec.Id && tombstones.has(_idKey15(rec.Id)));
		const liveCanned = canned.filter(notDeleted);
		const liveOverlay = overlay.filter(notDeleted);
		if (liveOverlay.length === 0) {
return liveCanned;
}
		const overlayById = new Map();
		for (const rec of liveOverlay) {
			if (rec && rec.Id) {
overlayById.set(String(rec.Id), rec);
}
		}
		const merged = liveCanned.map((rec) => {
			if (!rec || !rec.Id) {
return rec;
}
			const ov = overlayById.get(String(rec.Id));
			return ov || rec;
		});
		// Append overlay records that don't collide with a canned Id:
		// these are brand-new inserts (no loadedFromId on the source
		// record, so processUploadedRecord minted a fresh prefix-N Id).
		const cannedIds = new Set();
		for (const rec of liveCanned) {
			if (rec && rec.Id) {
cannedIds.add(String(rec.Id));
}
		}
		for (const rec of liveOverlay) {
			if (rec && rec.Id && !cannedIds.has(String(rec.Id))) {
merged.push(rec);
}
		}
		return merged;
	}

	function findRecord(objectName, id) {
		return recordsFor(objectName).find((r) => idMatches(r.Id, id)) || null;
	}

	// Append a user-added record to the overlay so future reads see it.
	function appendRecord(objectName, record) {
		const store = readStore(STORAGE_KEY.records);
		if (!store[objectName]) {
store[objectName] = [];
}
		store[objectName].push(record);
		writeStore(STORAGE_KEY.records, store);
	}

	// Remove a user-added record (recall path). Returns true if removed.
	// Only operates on the overlay; canned records can't be deleted
	// (they're frozen, and "real SF" semantically can't undo them anyway).
	function removeUserRecord(objectName, id) {
		const store = readStore(STORAGE_KEY.records);
		const list = store[objectName] || [];
		const before = list.length;
		store[objectName] = list.filter((r) => !idMatches(r.Id, id));
		writeStore(STORAGE_KEY.records, store);
		return store[objectName].length < before;
	}

	// Counter that gives uploaded records stable-looking SF Ids.
	// Lives in localStorage so the counter survives reloads: important
	// because re-using the same Id for a new record would cause
	// idMatches collisions and the canvas's idempotency checks to
	// misbehave.
	function nextUploadIdSuffix() {
		const meta = readStore('orgloom.playground.meta');
		const next = (meta.idCounter || 100000) + 1;
		meta.idCounter = next;
		writeStore('orgloom.playground.meta', meta);
		return next;
	}

	function mockNewId(objectName) {
		const desc = MOCK.describes[objectName];
		const prefix = (desc && desc.keyPrefix) || '001';
		const n = nextUploadIdSuffix();
		return prefix + String(n).padStart(12, '0') + 'AAA';
	}

	function findDescribe(objectName) {
		return MOCK.describes[objectName] || null;
	}

	// Pick the nameField for an object: used by search and lookup to
	// know which field to LIKE-match against.
	function nameFieldFor(objectName) {
		const desc = findDescribe(objectName);
		if (!desc) {
return 'Name';
}
		const nf = (desc.fields || []).find((f) => f.nameField);
		return (nf && nf.name) || 'Name';
	}

	// ---- handlers -------------------------------------------------------

	function handleMe() {
		// Demo runs on Pro. Mirrors the shape of the real saas /api/me
		// (apps/saas/src/saas-routes.js) so the canvas reads workspace
		// plan + license tier without branching for the mock. Pro is the
		// right tier to showcase: it unlocks the full canvas feature
		// set without surfacing the Team-only "invite members" path
		// (which would be misleading for a single-visitor demo).
		return jsonResponse({
			account: {
				id: 'playground',
				email: 'demo@orgloom.local',
				displayName: 'Demo User',
				isSuperAdmin: false,
			},
			connection: {
				id: 'demo-connection',
				sfOrgId: MOCK.demoOrgId,
				sfUserId: MOCK.demoUserId,
				instanceUrl: MOCK.instanceUrl,
				displayUsername: 'demo@orgloom.local',
				displayName: 'Acme Demo Sandbox',
				email: 'demo@orgloom.local',
				orgType: 'sandbox',
				// Snake-case duplicates for callers that haven't been
				// swept off the legacy shape yet.
				sf_org_id: MOCK.demoOrgId,
				sf_user_id: MOCK.demoUserId,
				display_name: 'Acme Demo Sandbox',
				instance_url: MOCK.instanceUrl,
				org_type: 'sandbox',
			},
			workspace: {
				id: 'demo-workspace',
				name: 'Demo Workspace',
				ownerAccountId: 'playground',
				kind: 'personal',
				plan: 'pro',
				paidSeats: 1,
				role: 'admin',
			},
			license: { tier: 'pro', label: 'Pro', rank: 1 },
			orgType: 'sandbox',
			capabilities: buildPlaygroundCapabilities(),
			playgroundMode: true,
		});
	}

	function handleMeCapabilities() {
		return jsonResponse({ capabilities: buildPlaygroundCapabilities() });
	}

	// Playground: every capability is granted so the demo surfaces every
	// menu item, button, and modal a paying customer would see. This is
	// the "look at everything the product can do" surface, not a tier
	// preview; visitors converted via /signup land on whatever plan
	// they pick at that point. Per-user-override caps (auto-fill,
	// bulk-edit, exports, recall) used to be implicit-true via a bug
	// in the client; they're now explicit here so the demo surface
	// doesn't silently lose features when the resolver tightens.
	//
	// Keep this list in sync with the keys of CAPABILITIES in
	// packages/canvas/src/capabilities.js. The capability-resolver tests
	// don't run against the playground (no server-side gate), so this
	// list is the only source of truth for what the demo enables.
	function buildPlaygroundCapabilities() {
		return {
			'connect-sf-org': true,
			'create-slot-canvas': true,
			'run-script': true,
			'invite-members': true,
			'share-canvas': true,
			'browse-records': true,
			'soql-import': true,
			'open-saved-canvas': true,
			'save-canvas': true,
			'upload-records': true,
			'recall-upload': true,
			'bulk-edit-records': true,
			'auto-fill-records': true,
			'export-canvas': true,
			'export-records': true,
			'receive-canvas': true,
			'filter-orgs': true,
			'generate-records-with-ai': true,
			'ai-edit-on-canvas': true,
		};
	}

	function handleObjectsList() {
		// Shape mirrors what real /api/objects returns: a bare array
		// of sObjects (NOT wrapped in {sobjects: ...}), sorted by label.
		// Matches listObjects() in sf-describe.js.
		const list = MOCK.objects.map((o) => ({
			name: o.name,
			label: o.label,
			labelPlural: (MOCK.describes[o.name] && MOCK.describes[o.name].labelPlural) || (o.label + 's'),
			keyPrefix: o.keyPrefix,
			custom: !!o.custom,
			queryable: !!o.queryable,
			createable: !!(MOCK.describes[o.name] && MOCK.describes[o.name].createable),
		})).sort((a, b) => a.label.localeCompare(b.label));
		return jsonResponse(list);
	}

	function handleDescribe(objectName) {
		const desc = findDescribe(objectName);
		if (!desc) {
			return jsonResponse({ error: 'unknown-object', message: 'No describe for ' + objectName + ' in the demo dataset.' }, { status: 404 });
		}
		// Real describe responses also include the object-level metadata
		// the canvas reads (createable, updateable, queryable). Spread
		// alongside the body so callers can use either path.
		return jsonResponse(desc);
	}

	// Standard page layout for an object: mirrors the real
	// /api/objects/:name/layout response. Without this, the edit
	// modal falls back to "no layout returned" and renders just
	// the nameField row, which doesn't match what a SF user
	// would expect their Account / Contact / etc. records to
	// look like. Layout shape comes straight from MOCK.layouts
	// (defined in mock-data.js); picklist values are extracted
	// from the matching describe so the modal can render dropdowns
	// without a second roundtrip.
	function handleLayout(objectName, params) {
		const layout = MOCK.layouts && MOCK.layouts[objectName];
		const desc = (MOCK.describes && MOCK.describes[objectName]) || null;
		if (!layout) {
			return jsonResponse({ sections: [], available: false, reason: 'No layout for ' + objectName + ' in the demo dataset.' });
		}
		const recordId = (params && params.get) ? params.get('recordId') : null;
		const recordTypeId = (params && params.get) ? params.get('recordTypeId') : null;
		// Pull picklist value sets out of the describe so the modal's
		// dropdown rendering finds them. Shape matches what the real
		// route serializes from UI API's picklistFieldValues.
		const picklistValues = {};
		if (desc && Array.isArray(desc.fields)) {
			desc.fields.forEach((f) => {
				if (f.type !== 'picklist' || !Array.isArray(f.picklistValues) || f.picklistValues.length === 0) {
return;
}
				picklistValues[f.name] = {
					controllerValues: null,
					defaultValue: (f.picklistValues.find((v) => v.defaultValue) || {}).value || null,
					values: f.picklistValues.map((v) => ({
						label: v.label || v.value,
						value: v.value,
						validFor: v.validFor || [],
					})),
				};
			});
		}
		// Defaults: when an existing record is being edited, the real
		// route returns the record's current values. Pull from the
		// merged overlay/canned data set so updates the visitor made
		// earlier in the session show through.
		const defaults = {};
		if (recordId) {
			const rec = findRecord(objectName, recordId);
			if (rec) {
				Object.keys(rec).forEach((k) => {
					if (rec[k] !== null && rec[k] !== undefined) {
defaults[k] = rec[k];
}
				});
			}
		}
		// Resolve a sensible record type id. We don't model multiple
		// record types per object, so just hand back whatever
		// recordTypeInfos[0] declares, or echo the caller's input.
		const resolvedRecordTypeId = recordTypeId
			|| (desc && Array.isArray(desc.recordTypeInfos) && desc.recordTypeInfos[0] && desc.recordTypeInfos[0].recordTypeId)
			|| null;
		return jsonResponse({
			sections: layout.sections,
			available: true,
			recordTypeId: resolvedRecordTypeId,
			columns: layout.columns || 2,
			defaults,
			fieldPerms: {},
			picklistValues,
		});
	}

	// Schema graph for the schema explorer + addToSelection. Real route
	// (canvas-routes.js) filters out audit/event/system noise; the mock
	// dataset is already curated so we just project from the describe.
	function handleGraph(objectName) {
		const desc = findDescribe(objectName);
		if (!desc) {
			return jsonResponse({ error: 'unknown-object', message: 'No describe for ' + objectName + ' in the demo dataset.' }, { status: 404 });
		}
		const parents = [];
		const parentSeen = new Set();
		for (const f of desc.fields || []) {
			if (f.type !== 'reference' || !Array.isArray(f.referenceTo)) {
continue;
}
			for (const target of f.referenceTo) {
				const key = target + '|' + f.name;
				if (parentSeen.has(key)) {
continue;
}
				parentSeen.add(key);
				if (!MOCK.describes[target]) {
continue;
}
				parents.push({
					object: target,
					field: f.name,
					label: f.label || f.name,
					required: !f.nillable && !f.defaultedOnCreate,
					createable: !!f.createable,
					updateable: !!f.updateable,
				});
			}
		}
		const children = [];
		const childSeen = new Set();
		for (const cr of desc.childRelationships || []) {
			if (!cr.childSObject || !MOCK.describes[cr.childSObject]) {
continue;
}
			const key = cr.childSObject + '|' + (cr.field || '');
			if (childSeen.has(key)) {
continue;
}
			childSeen.add(key);
			children.push({
				object: cr.childSObject,
				field: cr.field,
				relationshipName: cr.relationshipName,
			});
		}
		return jsonResponse({
			name: desc.name,
			label: desc.label || desc.name,
			parents,
			children,
		});
	}

	function handleSearch(objectName, query) {
		const list = recordsFor(objectName);
		if (!list.length) {
return jsonResponse({ records: [], nameField: 'Name' });
}
		const nameField = nameFieldFor(objectName);
		const q = (query || '').toLowerCase().trim();
		const matched = q
			? list.filter((r) => String(r[nameField] || '').toLowerCase().includes(q))
			: list.slice(0, 20);
		return jsonResponse({
			nameField,
			records: matched.slice(0, 20).map((r) => ({ id: r.Id, name: r[nameField] })),
		});
	}

	function handleLookup(objectName, params) {
		// /api/objects/:name/lookup proxies to UI API. Mock returns the
		// same shape the canvas client consumes: { records: [{ id,
		// apiName, title, subtitle, icon }], available: true }.
		const fieldName = params.get('fieldName');
		const q = (params.get('q') || '').toLowerCase().trim();
		const sourceRecordId = params.get('sourceRecordId');

		// Resolve the field's target object via the source object's
		// describe: same as the real route does server-side.
		const sourceDesc = findDescribe(objectName);
		if (!sourceDesc) {
return jsonResponse({ records: [], available: false });
}
		const fieldMeta = (sourceDesc.fields || []).find((f) => f.name === fieldName);
		if (!fieldMeta || !fieldMeta.referenceTo || !fieldMeta.referenceTo[0]) {
			return jsonResponse({ records: [], available: true, source: 'mock' });
		}
		const targetObject = fieldMeta.referenceTo[0];
		const list = recordsFor(targetObject);
		const nameField = nameFieldFor(targetObject);
		let matched = q
			? list.filter((r) => String(r[nameField] || '').toLowerCase().includes(q))
			: list.slice(0, 25);
		// Mirror the real self-exclude behavior.
		if (sourceRecordId) {
			matched = matched.filter((r) => !idMatches(r.Id, sourceRecordId));
		}
		return jsonResponse({
			records: matched.slice(0, 25).map((r) => ({
				id: r.Id,
				apiName: targetObject,
				icon: null,
				title: r[nameField] || r.Id,
				subtitle: null,
			})),
			available: true,
			source: 'mock',
		});
	}

	function handleRecord(objectName, id) {
		const rec = findRecord(objectName, id);
		if (!rec) {
return jsonResponse({ error: 'not-found' }, { status: 404 });
}
		return jsonResponse(rec);
	}

	function handleRelatedCount(objectName, params) {
		const field = params.get('field');
		const id = params.get('id');
		const count = recordsFor(objectName).filter((r) => idMatches(r[field], id)).length;
		return jsonResponse({ count });
	}

	function handleByRef(objectName, params) {
		const field = params.get('field');
		const id = params.get('id');
		const requested = Number(params.get('limit')) || 50;
		const limit = Math.max(1, Math.min(requested, 200));
		const records = recordsFor(objectName)
			.filter((r) => idMatches(r[field], id))
			.slice(0, limit);
		return jsonResponse({ records, skipped: false });
	}

	async function handleRelatedCountsPost(req) {
		const body = await req.json().catch(() => ({}));
		const probes = Array.isArray(body && body.probes) ? body.probes : [];
		const counts = probes.map((p) => {
			const count = recordsFor(p && p.name).filter((r) => idMatches(r[p.field], p.id)).length;
			return { name: p.name, field: p.field, id: p.id, count };
		});
		return jsonResponse({ counts });
	}

	function handleLimits() {
		return jsonResponse({
			DailyApiRequests: { Max: 15000, Remaining: 14987 },
			DataStorageMB: { Max: 1024, Remaining: 1018 },
		});
	}

	function handleAiStatus() {
		// Visitor sees the Generate-with-AI button enabled so they can
		// experience the scope-pick + prompt-write flow. The client
		// reads `enabled` (not `available`) on the response, surfacing
		// the button on the toolbar, and the actual submit is
		// intercepted by playground-bridge.js into a sign-up
		// conversion prompt; handleAiPlan below is NEVER reached in
		// mock mode. usage is null so the approaching-cap banner stays
		// hidden.
		return jsonResponse({
			enabled: true,
			model: 'mock',
			usage: null,
			planLabel: 'Demo',
		});
	}

	// ---- canvas share (demo stubs) --------------------------------------
	//
	// The /playground share modal opens but is locked down (banner +
	// disabled picker + disabled Share button) in canvas-share.js. These
	// handlers just provide canned data so the existing UI populates
	// without surfacing the 501 'mock-not-implemented' error; the
	// visitor needs to be able to SEE what the share surface looks like
	// without seeing error noise.

	function handleSfUsersSearch(params) {
		const q = (params && params.get && params.get('q')) || '';
		// Three demo teammates so the picker has something visible when
		// the visitor clicks into the input. Filter loosely by query so
		// typing feels alive even though the picker is disabled in
		// playground mode (the data still renders if some future surface
		// wires the picker live).
		const demoUsers = [
			{ id: '005DEMO000000001', name: 'Alex Chen', email: 'alex@example.com', username: 'alex.chen@example.com' },
			{ id: '005DEMO000000002', name: 'Priya Patel', email: 'priya@example.com', username: 'priya.patel@example.com' },
			{ id: '005DEMO000000003', name: 'Sam Rivera', email: 'sam@example.com', username: 'sam.rivera@example.com' },
		];
		const ql = q.toLowerCase().trim();
		const users = ql
			? demoUsers.filter((u) => u.name.toLowerCase().includes(ql) || u.email.includes(ql) || u.username.includes(ql))
			: demoUsers;
		return jsonResponse({ users });
	}

	function handleCanvasShareLinks() {
		// Empty by design: playground canvases have no actual shares.
		// The shape mirrors the real endpoint so canvas-share.js's
		// refreshList renders "No active shares." instead of erroring.
		return jsonResponse({ shares: [], directShares: [] });
	}

	// ---- canvas save/load (localStorage) --------------------------------

	function handleCanvasList() {
		const store = readStore(STORAGE_KEY.canvases);
		const userItems = Object.values(store)
			.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
			.map((c) => ({
				id: c.id,
				versionId: c.versionId,
				title: c.title,
				ownerId: c.ownerId || MOCK.demoUserId,
				ownedByMe: true,
				size: 0,
				createdAt: c.createdAt,
				updatedAt: c.updatedAt,
			}));
		// Surface the pre-seed sample canvas unless the visitor deleted
		// it OR has already updated it (in which case the user store
		// has the canonical version under the same id). Sample appears
		// at the bottom: user's own work shows first.
		const userHasPreseed = !!store[PRESEED_CANVAS.id];
		const items = userItems.slice();
		if (!userHasPreseed && !preseedIsDeleted()) {
items.push(preseedSummary());
}
		return jsonResponse({ items });
	}

	async function handleCanvasCreate(req) {
		const body = await req.json().catch(() => ({}));
		const name = String(body.name || '').trim();
		if (!name) {
return jsonResponse({ error: 'name-required' }, { status: 400 });
}
		if (!body.payload || typeof body.payload !== 'object') {
			return jsonResponse({ error: 'payload-required' }, { status: 400 });
		}
		// Fake ContentDocument Id. 069 is the SF ContentDocument prefix;
		// the canvas client treats it as a 15/18-char alphanumeric id
		// regardless of the actual prefix, so any prefix works.
		const id = '069' + String(nextUploadIdSuffix()).padStart(12, '0') + 'AAA';
		const versionId = '068' + String(nextUploadIdSuffix()).padStart(12, '0') + 'AAA';
		const now = Date.now();
		const store = readStore(STORAGE_KEY.canvases);
		store[id] = {
			id, versionId, title: name,
			ownerId: MOCK.demoUserId, ownedByMe: true,
			createdAt: now, updatedAt: now,
			payload: body.payload,
		};
		writeStore(STORAGE_KEY.canvases, store);
		return jsonResponse({ id, versionId });
	}

	async function handleCanvasUpdate(req, canvasId) {
		const body = await req.json().catch(() => ({}));
		const store = readStore(STORAGE_KEY.canvases);
		let existing = store[canvasId];
		// If the visitor edits the pre-seed sample, copy it into the
		// user store on first save so subsequent reads see the edited
		// version instead of the canonical sample.
		if (!existing && canvasId === PRESEED_CANVAS.id && !preseedIsDeleted()) {
			existing = {
				id: PRESEED_CANVAS.id,
				versionId: PRESEED_CANVAS.versionId,
				title: PRESEED_CANVAS.title,
				ownerId: PRESEED_CANVAS.ownerId,
				ownedByMe: true,
				createdAt: PRESEED_CANVAS.createdAt,
				updatedAt: PRESEED_CANVAS.updatedAt,
				payload: PRESEED_CANVAS.payload,
			};
		}
		if (!existing) {
return jsonResponse({ error: 'not-found' }, { status: 404 });
}
		if (!body.payload || typeof body.payload !== 'object') {
			return jsonResponse({ error: 'payload-required' }, { status: 400 });
		}
		const versionId = '068' + String(nextUploadIdSuffix()).padStart(12, '0') + 'AAA';
		existing.payload = body.payload;
		existing.versionId = versionId;
		existing.updatedAt = Date.now();
		store[canvasId] = existing;
		writeStore(STORAGE_KEY.canvases, store);
		return jsonResponse({ ok: true, backend: 'mock', id: canvasId, versionId, title: existing.title });
	}

	function handleCanvasGet(canvasId) {
		const store = readStore(STORAGE_KEY.canvases);
		const c = store[canvasId] || (canvasId === PRESEED_CANVAS.id && !preseedIsDeleted() ? PRESEED_CANVAS : null);
		if (!c) {
return jsonResponse({ error: 'not-found' }, { status: 404 });
}
		return jsonResponse({
			id: c.id,
			versionId: c.versionId,
			title: c.title,
			ownerId: c.ownerId || MOCK.demoUserId,
			ownedByMe: true,
			createdAt: c.createdAt,
			updatedAt: c.updatedAt,
			payload: c.payload,
			recipientRole: 'owner',
			recipientHasAccount: true,
			staleRefs: [],
		});
	}

	// AI clarifications surface: real route lists pending clarifications
	// the AI is waiting on the user to answer. The demo has no AI loop, so
	// the list is always empty. Without a handler, the canvas polls this
	// on every load and gets a 501 with the "mock-not-implemented" warning
	// in the console: noisy + the canvas client treats the failure as a
	// transient error worth retrying.
	function handleCanvasClarifications() {
		return jsonResponse({ clarifications: [] });
	}
	// AI proposals list: same role as clarifications; the demo has no
	// proposal queue so it's always empty.
	function handleCanvasProposals() {
		return jsonResponse({ proposals: [] });
	}
	// Audit-event surface: fires on most UI actions. The demo doesn't
	// persist audit; silently ack so the canvas client doesn't retry.
	function handleAuditEvent() {
		return jsonResponse({ ok: true });
	}
	// MCP relay register/unregister: the demo can't run MCP, but the
	// canvas attempts these on boot. Silent ok keeps the boot path
	// clean without surfacing a non-functional relay status.
	function handleMcpRelay() {
		return jsonResponse({ ok: true });
	}

	function handleCanvasDelete(canvasId) {
		const store = readStore(STORAGE_KEY.canvases);
		const inStore = !!store[canvasId];
		const isPreseed = canvasId === PRESEED_CANVAS.id;
		if (!inStore && !isPreseed) {
return jsonResponse({ error: 'not-found' }, { status: 404 });
}
		if (inStore) {
			delete store[canvasId];
			writeStore(STORAGE_KEY.canvases, store);
		}
		// Deleting the preseed marks it hidden, independent of whether
		// the visitor had also customized it. If they had, the user-
		// store copy above handles removal; the flag prevents the
		// list handler from re-adding the canonical sample.
		if (isPreseed) {
markPreseedDeleted();
}
		return jsonResponse({ ok: true });
	}

	// ---- upload (fake success + record overlay) -------------------------

	// Shared per-record upload result builder. Generates a fake SF id,
	// appends the record (with its tempId-resolved FK values) to the
	// overlay so subsequent reads see it.
	function processUploadedRecord(rec, idMap) {
		if (!rec || !rec.objectName) {
			return { tempId: rec && rec.tempId, success: false, error: 'no-object' };
		}
		const newId = rec.loadedFromId || mockNewId(rec.objectName);
		// Resolve any tempId references in values to real Ids minted in
		// this same upload (handles parent → child FK substitution).
		const resolved = {};
		Object.keys(rec.values || {}).forEach((k) => {
			const v = rec.values[k];
			if (typeof v === 'string' && /^@\{(.*?)\.id\}$/.test(v)) {
				const refTempId = v.match(/^@\{(.*?)\.id\}$/)[1];
				resolved[k] = idMap[refTempId] || v;
			} else if (idMap[v] != null) {
				resolved[k] = idMap[v];
			} else {
				resolved[k] = v;
			}
		});
		// Stamp Id, audit columns, and the FK to OwnerId/CreatedById so
		// the record looks fully populated when the user loads it later.
		const overlay = Object.assign({}, resolved, {
			Id: newId,
			OwnerId: resolved.OwnerId || MOCK.demoUserId,
			CreatedById: MOCK.demoUserId,
			LastModifiedById: MOCK.demoUserId,
			CreatedDate: new Date().toISOString(),
			LastModifiedDate: new Date().toISOString(),
			SystemModstamp: new Date().toISOString(),
		});
		appendRecord(rec.objectName, overlay);
		idMap[rec.tempId] = newId;
		return {
			tempId: rec.tempId,
			success: true,
			id: newId,
			objectName: rec.objectName,
			mode: rec.loadedFromId ? 'update' : 'create',
		};
	}

	// Process a single delete from the upload payload. Tombstones the
	// matching Salesforce id and (when the record was also in the user
	// overlay) removes it. Always reports success in the demo; a real
	// SF backend can fail a DELETE for a host of reasons (cascade
	// constraints, missing CRUD permission, validation rules with
	// IsDeleted), but the playground's purpose is to demonstrate the
	// happy path. Edge cases stay the real backend's job.
	function processDelete(del) {
		if (!del || !del.sfId) {
			return { tempId: del && del.tempId, success: false, error: 'Missing sfId' };
		}
		tombstone(del.sfId);
		if (del.objectName) {
			// Best-effort overlay removal so subsequent listings don't
			// pick a stale copy. removeUserRecord returns false when
			// the id wasn't in the overlay (canned-only record);
			// fine, the tombstone has it covered.
			removeUserRecord(del.objectName, del.sfId);
		}
		return {
			tempId: del.tempId,
			sfId: del.sfId,
			objectName: del.objectName,
			success: true,
			mode: 'delete',
		};
	}

	function recordBatch(records, associations, source, note, deletes) {
		const insertedIds = records
			.filter((r) => r.success && r.id)
			.map((r) => ({
				tempId: r.tempId,
				sfId: r.id,
				objectName: r.objectName,
				mode: r.mode || 'create',
				label: null,
			}));
		// Track successful deletes alongside inserts so the recall UI
		// can surface them with honest messaging: "we deleted these,
		// can't undelete from Org Loom, restore from SF recycle bin."
		const deletedIds = (deletes || [])
			.filter((d) => d && d.success && d.sfId)
			.map((d) => ({
				tempId: d.tempId || null,
				sfId: d.sfId,
				objectName: d.objectName || null,
			}));
		if (insertedIds.length === 0 && deletedIds.length === 0) {
return null;
}
		const batchId = 'ub_' + Date.now() + '_' + nextUploadIdSuffix();
		const externalId = '00B' + String(nextUploadIdSuffix()).padStart(12, '0') + 'AAA';
		const now = Date.now();
		const store = readStore(STORAGE_KEY.uploads);
		store[batchId] = {
			id: batchId, externalId,
			source: source || 'canvas',
			recordCount: insertedIds.length + deletedIds.length,
			note: note || null,
			status: 'uploaded',
			createdAt: now,
			recalledAt: null,
			recallResult: null,
			sfOrgId: MOCK.demoOrgId,
			insertedIds,
			deletedIds,
			associations: (associations || []).map((a) => ({
				fromTempId: a.fromId, toTempId: a.toId, fieldName: a.fieldName,
			})),
		};
		writeStore(STORAGE_KEY.uploads, store);
		return batchId;
	}

	async function handleUpload(req) {
		const body = await req.json().catch(() => ({}));
		const records = Array.isArray(body.records) ? body.records : [];
		const associations = Array.isArray(body.associations) ? body.associations : [];
		const deletes = Array.isArray(body.deletes) ? body.deletes : [];
		const directUpload = !!body.directUpload;
		const idMap = {};
		const results = records.map((rec) => processUploadedRecord(rec, idMap));
		// Deletes run AFTER creates/updates so an upload that creates
		// then deletes the same record (uncommon but legal) has the
		// create resolved first, then the delete applied to it.
		const deleteResults = deletes.map(processDelete);
		const batchId = recordBatch(results, associations, directUpload ? 'csv-direct' : 'canvas', body.note, deleteResults);
		return jsonResponse({
			results,
			deletes: deleteResults,
			instanceUrl: MOCK.instanceUrl,
			batchId,
		});
	}

	async function handleUploadGraph(req) {
		const body = await req.json().catch(() => ({}));
		const records = Array.isArray(body.records) ? body.records : [];
		const associations = Array.isArray(body.associations) ? body.associations : [];
		const deletes = Array.isArray(body.deletes) ? body.deletes : [];
		const directUpload = !!body.directUpload;
		const idMap = {};
		const results = records.map((rec) => processUploadedRecord(rec, idMap));
		const deleteResults = deletes.map(processDelete);
		const batchId = recordBatch(results, associations, directUpload ? 'csv-direct' : 'canvas-graph', body.note, deleteResults);
		return jsonResponse({
			results,
			deletes: deleteResults,
			instanceUrl: MOCK.instanceUrl,
			mode: 'graph',
			atomicSuccess: true,
			graphCount: 1,
			batchId,
		});
	}

	async function handleUploadBulk(req) {
		// Real bulk is SSE-streamed; mock fakes a single complete event.
		// Returns a synthesized "done" payload that the bulk-upload
		// client can parse without needing real streaming.
		const body = await req.json().catch(() => ({}));
		const records = Array.isArray(body.records) ? body.records : [];
		const deletes = Array.isArray(body.deletes) ? body.deletes : [];
		const idMap = {};
		const results = records.map((rec) => processUploadedRecord(rec, idMap));
		const deleteResults = deletes.map(processDelete);
		return jsonResponse({
			results,
			deletes: deleteResults,
			instanceUrl: MOCK.instanceUrl,
			mode: 'bulk',
			batchId: recordBatch(results, body.associations || [], 'csv-bulk', body.note, deleteResults),
		});
	}

	async function handleUploadPreflight(req) {
		const body = await req.json().catch(() => ({}));
		const records = Array.isArray(body.records) ? body.records : [];
		// Preflight is a dry-run. Return all-success without persisting
		// since the real one inserts then deletes residue; we just say
		// everything would work. The ok:true flag is load-bearing:
		// upload-modal checks `if (!pf.ok)` and routes to the
		// "Salesforce rejected the sample" failure UI when it's
		// missing.
		return jsonResponse({
			ok: true,
			results: records.map((r) => ({ tempId: r.tempId, success: true, objectName: r.objectName })),
			sampled: records.length,
			total: records.length,
		});
	}

	// ---- upload batches (recall ledger) ---------------------------------

	function handleBatchesList() {
		const store = readStore(STORAGE_KEY.uploads);
		const batches = Object.values(store)
			.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
			.map((b) => ({
				id: b.id, externalId: b.externalId,
				createdAt: b.createdAt, status: b.status, source: b.source,
				recordCount: b.recordCount, note: b.note,
				recalledAt: b.recalledAt, sfOrgId: b.sfOrgId,
				// Surface the delete count so the recall list UI can
				// label a batch like "5 synced + 2 deleted" without
				// having to GET the full batch. The full deletedIds
				// array lives on the batch detail (handleBatchGet).
				insertedCount: Array.isArray(b.insertedIds) ? b.insertedIds.length : 0,
				deletedCount: Array.isArray(b.deletedIds) ? b.deletedIds.length : 0,
			}));
		return jsonResponse({ batches });
	}

	function handleBatchGet(batchId) {
		const store = readStore(STORAGE_KEY.uploads);
		const b = store[batchId];
		if (!b) {
return jsonResponse({ error: 'not-found' }, { status: 404 });
}
		return jsonResponse({ batch: b });
	}

	async function handleBatchRecallPreflight(batchId) {
		const store = readStore(STORAGE_KEY.uploads);
		const b = store[batchId];
		if (!b) {
return jsonResponse({ error: 'not-found' }, { status: 404 });
}
		// Every inserted record is "clean" (we don't simulate drift).
		return jsonResponse({
			clean: b.insertedIds,
			drifted: [],
			alreadyDeleted: [],
			updates: [],
			unverified: [],
			cascadeConflicts: [],
			batch: { id: b.id, createdAt: b.createdAt, recordCount: b.recordCount, sfOrgId: b.sfOrgId },
		});
	}

	async function handleBatchRecall(batchId) {
		const store = readStore(STORAGE_KEY.uploads);
		const b = store[batchId];
		if (!b) {
return jsonResponse({ error: 'not-found' }, { status: 404 });
}
		if (b.recalledAt) {
return jsonResponse({ error: 'already-recalled' }, { status: 409 });
}
		// Remove each inserted record from the overlay and build the
		// per-record results array. Shape mirrors upload-recall.js's
		// real implementation: the client (upload-history.js) derives
		// the "N records deleted" count from results.length, so an
		// empty results array would surface "0 records deleted" even
		// though the mock just removed records.
		const results = [];
		let succeeded = 0;
		for (const ins of (b.insertedIds || [])) {
			const removed = removeUserRecord(ins.objectName, ins.sfId);
			if (removed) {
				results.push({
					tempId: ins.tempId,
					sfId: ins.sfId,
					objectName: ins.objectName,
					label: ins.label || null,
					success: true,
				});
				succeeded++;
			} else {
				// Already gone from the overlay: match real-server
				// semantics for ENTITY_IS_DELETED. User intent ("not in
				// the org") is satisfied either way, so this isn't a
				// failure.
				results.push({
					tempId: ins.tempId,
					sfId: ins.sfId,
					objectName: ins.objectName,
					label: ins.label || null,
					success: true,
					note: 'Already deleted',
				});
			}
		}
		const alreadyDeletedCount = results.length - succeeded;
		b.recalledAt = Date.now();
		b.status = 'recalled';
		b.recallResult = { succeeded, alreadyDeleted: alreadyDeletedCount, failed: 0, results };
		writeStore(STORAGE_KEY.uploads, store);
		return jsonResponse({
			ok: true, status: 'recalled',
			successCount: succeeded,
			alreadyDeletedCount,
			failureCount: 0,
			preservedUpdatesCount: 0,
			results,
		});
	}

	function handleBatchDelete(batchId) {
		const store = readStore(STORAGE_KEY.uploads);
		if (!store[batchId]) {
return jsonResponse({ error: 'not-found' }, { status: 404 });
}
		delete store[batchId];
		writeStore(STORAGE_KEY.uploads, store);
		return jsonResponse({ ok: true });
	}

	// ---- AI plan (programmatic generator) -------------------------------

	async function handleAiPlan(req) {
		// Real /api/ai/plan calls Anthropic. The mock generates records
		// programmatically: for each requested object/count combination,
		// it clones templates from the canned dataset and randomizes
		// names + key fields. Cheap, deterministic-ish, and looks real.
		const body = await req.json().catch(() => ({}));
		const objectCounts = body.recordCounts || body.objectCounts || {};
		const tempCounter = { n: 1 };
		const records = [];
		const associations = [];
		const objectsList = Object.keys(objectCounts);
		const tempIdsByObject = {};

		for (const objectName of objectsList) {
			const count = Math.max(0, Math.min(50, parseInt(objectCounts[objectName], 10) || 0));
			const templates = MOCK.records[objectName] || [];
			tempIdsByObject[objectName] = [];
			for (let i = 0; i < count; i++) {
				const template = templates[(i + Math.floor(Math.random() * templates.length)) % templates.length];
				if (!template) {
continue;
}
				const tempId = tempCounter.n++;
				const values = {};
				// Copy template values, randomize Name-like fields, clear
				// Ids and audit columns. Strip any FK values; those get
				// re-bound via associations below.
				Object.keys(template).forEach((k) => {
					if (k === 'Id' || k === 'CreatedDate' || k === 'LastModifiedDate' || k === 'SystemModstamp') {
return;
}
					if (k === 'OwnerId' || k === 'CreatedById' || k === 'LastModifiedById') {
return;
}
					if (k === 'AccountId' || k === 'ParentId') {
return;
} // handled by associations
					values[k] = template[k];
				});
				// Suffix Name fields with a short random tag so they look
				// generated rather than copy-pasted.
				const tag = '-G' + String(Math.floor(Math.random() * 9000) + 1000);
				if (values.Name) {
values.Name = values.Name + tag;
}
				if (values.LastName) {
values.LastName = values.LastName + tag;
}
				if (values.Company) {
values.Company = values.Company + tag;
}
				records.push({ tempId, objectName, values });
				tempIdsByObject[objectName].push(tempId);
			}
		}

		// Wire child→parent associations where the schema implies them
		// (Contact.AccountId → Account, Opportunity.AccountId → Account).
		// First Account in the batch is the default parent; if multiple
		// Accounts, round-robin children across them.
		const accountTempIds = tempIdsByObject.Account || [];
		if (accountTempIds.length > 0) {
			['Contact', 'Opportunity'].forEach((child) => {
				const childTempIds = tempIdsByObject[child] || [];
				childTempIds.forEach((tid, i) => {
					const parentTempId = accountTempIds[i % accountTempIds.length];
					associations.push({ fromId: tid, toId: parentTempId, fieldName: 'AccountId' });
				});
			});
		}

		return jsonResponse({
			records, associations,
			warnings: [],
			usage: { tokens: 0, costCents: 0, creditMode: false },
		});
	}

	// ---- SOQL query (minimal-parse + canned fallback) -------------------

	// Real /api/query parses arbitrary SOQL. The mock does a minimal
	// parse to keep two specific paths honest:
	//   1. Browse-load with a selection ships `SELECT Id FROM <Object>
	//      WHERE Id IN ('id1', ...)`; it must return JUST those records
	//      and NO children (the user picked exactly those rows). Before
	//      this parse, the mock ignored the SOQL and returned the canned
	//      5 Technology Accounts + Contacts shape, which surprised the
	//      visitor with extra records they never picked.
	//   2. SOQL-import preset (locked to one query in playground via
	//      soql-import.js's ORGLOOM_MOCK gate) requests
	//      `SELECT ..., (SELECT ... FROM Contacts) FROM Account WHERE
	//      Industry = 'Technology' LIMIT 5`; keep the canned shape
	//      because the visitor explicitly chose that preset.
	// Anything else falls through to "all records of the FROM object,
	// no children", the closest to honest behavior for an unhandled query.
	async function handleQuery(req) {
		const body = await req.json().catch(() => ({}));
		const fullFields = body.fullFields === false ? false : true;
		const soql = String(body.soql || '');

		// Tiny SOQL shape probe (regex, not a real parser). Handles
		// the patterns the playground actually emits (Browse-load,
		// SOQL-import preset). Anything else takes the catch-all.
		const fromMatch = soql.match(/FROM\s+([A-Za-z][A-Za-z0-9_]*)/i);
		const queryObject = fromMatch ? fromMatch[1] : 'Account';
		const inMatch = soql.match(/WHERE\s+Id\s+IN\s*\(([^)]*)\)/i);
		const explicitIds = inMatch
			? Array.from(inMatch[1].matchAll(/'([^']+)'/g)).map((m) => m[1])
			: null;
		const hasContactsSubquery = /\(\s*SELECT[\s\S]*FROM\s+Contacts\s*\)/i.test(soql);

		// Project full record values (fullFields=true) or just Id +
		// the fixed canned fields (fullFields=false). Field names that
		// don't exist on the source record are skipped silently; the
		// projection is a best-effort match of the real SOQL projection.
		function projectValues(source, fieldList) {
			if (fullFields) {
				const v = {};
				Object.keys(source).forEach((k) => {
					if (k === 'attributes') {
return;
}
					if (source[k] !== null && source[k] !== undefined) {
v[k] = source[k];
}
				});
				return v;
			}
			const v = { Id: source.Id };
			(fieldList || []).forEach((f) => {
 if (source[f] !== undefined) {
v[f] = source[f];
} 
});
			return v;
		}

		// Path 1: Browse-load with selection (or any "WHERE Id IN (...)"
		// query). Return ONLY the requested records, no related
		// children: the user picked exactly these rows.
		if (explicitIds && explicitIds.length > 0) {
			const allRecords = recordsFor(queryObject);
			const wanted = new Set(explicitIds);
			const matching = allRecords.filter((r) => r && wanted.has(r.Id));
			const tempCounter = { n: 1 };
			const records = matching.map((rec) => ({
				tempId: tempCounter.n++,
				objectName: queryObject,
				loadedFromId: rec.Id,
				values: projectValues(rec, []),
			}));
			return jsonResponse({
				objectName: queryObject,
				records,
				associations: [],
				totalSize: matching.length,
				returned: matching.length,
				truncated: false,
				fullFields,
			});
		}

		// Path 2: SOQL-import preset, canned 5-Technology-Accounts +
		// each Account's Contacts (mirrors the preset query that
		// soql-import.js locks the playground textarea to). Detected
		// by the Contacts subquery shape; falling through to this
		// branch for any other "FROM Account" query without the
		// subquery would surface unexpected children, which is the
		// bug this whole refactor is fixing.
		if (hasContactsSubquery && queryObject === 'Account') {
			const PARENT_OBJECT = 'Account';
			const PARENT_FIELDS = ['Name', 'Industry', 'Phone', 'Type'];
			const CHILD_OBJECT = 'Contact';
			const CHILD_FK = 'AccountId';
			const CHILD_FIELDS = ['FirstName', 'LastName', 'Email', 'Title'];
			const PARENT_LIMIT = 5;
			const CHILDREN_PER_PARENT = 3;
			const allParents = recordsFor(PARENT_OBJECT);
			const techParents = allParents
				.filter((a) => a && a.Industry === 'Technology')
				.slice(0, PARENT_LIMIT);
			const allChildren = recordsFor(CHILD_OBJECT);
			const tempCounter = { n: 1 };
			const records = [];
			const associations = [];
			for (const parent of techParents) {
				const parentTempId = tempCounter.n++;
				records.push({
					tempId: parentTempId,
					objectName: PARENT_OBJECT,
					loadedFromId: parent.Id,
					values: projectValues(parent, PARENT_FIELDS),
				});
				const childrenForParent = allChildren
					.filter((c) => c[CHILD_FK] === parent.Id)
					.slice(0, CHILDREN_PER_PARENT);
				for (const child of childrenForParent) {
					const childTempId = tempCounter.n++;
					records.push({
						tempId: childTempId,
						objectName: CHILD_OBJECT,
						loadedFromId: child.Id,
						values: projectValues(child, CHILD_FIELDS),
					});
					associations.push({
						fromTempId: childTempId,
						toTempId: parentTempId,
						fieldName: CHILD_FK,
					});
				}
			}
			return jsonResponse({
				objectName: PARENT_OBJECT,
				records,
				associations,
				totalSize: techParents.length,
				returned: techParents.length,
				truncated: false,
				fullFields,
			});
		}

		// Path 3: catch-all, return all records of the FROM object,
		// no related children. Browse-load WITHOUT a selection (the
		// "Load all matching" button) lands here.
		const allRecords = recordsFor(queryObject);
		const tempCounter = { n: 1 };
		const records = allRecords.map((rec) => ({
			tempId: tempCounter.n++,
			objectName: queryObject,
			loadedFromId: rec.Id,
			values: projectValues(rec, []),
		}));
		return jsonResponse({
			objectName: queryObject,
			records,
			associations: [],
			totalSize: allRecords.length,
			returned: allRecords.length,
			truncated: false,
			fullFields,
		});
	}

	// Browse endpoint mock. Mirrors the server-side compile-filters-to-
	// SOQL design but skips the SOQL hop entirely: we evaluate the
	// filters directly against the in-memory record overlay. The
	// returned shape matches the real endpoint so the front-end is
	// unaware which side it's talking to.
	async function handleBrowse(req) {
		const body = await req.json().catch(() => ({}));
		const objectName = String(body.objectName || '').trim();
		const filters = Array.isArray(body.filters) ? body.filters : [];
		const sort = body.sort || null;
		const limit = Math.max(1, Math.min(200, parseInt(body.limit, 10) || 25));
		const offset = Math.max(0, parseInt(body.offset, 10) || 0);
		if (!objectName) {
			return jsonResponse({ error: 'invalid-object-name' }, { status: 400 });
		}
		const allRecords = recordsFor(objectName);
		// Match a single condition against a record. Mirror the
		// server's per-type operator set so playground feels the same
		// as production.
		function _matches(rec, filt) {
			if (!filt || !filt.field) {
return true;
}
			const val = rec[filt.field];
			const v = filt.value;
			const has = val !== null && val !== undefined && val !== '';
			switch (filt.op) {
				case 'isNull': return !has;
				case 'isNotNull': return has;
				case 'equals': return String(val) === String(v);
				case 'notEquals': return String(val) !== String(v);
				case 'contains': return has && String(val).toLowerCase().includes(String(v).toLowerCase());
				case 'startsWith': return has && String(val).toLowerCase().startsWith(String(v).toLowerCase());
				case 'in': return Array.isArray(v) && v.some((x) => String(x) === String(val));
				case 'gt': return has && Number(val) > Number(v);
				case 'gte': return has && Number(val) >= Number(v);
				case 'lt': return has && Number(val) < Number(v);
				case 'lte': return has && Number(val) <= Number(v);
				case 'before': return has && new Date(val) < new Date(v);
				case 'after': return has && new Date(val) > new Date(v);
				case 'between': return has && Array.isArray(v) && v.length === 2 &&
					new Date(val) >= new Date(v[0]) && new Date(val) <= new Date(v[1]);
				default: return true;
			}
		}
		let matching = allRecords.filter((rec) => filters.every((f) => _matches(rec, f)));
		// Sort if requested. Mock sort is a stable lexicographic
		// compare with locale-aware comparison for strings; numbers
		// fall back to Number() coercion. ASC default; DESC reverses.
		if (sort && sort.field) {
			const dir = sort.direction === 'desc' ? -1 : 1;
			matching = matching.slice().sort((a, b) => {
				const av = a[sort.field], bv = b[sort.field];
				if (av == null && bv == null) {
return 0;
}
				if (av == null) {
return 1;
} // nulls last regardless of direction
				if (bv == null) {
return -1;
}
				if (typeof av === 'number' && typeof bv === 'number') {
return dir * (av - bv);
}
				return dir * String(av).localeCompare(String(bv));
			});
		}
		const count = matching.length;
		// Net-new count: matches not already on the canvas (parity with the
		// server's loadableCount; the "Load all N" number excludes dups).
		const onCanvasSet = new Set(Array.isArray(body.onCanvasIds) ? body.onCanvasIds : []);
		const loadableCount = onCanvasSet.size
			? matching.filter((rec) => !onCanvasSet.has(rec.Id)).length
			: count;
		const page = matching.slice(offset, offset + limit);

		// Preview fields: Id + name field + first few filter fields.
		// Matches the server-side selection logic.
		const previewFields = ['Id'];
		const sample = page[0] || matching[0] || {};
		// Pick Name / FirstName-LastName / Subject as the name-field
		// stand-in for the mock. Real server uses describe.nameField.
		const nameCandidate = ['Name', 'Subject', 'Title', 'CaseNumber'].find((n) => sample[n] !== undefined);
		if (nameCandidate) {
previewFields.push(nameCandidate);
}
		for (const f of filters) {
			if (f && f.field && sample[f.field] !== undefined && !previewFields.includes(f.field)) {
				previewFields.push(f.field);
				if (previewFields.length >= 6) {
break;
}
			}
		}
		// Project records down to previewFields for parity with the
		// real endpoint (which uses SOQL projection).
		const projected = page.map((rec) => {
			const out = {};
			previewFields.forEach((fn) => {
 if (rec[fn] !== undefined) {
out[fn] = rec[fn];
} 
});
			return out;
		});

		// Build a SOQL-shaped string for the Load-to-canvas path; the
		// caller feeds it through /api/query which the mock can run.
		// Mock can't actually execute it (handleQuery is hardcoded),
		// but Load-to-canvas in playground uses the same WHERE-eval
		// logic via a direct path described below.
		const orderClause = sort && sort.field
			? ' ORDER BY ' + sort.field + ' ' + (sort.direction === 'desc' ? 'DESC' : 'ASC')
			: '';
		const loadSoql = 'SELECT Id FROM ' + objectName + orderClause;
		const previewSoql = loadSoql + ' LIMIT ' + limit + ' OFFSET ' + offset;
		return jsonResponse({
			count,
			loadableCount,
			records: projected,
			hasMore: count > offset + page.length,
			previewFields,
			previewSoql,
			loadSoql,
		});
	}

	// ---- route table ----------------------------------------------------
	//
	// The dispatcher walks this list in order and runs the first
	// matcher whose URL pattern matches the request. matcher returns
	// either a Response (handled) or null (fall through to next).
	//
	// All matchers receive a URL object so they can pull pathname and
	// search params without re-parsing.

	const ROUTES = [
		// /api/me: saas identity surface.
		{ method: 'GET', match: (u) => u.pathname === '/api/me' && handleMe() },

		// /api/me/capabilities: capability map (Pro-tier in demo).
		{ method: 'GET', match: (u) => u.pathname === '/api/me/capabilities' && handleMeCapabilities() },

		// /api/objects (list)
		{ method: 'GET', match: (u) => u.pathname === '/api/objects' && handleObjectsList() },

		// /api/objects/:name/describe
		{ method: 'GET', match: (u) => {
			const m = u.pathname.match(/^\/api\/objects\/([^/]+)\/describe$/);
			return m && handleDescribe(decodeURIComponent(m[1]));
		}},

		// /api/objects/:name/graph
		{ method: 'GET', match: (u) => {
			const m = u.pathname.match(/^\/api\/objects\/([^/]+)\/graph$/);
			return m && handleGraph(decodeURIComponent(m[1]));
		}},

		// /api/objects/:name/layout
		{ method: 'GET', match: (u) => {
			const m = u.pathname.match(/^\/api\/objects\/([^/]+)\/layout$/);
			return m && handleLayout(decodeURIComponent(m[1]), u.searchParams);
		}},

		// /api/objects/:name/search?q=
		{ method: 'GET', match: (u) => {
			const m = u.pathname.match(/^\/api\/objects\/([^/]+)\/search$/);
			return m && handleSearch(decodeURIComponent(m[1]), u.searchParams.get('q'));
		}},

		// /api/objects/:name/lookup?fieldName=&q=
		{ method: 'GET', match: (u) => {
			const m = u.pathname.match(/^\/api\/objects\/([^/]+)\/lookup$/);
			return m && handleLookup(decodeURIComponent(m[1]), u.searchParams);
		}},

		// /api/objects/:name/records/:id
		{ method: 'GET', match: (u) => {
			const m = u.pathname.match(/^\/api\/objects\/([^/]+)\/records\/([^/]+)$/);
			return m && handleRecord(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
		}},

		// /api/objects/:name/by-ref
		{ method: 'GET', match: (u) => {
			const m = u.pathname.match(/^\/api\/objects\/([^/]+)\/by-ref$/);
			return m && handleByRef(decodeURIComponent(m[1]), u.searchParams);
		}},

		// /api/objects/:name/related-count
		{ method: 'GET', match: (u) => {
			const m = u.pathname.match(/^\/api\/objects\/([^/]+)\/related-count$/);
			return m && handleRelatedCount(decodeURIComponent(m[1]), u.searchParams);
		}},

		// /api/related-counts (POST body shape)
		{ method: 'POST', match: (u, req) => u.pathname === '/api/related-counts' && handleRelatedCountsPost(req) },

		// /api/limits
		{ method: 'GET', match: (u) => u.pathname === '/api/limits' && handleLimits() },

		// /api/ai/status
		{ method: 'GET', match: (u) => u.pathname === '/api/ai/status' && handleAiStatus() },

		// ===== Canvas share (demo-stub) =================================
		// The full share flow is locked down in playground (see
		// canvas-share.js's ORGLOOM_MOCK branch: disabled picker,
		// disabled Share button, demo banner). These handlers exist
		// only to keep the modal from surfacing 'mock-not-implemented'
		// errors while the user explores what the surface looks like.
		// POST /direct-share is NOT mocked; playground-bridge.js's
		// capture-phase listener intercepts the Share button click, and
		// the button is also disabled, so the request never fires.
		{ method: 'GET', match: (u) => u.pathname === '/api/sf/users/search' && handleSfUsersSearch(u.searchParams) },
		{ method: 'GET', match: (u) => {
			const m = u.pathname.match(/^\/api\/canvas\/[^/]+\/share-links$/);
			return m && handleCanvasShareLinks();
		}},

		// ===== Canvas save / load (localStorage-backed) =================
		{ method: 'GET', match: (u) => u.pathname === '/api/canvas' && handleCanvasList() },
		{ method: 'POST', match: (u, req) => u.pathname === '/api/canvas' && handleCanvasCreate(req) },
		{ method: 'GET', match: (u) => {
			const m = u.pathname.match(/^\/api\/canvas\/([^/]+)$/);
			return m && handleCanvasGet(decodeURIComponent(m[1]));
		}},
		{ method: 'PUT', match: (u, req) => {
			const m = u.pathname.match(/^\/api\/canvas\/([^/]+)$/);
			return m && handleCanvasUpdate(req, decodeURIComponent(m[1]));
		}},
		{ method: 'DELETE', match: (u) => {
			const m = u.pathname.match(/^\/api\/canvas\/([^/]+)$/);
			return m && handleCanvasDelete(decodeURIComponent(m[1]));
		}},

		// /api/canvas/:id/clarifications: AI clarifications list.
		{ method: 'GET', match: (u) => {
			const m = u.pathname.match(/^\/api\/canvas\/[^/]+\/clarifications$/);
			return m && handleCanvasClarifications();
		}},
		// /api/canvas/:id/proposals: AI proposals list.
		{ method: 'GET', match: (u) => {
			const m = u.pathname.match(/^\/api\/canvas\/[^/]+\/proposals$/);
			return m && handleCanvasProposals();
		}},
		// /api/audit-event: analytics ping, silent ack.
		{ method: 'POST', match: (u) => u.pathname === '/api/audit-event' && handleAuditEvent() },
		// /api/mcp/relay/register and /unregister: MCP relay setup,
		// non-functional in demo but the canvas attempts them on boot.
		{ method: 'POST', match: (u) => u.pathname === '/api/mcp/relay/register' && handleMcpRelay() },
		{ method: 'POST', match: (u) => u.pathname === '/api/mcp/relay/unregister' && handleMcpRelay() },

		// ===== Upload (fake success, record overlay) ====================
		{ method: 'POST', match: (u, req) => u.pathname === '/api/upload' && handleUpload(req) },
		{ method: 'POST', match: (u, req) => u.pathname === '/api/upload/graph' && handleUploadGraph(req) },
		{ method: 'POST', match: (u, req) => u.pathname === '/api/upload/bulk' && handleUploadBulk(req) },
		{ method: 'POST', match: (u, req) => u.pathname === '/api/upload/preflight' && handleUploadPreflight(req) },

		// ===== Upload batches (recall ledger) ===========================
		{ method: 'GET', match: (u) => u.pathname === '/api/upload-batches' && handleBatchesList() },
		{ method: 'GET', match: (u) => {
			const m = u.pathname.match(/^\/api\/upload-batches\/([^/]+)$/);
			return m && handleBatchGet(decodeURIComponent(m[1]));
		}},
		{ method: 'POST', match: (u) => {
			const m = u.pathname.match(/^\/api\/upload-batches\/([^/]+)\/recall-preflight$/);
			return m && handleBatchRecallPreflight(decodeURIComponent(m[1]));
		}},
		{ method: 'POST', match: (u) => {
			const m = u.pathname.match(/^\/api\/upload-batches\/([^/]+)\/recall$/);
			return m && handleBatchRecall(decodeURIComponent(m[1]));
		}},
		{ method: 'DELETE', match: (u) => {
			const m = u.pathname.match(/^\/api\/upload-batches\/([^/]+)$/);
			return m && handleBatchDelete(decodeURIComponent(m[1]));
		}},

		// ===== AI plan (programmatic generator) =========================
		{ method: 'POST', match: (u, req) => u.pathname === '/api/ai/plan' && handleAiPlan(req) },

		// ===== SOQL query (hardcoded result) ============================
		{ method: 'POST', match: (u, req) => u.pathname === '/api/query' && handleQuery(req) },

		// ===== Browse (structured filter -> count + preview) ============
		{ method: 'POST', match: (u, req) => u.pathname === '/api/browse' && handleBrowse(req) },
	];

	// ---- the interceptor ------------------------------------------------

	window.fetch = function mockFetch(input, init) {
		const method = ((init && init.method) || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
		const urlStr = typeof input === 'string' ? input : input.url;
		let url;
		try {
			url = new URL(urlStr, window.location.origin);
		} catch (_) {
			// Malformed URL: let the real fetch deal with it.
			return _realFetch(input, init);
		}

		// Only intercept same-origin /api/* calls. External calls
		// (PostHog, Anthropic via real client, etc.) pass through.
		if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) {
			return _realFetch(input, init);
		}

		// Walk the route table. A matcher can return a Response (handled),
		// a Promise<Response> (handled async), or null/false (fall
		// through).
		for (const route of ROUTES) {
			if (route.method !== method) {
continue;
}
			let result;
			try {
				result = route.match(url, typeof input === 'object' ? input : new Request(urlStr, init));
			} catch (e) {
				console.error('[mock-sf] matcher threw on ' + method + ' ' + url.pathname + ':', e);
				continue;
			}
			if (result) {
return Promise.resolve(result);
}
		}

		// Nothing matched: log it so we know what else needs mocking,
		// then return a clean 501 so the canvas's error path runs.
		return Promise.resolve(notImplemented(method, url.pathname));
	};
})();
