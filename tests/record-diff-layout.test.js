import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import postcss from 'postcss';

const css = postcss.parse(readFileSync(new URL('../src/public/css/app.css', import.meta.url), 'utf8'));

function declarationsFor(selector) {
	const declarations = new Map();
	css.walkRules(selector, (rule) => {
		if (rule.selector !== selector) {
			return;
		}
		rule.walkDecls((declaration) => declarations.set(declaration.prop, declaration.value));
	});
	return declarations;
}

test('record diff content shrinks inside the viewport and owns vertical scrolling', () => {
	const body = declarationsFor('.record-diff-modal .modal-body');
	const content = declarationsFor('.record-diff-modal .rdm-content');
	const rows = declarationsFor('.record-diff-modal .rdm-rows');

	assert.equal(body.get('overflow'), 'hidden');
	assert.equal(content.get('min-height'), '0');
	assert.equal(content.get('overflow-y'), 'auto');
	assert.equal(content.get('overscroll-behavior'), 'contain');
	assert.equal(rows.get('flex-shrink'), '0');
});
