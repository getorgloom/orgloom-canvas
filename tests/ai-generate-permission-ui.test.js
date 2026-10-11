import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const aiSource = readFileSync(new URL('../src/public/js/ai-generate.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/public/js/app.js', import.meta.url), 'utf8');
const toolbarSource = readFileSync(new URL('../src/public/js/bulk-toolbar.js', import.meta.url), 'utf8');
const menuSource = readFileSync(new URL('../src/public/js/bulk-ops-menu.js', import.meta.url), 'utf8');

test('Generate with AI checks workspace permission before opening its prompt', () => {
	const gateIndex = aiSource.indexOf("hasCapability('generate-records-with-ai')");
	const modalOpenIndex = aiSource.indexOf("aiGenModal.classList.remove('hidden')");
	assert.ok(gateIndex >= 0);
	assert.ok(modalOpenIndex > gateIndex);
	assert.match(aiSource, /if \(!access\.allowed\) \{\s*showAiAccessBlocked\(access\);\s*return false;/);
	assert.match(aiSource, /Ask a workspace admin to grant the Generate with AI permission/);
	assert.match(aiSource, /Open workspace permissions/);
	assert.match(aiSource, /plan-insufficient/);
	assert.match(aiSource, /Generate with AI is available on Pro and Team plans/);
	assert.match(appSource, /hasCapability:[\s\S]*_hasCap\.apply/);
	assert.match(appSource, /isCapabilityReady:[\s\S]*return _capsLoaded/);
	assert.match(appSource, /getWorkspacePlan:[\s\S]*_meInfo\.workspace\.plan/);
});

test('the Tools menu identifies Generate with AI as locked before prompting', () => {
	assert.match(menuSource, /getAiGen\(\)\.getAccessState\(\)/);
	assert.match(menuSource, /const aiPending = !aiAccess\.ready/);
	assert.match(menuSource, /const aiLocked = aiAccess\.ready && !aiAccess\.allowed/);
	assert.match(menuSource, /Ask a workspace admin to grant you the Generate with AI permission/);
	assert.match(menuSource, /disabled aria-disabled="true"/);
	assert.match(menuSource, /fill-menu-disabled-tip/);
});

test('Generate with AI stays inside Tools on empty and populated canvases', () => {
	assert.doesNotMatch(appSource, /bec-quick bec-quick--ai/);
	assert.doesNotMatch(toolbarSource, /data-bulk-ai-gen/);
	assert.match(toolbarSource, /Generate records with AI, auto-fill drafts/);
	assert.match(menuSource, /data-bulk-op="generate-ai"/);
	assert.match(menuSource, /<div class="fm-header">Create<\/div>/);
	assert.match(menuSource, /openAiGenModal\(\)/);
});
