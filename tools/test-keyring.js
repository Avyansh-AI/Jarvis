'use strict';
/**
 * Rotation test: mock 'OpenRouter' rejects key #1 (429), accepts key #2.
 * Expect: first utterance succeeds via key #2; second goes straight to #2.
 */
process.env.PORT = '8093';
process.env.OPENROUTER_BASE = 'http://127.0.0.1:8912';
process.env.OPENROUTER_API_KEYS = 'bad-key-1,good-key-2,spare-key-3';
// v1.0.7 canonical slots — the .env-only policy reads ONLY these; rotation under
// simulated 429 rate-limiting is re-proven against exactly these three.
process.env.OPENROUTER_KEY_1 = 'bad-key-1';
process.env.OPENROUTER_KEY_2 = 'good-key-2';
process.env.OPENROUTER_KEY_3 = 'spare-key-3';
process.env.OLLAMA_URL = ''; // force cloud-or-nothing for this test
// The network monitor only needs an HTTP response for connectivity; use the local mock
// so this deterministic rotation test is not dependent on external WAN access.
process.env.MAX_NET_PROBE_URL = 'http://127.0.0.1:8912/health';
// Isolate the data dir: a real settings store carries UI-managed keys that
// would (correctly) win over env keys — and printing them would leak secrets.
process.env.MAX_DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'max-keyring-'));

const http = require('http');
const attempts = [];

const mock = http.createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  const auth = req.headers.authorization || '';
  const key = auth.replace(/^Bearer /, '');
  // Connectivity probes do not carry an authorization header; only count LLM calls.
  if (key) attempts.push(key);
  if (key !== 'good-key-2') {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'rate limited' } }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    choices: [{ message: { role: 'assistant', content: 'mock ok — key two served this' }, finish_reason: 'stop' }],
  }));
});

(async () => {
  await new Promise((r) => mock.listen(8912, '127.0.0.1', r));
  require('../hub/server.js'); // boots hub on :8093
  await new Promise((r) => setTimeout(r, 800));

  const say = (t) => fetch('http://127.0.0.1:8093/api/utterance', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: t }),
  }).then((r) => r.json());

  const r1 = await say('hello there, introduce yourself briefly');
  console.log('utterance 1:', JSON.stringify(r1));
  console.log('attempts after 1st:', attempts.join(' → '));

  const r2 = await say('and again, one more time');
  console.log('utterance 2:', JSON.stringify(r2));
  console.log('attempts after 2nd:', attempts.join(' → '));

  const rotOk = attempts[0] === 'bad-key-1' && attempts[1] === 'good-key-2' && r1.brain === 'cloud';
  const stickyOk = attempts[2] === 'good-key-2' && r2.brain === 'cloud';
  console.log(rotOk && stickyOk ? '\nPASS: rotation + sticky-good-key work' : '\nFAIL: see above');
  process.exit(rotOk && stickyOk ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
