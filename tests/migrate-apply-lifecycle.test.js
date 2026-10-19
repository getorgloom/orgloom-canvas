import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/public/js/migrate-match.js', import.meta.url), 'utf8');
const settle = () => new Promise((resolve) => setImmediate(resolve));

class Element {
	constructor(attributes = {}) {
		this.attributes = attributes;
		this.listeners = new Map();
		this.disabled = false;
		this.hidden = false;
		this.classList = { toggle() {} };
	}
	setAttribute(name, value) {
		this.attributes[name] = value;
	}
	getAttribute(name) {
		return this.attributes[name] ?? null;
	}
	removeAttribute(name) {
		delete this.attributes[name];
	}
	addEventListener(name, handler) {
		this.listeners.set(name, handler);
	}
	removeEventListener(name) {
		this.listeners.delete(name);
	}
	querySelectorAll() {
		return [];
	}
	remove() {
		this.parentNode = null;
	}
	// Dispatch even on disabled controls to check the handler guards as well as the UI state.
	dispatch(name, event = {}) {
		return this.listeners.get(name)?.(event);
	}
}

async function harness() {
	const overlay = new Element();
	const close = new Element();
	const backdrop = new Element();
	const primary = new Element();
	const back = new Element();
	const steps = ['matches', 'differences', 'review'].map((step) => new Element({ 'data-mm-step': step }));
	const panels = ['matches', 'differences', 'review'].map((step) => new Element({ 'data-mm-panel': step }));
	const elements = new Map([
		['[data-mm-primary]', primary],
		['[data-mm-back]', back],
		['button[data-mm-close]', close],
		...steps.map((step) => [`[data-mm-step="${step.getAttribute('data-mm-step')}"]`, step]),
		...['.mm-summary', '.mm-record-decisions', '.mm-differences', '.mm-final-review'].map((selector) => [
			selector,
			new Element(),
		]),
	]);
	overlay.querySelector = (selector) => {
		assert.ok(elements.has(selector), `Unexpected selector: ${selector}`);
		return elements.get(selector);
	};
	overlay.querySelectorAll = (selector) => {
		if (selector === '[data-mm-close]') {
			return [backdrop, close];
		}
		if (selector === '[data-mm-step]') {
			return steps;
		}
		if (selector === '[data-mm-panel]') {
			return panels;
		}
		return [];
	};
	const document = new Element();
	document.createElement = () => overlay;
	document.body = {
		appendChild(el) {
			el.parentNode = this;
		},
	};
	const window = {
		OrgLoom: {},
		Orgloom: {
			migrateAnnotate: {
				computeMigrationStatus: () => ({ status: 'ready', issues: [] }),
				exclusionIssues: () => [],
			},
		},
	};
	vm.runInNewContext(source, { window, document, clearTimeout });
	const record = {
		id: 1,
		objectName: 'Contact',
		pendingDelete: true,
		values: { LastName: 'Original' },
		_migrateMatchIntent: 'existing',
		_migrateMatchResolution: 'existing',
		_migrateMatchedId: '003ORIGINAL',
		loadedFromId: '003ORIGINAL',
	};
	const attempts = [];
	const errors = [];
	let closes = 0;
	let rollbacks = 0;
	const api = window.OrgLoom.migrateMatch.mount({
		canvasState: { bulkRecords: [record], bulkAssociations: [], describeCache: { Contact: { fields: [] } } },
		escapeHtml: String,
		ensureDescribe: async () => ({}),
		csrfFetch: () => {
			throw new Error('Unexpected network request');
		},
		showBulkToast: (message) => errors.push(message),
		onApplied: () => {
			rollbacks++;
		},
		onCommitPlan: () => new Promise((resolve, reject) => attempts.push({ resolve, reject })),
	});
	api.open({
		onClose: () => {
			closes++;
		},
	});
	await settle();
	// A user choice made after opening must not be rolled back by an in-flight dismissal.
	record.values.LastName = 'Chosen';
	record._migrateMatchedId = record.loadedFromId = '003CHOSEN';
	await steps[2].dispatch('click');
	assert.equal(primary.textContent, 'Apply migration to canvas');
	assert.equal(primary.disabled, false);
	return {
		overlay,
		close,
		backdrop,
		primary,
		back,
		steps,
		panels,
		document,
		record,
		attempts,
		errors,
		get closes() {
			return closes;
		},
		get rollbacks() {
			return rollbacks;
		},
	};
}

test('apply blocks dismissals, navigation and duplicate commits until successful completion', async () => {
	const h = await harness();
	const applying = h.primary.dispatch('click');
	assert.equal(h.attempts.length, 1);
	assert.equal(h.overlay.getAttribute('aria-busy'), 'true');
	for (const control of [h.close, h.back, h.primary, ...h.steps]) {
		assert.equal(control.disabled, true);
	}
	assert.equal(h.primary.textContent, 'Applying to canvas…');
	await h.close.dispatch('click');
	await h.backdrop.dispatch('click');
	let prevented = false;
	let stopped = false;
	h.document.dispatch('keydown', {
		key: 'Escape',
		preventDefault() {
			prevented = true;
		},
		stopImmediatePropagation() {
			stopped = true;
		},
	});
	assert.ok(prevented && stopped);
	await h.back.dispatch('click');
	for (const step of h.steps) {
		await step.dispatch('click');
	}
	await h.primary.dispatch('click');
	assert.equal(h.attempts.length, 1);
	assert.equal(h.panels[2].hidden, false);
	assert.ok(h.overlay.parentNode);
	assert.equal(h.closes, 0);
	assert.equal(h.rollbacks, 0);
	assert.equal(h.record._migrateMatchedId, '003CHOSEN');
	assert.equal(h.record.values.LastName, 'Chosen');
	h.attempts[0].resolve();
	await applying;
	assert.equal(h.overlay.parentNode, null);
	assert.equal(h.closes, 1);
	assert.equal(h.rollbacks, 0);
	assert.equal(h.record._migrateMatchedId, '003CHOSEN');
	assert.equal(h.document.listeners.has('keydown'), false);
});

test('failed apply preserves choices and re-enables navigation and retry', async () => {
	const h = await harness();
	const applying = h.primary.dispatch('click');
	h.attempts[0].reject(new Error('Destination refresh failed'));
	await applying;
	assert.deepEqual(h.errors, ['Destination refresh failed']);
	assert.ok(h.overlay.parentNode);
	assert.equal(h.overlay.getAttribute('aria-busy'), 'false');
	for (const control of [h.close, h.back, h.primary, ...h.steps]) {
		assert.equal(control.disabled, false);
	}
	assert.equal(h.primary.textContent, 'Apply migration to canvas');
	assert.equal(h.record._migrateMatchedId, '003CHOSEN');
	assert.equal(h.record.values.LastName, 'Chosen');
	assert.equal(h.rollbacks, 0);
	await h.steps[0].dispatch('click');
	assert.equal(h.panels[0].hidden, false);
	await h.steps[2].dispatch('click');
	const retry = h.primary.dispatch('click');
	assert.equal(h.attempts.length, 2);
	h.attempts[1].resolve();
	await retry;
	assert.equal(h.closes, 1);
	assert.equal(h.rollbacks, 0);
});

test('after failed apply the user can still cancel and restore the original choices', async () => {
	const h = await harness();
	const applying = h.primary.dispatch('click');
	h.attempts[0].reject(new Error('Refresh failed'));
	await applying;
	await h.backdrop.dispatch('click');
	assert.equal(h.overlay.parentNode, null);
	assert.equal(h.closes, 1);
	assert.equal(h.rollbacks, 1);
	assert.equal(h.record._migrateMatchedId, '003ORIGINAL');
	assert.equal(h.record.values.LastName, 'Original');
});
