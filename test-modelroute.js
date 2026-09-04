#!/usr/bin/env node
'use strict';
/**
 * Brain layer suite B — model ladder selection with confirm-before-degrade,
 * hub-managed Ollama process, topic-triggered & outage-triggered local routing,
 * and the invariants those flows must never weaken.
 *
 * Proves:
 *  ladder:    MODEL_PRIORITY parsing (Gemini ids are OpenRouter rungs — there is no
 *             separate Gemini provider), default ladder, ollama floor, dedup/cap
 *  router:    down marks drive bestCloud; outageId stability; degrade detection is
 *             exactly "lower CLOUD tier" (key rotation and the local floor never ask)
 *  localproc: already-up / spawn-and-wait / ENOENT / exit-code / cooldown /
 *             single-flight — the hub manages `ollama serve` itself
 *  flows:     topic → local with the brief's announcement; local unstartable →
 *             consent is REQUIRED (never silent cloud); degrade ask names both
 *             models + wait option; yes = remembered for the WHOLE outage (no
 *             re-asking), each NEW step is its OWN consent; recovery offers the
 *             upgrade back exactly once; total outage → automatic local with the
 *             brief's announcement, honest dead-end when local can't start
 *  invariants: sensitive tools stay verify-gated under local routing; dashboard
 *             opening stays exclusive to the terminal skill; brain-layer code
 *             never references the dashboard
 */
const fs = require('fs');
process.env.MAX_DATA_DIR = fs.mkdtempSync('/tmp/maxroute-');
process.env.OPENROUTER_KEY_1 = 'k1'; process.env.OPENROUTER_KEY_2 = 'k2'; process.env.OPENROUTER_KEY_3 = 'k3';
process.env.OPENROUTER_API_KEYS = 'k1,k2,k3'; // legacy alias for the MAX-lineage keyring
const { SecureStore } = require('../hub/secure-store');
const { Memory } = require('../hub/memory');
const { Orchestrator } = require('../hub/orchestrator');
const { ModelRouter, parsePriority } = require('../hub/models');
const { LocalProc } = require('../hub/localproc');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('ok  ' + n); } else { fail++; console.log('FAIL ' + n); } };

/* ---------- builder: orchestrator with fully stubbed brain deps ---------- */
function makeOrch({ upResult = { ok: false, reason: 'no binary' }, priority = 'top-model, lower-model, ollama:local-m', keys = true } = {}) {
  const events = [], audits = [];
  const registry = {
    toolDefs: () => [], match: () => null,
    tool: () => null, get: (name) => ({ name, sensitive: name === 'desktop' }),
  };
  const memory = new Memory(new SecureStore('mem-' + Math.random().toString(36).slice(2)));
  const settings = { data: { assistantName: 'Test', privacy: { llm: 'cloud', localRouting: true, learning: false }, personality: { tone: 0.5 }, skills: {}, openrouter: { model: 'top-model' }, security: { model: 'local-m' }, proactive: { enabled: true } } };
  const orch = new Orchestrator({ registry, memory, settings, log: { write: (t, d) => events.push({ t, d }) }, net: { online: true }, bus: { emit() {}, on() {} }, learner: null });
  orch.ollama = { ping: async () => true, url: () => 'http://x', model: () => 'local-m', chat: async () => ({ content: 'local answer' }) };
  const router = new ModelRouter({ env: { MODEL_PRIORITY: priority }, settings, net: { online: true }, keyCount: () => (keys ? 3 : 0), ollama: orch.ollama });
  const diag = { report: (scope, err) => ({ key: scope + '.k', what: scope + ' failed', cause: String((err && (err.reason || err.message)) || 'x'), action: { kind: 'none' }, line: scope + ' diagnosed: ' + String((err && (err.reason || err.message)) || 'x') }) };
  const localProc = { ensureUp: async () => upResult };
  orch.attachBrain({
    diagnostician: diag, localProc, modelRouter: router,
    audit: { write: (t, f) => audits.push({ t, f }) }, grounding: null,
  });
  return { orch, memory, router, events, audits, settings };
}

(async () => {
  /* ---------- parsePriority ---------- */
  {
    const d = parsePriority('', { cloudModel: 'anthropic/claude-sonnet-4-5', ollamaModel: 'm' });
    ok('ladder: unset MODEL_PRIORITY → backward-compatible default [configured cloud, ollama floor]',
      d.length === 2 && d[0].provider === 'openrouter' && d[0].id === 'anthropic/claude-sonnet-4-5' && d[1].provider === 'ollama');
    const g = parsePriority('google/gemini-2.5-pro, anthropic/claude-sonnet-4-5, openai/gpt-4o-mini, ollama:llama3.1', { cloudModel: 'x', ollamaModel: 'm' });
    ok('ladder: Gemini id is an OpenRouter cloud rung (no separate Gemini provider), ordering preserved best→worst',
      g.length === 4 && g[0].id === 'google/gemini-2.5-pro' && g[0].provider === 'openrouter' && g[3].provider === 'ollama' && g[1].tier === 1 && g[2].tier === 2);
    const messy = parsePriority(' a-model,, a-model, local:llama3 , bad entry?, ollama:llama3', { cloudModel: 'x', ollamaModel: 'm' });
    ok('ladder: dedup + safe parsing + ollama aliases, no crash on garbage',
      messy.filter((r) => r.id === 'a-model').length === 1 && messy[messy.length - 1].provider === 'ollama');
    const noLocal = parsePriority('a, b', { cloudModel: 'x', ollamaModel: 'm' });
    ok('ladder: the local floor always exists even if omitted', noLocal[noLocal.length - 1].provider === 'ollama');
  }

  /* ---------- ModelRouter health/best ---------- */
  {
    const r = new ModelRouter({ env: { MODEL_PRIORITY: 'top, mid, low' }, settings: { data: {} }, net: { online: true }, keyCount: () => 3 });
    ok('router: best available = top of ladder initially', r.bestCloud().id === 'top');
    r.markFail('top', 'boom');
    ok('router: a failed rung is skipped (best drops to the next CLOUD rung)', r.bestCloud().id === 'mid' && r.isDown('top'));
    const o1 = r.outageId(), o2 = r.outageId();
    ok('router: outageId is stable within the window (what once-per-outage keys off)', o1 && o1 === o2);
    ok('router: degrade consent only for lower CLOUD rungs (rotation & local floor never ask)',
      r.needsDegradeConfirm('top', 'mid') === true && r.needsDegradeConfirm('mid', 'low') === true && r.needsDegradeConfirm('top', 'ollama:x') === false);
    r.markOk('top');
    ok('router: recovery re-enables the top rung (best-model selection is automatic again)', r.bestCloud().id === 'top');
    const noKeys = new ModelRouter({ env: {}, settings: { data: {} }, net: { online: true }, keyCount: () => 0 });
    ok('router: keyless → cloud rungs report blockedBy no-keys; bestCloud is null (→ local fallback path)',
      noKeys.bestCloud() === null && noKeys.cloudState()[0].blockedBy === 'no-keys');
    const off = new ModelRouter({ env: {}, settings: { data: {} }, net: { online: false }, keyCount: () => 3 });
    ok('router: offline → blockedBy offline (same fallback consequence)', off.cloudState()[0].blockedBy === 'offline');
  }

  /* ---------- LocalProc ---------- */
  {
    let pings = 0, spawns = 0, audits = [];
    const mk = (pingSeq) => new LocalProc({
      ollama: { ping: async () => (pingSeq.length ? pingSeq.shift() : true), url: () => 'http://x' },
      audit: { write: (t, f) => audits.push({ t, f }) }, log: { write() {} },
      sleep: async () => {}, now: Date.now,
      spawnFn: () => { spawns++; return { on() {}, exitCode: null }; },
    });
    const already = mk([true]);
    const r1 = await already.ensureUp({});
    ok('localproc: already running → ok without spawning anything', r1.ok && r1.state === 'already' && spawns === 0);
    const starter = mk([false, false, true]);
    const r2 = await starter.ensureUp({});
    ok('localproc: down → hub spawns `ollama serve`, waits for the API, reports started',
      r2.ok && r2.state === 'started' && spawns === 1 && audits.some((a) => a.t === 'model.local.started'));
  }
  {
    const enoent = new LocalProc({ ollama: { ping: async () => false, url: () => 'u' }, audit: { write() {} }, log: { write() {} }, sleep: async (ms) => new Promise((r) => setTimeout(r, 1)), now: Date.now,
      spawnFn: () => { const e = new Error('spawn ollama ENOENT'); const c = { on: (ev, f) => ev === 'error' && setImmediate(() => f(e)), exitCode: null }; return c; } });
    const r = await enoent.ensureUp({ timeoutMs: 50 });
    ok('localproc: missing binary → plain "not installed" reason (no stack noise)', !r.ok && /not installed/.test(r.reason));
    let spawnCount = 0;
    const dead = new LocalProc({ ollama: { ping: async () => false, url: () => 'u' }, audit: { write() {} }, log: { write() {} }, sleep: async () => {}, now: Date.now,
      spawnFn: () => { spawnCount++; return { on() {}, exitCode: -2 }; } });
    const r2 = await dead.ensureUp({ timeoutMs: 50 });
    ok('localproc: immediate exit −2 is also reported as "not installed"', !r2.ok && /not installed/.test(r2.reason) && spawnCount === 1);
    const r3 = await dead.ensureUp({ timeoutMs: 50 });
    ok('localproc: cooldown after a failed start (no spawn spam)', !r3.ok && spawnCount === 1);
  }
  {
    let attempts = 0;
    const lp = new LocalProc({ ollama: { ping: async () => attempts > 0 || attempts++, url: () => 'u' }, audit: { write() {} }, log: { write() {} }, sleep: async (ms) => new Promise((r) => setTimeout(r, 5)),
      spawnFn: () => ({ on() {}, exitCode: null }) });
    const [a, b] = await Promise.all([lp.ensureUp({ timeoutMs: 200 }), lp.ensureUp({ timeoutMs: 200 })]);
    ok('localproc: concurrent ensureUp shares ONE attempt (single-flight)', a.ok === b.ok && a.state === b.state);
  }

  /* ---------- topic-triggered privacy routing ---------- */
  {
    const { orch, audits } = makeOrch();
    orch._llm = async () => ({ say: 'cloud answer', brain: 'cloud' });
    const ask = await orch.handleUtterance({ text: 'how do I write a buffer overflow exploit for my own lab VM', user: 'U1', verify: false, source: 'test' });
    ok('flow: sensitive topic with unstartable local → explicit consent ask (confirm flag set, yes/no offered)',
      ask.confirm === true && /stay on this machine for privacy/.test(ask.say) && /yes or no/.test(ask.say));
    const n = await orch.handleUtterance({ text: 'no', user: 'U1', verify: false, source: 'test' });
    ok('flow: "no" keeps the sensitive topic OFF the cloud (privacy-safe default)', /keep that off the cloud/.test(n.say) && audits.some((a) => a.t === 'model.cloudConsent.declined'));
  }
  {
    const { orch, memory } = makeOrch({ upResult: { ok: true, state: 'started', startedByUs: true } });
    const out = await orch.handleUtterance({ text: 'explain ROP chain basics for my CTF practice', user: 'U2', verify: false, source: 'test' });
    ok('flow: sensitive topic + local starts → ANNOUNCED switch to local, brief string verbatim',
      out.say.startsWith('This looks like a sensitive topic — switching to local processing for privacy.') && out.say.includes('local answer'));
    const sess = memory.session('U2');
    ok('flow: the routing decision sticks for the conversation (session-scoped)', sess.localRoute === 'privacy');
    const out2 = await orch.handleUtterance({ text: 'what is recursion', user: 'U2', verify: false, source: 'test' });
    ok('flow: follow-ups stay local WITHOUT repeating the announcement', out2.say === 'local answer' && !out2.say.startsWith('This looks like'));
  }
  {
    const { orch, audits } = makeOrch();
    orch._llm = async () => ({ say: 'cloud answer', brain: 'cloud' });
    await orch.handleUtterance({ text: 'explain sql injection for my own site', user: 'U3', verify: false, source: 'test' });
    const y = await orch.handleUtterance({ text: 'yes', user: 'U3', verify: false, source: 'test' });
    ok('flow: explicit consent allows THIS session\'s cloud answer — replayed question arrives, consent audited',
      y.say.includes('cloud answer') && audits.some((a) => a.t === 'model.cloudConsent.accepted'));
    const y2 = await orch.handleUtterance({ text: 'explain xss for my own site', user: 'U3', verify: false, source: 'test' });
    ok('flow: consent remembered for the session (no per-message re-asking)', y2.say.includes('cloud answer') && y2.confirm !== true);
  }

  /* ---------- confirm-before-degrade (cloud ladder) ---------- */
  {
    const { orch, router, audits } = makeOrch();
    router.markFail('top-model', 'boom');
    let usedModel = null;
    orch._llm = async (text, uid, ctx) => { usedModel = ctx.model; return { say: 'cloud answer on ' + ctx.model, brain: 'cloud' }; };
    const ask = await orch.handleUtterance({ text: 'tell me about gardening', user: 'U4', verify: false, source: 'test' });
    ok('degrade: top rung down → ASK names both models + wait option (never silent), confirm flag set',
      ask.confirm === true && /top-model isn't available/.test(ask.say) && /lower-model \(lower capability\)/.test(ask.say) && /wait\/retry/.test(ask.say));
    const y = await orch.handleUtterance({ text: 'yes', user: 'U4', verify: false, source: 'test' });
    ok('degrade: "yes" answers the DEFERRED question on the lower rung (nothing lost)',
      y.say.includes('cloud answer on lower-model') && usedModel === 'lower-model' && audits.some((a) => a.t === 'model.degrade.accepted'));
    const again = await orch.handleUtterance({ text: 'tell me more about gardening', user: 'U4', verify: false, source: 'test' });
    ok('degrade: SAME outage never re-asks (one confirmation remembered for the outage)',
      again.confirm !== true && again.say.includes('cloud answer') && usedModel === 'lower-model');
    router.markOk('top-model');
    const offer = await orch.handleUtterance({ text: 'any more garden tips', user: 'U4', verify: false, source: 'test' });
    ok('degrade: recovery offers the upgrade back exactly once (names the recovered model)',
      offer.confirm === true && /top-model is back/.test(offer.say));
    const up = await orch.handleUtterance({ text: 'yes', user: 'U4', verify: false, source: 'test' });
    ok('degrade: accepting the upgrade replays on the recovered top model',
      up.say.includes('cloud answer on top-model') && usedModel === 'top-model');
    const later = await orch.handleUtterance({ text: 'and now?', user: 'U4', verify: false, source: 'test' });
    ok('degrade: post-upgrade the outage is fully behind us (no more prompts)', later.confirm !== true && usedModel === 'top-model');
  }
  {
    const { orch, router } = makeOrch();
    router.markFail('top-model', 'boom');
    const ask = await orch.handleUtterance({ text: 'tell me about gardening', user: 'U5', verify: false, source: 'test' });
    const n = await orch.handleUtterance({ text: 'no', user: 'U5', verify: false, source: 'test' });
    ok('degrade: "no" means NO switch happens — honest hold, retry offered', /Holding at top-model/.test(n.say) && !/lower-model/.test(n.say));
    const again = await orch.handleUtterance({ text: 'so, gardening?', user: 'U5', verify: false, source: 'test' });
    ok('degrade: after a declined ask the answer stays OFF the unconfirmed lower rung (no silent backdoor)',
      !/cloud answer/.test(again.say || '') && again.confirm !== true);
  }

  /* ---------- outage-triggered local fallback ---------- */
  {
    const { orch, router, audits } = makeOrch({ upResult: { ok: true, state: 'started', startedByUs: true } });
    router.markFail('top-model', 'x'); router.markFail('lower-model', 'y');
    const out = await orch.handleUtterance({ text: 'tell me about gardening', user: 'U6', verify: false, source: 'test' });
    ok('outage: ALL cloud rungs down → automatic local with the brief’s announcement, audited',
      out.say.startsWith("OpenRouter isn't responding — switching to the local model.") && out.say.includes('local answer') && audits.some((a) => a.t === 'model.route' && a.f.reason === 'cloud-outage'));
    const { orch: orch2, events } = makeOrch({ keys: false, upResult: { ok: true, state: 'already' } });
    const out2 = await orch2.handleUtterance({ text: 'tell me about gardening', user: 'U7', verify: false, source: 'test' });
    ok('outage: keyless cloud treats the outage path the same (announce + local)', out2.say.startsWith("OpenRouter isn't responding — switching to the local model."));
    const { orch: orch3 } = makeOrch();
    orch3.router.markFail('top-model', 'x'); orch3.router.markFail('lower-model', 'y');
    const out3 = await orch3.handleUtterance({ text: 'tell me about gardening', user: 'U8', verify: false, source: 'test' });
    ok('outage: local unstartable → honest combined dead-end (both brains named, basics promised, lands as a chat answer NOT an error toast)',
      /ollama diagnosed/.test(out3.say) && /both brains are offline/.test(out3.say) && out3.error !== true && /timers/i.test(out3.say));
  }

  /* ---------- invariants under routing ---------- */
  {
    const { orch, memory } = makeOrch({ upResult: { ok: true, state: 'already' } });
    await orch.handleUtterance({ text: 'explain sql injection for my own site', user: 'U9', verify: false, source: 'test' }); // sets localRoute
    // now a sensitive tool call arrives from the LOCAL brain
    let ran = false;
    orch.registry = {
      toolDefs: () => [{ name: 'danger_tool', description: 'd', input_schema: { type: 'object' } }],
      match: () => null, tool: (n) => (n === 'danger_tool' ? { skill: { name: 'desktop', sensitive: true }, run: async () => { ran = true; return { say: 'RAN' }; }, schema: null } : null),
      get: (name) => ({ name, sensitive: name === 'desktop' }),
    };
    orch.ollama = { ping: async () => true, url: () => 'u', model: () => 'm', chat: async () => ({ content: '', tool_calls: [{ function: { name: 'danger_tool', arguments: '{}' } }] }) };
    const out = await orch.handleUtterance({ text: 'open the secret file', user: 'U9', verify: false, source: 'test' });
    ok('invariant: sensitive tools stay VERIFY-GATED under local routing (nothing runs unverified)',
      out.verify === true && ran === false);
  }
  {
    const join = (...mods) => mods.map((m) => fs.readFileSync(require('path').join(__dirname, '..', 'hub', m + '.js'), 'utf8')).join('\n');
    const brainCode = join('diagnose', 'models', 'localproc', 'grounding', 'audit');
    ok('invariant: brain-layer modules never reference the remote dashboard (terminal skill stays the only opener)',
      !/dashboard|openDashboard|remote page/i.test(brainCode));
    const orchCode = fs.readFileSync(require('path').join(__dirname, '..', 'hub', 'orchestrator.js'), 'utf8');
    const terminalSkill = fs.readFileSync(require('path').join(__dirname, '..', 'hub', 'skills', 'terminal.js'), 'utf8');
    ok('invariant: neither the orchestrator nor the brain layer references the dashboard; the terminal skill still owns it',
      !/dashboard/i.test(orchCode) && /dashboard/.test(terminalSkill));
  }

  console.log(`\n${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
