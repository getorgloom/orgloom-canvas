// Test stub for the SF-Apex KEK provider + ContentVersion binary download.
//
// makeSfApexKekProvider(conn) POSTs to
//   <instanceUrl>/services/apexrest/orgloom/orgloom/kek/{wrap,unwrap,ensure}
// via the global fetch, and the upload-batches / canvas stores fetch large
// VersionData blobs from a relative SF URL the same way. Neither was stubbed
// in the original tests, so any test that drove a store through the real KEK
// provider errored out, which is how the recall-ledger encryption bugs
// shipped unnoticed. This helper stubs global.fetch so:
//   * /kek/wrap   → identity wrap   ({ wrapped: 'w:' + dekB64 })
//   * /kek/unwrap → identity unwrap ({ dek: dekB64 })
//   * /kek/ensure → { ok: true }
//   * a registered VersionData URL → the exact binary bytes (arrayBuffer)
// The identity wrap is a faithful stand-in: the provider treats `wrapped` as
// opaque, so round-tripping it proves the store's key handling without a real
// Salesforce org.

function jsonRes(obj) {
	return { ok: true, status: 200, async json() {
 return obj; 
} };
}

export function installSfFetchStub() {
	const realFetch = global.fetch;
	const versionBlobs = new Map(); // absolute URL -> Buffer

	global.fetch = async (url, opts) => {
		const u = String(url);
		if (u.endsWith('/kek/wrap')) {
			const body = JSON.parse((opts && opts.body) || '{}');
			return jsonRes({ wrapped: 'w:' + body.dek });
		}
		if (u.endsWith('/kek/unwrap')) {
			const body = JSON.parse((opts && opts.body) || '{}');
			return jsonRes({ dek: String(body.wrapped || '').replace(/^w:/, '') });
		}
		if (u.endsWith('/kek/ensure')) {
			return jsonRes({ ok: true });
		}
		if (versionBlobs.has(u)) {
			const buf = versionBlobs.get(u);
			return {
				ok: true,
				status: 200,
				async arrayBuffer() {
					return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
				},
			};
		}
		throw new Error('sf-kek-stub: unexpected fetch in test: ' + u);
	};

	return {
		// Register the bytes that a VersionData download URL should return.
		registerVersionUrl(absoluteUrl, buf) {
 versionBlobs.set(absoluteUrl, buf); 
},
		restore() {
 global.fetch = realFetch; 
},
	};
}

// A queue-based SF connection mock that carries instanceUrl + accessToken so
// makeSfApexKekProvider(conn) accepts it. Mirrors mockConn in the existing
// upload-batches tests, plus the two fields the KEK provider requires.
export function makeKekConn(initial = {}) {
	const INSTANCE_URL = 'https://test.my.salesforce.com';
	const calls = { queries: [], sobjectCreates: [], sobjectRetrieves: [], sobjectDestroys: [] };
	const queryQueue = [...(initial.queries || [])];
	const createQueue = [...(initial.creates || [])];
	const retrieveQueue = [...(initial.retrieves || [])];
	const destroyQueue = [...(initial.destroys || [])];
	return {
		instanceUrl: INSTANCE_URL,
		accessToken: 'TEST_TOKEN',
		version: '60.0',
		calls,
		// Exposed so multi-step tests can stage further responses after a
		// first call (e.g. finalize() needs reads staged with bytes captured
		// from the preceding createPending()).
		_queues: { queries: queryQueue, creates: createQueue, retrieves: retrieveQueue, destroys: destroyQueue },
		async query(soql) {
			calls.queries.push(soql);
			return queryQueue.length === 0 ? { records: [], totalSize: 0 } : queryQueue.shift();
		},
		sobject(name) {
			return {
				async create(payload) {
					calls.sobjectCreates.push({ name, payload });
					return createQueue.length === 0 ? { success: false, errors: ['no-create-queued'] } : createQueue.shift();
				},
				async retrieve(id) {
					calls.sobjectRetrieves.push({ name, id });
					return retrieveQueue.length === 0 ? null : retrieveQueue.shift();
				},
				async destroy(id) {
					calls.sobjectDestroys.push({ name, id });
					return destroyQueue.length === 0 ? { success: true } : destroyQueue.shift();
				},
			};
		},
		async request() {
 throw new Error('makeKekConn.request() not stubbed; use the VersionData URL via global fetch'); 
},
	};
}
