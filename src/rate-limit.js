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
			times = [];
			buckets.set(k, times);
		}
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

	function reset() {
		buckets.clear();
	}

	return { take, reset };
}
