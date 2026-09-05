import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_FEEDBACK_PATH = join(__dirname, '..', 'src', 'public', 'js', 'ui-feedback.js');
const APP_CSS_PATH = join(__dirname, '..', 'src', 'public', 'css', 'app.css');

function makeNode(className = '') {
	const controls = new Map();
	const node = {
		className,
		children: [],
		parentNode: null,
		classList: {
			add(name) {
				if (!node.className.split(/\s+/).includes(name)) {
					node.className = (node.className + ' ' + name).trim();
				}
			},
		},
		appendChild(child) {
			child.parentNode = node;
			node.children.push(child);
			return child;
		},
		remove() {
			if (node.parentNode) {
				node.parentNode.children = node.parentNode.children.filter((child) => child !== node);
				node.parentNode = null;
			}
		},
		querySelector(selector) {
			return controls.get(selector) || null;
		},
		querySelectorAll(selector) {
			if (selector === '.bulk-toast') {
				return node.children.filter((child) => child.className.split(/\s+/).includes('bulk-toast'));
			}
			return [];
		},
	};
	Object.defineProperty(node, 'innerHTML', {
		set(value) {
			node._innerHTML = value;
			for (const selector of ['.bulk-toast-action', '.bulk-toast-close']) {
				controls.set(selector, { addEventListener() {} });
			}
		},
	});
	return node;
}

test('action toast is hosted above canvas modals and remains available for 30 seconds', () => {
	const body = makeNode('body');
	const canvas = makeNode('graph-bulk');
	const graph = {
		querySelector(selector) {
			return selector === '#graph-bulk' ? canvas : null;
		},
	};
	const delays = [];
	const sandbox = {
		window: { OrgLoom: {} },
		document: {
			body,
			createElement: () => makeNode(),
			querySelectorAll: () => [],
		},
		setTimeout(_callback, delay) {
			delays.push(delay);
		},
		console,
	};
	vm.createContext(sandbox);
	vm.runInContext(readFileSync(UI_FEEDBACK_PATH, 'utf8'), sandbox);

	const feedback = sandbox.window.OrgLoom.uiFeedback.mount({
		escapeHtml: (value) => String(value),
		getGraph: () => graph,
	});
	feedback.showBulkToastWithAction('Changed', 'Undo', () => {});

	assert.equal(body.children.length, 1, 'toast should be outside the canvas stacking context');
	assert.equal(canvas.children.length, 0);
	assert.match(body.children[0].className, /\bbulk-toast\b/);
	assert.deepEqual(delays, [30_000]);
});

test('canvas toast remains available while the canvas is being rerendered', () => {
	const body = makeNode('body');
	const delays = [];
	const sandbox = {
		window: { OrgLoom: {} },
		document: {
			body,
			createElement: () => makeNode(),
			querySelectorAll: () => [],
		},
		setTimeout(_callback, delay) {
			delays.push(delay);
		},
		console,
	};
	vm.createContext(sandbox);
	vm.runInContext(readFileSync(UI_FEEDBACK_PATH, 'utf8'), sandbox);

	const feedback = sandbox.window.OrgLoom.uiFeedback.mount({
		escapeHtml: (value) => String(value),
		getGraph: () => {
			throw new Error('canvas is rerendering');
		},
	});
	feedback.showBulkToast('No related records found.', 'info');

	assert.equal(body.children.length, 1);
	assert.equal(body.children[0]._innerHTML.includes('No related records found.'), true);
	assert.deepEqual(delays, [4000]);
});

test('ordinary canvas toasts render above the canvas overlay', () => {
	const css = readFileSync(APP_CSS_PATH, 'utf8');
	const canvasLayer = css.match(/\.graph-overlay\s*\{[^}]*z-index:\s*(\d+)/);
	const toastLayer = css.match(/\.bulk-toast\s*\{[^}]*z-index:\s*(\d+)/);

	assert.ok(canvasLayer, 'canvas overlay z-index should be declared');
	assert.ok(toastLayer, 'toast z-index should be declared');
	assert.ok(Number(toastLayer[1]) > Number(canvasLayer[1]), 'toast should render above the canvas');
});
