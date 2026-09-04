#!/usr/bin/env node
/* Extracts highlightCode() from web/index.html (between hl:start / hl:end)
   and verifies token classes + escaping without a browser. */
'use strict';
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
const start = src.indexOf('// === hl:start ===');
const end = src.indexOf('// === hl:end ===');
if (start === -1 || end === -1) { console.error('FAIL: hl markers missing in index.html'); process.exit(1); }
const fn = new Function(src.slice(start, end) + '; return highlightCode;')();

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('ok  ' + name); } else { fail++; console.log('FAIL ' + name); } }

// 1. C++ keywords / numbers / comments / preprocessor / function calls
const cpp = fn('const int motorPin = 9;\n// Vocal segments\n#include <Arduino.h>\nvoid setup() { pinMode(motorPin, OUTPUT); }', 'cpp');
ok('cpp keyword tinted',       /<span class="tok-k">const<\/span>/.test(cpp));
ok('cpp number tinted',        /<span class="tok-n">9<\/span>/.test(cpp));
ok('cpp comment tinted',       /<span class="tok-c">\/\/ Vocal segments<\/span>/.test(cpp));
ok('cpp preprocessor tinted',  /<span class="tok-p">#include &lt;Arduino\.h&gt;<\/span>/.test(cpp));
ok('cpp sizeof stays keyword', /<span class="tok-k">void<\/span>/.test(cpp));
ok('cpp call tinted',          /<span class="tok-f">setup<\/span>\(\)/.test(cpp));
ok('cpp arg not a call',       !/tok-f">motorPin</.test(cpp));

// 2. JS strings incl. backticks, keywords beat func-call detection
const js = fn('const x = `hi`;\nif (ok) run();', 'js');
ok('js template string',       /<span class="tok-s">`hi`<\/span>/.test(js));
ok('js if tinted as keyword',  /<span class="tok-k">if<\/span>/.test(js));
ok('js call tinted',           /<span class="tok-f">run<\/span>/.test(js));

// 3. Python: hash comments, triple strings, decorators
const py = fn('# note\n@route\ndef f(): return """doc"""', 'py');
ok('py comment tinted',        /<span class="tok-c"># note<\/span>/.test(py));
ok('py decorator tinted',      /<span class="tok-p">@route<\/span>/.test(py));
ok('py triple string tinted',  /<span class="tok-s">"""doc"""<\/span>/.test(py));

// 4. HTML: tags, attrs strings, comments
const html = fn('<div class="a"><!-- hi --></div>', 'html');
ok('html tag tinted',          /<span class="tok-k">&lt;div<\/span>/.test(html));
ok('html string tinted',       /<span class="tok-s">"a"<\/span>/.test(html));
ok('html comment tinted',      /<span class="tok-c">&lt;!-- hi --&gt;<\/span>/.test(html));

// 5. Escaping: hostile code can never inject markup
const evil = fn('</div><script>alert(1)</script>', 'js');
ok('no raw tag survives',      !/<script>/.test(evil) && !/<\/div>/.test(evil));
ok('only our spans emitted',   evil.split(/<\/?span[^>]*>/).every((frag) => !/</.test(frag)));

// 6. JSON + unknown language fallbacks
ok('json boolean tinted',      /tok-k">true</.test(fn('{"a": true}', 'json')));
ok('unknown lang still tints', /tok-s">"hi"</.test(fn('print("hi")', 'brainfuck')));

console.log(`\n${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
