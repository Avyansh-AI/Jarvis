'use strict';
/** Boot readiness report + debug mode.
 *
 * The hardening rounds made startup *fail gracefully* — great for a running
 * assistant, terrible when you need to see WHY something is off. This module
 * makes startup state explicit instead of silent:
 *
 *   - every boot subsystem records exactly one check line (ok / warn / fail)
 *   - the consolidated report prints at listen time as `[boot] ✓/⚠/✗ …`
 *   - GET /api/diagnostics exposes it live (masked: counts and names only —
 *     no key material, no tokens, no paths outside the product)
 *   - MAX_DEBUG=1 prints full detail on every line and installs loud crash
 *     handlers, so exceptions are fatal & stack-traced instead of swallowed.
 */
const DEBUG = process.env.MAX_DEBUG === '1';

const checks = [];
/** record(name, ok, detail?, err?) — ok: true | false | 'warn'. Returns the entry. */
function record(name, ok, detail, err) {
  const entry = { name, ok: ok === true ? 'ok' : ok === 'warn' ? 'warn' : 'fail' };
  if (detail != null && detail !== '') entry.detail = String(detail);
  if (err && DEBUG) entry.stack = String((err && err.stack) || err);
  checks.push(entry);
  return entry;
}

/** Snapshot copy for the /api/diagnostics route (callers can't mutate). */
function report() { return checks.map((c) => ({ ...c })); }

function summary() {
  const fails = checks.filter((c) => c.ok === 'fail').length;
  const warns = checks.filter((c) => c.ok === 'warn').length;
  return { total: checks.length, ok: checks.length - fails - warns, warns, fails };
}

function printReport(prefix = '[boot]', logger = console.log) {
  const icon = { ok: '✓', warn: '⚠', fail: '✗' };
  for (const c of checks) {
    // detail always shown for non-ok lines; in DEBUG it's shown for all lines
    logger(`${prefix} ${icon[c.ok]} ${c.name}` + (c.detail && (DEBUG || c.ok !== 'ok') ? ` — ${c.detail}` : ''));
    if (c.stack) console.error(c.stack);
  }
  const s = summary();
  logger(`${prefix} readiness: ${s.ok}/${s.total} ok` +
    (s.warns ? `, ${s.warns} warning${s.warns === 1 ? '' : 's'} (see ⚠)` : '') +
    (s.fails ? `, ${s.fails} FAILURE${s.fails === 1 ? '' : 'S'} (see ✗ — running degraded)` : ''));
}

/** MAX_DEBUG=1: every crash is loud with a full stack instead of graceful. */
function installDebugCrashHandlers() {
  if (!DEBUG) return;
  process.on('unhandledRejection', (e) => { console.error('[debug] unhandledRejection:', (e && e.stack) || e); });
  process.on('uncaughtException', (e) => { console.error('[debug] uncaughtException:', (e && e.stack) || e); process.exit(1); });
  console.log('[debug] MAX_DEBUG=1 — verbose boot diagnostics; exceptions are fatal & stack-traced');
}

module.exports = { record, report, summary, printReport, installDebugCrashHandlers, DEBUG };
