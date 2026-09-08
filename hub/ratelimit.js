'use strict';
/**
 * Tiny in-memory token-bucket rate limiter (per key string).
 * No timers on the hot path: buckets age out lazily, plus a periodic prune.
 */
class RateLimiter {
  constructor() {
    this.buckets = new Map(); // key -> { count, resetAt }
    this._sweeper = setInterval(() => this._prune(), 60000);
    this._sweeper.unref?.();
  }

  /** Consume one token. Returns true if allowed. */
  take(key, max = 60, windowMs = 60000) {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b || b.resetAt <= now) { b = { count: 0, resetAt: now + windowMs }; this.buckets.set(key, b); }
    if (b.count >= max) return false;
    b.count++;
    return true;
  }

  /** Retry delay for a rejected key (seconds) — for 429 bodies. */
  retryAfterSec(key) {
    const b = this.buckets.get(key);
    return b ? Math.max(1, Math.round((b.resetAt - Date.now()) / 1000)) : 1;
  }

  _prune() {
    const now = Date.now();
    for (const [k, b] of this.buckets) if (b.resetAt < now - 5 * 60000) this.buckets.delete(k);
    if (this.buckets.size > 10000) { // hard cap under heavy spray
      const keys = [...this.buckets.keys()].slice(0, this.buckets.size - 8000);
      for (const k of keys) this.buckets.delete(k);
    }
  }
}

module.exports = { RateLimiter };
