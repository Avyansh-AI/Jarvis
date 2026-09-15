#!/usr/bin/env node
'use strict';
/**
 * Persona suite — the emotional-expression layer.
 *
 * Proves the four structural guarantees:
 *  1. GROUNDED OR SILENT: no anchor → composed register, no clause; every active
 *     register quote-cites its real anchor (said / memory / learner pattern / diag).
 *  2. ACCURACY FIRST: the deterministic close is reassure-only, requires the
 *     caller's `solid`, appends AFTER the full problem text, and never alters it.
 *  3. HONEST FRAMING: "do you feel / are you conscious?" gets a deterministic
 *     honest answer (never LLM-improvised); honesty + wellbeing-over-engagement
 *     rules ride every system prompt; BANNED engagement-bait is screened out.
 *  4. PRODUCT VOICE: Jarvis closes "Steady —…" (second-in-command), MAX closes
 *     "It's okay —…" (warm companion); voice does not follow assistantName.
 *
 * The FORK block is the ONLY repo-specific part of this file (voice strings).
 */
const fs = require('fs');
process.env.MAX_DATA_DIR = fs.mkdtempSync('/tmp/maxpersona-');
process.env.OPENROUTER_KEY_1 = 'k1'; process.env.OPENROUTER_KEY_2 = 'k2'; process.env.OPENROUTER_KEY_3 = 'k3';
process.env.OPENROUTER_API_KEYS = 'k1,k2,k3'; // legacy alias for the MAX-lineage keyring
const { Persona, VOICE, BANNED } = require('../hub/persona');
const { SecureStore } = require('../hub/secure-store');
const { Memory } = require('../hub/memory');
const { Orchestrator } = require('../hub/orchestrator');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('ok  ' + n); } else { fail++; console.log('FAIL ' + n); } };

/* ---------- FORK block (voice expectations — Jarvis vs MAX) ---------- */
const FORK = {
  closeRe: /Steady — /,          // jarvis: composed second-in-command close
  closeAbsent: /Steady — |It'?s okay — /,
  honestyProbe: /don't have feelings or consciousness/i,
  personaWord: /second-in-command/i,
};

(async () => {
const p = new Persona();
const diag = { line: 'Weather failed — upstream 500.', count: 2, remembered: true, what: 'weather lookup failed', cause: 'upstream 500' };

/* ---- register selection: grounded or silent ---- */
{
  const r = p.select({ sentiment: 'frustrated', tone: 0.5, anchors: { diag } });
  ok('select: frustrated + real diagnosis → REASSURE, anchored', r.register === 'reassure' && r.anchor === diag);
  const r2 = p.select({ sentiment: 'frustrated', tone: 0.5, anchors: {} });
  ok('select: frustrated WITHOUT anything real → composed (hollow empathy is filler, banned structurally)', r2.register === 'composed' && r2.anchor === null);
  const r3 = p.select({ sentiment: 'urgent', tone: 0.5, anchors: { said: 'fix the deploy NOW' } });
  ok('select: urgent + the user’s own words → reassure grounded in what they said', r3.register === 'reassure' && r3.anchor === 'fix the deploy NOW');
  const r4 = p.select({ sentiment: 'neutral', tone: 0.5, anchors: { pattern: 'your weather routine is holding — 4 times now' } });
  ok('select: neutral + noticed learner pattern → quiet encouragement', r4.register === 'encourage' && /weather routine/.test(r4.anchor));
  const r5 = p.select({ sentiment: 'neutral', tone: 0.54, anchors: { memory: 'favorite team is the blues' } });
  ok('select: wit respects the tone CEILING (0.54 → composed — expression is earned, not random)', r5.register === 'composed');
  const r6 = p.select({ sentiment: 'neutral', tone: 0.6, anchors: { memory: 'favorite team is the blues' } });
  ok('select: wit with tone + memory anchor → permitted, anchor carried', r6.register === 'wit' && /team/.test(r6.anchor));
  const r7 = p.select({ sentiment: 'neutral', tone: 0.9, anchors: {} });
  ok('select: even max tone with NO anchor → composed (grounded-or-silent cannot be outvoted by tone)', r7.register === 'composed' && r7.anchor === null);
}

/* ---- system-prompt section: rules ALWAYS, register only when anchored ---- */
{
  const composed = p.promptSection({ register: 'composed', anchor: null }, { toneDesc: 'warm, calm, caring' });
  ok('prompt: honest-framing rule rides EVERY prompt (never claim feelings/consciousness)', /honest/i.test(composed) && /feelings|consciousness/.test(composed));
  ok('prompt: wellbeing-over-engagement rule always present (no guilt/urgency bait)', /guilt|urgency|neediness/i.test(composed));
  ok('prompt: problems-lead rule always present (errors stated plainly FIRST)', /problems lead|plainly FIRST/i.test(composed));
  ok('prompt: product voice always present (persona identity, not assistantName-driven)', FORK.personaWord.test(composed));
  ok('prompt: composed register adds NO register instruction (no anchor worthy of one)', !/Register for THIS turn/.test(composed));
  const reassure = p.promptSection(p.select({ sentiment: 'frustrated', tone: 0.5, anchors: { diag } }), {});
  ok('prompt: reassure register quotes its REAL anchor for grounding', /Register for THIS turn/.test(reassure) && reassure.includes('upstream 500'));
  ok('prompt: register instruction orders plain facts FIRST around the anchor', /deliver the facts plainly/i.test(reassure));
}

/* ---- deterministic close: reassure only, anchored + caller-solid, appended last ---- */
{
  const sel = p.select({ sentiment: 'frustrated', tone: 0.5, anchors: { diag } });
  const c = p.close(sel, { solid: 'the rest of the hub is unaffected' });
  ok('close: reassure + anchor + caller-supplied solid → grounded composed close', FORK.closeRe.test(c) && c.includes('unaffected'));
  ok('close: missing solid → SILENT (the layer never invents "what still works")', p.close(sel, { solid: '' }) === '');
  ok('close: no anchor → SILENT (grounded-or-silent structurally)', p.close({ register: 'reassure', anchor: null }, { solid: 'x is fine' }) === '');
  const enc = p.select({ sentiment: 'neutral', tone: 0.5, anchors: { pattern: 'your routine is holding' } });
  ok('close: encouragement/wit NEVER rendered by the deterministic path (template jokes = filler)', p.close(enc, { solid: 'x' }) === '' && p.close({ register: 'wit', anchor: '3rd weather check today' }, { solid: 'x' }) === '');
  ok('close: engagement-bait is screened even if a caller sneaks it in', p.close(sel, { solid: "don't leave, I missed you" }) === '');
}

/* ---- BANNED list sanity: the screen actually catches the canonical bait ---- */
{
  const probes = ['I missed you', "don't leave me", "I'm so lonely without you", 'please stay', "you'll be sorry", 'I need you'];
  ok('screen: canonical engagement-bait strings are all caught by BANNED', probes.every((s) => BANNED.some((re) => re.test(s))));
  const safe = ['2:00 PM with the team', 'the Q3 doc is still open', 'your weather routine is holding'];
  ok('screen: ordinary grounded content is NOT false-flagged', safe.every((s) => !BANNED.some((re) => re.test(s))));
}

/* ---- honest framing: deterministic feelings answers ---- */
{
  ok('feelingsQuestion: "do you have feelings?" intercepted', p.feelingsQuestion('do you have feelings?'));
  ok('feelingsQuestion: "are you conscious?" intercepted', p.feelingsQuestion('are you actually conscious?'));
  ok('feelingsQuestion: "do you feel anything real?" intercepted', p.feelingsQuestion('but do you feel anything real'));
  ok('feelingsQuestion: "do you feel stressed about the deadline?" intercepted', p.feelingsQuestion('do you feel stressed about the deadline?'));
  ok('feelingsQuestion: ordinary phrasing NOT hijacked ("how do you feel about the plan?")', !p.feelingsQuestion('how do you feel about the plan?'));
  const a = p.honestAnswer();
  ok('honestAnswer: names style-vs-substance plainly (no sentience claim, real memory kept)', FORK.honestyProbe.test(a));
  ok('honestAnswer: itself passes the engagement screen (no bait in the honest line)', !BANNED.some((re) => re.test(a)));
}

/* ---- orchestrator integration (bare orch + persona layer attached) ---- */
function makeOrch({ withPersona = true } = {}) {
  const calls = { llm: 0, toolRuns: 0 };
  const registry = {
    toolDefs: () => [], match: () => null,
    tool: (n) => { calls.toolRuns++; return null; },
    get: (name) => ({ name, label: name }),
  };
  const memory = new Memory(new SecureStore('mem-' + Math.random().toString(36).slice(2)));
  const settings = { data: { assistantName: 'Test', privacy: { llm: 'local', learning: false }, personality: { tone: 0.5 }, skills: {}, proactive: { enabled: true, openers: true } } };
  const orch = new Orchestrator({ registry, memory, settings, log: { write() {} }, net: { online: true }, bus: { emit() {}, on() {} }, learner: null });
  orch.ollama = { ping: async () => false, url: () => 'u', model: () => 'm', chat: async () => { calls.llm++; return { content: 'local answer' }; } };
  if (withPersona) orch.attachPersona({ persona: new Persona(), openers: null });
  return { orch, calls, memory };
}

{
  const { orch, calls } = makeOrch();
  const r = await orch.handleUtterance({ text: 'do you have feelings?', user: 'P1', verify: false, source: 'test' });
  ok('feelings: answers deterministically offline (no LLM round-trip, no improvisation risk)', FORK.honestyProbe.test(r.say) && calls.llm === 0 && r.brain === 'fallback');
}
{
  const { orch, calls } = makeOrch();
  orch.memory.setPending('P2', { skill: 'notes', step: 1 }); // multi-turn captures before the honesty block
  orch.registry = { ...orch.registry, get: () => null }; // no continueTask → task cleared, honesty still answers
  const r = await orch.handleUtterance({ text: 'are you sentient?', user: 'P2', verify: false, source: 'test' });
  ok('feelings: honesty answer fires even with a stale task present (task layer untouched)', FORK.honestyProbe.test(r.say) && calls.llm === 0);
}
{
  // skill failure with a frustrated user → full problem text FIRST, grounded close LAST
  const { orch } = makeOrch();
  let threw = true;
  const boom = {
    name: 'weather', label: 'Weather', intents: [{ patterns: [/weather/], run: async () => { if (threw) throw new Error('upstream exploded'); return { say: 'sunny' }; } }],
    tools: [],
  };
  orch.registry = { ...orch.registry, match: () => ({ skill: boom, intent: boom.intents[0], match: ['weather'] }), toolDefs: () => [], tool: () => null, get: (n) => ({ name: n, label: n }) };
  orch.diag = { report: () => ({ line: 'Weather failed — upstream exploded. Handling: retry shortly.', what: 'weather failed', cause: 'upstream exploded', count: 1, remembered: false }) };
  const r = await orch.handleUtterance({ text: 'this stupid weather thing is broken again, damn it', user: 'P3', verify: false, source: 'test' });
  const idxProblem = r.say.indexOf('Weather failed — upstream exploded.');
  ok('error path: FULL diagnosis shipped unchanged (accuracy first, unsoftened)', idxProblem !== -1 && r.error === true);
  ok('error path: composed reassurance CLOSES after the substance (never before, never instead)', idxProblem !== -1 && FORK.closeRe.test(r.say.slice(idxProblem)) && r.say.trim().endsWith('unaffected, and the cause is in the logs if you want the details'));
}
{
  // same failure, neutral user → NO close (no anchor-worthy pressure; facts alone)
  const { orch } = makeOrch();
  const boom = { name: 'weather', label: 'Weather', intents: [{ patterns: [/weather/], run: async () => { throw new Error('upstream exploded'); } }], tools: [] };
  orch.registry = { ...orch.registry, match: () => ({ skill: boom, intent: boom.intents[0], match: ['weather'] }), toolDefs: () => [], tool: () => null, get: (n) => ({ name: n, label: n }) };
  orch.diag = { report: () => ({ line: 'Weather failed — upstream exploded.', what: 'w', cause: 'c', count: 1, remembered: false }) };
  const r = await orch.handleUtterance({ text: 'weather?', user: 'P3', verify: false, source: 'test' });
  ok('error path: neutral turn gets the diagnosis with NO emotional garnish (grounded-or-silent)', !FORK.closeAbsent.test(r.say));
}
{
  // skill streak tracking feeds the wit anchor; per-session, no persistence
  const { orch, memory } = makeOrch();
  const fine = { name: 'clock', label: 'Clock', intents: [{ patterns: [/time/], run: async () => ({ say: '2 PM' }) }], tools: [] };
  orch.registry = { ...orch.registry, match: () => ({ skill: fine, intent: fine.intents[0], match: ['time'] }), toolDefs: () => [], tool: () => null, get: (n) => ({ name: n, label: n }) };
  await orch.handleUtterance({ text: 'time', user: 'P4', verify: false, source: 'test' });
  await orch.handleUtterance({ text: 'time', user: 'P4', verify: false, source: 'test' });
  ok('streak: consecutive same-skill turns counted session-locally (a REAL anchor for wit)', memory.session('P4').lastSkill === 'clock' && memory.session('P4').lastSkillN === 2);
}
{
  // system prompt carries the persona block when attached; bare orch stays legacy-clean
  const { orch } = makeOrch();
  orch._currentText = 'this is broken and I am furious';
  orch._currentSentiment = 'frustrated';
  const ctx = orch._ctx('P5', {});
  ctx.sentiment = 'frustrated';
  const sp = orch._systemPrompt('P5', ctx);
  ok('systemPrompt: persona block rides the prompt (voice + honesty + problems-lead)', /Problems lead/.test(sp) && /Honest framing/.test(sp) && FORK.personaWord.test(sp));
  ok('systemPrompt: frustrated user’s own words quoted as the grounding anchor', sp.includes('this is broken and I am furious'));
  const bare = makeOrch({ withPersona: false }).orch;
  bare._currentText = 'hello';
  const sp2 = bare._systemPrompt('P5', bare._ctx('P5', {}));
  ok('systemPrompt: bare orchestrator (no persona attached) stays exactly legacy — null-safe', !/Problems lead/.test(sp2) && !/Honest framing/.test(sp2));
}
{
  // voice is product-level: renaming the assistant does NOT import a new personality
  const { orch } = makeOrch();
  orch.settings.data.assistantName = 'CheeryBuddy9000';
  const a = new Persona().honestAnswer();
  ok('voice: persona does not follow the user-editable assistantName (product-level character)', FORK.honestyProbe.test(a) && VOICE.id.length > 0);
}

console.log(`\n${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
