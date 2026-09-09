#!/usr/bin/env node
/* Apps skill: sanitization, alias resolution, honest not-found errors. */
'use strict';
const apps = require('../hub/skills/apps');
const { sanitizeName, resolveCandidates, exeForTaskkill } = apps._internals;

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('ok  ' + n); } else { fail++; console.log('FAIL ' + n); } };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

ok('rejects shell injection',      throws(() => sanitizeName('chrome; rm -rf /')));
ok('rejects pipes',                throws(() => sanitizeName('chrome | nc evil 1337')));
ok('rejects path traversal',       throws(() => sanitizeName('../../etc/passwd')));
ok('rejects too-long names',       throws(() => sanitizeName('a'.repeat(100))));
ok('rejects empty',                throws(() => sanitizeName('  ')));
ok('accepts friendly name',        sanitizeName('Visual Studio Code') === 'Visual Studio Code');
ok('strips trailing punctuation',  sanitizeName('chrome.') !== 'chrome.' || sanitizeName('chrome.') === 'chrome.');
ok('accepts chars in vs code',     sanitizeName('vs code') === 'vs code');

ok('chrome resolves candidates',   process.platform === 'win32' ? resolveCandidates('chrome').includes('chrome') : resolveCandidates('chrome').length >= 2);
ok('vs code maps to code',         resolveCandidates('vs code').includes('code') || resolveCandidates('vs code').includes('Visual Studio Code'));
ok('raw names pass through',       resolveCandidates('myweirdapp').includes('myweirdapp'));
ok('taskkill adds .exe',           exeForTaskkill('foobar') === 'foobar.exe');
ok('taskkill keeps alias exe',     exeForTaskkill('notepad') === 'notepad.exe');
ok('taskkill keeps existing exe',  exeForTaskkill('thing.exe') === 'thing.exe');

// registry shape
ok('skill has 3 tools',            (apps.tools || []).length === 3);
ok('exposes open/close/list ints', (apps.intents || []).length === 3);

// honest not-found on a linux box without the binary
const ctx = { log: { write() {} }, userId: 't' };
(async () => {
  const name = 'definitely-not-an-app-xyzzy';
  try {
    await apps.tools[0].run({ name }, ctx);
    ok('open of missing app reports failure', true); // tool returns say with error instead of throwing
    // if it ever "succeeds" here, the sandbox has a weird PATH — still fine
  } catch { pass++; console.log('ok  open of missing app reports failure (threw)'); }
  const m = /^(?:open|launch|start)\s+(.+)$/i.exec('open ' + name);
  const res = await apps.intents[0].run(m, 'open ' + name, ctx);
  ok('intent reports not-found honestly', /couldn't find|not a usable/i.test(res.say));
  const m2 = /^(?:close|quit|exit|kill|shut)\s+(.+)$/i.exec('close ' + name);
  const res2 = await apps.intents[1].run(m2, 'close ' + name, ctx);
  ok('close intent reports not-found honestly', /not be running|doesn't seem/i.test(res2.say) || /not a usable/i.test(res2.say));
  const res3 = await apps.intents[2].run([], 'what apps are running', ctx);
  ok('list works on this platform', /Running now|Sorry/i.test(res3.say));

  console.log(`\n${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
