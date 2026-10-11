import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const css = readFileSync(new URL('../src/public/css/app.css', import.meta.url), 'utf8');

function declarationsFor(selector) {
	const declarations = new Map();
	const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const rulePattern = new RegExp(escapedSelector + '\\s*\\{([^{}]*)\\}', 'g');
	for (const match of css.matchAll(rulePattern)) {
		for (const declaration of match[1].split(';')) {
			const separator = declaration.indexOf(':');
			if (separator === -1) {
				continue;
			}
			const property = declaration.slice(0, separator).trim();
			const value = declaration.slice(separator + 1).trim();
			if (property) {
				declarations.set(property, value);
			}
		}
	}
	return declarations;
}

test('record diff table owns scrolling while controls and column headers stay visible', () => {
	const body = declarationsFor('.record-diff-modal .modal-body');
	const content = declarationsFor('.record-diff-modal .rdm-content');
	const rows = declarationsFor('.record-diff-modal .rdm-rows');
	const table = declarationsFor('.record-diff-modal .rdm-table');
	const head = declarationsFor('.record-diff-modal .rdm-table-head');

	assert.equal(body.get('overflow'), 'hidden');
	assert.equal(content.get('min-height'), '0');
	assert.equal(content.get('overflow'), 'hidden');
	assert.equal(table.get('min-height'), '0');
	assert.equal(table.get('overflow-y'), 'auto');
	assert.equal(table.get('overscroll-behavior'), 'contain');
	assert.equal(head.get('position'), 'sticky');
	assert.equal(head.get('top'), '0');
	assert.equal(rows.get('flex-shrink'), '0');
});
