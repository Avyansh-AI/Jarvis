'use strict';
/**
 * API key ring — round-robin with per-key cooldown.
 *
 * JARVIS POLICY (v1.0.7, extended v1.1.0): keys come EXCLUSIVELY from .env as
 * OPENROUTER_KEY_1..3 (…up to _16, gap-tolerant) — and since v1.1.0 the same
 * rules for the sanctioned overflow providers: GROQ_KEY_1..n (sub-agents +
 * fallback + TTS) and GEMINI_KEY_1..n (fallback brain). Never from the settings
 * store, never from legacy aliases, never displayed — counts only, everywhere.
 * Nothing is ever read from the settings store or legacy env aliases here —
 * hub/keymigrate.js folds UI-entered and legacy-alias keys into .env ONCE at
 * boot, then this file is the one source of truth. When a call fails:
 *   401/402/403 → hard penalty (key presumed dead)   → skipped ~30 min
 *   429/5xx/network → soft penalty (rate limit/blip) → skipped ~5 min
 * Healthy keys are used round-robin; the last known-good key is preferred.
 * Logs reference keys by INDEX ONLY — never the secret itself.
 */
class KeyRing {
  constructor(keys, { softCooldownMs = 5 * 60000, hardCooldownMs = 30 * 60000 } = {}) {
    this.keys = [...new Set(keys.filter(Boolean).map((k) => k.trim()))];
    this.soft = softCooldownMs;
    this.hard = hardCooldownMs;
    this.i = 0;
    this.penalty = new Map(); // key -> usable-not-before ts
  }

  get size() { return this.keys.length; }

  /** Next usable key { key, index } — skips penalized keys; degrades to any key if all are penalized. */
  next() {
    if (!this.keys.length) return null;
    const now = Date.now();
    for (let n = 0; n < this.keys.length; n++) {
      const idx = (this.i + n) % this.keys.length;
      if ((this.penalty.get(this.keys[idx]) || 0) <= now) return { key: this.keys[idx], index: idx };
    }
    const idx = this.i % this.keys.length;
    return { key: this.keys[idx], index: idx };
  }

  fail(index, { hard = false } = {}) {
    const key = this.keys[index];
    if (key) this.penalty.set(key, Date.now() + (hard ? this.hard : this.soft));
    this.i = (index + 1) % this.keys.length;
  }

  ok(index) {
    if (this.keys[index]) this.penalty.delete(this.keys[index]);
    this.i = index;
  }

  status() {
    const now = Date.now();
    return this.keys.map((k, idx) => ({ index: idx, penalizedForSec: Math.max(0, Math.round(((this.penalty.get(k) || 0) - now) / 1000)) }));
  }
}

function loadKeysFor(prefix, env = process.env) {
  const list = [];
  for (let n = 1; n <= 16; n++) {
    const v = env[prefix + '_KEY_' + n];
    if (v && v.trim()) list.push(v.trim());
  }
  return list;
}

function loadKeys(env = process.env) {
  return loadKeysFor('OPENROUTER', env);
}

/** Which canonical slots (1..3) are empty — boot preflight reports these by name. */
function missingSlots(env = process.env, need = 3) {
  const missing = [];
  for (let n = 1; n <= need; n++) if (!env['OPENROUTER_KEY_' + n] || !env['OPENROUTER_KEY_' + n].trim()) missing.push('OPENROUTER_KEY_' + n);
  return missing;
}

/* v1.1.0 multi-brain: sanctioned providers, .env-only slots each (same policy
   as OPENROUTER_KEY_n: no Settings-UI keys, no aliases, count-only surfaces).
   The gate refuses ONLY a cloud with nothing; a partial OpenRouter rotation
   starts with a loud warning (overflow providers carry the fallback). */
const PROVIDERS = { openrouter: 'OPENROUTER', groq: 'GROQ', gemini: 'GEMINI' };

function providerCounts(env = process.env) {
  const c = {};
  for (const [p, prefix] of Object.entries(PROVIDERS)) c[p] = loadKeysFor(prefix, env).length;
  return c;
}

function bootGate(env = process.env, need = 3) {
  const counts = providerCounts(env);
  const total = counts.openrouter + counts.groq + counts.gemini;
  return { counts, missing: missingSlots(env, need), anyCloud: total > 0 };
}

/**
 * Effective key list: .env ONLY (v1.0.7). The settingsData argument is kept for
 * call-site compatibility but is deliberately ignored — the Settings UI no
 * longer holds keys (hub/keymigrate.js folded them into .env at boot).
 */
function effectiveKeys(settingsData, env = process.env) {
  return loadKeys(env);
}

module.exports = { KeyRing, loadKeys, loadKeysFor, effectiveKeys, missingSlots, providerCounts, bootGate, PROVIDERS };
