import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const toolbarSource = readFileSync(new URL('../src/public/js/bulk-toolbar.js', import.meta.url), 'utf8');
const saveLoadSource = readFileSync(new URL('../src/public/js/canvas-save-load.js', import.meta.url), 'utf8');
const csvExportSource = readFileSync(new URL('../src/public/js/canvas-export-csv.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/public/js/app.js', import.meta.url), 'utf8');
const routesSource = readFileSync(new URL('../src/canvas-routes.js', import.meta.url), 'utf8');
const saveLoadMountStart = appSource.indexOf('window.OrgLoom.canvasSaveLoad.mount({');
const saveLoadMountEnd = appSource.indexOf('const showSaveMenu = _csl.showSaveMenu', saveLoadMountStart);
const saveLoadMountSource = appSource.slice(saveLoadMountStart, saveLoadMountEnd);

test('Save canvas is locked before opening a save flow without permission', () => {
	assert.match(toolbarSource, /hasCapability\('save-canvas'\)/);
	assert.match(toolbarSource, /const savePending = !saveCapabilityReady/);
	assert.match(toolbarSource, /const saveLocked = saveCapabilityReady && !saveAllowed/);
	assert.match(toolbarSource, /Ask a workspace admin to grant you the Save canvases permission/);
	assert.match(toolbarSource, /canvas-save-primary--locked/);
	assert.match(saveLoadSource, /requireCapability\('save-canvas', 'Save canvases'\)/);
});

test('recipients get one clear save-copy action instead of duplicate new-canvas actions', () => {
	assert.match(saveLoadSource, /data-tpl-action="save-copy"/);
	assert.match(saveLoadSource, /Save a copy <span class="tpl-action-sub">create your own editable canvas/);
	assert.match(saveLoadSource, /const saveAsNewBtn =\s*!hasCurrent \|\| editsCurrent/);
	assert.doesNotMatch(saveLoadSource, /Fork as new canvas|data-tpl-action="fork-canvas"/);
});

test('file and CSV exports remain visible but locked without their respective permissions', () => {
	assert.match(saveLoadSource, /capabilityActionState\('export-canvas', 'Export canvas as file'\)/);
	assert.match(saveLoadSource, /capabilityActionState\('export-records', 'Export records as CSV'\)/);
	assert.match(saveLoadSource, /data-tpl-action="export-file"/);
	assert.match(saveLoadSource, /data-tpl-action="export-csv"/);
	assert.match(saveLoadSource, /requireCapability\('export-canvas', 'Export canvas as file'\)/);
	assert.match(saveLoadSource, /requireCapability\('export-records', 'Export records as CSV'\)/);
	assert.ok(saveLoadMountStart >= 0);
	assert.ok(saveLoadMountEnd > saveLoadMountStart);
	assert.match(saveLoadMountSource, /isCapabilityReady:[\s\S]*return _capsLoaded/);
});

test('file export rechecks permission immediately before creating the download', () => {
	const exportStart = saveLoadSource.indexOf('async function promptFileExport()');
	const exportEnd = saveLoadSource.indexOf('function _showExportOptionsDialog', exportStart);
	const exportSource = saveLoadSource.slice(exportStart, exportEnd);

	assert.ok(exportStart >= 0);
	assert.ok(exportEnd > exportStart);
	assert.match(exportSource, /await verifyFileExportPermission\(\)/);
	assert.ok(exportSource.indexOf('await verifyFileExportPermission()') < exportSource.indexOf('downloadTemplate('));
	assert.match(saveLoadSource, /\/api\/capabilities\/export-canvas\/check/);
	assert.match(saveLoadSource, /response\.status === 403/);
	assert.match(saveLoadSource, /refreshCapabilities\(\)/);
	assert.match(saveLoadSource, /class="app-export-options-error" role="alert" hidden/);
	assert.match(saveLoadSource, /confirmAccess\(\{ showError: false \}\)/);
	assert.match(saveLoadSource, /errorBox\.textContent = access\.message/);
	assert.match(saveLoadSource, /<h3>Unable to export canvas<\/h3>/);
	assert.match(saveLoadSource, /No file was downloaded\.<\/p>/);
	assert.match(saveLoadMountSource, /refreshCapabilities:[\s\S]*return _loadCaps\(\)\.then/);
	assert.match(routesSource, /app\.post\('\/api\/capabilities\/export-canvas\/check'/);
	assert.match(routesSource, /_gateCapability\(req, res, 'export-canvas', 'export_canvas'/);
});

test('CSV export rechecks permission and keeps its modal open on denial', () => {
	const runStart = csvExportSource.indexOf('async function runDownload()');
	const runEnd = csvExportSource.indexOf('async function verifyCsvExportPermission()', runStart);
	const runSource = csvExportSource.slice(runStart, runEnd);

	assert.ok(runStart >= 0);
	assert.ok(runEnd > runStart);
	assert.match(runSource, /await verifyCsvExportPermission\(\)/);
	assert.ok(runSource.indexOf('await verifyCsvExportPermission()') < runSource.indexOf('triggerDownload('));
	assert.match(csvExportSource, /\/api\/capabilities\/export-records\/check/);
	assert.match(csvExportSource, /class="cec-access-error" role="alert" hidden/);
	assert.match(csvExportSource, /errorBox\.textContent = access\.message/);
	assert.match(csvExportSource, /response\.status === 403/);
	assert.match(routesSource, /app\.post\('\/api\/capabilities\/export-records\/check'/);
	assert.match(routesSource, /_gateCapability\(req, res, 'export-records', 'export_records'/);
});
