#!/usr/bin/env node
'use strict';
/**
 * Cross-feature SEAM regression suite (the full-regression mandate: bugs hide
 * where features overlap). Unit-level, offline, fault-injecting:
 *  S1  parked write-confirm wins over lean-window intent routing (ordering)
 *  S2  parked confirm wins in security/hacking mode too
 *  S3  learning-layer fault injection can never break a security gate response
 *  S4  _gate never consults the learning layer (static + runtime spy)
 *  S5  verification attempts are invisible to the learning layer (H-001 fix)
 *  S6  only "terminal" can open the dashboard — no skill/notify path around it
 *  S7  wake-word stress corpus (false-positive rate on speech-shaped negatives)
 *  S8  gesture-control default-off + screen-read visibility indicator intact
 *  S9  v0.7.1 mic/embed hardening markers present in index.html
 *  S10 parked confirm coexists with a busy session (turns, pending task) — once only
 *  S11 expired parked confirm never executes
 *  S12 lean window + sensitive skill intent → verify gate, not the tool-less LLM
 *  S13 lockdown state + learning hook: still metadata-only, gate still locked
 *  S14 B-01/M-01: second parked confirm REPLACES first — owner told, latest only
 *  S15 B-04/L-02: bare yes/no with nothing parked is answered, not hallucinated
 *  S16 B-05/L-03: no-auth-LAN metadata posture stays explicitly documented
 *  S17 F-04: real-registry routing — weather-forecast idiom beats encyclopedia search
 */
const fs = require('fs');
process.env.MAX_DATA_DIR = fs.mkdtempSync('/tmp/maxseam-');
process.env.MAX_FILES_ROOT = fs.mkdtempSync('/tmp/maxseam-files-');
process.env.OPENROUTER_KEY_1 = ''; process.env.OPENROUTER_KEY_2 = ''; process.env.OPENROUTER_KEY_3 = ''; process.env.JARVIS_ALLOW_KEYLESS = '1';
process.env.OLLAMA_URL = 'http://127.0.0.1:9';
const { Orchestrator } = require('../hub/orchestrator');
const { SecureStore } = require('../hub/secure-store');
const { Learner } = require('../hub/learn');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('ok  ' + n); } else { fail++; console.log('FAIL ' + n); } };

function makeWorld({ learner = null, sensitiveSkill = true } = {}) {
  const events = [];
  const ghCalls = [];
  const clockIntent = { patterns: [], run: async () => ({ say: "It's 10:00 AM." }) };
  const registry = {
    toolDefs: () => [{ name: 'github_merge_pr', description: 'merge pr', input_schema: { type: 'object', properties: { repo: { type: 'string' }, number: { type: 'integer' } }, required: ['repo', 'number'] } }],
    match: (t) => (/time/.test(t) ? { skill: { name: 'clock', sensitive: false }, intent: clockIntent, match: [t] } : (/github status/.test(t) ? { skill: { name: 'github', sensitive: true, personalData: true }, intent: clockIntent, match: [t] } : null)),
    tool: (name) => (name === 'github_merge_pr' ? {
      skill: { name: 'github', label: 'GitHub', sensitive: sensitiveSkill, personalData: true },
      run: async (args) => { ghCalls.push(args); return { say: 'merged' }; },
      schema: { type: 'object', properties: { repo: { type: 'string' }, number: { type: 'integer' } }, required: ['repo', 'number'] },
      sideEffect: 'write', confirm: 'always',
    } : null),
    get: (name) => ({ name, sensitive: name === 'github' }),
  };
  const memory = {
    _s: {}, session(id) { return (this._s[id] = this._s[id] || { turns: [], mode: null }); },
    contextFor: () => ({ facts: [], prefs: {} }), countIntent() {}, setPending() {}, addTurn() {},
    ensureUser: (id) => ({ id, prefs: {} }), pendingTask: () => null, clearPending() {},
  };
  const settings = { data: { assistantName: 'Max', privacy: { llm: 'local', learning: true }, personality: { tone: 0.5 }, skills: {} } };
  const orch = new Orchestrator({ registry, memory, settings, log: { write: (t, d) => events.push({ t, d }) }, net: { online: true }, bus: { emit() {}, on() {} }, learner });
  orch.ollama = { ping: async () => false, url() { return ''; }, model() { return ''; }, chat: async () => { throw new Error('ollama off'); } };
  return { orch, memory, registry, events, ghCalls };
}
const VERIFIED_CTX = () => ({ userId: 'U', user: { guest: false, kid: false }, verified: true, source: 'test' });

(async () => {
  /* S1: parked write-confirm executes via "yes" — even with the lean window + a competing intent pattern */
  {
    const { orch, registry, ghCalls } = makeWorld();
    orch._leanUntil = Date.now() + 60000; // lean window active (v0.9.1 intent-first routing in play)
    const entry = Object.assign(registry.tool('github_merge_pr'), { toolName: 'github_merge_pr' });
    const d = await orch._dispatchTool(entry, { repo: 'me/priv', number: 9 }, VERIFIED_CTX(), { sawUntrusted: false });
    ok('S1: github write parked with reason "always" under lean window', d.confirm && d.confirm.reason === 'always' && ghCalls.length === 0);
    orch.memory.session('U').pendingConfirm = { ...d.confirm.parked, exp: Date.now() + 60000 };
    const r = await orch.handleUtterance({ text: 'yes', user: 'U', verify: true, source: 'test' });
    ok('S1: "yes" executes the parked write once — lean-window intent routing cannot hijack it', ghCalls.length === 1 && /merged|did it/.test(r.say || ''));
  }

  /* S2: hacking-mode session + parked confirm — mode branch must not swallow the yes */
  {
    const { orch, registry, memory, ghCalls } = makeWorld();
    memory.session('U').mode = 'security';
    const entry = Object.assign(registry.tool('github_merge_pr'), { toolName: 'github_merge_pr' });
    const d = await orch._dispatchTool(entry, { repo: 'me/priv', number: 9 }, VERIFIED_CTX(), { sawUntrusted: false });
    memory.session('U').pendingConfirm = { ...d.confirm.parked, exp: Date.now() + 60000 };
    await orch.handleUtterance({ text: 'yes', user: 'U', verify: true, source: 'test' });
    ok('S2: parked confirm executes inside hacking mode (mode cannot defer it)', ghCalls.length === 1);
  }

  /* S3: learning-layer explosion does not touch gate answers or session state */
  {
    const badLearner = { signal: () => { throw new Error('learning exploded'); }, toneFor: (u, b) => b, applyCorrection: () => { throw new Error('x'); } };
    const { orch, memory, registry } = makeWorld({ learner: badLearner });
    const out = await orch.handleUtterance({ text: 'zz no match', user: 'U', verify: true, source: 'test' });
    ok('S3: utterance completes despite exploding learning signal', !!out.say && out.say.length > 0);
    ok('S3: session lastResolved still updated after learner crash (hook isolated)', !!memory.session('U').lastResolved && typeof memory.session('U').lastResolved.target === 'string');
    const gate = orch._gate(registry.tool('github_merge_pr').skill, { user: { guest: false, kid: false }, verified: false, userId: 'U', deny: (k) => ({ denied: k }), bus: null });
    ok('S3: sensitive gate still blocks after learner crash', !!(gate.blocked && gate.blocked.verify));
  }

  /* S4: _gate never consults the learning layer (static source assertion;
         runtime gate behavior under a hostile learner is covered by S3/S13) */
  {
    const src = require('fs').readFileSync('hub/orchestrator.js', 'utf8');
    const gateFn = src.slice(src.indexOf('_gate(skill, ctx)'), src.indexOf('async handleUtterance'));
    ok('S4: _gate source contains zero learning-layer references', !/learner|applyCorrection|toneFor/.test(gateFn));
  }

  /* S5 (H-001 regression): verification attempts invisible to learning */
  {
    const store = new SecureStore('learning-seam');
    const models = new SecureStore('models-seam');
    const settings = { data: { privacy: { learning: true, logRetentionDays: 30 } } };
    const learner = new Learner({ store, modelsStore: models, settings, log: { write() {} }, bus: { emit() {}, on() {} }, registry: { get: () => null } });
    const world = makeWorld({ learner });
    await world.orch.handleUtterance({ text: 'verify me quarantine zebra fjord 73', user: 'U', verify: true, source: 'test' });
    await world.orch.handleUtterance({ text: 'no i meant the bedroom light', user: 'U', verify: true, source: 'test' });
    const raw = JSON.stringify(store.data);
    ok('S5/H-001: passphrase words never land in the learning store (topics/corrections)', !raw.includes('zebra') && !(raw.includes('quarantine')));
    ok('S5: a correction after a verify turn finds no context to pair against', !store.data.corrections.U);
  }

  /* S6: only "terminal" can open the dashboard */
  {
    const srcT = require('fs').readFileSync('hub/skills/terminal.js', 'utf8');
    const termPath = srcT.includes('dashboard.html');
    const others = require('fs').readdirSync('hub/skills').filter((f) => f.endsWith('.js') && !['registry.js', 'terminal.js'].includes(f))
      .filter((f) => require('fs').readFileSync('hub/skills/' + f, 'utf8').includes('dashboard.html'));
    const serverSrc = require('fs').readFileSync('hub/server.js', 'utf8');
    const notifyOpensDashboard = /broadcast\(\{[^}]*type: '(notify|alert)'[^}]*dashboard/.test(serverSrc);
    ok('S6: terminal is the only skill path to the dashboard; no notify broadcast opens it', termPath && others.length === 0 && !notifyOpensDashboard);
  }

  /* S7: wake-word stress corpus (JARVIS fork: "jarvis" is the trigger; "max" is retired) */
  {
    const WW = require('../web/js/wakeword.js');
    const w = (s) => WW.match(s).wake;
    const mustWake = ['jarvis', 'hey jarvis', 'ok jarvis', 'hello jarvis', 'JARVIS what time is it', 'hey', 'hi', 'hello'];
    const mustNot = ['jarv', 'jarvisor', 'hey there friend', 'ok', 'okay', 'max', 'hey max', 'starmax radio', 'mac check', 'the plan', ''];
    const deliberate = ['say hi to jarvis', 'ask jarvis about the lights', 'jarvis, lower the blinds']; // name-as-word wake — pinned as intentional tuning (see test-features)
    ok('S7 [fork]: all required wake phrases trigger', mustWake.every(w));
    ok('S7 [fork]: speech-shaped negatives do NOT trigger (incl. retired "max")', mustNot.every((x) => !w(x)));
    ok('S7 [fork]: deliberate mid-sentence-"jarvis" tuning still pins as wake (documented trade-off)', deliberate.every(w));
  }

  /* S8: gesture default-off + screen-read visibility indicator */
  {
    const { loadSettings } = require('../hub/settings');
    const st = loadSettings();
    const fs2 = require('fs');
    const idx = fs2.readFileSync('web/index.html', 'utf8') + fs2.readFileSync('web/vision.html', 'utf8');
    ok('S8: gestureControl + screenRead default OFF (v0.9-era regressions)', st.data.features.gestureControl === false && st.data.features.screenRead === false);
    ok('S8: screen-reading has an on-screen visibility indicator marker (screenShare/LS-gated)', /screenShare/.test(idx));
  }

  /* S9: v0.7.1 mic/embed hardening markers */
  {
    const idx = require('fs').readFileSync('web/index.html', 'utf8');
    ok('S9: index.html keeps permissionsPolicy detection, embed-mic message and the stuck-listening watchdog',
      /permissionsPolicy|featurePolicy/.test(idx) && /embedded preview has no microphone permission/i.test(idx) && /watchdog/i.test(idx));
  }

  /* S10: parked confirm coexists with busy session state */
  {
    const world = makeWorld();
    const sess = world.memory.session('U');
    sess.mode = null; sess.turns = Array(50).fill({ role: 'user', text: 'x' }); sess.suggestMode = 'security';
    world.memory.setPending('U', { skill: 'clock', step: 1 });
    const entry = Object.assign(world.registry.tool('github_merge_pr'), { toolName: 'github_merge_pr' });
    const d = await world.orch._dispatchTool(entry, { repo: 'me/priv', number: 21 }, VERIFIED_CTX(), { sawUntrusted: false });
    sess.pendingConfirm = { ...d.confirm.parked, exp: Date.now() + 60000 };
    await world.orch.handleUtterance({ text: 'yes', user: 'U', verify: true, source: 'test' });
    await world.orch.handleUtterance({ text: 'yes', user: 'U', verify: true, source: 'test' });
    ok('S10: busy session does not duplicate or lose the parked write — exactly one execution', world.ghCalls.length === 1);
  }

  /* S11: expired parked confirm never executes */
  {
    const world = makeWorld();
    const entry = Object.assign(world.registry.tool('github_merge_pr'), { toolName: 'github_merge_pr' });
    const d = await world.orch._dispatchTool(entry, { repo: 'me/priv', number: 22 }, VERIFIED_CTX(), { sawUntrusted: false });
    world.memory.session('U').pendingConfirm = { ...d.confirm.parked, exp: Date.now() - 1000 }; // already expired
    await world.orch.handleUtterance({ text: 'yes', user: 'U', verify: true, source: 'test' });
    ok('S11: expired confirmation prompt cannot be yes-ed into execution', world.ghCalls.length === 0);
  }

  /* S12: lean window + sensitive intent → verify gate (not the tool-less lean brain) */
  {
    const world = makeWorld();
    world.orch._leanUntil = Date.now() + 60000;
    let llmCalled = false;
    world.orch._llm = async () => { llmCalled = true; return { say: 'lean', brain: 'cloud-lean' }; };
    const out = await world.orch.handleUtterance({ text: 'github status', user: 'U', verify: false, source: 'http' });
    ok('S12: sensitive intent verifies first even under the lean window; tool-less brain never spoofed an answer', out.verify === true && llmCalled === false);
  }

  /* S13: lockdown + learning hook coexist — gate locked, learning metadata-only */
  {
    const store2 = new SecureStore('learning-seam2');
    const learner2 = new Learner({ store: store2, modelsStore: new SecureStore('models-seam2'), settings: { data: { privacy: { learning: true, logRetentionDays: 30 } } }, log: { write() {} }, bus: { emit() {}, on() {} }, registry: { get: () => null } });
    const world = makeWorld({ learner: learner2 });
    world.orch.isLockedDown = () => 900; // 15 min freeze
    const out = await world.orch.handleUtterance({ text: 'github status', user: 'U', verify: false, source: 'http' });
    ok('S13: lockdown freeze text surfaces; learning only captured metadata (skill name) not the exchange',
      /frozen/i.test(out.say || '') && !JSON.stringify(store2.data).includes('github status'));
  }

  /* S14 (BUGS_MASTER B-01 / backlog M-01): second parked confirm REPLACES the first —
     the owner is told in the spoken prompt, and only the latest can ever execute */
  {
    const world = makeWorld();
    const first = { name: 'github_merge_pr', args: { repo: 'me/priv', number: 31 }, at: Date.now() };
    const second = { name: 'github_close_issue', args: { repo: 'me/priv', number: 32 }, at: Date.now() };
    const note1 = world.orch._parkConfirm('U', first);
    const note2 = world.orch._parkConfirm('U', second);
    ok('S14: first park silent, second park speaks the replacement notice naming the cancelled action',
      note1 === '' && /replaces my earlier question about github merge pr/i.test(note2) && /cancelled/i.test(note2));
    // the dropped first action must be un-executable: "yes" runs only number 32
    world.registry.tool = (n) => (n === 'github_close_issue' ? {
      skill: { name: 'github', label: 'GitHub', sensitive: true, personalData: true },
      run: async (args) => { world.ghCalls.push(args); return { say: 'closed' }; },
      schema: { type: 'object', properties: { repo: { type: 'string' }, number: { type: 'integer' } }, required: ['repo', 'number'] },
      sideEffect: 'write', confirm: 'always',
    } : null);
    const r = await world.orch.handleUtterance({ text: 'yes', user: 'U', verify: true, source: 'test' });
    ok('S14: "yes" executes ONLY the latest parked action — the replaced one can never fire (fail-closed, and now noticed)',
      world.ghCalls.length === 1 && world.ghCalls[0].number === 32 && /closed|did it/.test(r.say || ''));
  }

  /* S15 (BUGS_MASTER B-04 / backlog L-02): bare yes/no with nothing parked — answered, never hallucinated */
  {
    const world = makeWorld();
    const r1 = await world.orch.handleUtterance({ text: 'yes', user: 'U', verify: true, source: 'test' });
    const r2 = await world.orch.handleUtterance({ text: 'no', user: 'U', verify: true, source: 'test' });
    ok('S15: bare yes/no with nothing parked is told there is nothing to confirm (restart-clear guidance included)',
      /nothing waiting for a yes or no/i.test(r1.say || '') && /cleared for safety/i.test(r1.say || '') && /nothing waiting/i.test(r2.say || ''));
    // expired prompt + "yes": same honest answer, zero execution
    world.memory.session('U').pendingConfirm = { name: 'github_merge_pr', args: { repo: 'me/priv', number: 40 }, exp: Date.now() - 1 };
    const r3 = await world.orch.handleUtterance({ text: 'yes', user: 'U', verify: true, source: 'test' });
    ok('S15: expired/dropped prompt surfaces the cleared-for-safety explanation and executes nothing',
      /nothing waiting/i.test(r3.say || '') && /restart|cleared/i.test(r3.say || '') && world.ghCalls.length === 0);
  }

  /* S16 (BUGS_MASTER B-05 / backlog L-03): the no-auth-LAN metadata posture stays explicitly documented */
  {
    const sec = fs.readFileSync(__dirname + '/../SECURITY.md', 'utf8');
    const rdm = fs.readFileSync(__dirname + '/../README.md', 'utf8');
    ok('S16: SECURITY.md + README.md explicitly state /api/learn and /api/github/status metadata is LAN-visible when MAX_TOKEN is unset',
      /\/api\/learn/.test(sec) && /\/api\/github\/status/.test(sec) && /LAN/.test(sec) && /metadata/i.test(sec) && /MAX_TOKEN/.test(sec) && /\/api\/learn/.test(rdm) && /\/api\/github\/status/.test(rdm));
  }

  /* S17 (fresh-hunt F-04): with search.js fixed, the REAL registry must route the
     "what is the weather …" idiom to the weather skill, while genuine concept
     questions still land in encyclopedia search. Uses the actual skills dir —
     no stubs — so load-order/shadowing regressions fail loudly here. */
  {
    const { Registry } = require('../hub/skills/registry');
    const reg = new Registry({ data: { skills: {} } }, { write() {} });
    reg.load(require('path').join(__dirname, '..', 'hub', 'skills'));
    const skillOf = (t) => { const m = reg.match(t); return m ? m.skill.name : null; };
    ok('S17: "what is the weather like / in Paris / today" routes to the weather skill (not search)',
      skillOf('what is the weather like') === 'weather' && skillOf('what is the weather in Paris') === 'weather' && skillOf('what is the weather today') === 'weather' && skillOf('what is the forecast for tomorrow') === 'weather');
    ok('S17: concept questions still reach encyclopedia search (of-the-sun, weatherman, capitals, northern lights)',
      skillOf('what is the temperature of the sun') === 'search' && skillOf('who is the weatherman') === 'search' && skillOf('what is the capital of France') === 'search' && skillOf('what are the northern lights') === 'search');
    ok('S17: pre-existing bare idioms unchanged (weather, clock, news)',
      skillOf('weather') === 'weather' && skillOf('what time is it') === 'clock' && skillOf('top headlines') === 'search');
  }

  console.log(`\n${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
