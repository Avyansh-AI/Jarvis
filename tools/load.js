#!/usr/bin/env node
'use strict';
/**
 * Load probe: 50 concurrent utterances against an intent-only hub.
 * Prints real latency numbers (p50/p95/max), not estimates.
 */
process.env.PORT = '8091';
process.env.OPENROUTER_KEY_1 = ''; process.env.OPENROUTER_KEY_2 = ''; process.env.OPENROUTER_KEY_3 = ''; process.env.JARVIS_ALLOW_KEYLESS = '1';
process.env.OLLAMA_URL = '';
process.env.MAX_DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'max-load-'));

require('../hub/server.js');

(async () => {
  await new Promise((r) => setTimeout(r, 900));
  const B = 'http://127.0.0.1:8091';
  const fire = (text) => {
    const t0 = performance.now();
    return fetch(B + '/api/utterance', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })
      .then((r) => r.json())
      .then(() => performance.now() - t0);
  };

  // warm-up
  await fire('what time is it');

  const texts = ['what time is it', 'set a timer for 30 seconds', 'list the skills', 'note that i like tea', 'what apps are running'];
  const t0 = performance.now();
  const lat = await Promise.all(Array.from({ length: 50 }, (_, i) => fire(texts[i % texts.length])));
  const wall = performance.now() - t0;
  lat.sort((a, b) => a - b);
  const p = (q) => lat[Math.min(lat.length - 1, Math.floor(q * lat.length))];
  console.log(`50 concurrent utterances:`);
  console.log(`  wall clock : ${wall.toFixed(0)} ms (≈ ${(50000 / wall).toFixed(0)} req/s)`);
  console.log(`  p50        : ${p(0.5).toFixed(1)} ms`);
  console.log(`  p95        : ${p(0.95).toFixed(1)} ms`);
  console.log(`  max        : ${lat[lat.length - 1].toFixed(1)} ms`);

  // sequential single-user voice-loop proxy (what a human experiences)
  const seq = [];
  for (let i = 0; i < 10; i++) seq.push(await fire(texts[i % texts.length]));
  seq.sort((a, b) => a - b);
  console.log(`sequential (n=10): p50 ${seq[4].toFixed(1)} ms · p90 ${seq[8].toFixed(1)} ms`);

  const health = await (await fetch(B + '/api/health')).json();
  console.log('hub after load:', health.ok ? 'healthy ✓' : 'UNHEALTHY ✗');
  process.exit(health.ok ? 0 : 1);
})();
