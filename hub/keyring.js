'use strict';
/**
 * API key ring — round-robin with per-key cooldown.
 *
 * JARVIS POLICY (v1.0.7): keys come EXCLUSIVELY from .env as
 * OPENROUTER_KEY_1, OPENROUTER_KEY_2, OPENROUTER_KEY_3 (…up to _16, gap-tolerant).
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

function loadKeys(env = process.env) {
  const list = [];
  for (let n = 1; n <= 16; n++) {
    const v = env['OPENROUTER_KEY_' + n];
    if (v && v.trim()) list.push(v.trim());
  }
  return list;
}

function loadGroqKeys(env = process.env) {
  const list = [];
  for (let n = 1; n <= 16; n++) {
    const v = env['GROQ_API_KEY_' + n] || (n === 1 ? env['GROQ_API_KEY'] : '');
    if (v && v.trim()) list.push(v.trim());
  }
  return list;
}

function loadGeminiKeys(env = process.env) {
  const list = [];
  for (let n = 1; n <= 16; n++) {
    const v = env['GEMINI_KEY_' + n] || env['GEMINI_API_KEY_' + n] || (n === 1 ? env['GEMINI_API_KEY'] || env['GOOGLE_API_KEY'] : '');
    if (v && v.trim()) list.push(v.trim());
  }
  return list;
}

/** Which canonical slots (1..3) are empty — boot preflight reports these by name. */
function missingSlots(env = process.env, need = 3) {
  const missing = [];
  for (let n = 1; n <= need; n++) if (!env['OPENROUTER_KEY_' + n] || !env['OPENROUTER_KEY_' + n].trim()) missing.push('OPENROUTER_KEY_' + n);
  return missing;
}

/**
 * Effective key list: .env + settings store (new UI). Settings keys are merged in,
 * .env remains primary source. This allows the Settings page to manage keys while
 * keeping .env as fallback.
 */
function effectiveKeys(settingsData, env = process.env) {
  const fromEnv = loadKeys(env);
  const fromSettings = [];
  try {
    if (settingsData) {
      const s = settingsData;
      // openrouter.keys array
      if (s.openrouter && Array.isArray(s.openrouter.keys)) {
        for (const k of s.openrouter.keys) if (k && typeof k === 'string' && k.trim() && !k.includes('•')) fromSettings.push(k.trim());
      }
      if (s.providers && s.providers.openrouter && Array.isArray(s.providers.openrouter.keys)) {
        for (const k of s.providers.openrouter.keys) if (k && typeof k === 'string' && k.trim() && !k.includes('•')) fromSettings.push(k.trim());
      }
    }
  } catch {}
  // dedupe, env first
  return [...new Set([...fromEnv, ...fromSettings])];
}

function effectiveGroqKeys(settingsData, env = process.env) {
  const fromEnv = loadGroqKeys(env);
  const fromSettings = [];
  try {
    if (settingsData) {
      const s = settingsData;
      if (s.groq && Array.isArray(s.groq.keys)) {
        for (const k of s.groq.keys) if (k && typeof k === 'string' && k.trim() && !k.includes('•')) fromSettings.push(k.trim());
      }
      if (s.providers && s.providers.groq && Array.isArray(s.providers.groq.keys)) {
        for (const k of s.providers.groq.keys) if (k && typeof k === 'string' && k.trim() && !k.includes('•')) fromSettings.push(k.trim());
      }
    }
  } catch {}
  return [...new Set([...fromEnv, ...fromSettings])];
}

function effectiveGeminiKeys(settingsData, env = process.env) {
  const fromEnv = loadGeminiKeys(env);
  const fromSettings = [];
  try {
    if (settingsData) {
      const s = settingsData;
      if (s.gemini && Array.isArray(s.gemini.keys)) {
        for (const k of s.gemini.keys) if (k && typeof k === 'string' && k.trim() && !k.includes('•')) fromSettings.push(k.trim());
      }
      if (s.providers && s.providers.gemini && Array.isArray(s.providers.gemini.keys)) {
        for (const k of s.providers.gemini.keys) if (k && typeof k === 'string' && k.trim() && !k.includes('•')) fromSettings.push(k.trim());
      }
    }
  } catch {}
  return [...new Set([...fromEnv, ...fromSettings])];
}

module.exports = { KeyRing, loadKeys, loadGroqKeys, loadGeminiKeys, effectiveKeys, effectiveGroqKeys: effectiveGroqKeys, effectiveGeminiKeys, missingSlots };
