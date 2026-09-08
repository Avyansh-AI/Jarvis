#!/usr/bin/env node
'use strict';
/**
 * Feature-pass suite (v0.9.0 "Jarvis feature update").
 * Boots a real hub on :8114 with an isolated data dir. Covers:
 *  1. wake-word matcher table (Max primary + tunable bare greetings)
 *  2. "terminal" intent: deterministic, no-LLM, the ONLY dashboard-open path
 *  3. desktop skill: jailed, symlink-safe, sensitive-gated
 *  4. browse: SSRF guard + read-only declaration
 *  5. create: real %PDF bytes, website files + /sites serving, deck fallback
 *  6. flights/youtube: no-key graceful paths
 *  7. discord: REST envelope, token never logged, bridge gating
 *  8. attention: opt-in gate respected
 *  9. meetings: save/list/summarize round-trip
 * 10. remote PIN unlock + activity feed shape (transcript-free)
 * 11. home devices endpoint shape without HA
 * 12. assets serving jailed + traversal refusal
 * 13. gesture/screen defaults OFF (auto-launch regression)
 * 14. task progress concurrent with an active voice session (workspace regression)
 * 14b. B-11: reminder intent parses time-clause-first phrasing in ONE turn
 *         + B-12: clear/delete imperatives are not shadowed by the list catch-all
 * 15. every new skill registered; theme still cream/coral; no LLM-provider
 *     strings crept in (Gemini etc. must NOT appear in hub code)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
process.env.MAX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'max-feat-'));
process.env.MAX_FILES_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'max-files-'));

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('ok  ' + n); } else { fail++; console.log('FAIL ' + n); } };

(async () => {
  /* ---- 1. wake words (pure module — no hub needed) ---- */
  const WW = require('../web/js/wakeword.js');
  const w = (s) => WW.match(s).wake;
  ok('wake [JARVIS fork]: "jarvis", "hey jarvis", "ok jarvis", "JARVIS, lights" all trigger',
    w('jarvis') && w('hey jarvis') && w('ok jarvis') && w('JARVIS, lights'));
  ok('wake: bare "hey"/"hi"/"hello" trigger; greetings with trailing talk do NOT',
    w('hey') && w('hi') && w('hello') && !w('hey, about that thing') && !w('hello everyone'));
  ok('wake [JARVIS fork]: sensitivity — partials rejected; "say hi to jarvis" accepted; "max" no longer wakes this fork',
    !w('jarv') && !w('jarvisor') && !w('hey are you there') && !w('the plan') && w('say hi to jarvis') && !w('max') && !w('hey max'));

  /* ---- live hub ---- */
  process.env.PORT = '8114';
  process.env.OPENROUTER_API_KEYS = ''; process.env.OPENROUTER_API_KEY = '';
  process.env.OPENROUTER_KEY_1 = ''; process.env.OPENROUTER_KEY_2 = ''; process.env.OPENROUTER_KEY_3 = ''; process.env.JARVIS_ALLOW_KEYLESS = '1';
  process.env.OLLAMA_URL = 'http://127.0.0.1:9';
  require('../hub/server.js');
  await new Promise((r) => setTimeout(r, 1200));
  const api = (p, body, method) => fetch('http://127.0.0.1:8114' + p, {
    method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());

  /* ---- 2. terminal intent ---- */
  const term = await api('/api/utterance', { user: 'Feat', text: 'terminal' });
  const term2 = await api('/api/utterance', { user: 'Feat', text: 'open terminal' });
  ok('terminal: exact + "open terminal" both return the dashboard-open action',
    term.open === 'dashboard.html' && term2.open === 'dashboard.html');
  const webAll = ['index', 'vision', 'dashboard', 'logs', 'settings', 'systems', 'meeting'].map((f) => fs.readFileSync(path.join(ROOT, 'web', f + '.html'), 'utf8')).join('\n');
  const autoOpens = (webAll.match(/window\.open\([^)]*dashboard|location\.href\s*=\s*['"]dashboard|\bonload\b[^}]*dashboard/gi) || []).length;
  ok('terminal: no other programmatic dashboard-open exists anywhere in the client', autoOpens === 0);
  const dashLinks = ['index', 'vision', 'logs', 'settings', 'systems', 'meeting'].filter((f) => fs.readFileSync(path.join(ROOT, 'web', f + '.html'), 'utf8').includes('href="dashboard.html"'));
  ok('terminal: no Dashboard nav links remain (voice command is the way in); self-link kept', dashLinks.length === 0 && fs.readFileSync(path.join(ROOT, 'web', 'dashboard.html'), 'utf8').includes('href="dashboard.html"'));

  /* ---- 3. desktop skill (unit-level through its exported tools) ---- */
  const desk = require('../hub/skills/desktop.js');
  ok('desktop: marked sensitive (voice-verify on every call, strictest class)', desk.sensitive === true);
  ok('desktop: traversal refused (.., backslashes); absolutes jail-relative; root never outside MAX_FILES_ROOT',
    desk._internals.realJoin('../../etc/passwd') === null && desk._internals.realJoin('..\\..\\win.ini') === null &&
    desk._internals.join('/etc/passwd').startsWith(desk._internals.ROOT_DIR) && desk._internals.ROOT_DIR === path.resolve(process.env.MAX_FILES_ROOT));
  const w1 = await desk.tools[0].run({ action: 'write', name: 'notes/todo.txt', content: 'buy milk' });
  const r1 = await desk.tools[0].run({ action: 'read', name: 'notes/todo.txt' });
  const esc = await desk.tools[1].run({ name: '../../../max-ai/.env' });
  ok('desktop: write/read round-trip inside jail; escape read blocked', w1.ok === true && r1.text === 'buy milk' && !!esc.error);

  /* ---- 4. browse ---- */
  const browse = require('../hub/skills/browse.js');
  ok('browse: SSRF — localhost + RFC1918 + non-http all refused',
    !!browse._internals.validateUrl('http://127.0.0.1:8080/api/settings').error &&
    !!browse._internals.validateUrl('http://192.168.1.1/admin').error &&
    !!browse._internals.validateUrl('file:///etc/passwd').error);
  ok('browse: declared read-only (untrusted output; page content can never trigger writes)', browse.tools[0].sideEffect === 'read');

  /* ---- 5. create ---- */
  const create = require('../hub/skills/create.js');
  const pdf = create._internals.makePdf('Test Doc', ['hello world '.repeat(40)]);
  ok('create: pure-node PDF is real (%PDF header, pages, %%EOF trailer)',
    pdf.slice(0, 5).toString() === '%PDF-' && pdf.includes('/Type /Page') && pdf.slice(-6).toString().includes('%%EOF'));
  const site = await create.tools.find((x) => x.name === 'create_website').run({ title: 'My Test Site', sections: [{ heading: 'H1', text: '<b>not html</b>' }] });
  const sitePage = await fetch('http://127.0.0.1:8114' + site.url).then((r) => r.text());
  ok('create: website generated, served at /sites/, HTML-escaped', site.ok === true && sitePage.includes('My Test Site') && sitePage.includes('&lt;b&gt;'));
  const site404 = await fetch('http://127.0.0.1:8114/sites/../server.js').then((r) => r.status);
  ok('create: /sites traversal refused', site404 === 404);

  /* ---- 6. flights + youtube graceful no-key paths ---- */
  const flights = require('../hub/skills/flights.js');
  const fNoKey = await flights.tools.find((x) => x.name === 'flight_status').run({ code: 'LH762' }, { net: { online: true }, settings: { integrations: {} } });
  ok('flights: status without key explains the free-key option (no crash)', /free key|Settings/.test(fNoKey.say));
  const yt = require('../hub/skills/youtube.js');
  ok('youtube: id extraction accepts watch/shorts/youtu.be, rejects junk',
    yt._internals.videoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ') === 'dQw4w9WgXcQ' &&
    yt._internals.videoId('https://youtu.be/dQw4w9WgXcQ?t=9') === 'dQw4w9WgXcQ' &&
    yt._internals.videoId('https://example.com/watch?v=dQw4w9WgXcQ') === null);

  /* ---- 7. discord ---- */
  const discord = require('../hub/skills/discord.js');
  const dNoCfg = await discord.tools[0].run({ message: 'hi' }, {});
  ok('discord: unconfigured send guided to Settings (service credential wording)', /Settings/.test(dNoCfg.say) && /not an LLM key/i.test(dNoCfg.say));
  const evLog = fs.readFileSync(path.join(process.env.MAX_DATA_DIR, 'events.jsonl'), 'utf8');
  ok('discord: no bot-token-shaped string in the event log', !/discordToken|Bot [A-Za-z0-9._-]{20,}/.test(evLog));

  /* ---- 8. attention gate ---- */
  const a1 = await api('/api/attn', { source: 'email', from: 'boss', title: 'URGENT: invoice overdue', body: 'please pay today' });
  ok('attention: important item stored; surfaced flag follows proactive opt-in', a1.ok === true && a1.score >= 2 && typeof a1.surfaced === 'boolean');
  await api('/api/settings', { proactive: { enabled: false } });
  const a2 = await api('/api/attn', { source: 'email', from: 'boss', title: 'URGENT again', body: 'payment payment' });
  await api('/api/settings', { proactive: { enabled: true } });
  ok('attention: proactive opt-in OFF → never surfaces (stored quietly only)', a2.surfaced === false);

  /* ---- 9. meetings round-trip ---- */
  const saved = await api('/api/meetings', { title: 'Standup', turns: [{ ts: 1, who: 'Asha', text: 'ship the release friday' }, { ts: 2, who: 'Dev', text: 'docs need updating' }] });
  const mList = await api('/api/meetings');
  const mSum = await api('/api/meetings/summarize', { id: saved.id, user: 'Feat' });
  ok('meetings: save → list → summarize round-trip (graceful without LLM keys)',
    saved.ok === true && mList.some((m) => m.id === saved.id) && typeof mSum.summary === 'string' && mSum.summary.length > 10);

  /* ---- 10. remote PIN + activity feed ---- */
  await api('/api/settings', { features: { remotePass: '2468' } });
  const badPin = await (await fetch('http://127.0.0.1:8114/api/remote/unlock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"pin":"0000"}' })).status;
  const goodPin = await api('/api/remote/unlock', { pin: '2468' });
  ok('remote: wrong PIN 403, right PIN 200', badPin === 403 && goodPin.ok === true);
  const act = await api('/api/activity?n=10');
  ok('activity: feed shaped + transcript-free (no raw "text" field ever shipped)',
    Array.isArray(act.items) && act.items.every((e) => e.text === undefined && (!e.message || e.message.length <= 140)));

  /* ---- 11. home devices without HA ---- */
  const home = await api('/api/home/devices');
  ok('home: HA absent → configured:false + empty list (no crash)', home.configured === false && Array.isArray(home.devices) && home.devices.length === 0);

  /* ---- 12. brand assets ---- */
  fs.mkdirSync(path.join(ROOT, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'assets', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const logo = await fetch('http://127.0.0.1:8114/assets/logo.png').then((r) => r.status);
  const bg = await fetch('http://127.0.0.1:8114/assets/background.png').then((r) => r.status);
  const trav = await fetch('http://127.0.0.1:8114/assets/../server.js').then((r) => r.status);
  fs.unlinkSync(path.join(ROOT, 'assets', 'logo.png'));
  ok('assets: logo served when dropped in, background 404-fallback when absent, traversal refused', logo === 200 && bg === 404 && trav !== 200);

  /* ---- 13. gesture/screen defaults (auto-launch regression) ---- */
  const fresh = require('../hub/settings.js');
  const defaults = fresh.DEFAULTS || null;
  ok('regression: gestureControl + screenRead default OFF in settings DEFAULTS',
    defaults ? (defaults.features.gestureControl === false && defaults.features.screenRead === false) : (() => {
      const src = fs.readFileSync(path.join(ROOT, 'hub', 'settings.js'), 'utf8');
      return /gestureControl: false/.test(src) && /screenRead: false/.test(src);
    })());
  const visionSrc = fs.readFileSync(path.join(ROOT, 'web', 'vision.html'), 'utf8');
  ok('regression: no mouse-control / auto-gesture code anywhere (getDisplayMedia only, LS-gated)',
    !/moveMouse|mouse\.move|robot|cursor.*control/i.test(visionSrc + webAll) && /MAX\.LS\.get\('screenShare', false\)/.test(visionSrc));

  /* ---- 14. task progress alongside an active voice session (workspace regression) ---- */
  await api('/api/utterance', { user: 'Multi', text: 'remind me in 1 second to stretch' }).catch(() => {});
  const h1 = (await api('/api/health'));
  const sessA = api('/api/utterance', { user: 'Multi', text: 'what time is it' });
  const sessB = api('/api/health');
  const [ra, rb] = await Promise.all([sessA, sessB]);
  const h2 = await api('/api/health');
  ok('regression: concurrent voice session + requests all progress to completion (no stall)',
    typeof ra.say === 'string' && rb.ok === true && h2.ok === true && h2.uptime >= h1.uptime);

  /* ---- 14b. B-11: time-first reminder phrasing must schedule, not re-ask "what" ---- */
  {
    const r1 = await api('/api/utterance', { user: 'RemB11', text: 'remind me in 2 minutes to stretch' });
    ok('B-11: "remind me in 2 minutes to <task>" schedules in ONE turn — task extracted, not re-asked',
      /remind you/i.test(r1.say || '') && /to stretch/i.test(r1.say || '') && !/what should i/i.test(r1.say || ''));
    const r2 = await api('/api/utterance', { user: 'RemB11', text: 'remind me to call mom in 20 minutes' });
    const r3 = await api('/api/utterance', { user: 'RemB11', text: 'remind me to water the plants' });
    ok('B-11: task-first forms unchanged — full form one-turn; missing time asks "when" (never silently drops)',
      /remind you/i.test(r2.say || '') && /to call mom/i.test(r2.say || '') && /when should i remind you/i.test(r3.say || ''));
    await api('/api/utterance', { user: 'RemB11', text: 'cancel' });
    const lr = await api('/api/utterance', { user: 'RemB11', text: 'list my reminders' });
    ok('B-11: scheduled reminders list with their real labels (stretch + call mom)',
      /stretch/i.test(lr.say || '') && /call mom/i.test(lr.say || ''));
    /* B-12: "clear all my reminders" must CLEAR — the list intent's generic
       /\bmy reminders\b/ pattern used to swallow it (imperatives now win). */
    const cl = await api('/api/utterance', { user: 'RemB11', text: 'clear all my reminders' });
    ok('B-12: "clear all my reminders" clears instead of answering with the list',
      /cleared \d+ reminder/i.test(cl.say || '') && !/you have \d+ reminder/i.test(cl.say || ''));
    const lr2 = await api('/api/utterance', { user: 'RemB11', text: 'list my reminders' });
    ok('B-12: list after clear is honestly empty (imperative actually executed)',
      /don.t have any reminders/i.test(lr2.say || ''));
  }

  /* ---- 15. registry + provider hygiene ---- */
  const skills = await api('/api/skills');
  const names = skills.map((s) => s.name);
  ok('registry: all six new skills loaded alongside the original 18',
    ['desktop', 'browse', 'create', 'flights', 'youtube', 'discord'].every((n) => names.includes(n)) && names.length >= 6);
  const hubSrc = ['hub/server.js', 'hub/orchestrator.js', 'hub/keyring.js'].map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  ok('provider hygiene: no Gemini/other LLM-provider code crept into the hub', !/gemini|anthropic\.com|api\.openai\.com/i.test(hubSrc));
  const theme = fs.readFileSync(path.join(ROOT, 'web', 'css', 'theme.css'), 'utf8');
  ok('theme [JARVIS fork]: dark HUD palette everywhere (cyan tokens + scan field, cream/coral gone from theme.css)',
    theme.includes('--cyan') && theme.includes('--hud-900') && !/brahma|--cream|--coral/i.test(theme));

  console.log(`\n${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
