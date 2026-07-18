import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../src/public/js/related-counts.js'), 'utf8');

test('user-requested related loads can refresh a previously cached by-ref response', async () => {
	const window = {};
	vm.runInNewContext(source, { window, Map, Set, Promise, JSON, encodeURIComponent });
	let currentName = 'Before upload';
	let requestCount = 0;
	const api = window.OrgLoom.relatedCounts.mount({
		canvasState: { bulkRecords: [], selectedObjects: [], _prefetchedTypeNodeKeys: new Set() },
		csrfFetch: async () => {
			requestCount++;
			return {
				ok: true,
				json: async () => ({ records: [{ Id: '02i000000000001AAA', Name: currentName }] }),
			};
		},
		fetchGraphData: async () => ({}),
	});

	const first = await api.fetchByRefCached('Asset', 'ContactId', '003000000000001AAA');
	assert.equal(first[0].Name, 'Before upload');
	currentName = 'After upload';
	const cached = await api.fetchByRefCached('Asset', 'ContactId', '003000000000001AAA');
	assert.equal(cached[0].Name, 'Before upload');
	assert.equal(requestCount, 1);

	const fresh = await api.fetchByRefCached('Asset', 'ContactId', '003000000000001AAA', {
		forceRefresh: true,
	});
	assert.equal(fresh[0].Name, 'After upload');
	assert.equal(requestCount, 2);
	assert.equal(
		(await api.fetchByRefCached('Asset', 'ContactId', '003000000000001AAA'))[0].Name,
		'After upload',
	);
});
