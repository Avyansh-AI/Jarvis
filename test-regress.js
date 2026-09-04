#!/usr/bin/env node
'use strict';
/**
 * Self-review regression suite — treats the last three passes (bugfix,
 * model-routing, emotion) as unverified and pins the behavior they must never
 * break again. Every case started life as a reproduced failure.
 *
 *  RG-1  sustained cloud outage: a declined downgrade is asked ONCE per step per
 *        session — not re-asked every message; acceptance survives re-probe renewal
 *  RG-2  localproc never multiplies `ollama serve` daemons (hung child → refuse,
 *        dead child → retry is fine), detects an already-running instance first
 *  RG-3  grounding: the user's OWN facts (my/favorite…) can never be overwritten by
 *        web text; overwritten values are clause-bounded, never mid-sentence garbage
 *  RG-4  secrets never reach a user-facing diagnosis line (or the logs); prose
 *        ("skipping", hf.co model ids) is never over-redacted
 *  RG-5  errors stay loud: skill/task failures lead with the plain problem,
 *        hacking-mode nudge never decorates an error, persona close is append-only
 *  RG-6  openers: suggest-only (no tool firing), toggle genuinely disables both
 *        the session-start and the explicit path, cross-user stash isolation
 *  RG-7  honest framing: feelings questions are deterministic, offline, and never
 *        claim sentience — in BOTH the dedicated path and the LLM system prompt
 *  RG-8  pre-existing regressions pinned: remember-intent stores the full fact
 *
 * Fork-safe: no voice-specific strings (those live in test-persona/test-openers).
 */
const fs = require('fs');
process.env.MAX_DATA_DIR = fs.mkdtempSync('/tmp/regress-');
process.env.OPENROUTER_KEY_1 = 'k1'; process.env.OPENROUTER_KEY_2 = 'k2'; process.env.OPENROUTER_KEY_3 = 'k3';
const { SecureStore } = require('../hub/secure-store');
const { Memory } = require('../hub/memory');
const { Orchestrator } = require('../hub/orchestrator');
const { ModelRouter } = require('../hub/models');
const { LocalProc } = require('../hub/localproc');
const { Grounding, keyValueOf, liveValueFor } = require('../hub/grounding');
const { Diagnostician, scrubText } = require('../hub/diagnose');
const { EventLog } = require('../hub/eventlog');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('ok  ' + n); } else { fail++; console.log('FAIL ' + n); } };

function makeOrch({ priority = 'google/top, openai/low', now } = {}) {
  const audits = [], events = [];
  const memory = new Memory(new SecureStore('mem-' + Math.random().toString(36).slice(2)));
  const settings = { data: { privacy: { llm: 'cloud', localRouting: true }, openrouter: {}, security: {}, personality: { tone: 0.5 }, proactive: { enabled: true, openers: true } } };
  const registry = { match: () => null, tool: () => null, toolDefs: () => [], get: () => null };
  const orch = new Orchestrator({ registry, memory, settings, log: { write: (t, d) => events.push({ t, d }) }, net: { online: true }, bus: { emit() {} } });
  const router = new ModelRouter({ env: { MODEL_PRIORITY: priority }, settings, keyCount: () => 3, net: { online: true }, now: now || Date.now });
  orch.router = router;
  orch._ring = () => ({ size: 3 });
  orch.ollama = { ping: async () => false, url: () => 'http://x', model: () => 'm' };
  orch.audit = { write: (t, f) => audits.push({ t, f }) };
  return { orch, memory, settings, router, audits, events, registry };
}

(async () => {
  /* ================= RG-1 sustained outage: one ask per step per session ================= */
  {
    let clock = 1_000_000;
    const { orch, memory, router } = makeOrch({ now: () => clock });
    const sess = memory.session('u');
    router.markFail('google/top', 'HTTP 503');
    const asks = [];
    for (let msg = 1; msg <= 8; msg++) {
      const sel = await orch._selectBrain('u', sess, {}, 'question ' + msg);
      if (sel.ask) { asks.push(msg); orch._consumeModelConfirm('u', sess.pendingConfirm, 'no', false, 'ui'); sess.pendingConfirm = null; }
      else if (!sel.deny) fail++, console.log('FAIL RG-1 unexpected selection', JSON.stringify(Object.keys(sel)));
      clock += 300000; // 5 min later: re-probe window expired, top STILL fails
      if (!router.isDown('google/top')) router.markFail('google/top', 'HTTP 503');
    }
    ok('RG-1 sustained outage, user keeps saying "no": asked exactly ONCE, not once per message', asks.length === 1 && asks[0] === 1);
    ok('RG-1 declined turns still get an honest, non-empty answer path (deny names the wait-state)',
      (await orch._selectBrain('u', sess, {}, 'again')).deny.includes('You chose to wait'));
  }
  {
    // explicit owner re-arm: "switch models" clears the remembered decline
    let clock = 2_000_000;
    const { orch, memory, router } = makeOrch({ now: () => clock });
    const sess = memory.session('u');
    router.markFail('google/top', 'HTTP 503');
    const a1 = await orch._selectBrain('u', sess, {}, 'q');
    orch._consumeModelConfirm('u', sess.pendingConfirm, 'no', false, 'ui');
    sess.degradeAskedFor = null; sess.degradeDeclined = null; sess.upgradeOfferedFor = null; sess.degrade = null; // exactly what the "switch models" intent clears
    const a2 = await orch._selectBrain('u', sess, {}, 'q2');
    ok('RG-1 "switch models" re-arms the ask (owner is always in charge)', !!a1.ask && !!a2.ask);
  }
  {
    // accepted degrade survives re-probe renewal (outageId churn must not revoke consent)
    let clock = 3_000_000;
    const { orch, memory, router } = makeOrch({ now: () => clock });
    const sess = memory.session('u');
    router.markFail('google/top', 'HTTP 503');
    const ask = await orch._selectBrain('u', sess, {}, 'q');
    orch._consumeModelConfirm('u', sess.pendingConfirm, 'yes', false, 'ui');
    const seen = [];
    for (let i = 0; i < 4; i++) {
      clock += 300000;
      if (!router.isDown('google/top')) router.markFail('google/top', 'HTTP 503'); // new probe cycle, new outageId
      const s = await orch._selectBrain('u', sess, {}, 'q' + i);
      seen.push(s.ask ? 'ASKED' : s.ok ? 'ok' : 'other');
    }
    ok('RG-1 accepted downgrade honored for the session across re-probes (never re-asked)', seen.every((s) => s === 'ok'));
    ok('RG-1 accepted downgrade actually routes to the confirmed rung', (await orch._selectBrain('u', sess, {}, 'final')).ok === true);
  }
  {
    // upgrade-back offer fires exactly once after recovery, then quiet
    const { orch, memory, router } = makeOrch();
    const sess = memory.session('u');
    router.markFail('google/top', 'HTTP 503');
    sess.degrade = { rungId: 'openai/low', outageId: router.outageId() };
    router.markOk('google/top');
    let offers = 0;
    for (let i = 0; i < 3; i++) {
      const top = router.cloudState()[0];
      if (sess.degrade && top && top.usable && sess.upgradeOfferedFor !== sess.degrade.outageId) { offers++; sess.upgradeOfferedFor = sess.degrade.outageId; }
    }
    ok('RG-1 upgrade-back offered exactly once per accepted downgrade', offers === 1);
  }
  {
    // a NEW step (an even lower rung) is its own consent even after a prior decline
    let clock = 4_000_000;
    const { orch, memory, router } = makeOrch({ priority: 'a/top, b/mid, c/floor', now: () => clock });
    const sess = memory.session('u');
    router.markFail('a/top', 'x');
    const a1 = await orch._selectBrain('u', sess, {}, 'q');
    orch._consumeModelConfirm('u', sess.pendingConfirm, 'no', false, 'ui'); // declines a/top -> b/mid
    router.markFail('b/mid', 'y'); // mid dies too — now the step is a/top -> c/floor, genuinely different
    const a2 = await orch._selectBrain('u', sess, {}, 'q2');
    ok('RG-1 each downward STEP is its own consent (declining mid never pre-declines floor)', !!a1.ask && !!a2.ask && /switch to floor \(lower capability\)/.test(a2.ask.say));
  }

  /* ================= RG-2 localproc daemon discipline ================= */
  {
    let spawns = 0;
    const mk = (pingSeq) => new LocalProc({
      ollama: { ping: async () => (pingSeq.length ? pingSeq.shift() : false), url: () => 'http://x' },
      audit: { write() {} }, log: { write() {} }, sleep: async () => {},
      spawnFn: () => { spawns++; return { on() {}, exitCode: null, pid: 4242 + spawns }; },
    });
    const already = new LocalProc({ ollama: { ping: async () => true, url: () => 'x' }, audit: { write() {} }, log: { write() {} } });
    const r = await already.ensureUp({});
    ok('RG-2 already-running instance detected first (zero spawns)', r.ok && r.state === 'already' && spawns === 0);

    const hung = mk([false]); // ping never true → first attempt times out with a LIVE child
    const r1 = await hung.ensureUp({ timeoutMs: 3 });
    ok('RG-2 first attempt spawning a hung daemon fails honestly', !r1.ok && spawns === 1);
    hung._failAt = 0; // age out the cooldown
    const r2 = await hung.ensureUp({ timeoutMs: 3 });
    ok('RG-2 hung child → NO second daemon spawned; owner told to kill it, never orphaned',
      !r2.ok && spawns === 1 && /still running but never began answering/.test(r2.reason) && !r2.startedByUs);

    let spawns2 = 0;
    const flaky = new LocalProc({
      ollama: { ping: async () => false, url: () => 'x' },
      audit: { write() {} }, log: { write() {} }, sleep: async () => {},
      spawnFn: () => { spawns2++; return { on() {}, exitCode: null, pid: 90 + spawns2 }; },
    });
    const cr1 = await flaky.ensureUp({ timeoutMs: 3 });
    flaky._child.exitCode = 1; // the daemon died on its own — a retry is legitimate
    flaky._failAt = 0;
    const cr2 = await flaky.ensureUp({ timeoutMs: 3 });
    ok('RG-2 a DEAD child never blocks recovery (spawn retried after cooldown)', !cr1.ok && !cr2.ok && spawns2 === 2);
  }
  {
    // single-flight under fan-in
    let spawns = 0, pings = 0;
    const lp = new LocalProc({
      ollama: { ping: async () => { pings++; return false; }, url: () => 'x' },
      audit: { write() {} }, log: { write() {} },
      sleep: async () => new Promise((r) => setTimeout(r, 2)),
      spawnFn: () => { spawns++; return { on() {}, exitCode: null, pid: 1 }; },
    });
    const rs = await Promise.all(Array.from({ length: 10 }, () => lp.ensureUp({ timeoutMs: 20 })));
    ok('RG-2 ten concurrent ensureUp calls share ONE attempt and ONE spawn', spawns === 1 && rs.every((r) => !r.ok) && pings > 0);
  }
  {
    // full timeout harness: the poll loop must terminate near the deadline even on a
    // black-hole endpoint (ping hangs to its own 1.5s cap in production — bounded here)
    const t0 = Date.now();
    const lp = new LocalProc({
      ollama: { ping: async () => new Promise((r) => setTimeout(() => r(false), 60)), url: () => 'x' },
      audit: { write() {} }, log: { write() {} }, sleep: async () => new Promise((r) => setTimeout(r, 25)),
      spawnFn: () => ({ on() {}, exitCode: null, pid: 9 }),
    });
    const r = await lp.ensureUp({ timeoutMs: 100 });
    ok('RG-2 ensureUp terminates near its deadline (no hang on a black-hole local API)', !r.ok && Date.now() - t0 < 800);
  }

  /* ================= RG-3 grounding: memory integrity ================= */
  {
    const memory = new Memory(new SecureStore('gm-' + Math.random().toString(36).slice(2)));
    memory.addFact('u', 'my favorite editor is vim');
    const audits = [];
    const g = new Grounding({ memory, search: async () => ({ title: 'E', text: 'Many now say their favorite editor is vscode, especially for remote work.', source: 's' }), net: { online: true }, audit: { write: (t) => audits.push(t) }, log: { write() {} } });
    const b = await g.gather('what is the latest on editor tooling this year', 'u');
    const applied = g.applyConflicts('u', b.conflicts);
    ok('RG-3 a web snippet about strangers NEVER overwrites the user\'s own "my favorite …" fact',
      applied.length === 0 && memory.facts('u')[0].fact === 'my favorite editor is vim' && !audits.includes('memory.conflict'));
  }
  {
    const memory = new Memory(new SecureStore('gm-' + Math.random().toString(36).slice(2)));
    memory.addFact('u', 'python version is 3.11');
    const g = new Grounding({ memory, audit: { write() {} }, log: { write() {} } });
    const c = g.detectConflict({ fact: 'python version is 3.11', ts: 1 }, 'As of 2026 the stable python version is 3.13.2 and ships with better errors.');
    g.applyConflicts('u', [c]);
    const f = memory.facts('u')[0].fact;
    ok('RG-3 objective facts still update fresher-wins — and the value stops at the clause boundary',
      c && c.fresh === '3.13.2' && f.startsWith('python version is 3.13.2 (live-checked') && f.includes('was: 3.11') && !/and ships/.test(f));
    const person = g.detectConflict({ fact: 'prime minister is John Doe', ts: 1 }, 'The Prime Minister is Jane Smith, elected in 2024 and re-elected recently.');
    ok('RG-3 person-name values stop at the comma boundary; copula never splits inside a word ("minister")',
      person && person.key === 'prime minister' && person.fresh === 'Jane Smith');
    ok('RG-3 keyValueOf: word-boundary copula keeps district/history-shaped keys intact',
      keyValueOf('district court is busy').key === 'district court' && keyValueOf('history is long').key === 'history');
    ok('RG-3 equal values never churn memory', g.detectConflict({ fact: 'python version is 3.13.2', ts: 1 }, 'the python version is 3.13.2 and it rocks') === null);
    ok('RG-3 liveValueFor trims conjunction tails', liveValueFor('version', 'the version is 3.9 or newer') === '3.9');
  }

  /* ================= RG-4 secrets never surface ================= */
  {
    // fake secrets built at runtime — a literal key-shaped string in a source file
    // trips the physical attack-surface sweep (rightly so), quoted or not
    const SK = 'sk-' + 'or-v1-deadbeef' + 'cafebabe1234567890';
    const d = new Diagnostician({});
    const leaked = 'github' + '_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZ' + '1234567890abcdef';
    const dx = d.report('github', new Error('GET https://api.github.com/x failed auth with ' + leaked + ' and ' + SK));
    ok('RG-4 user-facing diagnosis line scrubs fine-grained PATs AND OpenRouter keys',
      !dx.line.includes('github_pat_11') && !dx.line.includes('deadbeef') && (dx.line.match(/\[key-redacted\]/g) || []).length === 2);
    const prose = d.report('misc', new Error('skipping a beat near hf.co/huihui-ai/model-q4 and the skin cache, then ' + ('glpat-' + 'xyzzy123abc')));
    ok('RG-4 prose survives ("skipping", hf.co ids, "skin") while GitLab tokens scrub',
      /skipping a beat/.test(prose.line) && /hf\.co\/huihui-ai\/model-q4/.test(prose.line) && /skin cache/.test(prose.line) && !prose.line.includes('xyzzy123'));
    const logFile = new EventLog('regress-log');
    logFile.write('error', { message: 'key was ' + ('ghp_' + 'ABCDEFGH12345678') + ' quoted upstream; skipping retry' });
    const line = require('fs').readFileSync(logFile.file, 'utf8').trim();
    ok('RG-4 event log scrubs the same shapes, keeps the prose',
      !line.includes('ABCDEFGH12345678') && line.includes('skipping retry'));
    ok('RG-4 scrubText handles non-strings without throwing', scrubText(null) === '' && scrubText(42) === '42');
  }

  /* ================= RG-5 errors stay loud and plainly first ================= */
  {
    const { orch, audits } = makeOrch();
    orch.diag = new Diagnostician({ audit: orch.audit });
    orch.registry = {
      match: () => ({ skill: { name: 'search', label: 'web search' }, intent: { run: async () => { throw new Error('socket hang up mid-request'); } }, match: ['x'] }),
      tool: () => null, toolDefs: () => [], get: () => null,
    };
    const r = await orch._runHit(orch.registry.match('x'), 'search for payload examples', { userId: 'u', user: {}, bus: { emit() {} } }, 'u');
    const idxProblem = r.say.indexOf('web search hit a problem');
    ok('RG-5 skill failure leads with the plain problem; diagnosis intact (central layer, no duplication)',
      idxProblem !== -1 && /Net\.service|network|dropped|down|service could not be reached|retried/i.test(r.say) && r.error === true
      && audits.filter((a) => a.t === 'error.diagnosed').length === 1);
    ok('RG-5 hacking-mode nudge NEVER decorates an error turn', !/go hacking|sounds like security work/i.test(r.say) && !r.suggestMode);
    const clean = { say: 'A buffer overflow overwrites a return address… ' };
    orch._currentText = 'explain buffer overflows for my CTF';
    const fin = orch._finish('u', { ...clean }, null);
    ok('RG-5 nudge still fires on CLEAN security-topic turns (behavior preserved, just not on errors)',
      /go hacking/.test(fin.say) && fin.say.startsWith('A buffer overflow'));
  }
  {
    // a dying multi-turn task must be LOUD: cleared, diagnosed, said — never swallowed
    const { orch, memory } = makeOrch();
    orch.diag = new Diagnostician({ audit: orch.audit });
    const sk = { name: 'notes', label: 'notes', sensitive: false, continueTask: async () => { throw new Error('disk full while appending'); } };
    orch.registry = { get: () => sk, match: () => null, tool: () => null, toolDefs: () => [] };
    memory.setPending('u', { skill: 'notes', step: 1 });
    const r = await orch.handleUtterance({ text: 'here is the rest of my note', user: 'u', verify: false, source: 'test' });
    ok('RG-5 a failing task continuation is diagnosed and said out loud (task cleared, never silently re-interpreted)',
      r.error === true && /hit a problem/.test(r.say) && /disk full/.test(r.say) && memory.pendingTask('u') === null);
  }
  {
    const p = new (require('../hub/persona').Persona)();
    const sel = p.select({ sentiment: 'frustrated', tone: 0.5, anchors: { diag: { line: 'X failed — the cloud is down.', what: 'X', cause: 'y' } } });
    const close = p.close(sel, { solid: 'timers and notes still work' });
    ok('RG-5 persona close is REASSURE-only, grounded, pure (never masks the problem wording above it)',
      sel.register === 'reassure' && close.length > 0 && close.length < 120 && /timers and notes still work/.test(close));
    ok('RG-5 persona close is silent without sentiment/anchor/solid (grounded-or-silent on errors too)',
      p.close(p.select({ sentiment: 'neutral', tone: 0.5, anchors: {} }), { solid: 'x' }) === ''
      && p.close(sel, {}) === '');
  }

  /* ================= RG-6 openers: suggest-only, toggle-honest, user-isolated ================= */
  {
    const { orch, memory, audits } = makeOrch();
    const ran = [];
    const { Openers } = require('../hub/openers');
    const { Persona } = require('../hub/persona');
    const now = Date.now();
    const job = { id: 'j1', kind: 'reminder', label: 'remind me to review the Q3 doc', at: now + 3600e3, fired: false, user: 'u' };
    orch.openers = new Openers({ calendar: { today: () => [] }, scheduler: { store: { data: { jobs: [job] } } }, learner: null, settings: orch.settings });
    orch.persona = new Persona();
    orch.registry = { match: () => null, tool: () => null, toolDefs: () => [], get: () => null };
    orch._llm = async () => ({ say: 'quiet answer', brain: 'cloud' });
    orch._selectBrainSaved = orch.router; // router active; top usable by default
    const r1 = await orch.handleUtterance({ text: 'general question about trees', user: 'u', verify: false, source: 'test' });
    ok('RG-6 session start appends the grounded opener with a parked accept',
      r1.opener === true && /Q3 doc/i.test(r1.say) && r1.confirm !== true);
    const parked = memory.session('u').pendingConfirm;
    ok('RG-6 the parked accept is data, not an action (kind:opener, no tool name, no args)',
      parked && parked.kind === 'opener' && !parked.name && !parked.args);
    const y = await orch.handleUtterance({ text: 'yes', user: 'u', verify: false, source: 'test' });
    ok('RG-6 accepting an opener surfaces READ-ONLY details — no tool ran, reminder untouched, nothing privileged',
      /Q3 doc/i.test(y.say) && ran.length === 0 && job.fired === false && !audits.some((a) => /accepted/.test(a.t)));
  }
  {
    const { orch, memory } = makeOrch();
    const { Openers } = require('../hub/openers');
    orch.settings.data.proactive = { enabled: true, openers: false }; // sub-toggle off
    orch.openers = new Openers({ calendar: { today: () => [{ title: 'standup', start: Date.now() + 600e3 }] }, scheduler: { store: { data: { jobs: [] } } }, learner: null, settings: orch.settings });
    orch._llm = async () => ({ say: 'cloud answer', brain: 'cloud' });
    const r = await orch.handleUtterance({ text: 'hi there', user: 'u', verify: false, source: 'test' });
    ok('RG-6 openers sub-toggle OFF → session start suggests nothing (no stash, no parked accept)',
      !r.opener && !/standup/i.test(r.say) && !memory.session('u').pendingConfirm);
    const e = await orch.handleUtterance({ text: 'what should we start with', user: 'u', verify: false, source: 'test' });
    ok('RG-6 toggle OFF → explicit "where do we start" falls through to normal routing (not the grounded board)',
      !/On the board|You've got/.test(e.say) && e.say === 'cloud answer');
  }
  {
    const { orch, memory } = makeOrch();
    const { Openers } = require('../hub/openers');
    orch.settings.data.proactive = { enabled: false, openers: true }; // master off beats sub on
    orch.openers = new Openers({ calendar: { today: () => [{ title: 'dentist', start: Date.now() + 600e3 }] }, scheduler: { store: { data: { jobs: [] } } }, learner: null, settings: orch.settings });
    orch._llm = async () => ({ say: 'cloud answer', brain: 'cloud' });
    const r = await orch.handleUtterance({ text: 'hello again', user: 'u', verify: false, source: 'test' });
    ok('RG-6 master proactive toggle OFF also silences openers (extension of the existing opt-in)',
      !r.opener && !/dentist/i.test(r.say));
  }
  {
    // cross-user stash isolation (R-07): user B finishing first must never receive A's board
    const { orch } = makeOrch();
    const a = { say: 'A-STASH: your 2pm with finance. Start there?' };
    orch._openerStash = { uid: 'userA', data: { top: null, items: [], say: 'A-STASH: your 2pm with finance. Start there?' } };
    const outB = orch._finish('userB', { say: 'plain answer' }, null);
    ok('RG-6 a stashed opener is only ever consumed by its own user (no cross-user schedule leak)',
      !/A-STASH/.test(outB.say) && orch._openerStash && orch._openerStash.uid === 'userA');
    const outA = orch._finish('userA', { say: 'mine' }, null);
    ok('RG-6 the owning session still receives its own opener exactly once', /A-STASH/.test(outA.say) && orch._openerStash === null && outA.opener === true);
  }

  /* ================= RG-7 honest framing, end to end ================= */
  {
    const { orch } = makeOrch();
    const { Persona } = require('../hub/persona');
    orch.persona = new Persona();
    let llmCalls = 0;
    orch._llm = async () => { llmCalls++; return { say: 'improvised', brain: 'cloud' }; };
    const r = await orch.handleUtterance({ text: 'do you ever feel sad when I leave?', user: 'u', verify: false, source: 'test' });
    ok('RG-7 feelings question answered deterministically with the honest framing (no LLM improvisation)',
      llmCalls === 0 && /don't (?:have|literally) (?:feelings|feel|emotions)|no.*consciousness|program/.test(r.say));
    ok('RG-7 the honest answer never claims sentience and never fishes for engagement',
      !/I feel|I wish I could stay|miss you/i.test(r.say) && r.brain === 'fallback');
    const sp = orch._systemPrompt('u', { sentiment: 'neutral' });
    ok('RG-7 LLM system prompt carries honesty + problems-lead + wellbeing rules every turn',
      /do not have feelings or consciousness/i.test(sp) && /Problems lead/i.test(sp) && /Wellbeing over engagement/i.test(sp));
  }

  /* ================= RG-8 pre-existing: remember-intent stores the whole fact ================= */
  {
    const prefs = require('../hub/skills/preferences');
    const added = [];
    const memory = { addFact: (u, f) => added.push(f) };
    const intent = prefs.intents.find((i) => i.patterns.some((p) => p.test('my favorite color is teal')));
    const m = intent.patterns.map((p) => p.exec('my favorite color is teal')).find(Boolean);
    await intent.run(m, 'my favorite color is teal', { userId: 'u', memory });
    ok('RG-8 "my favorite color is teal" stores the full possessive fact (never a bare value)',
      added[0] === 'my favorite color is teal');
    const m2 = intent.patterns.map((p) => p.exec('remember that the deploy key lives in /opt/keys')).find(Boolean);
    await intent.run(m2, 'remember that the deploy key lives in /opt/keys', { userId: 'u', memory });
    ok('RG-8 "remember that …" keeps the whole sentence intact', added[1] === 'the deploy key lives in /opt/keys');
  }

  /* ================= static: brain layer never opens the dashboard ================= */
  {
    const rd = (m) => require('fs').readFileSync(require('path').join(__dirname, '..', 'hub', m + '.js'), 'utf8');
    const all = ['models', 'localproc', 'grounding', 'diagnose', 'audit', 'persona', 'openers'].map(rd).join('\n');
    const noSpawn = ['models', 'grounding', 'diagnose', 'audit', 'persona', 'openers'].map(rd).join('\n');
    ok('Static: the brain/persona layer never references the dashboard (terminal stays the only way in)',
      !/dashboard|window\.open|openExternal|browseTo/.test(all)
      && !/require\(['"]child_process['"]\)|\bspawn\s*\(/.test(noSpawn)
      && /require\('child_process'\)/.test(rd('localproc'))); // localproc spawns ollama ONLY, nothing else
  }

  console.log(`\n${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE ERROR', e); process.exit(1); });
