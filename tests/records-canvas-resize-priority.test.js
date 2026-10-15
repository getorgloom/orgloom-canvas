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

test('inline editors resize only from a visible bottom-right grip', () => {
	assert.match(insertModalSource, /handle\.className = 'inline-resize-handle inline-resize-handle--se'/);
	assert.match(insertModalSource, /_startResize\(ev, 'se', body\)/);
	assert.doesNotMatch(insertModalSource, /const dirs = \[/);
	assert.match(cssSource, /inline-resize-handle--se \{[^}]*width: 18px;[^}]*height: 18px;/);
	assert.match(cssSource, /inline-resize-handle--se \{[^}]*background: repeating-linear-gradient\(/);
	assert.match(cssSource, /modal\.is-inline \.modal-content \{\s*scrollbar-gutter: stable;/);
	assert.match(cssSource, /modal\.is-inline \.modal-footer \{\s*padding-right: 2\.5em;/);
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

test('the inline editor claims the gesture before FK edge hit-testing', () => {
	const captureMatch = source.match(
		/document\.addEventListener\(\s*'mousedown',\s*\(ev\) => \{([\s\S]*?)\},\s*true(?:\s*\/\*[\s\S]*?\*\/)?\s*,?\s*\);/,
	);
	const captureHandler = captureMatch ? captureMatch[1] : '';

	const inlineEditorGuard = captureHandler.indexOf("ev.target.closest('.modal.is-inline')");
	const edgeHitTest = captureHandler.indexOf('_findEdgeTargetAt(ev.clientX, ev.clientY)');

	assert.ok(captureMatch, 'capture-phase mousedown handler exists');
	assert.notEqual(inlineEditorGuard, -1, 'capture handler yields to every interaction inside an inline editor');
	assert.notEqual(edgeHitTest, -1, 'capture handler still performs FK edge hit-testing');
	assert.ok(inlineEditorGuard < edgeHitTest, 'inline editor guard runs before FK hit-testing');
});

test('expanded inline editors are never relationship-link sources', () => {
	assert.doesNotMatch(source, /kind: 'modal'/);
	assert.match(source, /ev\.target\.closest\('\.modal\.is-inline'\)/);
	assert.doesNotMatch(cssSource, /modal\.is-inline\.is-edge-link/);
});

test('hovering anywhere in an inline editor clears the FK-link affordance', () => {
	const hoverStart = source.indexOf("document.addEventListener('mousemove', (ev) => {");
	const hoverEnd = source.indexOf("document.addEventListener('mousedown', (ev) => {", hoverStart);
	const hoverHandler = source.slice(hoverStart, hoverEnd);

	assert.match(
		hoverHandler,
		/ev\.target\.closest\('\.modal\.is-inline'\)[\s\S]*classList\.remove\('cy-edge-hover'\)[\s\S]*_setEdgeHoverCard\(null\)/,
	);
});

test('inline editor dragging starts only from non-interactive header space', () => {
	assert.match(insertModalSource, /if \(ev\.button !== 0\)/);
	assert.match(
		insertModalSource,
		/closest\(\s*'button, a, input, select, textarea, \[contenteditable="true"\], \[role="button"\]',?\s*\)/,
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
