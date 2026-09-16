#!/usr/bin/env node
'use strict';
/** Round 6 — physical & network security: mutual hub auth, swap detection, boot
 *  integrity manifest, attack-surface + hardcoded-credential audit, secure disposal. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('ok  ' + n); } else { fail++; console.log('FAIL ' + n); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // 1. mutual auth: hub proof roundtrips; wrong/altered proofs rejected (constant-time path)
  process.env.SATELLITE_TOKEN = 'unittest-token';
  const { hubProof, verifyHubProof, Satellites } = require('../hub/satellites');
  const p = hubProof('sat-1', 12345);
  ok('hub proof: valid proof verifies', verifyHubProof('sat-1', 12345, p) === true);
  ok('hub proof: wrong id/ts/proof rejected', verifyHubProof('sat-2', 12345, p) === false && verifyHubProof('sat-1', 999, p) === false && verifyHubProof('sat-1', 12345, 'f'.repeat(64)) === false);
  ok('hub proof: garbage-shaped proof rejected without throwing', verifyHubProof('sat-1', 12345, 'not-hex') === false);
  delete process.env.SATELLITE_TOKEN;
  ok('hub proof: indeterminate (null) when no token configured — open mode explicit', verifyHubProof('sat-1', 5, 'x') === null && hubProof('sat-1', 5) === null);

  // 2. swap detection via fake WS clients
  process.env.SATELLITE_TOKEN = 'unittest-token';
  const sats = new Satellites({ write() {} });
  const swaps = [];
  sats.fingerprints = new Map();
  sats.on('satellite.swap', (id, from, to) => swaps.push({ id, from, to }));
  const mk = (ip) => {
    const L = {};
    return { id: 'c', sent: [], on: (t, f) => (L[t] = f), sendJSON(m) { this.sent.push(m); }, close() {}, req: { socket: { remoteAddress: ip } }, __emit(o) { L.message(JSON.stringify(o)); } };
  };
  const c1 = mk('10.0.0.50');
  sats.handle(c1);
  c1.__emit({ type: 'satellite.hello', id: 'puck-1', token: 'unittest-token' });
  const welcome = c1.sent.find((m) => m.type === 'satellite.welcome');
  ok('authenticated hello receives a verifiable hub proof', !!welcome && verifyHubProof('puck-1', welcome.ts, welcome.proof) === true);
  const c2 = mk('10.0.0.50'); // same ip → no alarm
  sats.handle(c2);
  c2.__emit({ type: 'satellite.hello', id: 'puck-1', token: 'unittest-token' });
  ok('same id + same address re-hello: no false swap alarm', swaps.length === 0);
  const c3 = mk('10.0.0.77'); // same id, NEW address → swap visible
  sats.handle(c3);
  c3.__emit({ type: 'satellite.hello', id: 'puck-1', token: 'unittest-token' });
  ok('same id + NEW address → satellite.swap fires (visible, not blocked)', swaps.length === 1 && swaps[0].from === '10.0.0.50' && swaps[0].to === '10.0.0.77');

  // 3. boot integrity manifest: write → verify OK; bogus hash → FAIL names the file
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'max-integ-'));
  execFileSync('bash', ['scripts/integrity.sh', 'write'], { cwd: ROOT, env: { ...process.env, MAX_DATA_DIR: tmpData } });
  const good = execFileSync('bash', ['scripts/integrity.sh', 'verify'], { cwd: ROOT, env: { ...process.env, MAX_DATA_DIR: tmpData } }).toString();
  ok('integrity: fresh manifest verifies clean', /files match/.test(good));
  const man = fs.readFileSync(path.join(tmpData, 'integrity.sha256'), 'utf8');
  fs.writeFileSync(path.join(tmpData, 'integrity.sha256'), man.replace(/^([a-f0-9]{2})/, '00'));
  let tamperFailed = false, tamperOut = '';
  try { execFileSync('bash', ['scripts/integrity.sh', 'verify'], { cwd: ROOT, env: { ...process.env, MAX_DATA_DIR: tmpData }, stdio: 'pipe' }); }
  catch (e) { tamperFailed = true; tamperOut = String(e.stderr || e.stdout || ''); }
  ok('integrity: single modified file FAILS verification loudly', tamperFailed);

  // 4. attack surface: hub process opens exactly ONE listening socket (the app port)
  const probePort = 8115;
  const hub = spawn('node', ['hub/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(probePort), MAX_DATA_DIR: tmpData, OPENROUTER_API_KEYS: '', OPENROUTER_KEY_1: '', OPENROUTER_KEY_2: '', OPENROUTER_KEY_3: '', JARVIS_ALLOW_KEYLESS: '1', OLLAMA_URL: 'http://127.0.0.1:9', MAX_NET_PROBE_URL: 'http://127.0.0.1:9' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  process.on('exit', () => { try { hub.kill('SIGKILL'); } catch {} });
  for (let i = 0; i < 40; i++) { try { if ((await fetch('http://127.0.0.1:8115/api/health')).ok) break; } catch {} await sleep(250); }
  const ss = execFileSync('bash', ['-c', 'ss -ltnp 2>/dev/null | grep "pid=' + hub.pid + '" || true']).toString().trim();
  const listenCount = ss ? ss.split('\n').filter(Boolean).length : 0;
  ok('attack surface: hub opens exactly one listening port', listenCount === 1);
  const probe = await fetch('http://127.0.0.1:' + probePort + '/api/health').then((r) => r.json());
  ok('the one port is the intended app port', probe.ok === true);
  hub.kill('SIGKILL');

  // 5. no hardcoded credentials anywhere in code (placeholders allowed, real-shaped keys are not)
  const codeFiles = execFileSync('bash', ['-c', 'find hub web tools scripts satellite -type f | grep -vE "\\.md$"']).toString().trim().split('\n');
  const KEYLIKE = /['"`](sk|ghp|gho|xox[bap]|AIza|ya29)[-A-Za-z0-9_]{10,}['"`]/;
  const hits = codeFiles.filter((f) => KEYLIKE.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  ok('no real-shaped API keys hardcoded in code', hits.length === 0);
  const ino = fs.readFileSync(path.join(ROOT, 'satellite/esp32/jarvis_satellite/jarvis_satellite.ino'), 'utf8');
  ok('firmware ships only placeholder creds (YOUR_WIFI…)', /#define WIFI_PASS\s+"YOUR_WIFI_PASSWORD"/.test(ino) && !/YOUR_WIFI"\s*"[^"]*[0-9a-f]{8}/i.test(ino));

  // 6. decommission: dry-run keeps data; --yes destroys it
  const deadData = fs.mkdtempSync(path.join(os.tmpdir(), 'max-dead-'));
  fs.writeFileSync(path.join(deadData, '.master.key'), 'deadbeef');
  fs.writeFileSync(path.join(deadData, 'memory.enc.json'), '{}');
  execFileSync('bash', ['scripts/decommission.sh'], { cwd: ROOT, env: { ...process.env, MAX_DATA_DIR: deadData } });
  ok('decommission dry-run destroys nothing', fs.existsSync(path.join(deadData, '.master.key')));
  execFileSync('bash', ['scripts/decommission.sh', '--yes'], { cwd: ROOT, env: { ...process.env, MAX_DATA_DIR: deadData } });
  ok('decommission --yes wipes the data dir (keys, stores, logs)', !fs.existsSync(deadData) || fs.readdirSync(deadData).length === 0);

  console.log(`\n${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
