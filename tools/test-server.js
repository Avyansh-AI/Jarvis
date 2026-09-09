#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');

const port = 18080;
const child = spawn(process.execPath, ['hub/server.js'], {
  cwd: require('node:path').join(__dirname, '..'),
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', MAX_TOKEN: 'test-token' },
  stdio: 'ignore',
});
const request = (headers = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: '/api/health', headers }, (res) => {
    let body = ''; res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
  });
  req.on('error', reject); req.end();
});
(async () => {
  try {
    await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 500); child.on('exit', reject); timer.unref(); });
    assert.equal((await request()).status, 401);
    assert.equal((await request({ authorization: 'Bearer test-token' })).status, 200);
    console.log('server security smoke test passed');
  } finally { child.kill('SIGTERM'); }
})().catch((error) => { console.error(error); child.kill('SIGKILL'); process.exit(1); });
