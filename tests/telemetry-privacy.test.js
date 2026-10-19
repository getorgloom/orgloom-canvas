import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { scrubErrorEvent } from '../src/public/js/error-telemetry.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '../src');
const saasSrc = path.resolve(here, '../../../apps/saas/src');

test('PostHog never records canvas surfaces and hashes signed-in identity', () => {
	const template = fs.readFileSync(path.join(src, 'views/partials/posthog.ejs'), 'utf8');
	assert.match(template, /const _ph_signedIn =/);
	assert.match(template, /const _ph_replayDisabled = _ph_signedIn/);
	assert.match(template, /autocapture: <%= _ph_replayDisabled \? 'false' : 'true' %>/);
	assert.match(template, /disable_session_recording: <%= _ph_replayDisabled \? 'true' : 'false' %>/);
	assert.match(template, /mask_all_text: <%= _ph_replayDisabled \? 'true' : 'false' %>/);
	assert.match(template, /posthog\.identify\(<%- jsonForScript\('acct:' \+ accountIdHash\) %>/);
	assert.doesNotMatch(template, /posthog\.identify\(<%- jsonForScript\(user\.id\) %>/);
	assert.match(template, /before_send: function/);
	assert.match(template, /properties\.page_path = window\.location\.pathname/);
});

test('import failure telemetry contains only a normalized flow and reason', () => {
	const source = fs.readFileSync(path.join(src, 'public/js/import-shared.js'), 'utf8');
	const captured = [];
	const window = {
		posthog: {
			capture(name, properties) {
				captured.push({ name, properties });
			},
		},
	};
	vm.runInNewContext(source, { window, Set });

	window.OrgLoom.importShared.captureImportFailure('soql', 'query', 'sensitive Salesforce error');

	assert.deepEqual(JSON.parse(JSON.stringify(captured)), [
		{
			name: 'canvas_import_failed',
			properties: { flow: 'soql', reason: 'query' },
		},
	]);
});

function loadConfig(kind, enabled = true) {
	const file = kind === 'browser' ? path.join(src, 'public/js/sentry-init.js') : path.join(saasSrc, 'lib/sentry.js');
	if (!fs.existsSync(file)) {
		return null;
	}
	let config;
	const sdk = {
		init(value) {
			config = value;
		},
		setUser() {},
	};
	const source = fs
		.readFileSync(file, 'utf8')
		.replace(/^import .*;$/gm, '')
		.replace(/^export \{ Sentry \};$/gm, '')
		.replace(/^export /gm, '');
	vm.runInNewContext(source, {
		Sentry: sdk,
		scrubErrorEvent,
		window: { Sentry: sdk, ORGLOOM_SENTRY_DSN: enabled ? 'https://public@invalid.test/1' : null },
		process: { env: { SENTRY_DSN: enabled ? 'https://public@invalid.test/1' : '' } },
		console: { log() {} },
	});
	return config;
}

function sensitiveEvent() {
	const secret = 'private-record@example.invalid';
	return {
		event_id: 'a'.repeat(32),
		timestamp: 1234567890,
		level: 'error',
		platform: 'javascript',
		environment: 'production',
		release: 'a'.repeat(40),
		user: { id: 'acct:0123456789abcdef', email: secret, ip_address: secret, name: secret },
		message: secret,
		logentry: { message: secret, params: [secret] },
		request: {
			url: 'https://user:password@example.invalid/workspaces/' + secret + '?token=' + secret + '#' + secret,
			method: 'POST',
			data: secret,
			cookies: secret,
			query_string: secret,
			headers: { Authorization: secret, Cookie: secret, Referer: secret, 'X-Custom': secret },
		},
		contexts: {
			response: { status_code: 503, body: secret, headers: { secret } },
			arbitrary: { secret },
			trace: { data: secret },
		},
		extra: { secret },
		breadcrumbs: [{ message: secret, data: { secret } }],
		tags: { source: 'canvas', secret },
		fingerprint: [secret],
		transaction: secret,
		unknown_future_sdk_field: { secret },
		exception: {
			values: [
				{
					type: 'TypeError',
					value: secret,
					mechanism: { data: { secret } },
					stacktrace: {
						registers: { secret },
						frames: [
							{
								filename: 'https://example.invalid/js/app.js?token=' + secret + '#' + secret,
								function: 'saveDraft',
								lineno: 42,
								colno: 3,
								in_app: true,
								vars: { secret },
								context_line: secret,
								pre_context: [secret],
								post_context: [secret],
								abs_path: secret,
							},
						],
					},
				},
			],
		},
	};
}

for (const kind of ['browser', 'server']) {
	test(kind + ' sends only approved error fields through its configured hook', (t) => {
		const config = loadConfig(kind);
		if (!config) {
			t.skip('hosted SaaS source is not installed');
			return;
		}
		const original = sensitiveEvent();
		const output = config.beforeSend(original);
		assert.equal(JSON.stringify(output).includes('private-record'), false);
		assert.deepEqual(output.request, { url: '/workspaces/:path', method: 'POST' });
		assert.deepEqual(output.user, { id: 'acct:0123456789abcdef' });
		assert.deepEqual(output.contexts, { response: { status_code: 503 } });
		assert.deepEqual(output.exception.values[0].stacktrace.frames, [
			{ filename: 'js/app.js', function: 'saveDraft', lineno: 42, colno: 3, in_app: true },
		]);
		assert.equal(output.exception.values[0].type, 'TypeError');
		assert.equal(output.release, 'a'.repeat(40));
		assert.equal(output.environment, 'production');
		assert.equal(original.message, 'private-record@example.invalid', 'do not mutate the original SDK event');
		for (const key of [
			'extra',
			'breadcrumbs',
			'transaction',
			'fingerprint',
			'logentry',
			'unknown_future_sdk_field',
		]) {
			assert.equal(Object.hasOwn(output, key), false);
		}
	});

	test(kind + ' disables tracing, logs and breadcrumbs without disabling error reports', (t) => {
		const config = loadConfig(kind);
		if (!config) {
			t.skip('hosted SaaS source is not installed');
			return;
		}
		assert.equal(config.tracesSampleRate, 0);
		assert.equal(config.enableLogs, false);
		assert.equal(config.autoSessionTracking, false);
		assert.equal(config.sendClientReports, false);
		assert.equal(config.sendDefaultPii, false);
		assert.equal(config.beforeSendTransaction({ type: 'transaction', spans: [{ data: 'secret' }] }), null);
		assert.equal(config.beforeBreadcrumb({ category: 'console', message: 'secret' }), null);
		assert.ok(config.beforeSend(sensitiveEvent()));
		assert.equal(loadConfig(kind, false), undefined);
		if (kind === 'browser') {
			assert.equal(config.replaysSessionSampleRate, 0);
			assert.equal(config.replaysOnErrorSampleRate, 0);
		}
	});
}

test('unknown event properties, paths, identities and error types fail closed', () => {
	assert.equal(scrubErrorEvent(null), null);
	assert.equal(scrubErrorEvent({ type: 'transaction' }), null);
	assert.deepEqual(
		scrubErrorEvent({
			user: { id: 'raw-account-id' },
			request: { url: '/secret-token#fragment', method: 'secret' },
			tags: { source: 'unknown', reason: 'secret' },
			release: 'secret',
			environment: 'secret',
			exception: {
				values: [
					{
						type: 'customer data',
						value: 'secret',
						stacktrace: { frames: [null, { filename: 'eval:secret' }] },
					},
				],
			},
		}),
		{
			request: { url: '/:path' },
			exception: { values: [{ type: 'Error', value: '<redacted-error-message>', stacktrace: { frames: [{}] } }] },
		},
	);
});

test('fixed operational alert grouping survives without arbitrary fingerprints or action values', () => {
	const event = scrubErrorEvent({
		tags: { source: 'audit-mirror', reason: 'retry-exhausted', action: 'secret' },
		fingerprint: ['secret'],
	});
	assert.deepEqual(event.tags, { source: 'audit-mirror', reason: 'retry-exhausted' });
	assert.deepEqual(event.fingerprint, ['audit-mirror', 'retry-exhausted']);
	assert.deepEqual(scrubErrorEvent({ tags: { source: 'audit-mirror', reason: 'secret' } }).tags, {
		source: 'audit-mirror',
	});
});
