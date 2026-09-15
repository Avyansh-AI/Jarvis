'use strict';
/** Connectivity monitor — drives the `offline` state and the local-fallback path. */
const { EventEmitter } = require('events');

class NetMonitor extends EventEmitter {
  constructor() {
    super();
    this.online = true;
    this.lastCheck = 0;
    this._timer = setInterval(() => this.check(), 10000);
    this._timer.unref?.();
    this.check();
  }

  async check() {
    const was = this.online;
    this.lastCheck = Date.now();
    const probe = process.env.MAX_NET_PROBE_URL || 'https://api.open-meteo.com/v1/forecast?latitude=0&longitude=0&current=temperature_2m'; // override: tests/private WANs
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3500);
      await fetch(probe, { signal: ctrl.signal });
      clearTimeout(t);
      this.online = true;
    } catch {
      this.online = false;
    }
    if (was !== this.online) this.emit('change', this.online);
    return this.online;
  }
}

/** fetch with a hard timeout (ms). */
async function http(url, opts = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** http + retry with linear backoff for flaky integrations (network errors + 5xx only). */
async function httpRetry(url, opts = {}, timeoutMs = 12000, { retries = 2, backoffMs = 400 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await http(url, opts, timeoutMs);
      if (res.status >= 500 && attempt < retries) { await sleep(backoffMs * (attempt + 1)); continue; }
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(backoffMs * (attempt + 1));
    }
  }
  throw lastErr;
}

module.exports = { NetMonitor, http, httpRetry };
