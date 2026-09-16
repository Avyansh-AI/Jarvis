#!/usr/bin/env node
'use strict';
/**
 * Adaptive Learning & Personalization Layer (PERSONALIZATION.md) — proves:
 *  pipeline:   signals captured are METADATA ONLY, bounded ring, retention pruning
 *  routines:   min-signal threshold, weeks-span drift guard, baseline-multiplier guard,
 *              suggest-not-automate lifecycle (confirm/dismiss/stop)
 *  prefs:      inspectable topic→weight dict, capped, decays without reinforcement
 *  tone:       min-signal gate, hard ±0.15 drift cap around the slider
 *  rerank:     needs 2 corrections, applies to LLVM… (sic) LLM arg args, refuses sensitive skills
 *  anomaly:    flags odd-hour bursts only after a real baseline, flag-only (never blocks)
 *  registry:   auto-checkpoints, keeps 3 versions, rollback restores prior model state
 *  control:    learning-layer-only reset (other stores untouched), privacy.learning toggle off → nothing captured
 */
const fs = require('fs');
process.env.MAX_DATA_DIR = fs.mkdtempSync('/tmp/maxlearn-');
const { SecureStore } = require('../hub/secure-store');
const { Learner } = require('../hub/learn');
const { Orchestrator } = require('../hub/orchestrator');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('ok  ' + n); } else { fail++; console.log('FAIL ' + n); } };

const HOUR = 3600e3, DAY = 86400e3, WEEK = 7 * DAY;
const T0 = new Date('2026-06-01T10:00:00Z').getTime();

function makeLearn(extra = {}) {
  let T = T0;
  const logs = [], emitted = [];
  const settings = { data: { privacy: { learning: true, logRetentionDays: 30 }, proactive: { enabled: true } } };
  const learn = new Learner({
    store: new SecureStore('learning-' + Math.random().toString(36).slice(2)),
    modelsStore: new SecureStore('models-' + Math.random().toString(36).slice(2)),
    settings,
    log: { write: (t, d) => logs.push({ t, d }) },
    bus: { emit: (e, x) => emitted.push({ e, x }), on: () => {} },
    registry: { get: (name) => ({ name, sensitive: name === 'desktop' }) },
    now: () => T,
    ...extra,
  });
  return { learn, logs, emitted, settings, setT: (t) => { T = t; }, getT: () => T };
}

(async () => {
  /* 1-3: pipeline hygiene */
  {
    const { learn, setT } = makeLearn();
    learn.signal({ user: 'U', skill: 'weather', sentiment: 'positive', text: 'a very unique phrase ZEBRA-QUOKKA-9071' });
    const raw = JSON.stringify(learn.store.data);
    ok('pipeline: signal stores skill/hour/dow/sentiment metadata', raw.includes('"weather"') && raw.includes('"positive"') && learn.store.data.signals.length === 1);
    ok('pipeline: raw utterance text NEVER persists in the learning store', !raw.includes('ZEBRA-QUOKKA-9071'));
  }
  {
    const { learn, setT } = makeLearn();
    for (let i = 0; i < 2100; i++) learn.signal({ user: 'U', skill: 'chat' });
    ok('pipeline: signal ring bounded at 2000', learn.store.data.signals.length <= 2000);
    // retention: a 40-day-old signal gets pruned when a new one lands (30d retention)
    learn.store.data.signals = [{ ts: T0 - 40 * DAY, u: 'U', skill: 'old', h: 1, d: 1, s: 'neutral' }];
    setT(T0);
    learn.signal({ user: 'U', skill: 'chat' });
    ok('pipeline: signals older than logRetentionDays are pruned (retention rule reused)', learn.store.data.signals.every((x) => x.skill !== 'old'));
  }

  /* 4-8: routine learner + suggestion lifecycle */
  {
    const { learn, emitted, setT } = makeLearn();
    const wks = []; for (let w = 0; w < 3; w++) wks.push(T0 + w * WEEK); // same hour-of-week, 3 weeks
    setT(wks[0]); learn.signal({ user: 'U', skill: 'weather' });
    setT(wks[1]); learn.signal({ user: 'U', skill: 'weather' });
    setT(wks[1]); learn.signal({ user: 'U', skill: 'weather' });
    ok('routines: 3 repeats → NO suggestion yet (min-signal threshold 4)', learn.store.data.suggestions.length === 0);
    setT(wks[2]); learn.signal({ user: 'U', skill: 'weather' });
    const s = learn.store.data.suggestions[0];
    ok('routines: 4th repeat across 3 weeks surfaces a PENDING suggestion (not an action) with confidence',
      learn.store.data.suggestions.length === 1 && s.state === 'pending' && s.skill === 'weather' && s.confidence > 0);
    ok('routines: suggestion is announced as a suggestion for the proactive layer (bus)', emitted.some((e) => e.e === 'learn.suggest'));
    // single-week burst must NOT suggest (weeks-span drift guard)
    const solo = makeLearn();
    for (let i = 0; i < 4; i++) { solo.setT(T0 + i * HOUR); solo.learn.signal({ user: 'U', skill: 'music' }); }
    ok('routines: 4 repeats inside one week → still no suggestion (drift guard)', solo.learn.store.data.suggestions.length === 0);
    // high flat baseline must NOT let one bucket stand out (baseline-multiplier guard)
    const flat = makeLearn();
    for (const skill of ['a', 'b']) for (let b = 0; b < 168; b++) for (let n = 0; n < 3; n++) {
      flat.setT(T0 + b * HOUR + n); flat.learn.signal({ user: 'U', skill });
    }
    for (let i = 0; i < 5; i++) { flat.setT(T0 + 168 * HOUR + 37 * HOUR + i * WEEK / 5); flat.learn.signal({ user: 'U', skill: 'c' }); }
    const stoodOut = flat.learn.store.data.suggestions.some((x) => x.skill === 'c');
    ok('routines: one 5-hit bucket against a flat high baseline is NOT a routine (3× baseline guard)', !stoodOut);
    // lifecycle: stop is permanent
    const fId = learn.store.data.suggestions[0].id;
    ok('lifecycle: confirm marks confirmed', learn.feedback({ id: fId, action: 'confirm' }).state === 'confirmed');
    ok('lifecycle: stop adds to permanent stop-list', learn.feedback({ id: fId, action: 'stop' }).state === 'stopped' && learn.store.data.stopped.includes(fId));
    for (let w = 3; w < 8; w++) { setT(T0 + w * WEEK); learn.signal({ user: 'U', skill: 'weather' }); }
    ok('lifecycle: "stop learning this" is permanent — no new suggestion for that pattern', !learn.store.data.suggestions.some((x) => x.id === fId && x.state === 'pending'));
    ok('lifecycle: bad action rejected', learn.feedback({ id: fId, action: 'nuke' }).ok === false);
  }

  /* 9: preference embedding — inspectable, capped, decaying */
  {
    const { learn, setT } = makeLearn();
    for (let i = 0; i < 3; i++) learn.signal({ user: 'U', skill: 'music', text: 'play some music please' });
    for (let i = 0; i < 20; i++) learn.signal({ user: 'U', skill: 'music' });
    const p = learn.store.data.prefs.U.topics;
    ok('prefs: inspectable topic→weight dict (skill + keyword topics)', p['skill:music'] > 0 && p.music > 0);
    ok('prefs: weights capped at 1.0', Math.max(...Object.values(p)) <= 1);
    const before = p.music;
    setT(T0 + 14 * DAY); learn.signal({ user: 'U', skill: 'clock', text: 'what time is it' }); // 2 decay windows pass
    ok('prefs: unreinforced topics decay over weeks', learn.store.data.prefs.U.topics.music < before);
  }

  /* 10: adaptive tone — min-signal gate + hard drift cap */
  {
    const { learn, setT } = makeLearn();
    for (let i = 0; i < 19; i++) learn.signal({ user: 'U', sentiment: 'frustrated' });
    ok('tone: no adaptation under 20 signals (min-signal gate)', learn.toneFor('U', 0.5) === 0.5);
    for (let i = 0; i < 60; i++) learn.signal({ user: 'U', sentiment: 'frustrated' });
    const drift = learn.store.data.tone.U.recent - learn.store.data.tone.U.long;
    ok('tone: long frustration shifts drift negative but hard-capped at ±0.15', drift < -0.05 && learn.toneFor('U', 0.5) >= 0.35 && learn.toneFor('U', 0.5) < 0.5);
  }

  /* 11-13: correction-based re-ranker */
  {
    const { learn, logs, getT, setT } = makeLearn();
    const prev = () => ({ skill: 'smart_home', target: 'turn on the office light', at: getT() });
    learn.signal({ user: 'U', text: 'no i meant the bedroom light', prevResolved: prev() });
    ok('rerank: a single correction does NOT steer yet (needs 2)', learn.applyCorrection('U', 'smart_home', 'office light') === null);
    learn.signal({ user: 'U', text: 'no i meant the bedroom light', prevResolved: prev() });
    const re = learn.applyCorrection('U', 'smart_home', 'office light');
    ok('rerank: second correction → applyCorrection steers office→bedroom, logged', !!re && re.to === 'bedroom light' && logs.some((l) => l.t === 'learn.rerank'));
    learn.signal({ user: 'U', text: 'i said the vault file', prevResolved: { skill: 'desktop', target: 'open the notes file', at: getT() } });
    learn.signal({ user: 'U', text: 'i said the vault file', prevResolved: { skill: 'desktop', target: 'open the notes file', at: getT() } });
    ok('rerank: NEVER steers a sensitive skill (gates are off-limits to learning)', learn.applyCorrection('U', 'desktop', 'notes file') === null);
    // stale context (5 min later) is not a correction
    const stale = makeLearn();
    stale.learn.signal({ user: 'U', text: 'no i meant the bedroom light', prevResolved: { skill: 'smart_home', target: 'office light', at: stale.getT() - 5 * 60e3 } });
    ok('rerank: corrections must land right after the mistake (2-min window)', !stale.learn.store.data.corrections.U || stale.learn.store.data.corrections.U.length === 0);
  }

  /* 14-15: anomaly detector — flag only after a real baseline, never blocks */
  {
    const { learn, logs, emitted, setT } = makeLearn();
    for (let d = 0; d < 30; d++) for (let i = 0; i < 5; i++) { setT(T0 + d * DAY + i * 600e3); learn.signal({ user: 'U', skill: 'chat', text: 'day chat' }); }
    // now a burst at odd hours (3-5am equivalent: +17h from 10:00 anchor)
    let flag = null;
    for (let i = 0; i < 40; i++) { setT(T0 + 30 * DAY + 17 * HOUR + i * 10 * 60e3); const f = learn.signal({ user: 'U', skill: 'chat', text: 'odd' }) || flag; flag = f; }
    const a = learn.store.data.anomaly.U;
    ok('anomaly: odd-hour + burst day after 30d baseline → review flag raised (event + log + bus)',
      a.flags.length === 1 && logs.some((l) => l.t === 'security.anomaly') && emitted.some((e) => e.e === 'security.anomaly'));
    ok('anomaly: flag is reviewOnly (it can never block or approve)', a.flags[0].reviewOnly === true && a.flags[0].z >= 3);
    const usual = makeLearn();
    for (let d = 0; d < 30; d++) for (let i = 0; i < 5; i++) { usual.setT(T0 + d * DAY + i * 600e3); usual.learn.signal({ user: 'U', skill: 'chat' }); }
    for (let i = 0; i < 35; i++) { usual.setT(T0 + 30 * DAY + i * 80e3); usual.learn.signal({ user: 'U', skill: 'chat' }); } // burst, but staying inside the USUAL 10:00 hour
    ok('anomaly: same-size burst inside the usual hour → no flag (not just a volume rule)', usual.learn.store.data.anomaly.U.flags.length === 0);
    const cold = makeLearn();
    for (let d = 0; d < 10; d++) for (let i = 0; i < 5; i++) { cold.setT(T0 + d * DAY + i * 600e3); cold.learn.signal({ user: 'U', skill: 'chat' }); }
    for (let i = 0; i < 40; i++) { cold.setT(T0 + 10 * DAY + 17 * HOUR + i * 10 * 60e3); cold.learn.signal({ user: 'U', skill: 'chat' }); }
    ok('anomaly: cold start (<100 signals, <7 days) cannot flag anything', cold.learn.store.data.anomaly.U.flags.length === 0);
  }

  /* 16: model registry — checkpoints + rollback */
  {
    const { learn, setT } = makeLearn();
    for (let w = 0; w < 30; w++) { setT(T0 + w * WEEK); learn.signal({ user: 'U', skill: 'weather' }); }
    for (let i = 0; i < 240; i++) { setT(T0 + 31 * WEEK + i * HOUR / 4); learn.signal({ user: 'U', skill: 'chat' }); }
    const reg = learn.registryStore.data.models;
    const v1 = reg.routines.current;
    const bucketsV1 = JSON.stringify(reg.routines.versions[reg.routines.versions.length - 1].blob.routines);
    for (let i = 0; i < 200; i++) { setT(T0 + 32 * WEEK + i * HOUR / 4); learn.signal({ user: 'U', skill: 'chat' }); }
    ok('registry: checkpoints accumulate (auto every 100 signals)', reg.routines.current > v1 && reg.routines.versions.length >= 2);
    for (let i = 0; i < 1200; i++) { setT(T0 + 33 * WEEK + i * HOUR / 8); learn.signal({ user: 'U', skill: 'chat' }); }
    ok('registry: keeps at most 3 versions', reg.routines.versions.length <= 3);
    const before = learn.store.data.routines;
    const rb = learn.rollback('routines');
    ok('registry: rollback restores the previous version blob', rb.ok && learn.store.data.routines !== before && JSON.stringify(learn.store.data.routines) === JSON.stringify(rb && reg.routines.versions[reg.routines.versions.length - 1].blob.routines));
    ok('registry: rollback refuses when no earlier version exists', makeLearn().learn.rollback('tone').ok === false);
  }

  /* 17: reset is learning-layer-only; other stores untouched; toggle off captures nothing */
  {
    const other = new SecureStore('memory-marshal');
    other.data.marker = 'KEEP-ME-77';
    other.save();
    const { learn, setT } = makeLearn();
    for (let i = 0; i < 50; i++) learn.signal({ user: 'U', skill: 'music' });
    learn.checkpointAll('test');
    const r = learn.reset();
    ok('control: reset wipes signals, models and version history', r.ok && learn.store.data.signals.length === 0 && Object.keys(learn.registryStore.data.models).length === 0);
    ok('control: reset does NOT touch other stores (memory intact)', new SecureStore('memory-marshal').data.marker === 'KEEP-ME-77');
    const off = makeLearn();
    off.settings.data.privacy.learning = false;
    for (let i = 0; i < 10; i++) off.learn.signal({ user: 'U', skill: 'music', text: 'music' });
    ok('control: privacy.learning = off → nothing captured at all', off.learn.store.data.signals.length === 0 && !off.learn.store.data.prefs.U);
  }

  /* 18: orchestrator hook contract — _finish emits learning signals with prevResolved */
  {
    const recs = [];
    const learner = { signal: (x) => recs.push(x), toneFor: (u, b) => b, applyCorrection: () => null };
    const registry = { toolDefs: () => [{ name: 'n', description: 'd', input_schema: { type: 'object' } }], match: () => null, tool: () => null, get: () => null };
    const memory = {
      _s: {}, session(id) { return (this._s[id] = this._s[id] || { turns: [], mode: null }); },
      contextFor: () => ({ facts: [], prefs: {} }), countIntent: () => {}, setPending: () => {},
      addTurn: () => {}, ensureUser: (id) => ({ id, prefs: {} }), pendingTask: () => null, clearPending: () => {},
    };
    const settings = { data: { assistantName: 'Max', privacy: { llm: 'local', learning: true }, personality: { tone: 0.5 }, skills: {} } };
    const orch = new Orchestrator({ registry, memory, settings, log: { write() {} }, net: { online: true }, bus: { emit() {}, on() {} }, learner });
    orch.ollama = { ping: async () => false, url: () => '', model: () => '' };
    await orch.handleUtterance({ text: 'zz no intent here', user: 'U', verify: false, source: 'http' });
    await orch.handleUtterance({ text: 'no i meant the bedroom light', user: 'U', verify: false, source: 'http' });
    ok('orchestrator: every finished turn emits a learning signal with metadata only',
      recs.length === 2 && recs.every((r) => r.user === 'U' && typeof r.skill !== 'undefined'));
    ok('orchestrator: second turn carries prevResolved for correction learning',
      !!recs[1].prevResolved && typeof recs[1].prevResolved.target === 'string');
  }

  /* 19: transparency — accumulation is VISIBLE before the suggestion threshold (the reported "not learning" bug) */
  {
    const { learn, setT } = makeLearn();
    setT(T0); learn.signal({ user: 'U', skill: 'clock' });
    let st = learn.state('U');
    ok('emerging: one occurrence is noise — nothing listed yet', st.emerging.length === 0);
    setT(T0 + 600e3); learn.signal({ user: 'U', skill: 'clock' });
    setT(T0 + 1200e3); learn.signal({ user: 'U', skill: 'clock' });
    st = learn.state('U');
    const e = st.emerging.find((x) => x.skill === 'clock');
    ok('emerging: repeated sub-threshold pattern IS visible with progress vs guardrails (n/4, weeks/2) — but NOT a suggestion yet',
      !!e && e.n === 3 && e.weeks === 1 && e.needed.hits === 4 && e.needed.weeks === 2 && st.routines.length === 0);
    ok('emerging: entries are metadata-only (day/hour numbers — never text)', typeof e.hour === 'number' && typeof e.dow === 'number');
    setT(T0 + WEEK); learn.signal({ user: 'U', skill: 'clock' }); // 4th hit, 2nd week, same hour-of-week bucket
    st = learn.state('U');
    ok('emerging: pattern matures OUT of still-learning into a real suggestion once guardrails pass',
      st.routines.length === 1 && !st.emerging.some((x) => x.skill === 'clock'));
    const scope = makeLearn();
    for (let i = 0; i < 3; i++) scope.learn.signal({ user: 'A', skill: 'weather' });
    ok('emerging: per-user transparency scope respected', scope.learn.state('A').emerging.length === 1 && scope.learn.state('B').emerging.length === 0);
    const stopped = makeLearn();
    for (let w = 0; w < 3; w++) { stopped.setT(T0 + w * WEEK); for (let i = 0; i < 2; i++) stopped.learn.signal({ user: 'U', skill: 'music' }); }
    const sid = stopped.learn.store.data.suggestions[0].id;
    stopped.learn.feedback({ id: sid, action: 'stop' });
    for (let w = 3; w < 5; w++) { stopped.setT(T0 + w * WEEK); stopped.learn.signal({ user: 'U', skill: 'music' }); }
    ok('emerging: "stop learning this" hides all future progress for that pattern (no shadow tracking)',
      !stopped.learn.state('U').emerging.some((x) => x.skill === 'music'));
  }

  /* 20: MAX_DEBUG verbose signal-capture logging — opt-in per process, metadata-only */
  {
    const saved = process.env.MAX_DEBUG;
    delete process.env.MAX_DEBUG;
    const { learn, logs } = makeLearn();
    learn.signal({ user: 'U', skill: 'weather', text: 'secret words PANGOLIN-42' });
    ok('debug: MAX_DEBUG unset → zero learn.debug events (no production log overhead)', logs.filter((l) => l.t === 'learn.debug').length === 0);
    process.env.MAX_DEBUG = '1';
    learn.signal({ user: 'U', skill: 'weather', text: 'secret words PANGOLIN-42' });
    const dbg = logs.filter((l) => l.t === 'learn.debug');
    ok('debug: MAX_DEBUG=1 → every captured signal provably reaches the pipeline (one event per signal)',
      dbg.length === 1 && dbg[0].d.what === 'signal' && dbg[0].d.skill === 'weather' && dbg[0].d.total === 2);
    ok('debug: verbose capture stays metadata-only — raw text NEVER logged even in debug mode', !JSON.stringify(dbg).includes('PANGOLIN-42'));
    if (saved === undefined) delete process.env.MAX_DEBUG; else process.env.MAX_DEBUG = saved;
  }

  /* 21: model updates trigger on a realistic cadence — first auto-checkpoint within days, not weeks */
  {
    const { learn } = makeLearn();
    for (let i = 0; i < 99; i++) learn.signal({ user: 'U', skill: 'chat' });
    ok('models: nothing checkpoints before the 100-signal cadence point', learn.registryStore.data.models.routines === undefined);
    learn.signal({ user: 'U', skill: 'chat' });
    ok('models: 100th signal fires an automatic checkpoint end-to-end; guardrail surface reports the real cadence',
      (learn.registryStore.data.models.routines || {}).current === 1 && learn.state('U').guardrails.checkpointEvery === 100);
  }

  console.log(`\n${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
