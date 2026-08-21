import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '../src');
const saasSrc = path.resolve(here, '../../../apps/saas/src');

test('PostHog never records canvas surfaces and hashes signed-in identity', () => {
	const template = fs.readFileSync(path.join(src, 'views/partials/top-strip.ejs'), 'utf8');
	assert.match(template, /const _ph_signedIn =/);
	assert.match(template, /const _ph_replayDisabled = _ph_signedIn \|\| _ts_onCanvas \|\| _ts_playground/);
	assert.match(template, /autocapture: <%= _ph_replayDisabled \? 'false' : 'true' %>/);
	assert.match(template, /disable_session_recording: <%= _ph_replayDisabled \? 'true' : 'false' %>/);
	assert.match(template, /mask_all_text: <%= _ph_replayDisabled \? 'true' : 'false' %>/);
	assert.match(template, /posthog\.identify\(<%- jsonForScript\('acct:' \+ accountIdHash\) %>/);
	assert.doesNotMatch(template, /posthog\.identify\(<%- jsonForScript\(user\.id\) %>/);
	assert.match(template, /delete properties\.\$current_url/);
	assert.match(template, /delete properties\.\$referrer/);
	assert.match(template, /properties\.page_path = window\.location\.pathname/);
});

test('browser error telemetry drops free-form messages, context, and click crumbs', () => {
	const source = fs.readFileSync(path.join(src, 'public/js/sentry-init.js'), 'utf8');
	assert.match(source, /event\.message = '<redacted-error-message>'/);
	assert.match(source, /event\.extra = \{\}/);
	assert.match(source, /b\.category === 'ui\.click'[\s\S]*?return null/);
	assert.match(source, /ex\.value = '<redacted-error-message>'/);
});

test('server error telemetry drops free-form messages and extra context', (t) => {
	const sourcePath = path.join(saasSrc, 'lib/sentry.js');
	if (!fs.existsSync(sourcePath)) {
		t.skip('hosted SaaS source is not installed');
		return;
	}
	const source = fs.readFileSync(sourcePath, 'utf8');
	assert.match(source, /event\.message = '<redacted-error-message>'/);
	assert.match(source, /event\.extra = \{\}/);
	assert.match(source, /ex\.value = '<redacted-error-message>'/);
});
