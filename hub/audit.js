'use strict';
/**
 * Tamper-evident audit log (data/audit.jsonl).
 *
 * The event log is an operational log — it rotates, prunes, and is fine to lose.
 * The audit log is different: it exists so the owner can TRUST that the record of
 * diagnosed errors, model switches, and sensitive decisions has not been edited
 * after the fact.
 *
 * How it works: every record carries
 *   prev — the MAC of the previous record ("GENESIS" for the first)
 *   mac  — HMAC-SHA256(masterKey, prev + '\n' + canonical(record-without-mac))
 * The key is the SAME data/.master.key the encrypted stores use (chmod 600), so
 * the chain cannot be recomputed by someone who only has the JSONL file, and any
 * edit, deletion, or reorder of a line breaks every link after it — verify()
 * reports the first broken position.
 *
 * Rotation keeps the chain verifiable: when the file grows past cap it is moved
 * aside and the new file opens with an anchor record carrying the last MAC.
 *
 * Like the event log: metadata only (raw text is never written), secret-shaped
 * strings are scrubbed, values are bounded, and a dead disk degrades to
 * console-only — the audit log may never take the product down with it.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./secure-store');

const CAP = 2 * 1024 * 1024; // 2 MB per segment
// shared with diagnose.js/eventlog.js — separator-aware so prose survives (R-06);
// adds fine-grained PATs (github_pat_) and GitLab tokens the old pattern missed
const KEY_RE = /\b(?:sk|pk|xox[bap]|gh[pousr]|github_pat|glpat|dop_v1|hf)[-_][-A-Za-z0-9_]{6,}|\b(?:AIza|ya29)[-A-Za-z0-9_.]{10,}/g;

function masterKey(dir) {
  // Same file secure-store maintains; create it the same way if absent.
  const kf = path.join(dir || DATA_DIR, '.master.key');
  try {
    const k = fs.readFileSync(kf, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(k)) return k;
  } catch {}
  try {
    fs.mkdirSync(dir || DATA_DIR, { recursive: true });
    const k = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(kf, k, { mode: 0o600 });
    return k;
  } catch {
    return null; // dead disk — MACs degrade to a per-process ephemeral key
  }
}

function scrub(v) {
  if (typeof v === 'string') return v.replace(KEY_RE, '[key-redacted]').slice(0, 300);
  if (Array.isArray(v)) return v.slice(0, 20).map(scrub);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v).slice(0, 30)) o[k] = scrub(x);
    return o;
  }
  return v;
}

class AuditLog {
  constructor({ name = 'audit', key, dir, cap } = {}) {
    this.cap = cap || CAP;
    this.dir = dir || DATA_DIR;
    this.file = path.join(this.dir, name + '.jsonl');
    this.key = key === undefined ? masterKey(this.dir) : key; // tests may inject
    if (!this.key) this.key = crypto.randomBytes(32).toString('hex');
    this._hmac = crypto.createHmac ? null : null;
    this._last = null;   // mac of the last record written/read
    this._seq = 0;
    this.unusable = false;
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch { this.unusable = true; }
    this._tailState();
  }

  _mac(prev, payload) {
    return crypto.createHmac('sha256', this.key).update(prev + '\n' + payload).digest('hex');
  }

  /** Recover chain head (last mac + seq) from the end of the current segment. */
  _tailState() {
    if (this.unusable) return;
    try {
      const lines = fs.readFileSync(this.file, 'utf8').trim().split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const rec = JSON.parse(lines[i]);
          if (rec && rec.mac) { this._last = rec.mac; this._seq = rec.seq || 0; return; }
        } catch { /* skip corrupt tail */ }
      }
    } catch { /* no file yet */ }
  }

  write(type, fields = {}) {
    const body = { ts: Date.now(), type, ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, k === 'text' ? undefined : scrub(v)])) };
    for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
    // rotation must happen BEFORE chaining: the record's prev link belongs to
    // the segment it lands in (a trigger record chained pre-rotation would
    // break every link after the anchor)
    if (!this.unusable) {
      try { if (fs.existsSync(this.file) && fs.statSync(this.file).size > this.cap) this._rotate(); } catch {}
    }
    const prev = this._last || 'GENESIS';
    const seq = ++this._seq;
    const mac = this._mac(prev, JSON.stringify({ seq, ...body }));
    const rec = { seq, ...body, prev, mac };
    this._last = mac;
    if (this.unusable) { console.error('[audit]', JSON.stringify(rec).slice(0, 240)); return rec; }
    try { fs.appendFileSync(this.file, JSON.stringify(rec) + '\n'); } catch {}
    return rec;
  }

  /** Move the full segment aside; open the new one with an anchor carrying the last MAC. */
  _rotate() {
    const lastMac = this._last, lastSeq = this._seq;
    try {
      fs.renameSync(this.file, this.file + '.1');
      const prev = 'GENESIS';
      const seq = 0;
      const body = { ts: Date.now(), type: 'audit.anchor', note: `segment rolled after seq ${lastSeq}`, chainedFrom: lastMac };
      const mac = this._mac(prev, JSON.stringify({ seq, ...body, chainedFrom: lastMac }));
      fs.writeFileSync(this.file, JSON.stringify({ seq, ...body, prev, mac }) + '\n', { mode: 0o600 });
      this._last = mac; this._seq = 0;
    } catch {}
  }

  tail(n = 100) {
    try {
      const lines = fs.readFileSync(this.file, 'utf8').trim().split('\n').filter(Boolean);
      return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && r.type !== 'audit.anchor');
    } catch { return []; }
  }

  /**
   * Recompute the whole chain. Returns { ok, lines, brokenAt } —
   * brokenAt is the 1-based line number of the first record whose link fails
   * (null when the chain is intact). Anchor records re-root the expectation.
   */
  verify() {
    let lines;
    try { lines = fs.readFileSync(this.file, 'utf8').trim().split('\n').filter(Boolean); } catch { return { ok: true, lines: 0, brokenAt: null, empty: true }; }
    let expect = 'GENESIS';
    for (let i = 0; i < lines.length; i++) {
      let rec;
      try { rec = JSON.parse(lines[i]); } catch { return { ok: false, lines: lines.length, brokenAt: i + 1, reason: 'unparseable line' }; }
      if (rec.type === 'audit.anchor') { expect = rec.mac; continue; }
      if (rec.prev !== expect) return { ok: false, lines: lines.length, brokenAt: i + 1, reason: 'chain link mismatch' };
      const { mac, prev, ...rest } = rec;
      if (this._mac(rec.prev, JSON.stringify(rest)) !== mac) return { ok: false, lines: lines.length, brokenAt: i + 1, reason: 'content MAC mismatch' };
      expect = rec.mac;
    }
    return { ok: true, lines: lines.length, brokenAt: null };
  }
}

module.exports = { AuditLog };
