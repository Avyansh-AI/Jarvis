'use strict';
/**
 * Adaptive Learning & Personalization Layer (see PERSONALIZATION.md).
 *
 * Local-only, metadata-only learning:
 *   - signals are {ts, user, skill, hour, dow, sentiment} — NEVER raw text.
 *   - every model is a small, inspectable JSON structure (no black boxes).
 *   - models are versioned checkpoints of that JSON (roll back any time).
 *   - drift guardrails everywhere: min-signal thresholds, recent-vs-long-term
 *     baselines, and hard caps on how far anything may drift.
 *   - security-critical logic is OFF-LIMITS here, permanently: the anomaly
 *     detector only FLAGS for review, never blocks or approves; the intent
 *     re-ranker never touches sensitive skills; nothing the learning layer
 *     learns can ever skip an auth/lock/payment confirmation.
 */

const SIGNAL_CAP = 2000;          // bounded ring, mirrors log-bounding rules
const CORRECTION_CAP = 300;
const SUGGESTION_CAP = 50;
const FLAG_CAP = 20;
const ROUTINE_MIN_HITS = 4;       // min-signal threshold before surfacing
const ROUTINE_MIN_WEEKS = 2;      // drift guard: pattern must span weeks
const ROUTINE_BASELINE_MULT = 3;  // drift guard: bucket must be ≥3× the user's mean bucket rate
const TONE_DRIFT_CAP = 0.15;      // adaptive tone may only nudge ±0.15 around the slider
const PREF_STEP = 0.1, PREF_CAP = 1, PREF_DECAY = 0.95, PREF_DECAY_MS = 7 * 86400e3;
const RERANK_MIN = 2;             // corrections needed before re-ranking kicks in
const ANOMALY_MIN_SIGNALS = 100;  // cold-start guard
const ANOMALY_MIN_DAYS = 7;
const ANOMALY_Z = 3;
const CHECKPOINT_EVERY = 100;     // signals between model checkpoints — first auto-checkpoint lands within days of normal use
const MODEL_VERSIONS_KEPT = 3;
const EMERGING_CAP = 8;           // transparency view lists at most this many still-learning patterns
const DEBUG = () => process.env.MAX_DEBUG === '1'; // temporary verbose diagnostics: MAX_DEBUG=1 → learn.debug events (metadata only)
const MODEL_NAMES = ['routines', 'prefs', 'tone', 'rerank', 'anomaly'];

const CORRECTION_RE = /^(?:no[,.!]?\s+)?(?:i meant|i said)\s+(?:the\s+)?(.+?)[.!?]*$/i;
const NOT_RE = /^(?:no[,.!]?\s+)?not\s+(?:the\s+)?(.+?)[.!?]*$/i;
const TOPIC_WORDS = {
  music: /\b(music|song|playlist|spotify|play)\b/i,
  news: /\b(news|headlines|headline)\b/i,
  weather: /\b(weather|rain|forecast|temperature)\b/i,
  coding: /\b(code|coding|bug|commit|repo|deploy|server)\b/i,
  finance: /\b(stock|stocks|crypto|budget|expense|portfolio)\b/i,
  home: /\b(light|lights|thermostat|fan|lock)\b/i,
  health: /\b(sleep|workout|steps|calories|meditation)\b/i,
};

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ')
  .replace(/\b(please|max|turn|switch|set|dim|brighten|play|open|close|on|off|the|to|my|a|an)\b/g, ' ')
  .replace(/\s+/g, ' ').trim().slice(0, 60);
const weekKey = (ts) => { const d = new Date(ts); const onejan = new Date(d.getFullYear(), 0, 1); return d.getFullYear() + '-w' + Math.ceil((((d - onejan) / 86400e3) + onejan.getDay() + 1) / 7); };
const dayKey = (ts) => new Date(ts).toDateString();
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function freshData() {
  return {
    sinceSignals: 0, totalSignals: 0, firstSignalTs: 0,
    signals: [],
    corrections: {}, // user -> [{skill, from, to, n, last}]
    routines: {},    // user -> skill -> bucket -> {n, weeks:{wk:1}}
    prefs: {},       // user -> {topics:{...}, lastDecay}
    tone: {},        // user -> {recent, long, n}
    anomaly: {},     // user -> {buckets:int168, day:{key,count}, stats:{mean,m2,days}, flags:[...]}
    suggestions: [], // {id, kind, user, skill, bucket, hour, dow, n, confidence, state, created, updated}
    stopped: [],     // suggestion ids the user said "stop learning this" about
  };
}

class Learner {
  constructor({ store, modelsStore, settings, log, bus, registry, now }) {
    this.store = store;                 // SecureStore('learning')
    this.registryStore = modelsStore;   // SecureStore('learn-models')
    this.settings = settings;
    this.log = log || { write() {} };
    this.bus = bus || { emit() {}, on() {} };
    this.skills = registry || null;
    this.now = now || Date.now;
    if (!this.store.data || !Array.isArray(this.store.data.signals)) this.store.data = freshData();
    const reg = this.registryStore.data;
    if (!reg.models) reg.models = {};   // name -> {current:v, versions:[{v,created,metrics,blob}]}
  }

  enabled() { return this.settings.data.privacy.learning !== false; }

  /* ---------- pipeline step 1: signal capture (metadata only) ---------- */

  signal({ user = 'default', skill = null, sentiment = 'neutral', text = '', prevResolved = null }) {
    if (!this.enabled()) return null;
    const d = this.store.data;
    const ts = this.now();
    const hour = new Date(ts).getHours();
    const dow = new Date(ts).getDay();
    d.totalSignals++; d.sinceSignals++;
    if (!d.firstSignalTs) d.firstSignalTs = ts;
    d.signals.push({ ts, u: user, skill, h: hour, d: dow, s: sentiment }); // ← no text, by design
    if (d.signals.length > SIGNAL_CAP) d.signals = d.signals.slice(-SIGNAL_CAP);
    this._prune(ts);

    this._observeRoutine(user, skill, ts, hour, dow);
    this._observePrefs(user, skill, text);
    this._observeTone(user, sentiment);
    const flag = this._observeAnomaly(user, ts, hour, dow);
    this._maybeCorrection(user, text, prevResolved);
    if (DEBUG()) this.log.write('learn.debug', { what: 'signal', user, skill, h: hour, dow, s: sentiment, total: d.totalSignals, sinceCheckpoint: d.sinceSignals, topics: Object.keys(((d.prefs[user] || {}).topics) || {}).length }); // verbose capture proof — metadata only, NEVER text
    if (d.sinceSignals >= CHECKPOINT_EVERY) { d.sinceSignals = 0; this.checkpointAll('auto ' + d.totalSignals); }
    this.store.saveSoon();
    return flag || null;
  }

  _prune(ts) {
    const days = Number(this.settings.data.privacy.logRetentionDays) || 30; // reuse the established retention rule
    const d = this.store.data;
    const cut = ts - days * 86400e3;
    if (d.signals.length && d.signals[0].ts < cut) d.signals = d.signals.filter((s) => s.ts >= cut);
  }

  /* ---------- pipeline steps 2+3: structured examples → model update ---------- */

  _observeRoutine(user, skill, ts, hour, dow) {
    if (!skill) return;
    const d = this.store.data;
    const r = (d.routines[user] = d.routines[user] || {});
    const per = (r[skill] = r[skill] || {});
    const b = dow * 24 + hour;
    const cell = (per[b] = per[b] || { n: 0, weeks: {} });
    cell.n++; cell.weeks[weekKey(ts)] = 1;
    if (cell.n < ROUTINE_MIN_HITS) return;                       // min-signal threshold
    if (Object.keys(cell.weeks).length < ROUTINE_MIN_WEEKS) return; // drift guard: must span weeks
    // drift guard: this bucket must stand out vs the user's overall mean bucket occupancy
    let total = 0;
    for (const sk of Object.keys(r)) for (const bx of Object.keys(r[sk])) total += r[sk][bx].n;
    const mean = total / (Object.keys(r).length * 168) || 0;
    if (mean > 0 && cell.n < mean * ROUTINE_BASELINE_MULT) return;
    this._suggest({ user, skill, bucket: b, hour, dow, n: cell.n, weeks: Object.keys(cell.weeks).length });
  }

  _suggest(p) {
    const d = this.store.data;
    const id = `routine:${p.user}:${p.skill}:${p.bucket}`;
    let s = d.suggestions.find((x) => x.id === id);
    if (s) {
      s.n = p.n; s.updated = this.now();
      s.confidence = clamp(Math.round((p.n / 10) * 100) / 100, 0.05, 0.95);
      if (s.state === 'pending') this.store.saveSoon();
      return;
    }
    if (d.stopped.includes(id)) return;                        // "stop learning this" is permanent
    s = {
      id, kind: 'routine', user: p.user, skill: p.skill, bucket: p.bucket, hour: p.hour, dow: p.dow,
      n: p.n, confidence: clamp(Math.round((p.n / 10) * 100) / 100, 0.05, 0.95),
      state: 'pending', created: this.now(), updated: this.now(),
    };
    d.suggestions.push(s);
    if (d.suggestions.length > SUGGESTION_CAP) d.suggestions = d.suggestions.slice(-SUGGESTION_CAP);
    this.log.write('learn.suggest', { user: p.user, skill: p.skill, hour: p.hour, confidence: s.confidence });
    this.bus.emit('learn.suggest', s); // server decides whether/how to toast (proactive opt-in respected)
  }

  _observePrefs(user, skill, text) {
    const d = this.store.data;
    const p = (d.prefs[user] = d.prefs[user] || { topics: {}, lastDecay: this.now() });
    // weekly exponential decay — old preferences fade unless reinforced (drift guard)
    const ts = this.now();
    while (ts - p.lastDecay >= PREF_DECAY_MS) {
      for (const k of Object.keys(p.topics)) { p.topics[k] = Math.round(p.topics[k] * PREF_DECAY * 100) / 100; if (p.topics[k] < 0.05) delete p.topics[k]; }
      p.lastDecay += PREF_DECAY_MS;
    }
    const bump = (topic) => { p.topics[topic] = clamp(Math.round(((p.topics[topic] || 0) + PREF_STEP) * 100) / 100, 0, PREF_CAP); };
    if (skill) bump('skill:' + skill);
    for (const [topic, re] of Object.entries(TOPIC_WORDS)) if (re.test(text || '')) bump(topic);
  }

  _observeTone(user, sentiment) {
    const d = this.store.data;
    const t = (d.tone[user] = d.tone[user] || { recent: 0.5, long: 0.5, n: 0 });
    const valence = sentiment === 'positive' ? 1 : sentiment === 'neutral' ? 0.5 : sentiment === 'urgent' ? 0.35 : 0.1; // frustrated lowest
    t.recent += 0.15 * (valence - t.recent); // fast EWMA
    t.long += 0.02 * (valence - t.long);     // slow EWMA = long-term baseline
    t.n++;
  }

  toneFor(user, base) {
    const t = this.store.data.tone[user];
    if (!t || t.n < 20) return base; // min-signal: tone only adapts after 20 signals
    const drift = clamp(t.recent - t.long, -TONE_DRIFT_CAP, TONE_DRIFT_CAP); // hard drift cap
    return Math.round(clamp(base + drift, 0, 1) * 100) / 100;
  }

  _observeAnomaly(user, ts, hour, dow) {
    const d = this.store.data;
    const a = (d.anomaly[user] = d.anomaly[user] || { buckets: new Array(168).fill(0), day: { key: dayKey(ts), count: 0 }, stats: { mean: 0, m2: 0, days: 0 }, flags: [], firstTs: ts });
    const b = dow * 24 + hour;
    const novel = a.buckets[b] === 0; // never active in this hour-of-week before
    a.buckets[b]++;
    // day rollover → fold yesterday's count into the long-term daily baseline (Welford)
    if (a.day.key !== dayKey(ts)) {
      a.stats.days++;
      const delta = a.day.count - a.stats.mean;
      a.stats.mean += delta / a.stats.days;
      a.stats.m2 += delta * (a.day.count - a.stats.mean);
      a.day = { key: dayKey(ts), count: 0 };
    }
    a.day.count++;
    const total = a.buckets.reduce((x, y) => x + y, 0);
    if (!novel || total < ANOMALY_MIN_SIGNALS || a.stats.days < ANOMALY_MIN_DAYS) return null;
    const std = Math.sqrt(a.stats.days > 1 ? a.stats.m2 / (a.stats.days - 1) : 0);
    const z = (a.day.count - a.stats.mean) / Math.max(std, 1);
    if (z <= ANOMALY_Z) return null;
    const flaggedToday = a.flags.some((f) => dayKey(f.ts) === dayKey(ts));
    if (flaggedToday) return null;
    const flag = { ts, user, hour, dow, z: Math.round(z * 10) / 10, reviewOnly: true }; // FLAG ONLY — never blocks
    a.flags.push(flag);
    if (a.flags.length > FLAG_CAP) a.flags = a.flags.slice(-FLAG_CAP);
    this.log.write('security.anomaly', { user, hour, z: flag.z, note: 'odd-hour activity burst vs your long-term baseline — review flag only, nothing was blocked' });
    this.bus.emit('security.anomaly', flag);
    return flag;
  }

  /* ---------- correction-based intent re-ranker ---------- */

  _maybeCorrection(user, text, prevResolved) {
    if (!prevResolved || !prevResolved.skill) return;
    if (this.now() - (prevResolved.at || 0) > 120e3) return; // corrections land right after the mistake
    const m = CORRECTION_RE.exec(String(text || '').trim()) || NOT_RE.exec(String(text || '').trim());
    if (!m) return;
    const to = norm(m[1]);
    const from = norm(prevResolved.target);
    if (!to || !from || to === from) return;
    const skill = prevResolved.skill;
    const d = this.store.data;
    const list = (d.corrections[user] = d.corrections[user] || []);
    let c = list.find((x) => x.skill === skill && x.from === from && x.to === to);
    if (c) { c.n++; c.last = this.now(); }
    else {
      c = { skill, from, to, n: 1, last: this.now() };
      list.push(c);
      if (list.length > CORRECTION_CAP / 10) list.splice(0, list.length - Math.floor(CORRECTION_CAP / 10));
    }
    if (c.n >= RERANK_MIN) this.log.write('learn.rerank', { user, skill, from, to, n: c.n });
  }

  /** What the current turn should use instead of `candidate`, or null.
   *  NEVER applies to sensitive skills — learned re-ranking cannot cross a gate. */
  applyCorrection(user, skill, candidate) {
    if (!skill) return null;
    const sk = this.skills && this.skills.get ? this.skills.get(skill) : null;
    if (sk && sk.sensitive) return null; // security-critical logic is off-limits, permanently
    const list = (this.store.data.corrections[user] || []);
    const cNorm = norm(candidate);
    for (const c of list) {
      if (c.skill === skill && c.n >= RERANK_MIN && cNorm && (cNorm.includes(c.from) || c.from.includes(cNorm))) {
        return { to: c.to, from: c.from, n: c.n };
      }
    }
    return null;
  }

  /* ---------- model registry: versioning + rollback ---------- */

  checkpointAll(reason) {
    const d = this.store.data;
    const reg = this.registryStore.data.models;
    for (const name of MODEL_NAMES) {
      const blob = structuredClone({
        routines: d.routines, prefs: d.prefs, tone: d.tone,
        corrections: d.corrections, anomaly: name === 'anomaly' ? d.anomaly : undefined,
        suggestions: d.suggestions.map((s) => ({ ...s })), stopped: [...d.stopped],
      });
      delete blob.undefined;
      const entry = (reg[name] = reg[name] || { current: 0, versions: [] });
      entry.current++;
      entry.versions.push({ v: entry.current, created: this.now(), metrics: { signals: d.totalSignals, reason: String(reason || 'auto') }, blob });
      entry.versions = entry.versions.slice(-MODEL_VERSIONS_KEPT);
    }
    this.registryStore.saveSoon();
    if (DEBUG()) this.log.write('learn.debug', { what: 'checkpoint', reason: String(reason || 'auto'), total: d.totalSignals });
  }

  rollback(name) {
    const reg = this.registryStore.data.models;
    const e = reg[name];
    if (!e || e.versions.length < 2) return { ok: false, error: 'no earlier version to roll back to' };
    e.versions.pop(); // drop current
    const prev = e.versions[e.versions.length - 1];
    e.current = prev.v;
    const d = this.store.data;
    const blob = structuredClone(prev.blob);
    d.routines = blob.routines || {}; d.prefs = blob.prefs || {}; d.tone = blob.tone || {};
    d.corrections = blob.corrections || {};
    if (name === 'anomaly' && blob.anomaly) d.anomaly = blob.anomaly;
    if (Array.isArray(blob.suggestions)) d.suggestions = blob.suggestions;
    if (Array.isArray(blob.stopped)) d.stopped = blob.stopped;
    this.store.saveSoon(); this.registryStore.saveSoon();
    this.log.write('learn.rollback', { model: name, to: prev.v });
    return { ok: true, model: name, restored: prev.v, remaining: e.versions.map((x) => x.v) };
  }

  /* ---------- transparency & control ---------- */

  feedback({ id, action }) {
    const d = this.store.data;
    const s = d.suggestions.find((x) => x.id === id);
    if (!s) return { ok: false, error: 'unknown suggestion' };
    if (action === 'confirm') s.state = 'confirmed';
    else if (action === 'dismiss') s.state = 'dismissed';
    else if (action === 'stop') { s.state = 'stopped'; if (!d.stopped.includes(id)) d.stopped.push(id); }
    else return { ok: false, error: 'action must be confirm|dismiss|stop' };
    s.updated = this.now();
    this.store.saveSoon();
    this.log.write('learn.feedback', { id, action });
    return { ok: true, state: s.state };
  }

  forget({ kind, key, user }) {
    const d = this.store.data;
    if (kind === 'pref') {
      const u = user || 'default';
      if (d.prefs[u] && d.prefs[u].topics) delete d.prefs[u].topics[key];
    } else if (kind === 'correction') {
      for (const u of Object.keys(d.corrections)) {
        d.corrections[u] = d.corrections[u].filter((c) => !(c.skill === key || `${c.from}→${c.to}` === key));
      }
    } else if (kind === 'suggestion') {
      d.suggestions = d.suggestions.filter((s) => s.id !== key);
    } else if (kind === 'anomaly') {
      for (const u of Object.keys(d.anomaly)) d.anomaly[u].flags = d.anomaly[u].flags.filter((f) => f.ts !== Number(key));
    } else return { ok: false, error: 'kind must be pref|correction|suggestion|anomaly' };
    this.store.saveSoon();
    return { ok: true };
  }

  /** Learning-layer-only reset: wipes signals + all five models + version history.
   *  Memory (facts/prefs), settings, events and everything else stay untouched. */
  reset() {
    this.store.data = freshData();
    this.registryStore.data.models = {};
    this.store.save(); this.registryStore.save();
    this.log.write('learn.reset', {});
    return { ok: true };
  }

  /* ---------- transparency: in-progress routine accumulation ---------- */

  /** Patterns still accumulating toward the suggestion guardrails — the progress
   *  state().routines cannot show yet. Pure read: metadata only, no mutation.
   *  Without this, learning LOOKS invisible for the first weeks even though the
   *  cells are filling — that "empty transparency view" was the reported bug. */
  emergingRoutines(user) {
    const d = this.store.data;
    const out = [];
    const names = user ? [user] : Object.keys(d.routines);
    for (const u of names) {
      const r = d.routines[u];
      if (!r) continue;
      let total = 0;
      for (const sk of Object.keys(r)) for (const bx of Object.keys(r[sk])) total += r[sk][bx].n;
      const mean = total / (Object.keys(r).length * 168) || 0; // same baseline math as _observeRoutine
      for (const sk of Object.keys(r)) {
        for (const bx of Object.keys(r[sk])) {
          const cell = r[sk][bx];
          if (cell.n < 2) continue;                                     // one occurrence is noise, not a pattern-in-progress
          const b = Number(bx);
          if (d.stopped.includes(`routine:${u}:${sk}:${b}`)) continue;  // "stop learning this" is permanent — no shadow progress
          const weeks = Object.keys(cell.weeks).length;
          const matured = cell.n >= ROUTINE_MIN_HITS && weeks >= ROUTINE_MIN_WEEKS
            && !(mean > 0 && cell.n < mean * ROUTINE_BASELINE_MULT);
          if (matured) continue;                                        // already surfaced as a suggestion in state().routines
          out.push({
            user: u, skill: sk, bucket: b, hour: b % 24, dow: Math.floor(b / 24),
            n: cell.n, weeks, needed: { hits: ROUTINE_MIN_HITS, weeks: ROUTINE_MIN_WEEKS },
          });
        }
      }
    }
    return out.sort((a, b) => b.n - a.n).slice(0, EMERGING_CAP);
  }

  state(user) {
    const d = this.store.data;
    const reg = this.registryStore.data.models;
    const models = {};
    for (const name of MODEL_NAMES) {
      const e = reg[name];
      models[name] = e ? { current: e.current, versions: e.versions.map((x) => ({ v: x.v, created: x.created, metrics: x.metrics })) } : { current: 0, versions: [] };
    }
    const users = (arr) => (user ? arr.filter(() => true) : arr);
    return {
      enabled: this.enabled(),
      signals: { count: d.signals.length, total: d.totalSignals, cap: SIGNAL_CAP, retentionDays: Number(this.settings.data.privacy.logRetentionDays) || 30 },
      routines: users(d.suggestions.filter((s) => !user || s.user === user)).slice(-30).reverse(),
      emerging: this.emergingRoutines(user),       // live progress toward the routine guardrails (fixes the invisible-accumulation bug)
      prefs: d.prefs,                                 // fully inspectable topic→weight dict
      tone: Object.fromEntries(Object.entries(d.tone).map(([u, t]) => [u, {
        signals: t.n,
        drift: t.n >= 20 ? Math.round(clamp(t.recent - t.long, -TONE_DRIFT_CAP, TONE_DRIFT_CAP) * 100) / 100 : 0,
        recent: Math.round(t.recent * 100) / 100, longTerm: Math.round(t.long * 100) / 100,
      }])),
      corrections: d.corrections,
      anomalies: Object.fromEntries(Object.entries(d.anomaly).map(([u, a]) => [u, a.flags.slice(-FLAG_CAP)])),
      models,
      guardrails: {
        routineMinHits: ROUTINE_MIN_HITS, routineMinWeeks: ROUTINE_MIN_WEEKS, routineBaselineMult: ROUTINE_BASELINE_MULT,
        toneDriftCap: TONE_DRIFT_CAP, rerankMinCorrections: RERANK_MIN,
        anomalyMinSignals: ANOMALY_MIN_SIGNALS, anomalyMinDays: ANOMALY_MIN_DAYS, anomalyZ: ANOMALY_Z,
        checkpointEvery: CHECKPOINT_EVERY, versionsKept: MODEL_VERSIONS_KEPT,
        offLimits: 'auth, locks, payments, sensitive skills — learning can never skip a confirmation; anomaly flags are review-only and never block',
      },
    };
  }
}

module.exports = { Learner, freshData, norm, CORRECTION_RE, NOT_RE };
