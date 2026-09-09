'use strict';
/**
 * Jarvis hub server — zero-dependency Node service.
 *
 *   static PWA (web/)  +  JSON API (/api/*)  +  WebSocket (/ws/app, /ws/satellite)
 *
 * Everything the UI, satellites, and skills need flows through here:
 * utterances → orchestrator → skills → responses, reminders, notifications,
 * sensor data, and system health.
 */
const http = require('http');
require('./env')(); // load the project .env before anything reads environment configuration
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const { attach } = require('./ws');
const { SecureStore, DATA_DIR } = require('./secure-store');
const { EventLog } = require('./eventlog');
const { NetMonitor } = require('./net');
const { Scheduler } = require('./scheduler');
const { Memory } = require('./memory');
const { loadSettings } = require('./settings');
const { Registry } = require('./skills/registry');
const { Orchestrator } = require('./orchestrator');
const { Learner } = require('./learn');
const { AuditLog } = require('./audit');
const { Diagnostician } = require('./diagnose');
const { ModelRouter } = require('./models');
const { LocalProc } = require('./localproc');
const { Grounding } = require('./grounding');
const { Persona } = require('./persona');
const { Openers } = require('./openers');
const { Satellites } = require('./satellites');
const diag = require('./diagnostics');
diag.installDebugCrashHandlers();

const PORT = parseInt(process.env.PORT || '8080', 10);
const WEB_ROOT = path.join(__dirname, '..', 'web');
const VERSION = require('../package.json').version;

/* ---------- boot ---------- */
const log = new EventLog();
const settings = loadSettings();
diag.record('.env + settings store', true, `assistant=${settings.data.assistantName} · tz=${settings.data.timezone || 'system-default'}`);

/* v1.0.7: fold Settings-UI-entered and legacy-alias OpenRouter keys into .env
   (OPENROUTER_KEY_n) ONCE, then enforce .env as the only source of truth. */
const keyMig = require('./keymigrate').migrateEnvKeys({ settings, envFile: path.join(__dirname, '..', '.env'), log });
if (keyMig.fromSettings || keyMig.migrated) {
  console.log(`[config] OpenRouter keys consolidated into .env (appended ${keyMig.migrated || keyMig.fromSettings ? 'slots' : 'none'}; purged from settings: ${keyMig.purgedSettings}) — one source of truth from now on.`);
}
/* Boot preflight: all 3 rotation slots must be present — never silently start
   with fewer keys. The ONLY sanctioned bypass is the explicit test/CI var
   JARVIS_ALLOW_KEYLESS=1 (documented in .env.example; prints loudly too). */
{
  const { missingSlots } = require('./keyring');
  const missing = missingSlots();
  if (missing.length) {
    const msg = `[config] ✗ OpenRouter rotation incomplete — missing from .env: ${missing.join(', ')}. ` +
      'Add all three keys (https://openrouter.ai/keys) as OPENROUTER_KEY_1=, OPENROUTER_KEY_2=, OPENROUTER_KEY_3=. ' +
      'Jarvis refuses to start with a partial rotation. (CI/test boots may set JARVIS_ALLOW_KEYLESS=1 to override.)';
    if (process.env.JARVIS_ALLOW_KEYLESS === '1') {
      console.warn(msg.replace('✗', '⚠').replace('Jarvis refuses to start with a partial rotation.', 'Starting anyway because JARVIS_ALLOW_KEYLESS=1 is set explicitly.'));
      diag.record('cloud brain key rotation', true, `KEYLESS OVERRIDE · missing ${missing.join(', ')}`);
    } else {
      console.error(msg);
      diag.record('cloud brain key rotation', false, `missing ${missing.join(', ')} — refusing to start`);
      diag.printReport('[boot]');
      process.exit(1);
    }
    } else {
    diag.record('cloud brain key rotation', true, '3/3 slots present (OPENROUTER_KEY_1..3, .env-only)');
  }
}
if (settings.data.timezone) process.env.TZ = settings.data.timezone; // hub speaks local time (IST default)
const memory = new Memory(new SecureStore('memory'));
diag.record('memory store (AES-256-GCM)', true);
const scheduleStore = new SecureStore('schedule');
diag.record('schedule store (AES-256-GCM)', true);
const bus = new EventEmitter();
bus.setMaxListeners(50);
const net = new NetMonitor();
const satellites = new Satellites(log);
// Round 6: persisted satellite fingerprints (id → last IP) so a swapped/impersonated
// node is VISIBLE (alert + event) even though it isn't blocked (home DHCP churns).
{
  const fpStore = new SecureStore('sat-fingerprints');
  fpStore.data.map = fpStore.data.map || {};
  satellites.fingerprints = new Map(Object.entries(fpStore.data.map));
  satellites.onFingerprint = (id, ip) => { fpStore.data.map[id] = ip; fpStore.saveSoon(); };
  satellites.on('satellite.swap', (id, from, to) => {
    broadcast({ type: 'alert', kind: 'security', label: `Satellite "${id}" re-appeared from a new address (${from} → ${to}). If you didn't move it, check it.` });
    fireAlert('satellite.swap', { satellite: id, from, to });
  });
}
const registry = new Registry(settings, log);
registry.load();
{
  const expected = fs.readdirSync(path.join(__dirname, 'skills')).filter((f) => f.endsWith('.js') && f !== 'registry.js' && !f.startsWith('_')).length;
  diag.record('skills registry', registry.skills.size === expected, `${registry.skills.size}/${expected} skills loaded`);
}
// Adaptive Learning & Personalization layer (PERSONALIZATION.md): local-only,
// metadata-only signals → five inspectable models, versioned + rollbackable.
const learner = new Learner({
  store: new SecureStore('learning'),
  modelsStore: new SecureStore('learn-models'),
  settings, log, bus, registry,
});
diag.record('learning layer (metadata-only)', true);
{
  const { effectiveKeys } = require('./keyring');
  const nKeys = effectiveKeys(settings.data).length;
  diag.record('cloud brain (OpenRouter)', nKeys > 0 ? true : 'warn',
    nKeys > 0 ? `${nKeys} key(s) in rotation · model=${settings.data.openrouter.model || process.env.OPENROUTER_MODEL || '(provider default)'}`
              : 'no keys (settings/.env) — skill intents + optional Ollama fallback only');
  diag.record('github integration (optional)', (settings.data.integrations && settings.data.integrations.ghToken) ? true : 'warn',
    (settings.data.integrations && settings.data.integrations.ghToken) ? 'token configured (masked)' : 'token unset — skill runs disconnected; does not block startup');
}
const orchestrator = new Orchestrator({ registry, memory, settings, log, net, bus, learner });
orchestrator.isLockedDown = (user) => lockedDown(user); // sensitive-freeze introspection

/* ---------- brain layer (v-next): central diagnosis, tamper-evident audit, model router ---------- */
const audit = new AuditLog();
const diagnostician = new Diagnostician({ store: new SecureStore('diagnostics'), log, audit, bus });
const grounding = new Grounding({ memory, search: (q) => require('./skills/search').wikiSummary(q), net, log, audit });
const modelRouter = new ModelRouter({ env: process.env, settings, ollama: orchestrator.ollama, net, keyCount: () => orchestrator._ring().size, audit, log });
const localProc = new LocalProc({ ollama: orchestrator.ollama, audit, log });
orchestrator.attachBrain({ diagnostician, audit, modelRouter, localProc, grounding });
diag.record('audit log (tamper-evident)', true, 'HMAC-chained to data/.master.key — /api/audit/verify');

/* persistence failures (disk full, perms, corrupt FS) must be LOUD, not silent:
   surface them in the event log + dashboards whenever a debounced save dies. */
SecureStore.onError = (name, err) => {
  log.write('store.save.fail', { store: name, message: String(err && err.message || err).slice(0, 120) });
  broadcast({ type: 'alert', kind: 'system', label: `Storage problem — ${name} could not be saved (${String(err && err.code || 'error')}). Check disk space on the hub.` });
};

/* boot-time config validation — loud but non-fatal */
for (const w of require('./config-check').validateConfig(settings.data)) {
  console.warn('[config] ⚠ ' + w);
  log.write('config.warning', { message: w });
}

/* watchdog: detect event-loop stalls (a wedged hub is worse than a restarted one).
   Logs always; exits only when MAX_WATCHDOG_EXIT=1 (then the supervisor restarts us).
   Tunable for slow hardware and for chaos testing the stall path itself. */
const WD_BEAT_MS = Math.max(100, parseInt(process.env.MAX_WATCHDOG_BEAT_MS || '5000', 10));
const WD_LAG_MS = Math.max(200, parseInt(process.env.MAX_WATCHDOG_LAG_MS || '10000', 10));
const WD_MAX_STALLS = Math.max(1, parseInt(process.env.MAX_WATCHDOG_STALLS || '3', 10));
let lastBeat = Date.now();
let stalls = 0;
const beat = setInterval(() => {
  const lag = Date.now() - lastBeat - WD_BEAT_MS;
  lastBeat = Date.now();
  if (lag > WD_LAG_MS) {
    stalls++;
    log.write('watchdog.stall', { lagMs: lag, streak: stalls });
    if (stalls >= WD_MAX_STALLS && process.env.MAX_WATCHDOG_EXIT === '1') {
      console.error('[watchdog] event loop stalled ' + stalls + '× — exiting for supervisor restart');
      process.exit(1);
    }
  } else stalls = 0;
}, WD_BEAT_MS);
beat.unref?.();

const appClients = new Set();
function broadcast(msg) {
  for (const c of appClients) { try { c.sendJSON(msg); } catch {} }
}

const scheduler = new Scheduler(scheduleStore, (job) => {
  log.write('reminder.fired', { kind: job.kind });
  broadcast({ type: 'notify', kind: job.kind, label: job.label, id: job.id, at: job.at });
  satellites.speak(job.label);
});
orchestrator.attachScheduler(scheduler);
/* persona + proactive openers (v-next): delivery-shaping + grounded session-start
   suggestions. Pure additives — no gates touched; calendar/scheduler access is read-only. */
orchestrator.attachPersona({
  persona: new Persona(),
  openers: new Openers({ calendar: require('./skills/calendar'), scheduler, learner, settings }),
});

/* Rate limiting — per key (ip or ip:user) token buckets, pruned lazily. */
const { RateLimiter } = require('./ratelimit');
const limiter = new RateLimiter();
const RATE_RULES = [ // first match wins; voiceprint limits are per-user (brute force targets one voice)
  { re: /^\/api\/voiceprint\/verify$/, max: 20, windowMs: 60000, key: (req, body) => req.ip + '|' + (body.user || 'default') }, // lockdown (5 fails) is the real teeth
  { re: /^\/api\/voiceprint\/challenge$/, max: 20, windowMs: 60000, key: (req, body, query) => req.ip + '|' + ((query && query.get('user')) || 'default') },
  { re: /^\/api\/voiceprint\/(enroll|delete)$/, max: 5, windowMs: 3600e3, key: (req, body) => req.ip + '|' + (body.user || 'default') },
  { re: /^\/api\/sos$/, max: 6, windowMs: 60000, key: (req) => req.ip },
  { re: /^\/api\/remote\/unlock$/, max: 6, windowMs: 60000, key: (req) => req.ip },
  { re: /^\/api\/vision\/describe$/, max: 20, windowMs: 60000, key: (req) => req.ip },
  { re: /^\/api\/system\/update$/, max: 3, windowMs: 3600e3, key: (req) => req.ip },
  { re: /^\/api\/utterance$/, max: 45, windowMs: 60000, key: (req) => req.ip },
  { re: /^\/api\/(settings|keys)$/, max: 30, windowMs: 60000, key: (req) => req.ip },
  { re: /^\/api\//, max: 300, windowMs: 60000, key: (req) => req.ip },
];
function rateCheck(req, pathname, body, query) {
  body = body || {};
  for (const r of RATE_RULES) {
    if (!r.re.test(pathname)) continue;
    if (!limiter.take(r.re.source + '|' + r.key(req, body, query), r.max, r.windowMs)) return false;
    return true;
  }
  return true;
}

/** user ids are storage keys and log fields — sanitize + bound them centrally. */
function sanitizeUser(v) {
  const s = String(v || 'default').replace(/[^\w. ()-]/g, '').trim().slice(0, 40);
  return s || 'default';
}

/* verify tokens + liveness challenges live in hub/tokens.js — single-use,
   time-boxed, user-bound, bounded memory, and fail-closed under clock skew
   (an NTP rollback can never extend a token's life; chaos-tested). */
const { TokenBox } = require('./tokens');
const tbox = new TokenBox();
const issueVerify = (user) => tbox.issueVerify(user);
const checkVerify = (token, user) => tbox.checkVerify(token, user);
const issueChallenge = (user) => tbox.issueChallenge(user);
/** Owner gate: consume only when the token belongs to an enrolled non-guest non-kid profile. */
function checkOwnerVerify(token) {
  return tbox.checkOwnerVerify(token, (uid) => {
    const u = memory.store.data.users[uid];
    return !!(u && u.voiceprint && !u.guest && !u.kid);
  });
}

/* lockdown: repeated verify failures or privileged-action denials freeze verification 15 min */
const verifyFails = new Map(); // user -> { count, first, lockedUntil }
function recordVerifyFail(user) {
  const f = verifyFails.get(user) || { count: 0, first: Date.now(), lockedUntil: 0 };
  if (Date.now() - f.first > 10 * 60000) { f.count = 0; f.first = Date.now(); }
  f.count++;
  if (f.count >= 5 && !f.lockedUntil) {
    f.lockedUntil = Date.now() + 15 * 60000;
    lockdownUser(user, 'repeated voice verification failures');
  }
  verifyFails.set(user, f);
}
function recordVerifyOk(user) {
  verifyFails.set(user, { count: 0, first: Date.now(), lockedUntil: 0 });
  const u = memory.store.data.users[String(user)];
  if (u && u.lockdownUntil) { u.lockdownUntil = 0; memory.store.saveSoon(); }
}
function lockedDown(user) {
  const f = verifyFails.get(String(user));
  let until = f && f.lockedUntil ? f.lockedUntil : 0;
  // persistent stamp survives a hub restart — a crash (or a crash triggered BY
  // an attacker, e.g. via the watchdog) must never clear a security lockdown
  const u = memory.store.data.users[String(user)];
  if (u && u.lockdownUntil) until = Math.max(until, u.lockdownUntil);
  return until > Date.now() ? Math.ceil((until - Date.now()) / 1000) : 0;
}
const deniedStreak = new Map(); // user -> ts[]
function recordDenied(user) {
  const list = (deniedStreak.get(user) || []).filter((ts) => Date.now() - ts < 10 * 60000);
  list.push(Date.now());
  deniedStreak.set(user, list);
  if (list.length >= 8) lockdownUser(user, 'repeated privileged-action denials');
}
function lockdownUser(user, reason) {
  try { // persist the freeze IMMEDIATELY (sync): a power cut one ms later must not lift it
    const u = memory.ensureUser(String(user));
    u.lockdownUntil = Date.now() + 15 * 60000;
    memory.store.save();
  } catch {}
  log.write('security.lockdown', { user, reason });
  broadcast({ type: 'alert', kind: 'security', label: `Security lockdown for "${user}" — ${reason}. Sensitive actions frozen ~15 min.` });
  fireAlert('security.lockdown', { user, reason });
}
function fireAlert(event, detail) {
  const hook = process.env.MAX_ALERT_WEBHOOK;
  if (!hook) return;
  fetch(hook, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event, detail, at: Date.now() }),
  }).catch(() => {});
}
bus.on('security.denied', (d) => { if (d && d.user) { log.write('security.denied', d); recordDenied(d.user); } });
// learning layer: suggestions are *suggestions* (never automatic actions) and follow the
// proactive opt-in; anomaly flags are review-only and never block anything.
bus.on('learn.suggest', (s) => {
  if (!settings.data.proactive.enabled || !(settings.data.proactive.categories && settings.data.proactive.categories.routines)) return;
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][s.dow] || '';
  broadcast({ type: 'notify', kind: 'learn.suggest', label: `I've noticed you usually use ${s.skill} around ${day} ${String(s.hour).padStart(2, '0')}:00 — want me to make that a routine? Confirm, dismiss, or stop in Settings → What Jarvis has learned.` });
});
bus.on('security.anomaly', (f) => {
  broadcast({ type: 'alert', kind: 'security', label: `Unusual activity pattern for "${f.user}" (~${String(f.hour).padStart(2, '0')}:00, z=${f.z}). Nothing was blocked — review it in logs / Settings → What Jarvis has learned.` });
});

/* ---------- helpers ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
  '.wav': 'audio/wav', '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8',
};

function authed(req) {
  const expected = process.env.MAX_TOKEN;
  if (!expected) return true;
  const url = new URL(req.url, 'http://localhost');
  return url.searchParams.get('token') === expected ||
    (req.headers.authorization || '') === 'Bearer ' + expected;
}

function send(res, code, body, type = 'application/json') {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 9e6) req.destroy(); }); // room for JPEG frames
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
  });
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  if (rel === '/jarvis-ai.html') rel = '/index.html';
  const file = path.normalize(path.join(WEB_ROOT, rel));
  if (!file.startsWith(WEB_ROOT)) { send(res, 403, { error: 'forbidden' }); return; }
  fs.readFile(file, (err, data) => {
    if (err) { send(res, 404, { error: 'not found' }); return; }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': file.endsWith('.html') ? 'no-store' : 'public, max-age=300' });
    res.end(data);
  });
}


/* v0.9.0: generated static sites (create skill) — jailed, HTML only. */
const FILES_ROOT_SRV = path.resolve(process.env.MAX_FILES_ROOT || path.join(__dirname, '..', 'files'));
const SITES_ROOT = path.join(FILES_ROOT_SRV, 'sites');
function serveSites(req, res, pathname) {
  let rel = decodeURIComponent(pathname.slice('/sites'.length) || '/');
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(SITES_ROOT, rel));
  if (!file.startsWith(SITES_ROOT) || path.extname(file) !== '.html') { send(res, 404, { error: 'not found' }); return; }
  fs.readFile(file, (err, data) => {
    if (err) { send(res, 404, { error: 'not found' }); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(data);
  });
}

/* v0.9.0: drop-in brand assets. assets/logo.* and assets/background.* are
   picked up automatically by the web UI (falling back to defaults when absent). */
function serveBrandAsset(req, res, pathname) {
  const name = pathname.split('/').pop();
  if (!/^(logo|background)\.(png|jpg|jpeg|svg|webp)$/.test(name)) { send(res, 404, { error: 'not found' }); return; }
  const file = path.join(__dirname, '..', 'assets', name);
  fs.readFile(file, (err, data) => {
    if (err) { send(res, 404, { error: 'not found' }); return; }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=60' });
    res.end(data);
  });
}

/* latest sensor readings (satellites + hub-local posts) — bounded: oldest sources evicted */
const sensorCache = {}; // room/source -> { ...readings, at }
function cacheSensor(source, readings) {
  const clean = {};
  for (const [k, v] of Object.entries(readings || {})) {
    if (Object.keys(clean).length >= 50) break;
    if (typeof v === 'number' || typeof v === 'boolean') clean[k.slice(0, 40)] = v;
    else if (typeof v === 'string') clean[k.slice(0, 40)] = v.slice(0, 120);
  }
  clean.at = Date.now();
  sensorCache[source] = clean;
  const keys = Object.keys(sensorCache);
  if (keys.length > 100) {
    keys.sort((a, b) => (sensorCache[a].at || 0) - (sensorCache[b].at || 0));
    for (const k of keys.slice(0, keys.length - 100)) delete sensorCache[k];
  }
}
satellites.on('sensor', (id, sensors) => { cacheSensor(id, sensors); broadcast({ type: 'sensor', source: id, data: sensorCache[id] }); });

/* retention hygiene (Round 4): the hub forgets on a schedule, not just when asked.
   - event log: entries older than settings.privacy.logRetentionDays are pruned at boot + daily
   - sensor snapshot cache: readings older than privacy.sensorTtlHours are dropped hourly */
function runRetentionPass() {
  try {
    const days = Number(settings.data.privacy.logRetentionDays) || 30;
    const pruned = log.pruneOlderThan(days);
    if (pruned) console.log(`[retention] pruned ${pruned} event-log entries older than ${days}d`);
    const ttl = (Number(settings.data.privacy.sensorTtlHours) || 24) * 3600e3;
    for (const [k, v] of Object.entries(sensorCache)) if (Date.now() - (v.at || 0) > ttl) delete sensorCache[k];
    // slow-leak sweeps (Round 7): security-state maps are keyed by network-supplied
    // usernames — without these, months of random ids grow RAM unbounded.
    const now = Date.now();
    for (const [u, f] of verifyFails) {
      // dead entry = no active lockdown AND its fail-window expired (a new fail would
      // restart the window from zero anyway, so pruning loses nothing)
      if ((!f.lockedUntil || f.lockedUntil <= now) && now - (f.first || 0) > 10 * 60000) verifyFails.delete(u);
    }
    for (const [u, arr] of deniedStreak) {
      const live = arr.filter((ts) => now - ts < 10 * 60000);
      if (live.length) deniedStreak.set(u, live); else deniedStreak.delete(u);
    }
    // quarantined corrupt stores age out with the log window
    try {
      for (const f of fs.readdirSync(DATA_DIR)) {
        const m = /^(.*)\.corrupt-(\d+)$/.exec(f);
        if (m && now - Number(m[2]) > days * 86400000) fs.rmSync(path.join(DATA_DIR, f), { force: true });
      }
    } catch {}
  } catch (e) { console.error('[retention]', e.message); }
}
runRetentionPass();
const retentionTimer = setInterval(runRetentionPass, 3600e3); // hourly: sensors hourlyish, logs cheap
retentionTimer.unref?.();
satellites.on('satellite.offline', (id) => {
  broadcast({ type: 'notify', kind: 'system', label: `${id} went offline — commands to it will queue until it's back.` });
});
satellites.on('wake', (id) => broadcast({ type: 'satellite.wake', source: id }));
net.on('change', (online) => {
  log.write('net', { online });
  broadcast({ type: 'net', online });
});

/* ---------- API routes ---------- */
/** Each: { method, match: RegExp on pathname, handler(req,res,params,body,query) } */
const routes = [];
function route(method, pattern, handler) { routes.push({ method, pattern, handler }); }

route('GET', /^\/api\/health$/, async (req, res) => {
  // sessions + queue sizing are exposed so dashboards/tests can watch for leaks
  const pendingTasks = [...memory.sessions.values()].filter((s) => s.pendingTask).length;
  send(res, 200, {
    ok: true, version: VERSION, name: settings.data.assistantName,
    online: net.online, uptime: Math.round(process.uptime()),
    skills: registry.describe().length, satellites: satellites.list().filter((s) => s.online).length,
    sessions: memory.sessions.size, pendingTasks,
  });
});

route('GET', /^\/api\/settings$/, async (req, res) => send(res, 200, settings.public()));

/* Systems readout: one honest answer to "what's working, what's blocking what,
   and how to fix it" — consumed by web/systems.html and the Jarvis greeting. */
route('GET', /^\/api\/status$/, async (req, res) => {
  const { effectiveKeys } = require('./keyring');
  const keys = effectiveKeys(settings.data);
  const keyFails = log.tail(5000).filter((e) => e.type === 'llm.key.fail');
  const lastKeyFail = keyFails[keyFails.length - 1] || null;
  const recentKeyFail = lastKeyFail && Date.now() - lastKeyFail.ts < 3600e3 ? lastKeyFail : null;
  let backupAt = null;
  try {
    const bdir = path.join(__dirname, '..', 'backups');
    const names = fs.readdirSync(bdir).filter((n) => n.endsWith('.tar.gz')).sort();
    if (names.length) backupAt = Math.round(fs.statSync(path.join(bdir, names[names.length - 1])).mtimeMs);
  } catch {}
  const sats = satellites.list();
  const lockedUsers = [...verifyFails.entries()]
    .filter(([, f]) => f.lockedUntil > Date.now())
    .map(([u, f]) => ({ user: u, secondsLeft: Math.ceil((f.lockedUntil - Date.now()) / 1000) }));
  const anyVoice = Object.values((memory.store && memory.store.data.users) || {}).some((u) => u && u.voiceprint);

  const needs = [];
  const llmMode = (settings.data.privacy && settings.data.privacy.llm) || 'cloud';
  if (llmMode === 'cloud' && keys.length === 0)
    needs.push({ id: 'brain.nokeys', severity: 'blocked', what: 'Cloud brain has no OpenRouter keys — chats will fall back to intent skills only.', fix: 'Settings → OpenRouter Keys, or switch the brain to local.' });
  if (keys.length > 0 && recentKeyFail) {
    const why = recentKeyFail.status === 402 ? 'free-tier credit cap hit (prompt or max_tokens too large for the remaining balance)'
      : recentKeyFail.status === 401 ? 'unauthorized — the key looks invalid or revoked'
      : 'HTTP ' + (recentKeyFail.status || recentKeyFail.reason || 'error');
    needs.push({ id: 'brain.keyfail', severity: 'warn', what: `Cloud brain key rejected recently (${why}).`, fix: recentKeyFail.status === 402 ? 'Add credit at openrouter.ai/settings/credits, or set a smaller/free model in Settings → OpenRouter. (Chat auto-retries lean in the meantime.)' : 'Settings → OpenRouter Keys: top up credit or replace/re-rotate keys.' });
  }
  if (!process.env.MAX_TOKEN)
    needs.push({ id: 'sec.token', severity: 'warn', what: 'Hub is LAN-open (no MAX_TOKEN) — anyone on this network can talk to it.', fix: 'Set MAX_TOKEN in .env and restart.' });
  if (!process.env.MAX_ALERT_WEBHOOK)
    needs.push({ id: 'sec.webhook', severity: 'info', what: 'No alert webhook — lockdowns and satellite swaps won’t page you when away.', fix: 'Set MAX_ALERT_WEBHOOK in .env so alerts reach you.' });
  if (!backupAt)
    needs.push({ id: 'data.backup', severity: 'warn', what: 'No backup found — encrypted memories/keys have no restore point.', fix: 'Run scripts/backup.sh (and one manual copy of data/.master.key).' });
  else if (Date.now() - backupAt > 7 * 86400e3)
    needs.push({ id: 'data.backup.stale', severity: 'info', what: `Latest backup is ${Math.round((Date.now() - backupAt) / 86400e3)} days old.`, fix: 'Re-run scripts/backup.sh.' });
  if (lockedUsers.length)
    needs.push({ id: 'sec.lockdown', severity: 'blocked', what: `Sensitive actions frozen for ${lockedUsers.map((l) => l.user).join(', ')} (${lockedUsers[0].secondsLeft}s left) after repeated verify failures.`, fix: 'Wait out the lock, or check Logs → Security alerts for who probed you.' });
  const satOff = sats.filter((s) => !s.online).length;
  if (satOff)
    needs.push({ id: 'sat.offline', severity: 'info', what: `${satOff} satellite(s) offline — sensor/room audio from them is stale.`, fix: 'Check power/Wi-Fi on the unit; see Dashboard.' });

  // bounded probe of the local brain so "is it up?" is a fact, not a guess
  const ollamaUrl = (settings.data.security && settings.data.security.url) || process.env.OLLAMA_URL || '';
  let ollamaUp = null;
  if (ollamaUrl) {
    try {
      const r = await fetch(ollamaUrl.replace(/\/$/, '') + '/api/tags', { signal: AbortSignal.timeout(600) });
      ollamaUp = r.ok;
    } catch { ollamaUp = false; }
  }

  if (llmMode === 'local' && ollamaUp === false)
    needs.push({ id: 'brain.ollama', severity: 'blocked', what: 'Brain is set to local but Ollama is unreachable.', fix: 'Start Ollama (`ollama serve`) or switch the brain to cloud.' });

  const leanState = orchestrator.leanState();
  if (llmMode === 'cloud' && leanState.active)
    needs.push({ id: 'brain.lean', severity: 'warn', what: `Cloud brain is in lean mode (OpenRouter credit ceiling — ~${leanState.minutesLeft} min left): answers use a reduced prompt meanwhile, and deterministic skills still answer locally.`, fix: 'Add credit at openrouter.ai/settings/credits or set a smaller model in Settings → API keys — full mode resumes on the next successful full-size request.' });

  send(res, 200, {
    ok: true, version: VERSION, name: settings.data.assistantName,
    uptime: Math.round(process.uptime()), online: net.online, brain: llmMode, lean: leanState,
    openrouter: { keys: keys.length, model: settings.data.openrouter?.model || '', lastFail: recentKeyFail ? { status: recentKeyFail.status || null, reason: recentKeyFail.reason || null, at: recentKeyFail.ts } : null },
    ollama: { url: ollamaUrl.replace(/\/\/[^@/]+@/, '//…@'), reachable: ollamaUp, model: (settings.data.security && settings.data.security.model) || '' },
    security: { tokenRequired: !!process.env.MAX_TOKEN, satelliteToken: !!process.env.SATELLITE_TOKEN, alertWebhook: !!process.env.MAX_ALERT_WEBHOOK, lockedUsers, anyVoiceprint: anyVoice },
    satellites: { total: sats.length, online: sats.filter((s) => s.online).length },
    privacy: { transcriptLogging: !!settings.data.privacy?.logTranscripts },
    backup: { lastAt: backupAt },
    needs,
  });
});
route('POST', /^\/api\/settings$/, async (req, res, m, body) => {
  settings.patch(body);
  if (body.timezone) process.env.TZ = settings.data.timezone; // live-apply without restart
  log.write('settings.updated', {});
  send(res, 200, settings.public());
});

route('GET', /^\/api\/skills$/, async (req, res) => send(res, 200, registry.describe()));

/* OpenRouter keys (v1.0.7): .env-ONLY (OPENROUTER_KEY_1..3). Metadata endpoint
   only — no secret material (not even masked) and no write path of any kind:
   keys rotate from .env; edit the file, restart. */
route('GET', /^\/api\/keys$/, async (req, res) => {
  const { effectiveKeys } = require('./keyring');
  const count = effectiveKeys(settings.data).length;
  const ring = orchestrator.keyStatus();
  send(res, 200, {
    source: 'env',
    model: settings.data.openrouter?.model || '',
    count,
    slots: ring.map((r) => ({ index: r.index, cooldownSec: r.penalizedForSec })),
    note: 'Rotating OpenRouter keys live exclusively in .env as OPENROUTER_KEY_1/2/3. Edit the file and restart to change them.',
  });
});
const keysGone = (req, res) => send(res, 410, {
  error: 'OpenRouter keys are managed exclusively in .env (OPENROUTER_KEY_1/2/3) — there is no API path to add, edit, or remove them.',
});
route('POST', /^\/api\/keys$/, keysGone);
route('DELETE', /^\/api\/keys$/, keysGone);

/* Vision — privacy-gated. Frames arrive as a data URL, described in memory, dropped. */
route('GET', /^\/api\/vision\/config$/, async (req, res) => {
  const { effectiveKeys } = require('./keyring');
  send(res, 200, { mode: settings.data.privacy.vision, cloudReady: effectiveKeys(settings.data).length > 0 });
});
route('POST', /^\/api\/vision\/describe$/, async (req, res, m, body) => {
  const mode = settings.data.privacy.vision;
  if (mode === 'off') { send(res, 403, { error: 'Vision is off. Enable it in Settings → Privacy → Vision processing.' }); return; }
  if (mode === 'local') {
    send(res, 200, {
      say: "Local-only mode: I can feel motion and light changes, but scene descriptions need a local vision model (not installed) — or switch Vision processing to cloud in Settings.",
      local: true,
    });
    return;
  }
  const { effectiveKeys } = require('./keyring');
  if (!effectiveKeys(settings.data).length) { send(res, 503, { error: 'No OpenRouter keys configured for vision.' }); return; }
  const img = String(body.image || '');
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(img)) { send(res, 400, { error: 'image must be a jpeg/png/webp data URL' }); return; }
  if (img.length > 6e6) { send(res, 413, { error: 'frame too large' }); return; }
  try {
    const say = await orchestrator.describeImage(img, String(body.question || '').slice(0, 300), sanitizeUser(body.user));
    send(res, 200, { say });
  } catch (e) {
    log.write('interaction', { skill: 'vision', ok: false, message: e.message });
    send(res, 502, { error: 'vision failed: ' + e.message });
  }
});

/* graceful load shedding (Round 7): under a burst, excess utterances get a
   polite defer ("say it again in a second") instead of queueing into a stall */
let utterancesInFlight = 0;
const MAX_INFLIGHT = Math.max(2, parseInt(process.env.MAX_INFLIGHT || '8', 10));
route('POST', /^\/api\/utterance$/, async (req, res, m, body) => {
  const user = sanitizeUser(body.user);
  // verification requires a SERVER-ISSUED token (voiceprint flow); client flags are never trusted
  const verified = body.verifyToken ? checkVerify(body.verifyToken, user) : false;
  if (utterancesInFlight >= MAX_INFLIGHT) {
    log.write('load.shed', { user, inFlight: utterancesInFlight });
    return send(res, 200, { say: "I'm juggling several requests right now — give me a second and ask again.", deferred: true, retryAfterMs: 1200 });
  }
  utterancesInFlight++;
  try {
    const out = await orchestrator.handleUtterance({ text: body.text || '', user, verify: verified, source: 'http' });
    send(res, 200, out);
  } finally { utterancesInFlight--; }
});

/* Local brain (Ollama) status + one-tap model pull */
route('GET', /^\/api\/ollama\/status$/, async (req, res) => {
  try { send(res, 200, await orchestrator.ollama.statusLive({ kick: false })); }
  catch (e) { send(res, 200, { state: 'down', url: orchestrator.ollama.url(), model: orchestrator.ollama.model(), reachable: false, error: e.message }); }
});
route('POST', /^\/api\/ollama\/pull$/, async (req, res) => {
  try {
    const st = await orchestrator.ollama.statusLive({ kick: true });
    log.write('ollama.pull', { state: st.state, model: st.model });
    send(res, 200, st);
  } catch (e) { send(res, 200, { state: 'down', url: orchestrator.ollama.url(), model: orchestrator.ollama.model(), reachable: false, error: e.message }); }
});

route('GET', /^\/api\/schedule$/, async (req, res) => send(res, 200, scheduler.list()));
route('DELETE', /^\/api\/schedule$/, async (req, res, m, body, query) => send(res, 200, { ok: scheduler.remove(query.get('id')) }));
route('POST', /^\/api\/schedule\/snooze$/, async (req, res, m, body) => send(res, 200, { ok: !!scheduler.snooze(body.id, body.minutes || 10) }));

route('GET', /^\/api\/memory$/, async (req, res, m, b, query) => {
  const user = sanitizeUser(query.get('user'));
    send(res, 200, { facts: memory.facts(user), prefs: memory.ensureUser(user).prefs, topIntents: memory.topIntents(8) });
});
route('POST', /^\/api\/memory\/forget$/, async (req, res, m, body) => {
  send(res, 200, { removed: memory.forgetFact(sanitizeUser(body.user), body.needle ?? body.index) });
});

route('GET', /^\/api\/users$/, async (req, res) => send(res, 200, memory.listUsers()));

/* full personal-data wipe: memory, voiceprints, notes, ledger, jobs, sessions, tokens.
   Config (settings) and the owner event log survive — that's system state, not personal data. */
route('POST', /^\/api\/data\/wipe$/, async (req, res) => {
  memory.store.data.users = {};
  memory.store.data.stats = { counts: {} };
  memory.sessions = new Map();
  memory.store.save();
  tbox.clear(); // verify tokens + liveness challenges
  scheduleStore.data.jobs = [];
  scheduleStore.save();
  const { storeFor } = require('./skill-data'); // wipe cached instances, not just files
  for (const name of ['notes', 'finance', 'calendar', 'vehicle']) {
    try { const st = storeFor(name); st.data = {}; st.save(); } catch {}
  }
  log.write('data.wiped', {});
  broadcast({ type: 'alert', kind: 'privacy', label: 'All personal data was just erased.' });
  send(res, 200, { ok: true } );
});

/* ---- "My data" controls (Round 4): view by category, export, per-category delete.
   Categories map 1:1 onto DATA_MAP.md. Deletes are REAL store surgery + immediate save,
   and every mutation lands in the audit log (hash-chained since v0.10). ---- */
const MYDATA_CATEGORIES = ['profile', 'facts', 'preferences', 'voiceprint', 'sessions', 'notes', 'finance', 'calendar', 'vehicle', 'schedule', 'stats'];
function userStore(userId, name) { // scoped slice of an encrypted skill store
  const { storeFor } = require('./skill-data');
  const st = storeFor(name);
  const key = name === 'notes' ? 'notes' : name === 'finance' ? 'entries' : name === 'calendar' ? 'events' : null;
  return { st, all: st.data, key };
}
function myDataView(userId) {
  const u = memory.store.data.users[userId];
  const sess = memory.sessions.get(userId);
  const view = {
    user: userId,
    profile: u ? { exists: true, name: u.name, kid: !!u.kid, guest: !!u.guest, created: u.created, lastSeen: u.lastSeen } : { exists: false },
    facts: { count: u ? (u.facts || []).length : 0, items: u ? (u.facts || []).map((f) => f.fact) : [] },
    preferences: u ? { ...u.prefs } : {},
    voiceprint: { enrolled: !!(u && u.voiceprint) },
    sessions: { live: !!sess, turns: sess ? sess.turns.length : 0, pendingTask: !!(sess && sess.pendingTask) },
    stats: { counts: { ...(memory.store.data.stats.counts || {}) } },
    schedule: { count: (scheduleStore.data.jobs || []).length },
  };
  for (const name of ['notes', 'finance', 'calendar', 'vehicle']) {
    try {
      const { all } = userStore(userId, name);
      const k = name === 'notes' ? 'notes' : name === 'finance' ? 'entries' : 'events';
      const bucket = all[k];
      const items = name === 'vehicle' ? all.demo ? [all.demo] : [] : Array.isArray(bucket) ? bucket : (bucket && bucket[userId]) || [];
      view[name] = { count: items.length, items };
    } catch { view[name] = { count: 0, items: [], error: true }; }
  }
  return view;
}
route('GET', /^\/api\/mydata$/, async (req, res, m, body, query) => {
  send(res, 200, myDataView(sanitizeUser(query && query.get('user'))));
});
route('GET', /^\/api\/mydata\/export$/, async (req, res, m, body, query) => {
  const user = sanitizeUser(query && query.get('user'));
  log.write('privacy.export', { user });
  const payload = JSON.stringify({ exportedAt: new Date().toISOString(), ...myDataView(user) }, null, 2);
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-disposition': `attachment; filename="max-mydata-${user}.json"`,
  });
  res.end(payload);
});
route('POST', /^\/api\/mydata\/delete$/, async (req, res, m, body) => {
  const user = sanitizeUser(body.user);
  const cat = String(body.category || '');
  const u = memory.store.data.users[user];
  if (!MYDATA_CATEGORIES.includes(cat)) return send(res, 400, { error: 'unknown category — one of ' + MYDATA_CATEGORIES.join(', ') });
  let removed = 0;
  if (cat === 'sessions') { memory.sessions.delete(user); removed = 1; }
  else if (!u && ['profile', 'facts', 'preferences', 'voiceprint', 'stats'].includes(cat)) return send(res, 404, { error: 'no such profile' });
  else if (cat === 'profile') { delete memory.store.data.users[user]; removed = 1; memory.sessions.delete(user); }
  else if (cat === 'facts') { removed = (u.facts || []).length; u.facts = []; }
  else if (cat === 'preferences') { u.prefs = { tone: 0.5 }; removed = 1; }
  else if (cat === 'voiceprint') { removed = u.voiceprint ? 1 : 0; u.voiceprint = null; }
  else if (cat === 'stats') { memory.store.data.stats = { counts: {} }; removed = 1; }
  else if (cat === 'schedule') { removed = (scheduleStore.data.jobs || []).length; scheduleStore.data.jobs = []; scheduleStore.save(); }
  else { // notes | finance | calendar | vehicle — scoped store surgery
    try {
      const { st, all, key } = userStore(user, cat);
      if (cat === 'vehicle') { removed = all.demo ? 1 : 0; delete all.demo; }
      else if (key && all[key]) {
        if (Array.isArray(all[key])) { removed = all[key].length; all[key] = []; }
        else if (all[key][user]) { removed = (all[key][user] || []).length; delete all[key][user]; }
      }
      st.save();
    } catch (e) { return send(res, 500, { error: 'delete failed: ' + e.message }); }
  }
  memory.store.save();
  log.write('privacy.delete', { user, category: cat, removed });
  broadcast({ type: 'alert', kind: 'privacy', label: `Deleted "${cat}" data for ${user} (${removed} item${removed === 1 ? '' : 's'}).` });
  send(res, 200, { ok: true, removed, view: myDataView(user) }); // returns the post-delete state so callers can verify
});
route('POST', /^\/api\/users$/, async (req, res, m, body) => {
  // once any voiceprint exists, profile flags are owner-only: a guest must not un-guest itself
  const anyEnrolled = Object.values(memory.store.data.users || {}).some((u) => u.voiceprint);
  if (anyEnrolled && !checkOwnerVerify(body.ownerToken)) {
    send(res, 403, { error: 'Changing profiles needs the verified owner.' });
    return;
  }
  const flags = body.flags && typeof body.flags === 'object' ? { kid: !!body.flags.kid, guest: !!body.flags.guest } : {};
  const u = memory.setUserFlags(sanitizeUser(body.id), flags);
  log.write('users.flags', { user: u.id, kid: !!u.kid, guest: !!u.guest });
  send(res, 200, u);
});

route('GET', /^\/api\/satellites$/, async (req, res) => send(res, 200, satellites.list()));
route('GET', /^\/api\/sensors$/, async (req, res) => send(res, 200, sensorCache));
route('POST', /^\/api\/sensors$/, async (req, res, m, body) => {
  const source = sanitizeUser(body.source || 'hub');
  cacheSensor(source, body.data);
  broadcast({ type: 'sensor', source, data: sensorCache[source] });
  send(res, 200, { ok: true });
});

route('GET', /^\/api\/logs\/summary$/, async (req, res, m, b, query) => {
  const hours = Math.min(720, parseInt(query.get('hours') || '24', 10));
  const s = log.summary(hours * 3600e3);
  send(res, 200, {
    ...s,
    system: {
      uptime: Math.round(process.uptime()), memMB: Math.round(process.memoryUsage().rss / 1e6),
      node: process.version, online: net.online, version: VERSION,
      satellites: satellites.list(),
    },
  });
});

/* voiceprint — best-effort, clearly experimental, NOT a certified security system.
   Verification now requires a live phrase challenge (liveness): a fixed recording
   of your passphrase fails because the challenge words change every time. */
route('GET', /^\/api\/voiceprint\/challenge$/, async (req, res, m, b, query) => {
  const user = sanitizeUser(query.get('user'));
  const u = memory.store.data.users[user];
  if (!u || !u.voiceprint) { send(res, 404, { error: 'no voiceprint enrolled for this profile' }); return; }
  const lock = lockedDown(user);
  if (lock) { send(res, 423, { error: `Voice verification is locked for ~${Math.ceil(lock / 60)} min after repeated failures.`, locked: true, retryAfterSec: lock }); return; }
  send(res, 200, issueChallenge(user));
});
route('POST', /^\/api\/voiceprint\/enroll$/, async (req, res, m, body) => {
  const user = memory.ensureUser(sanitizeUser(body.user));
  const feats = body.features;
  if (!Array.isArray(feats) || feats.length < 5 || feats.length > 64 || !feats.every((x) => Number.isFinite(x) && Math.abs(x) < 1e6)) {
    send(res, 400, { error: 'features must be 5–64 finite numbers' }); return;
  }
  user.voiceprint = { features: feats, enrolled: Date.now(), experimental: true };
  memory.store.save();
  log.write('voiceprint.enrolled', { user: user.id });
  send(res, 200, { ok: true });
});
route('POST', /^\/api\/voiceprint\/verify$/, async (req, res, m, body) => {
  const user = memory.ensureUser(sanitizeUser(body.user));
  const lock = lockedDown(user.id);
  if (lock) { send(res, 200, { ok: false, locked: true, retryAfterSec: lock, score: 0 }); return; }
  if (!user.voiceprint) { send(res, 200, { ok: false, enrolled: false, score: 0 }); return; }

  // 1) liveness: consume the single-use challenge first — no valid challenge, no attempt
  const ch = tbox.takeChallenge(body.challengeId, user.id);
  if (!ch) { send(res, 400, { ok: false, error: 'challenge expired or missing — start verification again', score: 0 }); return; }
  const said = String(body.spoken || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ');
  const hits = ch.words.filter((w) => new RegExp('\\b' + w + '\\b').test(said)).length;
  if (hits < 2) {
    recordVerifyFail(user.id);
    log.write('voiceprint.verify', { user: user.id, ok: false, reason: 'phrase' });
    send(res, 200, { ok: false, enrolled: true, spoken: false, score: 0 });
    return;
  }

  // 2) voiceprint match
  const a = user.voiceprint.features, b = body.features;
  if (!Array.isArray(b) || b.length !== a.length || !b.every((x) => Number.isFinite(x))) { send(res, 400, { error: 'feature mismatch' }); return; }
  let d = 0;
  for (let i = 0; i < a.length; i++) d += (a[i] - b[i]) ** 2;
  const dist = Math.sqrt(d / a.length);
  const score = Math.max(0, 1 - dist * 2.2);
  const okPass = score > 0.55;
  log.write('voiceprint.verify', { user: user.id, ok: okPass, score: Math.round(score * 100) / 100 });
  if (!okPass) recordVerifyFail(user.id);
  else recordVerifyOk(user.id);
  send(res, 200, { ok: okPass, enrolled: true, spoken: true, score: Math.round(score * 100) / 100, token: okPass ? issueVerify(user.id) : null });
});
route('POST', /^\/api\/voiceprint\/delete$/, async (req, res, m, body) => {
  const user = memory.ensureUser(sanitizeUser(body.user));
  const had = !!user.voiceprint;
  user.voiceprint = null;
  memory.store.save();
  log.write('voiceprint.deleted', { user: user.id });
  send(res, 200, { ok: true, had });
});

route('POST', /^\/api\/sos$/, async (req, res, m, body) => {
  const contacts = settings.data.emergencyContacts || [];
  const sosUser = sanitizeUser(body.user);
  log.write('sos.triggered', { user: sosUser });
  const label = `Emergency SOS from ${sosUser === 'default' ? 'home' : sosUser}. ${contacts.length ? 'Notifying ' + contacts.map((c) => c.name).join(', ') + '.' : 'No emergency contacts configured.'}`;
  broadcast({ type: 'alert', kind: 'sos', label });
  satellites.speak(label);
  if (settings.data.emergencyWebhook) {
    try {
      await fetch(settings.data.emergencyWebhook, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event: 'sos', user: sosUser, at: Date.now(), contacts, location: body.location || null }),
      });
    } catch (e) { log.write('error', { message: 'sos webhook: ' + e.message }); }
  }
  send(res, 200, { ok: true, contacts, message: label });
});

/* security-relevant event digest for the logs dashboard + owner awareness */
route('GET', /^\/api\/alerts$/, async (req, res, m, b, query) => {
  const hours = Math.min(72, Math.max(1, parseInt(query.get('hours') || '24', 10)));
  const since = Date.now() - hours * 3600e3;
  const KINDS = new Set(['security.lockdown', 'security.denied', 'voiceprint.verify', 'rate.limited', 'satellite.rejected', 'satellite.offline', 'watchdog.stall', 'sos.triggered', 'config.warning', 'security.anomaly']);
  const evts = log.tail(5000).filter((e) => e.ts >= since && KINDS.has(e.type));
  const counts = {};
  for (const e of evts) {
    const k = e.type === 'voiceprint.verify' && e.ok !== false ? null : e.type; // successful verifies aren't alerts
    if (k) counts[k] = (counts[k] || 0) + 1;
  }
  send(res, 200, {
    since,
    firing: !!counts['security.lockdown'],
    counts,
    recent: evts.filter((e) => e.type !== 'voiceprint.verify' || e.ok === false).slice(-25).reverse(),
  });
});


/* ---- v0.9.0 feature routes ---- */

/* Jarvis Remote PIN unlock — household-grade gate; the PIN never leaves the server
   (masked in settings readbacks) and real API auth remains MAX_TOKEN. */
route('POST', /^\/api\/remote\/unlock$/, async (req, res, m, body) => {
  const want = String(settings.data.features?.remotePass || '');
  if (!want) { send(res, 200, { ok: true, gated: false }); return; }
  const got = String(body.pin || '');
  const okPin = got.length === want.length && require('crypto').timingSafeEqual(Buffer.from(got.padEnd(64)), Buffer.from(want.padEnd(64)));
  if (!okPin) log.write('security.denied', { user: 'remote', reason: 'remote pin mismatch' });
  send(res, okPin ? 200 : 403, { ok: okPin, gated: true });
});

/* Jarvis Remote activity feed — sanitized, transcript-free view of what Jarvis did lately. */
/* Boot readiness report captured at startup — masked (counts/names only).
   Exists so a configuration failure surfaces as a clear line instead of a
   silent "doesn't work"; each line also prints at listen time ([boot]). */
route('GET', /^\/api\/diagnostics$/, (req, res) => {
  send(res, 200, { ok: true, version: VERSION, port: PORT, uptimeSec: Math.round(process.uptime()), debug: diag.DEBUG, summary: diag.summary(), checks: diag.report() });
});

route('GET', /^\/api\/activity$/, async (req, res, m, b, query) => {
  const n = Math.min(50, Math.max(1, parseInt(query.get('n') || '20', 10)));
  const KINDS = new Set(['interaction', 'schedule.fired', 'notify', 'satellite.online', 'satellite.offline', 'satellite.swap',
    'satellite.rejected', 'security.lockdown', 'security.denied', 'voiceprint.enrolled', 'settings.updated', 'discord.error',
    'attention', 'sos.triggered', 'llm.key.fail', 'update', 'backup', 'injection.guard']);
  const items = log.tail(800).filter((e) => KINDS.has(e.type)).slice(-n).reverse()
    .map((e) => ({
      ts: e.ts, type: e.type,
      user: e.user ? String(e.user).slice(0, 40) : undefined,
      skill: e.skill, ok: e.ok,
      message: e.message ? String(e.message).replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-…').slice(0, 140) : undefined,
    })); // note: e.text (raw transcripts) is deliberately never shipped to the feed
  send(res, 200, { items });
});

/* Smart-home device inventory for the Home panel (reads HA; control stays on the
   voice path so voice-verify rules keep holding for locks/garage). */
route('GET', /^\/api\/home\/devices$/, async (req, res) => {
  const cfg = settings.data.homeAssistant || {};
  if (!cfg.url || !cfg.token) { send(res, 200, { configured: false, devices: [] }); return; }
  try {
    const r = await net.httpRetry(cfg.url.replace(/\/$/, '') + '/api/states', { headers: { authorization: 'Bearer ' + cfg.token } }, 8000);
    if (!r.ok) { send(res, 200, { configured: true, error: 'Home Assistant answered HTTP ' + r.status, devices: [] }); return; }
    const all = await r.json();
    const WANT = /^(light|fan|switch|media_player|climate|input_boolean)\./;
    const devices = (Array.isArray(all) ? all : []).filter((e) => WANT.test(e.entity_id || '')).slice(0, 200)
      .map((e) => ({ id: e.entity_id, name: (e.attributes && e.attributes.friendly_name) || e.entity_id, state: e.state, domain: e.entity_id.split('.')[0] }));
    send(res, 200, { configured: true, devices });
  } catch (e) { send(res, 200, { configured: true, error: e.message, devices: [] }); }
});

/* ---- attention monitor: ingest external signals (email/message bridges, webhooks),
   score importance, and surface only when proactive notifications are opted in. */
route('GET', /^\/api\/attn$/, async (req, res) => {
  const { storeFor } = require('./skill-data');
  const st = storeFor('attention');
  send(res, 200, { optedIn: !!settings.data.proactive.enabled, items: (st.data.items || []).slice(-30).reverse() });
});
/* shared attention ingest: external signals (webhooks, email bridges, GitHub
   notifications) score by hot keywords and surface only when proactive's opted in */
function ingestAttention({ source = 'webhook', from = '', title = '', text = '', boost = 0 }) {
  const src = String(source).replace(/[^\w .-]/g, '').slice(0, 30) || 'webhook';
  from = String(from).slice(0, 80);
  title = String(title).slice(0, 160);
  text = String(text).slice(0, 800);
  const hay = (title + ' ' + text + ' ' + from).toLowerCase();
  const HOT = ['urgent', 'asap', 'invoice', 'payment', 'overdue', 'deadline', 'meeting in', 'reminder:', 'sos', 'security', 'failed', 'alert', 'review requested', 'ci failed', 'failing'];
  const score = HOT.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0) + Math.min(2, Number(boost) || 0);
  const { storeFor } = require('./skill-data');
  const st = storeFor('attention');
  st.data.items = st.data.items || [];
  st.data.items.push({ ts: Date.now(), source: src, from, title, score });
  if (st.data.items.length > 50) st.data.items = st.data.items.slice(-50);
  st.saveSoon();
  log.write('attention', { source: src, score });
  const important = !!settings.data.proactive.enabled && score >= 2;
  if (important) broadcast({ type: 'notify', kind: 'attention', label: `${src}${from ? ' — ' + from : ''}: ${title || 'new item'}` });
  return { ok: true, score, surfaced: important, note: important || !settings.data.proactive.enabled ? undefined : 'stored quietly (proactive threshold not met)' };
}
route('POST', /^\/api\/attn$/, async (req, res, m, body) => {
  send(res, 200, ingestAttention({ source: body.source, from: body.from, title: body.title, text: body.body }));
});

/* ---- GitHub integration (skill does the work; these expose status + instant revocation) ---- */
route('GET', /^\/api\/github\/status$/, async (req, res) => {
  const skill = registry.get('github');
  try { send(res, 200, skill && skill.status ? await skill.status() : { connected: false, error: 'skill missing' }); }
  catch (e) { send(res, 200, { connected: false, error: String(e.message || e) }); }
});
route('POST', /^\/api\/github\/disconnect$/, async (req, res) => {
  // Revocation must be immediate and provable: token dropped from settings, all
  // cached GitHub data wiped, every capability inert on the very next call
  // (the skill reads the token per-request; the poller reads it per-tick).
  settings.patch({ integrations: { ghToken: '' } });
  const { storeFor } = require('./skill-data');
  const st = storeFor('github');
  st.data = { audit: (st.data.audit || []).slice(-20) }; // keep the audit trail, drop repo/notif caches
  st.save();
  log.write('gh.disconnected', {});
  broadcast({ type: 'notify', kind: 'github', label: 'GitHub disconnected — token removed, caches wiped, all GitHub capabilities are now off.' });
  send(res, 200, { ok: true, disconnected: true, connected: false });
});

/* ---- meeting assistant: transcripts in, notes + action items out (via the brain) ---- */
route('GET', /^\/api\/meetings$/, async (req, res, m, b, query) => {
  const { storeFor } = require('./skill-data');
  const st = storeFor('meetings'); st.data.meetings = st.data.meetings || [];
  const id = query.get('id');
  if (id) {
    const meet = st.data.meetings.find((x) => x.id === id);
    send(res, meet ? 200 : 404, meet || { error: 'not found' });
    return;
  }
  send(res, 200, st.data.meetings.map((x) => ({ id: x.id, title: x.title, at: x.at, turns: x.turns.length, hasSummary: !!x.summary })).slice(-20).reverse());
});
route('POST', /^\/api\/meetings$/, async (req, res, m, body) => {
  const { storeFor } = require('./skill-data');
  const st = storeFor('meetings'); st.data.meetings = st.data.meetings || [];
  const turns = (Array.isArray(body.turns) ? body.turns : []).slice(0, 300)
    .map((t) => ({ ts: Number(t.ts) || Date.now(), who: String(t.who || '').slice(0, 40), text: String(t.text || '').slice(0, 4000) }))
    .filter((t) => t.text);
  if (!turns.length) { send(res, 400, { error: 'no transcript lines' }); return; }
  const meet = { id: Date.now().toString(36), title: String(body.title || 'Meeting').slice(0, 120), at: Date.now(), turns, summary: '' };
  st.data.meetings.push(meet);
  if (st.data.meetings.length > 30) st.data.meetings = st.data.meetings.slice(-30);
  st.save();
  log.write('interaction', { skill: 'meetings', ok: true, message: 'saved ' + turns.length + ' lines' });
  send(res, 200, { ok: true, id: meet.id });
});
route('POST', /^\/api\/meetings\/summarize$/, async (req, res, m, body) => {
  const { storeFor } = require('./skill-data');
  const st = storeFor('meetings'); st.data.meetings = st.data.meetings || [];
  const meet = st.data.meetings.find((x) => x.id === String(body.id || ''));
  if (!meet) { send(res, 404, { error: 'meeting not found' }); return; }
  const transcript = meet.turns.map((t) => (t.who ? t.who + ': ' : '') + t.text).join('\n').slice(0, 12000);
  const prompt = 'Summarize this meeting transcript into (1) concise notes and (2) action items with owners if mentioned. Transcript:\n' + transcript;
  const user = sanitizeUser(body.user);
  const out = await orchestrator.handleUtterance({ text: prompt, user, verify: false, source: 'http' });
  meet.summary = String(out.say || '').slice(0, 8000);
  meet.summarizedAt = Date.now();
  st.save();
  send(res, 200, { ok: true, summary: meet.summary });
});

route('GET', /^\/api\/proactive$/, async (req, res) => {
  const out = [];
  const top = memory.topIntents(3);
  for (const [skill, n] of top) {
    if (n >= 3) out.push({ kind: 'routine', text: `You use ${skill} a lot — want me to suggest or automate it proactively?` });
  }
  const soon = scheduler.list().find((j) => j.kind === 'reminder' && j.at - Date.now() < 3600e3 && j.at > Date.now());
  if (soon) out.push({ kind: 'reminder', text: `Heads up: "${soon.label}" is coming up soon.` });
  send(res, 200, out);
});

/* ---- brain layer transparency: audit chain, model ladder, diagnosed-issue memory ---- */
route('GET', /^\/api\/audit\/tail$/, (req, res, m, b, query) => {
  send(res, 200, { entries: audit.tail(Math.min(200, parseInt((query && query.get('n')) || '50', 10) || 50)) });
});
route('GET', /^\/api\/audit\/verify$/, (req, res) => send(res, 200, audit.verify()));
route('GET', /^\/api\/models$/, (req, res) => send(res, 200, modelRouter.status()));
route('GET', /^\/api\/diagnostics\/issues$/, (req, res) => send(res, 200, { issues: diagnostician.knownIssues() }));

/* ---- adaptive learning layer: inspect, edit, reset — one-tap control (PERSONALIZATION.md) ---- */
route('GET', /^\/api\/learn$/, (req, res, m, b, query) => {
  send(res, 200, learner.state(sanitizeUser(query && query.get('user'))));
});
route('POST', /^\/api\/learn\/feedback$/, (req, res, m, body) => {
  send(res, 200, learner.feedback({ id: String(body.id || ''), action: String(body.action || '') }));
});
route('POST', /^\/api\/learn\/forget$/, (req, res, m, body) => {
  send(res, 200, learner.forget({ kind: String(body.kind || ''), key: String(body.key || ''), user: sanitizeUser(body.user) }));
});
route('POST', /^\/api\/learn\/rollback$/, (req, res, m, body) => {
  send(res, 200, learner.rollback(String(body.model || '')));
});
route('POST', /^\/api\/learn\/reset$/, (req, res) => {
  // learning-layer-only wipe: signals + all five models + version history.
  // Facts, prefs, settings, events and everything else stay untouched (and vice versa: /api/data/wipe covers that).
  send(res, 200, learner.reset());
});

route('POST', /^\/api\/system\/update$/, async (req, res) => {
  if (!settings.data.update.allow) { send(res, 403, { error: 'updates disabled (set ALLOW_SELF_UPDATE=1)' }); return; }
  const { spawn } = require('child_process');
  const child = spawn('bash', [path.join(__dirname, '..', 'scripts', 'update.sh')], { cwd: path.join(__dirname, '..') });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  child.on('close', (code) => send(res, code === 0 ? 200 : 500, { ok: code === 0, output: out.slice(-4000) }));
});

/* skill-owned data stores get generic read endpoints where useful */
route('GET', /^\/api\/notes$/, async (req, res, m, b, q) => {
  const { storeFor } = require('./skill-data');
  const notes = storeFor('notes').data.notes || {};
  send(res, 200, notes[q.get('user') || 'default'] || []);
});
route('GET', /^\/api\/calendar$/, async (req, res) => {
  const { storeFor } = require('./skill-data');
  send(res, 200, (storeFor('calendar').data.events || []).sort((a, b) => a.start - b.start));
});
route('GET', /^\/api\/weather$/, async (req, res, m, b, q) => {
  const wx = registry.get('weather');
  if (!wx) { send(res, 503, { error: 'weather skill unavailable' }); return; }
  try {
    const city = q.get('city') || settings.data.homeCity || '';
    const out = await wx.current(city);
    send(res, 200, out);
  } catch (e) { send(res, 502, { error: e.message }); }
});

/* ---------- HTTP server ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  req.ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');

  if (pathname.startsWith('/api/')) {
    if (!authed(req)) { send(res, 401, { error: 'unauthorized' }); return; }
    const body = req.method === 'POST' || req.method === 'DELETE' ? await readBody(req) : {};
    if (!rateCheck(req, pathname, body, url.searchParams)) {
      log.write('rate.limited', { ip: req.ip, path: pathname });
      send(res, 429, { error: 'Easy there — slow down a touch and try again in a moment.' });
      return;
    }
    for (const r of routes) {
      const m = pathname.match(r.pattern);
      if (m && r.method === req.method) {
        try { await r.handler(req, res, m, body, url.searchParams); }
        catch (e) {
          // internal detail stays in the private log; clients get a calm, safe message
          log.write('error', { message: `api ${pathname}: ${e.message}` });
          send(res, 500, { error: 'Something went sideways on my end — please try again.' });
        }
        return;
      }
    }
    send(res, 404, { error: 'unknown endpoint' });
    return;
  }
  if (pathname.startsWith('/sites/')) { serveSites(req, res, pathname); return; }
  if (pathname.startsWith('/assets/')) { serveBrandAsset(req, res, pathname); return; }
  serveStatic(req, res, pathname);
});

/* ---------- WebSocket: app clients ---------- */
attach(server, {
  '/ws/app': (client, req) => {
    if (!authed(req)) { client.close(); return; }
    appClients.add(client);
    const url = new URL(req.url, 'http://localhost');
    const user = sanitizeUser(url.searchParams.get('user'));
    client.sendJSON({ type: 'hello', name: settings.data.assistantName, version: VERSION, online: net.online });
    client.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === 'utterance') {
        client.sendJSON({ type: 'state', state: 'thinking' });
        const verified = msg.verifyToken ? checkVerify(msg.verifyToken, user) : false; // tokens only, never client flags
        if (utterancesInFlight >= MAX_INFLIGHT) {
          log.write('load.shed', { user, inFlight: utterancesInFlight, via: 'ws' });
          client.sendJSON({ type: 'response', say: "I'm juggling several requests right now — give me a second and ask again.", deferred: true });
          return;
        }
        utterancesInFlight++;
        try {
          const out = await orchestrator.handleUtterance({ text: msg.text || '', user, verify: verified, source: 'ws' });
          client.sendJSON({ type: 'response', ...out });
        } catch (e) {
          client.sendJSON({ type: 'response', say: 'Something went sideways — sorry about that.', error: true });
          log.write('error', { message: 'ws utterance: ' + e.message });
        } finally { utterancesInFlight--; }
      } else if (msg.type === 'ping') {
        client.sendJSON({ type: 'pong', ts: Date.now() });
      }
    });
    client.on('close', () => appClients.delete(client));
  },
  '/ws/satellite': (client, req) => {
    if (!authed(req)) { client.close(); return; }
    satellites.handle(client);
  },
});

/* Discord bridge (optional; token+channel in Settings → Integrations — a service
   credential, NOT an LLM key). Polls every 60 s and surfaces new channel messages. */
/* GitHub skill register: notification poller + write-audit + attention feed.
   Writes emit 'gh.write' → the tamper-evident event log (token never logged). */
try {
  const ghSkill = registry.get('github');
  const { storeFor: storeForGh } = require('./skill-data');
  if (ghSkill && ghSkill.register) {
    ghSkill.register({ bus, skillStore: storeForGh('github'), settings: settings.data, net });
    bus.on('gh.write', (e) => log.write('gh.write', { user: e.user, action: e.action, repo: e.repo, target: e.target, ok: e.ok, status: e.status }));
    // notifications → the attention monitor; clearly-hot reasons get a +1 boost
    // so they clear the {score>=2} proactive bar on their own.
    bus.on('gh.notif', (n) => {
      ingestAttention({ source: 'github', from: n.repo, title: n.title, text: n.reason.replace(/_/g, ' ') + ' · ' + n.type + (n.hot ? ' · alert' : ''), boost: n.hot ? 1 : 0 });
    });
    bus.on('gh.error', (d) => log.write('gh.error', { status: d.status }));
  }
} catch (e) { log.write('error', { message: 'github bridge boot: ' + e.message }); }

try {
  const discordSkill = registry.get('discord');
  const { storeFor } = require('./skill-data');
  if (discordSkill && discordSkill.register) {
    discordSkill.register({ bus, skillStore: storeFor('discord'), settings: settings.data, net });
    bus.on('discord.message', (m) => broadcast({ type: 'notify', kind: 'discord', label: `Discord — ${m.from}: ${m.text}` }));
    bus.on('discord.error', (d) => log.write('discord.error', { status: d.status }));
    if (settings.data.integrations.discordToken && settings.data.integrations.discordChannel) console.log('[discord] bridge polling every 60s');
  }
} catch (e) { log.write('error', { message: 'discord bridge boot: ' + e.message }); }

server.listen(PORT, '0.0.0.0', () => {
  diag.printReport('[boot]');
  console.log(`[jarvis-ai] ${settings.data.assistantName} hub v${VERSION} on http://0.0.0.0:${PORT}`);
  console.log(`[jarvis-ai] web app: http://localhost:${PORT}/   dashboard: /dashboard.html   settings: /settings.html   logs: /logs.html`);
  const { effectiveKeys } = require('./keyring');
  const nKeys = effectiveKeys(settings.data).length;
  if (!nKeys) console.log('[jarvis-ai] no OpenRouter keys (settings/.env) — running on skill intents + optional Ollama fallback');
  else console.log(`[jarvis-ai] cloud brain: OpenRouter with ${nKeys} key${nKeys > 1 ? 's' : ''} (rotating failover)`);
});
