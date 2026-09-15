#!/usr/bin/env node
'use strict';
/**
 * Offline/degraded-mode proof: no cloud keys, no Ollama, network irrelevant —
 * the assistant must still handle real work via deterministic intents,
 * and must say something calm and helpful for things it can't do.
 */
process.env.PORT = '8096';
process.env.OPENROUTER_KEY_1 = ''; process.env.OPENROUTER_KEY_2 = ''; process.env.OPENROUTER_KEY_3 = ''; process.env.JARVIS_ALLOW_KEYLESS = '1';
process.env.OLLAMA_URL = '';
process.env.MAX_DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'max-off-'));

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('ok  ' + n); } else { fail++; console.log('FAIL ' + n); } };

(async () => {
  require('../hub/server.js');
  await new Promise((r) => setTimeout(r, 900));
  const say = async (text) => (await (await fetch('http://127.0.0.1:8096/api/utterance', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
  })).json());

  const timer = await say('set a timer for 30 seconds');
  ok('timer intent works offline', /timer set for/i.test(timer.say));

  const time = await say('what time is it');
  ok('clock intent works offline', /\d{1,2}:\d{2}|am|pm/i.test(time.say));

  const note = await say('note that I prefer loose-leaf tea');
  ok('notes intent works offline', note.say && note.say.length > 3);

  const list = await say('list the skills');
  ok('dev skill enumeration works offline', /18 skill|skill modules/i.test(list.say));

  const wx = await say('what is the weather');
  ok('weather fails gracefully offline-ish', wx.say.length > 10 && !/undefined|TypeError|NaN/.test(wx.say));

  const gib = await say('florb narb zugglewump the quantifier');
  ok('gibberish gets a calm useful fallback', gib.say.length > 10 && !/undefined|TypeError/.test(gib.say));

  // hub stays alive after all of it
  const health = await (await fetch('http://127.0.0.1:8096/api/health')).json();
  ok('hub healthy after offline session', health.ok === true && health.skills >= 18); // skill count grows with feature passes — assert the floor, not a fixed number

  console.log(`\n${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
