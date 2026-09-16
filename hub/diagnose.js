'use strict';
/**
 * Diagnostician — the single failure-intake point for the whole hub.
 *
 * Every skill/tool/brain routes failures through report() instead of inventing
 * its own error words. The result is a concrete, user-presentable diagnosis:
 *   what broke · likely cause · what is being done about it automatically
 *   (retrying / rotating keys / clamping credit / falling back) — or exactly
 *   what the OWNER needs to do ("your GitHub token looks expired — update it
 *   in .env").
 *
 * Every diagnosed issue lands in the tamper-evident audit log. Recurring
 * INFRASTRUCTURE problems (keys, providers, local brain, integrations — never
 * personal preferences, never the learning layer) are remembered in an
 * encrypted device-level store; when a pattern crosses the recurrence
 * threshold the diagnosis says so out loud instead of rediscovering it daily.
 *
 * This is a transparency layer: it observes and explains. It changes no
 * behavior of sandboxing, confirmation gates, or key rotation — it only
 * names what those systems are already doing.
 */

/** Ordered classifier. First match wins. Keep rules deterministic and boring. */
const RX = {
  net: /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|fetch failed|network|socket hang up|timed out/i,
  http: /http (\d{3})/i,
};

/* Secret shapes that must NEVER reach a user-facing line, an event-log entry, or
   an audit record. Prefix + separators keep prose safe ("skipping a beat", model
   ids like hf.co/… stay readable); the same pattern lives in eventlog.js/audit.js.
   R-06 fix: before this, the generic rule echoed err.message RAW into the chat
   line — an upstream error quoting a key (github_pat_…, sk-or-v1-…) was shown
   to the owner verbatim, even though the logs scrubbed it. */
const KEY_RE = /\b(?:sk|pk|xox[bap]|gh[pousr]|github_pat|glpat|dop_v1|hf)[-_][-A-Za-z0-9_]{6,}|\b(?:AIza|ya29)[-A-Za-z0-9_.]{10,}/g;
const scrubText = (s) => String(s == null ? '' : s).replace(KEY_RE, '[key-redacted]');

function statusOf(err) {
  if (err && typeof err.status === 'number') return err.status;
  const m = RX.http.exec(String((err && err.message) || ''));
  return m ? parseInt(m[1], 10) : 0;
}

const RULES = [
  {
    key: 'openrouter.credit',
    when: (e, sc) => sc === 'openrouter' && (statusOf(e) === 402 || (e && e.tokenLimit)),
    dx: () => ({
      what: 'the OpenRouter account is out of usable credit',
      cause: 'free-tier or credit cap — the provider says exactly how much fits and this request did not',
      action: { kind: 'auto', detail: 'replying in the lean credit window (smaller prompt, clamped tokens) — no action lost' },
      userFix: 'add credit at openrouter.ai/settings/credits, or set a smaller/free model (OPENROUTER_MODEL in .env)',
    }),
  },
  {
    key: 'openrouter.auth',
    when: (e, sc) => sc === 'openrouter' && [401, 403].includes(statusOf(e)),
    dx: () => ({
      what: 'OpenRouter rejected a rotation key',
      cause: 'the key is invalid, expired, or revoked',
      action: { kind: 'rotate', detail: 'rotated to the next key automatically' },
      userFix: 'if all keys fail: check OPENROUTER_KEY_1/2/3 in .env on the hub',
    }),
  },
  {
    key: 'openrouter.ratelimit',
    when: (e, sc) => sc === 'openrouter' && statusOf(e) === 429,
    dx: () => ({
      what: 'OpenRouter rate-limited a key',
      cause: 'too many requests on this key right now',
      action: { kind: 'rotate', detail: 'rotated keys and retried automatically' },
      userFix: null,
    }),
  },
  {
    key: 'openrouter.model',
    when: (e, sc) => sc === 'openrouter' && statusOf(e) === 404,
    dx: () => ({
      what: 'the configured cloud model is gone',
      cause: 'that model id was removed or renamed on OpenRouter',
      action: { kind: 'user-fix', detail: 'pick a current model id' },
      userFix: 'set OPENROUTER_MODEL (or MODEL_PRIORITY) in .env to a live model id',
    }),
  },
  {
    key: 'openrouter.outage',
    when: (e, sc) => sc === 'openrouter' && statusOf(e) >= 500,
    dx: () => ({
      what: 'OpenRouter is having an outage',
      cause: 'the provider returned a server error after rotating through every key',
      action: { kind: 'fallback-local', detail: 'switching to the local model on this machine' },
      userFix: null,
    }),
  },
  {
    key: 'openrouter.unreachable',
    when: (e, sc) => sc === 'openrouter' && RX.net.test(String((e && e.message) || '')),
    dx: () => ({
      what: 'OpenRouter is unreachable',
      cause: 'no route to the provider (network down, DNS, or the service is offline)',
      action: { kind: 'fallback-local', detail: 'switching to the local model on this machine' },
      userFix: 'check the hub’s internet connection if this keeps up',
    }),
  },
  {
    key: 'ollama.down',
    when: (e, sc) => sc === 'ollama',
    dx: (e) => ({
      what: 'the local model (Ollama) is not answering',
      cause: /not installed|ENOENT/i.test(String((e && e.reason) || (e && e.message) || '')) ? 'Ollama is not installed on this machine' : 'the Ollama service is not running or the model is not pulled yet',
      action: { kind: 'user-fix', detail: 'local routing cannot start without it' },
      userFix: 'install Ollama from ollama.com and run `ollama serve`, or say "go hacking" for guided setup',
    }),
  },
  {
    key: 'github.auth',
    when: (e, sc) => sc === 'github' && [401, 403].includes(statusOf(e)),
    dx: () => ({
      what: 'GitHub rejected the hub’s token',
      cause: 'your GitHub token looks expired (or the required scope was removed)',
      action: { kind: 'user-fix', detail: 'nothing else will work until it is replaced' },
      userFix: 'update it in .env (GH_TOKEN) and restart the hub',
    }),
  },
  {
    key: 'ha.auth',
    when: (e, sc) => sc === 'home-assistant' && [401, 403].includes(statusOf(e)),
    dx: () => ({
      what: 'Home Assistant rejected the hub’s credentials',
      cause: 'the long-lived token is wrong or expired',
      action: { kind: 'user-fix', detail: 'smart-home actions stay off until fixed' },
      userFix: 'set HA_TOKEN (and HA_URL) in .env and restart the hub',
    }),
  },
  {
    key: 'ha.unreachable',
    when: (e, sc) => sc === 'home-assistant' && RX.net.test(String((e && e.message) || '')),
    dx: () => ({
      what: 'the smart-home hub is unreachable',
      cause: 'Home Assistant is off, on another address, or the network dropped',
      action: { kind: 'retry', detail: 'will work again as soon as the hub is back' },
      userFix: 'check that Home Assistant is running and HA_URL in .env is right',
    }),
  },
  {
    key: 'net.service',
    when: (e, sc) => RX.net.test(String((e && e.message) || '')),
    dx: (e, sc) => ({
      what: `the ${sc} service could not be reached`,
      cause: 'the network connection dropped or the service is down',
      action: { kind: 'retry', detail: 'transient failures are retried automatically' },
      userFix: null,
    }),
  },
];

const RECUR_MIN = 3;               // failures of the same kind before it is a remembered pattern
const RECUR_WINDOW_MS = 7 * 86400e3;

class Diagnostician {
  /**
   * @param {object} deps
   *  store  SecureStore('diagnostics') — encrypted, device-level recurrence memory
   *  log    EventLog (operational log)
   *  audit  AuditLog (tamper-evident)
   *  bus    optional event bus
   *  now    injectable clock for tests
   */
  constructor({ store, log, audit, bus, now } = {}) {
    this.store = store || { data: {}, saveSoon() {} };
    this.log = log || { write() {} };
    this.audit = audit || { write() {} };
    this.bus = bus || { emit() {} };
    this.now = now || Date.now;
    if (!this.store.data || typeof this.store.data !== 'object') this.store.data = {};
    if (!this.store.data.issues || typeof this.store.data.issues !== 'object') this.store.data.issues = {};
  }

  classify(err, scope) {
    for (const r of RULES) {
      let hit = false;
      try { hit = r.when(err || {}, scope || 'core'); } catch {}
      if (hit) {
        const d = r.dx(err || {}, scope || 'core');
        return { key: r.key, ...d };
      }
    }
    return {
      key: (scope || 'core') + '.generic',
      what: `${scope || 'that'} failed`,
      cause: scrubText(String((err && err.message) || err || 'unknown error')).slice(0, 160),
      action: { kind: 'none', detail: 'nothing about it is automatic — see logs' },
      userFix: null,
    };
  }

  /**
   * Full intake: classify → audit → recurrence → user-presentable line.
   * Never throws; returns the diagnosis object with a ready `line`.
   */
  report(scope, err, { user = null, note = null } = {}) {
    let dx;
    try { dx = this.classify(err, scope); } catch (e) { dx = this.classify(e, 'diagnose'); }
    const ts = this.now();
    let rec = this.store.data.issues[dx.key];
    if (!rec || ts - rec.first > RECUR_WINDOW_MS) rec = { count: 0, first: ts };
    rec.count++; rec.last = ts; rec.scope = scope;
    this.store.data.issues[dx.key] = rec;
    try {
      const keys = Object.keys(this.store.data.issues);
      if (keys.length > 50) { // bound device memory like everything else
        keys.sort((a, b) => (this.store.data.issues[a].last || 0) - (this.store.data.issues[b].last || 0));
        for (const k of keys.slice(0, keys.length - 50)) delete this.store.data.issues[k];
      }
      this.store.saveSoon && this.store.saveSoon();
    } catch {}
    const remembered = rec.count >= RECUR_MIN;
    try {
      this.log.write('error.diagnosed', { scope, key: dx.key, user: user || undefined, note: note || undefined, count: rec.count });
      this.audit.write('error.diagnosed', {
        scope, key: dx.key, what: dx.what, cause: dx.cause,
        action: dx.action && dx.action.kind, userFix: dx.userFix || undefined,
        user: user || undefined, recurrence: rec.count,
      });
    } catch {}
    const suffix = remembered
      ? ` This is failure #${rec.count} of this kind since ${new Date(rec.first).toDateString()} — I've kept the pattern on record, so I'm not rediscovering it every time.`
      : '';
    // user-facing line: scrubbed — a diagnosis must never be how a secret leaks
    // (rule-based texts are static, but a future rule or a custom err could still smuggle one in)
    const parts = [`${cap(dx.what)} — ${scrubText(dx.cause)}.`];
    if (dx.action && dx.action.kind !== 'none' && dx.action.detail) parts.push(`Handling: ${scrubText(dx.action.detail)}.`);
    if (dx.userFix) parts.push(`To fix it: ${scrubText(dx.userFix)}.`);
    return {
      ...dx, scope, count: rec.count, remembered, firstTs: rec.first,
      line: parts.join(' ') + suffix,
    };
  }

  /** Device-level view for /api/status & diagnostics. */
  knownIssues() {
    const out = [];
    for (const [key, r] of Object.entries(this.store.data.issues || {})) {
      out.push({ key, count: r.count, first: r.first, last: r.last, scope: r.scope, remembered: r.count >= RECUR_MIN });
    }
    return out.sort((a, b) => (b.last || 0) - (a.last || 0));
  }
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

module.exports = { Diagnostician, RECUR_MIN, RECUR_WINDOW_MS, KEY_RE, scrubText };
