const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

function noop() {}

function expiresAt(sessionValue) {
	const cookie = sessionValue?.cookie;
	if (cookie?.expires) {
		const timestamp = new Date(cookie.expires).getTime();
		if (Number.isFinite(timestamp)) {
			return new Date(timestamp).toISOString();
		}
	}
	const maxAge = Number(cookie?.maxAge);
	const lifetime = Number.isFinite(maxAge) && maxAge >= 0
		? maxAge
		: DEFAULT_MAX_AGE_MS;
	return new Date(Date.now() + lifetime).toISOString();
}

/**
 * Create an express-session Store backed by the application's existing
 * better-sqlite3 connection. The table shape intentionally matches the
 * previous adapter so upgrades keep active local sessions readable.
 */
export function createSqliteSessionStore(Store) {
	return class SqliteSessionStore extends Store {
		constructor({ client, cleanupIntervalMs = DEFAULT_CLEANUP_INTERVAL_MS } = {}) {
			super();
			if (!client || typeof client.prepare !== 'function' || typeof client.exec !== 'function') {
				throw new TypeError('A better-sqlite3 client is required');
			}

			this.client = client;
			this.client.exec(`
				CREATE TABLE IF NOT EXISTS sessions (
					sid TEXT NOT NULL PRIMARY KEY,
					sess TEXT NOT NULL,
					expire TEXT NOT NULL
				)
			`);
			this.statements = {
				set: client.prepare(`
					INSERT INTO sessions (sid, sess, expire)
					VALUES (@sid, @sess, @expire)
					ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expire = excluded.expire
				`),
				get: client.prepare(`
					SELECT sess FROM sessions
					WHERE sid = ? AND datetime('now') < datetime(expire)
				`),
				destroy: client.prepare('DELETE FROM sessions WHERE sid = ?'),
				length: client.prepare("SELECT COUNT(*) AS count FROM sessions WHERE datetime('now') < datetime(expire)"),
				clear: client.prepare('DELETE FROM sessions'),
				touch: client.prepare(`
					UPDATE sessions SET expire = @expire
					WHERE sid = @sid AND datetime('now') < datetime(expire)
				`),
				all: client.prepare("SELECT sess FROM sessions WHERE datetime('now') < datetime(expire)"),
				clearExpired: client.prepare("DELETE FROM sessions WHERE datetime('now') >= datetime(expire)"),
			};

			if (Number.isFinite(cleanupIntervalMs) && cleanupIntervalMs > 0) {
				this.cleanupTimer = setInterval(() => {
					try {
						this.statements.clearExpired.run();
					} catch (error) {
						this.emit('disconnect', error);
					}
				}, cleanupIntervalMs);
				this.cleanupTimer.unref?.();
			}
		}

		set(sid, sessionValue, callback = noop) {
			try {
				const result = this.statements.set.run({
					sid,
					sess: JSON.stringify(sessionValue),
					expire: expiresAt(sessionValue),
				});
				callback(null, result);
			} catch (error) {
				callback(error);
			}
		}

		get(sid, callback = noop) {
			try {
				const row = this.statements.get.get(sid);
				callback(null, row ? JSON.parse(row.sess) : null);
			} catch (error) {
				callback(error);
			}
		}

		destroy(sid, callback = noop) {
			try {
				callback(null, this.statements.destroy.run(sid));
			} catch (error) {
				callback(error);
			}
		}

		length(callback = noop) {
			try {
				callback(null, this.statements.length.get().count);
			} catch (error) {
				callback(error);
			}
		}

		clear(callback = noop) {
			try {
				callback(null, this.statements.clear.run());
			} catch (error) {
				callback(error);
			}
		}

		touch(sid, sessionValue, callback = noop) {
			try {
				callback(null, this.statements.touch.run({ sid, expire: expiresAt(sessionValue) }));
			} catch (error) {
				callback(error);
			}
		}

		all(callback = noop) {
			try {
				callback(null, this.statements.all.all().map((row) => JSON.parse(row.sess)));
			} catch (error) {
				callback(error);
			}
		}

		close() {
			if (this.cleanupTimer) {
				clearInterval(this.cleanupTimer);
				this.cleanupTimer = null;
			}
		}
	};
}

