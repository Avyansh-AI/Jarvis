'use strict';
/**
 * Model ladder & router — automatic best-model selection with confirm-before-degrade.
 *
 * The ladder comes from .env `MODEL_PRIORITY` (comma list, best → worst):
 *   MODEL_PRIORITY=google/gemini-2.5-pro, anthropic/claude-sonnet-4-5, openai/gpt-4o-mini, ollama:llama3.1
 * Any OpenRouter-accessible model id is a cloud rung (Gemini ids included — there is
 * no separate Gemini provider; gemini-* models are reached THROUGH OpenRouter, same
 * keys, same rotation). Entries prefixed `ollama:`/`local:` are the local rung.
 * Unset → backward-compatible default: [configured OPENROUTER_MODEL/settings model,
 * then the local Ollama rung].
 *
 * Rules implemented here (see the brief):
 *  1. Startup & per-session, the best AVAILABLE rung is used automatically.
 *  2. Dropping to a lower CLOUD rung is never silent: the owner is asked once per
 *     outage ("X isn't available — switch to Y (lower capability), or wait/retry?"),
 *     the choice is remembered for the whole outage/session, and an upgrade back is
 *     offered when the better model returns.
 *  3. OpenRouter 3-key rotation inside a rung stays fully automatic (hub/keyring.js).
 *  4. Total cloud outage → local Ollama fallback is automatic WITH a plain
 *     announcement (the brief's item 3) — this module only decides; the
 *     orchestrator announces and routes.
 *
 * Session-scoped choices live on the user's session object (RAM-only, reaped with
 * it — nothing about an outage becomes a permanent preference).
 */

const MAX_RUNGS = 8;
const DOWN_MS = 120e3;          // a failed rung is re-probed after 2 min, not every message

function parsePriority(envValue, { cloudModel, ollamaModel }) {
  const rungs = [];
  const ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._/:+-]*$/; // model ids never contain spaces/?/&
  const push = (id, provider) => {
    id = String(id || '').trim();
    if (!id || !ID_SHAPE.test(id.replace(/^ollama:/, provider === 'ollama' ? '' : 'x')) ) return;
    if (provider === 'openrouter' && !ID_SHAPE.test(id)) return;
    if (rungs.length >= MAX_RUNGS || rungs.some((r) => r.id === id)) return;
    rungs.push({ id, provider, tier: rungs.length, label: labelOf(id, provider) });
  };
  const raw = String(envValue || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!raw.length) {
    push(cloudModel, 'openrouter');
    push('ollama:' + ollamaModel, 'ollama');
    return rungs;
  }
  for (const e of raw) {
    const m = /^(ollama|local)\s*:\s*(.+)$/i.exec(e);
    if (m) push('ollama:' + m[2].trim(), 'ollama');
    else push(e, 'openrouter');
  }
  if (!rungs.some((r) => r.provider === 'ollama')) push('ollama:' + ollamaModel, 'ollama'); // local rung always exists as the floor
  return rungs;
}

function labelOf(id, provider) {
  if (provider === 'ollama') return 'local ' + String(id).replace(/^ollama:/, '').split('/').pop();
  return String(id).split('/').pop();
}

class ModelRouter {
  /**
   * @param {object} deps
   *  env       process.env-like (MODEL_PRIORITY, OPENROUTER_MODEL)
   *  settings  settings facade (settings.data.openrouter.model, .security.model)
   *  ollama    Ollama client (ping/url/model)
   *  net       { online }
   *  keyCount  () => number of usable OpenRouter keys (rotation ring size)
   *  audit/log sinks (optional), now injectable
   */
  constructor({ env, settings, ollama, net, keyCount, audit, log, now } = {}) {
    this.env = env || {};
    this.settings = settings || { data: {} };
    this.ollama = ollama || null;
    this.net = net || { online: true };
    this.keyCount = keyCount || (() => 0);
    this.audit = audit || { write() {} };
    this.log = log || { write() {} };
    this.now = now || Date.now;
    this._down = {}; // rungId -> { since, until, reason }
  }

  ladder() {
    const s = this.settings.data || {};
    return parsePriority(this.env.MODEL_PRIORITY, {
      cloudModel: (s.openrouter && s.openrouter.model) || this.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4-5',
      ollamaModel: (s.security && s.security.model) || this.env.OLLAMA_MODEL || 'local-model',
    });
  }

  downState(id) { return this._down[id] || null; }
  isDown(id) { const d = this._down[id]; return !!(d && d.until > this.now()); }

  markFail(id, reason) {
    const t = this.now();
    this._down[id] = { since: t, until: t + DOWN_MS, reason: String(reason || 'failed').slice(0, 160) };
    this.log.write('model.rung.down', { rung: id, reason: this._down[id].reason });
  }
  markOk(id) {
    if (this._down[id]) this.log.write('model.rung.up', { rung: id });
    delete this._down[id];
  }

  /** Cloud rungs in ladder order. A rung is usable when the ring has keys, the hub is online, and it isn't in a down window. */
  cloudState() {
    const keys = this.keyCount() > 0;
    const online = !!this.net.online;
    return this.ladder().filter((r) => r.provider === 'openrouter').map((r) => ({
      ...r,
      usable: keys && online && !this.isDown(r.id),
      down: this.downState(r.id),
      blockedBy: !keys ? 'no-keys' : !online ? 'offline' : this.isDown(r.id) ? 'down' : null,
    }));
  }

  localRung() {
    return this.ladder().find((r) => r.provider === 'ollama') || null;
  }

  /** The best currently-usable cloud rung (or null). Local availability is the caller's probe. */
  bestCloud() {
    return this.cloudState().find((r) => r.usable) || null;
  }

  /** A stable identity for the current outage of the TOP cloud rung — what "one confirmation per outage" keys off. */
  outageId() {
    const top = this.cloudState()[0];
    if (!top) return null;
    const d = this.downState(top.id);
    return d && this.isDown(top.id) ? `outage:${top.id}:${d.since}` : null;
  }

  /** Is moving from `from` to `to` a capability downgrade that needs explicit consent? */
  needsDegradeConfirm(fromId, toId) {
    const lad = this.ladder();
    const from = lad.find((r) => r.id === fromId);
    const to = lad.find((r) => r.id === toId);
    if (!from || !to) return false;
    return from.provider === 'openrouter' && to.provider === 'openrouter' && to.tier > from.tier;
  }

  status(sess) {
    return {
      ladder: this.ladder().map((r) => ({ ...r, down: this.downState(r.id) })),
      cloud: this.cloudState().map((r) => ({ id: r.id, usable: r.usable, blockedBy: r.blockedBy })),
      keys: this.keyCount(),
      online: !!this.net.online,
      session: sess ? { localRoute: sess.localRoute || null, degrade: sess.degrade || null } : null,
    };
  }
}

module.exports = { ModelRouter, parsePriority, DOWN_MS };
