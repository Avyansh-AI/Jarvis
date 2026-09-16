#!/usr/bin/env node
'use strict';
/**
 * Openers suite — proactive, context-grounded "what should we start with".
 *
 * Proves:
 *  - grounded-or-silent: suggestions name REAL calendar events, due reminders,
 *    and live routine patterns; an empty board yields null (never an open-ended
 *    "what would you like to do?");
 *  - suggestion-only: the parked accept is kind:'opener' with NO tool name —
 *    nothing executes, nothing verifies, gates untouched; "yes" shows read-only
 *    detail; "no" closes; unrelated replies fall through and process normally;
 *  - toggleable: master proactive.enabled AND proactive.openers both gate it;
 *    guests/kids never receive personal schedule data;
 *  - session rules: appended once per fresh session, only on clean turns (never
 *    stacked on a confirm/verify/locked/task/nudge turn — single-question rule);
 *  - explicit-ask: "what should we start with" answers directly, honestly when
 *    the board is empty, falls through to normal routing when toggled off.
 *
 * FORK block = the only repo-specific part (voice strings).
 */
const fs = require('fs');
process.env.MAX_DATA_DIR = fs.mkdtempSync('/tmp/maxopen-');
process.env.OPENROUTER_KEY_1 = 'k1'; process.env.OPENROUTER_KEY_2 = 'k2'; process.env.OPENROUTER_KEY_3 = 'k3';
process.env.OPENROUTER_API_KEYS = 'k1,k2,k3'; // legacy alias for the MAX-lineage keyring
const { Openers } = require('../hub/openers');
const { Persona } = require('../hub/persona');
const { SecureStore } = require('../hub/secure-store');
const { Memory } = require('../hub/memory');
const { Orchestrator } = require('../hub/orchestrator');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('ok  ' + n); } else { fail++; console.log('FAIL ' + n); } };

/* ---------- FORK block (voice expectations — Jarvis vs MAX) ---------- */
const FORK = {
  boardRe: /^On the board: /,
  emptyRe: /Board is clear/,
  declineRe: /lead and I'll follow/,
  detailStartRe: /Say "briefing"/,
};

(async () => {
const NOW = Date.now();
const at = (h) => { const d = new Date(NOW); d.setMinutes(0, 0, 0); return d.getTime() + h * 3600e3; };
const mk = ({ events = [], jobs = [], emerging = [], settings = {} } = {}) => new Openers({
  calendar: { today: () => events },
  scheduler: { store: { data: { jobs } } },
  learner: emerging ? { emergingRoutines: () => emerging } : null,
  settings: { data: { proactive: { enabled: true, openers: true, ...settings } } },
  now: () => NOW,
});
const NOW_D = new Date(NOW);
const me = { id: 'me', guest: false, kid: false };

/* ---- candidates + ranking ---- */
{
  const o = mk({
    events: [{ title: 'Team sync', start: NOW + 3600e3 }, { title: 'Late lunch', start: NOW + 5 * 3600e3 }],
    jobs: [{ id: 'j1', kind: 'reminder', label: 'Q3 doc pass', at: NOW - 3600e3, fired: false }, { id: 'j2', kind: 'timer', label: 'tea', at: NOW + 600e3, fired: false }],
    emerging: [{ skill: 'weather', hour: NOW_D.getHours(), dow: NOW_D.getDay(), n: 4, weeks: 3 }],
  });
  const c = o.candidates('me', NOW);
  ok('candidates: imminent event ranks first, overdue reminder second, live routine third', c.length === 3 && c[0].kind === 'event' && c[0].title === 'Team sync' && c[1].kind === 'reminder' && c[2].kind === 'routine');
  ok('candidates: timers are NOT reminders (label only — kinds respected)', !c.some((x) => x.title === 'tea'));
  const scopedAll = [
    { id: 'j1', kind: 'reminder', label: 'Remind me to call mom', at: NOW - 3600e3, fired: false, user: 'me' },
    { id: 'j2', kind: 'reminder', label: 'Reminder: someone elses private thing', at: NOW - 3600e3, fired: false, user: 'other-user' },
    { id: 'j3', kind: 'reminder', label: 'Reminder: legacy global reminder', at: NOW - 3600e3, fired: false },
  ];
  const scoped = mk({ jobs: scopedAll }).candidates('me', NOW); // candidates() dedups to one per kind — scoping must happen BEFORE dedup
  const scopedOther = mk({ jobs: scopedAll }).candidates('other-user', NOW);
  ok('candidates: reminders are user-scoped (another user\'s never surface), label prefix stripped',
    scoped.some((x) => x.title === 'call mom') && !scoped.some((x) => /someone elses/.test(x.title)));
  ok('candidates: scoping is per-user (the other user sees their own, plus untagged legacy, never mine)',
    scopedOther.some((x) => /someone elses/.test(x.title)) && !scopedOther.some((x) => x.title === 'call mom'));
  ok('candidates: routine outside the current hour-of-week does NOT surface', mk({ emerging: [{ skill: 'weather', hour: (NOW_D.getHours() + 5) % 24, dow: NOW_D.getDay(), n: 9, weeks: 9 }] }).candidates('me', NOW).length === 0);
}

/* ---- compose: specific, grounded, voice-shaped; silent when empty ---- */
{
  const o = mk({ events: [{ title: 'Team sync', start: NOW + 3600e3 }], jobs: [{ id: 'j1', kind: 'reminder', label: 'Q3 doc pass', at: NOW - 3600e3, fired: false }] });
  const c = o.compose('me', me, NOW);
  ok('compose: names the real items specifically (never open-ended)', FORK.boardRe.test(c.say) && c.say.includes('Team sync') && c.say.includes('Q3 doc pass') && !/what would you like to do/i.test(c.say));
  ok('compose: top item + sanitized items ride along for the read-only accept', c.top.title === 'Team sync' && c.items.every((i) => i.kind && i.title));
  const empty = mk({});
  ok('compose: empty board → null (silence over filler — the anti-"what would you like to do?" rule)', empty.compose('me', me, NOW) === null);
}

/* ---- toggle gates ---- */
{
  const o = mk({ events: [{ title: 'X', start: NOW + 3600e3 }], settings: { openers: false } });
  ok('toggle: proactive.openers=false alone silences openers', o.compose('me', me, NOW) === null);
  const o2 = mk({ events: [{ title: 'X', start: NOW + 3600e3 }], settings: { enabled: false } });
  ok('toggle: master proactive.enabled=false silences openers too', o2.compose('me', me, NOW) === null);
  ok('privacy: guest profile never receives schedule data in a suggestion', mk({ events: [{ title: 'Secret party', start: NOW + 3600e3 }] }).compose('g', { id: 'g', guest: true }, NOW) === null);
  ok('privacy: kid profile never receives one either', mk({ events: [{ title: 'Dentist', start: NOW + 3600e3 }] }).compose('k', { id: 'k', kid: true }, NOW) === null);
}

/* ---- explicit ask ---- */
{
  const o = mk({ events: [{ title: 'Team sync', start: NOW + 3600e3 }] });
  const e = o.explicit('me', me, NOW);
  ok('explicit: "where do we start" answers with the grounded board', e && e.top && e.say.includes('Team sync'));
  const empty = mk({}).explicit('me', me, NOW);
  ok('explicit: empty board → HONEST "nothing queued" (not an invented errand)', FORK.emptyRe.test(empty.say) && empty.top === null);
  ok('explicit: toggle off → null (caller falls through to normal routing)', mk({ settings: { openers: false } }).explicit('me', me, NOW) === null);
}

/* ---- read-only detail ---- */
{
  const d = mk({}).detail({ kind: 'event', title: 'Team sync', at: NOW + 3600e3 });
  ok('detail: names the accepted item with its time — data, not actions', d.includes('Team sync') && FORK.detailStartRe.test(d));
  ok('detail: never references a tool/verify flow (suggestion-only by construction)', !/verify|tool|execute/i.test(d));
}

/* ---------- orchestrator integration ---------- */
function makeOrch({ opener, settings = {} } = {}) {
  const registry = {
    toolDefs: () => [], match: () => null, toolRuns: 0,
    tool: () => { registry.toolRuns++; return null; },
    get: (name) => ({ name, label: name }),
  };
  const memory = new Memory(new SecureStore('mem-' + Math.random().toString(36).slice(2)));
  const s = { data: { assistantName: 'Test', privacy: { llm: 'local', learning: false }, personality: { tone: 0.5 }, skills: {}, proactive: { enabled: true, openers: true, ...settings } } };
  const orch = new Orchestrator({ registry, memory, settings: s, log: { write() {} }, net: { online: true }, bus: { emit() {}, on() {} }, learner: null });
  orch.ollama = { ping: async () => false, url: () => 'u', model: () => 'm', chat: async () => ({ content: 'local answer' }) };
  orch.attachPersona({ persona: new Persona(), openers: opener });
  return { orch, registry, memory, settings: s };
}
const top = { kind: 'event', title: 'Team sync', at: NOW + 3600e3 };
const sticky = {
  compose: (uid, user) => (user && (user.guest || user.kid) ? null : { say: `On the board: Team sync at 2:00 PM. Start there, or is something else first?`, top, items: [top] }),
  explicit: () => ({ say: 'On the board: Team sync at 2:00 PM. Start there, or is something else first?', top, items: [top] }),
  detail: (t) => `"${t.title}" — 2:00 PM. Say "briefing" for the full rundown.`,
  enabled: () => true,
};

{
  const { orch, memory } = makeOrch({ opener: sticky });
  const r1 = await orch.handleUtterance({ text: 'hello there', user: 'O1', verify: false, source: 'test' });
  ok('session-open: first clean turn CARRIES the grounded suggestion', r1.say.includes('Team sync') && r1.opener === true);
  ok('session-open: the parked accept is kind:opener with NO tool name (unexecutable by construction)',
    memory.session('O1').pendingConfirm.kind === 'opener' && !memory.session('O1').pendingConfirm.name && typeof memory.session('O1').pendingConfirm.exp === 'number');
  const r2 = await orch.handleUtterance({ text: 'and another thing', user: 'O1', verify: false, source: 'test' });
  ok('session-open: shown ONCE per session (second turn gets none — no nagging)', !r2.say.includes('Team sync') && !r2.opener);
}
{
  const { orch, registry, memory } = makeOrch({ opener: sticky });
  await orch.handleUtterance({ text: 'hello', user: 'O2', verify: false, source: 'test' });
  const toolCallsBefore = registry.toolRuns;
  const r = await orch.handleUtterance({ text: 'yes', user: 'O2', verify: false, source: 'test' });
  ok('accept: "yes" surfaces read-only detail — no tool ever ran, no verify minted', r.say.includes('Team sync') && registry.toolRuns === toolCallsBefore && !r.verify && !r.confirm);
  const r3 = await orch.handleUtterance({ text: 'yes', user: 'O2', verify: false, source: 'test' });
  ok('accept: bare yes AFTER is told nothing is waiting (B-04 behavior intact)', /nothing waiting for a yes or no/i.test(r3.say));
  ok('accept: parked opener left no executable residue in the session', !memory.session('O2').pendingConfirm);
}
{
  const { orch } = makeOrch({ opener: sticky });
  await orch.handleUtterance({ text: 'hello', user: 'O3', verify: false, source: 'test' });
  const r = await orch.handleUtterance({ text: 'no', user: 'O3', verify: false, source: 'test' });
  ok('decline: "no" closes politely in the product voice', FORK.declineRe.test(r.say));
}
{
  // opener is ambient: an unrelated reply must NOT be eaten — it processes normally
  const { orch } = makeOrch({ opener: sticky });
  await orch.handleUtterance({ text: 'hello', user: 'O4', verify: false, source: 'test' });
  const clock = { name: 'clock', label: 'Clock', intents: [{ patterns: [/time/], run: async () => ({ say: 'It is 2 PM.' }) }], tools: [] };
  orch.registry = { ...orch.registry, match: () => ({ skill: clock, intent: clock.intents[0], match: ['time'] }) };
  const r = await orch.handleUtterance({ text: 'what time is it', user: 'O4', verify: false, source: 'test' });
  ok('ambient: unrelated reply drops the opener and is answered normally', /2 PM/.test(r.say) && r.skill === 'clock');
}
{
  // expiry: a stale opener must not hijack the next unrelated turn
  const { orch, memory } = makeOrch({ opener: sticky });
  await orch.handleUtterance({ text: 'hello', user: 'O5', verify: false, source: 'test' });
  memory.session('O5').pendingConfirm.exp = Date.now() - 1000; // force expiry
  const r = await orch.handleUtterance({ text: 'yes', user: 'O5', verify: false, source: 'test' });
  ok('expiry: a stale opener cannot be accepted later (fail-safe, told plainly)', /nothing waiting/i.test(r.say));
}
{
  const realOff = mk({ events: [{ title: 'Team sync', start: NOW + 3600e3 }], settings: { openers: false } });
  const { orch } = makeOrch({ opener: realOff });
  const r = await orch.handleUtterance({ text: 'hi', user: 'O6', verify: false, source: 'test' });
  ok('toggle: openers=false → no session-open append, no parked slot', !r.opener && !orch.memory.session('O6').pendingConfirm);
}
{
  const { orch, memory } = makeOrch({ opener: sticky });
  memory.ensureUser('guest-user').guest = true;
  const r = await orch.handleUtterance({ text: 'hi', user: 'guest-user', verify: false, source: 'test' });
  ok('privacy: guest profile → no suggestion stash this session (no schedule leak)', !r.opener && !memory.session('guest-user').pendingConfirm);
}
{
  // explicit ask: parks the same read-only accept; "start" is a yes-variant
  const { orch, memory } = makeOrch({ opener: sticky });
  const r = await orch.handleUtterance({ text: 'what should we start with', user: 'O7', verify: false, source: 'test' });
  ok('explicit: "what should we start with" → grounded board + confirm prompt', r.confirm === true && r.say.includes('Team sync'));
  ok('explicit: parked under kind:opener (still no tool)', memory.session('O7').pendingConfirm.kind === 'opener' && !memory.session('O7').pendingConfirm.name);
  const r2 = await orch.handleUtterance({ text: 'start', user: 'O7', verify: false, source: 'test' });
  ok('explicit: "start" accepted as the yes-variant → read-only detail', r2.say.includes('Team sync'));
}
{
  // single-question rule: a confirm turn must NOT carry the opener too
  const { orch, memory } = makeOrch({ opener: sticky });
  const lock = { name: 'smart_home', label: 'Home', sensitive: true, intents: [{ patterns: [/unlock/], run: async () => ({ say: 'unlocked' }) }], tools: [] };
  orch.registry = { ...orch.registry, match: () => ({ skill: lock, intent: lock.intents[0], match: ['unlock'] }), toolDefs: () => [], get: (n) => ({ name: n, sensitive: true, label: n }) };
  const r = await orch.handleUtterance({ text: 'unlock the door', user: 'O8', verify: false, source: 'test' });
  ok('single-question: a verify-gated first turn carries NO opener (never two questions)', r.verify === true && !r.opener && !memory.session('O8').pendingConfirm);
}

console.log(`\n${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
