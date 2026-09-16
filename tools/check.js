'use strict';
/** Sanity check: every hub module and skill loads without throwing. */
const fs = require('fs');
const path = require('path');

/* This harness requires hub/server.js like the suites do, so it mirrors their
   boot boilerplate: an isolated PORT (never collide with a live hub on 8080)
   and the documented JARVIS_ALLOW_KEYLESS=1 test/CI override, so a bare
   `node tools/check.js` on a fresh clone (no .env) checks module loading
   instead of tripping the key-rotation preflight. The preflight itself is
   pinned unmodified by test-jarvis J16, which spawns the real standalone boot. */
process.env.JARVIS_ALLOW_KEYLESS = '1';
process.env.PORT = process.env.PORT || '8199';

let ok = 0, bad = 0;
function tryRequire(rel) {
  try { require(rel); ok++; console.log('ok   ', rel); }
  catch (e) { bad++; console.log('FAIL ', rel, '—', e.message); }
}

for (const f of fs.readdirSync(path.join(__dirname, '..', 'hub'))) {
  if (f.endsWith('.js')) tryRequire(path.join('..', 'hub', f));
}
for (const f of fs.readdirSync(path.join(__dirname, '..', 'hub', 'skills'))) {
  if (f.endsWith('.js') && !f.startsWith('_') && f !== 'registry.js') {
    try {
      const s = require(path.join('..', 'hub', 'skills', f));
      if (!s.intents && !s.tools) { bad++; console.log('FAIL ', f, '— exports no intents or tools'); continue; }
      ok++; console.log('ok   skill:', s.name || f);
    } catch (e) { bad++; console.log('FAIL skill:', f, '—', e.message); }
  }
}
console.log(`\n${ok} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
