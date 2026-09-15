#!/usr/bin/env node
'use strict';
/**
 * Chaos regression suite — Round 3.
 * For every component: simulate the failure, assert the safe + visible outcome.
 *
 *   Phase A (in-process): store corruption/power-loss/disk-full, clock skew,
 *                         session+task hygiene, scheduler storms, skill-load
 *                         isolation, integration outages (poisoned net).
 *   Phase B (real hubs):  dead cloud at boot, garbage/truncated LLM replies,
 *                         brain recovery when the outage clears, HA actuator
 *                         ambiguity (fail-safe), HA down (fail-closed),
 *                         security lockdown surviving a SIGKILL+restart,
 *                         supervisor crash-loop restarts.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

process.env.MAX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'max-chaos-'));
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('ok  ' + n); } else { fail++; console.log('FAIL ' + n); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
/* ---------- Phase A: in-process module chaos ---------- */

const { SecureStore } = require('../hub/secure-store');
const D = process.env.MAX_DATA_DIR;

// A1: disk full (ENOSPC) mid-save — old file intact, failure reported, process alive
const s1 = new SecureStore('chaos1');
s1.data = { a: 1, deep: { b: 'keepme' } };
s1.save();
const origWrite = fs.writeFileSync;
let reported = null;
SecureStore.onError = (name, err) => { reported = { name, code: err.code }; };
fs.writeFileSync = () => { const e = new Error('no space left on device'); e.code = 'ENOSPC'; throw e; };
let threw = null;
try { s1.save(); } catch (e) { threw = e.code; }
ok('ENOSPC: save() throws cleanly instead of corrupting', threw === 'ENOSPC');
s1.saveSoon(); // debounced path must swallow + report, not crash the loop
await sleep(450);
fs.writeFileSync = origWrite;
ok('ENOSPC: debounced save reports via onError hook', !!reported && reported.name === 'chaos1' && reported.code === 'ENOSPC');
const reread = new SecureStore('chaos1');
ok('ENOSPC: previous good data survives untouched', reread.data.a === 1 && reread.data.deep.b === 'keepme');

// A2: corrupt main, good backup → auto-recover + heal main
fs.writeFileSync(path.join(D, 'chaos1.enc.json'), '{"corrupted":true,garbage');
const healed = new SecureStore('chaos1');
ok('corrupt main recovers from .bak (values intact)', healed.data.a === 1 && healed.data.deep.b === 'keepme');
const verifyHeal = new SecureStore('chaos1');
ok('main file healed after recovery (re-decrypts fine)', verifyHeal.data.a === 1);

// A3: corrupt main AND corrupt backup → quarantine + fresh boot, never throw
const s3 = new SecureStore('chaos3');
s3.data = { gone: true }; s3.save();
fs.writeFileSync(path.join(D, 'chaos3.enc.json'), 'GARBAGE###');
fs.writeFileSync(path.join(D, 'chaos3.enc.json.bak'), 'ALSO GARBAGE###');
let booted = true, freshData;
try { freshData = new SecureStore('chaos3').data; } catch { booted = false; }
const quarantined = fs.readdirSync(D).filter((f) => f.startsWith('chaos3.enc.json.corrupt-'));
ok('fully corrupt store: constructor never throws (hub still boots)', booted && freshData && !freshData.gone);
ok('fully corrupt store: evidence quarantined, not overwritten', quarantined.length === 1);

// A4: torn .tmp from a crash is swept at load
const s4 = new SecureStore('chaos4'); s4.data = { v: 7 }; s4.save();
fs.writeFileSync(path.join(D, 'chaos4.enc.json.tmp'), 'partial-write-');
const s4b = new SecureStore('chaos4');
ok('torn .tmp swept at load, data intact', s4b.data.v === 7 && !fs.existsSync(path.join(D, 'chaos4.enc.json.tmp')));

// A5: power loss between tmp write and rename (simulated EBUSY) — old main intact
const origRename = fs.renameSync;
fs.renameSync = () => { const e = new Error('simulated power cut at rename'); e.code = 'EBUSY'; throw e; };
let race = null;
try { s4b.data.v = 8; s4b.save(); } catch (e) { race = e.code; }
fs.renameSync = origRename;
const s4c = new SecureStore('chaos4');
ok('power-cut at rename: old file still valid (v=7), tmp swept', race === 'EBUSY' && s4c.data.v === 7);
SecureStore.onError = null;

// A6–A8: clock skew on security tokens (fail-closed in both directions)
const { TokenBox } = require('../hub/tokens');
const T = { t: 1_000_000 };
const tb = new TokenBox({ now: () => T.t });
const tok = tb.issueVerify('owner');
T.t += 1000;
ok('token valid inside its window', tb.checkVerify(tok, 'owner') === true);
const tok2 = tb.issueVerify('owner');
T.t -= 60 * 60000; // NTP rollback past issuance
ok('clock rollback can NOT extend a token (fail-closed)', tb.checkVerify(tok2, 'owner') === false);
T.t = 1_000_000 + 6 * 60000; // forward jump: everything ages out early
ok('forward clock jump expires tokens early (fail-closed)', tb.checkVerify(tok2, 'owner') === false);
T.t = 2_000_000;
const ch = tb.issueChallenge('owner');
ok('challenge not consumable by another user AND survives their failed attempt',
  tb.takeChallenge(ch.id, 'mallory') === null && !!tb.takeChallenge(ch.id, 'owner'));

// A9: session RAM bound + idle reaping + pending-task TTL
const { Memory } = require('../hub/memory');
const mem = new Memory(new SecureStore('chaos-mem'));
for (let i = 0; i < 260; i++) mem.session('user-' + i).updated = Date.now();
ok('sessions bounded at 200 (network ids cannot OOM the hub)', mem.sessions.size <= 200);
const st = mem.session('stale-user'); st.updated = Date.now() - 3 * 3600e3;
mem._sweepSessions();
ok('idle sessions reaped (nothing hangs forever)', !mem.sessions.has('stale-user'));
mem.sessions.clear(); // leave the flood state behind for normal-operation checks
mem.setPending('u1', { skill: 'notes', step: 1 });
mem.session('u1').pendingTask.expiresAt = Date.now() - 1; // walk-away task
ok('stale multi-turn task expires safely (does not hijack next utterance)', mem.pendingTask('u1') === null && mem.session('u1').pendingTask === null);

// A10/A11: scheduler — overdue storms fire exactly once; cap at 500
const { Scheduler } = require('../hub/scheduler');
let fired = 0;
const sched = new Scheduler({ data: { jobs: [] }, save() {} }, () => fired++);
for (let i = 0; i < 120; i++) sched.add({ kind: 'timer', label: 't' + i, at: Date.now() - 1000 });
sched._tick();
const firedOnce = fired;
sched._tick();
ok('120 overdue jobs fire exactly once (no storm after downtime)', firedOnce === 120 && fired === 120);
sched.add({ kind: 'alarm', label: 'daily', at: Date.now() - 5000, repeat: 'daily', hour: 0, minute: 0 });
sched._tick();
const recJob = sched.store.data.jobs.find((j) => j.repeat === 'daily');
ok('recurring job after clock gap reschedules forward, not catch-up loop', recJob.at > Date.now() && fired === 121);
const big = new Scheduler({ data: { jobs: [] }, save() {} }, () => {});
for (let i = 0; i < 500; i++) big.add({ kind: 'timer', label: 'x' + i, at: Date.now() + 3600e3 + i });
let capped = null;
try { big.add({ kind: 'timer', label: 'one too many', at: Date.now() + 7200e3 }); } catch (e) { capped = e.message; }
ok('schedule capped at 500 pending jobs (RAM DoS refused visibly)', /full/i.test(capped || ''));

// A12: broken skill file cannot kill the registry/boot
const { Registry } = require('../hub/skills/registry');
const skDir = fs.mkdtempSync(path.join(os.tmpdir(), 'max-skills-'));
fs.writeFileSync(path.join(skDir, 'good.js'), 'module.exports = { name: "good", label: "Good", intents: [], tools: [] };');
fs.writeFileSync(path.join(skDir, 'bad.js'), 'throw new Error("corrupted skill payload");');
const reg = new Registry({ data: { skills: {} } }, { write() {} });
let regOk = true;
try { reg.load(skDir); } catch { regOk = false; }
ok('corrupt skill file isolated — registry boots the healthy ones', regOk && reg.skills.has('good') && !reg.skills.has('bad'));

// A13–A15: integration outages (simulated total failure of the network layer)
const net = require('../hub/net');
const origRetry = net.httpRetry;
net.httpRetry = async () => { const e = new Error('connect ECONNREFUSED 10.255.255.1:443 — simulated outage'); e.code = 'ECONNREFUSED'; throw e; };
const fresh = (p) => { delete require.cache[require.resolve(p)]; return require(p); };
const deadCtx = {
  settings: { homeAssistant: { url: 'http://172.16.0.9:8123', token: 'tok' } },
  log: { write() {} }, verified: true, net: { online: false }, user: { id: 'x' },
};
const cal = fresh('../hub/skills/calendar.js');
const imp = cal.intents.find((i) => i.patterns.some((p) => /import/.test(p.source)));
const calRes = await imp.run(['import calendar', 'calendar'], 'import calendar from http://10.255.255.1/feed.ics', deadCtx);
ok('calendar outage: graceful message, no crash', /couldn't read that ICS feed/i.test(calRes.say));
const wx = fresh('../hub/skills/weather.js');
const wxRes = await wx.intents[0].run(['weather in Paris', 'Paris'], 'weather in Paris', deadCtx);
ok('weather outage: graceful message, no crash', /couldn't get|couldn.t find|hiccup|weather/i.test(wxRes.say) && !/is now|degrees and/i.test(wxRes.say));
const sh = fresh('../hub/skills/smart_home.js');
const lightRes = await sh.intents[0].run(['turn on the kitchen', 'on', 'kitchen'], 'turn on the kitchen light', deadCtx);
ok('smart-home outage: hiccup reported, never claims success', /hiccup|isn.t configured/i.test(lightRes.say) && !/is now on/i.test(lightRes.say));
net.httpRetry = origRetry;

// A16: vehicle provider failure is honest (no false "Car locked.")
const veh = require('../hub/skills/vehicle.js');
const vehRes = await veh.intents[0].run(['lock the car', 'lock'], 'lock the car', { settings: { vehicle: { provider: 'tesla', token: 'x' } }, log: { write() {} } });
ok('vehicle provider failure: honest error, no false claim of success', !/Car locked\./.test(vehRes.say) && /wired|error|demo/i.test(vehRes.say));

// A17: satellite partition → offline event, queued commands flush on re-pair
const { Satellites } = require('../hub/satellites');
const sats = new Satellites({ write() {} });
const satsEvents = [];
sats.on('satellite.offline', (id) => satsEvents.push('offline:' + id));
const fakeClient = () => {
  const listeners = {};
  return {
    id: 'fake-' + Math.random().toString(36).slice(2, 7), sent: [],
    on: (t, f) => (listeners[t] = f),
    sendJSON(m) { this.sent.push(m); },
    close() { if (listeners.close) listeners.close(); },
    req: { socket: { remoteAddress: '10.0.0.44' } },
    __emit(o) { listeners.message(JSON.stringify(o)); },
    __close() { listeners.close(); },
  };
};
const c1 = fakeClient();
sats.handle(c1);
c1.__emit({ type: 'satellite.hello', id: 'kitchen-puck', caps: { speaker: true } });
const wasOnline = sats.list().find((n) => n.id === 'kitchen-puck')?.online;
c1.__close(); // network partition
const queued = sats.send('kitchen-puck', { type: 'satellite.say', text: 'hub is back' });
const c2 = fakeClient(); // re-pair after the drop
sats.handle(c2);
c2.__emit({ type: 'satellite.hello', id: 'kitchen-puck', caps: { speaker: true } });
const flushed = c2.sent.filter((m) => m.type === 'satellite.say' && m.text === 'hub is back').length;
ok('satellite drop is visible (offline event) and re-pair flushes the queue',
  wasOnline === true && queued === false && satsEvents.includes('offline:kitchen-puck') && flushed === 1);

// A18: UI edge-service guards exist (STT/TTS unavailable → visible, text path stays)
const idx = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
ok('TTS guard: speechSynthesis absence handled (text-only survives)', idx.includes("speechSynthesis' in window"));
ok('STT guard: SpeechRecognition absence/error has user-facing hint', /webkitSpeechRecognition/.test(idx) && /micErrorHint|not supported|SpeechRecognition/.test(idx));

/* ---------- Phase B: chaos against real booted hubs ---------- */

async function waitHealthy(port, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return true; } catch {}
    await sleep(250);
  }
  return false;
}
const spawned = new Set(); // never strand a hub on a port, even if an assertion explodes
process.on('exit', () => { for (const c of spawned) { try { c.kill('SIGKILL'); } catch {} } });
function bootHub(port, dataDir, extraEnv = {}) {
  const child = spawn('node', ['hub/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), MAX_DATA_DIR: dataDir, OPENROUTER_API_KEYS: 'chaos-dummy-key', OPENROUTER_API_KEY: '', OPENROUTER_KEY_1: 'chaos-dummy-key', OPENROUTER_KEY_2: 'chaos-dk-2', OPENROUTER_KEY_3: 'chaos-dk-3', OLLAMA_URL: 'http://127.0.0.1:9', MAX_NET_PROBE_URL: 'http://127.0.0.1:8131/probe', ...extraEnv }, // probe pinned local: the suite must not depend on WAN luck
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  spawned.add(child);
  child.once('exit', () => spawned.delete(child));
  child.bootLog = '';
  child.stdout.on('data', (d) => { child.bootLog += d; });
  child.stderr.on('data', (d) => { child.bootLog += d; });
  return child;
}
const api = (port, p, body) => fetch(`http://127.0.0.1:${port}` + p, {
  method: body ? 'POST' : 'GET',
  headers: { 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
}).then((r) => r.json().catch(() => ({}))).then((j) => ({ ...j, __status: undefined }));
/** Kill a booted hub and WAIT for the exit — port reuse races made B-boots flaky otherwise. */
async function killHub(h) {
  if (!h || h.exitCode !== null || h.signalCode !== null) return;
  h.kill('SIGKILL');
  await Promise.race([new Promise((r) => h.once('exit', r)), sleep(2500)]);
}
const OWNER_F = [0.1, 0.2, 0.3, 0.4, 0.5];
async function verifyOwner(port, user = 'owner') {
  const ch = await api(port, '/api/voiceprint/challenge?user=' + user);
  const v = await api(port, '/api/voiceprint/verify', { user, features: OWNER_F, challengeId: ch.id, spoken: 'I say ' + ch.phrase + ' clearly' });
  return v;
}

// Mock OpenRouter — behaviors switched by `orMode`
let orMode = 'ok';
const mockOR = http.createServer((req, res) => {
  if (req.method === 'GET') { res.setHeader('content-type', 'application/json'); return void res.end('{}'); } // net probe + misc GETs
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (orMode === 'garbage') { res.end('this is not JSON at all{'); }
    else if (orMode === 'truncated') { res.end('{"choices":[{"message":{"con'); } // cut mid-stream
    else if (orMode === 'dead500') { res.statusCode = 500; res.end('{"error":{"message":"upstream on fire"}}'); }
    else res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Mock cloud is healthy and answering.' } }] }));
  });
});
// Mock Home Assistant — POSTs succeed but the lock NEVER changes state (jammed actuator)
let haStates = [{ entity_id: 'lock.front_door', state: 'locked', attributes: { friendly_name: 'Front Door' } }];
const mockHA = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.method === 'GET' && req.url.startsWith('/api/states')) return void res.end(JSON.stringify(haStates));
  if (req.method === 'POST' && req.url.startsWith('/api/services/')) return void res.end('[]');
  res.statusCode = 404; res.end('{}');
});
await new Promise((r) => mockOR.listen(8131, '127.0.0.1', r));
await new Promise((r) => mockHA.listen(8132, '127.0.0.1', r));

// B1: cloud API stone dead at boot → deterministic skills live, fallback calm, health fine
let hub = bootHub(8097, fs.mkdtempSync(path.join(os.tmpdir(), 'max-chaos-b1-')), { OPENROUTER_BASE: 'http://127.0.0.1:9' });
ok('B1: hub boots serving while cloud is dead', await waitHealthy(8097));
const clockRes = await api(8097, '/api/utterance', { text: 'what time is it?' });
ok('B1: deterministic skills unaffected by cloud partition', /\d{1,2}:\d{2}|AM|PM/i.test(clockRes.say || ''));
const chatRes = await api(8097, '/api/utterance', { text: 'explain quantum entanglement in one sentence' });
ok('B1: unmatched chat during outage → calm fallback, not a crash',
  /hiccup|sorry|offline|trouble/i.test(chatRes.say || '') && !chatRes.error);
await killHub(hub);

// B2: malformed LLM responses (garbage, truncated, upstream 500) → calm fallback; recovery when it heals
hub = bootHub(8098, fs.mkdtempSync(path.join(os.tmpdir(), 'max-chaos-b2-')), { OPENROUTER_BASE: 'http://127.0.0.1:8131' });
await waitHealthy(8098);
orMode = 'garbage';
const gRes = await api(8098, '/api/utterance', { text: 'explain entropy to a five year old' });
orMode = 'truncated';
const tRes = await api(8098, '/api/utterance', { text: 'explain entropy to a five year old' });
orMode = 'dead500';
const fRes = await api(8098, '/api/utterance', { text: 'explain entropy to a five year old' });
ok('B2: garbage/truncated/500 LLM replies all degrade to calm fallback',
  [gRes, tRes, fRes].every((r) => /hiccup|sorry|offline|tangled/i.test(r.say || '') || r.brain === 'fallback'));
orMode = 'ok';
let healRes = null;
for (let i = 0; i < 3 && !(healRes && healRes.brain === 'cloud'); i++) { // key cooldown from the 500s may need one rotation cycle
  healRes = await api(8098, '/api/utterance', { text: 'explain entropy to a five year old' });
}
ok('B2: brain self-heals the moment the outage clears (no restart needed)', healRes.brain === 'cloud' && /Mock cloud is healthy/.test(healRes.say || ''));
const hl = await api(8098, '/api/health');
ok('B2: health exposes session/queue gauges for leak-watching', typeof hl.sessions === 'number' && typeof hl.pendingTasks === 'number');
await killHub(hub);

// B3: lockdown survives SIGKILL + restart (attacker cannot crash their way out of a freeze)
const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'max-chaos-lock-'));
hub = bootHub(8099, lockDir, { OPENROUTER_BASE: 'http://127.0.0.1:9' });
await waitHealthy(8099);
await api(8099, '/api/voiceprint/enroll', { user: 'owner', features: OWNER_F });
for (let i = 0; i < 5; i++) {
  const ch = await api(8099, '/api/voiceprint/challenge?user=owner');
  await api(8099, '/api/voiceprint/verify', { user: 'owner', features: [0.9, 0.9, 0.9, 0.9, 0.9], challengeId: ch.id, spoken: ch.phrase });
}
const lockNow = await api(8099, '/api/voiceprint/verify', { user: 'owner', features: OWNER_F, challengeId: 'x', spoken: 'x' });
await killHub(hub); // true power cut the instant the lockdown response landed — no graceful shutdown
hub = bootHub(8100, lockDir, { OPENROUTER_BASE: 'http://127.0.0.1:9' });
await waitHealthy(8100);
const lockAfter = await api(8100, '/api/voiceprint/verify', { user: 'owner', features: OWNER_F, challengeId: 'x', spoken: 'x' });
ok('B3: security lockdown survives a SIGKILL restart', lockNow.locked === true && lockAfter.locked === true && lockAfter.retryAfterSec > 0);

// B4: actuator ambiguity NEVER claims success (jammed lock: command ACKed, state unchanged)
await api(8100, '/api/settings', { homeAssistant: { url: 'http://127.0.0.1:8132', token: 'chaos-token' } });
// owner is locked down from B3 — enroll a second user for the actuator runs
await api(8100, '/api/voiceprint/enroll', { user: 'actu', features: OWNER_F });
const vt = await verifyOwner(8100, 'actu');
const unlockAmb = await api(8100, '/api/utterance', { text: 'unlock the front door', user: 'actu', verifyToken: vt.token });
ok('B4: jammed lock → "can\'t confirm", never "unlocked — confirmed"',
  vt.ok === true && /can.t confirm|cannot confirm|NOT unlocked/i.test(unlockAmb.say || '') && !/is now unlocked|Unlocked — confirmed/i.test(unlockAmb.say || ''));

// B5: HA fully down → clean hiccup, still no success claim
await api(8100, '/api/settings', { homeAssistant: { url: 'http://127.0.0.1:9', token: 'chaos-token' } });
const vt2 = await verifyOwner(8100, 'actu');
const unlockDown = await api(8100, '/api/utterance', { text: 'unlock the front door', user: 'actu', verifyToken: vt2.token });
ok('B5: HA unreachable → honest hiccup, fail-closed language',
  /hiccup|isn.t configured|reach/i.test(unlockDown.say || '') && !/now unlocked|Unlocked — confirmed/i.test(unlockDown.say || ''));
await killHub(hub);

// B6: supervisor restarts a crashing hub with capped backoff (self-healing service loop)
const fakeSrv = path.join(os.tmpdir(), 'max-fake-crash.js');
fs.writeFileSync(fakeSrv, 'console.log("[fake] boot"); setTimeout(() => process.exit(1), 150);');
const sup = spawn('bash', ['scripts/supervisor.sh'], {
  cwd: ROOT,
  env: { ...process.env, MAX_SERVER_CMD: 'node ' + fakeSrv },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let supLog = '';
sup.stdout.on('data', (d) => (supLog += d));
sup.stderr.on('data', (d) => (supLog += d));
await sleep(3500);
sup.kill('SIGTERM');
await sleep(200);
const starts = (supLog.match(/\[supervisor\] starting hub/g) || []).length;
const restartNoted = /restarting in \d+s/.test(supLog);
ok('B6: supervisor restarted a crashing hub (≥3 boots in 3.5s, backoff logged)', starts >= 3 && restartNoted);

// B7: event-loop WEDGE injected via SIGSTOP (no code changes, no HTTP trigger) —
//     the watchdog must SEE it, and must hand off to the supervisor only when opted in.
const wdEnv = { OPENROUTER_BASE: 'http://127.0.0.1:9', OPENROUTER_API_KEYS: '', OPENROUTER_KEY_1: '', OPENROUTER_KEY_2: '', OPENROUTER_KEY_3: '', JARVIS_ALLOW_KEYLESS: '1', MAX_WATCHDOG_BEAT_MS: '250', MAX_WATCHDOG_LAG_MS: '800', MAX_WATCHDOG_STALLS: '3' };
// part 1 — detect & log, but stay alive (no MAX_WATCHDOG_EXIT):
const wdDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'max-chaos-wd1-'));
hub = bootHub(8101, wdDir1, wdEnv);
await waitHealthy(8101);
let sawStall = false;
for (let attempt = 0; attempt < 2 && !sawStall; attempt++) { // freeze; retry once if the poll raced the resume
  process.kill(hub.pid, 'SIGSTOP'); // frozen loop, like a swap-storm/wedged addon
  await sleep(2600);
  process.kill(hub.pid, 'SIGCONT');
  for (let i = 0; i < 48 && !sawStall; i++) { // watchdog.stall lands in the event log
    await sleep(250);
    try { sawStall = fs.readFileSync(path.join(wdDir1, 'events.jsonl'), 'utf8').includes('watchdog.stall'); } catch {}
  }
}
await sleep(400);
const aliveAfter = hub.exitCode === null && hub.signalCode === null;
ok('B7: wedged loop is DETECTED and logged (watchdog.stall), hub stays up by default', sawStall && aliveAfter);
await killHub(hub);
// part 2 — with MAX_WATCHDOG_EXIT=1, a SUSTAINED wedged loop exits for supervisor restart.
// (A single big freeze recovers by itself and — correctly — never restarts; the
// streak only climbs when every beat arrives late, so the CONT windows below
// stay shorter than the 250ms beat interval to model continuous starvation.)
hub = bootHub(8102, fs.mkdtempSync(path.join(os.tmpdir(), 'max-chaos-wd2-')), { ...wdEnv, MAX_WATCHDOG_EXIT: '1' });
await waitHealthy(8102);
for (let i = 0; i < 8 && hub.exitCode === null; i++) {
  try { process.kill(hub.pid, 'SIGSTOP'); } catch { break; } // a fast watchdog exit can finish inside the first freeze window (ESRCH race)
  await sleep(1400);
  try { process.kill(hub.pid, 'SIGCONT'); } catch {}
  await sleep(120);
}
const exited = hub.exitCode !== null || hub.signalCode !== null;
ok('B7: persistent wedge exits for supervisor restart when MAX_WATCHDOG_EXIT=1',
  exited && /event loop stalled .+ exiting for supervisor restart/.test(hub.bootLog));

mockOR.close(); mockHA.close();
console.log(`\n${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
