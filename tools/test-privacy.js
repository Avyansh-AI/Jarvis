#!/usr/bin/env node
'use strict';
/**
 * Privacy & data-governance suite (Round 4).
 * Boots a real hub on :8105 with an isolated data dir and proves:
 *  - the "my data" view sees seeded data by category
 *  - export carries it; per-category delete REALLY removes it (re-export clean)
 *  - voiceprint/facts/sessions/schedule/stats/profile deletion each verified
 *  - event-log age retention prunes old entries but never corrupt-line evidence
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.MAX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'max-priv-'));
const D = process.env.MAX_DATA_DIR;

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('ok  ' + n); } else { fail++; console.log('FAIL ' + n); } };

(async () => {
  // unit: event-log age retention
  const { EventLog } = require('../hub/eventlog');
  const el = new EventLog('privtest');
  const old = JSON.stringify({ ts: Date.now() - 40 * 86400000, type: 'interaction' });
  const fresh = JSON.stringify({ ts: Date.now(), type: 'interaction' });
  fs.writeFileSync(el.file, old + '\n' + fresh + '\n' + 'CORRUPT-LINE\n');
  const pruned = el.pruneOlderThan(30);
  const kept = fs.readFileSync(el.file, 'utf8');
  ok('retention: entries older than 30d pruned', pruned === 1 && !kept.includes(old));
  ok('retention: fresh + unparseable lines survive (evidence kept until provably old)', kept.includes(fresh) && kept.includes('CORRUPT-LINE'));
  ok('retention: pruneOlderThan(0) is a no-op (safety)', el.pruneOlderThan(0) === 0);

  // live hub
  process.env.PORT = '8105';
  process.env.OPENROUTER_API_KEYS = '';
  process.env.OPENROUTER_API_KEY = '';
  process.env.OPENROUTER_KEY_1 = ''; process.env.OPENROUTER_KEY_2 = ''; process.env.OPENROUTER_KEY_3 = ''; process.env.JARVIS_ALLOW_KEYLESS = '1';
  process.env.OLLAMA_URL = 'http://127.0.0.1:9';
  require('../hub/server.js');
  await new Promise((r) => setTimeout(r, 900));
  const api = (p, body) => fetch('http://127.0.0.1:8105' + p, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = (r) => r.json();

  // seed every category we claim to govern
  await api('/api/utterance', { text: 'my favorite tea is cardamom', user: 'priv' });
  await api('/api/utterance', { text: 'take a note buy oat milk on Friday', user: 'priv' });
  await api('/api/utterance', { text: 'remind me to stretch in 50 minutes', user: 'priv' });
  await api('/api/voiceprint/enroll', { user: 'priv', features: [0.1, 0.2, 0.3, 0.4, 0.5] });
  await api('/api/utterance', { text: 'what time is it', user: 'priv' });

  const v1 = await (await api('/api/mydata?user=priv')).json();
  ok('view: facts seeded & counted', v1.facts.count >= 1 && v1.facts.items.some((f) => /cardamom/.test(f)));
  ok('view: notes seeded & counted', v1.notes.count >= 1);
  ok('view: schedule seeded & counted', v1.schedule.count >= 1);
  ok('view: voiceprint enrolled flag', v1.voiceprint.enrolled === true);
  ok('view: live session visible', v1.sessions.live === true && v1.sessions.turns >= 1);

  const exp = await (await api('/api/mydata/export?user=priv')).text();
  ok('export is a full JSON copy', exp.includes('cardamom') && exp.includes('exportedAt'));
  const cd = /^attachment/i.test((await api('/api/mydata/export?user=priv')).headers.get('content-disposition') || '');
  ok('export downloads as attachment', cd);

  // per-category deletes are REAL (verified through a fresh read)
  const d1 = await (await api('/api/mydata/delete', { user: 'priv', category: 'facts' })).json();
  ok('delete facts: removed + post-view shows zero', d1.removed >= 1 && d1.view.facts.count === 0);
  const exp2 = await (await api('/api/mydata/export?user=priv')).text();
  ok('delete is real: re-export no longer contains the fact', !exp2.includes('cardamom'));
  const d2 = await (await api('/api/mydata/delete', { user: 'priv', category: 'voiceprint' })).json();
  ok('delete voiceprint: enrolled flag flips', d2.removed === 1 && d2.view.voiceprint.enrolled === false);
  const d3 = await (await api('/api/mydata/delete', { user: 'priv', category: 'notes' })).json();
  ok('delete notes: count zeroed', d3.view.notes.count === 0);
  const d4 = await (await api('/api/mydata/delete', { user: 'priv', category: 'schedule' })).json();
  ok('delete schedule: timers/reminders gone', d4.view.schedule.count === 0);
  const d5 = await (await api('/api/mydata/delete', { user: 'priv', category: 'sessions' })).json();
  ok('delete sessions: live session gone', d5.view.sessions.live === false);
  const d6 = await (await api('/api/mydata/delete', { user: 'priv', category: 'stats' })).json();
  ok('delete stats: counters cleared', Object.keys(d6.view.stats.counts).length === 0);
  const bad = await api('/api/mydata/delete', { user: 'priv', category: 'banking' });
  ok('unknown category refused (400)', bad.status === 400);
  const d7 = await (await api('/api/mydata/delete', { user: 'priv', category: 'profile' })).json();
  ok('delete profile: profile no longer exists', d7.view.profile.exists === false);

  // retention defaults are exposed + sane
  const st = await (await api('/api/settings')).json();
  ok('retention knobs live in privacy settings (30d logs, 24h sensors)', st.privacy.logRetentionDays === 30 && st.privacy.sensorTtlHours === 24);

  console.log(`\n${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
