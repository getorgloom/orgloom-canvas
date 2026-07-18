import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import vm from 'node:vm';

const proposalSource = readFileSync(new URL('../src/public/js/ai-proposals.js', import.meta.url), 'utf8');
const clarificationSource = readFileSync(new URL('../src/public/js/ai-clarifications.js', import.meta.url), 'utf8');

function element() {
	return {
		hidden: true,
		innerHTML: '',
		textContent: '',
		value: '',
		appendChild() {},
		addEventListener() {},
		setAttribute() {},
		querySelector() {
			return element();
		},
		querySelectorAll() {
			return [];
		},
	};
}

function createHarness(source, moduleName, responseKey) {
	const windowListeners = new Map();
	const documentListeners = new Map();
	const requests = [];
	const intervals = new Map();
	let intervalId = 0;
	const window = {
		ORGLOOM_MCP_ACTIVE: false,
		OrgLoom: {},
		Orgloom: {},
		localStorage: { getItem: () => null, setItem() {} },
		addEventListener(event, handler) {
			if (!windowListeners.has(event)) {
				windowListeners.set(event, []);
			}
			windowListeners.get(event).push(handler);
		},
	};
	const document = {
		visibilityState: 'visible',
		body: element(),
		createElement: element,
		addEventListener(event, handler) {
			documentListeners.set(event, handler);
		},
	};
	vm.runInNewContext(source, {
		window,
		document,
		console,
		Promise,
		JSON,
		Number,
		String,
		Array,
		Map,
		Set,
		encodeURIComponent,
		setInterval(callback) {
			const id = ++intervalId;
			intervals.set(id, callback);
			return id;
		},
		clearInterval(id) {
			intervals.delete(id);
		},
	});
	const deps = {
		canvasState: { currentCanvas: { id: 'draft-test' }, bulkRecords: [], bulkAssociations: [] },
		csrfFetch: async (url) => {
			requests.push(url);
			return { ok: true, json: async () => ({ [responseKey]: [] }) };
		},
		escapeHtml: (value) => String(value),
		showBulkToast() {},
		showConfirmDialog: async () => true,
		addToSelection() {},
		bulkAutoFill() {},
		ensureDescribe: async () => ({}),
		renderBulkView() {},
	};
	const api = window.OrgLoom[moduleName].mount(deps);
	return {
		api,
		requests,
		intervals,
		focus() {
			for (const handler of windowListeners.get('focus') || []) {
				handler();
			}
		},
		setActive(active) {
			window.ORGLOOM_MCP_ACTIVE = active;
			for (const handler of windowListeners.get('orgloom:mcp-availability') || []) {
				handler({ detail: { active } });
			}
		},
	};
}

for (const scenario of [
	{
		name: 'proposal',
		source: proposalSource,
		moduleName: 'aiProposals',
		responseKey: 'proposals',
		refreshMethod: 'refreshProposals',
		path: '/proposals',
	},
	{
		name: 'clarification',
		source: clarificationSource,
		moduleName: 'aiClarifications',
		responseKey: 'clarifications',
		refreshMethod: 'refreshClarifications',
		path: '/clarifications',
	},
]) {
	describe(`${scenario.name} polling`, () => {
		test('stays idle without an MCP token and follows availability changes', async () => {
			const harness = createHarness(scenario.source, scenario.moduleName, scenario.responseKey);
			assert.equal(harness.requests.length, 0);
			assert.equal(harness.intervals.size, 0);

			harness.focus();
			await harness.api[scenario.refreshMethod]();
			assert.equal(harness.requests.length, 0, 'focus and direct refresh remain gated');

			harness.setActive(true);
			assert.equal(harness.requests.length, 1);
			assert.match(harness.requests[0], new RegExp(`${scenario.path}$`));
			assert.equal(harness.intervals.size, 1);
			const scheduledRefresh = [...harness.intervals.values()][0];

			harness.setActive(false);
			assert.equal(harness.intervals.size, 0);
			await scheduledRefresh();
			assert.equal(harness.requests.length, 1, 'a queued callback is harmless after revocation');
		});
	});
}
