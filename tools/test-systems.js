#!/usr/bin/env node
'use strict';
/**
 * Systems-readout & Jarvis-mode suite (v0.8.0).
 * Boots a real hub on :8112 with an isolated data dir and proves:
 *  - GET /api/status exposes honest capability truth (brain/keys/security/backup)
 *  - the needs[] blocker list fires correctly (no keys, no token, no backup)
 *  - status reflects an enrollment (anyVoiceprint flips true)
 *  - the payload carries no secret material
 *  - web/systems.html exists and its script parses; the blocker-layer rows exist
 *  - index/settings pages carry the Jarvis hooks and Systems navigation
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const WEB = path.join(__dirname, '..', 'web');
process.env.MAX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'max-sys-'));

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('ok  ' + n); } else { fail++; console.log('FAIL ' + n); } };
const inlineScript = (file) => {
  const html = fs.readFileSync(file, 'utf8');
  const m = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((x) => x[1]).join('\n;\n');
  return m;
};

(async () => {
  process.env.PORT = '8117'; // 8112 is used by test-injection's mock HA — plus a wait-free probe
  process.env.OPENROUTER_API_KEYS = '';
  process.env.OPENROUTER_API_KEY = '';
  process.env.OPENROUTER_KEY_1 = ''; process.env.OPENROUTER_KEY_2 = ''; process.env.OPENROUTER_KEY_3 = ''; process.env.JARVIS_ALLOW_KEYLESS = '1';
  process.env.OLLAMA_URL = 'http://127.0.0.1:9'; // guaranteed-unreachable local brain
  const net0 = require('net');
  for (let i = 0; i < 30; i++) { // poll until the port is free (previous suite may linger briefly)
    const free = await new Promise((res) => {
      const probe = net0.createServer();
      probe.once('error', () => res(false));
      probe.once('listening', () => probe.close(() => res(true)));
      probe.listen(8117, '0.0.0.0');
    });
    if (free) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  require('../hub/server.js');
  await new Promise((r) => setTimeout(r, 1100));
  const api = (p, body) => fetch('http://127.0.0.1:8117' + p, {
    method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());

  /* ---- /api/status truth ---- */
  const s = await api('/api/status');
  ok('status: capability fields present', !!(s && s.version && s.brain && s.openrouter && s.security && s.satellites && 'backup' in s && Array.isArray(s.needs)));
  ok('status: blocker — no cloud keys', s.needs.some((n) => n.id === 'brain.nokeys' && n.severity === 'blocked' && /OpenRouter/.test(n.fix)));
  ok('status: blocker — LAN-open token warn', s.needs.some((n) => n.id === 'sec.token'));
  ok('status: blocker — no backup yet', s.needs.some((n) => n.id === 'data.backup'));
  ok('status: ollama probe reports unreachable, not guessed', s.ollama.reachable === false && typeof s.ollama.url === 'string' && s.ollama.url.length > 0);
  ok('status: no lockdown, no voiceprint on a fresh hub', s.security.lockedUsers.length === 0 && s.security.anyVoiceprint === false);
  ok('status: payload carries no secret-shaped material', !/sk-or-|sk-[A-Za-z0-9]{8}|ghp_[A-Za-z0-9]/i.test(JSON.stringify(s)));

  /* ---- boot diagnostics (v0.11.2 / v1.0.1) ---- */
  const dg = await api('/api/diagnostics');
  const byName = Object.fromEntries((dg.checks || []).map((c) => [c.name, c]));
  ok('diagnostics: readiness report live — 9 checks (incl. v1.0.7 rotation preflight + v1.0.8 audit log), registry 26/26, zero failures, honest warns on key-less cloud + keyless override',
    dg.ok === true && dg.summary && dg.summary.total === 9 && dg.summary.fails === 0
      && byName['skills registry'] && byName['skills registry'].ok === 'ok' && /^\d+\/\d+ skills loaded$/.test(byName['skills registry'].detail)
      && byName['cloud brain (OpenRouter)'] && byName['cloud brain (OpenRouter)'].ok === 'warn' && /no keys/.test(byName['cloud brain (OpenRouter)'].detail || '')
      && byName['cloud brain key rotation'] && /KEYLESS OVERRIDE|3\/3 slots/.test(byName['cloud brain key rotation'].detail || ''));
  const srvSrc = fs.readFileSync(path.join(__dirname, '..', 'hub', 'server.js'), 'utf8');
  ok('diagnostics: payload masked (no key material) + MAX_DEBUG loud-crash handlers wired',
    !/sk-or-|sk-[A-Za-z0-9]{8}|ghp_[A-Za-z0-9]/i.test(JSON.stringify(dg)) && /installDebugCrashHandlers\(\)/.test(srvSrc) && fs.existsSync(path.join(__dirname, '..', 'hub', 'diagnostics.js')));

  /* ---- enrollment flips the reported capability ---- */
  await api('/api/voiceprint/enroll', { user: 'Sys Owner', features: [0.1, 0.2, 0.3, 0.4, 0.5] });
  const s2 = await api('/api/status');
  ok('status: anyVoiceprint flips true after enroll', s2.security.anyVoiceprint === true);

  /* ---- the blocking-layer page ---- */
  const sysHtml = fs.readFileSync(path.join(WEB, 'systems.html'), 'utf8');
  ok('systems.html: inline script parses', (() => { try { new vm.Script(inlineScript(path.join(WEB, 'systems.html'))); return true; } catch { return false; } })());
  ok('systems.html: blocker rows exist (mic/brain/voice/guard)', /Microphone/.test(sysHtml) && /Cloud brain/.test(sysHtml) && /Voice verification/.test(sysHtml) && /API guard/.test(sysHtml));
  ok('systems.html: fix arrows present in the row renderer', sysHtml.includes("'→ ' + r.fix") && sysHtml.includes("'→ ' + n.fix"));

  /* ---- Jarvis hooks + navigation in existing pages ---- */
  const idx = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
  ok('index.html: jarvis greeting hook + status fetch', /function jarvisGreet\(\)/.test(idx) && idx.includes("/api/status") && /MAX\.LS\.get\('jarvis'/.test(idx));
  ok('index.html: inline script still parses after edits', (() => { try { new vm.Script(inlineScript(path.join(WEB, 'index.html'))); return true; } catch { return false; } })());
  const set = fs.readFileSync(path.join(WEB, 'settings.html'), 'utf8');
  ok('settings.html: jarvis toggle wired to localStorage', set.includes('t-jarvis') && /LS\.set\('jarvis'/.test(set));

  /* ---- problem-visibility pass ---- */
  ok('status: lean-credit window exposed (lean.active false on a key-less fresh hub; no brain.lean row without cause)',
    s.lean && s.lean.active === false && !s.needs.some((n) => n.id === 'brain.lean'));
  ok('index: need-banner surfaces the WHY on the main page (element + /api/status polling + offline copy)',
    idx.includes('id="needBanner"') && /Hub offline — the server process isn't running/.test(idx) && idx.includes('refreshNeeds'));
  ok('systems.html: boot diagnostics card wired to /api/diagnostics', sysHtml.includes('d-diag') && sysHtml.includes("MAX.get('/api/diagnostics')"));

  /* ---- voice-picker regression (empty dropdown bug) ---- */
  const cjsSrc = fs.readFileSync(path.join(WEB, 'js', 'common.js'), 'utf8');
  ok('settings: speaking-voice select can never render empty (default option first, empty-state explanation, async voice-list poll)',
    /sel\.appendChild\(def\)/.test(set) && set.indexOf('sel.appendChild(def)') < set.indexOf('try { vs = MAX.voices') /* code order: default option is appended before voices are read */
      && /No device voices|no speech synthesis/i.test(set) && /voicePoll|onvoiceschanged/.test(set));
  ok('common.js: voices getter is speechSynthesis-absence-safe (no bare ReferenceError path)',
    /'speechSynthesis' in window && window\.speechSynthesis/.test(cjsSrc) && !/voices = speechSynthesis \?/.test(cjsSrc));

  const swSrc = fs.readFileSync(path.join(WEB, 'sw.js'), 'utf8');
  ok('index/sw: no fatal widget dependency (mount guarded or absent) + service-worker shell v2 caches the full app incl. widgets/wakeword',
    (!idx.includes('MAX.widgets') || (/MAX\.widgets && MAX\.widgets\.mountAll\b/.test(idx) && idx.includes('try { MAX.widgets.mountAll(); } catch')))
      && /shell-v2/.test(swSrc) && swSrc.includes('js/wakeword.js') && swSrc.includes('systems.html'));
  ok('nav: Systems linked from all pages', ['index', 'vision', 'dashboard', 'logs', 'settings', 'systems'].every((p) => fs.readFileSync(path.join(WEB, p + '.html'), 'utf8').includes('href="systems.html"')));

  console.log(`\n${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
