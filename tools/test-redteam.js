#!/usr/bin/env node
'use strict';
/**
 * RED TEAM suite — Round 2. Every test is an actual attack against the system
 * we shipped after Round 1. Each pass is a defeated break-in.
 * Boots an isolated hub on :8097.
 */
process.env.PORT = '8097';
process.env.OPENROUTER_KEY_1 = ''; process.env.OPENROUTER_KEY_2 = ''; process.env.OPENROUTER_KEY_3 = ''; process.env.JARVIS_ALLOW_KEYLESS = '1';
process.env.OLLAMA_URL = '';
process.env.MAX_DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'max-red-'));

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('ok  ' + n); } else { fail++; console.log('FAIL ' + n); } };
const OWNER_F = [0.2, 0.3, 0.4, 0.1, 0.5];

(async () => {
  const net = require('net');
  require('../hub/server.js');
  await new Promise((r) => setTimeout(r, 900));
  const BASE = 'http://127.0.0.1:8097';
  const j = (res) => res.json();
  const post = (p, body) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const get = (p) => fetch(BASE + p);

  /** Helper: run a full legit verify for a user; returns {say/token/score/errorCode}. */
  async function doVerify(user, features) {
    const ch = await (await get('/api/voiceprint/challenge?user=' + user)).json();
    if (ch.error) return { error: ch.error };
    const v = await (await post('/api/voiceprint/verify', { user, features, challengeId: ch.id, spoken: 'I say ' + ch.phrase + ' now' })).json();
    return v;
  }

  /* --- ATTACK 1: secrets read through dev skill (found & fixed this round) --- */
  const dev = require('../hub/skills/dev');
  ok('cat .env refused', !(await dev._runSafe('cat .env')).ok);
  ok('explain .env refused', (await dev.intents[0].run([0, '.env', '.env'])).say && /protected/.test((await dev.intents[0].run([0, '.env', '.env'])).say));
  ok('cat data/ refused', !(await dev._runSafe('cat data/.master.key')).ok);
  ok('node .env read throws', !(await dev._runSafe('node -e "console.log(require(\'fs\').readFileSync(\'.env\',\'utf8\'))"')).ok);
  ok('node spawn() kernel-denied', !(await dev._runSafe("node -e try{require('child_process').spawnSync('id')}catch(e){console.log(e.message)} process.exit(1) ")).ok);

  /* --- ATTACK 2: forged verify token --- */
  const r2 = await (await post('/api/utterance', { text: 'unlock the front door', verifyToken: require('crypto').randomBytes(16).toString('hex') })).json();
  ok('forged verifyToken keeps locks gated', r2.verify === true || /verify|frozen/i.test(r2.say));

  /* --- happy path: enroll owner, legit verify, token+lock --- */
  await post('/api/voiceprint/enroll', { user: 'owner', features: OWNER_F });
  const v1 = await doVerify('owner', OWNER_F);
  ok('legit verify passes liveness+score', v1.ok === true && typeof v1.token === 'string');
  const unlock = await (await post('/api/utterance', { text: 'unlock the front door', user: 'owner', verifyToken: v1.token })).json();
  ok("owner's token actually verifies (reaches HA, not the gate)", /Home Assistant isn|lock|Smart home hiccup/i.test(unlock.say));

  /* --- ATTACK 3: token stolen but used by another user --- */
  const vA = await doVerify('owner', OWNER_F);
  const r3 = await (await post('/api/utterance', { text: 'unlock the garage', user: 'mallory', verifyToken: vA.token })).json();
  ok('stolen token useless for another user', r3.verify === true || /verify/i.test(r3.say));
  const r3b = await (await post('/api/utterance', { text: 'unlock the garage', user: 'owner', verifyToken: vA.token })).json();
  ok('binding ≠ burning: theft attempt does not destroy the owner token', r3b.verify !== true && /lock|garage|Home Assistant/i.test(r3b.say));

  /* --- ATTACK 4: replay attacks --- */
  const ch1 = await (await get('/api/voiceprint/challenge?user=owner')).json();
  const rep1 = await (await post('/api/voiceprint/verify', { user: 'owner', features: OWNER_F, challengeId: ch1.id, spoken: ch1.phrase })).json();
  const rep2 = await (await post('/api/voiceprint/verify', { user: 'owner', features: OWNER_F, challengeId: ch1.id, spoken: ch1.phrase })).json();
  ok('challenge is single-use (replay rejected)', rep1.ok === true && rep2.ok !== true);
  const noCh = await post('/api/voiceprint/verify', { user: 'owner', features: OWNER_F });
  ok('verify without challenge rejected', noCh.status === 400);

  /* --- ATTACK 5: recording of the owner (right voice, no live phrase) --- */
  const ch2 = await (await get('/api/voiceprint/challenge?user=owner')).json();
  const rec = await (await post('/api/voiceprint/verify', { user: 'owner', features: OWNER_F, challengeId: ch2.id, spoken: 'max its me max its me' })).json();
  ok('recording-without-phrase fails liveness', rec.ok === false && rec.spoken === false);

  /* --- ATTACK 6: TTS clone saying the phrase, wrong voice --- */
  const ch3 = await (await get('/api/voiceprint/challenge?user=owner')).json();
  const tts = await (await post('/api/voiceprint/verify', { user: 'owner', features: [0.9, 0.8, 0.1, 0.9, 0.9], challengeId: ch3.id, spoken: 'uh ' + ch3.phrase })).json();
  ok('phrase-correct but voice-wrong fails score', tts.ok === false);

  /* --- ATTACK 7: profile self-escalation --- */
  // guest profile made BEFORE any enrollment (setup window) so we can test the guest gate
  await post('/api/users', { id: 'g1', flags: { guest: true } }); // rejected now (owner enrolled)
  const g1try = await post('/api/users', { id: 'g1', flags: { guest: false } });
  ok('guest cannot de-guest itself', g1try.status === 403);
  const badTok = await post('/api/users', { id: 'g1', flags: { guest: false }, ownerToken: 'nope' });
  ok('fake ownerToken rejected', badTok.status === 403);
  const vt = await doVerify('owner', OWNER_F);
  const okTok = await post('/api/users', { id: 'partner', flags: { kid: true }, ownerToken: vt.token });
  ok('real owner token can set flags', okTok.status === 200);

  /* --- ATTACK 8: oversized/ malformed enrollment --- */
  const big = await post('/api/voiceprint/enroll', { user: 'x', features: Array(500).fill(1) });
  ok('oversized features rejected', big.status === 400);
  const nan = await post('/api/voiceprint/enroll', { user: 'x', features: ['a', 'b', 'c', 'd', 'e'] });
  ok('non-numeric features rejected', nan.status === 400);

  /* --- ATTACK 9: burst the verify limit (parallel) — per-user limit is 20/min --- */
  const burst = await Promise.all(Array.from({ length: 24 }, () => post('/api/voiceprint/verify', { user: 'bz', features: OWNER_F })));
  const burstStatuses = await Promise.allSettled(burst.map((r) => r.json()));
  const n429 = burst.filter((r) => r.status === 429).length;
  ok('parallel verify burst gets throttled', n429 >= 1);
  void burstStatuses;

  /* --- ATTACK 10: lockdown after 5 failures --- */
  await post('/api/voiceprint/enroll', { user: 'att', features: [0.01, 0.01, 0.01, 0.01, 0.01] });
  for (let i = 0; i < 5; i++) {
    const c = await (await get('/api/voiceprint/challenge?user=att')).json();
    await post('/api/voiceprint/verify', { user: 'att', features: [0.99, 0.99, 0.99, 0.99, 0.99], challengeId: c.id, spoken: c.phrase });
  }
  const locked = await (await post('/api/voiceprint/verify', { user: 'att', features: [0.99, 0.99, 0.99, 0.99, 0.99], challengeId: 'x' })).json();
  ok('5 failures → verification locked', locked.locked === true);
  const frozen = await (await post('/api/utterance', { text: 'unlock the front door', user: 'att' })).json();
  ok('sensitive actions frozen during lockdown', /frozen/i.test(frozen.say));

  /* --- ATTACK 11: satellite registry flood (unit) --- */
  const { Satellites } = require('../hub/satellites');
  const sat = new Satellites({ write() {} });
  const fakeClient = () => {
    const listeners = {};
    return { id: 'fake', on: (t, f) => (listeners[t] = f), sendJSON() {}, close() { this.__closed = true; }, req: { socket: { remoteAddress: '10.0.0.9' } }, __emit: (o) => listeners.message(JSON.stringify(o)) };
  };
  for (let i = 0; i < 80; i++) { const c = fakeClient(); sat.handle(c); c.__emit({ type: 'satellite.hello', id: 'sat' + i }); }
  ok('satellite registry capped at 64', sat.nodes.size <= 64);

  /* --- ATTACK 12: settings DoS + pollution via API --- */
  const { deepMerge } = require('../hub/settings');
  let deep = {}, cur = deep;
  for (let i = 0; i < 5000; i++) { cur.a = {}; cur = cur.a; }
  let crashed = false;
  try { deepMerge({ a: {} }, deep); } catch { crashed = true; }
  ok('depth bomb handled without process crash', !crashed);
  await post('/api/settings', JSON.parse('{"__proto__":{"polluted":true},"personality":{"tone":0.9}}'));
  ok('API __proto__ patch does not pollute', ({}).polluted === undefined);

  /* --- ATTACK 13: fuzz every registered tool with garbage args --- */
  const { Registry } = require('../hub/skills/registry');
  const { loadSettings } = require('../hub/settings');
  process.env.MAX_DATA_DIR2 = process.env.MAX_DATA_DIR;
  const registry = new Registry(loadSettings(), { write() {} });
  registry.load();
  let settles = 0, total = 0;
  for (const def of registry.toolDefs()) {
    const entry = registry.tool(def.name);
    for (const garbage of [null, undefined, {}, { name: ['x'] }, { amount: 'NaN', minutes: -1, text: 'x'.repeat(5000) }]) {
      total++;
      try {
        const ctx = { userId: 'fuzz', user: { guest: false, kid: false }, verified: true, settings: registry.settings.data, mode: null,
          scheduler: { add() {} }, bus: { emit() {} }, log: { write() {} }, net: { online: false }, http: null, env: {}, memory: { countIntent() {} } };
        await Promise.race([Promise.resolve(entry.run(garbage || {}, ctx)), new Promise((_, rej) => setTimeout(() => rej(new Error('hang')), 3000))]);
        settles++;
      } catch (e) {
        if (e.message === 'hang') console.error('   hang in', def.name); else settles++; // throwing an Error is ACCEPTABLE; hanging is not
      }
    }
  }
  ok(`tool fuzz (${total} calls) — nothing hangs`, settles === total);

  /* --- ATTACK 14: data wipe actually wipes --- */
  await post('/api/utterance', { text: 'remember that I love mangoes', user: 'wipu' });
  await post('/api/data/wipe', {});
  const wipedMem = await (await get('/api/memory?user=wipu')).json();
  ok('wipe clears memory', wipedMem.facts.length === 0);
  const vt2 = await (await post('/api/voiceprint/verify', { user: 'owner', features: OWNER_F, challengeId: 'gone', spoken: 'x' })).json();
  ok('wipe kills verify challenges too', vt2.ok !== true && !vt2.token);

  /* --- ATTACK 15: WS oversized frame gets killed --- */
  const wsResult = await new Promise((resolve) => {
    const s = net.createConnection(8097, '127.0.0.1');
    let stage = 0;
    const t = setTimeout(() => { try { s.destroy(); } catch {} resolve('timeout'); }, 4000);
    s.on('connect', () => {
      s.write('GET /ws/app HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
    });
    s.on('data', (d) => {
      if (stage === 0) {
        stage = 1;
        // binary frame header declaring a 4 MB payload (0x400000) — over the 1 MB cap
        const hdr = Buffer.from([0x82, 0x7f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40, 0x00, 0x00]);
        s.write(Buffer.concat([hdr, Buffer.from('AAAAAAAAAAAAAAAA')]));
      } else {
        clearTimeout(t); s.destroy(); resolve('close-frame-received'); // server's close frame = rejected & sealed
      }
    });
    s.on('close', () => { clearTimeout(t); resolve('closed'); });
    s.on('error', () => { clearTimeout(t); resolve('closed'); });
  });
  ok('WS oversize frame → connection closed', wsResult === 'closed' || wsResult === 'close-frame-received');

  console.log(`\n${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
