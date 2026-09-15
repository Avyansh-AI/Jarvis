'use strict';
/** Private analytics log (JSONL, owner-only). Powers the logs dashboard. */
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./secure-store');

class EventLog {
  constructor(name = 'events') {
    this.unusable = false;
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {
      this.unusable = true; // dead/full disk at boot: stay alive, in-memory only, say so once
      console.error('[eventlog] data dir unusable (' + (e.code || e.message) + ') — logging to console only');
    }
    this.file = path.join(DATA_DIR, name + '.jsonl');
    this.maxBytes = 4 * 1024 * 1024;
  }

  write(type, fields = {}) {
    const rec = { ts: Date.now(), type };
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'text' && !fields.allowText) continue; // never log raw transcripts by default
      if (typeof v === 'string') {
        // scrub anything shaped like an API key, then bound length — logs never hold secrets
        // (pattern shared with diagnose.js/audit.js; separator-aware so prose like
        // "skipping" or model ids like hf.co/… survive — R-06 review fix)
        rec[k] = v.replace(/\b(?:sk|pk|xox[bap]|gh[pousr]|github_pat|glpat|dop_v1|hf)[-_][-A-Za-z0-9_]{6,}|\b(?:AIza|ya29)[-A-Za-z0-9_.]{10,}/g, '[key-redacted]').slice(0, 300);
      } else rec[k] = v;
    }
    if (this.unusable) { console.error('[event]', type, JSON.stringify(rec).slice(0, 200)); return; }
    try {
      fs.appendFileSync(this.file, JSON.stringify(rec) + '\n');
      if (fs.statSync(this.file).size > this.maxBytes) this._rotate();
    } catch {}
  }

  _rotate() {
    const old = this.file + '.1';
    try {
      if (fs.existsSync(old)) fs.unlinkSync(old);
      fs.renameSync(this.file, old);
    } catch {}
  }

  /** Age-based retention: drop entries older than `days` (rewrite in place, tolerates
      corrupt lines by keeping them — they're evidence until they age out). */
  pruneOlderThan(days) {
    if (this.unusable || !days || days < 1) return 0;
    let lines;
    try { lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean); } catch { return 0; }
    const cutoff = Date.now() - days * 86400000;
    const kept = lines.filter((l) => {
      try { const rec = JSON.parse(l); return !(rec.ts && rec.ts < cutoff); } catch { return true; }
    });
    const removed = lines.length - kept.length;
    if (removed > 0) {
      try { fs.writeFileSync(this.file + '.new', kept.join('\n') + (kept.length ? '\n' : ''), { mode: 0o600 }); fs.renameSync(this.file + '.new', this.file); } catch {}
    }
    return removed;
  }

  tail(n = 500) {
    try {
      const lines = fs.readFileSync(this.file, 'utf8').trim().split('\n');
      return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  }

  summary(windowMs = 24 * 3600e3) {
    const since = Date.now() - windowMs;
    const evts = this.tail(3000).filter((e) => e.ts >= since);
    const bySkill = {}, byType = {}, byHour = {}, errors = [];
    let interactions = 0, ok = 0, fail = 0;
    for (const e of evts) {
      byType[e.type] = (byType[e.type] || 0) + 1;
      byHour[new Date(e.ts).getHours()] = (byHour[new Date(e.ts).getHours()] || 0) + 1;
      if (e.type === 'interaction') {
        interactions++;
        const s = e.skill || '(conversation)';
        bySkill[s] = bySkill[s] || { ok: 0, fail: 0 };
        if (e.ok === false) { fail++; bySkill[s].fail++; } else { ok++; bySkill[s].ok++; }
      }
      if (e.ok === false || e.type === 'error') {
        errors.push({ ts: e.ts, type: e.type, skill: e.skill || null, message: e.message || null });
      }
    }
    return { since, interactions, ok, fail, bySkill, byType, byHour, errors: errors.slice(-25).reverse() };
  }
}

module.exports = { EventLog };
