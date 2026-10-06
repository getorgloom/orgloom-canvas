import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/public/js/soql-import.js', import.meta.url), 'utf8');

function harness({ playground = false, records = [], capped = false, truncated = false } = {}) {
	const elements = new Map();
	function element(selector) {
		if (!elements.has(selector)) {
			elements.set(selector, {
				innerHTML: '',
				value: '',
				checked: true,
				listeners: {},
				attributes: {},
				addEventListener(type, fn) {
					this.listeners[type] = fn;
				},
				setAttribute(name, value) {
					this.attributes[name] = value;
				},
				querySelector: element,
				querySelectorAll: () => [],
				classList: {
					toggle(name, value) {
						this[name] = value;
					},
				},
				focus() {},
				remove() {},
			});
		}
		return elements.get(selector);
	}
	const modal = element('modal');
	const requests = [];
	const context = {
		window: { ORGLOOM_MOCK: playground, SF_INSTANCE_URL: 'https://example.my.salesforce.com' },
		document: {
			createElement: () => modal,
			querySelectorAll: () => [],
			body: { appendChild() {} },
			addEventListener() {},
			removeEventListener() {},
		},
		setTimeout: (fn) => fn(),
	};
	vm.runInNewContext(source, context);
	const noop = () => {};
	const api = context.window.OrgLoom.soqlImport.mount({
		canvasState: {},
		showBulkToast: noop,
		escapeHtml: (value) =>
			String(value)
				.replaceAll('&', '&amp;')
				.replaceAll('<', '&lt;')
				.replaceAll('>', '&gt;')
				.replaceAll('"', '&quot;'),
		csrfFetch: async (_url, options) => {
			requests.push(JSON.parse(options.body));
			return {
				ok: true,
				json: async () => ({ records, returned: records.length, totalSize: 999, capped, truncated }),
			};
		},
		addToSelection: noop,
		renderBulkView: noop,
		getGraph: noop,
		clearBulkUserDeleted: noop,
		relayoutNewRecords: noop,
		setSkipNextCyAutoPan: noop,
		clearEmptyStarterCard: noop,
	});
	api.openModal();
	element('#soql-query').value = 'SELECT Id, Name FROM Account';
	return { modal, element, requests, preview: () => element('#soql-preview-btn').listeners.click() };
}

test('SOQL modal keeps concise instructions and collapsed query help', () => {
	const { modal } = harness();
	assert.match(modal.innerHTML, /Include <code>Id<\/code> in your query\. Up to 500 records per import\./);
	assert.match(modal.innerHTML, /<details class="soql-query-help"><summary>Query help<\/summary>/);
	assert.match(modal.innerHTML, /id="soql-full-fields" checked/);
	assert.match(modal.innerHTML, /Include fields not listed in your query\./);
	assert.match(modal.innerHTML, /id="soql-preview-btn">Preview<\/button>/);
});

test('playground keeps its read-only preset and disabled full-fields option', () => {
	const { modal } = harness({ playground: true });
	assert.match(modal.innerHTML, /Demo query\. Connect Salesforce to run your own\./);
	assert.match(modal.innerHTML, /readonly aria-readonly="true"/);
	assert.match(modal.innerHTML, /id="soql-full-fields" checked disabled/);
	assert.match(modal.innerHTML, /WHERE Industry = 'Technology'/);
});

test('preview hides IDs by default, toggles without querying, and retains the choice on rerun', async () => {
	const records = Array.from({ length: 76 }, (_, i) => ({
		objectName: 'Account',
		loadedFromId: '001' + i,
		values: { Name: '<Demo>' },
	}));
	const h = harness({ records });
	await h.preview();
	const preview = h.element('#soql-preview');
	assert.match(preview.innerHTML, /76 records<\/strong> ready to add/);
	assert.match(preview.innerHTML, /soql-preview-tablewrap"/);
	assert.match(preview.innerHTML, /aria-pressed="false">Show IDs/);
	assert.match(preview.innerHTML, /&lt;Demo&gt;/);
	assert.doesNotMatch(preview.innerHTML, /Total in SF|Composite Graph|bulk fallback|class="banner"/);
	const toggle = h.element('toggle');
	preview.listeners.click({ target: { closest: () => toggle } });
	assert.equal(toggle.attributes['aria-pressed'], 'true');
	assert.equal(h.element('.soql-preview-tablewrap').classList['soql-show-ids'], true);
	assert.equal(h.requests.length, 1);
	await h.preview();
	assert.match(preview.innerHTML, /soql-preview-tablewrap soql-show-ids/);
	preview.listeners.click({ target: { closest: () => toggle } });
	assert.equal(toggle.attributes['aria-pressed'], 'false');
	h.element('#soql-full-fields').checked = false;
	await h.preview();
	assert.equal(h.requests.at(-1).fullFields, false);
});

test('limit notices remain conditional and empty results have no ID toggle', async () => {
	for (const options of [{ capped: true }, { truncated: true }]) {
		const h = harness(options);
		await h.preview();
		assert.match(h.element('#soql-preview').innerHTML, /class="banner"/);
	}
	const h = harness();
	await h.preview();
	assert.match(h.element('#soql-preview').innerHTML, /0 records/);
	assert.doesNotMatch(h.element('#soql-preview').innerHTML, /data-soql-toggle-ids|class="banner"/);
});
