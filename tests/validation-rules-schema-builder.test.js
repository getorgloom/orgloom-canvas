import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(new URL('../src/public/js/app.js', import.meta.url), 'utf8');
const editorSource = readFileSync(new URL('../src/public/js/insert-modal.js', import.meta.url), 'utf8');
const schemaSource = readFileSync(new URL('../src/public/js/schema-builder.js', import.meta.url), 'utf8');
const cssSource = readFileSync(new URL('../src/public/css/app.css', import.meta.url), 'utf8');
const uploadModalSource = readFileSync(new URL('../src/public/js/upload-modal.js', import.meta.url), 'utf8');
const routesSource = readFileSync(new URL('../src/canvas-routes.js', import.meta.url), 'utf8');

test('validation rules are presented on schema objects instead of every record editor', () => {
	assert.doesNotMatch(editorSource, /renderRulesSectionHtml|data-section="rules"|Validation Rules/);
	assert.match(schemaSource, /class="schema-validation-rules"/);
	assert.match(schemaSource, /No active validation rules for this object\./);
	assert.ok(schemaSource.includes("Couldn\\'t load validation rules:"));
});

test('schema fields and validation rules are closed metadata sections with rules last', () => {
	const fieldsIndex = schemaSource.indexOf('<section class="schema-fields-section">');
	const rulesIndex = schemaSource.indexOf('<section class="schema-validation-rules">');
	assert.ok(fieldsIndex >= 0);
	assert.ok(rulesIndex > fieldsIndex);
	assert.match(schemaSource, /data-schema-section-toggle aria-expanded="false"/);
	assert.match(schemaSource, /data-schema-section-content hidden/);
	assert.doesNotMatch(schemaSource, /Salesforce enforces these rules during upload/);
});

test('expanded schema cards are resizable and keep field and rule scrolling inside the card', () => {
	assert.match(schemaSource, /class="schema-expand-resize-handle"/);
	assert.match(schemaSource, /_schemaPanelSizes = new Map\(\)/);
	assert.match(schemaSource, /addEventListener\('pointermove'/);
	assert.match(schemaSource, /Resize schema card/);
	assert.match(schemaSource, /width: 'data\(expandedWidth\)'/);
	assert.match(schemaSource, /_repositionExpandedSchemaNeighbors\(\)/);
	assert.match(cssSource, /\.schema-expand-resize-handle\s*\{[^}]*cursor:\s*nwse-resize/s);
	assert.match(cssSource, /\.schema-rules-content\s*\{[^}]*overflow-y:\s*auto/s);
	assert.match(cssSource, /\.schema-expand-body\s*\{[^}]*overflow-y:\s*auto/s);
	assert.match(cssSource, /overscroll-behavior:\s*contain/);
});

test('record selection renders schema immediately and filter changes place new peers outside a resized card', () => {
	assert.match(appSource, /function onRecordClick[\s\S]*?renderBulkView\(\);\s*renderCanvas\(\);/);
	assert.doesNotMatch(
		appSource,
		/function onRecordClick[\s\S]*?renderBulkView\(\);\s*if \(canvasState\.graphView === 'schema'\)/,
	);
	assert.match(schemaSource, /function _syncExpandedSchemaNeighbors\(\)/);
	assert.match(schemaSource, /if \(!_expandedNeighborPositions\.has\(node\.id\(\)\)\)/);
	assert.match(schemaSource, /_expandedNeighborPositions\.set\(ringNode\.id\(\), basePosition\)/);
	assert.match(schemaSource, /_syncExpandedSchemaNeighbors\(\);/);
});

test('schema validation rules load lazily and are cached per Salesforce org and object', () => {
	assert.match(schemaSource, /section\.addEventListener\('schema-section-open'/);
	assert.match(schemaSource, /schema-rule-label">Name:<\/span>/);
	assert.match(schemaSource, /schema-rule-label">Error message:<\/span>/);
	assert.match(schemaSource, /if \(loaded\)/);
	assert.match(schemaSource, /ensureRules\(objectName\)/);
	assert.match(appSource, /String\(window\.SF_ORG_ID \|\| 'unknown'\) \+ '\|' \+ name/);
	assert.match(appSource, /const request = csrfFetch\('\/api\/objects\/'/);
});

test('record autofill retains parsed rules without restoring the record-level rule UI', () => {
	assert.match(editorSource, /const rulesPromise = sharedDraft/);
	assert.match(editorSource, /: ensureRules\(objectName\)/);
	assert.match(editorSource, /tryFixValidationRules\(values, currentFields, currentRules\)/);
});

test('Salesforce validates actual uploads without a separate sample-write pass', () => {
	assert.match(uploadModalSource, /csrfFetch\('\/api\/upload\/graph'/);
	assert.doesNotMatch(uploadModalSource, /\/api\/upload\/preflight/);
	assert.match(routesSource, /app\.post\('\/api\/upload\/graph'/);
	assert.doesNotMatch(routesSource, /app\.post\('\/api\/upload\/preflight'/);
	assert.match(routesSource, /url: apiBase \+ '\/composite\/graph'/);
});
