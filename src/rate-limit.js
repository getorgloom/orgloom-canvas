// In-memory sliding-window rate limiter.
//
// Lightweight enough to live in the process: no Redis dependency for
// the open-source canvas, no horizontal-scale story yet. A future
// hosted-tier multi-instance deploy will need a shared store (Redis,
// dynamoDB), but the API of `take()` stays the same so the call sites
// don't have to change.
//
// Usage:
//   const limiter = makeLimiter({ windowMs: 60_000, max: 10 });
//   if (!limiter.take('account-123')) return res.status(429)...
//
// Each bucket stores an array of timestamps within the window. On
// take(), expired timestamps are dropped, the current count is
// compared to `max`, and (if accepted) the new timestamp is appended.
// Buckets are pruned when they go fully empty so memory doesn't
// grow without bound.

export function makeLimiter({ windowMs, max }) {
	if (!Number.isFinite(windowMs) || windowMs <= 0) {
throw new Error('windowMs required (positive number of ms)');
}
	if (!Number.isFinite(max) || max <= 0) {
throw new Error('max required (positive number of attempts)');
}
	const buckets = new Map();

	function take(key) {
		const k = String(key);
		const now = Date.now();
		const cutoff = now - windowMs;
		let times = buckets.get(k);
		if (!times) {
 times = []; buckets.set(k, times); 
}
		// Drop expired entries from the head. Since we push monotonically,
		// the first entry above cutoff means all later entries are too.
		let drop = 0;
		while (drop < times.length && times[drop] <= cutoff) {
drop++;
}
		if (drop > 0) {
times.splice(0, drop);
}
		if (times.length === 0) {
buckets.delete(k);
} // re-add below if we accept
		if (times.length >= max) {
			// Re-stash if we just deleted the empty bucket above.
			if (!buckets.has(k)) {
buckets.set(k, times);
}
			return false;
		}
		times.push(now);
		if (!buckets.has(k)) {
buckets.set(k, times);
}
		return true;
	}

	// Test helper: clear all state. Not for production use.
	function reset() {
 buckets.clear(); 
}

	return { take, reset };
}
