import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/public/js/records-canvas.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/public/css/app.css', import.meta.url), 'utf8');
const context = { window: {} };
vm.runInNewContext(source, context);
const { recordObjectLabel } = context.window.OrgLoom.recordsCanvas._test;
const escapeHtml = (value) =>
	String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
test('all object labels use the original orange accent without per-object color overrides', () => {
	assert.match(
		css,
		/\.record-card \.record-type-tag\s*\{[^}]*background: var\(--accent-soft\);[^}]*color: var\(--accent\);/s,
	);
	for (const objectName of ['Account', 'Contact', 'Case', 'Opportunity', 'Example__c']) {
		assert.doesNotMatch(recordObjectLabel({ objectName }, escapeHtml), /style=|--record-object-color/);
	}
});

test('custom object labels are escaped with full hover text', () => {
	const label = '<Custom "Object">' + 'x'.repeat(250);
	const html = recordObjectLabel({ objectName: 'Example__c";color:red', label }, escapeHtml);
	assert.ok(html.includes('title="' + escapeHtml(label) + '"'));
	assert.ok(html.includes('>' + escapeHtml(label) + '</span>'));
	assert.doesNotMatch(html, /<Custom|;color:red/);
	assert.match(recordObjectLabel({}, escapeHtml), />Record<\/span>/);
});

test('cards use object labels without status stripes and preserve selection and delete cues', () => {
	assert.match(source, /recordObjectLabel\(rec, escapeHtml\)/);
	for (const state of [
		'has-draft',
		'has-existing',
		'has-modified',
		'has-pending-delete',
		'record-card-salesforce-readonly',
	]) {
		const rule = css.match(new RegExp('\\.record-card\\.' + state + '\\s*\\{([^}]*)\\}'));
		assert.doesNotMatch(rule?.[1] || '', /border-left/);
	}
	assert.match(css, /\.record-card\.selected\s*\{[^}]*outline: 2px solid var\(--accent\)/);
	assert.match(css, /\.record-card\.has-pending-delete \.record-title-link\s*\{[^}]*line-through/);
	assert.match(css, /\.record-card \.record-type-tag\s*\{[^}]*text-overflow: ellipsis[^}]*color: var\(--accent\)/s);
	for (const badge of ['draft', 'existing', 'modified', 'pending-delete', 'readonly']) {
		assert.ok(css.includes('.record-' + badge + '-badge'));
	}
});

test('status borders cover all sides and selection uses a separate offset ring', () => {
	for (const [state, token] of Object.entries({
		existing: 'info',
		draft: 'success',
		modified: 'warn',
		'pending-delete': 'danger',
	})) {
		const rule = css.match(new RegExp('\\.record-card\\.has-' + state + '\\s*\\{([^}]*)\\}'));
		assert.ok(rule[1].includes('--record-status-border: color-mix(in srgb, var(--' + token + ')'));
	}
	assert.match(css, /\.record-card\s*\{[^}]*border: 1px solid var\(--record-status-border, var\(--border\)\)/);
	for (const state of ['selected', 'multi-selected']) {
		const rule = css.match(new RegExp('\\.record-card\\.' + state + '\\s*\\{([^}]*)\\}'))[1];
		assert.match(rule, /outline: 2px solid var\(--accent\)/);
		assert.match(rule, /outline-offset: 3px/);
		assert.doesNotMatch(rule, /border-color/);
	}
});
