import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = (file) => fs.readFileSync(new URL('../src/public/js/' + file, import.meta.url), 'utf8');
const json = (value) => JSON.parse(JSON.stringify(value));
const globals = { window: { OrgLoom: {} }, console, localStorage: { removeItem() {} } };
globals.window.Orgloom = globals.window.OrgLoom;
for (const file of ['migrate-annotate.js', 'linked-csv.js']) vm.runInNewContext(read(file), globals);
const engine = globals.window.Orgloom.migrateAnnotate;

test('excluding an unavailable object keeps valid records and removes optional links and source IDs', () => {
	const records = [
		{ id: 1, objectName: 'Missing__c', values: { Name: 'Source' }, _migrateExcluded: true },
		{ id: 2, objectName: 'Account', values: { Name: 'Keep', Parent__c: 'SOURCE_ID' } },
	];
	const savedSource = structuredClone(records);
	const links = [{ fromId: 2, toId: 1, fieldName: 'Parent__c' }];
	const annotations = engine.annotateRecords(records, {
		Account: { fields: [{ name: 'Name' }, { name: 'Parent__c' }] },
	});
	assert.equal(annotations[0].status, 'excluded');
	const result = engine.applyMigrationPlan(
		records,
		links,
		{ 1: annotations[0], 2: annotations[1] },
		{},
		{ Account: { fields: [{ name: 'Parent__c', required: false }] } },
	);
	assert.equal(result.excluded, 1);
	assert.equal(records.length, 1);
	assert.equal(records[0].values.Name, 'Keep');
	assert.equal('Parent__c' in records[0].values, false);
	assert.equal(links.length, 0);
	assert.equal(savedSource.length, 2);
	assert.equal(savedSource[0].values.Name, 'Source');
});

test('a required relationship to an excluded record blocks the plan without partially changing records', () => {
	const records = [
		{ id: 1, objectName: 'Missing__c', _migrateExcluded: true, values: {} },
		{ id: 2, objectName: 'Child__c', values: { Parent__c: 'SOURCE_ID' } },
	];
	const links = [{ fromId: 2, toId: 1, fieldName: 'Parent__c' }];
	const describes = { Child__c: { fields: [{ name: 'Parent__c', required: true }] } };
	const before = JSON.stringify({ records, links });
	assert.equal(engine.exclusionIssues(records[1], records, links, describes)[0].kind, 'excluded-relationship');
	assert.throws(() => engine.applyMigrationPlan(records, links, {}, {}, describes), /required relationship/);
	assert.equal(JSON.stringify({ records, links }), before);
	delete records[0]._migrateExcluded;
	assert.equal(engine.exclusionIssues(records[1], records, links, describes).length, 0);
});

test('unavailable included objects and an entirely excluded plan cannot be applied', () => {
	const record = { id: 1, objectName: 'Missing__c', values: {} };
	assert.throws(() => engine.applyMigrationPlan([record], [], { 1: { status: 'pending' } }, {}), /unavailable/);
	record._migrateExcluded = true;
	assert.throws(() => engine.applyMigrationPlan([record], [], {}, {}), /at least one/);
});

test('CSV unmapped values stay separate from Salesforce fields; relationship keys and encrypted values are not copied', () => {
	const file = {
		headers: ['Name', 'Missing__c', 'RelationshipKey', 'Secret__c'],
		mapping: { 0: 'Name' },
		describe: { fields: [{ name: 'Secret__c', type: 'encryptedstring' }] },
	};
	const notes = globals.window.OrgLoom.unmappedCsvColumns(
		file,
		['Draft', 'Keep me', 'match-key', 'secret'],
		new Set([2]),
	);
	assert.deepEqual(json(notes), [{ name: 'Missing__c', value: 'Keep me' }]);
});

function templateHarness() {
	const window = { OrgLoom: { importShared: { admitAssociation: () => true, skipSuffix: () => '' } } };
	const context = { window, console, localStorage: { removeItem() {} } };
	for (const file of ['encrypted-fields.js', 'templates.js']) vm.runInNewContext(read(file), context);
	const state = {
		selectedObjects: [],
		selectedIdSeq: 1,
		hiddenObjects: new Set(),
		bulkRecords: [],
		bulkAssociations: [],
		bulkIdSeq: 1,
		bulkSelectedIds: new Set(),
		_prefetchedTypeNodeKeys: new Set(),
		_renderedRecIds: new Set(),
		describeCache: {},
	};
	const requests = [];
	const warnings = [];
	let available = false;
	const noop = () => {};
	const api = window.OrgLoom.templates.mount({
		canvasState: state,
		showBulkToast: (message) => warnings.push(message),
		escapeHtml: String,
		csrfFetch: async () => {
			throw new Error('Unexpected network call');
		},
		ensureDescribe: async (name) => {
			requests.push(name);
			if (name === 'Missing__c' && !available) throw new Error('Not found');
			const description = { fields: [{ name: 'Name' }, ...(available ? [{ name: 'Missing_Field__c' }] : [])] };
			state.describeCache[name] = description;
			return description;
		},
		addToSelection: async (name) => {
			const entry = { id: state.selectedIdSeq++, name, label: name };
			state.selectedObjects.push(entry);
			return entry;
		},
		setGraphView: noop,
		renderAll: noop,
		showReplaceOrMergeDialog: noop,
		pingAuditEvent: noop,
		getCanvasRecordCap: () => 5000,
		realRecordCount: () => state.bulkRecords.length,
		runSlotPreflight: async () => {},
		clearEmptyStarterCard: noop,
		getSlotIdSeq: () => 1,
		setSlotIdSeq: noop,
	});
	return {
		api,
		state,
		requests,
		warnings,
		makeAvailable: () => {
			available = true;
		},
	};
}

for (const format of ['template', 'saved']) {
	test(format + ' JSON keeps unavailable objects and fields, warns, and checks once per object', async () => {
		const { api, state, requests, warnings, makeAvailable } = templateHarness();
		const entries = [
			{
				id: 1,
				tempId: 1,
				objectName: 'Account',
				values: { Name: 'One', Missing_Field__c: 'Keep value' },
				unmappedCsvColumns: [{ name: 'CSV column', value: 'Keep CSV too' }],
			},
			{ id: 2, tempId: 2, objectName: 'Account', values: { Name: 'Two' } },
			{ id: 3, tempId: 3, objectName: 'Missing__c', values: { Name: 'Three' } },
		];
		const payload = {
			_meta: { app: 'Org Loom', version: 1 },
			schema: { objects: [{ name: 'Account' }, { name: 'Missing__c' }] },
			associations: [],
			...(format === 'template' ? { records: entries } : { drafts: entries, loadedRecords: [] }),
		};
		await api[format === 'template' ? 'applyTemplate' : 'applyCanvasPayload'](payload, {
			importFileName: 'probe.json',
		});
		assert.equal(state.bulkRecords.length, 3);
		assert.equal(state.bulkRecords[0].values.Missing_Field__c, 'Keep value');
		assert.deepEqual(json(state.bulkRecords[0]._importSchemaWarning.fields), ['Missing_Field__c']);
		assert.equal(state.bulkRecords[2]._importSchemaWarning.objectUnavailable, true);
		assert.equal(requests.filter((name) => name === 'Account').length, 1);
		assert.match(warnings.at(-1), /unavailable object/);
		assert.match(warnings.at(-1), /field value/);
		const exported = api.buildTemplate({});
		assert.equal(exported.records[0].values.Missing_Field__c, 'Keep value');
		assert.equal(exported.records[0].unmappedCsvColumns[0].value, 'Keep CSV too');
		assert.equal('unmappedCsvColumns' in api.buildCanvasPayload().drafts[0], false);
		makeAvailable();
		await api.checkImportedRecords(state.bulkRecords);
		assert.equal(state.bulkRecords[0]._importSchemaWarning, undefined);
		assert.equal(state.bulkRecords[2]._importSchemaWarning, undefined);
	});
}
