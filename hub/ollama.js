'use strict';
/**
 * Ollama — the local, fully-offline uncensored brain used in hacking mode
 * (and whenever privacy.llm === 'local').
 *
 * - ping():          is Ollama reachable?
 * - hasModel():      is the configured model pulled yet?
 * - pull():          background NDJSON pull with live progress state
 * - chat():          native /api/chat WITH tool support (stream: false)
 * - statusLive():    { state: down | starting | pulling | error | ready } — kick starts a pull
 *
 * No work happens at require time; the singleton is constructed by the
 * Orchestrator with lazy url/model getters.
 */
const httpNode = require('http');
const httpsNode = require('https');
const { http } = require('./net');

const DEFAULT_MODEL = 'hf.co/huihui-ai/Huihui-Qwythos-9B-Claude-Mythos-5-1M-abliterated-GGUF:Q4_K_M';
const DEFAULT_URL = 'http://127.0.0.1:11434';

class Ollama {
  /** @param {{url: () => string, model: () => string}} getters */
  constructor({ url, model } = {}) {
    this._url = url || (() => process.env.OLLAMA_URL || DEFAULT_URL);
    this._model = model || (() => process.env.OLLAMA_MODEL || DEFAULT_MODEL);
    this._tags = null;       // cached /api/tags names from last ping
    this._lastPing = 0;
    this._reachable = false;
    this.pullState = { active: false, done: 0, total: 0, status: '', error: null, finishedAt: 0, startedAt: 0 };
  }

  url() { return String(this._url() || DEFAULT_URL).replace(/\/+$/, ''); }
  model() { return String(this._model() || DEFAULT_MODEL); }

  async ping() {
    try {
      const res = await http(this.url() + '/api/tags', {}, 1500);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json().catch(() => ({}));
      this._tags = (data.models || []).map((m) => m.name || '');
      this._reachable = true;
    } catch {
      this._reachable = false;
      this._tags = null;
    }
    this._lastPing = Date.now();
    return this._reachable;
  }

  /** Any local tag of the same base name counts (different quant is fine). */
  hasModel(tags) {
    const list = tags || this._tags || [];
    const want = this.model();
    const base = want.split(':')[0];
    return list.some((n) => n === want || n === want + ':latest' || (base && n.split(':')[0] === base));
  }

  /** Kick off a background pull (idempotent while one is active). */
  pull() {
    const ps = this.pullState;
    if (ps.active) return ps;
    Object.assign(ps, { active: true, done: 0, total: 0, status: 'starting', error: null, startedAt: Date.now(), finishedAt: 0 });
    let u;
    try { u = new URL(this.url() + '/api/pull'); } catch (e) { ps.active = false; ps.error = e.message; ps.finishedAt = Date.now(); return ps; }
    const lib = u.protocol === 'https:' ? httpsNode : httpNode;
    let req;
    try {
      req = lib.request(u, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
        res.setEncoding('utf8');
        let buf = '';
        res.on('data', (d) => {
          buf += d;
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1);
            if (!line.trim()) continue;
            try {
              const j = JSON.parse(line);
              if (j.status) ps.status = j.status;
              if (j.completed) ps.done = j.completed;
              if (j.total) ps.total = j.total;
              if (j.error) ps.error = String(j.error);
            } catch { /* partial json line */ }
          }
        });
        res.on('end', () => {
          ps.active = false;
          ps.finishedAt = Date.now();
          if (res.statusCode !== 200 && !ps.error) ps.error = 'pull HTTP ' + res.statusCode;
          if (res.statusCode === 200 && !ps.error) this._tags = null; // force re-probe
        });
      });
      req.on('error', (e) => { ps.active = false; ps.error = e.message; ps.finishedAt = Date.now(); });
      req.write(JSON.stringify({ name: this.model(), stream: true }));
      req.end();
    } catch (e) {
      ps.active = false; ps.error = e.message; ps.finishedAt = Date.now();
    }
    return ps;
  }

  pct() {
    const ps = this.pullState;
    if (!ps.total) return null;
    return Math.min(100, Math.round((ps.done / ps.total) * 100));
  }

  /**
   * Probe Ollama and report coarse state; with kick=true a missing model
   * starts pulling in the background.
   */
  async statusLive({ kick = false } = {}) {
    const model = this.model(), url = this.url();
    if (!(await this.ping())) return { state: 'down', url, model, reachable: false, pulling: false, pct: null, error: null };
    if (this.hasModel()) return { state: 'ready', url, model, reachable: true, pulling: false, pct: 100, error: null };
    const ps = this.pullState;
    if (ps.active) {
      return { state: 'pulling', url, model, reachable: true, pulling: true, pct: this.pct(), done: ps.done, total: ps.total, status: ps.status, error: null };
    }
    if (ps.error && Date.now() - ps.finishedAt < 120000) {
      return { state: 'error', url, model, reachable: true, pulling: false, pct: null, error: ps.error };
    }
    if (kick) {
      this.pull();
      return { state: 'starting', url, model, reachable: true, pulling: true, pct: 0, status: 'starting', error: null };
    }
    return { state: 'missing', url, model, reachable: true, pulling: false, pct: null, error: null };
  }

  /** Plain async text/tool chat. Returns Ollama's message object. */
  async chat(messages, tools) {
    const body = { model: this.model(), messages, stream: false, options: { num_predict: 700 } };
    if (tools && tools.length) body.tools = tools;
    const res = await http(this.url() + '/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, 120000);
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error('Ollama HTTP ' + res.status + (txt ? ': ' + txt.slice(0, 160) : ''));
    }
    const data = await res.json();
    return data.message || { role: 'assistant', content: data.response || '' };
  }
}

module.exports = { Ollama, DEFAULT_MODEL, DEFAULT_URL };
