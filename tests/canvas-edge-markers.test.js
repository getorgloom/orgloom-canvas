import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/public/js/cy-interactions.js', import.meta.url), 'utf8');

function element(tagName) {
	return {
		tagName,
		children: [],
		attributes: {},
		setAttribute(name, value) {
			assert.doesNotMatch(String(value), /NaN|Infinity|undefined/, 'SVG attributes must be valid');
			this.attributes[name] = value;
		},
		appendChild(child) {
			this.children.push(child);
		},
		removeChild(child) {
			this.children.splice(this.children.indexOf(child), 1);
		},
		querySelector() {
			return this.children.find((child) => child.tagName === 'svg');
		},
	};
}

function edge(sourcePoint, targetPoint, kind = 'fk', ringKind = '') {
	return {
		sourcePoint,
		targetPoint,
		renderedSourceEndpoint() {
			return this.sourcePoint;
		},
		renderedTargetEndpoint() {
			return this.targetPoint;
		},
		hasClass: () => false,
		data: () => kind,
		target: () => ({ data: () => ringKind }),
	};
}

function harness(edges) {
	const context = { window: {}, document: { createElementNS: (_ns, tag) => element(tag) } };
	vm.runInNewContext(source, context);
	const api = context.window.OrgLoom.cyInteractions.mount({
		getCanvasSpaceHeld: () => false,
		setCanvasMiddleMousePanning() {},
	});
	const listeners = new Map();
	const cy = {
		edges: () => edges,
		on(events, selector, handler) {
			listeners.set(events, handler || selector);
		},
	};
	const container = element('div');
	api.attachCyEdgeMarkers(cy, container);
	return {
		render: () => listeners.get('render')(),
		markers: () => container.children[0].children.filter((child) => child.tagName === 'g'),
	};
}

test('edge markers skip incomplete, nonfinite, and degenerate geometry without hiding valid edges', () => {
	const validPoint = { x: 10, y: 20 };
	const invalidPoints = [null, undefined, {}, { x: '5', y: 10 }, { x: null, y: 10 }];
	for (const value of [NaN, Infinity, -Infinity, undefined]) {
		invalidPoints.push({ x: value, y: 10 }, { x: 10, y: value });
	}
	const edges = invalidPoints.flatMap((point) => [edge(point, validPoint), edge(validPoint, point)]);
	edges.push(edge(validPoint, validPoint));
	edges.push(edge({ x: -Number.MAX_VALUE, y: 0 }, { x: Number.MAX_VALUE, y: 0 }));
	edges.push(edge({ x: 0, y: 0 }, validPoint));
	const h = harness(edges);
	assert.equal(h.markers().length, 2);
});

test('markers recover on the next render and stale markers disappear while geometry is invalid', () => {
	const relationship = edge({ x: NaN, y: NaN }, { x: 100, y: 0 });
	const h = harness([relationship]);
	assert.equal(h.markers().length, 0);
	relationship.sourcePoint = { x: 0, y: 0 };
	h.render();
	assert.deepEqual(
		h.markers().map((marker) => marker.attributes.transform),
		['translate(0,0) rotate(0)', 'translate(100,0) rotate(180)'],
	);
	relationship.targetPoint = { x: NaN, y: 0 };
	h.render();
	assert.equal(h.markers().length, 0);
	relationship.targetPoint = { x: 100, y: 0 };
	h.render();
	assert.equal(h.markers().length, 2);
	h.render();
	assert.equal(h.markers().length, 2, 'redraw must not duplicate markers');
});

test('valid child-ring relationships retain their reversed marker orientation', () => {
	const h = harness([edge({ x: 0, y: 0 }, { x: 100, y: 0 }, 'ring', 'ring-child')]);
	assert.deepEqual(
		h.markers().map((marker) => marker.attributes.transform),
		['translate(100,0) rotate(180)', 'translate(0,0) rotate(0)'],
	);
});
