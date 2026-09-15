'use strict';
/**
 * One-time OpenRouter key consolidation (Jarvis v1.0.7) — .env becomes the ONLY
 * source of truth, as OPENROUTER_KEY_1 / _2 / _3 (…_16):
 *
 *   1. Seeds: settings-store keys (entered via the old Settings UI) first, then
 *      legacy env aliases (OPENROUTER_API_KEYS csv, OPENROUTER_API_KEY/OPENROUTER_KEY).
 *   2. Missing canonical slots are appended to .env (values written straight from
 *      memory — never logged, never printed).
 *   3. Legacy alias lines in .env that were folded are commented out with a
 *      '# migrated ->' marker (recoverable); settings-store keys are PURGED
 *      (encrypted store saved without them).
 *
 * Idempotent: once slots 1..3 exist and no settings keys remain, this is a no-op.
 * All logging references counts/slot NAMES only — never secret material.
 */
const fs = require('fs');

function legacyEnvKeys(env = process.env) {
  const list = String(env.OPENROUTER_API_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const single = env.OPENROUTER_API_KEY || env.OPENROUTER_KEY;
  if (single) list.push(single.trim());
  return list;
}

function migrateEnvKeys({ settings, envFile, log } = {}) {
  const out = { migrated: 0, fromSettings: 0, fromLegacyEnv: 0, purgedSettings: false };
  try {
    const canonical = [];
    for (let n = 1; n <= 16; n++) {
      const v = process.env['OPENROUTER_KEY_' + n];
      if (v && v.trim()) canonical.push(v.trim());
    }
    const fromSettings = (settings && settings.data && settings.data.openrouter && Array.isArray(settings.data.openrouter.keys))
      ? settings.data.openrouter.keys.filter(Boolean).map((k) => String(k).trim()) : [];
    const fromLegacy = legacyEnvKeys();
    // priority: canonical > settings (UI-entered) > legacy aliases; dedup, cap 16 slots
    // policy: exactly 3 rotation slots; any extra folded keys are noted, not stored
    const all = [...new Set([...canonical, ...fromSettings, ...fromLegacy])].slice(0, 3);
    out.extraIgnored = Math.max(0, new Set([...canonical, ...fromSettings, ...fromLegacy]).size - all.length);
    out.fromSettings = fromSettings.length;
    out.fromLegacyEnv = fromLegacy.length;

    const deficit = all.length > canonical.length;
    if ((deficit || fromSettings.length) && envFile) {
      let raw = '';
      try { raw = fs.readFileSync(envFile, 'utf8'); } catch {}
      const lines = raw.split(/\r?\n/);
      const have = new Set();
      for (const l of lines) { const m = l.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/); if (m) have.add(m[1]); }
      // comment out folded legacy alias lines (once, recoverable)
      const LEGACY = ['OPENROUTER_API_KEYS', 'OPENROUTER_API_KEY', 'OPENROUTER_KEY'];
      const rewritten = lines.map((l) => {
        const m = l.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
        if (m && LEGACY.includes(m[1]) && !l.trimStart().startsWith('#')) {
          out.migrated++;
          return '# migrated -> ' + l.trimStart();
        }
        return l;
      });
      // append canonical slots that are missing
      let n = 1, appended = [];
      for (let i = 0; i < all.length && n <= 16; i++, n++) {
        const name = 'OPENROUTER_KEY_' + n;
        if (have.has(name)) continue;
        rewritten.push(`${name}=${all[i]}`);
        appended.push(name);
        have.add(name);
      }
      if (out.migrated || appended.length) {
        fs.writeFileSync(envFile, rewritten.join('\n').replace(/\n{3,}/g, '\n\n') + '\n', { mode: 0o600 });
        // refresh process.env so the keyring sees canonical slots this boot
        for (let i = 0; i < all.length && i < 16; i++) process.env['OPENROUTER_KEY_' + (i + 1)] = all[i];
        if (log) log.write('keys.migrated', { appendedSlots: appended.length, commentedLegacyLines: out.migrated, note: 'OpenRouter keys consolidated into .env (OPENROUTER_KEY_n)' });
      }
    }
    // purge settings-store keys — the store must stop being a key source
    if (fromSettings.length && settings && settings.data && settings.data.openrouter) {
      delete settings.data.openrouter.keys;
      settings.data.openrouter.migratedToEnv = true;
      try { settings.store.save(); } catch {}
      out.purgedSettings = true;
      if (log) log.write('keys.purgedFromSettings', { count: fromSettings.length });
    }
  } catch (e) {
    if (log) log.write('error', { message: 'key migration: ' + e.message });
  }
  return out;
}

module.exports = { migrateEnvKeys };
