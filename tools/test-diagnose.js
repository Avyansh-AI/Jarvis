#!/usr/bin/env node
'use strict';
/**
 * Brain layer suite A — central error diagnosis, tamper-evident audit log,
 * recurring-issue memory, and unified memory+search grounding.
 *
 * Proves:
 *  audit:    hash-chain write/verify; tamper at any position breaks AT that line;
 *            rotation anchors keep the chain; secrets scrubbed; dead disk never throws
 *  diagnose: every infra failure classifies to what/cause/action — key rotation,
 *            credit clamp, model 404, provider outage, unreachable, GitHub "update
 *            it in .env" (the brief's exact example), HA auth/unreachable, Ollama
 *            down/missing, generic. All land in the audit log.
 *  memory:   recurring INFRA issues are remembered device-wide (never per-user
 *            preferences) and the diagnosis SAYS SO at the threshold — instead of
 *            rediscovering it each day. Learning layer is provably untouched.
 *  grounding: fresh-sensitive detection; question-relevant memory recall; the live
 *            search snippet joins the prompt with the fresher source marked
 *            authoritative; deterministic conflicts prefer the fresher value and
 *            REWRITE the stored fact with provenance + audit; non-conflicts leave
 *            memory alone; search failure never blocks an answer.
 */
const fs = require('fs');
process.env.MAX_DATA_DIR = fs.mkdtempSync('/tmp/maxdiag-');
const { SecureStore } = require('../hub/secure-store');
const { AuditLog } = require('../hub/audit');
const { Diagnostician, RECUR_MIN } = require('../hub/diagnose');
const { Memory } = require('../hub/memory');
const { Grounding } = require('../hub/grounding');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('ok  ' + n); } else { fail++; console.log('FAIL ' + n); } };

function makeDiag() {
  const auditRows = [];
  const audit = { write: (t, f) => auditRows.push({ t, f }) };
  const logs = [];
  const store = new SecureStore('diag-' + Math.random().toString(36).slice(2));
  const d = new Diagnostician({ store, log: { write: (t, f) => logs.push({ t, f }) }, audit });
  return { d, auditRows, logs, store };
}

(async () => {
  /* ---------- audit log ---------- */
  {
    const dir = fs.mkdtempSync('/tmp/audit-');
    process.env.MAX_DATA_DIR = dir;
    const a = new AuditLog({ name: 'a1', dir });
    for (let i = 0; i < 5; i++) a.write('error.diagnosed', { scope: 'openrouter', i });
    const v = a.verify();
    ok('audit: clean chain verifies (ok, all 5 lines)', v.ok && v.lines === 5 && v.brokenAt === null);
    // tamper: rewrite the middle record's payload
    const file = dir + '/a1.jsonl';
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    const rec = JSON.parse(lines[2]); rec.scope = 'TAMPERED';
    lines[2] = JSON.stringify(rec); fs.writeFileSync(file, lines.join('\n') + '\n');
    const v2 = new AuditLog({ name: 'a1', dir }).verify();
    ok('audit: editing one field breaks the chain at exactly that line', !v2.ok && v2.brokenAt === 3 && /MAC/.test(v2.reason));
    // deletion breaks too
    lines.splice(2, 1); fs.writeFileSync(file, lines.join('\n') + '\n');
    const v3 = new AuditLog({ name: 'a1', dir }).verify();
    ok('audit: deleting a line breaks the chain link', !v3.ok && v3.brokenAt !== null);
  }
  {
    process.env.MAX_DATA_DIR = fs.mkdtempSync('/tmp/audit2-');
    const ad2 = process.env.MAX_DATA_DIR; const a = new AuditLog({ name: 'a2', dir: ad2 });
    const FAKE_KEY = ['sk', 'or-v1-ABCDEF123456'].join('-'); // built at runtime: repo credential audit must never see a key-shaped literal
    a.write('error.diagnosed', { note: 'bearer ' + FAKE_KEY + ' trailing', text: 'raw transcript should vanish anyway' });
    const raw = fs.readFileSync(process.env.MAX_DATA_DIR + '/a2.jsonl', 'utf8');
    ok('audit: secret-shaped strings scrubbed, raw text never written', raw.includes('[key-redacted]') && !raw.includes(FAKE_KEY) && !raw.includes('raw transcript'));
    // forced rotation via a tiny test cap: many records roll the segment, anchor re-roots
    const aR = new AuditLog({ name: 'a2r', dir: ad2, cap: 1200 });
    for (let i = 0; i < 40; i++) aR.write('filler', { i, note: 'rotation roll' });
    const rolled = fs.existsSync(ad2 + '/a2r.jsonl.1');
    const anchor = fs.readFileSync(ad2 + '/a2r.jsonl', 'utf8').split('\n')[0];
    const vR = new AuditLog({ name: 'a2r', dir: ad2, cap: 1200 }).verify();
    ok('audit: segment rotation keeps the new chain verifiable via anchor', rolled && anchor.includes('audit.anchor') && vR.ok);
  }
  {
    // dead-disk posture: existing but UNWRITABLE dir → console-only, never throws
    const ro = fs.mkdtempSync('/tmp/rodir-'); fs.chmodSync(ro, 0o500);
    let threw = false;
    try { const a = new AuditLog({ name: 'a3', dir: ro }); a.write('x', { y: 1 }); } catch { threw = true; }
    fs.chmodSync(ro, 0o700);
    ok('audit: dead disk degrades to console-only without throwing', !threw);
  }

  /* ---------- diagnosis rules ---------- */
  {
    const { d, auditRows } = makeDiag();
    const github = d.report('github', { status: 401, message: 'HTTP 401' }, { user: 'U' });
    ok('diagnose: GitHub 401 says what broke + the brief’s exact user action (.env)',
      /GitHub rejected/.test(github.line) && /expired/.test(github.line) && /update it in \.env/.test(github.line) && /GH_TOKEN/.test(github.line));
    const rot = d.report('openrouter', { status: 401, message: 'OpenRouter HTTP 401' });
    ok('diagnose: key rejection names the automatic handling (rotate) + the .env escape hatch',
      /rejected a rotation key/.test(rot.line) && /rotated to the next key automatically/.test(rot.line) && /OPENROUTER_KEY_1\/2\/3 in \.env/.test(rot.line));
    const cr = d.report('openrouter', { status: 402, tokenLimit: 100, tokenKind: 'prompt' });
    ok('diagnose: credit cap explains the lean clamp + where to add credit', /out of usable credit/.test(cr.line) && /lean credit window/.test(cr.line) && /openrouter\.ai\/settings\/credits/.test(cr.line));
    const rl = d.report('openrouter', { status: 429, message: 'OpenRouter HTTP 429' });
    ok('diagnose: rate limit is automatic (rotate+retry), no user action asked', /rate-limited/.test(rl.line) && /rotated keys and retried/.test(rl.line) && !/To fix it/.test(rl.line));
    const m404 = d.report('openrouter', { status: 404, message: 'OpenRouter HTTP 404' });
    ok('diagnose: dead model id tells the owner to pick a live one (.env)', /model is gone/.test(m404.line) && /OPENROUTER_MODEL/.test(m404.line));
    const out5 = d.report('openrouter', { status: 503, message: 'OpenRouter HTTP 503' });
    ok('diagnose: provider outage announces the local fallback', out5.action.kind === 'fallback-local' && /outage/.test(out5.line));
    const unr = d.report('openrouter', { message: 'fetch failed: ENOTFOUND openrouter.ai' });
    ok('diagnose: unreachable names network/DNS cause + fix', /unreachable/.test(unr.line) && /internet connection/.test(unr.line));
    const ol = d.report('ollama', { reason: 'Ollama is not installed on this machine (no `ollama` binary)' });
    ok('diagnose: local model down says install/serve plainly', /not installed/.test(ol.line) && /ollama\.com/.test(ol.line));
    const ha = d.report('home-assistant', { status: 401, message: 'HTTP 401' });
    ok('diagnose: HA auth failure points at HA_TOKEN in .env', /Home Assistant rejected/.test(ha.line) && /HA_TOKEN/.test(ha.line));
    const gen = d.report('notes', new Error('disk wobbly'));
    ok('diagnose: unknown failure still gets a concrete what+cause (never a bare "error")', /notes failed/i.test(gen.line) && /disk wobbly/.test(gen.line));
    ok('diagnose: every report lands in the audit chain as error.diagnosed', auditRows.filter((r) => r.t === 'error.diagnosed').length >= 10 && auditRows.every((r) => r.f.key));
  }

  /* ---------- recurring infrastructure memory ---------- */
  {
    const { d, store } = makeDiag();
    let last;
    for (let i = 0; i < RECUR_MIN + 1; i++) last = d.report('ollama', { reason: 'down' }, { user: 'U' });
    ok(`memory: failure #${RECUR_MIN} of a kind becomes a remembered pattern`, last.remembered === true && last.count >= RECUR_MIN);
    ok('memory: the line SAYS the pattern is on record (proactive, not rediscovered)', /failure #\d+ of this kind since/.test(last.line) && /on record/.test(last.line));
    ok('memory: recurrence persists device-wide in the encrypted store (keyed by issue)', JSON.stringify(store.data.issues).includes('ollama.down'));
    const fresh = new Diagnostician({ store, log: { write() {} }, audit: { write() {} } });
    const again = fresh.report('ollama', { reason: 'down' });
    ok('memory: pattern survives process restart (reloaded store still remembers)', again.count > RECUR_MIN && again.remembered);
  }

  /* ---------- grounding: unified memory + live search ---------- */
  {
    const mem = new Memory(new SecureStore('mem-g'));
    mem.addFact('U', 'python version is 3.11');
    mem.addFact('U', 'my favorite editor is neovim');
    const audits = [];
    const g = new Grounding({
      memory: mem, net: { online: true },
      audit: { write: (t, f) => audits.push({ t, f }) }, log: { write() {} },
      search: async (q) => ({ title: 'Python (programming language)', source: 'Wikipedia', text: 'Python is a programming language. The python version is 3.13, released October 2025.' }),
    });
    ok('grounding: fresh-sensitive detector (latest/current/version/2026)', g.freshSensitive('what is the latest python version') && g.freshSensitive('who is the current prime minister') && !g.freshSensitive('what is recursion'));
    const rel = g.relevantFacts('U', 'what python version should I use');
    ok('grounding: memory recall is question-relevant (python fact hits, editor fact does not)',
      rel.length === 1 && rel[0].fact.includes('python'));
    const bundle = await g.gather('what is the latest python version', 'U');
    ok('grounding: BOTH sources gathered for a fresh question (memory AND live search)', bundle.memoryFacts.length === 1 && !!bundle.live && bundle.live.title.includes('Python'));
    ok('grounding: deterministic conflict detected (stored 3.11 vs live 3.13)', bundle.conflicts.length === 1 && bundle.conflicts[0].stored === '3.11' && bundle.conflicts[0].fresh.startsWith('3.13'));
    const applied = g.applyConflicts('U', bundle.conflicts);
    const facts = mem.facts('U').map((f) => f.fact);
    ok('grounding: fresher wins — memory rewritten with provenance (was: …), audited fresher-wins',
      applied.length === 1 && facts.some((f) => f.includes('3.13') && f.includes('was: 3.11')) && !facts.some((f) => /python version is 3\.11$/.test(f)) && audits.some((a) => a.t === 'memory.conflict' && a.f.rule === 'fresher-wins'));
    const section = g.promptSection(bundle);
    ok('grounding: prompt labels both sources, fresher marked authoritative', /could be stale/.test(section) && /fetched just now/.test(section) && /TRUST THIS/.test(section));
  }
  {
    // non-conflict: live agrees with memory → nothing rewritten; agreement path
    const mem = new Memory(new SecureStore('mem-g2'));
    mem.addFact('U', 'python version is 3.13');
    const g = new Grounding({ memory: mem, net: { online: true }, audit: { write() {} }, log: { write() {} }, search: async () => ({ title: 'Python', text: 'The python version is 3.13 now.' }) });
    const bundle = await g.gather('latest python version', 'U');
    ok('grounding: agreement is not a conflict (memory untouched)', bundle.conflicts.length === 0 && mem.facts('U')[0].fact === 'python version is 3.13');
    // unparsable facts never break gather
    mem.addFact('U', 'I once saw a really nice garden in spring');
    const b2 = await g.gather('latest python version', 'U');
    ok('grounding: prose facts are left alone (conservative conflict rule)', b2.conflicts.length === 0);
    // offline: no live call, memory still gathered
    const gOff = new Grounding({ memory: mem, net: { online: false }, audit: { write() {} }, log: { write() {} }, search: async () => { throw new Error('should not be called'); } });
    const bOff = await gOff.gather('latest python version', 'U');
    ok('grounding: offline never calls search, still returns memory bundle', bOff.live === null && bOff.freshSensitive === true);
    // search failure: never blocks the answer
    const gFail = new Grounding({ memory: mem, net: { online: true }, audit: { write() {} }, log: { write() {} }, search: async () => { throw new Error('wiki down'); } });
    const bFail = await gFail.gather('latest python version', 'U');
    ok('grounding: search failure degrades quietly (live:null), answer path unaffected', bFail.live === null);
  }

  /* ---------- learning layer is untouched by diagnosis memory ---------- */
  {
    const { d, store } = makeDiag();
    for (let i = 0; i < 5; i++) d.report('openrouter', { status: 500 });
    const { Learner } = require('../hub/learn');
    const learnStore = new SecureStore('learn-diag');
    const learner = new Learner({ store: learnStore, modelsStore: new SecureStore('lm-diag'), settings: { data: { privacy: {} } }, log: { write() {} }, bus: { emit() {}, on() {} } });
    learner.signal({ user: 'U', skill: 'chat' });
    ok('isolation: infra recurrence memory never enters learning signals/models',
      !JSON.stringify(learnStore.data).includes('openrouter.outage') && !JSON.stringify(learner.state('U').prefs).includes('openrouter') && learner.state('U').signals.total === 1);
    ok('isolation: diagnostics store holds no personal preference keys', !JSON.stringify(store.data).match(/favorite|tone|pref/i));
  }

  console.log(`\n${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
