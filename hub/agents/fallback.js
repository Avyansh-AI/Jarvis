'use strict';
/**
 * Fallback Agent — Gemini with 3-key overflow
 *
 * Safety net when Host and Sub-agents are down. Uses Gemini models via
 * OpenRouter (or direct Google API if configured). Implements 3-key overflow:
 *   GEMINI_KEY_1, GEMINI_KEY_2, GEMINI_KEY_3
 * If those are empty, overflows to OPENROUTER_KEY_1..3 so the system still
 * works without extra config.
 *
 * Models: google/gemini-2.0-flash-001 (default), alt: gemini-2.5-pro, gemini-pro
 */

const { KeyRing } = require('../keyring');
const { http } = require('../net');

const DEFAULT_GEMINI_MODEL = 'google/gemini-2.0-flash-001';

function loadGeminiKeys(env = process.env) {
  const keys = [];
  for (let i = 1; i <= 3; i++) {
    const k = env['GEMINI_KEY_' + i] || env['GEMINI_API_KEY_' + i] || '';
    if (k && k.trim()) keys.push(k.trim());
  }
  if (keys.length === 0) {
    for (let i = 1; i <= 3; i++) {
      const k = env['OPENROUTER_KEY_' + i] || '';
      if (k && k.trim()) keys.push(k.trim());
    }
  }
  return keys;
}

class FallbackAgent {
  constructor({ settings, log } = {}) {
    this.id = 'fallback';
    this.label = 'Fallback';
    this.model = process.env.FALLBACK_MODEL || process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
    this.provider = process.env.GEMINI_API_URL ? 'google-direct' : 'openrouter';
    this.log = log || { write() {} };
    this.settings = settings;
    const keys = loadGeminiKeys();
    this.ring = new KeyRing(keys);
    this._lastFail = null;
    this._lastOk = 0;
  }

  isConfigured() {
    return this.ring.size > 0;
  }

  async health() {
    return {
      id: this.id,
      label: this.label,
      model: this.model,
      provider: this.provider,
      configured: this.ring.size > 0,
      keys: this.ring.size,
      lastOk: this._lastOk || null,
      lastFail: this._lastFail,
      status: this.ring.size === 0 ? 'no-keys' : this._lastFail && Date.now() - this._lastFail.at < 60000 ? 'degraded' : 'ok',
      overflow: true,
    };
  }

  async chat({ messages, max_tokens = 500 }) {
    if (this.ring.size === 0) throw new Error('Fallback has no keys (GEMINI_KEY_1..3 or OPENROUTER_KEY_1..3)');

    // If direct Google API is configured, use it; else OpenRouter
    if (process.env.GEMINI_API_URL || process.env.GOOGLE_API_KEY) {
      return this._chatGoogleDirect({ messages, max_tokens });
    }
    return this._chatOpenRouter({ messages, max_tokens });
  }

  async _chatOpenRouter({ messages, max_tokens }) {
    const base = (process.env.OPENROUTER_BASE || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
    const body = {
      model: this.model,
      max_tokens,
      messages,
    };
    const ring = this.ring;
    const attempts = Math.max(1, ring.size);
    let lastErr = new Error('no keys');
    for (let i = 0; i < attempts; i++) {
      const pick = ring.next();
      if (!pick) break;
      try {
        const res = await http(base + '/chat/completions', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer ' + pick.key,
            'http-referer': process.env.OPENROUTER_REFERER || 'http://localhost:8080',
            'x-title': process.env.OPENROUTER_TITLE || 'Jarvis Fallback',
          },
          body: JSON.stringify(body),
        }, 45000);
        if (res.ok) {
          ring.ok(pick.index);
          this._lastOk = Date.now();
          this._lastFail = null;
          const data = await res.json();
          const msg = data.choices && data.choices[0] && data.choices[0].message;
          return { message: msg, raw: data, via: 'openrouter', keyIndex: pick.index };
        }
        const status = res.status;
        lastErr = new Error('Gemini (OpenRouter) HTTP ' + status);
        lastErr.status = status;
        if (status === 401 || status === 402 || status === 403) ring.fail(pick.index, { hard: true });
        else ring.fail(pick.index, {});
        this._lastFail = { at: Date.now(), status, key: pick.index };
      } catch (e) {
        lastErr = e;
        this._lastFail = { at: Date.now(), reason: e.message };
      }
    }
    throw lastErr;
  }

  async _chatGoogleDirect({ messages, max_tokens }) {
    // Direct Google Generative AI API (optional path)
    const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || '';
    const url = (process.env.GEMINI_API_URL || 'https://generativelanguage.googleapis.com/v1beta/models/' + this.model + ':generateContent') + '?key=' + apiKey;
    const contents = messages.filter((m) => m.role !== 'system').map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content || '') }],
    }));
    const system = messages.find((m) => m.role === 'system');
    const body = {
      contents,
      generationConfig: { maxOutputTokens: max_tokens },
    };
    if (system) body.systemInstruction = { parts: [{ text: system.content }] };

    const res = await http(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, 45000);
    if (!res.ok) throw new Error('Google Gemini HTTP ' + res.status);
    const data = await res.json();
    const text = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
    return { message: { role: 'assistant', content: text || '' }, raw: data, via: 'google-direct' };
  }
}

module.exports = { FallbackAgent, loadGeminiKeys, DEFAULT_GEMINI_MODEL };
