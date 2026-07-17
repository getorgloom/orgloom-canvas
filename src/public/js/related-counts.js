// Related-count + by-ref cache subsystem.
//
// Backs every "Load related" / type-node opening in the records canvas
// with two memoized maps:
//   _relatedCountCache: (objectName|field|recordId) -> count
//   _byRefCache: (objectName|field|hostId)   -> records[]
//
// Both maps share key shape so callers can flip cheaply between
// counts and records.  In-flight Promise maps dedupe concurrent
// requests; prefetch + a fast user click no longer fire two
// identical network round-trips for the same probe.
//
// Also owns prefetchTypeNodeOneLevel: speculative L1/L2/L3 fan-out
// fired when a type-node first renders, so opening it feels instant.
//
// Dependencies passed to mount():
//   canvasState: shared canvas state. prefetchTypeNodeOneLevel
//                     reads bulkRecords + selectedObjects and writes
//                     _prefetchedTypeNodeKeys.
//   csrfFetch: fetch wrapper.
//   fetchGraphData: async; resolves describe-style graph data for
//                     an object. Used by prefetch to discover the
//                     child fields of the target type-node.
//
// Public API (returned from mount):
//   _RELATED_SOFT_THRESHOLD, _RELATED_HARD_THRESHOLD,
//   _RELATED_BULK_LOAD_CAP, PREFETCH_COUNT_CAP: load-cap constants
//   AUDIT_FK_FIELDS: Set of audit FK
//                                                  field names; shared
//                                                  with code outside
//                                                  this module that
//                                                  filters audit refs.
//   _relatedCountCache, _byRefCache: the Maps; exposed
//                                                  so callers can read
//                                                  cached values and
//                                                  invalidate entries
//                                                  on record removal.
//   _countCacheKey: key builder.
//   fetchRelatedCount(objectName, field, id): single count probe.
//   fetchRelatedCountsBatch(probes): batched fan-out.
//   fetchByRefCached(objectName, field, hostId): list-by-ref query.
//   prefetchTypeNodeOneLevel(tn): speculative warm-up.
//
// Exposed as window.OrgLoom.relatedCounts. Load order: before app.js.

(function () {
	'use strict';

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.relatedCounts = {
		mount: function mount(deps) {
			if (!deps || !deps.canvasState || !deps.csrfFetch || !deps.fetchGraphData) {
				throw new Error('related-counts.mount: missing required deps');
			}
			const canvasState = deps.canvasState;
			const csrfFetch = deps.csrfFetch;
			const fetchGraphData = deps.fetchGraphData;

			const AUDIT_FK_FIELDS = new Set(['CreatedById', 'LastModifiedById', 'OwnerId']);
			// Caches that let edit-mode navigation feel instant. The first
			// hop (Open a type-node) used to wait for its by-ref query;
			// the second hop (descendant type-nodes appearing) used to wait
			// for N count probes per new record. We now prefetch BOTH at
			// type-node render time so by the time the user clicks Open
			// the records and the next-level type-nodes are already in
			// memory. Prefetching is capped (PREFETCH_COUNT_CAP) so we
			// don't fan out hundreds of queries from a User-class node.
			// When the cached related-count for a child-direction
			// type-node exceeds these, openTypeNode interposes a confirm
			// dialog before bulk-loading. SOFT_THRESHOLD is the line
			// above which we ask the user to opt in (load N, search,
			// or cancel); HARD_THRESHOLD is the line above which we
			// remove the bulk-load option entirely (search only); at
			// this scale the rendered cards will overload cy regardless
			// of whether the user actually wants them all.
			// Soft threshold: above this count we intercept "Load related"
			// with a confirm modal instead of silently pulling records
			// down. 50 is the line above which the cytoscape canvas
			// starts to feel noticeably sluggish (edges + HTML labels
			// are O(n²) for layout), and also the line above which a
			// preflight-review at upload time becomes impractical.
			// Common "Account → 600 Contacts" lookups land well above
			// this so the user gets to choose: bulk-load (capped at
			// _RELATED_BULK_LOAD_CAP), search-and-pick, or cancel.
			const _RELATED_SOFT_THRESHOLD = 50;
			const _RELATED_HARD_THRESHOLD = 5000;
			const _RELATED_BULK_LOAD_CAP = 200; // matches /by-ref server cap
			const _relatedCountCache = new Map(); // key: objName|field|recordId -> count
			const _byRefCache = new Map();        // key: objName|field|hostId -> records[]
			// In-flight Promise maps: a second caller for the same key
			// awaits the existing request instead of firing a duplicate.
			// Without these, prefetch + a fast user click can fire two
			// identical network round-trips for the same probe; they
			// both populate the cache eventually, but the user still
			// waits a full network roundtrip for the second one.
			const _relatedCountInFlight = new Map();
			const _byRefInFlight = new Map();
			const PREFETCH_COUNT_CAP = 25;
			
			function _countCacheKey(objectName, field, id) {
				return objectName + '|' + field + '|' + id;
			}
			
			function fetchRelatedCount(objectName, field, id) {
				const key = _countCacheKey(objectName, field, id);
				if (_relatedCountCache.has(key)) {
return Promise.resolve(_relatedCountCache.get(key));
}
				if (_relatedCountInFlight.has(key)) {
return _relatedCountInFlight.get(key);
}
				const url = '/api/objects/' + encodeURIComponent(objectName)
					+ '/related-count?field=' + encodeURIComponent(field)
					+ '&id=' + encodeURIComponent(id);
				const p = csrfFetch(url, { credentials: 'same-origin' })
					.then(async (r) => {
						if (!r.ok) {
 _relatedCountCache.set(key, 0); return 0; 
}
						const body = await r.json();
						const c = body && typeof body.count === 'number' ? body.count : 0;
						_relatedCountCache.set(key, c);
						return c;
					})
					.catch(() => {
 _relatedCountCache.set(key, 0); return 0; 
})
					.finally(() => {
 _relatedCountInFlight.delete(key); 
});
				_relatedCountInFlight.set(key, p);
				return p;
			}
			
			// Batched variant: fans out probes server-side instead of
			// burning the browser's 6-conn HTTP/1.1 cap on N foreground
			// requests. Returns a Map keyed by `objName|field|id` so
			// callers index into results without re-resolving keys.
			// Already-cached probes don't ride the network; in-flight
			// duplicates piggyback on the existing singleton promise
			// where possible. Salesforce-side cap is 200 probes per
			// request; we chunk transparently above that.
			async function fetchRelatedCountsBatch(probes) {
				const result = new Map();
				if (!probes || probes.length === 0) {
return result;
}
				const toFetch = [];
				const inflightWaits = [];
				for (const p of probes) {
					if (!p || !p.objectName || !p.field || !p.id) {
continue;
}
					const key = _countCacheKey(p.objectName, p.field, p.id);
					if (_relatedCountCache.has(key)) {
						result.set(key, _relatedCountCache.get(key));
						continue;
					}
					const inflight = _relatedCountInFlight.get(key);
					if (inflight) {
						inflightWaits.push({ key, promise: inflight });
						continue;
					}
					toFetch.push({ key, p });
				}
				if (toFetch.length > 0) {
					// Mark in-flight before the request so concurrent batch
					// callers dedupe through the same promise.
					let resolveBatch;
					const batchPromise = new Promise((r) => {
 resolveBatch = r; 
});
					toFetch.forEach((x) => {
						_relatedCountInFlight.set(x.key, batchPromise.then(() => _relatedCountCache.get(x.key) || 0));
					});
					// Server caps at 200; chunk if we exceed (rare).
					const CHUNK = 200;
					const chunks = [];
					for (let i = 0; i < toFetch.length; i += CHUNK) {
chunks.push(toFetch.slice(i, i + CHUNK));
}
					try {
						const responses = await Promise.all(chunks.map(async (chunk) => {
							const resp = await csrfFetch('/api/related-counts', {
								method: 'POST',
								headers: { 'Content-Type': 'application/json' },
								credentials: 'same-origin',
								body: JSON.stringify({
									probes: chunk.map((x) => ({ name: x.p.objectName, field: x.p.field, id: x.p.id })),
								}),
							});
							if (!resp.ok) {
return { counts: [] };
}
							return resp.json().catch(() => ({ counts: [] }));
						}));
						const allCounts = responses.flatMap((b) => (b && b.counts) || []);
						allCounts.forEach((c) => {
							const key = _countCacheKey(c.name, c.field, c.id);
							_relatedCountCache.set(key, c.count || 0);
							result.set(key, c.count || 0);
						});
						// Anything we sent but the server didn't echo back
						// gets a defensive default so the cache + result Map
						// stay consistent.
						toFetch.forEach((x) => {
							if (!result.has(x.key)) {
								_relatedCountCache.set(x.key, 0);
								result.set(x.key, 0);
							}
						});
					} catch (e) {
						toFetch.forEach((x) => {
							_relatedCountCache.set(x.key, 0);
							result.set(x.key, 0);
						});
					} finally {
						toFetch.forEach((x) => _relatedCountInFlight.delete(x.key));
						resolveBatch();
					}
				}
				for (const w of inflightWaits) {
					const v = await w.promise.catch(() => 0);
					result.set(w.key, v);
				}
				return result;
			}
			
			function fetchByRefCached(objectName, field, hostId) {
				const key = _countCacheKey(objectName, field, hostId);
				if (_byRefCache.has(key)) {
return Promise.resolve(_byRefCache.get(key));
}
				if (_byRefInFlight.has(key)) {
return _byRefInFlight.get(key);
}
				const url = '/api/objects/' + encodeURIComponent(objectName)
					+ '/by-ref?field=' + encodeURIComponent(field)
					+ '&id=' + encodeURIComponent(hostId);
				const p = csrfFetch(url, { credentials: 'same-origin' })
					.then(async (r) => {
						if (!r.ok) {
throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
}
						const body = await r.json();
						const records = body.records || [];
						_byRefCache.set(key, records);
						return records;
					})
					.finally(() => {
 _byRefInFlight.delete(key); 
});
				_byRefInFlight.set(key, p);
				return p;
			}
			
			// Speculative two-level-deeper prefetch fired when a type-node
			// is first rendered. Chains:
			//   L0  type-node (already shown)
			//   L1  by-ref → records under this type-node
			//   L2  count probes for each record's relationships
			//   L3  by-ref for each L2 relationship whose count is small
			// All results land in caches consumed by openTypeNode +
			// seedEditModeTypeNodes. Aggressive caps prevent fan-out
			// explosions: a User-typed node with 5K children won't get
			// L1, and L3 only kicks off where L2 count <= PREFETCH_COUNT_CAP.
			async function prefetchTypeNodeOneLevel(tn) {
				if (!tn || !tn.isTypeNode) {
return;
}
				const host = canvasState.bulkRecords.find((r) => r.id === tn.hostRecordId);
				if (!host || !host.loadedFromId) {
return;
}
				const dedupKey = tn.id + '|' + host.id;
				if (canvasState._prefetchedTypeNodeKeys.has(dedupKey)) {
return;
}
				canvasState._prefetchedTypeNodeKeys.add(dedupKey);
				try {
					let records;
					if (tn.direction === 'child') {
						const cacheKey = _countCacheKey(tn.objectName, tn.fieldOnOther, host.loadedFromId);
						const knownCount = _relatedCountCache.get(cacheKey);
						if (typeof knownCount === 'number' && knownCount > PREFETCH_COUNT_CAP) {
return;
}
						records = await fetchByRefCached(tn.objectName, tn.fieldOnOther, host.loadedFromId);
					} else {
						const cacheKey = _countCacheKey(tn.objectName, 'Id', tn.parentId);
						if (_byRefCache.has(cacheKey)) {
records = _byRefCache.get(cacheKey);
} else {
							const r = await csrfFetch('/api/objects/' + encodeURIComponent(tn.objectName) + '/records/' + encodeURIComponent(tn.parentId), { credentials: 'same-origin' });
							if (!r.ok) {
return;
}
							const single = await r.json();
							records = single ? [single] : [];
							_byRefCache.set(cacheKey, records);
						}
					}
					if (!records || records.length === 0) {
return;
}
					let targetSel = canvasState.selectedObjects.find((s) => s.name === tn.objectName);
					if (!targetSel) {
						try {
							targetSel = await fetchGraphData(tn.objectName).then((data) => ({ name: data.name, label: data.label || data.name, data }));
						} catch (e) {
 return; 
}
					}
					const childFields = (targetSel.data && targetSel.data.children || []).filter((c) => {
						if (!c.field || !c.object) {
return false;
}
						// Always exclude audit FKs: they fan out to every
						// SObject in the org via User and are never the
						// useful relationship the user wants here.
						if (AUDIT_FK_FIELDS.has(c.field)) {
return false;
}
						return true;
					});
					// L2: cross product of (records × child fields) for
					// counts. Round-robin order: child-field-first then
					// record, so every record receives one probe per
					// round. Records-first ordering would cap at ~3-4
					// contacts when the cross product exceeds the cap,
					// leaving the rest with cold count probes that have
					// to fire fresh when the user opens the type-node.
					// Cap is generous (200) because COUNT() queries are
					// cheap and HTTP/2 / browser concurrency keeps the
					// total round-trip short.
					const validRecs = records.filter((r) => r && r.Id);
					const probes = [];
					for (let ci = 0; ci < childFields.length; ci++) {
						const c = childFields[ci];
						for (let ri = 0; ri < validRecs.length; ri++) {
							probes.push({ objectName: c.object, field: c.field, id: validRecs[ri].Id });
						}
					}
					const L2_CAP = 200;
					const probeSlice = probes.slice(0, L2_CAP);
					// Single batched request for the L2 fan-out: much
					// kinder to the browser's connection pool than N
					// singleton fetches.
					const counts = await fetchRelatedCountsBatch(probeSlice);
					const probeResults = probeSlice.map((p) => ({
						...p,
						count: counts.get(_countCacheKey(p.objectName, p.field, p.id)) || 0,
					}));
					// L3: for each L2 hit with a small count, prefetch
					// the by-ref records too so opening that descendant
					// type-node also lands instantly. Cap aggressively
					// because L3 cardinality is records × children × N.
					const L3_CAP = 30;
					const l3Targets = probeResults
						.filter((p) => p.count > 0 && p.count <= PREFETCH_COUNT_CAP)
						.slice(0, L3_CAP);
					await Promise.all(l3Targets.map((p) =>
						fetchByRefCached(p.objectName, p.field, p.id).catch(() => null)
					));
				} catch (e) {
					console.warn('prefetchTypeNodeOneLevel:', e);
				}
			}

			return {
				_RELATED_SOFT_THRESHOLD: _RELATED_SOFT_THRESHOLD,
				_RELATED_HARD_THRESHOLD: _RELATED_HARD_THRESHOLD,
				_RELATED_BULK_LOAD_CAP: _RELATED_BULK_LOAD_CAP,
				PREFETCH_COUNT_CAP: PREFETCH_COUNT_CAP,
				AUDIT_FK_FIELDS: AUDIT_FK_FIELDS,
				_relatedCountCache: _relatedCountCache,
				_byRefCache: _byRefCache,
				_countCacheKey: _countCacheKey,
				fetchRelatedCount: fetchRelatedCount,
				fetchRelatedCountsBatch: fetchRelatedCountsBatch,
				fetchByRefCached: fetchByRefCached,
				prefetchTypeNodeOneLevel: prefetchTypeNodeOneLevel,
			};
		},
	};
})();
