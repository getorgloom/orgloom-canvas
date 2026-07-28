import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../src/public/js/records-canvas.js'), 'utf8');
const insertModalSource = fs.readFileSync(path.resolve(here, '../src/public/js/insert-modal.js'), 'utf8');
const appSource = fs.readFileSync(path.resolve(here, '../src/public/js/app.js'), 'utf8');
const cssSource = fs.readFileSync(path.resolve(here, '../src/public/css/app.css'), 'utf8');

test('inline resize corners have a comfortably sized hit area', () => {
	for (const direction of ['nw', 'ne', 'sw', 'se']) {
		assert.match(cssSource, new RegExp(`inline-resize-handle--${direction}[^}]*width: 28px;[^}]*height: 28px;`));
	}
});

test('the full modal perimeter is available for resizing', () => {
	assert.match(insertModalSource, /const dirs = \['n', 'e', 's', 'w', 'nw', 'ne', 'sw', 'se'\]/);
	for (const direction of ['n', 'e', 's', 'w']) {
		assert.match(cssSource, new RegExp(`inline-resize-handle--${direction} \\{[^}]+cursor: ${direction}-resize;`));
	}
});

test('inline editors stay inside the usable canvas instead of the page header', () => {
	assert.match(insertModalSource, /function _getInlineUsableBounds\(container\)/);
	assert.match(
		insertModalSource,
		/rect && rect\.height > 0 \? rect\.top \+ margin : margin/,
		'the Cytoscape canvas top edge, not the browser viewport, defines the modal ceiling',
	);
	assert.match(insertModalSource, /const minTop = bounds\.top \+ halfH/);
	assert.match(insertModalSource, /const maxTop = bounds\.bottom - halfH/);
	assert.match(insertModalSource, /_fitInlineModalToBounds\(_body, container\)/);
	assert.match(insertModalSource, /new ResizeObserver\(_refreshInlineBounds\)/);
	assert.match(insertModalSource, /window\.addEventListener\('resize', _inlineViewportHandler\)/);
	assert.match(cssSource, /max-height: var\(--inline-max-height, 90vh\)/);
	assert.match(cssSource, /max-width: var\(--inline-max-width, 90vw\)/);
});

test('inline editor resizing is constrained by the canvas dimensions', () => {
	assert.match(insertModalSource, /const bounds = _getInlineUsableBounds\(_getCyContainer && _getCyContainer\(\)\)/);
	assert.match(insertModalSource, /const maxW = bounds\.width/);
	assert.match(insertModalSource, /const maxH = bounds\.height/);
	assert.match(insertModalSource, /_inlinePinToNode\(_getCyInstance\(\), _inlineCyNode, _getCyContainer\(\)\)/);
});

test('moving an inline editor publishes the card position to shared viewers', () => {
	assert.match(insertModalSource, /!deps\.publishPresenceLayout/);
	assert.match(insertModalSource, /const publishPresenceLayout = deps\.publishPresenceLayout/);
	assert.match(
		insertModalSource,
		/const movedRec =\s*didMove && canvasState\.bulkRecords\.find\(\(record\) => record\.id === _inlineRecId\)/,
	);
	assert.match(insertModalSource, /publishPresenceLayout\(\[movedRec\]\)/);
	assert.match(
		appSource,
		/publishPresenceLayout: function \(records\) \{\s*return _publishPresenceLayout\(records\);\s*\}/,
	);
});

test('inline resize handles claim the gesture before FK edge hit-testing', () => {
	const captureMatch = source.match(
		/document\.addEventListener\(\s*'mousedown',\s*\(ev\) => \{([\s\S]*?)\},\s*true(?:\s*\/\*[\s\S]*?\*\/)?\s*,?\s*\);/,
	);
	const captureHandler = captureMatch ? captureMatch[1] : '';

	const resizeGuard = captureHandler.indexOf('_isInlineResizeHandleTarget(ev.target)');
	const edgeHitTest = captureHandler.indexOf('_findEdgeTargetAt(ev.clientX, ev.clientY)');

	assert.ok(captureMatch, 'capture-phase mousedown handler exists');
	assert.notEqual(resizeGuard, -1, 'capture handler yields to an inline resize handle');
	assert.notEqual(edgeHitTest, -1, 'capture handler still performs FK edge hit-testing');
	assert.ok(resizeGuard < edgeHitTest, 'resize guard runs before FK hit-testing');
});

test('starting a relationship from the inline editor does not close the editor', () => {
	const outsideHandlerStart = insertModalSource.indexOf('_inlineOutsideClickHandler = (ev) => {');
	const outsideHandlerEnd = insertModalSource.indexOf('document.addEventListener', outsideHandlerStart);
	const outsideHandler = insertModalSource.slice(outsideHandlerStart, outsideHandlerEnd);

	assert.match(outsideHandler, /_getCyPendingEdge && _getCyPendingEdge\(\)/);
	assert.ok(
		outsideHandler.indexOf('_getCyPendingEdge && _getCyPendingEdge()') < outsideHandler.indexOf('closeModal()'),
		'a claimed relationship gesture is ignored before outside-click closing',
	);
	assert.match(appSource, /getCyPendingEdge: function \(\) \{\s*return _cyPendingEdge;\s*\}/);
});

test('hovering an inline resize handle clears the FK-link affordance', () => {
	const hoverStart = source.indexOf("document.addEventListener('mousemove', (ev) => {");
	const hoverEnd = source.indexOf("document.addEventListener('mousedown', (ev) => {", hoverStart);
	const hoverHandler = source.slice(hoverStart, hoverEnd);

	assert.match(
		hoverHandler,
		/_isInlineResizeHandleTarget\(ev\.target\)[\s\S]*classList\.remove\('cy-edge-hover'\)[\s\S]*_setEdgeHoverCard\(null\)/,
	);
});

test('the first Cytoscape render waits for settled card geometry before becoming visible', () => {
	assert.match(source, /container\.classList\.add\('cy-initializing'\)/);
	assert.match(source, /redrawCyEdgeMarkers\(settledCy, container\)/);
	assert.match(source, /container\.classList\.remove\('cy-initializing'\)/);
	assert.ok(
		source.indexOf("container.classList.add('cy-initializing')") <
			source.indexOf("container.classList.remove('cy-initializing')"),
		'initial canvas visibility is restored only after the first-render setup',
	);
});
