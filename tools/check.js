'use strict';
/** Sanity check: every hub module and skill loads without throwing. */
const fs = require('fs');
const path = require('path');

let ok = 0, bad = 0;
function tryRequire(rel) {
  try { require(rel); ok++; console.log('ok   ', rel); }
  catch (e) { bad++; console.log('FAIL ', rel, '—', e.message); }
}

for (const f of fs.readdirSync(path.join(__dirname, '..', 'hub'))) {
  if (f.endsWith('.js') && !['common.js','widgets.js'].includes(f)) tryRequire(path.join('..', 'hub', f));
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
