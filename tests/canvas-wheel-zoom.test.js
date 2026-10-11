import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/public/js/cy-interactions.js', import.meta.url), 'utf8');

function harness() {
	const listeners = new Set();
	const document = {
		addEventListener(type, fn) {
			assert.equal(type, 'wheel');
			listeners.add(fn);
		},
		removeEventListener(type, fn) {
			assert.equal(type, 'wheel');
			listeners.delete(fn);
		},
	};
	const context = { window: {}, document };
	vm.runInNewContext(source, context);
	const api = context.window.OrgLoom.cyInteractions;
	const interactions = api.mount({ getCanvasSpaceHeld: () => false, setCanvasMiddleMousePanning() {} });
	const target = {};
	const container = {
		contains: (el) => el === target,
		getBoundingClientRect: () => ({ left: 10, top: 20, right: 510, bottom: 420 }),
	};
	function makeCy() {
		let level = 1;
		let destroyed = false;
		const destroyListeners = new Set();
		const calls = [];
		return {
			calls,
			zoom(options) {
				if (!options) return level;
				level = options.level;
				calls.push(options);
			},
			destroyed: () => destroyed,
			on(type, fn) {
				assert.equal(type, 'destroy');
				destroyListeners.add(fn);
			},
			off(type, fn) {
				assert.equal(type, 'destroy');
				destroyListeners.delete(fn);
			},
			destroy() {
				destroyed = true;
				[...destroyListeners].forEach((fn) => fn());
			},
		};
	}
	function wheel(overrides = {}) {
		const event = {
			target,
			deltaY: 100,
			deltaMode: 0,
			clientX: 110,
			clientY: 120,
			ctrlKey: false,
			defaultPrevented: false,
			preventDefault() {
				this.defaultPrevented = true;
			},
			...overrides,
		};
		[...listeners].forEach((fn) => fn(event));
		return event;
	}
	return { ...interactions, factor: api.wheelZoomFactor, makeCy, container, wheel, listeners };
}

test('repeated canvas destruction and recreation leaves exactly one wheel handler', () => {
	const h = harness();
	for (let i = 0; i < 8; i++) {
		const cy = h.makeCy();
		h.attachCyWheelZoom(cy, h.container);
		h.attachCyWheelZoom(cy, h.container);
		assert.equal(h.listeners.size, 1);
		h.wheel();
		assert.equal(cy.calls.length, 1);
		assert.equal(cy.zoom(), 0.9);
		assert.deepEqual({ ...cy.calls[0].renderedPosition }, { x: 100, y: 100 });
		cy.destroy();
		assert.equal(h.listeners.size, 0);
		h.wheel();
		assert.equal(cy.calls.length, 1);
	}
});

test('replacing an instance on the same container detaches the previous handler', () => {
	const h = harness();
	const old = h.makeCy();
	const current = h.makeCy();
	h.attachCyWheelZoom(old, h.container);
	h.attachCyWheelZoom(current, h.container);
	old.destroy();
	h.wheel();
	assert.equal(h.listeners.size, 1);
	assert.equal(old.calls.length, 0);
	assert.equal(current.calls.length, 1);
	current.destroy();
	h.attachCyWheelZoom(current, h.container);
	assert.equal(h.listeners.size, 0);
});

test('small high-resolution wheel events use distance rather than event count', () => {
	const h = harness();
	const cy = h.makeCy();
	h.attachCyWheelZoom(cy, h.container);
	for (let i = 0; i < 100; i++) h.wheel({ deltaY: 1 });
	assert.ok(Math.abs(cy.zoom() - 0.9) < 1e-12);
	for (let i = 0; i < 100; i++) h.wheel({ deltaY: -1 });
	assert.ok(Math.abs(cy.zoom() - 1) < 1e-12);
});

test('wheel units are normalized and accelerated or invalid deltas stay bounded', () => {
	const { factor } = harness();
	assert.equal(factor({ deltaY: 3, deltaMode: 1 }), factor({ deltaY: 48, deltaMode: 0 }));
	assert.equal(factor({ deltaY: 1, deltaMode: 2 }), 0.9);
	assert.equal(factor({ deltaY: 100000 }), 0.9);
	assert.equal(factor({ deltaY: -100000 }), 1 / 0.9);
	for (const deltaY of [0, NaN, Infinity, undefined]) assert.equal(factor({ deltaY }), 1);
});

test('zoom ignores other surfaces, handled events and horizontal scroll and preserves limits', () => {
	const h = harness();
	const cy = h.makeCy();
	h.attachCyWheelZoom(cy, h.container);
	h.wheel({ target: {} });
	h.wheel({ clientX: 0 });
	h.wheel({ defaultPrevented: true });
	h.wheel({ deltaY: 0, deltaX: 100 });
	assert.equal(cy.calls.length, 0);
	assert.equal(h.wheel({ ctrlKey: true }).defaultPrevented, true);
	for (let i = 0; i < 100; i++) h.wheel();
	assert.equal(cy.zoom(), 0.2);
	for (let i = 0; i < 100; i++) h.wheel({ deltaY: -100 });
	assert.equal(cy.zoom(), 4);
});

test('records canvas uses the lifecycle-managed wheel handler instead of a document listener', () => {
	const records = readFileSync(new URL('../src/public/js/records-canvas.js', import.meta.url), 'utf8');
	assert.match(records, /attachCyWheelZoom\(getCyInstance\(\), container\)/);
	assert.doesNotMatch(records, /document\.addEventListener\(\s*'wheel'/);
	const app = readFileSync(new URL('../src/public/js/app.js', import.meta.url), 'utf8');
	assert.match(
		app,
		/const _rcv = window\.OrgLoom\.recordsCanvas\.mount\(\{[\s\S]*?attachCyWheelZoom: attachCyWheelZoom/,
	);
});
