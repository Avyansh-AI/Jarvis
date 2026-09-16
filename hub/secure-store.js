'use strict';
/**
 * AES-256-GCM encrypted JSON file store.
 * Key = scrypt(MAX_SECRET || generated local key, salt).
 * Writes are atomic (tmp + rename). Nothing (including transcripts) is
 * written anywhere unless a caller explicitly stores it here.
 *
 * Self-healing (chaos-tested in tools/test-chaos.js):
 * - every good save leaves a `.bak` copy; a corrupt main file is recovered
 *   from it automatically (power loss between rename and crash, bit rot).
 * - a main file that won't decrypt and has no good backup is quarantined to
 *   `<file>.corrupt-<ts>` (never silently overwritten — forensics preserved)
 *   and the store starts fresh, so the hub always boots.
 * - torn `.tmp` files from crashes mid-write are swept at load.
 * - write failures (ENOSPC etc.) leave the previous good file untouched and
 *   surface via SecureStore.onError — the running process keeps its in-RAM
 *   copy and never crashes on a bad disk.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.MAX_DATA_DIR || path.join(__dirname, '..', 'data');

function ensureDir() { fs.mkdirSync(DATA_DIR, { recursive: true }); }

function localKey() {
  ensureDir();
  const kf = path.join(DATA_DIR, '.master.key');
  if (fs.existsSync(kf)) return fs.readFileSync(kf, 'utf8').trim();
  const key = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(kf, key, { mode: 0o600 });
  return key;
}

/* Debounced-write registry: saves are sync (scrypt ~40 ms) — hot paths
   (intent counters, facts, prefs) use saveSoon so a burst costs one encrypt. */
const pending = new Set();
process.on('beforeExit', () => { for (const s of pending) { try { s.save(); } catch {} } pending.clear(); });

class SecureStore {
  /** hook: (storeName, err) => {} — set once by the server to log/broadcast disk trouble */
  static onError = null;

  constructor(name, { pass } = {}) {
    this.name = name;
    this.degraded = false; // true = data dir unusable; RAM-only, loud
    try { ensureDir(); } catch (e) {
      this.degraded = true;
      console.error(`[secure-store] data dir unusable (${e.code || e.message}) — ${name} running RAM-ONLY, changes won't persist`);
      SecureStore._report(name, e);
    }
    this.file = path.join(DATA_DIR, name + '.enc.json');
    this.bakFile = this.file + '.bak';
    if (process.env.MAX_SECRET) this.pass = process.env.MAX_SECRET;
    else if (this.degraded) this.pass = crypto.randomBytes(32).toString('hex'); // ephemeral — nothing can persist anyway
    else {
      try { this.pass = pass || localKey(); } catch (e) {
        this.degraded = true; // dir exists but key file can't be read/written (read-only FS, perms)
        this.pass = crypto.randomBytes(32).toString('hex');
        console.error(`[secure-store] master key unusable (${e.code || e.message}) — ${name} running RAM-ONLY`);
        SecureStore._report(name, e);
      }
    }
    this.data = {};
    this._debounceMs = 250;
    this._timer = null;
    if (this.degraded) return;
    this._sweepTmp();
    this._load();
  }

  static _report(name, err) {
    try { if (SecureStore.onError) SecureStore.onError(name, err); } catch {}
  }

  /** Coalesced write for hot paths: at most one encrypt per _debounceMs window. */
  saveSoon() {
    if (this._timer) return;
    pending.add(this);
    this._timer = setTimeout(() => {
      this._timer = null;
      pending.delete(this);
      try { this.save(); } catch (e) {
        console.error('[secure-store] debounced save failed:', e.message);
        SecureStore._report(this.name, e);
      }
    }, this._debounceMs);
    this._timer.unref?.();
  }

  /** Remove torn tmp files for this store (crashes between write and rename). */
  _sweepTmp() {
    const tmp = this.file + '.tmp';
    try { if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true }); } catch {}
  }

  _decryptFile(file) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const key = crypto.scryptSync(this.pass, Buffer.from(raw.salt, 'base64'), 32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(raw.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(raw.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(raw.payload, 'base64')), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
  }

  _load() {
    if (!fs.existsSync(this.file)) {
      // fresh start — but maybe only the backup survived
      if (fs.existsSync(this.bakFile)) {
        try { this.data = this._decryptFile(this.bakFile); this._healFromBackup(); return this.data; } catch {}
      }
      this.data = {};
      return this.data;
    }
    try {
      this.data = this._decryptFile(this.file);
      return this.data;
    } catch (e) {
      console.error('[secure-store] could not decrypt', path.basename(this.file), '— trying backup:', e.message);
    }
    // main is corrupt: recover from the backup copy if it verifies
    if (fs.existsSync(this.bakFile)) {
      try {
        this.data = this._decryptFile(this.bakFile);
        console.error('[secure-store] recovered', path.basename(this.file), 'from backup');
        this._healFromBackup();
        return this.data;
      } catch (e) {
        console.error('[secure-store] backup also unreadable:', e.message);
      }
    }
    // unrecoverable: quarantine (don't destroy evidence) and start clean
    try { fs.renameSync(this.file, this.file + '.corrupt-' + Date.now()); } catch {}
    console.error('[secure-store] quarantined corrupt store', path.basename(this.file), '— starting fresh');
    this.data = {};
    return this.data;
  }

  _healFromBackup() {
    try { fs.copyFileSync(this.bakFile, this.file); fs.chmodSync(this.file, 0o600); } catch {}
  }

  /** Atomic encrypt+write; throws on failure (callers catch), previous file stays intact. */
  save() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; pending.delete(this); }
    if (this.degraded) { const e = new Error('storage unavailable — hub is in RAM-only degraded mode'); e.code = 'EDEGRADED'; throw e; }
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = crypto.scryptSync(this.pass, salt, 32);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const payload = Buffer.concat([cipher.update(JSON.stringify(this.data)), cipher.final()]);
    const out = {
      v: 1, alg: 'aes-256-gcm', kdf: 'scrypt',
      salt: salt.toString('base64'), iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'), payload: payload.toString('base64'),
    };
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 }); // ENOSPC etc: throws BEFORE touching the good file
    fs.renameSync(tmp, this.file);                               // atomic: power cut here leaves old OR new, never torn
    try { fs.copyFileSync(this.file, this.bakFile); fs.chmodSync(this.bakFile, 0o600); } catch {} // backup copy is best-effort
  }
}

module.exports = { SecureStore, DATA_DIR };
