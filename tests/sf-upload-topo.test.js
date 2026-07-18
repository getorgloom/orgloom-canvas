import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
	topoSortRecords,
	groupConnectedComponents,
	graphRefIdFor,
	GRAPH_PER_GRAPH_CAP,
	GRAPH_TOTAL_NODES_CAP,
} from '../src/sf-upload.js';

function rec(tempId, objectName = 'X') {
	return { tempId, objectName, values: {} };
}
function fk(fromId, toId, fieldName = 'ParentId') {
	return { fromId, toId, fieldName };
}

describe('topoSortRecords', () => {
	test('linear chain child→parent appears parent-first', () => {
		const records = [rec(1), rec(2), rec(3)];
		const associations = [fk(3, 2), fk(2, 1)];
		const { order, cycleIds } = topoSortRecords(records, associations);
		assert.equal(cycleIds.size, 0);
		const pos = new Map(order.map((id, i) => [id, i]));
		for (const a of associations) {
			assert.ok(pos.get(a.toId) < pos.get(a.fromId), `parent ${a.toId} must appear before child ${a.fromId}`);
		}
		assert.equal(order.length, 3);
	});

	test('two parents one child: both parents come first', () => {
		const records = [rec(1), rec(2), rec(3)];
		const associations = [fk(3, 1), fk(3, 2)];
		const { order } = topoSortRecords(records, associations);
		const pos = new Map(order.map((id, i) => [id, i]));
		assert.ok(pos.get(1) < pos.get(3));
		assert.ok(pos.get(2) < pos.get(3));
	});

	test('records with no associations are emitted in some order, all present', () => {
		const records = [rec(1), rec(2), rec(3)];
		const { order, cycleIds } = topoSortRecords(records, []);
		assert.equal(cycleIds.size, 0);
		assert.deepEqual([...order].sort(), [1, 2, 3]);
	});

	test('circular FK reference is detected via cycleIds', () => {
		const records = [rec(1), rec(2), rec(3)];
		const associations = [fk(1, 2), fk(2, 3), fk(3, 1)];
		const { order, cycleIds } = topoSortRecords(records, associations);
		assert.equal(cycleIds.size, 3);
		assert.ok(cycleIds.has(1));
		assert.ok(cycleIds.has(2));
		assert.ok(cycleIds.has(3));
		assert.equal(order.length, 3);
	});

	test('associations pointing at missing ids are ignored (no crash, no error)', () => {
		const records = [rec(1), rec(2)];
		const associations = [fk(2, 1), fk(2, 99), fk(99, 1)];
		const { order, cycleIds } = topoSortRecords(records, associations);
		assert.equal(cycleIds.size, 0);
		assert.equal(order.length, 2);
		const pos = new Map(order.map((id, i) => [id, i]));
		assert.ok(pos.get(1) < pos.get(2));
	});

	test('null/undefined association entries are ignored', () => {
		const records = [rec(1), rec(2)];
		const associations = [null, undefined, fk(2, 1)];
		const { order } = topoSortRecords(records, associations);
		const pos = new Map(order.map((id, i) => [id, i]));
		assert.ok(pos.get(1) < pos.get(2));
	});
});

describe('groupConnectedComponents', () => {
	test('two FK-related records form one component', () => {
		const submittedIds = new Set([1, 2]);
		const order = [1, 2];
		const components = groupConnectedComponents(submittedIds, order, [fk(2, 1)]);
		assert.equal(components.length, 1);
		assert.deepEqual(components[0], [1, 2]);
	});

	test('two FK-unrelated records form two components', () => {
		const submittedIds = new Set([1, 2]);
		const components = groupConnectedComponents(submittedIds, [1, 2], []);
		assert.equal(components.length, 2);
		assert.deepEqual(
			components.map((c) => c.length),
			[1, 1],
		);
	});

	test('three records, two linked + one alone → two components', () => {
		const submittedIds = new Set([1, 2, 3]);
		const components = groupConnectedComponents(submittedIds, [1, 2, 3], [fk(2, 1)]);
		const sizes = components.map((c) => c.length).sort();
		assert.deepEqual(sizes, [1, 2]);
		const big = components.find((c) => c.length === 2);
		const small = components.find((c) => c.length === 1);
		assert.deepEqual(big, [1, 2]);
		assert.deepEqual(small, [3]);
	});

	test('chain spanning multiple FKs forms one component', () => {
		const submittedIds = new Set([1, 2, 3, 4]);
		const order = [1, 2, 3, 4];
		const components = groupConnectedComponents(submittedIds, order, [fk(2, 1), fk(3, 2), fk(4, 3)]);
		assert.equal(components.length, 1);
		assert.deepEqual(components[0], [1, 2, 3, 4]);
	});

	test('records preserved in submittedOrder within each component', () => {
		const submittedIds = new Set([10, 20, 30]);
		const order = [10, 20, 30]; // topo order
		const components = groupConnectedComponents(submittedIds, order, [fk(20, 10), fk(30, 10)]);
		assert.equal(components.length, 1);
		assert.deepEqual(components[0], [10, 20, 30]);
	});

	test('associations referencing ids not in submittedIds are ignored', () => {
		const submittedIds = new Set([1, 2]);
		const components = groupConnectedComponents(
			submittedIds,
			[1, 2],
			[
				fk(2, 1),
				fk(1, 99), // 99 not submitted; must NOT pull 1 into a cross-graph component
			],
		);
		assert.equal(components.length, 1);
		assert.deepEqual(components[0], [1, 2]);
	});
});

describe('graph caps (contract values)', () => {
	test('per-graph cap is 75', () => {
		assert.equal(GRAPH_PER_GRAPH_CAP, 75, 'caller relies on this exact value');
	});

	test('total nodes cap is 500', () => {
		assert.equal(GRAPH_TOTAL_NODES_CAP, 500);
	});
});

describe('graphRefIdFor', () => {
	test('prefixes with r and strips non-alphanumeric chars', () => {
		assert.equal(graphRefIdFor(42), 'r42');
		assert.equal(graphRefIdFor('foo-bar'), 'rfoo_bar');
		assert.equal(graphRefIdFor('a.b/c d'), 'ra_b_c_d');
	});
});
