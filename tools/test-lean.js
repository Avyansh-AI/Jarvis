#!/usr/bin/env node
'use strict';
/**
 * Lean cloud fallback (free-tier 402 'Prompt tokens limit exceeded') — proves:
 *  1. the parser extracts needed/limit from OpenRouter's message
 *  2. a full-profile call that hits the cap retries LEAN in the same turn
 *     (lean = no tools, no history, short system, brain tag 'cloud-lean')
 *  3. the %% window makes later calls start lean without a doomed full try
 *  4. a full-size success clears the lean window (credit topped up again)
 *  5. when even lean can't fit, the user hears the REAL reason + the fix URL
 *  6. the 402 detail capture in _chat attaches tokenLimit/tokenNeeded to the error
 */
process.env.OPENROUTER_API_KEYS = 'sk-test-a,sk-test-b';
process.env.OPENROUTER_API_KEY = '';
process.env.OPENROUTER_KEY_1 = 'sk-test-a'; process.env.OPENROUTER_KEY_2 = 'sk-test-b'; process.env.OPENROUTER_KEY_3 = '';
const { Orchestrator, tokenLimitDetail } = require('../hub/orchestrator');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('ok  ' + n); } else { fail++; console.log('FAIL ' + n); } };

const events = [];
function makeOrch() {
  const registry = {
    _toolDefsCalls: 0,
    toolDefs() { this._toolDefsCalls++; return [{ name: 'noop_tool', description: 'n', input_schema: { type: 'object', properties: {} } }]; },
    match: () => null, tool: () => null, get: () => null, describe: () => [],
  };
  const memory = {
    session: () => ({ turns: [], mode: null, pendingConfirm: null }),
    contextFor: () => ({ facts: [], prefs: {} }),
    countIntent: () => {}, setPending: () => {}, addTurn: () => {},
    ensureUser: (id) => ({ id, guest: false, kid: false, prefs: {} }), pendingTask: () => null, clearPending: () => {},
  };
  const settings = { data: { assistantName: 'Max', openrouter: { model: '' }, privacy: { llm: 'cloud' }, personality: { tone: 0.5 }, skills: {} } };
  const log = { write: (t, d) => events.push({ t, d }) };
  const net = { online: true };
  const orch = new Orchestrator({ registry, memory, settings, log, net, bus: { emit: () => {}, on: () => {} } });
  return { orch, registry };
}
const okRes = (text) => ({ ok: true, json: async () => ({ choices: [{ message: { content: text } }] }) });
const tokenLimitErr = () => { const e = new Error('OpenRouter HTTP 402'); e.tokenLimit = 1673; e.tokenNeeded = 2290; e.tokenKind = 'prompt'; return e; };
const maxTokErr = (afford = 298) => { const e = new Error('OpenRouter HTTP 402'); e.tokenLimit = afford; e.tokenNeeded = 600; e.tokenKind = 'max_tokens'; return e; };

(async () => {
  /* 1-2: parser */
  ok('parser: extracts needed/limit from the OpenRouter message', (() => { const d = tokenLimitDetail('Prompt tokens limit exceeded: 2290 > 1673. To increase, visit …'); return d && d.needed === 2290 && d.limit === 1673; })());
  ok('parser: null on unrelated messages', tokenLimitDetail('rate limited') === null && tokenLimitDetail('') === null);

  /* 3: full hits cap → same turn still answers, lean */
  {
    const { orch } = makeOrch();
    let fullCalls = 0, leanCalls = 0;
    orch._chat = async (base, body) => { if (body.tools) { fullCalls++; throw tokenLimitErr(); } leanCalls++; return okRes('lean answer here'); };
    const out = await orch._llm('explain entropy simply', 'U', { userId: 'U' });
    ok('lean retry: answer still returned this turn, tagged cloud-lean, llm.lean logged',
      out.brain === 'cloud-lean' && out.say === 'lean answer here' && fullCalls === 1 && leanCalls === 1 && events.some((e) => e.t === 'llm.lean' && e.d.limit === 1673));
  }

  /* 4: lean sends NO tool catalog */
  {
    const { orch, registry } = makeOrch();
    orch._chat = async (base, body) => { if (body.tools) throw tokenLimitErr(); return okRes('ok'); };
    await orch._llm('hi', 'U', { userId: 'U' });
    await orch._llm('hi again', 'U', { userId: 'U' });
    ok('lean profile never builds the tool catalog again (toolDefs called once, for the first full try)',
      registry._toolDefsCalls === 1);
  }

  /* 5: lean window — later calls don't waste a doomed full attempt */
  {
    const { orch } = makeOrch();
    let fullCalls = 0;
    orch._chat = async (base, body) => { if (body.tools) { fullCalls++; throw tokenLimitErr(); } return okRes('lean'); };
    await orch._llm('one', 'U', { userId: 'U' });
    await orch._llm('two', 'U', { userId: 'U' });
    await orch._llm('three', 'U', { userId: 'U' });
    ok('lean window: 3 turns, only the first tried full size', fullCalls === 1 && !!orch._leanUntil);
  }

  /* 6: full-size success clears the window */
  {
    const { orch } = makeOrch();
    let lean = true;
    orch._chat = async (base, body) => { if (lean && body.tools) throw tokenLimitErr(); return okRes('answer'); };
    await orch._llm('first', 'U', { userId: 'U' });
    lean = false; // simulate credit top-up
    orch._leanUntil = Date.now() - 1; // simulate the 30-min window having expired → re-probe full size
    const out = await orch._llm('second', 'U', { userId: 'U' });
    ok('full-size success after window expiry clears lean mode (brain: cloud, window cleared)', out.brain === 'cloud' && !orch._leanUntil);
  }

  /* 7: honest message when even lean can't fit */
  {
    const { orch } = makeOrch();
    orch._chat = async () => { throw tokenLimitErr(); };
    orch.ollama = { ping: async () => false, url: () => '', model: () => '' };
    const out = await orch.handleUtterance({ text: 'tell me a fact no skill matches zzz', user: 'U', verify: false, source: 'http' }).catch((e) => ({ error: e.message }));
    ok('even-lean-fails: user hears the real reason (free limit) + credit URL',
      /free limit|17\d\d/.test(out.say || '') && /openrouter\.ai\/settings\/credits/.test(out.say || ''));
  }

  /* 8: parser — the OTHER live 402 shape ('can only afford M', max_tokens too big) */
  ok('parser: max_tokens shape → {kind:max_tokens, needed:600, limit:298}', (() => {
    const d = tokenLimitDetail('This request requires more credits, or fewer max_tokens. You requested up to 600 tokens, but can only afford 298. To increase, visit …');
    return d && d.kind === 'max_tokens' && d.needed === 600 && d.limit === 298;
  })());
  ok('parser: prompt shape now tagged kind=prompt', (() => { const d = tokenLimitDetail('Prompt tokens limit exceeded: 2290 > 1673.'); return d && d.kind === 'prompt'; })());

  /* 9: full hits max_tokens cap → lean retry clamps max_tokens to what fits */
  {
    const { orch } = makeOrch();
    let leanMax = null;
    orch._chat = async (base, body) => { if (body.tools) throw maxTokErr(298); leanMax = body.max_tokens; return okRes('squeezed answer'); };
    const out = await orch._llm('explain entropy simply', 'U', { userId: 'U' });
    ok('max_tokens clamp: lean retry fits the budget (max_tokens 150 ≤ afford 298), llm.lean kind=max_tokens',
      out.brain === 'cloud-lean' && out.say === 'squeezed answer' && leanMax === 150 && events.some((e) => e.t === 'llm.lean' && e.d.kind === 'max_tokens'));
  }

  /* 10: lean-first turn (window already active) that hits max_tokens gets ONE clamped hop */
  {
    const { orch } = makeOrch();
    orch._leanUntil = Date.now() + 60000;
    const maxSeq = [];
    let calls = 0;
    orch._chat = async (base, body) => { maxSeq.push(body.max_tokens); calls++; if (calls === 1) throw maxTokErr(120); return okRes('tiny but real'); };
    const out = await orch._llm('quick thought', 'U', { userId: 'U' });
    ok('lean-first max_tokens: retries once clamped (min(150, 120-10)=110), clamp logged',
      out.brain === 'cloud-lean' && out.say === 'tiny but real' && JSON.stringify(maxSeq) === '[400,110]' && events.some((e) => e.t === 'llm.lean' && e.d.kind === 'clamp'));
  }

  /* 11: same failure twice in lean mode → honest 'out of credit' message, no endless loop */
  {
    const { orch } = makeOrch();
    orch._chat = async () => { throw maxTokErr(40); };
    orch.ollama = { ping: async () => false, url: () => '', model: () => '' };
    const out = await orch.handleUtterance({ text: 'tell me a fact no skill matches zzz', user: 'U', verify: false, source: 'http' }).catch((e) => ({ error: e.message }));
    ok('lean gives up after double max_tokens 402: user hears out-of-credit + credit URL',
      /out of credit/.test(out.say || '') && /openrouter\.ai\/settings\/credits/.test(out.say || ''));
  }

  /* 12: lean window active → deterministic intents run locally, LLM never consulted;
         unmatched text still reaches the lean LLM */
  {
    const { orch } = makeOrch();
    orch.ollama = { ping: async () => false, url: () => '', model: () => '' };
    orch._gate = () => ({ blocked: null });
    orch._leanUntil = Date.now() + 60000; // lean window active
    let llmCalls = 0, skillRan = false;
    orch._chat = async () => { llmCalls++; return okRes('lean chat answer'); };
    const clockish = { patterns: [], run: async () => { skillRan = true; return "It's 9:44 AM on Friday."; } };
    orch.registry.match = () => ({ skill: { name: 'clock', sensitive: false }, intent: clockish, match: ['what time is it'] });
    const a = await orch.handleUtterance({ text: 'what time is it', user: 'U', verify: false, source: 'http' });
    const skillFirst = skillRan && llmCalls === 0 && /9:44/.test(a.say || '');
    orch.registry.match = () => null; // nothing matches → lean cloud should take it
    const b = await orch.handleUtterance({ text: 'tell me something interesting', user: 'U', verify: false, source: 'http' });
    ok('lean window: clock intent answered by the real skill (LLM untouched); unmatched text falls through to lean LLM',
      skillFirst && llmCalls === 1 && b.brain === 'cloud-lean' && /lean chat answer/.test(b.say || ''));
  }

  /* 13 (BUGS_MASTER B-03 / backlog L-01): TRANSITION turn — the request that discovers
     the 402 must not push a deterministic question onto the tool-less lean model */
  {
    const { orch, registry } = makeOrch();
    orch.ollama = { ping: async () => false, url: () => '', model: () => '' };
    orch._gate = () => ({ blocked: null });
    let leanCalls = 0, skillRan = false;
    orch._chat = async (base, body) => { if (body.tools) throw tokenLimitErr(); leanCalls++; return okRes('lean guess'); };
    registry.match = () => ({ skill: { name: 'clock', sensitive: false }, intent: { patterns: [], run: async () => { skillRan = true; return "It's 9:44 AM."; } }, match: ['what time is it'] });
    const out = await orch.handleUtterance({ text: 'what time is it', user: 'U', verify: false, source: 'http' });
    ok('transition turn: full 402 → deterministic intent answered LOCALLY same turn; lean model never had to guess',
      skillRan === true && leanCalls === 0 && /9:44/.test(out.say || '') && orch._leanUntil > Date.now());
  }

  /* 14 (B-03 cont.): the lean system prompt forbids faking actions / live data */
  {
    const { orch } = makeOrch();
    let leanSystem = '';
    orch._chat = async (base, body) => { if (body.tools) throw tokenLimitErr(); leanSystem = body.messages[0].content; return okRes('honest lean'); };
    await orch._llm('github status', 'U', { userId: 'U' });
    ok('lean prompt hardening: explicitly bars claiming actions done or live data read',
      /never claim you performed an action/i.test(leanSystem) && /live data/i.test(leanSystem) && /did not and cannot/i.test(leanSystem));
  }

  console.log(`\n${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
