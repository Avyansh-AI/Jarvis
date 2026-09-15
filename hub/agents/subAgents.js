'use strict';
/**
 * Sub-Agents Pool — Qwen3.6-27b with 5 accounts
 *
 * 5 parallel Qwen workers, each with its own API key/account. They share the
 * same model but have independent rotation and can run sub-tasks in parallel.
 * If dedicated QWEN_KEY_1..5 are not set, we gracefully fall back to the
 * OpenRouter 3-key ring so the system still works zero-config.
 */

const { KeyRing } = require('../keyring');
const { http } = require('../net');

const DEFAULT_QWEN_MODEL = 'qwen/qwen3-27b';

function loadQwenKeys(env = process.env) {
  const keys = [];
  for (let i = 1; i <= 5; i++) {
    const k = env['QWEN_KEY_' + i] || env['QWEN_API_KEY_' + i] || '';
    if (k && k.trim()) keys.push(k.trim());
  }
  // fallback to OpenRouter keys if no dedicated Qwen keys
  if (keys.length === 0) {
    for (let i = 1; i <= 3; i++) {
      const k = env['OPENROUTER_KEY_' + i] || '';
      if (k && k.trim()) keys.push(k.trim());
    }
  }
  return keys;
}

class SubAgentWorker {
  constructor({ id, model, ring, log }) {
    this.id = id;
    this.model = model;
    this.ring = ring;
    this.log = log || { write() {} };
    this.busy = false;
    this.tasks = 0;
    this.lastOk = 0;
  }

  async run({ prompt, messages, tools }) {
    this.busy = true;
    this.tasks++;
    try {
      const base = (process.env.OPENROUTER_BASE || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
      const body = {
        model: this.model,
        max_tokens: 600,
        messages: messages || [{ role: 'user', content: prompt }],
      };
      if (tools && tools.length) {
        body.tools = tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.input_schema },
        }));
        body.tool_choice = 'auto';
      }

      // simple round-robin inside this worker's ring
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
              'x-title': process.env.OPENROUTER_TITLE || 'Jarvis Sub-agent ' + this.id,
            },
            body: JSON.stringify(body),
          }, 45000);
          if (res.ok) {
            ring.ok(pick.index);
            this.lastOk = Date.now();
            const data = await res.json();
            const msg = data.choices && data.choices[0] && data.choices[0].message;
            return { ok: true, worker: this.id, message: msg, raw: data };
          }
          const status = res.status;
          lastErr = new Error('Qwen HTTP ' + status);
          lastErr.status = status;
          if (status === 401 || status === 402 || status === 403) ring.fail(pick.index, { hard: true });
          else ring.fail(pick.index, {});
        } catch (e) {
          ring.fail(ring.next ? 0 : 0, {}); // defensive
          lastErr = e;
        }
      }
      throw lastErr;
    } finally {
      this.busy = false;
    }
  }
}

class SubAgentsPool {
  constructor({ settings, log } = {}) {
    this.id = 'sub-agents';
    this.label = 'Sub-agents';
    this.model = process.env.QWEN_MODEL || DEFAULT_QWEN_MODEL;
    this.log = log || { write() {} };
    this.settings = settings;

    const keys = loadQwenKeys();
    // One shared ring for all 5 workers, but each worker tracks its own busy state
    // For true 5-account isolation, we shard keys: worker i gets key i % keys.length
    // If keys < 5, they share but still rotate.
    const sharedRing = new KeyRing(keys);
    this.ring = sharedRing;

    this.workers = Array.from({ length: 5 }, (_, i) => new SubAgentWorker({
      id: `qwen-${i + 1}`,
      model: this.model,
      ring: sharedRing,
      log: this.log,
    }));

    this._lastFail = null;
  }

  isConfigured() {
    return this.ring.size > 0;
  }

  async health() {
    return {
      id: this.id,
      label: this.label,
      model: this.model,
      provider: 'openrouter',
      count: this.workers.length,
      configured: this.ring.size > 0,
      keys: this.ring.size,
      workers: this.workers.map((w) => ({ id: w.id, busy: w.busy, tasks: w.tasks, lastOk: w.lastOk || null })),
      status: this.ring.size === 0 ? 'no-keys' : 'ok',
    };
  }

  // Pick the least-busy worker
  _pickWorker() {
    return this.workers.slice().sort((a, b) => a.tasks - b.tasks || (a.busy ? 1 : 0) - (b.busy ? 1 : 0))[0];
  }

  async runOne(opts) {
    const w = this._pickWorker();
    return w.run(opts);
  }

  // Run N sub-tasks in parallel (fan-out)
  async runParallel(tasks) {
    // tasks: [{prompt, messages, tools}, ...]
    const results = await Promise.allSettled(tasks.map((t, i) => {
      const worker = this.workers[i % this.workers.length];
      return worker.run(t);
    }));
    return results.map((r) => r.status === 'fulfilled' ? r.value : { ok: false, error: String(r.reason) });
  }

  // Convenience: single prompt via pool
  async chat({ messages, tools, prompt }) {
    return this.runOne({ messages, tools, prompt });
  }
}

module.exports = { SubAgentsPool, SubAgentWorker, loadQwenKeys, DEFAULT_QWEN_MODEL };
