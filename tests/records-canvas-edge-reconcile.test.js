import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/public/js/records-canvas.js', import.meta.url), 'utf8');
const window = { OrgLoom: {} };
vm.runInNewContext(source, { window, console, Object });

function edge(data) {
	const values = { ...data };
	let removed = false;
	return {
		data(key, value) {
			if (arguments.length === 2) {
				values[key] = value;
			}
			return values[key];
		},
		remove() {
			removed = true;
		},
		values,
		get removed() {
			return removed;
		},
	};
}

test('a reused edge id is replaced when its restored endpoints changed', () => {
	const existing = edge({ id: 'a7', source: 'r1', target: 'r2', label: 'AccountId', kind: 'fk' });
	const desired = {
		group: 'edges',
		data: { id: 'a7', source: 'r3', target: 'r4', label: 'ContactId', kind: 'fk' },
	};
	const added = [];
	const cy = { add: (element) => added.push(element) };

	assert.equal(window.OrgLoom.recordsCanvas._test.reconcileExistingEdge(cy, existing, desired), true);
	assert.equal(existing.removed, true);
	assert.deepEqual(added, [desired]);
});

test('an unchanged edge keeps its endpoints and refreshes its display data', () => {
	const existing = edge({ id: 'a7', source: 'r1', target: 'r2', label: 'Old label', kind: 'fk' });
	const desired = {
		group: 'edges',
		data: { id: 'a7', source: 'r1', target: 'r2', label: 'AccountId', kind: 'fk' },
	};
	const added = [];
	const cy = { add: (element) => added.push(element) };

	assert.equal(window.OrgLoom.recordsCanvas._test.reconcileExistingEdge(cy, existing, desired), false);
	assert.equal(existing.removed, false);
	assert.equal(existing.values.label, 'AccountId');
	assert.deepEqual(added, []);
});

test('a derived lookup edge never renders through an inaccessible shared record', () => {
	const canRender = window.OrgLoom.recordsCanvas._test.canRenderDerivedRecordLink;

	assert.equal(canRender({ id: 1 }, { id: 2 }), true);
	assert.equal(canRender({ id: 1, _inaccessible: true }, { id: 2 }), false);
	assert.equal(canRender({ id: 1 }, { id: 2, _inaccessible: true }), false);
});

test('a blank migration card uses its selected destination record label', () => {
	const labelForMatch = window.OrgLoom.recordsCanvas._test.migrationMatchLabel;
	const record = {
		_migrateMatchedId: '001TARGET',
		_migrateMatchCandidates: [
			{ id: '001OTHER', label: 'Other account' },
			{ id: '001TARGET', label: 'Acme' },
		],
	};

	assert.equal(labelForMatch(record), 'Acme');
	assert.equal(labelForMatch({ _migrateMatchedId: '001TARGET', _migrateMatchCandidates: [] }), '');
});
