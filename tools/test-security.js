#!/usr/bin/env node
'use strict';
/**
 * Security regression suite — the findings from the hardening sprint,
 * locked in as tests. Boots a real hub on :8095 with an isolated data dir.
 */
process.env.PORT = '8095';
process.env.OPENROUTER_KEY_1 = ''; process.env.OPENROUTER_KEY_2 = ''; process.env.OPENROUTER_KEY_3 = ''; process.env.JARVIS_ALLOW_KEYLESS = '1';
process.env.OLLAMA_URL = ''; // intents-only hub: deterministic
process.env.MAX_DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'max-sec-'));

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('ok  ' + n); } else { fail++; console.log('FAIL ' + n); } };

(async () => {
  require('../hub/server.js');
  await new Promise((r) => setTimeout(r, 900));
  const api = (path, body) => fetch('http://127.0.0.1:8095' + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });

  // 1. CRITICAL REGRESSION: client-sent verify:true must NOT unlock locks
  const r1 = await (await api('/api/utterance', { text: 'unlock the door', verify: true })).json();
  ok('verify:true flag ignored — lock still gated', r1.verify === true || /verify/i.test(r1.say));

  // 2. user id sanitization end-to-end
  await api('/api/utterance', { text: 'what time is it', user: 'evil/<script>user🚀' });
  const users = await (await api('/api/users')).json();
  ok('user ids sanitized', users.every((u) => /^[\w. ()-]{1,40}$/.test(u.id)));

  // 3. settings patch: unknown top-level keys rejected
  await api('/api/settings', { evilTopLevelKey: 1, privacy: { vision: 'cloud' } });
  const st = await (await api('/api/settings')).json();
  ok('unknown settings key dropped', st.evilTopLevelKey === undefined);
  ok('known settings key applied', st.privacy.vision === 'cloud');

  // 4. deepMerge prototype pollution + masked-array clobber guards (unit)
  const { deepMerge } = require('../hub/settings');
  const base = { openrouter: { keys: ['REAL-KEY-1'] }, a: 1 };
  deepMerge(base, JSON.parse('{"__proto__":{"polluted":true},"openrouter":{"keys":["••••••REAL"]}}'));
  ok('no __proto__ pollution', ({}).polluted === undefined && base.polluted === undefined);
  ok('masked key array ignored', base.openrouter.keys[0] === 'REAL-KEY-1');
  deepMerge(base, { a: 2 });
  ok('legit values still merge', base.a === 2);

  // 5. dev sandbox: benign node works, exfil attempts blocked
  const dev = require('../hub/skills/dev');
  const benign = await dev._runSafe('node -e "console.log(2+2)"');
  ok('sandbox runs benign node', benign.ok && benign.output.trim() === '4');
  const exfilEnv = await dev._runSafe('node -e "console.log(require(\'fs\').readFileSync(\'.env\',\'utf8\'))"');
  ok('.env read blocked', !exfilEnv.ok && /protected/i.test(exfilEnv.output));
  const exfilNet = await dev._runSafe('node -e "const h=require(\'http\');console.log(1)"');
  ok('http module blocked', !exfilNet.ok && /blocked/i.test(exfilNet.output));
  const exfilScan = await dev._runSafe('node -e "const c=require(\'child_process\')"');
  ok('static require scan blocks child_process', !exfilScan.ok);
  ok('nmap public target refused', !!dev._labCheck('nmap', ['-sn', '8.8.8.8']));
  ok('nmap LAN target allowed', dev._labCheck('nmap', ['-sn', '192.168.1.0/24']) === null);

  // 6. smart_home tool gates: garage w/o verify; bad temp range (BEFORE any network call)
  const home = require('../hub/skills/smart_home');
  const g = await home.tools[0].run({ device: 'garage door', action: 'open_cover' }, { verified: false, user: {} });
  ok('home_control garage gated', g.verify === true);
  const t = await home.tools[0].run({ device: 'thermostat', action: 'set_temperature', temperature: 200 }, { verified: true, user: {} });
  ok('thermostat range validated', /between 5 and 35/i.test(t.say));
  const t2 = await home.tools[0].run({ device: 'thermostat', action: 'set_temperature', temperature: NaN }, { verified: true, user: {} });
  ok('thermostat NaN validated', /between 5 and 35/i.test(t2.say));

  // 7. finance validation
  const fin = require('../hub/skills/finance');
  const bad = await fin.tools[0].run({ amount: -50 }, { userId: 't', user: {} });
  ok('negative expense rejected', /sensible amount/i.test(bad.say));
  const nan = await fin.tools[0].run({ amount: 'lots' }, { userId: 't', user: {} });
  ok('non-numeric expense rejected', /sensible amount/i.test(nan.say));

  // 8. orchestrator gate matrix (sensitive / guest / kid)
  const { Orchestrator } = require('../hub/orchestrator');
  const gate = Orchestrator.prototype._gate;
  const u = { guest: false, kid: false };
  const deny = () => ({ say: 'denied' });
  ok('sensitive blocked unverified', gate.call({}, { sensitive: true }, { user: u, verified: false, deny }).blocked.verify === true);
  ok('sensitive allowed verified', gate.call({}, { sensitive: true }, { user: u, verified: true, deny }).blocked === null);
  ok('guest blocked from personalData', gate.call({}, { personalData: true }, { user: { guest: true, kid: false }, deny }).blocked !== null);
  ok('kid blocked from kidBlocked', gate.call({}, { kidBlocked: true }, { user: { guest: false, kid: true }, deny }).blocked !== null);

  // 9. rate limiting on voiceprint verify (20/min per user): calls beyond 20 get 429
  let over = 0;
  for (let i = 0; i < 25; i++) {
    const r = await api('/api/voiceprint/verify', { user: 'default', features: [1, 2, 3, 4, 5] });
    if (r.status === 429) over++;
  }
  ok('voiceprint verify rate-limited past 20/min', over >= 4);

  // 10. eventlog: keys scrubbed, text dropped
  const fs = require('fs');
  const logFile = require('path').join(process.env.MAX_DATA_DIR, 'events.jsonl');
  const lines = fs.readFileSync(logFile, 'utf8');
  ok('no raw transcripts in log', !lines.includes('unlock the door'));

  console.log(`\n${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
