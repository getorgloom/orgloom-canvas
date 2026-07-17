const LEVELS = ['log', 'info', 'warn', 'error', 'debug'];
const OUTCOMES = [
	'failed', 'failure', 'error', 'blocked', 'denied', 'missing', 'invalid',
	'expired', 'disabled', 'enabled', 'started', 'complete', 'ready', 'retry',
];

function safeCode(value) {
	const code = String(value || '');
	return /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : undefined;
}

function safeError(error) {
	const result = { errorType: 'Error' };
	const name = String(error?.name || 'Error');
	if (/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name)) {
		result.errorType = name;
	}
	const code = safeCode(error?.errorCode || error?.code);
	if (code) {
		result.code = code;
	}
	const status = Number(error?.status || error?.statusCode);
	if (Number.isInteger(status) && status >= 100 && status <= 599) {
		result.status = status;
	}
	return result;
}

function eventLabel(value) {
	const raw = String(value || '');
	const prefix = raw.match(/^\[([A-Za-z0-9/_-]{1,40})\]/)?.[1];
	const lower = raw.toLowerCase();
	const outcome = OUTCOMES.find((word) => lower.includes(word)) || 'event';
	return `[${prefix || 'app'}] ${outcome}`;
}

export function sanitizeConsoleArgs(args) {
	return Array.from(args, (arg, index) => {
		try {
			if (arg instanceof Error) {
				return safeError(arg);
			}
			if (typeof arg === 'string') {
				return index === 0 ? eventLabel(arg) : '[redacted]';
			}
			if (typeof arg === 'number' || typeof arg === 'boolean' || arg == null) {
				return arg;
			}
			if (typeof arg === 'object') {
				return { redacted: true, keys: Object.keys(arg).sort().slice(0, 12) };
			}
			return '[redacted]';
		} catch (_) {
			return '[redacted]';
		}
	});
}

export function installOperationalConsoleGuard(consoleLike = console) {
	const originals = new Map();
	for (const level of LEVELS) {
		if (typeof consoleLike[level] !== 'function') {
			continue;
		}
		const original = consoleLike[level].bind(consoleLike);
		originals.set(level, consoleLike[level]);
		consoleLike[level] = (...args) => original(...sanitizeConsoleArgs(args));
	}
	return () => {
		for (const [level, original] of originals) {
			consoleLike[level] = original;
		}
	};
}

export const _internals = { eventLabel, safeError };
