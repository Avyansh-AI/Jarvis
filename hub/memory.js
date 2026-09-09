'use strict';
/**
 * Conversation + long-term memory.
 * - Per-user profiles, facts, preferences (encrypted at rest via SecureStore)
 * - Volatile per-session state (multi-turn context, pending tasks) in RAM only
 * - Intent counters power preference learning / proactive suggestions
 */
const SESSION_CAP = 200;          // network-derived ids must not grow RAM without bound
const SESSION_IDLE_MS = 2 * 3600e3; // idle sessions are reaped — nothing hangs forever
const TASK_TTL_MS = 10 * 60e3;    // multi-turn tasks expire safely instead of lying in wait

class Memory {
  constructor(store) {
    this.store = store;
    const d = store.data;
    d.users = d.users || {};
    d.stats = d.stats || { counts: {} };
    this.sessions = new Map();
    this._sweeper = setInterval(() => this._sweepSessions(), 10 * 60e3);
    this._sweeper.unref?.();
  }

  _sweepSessions() {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (now - (s.updated || 0) > SESSION_IDLE_MS) this.sessions.delete(id);
    }
    while (this.sessions.size > SESSION_CAP) {
      let oldestId = null, oldest = Infinity;
      for (const [id, s] of this.sessions) if ((s.updated || 0) < oldest) { oldest = s.updated || 0; oldestId = id; }
      if (oldestId === null) break;
      this.sessions.delete(oldestId);
    }
  }

  ensureUser(id = 'default') {
    const users = this.store.data.users;
    if (!users[id]) {
      // bound the profile count — ids come from network input
      const ids = Object.keys(users);
      if (ids.length >= 60) {
        ids.sort((a, b) => (users[a].lastSeen || 0) - (users[b].lastSeen || 0));
        delete users[ids[0]];
      }
      users[id] = {
        id, name: id === 'default' ? 'Owner' : id,
        created: Date.now(), lastSeen: Date.now(),
        facts: [],
        prefs: { tone: 0.5 },           // 0 = clinical … 1 = playful
        kid: false, guest: false,
        voiceprint: null,               // experimental voice features (see /api/voiceprint)
      };
      this.store.saveSoon();
    }
    users[id].lastSeen = Date.now();
    return users[id];
  }

  setUserFlags(id, flags) {
    const u = this.ensureUser(id);
    Object.assign(u, flags);
    this.store.save();
    return u;
  }

  listUsers() {
    return Object.values(this.store.data.users).map((u) => ({
      id: u.id, name: u.name, kid: !!u.kid, guest: !!u.guest,
      facts: u.facts.length, tone: u.prefs.tone ?? 0.5,
      hasVoiceprint: !!u.voiceprint, lastSeen: u.lastSeen,
    }));
  }

  addFact(userId, fact) {
    const u = this.ensureUser(userId);
    const clean = String(fact || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 400); // bounded, single-line
    if (!clean) return;
    u.facts.push({ fact: clean, ts: Date.now() });
    if (u.facts.length > 200) u.facts = u.facts.slice(-200);
    this.store.saveSoon();
  }

  forgetFact(userId, needle) {
    const u = this.ensureUser(userId);
    const before = u.facts.length;
    if (typeof needle === 'number') u.facts.splice(needle, 1);
    else u.facts = u.facts.filter((f) => !f.fact.toLowerCase().includes(String(needle).toLowerCase()));
    this.store.save();
    return before - u.facts.length;
  }

  facts(userId) { return (this.store.data.users[userId]?.facts) || []; }

  setPref(userId, key, value) {
    const u = this.ensureUser(userId);
    u.prefs[key] = value;
    this.store.saveSoon();
  }

  /* ---- volatile session (multi-turn task tracking) ---- */
  session(userId) {
    if (!this.sessions.has(userId)) {
      if (this.sessions.size >= SESSION_CAP) this._sweepSessions();
      if (this.sessions.size >= SESSION_CAP) return { turns: [], pendingTask: null, updated: Date.now() }; // ephemeral, uncached
      this.sessions.set(userId, { turns: [], pendingTask: null, updated: Date.now() });
    }
    return this.sessions.get(userId);
  }

  /** Multi-turn tasks get a 10-minute TTL: a task the user walks away from
      must expire, not hijack their next request tomorrow. */
  setPending(userId, task) {
    const s = this.session(userId);
    s.pendingTask = { ...task, expiresAt: Date.now() + TASK_TTL_MS };
    return s.pendingTask;
  }

  /** Live (unexpired) pending task, or null — clears stale ones as a side effect. */
  pendingTask(userId) {
    const s = this.session(userId);
    if (s.pendingTask && s.pendingTask.expiresAt <= Date.now()) s.pendingTask = null;
    return s.pendingTask;
  }

  clearPending(userId) { const s = this.session(userId); s.pendingTask = null; }

  addTurn(userId, role, text) {
    const s = this.session(userId);
    s.turns.push({ role, text, ts: Date.now() });
    if (s.turns.length > 12) s.turns = s.turns.slice(-12);
    s.updated = Date.now();
  }

  /* ---- preference learning ---- */
  countIntent(key) {
    const c = this.store.data.stats.counts;
    c[key] = (c[key] || 0) + 1;
    this.store.saveSoon();
    return c[key];
  }

  topIntents(n = 5) {
    return Object.entries(this.store.data.stats.counts).sort((a, b) => b[1] - a[1]).slice(0, n);
  }

  contextFor(userId) {
    const u = this.ensureUser(userId);
    return {
      user: u,
      facts: u.facts.slice(-12).map((f) => f.fact),
      prefs: u.prefs,
      session: this.session(userId),
    };
  }
}

module.exports = { Memory };
