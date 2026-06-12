export class TokenBucketRateLimiter {
  constructor({
    now = () => Date.now(),
    maxKeys = 2_000,
    cleanupIntervalMs = 60_000,
  } = {}) {
    this.now = now;
    this.maxKeys = maxKeys;
    this.cleanupIntervalMs = cleanupIntervalMs;
    this.entries = new Map();
    this.nextCleanupAt = 0;
  }

  consume(bucket, key, { capacity, windowMs, cost = 1 }) {
    const now = this.now();
    if (now >= this.nextCleanupAt || this.entries.size >= this.maxKeys) {
      this.prune(now);
      this.nextCleanupAt = now + this.cleanupIntervalMs;
    }

    const entryKey = `${bucket}:${key}`;
    const refillPerMs = capacity / windowMs;
    const previous = this.entries.get(entryKey);
    const elapsed = previous ? Math.max(0, now - previous.updatedAt) : 0;
    const available = previous
      ? Math.min(capacity, previous.tokens + elapsed * refillPerMs)
      : capacity;
    const allowed = available >= cost;
    const tokens = allowed ? available - cost : available;
    const retryAfterSeconds = allowed
      ? 0
      : Math.max(1, Math.ceil((cost - available) / refillPerMs / 1_000));

    this.entries.delete(entryKey);
    this.entries.set(entryKey, {
      tokens,
      updatedAt: now,
      expiresAt: now + windowMs * 2,
    });
    while (this.entries.size > this.maxKeys) {
      this.entries.delete(this.entries.keys().next().value);
    }

    return {
      allowed,
      remaining: Math.max(0, Math.floor(tokens)),
      retryAfterSeconds,
    };
  }

  prune(now = this.now()) {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    while (this.entries.size > this.maxKeys) {
      this.entries.delete(this.entries.keys().next().value);
    }
  }

  get size() {
    return this.entries.size;
  }
}
