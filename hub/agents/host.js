'use strict';
/**
 * Host Agent — gpt-oss-120b via OpenRouter
 *
 * Primary brain for Jarvis. Uses the existing OpenRouter 3-key rotation
 * (KeyRing) and the same chat/completions path as the legacy orchestrator,
 * but wrapped as an explicit agent with health checks and a stable identity
 * for the multi-agent map.
 */

const { KeyRing, effectiveKeys } = require('../keyring');
const { http } = require('../net');
const { AGENT_MAP } = require('../config/agents');

const DEFAULT_MODEL = 'openai/gpt-oss-120b';

class HostAgent {
  constructor({ settings, log } = {}) {
    this.id = 'host';
    this.label = 'Host';
    this.model = process.env.HOST_MODEL || (settings && settings.data.openrouter && settings.data.openrouter.model) || process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
    this.provider = 'openrouter';
    this.settings = settings;
    this.log = log || { write() {} };
    this._ring = null;
    this._sig = null;
    this._lastOk = 0;
    this._lastFail = null;
  }

  _ringInstance() {
    const eff = effectiveKeys(this.settings ? this.settings.data : {});
    const sig = eff.join('|');
    if (!this._ring || this._sig !== sig) {
      this._ring = new KeyRing(eff);
      this._sig = sig;
    }
    return this._ring;
  }

  isConfigured() {
    return this._ringInstance().size > 0;
  }

  async health() {
    const ring = this._ringInstance();
    return {
      id: this.id,
      label: this.label,
      model: this.model,
      provider: this.provider,
      configured: ring.size > 0,
      keys: ring.size,
      lastOk: this._lastOk || null,
      lastFail: this._lastFail,
      status: ring.size === 0 ? 'no-keys' : this._lastFail && Date.now() - this._lastFail.at < 60000 ? 'degraded' : 'ok',
    };
  }

  async chat({ messages, tools, max_tokens = 600 }) {
    const ring = this._ringInstance();
    if (ring.size === 0) throw new Error('Host agent has no OpenRouter keys (OPENROUTER_KEY_1..3)');

    const base = (process.env.OPENROUTER_BASE || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
    const body = {
      model: this.model,
      max_tokens,
      messages,
    };
    if (tools && tools.length) {
      body.tools = tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      }));
      body.tool_choice = 'auto';
    }

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
            'x-title': process.env.OPENROUTER_TITLE || 'Jarvis',
          },
          body: JSON.stringify(body),
        }, 45000);
        if (res.ok) {
          ring.ok(pick.index);
          this._lastOk = Date.now();
          this._lastFail = null;
          const data = await res.json();
          const msg = data.choices && data.choices[0] && data.choices[0].message;
          if (!msg) throw new Error('no message');
          return { message: msg, raw: data, keyIndex: pick.index };
        }
        const status = res.status;
        lastErr = new Error('OpenRouter HTTP ' + status);
        lastErr.status = status;
        if (status === 401 || status === 402 || status === 403) {
          ring.fail(pick.index, { hard: true });
          this.log.write('llm.key.fail', { agent: this.id, key: pick.index, status });
        } else if (status === 429 || status >= 500) {
          ring.fail(pick.index, {});
          this.log.write('llm.key.fail', { agent: this.id, key: pick.index, status });
        } else {
          throw lastErr;
        }
        this._lastFail = { at: Date.now(), status, key: pick.index };
      } catch (e) {
        if (e.status) {
          lastErr = e;
        } else {
          const pick2 = ring.next ? null : null; // keep shape
          ring.fail(pick.index, {});
          lastErr = e;
          this._lastFail = { at: Date.now(), reason: e.message };
        }
      }
    }
    throw lastErr;
  }
}

module.exports = { HostAgent, DEFAULT_MODEL };
